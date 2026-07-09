"""Audit the quick-step workbench action palette contract."""

from __future__ import annotations

import pathlib
import re
import sys


REQUIRED_ACTION_IDS = [
    "hotkey",
    "coordinate-click",
    "image-click-flow",
    "ocr-assert",
    "text-input",
    "right-click-item",
    "guard-snapshot",
    "recovery-fragment",
    "full-task-skeleton",
]

REQUIRED_PRESET_IDS = [
    "image-click-flow",
    "text-input",
    "right-click-item",
    "guard-snapshot",
    "recovery-fragment",
    "full-task-skeleton",
]

REQUIRED_STEP_TYPES = [
    "hotkey",
    "click",
    "ocr_assert",
]


def read_text(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8")


def main() -> int:
    project = pathlib.Path(__file__).resolve().parents[1]
    main_js = read_text(project / "src" / "main.js")
    html = read_text(project / "index.html")
    package = read_text(project / "package.json")
    docs = "\n".join(
        [
            read_text(project / "README.md"),
            read_text(project / "docs" / "workflow-model.md"),
            read_text(project / "docs" / "product-plan.md"),
        ]
    )

    failures: list[str] = []
    if 'id="quick-step-actions"' not in html:
        failures.append("index.html missing #quick-step-actions host")
    if "quickStepActions" not in main_js:
        failures.append("src/main.js missing quickStepActions catalog")
    if "renderQuickStepActions()" not in main_js:
        failures.append("src/main.js does not render quick-step actions during startup")
    if "insertQuickStepAction" not in main_js:
        failures.append("src/main.js missing quick-step insertion handler")
    if "data-quick-step-action" not in main_js:
        failures.append("src/main.js missing delegated quick-step action buttons")
    if "createStepBlock(action.presetId)" not in main_js:
        failures.append("quick-step preset actions must reuse createStepBlock")
    if "createStep(action.stepType)" not in main_js:
        failures.append("quick-step single-step actions must reuse createStep")
    if "selectFirstUnboundCapturedStep(inserted)" not in main_js:
        failures.append("quick-step image flows must advance to the first unbound captured step")
    if "focusQuickStepActionTarget" not in main_js:
        failures.append("quick-step actions should focus the most relevant field after insert")

    for action_id in REQUIRED_ACTION_IDS:
        if f'id: "{action_id}"' not in main_js:
            failures.append(f"quickStepActions missing action id {action_id}")

    for preset_id in REQUIRED_PRESET_IDS:
        if f'presetId: "{preset_id}"' not in main_js:
            failures.append(f"quickStepActions missing preset action {preset_id}")
        if f'id: "{preset_id}"' not in main_js:
            failures.append(f"stepBlockPresets missing preset id {preset_id}")

    for step_type in REQUIRED_STEP_TYPES:
        if f'stepType: "{step_type}"' not in main_js:
            failures.append(f"quickStepActions missing direct step type {step_type}")

    if '"audit:quick-steps": "python scripts/audit_quick_step_workbench.py"' not in package:
        failures.append("package.json missing audit:quick-steps script")
    if "快捷动作" not in docs or "quick-step" not in docs:
        failures.append("docs must describe quick-step action palette")

    action_count = len(re.findall(r"\bid:\s*\"(?:%s)\"" % "|".join(map(re.escape, REQUIRED_ACTION_IDS)), main_js))
    result = {
        "actionCount": action_count,
        "requiredActions": len(REQUIRED_ACTION_IDS),
        "failures": failures,
    }
    if failures:
        print("Quick-step workbench audit failed:")
        for failure in failures:
            print(f"- {failure}")
        print(result)
        return 1
    print(
        "Quick-step workbench audit passed "
        f"({action_count}/{len(REQUIRED_ACTION_IDS)} required actions)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
