#!/usr/bin/env python3
"""Audit that runtime input stays hwnd-targeted and does not use real mouse APIs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


DEFAULT_INCLUDE = ["index.html", "src-tauri/src", "src", "scripts"]
FORBIDDEN_TOKENS = [
    "SendInput",
    "SetCursorPos",
    "mouse_event",
    "keybd_event",
    "pyautogui",
    "pynput",
    "win32api.SetCursorPos",
    "win32api.mouse_event",
    "AttachThreadInput",
    "SwitchToThisWindow",
    "SetActiveWindow",
    "SendMessageW(",
]
HWND_TOKENS = [
    "PostMessageW",
    "WM_LBUTTONDOWN",
    "WM_LBUTTONUP",
    "WM_RBUTTONDOWN",
    "WM_RBUTTONUP",
    "WM_MOUSEMOVE",
    "WM_KEYDOWN",
    "WM_KEYUP",
    "WM_SYSKEYDOWN",
    "WM_SYSKEYUP",
    "WM_CHAR",
]
FOCUS_TOKENS = [
    "SetForegroundWindow",
    "BringWindowToTop",
    "ShowWindow",
]
IDENTITY_TOKENS = [
    "ExpectedWindowInput",
    "validate_expected_window",
    "window_for_hwnd",
    "expectedWindow",
    "windowIdentity",
]
TARGET_TOKENS = [
    "targets",
    "targetId",
    "targetDataUrl",
    "normalizeTarget",
    "targetForStep",
    "targetUsages",
    "deleteSelectedTarget",
    "unbindStepTarget",
]
TARGET_CRUD_TOKENS = [
    "target-search",
    "target-kind-filter",
    "target-editor",
    "selectedTargetId",
    "bindTargetEditor",
    "renderTargetEditor",
    "targetUsages",
    "deleteSelectedTarget",
    "unbindCurrentStepTarget",
]
STEP_EDIT_TOKENS = [
    "insert-step-below",
    "duplicate-step",
    "step-block-preset",
    "insert-step-block",
    "$(\"#insert-step-below\").addEventListener",
    "$(\"#duplicate-step\").addEventListener",
    "$(\"#insert-step-block\").addEventListener",
    "insertStepBelowSelected",
    "duplicateSelectedStep",
    "cloneStepForInsert",
    "stepBlockPresets",
    "insertStepBlock",
    "insertStepsAt",
    "ensureTargetsForSteps",
    "selectFirstUnboundCapturedStep",
    "selectNextUnboundCapturedStepAfter",
]
STEP_VALIDATION_TOKENS = [
    "stepValidation",
    "buildStepValidationIndex",
    "firstIssueStepId",
    "step-validation-detail",
    "renderStepValidationDetails",
    "step-badge",
    ".step-badge.issue",
    ".step-badge.warning",
]
TARGET_FILTER_UI_TOKENS = [
    "ensureSelectedTarget(filteredTargets",
    "targetThumbLabel",
    "待贴图",
]
PASTE_AUTO_STEP_TOKENS = [
    "capturedImageStepTypes",
    "ensureCapturedTargetStep",
    "saveTargetForStep",
    "isStepBlockPlaceholderTarget",
    "insertStepAt",
    "bindTargetToStep(destination.step",
]
RUNNER_SEMANTIC_TOKENS = [
    "backgroundStepDelay",
    "executeRetryUntilStep",
    "retryUntilHasVisualTarget",
    "type: \"wait_image\"",
]
OCR_CONTRACT_TOKENS = [
    "dispatch_ocr_step",
    "recognize_ocr_text",
    "OcrEngine",
    "RecognizeAsync",
    "target_texts",
    "targetTexts",
    "ocrExpectedTextsForStep",
    "validateOcrStepRuntimeFields",
    "ocr_unavailable",
    "text_miss",
]
UI_STABILITY_TOKENS = [
    "MAX_LOG_ROWS",
    "log.children.length > MAX_LOG_ROWS",
    "element.classList.add(value)",
    ".state-pill.running",
    ".session-lane.failed",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    files = list(iter_source_files(project_root))
    forbidden = scan_tokens(files, FORBIDDEN_TOKENS)
    hwnd = scan_tokens(files, HWND_TOKENS)
    focus = scan_tokens(files, FOCUS_TOKENS)
    identity = scan_tokens(files, IDENTITY_TOKENS)
    targets = scan_tokens(files, TARGET_TOKENS)
    target_crud = scan_tokens(files, TARGET_CRUD_TOKENS)
    target_filter_ui = scan_tokens(files, TARGET_FILTER_UI_TOKENS)
    step_edit = scan_tokens(files, STEP_EDIT_TOKENS)
    step_validation = scan_tokens(files, STEP_VALIDATION_TOKENS)
    paste_auto_step = scan_tokens(files, PASTE_AUTO_STEP_TOKENS)
    runner_semantics = scan_tokens(files, RUNNER_SEMANTIC_TOKENS)
    ocr_contract = scan_tokens(files, OCR_CONTRACT_TOKENS)
    ui_stability = scan_tokens(files, UI_STABILITY_TOKENS)
    identity_required = bool(hwnd)
    identity_seen = {hit["token"] for hit in identity}
    identity_missing = [
        token for token in IDENTITY_TOKENS if identity_required and token not in identity_seen
    ]
    target_crud_seen = {hit["token"] for hit in target_crud}
    target_crud_missing = [
        token for token in TARGET_CRUD_TOKENS if token not in target_crud_seen
    ]
    target_filter_ui_seen = {hit["token"] for hit in target_filter_ui}
    target_filter_ui_missing = [
        token for token in TARGET_FILTER_UI_TOKENS if token not in target_filter_ui_seen
    ]
    step_edit_seen = {hit["token"] for hit in step_edit}
    step_edit_missing = [
        token for token in STEP_EDIT_TOKENS if token not in step_edit_seen
    ]
    step_validation_seen = {hit["token"] for hit in step_validation}
    step_validation_missing = [
        token for token in STEP_VALIDATION_TOKENS if token not in step_validation_seen
    ]
    paste_auto_step_seen = {hit["token"] for hit in paste_auto_step}
    paste_auto_step_missing = [
        token for token in PASTE_AUTO_STEP_TOKENS if token not in paste_auto_step_seen
    ]
    runner_semantics_seen = {hit["token"] for hit in runner_semantics}
    runner_semantics_missing = [
        token for token in RUNNER_SEMANTIC_TOKENS if token not in runner_semantics_seen
    ]
    ocr_contract_seen = {hit["token"] for hit in ocr_contract}
    ocr_contract_missing = [
        token for token in OCR_CONTRACT_TOKENS if token not in ocr_contract_seen
    ]
    ui_stability_seen = {hit["token"] for hit in ui_stability}
    ui_stability_missing = [
        token for token in UI_STABILITY_TOKENS if token not in ui_stability_seen
    ]
    report = {
        "version": 1,
        "projectRoot": str(project_root),
        "scannedFiles": len(files),
        "forbiddenTokens": forbidden,
        "hwndInputEvidence": hwnd,
        "focusAffectingEvidence": focus,
        "identityCheckEvidence": identity,
        "identityCheckRequired": identity_required,
        "identityCheckMissing": identity_missing,
        "targetLibraryEvidence": targets,
        "targetCrudEvidence": target_crud,
        "targetCrudMissing": target_crud_missing,
        "targetFilterUiEvidence": target_filter_ui,
        "targetFilterUiMissing": target_filter_ui_missing,
        "stepEditEvidence": step_edit,
        "stepEditMissing": step_edit_missing,
        "stepValidationEvidence": step_validation,
        "stepValidationMissing": step_validation_missing,
        "pasteAutoStepEvidence": paste_auto_step,
        "pasteAutoStepMissing": paste_auto_step_missing,
        "runnerSemanticEvidence": runner_semantics,
        "runnerSemanticMissing": runner_semantics_missing,
        "ocrContractEvidence": ocr_contract,
        "ocrContractMissing": ocr_contract_missing,
        "uiStabilityEvidence": ui_stability,
        "uiStabilityMissing": ui_stability_missing,
        "passed": (
            not forbidden
            and not focus
            and not identity_missing
            and not target_crud_missing
            and not target_filter_ui_missing
            and not step_edit_missing
            and not step_validation_missing
            and not paste_auto_step_missing
            and not runner_semantics_missing
            and not ocr_contract_missing
            and not ui_stability_missing
        ),
        "note": (
            "Forbidden tokens indicate real cursor/keyboard injection risk. "
            "Focus-affecting APIs indicate foreground-control risk. "
            "hwndInputEvidence may be empty when this build has no runtime input dispatcher. "
            "When hwnd input exists, expectedWindow identity evidence must also be present. "
            "Step editing, validation badge, paste-to-step, runner semantic, and UI stability tokens catch visible UI or modeled-step regressions."
        ),
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"scannedFiles={report['scannedFiles']}")
        print(f"forbiddenTokens={len(forbidden)}")
        print(f"hwndInputEvidence={len(hwnd)}")
        print(f"focusAffectingEvidence={len(focus)}")
        print(f"identityCheckEvidence={len(identity)}")
        print(f"identityCheckMissing={len(identity_missing)}")
        print(f"targetLibraryEvidence={len(targets)}")
        print(f"targetCrudEvidence={len(target_crud)}")
        print(f"targetCrudMissing={len(target_crud_missing)}")
        print(f"targetFilterUiEvidence={len(target_filter_ui)}")
        print(f"targetFilterUiMissing={len(target_filter_ui_missing)}")
        print(f"stepEditEvidence={len(step_edit)}")
        print(f"stepEditMissing={len(step_edit_missing)}")
        print(f"stepValidationEvidence={len(step_validation)}")
        print(f"stepValidationMissing={len(step_validation_missing)}")
        print(f"pasteAutoStepEvidence={len(paste_auto_step)}")
        print(f"pasteAutoStepMissing={len(paste_auto_step_missing)}")
        print(f"runnerSemanticEvidence={len(runner_semantics)}")
        print(f"runnerSemanticMissing={len(runner_semantics_missing)}")
        print(f"ocrContractEvidence={len(ocr_contract)}")
        print(f"ocrContractMissing={len(ocr_contract_missing)}")
        print(f"uiStabilityEvidence={len(ui_stability)}")
        print(f"uiStabilityMissing={len(ui_stability_missing)}")
        if forbidden:
            for hit in forbidden:
                print(f"FORBIDDEN {hit['path']}:{hit['line']} {hit['token']}")
        if focus:
            for hit in focus:
                print(f"FORBIDDEN_FOCUS {hit['path']}:{hit['line']} {hit['token']}")
        if identity_missing:
            for token in identity_missing:
                print(f"MISSING_IDENTITY {token}")
        if target_crud_missing:
            for token in target_crud_missing:
                print(f"MISSING_TARGET_CRUD {token}")
        if target_filter_ui_missing:
            for token in target_filter_ui_missing:
                print(f"MISSING_TARGET_FILTER_UI {token}")
        if step_edit_missing:
            for token in step_edit_missing:
                print(f"MISSING_STEP_EDIT {token}")
        if step_validation_missing:
            for token in step_validation_missing:
                print(f"MISSING_STEP_VALIDATION {token}")
        if paste_auto_step_missing:
            for token in paste_auto_step_missing:
                print(f"MISSING_PASTE_AUTO_STEP {token}")
        if runner_semantics_missing:
            for token in runner_semantics_missing:
                print(f"MISSING_RUNNER_SEMANTIC {token}")
        if ocr_contract_missing:
            for token in ocr_contract_missing:
                print(f"MISSING_OCR_CONTRACT {token}")
        if ui_stability_missing:
            for token in ui_stability_missing:
                print(f"MISSING_UI_STABILITY {token}")
    return 0 if report["passed"] else 2


def iter_source_files(project_root: Path):
    suffixes = {".rs", ".py", ".js", ".ts", ".html", ".css", ".json", ".ps1"}
    ignored_dirs = {"node_modules", "dist", "target", "__pycache__"}
    self_path = Path(__file__).resolve()
    for include in DEFAULT_INCLUDE:
        root = project_root / include
        if not root.exists():
            continue
        if root.is_file():
            if root.suffix.lower() in suffixes and root.resolve() != self_path:
                yield root
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in suffixes:
                continue
            if path.resolve() == self_path:
                continue
            if any(part in ignored_dirs for part in path.parts):
                continue
            yield path


def scan_tokens(paths: list[Path], tokens: list[str]) -> list[dict[str, object]]:
    hits: list[dict[str, object]] = []
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        for line_no, line in enumerate(lines, start=1):
            for token in tokens:
                if token in line:
                    hits.append(
                        {
                            "path": str(path),
                            "line": line_no,
                            "token": token,
                            "text": line.strip()[:240],
                        }
                    )
    return hits


if __name__ == "__main__":
    raise SystemExit(main())
