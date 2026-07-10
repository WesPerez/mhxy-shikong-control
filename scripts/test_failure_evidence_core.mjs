#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  failureEvidenceBundle,
  failureEvidenceSummaryText,
  failureStepFromReport,
  isFailureStepResult,
} from "../src/failure-evidence-core.js";

const fixedNow = "2026-07-10T00:00:00.000Z";

function sampleReport(overrides = {}) {
  return {
    id: "run-1",
    status: "failed",
    mode: "background",
    source: "queue",
    hwnd: 123,
    display: "梦幻西游：时空 #1",
    workflowId: "wf-a",
    workflowName: "家园活力",
    workflowIds: ["wf-a"],
    workflowNames: ["家园活力"],
    queueLength: 1,
    totalSteps: 12,
    completedSteps: 6,
    durationMs: 3210,
    failureReason: "missing asset",
    failedWorkflowName: "家园活力",
    failedStepName: "点击按钮",
    windowIdentity: {
      hwnd: 123,
      title: "梦幻西游：时空",
      processId: 456,
      processName: "MyGame_x64r",
      clientWidth: 1264,
      clientHeight: 720,
      elevated: true,
    },
    queuePlan: [{ workflowName: "家园活力" }],
    queueEvents: Array.from({ length: 4 }, (_, index) => ({ order: index + 1, phase: "queue" })),
    runEvents: Array.from({ length: 25 }, (_, index) => ({ order: index + 1, type: "step_result" })),
    controlFlowTransitions: Array.from({ length: 3 }, (_, index) => ({ order: index + 1, status: "taken" })),
    pauseEvents: [],
    stepResults: [
      { order: 1, workflowName: "家园活力", stepName: "打开界面", status: "ok", action: "hotkey" },
      { order: 2, workflowName: "家园活力", stepName: "点击按钮", status: "missing_asset", action: "match" },
    ],
    startedAt: fixedNow,
    endedAt: fixedNow,
    ...overrides,
  };
}

function testFailureStepPrefersExplicitFailedStep() {
  const step = failureStepFromReport(sampleReport());
  assert.equal(step.stepName, "点击按钮");
}

function testFailureStepFallsBackToFailureStatus() {
  const step = failureStepFromReport(
    sampleReport({
      failedWorkflowName: "",
      failedStepName: "",
      stepResults: [
        { order: 1, stepName: "A", status: "ok" },
        { order: 2, stepName: "B", status: "text_miss" },
      ],
    }),
  );
  assert.equal(step.stepName, "B");
}

function testFailureStepSynthesizesMissingRecordedStep() {
  const step = failureStepFromReport(
    sampleReport({
      failureReason: "控制流超过 500 步预算",
      failedWorkflowName: "材料整理",
      failedStepName: "循环回查",
      stepResults: [{ order: 1, workflowName: "材料整理", stepName: "打开背包", status: "ok" }],
    }),
  );
  assert.equal(step.workflowName, "材料整理");
  assert.equal(step.stepName, "循环回查");
  assert.equal(step.action, "session_failure");
  assert.match(step.detail, /控制流/);
}

function testFailureEvidenceBundleIncludesBoundedEvidenceAndFullReport() {
  const bundle = failureEvidenceBundle(sampleReport(), {
    now: () => fixedNow,
    schemaVersion: 9,
    limits: { runEvents: 5, stepResults: 1 },
  });

  assert.equal(bundle.kind, "mhxy-shikong.failure-evidence");
  assert.equal(bundle.workspaceSchemaVersion, 9);
  assert.equal(bundle.generatedAt, fixedNow);
  assert.equal(bundle.summary.failedStepName, "点击按钮");
  assert.equal(bundle.windowIdentity.started.processName, "MyGame_x64r");
  assert.equal(bundle.evidenceCounts.runEvents, 25);
  assert.equal(bundle.latest.runEvents.length, 5);
  assert.equal(bundle.latest.runEvents[0].order, 21);
  assert.equal(bundle.latest.stepResults.length, 1);
  assert.equal(bundle.fullReport.id, "run-1");
}

function testFailureEvidenceSummaryTextIsCopyFriendly() {
  const bundle = failureEvidenceBundle(sampleReport(), { now: () => fixedNow });
  const text = failureEvidenceSummaryText(bundle);
  assert.match(text, /failed/);
  assert.match(text, /家园活力/);
  assert.match(text, /点击按钮/);
}

function testFailureStatusClassifierCatchesDetails() {
  assert.equal(isFailureStepResult({ status: "ok", detail: "identity mismatch" }), true);
  assert.equal(isFailureStepResult({ status: "ok", detail: "all good" }), false);
}

function testFailureStatusClassifierCoversStepTypes() {
  const cases = [
    { stepType: "image_click", status: "missing_asset" },
    { stepType: "wait_image", status: "below_threshold" },
    { stepType: "ocr_assert", status: "text_miss" },
    { stepType: "ocr_assert", status: "ocr_unavailable" },
    { stepType: "ocr_assert", status: "missing_expect" },
    { stepType: "click", status: "error" },
    { stepType: "text_input", status: "unsupported" },
    { stepType: "hotkey", status: "stopped" },
    { stepType: "retry_until", status: "below_threshold" },
  ];
  for (const item of cases) {
    assert.equal(isFailureStepResult(item), true, `${item.stepType}/${item.status}`);
  }
}

const tests = [
  testFailureStepPrefersExplicitFailedStep,
  testFailureStepFallsBackToFailureStatus,
  testFailureStepSynthesizesMissingRecordedStep,
  testFailureEvidenceBundleIncludesBoundedEvidenceAndFullReport,
  testFailureEvidenceSummaryTextIsCopyFriendly,
  testFailureStatusClassifierCatchesDetails,
  testFailureStatusClassifierCoversStepTypes,
];

for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}

console.log(`${tests.length} failure evidence tests passed`);
