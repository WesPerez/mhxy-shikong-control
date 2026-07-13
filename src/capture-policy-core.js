export function controlCaptureEligible(result) {
  const provider = String(result?.captureProvider || "");
  const trustedProvider = provider === "window_print" || provider === "window_gdi";
  return Boolean(
    result
      && trustedProvider
      && result.captureReliability === "health_verified",
  );
}

export function targetVerificationPassed(result) {
  return Boolean(
    controlCaptureEligible(result)
      && result.status === "matched"
      && result.matched === true,
  );
}

export function previewCaptureSummary(preview) {
  const provider = String(preview?.captureProvider || "unknown");
  const reliability = String(preview?.captureReliability || "unknown");
  const trusted = (provider === "window_print" || provider === "window_gdi")
    && reliability === "health_verified";
  const label = reliability === "preview_only"
    ? "不可信预览"
    : reliability === "target_window_unverified"
      ? "目标窗口来源（未验证）"
      : trusted
        ? "可信目标窗口"
        : "来源未知";
  return { provider, reliability, trusted, label };
}
