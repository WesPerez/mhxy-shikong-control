#!/usr/bin/env python3
"""Audit strict control capture and preview-only fallback boundaries."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def function_block(source: str, signature: str) -> str:
    start = source.find(signature)
    if start < 0:
        return ""
    end = source.find("\nfn ", start + len(signature))
    return source[start:] if end < 0 else source[start:end]


def require(failures: list[str], source: str, token: str, message: str) -> None:
    if token not in source:
        failures.append(message)


def main() -> int:
    # P3 health module presence is enforced below after paths are resolved.
    platform = (ROOT / "src-tauri/src/platform.rs").read_text(encoding="utf-8")
    capture_health = (ROOT / "src-tauri/src/runtime/capture_health.rs").read_text(encoding="utf-8")
    rust_main = (ROOT / "src-tauri/src/main.rs").read_text(encoding="utf-8")
    frontend = (ROOT / "src/main.js").read_text(encoding="utf-8")
    capture_core = (ROOT / "src/capture-policy-core.js").read_text(encoding="utf-8")
    capture_test = (ROOT / "scripts/test_capture_policy_core.mjs").read_text(encoding="utf-8")
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    failures: list[str] = []

    for token, message in [
        ("pub struct CapturedFrame", "CapturedFrame wrapper is missing"),
        ("pub struct CaptureMetadata", "capture metadata is missing"),
        ("WindowPrint", "window PrintWindow provider is missing"),
        ("WindowGdi", "window GDI provider is missing"),
        ("DesktopVisibleGdi", "desktop preview provider is missing"),
        ("TargetWindowUnverified", "target-window unverified reliability is missing"),
        ("HealthVerified", "health-verified reliability is missing"),
        ("PreviewOnly", "preview-only reliability is missing"),
        ("frame_hash", "capture frame hash is missing"),
        ("captured_at_ms", "capture timestamp is missing"),
        ("assess_target_frame_health", "frame health assessment is missing"),
        ("capture_client_rgb_print", "PrintWindow capture entry is missing"),
        ("strict_capture_never_calls_desktop_fallback", "strict fallback regression test is missing"),
        ("preview_fallback_is_explicitly_preview_only", "preview fallback regression test is missing"),
        ("black_primary_frame_stays_unverified_for_control", "black frame fail-closed test is missing"),
    ]:
        require(failures, platform, token, message)

    strict_capture = function_block(platform, "pub fn capture_client_rgb_strict(")
    require(failures, strict_capture, "CapturePurpose::Control", "strict capture must use control policy")
    preview_capture = function_block(platform, "pub fn capture_client_rgb(")
    require(failures, preview_capture, "CapturePurpose::Preview", "manual preview must use preview policy")

    loose_calls = [
        line.strip()
        for line in rust_main.splitlines()
        if "capture_client_rgb(" in line and "fn capture_client_rgb" not in line
    ]
    if loose_calls != ["let captured = capture_client_rgb(hwnd)?;"]:
        failures.append(f"loose capture must be confined to capture_window_preview: {loose_calls}")
    preview_command = function_block(rust_main, "fn capture_window_preview(")
    require(failures, preview_command, "capture_client_rgb(hwnd)?", "manual preview must be the only loose capture consumer")

    for signature in [
        "fn execute_workflow_step_unlocked(",
        "fn save_window_snapshot(",
        "fn dispatch_image_step(",
        "fn dispatch_ocr_step(",
    ]:
        require(
            failures,
            function_block(rust_main, signature),
            "capture_client_rgb_strict",
            f"{signature} must use strict capture",
        )

    for token, message in [
        ("capture_provider: Option<CaptureProvider>", "step result capture provider is missing"),
        ("capture_reliability: Option<CaptureReliability>", "step result reliability is missing"),
        ("captured_at_ms: Option<u64>", "step result capture timestamp is missing"),
        ("frame_hash: Option<String>", "step result frame hash is missing"),
        ("unverified_visual_capture_never_calls_input_action", "unverified capture zero-input test is missing"),
        ("step_result_keeps_capture_provenance", "step result provenance test is missing"),
    ]:
        require(failures, rust_main, token, message)

    require(failures, frontend, "targetVerificationPassed(result)", "target verification must use capture trust policy")
    require(failures, frontend, "previewCaptureSummary(preview)", "preview UI must expose capture trust")
    require(failures, frontend, "captureProvider: result?.captureProvider", "step reports must retain capture provider")
    require(failures, frontend, '"capture_unreliable"', "capture_unreliable must fail closed in the runner")
    require(failures, capture_core, 'result.status === "matched"', "target verification must require matched status")
    require(failures, capture_core, 'result.captureReliability === "health_verified"', "control capture must require health verification")
    require(failures, capture_core, 'provider === "window_print" || provider === "window_gdi"', "trusted providers must include window_print and window_gdi")
    require(failures, capture_health, "CaptureHealthIssue::BlackFrame", "black frame classification is missing")
    require(failures, capture_health, "CaptureHealthIssue::StaleFrame", "stale frame classification is missing")
    require(failures, capture_health, "fn analyze_rgb_frame", "RGB health analyzer is missing")
    require(failures, capture_test, "testPlannedOrPreviewOnlyNeverPassesTargetVerification", "preview-only target verification regression test is missing")

    scripts = package.get("scripts", {})
    if scripts.get("test:capture-policy") != "node scripts/test_capture_policy_core.mjs":
        failures.append("package.json must expose test:capture-policy")
    if "npm run test:capture-policy" not in scripts.get("test:all-core", ""):
        failures.append("test:all-core must include capture policy tests")
    if scripts.get("audit:capture-policy") != "python scripts/audit_capture_policy.py":
        failures.append("package.json must expose audit:capture-policy")
    if "npm run audit:capture-policy" not in scripts.get("audit:all", ""):
        failures.append("audit:all must include capture policy audit")

    print(f"looseCaptureConsumers={len(loose_calls)}")
    print(f"captureMetadataFields={sum(token in platform for token in ['provider', 'reliability', 'captured_at_ms', 'frame_hash', 'width', 'height'])}")
    for failure in failures:
        print(f"FAIL {failure}")
    return 0 if not failures else 2


if __name__ == "__main__":
    sys.exit(main())
