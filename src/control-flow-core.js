const DEFAULT_MAX_WORKFLOW_JUMPS = 100;
const DEFAULT_MAX_CONTROL_FLOW_TRANSITIONS = 300;

const DEFAULT_TERMINAL_BACKEND_STATUSES = new Set(["error", "unsupported"]);
const DEFAULT_BACKGROUND_FAILURE_STATUSES = new Set([
  "missing_asset",
  "below_threshold",
  "text_miss",
  "ocr_unavailable",
  "missing_expect",
]);
const DEFAULT_PLANNED_ONLY_STEP_TYPES = new Set(["restore"]);

function labelsFrom(options) {
  return options.stepLabels || {};
}

function backgroundFailureStatusesFrom(options) {
  return options.backgroundFailureStatuses || DEFAULT_BACKGROUND_FAILURE_STATUSES;
}

function terminalBackendStatusesFrom(options) {
  return options.terminalBackendStatuses || DEFAULT_TERMINAL_BACKEND_STATUSES;
}

function plannedOnlyStepTypesFrom(options) {
  return options.plannedOnlyStepTypes || DEFAULT_PLANNED_ONLY_STEP_TYPES;
}

export function unboundedWorkflowJumpCycleFindings(workflows) {
  const workflowList = Array.isArray(workflows) ? workflows : [];
  const workflowById = new Map(workflowList.map((workflow) => [String(workflow.id || ""), workflow]));
  const edges = [];
  for (const workflow of workflowList) {
    const workflowId = String(workflow.id || "").trim();
    if (!workflowId) continue;
    for (const step of workflow.steps || []) {
      const targetWorkflowId = String(step.jumpWorkflowId || "").trim();
      if (step.enabled === false || !targetWorkflowId || !workflowById.has(targetWorkflowId)) continue;
      const maxIterations = Math.max(0, Number(step.maxIterations) || 0);
      edges.push({
        workflowId,
        workflowName: workflow.name || workflowId,
        stepId: String(step.id || ""),
        stepName: step.name || step.type || step.id,
        stepType: step.type || "",
        targetWorkflowId,
        targetWorkflowName: workflowById.get(targetWorkflowId)?.name || targetWorkflowId,
        maxIterations,
        bounded: maxIterations > 0,
      });
    }
  }
  const edgesByWorkflow = new Map();
  for (const edge of edges) {
    const group = edgesByWorkflow.get(edge.workflowId) || [];
    group.push(edge);
    edgesByWorkflow.set(edge.workflowId, group);
  }
  const findings = [];
  for (const edge of edges.filter((item) => !item.bounded)) {
    const path = workflowJumpPathToWorkflow(edge.targetWorkflowId, edge.workflowId, edgesByWorkflow);
    if (!path) continue;
    findings.push({
      ...edge,
      cycleWorkflowIds: [edge.workflowId, ...path.workflowIds],
      cycleWorkflowNames: [edge.workflowName, ...path.workflowIds.map((id) => workflowById.get(id)?.name || id)],
    });
  }
  return findings;
}

function workflowJumpPathToWorkflow(startWorkflowId, targetWorkflowId, edgesByWorkflow) {
  const stack = [{ workflowId: startWorkflowId, path: [startWorkflowId] }];
  const visited = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || visited.has(current.workflowId)) continue;
    if (current.workflowId === targetWorkflowId) return { workflowIds: current.path };
    visited.add(current.workflowId);
    for (const edge of edgesByWorkflow.get(current.workflowId) || []) {
      if (visited.has(edge.targetWorkflowId)) continue;
      stack.push({ workflowId: edge.targetWorkflowId, path: [...current.path, edge.targetWorkflowId] });
    }
  }
  return null;
}

export function insertWorkflowJumpIntoRunPlan(session, runPlan, insertIndex, request, options = {}) {
  const {
    workflowById = () => null,
    normalizeQueueItem = (value) => value,
    randomId = (prefix) => `${prefix}-test`,
    failSession = (targetSession, workflow, item, reason) => {
      targetSession.cancelRequested = true;
      targetSession.status = "failed";
      targetSession.failureReason = reason;
      targetSession.failedWorkflowName = workflow?.name || "";
      targetSession.failedStepName = item?.name || item?.type || "";
    },
    renderSessions = () => {},
    maxWorkflowJumps = DEFAULT_MAX_WORKFLOW_JUMPS,
  } = options;

  session.workflowJumpCount = Math.max(0, Number(session.workflowJumpCount) || 0) + 1;
  if (session.workflowJumpCount > maxWorkflowJumps) {
    failSession(
      session,
      { name: request.fromWorkflowName || session.currentWorkflowName || "" },
      { name: request.fromStepName || "任务跳转", type: "task_jump" },
      `任务跳转超过 ${maxWorkflowJumps} 次预算，已停止当前窗口队列`,
    );
    return false;
  }

  const workflow = workflowById(request.workflowId);
  if (!workflow) {
    failSession(
      session,
      { name: request.fromWorkflowName || session.currentWorkflowName || "" },
      { name: request.fromStepName || "任务跳转", type: "task_jump" },
      `任务跳转目标不存在：${request.workflowId}`,
    );
    return false;
  }

  const entry = {
    workflow: JSON.parse(JSON.stringify(workflow)),
    queueItem: normalizeQueueItem({
      id: randomId("queue-jump"),
      workflowId: workflow.id,
      order: insertIndex + 1,
      enabled: true,
      startDelayMs: 0,
      afterDelayMs: 0,
    }),
  };
  runPlan.splice(insertIndex, 0, entry);
  session.workflowIds.splice(insertIndex, 0, workflow.id);
  session.workflowNames.splice(insertIndex, 0, workflow.name);
  session.workflowName = session.workflowIds.length === 1 ? session.workflowNames[0] : `${session.workflowIds.length} 个任务`;
  session.totalSteps += workflow.steps.filter((item) => item.enabled !== false).length;
  session.queuePlan.splice(insertIndex, 0, {
    queueItemId: entry.queueItem.id,
    workflowId: workflow.id,
    workflowName: workflow.name,
    order: insertIndex + 1,
    startDelayMs: 0,
    afterDelayMs: 0,
    insertedBy: "task_jump",
    fromWorkflowId: request.fromWorkflowId || "",
    fromWorkflowName: request.fromWorkflowName || "",
    fromStepId: request.fromStepId || "",
    fromStepName: request.fromStepName || "",
    maxIterations: request.maxIterations || 0,
    iterationCount: request.iterationCount ?? null,
  });
  session.queuePlan.forEach((item, orderIndex) => {
    item.order = orderIndex + 1;
  });
  session.queueEvents.push({
    workflowId: request.fromWorkflowId || "",
    workflowName: request.fromWorkflowName || "",
    phase: "task_jump",
    delayMs: 0,
    status: "queued",
    toWorkflowId: workflow.id,
    toWorkflowName: workflow.name,
    fromStepId: request.fromStepId || "",
    fromStepName: request.fromStepName || "",
    maxIterations: request.maxIterations || 0,
    iterationCount: request.iterationCount ?? null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
  });
  session.logs.unshift(`${request.fromWorkflowName || "任务"} / ${request.fromStepName || "任务跳转"} 插入任务：${workflow.name}`);
  renderSessions();
  return true;
}

export function recoveryDecisionForFailedStep(context, options = {}) {
  const { session, workflow, steps, stepIndexById, item, currentPc, result } = context;
  const backgroundFailureStatuses = backgroundFailureStatusesFrom(options);
  const failureReason = failureReasonFromResult(result);
  const defaultNextPc = currentPc + 1;
  const targetStepId = String(item.recoveryStepId || "").trim();
  const buildTransition = (status, nextPc, extra = {}) => {
    const targetStep = Number.isInteger(nextPc) ? steps[nextPc] : null;
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      fromStepId: item.id,
      fromStepName: item.name || labelsFrom(options)[item.type] || item.type,
      fromStepType: item.type,
      fromIndex: currentPc,
      stepOrder: session.currentStep,
      reason: "failure restore",
      guardResult: null,
      guardSupported: null,
      guardExpression: "",
      configuredTargetStepId: targetStepId,
      toStepId: status === "taken" && targetStep ? targetStep.id : "",
      toStepName: status === "taken" && targetStep ? targetStep.name || labelsFrom(options)[targetStep.type] || targetStep.type : "",
      toStepType: status === "taken" && targetStep ? targetStep.type : "",
      toIndex: status === "taken" && Number.isInteger(nextPc) ? nextPc : null,
      defaultNextStepId: steps[defaultNextPc]?.id || "",
      defaultNextIndex: defaultNextPc < steps.length ? defaultNextPc : null,
      status,
      resultStatus: result?.status || "",
      resultAction: result?.action || "",
      recovery: true,
      ...extra,
    };
  };

  if (session.recoveryContext) {
    return {
      recovered: false,
      failureReason: `恢复分支失败：${failureReason}；原失败：${session.recoveryContext.failureReason}`,
      transition: null,
    };
  }
  if (item.onFail !== "restore") {
    return { recovered: false, failureReason, transition: null };
  }
  if (!backgroundFailureStatuses.has(result?.status || "")) {
    return {
      recovered: false,
      failureReason,
      message: `${workflow.name} / ${item.name} 失败状态 ${result?.status || "unknown"} 不适合自动恢复，已停止`,
      transition: buildTransition("skipped", defaultNextPc, { skippedReason: "status is not recoverable" }),
    };
  }
  if (!targetStepId) {
    return {
      recovered: false,
      failureReason,
      message: `${workflow.name} / ${item.name} 设置了 restore 失败处理，但未配置恢复入口`,
      transition: buildTransition("skipped", defaultNextPc, { skippedReason: "no recoveryStepId configured" }),
    };
  }
  const nextPc = stepIndexById.get(targetStepId);
  if (!Number.isInteger(nextPc)) {
    return {
      recovered: false,
      failureReason,
      message: `${workflow.name} / ${item.name} 恢复入口不可用，已停止`,
      transition: buildTransition("skipped", defaultNextPc, { skippedReason: "recovery step not enabled or missing" }),
    };
  }

  const recoveryStep = steps[nextPc];
  const backward = nextPc <= currentPc;
  let iterationCount = null;
  const maxIterations = Math.max(0, Number(item.maxIterations) || 0);
  if (backward) {
    const key = `${workflow.id}:${item.id}:recovery:${targetStepId}`;
    const currentCount = Number(session.controlFlowCounts?.[key] || 0);
    if (maxIterations <= 0 || currentCount >= maxIterations) {
      const limit = maxIterations <= 0 ? "未设置后向恢复上限" : `已达到 maxIterations=${maxIterations}`;
      return {
        recovered: false,
        failureReason,
        message: `${workflow.name} / ${item.name} 恢复入口 ${stepLabelForExecution(recoveryStep, options)} 被跳过：${limit}`,
        transition: buildTransition("skipped", defaultNextPc, {
          skippedReason: limit,
          requestedToStepId: targetStepId,
          requestedToIndex: nextPc,
          backward: true,
          maxIterations,
          iterationCount: currentCount,
        }),
      };
    }
    session.controlFlowCounts ||= {};
    session.controlFlowCounts[key] = currentCount + 1;
    iterationCount = currentCount + 1;
  }

  session.recoveryContext = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    failedStepId: item.id,
    failedStepName: item.name || labelsFrom(options)[item.type] || item.type,
    failureReason,
    resultStatus: result?.status || "",
    resultAction: result?.action || "",
    recoveryStepId: recoveryStep.id,
    recoveryStepName: recoveryStep.name || labelsFrom(options)[recoveryStep.type] || recoveryStep.type,
    startedAt: new Date().toISOString(),
  };
  return {
    recovered: true,
    nextPc,
    message: `${workflow.name} / ${item.name} 失败后跳转恢复入口：${stepLabelForExecution(recoveryStep, options)}`,
    transition: buildTransition("taken", nextPc, {
      backward,
      maxIterations,
      iterationCount,
      originalFailureReason: failureReason,
    }),
  };
}

export function completeRecoveryAsFailed(session) {
  const context = session.recoveryContext;
  if (!context) return;
  session.status = "failed";
  session.cancelRequested = true;
  session.failureReason = `原失败：${context.failureReason}；恢复分支已执行到任务结束，当前窗口队列已停止`;
  session.failedWorkflowName = context.workflowName;
  session.failedStepName = context.failedStepName;
  session.logs.unshift(`${context.workflowName} / 恢复分支完成，原失败仍停止当前窗口队列`);
  session.recoveryContext = null;
}

export function controlFlowDecisionForStep(context, options = {}) {
  const { session, workflow, steps, stepIndexById, item, currentPc, result, previousResult } = context;
  const plannedOnlyStepTypes = plannedOnlyStepTypesFrom(options);
  let targetStepId = "";
  let workflowJumpId = "";
  let reason = "";
  let guardResult = null;
  let guardSupported = null;
  let guardExpression = "";
  const defaultNextPc = currentPc + 1;
  const buildTransition = (status, nextPc, extra = {}) => {
    const targetStep = Number.isInteger(nextPc) ? steps[nextPc] : null;
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      fromStepId: item.id,
      fromStepName: item.name || labelsFrom(options)[item.type] || item.type,
      fromStepType: item.type,
      fromIndex: currentPc,
      stepOrder: session.currentStep,
      reason,
      guardResult,
      guardSupported,
      guardExpression,
      configuredTargetStepId: targetStepId || "",
      toStepId: status === "taken" && targetStep ? targetStep.id : "",
      toStepName: status === "taken" && targetStep ? targetStep.name || labelsFrom(options)[targetStep.type] || targetStep.type : "",
      toStepType: status === "taken" && targetStep ? targetStep.type : "",
      toIndex: status === "taken" && Number.isInteger(nextPc) ? nextPc : null,
      defaultNextStepId: steps[defaultNextPc]?.id || "",
      defaultNextIndex: defaultNextPc < steps.length ? defaultNextPc : null,
      status,
      resultStatus: result?.status || "",
      resultAction: result?.action || "",
      ...extra,
    };
  };

  const buildWorkflowJumpDecision = (jumpReason) => {
    workflowJumpId = String(item.jumpWorkflowId || "").trim();
    reason = jumpReason;
    if (!workflowJumpId) {
      return {
        nextPc: defaultNextPc,
        message: `${workflow.name} / ${item.name} 未设置任务跳转目标，保持顺序执行`,
        transition: buildTransition("skipped", defaultNextPc, { skippedReason: "no jumpWorkflowId configured" }),
      };
    }
    const targetWorkflow = options.workflowById?.(workflowJumpId);
    if (!targetWorkflow) {
      return {
        nextPc: defaultNextPc,
        message: `${workflow.name} / ${item.name} 任务跳转目标不存在，保持顺序执行`,
        transition: buildTransition("skipped", defaultNextPc, {
          skippedReason: "target workflow missing",
          requestedToWorkflowId: workflowJumpId,
        }),
      };
    }
    const maxIterations = Math.max(0, Number(item.maxIterations) || 0);
    const jumpCountKey = `${workflow.id}:${item.id}:task_jump:${workflowJumpId}`;
    const currentCount = Number(session.controlFlowCounts?.[jumpCountKey] || 0);
    if ((workflowJumpId === workflow.id || maxIterations > 0) && (maxIterations <= 0 || currentCount >= maxIterations)) {
      const limit = maxIterations <= 0 ? "未设置任务跳转上限" : `已达到 maxIterations=${maxIterations}`;
      return {
        nextPc: defaultNextPc,
        message: `${workflow.name} / ${item.name} 任务跳转到 ${targetWorkflow.name} 被跳过：${limit}`,
        transition: buildTransition("skipped", defaultNextPc, {
          skippedReason: limit,
          requestedToWorkflowId: workflowJumpId,
          toWorkflowId: targetWorkflow.id,
          toWorkflowName: targetWorkflow.name,
          workflowJump: true,
          maxIterations,
          iterationCount: currentCount,
        }),
      };
    }
    if (workflowJumpId === workflow.id || maxIterations > 0) {
      session.controlFlowCounts ||= {};
      session.controlFlowCounts[jumpCountKey] = currentCount + 1;
    }
    return {
      nextPc: steps.length,
      workflowJumpId,
      workflowJumpName: targetWorkflow.name,
      maxIterations,
      iterationCount: workflowJumpId === workflow.id || maxIterations > 0 ? currentCount + 1 : null,
      message: `${workflow.name} / ${item.name} 任务跳转到 ${targetWorkflow.name}`,
      transition: buildTransition("taken", steps.length, {
        toWorkflowId: targetWorkflow.id,
        toWorkflowName: targetWorkflow.name,
        requestedToWorkflowId: workflowJumpId,
        workflowJump: true,
        maxIterations,
        iterationCount: workflowJumpId === workflow.id || maxIterations > 0 ? currentCount + 1 : null,
      }),
    };
  };

  if (item.type === "condition") {
    const guard = evaluateConditionGuard(item, result, previousResult);
    guardResult = guard.passed;
    guardSupported = guard.supported;
    guardExpression = guard.expression;
    if (!guard.supported) {
      reason = "condition unsupported";
      return {
        nextPc: defaultNextPc,
        message: `${workflow.name} / ${item.name} 条件 guard=${guard.expression || "空"} 当前不支持，保持顺序执行`,
        transition: buildTransition("skipped", defaultNextPc, { skippedReason: "unsupported guard expression" }),
      };
    }
    targetStepId = guard.passed ? item.targetStepId : item.elseTargetStepId;
    reason = `condition ${guard.passed ? "true" : "false"}`;
    if (guard.passed && !targetStepId && item.jumpWorkflowId) {
      return buildWorkflowJumpDecision("condition true task_jump");
    }
  } else if (
    isSuccessfulStepResult(result, options) &&
    result?.status !== "planned" &&
    !plannedOnlyStepTypes.has(item.type) &&
    item.jumpWorkflowId
  ) {
    return buildWorkflowJumpDecision(item.type === "task_jump" ? "task_jump" : "success task_jump");
  } else if (
    item.type === "loop" &&
    (isSuccessfulStepResult(result, options) || result?.status === "planned") &&
    !plannedOnlyStepTypes.has(item.type) &&
    item.targetStepId
  ) {
    targetStepId = item.targetStepId;
    reason = "loop";
  } else if (
    isSuccessfulStepResult(result, options) &&
    result?.status !== "planned" &&
    !plannedOnlyStepTypes.has(item.type) &&
    item.targetStepId
  ) {
    targetStepId = item.targetStepId;
    reason = "success";
  }

  if (!targetStepId) {
    return {
      nextPc: defaultNextPc,
      message: item.type === "loop" ? `${workflow.name} / ${item.name} 循环步骤未设置循环目标，保持顺序执行` : "",
      transition: ["condition", "loop"].includes(item.type)
        ? buildTransition("fallthrough", defaultNextPc, { skippedReason: "no target step configured" })
        : null,
    };
  }

  const nextPc = stepIndexById.get(targetStepId);
  if (!Number.isInteger(nextPc)) {
    return {
      nextPc: defaultNextPc,
      message: "",
      transition: buildTransition("skipped", defaultNextPc, { skippedReason: "target step not enabled or missing" }),
    };
  }

  if (item.type === "loop" && nextPc >= currentPc) {
    const reasonText = "循环目标必须位于当前步骤之前";
    return {
      nextPc: defaultNextPc,
      message: `${workflow.name} / ${item.name} 循环到 ${stepLabelForExecution(steps[nextPc], options)} 被跳过：${reasonText}`,
      transition: buildTransition("skipped", defaultNextPc, {
        skippedReason: reasonText,
        requestedToStepId: targetStepId,
        requestedToIndex: nextPc,
        backward: false,
        maxIterations: Math.max(0, Number(item.maxIterations) || 0),
        iterationCount: null,
      }),
    };
  }

  if (nextPc <= currentPc) {
    const maxIterations = Math.max(0, Number(item.maxIterations) || 0);
    const key = `${workflow.id}:${item.id}:${targetStepId}`;
    const currentCount = Number(session.controlFlowCounts?.[key] || 0);
    if (maxIterations <= 0 || currentCount >= maxIterations) {
      const limit = maxIterations <= 0 ? "未设置后向跳转上限" : `已达到 maxIterations=${maxIterations}`;
      return {
        nextPc: defaultNextPc,
        message: `${workflow.name} / ${item.name} ${reason} 后向跳转到 ${stepLabelForExecution(steps[nextPc], options)} 被跳过：${limit}`,
        transition: buildTransition("skipped", defaultNextPc, {
          skippedReason: limit,
          requestedToStepId: targetStepId,
          requestedToIndex: nextPc,
          backward: true,
          maxIterations,
          iterationCount: currentCount,
        }),
      };
    }
    session.controlFlowCounts ||= {};
    session.controlFlowCounts[key] = currentCount + 1;
    return {
      nextPc,
      message: `${workflow.name} / ${item.name} ${reason} 跳转到 ${stepLabelForExecution(steps[nextPc], options)}`,
      transition: buildTransition("taken", nextPc, {
        backward: true,
        maxIterations,
        iterationCount: currentCount + 1,
      }),
    };
  }

  return {
    nextPc,
    message: `${workflow.name} / ${item.name} ${reason} 跳转到 ${stepLabelForExecution(steps[nextPc], options)}`,
    transition: buildTransition("taken", nextPc, {
      backward: false,
      maxIterations: Math.max(0, Number(item.maxIterations) || 0),
      iterationCount: null,
    }),
  };
}

export function evaluateConditionGuard(item, result, previousResult) {
  const expression = (commandValue(item.command, "guard") || item.expect || "true").trim();
  const raw = expression.toLowerCase();
  const last = previousResult || result || {};
  const outcome = (supported, passed, source) => ({ expression, supported, passed: Boolean(passed), source });
  if (["true", "1", "yes", "y", "continue", "pass", "passed", "ready", "ready=true"].includes(raw)) return outcome(true, true, "literal");
  if (["false", "0", "no", "n", "stop", "fail", "failed", "blocked"].includes(raw)) return outcome(true, false, "literal");
  if (["matched", "last.matched"].includes(raw)) return outcome(true, Boolean(last.matched), "last.matched");
  if (["!matched", "not matched", "last.!matched", "!last.matched"].includes(raw)) return outcome(true, !last.matched, "last.matched");
  if (["inputsent", "input_sent", "last.inputsent", "last.input_sent"].includes(raw)) return outcome(true, Boolean(last.inputSent), "last.inputSent");
  const statusMatch = raw.match(/^(?:last\.)?status\s*={1,2}\s*([a-z0-9_-]+)$/);
  if (statusMatch) return outcome(true, String(last.status || "").toLowerCase() === statusMatch[1], "last.status");
  const actionMatch = raw.match(/^(?:last\.)?action\s*={1,2}\s*([a-z0-9_-]+)$/);
  if (actionMatch) return outcome(true, String(last.action || "").toLowerCase() === actionMatch[1], "last.action");
  const scoreMatch = raw.match(/^(?:last\.)?score\s*(>=|<=|>|<|={1,2})\s*(-?\d+(?:\.\d+)?)$/);
  if (scoreMatch) return outcome(true, compareNumbers(Number(last.score), scoreMatch[1], Number(scoreMatch[2])), "last.score");
  const bareScoreMatch = raw.match(/^(=>|>=|<=|>|<|={1,2})\s*(-?\d+(?:\.\d+)?)$/);
  if (bareScoreMatch) {
    const operator = bareScoreMatch[1] === "=>" ? ">=" : bareScoreMatch[1];
    return outcome(true, compareNumbers(Number(last.score), operator, Number(bareScoreMatch[2])), "last.score");
  }
  return outcome(false, false, "unsupported");
}

export function compareNumbers(left, operator, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  return left === right;
}

export function recordControlFlowTransition(session, transition, options = {}) {
  if (!transition) return;
  const maxControlFlowTransitions = options.maxControlFlowTransitions || DEFAULT_MAX_CONTROL_FLOW_TRANSITIONS;
  session.controlFlowTransitionSerial = Math.max(0, Number(session.controlFlowTransitionSerial) || 0) + 1;
  const record = {
    order: session.controlFlowTransitionSerial,
    at: new Date().toISOString(),
    ...transition,
  };
  session.controlFlowTransitions ||= [];
  session.controlFlowTransitions.push(record);
  if (session.controlFlowTransitions.length > maxControlFlowTransitions) {
    session.controlFlowTransitions.splice(0, session.controlFlowTransitions.length - maxControlFlowTransitions);
  }
}

export function isSuccessfulStepResult(result, options = {}) {
  const status = result?.status || "unknown";
  return !terminalBackendStatusesFrom(options).has(status) && !backgroundFailureStatusesFrom(options).has(status) && status !== "stopped";
}

export function stepLabelForExecution(item, options = {}) {
  const stepLabels = labelsFrom(options);
  return item ? `${item.name || stepLabels[item.type] || item.type} [${item.type}]` : "未知步骤";
}

export function failureReasonFromResult(result) {
  return result?.detail || `${result?.status || "unknown"}/${result?.action || "unknown"}`;
}

function commandValue(command, key) {
  const parts = String(command || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [rawKey, ...rest] = part.split("=");
    if (rawKey?.trim().toLowerCase() === key.toLowerCase()) return rest.join("=").trim();
  }
  return "";
}
