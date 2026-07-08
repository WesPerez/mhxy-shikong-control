#!/usr/bin/env python3
"""Audit the Maa runtime surface used by the ShiKong controller.

This is a read-only audit. It checks recognition/action/custom hook coverage for
the exact pipeline roots loaded by the Rust runtime: Maa base pipeline plus the
ShiKong override pipeline. Interface-reachable hooks are treated as completion
evidence; non-interface resource hooks are reported as context.
"""

from __future__ import annotations

import argparse
import html
import json
import time
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Any


DEFAULT_JSON_REPORT = Path("assets/resource/ShiKong/reports/latest-runtime-surface.json")
DEFAULT_HTML_REPORT = Path("assets/resource/ShiKong/reports/latest-runtime-surface.html")

SUPPORTED_RECOGNITION = {"DirectHit", "TemplateMatch", "ColorMatch", "OCR", "Or", "And", "Custom"}
SUPPORTED_ACTION = {"Click", "Swipe", "MultiSwipe", "InputText", "ClickKey", "Custom", "StartApp", "StopApp"}
MANUAL_ACTION = set()
SUPPORTED_CUSTOM_RECOGNITION = {
    "invite",
    "OCRNum",
    "OCRVitality",
    "sjqy_tiku_V2",
    "sjqy_tiku_V3",
    "AIAnswer",
    "zhipu",
}
PLACEHOLDER_CUSTOM_RECOGNITION = {"reco2", "my_reco_222"}
SUPPORTED_CUSTOM_ACTION = {
    "count",
    "countGlobal",
    "countZG",
    "input_node_success_num",
    "output_node_success_num",
    "returnOCR",
}
PLACEHOLDER_CUSTOM_ACTION = {"my_action_111"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--maa-root", type=Path, default=None)
    parser.add_argument("--json-report", type=Path, default=DEFAULT_JSON_REPORT)
    parser.add_argument("--html-report", type=Path, default=DEFAULT_HTML_REPORT)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    maa_root = (args.maa_root or project_root.parent / "Maa_MHXY_MG").resolve()
    report = build_report(project_root, maa_root)

    json_path = resolve(project_root, args.json_report)
    html_path = resolve(project_root, args.html_report)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    html_path.write_text(build_html(report), encoding="utf-8")

    print(
        json.dumps(
            {
                "json": str(json_path),
                "html": str(html_path),
                "passed": report["passed"],
                "interfaceReachableNodes": report["summary"]["interfaceReachableNodes"],
                "interfaceUnsupportedHooks": report["summary"]["interfaceUnsupportedHooks"],
                "interfacePlaceholderHooks": report["summary"]["interfacePlaceholderHooks"],
                "interfaceManualHooks": report["summary"]["interfaceManualHooks"],
                "missingInterfaceNodes": report["summary"]["missingInterfaceNodes"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["passed"] else 2


def build_report(project_root: Path, maa_root: Path) -> dict[str, Any]:
    interface_tasks = load_interface_tasks(maa_root)
    nodes, node_sources, pipeline_files = load_runtime_nodes(project_root, maa_root)
    reachable, missing_refs = reachable_from_entries(nodes, interface_tasks)
    all_hooks = collect_surface(nodes.keys(), nodes, node_sources)
    interface_hooks = collect_surface(reachable, nodes, node_sources)
    interface_issues = issue_items(interface_hooks, include_manual=False)
    interface_manual = manual_items(interface_hooks)
    all_issues = issue_items(all_hooks, include_manual=False)
    all_manual = manual_items(all_hooks)
    passed = not interface_issues and not missing_refs and bool(interface_tasks)
    return {
        "version": 1,
        "generatedAt": int(time.time()),
        "projectRoot": str(project_root),
        "maaRoot": str(maa_root),
        "passed": passed,
        "policy": {
            "pipelineRoots": [
                "Maa_MHXY_MG/assets/resource/base/pipeline",
                "MHXY-ShiKong-Control/assets/resource/ShiKong/pipeline",
            ],
            "completionScope": "interface-reachable hooks only",
            "manualHooks": "reported as warnings; PC client StartApp is implemented as bound-window confirmation plus configured launcher command",
        },
        "summary": {
            "interfaceTasks": len(interface_tasks),
            "runtimeNodes": len(nodes),
            "pipelineFiles": pipeline_files,
            "interfaceReachableNodes": len(reachable),
            "missingInterfaceNodes": len(missing_refs),
            "interfaceUnsupportedHooks": count_status(interface_hooks, "unsupported"),
            "interfacePlaceholderHooks": count_status(interface_hooks, "placeholder"),
            "interfaceManualHooks": count_status(interface_hooks, "manual"),
            "allUnsupportedHooks": count_status(all_hooks, "unsupported"),
            "allPlaceholderHooks": count_status(all_hooks, "placeholder"),
            "allManualHooks": count_status(all_hooks, "manual"),
        },
        "interface": {
            "tasks": interface_tasks,
            "missingNodeRefs": missing_refs,
            "surface": surface_rows(interface_hooks),
            "issues": interface_issues,
            "manual": interface_manual,
        },
        "allResources": {
            "surface": surface_rows(all_hooks),
            "issues": all_issues,
            "manual": all_manual,
        },
    }


def load_interface_tasks(maa_root: Path) -> list[dict[str, str]]:
    interface_path = maa_root / "assets/interface.json"
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


def load_runtime_nodes(project_root: Path, maa_root: Path) -> tuple[dict[str, Any], dict[str, str], int]:
    roots = [
        maa_root / "assets/resource/base/pipeline",
        project_root / "assets/resource/ShiKong/pipeline",
    ]
    nodes: dict[str, Any] = {}
    sources: dict[str, str] = {}
    pipeline_files = 0
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.json")):
            data = read_json(path)
            if not isinstance(data, dict):
                continue
            pipeline_files += 1
            rel = slash(path.relative_to(project_root if project_root in path.parents else maa_root))
            for name, value in data.items():
                nodes[name] = value
                sources[name] = rel
    return nodes, sources, pipeline_files


def reachable_from_entries(
    nodes: dict[str, Any],
    tasks: list[dict[str, str]],
) -> tuple[set[str], list[dict[str, str]]]:
    seen: set[str] = set()
    missing: list[dict[str, str]] = []
    queue = deque((task["entry"], "interface", task["name"]) for task in tasks)
    while queue:
        raw, from_node, via = queue.popleft()
        name = strip_jumpback(raw)
        if not name:
            continue
        if name not in nodes:
            missing.append({"from": from_node, "target": name, "via": via})
            continue
        if name in seen:
            continue
        seen.add(name)
        for ref in refs_from_value(nodes[name]):
            queue.append((ref, name, "next/on_error"))
    return seen, missing


def collect_surface(
    node_names: Any,
    nodes: dict[str, Any],
    node_sources: dict[str, str],
) -> dict[str, dict[str, dict[str, Any]]]:
    surface: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for node_name in sorted(node_names):
        value = nodes.get(node_name)
        if value is None:
            continue
        examples = collect_hooks(value)
        for category, names in examples.items():
            for name, count in Counter(names).items():
                bucket = surface[category].setdefault(
                    name,
                    {
                        "name": name,
                        "category": category,
                        "status": status_for(category, name),
                        "count": 0,
                        "examples": [],
                    },
                )
                bucket["count"] += count
                if len(bucket["examples"]) < 5:
                    bucket["examples"].append(f"{node_sources.get(node_name, '-') } :: {node_name}")
    return surface


def collect_hooks(value: Any) -> dict[str, list[str]]:
    found: dict[str, list[str]] = defaultdict(list)
    if isinstance(value, dict):
        for key, category in [
            ("recognition", "recognition"),
            ("action", "action"),
            ("custom_recognition", "custom_recognition"),
            ("custom_action", "custom_action"),
        ]:
            item = value.get(key)
            if isinstance(item, str) and item:
                found[category].append(item)
        for child in value.values():
            child_found = collect_hooks(child)
            for category, names in child_found.items():
                found[category].extend(names)
    elif isinstance(value, list):
        for child in value:
            child_found = collect_hooks(child)
            for category, names in child_found.items():
                found[category].extend(names)
    return found


def refs_from_value(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key in ("next", "on_error"):
            refs.extend(refs_from_ref_value(value.get(key)))
        for child in value.values():
            refs.extend(refs_from_value(child))
    elif isinstance(value, list):
        for child in value:
            refs.extend(refs_from_value(child))
    return refs


def refs_from_ref_value(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        refs: list[str] = []
        for item in value:
            if isinstance(item, str):
                refs.append(item)
            elif isinstance(item, dict):
                raw = item.get("name") or item.get("task") or item.get("node")
                if isinstance(raw, str):
                    refs.append(raw)
        return refs
    return []


def surface_rows(surface: dict[str, dict[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    rows = []
    for category, items in surface.items():
        rows.extend(items.values())
    rows.sort(key=lambda item: (status_rank(item["status"]), item["category"], item["name"]))
    return rows


def issue_items(surface: dict[str, dict[str, dict[str, Any]]], include_manual: bool) -> list[dict[str, Any]]:
    bad = {"unsupported", "placeholder"}
    if include_manual:
        bad.add("manual")
    return [item for item in surface_rows(surface) if item["status"] in bad]


def manual_items(surface: dict[str, dict[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    return [item for item in surface_rows(surface) if item["status"] == "manual"]


def count_status(surface: dict[str, dict[str, dict[str, Any]]], status: str) -> int:
    return sum(1 for item in surface_rows(surface) if item["status"] == status)


def status_for(category: str, name: str) -> str:
    if category == "recognition":
        return "supported" if name in SUPPORTED_RECOGNITION else "unsupported"
    if category == "action":
        if name in SUPPORTED_ACTION:
            return "supported"
        if name in MANUAL_ACTION:
            return "manual"
        return "unsupported"
    if category == "custom_recognition":
        if name in SUPPORTED_CUSTOM_RECOGNITION:
            return "supported"
        if name in PLACEHOLDER_CUSTOM_RECOGNITION:
            return "placeholder"
        return "unsupported"
    if category == "custom_action":
        if name in SUPPORTED_CUSTOM_ACTION:
            return "supported"
        if name in PLACEHOLDER_CUSTOM_ACTION:
            return "placeholder"
        return "unsupported"
    return "unsupported"


def status_rank(status: str) -> int:
    return {
        "unsupported": 0,
        "placeholder": 1,
        "manual": 2,
        "supported": 3,
    }.get(status, 0)


def strip_jumpback(raw: str) -> str:
    value = raw.strip()
    if value.startswith("[JumpBack]"):
        value = value[len("[JumpBack]") :].strip()
    return "" if value == "空节点" else value


def build_html(report: dict[str, Any]) -> str:
    def rows(items: list[dict[str, Any]]) -> str:
        if not items:
            return '<tr><td colspan="5">none</td></tr>'
        return "".join(
            "<tr>"
            f"<td>{html.escape(item['category'])}</td>"
            f"<td>{html.escape(item['name'])}</td>"
            f"<td>{html.escape(item['status'])}</td>"
            f"<td>{html.escape(str(item['count']))}</td>"
            f"<td>{html.escape(' | '.join(item.get('examples') or []))}</td>"
            "</tr>"
            for item in items
        )

    summary = report["summary"]
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>梦幻西游：时空 Runtime Surface Audit</title>
  <style>
    body {{ font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #101315; color: #ece7dc; margin: 24px; }}
    table {{ border-collapse: collapse; width: 100%; margin: 12px 0 24px; }}
    th, td {{ border: 1px solid #30363b; padding: 8px; vertical-align: top; font-size: 13px; }}
    th {{ background: #181c1f; text-align: left; }}
    .muted {{ color: #9aa5ad; }}
  </style>
</head>
<body>
  <h1>Runtime Surface Audit</h1>
  <p class="muted">Read-only audit for interface-reachable recognition/action/custom hooks.</p>
  <p>Passed: <strong>{html.escape(str(report['passed']))}</strong>;
     interface reachable nodes: <strong>{html.escape(str(summary['interfaceReachableNodes']))}</strong>;
     unsupported: <strong>{html.escape(str(summary['interfaceUnsupportedHooks']))}</strong>;
     placeholder: <strong>{html.escape(str(summary['interfacePlaceholderHooks']))}</strong>;
     manual: <strong>{html.escape(str(summary['interfaceManualHooks']))}</strong>.</p>
  <h2>Interface Issues</h2>
  <table><thead><tr><th>category</th><th>name</th><th>status</th><th>count</th><th>examples</th></tr></thead><tbody>{rows(report['interface']['issues'])}</tbody></table>
  <h2>Interface Manual Warnings</h2>
  <table><thead><tr><th>category</th><th>name</th><th>status</th><th>count</th><th>examples</th></tr></thead><tbody>{rows(report['interface']['manual'])}</tbody></table>
  <h2>All Resource Issues</h2>
  <table><thead><tr><th>category</th><th>name</th><th>status</th><th>count</th><th>examples</th></tr></thead><tbody>{rows(report['allResources']['issues'])}</tbody></table>
</body>
</html>
"""


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def slash(path: Path) -> str:
    return path.as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
