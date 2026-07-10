#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def require(failures: list[str], source: str, needle: str, label: str) -> None:
    if needle not in source:
        failures.append(label)


def require_regex(failures: list[str], source: str, pattern: str, label: str) -> None:
    if not re.search(pattern, source, flags=re.S):
        failures.append(label)


def main() -> int:
    failures: list[str] = []
    paths = [
        "scripts/live_background_hotkey_validation.py",
        "package.json",
        "README.md",
        "docs/product-plan.md",
        "docs/workflow-model.md",
    ]
    for path in paths:
        if not (ROOT / path).is_file():
            failures.append(f"missing {path}")
    if failures:
        return report(failures)

    script = read_text("scripts/live_background_hotkey_validation.py")
    package = json.loads(read_text("package.json"))
    docs = "\n".join([read_text("README.md"), read_text("docs/product-plan.md"), read_text("docs/workflow-model.md")])

    for needle in [
        "--allow-input",
        "--require-executed",
        "MHXY_LIVE_GAME_TEST",
        "preflight_only",
        "input_not_allowed",
        "blocked_by_privilege_or_setup",
        "missing_live_windows",
        "skippedBySetupGate",
        "skippedByPrivilegeGate",
        "classification",
        "EXIT_NOT_EXECUTED = 2",
        "exitCodes",
        "inputEnvSet",
        "assets",
        "reports",
        "live-background-hotkey",
        'strftime("%Y%m%d-%H%M%S-%f")',
        "--exact",
        "tests::live_background_hotkey_changes_two_game_windows",
        "tests::live_parallel_background_hotkey_changes_two_game_windows",
    ]:
        require(failures, script, needle, f"live validation script missing {needle}")
    if 'env["MHXY_LIVE_GAME_TEST"] = "1"' not in script:
        failures.append("live validation script must set MHXY_LIVE_GAME_TEST only in the child env")
    if "if args.allow_input:" not in script:
        failures.append("live validation script must gate live commands behind --allow-input")
    require_regex(
        failures,
        script,
        r"if args\.allow_input:\s+env = os\.environ\.copy\(\)\s+env\[\"MHXY_LIVE_GAME_TEST\"\] = \"1\"",
        "live validation script must only set MHXY_LIVE_GAME_TEST inside the --allow-input branch",
    )
    if "run_command(command, env=env)" not in script:
        failures.append("live validation script must execute live commands only through the gated child env")

    scripts = package.get("scripts", {})
    if scripts.get("validate:live-hotkey") != "python scripts/live_background_hotkey_validation.py":
        failures.append("package.json missing validate:live-hotkey script")
    if scripts.get("live:hotkey:preflight") != "python scripts/live_background_hotkey_validation.py":
        failures.append("package.json missing safe live:hotkey:preflight script")
    if scripts.get("live:hotkey:allow-input") != "python scripts/live_background_hotkey_validation.py --allow-input --require-executed":
        failures.append("package.json missing explicit live:hotkey:allow-input script")
    if scripts.get("live:hotkey:allow-both") != "python scripts/live_background_hotkey_validation.py --allow-input --require-executed --both":
        failures.append("package.json missing explicit live:hotkey:allow-both script")
    if scripts.get("audit:live-validation") != "python scripts/audit_live_validation_workflow.py":
        failures.append("package.json missing audit:live-validation script")

    for needle in [
        "validate:live-hotkey",
        "live:hotkey:preflight",
        "live:hotkey:allow-input",
        "live:hotkey:allow-both",
        "--allow-input",
        "--require-executed",
        "MHXY_LIVE_GAME_TEST",
        "assets/resource/ShiKong/reports",
        "input_not_allowed",
        "blocked_by_privilege_or_setup",
        "管理员",
        "不会默认发送后台输入",
    ]:
        require(failures, docs, needle, f"docs missing {needle}")

    return report(failures)


def report(failures: list[str]) -> int:
    if failures:
        print("live validation workflow audit failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("live validation workflow audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
