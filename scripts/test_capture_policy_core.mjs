import assert from "node:assert/strict";
import {
  controlCaptureEligible,
  previewCaptureSummary,
  targetVerificationPassed,
} from "../src/capture-policy-core.js";

function testPlannedOrPreviewOnlyNeverPassesTargetVerification() {
  assert.equal(targetVerificationPassed({ status: "planned", matched: true }), false);
  assert.equal(targetVerificationPassed({
    status: "matched",
    matched: true,
    captureProvider: "desktop_visible_gdi",
    captureReliability: "preview_only",
  }), false);
}

function testOnlyHealthVerifiedTargetCapturePasses() {
  const result = {
    status: "matched",
    matched: true,
    captureProvider: "window_gdi",
    captureReliability: "health_verified",
  };
  assert.equal(controlCaptureEligible(result), true);
  assert.equal(targetVerificationPassed(result), true);
  assert.equal(targetVerificationPassed({ ...result, matched: false }), false);
  assert.equal(controlCaptureEligible({
    ...result,
    captureProvider: "window_print",
  }), true);
  assert.equal(controlCaptureEligible({
    ...result,
    captureReliability: "target_window_unverified",
  }), false);
}

function testPreviewSummaryExposesUntrustedFallback() {
  assert.deepEqual(previewCaptureSummary({
    captureProvider: "desktop_visible_gdi",
    captureReliability: "preview_only",
  }), {
    provider: "desktop_visible_gdi",
    reliability: "preview_only",
    trusted: false,
    label: "不可信预览",
  });
}

for (const test of [
  testPlannedOrPreviewOnlyNeverPassesTargetVerification,
  testOnlyHealthVerifiedTargetCapturePasses,
  testPreviewSummaryExposesUntrustedFallback,
]) {
  test();
  console.log(`ok ${test.name}`);
}
console.log("3 capture policy tests passed");
