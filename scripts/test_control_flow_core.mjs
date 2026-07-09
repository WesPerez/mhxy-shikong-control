#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  completeRecoveryAsFailed,
  controlFlowDecisionForStep,
  evaluateConditionGuard,
  insertWorkflowJumpIntoRunPlan,
  recordControlFlowTransition,
  recoveryDecisionForFailedStep,
  unboundedWorkflowJumpCycleFindings,
} from "../src/control-flow-core.js";

const labels = {
  condition: "Condition",
  detect_page: "Detect page",
  image_click: "Image click",
  loop: "Loop",
  restore: "Restore",
  task_jump: "Task jump",
};

const workflowA = {
  id: "wf-a",
  name: "Workflow A",
  steps: [
    { id: "a-start", type: "detect_page", name: "Start" },
    { id: "a-jump", type: "task_jump", name: "Jump to B", jumpWorkflowId: "wf-b" },
  ],
};

const workflowB = {
  id: "wf-b",
  name: "Workflow B",
  steps: [
    { id: "b-start", type: "detect_page", name: "B Start" },
    { id: "b-end", type: "restore", name: "B Restore" },
  ],
};

const workflows = new Map([
  [workflowA.id, workflowA],
  [workflowB.id, workflowB],
]);

const options = {
  stepLabels: labels,
  workflowById: (id) => workflows.get(id) || null,
};

function makeSession(overrides = {}) {
  return {
    currentStep: 1,
    controlFlowCounts: {},
    controlFlowTransitions: [],
    controlFlowTransitionSerial: 0,
    workflowIds: ["wf-a"],
    workflowNames: ["Workflow A"],
    workflowName: "Workflow A",
    queuePlan: [
      {
        queueItemId: "queue-a",
        workflowId: "wf-a",
        workflowName: "Workflow A",
        order: 1,
        startDelayMs: 0,
        afterDelayMs: 0,
      },
    ],
    queueEvents: [],
    logs: [],
    totalSteps: 2,
    status: "running",
    cancelRequested: false,
    workflowJumpCount: 0,
    ...overrides,
  };
}

function decisionFor({ steps, itemIndex, item = steps[itemIndex], session = makeSession(), result = ok(), previousResult = null }) {
  const stepIndexById = new Map(steps.map((step, index) => [step.id, index]));
  return controlFlowDecisionForStep(
    {
      session,
      workflow: workflowA,
      steps,
      stepIndexById,
      item,
      currentPc: itemIndex,
      result,
      previousResult,
    },
    options,
  );
}

function recoveryFor({ steps, itemIndex, item = steps[itemIndex], session = makeSession(), result }) {
  const stepIndexById = new Map(steps.map((step, index) => [step.id, index]));
  return recoveryDecisionForFailedStep(
    {
      session,
      workflow: workflowA,
      steps,
      stepIndexById,
      item,
      currentPc: itemIndex,
      result,
    },
    options,
  );
}

function ok(extra = {}) {
  return { status: "ok", action: "test", detail: "ok", inputSent: false, matched: false, ...extra };
}

function missingAsset(extra = {}) {
  return { status: "missing_asset", action: "match", detail: "missing asset", inputSent: false, matched: false, ...extra };
}

function testTaskJumpDecisionRequestsWorkflow() {
  const steps = [
    { id: "s1", type: "detect_page", name: "Start" },
    { id: "s2", type: "task_jump", name: "Jump", jumpWorkflowId: "wf-b" },
  ];

  const decision = decisionFor({ steps, itemIndex: 1, result: ok({ action: "task_jump" }) });

  assert.equal(decision.workflowJumpId, "wf-b");
  assert.equal(decision.nextPc, steps.length);
  assert.equal(decision.transition.status, "taken");
  assert.equal(decision.transition.workflowJump, true);
  assert.equal(decision.transition.toWorkflowId, "wf-b");
  assert.equal(decision.transition.requestedToWorkflowId, "wf-b");
}

function testPlannedTaskJumpDoesNotTriggerWorkflowJump() {
  const steps = [
    { id: "s1", type: "detect_page", name: "Start" },
    { id: "s2", type: "task_jump", name: "Jump", jumpWorkflowId: "wf-b" },
  ];

  const decision = decisionFor({
    steps,
    itemIndex: 1,
    result: { status: "planned", action: "no_input", detail: "backend compatibility path" },
  });

  assert.equal(decision.workflowJumpId, undefined);
  assert.equal(decision.nextPc, 2);
  assert.equal(decision.transition, null);
}

function testSelfTaskJumpRequiresAndHonorsMaxIterations() {
  const session = makeSession();
  const steps = [
    { id: "s1", type: "detect_page", name: "Start" },
    { id: "s2", type: "task_jump", name: "Self jump", jumpWorkflowId: "wf-a", maxIterations: 0 },
  ];

  const skipped = decisionFor({ steps, itemIndex: 1, session });
  assert.equal(skipped.workflowJumpId, undefined);
  assert.equal(skipped.transition.status, "skipped");
  assert.equal(skipped.transition.workflowJump, true);

  steps[1].maxIterations = 2;
  const first = decisionFor({ steps, itemIndex: 1, session });
  const second = decisionFor({ steps, itemIndex: 1, session });
  const third = decisionFor({ steps, itemIndex: 1, session });

  assert.equal(first.workflowJumpId, "wf-a");
  assert.equal(first.iterationCount, 1);
  assert.equal(second.workflowJumpId, "wf-a");
  assert.equal(second.iterationCount, 2);
  assert.equal(third.workflowJumpId, undefined);
  assert.equal(third.transition.status, "skipped");
  assert.equal(third.transition.iterationCount, 2);
}

function testBackwardStepJumpBudget() {
  const session = makeSession();
  const steps = [
    { id: "s1", type: "detect_page", name: "Start" },
    { id: "s2", type: "image_click", name: "Loop", targetStepId: "s1", maxIterations: 1 },
  ];

  const first = decisionFor({ steps, itemIndex: 1, session });
  const second = decisionFor({ steps, itemIndex: 1, session });

  assert.equal(first.nextPc, 0);
  assert.equal(first.transition.backward, true);
  assert.equal(first.transition.iterationCount, 1);
  assert.equal(second.nextPc, 2);
  assert.equal(second.transition.status, "skipped");
  assert.equal(second.transition.iterationCount, 1);
}

function testLoopStepUsesPlannedNoInputAndBudget() {
  const session = makeSession();
  const steps = [
    { id: "s1", type: "detect_page", name: "Start" },
    { id: "s2", type: "image_click", name: "Body" },
    { id: "s3", type: "loop", name: "Loop once", targetStepId: "s2", maxIterations: 1 },
    { id: "s4", type: "snapshot", name: "After" },
  ];
  const planned = { status: "planned", action: "no_input", detail: "no backend input" };
  const first = decisionFor({ steps, itemIndex: 2, session, result: planned });
  const second = decisionFor({ steps, itemIndex: 2, session, result: planned });

  assert.equal(first.nextPc, 1);
  assert.equal(first.transition.reason, "loop");
  assert.equal(first.transition.backward, true);
  assert.equal(first.transition.iterationCount, 1);
  assert.equal(first.transition.maxIterations, 1);
  assert.equal(second.nextPc, 3);
  assert.equal(second.transition.status, "skipped");
  assert.equal(second.transition.iterationCount, 1);
}

function testLoopStepRejectsForwardTarget() {
  const steps = [
    { id: "s1", type: "detect_page", name: "Start" },
    { id: "s2", type: "loop", name: "Bad loop", targetStepId: "s3", maxIterations: 2 },
    { id: "s3", type: "snapshot", name: "Forward" },
  ];

  const decision = decisionFor({ steps, itemIndex: 1, result: { status: "planned", action: "no_input" } });

  assert.equal(decision.nextPc, 2);
  assert.equal(decision.transition.status, "skipped");
  assert.equal(decision.transition.skippedReason, "循环目标必须位于当前步骤之前");
}

function testConditionBranchesAndTaskJump() {
  const steps = [
    { id: "s1", type: "detect_page", name: "Start" },
    {
      id: "s2",
      type: "condition",
      name: "Branch",
      command: "guard=true",
      targetStepId: "s4",
      elseTargetStepId: "s3",
    },
    { id: "s3", type: "restore", name: "Else" },
    { id: "s4", type: "image_click", name: "Then" },
  ];

  const truthy = decisionFor({ steps, itemIndex: 1 });
  assert.equal(truthy.nextPc, 3);
  assert.equal(truthy.transition.reason, "condition true");
  assert.equal(truthy.transition.guardResult, true);

  steps[1].command = "guard=false";
  const falsy = decisionFor({ steps, itemIndex: 1 });
  assert.equal(falsy.nextPc, 2);
  assert.equal(falsy.transition.reason, "condition false");
  assert.equal(falsy.transition.guardResult, false);

  delete steps[1].targetStepId;
  steps[1].command = "guard=true";
  steps[1].jumpWorkflowId = "wf-b";
  const jump = decisionFor({ steps, itemIndex: 1 });
  assert.equal(jump.workflowJumpId, "wf-b");
  assert.equal(jump.transition.reason, "condition true task_jump");
}

function testUnsupportedConditionFallsThroughWithEvidence() {
  const guard = evaluateConditionGuard({ command: "guard=state.inventory_ready" }, ok(), null);
  assert.equal(guard.supported, false);

  const steps = [
    { id: "s1", type: "detect_page", name: "Start" },
    { id: "s2", type: "condition", name: "Unsupported", command: "guard=state.inventory_ready", targetStepId: "s1" },
  ];
  const decision = decisionFor({ steps, itemIndex: 1 });
  assert.equal(decision.nextPc, 2);
  assert.equal(decision.transition.status, "skipped");
  assert.equal(decision.transition.skippedReason, "unsupported guard expression");
}

function testRecoveryOnlyRunsForRecoverableFailures() {
  const session = makeSession();
  const steps = [
    { id: "s1", type: "image_click", name: "Needs target", onFail: "restore", recoveryStepId: "s3" },
    { id: "s2", type: "delay", name: "Normal next" },
    { id: "s3", type: "restore", name: "Recovery" },
  ];

  const recovery = recoveryFor({ steps, itemIndex: 0, session, result: missingAsset() });
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.nextPc, 2);
  assert.equal(recovery.transition.status, "taken");
  assert.equal(recovery.transition.recovery, true);
  assert.equal(session.recoveryContext.failedStepId, "s1");

  completeRecoveryAsFailed(session);
  assert.equal(session.status, "failed");
  assert.equal(session.cancelRequested, true);
  assert.match(session.failureReason, /原失败/);
  assert.equal(session.recoveryContext, null);
}

function testRecoverySkipsNonRecoverableFailures() {
  const steps = [
    { id: "s1", type: "image_click", name: "Needs target", onFail: "restore", recoveryStepId: "s2" },
    { id: "s2", type: "restore", name: "Recovery" },
  ];

  const recovery = recoveryFor({
    steps,
    itemIndex: 0,
    result: { status: "error", action: "window_identity", detail: "identity drift" },
  });

  assert.equal(recovery.recovered, false);
  assert.equal(recovery.transition.status, "skipped");
  assert.equal(recovery.transition.skippedReason, "status is not recoverable");
}

function testInsertWorkflowJumpIntoRunPlan() {
  const session = makeSession();
  const runPlan = [
    {
      workflow: structuredClone(workflowA),
      queueItem: { id: "queue-a", workflowId: "wf-a", order: 1, enabled: true },
    },
  ];

  const inserted = insertWorkflowJumpIntoRunPlan(
    session,
    runPlan,
    1,
    {
      workflowId: "wf-b",
      fromWorkflowId: "wf-a",
      fromWorkflowName: "Workflow A",
      fromStepId: "a-jump",
      fromStepName: "Jump to B",
      maxIterations: 2,
      iterationCount: 1,
    },
    {
      ...options,
      normalizeQueueItem: (value) => value,
      randomId: () => "queue-jump-test",
    },
  );

  assert.equal(inserted, true);
  assert.equal(runPlan.length, 2);
  assert.equal(runPlan[1].workflow.id, "wf-b");
  assert.equal(session.workflowIds.join(","), "wf-a,wf-b");
  assert.equal(session.queuePlan.length, 2);
  assert.equal(session.queuePlan[1].insertedBy, "task_jump");
  assert.equal(session.queuePlan[1].order, 2);
  assert.equal(session.queueEvents.at(-1).phase, "task_jump");
  assert.equal(session.queueEvents.at(-1).toWorkflowId, "wf-b");
  assert.equal(session.totalSteps, 4);

  runPlan[1].workflow.name = "Mutated B";
  assert.equal(workflowB.name, "Workflow B");
}

function testInsertWorkflowJumpBudgetFailure() {
  const session = makeSession({ workflowJumpCount: 1 });
  const runPlan = [];

  const inserted = insertWorkflowJumpIntoRunPlan(
    session,
    runPlan,
    0,
    { workflowId: "wf-b", fromStepName: "Jump" },
    { ...options, maxWorkflowJumps: 1 },
  );

  assert.equal(inserted, false);
  assert.equal(session.status, "failed");
  assert.match(session.failureReason, /任务跳转超过 1 次预算/);
}

function testTransitionRecordingTrimsOldEntries() {
  const session = makeSession();
  recordControlFlowTransition(session, { status: "taken", fromStepId: "s1" }, { maxControlFlowTransitions: 2 });
  recordControlFlowTransition(session, { status: "skipped", fromStepId: "s2" }, { maxControlFlowTransitions: 2 });
  recordControlFlowTransition(session, { status: "fallthrough", fromStepId: "s3" }, { maxControlFlowTransitions: 2 });

  assert.equal(session.controlFlowTransitionSerial, 3);
  assert.equal(session.controlFlowTransitions.length, 2);
  assert.deepEqual(
    session.controlFlowTransitions.map((item) => item.fromStepId),
    ["s2", "s3"],
  );
  assert.deepEqual(
    session.controlFlowTransitions.map((item) => item.order),
    [2, 3],
  );
}

function testUnboundedWorkflowJumpCyclesAreReported() {
  const workflows = [
    {
      id: "wf-a",
      name: "Workflow A",
      steps: [{ id: "a-jump", type: "task_jump", name: "Jump to B", jumpWorkflowId: "wf-b" }],
    },
    {
      id: "wf-b",
      name: "Workflow B",
      steps: [{ id: "b-jump", type: "task_jump", name: "Jump to A", jumpWorkflowId: "wf-a" }],
    },
  ];

  const findings = unboundedWorkflowJumpCycleFindings(workflows);

  assert.deepEqual(
    findings.map((item) => item.stepId).sort(),
    ["a-jump", "b-jump"],
  );
  assert.deepEqual(findings[0].cycleWorkflowIds, ["wf-a", "wf-b", "wf-a"]);
}

function testPartlyBoundedWorkflowJumpCyclesReportUnboundedEdge() {
  const workflows = [
    {
      id: "wf-a",
      name: "Workflow A",
      steps: [{ id: "a-jump", type: "task_jump", name: "Jump to B", jumpWorkflowId: "wf-b" }],
    },
    {
      id: "wf-b",
      name: "Workflow B",
      steps: [{ id: "b-jump", type: "task_jump", name: "Jump to A", jumpWorkflowId: "wf-a", maxIterations: 2 }],
    },
  ];

  const findings = unboundedWorkflowJumpCycleFindings(workflows);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].stepId, "a-jump");
}

function testBoundedWorkflowJumpCyclesAreAllowed() {
  const workflows = [
    {
      id: "wf-a",
      name: "Workflow A",
      steps: [{ id: "a-jump", type: "task_jump", name: "Jump to B", jumpWorkflowId: "wf-b", maxIterations: 2 }],
    },
    {
      id: "wf-b",
      name: "Workflow B",
      steps: [{ id: "b-jump", type: "task_jump", name: "Jump to A", jumpWorkflowId: "wf-a", maxIterations: 2 }],
    },
  ];

  assert.equal(unboundedWorkflowJumpCycleFindings(workflows).length, 0);
}

const tests = [
  testTaskJumpDecisionRequestsWorkflow,
  testPlannedTaskJumpDoesNotTriggerWorkflowJump,
  testSelfTaskJumpRequiresAndHonorsMaxIterations,
  testBackwardStepJumpBudget,
  testLoopStepUsesPlannedNoInputAndBudget,
  testLoopStepRejectsForwardTarget,
  testConditionBranchesAndTaskJump,
  testUnsupportedConditionFallsThroughWithEvidence,
  testRecoveryOnlyRunsForRecoverableFailures,
  testRecoverySkipsNonRecoverableFailures,
  testInsertWorkflowJumpIntoRunPlan,
  testInsertWorkflowJumpBudgetFailure,
  testTransitionRecordingTrimsOldEntries,
  testUnboundedWorkflowJumpCyclesAreReported,
  testPartlyBoundedWorkflowJumpCyclesReportUnboundedEdge,
  testBoundedWorkflowJumpCyclesAreAllowed,
];

for (const test of tests) {
  test();
}

console.log(`control-flow-core: ${tests.length} tests passed`);
