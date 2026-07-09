#!/usr/bin/env python3
"""Audit the schema v8 Step.params compatibility contract."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


SCHEMA_VERSION = 8


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Repository root to audit.",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    return parser.parse_args()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def find_matching(source: str, start: int, open_char: str, close_char: str) -> int:
    depth = 0
    quote = ""
    escaped = False
    line_comment = False
    block_comment = False
    for index in range(start, len(source)):
        ch = source[index]
        nxt = source[index + 1] if index + 1 < len(source) else ""
        if line_comment:
            if ch in "\r\n":
                line_comment = False
            continue
        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
            continue
        if quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = ""
            continue
        if ch == "/" and nxt == "/":
            line_comment = True
            continue
        if ch == "/" and nxt == "*":
            block_comment = True
            continue
        if ch in "\"'`":
            quote = ch
            continue
        if ch == open_char:
            depth += 1
        elif ch == close_char:
            depth -= 1
            if depth == 0:
                return index
    raise ValueError(f"unclosed {open_char}")


def function_body(source: str, name: str) -> str:
    marker = re.search(rf"\bfunction\s+{re.escape(name)}\s*\([^)]*\)\s*\{{", source)
    if not marker:
        raise ValueError(f"missing function {name}")
    start = marker.end() - 1
    return source[start + 1 : find_matching(source, start, "{", "}")]


def struct_body(source: str, name: str) -> str:
    marker = re.search(rf"\bstruct\s+{re.escape(name)}\s*\{{", source)
    if not marker:
        raise ValueError(f"missing struct {name}")
    start = marker.end() - 1
    return source[start + 1 : find_matching(source, start, "{", "}")]


def require_contains(haystack: str, needles: list[str], failures: list[str], scope: str) -> None:
    for needle in needles:
        if needle not in haystack:
            failures.append(f"{scope} missing {needle}")


def audit(project_root: Path) -> dict[str, object]:
    failures: list[str] = []
    warnings: list[str] = []
    counts: dict[str, int] = {}

    paths = {
        "main": project_root / "src/main.js",
        "params_core": project_root / "src/step-params-core.js",
        "rust": project_root / "src-tauri/src/main.rs",
        "package": project_root / "package.json",
        "workflow_docs": project_root / "docs/workflow-model.md",
        "product_docs": project_root / "docs/product-plan.md",
        "readme": project_root / "README.md",
        "params_test": project_root / "scripts/test_step_params_core.mjs",
        "control_flow_audit": project_root / "scripts/audit_control_flow_schema.py",
        "target_library_test": project_root / "scripts/test_target_library_core.mjs",
    }
    for label, path in paths.items():
        if not path.is_file():
            failures.append(f"missing {label}: {path}")
    if failures:
        return {"passed": False, "failures": failures, "warnings": warnings, "counts": counts}

    main = read_text(paths["main"])
    params_core = read_text(paths["params_core"])
    rust = read_text(paths["rust"])
    package = json.loads(read_text(paths["package"]))
    workflow_docs = read_text(paths["workflow_docs"])
    product_docs = read_text(paths["product_docs"])
    readme = read_text(paths["readme"])
    params_test = read_text(paths["params_test"])
    control_flow_audit = read_text(paths["control_flow_audit"])
    target_library_test = read_text(paths["target_library_test"])

    if not re.search(rf"WORKSPACE_SCHEMA_VERSION\s*=\s*{SCHEMA_VERSION}\b", main):
        failures.append(f"src/main.js WORKSPACE_SCHEMA_VERSION is not {SCHEMA_VERSION}")
    if not re.search(rf"WORKSPACE_SCHEMA_VERSION:\s*u32\s*=\s*{SCHEMA_VERSION}\b", rust):
        failures.append(f"src-tauri/src/main.rs WORKSPACE_SCHEMA_VERSION is not {SCHEMA_VERSION}")
    if f"WORKSPACE_SCHEMA_VERSION\\s*=\\s*{SCHEMA_VERSION}" not in control_flow_audit:
        failures.append("scripts/audit_control_flow_schema.py must audit schema v8")
    if re.search(r"schemaVersion:\s*7\b", target_library_test):
        failures.append("scripts/test_target_library_core.mjs still expects schemaVersion 7")

    require_contains(
        params_core,
        [
            "export const STEP_PARAM_KEYS",
            "export function normalizeStepParams",
            "export function projectStepParamsToLegacy",
            "export function syncStepParamsToLegacy",
            "export function syncStepParamsFromLegacy",
            "options.preferLegacy",
            "for (const key of STEP_PARAM_KEYS) delete params[key]",
        ],
        failures,
        "src/step-params-core.js",
    )
    require_contains(
        main,
        [
            'from "./step-params-core.js"',
            "params: normalizeStepParams",
            "syncLegacyFromStepParams",
            "syncParamsFromLegacyFields",
            "projectedLegacyStep",
            "backendStepPayload",
        ],
        failures,
        "src/main.js",
    )

    try:
        backend_body = function_body(main, "backendStepPayload")
        if re.search(r"\bparams\s*:", backend_body):
            failures.append("backendStepPayload must not send params to Rust")
        require_contains(backend_body, ["projectedLegacyStep", "target", "command", "expect"], failures, "backendStepPayload")
    except ValueError as error:
        failures.append(str(error))

    try:
        effective_body = function_body(main, "effectiveCommandForStep")
        require_contains(effective_body, ["projectedLegacyStep", "targetCommandDefaults"], failures, "effectiveCommandForStep")
    except ValueError as error:
        failures.append(str(error))

    try:
        workflow_step_input = struct_body(rust, "WorkflowStepInput")
        if re.search(r"\bparams\s*:", workflow_step_input):
            failures.append("Rust WorkflowStepInput must not require params while v8 is a frontend compatibility mirror")
    except ValueError as error:
        failures.append(str(error))

    scripts = package.get("scripts", {})
    if scripts.get("test:step-params") != "node scripts/test_step_params_core.mjs":
        failures.append("package.json missing test:step-params script")
    if scripts.get("audit:step-params") != "python scripts/audit_step_params_contract.py":
        failures.append("package.json missing audit:step-params script")

    require_contains(
        params_test,
        [
            "syncStepParamsFromLegacy",
            "syncStepParamsToLegacy",
            "futureNestedName",
            "trace-token",
            "image_click",
            "ocr_assert",
            "retry_until",
            "testOcrLegacyPrefersTargetOverGenericExpect",
            "testLegacyRefreshReplacesStaleImageTarget",
            "testDoubleClickCoordinatesWorkWithoutImageTarget",
            "testNonParamWorkflowFieldsArePreserved",
        ],
        failures,
        "scripts/test_step_params_core.mjs",
    )

    docs_text = "\n".join([workflow_docs, product_docs, readme])
    require_contains(
        docs_text,
        [
            "schema v8",
            "steps[].params",
            "前端结构化参数镜像",
            "Rust IPC",
            "target/command/expect",
            "兼容",
        ],
        failures,
        "docs",
    )
    if "schema v7" in docs_text:
        failures.append("docs still describe the current schema as v7")

    counts["main_params_mentions"] = len(re.findall(r"\bparams\b", main))
    counts["params_core_exports"] = len(re.findall(r"^export ", params_core, re.M))
    return {"passed": not failures, "failures": failures, "warnings": warnings, "counts": counts}


def main() -> int:
    args = parse_args()
    result = audit(args.project_root)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result["passed"]:
        print(
            "Step params contract audit passed "
            f"({result['counts'].get('params_core_exports', 0)} exports, "
            f"{result['counts'].get('main_params_mentions', 0)} main params mentions)"
        )
    else:
        print("Step params contract audit failed:")
        for failure in result["failures"]:
            print(f" - {failure}")
        for warning in result["warnings"]:
            print(f" warning: {warning}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
