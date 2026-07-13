#!/usr/bin/env python3
"""Audit offline home-vitality wiring and live-gate fail-closed checklist."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    failures: list[str] = []
    core = (ROOT / "src/home-vitality-core.js").read_text(encoding="utf-8")
    main_js = (ROOT / "src/main.js").read_text(encoding="utf-8")
    index_html = (ROOT / "index.html").read_text(encoding="utf-8")
    styles = (ROOT / "src/styles.css").read_text(encoding="utf-8")
    tests = (ROOT / "scripts/test_home_vitality_core.mjs").read_text(encoding="utf-8")
    mapping = json.loads((ROOT / "assets/resource/ShiKong/template_mapping.json").read_text(encoding="utf-8"))
    templates = mapping.get("templates") or {}

    required_core_tokens = [
        "HOME_VITALITY_BLUEPRINT",
        "HOME_VITALITY_TEMPLATE_BINDINGS",
        "HOME_VITALITY_LIVE_GATE_CHECKLIST",
        "assessHomeVitalityReadiness",
        "assessHomeVitalityLiveGates",
        "liveReady: false",
        "liveInputAuthorized: false",
        "entry.home",
        "jiayuan/jiayuan.png",
    ]
    for token in required_core_tokens:
        if token not in core:
            failures.append(f"home-vitality-core missing token: {token}")

    for token in [
        "HOME_VITALITY_BLUEPRINT",
        "HOME_VITALITY_TEMPLATE_BINDINGS",
        "HOME_VITALITY_LIVE_GATE_CHECKLIST",
        "assessHomeVitalityLiveGates",
        "home-vitality-readiness",
        "HOME_VITALITY_BLUEPRINT.steps.map",
    ]:
        if token not in main_js:
            failures.append(f"main.js missing home vitality wiring token: {token}")

    if "workflow-blueprint-select" not in index_html:
        failures.append("index.html missing blueprint select for offline task wiring")
    if "home-vitality-readiness" not in styles:
        failures.append("styles.css missing home-vitality readiness presentation")

    for key in ["jiayuan/jiayuan.png", "jiayuan/dali.png", "zonghe/jiahao.png"]:
        if key not in templates:
            failures.append(f"template_mapping missing {key}")
        else:
            rel = templates[key].get("replacementPath") or f"assets/resource/ShiKong/image/{key}"
            path = ROOT / rel
            if not path.is_file():
                failures.append(f"template file missing for {key}: {rel}")

    if "testLiveGateChecklistIsFailClosedEvenWhenAllObserved" not in tests:
        failures.append("home vitality tests missing fail-closed live gate coverage")
    if "entry.home must bind offline to jiayuan/jiayuan.png" not in tests:
        failures.append("home vitality tests missing entry.home binding assertion")

    # Duplicated full step arrays are no longer authoritative; main must import shared steps.
    if re.search(r'id:\s*"home-vitality"\s*,\s*\n\s*label:\s*"家园活力"', main_js):
        failures.append("main.js still hardcodes home-vitality blueprint instead of shared core")

    report = {
        "ok": not failures,
        "failures": failures,
        "checked": {
            "core": "src/home-vitality-core.js",
            "main": "src/main.js",
            "templates": ["jiayuan/jiayuan.png", "jiayuan/dali.png", "zonghe/jiahao.png"],
            "liveReadyAlwaysFalse": True,
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if failures:
        for item in failures:
            print(f"FAIL: {item}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
