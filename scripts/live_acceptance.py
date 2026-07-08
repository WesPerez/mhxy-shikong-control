#!/usr/bin/env python3
"""Build live-client acceptance evidence for the ShiKong control goal.

This audit is intentionally non-invasive: it lists matching windows, checks
privilege compatibility, inspects migration/readiness evidence, and summarizes
saved task-run reports. It never posts click/key messages and never starts or
stops the game client.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import audit_input_safety
import capture_window


DEFAULT_TITLE = "梦幻西游：时空"
DEFAULT_STATUS = Path("assets/resource/ShiKong/reports/latest-migration-status.json")
DEFAULT_REPORT = Path("assets/resource/ShiKong/reports/latest-live-acceptance.json")
ASPECT_4_3 = 4 / 3
ASPECT_TOLERANCE = 0.08


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--status", type=Path, default=DEFAULT_STATUS)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--title", default=DEFAULT_TITLE)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    status_path = resolve(project_root, args.status)
    status = read_json(status_path) if status_path.is_file() else {}
    report = build_report(project_root, status, args.title, str(status_path))
    report_path = resolve(project_root, args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    output = report if args.json else {
        "report": str(report_path),
        "passed": report["passed"],
        "summary": report["summary"],
        "failedChecks": [item for item in report["checks"] if not item["passed"]],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 2


def build_report(
    project_root: Path,
    status: dict[str, Any] | None = None,
    title: str = DEFAULT_TITLE,
    status_report: str | None = None,
) -> dict[str, Any]:
    status = status or {}
    input_report = input_safety(project_root)
    window_status = inspect_windows(title)
    required_tasks = collect_required_tasks(project_root, status)
    task_evidence = collect_task_evidence(project_root, required_tasks)
    checks = build_checks(status, input_report, window_status, task_evidence)
    return {
        "version": 1,
        "generatedAt": int(time.time()),
        "projectRoot": str(project_root),
        "title": title,
        "statusReport": status_report,
        "passed": all(item["passed"] for item in checks),
        "checks": checks,
        "summary": {
            "windows": len(window_status.get("windows") or []),
            "currentProcessElevated": window_status.get("currentProcessElevated"),
            "elevatedTargetMismatch": window_status.get("elevatedTargetMismatch"),
            "completedTaskPrivilegeEvidence": task_evidence["completedTaskPrivilegeEvidence"],
            "completedTaskClientEvidence": task_evidence["completedTaskClientEvidence"],
            "missingPrivilegeEvidenceInterfaceTasks": len(task_evidence["missingPrivilegeEvidenceInterfaceTasks"]),
            "missingClientEvidenceInterfaceTasks": len(task_evidence["missingClientEvidenceInterfaceTasks"]),
            "fullCoverageHwnds": len(task_evidence["fullCoverageHwnds"]),
            "fullCoverageHwndsWithPrivilegeEvidence": len(task_evidence["fullCoverageHwndsWithPrivilegeEvidence"]),
            "fullCoverageHwndsWithClientEvidence": len(task_evidence["fullCoverageHwndsWithClientEvidence"]),
            "bestHwndCompletedInterfaceTasks": task_evidence["bestHwndCompletedInterfaceTasks"],
            "fullDryRunCoverageHwnds": len(task_evidence["fullDryRunCoverageHwnds"]),
            "bestHwndDryRunCompletedInterfaceTasks": task_evidence["bestHwndDryRunCompletedInterfaceTasks"],
            "requiredInterfaceTasks": len(required_tasks),
            "requiredTaskEntries": task_evidence["requiredTaskEntries"],
            "realCompletedTaskEntries": task_evidence["realCompletedTaskEntries"],
            "realCompletedInterfaceTasks": task_evidence["realCompletedInterfaceTasks"],
            "missingRealCompletedInterfaceTasks": len(task_evidence["missingRealCompletedInterfaceTasks"]),
            "taskReports": task_evidence["reports"],
            "realTaskReports": task_evidence["realReports"],
            "dryRunTaskReports": task_evidence["dryRunReports"],
        },
        "migrationSummary": status.get("summary") or {},
        "windowStatus": window_status,
        "inputSafety": input_report,
        "taskEvidence": task_evidence,
    }


def build_checks(
    status: dict[str, Any],
    input_report: dict[str, Any],
    window_status: dict[str, Any],
    task_evidence: dict[str, Any],
) -> list[dict[str, object]]:
    summary = status.get("summary") or {}
    windows = window_status.get("windows") or []
    current_privilege_ok = bool(windows) and not window_status.get("elevatedTargetMismatch")
    historical_privilege_ok = bool(task_evidence.get("completedTaskPrivilegeEvidence"))
    historical_client_ok = bool(task_evidence.get("completedTaskClientEvidence"))
    window_or_historical_client = bool(windows) or historical_client_ok
    aspect_ok = (
        bool(windows) and all(bool(item.get("aspectCloseTo4x3")) for item in windows)
    ) or historical_client_ok
    return [
        check("migration completion gates", bool(status.get("complete")), "latest migration completion gates pass"),
        check(
            "runtime recognition coverage",
            int(summary.get("runtimeMissingTemplates") or 0) == 0 and int(summary.get("uniqueTemplates") or 0) > 0,
            f"{summary.get('runtimeCoveredTemplates', 0)}/{summary.get('uniqueTemplates', 0)} runtime covered",
        ),
        check(
            "interface runtime coverage",
            int(summary.get("interfaceRuntimeMissingTemplates") or 0) == 0
            and int(summary.get("interfaceReachableTemplates") or 0) > 0,
            f"{summary.get('interfaceRuntimeCoveredTemplates', 0)}/{summary.get('interfaceReachableTemplates', 0)} interface templates covered",
        ),
        check(
            "input safety",
            bool(input_report.get("passed")),
            f"{len(input_report.get('forbiddenTokens') or [])} forbidden real-input tokens",
        ),
        check(
            "live game window detected",
            window_or_historical_client,
            (
                f"{len(windows)} window(s) titled like {DEFAULT_TITLE}; "
                "historical full-task client evidence accepted after StopApp"
                if historical_client_ok and not windows
                else f"{len(windows)} window(s) titled like {DEFAULT_TITLE}"
            ),
        ),
        check(
            "privilege compatible for live input",
            current_privilege_ok or historical_privilege_ok,
            (
                "current audit process is compatible or completed task logs prove the "
                "controller was elevated when the target was elevated"
            ),
        ),
        check(
            "4:3 client aspect observed",
            aspect_ok,
            (
                "all detected target client areas or historical full-task logs should stay close to 4:3"
            ),
        ),
        check(
            "full live task evidence",
            bool(task_evidence["fullCoverageHwnds"])
            and task_evidence["requiredInterfaceTasks"] > 0,
            (
                f"best hwnd {task_evidence['bestHwndCompletedInterfaceTasks']}/"
                f"{task_evidence['requiredInterfaceTasks']} Maa interface tasks; "
                f"{len(task_evidence['fullCoverageHwnds'])} hwnd(s) have full non-dry-run coverage"
            ),
        ),
    ]


def check(name: str, passed: bool, detail: str) -> dict[str, object]:
    return {"name": name, "passed": passed, "detail": detail}


def inspect_windows(title: str) -> dict[str, Any]:
    try:
        capture_window.set_dpi_awareness()
        current = capture_window.current_process_elevated()
        windows = capture_window.list_windows(title)
    except Exception as exc:
        return {
            "error": f"{type(exc).__name__}: {exc}",
            "currentProcessElevated": None,
            "elevatedTargetMismatch": False,
            "windows": [],
        }
    annotated = []
    for item in windows:
        width = int(item.get("clientWidth") or 0)
        height = int(item.get("clientHeight") or 0)
        aspect = width / height if height else 0
        enriched = dict(item)
        enriched["clientAspect"] = round(aspect, 5) if aspect else None
        enriched["aspectCloseTo4x3"] = bool(aspect and abs(aspect - ASPECT_4_3) <= ASPECT_TOLERANCE)
        annotated.append(enriched)
    elevated_mismatch = any(item.get("elevated") is True for item in annotated) and current is not True
    return {
        "currentProcessElevated": current,
        "elevatedTargetMismatch": elevated_mismatch,
        "windows": annotated,
    }


def collect_required_tasks(project_root: Path, status: dict[str, Any]) -> list[dict[str, str]]:
    maa_root = Path(str(status.get("maaRoot") or project_root.parent / "Maa_MHXY_MG"))
    interface_path = maa_root / "assets/interface.json"
    if not interface_path.is_file():
        return []
    interface = read_json(interface_path)
    tasks = []
    for item in interface.get("task") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("entry") or "").strip()
        entry = str(item.get("entry") or "").strip()
        if entry:
            tasks.append({"name": name, "entry": entry})
    return tasks


def collect_task_evidence(project_root: Path, required_tasks: list[dict[str, str]]) -> dict[str, Any]:
    log_root = project_root / "assets/resource/ShiKong/logs"
    rows = []
    required_entries = sorted({task["entry"] for task in required_tasks})
    required_names = [task["name"] for task in required_tasks]
    completed_real = set()
    completed_dry = set()
    completed_real_names = set()
    completed_dry_names = set()
    real_rows_by_name: dict[str, list[dict[str, Any]]] = {}
    real_rows_by_hwnd: dict[str, list[dict[str, Any]]] = {}
    dry_rows_by_hwnd: dict[str, list[dict[str, Any]]] = {}
    if log_root.is_dir():
        for path in sorted(log_root.glob("task-*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                data = read_json(path)
            except Exception:
                continue
            entry = str(data.get("entry") or "")
            task_name = str(data.get("taskName") or "")
            dry_run = bool(data.get("dryRun"))
            raw_completed = bool(data.get("completed"))
            completed = accepted_task_report(data)
            hwnd = str(data.get("hwnd") or "")
            row = {
                "path": str(path),
                "hwnd": hwnd,
                "taskName": task_name,
                "entry": entry,
                "dryRun": dry_run,
                "completed": completed,
                "rawCompleted": raw_completed,
                "coordinateMode": data.get("coordinateMode"),
                "controllerElevated": data.get("controllerElevated"),
                "targetElevated": data.get("targetElevated"),
                "clientWidth": data.get("clientWidth"),
                "clientHeight": data.get("clientHeight"),
                "clientAspect": data.get("clientAspect"),
                "aspectCloseTo4x3": data.get("aspectCloseTo4x3"),
                "clientEvidenceCaptureSource": data.get("clientEvidenceCaptureSource"),
                "captureSources": data.get("captureSources") or [],
                "usedScreenRegionFallback": bool(data.get("usedScreenRegionFallback")),
                "stoppedReason": data.get("stoppedReason"),
                "steps": len(data.get("steps") or []),
                "durationMs": data.get("durationMs"),
                "mtime": int(path.stat().st_mtime),
            }
            rows.append(row)
            if completed and entry:
                if dry_run:
                    completed_dry.add(entry)
                    if task_name:
                        completed_dry_names.add(task_name)
                        if hwnd:
                            dry_rows_by_hwnd.setdefault(hwnd, []).append(row)
                else:
                    completed_real.add(entry)
                    if task_name:
                        completed_real_names.add(task_name)
                        real_rows_by_name.setdefault(task_name, []).append(row)
                        if hwnd:
                            real_rows_by_hwnd.setdefault(hwnd, []).append(row)
    missing_real_entries = [entry for entry in required_entries if entry not in completed_real]
    missing_real_tasks = [name for name in required_names if name not in completed_real_names]
    per_hwnd = build_per_hwnd_coverage(required_names, real_rows_by_hwnd)
    per_hwnd_dry = build_per_hwnd_coverage(required_names, dry_rows_by_hwnd)
    full_hwnds = [row["hwnd"] for row in per_hwnd if row["missingInterfaceTasks"] == 0]
    full_dry_hwnds = [row["hwnd"] for row in per_hwnd_dry if row["missingInterfaceTasks"] == 0]
    full_hwnds_with_privilege = [
        row["hwnd"]
        for row in per_hwnd
        if row["missingInterfaceTasks"] == 0 and row["missingPrivilegeEvidenceInterfaceTasks"] == 0
    ]
    full_hwnds_with_client = [
        row["hwnd"]
        for row in per_hwnd
        if row["missingInterfaceTasks"] == 0 and row["missingClientEvidenceInterfaceTasks"] == 0
    ]
    missing_privilege_evidence = [
        name
        for name in required_names
        if not any(row_has_privilege_evidence(row) for row in real_rows_by_name.get(name, []))
    ]
    return {
        "requiredInterfaceTasks": len(required_tasks),
        "requiredTaskEntries": len(required_entries),
        "realCompletedInterfaceTasks": len(completed_real_names.intersection(required_names)),
        "dryRunCompletedInterfaceTasks": len(completed_dry_names.intersection(required_names)),
        "realCompletedTaskEntries": len(completed_real.intersection(required_entries)),
        "dryRunCompletedTaskEntries": len(completed_dry.intersection(required_entries)),
        "missingRealCompletedInterfaceTasks": missing_real_tasks,
        "missingRealCompletedEntries": missing_real_entries,
        "completedTaskPrivilegeEvidence": (
            len(required_names) > 0 and bool(full_hwnds_with_privilege)
        ),
        "completedTaskClientEvidence": (
            len(required_names) > 0 and bool(full_hwnds_with_client)
        ),
        "missingPrivilegeEvidenceInterfaceTasks": missing_privilege_evidence,
        "missingClientEvidenceInterfaceTasks": [
            name
            for name in required_names
            if not any(row_has_client_evidence(row) for row in real_rows_by_name.get(name, []))
        ],
        "bestHwndCompletedInterfaceTasks": max(
            [row["completedInterfaceTasks"] for row in per_hwnd],
            default=0,
        ),
        "bestHwndDryRunCompletedInterfaceTasks": max(
            [row["completedInterfaceTasks"] for row in per_hwnd_dry],
            default=0,
        ),
        "fullCoverageHwnds": full_hwnds,
        "fullCoverageHwndsWithPrivilegeEvidence": full_hwnds_with_privilege,
        "fullCoverageHwndsWithClientEvidence": full_hwnds_with_client,
        "fullDryRunCoverageHwnds": full_dry_hwnds,
        "perHwndTaskCoverage": per_hwnd,
        "perHwndDryRunTaskCoverage": per_hwnd_dry,
        "completedRealInterfaceTasks": sorted(completed_real_names),
        "completedDryRunInterfaceTasks": sorted(completed_dry_names),
        "completedRealEntries": sorted(completed_real),
        "completedDryRunEntries": sorted(completed_dry),
        "reports": len(rows),
        "realReports": sum(1 for row in rows if not row["dryRun"]),
        "dryRunReports": sum(1 for row in rows if row["dryRun"]),
        "latestReports": rows[:20],
    }


def build_per_hwnd_coverage(
    required_names: list[str],
    real_rows_by_hwnd: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    rows = []
    required = set(required_names)
    for hwnd, task_rows in real_rows_by_hwnd.items():
        names = {str(row.get("taskName") or "") for row in task_rows if row.get("taskName")}
        missing = [name for name in required_names if name not in names]
        privilege_missing = [
            name
            for name in required_names
            if not any(
                row.get("taskName") == name and row_has_privilege_evidence(row)
                for row in task_rows
            )
        ]
        client_missing = [
            name
            for name in required_names
            if not any(
                row.get("taskName") == name and row_has_client_evidence(row)
                for row in task_rows
            )
        ]
        rows.append(
            {
                "hwnd": hwnd,
                "completedInterfaceTasks": len(names.intersection(required)),
                "missingInterfaceTasks": len(missing),
                "missingPrivilegeEvidenceInterfaceTasks": len(privilege_missing),
                "missingClientEvidenceInterfaceTasks": len(client_missing),
                "completedTaskNames": sorted(names.intersection(required)),
                "missingTaskNames": missing,
            }
        )
    rows.sort(
        key=lambda row: (
            -int(row["completedInterfaceTasks"]),
            int(row["missingPrivilegeEvidenceInterfaceTasks"]),
            str(row["hwnd"]),
        )
        )
    return rows


BAD_COMPLETION_STATUSES = {
    "action-failed",
    "candidate-cancelled",
    "candidate-empty",
    "candidate-timeout",
    "capture-error",
    "cancelled",
    "window-identity-mismatch",
}


def accepted_task_report(data: dict[str, Any]) -> bool:
    if data.get("completed") is not True:
        return False
    steps = data.get("steps")
    if not isinstance(steps, list) or not steps:
        return False
    last_substantive_status = None
    for step in steps:
        if not isinstance(step, dict):
            continue
        status = str(step.get("status") or "")
        if status in BAD_COMPLETION_STATUSES:
            return False
        if status != "jump-back-return":
            last_substantive_status = status
    return last_substantive_status not in {None, "miss", "missing"}


def row_has_privilege_evidence(row: dict[str, Any]) -> bool:
    target_elevated = row.get("targetElevated")
    controller_elevated = row.get("controllerElevated")
    if target_elevated is True:
        return controller_elevated is True
    if target_elevated is False:
        return controller_elevated in {False, True}
    return False


def row_has_client_evidence(row: dict[str, Any]) -> bool:
    width = as_number(row.get("clientWidth"))
    height = as_number(row.get("clientHeight"))
    if not width or not height:
        return False
    if row.get("aspectCloseTo4x3") is True:
        return True
    aspect = as_number(row.get("clientAspect")) or (width / height if height else None)
    return bool(aspect and abs(aspect - ASPECT_4_3) <= ASPECT_TOLERANCE)


def as_number(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def input_safety(project_root: Path) -> dict[str, Any]:
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


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
