#!/usr/bin/env python3
"""Audit that runtime input stays hwnd-targeted and does not use real mouse APIs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


DEFAULT_INCLUDE = ["index.html", "src-tauri/src", "src", "scripts"]
FORBIDDEN_TOKENS = [
    "SendInput",
    "SetCursorPos",
    "mouse_event",
    "keybd_event",
    "pyautogui",
    "pynput",
    "win32api.SetCursorPos",
    "win32api.mouse_event",
    "AttachThreadInput",
    "SwitchToThisWindow",
    "SetActiveWindow",
    "SendMessageW(",
]
HWND_TOKENS = [
    "PostMessageW",
    "WM_LBUTTONDBLCLK",
    "WM_LBUTTONDOWN",
    "WM_LBUTTONUP",
    "WM_RBUTTONDBLCLK",
    "WM_RBUTTONDOWN",
    "WM_RBUTTONUP",
    "WM_MOUSEMOVE",
    "WM_KEYDOWN",
    "WM_KEYUP",
    "WM_SYSKEYDOWN",
    "WM_SYSKEYUP",
    "WM_CHAR",
]
FOCUS_TOKENS = [
    "SetForegroundWindow",
    "BringWindowToTop",
    "ShowWindow",
]
IDENTITY_TOKENS = [
    "ExpectedWindowInput",
    "validate_expected_window",
    "window_for_hwnd",
    "expectedWindow",
    "windowIdentity",
    "expected_window: Option<&ExpectedWindowInput>",
    "validate_expected_window(hwnd, expected_window)?",
]
IDENTITY_REQUIRED_TOKENS = [
    "current_window_identity",
    "currentWindowIdentityForRun",
    "validate_expected_window_argument",
    "expected window identity must include hwnd",
    "hwnd argument",
    "requiredBackgroundWindowIdentityIssue",
    "窗口身份不完整",
]
IMAGE_CLICK_RECHECK_TOKENS = [
    "validate_expected_window(hwnd, expected_window)?;",
]
IMAGE_CLICK_RECHECK_PATTERNS = [
    (
        "image_click dispatch passes expected_window",
        '"image_click"=>{dispatch_image_step(hwnd,&step,MouseDispatchMode::Click,expected_window)}',
    ),
    (
        "template image_click revalidates before click",
        "ifmode.sends_input()&&matched.score>=threshold{validate_expected_window(hwnd,expected_window)?;letresult=matchmode",
    ),
    (
        "roi image_click revalidates before click",
        "ifmode.sends_input(){validate_expected_window(hwnd,expected_window)?;letresult=matchmode",
    ),
]
TARGET_TOKENS = [
    "targets",
    "targetId",
    "targetDataUrl",
    "normalizeTarget",
    "targetForStep",
    "targetUsages",
    "deleteSelectedTarget",
    "unbindStepTarget",
]
TARGET_CRUD_TOKENS = [
    "target-search",
    "target-kind-filter",
    "target-editor",
    "selectedTargetId",
    "bindTargetEditor",
    "renderTargetEditor",
    "targetUsages",
    "deleteSelectedTarget",
    "unbindCurrentStepTarget",
]
STEP_EDIT_TOKENS = [
    "insert-step-below",
    "duplicate-step",
    "step-block-preset",
    "insert-step-block",
    "$(\"#insert-step-below\").addEventListener",
    "$(\"#duplicate-step\").addEventListener",
    "$(\"#insert-step-block\").addEventListener",
    "insertStepBelowSelected",
    "duplicateSelectedStep",
    "cloneStepForInsert",
    "stepBlockPresets",
    "insertStepBlock",
    "insertStepsAt",
    "ensureTargetsForSteps",
    "selectFirstUnboundCapturedStep",
    "selectNextUnboundCapturedStepAfter",
]
STEP_VALIDATION_TOKENS = [
    "stepValidation",
    "buildStepValidationIndex",
    "firstIssueStepId",
    "step-validation-detail",
    "renderStepValidationDetails",
    "step-badge",
    ".step-badge.issue",
    ".step-badge.warning",
]
TARGET_FILTER_UI_TOKENS = [
    "ensureSelectedTarget(filteredTargets",
    "targetThumbLabel",
    "待贴图",
]
TARGET_PORTABILITY_TOKENS = [
    "export-target-library",
    "import-target-library",
    "targetLibraryExportPayload",
    "TARGET_LIBRARY_KIND",
    "targetLibraryTargetsFromPayload",
    "mergeImportedTargetLibrary",
    "mergeImportedTargetIntoExisting",
    "targetNoteIsGeneric",
    "目标库已导出",
    "目标库已合并",
]
PASTE_AUTO_STEP_TOKENS = [
    "capturedImageStepTypes",
    "ensureCapturedTargetStep",
    "saveTargetForStep",
    "isStepBlockPlaceholderTarget",
    "insertStepAt",
    "bindTargetToStep(destination.step",
]
CLIPBOARD_FALLBACK_TOKENS = [
    "import_clipboard_image",
    "read_clipboard_rgb_frame",
    "CF_DIBV5",
    "CF_DIB",
    "dib_to_rgb_frame",
    "后端剪贴板图片导入失败",
    "由 Ctrl+V 后端剪贴板导入创建",
]
RUNNER_SEMANTIC_TOKENS = [
    "backgroundStepDelay",
    "executeRetryUntilStep",
    "retryUntilHasVisualTarget",
    "terminalBackendStatuses",
    "backgroundFailureStatuses",
    "plannedOnlyStepTypes",
    "status: \"missing_asset\"",
    "type: \"wait_image\"",
]
LOOP_SEMANTIC_TOKENS = [
    "item.type === \"loop\"",
    "action: \"loop\"",
    "bounded loop requested",
    "inputSent: false",
    "matched: false",
    "循环步骤必须设置最大循环次数",
    "循环目标应指向当前步骤之前的步骤",
    "循环目标必须位于当前步骤之前",
]
STEP_TIMING_TOKENS = [
    "param-pre-delay-ms",
    "param-post-delay-ms",
    "commandWithDelayValue",
    "commandDurationMs",
    "runStepDelay",
    "stepTimingDelay",
    "withStepTimingDetail",
    "preDelay",
    "postDelay",
]
IMAGE_CLICK_POINT_TOKENS = [
    "imageClickPointOptions",
    "param-image-point",
    "param-image-offset-x",
    "param-image-offset-y",
    "image_click_point",
    "point_from_step_with_offset",
    "point_with_command_offset",
    "command_i32_value",
    "offsetX",
    "offsetY",
]
COMPLETION_BOARD_TOKENS = [
    "workflow-completion",
    "completion-list",
    "focus-next-gap",
    "workflowCompletionState",
    "renderWorkflowCompletion",
    "focusNextCompletionGap",
    ".completion-board",
    ".completion-item.issue",
]
WORKFLOW_BLUEPRINT_TOKENS = [
    "workflow-blueprint-select",
    "workflow-batch-count",
    "workflow-name-prefix",
    "create-workflow-from-blueprint",
    "create-and-assign-blueprint",
    "workflowBlueprints",
    "fillWorkflowBlueprintSelect",
    "workflowBlueprintById",
    "createWorkflowFromBlueprint",
    "createWorkflowBatch",
    "ensureTargetsForSteps(workflow.steps",
    "selectFirstUnboundCapturedStep",
    ".workflow-wizard",
]
WORKFLOW_DUPLICATE_TARGET_TOKENS = [
    "cloneWorkflowTargetForDuplicate",
    "targetIdMap",
    "已克隆",
]
BATCH_QUEUE_TOKENS = [
    "batch-queue-panel",
    "queue-workflow-picker",
    "append-picked-workflows",
    "copy-active-queue-to-selected",
    "clear-selected-queues",
    "selectedWorkflowIdsForQueue",
    "appendWorkflowIdsToTargets",
    "copyActiveQueueToSelectedWindows",
    "clearSelectedQueues",
    "cloneQueueItems",
    "selectedEditableWindows",
    "isQueueLocked",
    "window.confirm",
    ".batch-queue-panel",
    ".queue-action-grid",
]
QUEUE_TIMING_TOKENS = [
    "queue-stagger-ms",
    "queue-gap-ms",
    "queueTimingOptions",
    "startDelayMs",
    "afterDelayMs",
    "queueRunEntriesForTarget",
    "queuePlan",
    "queueEvents",
    "runQueueDelay",
    "cancellableSleep",
    ".queue-timing-grid",
    ".queue-item-timing",
]
OCR_CONTRACT_TOKENS = [
    "dispatch_ocr_step",
    "recognize_ocr_text",
    "OcrEngine",
    "RecognizeAsync",
    "target_texts",
    "targetTexts",
    "ocrExpectedTextsForStep",
    "validateOcrStepRuntimeFields",
    "ocr_unavailable",
    "text_miss",
]
UI_STABILITY_TOKENS = [
    "MAX_LOG_ROWS",
    "log.children.length > MAX_LOG_ROWS",
    "element.classList.add(value)",
    ".state-pill.running",
    ".session-lane.failed",
]
RUN_REPORT_TOKENS = [
    "MAX_SESSION_STEP_RESULTS",
    "current_window_identity",
    "recordSessionStepResult",
    "attachEndedWindowIdentity",
    "runHistoryEntryFromSession",
    "endedWindowIdentity",
    "endedWindowIdentityError",
    "controlFlowTransitions",
    "recordControlFlowTransition",
    "stepResults",
    "renderRunHistory",
    ".session-lane.history",
]
TEXT_INPUT_TOKENS = [
    "text_input",
    "post_text",
    "WM_CHAR",
    "dispatch_text_input_step",
    "textInputValueForStep",
    "param-text-value",
    "MAX_TEXT_INPUT_CHARS",
    "mode=hwnd-char",
    "文本输入会向目标 hwnd 投递 WM_CHAR",
]
DOUBLE_CLICK_TOKENS = [
    "double_click",
    "post_mouse_double_click",
    "dispatch_click_step(hwnd, &step, MouseDispatchMode::DoubleClick)",
    "MouseDispatchMode::DoubleClick",
    "WM_LBUTTONDBLCLK",
    "WM_RBUTTONDBLCLK",
    "data-step-types=\"click double_click\"",
    "data-param-for=\"image_click double_click\"",
    "后台双击",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    files = list(iter_source_files(project_root))
    forbidden = scan_tokens(files, FORBIDDEN_TOKENS)
    hwnd = scan_tokens(files, HWND_TOKENS)
    focus = scan_tokens(files, FOCUS_TOKENS)
    identity = scan_tokens(files, IDENTITY_TOKENS)
    identity_required_guard = scan_tokens(files, IDENTITY_REQUIRED_TOKENS)
    image_click_recheck = scan_tokens(files, IMAGE_CLICK_RECHECK_TOKENS)
    image_click_recheck_patterns = scan_collapsed_patterns(files, IMAGE_CLICK_RECHECK_PATTERNS)
    targets = scan_tokens(files, TARGET_TOKENS)
    target_crud = scan_tokens(files, TARGET_CRUD_TOKENS)
    target_filter_ui = scan_tokens(files, TARGET_FILTER_UI_TOKENS)
    target_portability = scan_tokens(files, TARGET_PORTABILITY_TOKENS)
    step_edit = scan_tokens(files, STEP_EDIT_TOKENS)
    step_validation = scan_tokens(files, STEP_VALIDATION_TOKENS)
    paste_auto_step = scan_tokens(files, PASTE_AUTO_STEP_TOKENS)
    clipboard_fallback = scan_tokens(files, CLIPBOARD_FALLBACK_TOKENS)
    runner_semantics = scan_tokens(files, RUNNER_SEMANTIC_TOKENS)
    loop_semantics = scan_tokens(files, LOOP_SEMANTIC_TOKENS)
    step_timing = scan_tokens(files, STEP_TIMING_TOKENS)
    image_click_point = scan_tokens(files, IMAGE_CLICK_POINT_TOKENS)
    completion_board = scan_tokens(files, COMPLETION_BOARD_TOKENS)
    workflow_blueprint = scan_tokens(files, WORKFLOW_BLUEPRINT_TOKENS)
    workflow_duplicate_target = scan_tokens(files, WORKFLOW_DUPLICATE_TARGET_TOKENS)
    batch_queue = scan_tokens(files, BATCH_QUEUE_TOKENS)
    queue_timing = scan_tokens(files, QUEUE_TIMING_TOKENS)
    ocr_contract = scan_tokens(files, OCR_CONTRACT_TOKENS)
    ui_stability = scan_tokens(files, UI_STABILITY_TOKENS)
    run_report = scan_tokens(files, RUN_REPORT_TOKENS)
    text_input = scan_tokens(files, TEXT_INPUT_TOKENS)
    double_click = scan_tokens(files, DOUBLE_CLICK_TOKENS)
    identity_required = bool(hwnd)
    identity_seen = {hit["token"] for hit in identity}
    identity_missing = [
        token for token in IDENTITY_TOKENS if identity_required and token not in identity_seen
    ]
    identity_required_guard_seen = {hit["token"] for hit in identity_required_guard}
    identity_required_guard_missing = [
        token
        for token in IDENTITY_REQUIRED_TOKENS
        if identity_required and token not in identity_required_guard_seen
    ]
    image_click_recheck_seen = {hit["token"] for hit in image_click_recheck}
    image_click_recheck_missing = [
        token for token in IMAGE_CLICK_RECHECK_TOKENS if token not in image_click_recheck_seen
    ]
    image_click_recheck_pattern_seen = {hit["token"] for hit in image_click_recheck_patterns}
    image_click_recheck_pattern_missing = [
        token
        for token, _pattern in IMAGE_CLICK_RECHECK_PATTERNS
        if token not in image_click_recheck_pattern_seen
    ]
    target_crud_seen = {hit["token"] for hit in target_crud}
    target_crud_missing = [
        token for token in TARGET_CRUD_TOKENS if token not in target_crud_seen
    ]
    target_filter_ui_seen = {hit["token"] for hit in target_filter_ui}
    target_filter_ui_missing = [
        token for token in TARGET_FILTER_UI_TOKENS if token not in target_filter_ui_seen
    ]
    target_portability_seen = {hit["token"] for hit in target_portability}
    target_portability_missing = [
        token for token in TARGET_PORTABILITY_TOKENS if token not in target_portability_seen
    ]
    step_edit_seen = {hit["token"] for hit in step_edit}
    step_edit_missing = [
        token for token in STEP_EDIT_TOKENS if token not in step_edit_seen
    ]
    step_validation_seen = {hit["token"] for hit in step_validation}
    step_validation_missing = [
        token for token in STEP_VALIDATION_TOKENS if token not in step_validation_seen
    ]
    paste_auto_step_seen = {hit["token"] for hit in paste_auto_step}
    paste_auto_step_missing = [
        token for token in PASTE_AUTO_STEP_TOKENS if token not in paste_auto_step_seen
    ]
    clipboard_fallback_seen = {hit["token"] for hit in clipboard_fallback}
    clipboard_fallback_missing = [
        token for token in CLIPBOARD_FALLBACK_TOKENS if token not in clipboard_fallback_seen
    ]
    runner_semantics_seen = {hit["token"] for hit in runner_semantics}
    runner_semantics_missing = [
        token for token in RUNNER_SEMANTIC_TOKENS if token not in runner_semantics_seen
    ]
    loop_semantics_seen = {hit["token"] for hit in loop_semantics}
    loop_semantics_missing = [
        token for token in LOOP_SEMANTIC_TOKENS if token not in loop_semantics_seen
    ]
    step_timing_seen = {hit["token"] for hit in step_timing}
    step_timing_missing = [
        token for token in STEP_TIMING_TOKENS if token not in step_timing_seen
    ]
    image_click_point_seen = {hit["token"] for hit in image_click_point}
    image_click_point_missing = [
        token for token in IMAGE_CLICK_POINT_TOKENS if token not in image_click_point_seen
    ]
    completion_board_seen = {hit["token"] for hit in completion_board}
    completion_board_missing = [
        token for token in COMPLETION_BOARD_TOKENS if token not in completion_board_seen
    ]
    workflow_blueprint_seen = {hit["token"] for hit in workflow_blueprint}
    workflow_blueprint_missing = [
        token for token in WORKFLOW_BLUEPRINT_TOKENS if token not in workflow_blueprint_seen
    ]
    workflow_duplicate_target_seen = {hit["token"] for hit in workflow_duplicate_target}
    workflow_duplicate_target_missing = [
        token
        for token in WORKFLOW_DUPLICATE_TARGET_TOKENS
        if token not in workflow_duplicate_target_seen
    ]
    batch_queue_seen = {hit["token"] for hit in batch_queue}
    batch_queue_missing = [
        token for token in BATCH_QUEUE_TOKENS if token not in batch_queue_seen
    ]
    queue_timing_seen = {hit["token"] for hit in queue_timing}
    queue_timing_missing = [
        token for token in QUEUE_TIMING_TOKENS if token not in queue_timing_seen
    ]
    ocr_contract_seen = {hit["token"] for hit in ocr_contract}
    ocr_contract_missing = [
        token for token in OCR_CONTRACT_TOKENS if token not in ocr_contract_seen
    ]
    ui_stability_seen = {hit["token"] for hit in ui_stability}
    ui_stability_missing = [
        token for token in UI_STABILITY_TOKENS if token not in ui_stability_seen
    ]
    run_report_seen = {hit["token"] for hit in run_report}
    run_report_missing = [
        token for token in RUN_REPORT_TOKENS if token not in run_report_seen
    ]
    text_input_seen = {hit["token"] for hit in text_input}
    text_input_missing = [
        token for token in TEXT_INPUT_TOKENS if token not in text_input_seen
    ]
    double_click_seen = {hit["token"] for hit in double_click}
    double_click_missing = [
        token for token in DOUBLE_CLICK_TOKENS if token not in double_click_seen
    ]
    report = {
        "version": 1,
        "projectRoot": str(project_root),
        "scannedFiles": len(files),
        "forbiddenTokens": forbidden,
        "hwndInputEvidence": hwnd,
        "focusAffectingEvidence": focus,
        "identityCheckEvidence": identity,
        "identityCheckRequired": identity_required,
        "identityCheckMissing": identity_missing,
        "identityRequiredGuardEvidence": identity_required_guard,
        "identityRequiredGuardMissing": identity_required_guard_missing,
        "imageClickRecheckEvidence": image_click_recheck,
        "imageClickRecheckMissing": image_click_recheck_missing,
        "imageClickRecheckPatternEvidence": image_click_recheck_patterns,
        "imageClickRecheckPatternMissing": image_click_recheck_pattern_missing,
        "targetLibraryEvidence": targets,
        "targetCrudEvidence": target_crud,
        "targetCrudMissing": target_crud_missing,
        "targetFilterUiEvidence": target_filter_ui,
        "targetFilterUiMissing": target_filter_ui_missing,
        "targetPortabilityEvidence": target_portability,
        "targetPortabilityMissing": target_portability_missing,
        "stepEditEvidence": step_edit,
        "stepEditMissing": step_edit_missing,
        "stepValidationEvidence": step_validation,
        "stepValidationMissing": step_validation_missing,
        "pasteAutoStepEvidence": paste_auto_step,
        "pasteAutoStepMissing": paste_auto_step_missing,
        "clipboardFallbackEvidence": clipboard_fallback,
        "clipboardFallbackMissing": clipboard_fallback_missing,
        "runnerSemanticEvidence": runner_semantics,
        "runnerSemanticMissing": runner_semantics_missing,
        "loopSemanticEvidence": loop_semantics,
        "loopSemanticMissing": loop_semantics_missing,
        "stepTimingEvidence": step_timing,
        "stepTimingMissing": step_timing_missing,
        "imageClickPointEvidence": image_click_point,
        "imageClickPointMissing": image_click_point_missing,
        "completionBoardEvidence": completion_board,
        "completionBoardMissing": completion_board_missing,
        "workflowBlueprintEvidence": workflow_blueprint,
        "workflowBlueprintMissing": workflow_blueprint_missing,
        "workflowDuplicateTargetEvidence": workflow_duplicate_target,
        "workflowDuplicateTargetMissing": workflow_duplicate_target_missing,
        "batchQueueEvidence": batch_queue,
        "batchQueueMissing": batch_queue_missing,
        "queueTimingEvidence": queue_timing,
        "queueTimingMissing": queue_timing_missing,
        "ocrContractEvidence": ocr_contract,
        "ocrContractMissing": ocr_contract_missing,
        "uiStabilityEvidence": ui_stability,
        "uiStabilityMissing": ui_stability_missing,
        "runReportEvidence": run_report,
        "runReportMissing": run_report_missing,
        "textInputEvidence": text_input,
        "textInputMissing": text_input_missing,
        "doubleClickEvidence": double_click,
        "doubleClickMissing": double_click_missing,
        "passed": (
            not forbidden
            and not focus
            and not identity_missing
            and not identity_required_guard_missing
            and not image_click_recheck_missing
            and not image_click_recheck_pattern_missing
            and not target_crud_missing
            and not target_filter_ui_missing
            and not target_portability_missing
            and not step_edit_missing
            and not step_validation_missing
            and not paste_auto_step_missing
            and not clipboard_fallback_missing
            and not runner_semantics_missing
            and not loop_semantics_missing
            and not step_timing_missing
            and not image_click_point_missing
            and not completion_board_missing
            and not workflow_blueprint_missing
            and not workflow_duplicate_target_missing
            and not batch_queue_missing
            and not queue_timing_missing
            and not ocr_contract_missing
            and not ui_stability_missing
            and not run_report_missing
            and not text_input_missing
            and not double_click_missing
        ),
        "note": (
            "Forbidden tokens indicate real cursor/keyboard injection risk. "
            "Focus-affecting APIs indicate foreground-control risk. "
            "hwndInputEvidence may be empty when this build has no runtime input dispatcher. "
            "When hwnd input exists, expectedWindow identity evidence must also be present. "
            "expectedWindow.hwnd must be required and checked before dispatch. "
            "image_click must recheck expectedWindow after matching and before posting a click. "
            "Step editing, validation badge, paste-to-step, clipboard fallback, runner semantic, loop semantic, step timing, image click point controls, workflow blueprint, independent workflow duplicate targets, target library import/export, batch queue, queue timing, run report, text input, double click, and UI stability tokens catch visible UI or modeled-step regressions."
        ),
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"scannedFiles={report['scannedFiles']}")
        print(f"forbiddenTokens={len(forbidden)}")
        print(f"hwndInputEvidence={len(hwnd)}")
        print(f"focusAffectingEvidence={len(focus)}")
        print(f"identityCheckEvidence={len(identity)}")
        print(f"identityCheckMissing={len(identity_missing)}")
        print(f"identityRequiredGuardEvidence={len(identity_required_guard)}")
        print(f"identityRequiredGuardMissing={len(identity_required_guard_missing)}")
        print(f"imageClickRecheckEvidence={len(image_click_recheck)}")
        print(f"imageClickRecheckMissing={len(image_click_recheck_missing)}")
        print(f"imageClickRecheckPatternEvidence={len(image_click_recheck_patterns)}")
        print(f"imageClickRecheckPatternMissing={len(image_click_recheck_pattern_missing)}")
        print(f"targetLibraryEvidence={len(targets)}")
        print(f"targetCrudEvidence={len(target_crud)}")
        print(f"targetCrudMissing={len(target_crud_missing)}")
        print(f"targetFilterUiEvidence={len(target_filter_ui)}")
        print(f"targetFilterUiMissing={len(target_filter_ui_missing)}")
        print(f"targetPortabilityEvidence={len(target_portability)}")
        print(f"targetPortabilityMissing={len(target_portability_missing)}")
        print(f"stepEditEvidence={len(step_edit)}")
        print(f"stepEditMissing={len(step_edit_missing)}")
        print(f"stepValidationEvidence={len(step_validation)}")
        print(f"stepValidationMissing={len(step_validation_missing)}")
        print(f"pasteAutoStepEvidence={len(paste_auto_step)}")
        print(f"pasteAutoStepMissing={len(paste_auto_step_missing)}")
        print(f"clipboardFallbackEvidence={len(clipboard_fallback)}")
        print(f"clipboardFallbackMissing={len(clipboard_fallback_missing)}")
        print(f"runnerSemanticEvidence={len(runner_semantics)}")
        print(f"runnerSemanticMissing={len(runner_semantics_missing)}")
        print(f"loopSemanticEvidence={len(loop_semantics)}")
        print(f"loopSemanticMissing={len(loop_semantics_missing)}")
        print(f"stepTimingEvidence={len(step_timing)}")
        print(f"stepTimingMissing={len(step_timing_missing)}")
        print(f"imageClickPointEvidence={len(image_click_point)}")
        print(f"imageClickPointMissing={len(image_click_point_missing)}")
        print(f"completionBoardEvidence={len(completion_board)}")
        print(f"completionBoardMissing={len(completion_board_missing)}")
        print(f"workflowBlueprintEvidence={len(workflow_blueprint)}")
        print(f"workflowBlueprintMissing={len(workflow_blueprint_missing)}")
        print(f"workflowDuplicateTargetEvidence={len(workflow_duplicate_target)}")
        print(f"workflowDuplicateTargetMissing={len(workflow_duplicate_target_missing)}")
        print(f"batchQueueEvidence={len(batch_queue)}")
        print(f"batchQueueMissing={len(batch_queue_missing)}")
        print(f"queueTimingEvidence={len(queue_timing)}")
        print(f"queueTimingMissing={len(queue_timing_missing)}")
        print(f"ocrContractEvidence={len(ocr_contract)}")
        print(f"ocrContractMissing={len(ocr_contract_missing)}")
        print(f"uiStabilityEvidence={len(ui_stability)}")
        print(f"uiStabilityMissing={len(ui_stability_missing)}")
        print(f"runReportEvidence={len(run_report)}")
        print(f"runReportMissing={len(run_report_missing)}")
        print(f"textInputEvidence={len(text_input)}")
        print(f"textInputMissing={len(text_input_missing)}")
        print(f"doubleClickEvidence={len(double_click)}")
        print(f"doubleClickMissing={len(double_click_missing)}")
        if forbidden:
            for hit in forbidden:
                print(f"FORBIDDEN {hit['path']}:{hit['line']} {hit['token']}")
        if focus:
            for hit in focus:
                print(f"FORBIDDEN_FOCUS {hit['path']}:{hit['line']} {hit['token']}")
        if identity_missing:
            for token in identity_missing:
                print(f"MISSING_IDENTITY {token}")
        if image_click_recheck_missing:
            for token in image_click_recheck_missing:
                print(f"MISSING_IMAGE_CLICK_RECHECK {token}")
        if image_click_recheck_pattern_missing:
            for token in image_click_recheck_pattern_missing:
                print(f"MISSING_IMAGE_CLICK_RECHECK_PATTERN {token}")
        if clipboard_fallback_missing:
            for token in clipboard_fallback_missing:
                print(f"MISSING_CLIPBOARD_FALLBACK {token}")
        if target_crud_missing:
            for token in target_crud_missing:
                print(f"MISSING_TARGET_CRUD {token}")
        if target_filter_ui_missing:
            for token in target_filter_ui_missing:
                print(f"MISSING_TARGET_FILTER_UI {token}")
        if target_portability_missing:
            for token in target_portability_missing:
                print(f"MISSING_TARGET_PORTABILITY {token}")
        if step_edit_missing:
            for token in step_edit_missing:
                print(f"MISSING_STEP_EDIT {token}")
        if step_validation_missing:
            for token in step_validation_missing:
                print(f"MISSING_STEP_VALIDATION {token}")
        if paste_auto_step_missing:
            for token in paste_auto_step_missing:
                print(f"MISSING_PASTE_AUTO_STEP {token}")
        if runner_semantics_missing:
            for token in runner_semantics_missing:
                print(f"MISSING_RUNNER_SEMANTIC {token}")
        if loop_semantics_missing:
            for token in loop_semantics_missing:
                print(f"MISSING_LOOP_SEMANTIC {token}")
        if step_timing_missing:
            for token in step_timing_missing:
                print(f"MISSING_STEP_TIMING {token}")
        if image_click_point_missing:
            for token in image_click_point_missing:
                print(f"MISSING_IMAGE_CLICK_POINT {token}")
        if completion_board_missing:
            for token in completion_board_missing:
                print(f"MISSING_COMPLETION_BOARD {token}")
        if workflow_blueprint_missing:
            for token in workflow_blueprint_missing:
                print(f"MISSING_WORKFLOW_BLUEPRINT {token}")
        if workflow_duplicate_target_missing:
            for token in workflow_duplicate_target_missing:
                print(f"MISSING_WORKFLOW_DUPLICATE_TARGET {token}")
        if batch_queue_missing:
            for token in batch_queue_missing:
                print(f"MISSING_BATCH_QUEUE {token}")
        if queue_timing_missing:
            for token in queue_timing_missing:
                print(f"MISSING_QUEUE_TIMING {token}")
        if ocr_contract_missing:
            for token in ocr_contract_missing:
                print(f"MISSING_OCR_CONTRACT {token}")
        if ui_stability_missing:
            for token in ui_stability_missing:
                print(f"MISSING_UI_STABILITY {token}")
        if run_report_missing:
            for token in run_report_missing:
                print(f"MISSING_RUN_REPORT {token}")
        if text_input_missing:
            for token in text_input_missing:
                print(f"MISSING_TEXT_INPUT {token}")
        if double_click_missing:
            for token in double_click_missing:
                print(f"MISSING_DOUBLE_CLICK {token}")
    return 0 if report["passed"] else 2


def iter_source_files(project_root: Path):
    suffixes = {".rs", ".py", ".js", ".ts", ".html", ".css", ".json", ".ps1"}
    ignored_dirs = {"node_modules", "dist", "target", "__pycache__"}
    self_path = Path(__file__).resolve()
    for include in DEFAULT_INCLUDE:
        root = project_root / include
        if not root.exists():
            continue
        if root.is_file():
            if root.suffix.lower() in suffixes and root.resolve() != self_path:
                yield root
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in suffixes:
                continue
            if path.resolve() == self_path:
                continue
            if any(part in ignored_dirs for part in path.parts):
                continue
            yield path


def scan_tokens(paths: list[Path], tokens: list[str]) -> list[dict[str, object]]:
    hits: list[dict[str, object]] = []
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        for line_no, line in enumerate(lines, start=1):
            for token in tokens:
                if token in line:
                    hits.append(
                        {
                            "path": str(path),
                            "line": line_no,
                            "token": token,
                            "text": line.strip()[:240],
                        }
                    )
    return hits


def scan_collapsed_patterns(
    paths: list[Path], patterns: list[tuple[str, str]]
) -> list[dict[str, object]]:
    hits: list[dict[str, object]] = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = path.read_text(encoding="utf-8", errors="ignore")
        collapsed = "".join(text.split())
        for token, pattern in patterns:
            if pattern in collapsed:
                hits.append(
                    {
                        "path": str(path),
                        "line": 0,
                        "token": token,
                        "text": pattern[:240],
                    }
                )
    return hits


if __name__ == "__main__":
    raise SystemExit(main())
