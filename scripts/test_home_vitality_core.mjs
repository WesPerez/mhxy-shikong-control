import assert from "node:assert/strict";
import {
  HOME_VITALITY_BLUEPRINT,
  HOME_VITALITY_LIVE_GATE_CHECKLIST,
  HOME_VITALITY_TEMPLATE_BINDINGS,
  assessHomeVitalityLiveGates,
  assessHomeVitalityReadiness,
  requiredVisualTargets,
  summarizeHomeVitalityGaps,
} from "../src/home-vitality-core.js";

function testBlueprintHasEnoughStepsAndVisualTargets() {
  assert.equal(HOME_VITALITY_BLUEPRINT.id, "home-vitality");
  assert.ok(HOME_VITALITY_BLUEPRINT.steps.length >= 10);
  const targets = requiredVisualTargets();
  assert.ok(targets.includes("page.home.ready"));
  assert.ok(targets.includes("entry.home"));
  assert.ok(targets.includes("button.home_clean"));
  assert.ok(targets.includes("page.home_yard.ready"));
  assert.ok(HOME_VITALITY_TEMPLATE_BINDINGS.some((item) => item.target === "button.home_clean"));
  assert.equal(
    HOME_VITALITY_TEMPLATE_BINDINGS.some((item) => item.target === "entry.home" && item.key === "jiayuan/jiayuan.png"),
    true,
    "entry.home must bind offline to jiayuan/jiayuan.png",
  );
}

function testMissingEntryHomeIsNeedsCaptureWhenTemplateKeyUnavailable() {
  const assessment = assessHomeVitalityReadiness({
    availableTemplateKeys: ["zonghe/jiahao.png", "jiayuan/dali.png"],
  });
  assert.equal(assessment.stepCount, HOME_VITALITY_BLUEPRINT.steps.length);
  assert.equal(assessment.liveReady, false);
  assert.equal(assessment.liveInputAuthorized, false);
  assert.equal(assessment.offlineScaffoldReady, false);
  assert.ok(assessment.missingVisualTargets.includes("entry.home"));
  const entrySteps = assessment.steps.filter((item) => item.target === "entry.home");
  assert.ok(entrySteps.length >= 1);
  for (const step of entrySteps) {
    assert.equal(step.ready, false);
    assert.equal(step.status, "needs_capture");
    assert.equal(step.liveInput, false);
  }
}

function testEntryHomeReadyWithBuiltinTemplateKeyButNeverLive() {
  const assessment = assessHomeVitalityReadiness({
    availableTemplateKeys: ["zonghe/jiahao.png", "jiayuan/dali.png", "jiayuan/jiayuan.png"],
  });
  assert.equal(assessment.liveReady, false);
  assert.equal(assessment.liveInputAuthorized, false);
  assert.equal(assessment.offlineScaffoldReady, true);
  assert.deepEqual(assessment.missingVisualTargets, []);
  const entrySteps = assessment.steps.filter((item) => item.target === "entry.home");
  assert.ok(entrySteps.length >= 1);
  for (const step of entrySteps) {
    assert.equal(step.ready, true);
    assert.equal(step.status, "builtin_template_available");
    assert.equal(step.liveInput, false);
    assert.equal(step.templateKey, "jiayuan/jiayuan.png");
  }
}

function testBoundAssetsMakeVisualStepsReadyButNotLive() {
  const assessment = assessHomeVitalityReadiness({
    availableTemplateKeys: ["zonghe/jiahao.png", "jiayuan/dali.png"],
    targetAssets: {
      "page.home.ready": { loaded: true },
      "page.home_yard.ready": { loaded: true },
      "button.home_clean": { loaded: true },
      "entry.home": { dataUrl: "data:image/png;base64,aaa" },
    },
  });
  assert.equal(assessment.offlineScaffoldReady, true);
  assert.equal(assessment.liveReady, false);
  assert.equal(assessment.liveInputAuthorized, false);
  assert.deepEqual(assessment.missingVisualTargets, []);
  const ocr = assessment.steps.filter((item) => item.type === "ocr_assert");
  assert.ok(ocr.length >= 1);
  for (const step of ocr) {
    assert.equal(step.status, "needs_ocr_backend");
    assert.equal(step.ready, false);
    assert.equal(step.liveInput, false);
  }
  const restore = assessment.steps.find((item) => item.type === "restore");
  assert.equal(restore.status, "planned_restore");
  assert.equal(restore.ready, false);
  const hotkey = assessment.steps.find((item) => item.type === "hotkey");
  assert.equal(hotkey.status, "planned_hotkey");
  assert.equal(hotkey.ready, true);
  assert.equal(hotkey.liveInput, false);
}

function testGapSummaryListsOcrWhenTemplatesPresent() {
  const summary = summarizeHomeVitalityGaps(
    assessHomeVitalityReadiness({
      availableTemplateKeys: ["zonghe/jiahao.png", "jiayuan/dali.png", "jiayuan/jiayuan.png"],
    }),
  );
  assert.equal(summary.liveReady, false);
  assert.equal(summary.offlineScaffoldReady, true);
  assert.ok(summary.gaps.some((item) => item.kind === "ocr"));
  assert.equal(summary.gaps.some((item) => item.target === "entry.home"), false);
}

function testLiveGateChecklistIsFailClosedEvenWhenAllObserved() {
  assert.ok(HOME_VITALITY_LIVE_GATE_CHECKLIST.length >= 5);
  const observations = Object.fromEntries(HOME_VITALITY_LIVE_GATE_CHECKLIST.map((item) => [item.id, true]));
  const gates = assessHomeVitalityLiveGates({ observations });
  assert.equal(gates.liveReady, false);
  assert.equal(gates.liveInputAuthorized, false);
  assert.equal(gates.requiredSatisfied, true);
  assert.ok(gates.items.every((item) => item.authorized === false));
  const empty = assessHomeVitalityLiveGates();
  assert.equal(empty.requiredSatisfied, false);
  assert.equal(empty.liveReady, false);
}

const tests = [
  testBlueprintHasEnoughStepsAndVisualTargets,
  testMissingEntryHomeIsNeedsCaptureWhenTemplateKeyUnavailable,
  testEntryHomeReadyWithBuiltinTemplateKeyButNeverLive,
  testBoundAssetsMakeVisualStepsReadyButNotLive,
  testGapSummaryListsOcrWhenTemplatesPresent,
  testLiveGateChecklistIsFailClosedEvenWhenAllObserved,
];

for (const test of tests) {
  test();
  console.log("ok " + test.name);
}

console.log(String(tests.length) + " home vitality tests passed");
