#!/usr/bin/env python3
"""Build a per-window live acceptance run plan.

This script is read-only with respect to the game client: it does not send
input, start/stop processes, or touch windows. It converts the latest live
acceptance report into a concrete missing-task plan per hwnd.
"""

from __future__ import annotations

import argparse
import html
import json
import time
from pathlib import Path
from typing import Any


DEFAULT_LIVE_REPORT = Path("assets/resource/ShiKong/reports/latest-live-acceptance.json")
DEFAULT_STATUS_REPORT = Path("assets/resource/ShiKong/reports/latest-migration-status.json")
DEFAULT_JSON_REPORT = Path("assets/resource/ShiKong/reports/latest-acceptance-plan.json")
DEFAULT_HTML_REPORT = Path("assets/resource/ShiKong/reports/latest-acceptance-plan.html")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--live-report", type=Path, default=DEFAULT_LIVE_REPORT)
    parser.add_argument("--status", type=Path, default=DEFAULT_STATUS_REPORT)
    parser.add_argument("--json-report", type=Path, default=DEFAULT_JSON_REPORT)
    parser.add_argument("--html-report", type=Path, default=DEFAULT_HTML_REPORT)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    live_path = resolve(project_root, args.live_report)
    status_path = resolve(project_root, args.status)
    live = read_json(live_path) if live_path.is_file() else {}
    status = read_json(status_path) if status_path.is_file() else {}
    tasks = collect_required_tasks(project_root, status)
    plan = build_plan(project_root, live, status, tasks, str(live_path), str(status_path))

    json_path = resolve(project_root, args.json_report)
    html_path = resolve(project_root, args.html_report)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    html_path.write_text(build_html(plan), encoding="utf-8")

    output = {
        "json": str(json_path),
        "html": str(html_path),
        "passed": plan["passed"],
        "windows": len(plan["windows"]),
        "bestCompleted": plan["summary"]["bestCompleted"],
        "requiredTasks": plan["summary"]["requiredTasks"],
        "totalMissingWindowTasks": plan["summary"]["totalMissingWindowTasks"],
        "nextActions": [item["nextAction"] for item in plan["windows"]],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


def build_plan(
    project_root: Path,
    live: dict[str, Any],
    status: dict[str, Any],
    tasks: list[dict[str, str]],
    live_report: str,
    status_report: str,
) -> dict[str, Any]:
    task_evidence = live.get("taskEvidence") or {}
    required_names = [task["name"] for task in tasks]
    required_count = len(required_names)
    windows = live.get("windowStatus", {}).get("windows") or []
    real_by_hwnd = rows_by_hwnd(task_evidence.get("perHwndTaskCoverage") or [])
    dry_by_hwnd = rows_by_hwnd(task_evidence.get("perHwndDryRunTaskCoverage") or [])
    current_elevated = live.get("windowStatus", {}).get("currentProcessElevated")
    planned_windows = []

    for window in windows:
        hwnd = str(window.get("hwnd") or "")
        real = real_by_hwnd.get(hwnd)
        dry = dry_by_hwnd.get(hwnd)
        missing_names = list(real.get("missingTaskNames") or []) if real else required_names
        completed = int(real.get("completedInterfaceTasks") or 0) if real else 0
        dry_completed = int(dry.get("completedInterfaceTasks") or 0) if dry else 0
        missing_tasks = [
            {
                "index": index + 1,
                "name": task["name"],
                "entry": task["entry"],
            }
            for index, task in enumerate(tasks)
            if task["name"] in set(missing_names)
        ]
        admin_required = window.get("elevated") is True and current_elevated is not True
        next_action = next_action_for(admin_required, completed, required_count, missing_tasks)
        planned_windows.append(
            {
                "hwnd": hwnd,
                "title": window.get("title"),
                "processId": window.get("processId"),
                "targetElevated": window.get("elevated"),
                "controllerElevated": current_elevated,
                "clientWidth": window.get("clientWidth"),
                "clientHeight": window.get("clientHeight"),
                "clientAspect": window.get("clientAspect"),
                "aspectCloseTo4x3": window.get("aspectCloseTo4x3"),
                "completedTasks": completed,
                "dryRunCompletedTasks": dry_completed,
                "missingTasks": len(missing_tasks),
                "missingTaskNames": [task["name"] for task in missing_tasks],
                "missingTaskEntries": [task["entry"] for task in missing_tasks],
                "missingTaskPlan": missing_tasks,
                "adminRequired": admin_required,
                "nextAction": next_action,
            }
        )

    planned_windows.sort(key=lambda item: (-item["completedTasks"], item["missingTasks"], item["hwnd"]))
    total_missing = sum(int(item["missingTasks"]) for item in planned_windows)
    return {
        "version": 1,
        "generatedAt": int(time.time()),
        "projectRoot": str(project_root),
        "liveReport": live_report,
        "statusReport": status_report,
        "passed": bool(live.get("passed")),
        "summary": {
            "implementationComplete": bool(status.get("complete")),
            "liveAcceptancePassed": bool(live.get("passed")),
            "windows": len(planned_windows),
            "requiredTasks": required_count,
            "bestCompleted": max((int(item["completedTasks"]) for item in planned_windows), default=0),
            "totalMissingWindowTasks": total_missing,
            "currentProcessElevated": current_elevated,
            "elevatedTargetMismatch": live.get("summary", {}).get("elevatedTargetMismatch"),
            "releaseExe": str(project_root / "src-tauri/target/release/mhxy-shikong-control.exe"),
            "adminDevCommand": "npm run tauri:dev:admin",
        },
        "windows": planned_windows,
    }


def next_action_for(
    admin_required: bool,
    completed: int,
    required_count: int,
    missing_tasks: list[dict[str, str]],
) -> str:
    if not missing_tasks and required_count > 0:
        return "complete: run npm run audit:live-acceptance to confirm"
    if admin_required:
        return "start controller as administrator, then run missing acceptance"
    if completed == 0:
        return "run full acceptance on this hwnd"
    return "run missing acceptance on this hwnd"


def rows_by_hwnd(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(row.get("hwnd") or ""): row for row in rows if row.get("hwnd") is not None}


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
    return acceptance_ordered_tasks(tasks)


def acceptance_ordered_tasks(tasks: list[dict[str, str]]) -> list[dict[str, str]]:
    return [task for task in tasks if not is_stop_app_task(task)] + [
        task for task in tasks if is_stop_app_task(task)
    ]


def is_stop_app_task(task: dict[str, str]) -> bool:
    return task.get("entry") == "stop" or task.get("name") == "停止游戏"


def build_html(plan: dict[str, Any]) -> str:
    rows = []
    for window in plan.get("windows") or []:
        missing_preview = "<br>".join(html.escape(name) for name in window.get("missingTaskNames", [])[:12])
        if window.get("missingTasks", 0) > 12:
            missing_preview += f"<br>... +{int(window['missingTasks']) - 12}"
        rows.append(
            "<tr>"
            f"<td>{html.escape(str(window.get('hwnd') or ''))}</td>"
            f"<td>{html.escape(str(window.get('completedTasks')))} / {html.escape(str(plan['summary']['requiredTasks']))}</td>"
            f"<td>{html.escape(str(window.get('dryRunCompletedTasks')))}</td>"
            f"<td>{html.escape(str(window.get('targetElevated')))}</td>"
            f"<td>{html.escape(str(window.get('adminRequired')))}</td>"
            f"<td>{html.escape(str(window.get('nextAction')))}</td>"
            f"<td>{missing_preview}</td>"
            "</tr>"
        )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>梦幻西游：时空 实机验收计划</title>
  <style>
    body {{ font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #101315; color: #ece7dc; margin: 24px; }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border: 1px solid #30363b; padding: 8px; vertical-align: top; font-size: 13px; }}
    th {{ background: #181c1f; text-align: left; }}
    code, .muted {{ color: #9aa5ad; }}
  </style>
</head>
<body>
  <h1>梦幻西游：时空 实机验收计划</h1>
  <p class="muted">Generated at {html.escape(str(plan.get('generatedAt')))}. This report is read-only and does not control the game.</p>
  <p>Implementation complete: <strong>{html.escape(str(plan['summary']['implementationComplete']))}</strong>;
     live acceptance passed: <strong>{html.escape(str(plan['summary']['liveAcceptancePassed']))}</strong>;
     best completed: <strong>{html.escape(str(plan['summary']['bestCompleted']))}/{html.escape(str(plan['summary']['requiredTasks']))}</strong>.</p>
  <p>Admin dev command: <code>{html.escape(plan['summary']['adminDevCommand'])}</code></p>
  <p>Release exe: <code>{html.escape(plan['summary']['releaseExe'])}</code></p>
  <table>
    <thead>
      <tr><th>hwnd</th><th>real</th><th>dry</th><th>target elevated</th><th>admin required</th><th>next action</th><th>missing preview</th></tr>
    </thead>
    <tbody>
      {''.join(rows) or '<tr><td colspan="7">No matching game windows in the live report.</td></tr>'}
    </tbody>
  </table>
</body>
</html>
"""


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
