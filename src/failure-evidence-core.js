const DEFAULT_LIMITS = {
  runEvents: 20,
  controlFlowTransitions: 20,
  queueEvents: 20,
  pauseEvents: 10,
  stepResults: 20,
};

export function failureEvidenceBundle(report, options = {}) {
  const source = objectValue(report);
  const limits = { ...DEFAULT_LIMITS, ...(objectValue(options.limits)) };
  const failedStep = failureStepFromReport(source);
  const generatedAt = typeof options.now === "function" ? options.now() : new Date().toISOString();
  const runEvents = arrayTail(source.runEvents, limits.runEvents);
  const controlFlowTransitions = arrayTail(source.controlFlowTransitions, limits.controlFlowTransitions);
  const queueEvents = arrayTail(source.queueEvents, limits.queueEvents);
  const pauseEvents = arrayTail(source.pauseEvents, limits.pauseEvents);
  const stepResults = arrayTail(source.stepResults, limits.stepResults);
  return {
    kind: "mhxy-shikong.failure-evidence",
    version: 1,
    generatedAt,
    appName: options.appName || "MHXY-ShiKong-Control",
    workspaceSchemaVersion: Number(options.schemaVersion) || null,
    summary: {
      id: text(source.id),
      status: text(source.status || "unknown"),
      mode: text(source.mode || ""),
      source: text(source.source || ""),
      hwnd: source.hwnd ?? "",
      display: text(source.display || ""),
      workflowId: text(source.workflowId || ""),
      workflowName: text(source.workflowName || ""),
      workflowIds: arrayValue(source.workflowIds).map(text),
      workflowNames: arrayValue(source.workflowNames).map(text),
      queueLength: finiteNumber(source.queueLength, arrayValue(source.workflowIds).length),
      totalSteps: finiteNumber(source.totalSteps, 0),
      completedSteps: finiteNumber(source.completedSteps, arrayValue(source.stepResults).length),
      durationMs: finiteNumber(source.durationMs, 0),
      pauseCount: finiteNumber(source.pauseCount, 0),
      pausedDurationMs: finiteNumber(source.pausedDurationMs, 0),
      failureReason: text(source.failureReason || source.endedWindowIdentityError || ""),
      failedWorkflowName: text(source.failedWorkflowName || failedStep?.workflowName || ""),
      failedStepName: text(source.failedStepName || failedStep?.stepName || ""),
      failedStep: compactStepResult(failedStep),
      startedAt: text(source.startedAt || ""),
      endedAt: text(source.endedAt || ""),
    },
    windowIdentity: {
      started: compactWindowIdentity(source.windowIdentity),
      ended: compactWindowIdentity(source.endedWindowIdentity),
      endedError: text(source.endedWindowIdentityError || ""),
    },
    evidenceCounts: {
      queuePlan: arrayValue(source.queuePlan).length,
      queueEvents: arrayValue(source.queueEvents).length,
      runEvents: arrayValue(source.runEvents).length,
      controlFlowTransitions: arrayValue(source.controlFlowTransitions).length,
      pauseEvents: arrayValue(source.pauseEvents).length,
      stepResults: arrayValue(source.stepResults).length,
    },
    latest: {
      queuePlan: arrayTail(source.queuePlan, 10),
      queueEvents,
      runEvents,
      controlFlowTransitions,
      pauseEvents,
      stepResults,
    },
    fullReport: cloneJsonSafe(source),
  };
}

export function failureEvidenceSummaryText(bundle) {
  const source = objectValue(bundle?.summary);
  const parts = [
    source.status || "unknown",
    source.display || source.hwnd ? `hwnd=${source.display || source.hwnd}` : "",
    source.workflowName || source.workflowNames?.join?.(", "),
    source.failedStepName ? `失败步=${source.failedStepName}` : "",
    source.failureReason ? `原因=${source.failureReason}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

export function failureStepFromReport(report) {
  const source = objectValue(report);
  const steps = arrayValue(source.stepResults);
  const explicit = [...steps].reverse().find((item) => {
    if (source.failedWorkflowName && item?.workflowName !== source.failedWorkflowName) return false;
    if (source.failedStepName && item?.stepName === source.failedStepName) return true;
    return false;
  });
  if (explicit) return explicit;
  if (source.failedWorkflowName || source.failedStepName) {
    return {
      workflowId: text(source.failedWorkflowId || source.workflowId || ""),
      workflowName: text(source.failedWorkflowName || source.workflowName || ""),
      stepId: text(source.failedStepId || ""),
      stepName: text(source.failedStepName || ""),
      stepType: text(source.failedStepType || ""),
      status: text(source.status || "failed"),
      action: "session_failure",
      detail: text(source.failureReason || source.endedWindowIdentityError || ""),
    };
  }
  return [...steps].reverse().find(isFailureStepResult) || steps.at(-1) || null;
}

export function isFailureStepResult(result) {
  const status = text(result?.status || "");
  return (
    ["stopped", "error", "unsupported", "missing_asset", "below_threshold", "text_miss", "ocr_unavailable", "missing_expect"].includes(status) ||
    Boolean(result?.detail && /失败|error|unsupported|identity|threshold|missing/i.test(String(result.detail)))
  );
}

function compactStepResult(step) {
  if (!step) return null;
  return {
    order: step.order ?? null,
    workflowId: text(step.workflowId || ""),
    workflowName: text(step.workflowName || ""),
    stepId: text(step.stepId || ""),
    stepName: text(step.stepName || ""),
    stepType: text(step.stepType || ""),
    status: text(step.status || ""),
    action: text(step.action || ""),
    detail: text(step.detail || ""),
    inputSent: Boolean(step.inputSent),
    matched: Boolean(step.matched),
    score: step.score ?? null,
    x: step.x ?? null,
    y: step.y ?? null,
    startedAt: text(step.startedAt || ""),
    endedAt: text(step.endedAt || ""),
    durationMs: finiteNumber(step.durationMs, 0),
  };
}

function compactWindowIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  return {
    hwnd: identity.hwnd ?? null,
    title: text(identity.title || ""),
    processId: identity.processId ?? null,
    processName: text(identity.processName || ""),
    clientWidth: finiteNumber(identity.clientWidth, 0),
    clientHeight: finiteNumber(identity.clientHeight, 0),
    elevated: typeof identity.elevated === "boolean" ? identity.elevated : null,
  };
}

function arrayTail(value, limit) {
  const items = arrayValue(value);
  const count = Math.max(0, Math.floor(Number(limit) || 0));
  return cloneJsonSafe(count ? items.slice(-count) : []);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value) {
  return String(value ?? "");
}

function cloneJsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
