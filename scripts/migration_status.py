#!/usr/bin/env python3
"""Build an auditable migration status report for the ShiKong port.

The report combines the original Maa inventory, ShiKong template mappings,
the latest mapping validation report, the latest manifest probe, and the
current window/elevation status. It is intentionally read-only and is meant to
act as the "are we actually done?" gate for the full rewrite/migration goal.
"""

from __future__ import annotations

import argparse
import html
import json
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import capture_window
import probe_pipeline_templates as probe


DEFAULT_STATUS_NAME = "latest-migration-status"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--maa-root", type=Path, default=None)
    parser.add_argument("--manifest-probe", type=Path, default=None)
    parser.add_argument("--validation-report", type=Path, default=None)
    parser.add_argument("--title", default="梦幻西游：时空")
    parser.add_argument("--report-name", default=DEFAULT_STATUS_NAME)
    parser.add_argument("--top-missing", type=int, default=80)
    parser.add_argument("--fail-on-incomplete", action="store_true")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    maa_root = (args.maa_root or project_root.parent / "Maa_MHXY_MG").resolve()
    manifest_probe_path = resolve_optional(
        project_root,
        args.manifest_probe,
        project_root / "assets/resource/ShiKong/reports/latest-manifest-probe.json",
    )
    validation_path = resolve_optional(
        project_root,
        args.validation_report,
        latest_file(project_root / "assets/resource/ShiKong/crop_plans", "template-validation-*.json"),
    )

    interface = read_json(maa_root / "assets/interface.json")
    refs = probe.collect_template_refs(maa_root)
    mapping = probe.load_mapping(project_root)
    text_fallbacks = load_text_fallbacks(project_root)
    pipeline_override_nodes = load_pipeline_override_nodes(project_root)
    pipeline_override_coverage = build_pipeline_override_coverage(refs, pipeline_override_nodes)
    manifest_probe = read_json(manifest_probe_path) if manifest_probe_path and manifest_probe_path.is_file() else {}
    validation = read_json(validation_path) if validation_path and validation_path.is_file() else {}
    window_status = inspect_windows(args.title)

    tasks = collect_tasks(interface, maa_root)
    presets = collect_presets(interface, {task["name"] for task in tasks})
    runtime_nodes = load_runtime_pipeline_nodes(maa_root, project_root)
    interface_reachable_nodes = collect_reachable_nodes(
        runtime_nodes, [str(task.get("entry") or "") for task in tasks]
    )
    template_rows = build_template_rows(
        project_root,
        maa_root,
        refs,
        mapping,
        text_fallbacks,
        pipeline_override_coverage,
        interface_reachable_nodes,
        manifest_probe,
        validation,
        tasks,
    )
    domains = build_domain_rows(template_rows)
    task_rows = build_task_rows(template_rows, tasks)
    gates = build_gates(tasks, presets, template_rows, manifest_probe, validation)
    complete = all(
        gate["status"] == "pass"
        for gate in gates
        if gate.get("kind") == "completion"
    )

    report = {
        "version": 1,
        "generatedAt": int(time.time()),
        "complete": complete,
        "projectRoot": str(project_root),
        "maaRoot": str(maa_root),
        "manifestProbe": relative_or_absolute(project_root, manifest_probe_path) if manifest_probe_path else None,
        "validationReport": relative_or_absolute(project_root, validation_path) if validation_path else None,
        "windowStatus": window_status,
        "summary": build_summary(tasks, presets, template_rows, manifest_probe, validation),
        "gates": gates,
        "domains": domains,
        "tasks": task_rows,
        "missingTemplates": [row for row in template_rows if not row["mapped"]][: args.top_missing],
        "unhitMappedTemplates": [row for row in template_rows if row["mapped"] and not row["manifestHit"]][: args.top_missing],
        "templates": template_rows,
    }

    report_dir = project_root / "assets/resource/ShiKong/reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_name(args.report_name)
    json_path = report_dir / f"{stem}.json"
    html_path = report_dir / f"{stem}.html"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    html_path.write_text(build_html(report), encoding="utf-8")

    print(
        json.dumps(
            {
                "json": str(json_path),
                "html": str(html_path),
                "complete": complete,
                "summary": report["summary"],
                "failedGates": [gate for gate in gates if gate["status"] != "pass"],
                "failedCompletionGates": [
                    gate
                    for gate in gates
                    if gate.get("kind") == "completion" and gate["status"] != "pass"
                ],
                "auditWarnings": [
                    gate
                    for gate in gates
                    if gate.get("kind") == "audit" and gate["status"] != "pass"
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 2 if args.fail_on_incomplete and not complete else 0


def collect_tasks(interface: dict[str, Any], maa_root: Path) -> list[dict[str, Any]]:
    node_to_pipeline = collect_node_to_pipeline(maa_root)
    tasks: list[dict[str, Any]] = []
    for index, item in enumerate(interface.get("task") or [], start=1):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("entry") or f"task-{index}")
        entry = str(item.get("entry") or "")
        pipeline = node_to_pipeline.get(entry)
        tasks.append(
            {
                "index": index,
                "name": name,
                "entry": entry,
                "pipeline": pipeline,
                "options": item.get("option") or [],
                "entryFound": pipeline is not None,
            }
        )
    return tasks


def collect_node_to_pipeline(maa_root: Path) -> dict[str, str]:
    node_to_pipeline: dict[str, str] = {}
    pipeline_root = maa_root / "assets/resource/base/pipeline"
    for path in sorted(pipeline_root.rglob("*.json")):
        try:
            data = read_json(path)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        pipeline = path.relative_to(maa_root).as_posix()
        for node in data:
            node_to_pipeline.setdefault(str(node), pipeline)
    return node_to_pipeline


def load_runtime_pipeline_nodes(maa_root: Path, project_root: Path) -> dict[str, Any]:
    nodes: dict[str, Any] = {}
    for root in [
        maa_root / "assets/resource/base/pipeline",
        project_root / "assets/resource/ShiKong/pipeline",
    ]:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.json")):
            try:
                data = read_json(path)
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            for name, node in data.items():
                nodes[str(name)] = node
    return nodes


def collect_reachable_nodes(nodes: dict[str, Any], entries: list[str]) -> set[str]:
    reachable: set[str] = set()
    pending = [entry for entry in entries if entry and entry in nodes]
    while pending:
        name = pending.pop()
        if name in reachable:
            continue
        reachable.add(name)
        node = nodes.get(name)
        if not isinstance(node, dict):
            continue
        for field in ("next", "on_error"):
            for target in node_refs_from_value(node.get(field)):
                if target not in reachable and target in nodes:
                    pending.append(target)
    return reachable


def node_refs_from_value(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, str):
        item = normalize_node_ref(value)
        if item:
            refs.append(item)
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, str):
                item = normalize_node_ref(child)
                if item:
                    refs.append(item)
            elif isinstance(child, dict):
                raw = child.get("name") or child.get("task") or child.get("node")
                if isinstance(raw, str):
                    item = normalize_node_ref(raw)
                    if item:
                        refs.append(item)
    return refs


def normalize_node_ref(value: str) -> str | None:
    item = value.strip()
    if item.startswith("[JumpBack]"):
        item = item[len("[JumpBack]") :].strip()
    if not item or item == "空节点":
        return None
    return item


def collect_presets(interface: dict[str, Any], task_names: set[str]) -> dict[str, Any]:
    presets = []
    missing = []
    refs = 0
    for preset in interface.get("preset") or []:
        if not isinstance(preset, dict):
            continue
        name = str(preset.get("name") or "(unnamed preset)")
        task_items = []
        for task in preset.get("task") or []:
            if not isinstance(task, dict):
                continue
            task_name = str(task.get("name") or "")
            refs += 1
            found = task_name in task_names
            if not found:
                missing.append(f"{name} -> {task_name}")
            task_items.append({"name": task_name, "found": found})
        presets.append({"name": name, "tasks": task_items})
    return {
        "count": len(presets),
        "taskRefs": refs,
        "missingRefs": missing,
        "items": presets,
    }


def build_template_rows(
    project_root: Path,
    maa_root: Path,
    refs: list[probe.TemplateRef],
    mapping: dict[str, Any],
    text_fallbacks: set[str],
    pipeline_override_coverage: dict[str, dict[str, Any]],
    interface_reachable_nodes: set[str],
    manifest_probe: dict[str, Any],
    validation: dict[str, Any],
    tasks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_template: dict[str, dict[str, Any]] = {}
    tasks_by_pipeline = defaultdict(set)
    for task in tasks:
        if task.get("pipeline"):
            tasks_by_pipeline[task["pipeline"]].add(task["name"])

    manifest_by_template = {
        row.get("template"): row
        for row in manifest_probe.get("templateRows") or []
        if isinstance(row, dict) and row.get("template")
    }
    validation_by_template: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in validation.get("items") or []:
        if isinstance(item, dict) and item.get("template"):
            validation_by_template[str(item["template"])].append(item)

    for ref in refs:
        row = by_template.setdefault(
            ref.template,
            {
                "template": ref.template,
                "domain": ref.template.split("/", 1)[0],
                "refCount": 0,
                "pipelines": set(),
                "nodes": set(),
                "tasks": set(),
                "rois": set(),
            },
        )
        row["refCount"] += 1
        row["pipelines"].add(ref.pipeline)
        row["nodes"].add(ref.node)
        for task_name in tasks_by_pipeline.get(ref.pipeline, []):
            row["tasks"].add(task_name)
        if ref.roi:
            row["rois"].add(tuple(ref.roi))

    rows = []
    for template, row in by_template.items():
        meta = mapping.get(template) or {}
        variants = mapping_variants(meta)
        existing_variants = [
            variant
            for variant in variants
            if resolve(project_root, Path(str(variant.get("replacementPath") or ""))).is_file()
        ]
        text_fallback = template in text_fallbacks
        pipeline_override = pipeline_override_coverage.get(template) or {}
        pipeline_override_covered = bool(pipeline_override.get("covered"))
        manifest_row = manifest_by_template.get(template) or {}
        validation_items = validation_by_template.get(template, [])
        validation_failed = [item for item in validation_items if item.get("status") != "pass"]
        old_path = maa_root / "assets/resource/base/image" / template
        priority = template_priority(row)
        interface_reachable = any(node in interface_reachable_nodes for node in row["nodes"])
        runtime_coverage = []
        if existing_variants:
            runtime_coverage.append("templateMapping")
        if text_fallback:
            runtime_coverage.append("textFallback")
        if pipeline_override_covered:
            runtime_coverage.append("pipelineOverride")
        rows.append(
            {
                "template": template,
                "domain": row["domain"],
                "refCount": row["refCount"],
                "priority": priority,
                "mapped": bool(existing_variants),
                "textFallback": text_fallback,
                "pipelineOverride": pipeline_override_covered,
                "interfaceReachable": interface_reachable,
                "runtimeCovered": bool(existing_variants)
                or text_fallback
                or pipeline_override_covered,
                "runtimeCoverage": runtime_coverage,
                "variantCount": len(existing_variants),
                "replacementPaths": [
                    str(variant.get("replacementPath")) for variant in existing_variants
                ],
                "overrideNodes": pipeline_override.get("nodes") or [],
                "validationItems": len(validation_items),
                "validationPassed": len(validation_items) > 0 and not validation_failed,
                "validationFailed": len(validation_failed),
                "manifestHit": bool(manifest_row.get("mappedHitCaptures")),
                "manifestHitCaptures": manifest_row.get("mappedHitCaptures") or [],
                "bestManifestScore": manifest_row.get("bestScore"),
                "oldImageExists": old_path.is_file(),
                "pipelines": sorted(row["pipelines"]),
                "tasks": sorted(row["tasks"]),
                "nodes": sorted(row["nodes"])[:20],
                "rois": [list(roi) for roi in sorted(row["rois"])[:10]],
            }
        )
    rows.sort(key=lambda item: (item["mapped"], -item["priority"], item["template"]))
    return rows


def build_domain_rows(template_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in template_rows:
        grouped[row["domain"]].append(row)
    rows = []
    for domain, items in grouped.items():
        total = len(items)
        mapped = sum(1 for item in items if item["mapped"])
        text_fallback = sum(1 for item in items if item["textFallback"])
        pipeline_override = sum(1 for item in items if item["pipelineOverride"])
        runtime_covered = sum(1 for item in items if item["runtimeCovered"])
        manifest_hit = sum(1 for item in items if item["manifestHit"])
        rows.append(
            {
                "domain": domain,
                "templates": total,
                "mapped": mapped,
                "textFallback": text_fallback,
                "pipelineOverride": pipeline_override,
                "runtimeCovered": runtime_covered,
                "runtimeMissing": total - runtime_covered,
                "missing": total - mapped,
                "manifestHit": manifest_hit,
                "manifestMissing": total - manifest_hit,
                "refs": sum(item["refCount"] for item in items),
            }
        )
    rows.sort(key=lambda item: (-item["missing"], -item["refs"], item["domain"]))
    return rows


def build_task_rows(template_rows: list[dict[str, Any]], tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in template_rows:
        for task in row["tasks"] or ["(no direct task)"]:
            by_task[task].append(row)
    rows = []
    task_order = {task["name"]: task["index"] for task in tasks}
    for task, items in by_task.items():
        total = len(items)
        mapped = sum(1 for item in items if item["mapped"])
        text_fallback = sum(1 for item in items if item["textFallback"])
        pipeline_override = sum(1 for item in items if item["pipelineOverride"])
        runtime_covered = sum(1 for item in items if item["runtimeCovered"])
        manifest_hit = sum(1 for item in items if item["manifestHit"])
        rows.append(
            {
                "task": task,
                "order": task_order.get(task, 9999),
                "templates": total,
                "mapped": mapped,
                "textFallback": text_fallback,
                "pipelineOverride": pipeline_override,
                "runtimeCovered": runtime_covered,
                "runtimeMissing": total - runtime_covered,
                "missing": total - mapped,
                "manifestHit": manifest_hit,
                "manifestMissing": total - manifest_hit,
            }
        )
    rows.sort(key=lambda item: (-item["missing"], item["order"], item["task"]))
    return rows


def build_gates(
    tasks: list[dict[str, Any]],
    presets: dict[str, Any],
    template_rows: list[dict[str, Any]],
    manifest_probe: dict[str, Any],
    validation: dict[str, Any],
) -> list[dict[str, Any]]:
    unique_templates = len(template_rows)
    mapped_templates = sum(1 for row in template_rows if row["mapped"])
    runtime_covered_templates = sum(1 for row in template_rows if row["runtimeCovered"])
    interface_rows = [row for row in template_rows if row["interfaceReachable"]]
    interface_runtime_covered = sum(1 for row in interface_rows if row["runtimeCovered"])
    manifest_hit_templates = sum(1 for row in template_rows if row["manifestHit"])
    validation_failed = int(validation.get("failed") or 0)
    validation_total = int(validation.get("total") or 0)
    gates = [
        gate(
            "interface tasks",
            all(task["entryFound"] for task in tasks) and bool(tasks),
            f"{sum(1 for task in tasks if task['entryFound'])}/{len(tasks)} task entries found",
        ),
        gate(
            "preset task refs",
            not presets["missingRefs"] and presets["taskRefs"] > 0,
            f"{presets['taskRefs']} refs, missing {len(presets['missingRefs'])}",
        ),
        gate(
            "template mapping coverage",
            mapped_templates == unique_templates and unique_templates > 0,
            f"{mapped_templates}/{unique_templates} unique templates mapped",
            kind="audit",
        ),
        gate(
            "runtime recognition coverage",
            runtime_covered_templates == unique_templates and unique_templates > 0,
            f"{runtime_covered_templates}/{unique_templates} templates mapped, text-fallback, or pipeline-override covered",
        ),
        gate(
            "interface task runtime coverage",
            interface_runtime_covered == len(interface_rows) and bool(interface_rows),
            f"{interface_runtime_covered}/{len(interface_rows)} reachable task templates runtime covered",
        ),
        gate(
            "mapped template validation",
            validation_total > 0 and validation_failed == 0,
            f"{validation_total} variants checked, failed {validation_failed}",
        ),
        gate(
            "latest screenshot runtime hits",
            manifest_hit_templates == unique_templates and unique_templates > 0,
            f"{manifest_hit_templates}/{unique_templates} unique templates hit in latest manifest probe",
            kind="audit",
        ),
        gate(
            "manifest probe loaded",
            bool(manifest_probe.get("templateRows")),
            f"{len(manifest_probe.get('templateRows') or [])} template rows",
        ),
    ]
    return gates


def gate(
    name: str, passed: bool, detail: str, kind: str = "completion"
) -> dict[str, str]:
    status = "pass" if passed else ("warn" if kind == "audit" else "fail")
    return {"name": name, "status": status, "detail": detail, "kind": kind}


def build_summary(
    tasks: list[dict[str, Any]],
    presets: dict[str, Any],
    template_rows: list[dict[str, Any]],
    manifest_probe: dict[str, Any],
    validation: dict[str, Any],
) -> dict[str, Any]:
    mapped = sum(1 for row in template_rows if row["mapped"])
    text_fallback = sum(1 for row in template_rows if row["textFallback"])
    pipeline_override = sum(1 for row in template_rows if row["pipelineOverride"])
    runtime_covered = sum(1 for row in template_rows if row["runtimeCovered"])
    interface_rows = [row for row in template_rows if row["interfaceReachable"]]
    interface_runtime_covered = sum(1 for row in interface_rows if row["runtimeCovered"])
    manifest_hit = sum(1 for row in template_rows if row["manifestHit"])
    domains = Counter(row["domain"] for row in template_rows if not row["mapped"])
    runtime_missing_domains = Counter(row["domain"] for row in template_rows if not row["runtimeCovered"])
    interface_missing_domains = Counter(
        row["domain"] for row in interface_rows if not row["runtimeCovered"]
    )
    return {
        "tasks": len(tasks),
        "taskEntriesFound": sum(1 for task in tasks if task["entryFound"]),
        "presets": presets["count"],
        "presetTaskRefs": presets["taskRefs"],
        "presetTaskRefsMissing": len(presets["missingRefs"]),
        "uniqueTemplates": len(template_rows),
        "mappedTemplates": mapped,
        "textFallbackTemplates": text_fallback,
        "pipelineOverrideTemplates": pipeline_override,
        "runtimeCoveredTemplates": runtime_covered,
        "runtimeMissingTemplates": len(template_rows) - runtime_covered,
        "interfaceReachableTemplates": len(interface_rows),
        "interfaceRuntimeCoveredTemplates": interface_runtime_covered,
        "interfaceRuntimeMissingTemplates": len(interface_rows) - interface_runtime_covered,
        "missingTemplates": len(template_rows) - mapped,
        "manifestHitTemplates": manifest_hit,
        "manifestMissingTemplates": len(template_rows) - manifest_hit,
        "validationTotal": validation.get("total", 0),
        "validationPassed": validation.get("passed", 0),
        "validationFailed": validation.get("failed", 0),
        "latestManifestCaptures": manifest_probe.get("captureCount", 0),
        "topMissingDomains": domains.most_common(8),
        "topRuntimeMissingDomains": runtime_missing_domains.most_common(8),
        "topInterfaceRuntimeMissingDomains": interface_missing_domains.most_common(8),
    }


def inspect_windows(title: str) -> dict[str, Any]:
    try:
        capture_window.set_dpi_awareness()
        current = capture_window.current_process_elevated()
        windows = capture_window.list_windows(title)
        return {"currentProcessElevated": current, "windows": windows}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}", "windows": []}


def build_html(report: dict[str, Any]) -> str:
    gates = "\n".join(gate_row(gate_item) for gate_item in report["gates"])
    domains = "\n".join(domain_row(row) for row in report["domains"][:30])
    tasks = "\n".join(task_row(row) for row in report["tasks"][:60])
    missing = "\n".join(template_row(row) for row in report["missingTemplates"])
    unhit = "\n".join(template_row(row) for row in report["unhitMappedTemplates"])
    summary = html.escape(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    status = "COMPLETE" if report["complete"] else "INCOMPLETE"
    status_class = "ok" if report["complete"] else "fail"
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ShiKong Migration Status</title>
  <style>
    :root {{ color-scheme: dark; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: #111315; color: #ece7dc; }}
    body {{ margin: 0; background: #111315; }}
    header {{ padding: 18px 22px; background: #171a1d; border-bottom: 1px solid #2d3338; position: sticky; top: 0; z-index: 2; }}
    h1 {{ margin: 0 0 8px; font-size: 22px; letter-spacing: 0; }}
    h2 {{ margin: 24px 0 10px; font-size: 16px; color: #f4ead8; }}
    main {{ padding: 0 22px 36px; }}
    .meta, pre {{ color: #aeb8bf; font-size: 13px; line-height: 1.55; }}
    .badge {{ display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }}
    .ok {{ color: #062315; background: #72d390; }}
    .fail {{ color: #220b08; background: #ff8a70; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
    th, td {{ border-bottom: 1px solid #2b3034; padding: 7px 8px; text-align: left; vertical-align: top; }}
    th {{ background: #1c2024; color: #d8e1e8; position: sticky; top: 71px; }}
    td {{ color: #d8d0c4; word-break: break-word; }}
    code {{ color: #d8e1e8; }}
  </style>
</head>
<body>
  <header>
    <h1>梦幻西游：时空 迁移状态 <span class="badge {status_class}">{status}</span></h1>
    <div class="meta">manifest {html.escape(str(report.get("manifestProbe")))} · validation {html.escape(str(report.get("validationReport")))}</div>
  </header>
  <main>
    <h2>Summary</h2>
    <pre>{summary}</pre>
    <h2>Gates</h2>
    <table><thead><tr><th>gate</th><th>status</th><th>detail</th></tr></thead><tbody>{gates}</tbody></table>
    <h2>Missing By Domain</h2>
    <table><thead><tr><th>domain</th><th>mapped</th><th>runtime</th><th>manifest hit</th><th>refs</th></tr></thead><tbody>{domains}</tbody></table>
    <h2>Missing By Task</h2>
    <table><thead><tr><th>task</th><th>mapped</th><th>runtime</th><th>manifest hit</th></tr></thead><tbody>{tasks}</tbody></table>
    <h2>Top Missing Templates</h2>
    <table><thead><tr><th>template</th><th>refs</th><th>tasks</th><th>pipelines</th></tr></thead><tbody>{missing}</tbody></table>
    <h2>Mapped But Not Hit In Latest Manifest</h2>
    <table><thead><tr><th>template</th><th>refs</th><th>tasks</th><th>pipelines</th></tr></thead><tbody>{unhit}</tbody></table>
  </main>
</body>
</html>
"""


def gate_row(item: dict[str, str]) -> str:
    cls = "ok" if item["status"] == "pass" else "fail"
    return f"<tr><td>{html.escape(item['name'])}</td><td><span class=\"badge {cls}\">{item['status']}</span></td><td>{html.escape(item['detail'])}</td></tr>"


def domain_row(row: dict[str, Any]) -> str:
    return f"<tr><td><code>{html.escape(row['domain'])}</code></td><td>{row['mapped']}/{row['templates']} mapped, {row['missing']} missing</td><td>{row['runtimeCovered']}/{row['templates']} covered, {row['textFallback']} text, {row['pipelineOverride']} override</td><td>{row['manifestHit']}/{row['templates']} hit</td><td>{row['refs']}</td></tr>"


def task_row(row: dict[str, Any]) -> str:
    return f"<tr><td>{html.escape(row['task'])}</td><td>{row['mapped']}/{row['templates']} mapped, {row['missing']} missing</td><td>{row['runtimeCovered']}/{row['templates']} covered, {row['textFallback']} text, {row['pipelineOverride']} override</td><td>{row['manifestHit']}/{row['templates']} hit</td></tr>"


def template_row(row: dict[str, Any]) -> str:
    tasks = ", ".join(row["tasks"][:5]) or "(no direct task)"
    pipelines = ", ".join(row["pipelines"][:4])
    return f"<tr><td><code>{html.escape(row['template'])}</code></td><td>{row['refCount']}</td><td>{html.escape(tasks)}</td><td><code>{html.escape(pipelines)}</code></td></tr>"


def template_priority(row: dict[str, Any]) -> int:
    priority = row["refCount"] * 10 + len(row["tasks"]) * 4 + len(row["pipelines"]) * 2
    if row["domain"] in {"zonghe", "duiwu", "qiandao", "beibao"}:
        priority += 40
    if any(key in row["template"] for key in ("jiemian", "panduan", "zhujiemian")):
        priority += 25
    return priority


def mapping_variants(meta: dict[str, Any]) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    if isinstance(meta, dict) and any(key in meta for key in ("replacementPath", "sourceRoi", "sourceFrameWidth", "sourceFrameHeight")):
        variants.append(meta)
    for item in meta.get("variants") or []:
        if isinstance(item, dict):
            variants.append(item)
    return variants


def load_pipeline_override_nodes(project_root: Path) -> dict[str, Any]:
    override_root = project_root / "assets/resource/ShiKong/pipeline"
    nodes: dict[str, Any] = {}
    if not override_root.is_dir():
        return nodes
    for path in sorted(override_root.rglob("*.json")):
        try:
            data = read_json(path)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        for name, node in data.items():
            nodes[str(name)] = node
    return nodes


def build_pipeline_override_coverage(
    refs: list[probe.TemplateRef], override_nodes: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    refs_by_template: dict[str, list[probe.TemplateRef]] = defaultdict(list)
    for ref in refs:
        refs_by_template[ref.template].append(ref)

    coverage: dict[str, dict[str, Any]] = {}
    for template, template_refs in refs_by_template.items():
        covered_refs = []
        for ref in template_refs:
            override_node = override_nodes.get(ref.node)
            if override_node is None:
                continue
            override_templates = set(template_values_in_node(override_node))
            if template not in override_templates:
                covered_refs.append(ref)
        if covered_refs and len(covered_refs) == len(template_refs):
            coverage[template] = {
                "covered": True,
                "nodes": sorted({ref.node for ref in covered_refs}),
                "pipelines": sorted({ref.pipeline for ref in covered_refs}),
            }
    return coverage


def template_values_in_node(value: Any) -> list[str]:
    templates: list[str] = []
    if isinstance(value, dict):
        templates.extend(template_values(value.get("template")))
        for child in value.values():
            templates.extend(template_values_in_node(child))
    elif isinstance(value, list):
        for child in value:
            templates.extend(template_values_in_node(child))
    return templates


def template_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.replace("\\", "/")]
    if isinstance(value, list):
        return [item.replace("\\", "/") for item in value if isinstance(item, str)]
    return []


def latest_file(root: Path, pattern: str) -> Path | None:
    matches = [path for path in root.glob(pattern) if path.is_file()]
    if not matches:
        return None
    return max(matches, key=lambda path: path.stat().st_mtime)


def resolve_optional(project_root: Path, value: Path | None, default: Path | None) -> Path | None:
    path = value or default
    if path is None:
        return None
    return resolve(project_root, path)


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_text_fallbacks(project_root: Path) -> set[str]:
    path = project_root / "assets/resource/ShiKong/template_text_fallbacks.json"
    if not path.is_file():
        return set()
    data = read_json(path)
    templates = data.get("templates") if isinstance(data, dict) else {}
    if not isinstance(templates, dict):
        return set()
    return {str(template) for template in templates}


def relative_or_absolute(root: Path, path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)


def safe_name(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in value)
    return cleaned.strip("_") or DEFAULT_STATUS_NAME


if __name__ == "__main__":
    raise SystemExit(main())
