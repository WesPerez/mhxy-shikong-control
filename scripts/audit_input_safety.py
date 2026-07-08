#!/usr/bin/env python3
"""Audit that runtime input stays hwnd-targeted and does not use real mouse APIs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


DEFAULT_INCLUDE = ["src-tauri/src", "src", "scripts"]
FORBIDDEN_TOKENS = [
    "SendInput",
    "SetCursorPos",
    "mouse_event",
    "keybd_event",
    "pyautogui",
    "pynput",
    "win32api.SetCursorPos",
    "win32api.mouse_event",
]
HWND_TOKENS = [
    "PostMessageW",
    "WM_LBUTTONDOWN",
    "WM_LBUTTONUP",
    "WM_MOUSEMOVE",
    "WM_KEYDOWN",
    "WM_KEYUP",
    "WM_CHAR",
]
FOCUS_TOKENS = [
    "SetForegroundWindow",
    "BringWindowToTop",
    "ShowWindow",
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
    report = {
        "version": 1,
        "projectRoot": str(project_root),
        "scannedFiles": len(files),
        "forbiddenTokens": forbidden,
        "hwndInputEvidence": hwnd,
        "focusAffectingEvidence": focus,
        "passed": not forbidden and not focus,
        "note": (
            "Forbidden tokens indicate real cursor/keyboard injection risk. "
            "Focus-affecting APIs indicate foreground-control risk. "
            "hwndInputEvidence may be empty when this build has no runtime input dispatcher."
        ),
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"scannedFiles={report['scannedFiles']}")
        print(f"forbiddenTokens={len(forbidden)}")
        print(f"hwndInputEvidence={len(hwnd)}")
        print(f"focusAffectingEvidence={len(focus)}")
        if forbidden:
            for hit in forbidden:
                print(f"FORBIDDEN {hit['path']}:{hit['line']} {hit['token']}")
        if focus:
            for hit in focus:
                print(f"FORBIDDEN_FOCUS {hit['path']}:{hit['line']} {hit['token']}")
    return 0 if report["passed"] else 2


def iter_source_files(project_root: Path):
    suffixes = {".rs", ".py", ".js", ".ts", ".html", ".css", ".json", ".ps1"}
    ignored_dirs = {"node_modules", "dist", "target", "__pycache__"}
    self_path = Path(__file__).resolve()
    for include in DEFAULT_INCLUDE:
        root = project_root / include
        if not root.exists():
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
