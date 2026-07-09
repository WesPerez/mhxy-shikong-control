#!/usr/bin/env python3
"""Audit multi-window queue readiness, identity checks, and UI signals."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


REQUIRED_FUNCTIONS = [
    "ensureAssignment",
    "prepareExerciseWorkspace",
    "queueReadinessSummary",
    "readinessBucketSummary",
    "workflowCompletionState",
    "workflowCompletionItem",
    "readinessGapForMessage",
    "readinessRuntimeItem",
    "workbenchReadinessItems",
    "completionFocusSelector",
    "completionStatusMessage",
    "renderQueueOverview",
    "renderAssignments",
    "cloneQueueItems",
    "copyActiveQueueToSelectedWindows",
    "queueExerciseSuiteForTargets",
    "runSelected",
    "startRunForWindow",
    "activeRunSessions",
    "runningSessions",
    "pausedSessions",
    "pauseRuns",
    "resumeRuns",
    "setSessionPaused",
    "closePauseEvent",
    "resumeSession",
    "recordRunEvent",
    "waitIfPaused",
    "syncRunActionButtons",
    "executeBackendStep",
    "runHistoryEntryFromSession",
    "renderFailureReports",
    "failureReportDetailHtml",
    "toggleFailureReportDetail",
    "stopDryRun",
    "selectedEditableWindows",
    "updateQueueItem",
    "updateQueueItemTiming",
]
EXPECTED_QUEUE_PATTERN = [2, 5, 7, 3, 9, 4, 6, 8, 1, 10]


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
    brace_match = re.search(r"\{", source[params_end + 1 :])
    if not brace_match:
        raise ValueError(f"missing function body {name}")
    start = params_end + 1 + brace_match.start()
    return source[start + 1 : find_matching(source, start, "{", "}")]


def require_contains(failures: list[str], text: str, needle: str, label: str) -> None:
    if needle not in text:
        failures.append(label)


def require_regex(failures: list[str], text: str, pattern: str, label: str) -> None:
    if not re.search(pattern, text, re.S):
        failures.append(label)


def parse_number_array(source: str, name: str) -> list[int] | None:
    match = re.search(rf"\bconst\s+{re.escape(name)}\s*=\s*\[([^\]]*)\]", source, re.S)
    if not match:
        return None
    values: list[int] = []
    for item in match.group(1).split(","):
        item = item.strip()
        if not item:
            continue
        if not re.fullmatch(r"\d+", item):
            return None
        values.append(int(item))
    return values


def audit(project_root: Path) -> dict[str, object]:
    failures: list[str] = []
    warnings: list[str] = []
    counts: dict[str, int] = {}

    main_path = project_root / "src/main.js"
    css_path = project_root / "src/styles.css"
    index_path = project_root / "index.html"
    package_path = project_root / "package.json"
    if not main_path.is_file():
        return {"passed": False, "failures": [f"missing {main_path}"], "warnings": warnings, "counts": counts}
    if not css_path.is_file():
        failures.append("missing src/styles.css")
    if not index_path.is_file():
        failures.append("missing index.html")
    if not package_path.is_file():
        failures.append("missing package.json")

    source = read_text(main_path)
    css = read_text(css_path) if css_path.is_file() else ""
    index_html = read_text(index_path) if index_path.is_file() else ""
    package = json.loads(read_text(package_path)) if package_path.is_file() else {}

    bodies: dict[str, str] = {}
    for name in REQUIRED_FUNCTIONS:
        try:
            bodies[name] = extract_function_body(source, name)
        except ValueError as error:
            failures.append(str(error))

    if failures:
        return {"passed": False, "failures": failures, "warnings": warnings, "counts": counts}

    ensure_assignment = bodies["ensureAssignment"]
    prepare_exercise = bodies["prepareExerciseWorkspace"]
    queue_readiness = bodies["queueReadinessSummary"]
    readiness_bucket = bodies["readinessBucketSummary"]
    workflow_completion = bodies["workflowCompletionState"]
    workflow_completion_item = bodies["workflowCompletionItem"]
    readiness_gap = bodies["readinessGapForMessage"]
    readiness_runtime_item = bodies["readinessRuntimeItem"]
    workbench_readiness = bodies["workbenchReadinessItems"]
    completion_focus = bodies["completionFocusSelector"]
    completion_status = bodies["completionStatusMessage"]
    render_overview = bodies["renderQueueOverview"]
    render_assignments = bodies["renderAssignments"]
    clone_queue = bodies["cloneQueueItems"]
    copy_queue = bodies["copyActiveQueueToSelectedWindows"]
    exercise_queue = bodies["queueExerciseSuiteForTargets"]
    run_selected = bodies["runSelected"]
    start_run = bodies["startRunForWindow"]
    active_runs = bodies["activeRunSessions"]
    pause_runs = bodies["pauseRuns"]
    resume_runs = bodies["resumeRuns"]
    set_paused = bodies["setSessionPaused"]
    close_pause = bodies["closePauseEvent"]
    resume_session = bodies["resumeSession"]
    record_run_event = bodies["recordRunEvent"]
    wait_paused = bodies["waitIfPaused"]
    sync_buttons = bodies["syncRunActionButtons"]
    execute_backend = bodies["executeBackendStep"]
    run_history = bodies["runHistoryEntryFromSession"]
    render_reports = bodies["renderFailureReports"]
    report_detail = bodies["failureReportDetailHtml"]
    toggle_report = bodies["toggleFailureReportDetail"]
    stop_runs = bodies["stopDryRun"]
    selected_editable = bodies["selectedEditableWindows"]
    update_queue = bodies["updateQueueItem"]
    update_timing = bodies["updateQueueItemTiming"]

    queue_pattern = parse_number_array(source, "exerciseSuiteQueuePattern")
    counts["exerciseQueuePatternLength"] = len(queue_pattern or [])
    if queue_pattern != EXPECTED_QUEUE_PATTERN:
        failures.append(f"exerciseSuiteQueuePattern must be {EXPECTED_QUEUE_PATTERN}, got {queue_pattern}")

    require_contains(
        failures,
        ensure_assignment,
        "state.workspace.assignments[key]",
        "ensureAssignment must store assignments by hwnd key",
    )
    require_contains(
        failures,
        ensure_assignment,
        "assignment.windowIdentity = windowIdentityForTarget(target)",
        "ensureAssignment must snapshot target window identity",
    )
    require_contains(
        failures,
        ensure_assignment,
        "assignment.queue = Array.isArray(assignment.queue)",
        "ensureAssignment must preserve and normalize the existing queue",
    )

    require_contains(failures, prepare_exercise, "await refreshWindows()", "prepareExerciseWorkspace must refresh windows")
    require_contains(failures, prepare_exercise, "selectGameWindows()", "prepareExerciseWorkspace must select game windows")
    require_contains(
        failures,
        prepare_exercise,
        "queueExerciseSuiteForTargets(workflows, targets, { onlyEmptyQueues: true })",
        "prepareExerciseWorkspace must queue the exercise suite without overwriting non-empty queues",
    )
    require_contains(
        failures,
        prepare_exercise,
        "await saveWorkspaceNow()",
        "prepareExerciseWorkspace must persist the generated exercise setup",
    )

    counts["queueReadinessReferences"] = source.count("queueReadinessSummary(")
    counts["readinessPills"] = source.count("readiness-pill")

    require_contains(
        failures,
        queue_readiness,
        'validateWorkflowQueue(workflows, "background")',
        "queueReadinessSummary must validate queued workflows in background mode",
    )
    require_contains(failures, queue_readiness, "missingWorkflowCount", "queue readiness must count missing workflows")
    require_contains(failures, queue_readiness, "disabledCount", "queue readiness must count disabled queue items")
    require_contains(failures, queue_readiness, "level", "queue readiness must produce a level")
    require_contains(failures, queue_readiness, "firstBlockingMessage", "queue readiness must expose first blocking message")

    required_gap_categories = [
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
    ]
    for category in required_gap_categories:
        require_contains(
            failures,
            readiness_gap,
            f'category: "{category}"',
            f"readinessGapForMessage must classify {category}",
        )
    require_contains(
        failures,
        readiness_bucket,
        "item.category || readinessGapForMessage(item.message).category",
        "readinessBucketSummary must use stable categories instead of only matching message text",
    )
    require_contains(failures, readiness_bucket, 'category === "missing_asset"', "readiness buckets must count missing assets by category")
    require_contains(failures, readiness_bucket, 'category === "missing_coordinate"', "readiness buckets must count missing coordinates by category")
    require_contains(failures, readiness_bucket, 'category === "missing_ocr_text"', "readiness buckets must count missing OCR texts by category")
    require_contains(failures, readiness_bucket, 'category === "missing_window"', "readiness buckets must count missing windows by category")
    require_contains(failures, readiness_bucket, 'category === "permission"', "readiness buckets must count permission blockers by category")
    require_contains(failures, readiness_bucket, 'category === "window_identity"', "readiness buckets must count window identity blockers by category")
    require_contains(failures, readiness_bucket, "controlFlowBlocks", "readiness buckets must count control-flow blockers")
    require_contains(failures, readiness_bucket, 'category === "planned_semantic"', "readiness buckets must count planned semantics by category")
    require_contains(failures, readiness_runtime_item, "category: gap.category", "runtime readiness items must store gap category")
    require_contains(failures, readiness_runtime_item, "focusSelector: gap.focusSelector", "runtime readiness items must store focus selector")
    require_contains(failures, workbench_readiness, "selectedWindows()", "workbench readiness must include selected-window state")
    require_contains(failures, workbench_readiness, "currentProcessElevated", "workbench readiness must include admin privilege state")
    require_contains(failures, workbench_readiness, "windowIdentityMismatchReason", "workbench readiness must include window identity state")
    require_contains(failures, workflow_completion, "const gap = readinessGapForMessage(message)", "workflowCompletionState must attach taxonomy metadata")
    require_contains(failures, workflow_completion, "category: gap.category", "workflow completion items must store gap category")
    require_contains(failures, workflow_completion, "focusSelector: gap.focusSelector", "workflow completion items must store focus selector")
    require_contains(failures, workflow_completion, "statusMessage: gap.statusMessage", "workflow completion items must store status message")
    require_contains(failures, workflow_completion_item, "const gap = readinessGapForMessage(message)", "workflow-level completion items must attach taxonomy metadata")
    require_contains(failures, completion_focus, "item.category", "completionFocusSelector must branch on stable categories")
    require_contains(failures, completion_focus, "item.focusSelector", "completionFocusSelector must use taxonomy focus selectors")
    require_contains(failures, completion_status, "item.statusMessage", "completionStatusMessage must use taxonomy status text")

    require_contains(failures, render_overview, "queueReadinessSummary(assignment)", "queue overview must use queue readiness")
    require_contains(failures, render_overview, "readiness-pill", "queue overview must render a readiness pill")
    require_contains(failures, render_overview, "runnableEntries", "queue overview must count runnable entries, not raw queue length")

    require_contains(failures, render_assignments, "queueReadinessSummary(assignment)", "assignment list must use queue readiness")
    require_contains(failures, render_assignments, "workflowReadinessSummary(workflow)", "queue items must show per-workflow readiness")
    require_contains(failures, render_assignments, "任务丢失", "queue items must flag deleted workflow references")
    require_contains(failures, render_assignments, "readiness-pill", "assignment list must render readiness pills")

    forbidden_clone_fields = ["hwnd", "title", "processId", "windowIdentity", "display"]
    for field in forbidden_clone_fields:
        if re.search(rf"\b{field}\s*:", clone_queue):
            failures.append(f"cloneQueueItems must not clone window identity field: {field}")
    if re.search(r"\bid\s*:", clone_queue):
        failures.append("cloneQueueItems must not clone source queue item ids")
    require_contains(
        failures,
        clone_queue,
        "addedAt: new Date().toISOString()",
        "cloneQueueItems must stamp copied queue items with a fresh addedAt",
    )

    require_contains(failures, copy_queue, "cloneQueueItems(sourceAssignment?.queue || [])", "copy queue must clone source queue items")
    require_contains(
        failures,
        copy_queue,
        "String(target.hwnd) !== String(source?.hwnd)",
        "copy queue must skip the source window",
    )
    require_contains(failures, copy_queue, "ensureAssignment(target)", "copy queue must rebuild assignment for each target")
    require_contains(failures, copy_queue, "assignment.queue = cloneQueueItems(sourceQueue)", "copy queue must clone into targets")
    if re.search(r"\bwindowIdentity\s*=", copy_queue):
        failures.append("copyActiveQueueToSelectedWindows must not assign source windowIdentity")

    require_contains(failures, exercise_queue, "exerciseSuiteQueuePattern", "exercise suite must use varied queue sizes")
    require_contains(failures, exercise_queue, "targetIndex * staggerMs", "exercise suite must stagger first task per window")
    require_contains(failures, exercise_queue, "afterDelayMs: gapMs", "exercise suite must preserve per-task gap")
    require_contains(failures, exercise_queue, "ensureAssignment(target)", "exercise suite must create per-window assignments")

    require_contains(failures, selected_editable, "isQueueLocked(target.hwnd)", "queue editing must skip locked running windows")
    require_contains(failures, update_queue, "isQueueLocked(hwnd)", "queue item edits must respect running lock")
    require_contains(failures, update_timing, "isQueueLocked(hwnd)", "queue timing edits must respect running lock")

    require_contains(
        failures,
        run_selected,
        "windowIdentityMismatchReason(assignment.windowIdentity, windowIdentityForTarget(target))",
        "runSelected must verify assignment identity before queued run",
    )
    require_contains(failures, run_selected, "validateWorkflowQueue(workflows, mode)", "runSelected must validate each queue")
    require_contains(failures, run_selected, "startRunForWindow(target, runEntries, mode, source)", "runSelected must start per target")

    require_contains(failures, start_run, "isActiveSession(state.sessions[key])", "startRunForWindow must enforce same-hwnd lock")
    require_contains(failures, start_run, "currentWindowIdentityForRun(target, mode)", "startRunForWindow must refresh identity")
    require_contains(failures, start_run, "queuePlan", "startRunForWindow must record queue plan")
    require_contains(failures, start_run, "void runSession(session, runPlan)", "startRunForWindow must launch independent session")
    require_contains(
        failures,
        start_run,
        "JSON.parse(JSON.stringify(entry.workflow))",
        "startRunForWindow must deep-copy queued workflows before async execution",
    )

    require_contains(failures, active_runs, "isActiveSession(session)", "activeRunSessions must treat running and paused sessions as active")
    require_contains(failures, pause_runs, "pauseRequested = true", "pauseRuns must request a session pause")
    require_contains(
        failures,
        pause_runs,
        "暂停请求已提交",
        "pauseRuns must report a pending pause instead of pretending an in-flight backend step is already paused",
    )
    require_contains(failures, resume_runs, "resumeSession(session)", "resumeRuns must resume paused sessions")
    require_contains(failures, set_paused, 'phase: "pause"', "setSessionPaused must record a pause queue event")
    require_contains(failures, set_paused, 'status = "paused"', "setSessionPaused must expose paused status")
    require_contains(failures, close_pause, "pausedDurationMs", "closePauseEvent must accumulate paused duration")
    require_contains(failures, close_pause, "activePauseEvent", "closePauseEvent must close the active pause event")
    require_contains(failures, resume_session, 'phase: "resume"', "resumeSession must record a resume queue event")
    require_contains(failures, resume_session, "closePauseEvent(session", "resumeSession must close and account for paused duration")
    require_contains(failures, resume_session, 'recordRunEvent(session, "resume"', "resumeSession must append a resume run event")
    require_contains(failures, record_run_event, "MAX_SESSION_RUN_EVENTS", "recordRunEvent must bound retained run events")
    require_contains(failures, record_run_event, "runEventSerial", "recordRunEvent must keep stable event order")
    require_contains(failures, record_run_event, "session.runEvents.push(event)", "recordRunEvent must append run events")
    require_contains(failures, wait_paused, "while (!session.cancelRequested && session.pauseRequested)", "waitIfPaused must block until resume or stop")
    require_contains(failures, wait_paused, "setSessionPaused(session", "waitIfPaused must enter the paused state")
    require_contains(failures, sync_buttons, "#pause-runs", "syncRunActionButtons must control pause button state")
    require_contains(failures, sync_buttons, "#resume-runs", "syncRunActionButtons must control resume button state")
    require_contains(failures, stop_runs, "isActiveSession(session)", "stopDryRun must stop paused sessions too")
    require_contains(failures, stop_runs, "pauseRequested = false", "stopDryRun must break paused waits")
    require_contains(failures, source, "waitIfPaused(session, workflow", "runner must check pause gates with workflow context")
    require_contains(failures, source, "cancellableSleep(session, ms, { workflow, phase })", "queue delays must be pause-aware")
    require_contains(failures, source, "cancellableSleep(session, ms, { workflow, item, phase: key })", "step delays must be pause-aware")
    require_contains(failures, source, "cancellableSleep(session, backgroundRetryDelay(item), { item, phase: \"retry_wait\" })", "retry waits must be pause-aware")
    require_contains(failures, source, "pauseRequested: false", "sessions must initialize pauseRequested")
    require_contains(failures, source, "pausedDurationMs: 0", "sessions must initialize pausedDurationMs")
    require_contains(failures, source, "pauseCount: 0", "sessions must initialize pauseCount")
    require_contains(failures, source, "runEvents: []", "sessions must initialize append-only run events")
    require_contains(failures, source, 'recordRunEvent(session, "session_start"', "runner must record session start events")
    require_contains(failures, source, 'recordRunEvent(session, "workflow_start"', "runner must record workflow start events")
    require_contains(failures, source, 'recordRunEvent(session, "step_start"', "runner must record step start events")
    require_contains(failures, source, 'recordRunEvent(session, "step_result"', "runner must record step result events")
    require_contains(failures, source, 'recordRunEvent(session, "control_flow"', "runner must record control-flow events")
    require_contains(failures, source, 'recordRunEvent(session, "task_jump"', "runner must record task jump events")
    require_contains(failures, source, 'recordRunEvent(session, "session_end"', "runner must record session end events")
    require_contains(failures, index_html, 'id="pause-runs"', "index.html must expose a pause button")
    require_contains(failures, index_html, 'id="resume-runs"', "index.html must expose a resume button")

    require_contains(
        failures,
        execute_backend,
        "hwnd: Number(session.hwnd)",
        "executeBackendStep must send the target hwnd to Rust",
    )
    require_contains(
        failures,
        execute_backend,
        "expectedWindow: session.windowIdentity || null",
        "executeBackendStep must send the startup identity snapshot to Rust",
    )

    require_contains(failures, run_history, "queuePlan: session.queuePlan", "run history must keep queue plan")
    require_contains(failures, run_history, "queueEvents: session.queueEvents", "run history must keep queue delay events")
    require_contains(failures, run_history, "runEvents:", "run history must keep append-only event evidence")
    require_contains(failures, run_history, "MAX_SESSION_RUN_EVENTS", "run history must bound copied run events")
    require_contains(failures, run_history, "pauseCount: session.pauseCount", "run history must keep pause count")
    require_contains(failures, run_history, "pausedDurationMs: session.pausedDurationMs", "run history must keep paused duration")
    require_contains(failures, run_history, "pauseEvents:", "run history must keep explicit pause/resume events")
    require_contains(failures, run_history, "runEvents:", "run history must keep ordered runtime events")
    require_contains(
        failures,
        run_history,
        "controlFlowTransitions:",
        "run history must keep control-flow transition evidence",
    )
    require_contains(failures, run_history, "windowIdentity: session.windowIdentity", "run history must keep startup identity")
    require_contains(
        failures,
        run_history,
        "endedWindowIdentity: session.endedWindowIdentity",
        "run history must keep ended identity evidence",
    )
    require_contains(
        failures,
        source,
        "expandedFailureReportIds: new Set()",
        "failure report detail expansion must stay as UI-only state",
    )
    require_contains(
        failures,
        render_reports,
        'data-report-action="toggle"',
        "failure reports must expose an expand/collapse detail action",
    )
    require_contains(
        failures,
        render_reports,
        "failureReportDetailHtml(report, failedStep, identity)",
        "failure reports must render structured detail when expanded",
    )
    for token in ["queuePlan", "queueEvents", "runEvents", "controlFlowTransitions", "pauseEvents", "stepResults"]:
        require_contains(
            failures,
            report_detail,
            token,
            f"expanded failure report detail must include {token} evidence",
        )
    require_contains(
        failures,
        toggle_report,
        "state.expandedFailureReportIds",
        "failure report detail toggle must use UI-only expansion state",
    )
    require_contains(
        failures,
        toggle_report,
        "renderFailureReports()",
        "failure report detail toggle must rerender reports",
    )

    require_regex(failures, css, r"\.queue-overview-row\.(ready|warning|blocked)", "CSS must style queue overview readiness")
    require_regex(failures, css, r"\.queue-window\.(ready|warning|blocked)", "CSS must style queue window readiness")
    require_regex(failures, css, r"\.queue-item\.(ready|warning|blocked)", "CSS must style queue item readiness")
    require_contains(failures, css, ".state-pill.paused", "CSS must style paused run-state pill")
    require_contains(failures, css, ".session-lane.paused", "CSS must style paused session lanes")
    require_contains(failures, css, ".failure-report-detail", "CSS must style expanded failure report details")
    require_contains(failures, css, "grid-column: 2 / -1", "queue item detail must occupy a stable row")

    scripts = package.get("scripts", {})
    if scripts.get("audit:queue-readiness") != "python scripts/audit_queue_readiness.py":
        failures.append("package.json must expose audit:queue-readiness")

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
