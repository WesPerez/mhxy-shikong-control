"""Audit the readiness completion action dock contract."""

from __future__ import annotations

import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def require_contains(failures: list[str], source: str, needle: str, label: str) -> None:
    if needle not in source:
        failures.append(label)


def main() -> int:
    paths = {
        "main": PROJECT_ROOT / "src" / "main.js",
        "index": PROJECT_ROOT / "index.html",
        "css": PROJECT_ROOT / "src" / "styles.css",
        "package": PROJECT_ROOT / "package.json",
        "readme": PROJECT_ROOT / "README.md",
    }
    sources = {name: read_text(path) for name, path in paths.items()}
    package = json.loads(sources["package"])
    scripts = package.get("scripts", {})
    failures: list[str] = []

    require_contains(
        failures,
        sources["index"],
        'id="completion-action-dock"',
        "index.html must expose the completion action dock container",
    )
    for token in [
        "renderCompletionActionDock(completion)",
        "completionDockActionsForItem",
        "completionReadyDockActions",
        "handleCompletionActionDock",
        "focusCompletionDockStep",
        "bindClipboardImageToCurrentStep",
        "clipboardImagePayloadFromBackend",
        "createTargetFromClipboardImagePayload",
        "applyRoiCenterToSelectedStep",
        "enablePreviewClickCaptureFromDock",
        "$(\"#completion-action-dock\").addEventListener",
    ]:
        require_contains(failures, sources["main"], token, f"src/main.js missing {token}")

    for action in [
        "clipboard-image",
        "roi-target",
        "capture-point",
        "roi-center",
        "target-library",
        "builtin-templates",
        "refresh-windows",
        "restart-admin",
        "assign-active",
        "dry-run",
        "prepare-exercise",
    ]:
        require_contains(failures, sources["main"], action, f"action dock missing {action} action")

    require_contains(
        failures,
        sources["main"],
        "await createTargetFromClipboardImagePayload(payload)",
        "Ctrl+V paste path must share the same clipboard target creation helper",
    )
    require_contains(
        failures,
        sources["main"],
        "focusTargetLibrary(\"ocr\")",
        "OCR gaps must be able to focus OCR target library",
    )
    require_contains(
        failures,
        sources["main"],
        "completionFocusSelector(item, stepItem)",
        "action dock must reuse readiness focus selectors",
    )

    for token in [
        ".completion-action-dock",
        ".completion-action-copy",
        ".completion-action-row",
        ".dock-action",
        ".dock-action.primary",
    ]:
        require_contains(failures, sources["css"], token, f"src/styles.css missing {token}")

    if scripts.get("audit:completion-action-dock") != "python scripts/audit_completion_action_dock.py":
        failures.append("package.json missing audit:completion-action-dock script")
    require_contains(
        failures,
        sources["readme"],
        "audit:completion-action-dock",
        "README.md must mention the completion action dock audit",
    )

    if failures:
        print("Completion action dock audit failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Completion action dock audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
