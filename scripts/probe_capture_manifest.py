#!/usr/bin/env python3
"""Probe every screenshot listed in a capture playbook manifest.

The output is a read-only aggregate report. It keeps one full probe JSON and
optional hit-preview image per capture, then writes a compact HTML/JSON summary
that shows which screenshots cover which Maa template references.
"""

from __future__ import annotations

import argparse
import html
import json
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

import probe_pipeline_templates as probe


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--maa-root", type=Path, default=None)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="capture-manifest.json to probe; defaults to the newest playbook manifest under captures/",
    )
    parser.add_argument(
        "--coordinate-mode",
        choices=["cropCenter4x3", "stretch1280x720"],
        default="cropCenter4x3",
    )
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--preview-limit", type=int, default=80)
    parser.add_argument("--variant-min-score", type=float, default=0.94)
    parser.add_argument("--report-name", default=None)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    maa_root = (args.maa_root or project_root.parent / "Maa_MHXY_MG").resolve()
    manifest_path = resolve(project_root, args.manifest) if args.manifest else latest_manifest(project_root)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    refs = probe.collect_template_refs(maa_root)
    mapping = probe.load_mapping(project_root)

    report_dir = project_root / "assets/resource/ShiKong/reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_name(args.report_name or f"manifest-probe-{time.time_ns()}")

    captures: list[dict[str, Any]] = []
    all_items: list[dict[str, Any]] = []
    for capture in manifest.get("captures") or []:
        if not isinstance(capture, dict) or capture.get("status") != "ok" or not capture.get("path"):
            continue
        image_path = resolve(project_root, Path(capture["path"]))
        if not image_path.is_file():
            captures.append(
                {
                    "name": capture.get("name") or image_path.stem,
                    "image": relative_or_absolute(project_root, image_path),
                    "status": "missing-image",
                    "detail": str(image_path),
                }
            )
            continue
        capture_report = probe_capture(
            project_root,
            maa_root,
            mapping,
            refs,
            image_path,
            capture.get("name") or image_path.stem,
            args.coordinate_mode,
        )
        capture_stem = f"{stem}-{safe_name(capture_report['name'])}"
        capture_report_path = report_dir / f"{capture_stem}.json"
        capture_report_path.write_text(
            json.dumps(capture_report["fullReport"], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        preview_paths: list[Path] = []
        if args.preview:
            preview_paths = probe.write_preview(
                image_path,
                capture_report["fullReport"]["items"],
                capture_report_path,
                args.preview_limit,
            )
        summary = dict(capture_report["summary"])
        summary["report"] = relative_or_absolute(project_root, capture_report_path)
        summary["preview"] = [relative_or_absolute(project_root, path) for path in preview_paths]
        captures.append(summary)
        for item in capture_report["fullReport"]["items"]:
            enriched = dict(item)
            enriched["captureName"] = capture_report["name"]
            enriched["captureImage"] = summary["image"]
            enriched["captureReport"] = summary["report"]
            all_items.append(enriched)

    aggregate = build_aggregate(
        project_root,
        manifest_path,
        manifest,
        captures,
        all_items,
        args.coordinate_mode,
        args.variant_min_score,
    )
    json_path = report_dir / f"{stem}.json"
    html_path = report_dir / f"{stem}.html"
    json_path.write_text(json.dumps(aggregate, ensure_ascii=False, indent=2), encoding="utf-8")
    html_path.write_text(build_html(aggregate), encoding="utf-8")

    print(
        json.dumps(
            {
                "json": str(json_path),
                "html": str(html_path),
                "captures": len(captures),
                "totalRefsPerCapture": len(refs),
                "uniqueMatchedTemplates": aggregate["uniqueMatchedTemplates"],
                "mappedMatchedTemplates": aggregate["mappedMatchedTemplates"],
                "variantCandidates": len(aggregate["variantCandidates"]),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def probe_capture(
    project_root: Path,
    maa_root: Path,
    mapping: dict[str, Any],
    refs: list[probe.TemplateRef],
    image_path: Path,
    name: str,
    coordinate_mode: str,
) -> dict[str, Any]:
    screenshot = cv2.cvtColor(np.array(Image.open(image_path).convert("RGB")), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(screenshot, cv2.COLOR_BGR2GRAY)
    image_height, image_width = gray.shape[:2]
    items = [
        probe.probe_one(
            project_root,
            maa_root,
            mapping,
            ref,
            gray,
            image_width,
            image_height,
            coordinate_mode,
        )
        for ref in refs
    ]
    matched = [item for item in items if item["hit"]]
    mapped = [item for item in items if item["source"] == "ShiKong"]
    mapped_hit = [item for item in mapped if item["hit"]]
    full_report = {
        "version": 1,
        "generatedAt": int(time.time()),
        "name": name,
        "image": relative_or_absolute(project_root, image_path),
        "imageSize": [image_width, image_height],
        "coordinateMode": coordinate_mode,
        "totalRefs": len(items),
        "matchedRefs": len(matched),
        "mappedRefs": len(mapped),
        "mappedMatchedRefs": len(mapped_hit),
        "uniqueMatchedTemplates": len({item["template"] for item in matched}),
        "items": items,
    }
    return {
        "name": name,
        "fullReport": full_report,
        "summary": {
            "name": name,
            "image": full_report["image"],
            "imageSize": full_report["imageSize"],
            "status": "ok",
            "totalRefs": len(items),
            "matchedRefs": len(matched),
            "mappedRefs": len(mapped),
            "mappedMatchedRefs": len(mapped_hit),
            "uniqueMatchedTemplates": full_report["uniqueMatchedTemplates"],
            "uniqueMappedMatchedTemplates": len({item["template"] for item in mapped_hit}),
        },
    }


def build_aggregate(
    project_root: Path,
    manifest_path: Path,
    manifest: dict[str, Any],
    captures: list[dict[str, Any]],
    items: list[dict[str, Any]],
    coordinate_mode: str,
    variant_min_score: float,
) -> dict[str, Any]:
    matched = [item for item in items if item.get("hit")]
    mapped_hit = [item for item in matched if item.get("source") == "ShiKong"]
    templates: dict[str, dict[str, Any]] = {}
    for item in items:
        template = item.get("template") or ""
        if not template:
            continue
        record = templates.setdefault(
            template,
            {
                "template": template,
                "domain": template.split("/", 1)[0],
                "bestScore": 0.0,
                "hitCaptures": [],
                "mappedHitCaptures": [],
                "best": None,
            },
        )
        score = float(item.get("score") or 0.0)
        if score > record["bestScore"]:
            record["bestScore"] = round(score, 5)
            record["best"] = compact_item(item)
        if item.get("hit"):
            capture_name = item.get("captureName")
            if capture_name and capture_name not in record["hitCaptures"]:
                record["hitCaptures"].append(capture_name)
            if item.get("source") == "ShiKong" and capture_name not in record["mappedHitCaptures"]:
                record["mappedHitCaptures"].append(capture_name)

    template_rows = sorted(
        templates.values(),
        key=lambda row: (
            not row["hitCaptures"],
            not row["mappedHitCaptures"],
            -float(row["bestScore"]),
            row["template"],
        ),
    )
    variant_candidates = select_variant_candidates(mapped_hit, variant_min_score)
    return {
        "version": 1,
        "generatedAt": int(time.time()),
        "manifest": relative_or_absolute(project_root, manifest_path),
        "playbook": manifest.get("playbook"),
        "window": manifest.get("window"),
        "coordinateMode": coordinate_mode,
        "variantMinScore": variant_min_score,
        "captures": captures,
        "captureCount": len(captures),
        "totalProbeItems": len(items),
        "matchedRefs": len(matched),
        "mappedMatchedRefs": len(mapped_hit),
        "uniqueMatchedTemplates": len({item["template"] for item in matched}),
        "mappedMatchedTemplates": len({item["template"] for item in mapped_hit}),
        "templateRows": template_rows,
        "variantCandidates": variant_candidates,
    }


def select_variant_candidates(items: list[dict[str, Any]], min_score: float) -> list[dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    for item in items:
        if float(item.get("score") or 0.0) < min_score or not item.get("bestRoi"):
            continue
        template = item["template"]
        current = best.get(template)
        if current is None or float(item.get("score") or 0.0) > float(current.get("score") or 0.0):
            best[template] = compact_item(item)
    return sorted(best.values(), key=lambda item: (-float(item.get("score") or 0.0), item["template"]))


def compact_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "captureName": item.get("captureName"),
        "captureImage": item.get("captureImage"),
        "captureReport": item.get("captureReport"),
        "pipeline": item.get("pipeline"),
        "node": item.get("node"),
        "template": item.get("template"),
        "source": item.get("source"),
        "variantName": item.get("variantName"),
        "score": item.get("score"),
        "hit": item.get("hit"),
        "bestRoi": item.get("bestRoi"),
        "threshold": item.get("threshold"),
        "detail": item.get("detail"),
    }


def build_html(report: dict[str, Any]) -> str:
    capture_rows = "\n".join(capture_row(capture) for capture in report["captures"])
    template_rows = "\n".join(template_row(row) for row in report["templateRows"][:160])
    variant_rows = "\n".join(variant_row(row) for row in report["variantCandidates"][:80])
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ShiKong Manifest Probe</title>
  <style>
    :root {{ color-scheme: dark; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: #111315; color: #ece7dc; }}
    body {{ margin: 0; background: #111315; }}
    header {{ padding: 18px 22px; background: #171a1d; border-bottom: 1px solid #2d3338; position: sticky; top: 0; z-index: 2; }}
    h1 {{ margin: 0 0 8px; font-size: 22px; letter-spacing: 0; }}
    h2 {{ margin: 22px 0 10px; font-size: 16px; color: #f4ead8; }}
    .meta {{ color: #aeb8bf; font-size: 13px; line-height: 1.55; }}
    main {{ padding: 0 22px 36px; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
    th, td {{ border-bottom: 1px solid #2b3034; padding: 7px 8px; text-align: left; vertical-align: top; }}
    th {{ position: sticky; top: 74px; background: #1c2024; color: #d8e1e8; z-index: 1; }}
    td {{ color: #d8d0c4; word-break: break-all; }}
    code {{ color: #d8e1e8; }}
    .ok {{ color: #72d390; }}
    .warn {{ color: #d7b86c; }}
    .miss {{ color: #89949c; }}
  </style>
</head>
<body>
  <header>
    <h1>梦幻西游：时空 Manifest Probe</h1>
    <div class="meta">
      manifest {html.escape(report["manifest"])} · captures {report["captureCount"]} ·
      matchedRefs {report["matchedRefs"]}/{report["totalProbeItems"]} ·
      uniqueMatchedTemplates {report["uniqueMatchedTemplates"]} ·
      mappedMatchedTemplates {report["mappedMatchedTemplates"]} ·
      variantCandidates {len(report["variantCandidates"])}
    </div>
  </header>
  <main>
    <h2>Captures</h2>
    <table><thead><tr><th>name</th><th>image</th><th>refs</th><th>unique templates</th><th>report / preview</th></tr></thead><tbody>{capture_rows}</tbody></table>
    <h2>Variant Candidates</h2>
    <table><thead><tr><th>template</th><th>score</th><th>capture</th><th>roi</th><th>report</th></tr></thead><tbody>{variant_rows}</tbody></table>
    <h2>Templates</h2>
    <table><thead><tr><th>template</th><th>best</th><th>hit captures</th><th>mapped hit captures</th><th>best item</th></tr></thead><tbody>{template_rows}</tbody></table>
  </main>
</body>
</html>
"""


def capture_row(capture: dict[str, Any]) -> str:
    preview = " | ".join(capture.get("preview") or [])
    return f"""
    <tr>
      <td><code>{html.escape(str(capture.get("name") or ""))}</code></td>
      <td>{html.escape(str(capture.get("image") or ""))}</td>
      <td>{capture.get("mappedMatchedRefs", 0)}/{capture.get("totalRefs", 0)} mapped · {capture.get("matchedRefs", 0)} hit</td>
      <td>{capture.get("uniqueMappedMatchedTemplates", 0)} mapped · {capture.get("uniqueMatchedTemplates", 0)} hit</td>
      <td><code>{html.escape(str(capture.get("report") or ""))}</code><br />{html.escape(preview)}</td>
    </tr>
    """


def variant_row(item: dict[str, Any]) -> str:
    return f"""
    <tr>
      <td><code>{html.escape(str(item.get("template") or ""))}</code></td>
      <td class="ok">{item.get("score")}</td>
      <td>{html.escape(str(item.get("captureName") or ""))}</td>
      <td><code>{html.escape(json.dumps(item.get("bestRoi"), ensure_ascii=False))}</code></td>
      <td><code>{html.escape(str(item.get("captureReport") or ""))}</code></td>
    </tr>
    """


def template_row(row: dict[str, Any]) -> str:
    best = row.get("best") or {}
    cls = "ok" if row.get("mappedHitCaptures") else "warn" if row.get("hitCaptures") else "miss"
    return f"""
    <tr>
      <td><code>{html.escape(str(row.get("template") or ""))}</code></td>
      <td class="{cls}">{row.get("bestScore")}</td>
      <td>{html.escape(", ".join(row.get("hitCaptures") or []))}</td>
      <td>{html.escape(", ".join(row.get("mappedHitCaptures") or []))}</td>
      <td>{html.escape(str(best.get("source") or ""))} · {html.escape(str(best.get("node") or ""))} · <code>{html.escape(json.dumps(best.get("bestRoi"), ensure_ascii=False))}</code></td>
    </tr>
    """


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def latest_manifest(project_root: Path) -> Path:
    root = project_root / "assets/resource/ShiKong/captures"
    candidates = sorted(
        root.glob("playbook-*/capture-manifest.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise SystemExit(f"no playbook capture manifests found under {root}")
    for candidate in candidates:
        if manifest_has_ok_capture(candidate):
            return candidate
    raise SystemExit(f"no playbook capture manifests with ok captures found under {root}")


def manifest_has_ok_capture(path: Path) -> bool:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    for capture in manifest.get("captures") or []:
        if (
            isinstance(capture, dict)
            and capture.get("status") == "ok"
            and capture.get("path")
        ):
            return True
    return False


def relative_or_absolute(root: Path, path: Path) -> str:
    try:
        return probe.slash_path(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path)


def safe_name(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in value)
    return cleaned.strip("_") or "manifest-probe"


if __name__ == "__main__":
    raise SystemExit(main())
