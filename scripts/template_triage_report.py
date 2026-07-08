#!/usr/bin/env python3
"""Generate a visual triage report for unmapped Maa templates.

This script is intentionally read-mostly: it never writes replacement images or
updates template_mapping.json. It only writes an HTML/JSON report under
assets/resource/ShiKong/reports so the migration can be reviewed before any
template crop is applied.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import math
import time
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image


BASELINE_WIDTH = 1280
BASELINE_HEIGHT = 720
VISIBLE_4X3_LEFT = 160
VISIBLE_4X3_WIDTH = 960
DEFAULT_SCALES = [0.65, 0.75, 0.85, 0.95, 1.0, 1.1, 1.2, 1.35, 1.5]
DEFAULT_SCREENSHOTS = [
    Path("assets/resource/ShiKong/captures/script-home-2.png"),
    Path("assets/resource/ShiKong/captures/reference-image-1-client.png"),
]


@dataclass
class TemplateUse:
    pipeline: str
    node: str
    template: str
    roi: list[int] | None
    threshold: float


@dataclass
class Candidate:
    image: str
    score: float
    roi: list[int]
    scale: float
    search_mode: str
    search_roi: list[int] | None
    crop_data_uri: str | None = None


@dataclass
class TemplateGroup:
    template: str
    uses: list[TemplateUse] = field(default_factory=list)
    mapped: bool = False
    replacement_path: str | None = None
    source_space: str | None = None
    variant_count: int = 0
    old_image_path: str | None = None
    old_image_data_uri: str | None = None
    candidates: list[Candidate] = field(default_factory=list)

    @property
    def domain(self) -> str:
        return self.template.replace("\\", "/").split("/", 1)[0]

    @property
    def priority(self) -> int:
        pipelines = {use.pipeline for use in self.uses}
        nodes = {use.node for use in self.uses}
        score = len(self.uses) * 10 + len(pipelines) * 2 + min(len(nodes), 20)
        if self.domain in {"zonghe", "duiwu", "qiandao", "beibao"}:
            score += 40
        if any(key in self.template for key in ("jiemian", "panduan", "zhujiemian")):
            score += 25
        if self.candidates:
            score += int(self.candidates[0].score * 20)
        return score


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--maa-root", type=Path, default=None)
    parser.add_argument("--screenshot", action="append", type=Path, default=[])
    parser.add_argument("--coordinate-mode", choices=["cropCenter4x3", "stretch1280x720"], default="cropCenter4x3")
    parser.add_argument(
        "--search-mode",
        choices=["roi", "global", "both"],
        default="roi",
        help="candidate search area; roi is faster and has fewer false positives",
    )
    parser.add_argument("--candidate-min-score", type=float, default=0.60)
    parser.add_argument("--candidate-limit", type=int, default=2)
    parser.add_argument("--top", type=int, default=160)
    parser.add_argument("--include-mapped", action="store_true")
    parser.add_argument("--domain", action="append", default=[])
    parser.add_argument("--report-name", default=None)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    maa_root = (args.maa_root or project_root.parent / "Maa_MHXY_MG").resolve()
    screenshots = resolve_screenshots(project_root, args.screenshot)
    mapping = load_mapping(project_root)
    uses = collect_template_uses(maa_root)
    tasks_by_pipeline = collect_tasks_by_pipeline(maa_root)
    groups = build_groups(project_root, maa_root, mapping, uses)

    if args.domain:
        domains = set(args.domain)
        groups = [group for group in groups if group.domain in domains]
    if not args.include_mapped:
        groups = [group for group in groups if not group.mapped]

    screenshot_cache = load_screenshots(screenshots)
    for group in groups:
        group.candidates = find_candidates(
            group,
            screenshot_cache,
            args.coordinate_mode,
            args.search_mode,
            args.candidate_min_score,
            args.candidate_limit,
        )

    groups.sort(key=lambda item: (item.mapped, -item.priority, item.template))
    selected = groups[: max(1, args.top)]
    report_dir = project_root / "assets/resource/ShiKong/reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stem = sanitize_file_part(args.report_name or f"template-triage-{time.time_ns()}")
    json_path = report_dir / f"{stem}.json"
    html_path = report_dir / f"{stem}.html"

    report = build_json_report(project_root, maa_root, screenshots, selected, tasks_by_pipeline, len(groups), args)
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    html_path.write_text(build_html(report), encoding="utf-8")

    print(
        json.dumps(
            {
                "json": str(json_path),
                "html": str(html_path),
                "screenshots": [str(path) for path in screenshots],
                "reportedTemplates": len(selected),
                "totalFilteredTemplates": len(groups),
                "withCandidates": sum(1 for group in selected if group.candidates),
                "mappedIncluded": bool(args.include_mapped),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def resolve_screenshots(project_root: Path, requested: list[Path]) -> list[Path]:
    candidates = requested or DEFAULT_SCREENSHOTS
    result: list[Path] = []
    seen: set[Path] = set()
    for item in candidates:
        path = item if item.is_absolute() else project_root / item
        path = path.resolve()
        if path.is_file() and path not in seen:
            result.append(path)
            seen.add(path)
    return result


def load_mapping(project_root: Path) -> dict[str, Any]:
    path = project_root / "assets/resource/ShiKong/template_mapping.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("templates", {})


def collect_template_uses(maa_root: Path) -> list[TemplateUse]:
    uses: list[TemplateUse] = []
    pipeline_root = maa_root / "assets/resource/base/pipeline"
    for path in sorted(pipeline_root.rglob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        pipeline = slash_path(path.relative_to(maa_root))
        if isinstance(data, dict):
            for node, value in data.items():
                collect_uses_from_value(value, pipeline, node, None, 0.82, uses)
    return uses


def collect_uses_from_value(
    value: Any,
    pipeline: str,
    node: str,
    inherited_roi: list[int] | None,
    inherited_threshold: float,
    uses: list[TemplateUse],
) -> None:
    if isinstance(value, dict):
        roi = parse_roi(value.get("roi")) or inherited_roi
        thresholds = threshold_values(value.get("threshold"), inherited_threshold)
        templates = template_values(value.get("template"))
        for index, template in enumerate(templates):
            uses.append(TemplateUse(pipeline, node, template, roi, thresholds[min(index, len(thresholds) - 1)]))
        for child in value.values():
            collect_uses_from_value(child, pipeline, node, roi, thresholds[-1], uses)
    elif isinstance(value, list):
        for child in value:
            collect_uses_from_value(child, pipeline, node, inherited_roi, inherited_threshold, uses)


def collect_tasks_by_pipeline(maa_root: Path) -> dict[str, list[str]]:
    interface_path = maa_root / "assets/interface.json"
    if not interface_path.exists():
        return {}
    interface = json.loads(interface_path.read_text(encoding="utf-8"))
    node_to_pipeline: dict[str, str] = {}
    pipeline_root = maa_root / "assets/resource/base/pipeline"
    for path in sorted(pipeline_root.rglob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        pipeline = slash_path(path.relative_to(maa_root))
        if isinstance(data, dict):
            for node in data:
                node_to_pipeline.setdefault(node, pipeline)
    tasks_by_pipeline: dict[str, list[str]] = {}
    for task in interface.get("task") or []:
        if not isinstance(task, dict):
            continue
        entry = task.get("entry")
        name = task.get("name") or entry
        pipeline = node_to_pipeline.get(entry)
        if pipeline:
            tasks_by_pipeline.setdefault(pipeline, []).append(str(name))
    return tasks_by_pipeline


def build_groups(
    project_root: Path,
    maa_root: Path,
    mapping: dict[str, Any],
    uses: list[TemplateUse],
) -> list[TemplateGroup]:
    groups: dict[str, TemplateGroup] = {}
    for use in uses:
        group = groups.setdefault(use.template, TemplateGroup(template=use.template))
        group.uses.append(use)
    for template, group in groups.items():
        old_path = maa_root / "assets/resource/base/image" / template
        if old_path.is_file():
            group.old_image_path = str(old_path)
            group.old_image_data_uri = image_data_uri(old_path, max_size=(160, 120))
        meta = mapping.get(template) or {}
        variants = mapping_variants(meta)
        existing = [item for item in variants if resolve_path(project_root, item.get("replacementPath")).is_file()]
        group.mapped = bool(existing)
        group.variant_count = max(0, len(existing) - 1)
        if existing:
            group.replacement_path = existing[0].get("replacementPath")
            group.source_space = existing[0].get("sourceSpace")
    return list(groups.values())


def load_screenshots(paths: list[Path]) -> list[dict[str, Any]]:
    loaded: list[dict[str, Any]] = []
    for path in paths:
        try:
            pil = Image.open(path).convert("RGB")
            rgb = np.array(pil)
            gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        except Exception:
            continue
        loaded.append({"path": path, "pil": pil, "gray": gray, "width": pil.width, "height": pil.height})
    return loaded


def find_candidates(
    group: TemplateGroup,
    screenshots: list[dict[str, Any]],
    coordinate_mode: str,
    search_mode: str,
    min_score: float,
    limit: int,
) -> list[Candidate]:
    if not group.old_image_path:
        return []
    try:
        old = Image.open(group.old_image_path).convert("L")
    except Exception:
        return []
    if old.width < 6 or old.height < 6:
        return []
    old_np = np.array(old)
    if np.std(old_np) < 2:
        return []

    candidates: list[Candidate] = []
    for screenshot in screenshots:
        best = match_template_in_screenshot(group, old_np, screenshot, coordinate_mode, search_mode)
        if best and best.score >= min_score:
            best.crop_data_uri = screenshot_crop_data_uri(screenshot["pil"], best.roi)
            candidates.append(best)
    candidates.sort(key=lambda item: -item.score)
    return candidates[: max(1, limit)]


def match_template_in_screenshot(
    group: TemplateGroup,
    old_np: np.ndarray,
    screenshot: dict[str, Any],
    coordinate_mode: str,
    search_mode: str,
) -> Candidate | None:
    image_width = int(screenshot["width"])
    image_height = int(screenshot["height"])
    gray = screenshot["gray"]
    best: Candidate | None = None
    windows = search_windows(group.uses, image_width, image_height, coordinate_mode, search_mode)
    for scale in DEFAULT_SCALES:
        width = max(4, int(round(old_np.shape[1] * scale)))
        height = max(4, int(round(old_np.shape[0] * scale)))
        if width >= image_width or height >= image_height:
            continue
        scaled = cv2.resize(old_np, (width, height), interpolation=cv2.INTER_AREA)
        if np.std(scaled) < 2:
            continue
        for mode, search_roi in windows:
            x, y, roi_width, roi_height = search_roi or [0, 0, image_width, image_height]
            if roi_width < width or roi_height < height:
                continue
            search = gray[y : y + roi_height, x : x + roi_width]
            result = cv2.matchTemplate(search, scaled, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(result)
            if not math.isfinite(max_val):
                continue
            roi = [int(x + max_loc[0]), int(y + max_loc[1]), int(width), int(height)]
            candidate = Candidate(
                image=str(screenshot["path"]),
                score=round(float(max_val), 5),
                roi=roi,
                scale=scale,
                search_mode=mode,
                search_roi=search_roi,
            )
            if best is None or candidate.score > best.score:
                best = candidate
    return best


def search_windows(
    uses: list[TemplateUse],
    image_width: int,
    image_height: int,
    coordinate_mode: str,
    search_mode: str,
) -> list[tuple[str, list[int] | None]]:
    windows: list[tuple[str, list[int] | None]] = []
    seen: set[tuple[int, int, int, int]] = set()
    if search_mode in {"roi", "both"}:
        for use in uses:
            mapped = map_roi(use.roi, image_width, image_height, coordinate_mode)
            if mapped is None:
                continue
            padded = pad_and_clamp_roi(mapped, image_width, image_height)
            key = tuple(padded)
            if key not in seen:
                windows.append(("roi", padded))
                seen.add(key)
    if search_mode in {"global", "both"} or not windows:
        windows.append(("global", None))
    return windows


def build_json_report(
    project_root: Path,
    maa_root: Path,
    screenshots: list[Path],
    groups: list[TemplateGroup],
    tasks_by_pipeline: dict[str, list[str]],
    total_filtered: int,
    args: argparse.Namespace,
) -> dict[str, Any]:
    return {
        "version": 1,
        "generatedAt": int(time.time()),
        "projectRoot": str(project_root),
        "maaRoot": str(maa_root),
        "screenshots": [relative_or_absolute(project_root, path) for path in screenshots],
        "coordinateMode": args.coordinate_mode,
        "searchMode": args.search_mode,
        "candidateMinScore": args.candidate_min_score,
        "includeMapped": bool(args.include_mapped),
        "totalFilteredTemplates": total_filtered,
        "reportedTemplates": len(groups),
        "withCandidates": sum(1 for group in groups if group.candidates),
        "rows": [group_to_json(group, project_root, tasks_by_pipeline) for group in groups],
    }


def group_to_json(
    group: TemplateGroup,
    project_root: Path,
    tasks_by_pipeline: dict[str, list[str]],
) -> dict[str, Any]:
    pipelines = sorted({use.pipeline for use in group.uses})
    nodes = sorted({use.node for use in group.uses})
    rois = sorted({tuple(use.roi) for use in group.uses if use.roi})
    tasks = sorted({task for pipeline in pipelines for task in tasks_by_pipeline.get(pipeline, [])})
    thresholds = sorted({use.threshold for use in group.uses})
    return {
        "template": group.template,
        "domain": group.domain,
        "mapped": group.mapped,
        "replacementPath": group.replacement_path,
        "sourceSpace": group.source_space,
        "variantCount": group.variant_count,
        "totalRefs": len(group.uses),
        "priority": group.priority,
        "captureHint": capture_hint(group.domain, group.template, pipelines, nodes, tasks),
        "oldImagePath": group.old_image_path,
        "oldImage": group.old_image_data_uri,
        "pipelines": pipelines,
        "tasks": tasks,
        "nodes": nodes[:20],
        "rois": [list(roi) for roi in rois[:10]],
        "thresholds": thresholds,
        "candidates": [
            {
                "image": relative_or_absolute(project_root, Path(item.image)),
                "score": item.score,
                "roi": item.roi,
                "scale": item.scale,
                "searchMode": item.search_mode,
                "searchRoi": item.search_roi,
                "cropImage": item.crop_data_uri,
            }
            for item in group.candidates
        ],
    }


def build_html(report: dict[str, Any]) -> str:
    rows = report["rows"]
    row_html = "\n".join(build_row(row) for row in rows)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ShiKong Template Triage</title>
  <style>
    :root {{ color-scheme: dark; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: #111315; color: #ece7dc; }}
    body {{ margin: 0; background: #111315; }}
    header {{ position: sticky; top: 0; z-index: 2; padding: 18px 22px; background: #171a1d; border-bottom: 1px solid #2d3338; }}
    h1 {{ margin: 0 0 8px; font-size: 22px; letter-spacing: 0; }}
    .meta {{ color: #aeb8bf; font-size: 13px; line-height: 1.55; }}
    main {{ padding: 18px 22px 36px; }}
    .row {{ display: grid; grid-template-columns: 178px 188px minmax(0, 1fr); gap: 14px; padding: 14px 0; border-bottom: 1px solid #2b3034; }}
    .thumb {{ min-height: 116px; display: grid; place-items: center; border: 1px solid #30363b; border-radius: 6px; background: #15191c; overflow: hidden; }}
    .thumb img {{ max-width: 160px; max-height: 120px; image-rendering: auto; }}
    .candidate img {{ max-width: 170px; max-height: 120px; }}
    .noimg {{ color: #6f7b84; font-size: 12px; }}
    h2 {{ margin: 0 0 8px; font-size: 15px; letter-spacing: 0; color: #f4ead8; }}
    .badges {{ display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 8px; }}
    .badge {{ border: 1px solid #3a4249; border-radius: 999px; padding: 2px 8px; color: #c8d1d7; font-size: 12px; }}
    .badge.hot {{ color: #17130b; background: #d9a441; border-color: #d9a441; }}
    .badge.ok {{ color: #062315; background: #72d390; border-color: #72d390; }}
    .hint {{ color: #d7b86c; font-size: 13px; margin-bottom: 8px; }}
    .grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; color: #b8c1c7; font-size: 12px; }}
    .label {{ color: #7f8a92; }}
    code {{ color: #d8e1e8; word-break: break-all; }}
    details {{ margin-top: 8px; }}
    summary {{ cursor: pointer; color: #8fd2ff; }}
    ul {{ margin: 6px 0 0; padding-left: 18px; }}
  </style>
</head>
<body>
  <header>
    <h1>梦幻西游：时空 图片迁移审计</h1>
    <div class="meta">
      templates {report["reportedTemplates"]}/{report["totalFilteredTemplates"]} ·
      candidates {report["withCandidates"]} ·
      coordinate {html.escape(report["coordinateMode"])} ·
      search {html.escape(report["searchMode"])} ·
      minScore {report["candidateMinScore"]} ·
      screenshots {html.escape(" | ".join(report["screenshots"]))}
    </div>
  </header>
  <main>{row_html}</main>
</body>
</html>
"""


def build_row(row: dict[str, Any]) -> str:
    old = f'<img src="{row["oldImage"]}" alt="old template" />' if row.get("oldImage") else '<span class="noimg">missing old image</span>'
    candidate = row["candidates"][0] if row["candidates"] else None
    candidate_html = (
        f'<img src="{candidate["cropImage"]}" alt="candidate crop" />'
        f'<div class="meta">score {candidate["score"]} · {html.escape(candidate["searchMode"])} · roi {candidate["roi"]}</div>'
        f'<div class="meta">{html.escape(candidate["image"])}</div>'
        if candidate and candidate.get("cropImage")
        else '<span class="noimg">no candidate over threshold</span>'
    )
    badge_class = "ok" if row["mapped"] else "hot"
    mapped_text = "mapped" if row["mapped"] else "unmapped"
    pipeline_items = "".join(f"<li><code>{html.escape(item)}</code></li>" for item in row["pipelines"])
    node_items = "".join(f"<li>{html.escape(item)}</li>" for item in row["nodes"])
    return f"""
    <section class="row">
      <div>
        <div class="thumb">{old}</div>
        <div class="meta">old</div>
      </div>
      <div>
        <div class="thumb candidate">{candidate_html}</div>
        <div class="meta">best candidate</div>
      </div>
      <div>
        <h2><code>{html.escape(row["template"])}</code></h2>
        <div class="badges">
          <span class="badge {badge_class}">{mapped_text}</span>
          <span class="badge">{html.escape(row["domain"])}</span>
          <span class="badge">refs {row["totalRefs"]}</span>
          <span class="badge">priority {row["priority"]}</span>
          <span class="badge">variants {row["variantCount"]}</span>
        </div>
        <div class="hint">{html.escape(row["captureHint"])}</div>
        <div class="grid">
          <div><span class="label">tasks</span><br />{html.escape(" | ".join(row["tasks"][:6]) or "no direct task")}</div>
          <div><span class="label">thresholds</span><br />{html.escape(", ".join(str(item) for item in row["thresholds"]))}</div>
          <div><span class="label">rois</span><br /><code>{html.escape(json.dumps(row["rois"], ensure_ascii=False))}</code></div>
          <div><span class="label">replacement</span><br /><code>{html.escape(str(row.get("replacementPath") or "-"))}</code></div>
        </div>
        <details>
          <summary>pipelines / nodes</summary>
          <ul>{pipeline_items}</ul>
          <ul>{node_items}</ul>
        </details>
      </div>
    </section>
    """


def parse_roi(value: Any) -> list[int] | None:
    if isinstance(value, list) and len(value) >= 4:
        try:
            return [int(value[0]), int(value[1]), int(value[2]), int(value[3])]
        except Exception:
            return None
    return None


def threshold_values(value: Any, default: float) -> list[float]:
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, list):
        values = [float(item) for item in value if isinstance(item, (int, float))]
        return values or [default]
    return [default]


def template_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.replace("\\", "/")]
    if isinstance(value, list):
        return [item.replace("\\", "/") for item in value if isinstance(item, str)]
    return []


def mapping_variants(meta: dict[str, Any]) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    if isinstance(meta, dict) and any(key in meta for key in ("replacementPath", "sourceRoi", "sourceFrameWidth", "sourceFrameHeight")):
        variants.append(meta)
    for item in meta.get("variants") or []:
        if isinstance(item, dict):
            variants.append(item)
    return variants


def resolve_path(project_root: Path, value: Any) -> Path:
    if not isinstance(value, str) or not value.strip():
        return Path("__missing__")
    path = Path(value)
    return path if path.is_absolute() else project_root / path


def map_roi(roi: list[int] | None, image_width: int, image_height: int, coordinate_mode: str) -> list[int] | None:
    if roi is None:
        return None
    if coordinate_mode == "stretch1280x720":
        scale_x = image_width / BASELINE_WIDTH
        scale_y = image_height / BASELINE_HEIGHT
        return [
            int(round(max(0, roi[0]) * scale_x)),
            int(round(max(0, roi[1]) * scale_y)),
            max(1, int(round(max(1, roi[2]) * scale_x))),
            max(1, int(round(max(1, roi[3]) * scale_y))),
        ]
    scale_x = image_width / VISIBLE_4X3_WIDTH
    scale_y = image_height / BASELINE_HEIGHT
    left = (roi[0] - VISIBLE_4X3_LEFT) * scale_x
    right = (roi[0] + max(1, roi[2]) - VISIBLE_4X3_LEFT) * scale_x
    return [
        int(round(left)),
        int(round(max(0, roi[1]) * scale_y)),
        max(1, int(round(max(1.0, right - left)))),
        max(1, int(round(max(1, roi[3]) * scale_y))),
    ]


def pad_and_clamp_roi(roi: list[int], image_width: int, image_height: int) -> list[int]:
    padding = max(12, int(round(max(roi[2], roi[3]) * 0.55)))
    left = max(0, roi[0] - padding)
    top = max(0, roi[1] - padding)
    right = min(image_width, roi[0] + max(1, roi[2]) + padding)
    bottom = min(image_height, roi[1] + max(1, roi[3]) + padding)
    return [left, top, max(1, right - left), max(1, bottom - top)]


def screenshot_crop_data_uri(image: Image.Image, roi: list[int]) -> str | None:
    try:
        x, y, width, height = roi
        crop = image.crop((x, y, x + width, y + height))
        return image_to_data_uri(crop, max_size=(180, 130))
    except Exception:
        return None


def image_data_uri(path: Path, max_size: tuple[int, int]) -> str | None:
    try:
        return image_to_data_uri(Image.open(path).convert("RGB"), max_size=max_size)
    except Exception:
        return None


def image_to_data_uri(image: Image.Image, max_size: tuple[int, int]) -> str:
    item = image.copy()
    item.thumbnail(max_size, Image.Resampling.LANCZOS)
    buffer = BytesIO()
    item.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def capture_hint(domain: str, template: str, pipelines: list[str], nodes: list[str], tasks: list[str]) -> str:
    text = " ".join([domain, template, *pipelines, *nodes, *tasks]).lower()
    if domain == "zonghe":
        if "huodong" in template:
            return "采集建议：主界面顶部活动按钮及活动面板展开态。"
        if "baoguo" in template:
            return "采集建议：主界面右下背包按钮，以及背包面板打开态。"
        if "xiaoditu" in template:
            return "采集建议：主界面左上小地图、地图面板和自动寻路状态。"
        return "采集建议：主界面通用按钮、弹窗关闭按钮、任务追踪/自动寻路状态。"
    hints = {
        "duiwu": "采集建议：队伍/创建队伍/申请入队/队伍目标设置面板。",
        "qiandao": "采集建议：福利、签到、回归、节日活动领奖面板。",
        "beibao": "采集建议：背包、整理、出售、商会和物品弹窗。",
        "shangcheng": "采集建议：商城、摆摊、商会出售界面。",
        "r5": "采集建议：好友、组队、五开队员邀请相关界面。",
        "jiayuan": "采集建议：家园、庭院、打理、布置、护院界面。",
        "jineng": "采集建议：技能、升级、加点、宠物/角色技能面板。",
        "zhandou": "采集建议：战斗中按钮、技能选择、自动战斗状态。",
        "wujian": "采集建议：帮派/万卷书相关答题和活动面板。",
        "wanjian": "采集建议：帮派万卷答题题目、选项和提交状态。",
        "richangdati": "采集建议：日常答题题目、选项、聊天答题窗口。",
        "mijing": "采集建议：秘境入口、材料、副本选择和战斗过程界面。",
        "mijing_cailiao": "采集建议：秘境材料背包、提交材料、奖励面板。",
        "fuben": "采集建议：副本创建、确认、选择、进入和结算界面。",
        "qifu": "采集建议：祈福、宠物祈福、领奖界面。",
        "zhuagui": "采集建议：抓鬼任务链、NPC 对话、任务追踪和战斗后状态。",
        "baotu": "采集建议：宝图任务、藏宝图使用、挖图结果界面。",
        "yunbiao": "采集建议：运镖任务、镖局对话、活动值判断界面。",
        "zhanghao": "采集建议：登录、选区、角色选择、服务器状态点。",
        "dati": "采集建议：聊天答题窗口、输入框、发送按钮。",
        "wuxing": "采集建议：五行修业入口、任务面板和 NPC 对话。",
        "shimen": "采集建议：师门任务、任务追踪和 NPC 对话。",
    }
    if "battle" in text or "zhandou" in text:
        return hints["zhandou"]
    return hints.get(domain, "采集建议：按引用 pipeline 打开对应功能面板后重采。")


def relative_or_absolute(root: Path, path: Path) -> str:
    try:
        return slash_path(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path)


def sanitize_file_part(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in value)
    return cleaned.strip("_") or "template-triage"


def slash_path(path: Path) -> str:
    return path.as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
