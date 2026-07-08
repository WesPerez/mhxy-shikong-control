#!/usr/bin/env python3
"""Build a compact readiness report for the ShiKong control goal."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import audit_input_safety
import live_acceptance
import runtime_surface_audit


DEFAULT_STATUS = Path("assets/resource/ShiKong/reports/latest-migration-status.json")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--status", type=Path, default=DEFAULT_STATUS)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--title", default=live_acceptance.DEFAULT_TITLE)
    parser.add_argument(
        "--require-live-acceptance",
        action="store_true",
        help="fail unless every Maa task entry has completed non-dry-run live evidence",
    )
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    status_path = resolve(project_root, args.status)
    status = read_json(status_path)
    input_report = input_safety(project_root)
    surface_report = runtime_surface(project_root, status)
    live_report = live_acceptance.build_report(project_root, status, args.title, str(status_path))
    checks = build_checks(status, input_report, surface_report)
    implementation_passed = all(item["passed"] for item in checks)
    passed = implementation_passed and (
        live_report.get("passed") or not args.require_live_acceptance
    )
    report = {
        "version": 1,
        "generatedAt": int(time.time()),
        "projectRoot": str(project_root),
        "statusReport": str(status_path),
        "passed": passed,
        "implementationPassed": implementation_passed,
        "liveAcceptancePassed": bool(live_report.get("passed")),
        "checks": checks,
        "summary": status.get("summary") or {},
        "auditWarnings": status.get("auditWarnings")
        or [gate for gate in status.get("gates") or [] if gate.get("kind") == "audit" and gate.get("status") != "pass"],
        "inputSafety": input_report,
        "runtimeSurface": surface_report,
        "liveAcceptance": live_report,
    }
    report_path = args.report or (
        project_root
        / "assets/resource/ShiKong/reports"
        / "latest-goal-readiness.json"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "report": str(report_path),
                "passed": passed,
                "implementationPassed": implementation_passed,
                "liveAcceptancePassed": bool(live_report.get("passed")),
                "failedChecks": [item for item in checks if not item["passed"]],
                "failedLiveAcceptanceChecks": [
                    item for item in live_report.get("checks") or [] if not item.get("passed")
                ],
                "auditWarnings": report["auditWarnings"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if passed else 2


def build_checks(status: dict, input_report: dict, surface_report: dict) -> list[dict[str, object]]:
    summary = status.get("summary") or {}
    surface_summary = surface_report.get("summary") or {}
    failed_completion = [
        gate
        for gate in status.get("gates") or []
        if gate.get("kind", "completion") == "completion" and gate.get("status") != "pass"
    ]
    return [
        check("migration complete", bool(status.get("complete")), "completion gates all pass"),
        check("completion gates", not failed_completion, f"{len(failed_completion)} failed completion gates"),
        check(
            "runtime coverage",
            int(summary.get("runtimeMissingTemplates") or 0) == 0,
            f"{summary.get('runtimeCoveredTemplates', 0)}/{summary.get('uniqueTemplates', 0)} runtime covered",
        ),
        check(
            "interface task coverage",
            int(summary.get("interfaceRuntimeMissingTemplates") or 0) == 0,
            f"{summary.get('interfaceRuntimeCoveredTemplates', 0)}/{summary.get('interfaceReachableTemplates', 0)} interface-reachable runtime covered",
        ),
        check(
            "mapped template validation",
            int(summary.get("validationFailed") or 0) == 0 and int(summary.get("validationTotal") or 0) > 0,
            f"{summary.get('validationPassed', 0)}/{summary.get('validationTotal', 0)} validation passed",
        ),
        check(
            "input safety",
            bool(input_report.get("passed")),
            f"{len(input_report.get('forbiddenTokens') or [])} forbidden real-input tokens",
        ),
        check(
            "runtime hook surface",
            bool(surface_report.get("passed")),
            (
                f"{surface_summary.get('interfaceReachableNodes', 0)} interface nodes; "
                f"{surface_summary.get('interfaceUnsupportedHooks', 0)} unsupported, "
                f"{surface_summary.get('interfacePlaceholderHooks', 0)} placeholder, "
                f"{surface_summary.get('missingInterfaceNodes', 0)} missing refs"
            ),
        ),
    ]


def check(name: str, passed: bool, detail: str) -> dict[str, object]:
    return {"name": name, "passed": passed, "detail": detail}


def input_safety(project_root: Path) -> dict:
    files = list(audit_input_safety.iter_source_files(project_root))
    forbidden = audit_input_safety.scan_tokens(files, audit_input_safety.FORBIDDEN_TOKENS)
    hwnd = audit_input_safety.scan_tokens(files, audit_input_safety.HWND_TOKENS)
    focus = audit_input_safety.scan_tokens(files, audit_input_safety.FOCUS_TOKENS)
    return {
        "scannedFiles": len(files),
        "forbiddenTokens": forbidden,
        "hwndInputEvidence": len(hwnd),
        "focusAffectingEvidence": len(focus),
        "passed": not forbidden and bool(hwnd),
    }


def runtime_surface(project_root: Path, status: dict) -> dict:
    maa_root = Path(str(status.get("maaRoot") or project_root.parent / "Maa_MHXY_MG"))
    report = runtime_surface_audit.build_report(project_root, maa_root)
    report_path = project_root / "assets/resource/ShiKong/reports/latest-runtime-surface.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
