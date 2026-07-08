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
    "$(\"#insert-step-below\").addEventListener",
    "$(\"#duplicate-step\").addEventListener",
    "insertStepBelowSelected",
    "duplicateSelectedStep",
    "cloneStepForInsert",
]
STEP_VALIDATION_TOKENS = [
    "stepValidation",
    "buildStepValidationIndex",
    "firstIssueStepId",
    "step-badge",
    ".step-badge.issue",
]
PASTE_AUTO_STEP_TOKENS = [
    "capturedImageStepTypes",
    "ensureCapturedTargetStep",
    "saveTargetForStep",
    "insertStepAt",
    "bindTargetToStep(destination.step",
]
RUNNER_SEMANTIC_TOKENS = [
    "backgroundStepDelay",
    "executeRetryUntilStep",
    "type: \"wait_image\"",
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
    step_edit = scan_tokens(files, STEP_EDIT_TOKENS)
    step_validation = scan_tokens(files, STEP_VALIDATION_TOKENS)
    paste_auto_step = scan_tokens(files, PASTE_AUTO_STEP_TOKENS)
    runner_semantics = scan_tokens(files, RUNNER_SEMANTIC_TOKENS)
    identity_required = bool(hwnd)
    identity_seen = {hit["token"] for hit in identity}
    identity_missing = [
        token for token in IDENTITY_TOKENS if identity_required and token not in identity_seen
    ]
    target_crud_seen = {hit["token"] for hit in target_crud}
    target_crud_missing = [
        token for token in TARGET_CRUD_TOKENS if token not in target_crud_seen
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
        "stepEditEvidence": step_edit,
        "stepEditMissing": step_edit_missing,
        "stepValidationEvidence": step_validation,
        "stepValidationMissing": step_validation_missing,
        "pasteAutoStepEvidence": paste_auto_step,
        "pasteAutoStepMissing": paste_auto_step_missing,
        "runnerSemanticEvidence": runner_semantics,
        "runnerSemanticMissing": runner_semantics_missing,
        "passed": (
            not forbidden
            and not focus
            and not identity_missing
            and not target_crud_missing
            and not step_edit_missing
            and not step_validation_missing
            and not paste_auto_step_missing
            and not runner_semantics_missing
        ),
        "note": (
            "Forbidden tokens indicate real cursor/keyboard injection risk. "
            "Focus-affecting APIs indicate foreground-control risk. "
            "hwndInputEvidence may be empty when this build has no runtime input dispatcher. "
            "When hwnd input exists, expectedWindow identity evidence must also be present. "
            "Step editing, validation badge, paste-to-step, and runner semantic tokens catch visible UI or modeled-step regressions."
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
        print(f"stepEditEvidence={len(step_edit)}")
        print(f"stepEditMissing={len(step_edit_missing)}")
        print(f"stepValidationEvidence={len(step_validation)}")
        print(f"stepValidationMissing={len(step_validation_missing)}")
        print(f"pasteAutoStepEvidence={len(paste_auto_step)}")
        print(f"pasteAutoStepMissing={len(paste_auto_step_missing)}")
        print(f"runnerSemanticEvidence={len(runner_semantics)}")
        print(f"runnerSemanticMissing={len(runner_semantics_missing)}")
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
