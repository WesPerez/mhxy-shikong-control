#!/usr/bin/env python3
"""Audit schema v7 control-flow fields and pc runner boundaries."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


CONTROL_FLOW_STEP_FIELDS = ["targetStepId", "elseTargetStepId", "recoveryStepId"]
CONTROL_FLOW_WORKFLOW_FIELDS = ["jumpWorkflowId"]
CONTROL_FLOW_FIELDS = [*CONTROL_FLOW_STEP_FIELDS, *CONTROL_FLOW_WORKFLOW_FIELDS, "maxIterations"]


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


def set_literals(source: str, name: str) -> set[str]:
    match = re.search(rf"\b{name}\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]", source, re.S)
    if not match:
        raise ValueError(f"missing set {name}")
    matches = re.findall(r'"([^"]+)"|\'([^\']+)\'', match.group(1))
    return {double or single for double, single in matches}


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
        "core": project_root / "src/control-flow-core.js",
        "html": project_root / "index.html",
        "rust": project_root / "src-tauri/src/main.rs",
        "package": project_root / "package.json",
        "workflow_docs": project_root / "docs/workflow-model.md",
        "product_docs": project_root / "docs/product-plan.md",
        "readme": project_root / "README.md",
    }
    for label, path in paths.items():
        if not path.is_file():
            failures.append(f"missing {label}: {path}")
    if failures:
        return {"passed": False, "failures": failures, "warnings": warnings, "counts": counts}

    main = read_text(paths["main"])
    core = read_text(paths["core"])
    html = read_text(paths["html"])
    rust = read_text(paths["rust"])
    package = json.loads(read_text(paths["package"]))
    workflow_docs = read_text(paths["workflow_docs"])
    product_docs = read_text(paths["product_docs"])
    readme = read_text(paths["readme"])

    if not re.search(r"WORKSPACE_SCHEMA_VERSION\s*=\s*7\b", main):
        failures.append("src/main.js WORKSPACE_SCHEMA_VERSION is not 7")
    if not re.search(r"WORKSPACE_SCHEMA_VERSION:\s*u32\s*=\s*7\b", rust):
        failures.append("src-tauri/src/main.rs WORKSPACE_SCHEMA_VERSION is not 7")
    require_contains(rust, ["task_jump", "loop", "planned", "no_input"], failures, "src-tauri/src/main.rs")

    try:
        planned_only = set_literals(main, "plannedOnlyStepTypes")
        if "restore" not in planned_only:
            failures.append("plannedOnlyStepTypes must include restore")
        if "condition" in planned_only:
            failures.append("plannedOnlyStepTypes must not include condition once the pc runner executes condition branches")
    except ValueError as error:
        failures.append(str(error))

    require_contains(main, CONTROL_FLOW_STEP_FIELDS, failures, "src/main.js")
    require_contains(main, CONTROL_FLOW_WORKFLOW_FIELDS, failures, "src/main.js")
    require_contains(main, ["maxIterations"], failures, "src/main.js")
    require_contains(
        main,
        ["sanitizeStepControlFlowForType", "item.type !== \"condition\"", "item.type === \"loop\"", "plannedOnlyStepTypes.has(item.type)"],
        failures,
        "src/main.js",
    )
    require_contains(main, ['["loop", "循环"]', "loop: {", "action: \"loop\"", "bounded loop requested"], failures, "src/main.js loop")

    try:
        normalize_body = function_body(main, "normalizeStep")
        require_contains(
            normalize_body,
            ["controlFlowStepReferenceFields", "controlFlowWorkflowReferenceFields", "maxIterations"],
            failures,
            "normalizeStep",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        duplicate_body = function_body(main, "duplicateWorkflow")
        require_contains(
            duplicate_body,
            ["stepIdMap", "remapStepControlFlowReferences", "jumpWorkflowId === source.id"],
            failures,
            "duplicateWorkflow",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        clone_body = function_body(main, "cloneStepForInsert")
        require_contains(clone_body, ["remapStepControlFlowReferences", "clearWorkflowReferences: true"], failures, "cloneStepForInsert")
    except ValueError as error:
        failures.append(str(error))

    try:
        validation_body = function_body(main, "validateStepControlFlowReferences")
        require_contains(
            validation_body,
            [
                "指向不存在的步骤",
                "指向已停用步骤",
                "不能指向当前步骤",
                "后向跳转，必须设置最大循环次数",
                "循环步骤必须选择循环目标",
                "循环步骤必须设置最大循环次数",
                "循环目标应指向当前步骤之前的步骤",
                "plannedOnlyStepTypes",
                "不能驱动成功/条件/任务跳转",
            ],
            failures,
            "validateStepControlFlowReferences",
        )
    except ValueError as error:
        failures.append(str(error))

    require_contains(main, ["MAX_CONTROL_FLOW_STEPS", "MAX_CONTROL_FLOW_TRANSITIONS", "MAX_WORKFLOW_JUMPS"], failures, "src/main.js")
    require_contains(
        main,
        [
            "from \"./control-flow-core.js\"",
            "controlFlowDecisionForStepCore",
            "insertWorkflowJumpIntoRunPlanCore",
            "recoveryDecisionForFailedStepCore",
            "unboundedWorkflowJumpCycleFindings",
        ],
        failures,
        "src/main.js",
    )
    try:
        run_session_body = function_body(main, "runSession")
        require_contains(
            run_session_body,
            ["pendingRunPlan", "runWorkflowEntry(session, entry)", "workflowJumpRequest", "insertWorkflowJumpIntoRunPlan"],
            failures,
            "runSession",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        cycle_body = function_body(core, "unboundedWorkflowJumpCycleFindings")
        require_contains(
            cycle_body,
            ["jumpWorkflowId", "maxIterations", "bounded", "!item.bounded", "workflowJumpPathToWorkflow", "cycleWorkflowNames"],
            failures,
            "src/control-flow-core.js unboundedWorkflowJumpCycleFindings",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        jump_insert_body = function_body(core, "insertWorkflowJumpIntoRunPlan")
        require_contains(
            jump_insert_body,
            ["maxWorkflowJumps", "queuePlan.splice", "insertedBy: \"task_jump\"", "phase: \"task_jump\""],
            failures,
            "src/control-flow-core.js insertWorkflowJumpIntoRunPlan",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        workflow_runner_body = function_body(main, "runWorkflowEntry")
        require_contains(
            workflow_runner_body,
            [
                "let pc = 0",
                "stepIndexById",
                "executedSteps >= MAX_CONTROL_FLOW_STEPS",
                "controlFlowDecisionForStep",
                "recordControlFlowTransition",
                "session.status === \"failed\"",
                "verifySessionWindowIdentityForStep",
                "recoveryDecisionForFailedStep",
                "completeRecoveryAsFailed",
                "workflowJumpRequest",
            ],
            failures,
            "runWorkflowEntry",
        )
        if "for (const item of steps)" in workflow_runner_body:
            failures.append("runWorkflowEntry must use pc, not a linear for...of over steps")
    except ValueError as error:
        failures.append(str(error))

    try:
        identity_body = function_body(main, "verifySessionWindowIdentityForStep")
        require_contains(
            identity_body,
            ["current_window_identity", "requiredBackgroundWindowIdentityIssue", "windowIdentityMismatchReason"],
            failures,
            "verifySessionWindowIdentityForStep",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        background_step_body = function_body(main, "executeBackgroundStep")
        require_contains(
            background_step_body,
            ["item.type === \"task_jump\"", "action: \"task_jump\"", "inputSent: false", "matched: false"],
            failures,
            "executeBackgroundStep",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        blueprint_body = function_body(main, "createWorkflowFromBlueprint")
        require_contains(blueprint_body, ["withDefaultRecoveryReferences", "createBlueprintStep"], failures, "createWorkflowFromBlueprint")
    except ValueError as error:
        failures.append(str(error))

    try:
        decision_body = function_body(core, "controlFlowDecisionForStep")
        require_contains(
            decision_body,
            [
                "evaluateConditionGuard",
                "item.type === \"loop\"",
                "item.targetStepId",
                "item.elseTargetStepId",
                "session.controlFlowCounts",
                "maxIterations",
                "buildTransition",
                "fallthrough",
                "skipped",
                "taken",
                "stepOrder",
                "defaultNextIndex",
                "unsupported guard expression",
                "result?.status !== \"planned\"",
                "plannedOnlyStepTypes",
                "循环目标必须位于当前步骤之前",
                "buildWorkflowJumpDecision",
                "item.jumpWorkflowId",
                "workflowJumpId",
                "workflowJump",
                "toWorkflowId",
            ],
            failures,
            "src/control-flow-core.js controlFlowDecisionForStep",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        recovery_body = function_body(core, "recoveryDecisionForFailedStep")
        require_contains(
            recovery_body,
            [
                "backgroundFailureStatuses.has",
                "recoveryStepId",
                "failure restore",
                "originalFailureReason",
                "recoveryContext",
            ],
            failures,
            "src/control-flow-core.js recoveryDecisionForFailedStep",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        transition_body = function_body(core, "recordControlFlowTransition")
        require_contains(
            transition_body,
            [
                "controlFlowTransitionSerial",
                "controlFlowTransitions",
                "maxControlFlowTransitions",
                "new Date().toISOString()",
            ],
            failures,
            "src/control-flow-core.js recordControlFlowTransition",
        )
    except ValueError as error:
        failures.append(str(error))
    try:
        transition_wrapper_body = function_body(main, "recordControlFlowTransition")
        require_contains(
            transition_wrapper_body,
            ["recordControlFlowTransitionCore", "MAX_CONTROL_FLOW_TRANSITIONS"],
            failures,
            "src/main.js recordControlFlowTransition wrapper",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        history_body = function_body(main, "runHistoryEntryFromSession")
        require_contains(history_body, ["controlFlowTransitions", "MAX_CONTROL_FLOW_TRANSITIONS"], failures, "runHistoryEntryFromSession")
    except ValueError as error:
        failures.append(str(error))

    try:
        history_summary_body = function_body(main, "historyTransitionSummary")
        require_contains(
            history_summary_body,
            ["controlFlowTransitions", "queueEvents", "phase === \"task_jump\"", "formatHistoryTransition"],
            failures,
            "historyTransitionSummary",
        )
    except ValueError as error:
        failures.append(str(error))

    try:
        guard_body = function_body(core, "evaluateConditionGuard")
        require_contains(
            guard_body,
            ["last.matched", "status", "action", "supported", "compareNumbers", "unsupported"],
            failures,
            "src/control-flow-core.js evaluateConditionGuard",
        )
    except ValueError as error:
        failures.append(str(error))

    ui_ids = [
        "param-control-target-step",
        "param-control-else-step",
        "param-control-recovery-step",
        "param-control-workflow-jump",
        "param-control-max-iterations",
    ]
    require_contains(html, ui_ids, failures, "index.html")
    require_contains(html, ["data-step-types=\"detect_page wait_image image_click double_click ocr_assert click hotkey text_input delay condition loop", "循环只在当前任务内跳转"], failures, "index.html loop")
    require_contains(main, [f'$("#{item}").addEventListener' for item in ui_ids], failures, "bindStepParamEditor")

    docs_text = "\n".join([workflow_docs, product_docs, readme])
    require_contains(docs_text, ["schema v7", "targetStepId", "elseTargetStepId", "recoveryStepId", "jumpWorkflowId", "maxIterations"], failures, "docs")
    require_contains(
        docs_text,
        ["指令指针", "condition", "loop", "有限循环", "后向跳转", "失败恢复", "任务跳转", "跨任务环", "controlFlowTransitions"],
        failures,
        "docs",
    )
    test_control_flow = read_text(project_root / "scripts/test_control_flow_core.mjs")
    require_contains(test_control_flow, ["testLoopStepUsesPlannedNoInputAndBudget", "type: \"loop\"", "循环目标必须位于当前步骤之前"], failures, "scripts/test_control_flow_core.mjs loop")

    scripts = package.get("scripts", {})
    if scripts.get("audit:control-flow-schema") != "python scripts/audit_control_flow_schema.py":
        failures.append("package.json missing audit:control-flow-schema script")
    if scripts.get("test:control-flow") != "node scripts/test_control_flow_core.mjs":
        failures.append("package.json missing test:control-flow script")

    counts.update({"controlFlowFields": len(CONTROL_FLOW_FIELDS), "uiControls": len(ui_ids)})
    return {"passed": not failures, "failures": failures, "warnings": warnings, "counts": counts}


def main() -> int:
    args = parse_args()
    result = audit(args.project_root.resolve())
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for key, value in result["counts"].items():
            print(f"{key}={value}")
        for message in result["failures"]:
            print(f"FAIL {message}")
        for message in result["warnings"]:
            print(f"WARN {message}")
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    sys.exit(main())
