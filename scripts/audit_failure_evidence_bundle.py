#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def require(failures: list[str], source: str, needle: str, label: str) -> None:
    if needle not in source:
        failures.append(label)


def main() -> int:
    failures: list[str] = []
    paths = [
        "src/failure-evidence-core.js",
        "scripts/test_failure_evidence_core.mjs",
        "src/main.js",
        "index.html",
        "package.json",
        "README.md",
        "docs/workflow-model.md",
        "docs/product-plan.md",
    ]
    for path in paths:
      if not (ROOT / path).is_file():
          failures.append(f"missing {path}")
    if failures:
        return report(failures)

    core = read_text("src/failure-evidence-core.js")
    test = read_text("scripts/test_failure_evidence_core.mjs")
    main_js = read_text("src/main.js")
    html = read_text("index.html")
    package = json.loads(read_text("package.json"))
    docs = "\n".join([read_text("README.md"), read_text("docs/workflow-model.md"), read_text("docs/product-plan.md")])

    for needle in [
        "failureEvidenceBundle",
        "failureEvidenceSummaryText",
        "failureStepFromReport",
        "isFailureStepResult",
        "fullReport",
        "latest",
        "evidenceCounts",
        "mhxy-shikong.failure-evidence",
    ]:
        require(failures, core, needle, f"failure evidence core missing {needle}")
    for needle in [
        "testFailureEvidenceBundleIncludesBoundedEvidenceAndFullReport",
        "testFailureEvidenceSummaryTextIsCopyFriendly",
        "testFailureStatusClassifierCatchesDetails",
    ]:
        require(failures, test, needle, f"failure evidence test missing {needle}")
    for needle in [
        'from "./failure-evidence-core.js"',
        "copyFailureEvidenceBundle",
        "failureEvidenceBundle(report",
        "failureEvidenceSummaryText(bundle)",
        'data-report-action="evidence"',
    ]:
        require(failures, main_js, needle, f"src/main.js missing {needle}")
    require(failures, html, 'id="failure-report-board"', "index.html missing failure report board")
    scripts = package.get("scripts", {})
    if scripts.get("test:failure-evidence") != "node scripts/test_failure_evidence_core.mjs":
        failures.append("package.json missing test:failure-evidence script")
    if scripts.get("audit:failure-evidence") != "python scripts/audit_failure_evidence_bundle.py":
        failures.append("package.json missing audit:failure-evidence script")
    for needle in ["失败证据包", "runEvents", "controlFlowTransitions", "复制证据包"]:
        require(failures, docs, needle, f"docs missing {needle}")
    return report(failures)


def report(failures: list[str]) -> int:
    if failures:
        print("failure evidence bundle audit failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("failure evidence bundle audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
