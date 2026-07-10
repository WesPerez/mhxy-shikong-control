#!/usr/bin/env python3
"""Audit readiness taxonomy, queue summaries, and window identity gates."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


REQUIRED_FUNCTIONS = [
    "readinessBucketSummary",
    "readinessDetailText",
    "addReadinessBuckets",
    "readinessGapForMessage",
    "readinessRuntimeItem",
    "workbenchReadinessItems",
    "workflowReadinessSummary",
    "queueReadinessSummary",
    "queueRuntimeReadinessItems",
    "workflowCompletionState",
    "isSpecificCompletionGap",
    "completionKindForMessage",
    "completionActionForMessage",
    "completionFocusSelector",
    "completionStatusMessage",
    "renderWorkflowList",
    "renderWorkflowCompletion",
    "renderAssignments",
    "buildTargetReadinessIndex",
    "targetReadinessForDisplay",
    "renderTargets",
    "validateWorkflow",
    "validateStepControlFlowReferences",
    "validateStepRuntimeFields",
    "validateOcrStepRuntimeFields",
    "runSelected",
    "startRunForWindow",
    "currentWindowIdentityForRun",
    "verifySessionWindowIdentityForStep",
    "requiredBackgroundWindowIdentityIssue",
    "windowIdentityMismatchReason",
    "executeBackendStep",
    "refreshPrivilege",
    "renderWindows",
    "renderOpsDashboard",
]

BUCKET_FIELDS = [
    "issues",
    "warnings",
    "missingAssets",
    "missingCoords",
    "missingOcrTexts",
    "missingWindows",
    "permissionBlocks",
    "windowIdentityBlocks",
    "controlFlowBlocks",
    "targetIssues",
    "textIssues",
    "roiWarnings",
    "plannedSemantics",
    "restorePlans",
    "timingIssues",
    "hotkeyWarnings",
    "mouseWarnings",
    "thresholdWarnings",
    "sampleCoverageWarnings",
]

CORE_LABELS = [
    "缺窗口",
    "权限",
    "窗口身份",
    "缺素材",
    "缺坐标",
    "OCR",
    "目标",
    "文本",
    "ROI 提醒",
    "流程",
    "计划态",
    "恢复计划",
    "时间",
]

FOCUS_SELECTORS = [
    "#param-text-value",
    "#target-texts",
    "#step-expect",
    "#param-click-x",
    "#param-hotkey",
    "#param-image-threshold",
    "#target-editor",
    "#param-image-button",
    "#param-click-button",
    "#param-retry-interval",
    "#param-delay-ms",
    "#param-condition-guard",
    "#param-control-workflow-jump",
    "#param-control-target-step",
    "#param-control-max-iterations",
    "#param-control-recovery-step",
    "#param-target-select",
    "#restart-admin",
    "#refresh-windows",
    "#step-block-preset",
]

GAP_CATEGORIES = [
    "missing_asset",
    "missing_coordinate",
    "missing_ocr_text",
    "missing_target",
    "roi_warning",
    "planned_semantic",
    "restore_plan",
    "missing_window",
    "permission",
    "window_identity",
    "task_jump",
    "loop_control",
    "recovery_entry",
    "unsupported_guard",
    "text_input",
    "hotkey",
    "threshold",
    "mouse_button",
    "timing",
    "step_structure",
]


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


def extract_function_body(source: str, name: str) -> str:
    marker = re.search(rf"\bfunction\s+{re.escape(name)}\s*\(", source)
    if not marker:
        raise ValueError(f"missing function {name}")
    params_start = marker.end() - 1
    params_end = find_matching(source, params_start, "(", ")")
    start = source.find("{", params_end)
    if start < 0:
        raise ValueError(f"missing function body {name}")
    return source[start + 1 : find_matching(source, start, "{", "}")]


def require_contains(failures: list[str], text: str, needle: str, label: str) -> None:
    if needle not in text:
        failures.append(label)


def require_all_contains(failures: list[str], text: str, needles: list[str], label: str) -> None:
    missing = [needle for needle in needles if needle not in text]
    if missing:
        failures.append(f"{label}: missing {', '.join(missing)}")


def require_regex(failures: list[str], text: str, pattern: str, label: str) -> None:
    if not re.search(pattern, text, re.S):
        failures.append(label)


def audit(project_root: Path) -> dict[str, object]:
    failures: list[str] = []
    warnings: list[str] = []
    counts: dict[str, int] = {}

    main_path = project_root / "src/main.js"
    css_path = project_root / "src/styles.css"
    index_path = project_root / "index.html"
    package_path = project_root / "package.json"
    readme_path = project_root / "README.md"
    product_plan_path = project_root / "docs/product-plan.md"
    workflow_model_path = project_root / "docs/workflow-model.md"

    for path in [main_path, css_path, index_path, package_path, readme_path, product_plan_path, workflow_model_path]:
        if not path.is_file():
            failures.append(f"missing {path.relative_to(project_root)}")
    if failures:
        return {"passed": False, "failures": failures, "warnings": warnings, "counts": counts}

    source = read_text(main_path)
    css = read_text(css_path)
    index_html = read_text(index_path)
    package = json.loads(read_text(package_path))
    docs_text = "\n".join(read_text(path) for path in [readme_path, product_plan_path, workflow_model_path])

    bodies: dict[str, str] = {}
    for name in REQUIRED_FUNCTIONS:
        try:
            bodies[name] = extract_function_body(source, name)
        except ValueError as error:
            failures.append(str(error))
    if failures:
        return {"passed": False, "failures": failures, "warnings": warnings, "counts": counts}

    bucket = bodies["readinessBucketSummary"]
    detail = bodies["readinessDetailText"]
    add_buckets = bodies["addReadinessBuckets"]
    gap_for_message = bodies["readinessGapForMessage"]
    runtime_item = bodies["readinessRuntimeItem"]
    workbench_readiness = bodies["workbenchReadinessItems"]
    workflow_summary = bodies["workflowReadinessSummary"]
    queue_summary = bodies["queueReadinessSummary"]
    queue_runtime = bodies["queueRuntimeReadinessItems"]
    completion_state = bodies["workflowCompletionState"]
    specific_gap = bodies["isSpecificCompletionGap"]
    kind_for_message = bodies["completionKindForMessage"]
    action_for_message = bodies["completionActionForMessage"]
    focus_selector = bodies["completionFocusSelector"]
    status_message = bodies["completionStatusMessage"]
    render_workflow_list = bodies["renderWorkflowList"]
    render_completion = bodies["renderWorkflowCompletion"]
    render_assignments = bodies["renderAssignments"]
    target_index = bodies["buildTargetReadinessIndex"]
    target_readiness = bodies["targetReadinessForDisplay"]
    render_targets = bodies["renderTargets"]
    validate_workflow = bodies["validateWorkflow"]
    validate_control_flow = bodies["validateStepControlFlowReferences"]
    validate_runtime = bodies["validateStepRuntimeFields"]
    validate_ocr = bodies["validateOcrStepRuntimeFields"]
    run_selected = bodies["runSelected"]
    start_run = bodies["startRunForWindow"]
    current_identity = bodies["currentWindowIdentityForRun"]
    verify_identity = bodies["verifySessionWindowIdentityForStep"]
    required_identity = bodies["requiredBackgroundWindowIdentityIssue"]
    mismatch_reason = bodies["windowIdentityMismatchReason"]
    execute_backend = bodies["executeBackendStep"]
    refresh_privilege = bodies["refreshPrivilege"]
    render_windows = bodies["renderWindows"]
    render_ops = bodies["renderOpsDashboard"]

    counts["readinessPillReferences"] = source.count("readiness-pill")
    counts["targetReadinessReferences"] = source.count("targetReadiness")
    counts["queueReadinessReferences"] = source.count("queueReadinessSummary(")
    taxonomy_source = gap_for_message + focus_selector
    counts["completionFocusSelectors"] = sum(1 for selector in FOCUS_SELECTORS if selector in taxonomy_source)
    counts["coreLabels"] = sum(1 for label in CORE_LABELS if label in source)

    require_all_contains(failures, bucket, BUCKET_FIELDS, "readinessBucketSummary must keep all bucket fields")
    require_contains(
        failures,
        bucket,
        "item.category || readinessGapForMessage(item.message).category",
        "readiness bucket must use stable categories rather than direct message text matching",
    )
    for category in GAP_CATEGORIES:
        require_contains(failures, gap_for_message, f'category: "{category}"', f"readinessGapForMessage must classify {category}")
    for category in [
        "missing_asset",
        "missing_coordinate",
        "missing_ocr_text",
        "missing_window",
        "permission",
        "window_identity",
        "missing_target",
        "text_input",
        "roi_warning",
        "planned_semantic",
        "restore_plan",
        "timing",
        "hotkey",
        "mouse_button",
        "threshold",
        "step_structure",
    ]:
        require_contains(failures, bucket, category, f"readiness bucket must count {category}")
    require_all_contains(failures, detail, CORE_LABELS, "readinessDetailText must expose stable user-facing labels")
    require_all_contains(failures, add_buckets, BUCKET_FIELDS, "addReadinessBuckets must merge all bucket fields")
    require_all_contains(
        failures,
        gap_for_message,
        [
            "缺窗口",
            "权限",
            "窗口身份",
            "缺素材",
            "坐标",
            "OCR",
            "目标",
            "文本",
            "ROI",
            "流程",
            "恢复",
            "时间",
            "热键",
            "阈值",
            "鼠标",
            "跳转",
            "条件",
            "循环",
            "步骤",
            "粘贴图",
            "填坐标",
            "填文本",
            "设 ROI",
            "绑目标",
            "改热键",
            "改阈值",
            "改按钮",
            "改时间",
            "看计划",
            "配恢复",
        ],
        "readinessGapForMessage must keep user-facing kind/action labels",
    )
    require_contains(failures, runtime_item, "category: gap.category", "runtime readiness items must store gap category")
    require_contains(failures, runtime_item, "focusSelector: gap.focusSelector", "runtime readiness items must store focus selector")
    require_contains(failures, runtime_item, "statusMessage: gap.statusMessage", "runtime readiness items must store status message")
    require_contains(failures, workbench_readiness, "selectedWindows()", "workbench readiness must include selected-window state")
    require_contains(failures, workbench_readiness, "currentProcessElevated", "workbench readiness must include admin privilege state")
    require_contains(failures, workbench_readiness, "windowIdentityMismatchReason", "workbench readiness must include window identity state")

    require_contains(failures, workflow_summary, 'validateWorkflow(workflow, "background")', "workflow readiness must use background validation")
    require_contains(failures, workflow_summary, "readinessBucketSummary(completion.items)", "workflow readiness must summarize completion items")
    require_contains(failures, workflow_summary, "readinessDetailText(summary)", "workflow readiness must expose classified details")

    require_contains(failures, queue_summary, 'validateWorkflowQueue(workflows, "background")', "queue readiness must use background queue validation")
    require_contains(failures, queue_summary, "readinessBuckets", "queue readiness must keep workflow-level readiness buckets")
    require_contains(failures, queue_summary, "addReadinessBuckets(readinessBuckets, workflowReadinessSummary(workflow))", "queue readiness must merge per-workflow taxonomy")
    require_contains(failures, queue_summary, "readinessDetailText(readinessBuckets)", "queue readiness must render classified details")
    require_all_contains(
        failures,
        queue_summary,
        ["missingWorkflowCount", "disabledCount", "firstBlockingMessage"],
        "queue readiness must keep queue-level blockers",
    )

    require_all_contains(
        failures,
        completion_state,
        ["const gap = readinessGapForMessage(message)", "category: gap.category", "kind: gap.kind", "action: gap.action", "severity", "stepIssues", "stepWarnings"],
        "workflowCompletionState must preserve per-step classified completion items",
    )
    require_all_contains(
        failures,
        specific_gap,
        [
            "Ctrl\\+V 图片",
            "OCR 需要目标文本",
            "文本输入需要",
            "后台(?:点击|双击)需要",
            "绑定的识别目标已不存在",
            "匹配阈值",
            "鼠标键",
            "延迟步骤",
            "计划态",
            "不会自动执行恢复",
        ],
        "specific completion gaps must cover runtime blockers",
    )
    require_contains(
        failures,
        kind_for_message,
        "readinessGapForMessage(message).kind",
        "completionKindForMessage must delegate to readiness taxonomy",
    )
    require_contains(
        failures,
        action_for_message,
        "readinessGapForMessage(message).action",
        "completionActionForMessage must delegate to readiness taxonomy",
    )
    require_all_contains(
        failures,
        source,
        ["缺素材", "OCR", "ROI", "坐标", "目标", "文本", "热键", "阈值", "鼠标", "时间", "流程", "恢复"],
        "readiness taxonomy must classify all user-facing buckets",
    )
    require_all_contains(
        failures,
        source,
        ["粘贴图", "填坐标", "填文本", "设 ROI", "绑目标", "改热键", "改阈值", "改按钮", "改时间", "看计划", "配恢复"],
        "readiness taxonomy must keep actionable labels",
    )
    require_contains(failures, focus_selector, "item.category", "completionFocusSelector must branch on stable categories")
    require_contains(failures, focus_selector, "item.focusSelector", "completionFocusSelector must use taxonomy focus selectors")
    require_all_contains(failures, source, FOCUS_SELECTORS, "readiness taxonomy must expose expected editor focus controls")
    require_all_contains(
        failures,
        source,
        ["复制图片后直接 Ctrl+V", "填写目标文本", "填写 x/y 坐标或绑定 ROI 目标", "OCR ROI 提醒"],
        "completionStatusMessage must give low-operation repair guidance",
    )
    require_contains(failures, status_message, "item.statusMessage", "completionStatusMessage must use taxonomy status text")

    require_contains(failures, render_workflow_list, "workflowReadinessSummary(item)", "workflow list must show workflow readiness")
    require_contains(failures, render_workflow_list, "readiness-pill", "workflow list must render readiness pills")
    require_contains(failures, render_completion, "readinessBucketSummary", "completion board must summarize buckets")
    require_contains(failures, render_completion, "readinessDetailText", "completion board must render detail text")
    require_contains(failures, render_assignments, "queueReadinessSummary(assignment)", "window queues must render queue readiness")
    require_contains(failures, render_assignments, "workflowReadinessSummary(workflow)", "queue items must render per-workflow readiness")
    require_contains(failures, render_assignments, "readiness-pill", "queue UI must render readiness pills")
    require_contains(
        failures,
        queue_summary,
        "queueRuntimeReadinessItems(assignment)",
        "queue readiness must include runtime environment items",
    )
    require_contains(failures, queue_runtime, "windowForAssignment(assignment)", "queue runtime readiness must bind assignment to live window")
    require_contains(failures, queue_runtime, "currentProcessElevated", "queue runtime readiness must include admin privilege state")
    require_contains(failures, queue_runtime, "windowIdentityMismatchReason", "queue runtime readiness must include window identity state")

    require_contains(failures, target_index, "workflowCompletionState(workflow", "target readiness index must derive from workflow completion items")
    require_contains(failures, target_readiness, "readinessBucketSummary(indexedItems)", "target readiness must reuse taxonomy buckets")
    require_contains(failures, target_readiness, "readinessDetailText(summary)", "target readiness must expose taxonomy details")
    require_all_contains(
        failures,
        target_readiness,
        [
            "缺文本",
            "缺素材",
            "缺坐标",
            "需要 Ctrl+V 图片或 ROI 裁剪图",
            "后台点击需要 x/y 坐标或 ROI 目标",
            "未使用",
            "已采样",
            "可定位",
        ],
        "targetReadinessForDisplay must classify shared target gaps",
    )
    require_contains(failures, render_targets, "buildTargetReadinessIndex()", "target list must build readiness index")
    require_contains(failures, render_targets, "targetReadinessForDisplay(targetItem", "target list must render target readiness")
    require_contains(failures, render_targets, "target-readiness", "target list must expose readiness marker")

    require_contains(failures, validate_workflow, "validateStepControlFlowReferences", "validateWorkflow must audit control-flow references")
    require_contains(failures, validate_workflow, "validateStepRuntimeFields", "validateWorkflow must audit runtime fields")
    require_all_contains(
        failures,
        validate_control_flow,
        ["任务跳转需要选择目标任务", "循环步骤必须选择循环目标", "后向跳转", "恢复入口", "最大循环次数"],
        "control-flow validation must keep blocking taxonomy",
    )
    require_all_contains(
        failures,
        validate_runtime,
        [
            "鼠标键只支持 left/right",
            "匹配阈值必须在 0 到 1 之间",
            "图像点击点只支持",
            "绑定的识别目标已不存在",
            "后台点击",
            "后台双击",
            "图像步骤需要 Ctrl+V 图片或 ROI 裁剪图",
            "文本输入需要内容",
            "重试直到需要绑定图片、ROI 或坐标目标",
            "条件 guard=",
            "失败处理 restore",
            "计划态",
        ],
        "runtime validation must keep action readiness taxonomy",
    )
    require_all_contains(
        failures,
        validate_ocr,
        ["OCR 需要目标文本", "OCR 语言标记", "OCR 未限定 ROI"],
        "OCR validation must keep text/lang/ROI taxonomy",
    )

    require_contains(failures, run_selected, "windowIdentityMismatchReason", "runSelected must check queued window identity before launch")
    require_contains(failures, start_run, "currentWindowIdentityForRun(target, mode)", "startRunForWindow must capture live window identity")
    require_contains(failures, start_run, "windowIdentity", "RunSession must store startup window identity")
    require_contains(failures, current_identity, "requiredBackgroundWindowIdentityIssue(expected)", "run start must require complete expected identity")
    require_contains(failures, current_identity, 'invokeBackend("current_window_identity"', "background start must re-read live identity")
    require_contains(failures, current_identity, "windowIdentityMismatchReason(expected, current)", "background start must reject window drift")
    require_contains(failures, verify_identity, "缺少启动窗口身份快照", "step identity gate must fail missing startup identity")
    require_contains(failures, verify_identity, 'invokeBackend("current_window_identity"', "step identity gate must re-read live identity")
    require_contains(failures, execute_backend, "expectedWindow: session.windowIdentity || null", "backend payload must include expected window")
    require_all_contains(
        failures,
        required_identity,
        ["缺少 hwnd", "缺少窗口标题", "缺少进程 PID", "缺少进程名", "缺少客户区尺寸", "缺少权限状态"],
        "requiredBackgroundWindowIdentityIssue must classify incomplete identity",
    )
    require_all_contains(
        failures,
        mismatch_reason,
        ["hwnd", "title", "pid", "process", "clientWidth", "clientHeight", "elevated"],
        "windowIdentityMismatchReason must compare stable identity fields",
    )
    require_contains(failures, refresh_privilege, "currentProcessElevated", "privilege refresh must read current process elevation")
    require_contains(failures, refresh_privilege, "#restart-admin", "privilege UI must expose admin restart path")
    require_contains(failures, render_windows, "item.elevated", "window list must surface target elevation")
    require_contains(failures, render_ops, "ops-dispatch-mode", "ops dashboard must surface dispatch mode")

    require_regex(failures, css, r"\.readiness-pill\.(ready|warning|blocked)", "CSS must style readiness pills")
    require_contains(failures, css, ".completion-board", "CSS must style completion board")
    require_contains(failures, css, ".target-readiness", "CSS must style target readiness")
    require_regex(failures, css, r"\.target-row\.(ready|warning|blocked|unused)", "CSS must style target readiness row states")
    require_contains(failures, index_html, 'id="workflow-completion"', "index.html must expose workflow completion board")
    require_contains(failures, index_html, 'id="restart-admin"', "index.html must expose admin restart button")

    scripts = package.get("scripts", {})
    if scripts.get("audit:readiness-taxonomy") != "python scripts/audit_readiness_taxonomy.py":
        failures.append("package.json must expose audit:readiness-taxonomy")
    require_contains(failures, docs_text, "audit:readiness-taxonomy", "docs must mention the readiness taxonomy audit command")

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
