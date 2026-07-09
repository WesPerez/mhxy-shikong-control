#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  commandParts,
  commandValue,
  commandWithValues,
  normalizeStepParams,
  projectStepParamsToLegacy,
  syncStepParamsFromLegacy,
  syncStepParamsToLegacy,
} from "../src/step-params-core.js";

function partMap(command) {
  const keyed = new Map();
  const raw = [];
  for (const part of commandParts(command)) {
    if (part.key) keyed.set(part.key, part.value);
    else raw.push(part.raw);
  }
  return { keyed, raw };
}

function testLegacyHotkeyBackfillsParams() {
  const step = syncStepParamsFromLegacy({
    type: "hotkey",
    target: "ALT+N",
    command: "trace-token; mode=hwnd-key",
    expect: "panel.open",
    timeoutMs: 1200,
    params: { futureFlag: "keep" },
  });

  assert.equal(step.params.hotkey, "ALT+N");
  assert.equal(step.params.mode, "hwnd-key");
  assert.equal(step.params.futureFlag, "keep");
  assert.equal(step.target, "ALT+N");
  assert.equal(commandValue(step.command, "mode"), "hwnd-key");
  assert.deepEqual(partMap(step.command).raw, ["trace-token"]);
}

function testParamsProjectToLegacyWithPriority() {
  const step = syncStepParamsToLegacy({
    type: "hotkey",
    target: "ALT+N",
    command: "trace-token; mode=legacy",
    expect: "panel.open",
    timeoutMs: 1200,
    params: { hotkey: "CTRL+1", mode: "hwnd-key" },
  });

  assert.equal(step.target, "CTRL+1");
  assert.equal(commandValue(step.command, "mode"), "hwnd-key");
  assert.deepEqual(partMap(step.command).raw, ["trace-token"]);
}

function testCommandUpdatesPreserveRawAndUnknownKeys() {
  const command = commandWithValues("raw-token; custom=1; mode=old", { mode: "new", button: "right" });
  const parts = partMap(command);

  assert.deepEqual(parts.raw, ["raw-token"]);
  assert.equal(parts.keyed.get("custom"), "1");
  assert.equal(parts.keyed.get("mode"), "new");
  assert.equal(parts.keyed.get("button"), "right");

  const removed = commandWithValues(command, { button: "" });
  assert.equal(commandValue(removed, "button"), "");
  assert.equal(commandValue(removed, "mode"), "new");
  assert.equal(commandValue(removed, "custom"), "1");
}

function testTextInputLegacyAndParams() {
  const legacy = syncStepParamsFromLegacy({
    type: "text_input",
    target: "活力",
    command: "mode=hwnd-char",
    expect: "text.sent",
    timeoutMs: 1200,
  });
  assert.equal(legacy.params.text, "活力");
  assert.equal(legacy.target, "活力");

  const projected = syncStepParamsToLegacy({
    ...legacy,
    params: { ...legacy.params, text: "家园活力" },
  });
  assert.equal(projected.target, "家园活力");
  assert.equal(commandValue(projected.command, "mode"), "hwnd-char");
}

function testClickPointProjection() {
  const step = syncStepParamsToLegacy({
    type: "click",
    target: "x=0,y=0",
    command: "button=left; mode=hwnd-message",
    expect: "click.accepted",
    timeoutMs: 1300,
    params: { clickX: 321, clickY: 654, button: "right", mode: "hwnd-message" },
  });

  assert.equal(step.target, "x=321,y=654");
  assert.equal(commandValue(step.command, "button"), "right");
  assert.equal(commandValue(step.command, "mode"), "hwnd-message");
}

function testImageClickProjection() {
  const step = syncStepParamsToLegacy({
    type: "image_click",
    target: "button.old",
    command: "threshold=0.7; point=center",
    expect: "screen.changed",
    timeoutMs: 4500,
    params: {
      imageTarget: "button.confirm",
      threshold: 0.92,
      point: "bottom-right",
      offsetX: 6,
      offsetY: -3,
      button: "left",
    },
  });

  assert.equal(step.target, "button.confirm");
  assert.equal(commandValue(step.command, "threshold"), "0.92");
  assert.equal(commandValue(step.command, "point"), "bottom-right");
  assert.equal(commandValue(step.command, "offsetX"), "6");
  assert.equal(commandValue(step.command, "offsetY"), "-3");
  assert.equal(commandValue(step.command, "button"), "left");
}

function testDelayOcrConditionAndRetry() {
  const delay = syncStepParamsToLegacy({
    type: "delay",
    target: "100ms",
    command: "reason=old",
    expect: "time.elapsed",
    timeoutMs: 100,
    params: { delayMs: 850, reason: "animation" },
  });
  assert.equal(delay.target, "850ms");
  assert.equal(delay.timeoutMs, 850);
  assert.equal(commandValue(delay.command, "reason"), "animation");

  const ocr = syncStepParamsToLegacy({
    type: "ocr_assert",
    target: "text.keyword",
    command: "lang=zh; roi=auto",
    expect: "text_found",
    timeoutMs: 4200,
    params: { ocrText: "累计奖励", lang: "zh-Hans", roi: "named-region" },
  });
  assert.equal(ocr.expect, "累计奖励");
  assert.equal(commandValue(ocr.command, "lang"), "zh-Hans");
  assert.equal(commandValue(ocr.command, "roi"), "named-region");

  const condition = syncStepParamsToLegacy({
    type: "condition",
    target: "last.score",
    command: "guard=true",
    expect: "condition.checked",
    timeoutMs: 1000,
    params: { conditionLabel: "last.status", guard: "last.status=ok" },
  });
  assert.equal(condition.target, "last.status");
  assert.equal(commandValue(condition.command, "guard"), "last.status=ok");

  const retry = syncStepParamsToLegacy({
    type: "retry_until",
    target: "page.old",
    command: "interval=500ms",
    expect: "ready=true",
    timeoutMs: 8000,
    params: { retryTarget: "page.home.ready", intervalMs: 1200 },
  });
  assert.equal(retry.target, "page.home.ready");
  assert.equal(commandValue(retry.command, "interval"), "1200ms");
}

function testOcrLegacyPrefersTargetOverGenericExpect() {
  const legacy = syncStepParamsFromLegacy({
    type: "ocr_assert",
    target: "帮派福利",
    command: "lang=zh; roi=top",
    expect: "text_found",
    timeoutMs: 4200,
    params: { ocrText: "old-generic" },
  });

  assert.equal(legacy.params.ocrText, "帮派福利");
  assert.equal(legacy.expect, "帮派福利");
  assert.equal(commandValue(legacy.command, "lang"), "zh");
  assert.equal(commandValue(legacy.command, "roi"), "top");
}

function testLegacyRefreshKeepsFutureParamsButReplacesKnownParams() {
  const step = syncStepParamsFromLegacy({
    type: "click",
    target: "x=8,y=9",
    command: "button=right; mode=hwnd-message",
    expect: "click.accepted",
    timeoutMs: 1300,
    params: {
      clickX: 1,
      clickY: 2,
      futureNestedName: "survives",
    },
  });

  assert.equal(step.params.clickX, 8);
  assert.equal(step.params.clickY, 9);
  assert.equal(step.params.futureNestedName, "survives");
  assert.equal(step.target, "x=8,y=9");
}

function testLegacyRefreshReplacesStaleImageTarget() {
  const step = syncStepParamsFromLegacy({
    type: "image_click",
    target: "button.new",
    command: "threshold=0.91; button=right; point=bottom-right",
    expect: "screen.changed",
    timeoutMs: 2600,
    targetId: "button.new",
    params: {
      imageTarget: "button.old",
      threshold: 0.5,
      futureFlag: "keep",
    },
  });

  assert.equal(step.target, "button.new");
  assert.equal(step.params.imageTarget, "button.new");
  assert.equal(step.params.threshold, 0.91);
  assert.equal(step.params.futureFlag, "keep");
  assert.equal(commandValue(step.command, "threshold"), "0.91");
  assert.equal(commandValue(step.command, "button"), "right");
}

function testNormalizeParamsIgnoresInvalidValues() {
  const params = normalizeStepParams({
    type: "delay",
    target: "1s",
    command: "reason=animation",
    timeoutMs: 1000,
    params: {
      delayMs: "",
      invalidObject: { nested: true },
      validFlag: true,
    },
  });

  assert.equal(params.delayMs, 1000);
  assert.equal(params.validFlag, true);
  assert.equal(Object.hasOwn(params, "invalidObject"), false);
}

function testDirectProjectionDoesNotRequireNormalizeStep() {
  const projected = projectStepParamsToLegacy({
    type: "wait_image",
    target: "",
    command: "custom=true",
    expect: "ready",
    timeoutMs: 1000,
    params: { imageTarget: "page.ready", threshold: 0.88 },
  });

  assert.equal(projected.target, "page.ready");
  assert.equal(commandValue(projected.command, "custom"), "true");
  assert.equal(commandValue(projected.command, "threshold"), "0.88");
}

function testNonParamWorkflowFieldsArePreserved() {
  const step = syncStepParamsToLegacy({
    id: "step-1",
    type: "task_jump",
    target: "workflow.next",
    command: "mode=same-window-queue",
    expect: "jump.workflow",
    timeoutMs: 0,
    retry: 0,
    onFail: "stop",
    enabled: false,
    targetStepId: "step-success",
    elseTargetStepId: "step-else",
    recoveryStepId: "step-recovery",
    jumpWorkflowId: "wf-next",
    maxIterations: 3,
    params: { futureFlag: "keep" },
  });

  assert.equal(step.id, "step-1");
  assert.equal(step.enabled, false);
  assert.equal(step.targetStepId, "step-success");
  assert.equal(step.elseTargetStepId, "step-else");
  assert.equal(step.recoveryStepId, "step-recovery");
  assert.equal(step.jumpWorkflowId, "wf-next");
  assert.equal(step.maxIterations, 3);
  assert.equal(step.params.futureFlag, "keep");
}

function testDoubleClickImageTargetWinsOverCoordinates() {
  const projected = syncStepParamsToLegacy({
    type: "double_click",
    target: "x=10,y=20",
    command: "button=left; mode=hwnd-message",
    expect: "double_click.accepted",
    timeoutMs: 1500,
    params: {
      clickX: 10,
      clickY: 20,
      imageTarget: "button.reward",
      threshold: 0.9,
    },
  });

  assert.equal(projected.target, "button.reward");
  assert.equal(commandValue(projected.command, "threshold"), "0.9");
  assert.equal(commandValue(projected.command, "mode"), "hwnd-message");
}

function testDoubleClickCoordinatesWorkWithoutImageTarget() {
  const projected = syncStepParamsToLegacy({
    type: "double_click",
    target: "button.old",
    command: "button=left",
    expect: "double_click.accepted",
    timeoutMs: 1500,
    params: {
      clickX: 10,
      clickY: 20,
      button: "right",
    },
  });

  assert.equal(projected.target, "x=10,y=20");
  assert.equal(commandValue(projected.command, "button"), "right");
  assert.equal(commandValue(projected.command, "mode"), "hwnd-message");
}

const tests = [
  testLegacyHotkeyBackfillsParams,
  testParamsProjectToLegacyWithPriority,
  testCommandUpdatesPreserveRawAndUnknownKeys,
  testTextInputLegacyAndParams,
  testClickPointProjection,
  testImageClickProjection,
  testDelayOcrConditionAndRetry,
  testOcrLegacyPrefersTargetOverGenericExpect,
  testLegacyRefreshKeepsFutureParamsButReplacesKnownParams,
  testLegacyRefreshReplacesStaleImageTarget,
  testNormalizeParamsIgnoresInvalidValues,
  testDirectProjectionDoesNotRequireNormalizeStep,
  testNonParamWorkflowFieldsArePreserved,
  testDoubleClickImageTargetWinsOverCoordinates,
  testDoubleClickCoordinatesWorkWithoutImageTarget,
];

for (const test of tests) {
  test();
}

console.log(`step-params-core: ${tests.length} tests passed`);
