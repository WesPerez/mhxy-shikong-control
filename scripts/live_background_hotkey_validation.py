#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORTS_DIR = ROOT / "assets" / "resource" / "ShiKong" / "reports"
LIVE_TESTS = {
    "serial": "tests::live_background_hotkey_changes_two_game_windows",
    "parallel": "tests::live_parallel_background_hotkey_changes_two_game_windows",
}
BLOCKED_CLASSIFICATIONS = {"privilege_blocked", "missing_live_windows", "live_env_not_enabled"}
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_NOT_EXECUTED = 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create an auditable report for live hwnd background hotkey validation.",
    )
    parser.add_argument(
        "--allow-input",
        action="store_true",
        help="Actually run ignored Rust live tests and allow them to post hwnd hotkey messages.",
    )
    parser.add_argument(
        "--require-executed",
        action="store_true",
        help="Return a non-zero exit code if live tests are skipped by privilege or setup gates.",
    )
    parser.add_argument(
        "--test",
        action="append",
        choices=sorted(LIVE_TESTS),
        help="Live test to run when --allow-input is set. Defaults to serial.",
    )
    parser.add_argument("--both", action="store_true", help="Run serial and parallel live tests.")
    parser.add_argument(
        "--reports-dir",
        type=Path,
        default=REPORTS_DIR,
        help="Directory for JSON and Markdown evidence files.",
    )
    return parser.parse_args()


def is_admin() -> bool:
    if os.name != "nt":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def run_command(command: list[str], env: dict[str, str] | None = None) -> dict[str, object]:
    started = datetime.now(timezone.utc)
    process = subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    ended = datetime.now(timezone.utc)
    classification = classify_run(process.returncode, process.stdout)
    return {
        "command": command,
        "exitCode": process.returncode,
        "startedAt": started.isoformat(),
        "endedAt": ended.isoformat(),
        "durationMs": round((ended - started).total_seconds() * 1000),
        "output": process.stdout,
        "classification": classification,
        "skippedByPrivilegeGate": classification == "privilege_blocked",
        "skippedBySetupGate": classification in {"missing_live_windows", "live_env_not_enabled"},
    }


def classify_run(exit_code: int, output: str) -> str:
    if "skip live background input test" in output:
        return "privilege_blocked"
    if "expected at least two live game windows" in output:
        return "missing_live_windows"
    if "set MHXY_LIVE_GAME_TEST=1" in output:
        return "live_env_not_enabled"
    if exit_code != 0:
        return "failed"
    return "passed"


def short_git_value(args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def process_snapshot() -> dict[str, object]:
    ps_command = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -match 'mhxy|MyGame' -or $_.CommandLine -match 'MHXY-ShiKong-Control|mhxy-shikong-control|MyGame' } | "
        "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Depth 4"
    )
    for executable in ("pwsh", "powershell"):
        try:
            result = subprocess.run(
                [executable, "-NoProfile", "-Command", ps_command],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
        except OSError:
            continue
        if result.returncode != 0:
            return {"status": "failed", "command": executable, "output": result.stdout}
        try:
            data = json.loads(result.stdout) if result.stdout.strip() else []
        except json.JSONDecodeError:
            data = result.stdout.strip()
        return {"status": "ok", "command": executable, "processes": data}
    return {"status": "unavailable", "processes": []}


def selected_tests(args: argparse.Namespace) -> list[str]:
    if args.both:
        return ["serial", "parallel"]
    return args.test or ["serial"]


def planned_command(test_key: str) -> list[str]:
    return [
        "cargo",
        "test",
        "--manifest-path",
        str(ROOT / "src-tauri" / "Cargo.toml"),
        LIVE_TESTS[test_key],
        "--",
        "--ignored",
        "--exact",
        "--nocapture",
    ]


def write_markdown(path: Path, evidence: dict[str, object]) -> None:
    lines = [
        f"# Live Background Hotkey Validation {evidence['id']}",
        "",
        f"- Status: `{evidence['status']}`",
        f"- Generated: `{evidence['generatedAt']}`",
        f"- Git: `{evidence['git']['head']}`",
        f"- Admin: `{evidence['admin']}`",
        f"- Allow input: `{evidence['allowInput']}`",
        f"- Require executed: `{evidence['requireExecuted']}`",
        f"- JSON evidence: `{evidence['jsonPath']}`",
        "",
        "## Planned Commands",
        "",
    ]
    for command in evidence["plannedCommands"]:
        lines.append(f"- `{' '.join(command)}`")
    lines.extend(["", "## Process Snapshot", "", "```json", json.dumps(evidence["processSnapshot"], ensure_ascii=False, indent=2), "```", ""])
    if not evidence["allowInput"]:
        lines.extend(
            [
                "## Result",
                "",
                "Live input was not allowed for this run. Re-run with `--allow-input` from an administrator shell to execute ignored Rust live tests.",
                "",
            ],
        )
    if evidence["runs"]:
        lines.extend(["## Command Output", ""])
        for run in evidence["runs"]:
            lines.extend(
                [
                    f"### {' '.join(run['command'])}",
                    "",
                    f"- Exit code: `{run['exitCode']}`",
                    f"- Skipped by privilege gate: `{run['skippedByPrivilegeGate']}`",
                    "",
                    "```text",
                    str(run["output"]).rstrip(),
                    "```",
                    "",
                ],
            )
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    report_id = f"live-background-hotkey-{stamp}"
    reports_dir = args.reports_dir.resolve()
    reports_dir.mkdir(parents=True, exist_ok=True)
    json_path = reports_dir / f"{report_id}.json"
    md_path = reports_dir / f"{report_id}.md"
    test_keys = selected_tests(args)
    commands = [planned_command(test_key) for test_key in test_keys]
    evidence: dict[str, object] = {
        "kind": "mhxy-shikong.live-background-hotkey-validation",
        "version": 1,
        "id": report_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "repoRoot": str(ROOT),
        "admin": is_admin(),
        "allowInput": bool(args.allow_input),
        "requireExecuted": bool(args.require_executed),
        "inputEnvVar": "MHXY_LIVE_GAME_TEST",
        "inputEnvSet": bool(args.allow_input),
        "exitCodes": {
            "passedOrPreflight": EXIT_OK,
            "failed": EXIT_FAILED,
            "notExecutedWhenRequired": EXIT_NOT_EXECUTED,
        },
        "tests": test_keys,
        "plannedCommands": commands,
        "git": {
            "head": short_git_value(["rev-parse", "--short", "HEAD"]),
            "branch": short_git_value(["branch", "--show-current"]),
            "statusShort": short_git_value(["status", "--short"]),
        },
        "processSnapshot": process_snapshot(),
        "runs": [],
        "jsonPath": str(json_path),
        "markdownPath": str(md_path),
        "status": "preflight_only",
    }

    exit_code = EXIT_OK
    if args.allow_input:
        env = os.environ.copy()
        env["MHXY_LIVE_GAME_TEST"] = "1"
        runs = [run_command(command, env=env) for command in commands]
        evidence["runs"] = runs
        any_blocked = any(run["classification"] in BLOCKED_CLASSIFICATIONS for run in runs)
        any_failed = any(run["classification"] == "failed" for run in runs)
        if any_failed:
            evidence["status"] = "failed"
            exit_code = EXIT_FAILED
        elif any_blocked:
            evidence["status"] = "blocked_by_privilege_or_setup"
            exit_code = EXIT_NOT_EXECUTED if args.require_executed else EXIT_OK
        else:
            evidence["status"] = "passed"
    elif args.require_executed:
        evidence["status"] = "input_not_allowed"
        exit_code = EXIT_NOT_EXECUTED

    json_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(md_path, evidence)
    print(f"live validation status: {evidence['status']}")
    print(f"json: {json_path}")
    print(f"markdown: {md_path}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
