import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  compareNumbers as compareNumbersCore,
  completeRecoveryAsFailed as completeRecoveryAsFailedCore,
  completeRecoveryWithPolicy as completeRecoveryWithPolicyCore,
  controlFlowDecisionForStep as controlFlowDecisionForStepCore,
  evaluateConditionGuard as evaluateConditionGuardCore,
  failureReasonFromResult as failureReasonFromResultCore,
  insertWorkflowJumpIntoRunPlan as insertWorkflowJumpIntoRunPlanCore,
  isSuccessfulStepResult as isSuccessfulStepResultCore,
  recordControlFlowTransition as recordControlFlowTransitionCore,
  recoveryDecisionForFailedStep as recoveryDecisionForFailedStepCore,
  normalizeRecoveryAction as normalizeRecoveryActionCore,
  stepLabelForExecution as stepLabelForExecutionCore,
  unboundedWorkflowJumpCycleFindings,
} from "./control-flow-core.js";
import {
  mergeImportedTargetLibrary as mergeImportedTargetLibraryCore,
  normalizeTarget as normalizeTargetCore,
  targetLibraryExportPayload as targetLibraryExportPayloadCore,
  targetLibraryTargetsFromPayload as targetLibraryTargetsFromPayloadCore,
} from "./target-library-core.js";
import {
  createManualConfirmation,
  manualConfirmationStatus,
  manualConfirmationStatusForStep,
  manualConfirmationStatusText,
  requiresManualConfirmationForStep,
} from "./manual-confirmation-core.js";
import {
  normalizeStepParams,
  syncStepParamsFromLegacy,
  syncStepParamsToLegacy,
} from "./step-params-core.js";
import {
  workspaceMigrationAudit,
  workspaceMigrationSummaryText,
} from "./workspace-migration-core.js";
import { normalizeWorkspaceCore } from "./workspace-normalization-core.js";
import {
  failureEvidenceBundle,
  failureEvidenceSummaryText,
  failureStepFromReport as failureStepFromReportCore,
} from "./failure-evidence-core.js";
import {
  HOME_VITALITY_BLUEPRINT,
  HOME_VITALITY_BLUEPRINT_ID,
  HOME_VITALITY_LIVE_GATE_CHECKLIST,
  HOME_VITALITY_TEMPLATE_BINDINGS,
  assessHomeVitalityLiveGates,
  assessHomeVitalityReadiness,
  summarizeHomeVitalityGaps,
} from "./home-vitality-core.js";
import { createSaveCoordinator } from "./save-coordinator-core.js";
import {
  fileizeWorkspaceAssets,
  prepareWorkspaceForPersistence,
} from "./asset-store-core.js";
import {
  WELFARE_SIGNIN_BLUEPRINT,
  WELFARE_SIGNIN_BLUEPRINT_ID,
  WELFARE_SIGNIN_TEMPLATE_BINDINGS,
  assessWelfareSignInReadiness,
} from "./welfare-sign-in-core.js";
import {
  BAG_ORGANIZE_BLUEPRINT,
  BAG_ORGANIZE_BLUEPRINT_ID,
  assessBagOrganizeReadiness,
} from "./bag-organize-core.js";
import {
  TEAM_OBSERVE_BLUEPRINT,
  assessTeamObserveReadiness,
} from "./team-observe-core.js";
import {
  STALL_SEARCH_BLUEPRINT,
  assessStallSearchReadiness,
} from "./stall-search-core.js";
import {
  analyzeWindowEventTimeline,
  assessDualQueueIsolation,
} from "./multi-window-isolation-core.js";
import {
  isLiveValidationEvidence,
  liveValidationRunHistoryEntry,
  mergeLiveValidationRunHistory,
} from "./live-validation-core.js";
import {
  previewCaptureSummary,
  targetVerificationPassed,
} from "./capture-policy-core.js";
import {
  activateStartingSession,
  assignedQueueRunEntries,
  isActiveRunSession,
  releaseStartingSession,
  reserveStartingSession,
} from "./run-dispatch-core.js";
import {
  inspectorTabForFocusSelector,
  normalizeInspectorTab,
  workbenchViewportContract,
} from "./workbench-layout-core.js";
import {
  matchBoxMetaText,
  normalizeMatchBox,
  pickMatchFieldsFromResult,
  projectMatchBoxToStage,
} from "./match-overlay-core.js";
import "./styles.css";

const TARGET_TITLE = "梦幻西游：时空";
const WORKSPACE_SCHEMA_VERSION = 9;
const DEFAULT_IMAGE_THRESHOLD = 0.86;
const WINDOW_CLIENT_SIZE_TOLERANCE = 2;
const MAX_LOG_ROWS = 500;
const MAX_SESSION_STEP_RESULTS = 300;
const MAX_SESSION_RUN_EVENTS = 800;
const MAX_CONTROL_FLOW_TRANSITIONS = 300;
const MAX_TEXT_INPUT_CHARS = 500;
const MAX_CONTROL_FLOW_STEPS = 500;
const MAX_WORKFLOW_JUMPS = 100;
const targetBackedStepTypes = new Set([
  "image_click",
  "double_click",
  "wait_image",
  "detect_page",
  "click",
  "ocr_assert",
  "retry_until",
]);
const capturedImageStepTypes = new Set(["image_click", "double_click", "wait_image", "detect_page", "retry_until"]);
const stepFailActions = new Set(["stop", "retry", "skip", "restore"]);
const targetKindOptions = ["image", "roi", "page", "ocr", "click_target", "state", "unknown"];
const workflowConcurrencyOptions = new Set(["per-window-exclusive"]);
const imageClickPointOptions = new Set(["center", "top-left", "top-right", "bottom-left", "bottom-right"]);
const terminalBackendStatuses = new Set(["error", "unsupported", "cancelled"]);
const backgroundFailureStatuses = new Set([
  "missing_asset",
  "missing_template",
  "search_budget_exceeded",
  "below_threshold",
  "text_miss",
  "ocr_unavailable",
  "missing_expect",
  "capture_unavailable",
  "capture_unreliable",
  "timeout",
  "ocr_queue_full",
  "manual_confirmation_required",
]);
const plannedOnlyStepTypes = new Set(["restore"]);
const recoveryFragmentStepTypes = new Set([
  "hotkey",
  "delay",
  "detect_page",
  "wait_image",
  "image_click",
  "click",
  "double_click",
  "ocr_assert",
  "retry_until",
  "snapshot",
]);
const recoveryExecutableStepTypes = new Set(["hotkey", "detect_page", "wait_image", "image_click", "click", "double_click", "ocr_assert", "retry_until"]);
const recoveryVerificationStepTypes = new Set(["detect_page", "wait_image", "ocr_assert", "retry_until"]);
const recoveryFragmentMarker = "default-recovery-fragment";
const controlFlowStepReferenceFields = ["targetStepId", "elseTargetStepId", "recoveryStepId"];
const controlFlowWorkflowReferenceFields = ["jumpWorkflowId"];
const builtinTargetTemplateBindings = [
  { target: "page.home.ready", key: "zonghe/jiahao.png", kind: "page", name: "主界面判定", threshold: 0.86 },
  { target: "entry.home", key: "jiayuan/jiayuan.png", kind: "image", name: "家园入口", threshold: 0.82, requiresManualConfirmation: true },
  { target: "target.activity.icon", key: "zonghe/huodong1.png", kind: "image", name: "活动入口" },
  { target: "page.activity.ready", key: "zonghe/huodong_jiemian_panduan.png", kind: "page", name: "活动界面判定" },
  { target: "button.welfare", key: "qiandao/fuli.png", kind: "image", name: "福利入口" },
  { target: "page.welfare.ready", key: "qiandao/fuli.png", kind: "page", name: "福利界面判定" },
  { target: "button.cumulative_reward", key: "qiandao/leiji2.png", kind: "image", name: "累计奖励" },
  { target: "page.guild.ready", key: "qiandao/bangpai_jiemian_panduan.png", kind: "page", name: "帮派界面判定" },
  { target: "button.guild_welfare", key: "qiandao/bangpaifuli.png", kind: "image", name: "帮派福利入口" },
  { target: "button.guild_checkin", key: "qiandao/bangpaifuli.png", kind: "image", name: "帮派福利签到区" },
  { target: "button.confirm", key: "zonghe/zhujiemian_shiyong_cha.png", kind: "image", name: "确认/关闭按钮" },
  { target: "button.team_up", key: "duiwu/duiwu-zudui.png", kind: "image", name: "组队按钮" },
  { target: "page.team.ready", key: "duiwu/duiwu-duiwu.png", kind: "page", name: "队伍界面判定" },
  { target: "page.bag.ready", key: "beibao/beibao_jiemian_panduan.png", kind: "page", name: "背包界面判定" },
  { target: "button.sort_material", key: "beibao/beibao_diduan.png", kind: "image", name: "背包整理区", threshold: 0.84 },
  { target: "button.home_clean", key: "jiayuan/dali.png", kind: "image", name: "家园打理按钮", requiresManualConfirmation: true },
  { target: "page.home_yard.ready", key: "jiayuan/dali.png", kind: "page", name: "家园打理页判定" },
  { target: "item.target", key: "beibao/zhenfajuan.png", kind: "image", name: "示例背包物品", threshold: 0.82 },
  { target: "item.treasure_map", key: "baotu/cangbaotu.png", kind: "image", name: "藏宝图物品" },
  { target: "entry.secret_realm", key: "mijing/mijing_moshi.png", kind: "image", name: "秘境入口/模式" },
  { target: "item.realm_material", key: "mijing_cailiao/nanshanyu.png", kind: "image", name: "秘境材料" },
  { target: "target.realm_material", key: "mijing_cailiao/nanshanyu.png", kind: "image", name: "秘境材料确认" },
  { target: "grid.material_slot", key: "mijing_cailiao/nanshanyu.png", kind: "image", name: "材料格参考", threshold: 0.84 },
  { target: "page.stall.ready", key: "shangcheng/baitan_zhujiemian.png", kind: "page", name: "摆摊界面判定" },
  { target: "page.quest.ready", key: "zonghe/renwu_tanchuang.png", kind: "page", name: "任务面板判定" },
  { target: "item.current_quest", key: "zonghe/rwl_suojin.png", kind: "image", name: "当前任务条目" },
  { target: "item.target_material", key: "beibao/bailianjingtie.png", kind: "image", name: "目标材料" },
];

const stepTypes = [
  ["detect_page", "检测页面"],
  ["wait_image", "等待图像"],
  ["image_click", "图像点击"],
  ["double_click", "后台双击"],
  ["ocr_assert", "OCR 确认"],
  ["click", "后台点击"],
  ["hotkey", "快捷键"],
  ["text_input", "文本输入"],
  ["delay", "延迟等待"],
  ["condition", "条件判断"],
  ["loop", "循环"],
  ["retry_until", "重试直到"],
  ["snapshot", "截图记录"],
  ["task_jump", "任务跳转"],
  ["restore", "恢复状态"],
];

const stepLabels = Object.fromEntries(stepTypes);

const stepDefaults = {
  detect_page: {
    name: "检测页面",
    target: "page.home.ready",
    command: "match=image_or_ocr",
    expect: "ready=true",
    timeoutMs: 3000,
    retry: 2,
    onFail: "restore",
  },
  wait_image: {
    name: "等待图像",
    target: "target.image",
    command: "threshold=0.86",
    expect: "visible",
    timeoutMs: 5000,
    retry: 2,
    onFail: "retry",
  },
  image_click: {
    name: "图像点击",
    target: "button.target",
    command: "button=left; point=center",
    expect: "screen.changed",
    timeoutMs: 2600,
    retry: 1,
    onFail: "retry",
  },
  double_click: {
    name: "后台双击",
    target: "button.target",
    command: "button=left; point=center; mode=hwnd-message",
    expect: "double_click.accepted",
    timeoutMs: 1800,
    retry: 0,
    onFail: "stop",
  },
  ocr_assert: {
    name: "OCR 确认",
    target: "text.keyword",
    command: "lang=zh; roi=auto",
    expect: "text_found",
    timeoutMs: 4200,
    retry: 2,
    onFail: "restore",
  },
  click: {
    name: "后台点击",
    target: "x=0,y=0",
    command: "button=left; mode=hwnd-message",
    expect: "click.accepted",
    timeoutMs: 1300,
    retry: 0,
    onFail: "stop",
  },
  hotkey: {
    name: "快捷键",
    target: "ALT+N",
    command: "mode=hwnd-key",
    expect: "panel.open",
    timeoutMs: 1200,
    retry: 0,
    onFail: "stop",
  },
  text_input: {
    name: "文本输入",
    target: "要输入的文本",
    command: "mode=hwnd-char",
    expect: "text.sent",
    timeoutMs: 1200,
    retry: 0,
    onFail: "stop",
  },
  delay: {
    name: "延迟等待",
    target: "800ms",
    command: "reason=animation",
    expect: "time.elapsed",
    timeoutMs: 800,
    retry: 0,
    onFail: "skip",
  },
  condition: {
    name: "条件判断",
    target: "last.score",
    command: "guard=true",
    expect: "condition.checked",
    timeoutMs: 1000,
    retry: 0,
    onFail: "skip",
  },
  loop: {
    name: "有限循环",
    target: "control.loop",
    command: "mode=control-flow",
    expect: "bounded.repeat",
    timeoutMs: 0,
    retry: 0,
    onFail: "stop",
  },
  retry_until: {
    name: "重试直到",
    target: "page.target.ready",
    command: "interval=800ms",
    expect: "ready=true",
    timeoutMs: 8000,
    retry: 5,
    onFail: "restore",
  },
  snapshot: {
    name: "截图记录",
    target: "window.client",
    command: "dry-run log only",
    expect: "snapshot.recorded",
    timeoutMs: 1000,
    retry: 0,
    onFail: "skip",
  },
  task_jump: {
    name: "任务跳转",
    target: "workflow.next",
    command: "mode=same-window-queue",
    expect: "jump.workflow",
    timeoutMs: 0,
    retry: 0,
    onFail: "stop",
  },
  restore: {
    name: "恢复状态",
    target: "restore.home",
    command: "safe sequence",
    expect: "page.home.ready",
    timeoutMs: 6000,
    retry: 1,
    onFail: "stop",
  },
};

const stepBlockPresets = [
  {
    id: "open-panel",
    label: "打开界面 · 3步",
    steps: [
      { type: "hotkey", name: "打开目标界面", target: "ALT+N", command: "mode=hwnd-key", expect: "panel.open" },
      { type: "delay", name: "等待界面动画", target: "800ms", command: "reason=panel_transition", expect: "time.elapsed" },
      { type: "detect_page", name: "确认界面就绪", target: "page.target.ready", command: "threshold=0.86", expect: "ready=true" },
    ],
  },
  {
    id: "image-click-flow",
    label: "识图点击 · 4步",
    steps: [
      { type: "wait_image", name: "等待目标出现", target: "target.image", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "点击目标", target: "button.target", command: "button=left; point=center", expect: "screen.changed" },
      { type: "delay", name: "等待点击反馈", target: "600ms", command: "reason=click_feedback", expect: "time.elapsed" },
      { type: "retry_until", name: "等待下一状态", target: "page.next.ready", command: "interval=600ms", expect: "ready=true", timeoutMs: 5000, retry: 2 },
    ],
  },
  {
    id: "text-input",
    label: "文本输入 · 2步",
    steps: [
      { type: "text_input", name: "输入文本", target: "要输入的文本", command: "mode=hwnd-char", expect: "text.sent" },
      { type: "delay", name: "等待输入反馈", target: "300ms", command: "reason=text_input_feedback", expect: "time.elapsed" },
    ],
  },
  {
    id: "right-click-item",
    label: "物品右键 · 4步",
    steps: [
      { type: "wait_image", name: "查找物品图标", target: "item.target", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "右键使用物品", target: "item.target", command: "button=right; point=center", expect: "action.accepted" },
      { type: "delay", name: "等待服务器反馈", target: "1000ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "snapshot", name: "记录使用结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
    ],
  },
  {
    id: "guard-snapshot",
    label: "状态检查 · 3步",
    steps: [
      { type: "detect_page", name: "检测当前页面", target: "page.current.ready", command: "threshold=0.86", expect: "ready=true" },
      { type: "condition", name: "判断是否继续", target: "state.can_continue", command: "guard=true", expect: "continue" },
      { type: "snapshot", name: "记录判断现场", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
    ],
  },
  {
    id: "recovery-fragment",
    label: "恢复片段 · 4步",
    steps: [
      { type: "hotkey", name: "关闭当前弹窗", target: "ESC", command: "mode=hwnd-key", expect: "dialog.closed", timeoutMs: 800, retry: 0, onFail: "stop", notes: "default-recovery-fragment" },
      { type: "delay", name: "等待界面回稳", target: "600ms", command: "reason=recovery_settle", expect: "time.elapsed", timeoutMs: 600, retry: 0, onFail: "skip", notes: "default-recovery-fragment" },
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible", timeoutMs: 3000, retry: 1, onFail: "stop", notes: "default-recovery-fragment" },
      { type: "snapshot", name: "记录恢复现场", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded", timeoutMs: 1000, retry: 0, onFail: "skip", notes: "default-recovery-fragment" },
    ],
  },
  {
    id: "full-task-skeleton",
    label: "完整任务骨架 · 10步",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开目标面板", target: "ALT+N", command: "mode=hwnd-key", expect: "panel.open" },
      { type: "delay", name: "等待面板动画", target: "800ms", command: "reason=panel_transition", expect: "time.elapsed" },
      { type: "wait_image", name: "等待入口出现", target: "entry.target", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "进入目标页面", target: "entry.target", command: "button=left; point=center", expect: "page.target.open" },
      { type: "delay", name: "等待切页", target: "700ms", command: "reason=page_transition", expect: "time.elapsed" },
      { type: "wait_image", name: "等待操作按钮", target: "button.primary_action", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "执行主要操作", target: "button.primary_action", command: "button=left; point=center", expect: "action.accepted" },
      { type: "snapshot", name: "记录结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
];

const quickStepActions = [
  {
    id: "hotkey",
    kind: "键盘",
    label: "快捷键",
    detail: "向目标 hwnd 发送组合键",
    stepType: "hotkey",
    focusSelector: "#param-hotkey",
  },
  {
    id: "coordinate-click",
    kind: "鼠标",
    label: "坐标点击",
    detail: "采点或手填坐标，后台点击",
    stepType: "click",
    focusSelector: "#param-click-x",
  },
  {
    id: "image-click-flow",
    kind: "识图",
    label: "识图点击链",
    detail: "等待图像、点击、等待反馈",
    presetId: "image-click-flow",
    focusSelector: "#param-target-select",
  },
  {
    id: "ocr-assert",
    kind: "OCR",
    label: "OCR 判断",
    detail: "截图识别文字，不发送输入",
    stepType: "ocr_assert",
    focusSelector: "#target-texts",
  },
  {
    id: "text-input",
    kind: "键盘",
    label: "文本输入",
    detail: "WM_CHAR 后台输入文本",
    presetId: "text-input",
    focusSelector: "#param-text-value",
  },
  {
    id: "right-click-item",
    kind: "物品",
    label: "右键物品",
    detail: "等图、右键、记录结果",
    presetId: "right-click-item",
    focusSelector: "#param-target-select",
  },
  {
    id: "guard-snapshot",
    kind: "流程",
    label: "条件检查",
    detail: "状态判断并记录现场",
    presetId: "guard-snapshot",
    focusSelector: "#param-condition-guard",
  },
  {
    id: "recovery-fragment",
    kind: "恢复",
    label: "失败恢复",
    detail: "ESC、等待、回主界面、截图",
    presetId: "recovery-fragment",
    focusSelector: "#param-control-recovery-step",
  },
  {
    id: "full-task-skeleton",
    kind: "任务",
    label: "10 步骨架",
    detail: "完整任务结构，适合新任务起步",
    presetId: "full-task-skeleton",
    focusSelector: "#param-target-select",
  },
];

function homeVitalityBuiltinTemplateKeys() {
  const keys = new Set(HOME_VITALITY_TEMPLATE_BINDINGS.map((item) => item.key).filter(Boolean));
  for (const binding of builtinTargetTemplateBindings) {
    if (binding?.key) keys.add(binding.key);
  }
  return [...keys];
}

function assessActiveHomeVitalityReadiness(options = {}) {
  const availableTemplateKeys = options.availableTemplateKeys || homeVitalityBuiltinTemplateKeys();
  const targetAssets = {};
  for (const target of state.workspace?.targets || []) {
    const asset = {
      dataUrl: target.dataUrl || "",
      roi: target.roi || null,
      loaded: Boolean(target.dataUrl || target.roi),
    };
    targetAssets[target.id] = asset;
    for (const binding of HOME_VITALITY_TEMPLATE_BINDINGS) {
      if (!targetMatchesBuiltinBinding(target.id, binding.target)) continue;
      const confirmation = manualConfirmationStatus(target, {
        required: binding.requiresManualConfirmation === true,
      });
      targetAssets[binding.target] = {
        ...asset,
        manualConfirmationValid: confirmation.valid,
      };
    }
  }
  return assessHomeVitalityReadiness({
    availableTemplateKeys,
    targetAssets,
    bindings: HOME_VITALITY_TEMPLATE_BINDINGS,
    blueprint: HOME_VITALITY_BLUEPRINT,
  });
}

function homeVitalityGapSummary(options = {}) {
  return summarizeHomeVitalityGaps(assessActiveHomeVitalityReadiness(options));
}

if (typeof window !== "undefined") {
  window.__homeVitalityReadiness = {
    blueprintId: HOME_VITALITY_BLUEPRINT_ID,
    assess: assessActiveHomeVitalityReadiness,
    gaps: homeVitalityGapSummary,
    liveGates: () => assessHomeVitalityLiveGates(),
    checklist: HOME_VITALITY_LIVE_GATE_CHECKLIST,
  };
}

const workflowBlueprints = [
  {
    id: HOME_VITALITY_BLUEPRINT.id,
    label: HOME_VITALITY_BLUEPRINT.label,
    category: HOME_VITALITY_BLUEPRINT.category,
    defaultPrefix: HOME_VITALITY_BLUEPRINT.defaultPrefix || HOME_VITALITY_BLUEPRINT.label,
    autoRecovery: HOME_VITALITY_BLUEPRINT.autoRecovery === true,
    description: HOME_VITALITY_BLUEPRINT.description,
    steps: HOME_VITALITY_BLUEPRINT.steps.map((step) => ({ ...step })),
  },
  {
    id: "daily-reward",
    label: "福利签到",
    category: "日常",
    defaultPrefix: "福利签到",
    description: "进入福利/活动页面，处理签到、确认弹窗和奖励记录。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开活动面板", target: "ALT+N", command: "mode=hwnd-key", expect: "activity.panel.open" },
      { type: "wait_image", name: "等待福利入口", target: "button.welfare", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "进入福利页", target: "button.welfare", command: "button=left; point=center", expect: "welfare.visible" },
      { type: "delay", name: "等待切页动画", target: "700ms", command: "reason=page_transition", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认福利标题", target: "福利", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "等待签到按钮", target: "button.sign_in", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "点击签到", target: "button.sign_in", command: "button=left; point=center", expect: "reward.popup" },
      { type: "image_click", name: "确认奖励", target: "button.confirm", command: "button=left; point=center", expect: "popup.closed" },
      { type: "retry_until", name: "等待福利页稳定", target: "page.welfare.ready", command: "interval=600ms", expect: "ready=true", timeoutMs: 5000, retry: 3 },
      { type: "snapshot", name: "记录领取结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "bag-item-use",
    label: "背包物品",
    category: "背包",
    defaultPrefix: "背包物品",
    description: "打开背包，识别目标物品，支持左键选择、右键使用和确认弹窗。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开背包", target: "ALT+E", command: "mode=hwnd-key", expect: "bag.open" },
      { type: "wait_image", name: "等待背包界面", target: "page.bag.ready", command: "threshold=0.85", expect: "visible" },
      { type: "ocr_assert", name: "确认背包标题", target: "包裹", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "查找目标物品", target: "item.target", command: "threshold=0.88", expect: "visible" },
      { type: "double_click", name: "双击目标物品", target: "item.target", command: "button=left; point=center", expect: "item.opened" },
      { type: "image_click", name: "右键使用物品", target: "item.target", command: "button=right; point=center", expect: "action.accepted" },
      { type: "delay", name: "等待服务器反馈", target: "1000ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认物品提示", target: "使用", command: "lang=zh; roi=dialog", expect: "text_found" },
      { type: "image_click", name: "确认使用", target: "button.confirm", command: "button=left", expect: "popup.closed" },
      { type: "snapshot", name: "记录物品结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "team-prep",
    label: "组队准备",
    category: "组队",
    defaultPrefix: "组队准备",
    description: "打开队伍界面，选择活动分类，等待目标活动并尝试申请或确认队伍状态。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开队伍", target: "ALT+T", command: "mode=hwnd-key", expect: "team.panel.open" },
      { type: "wait_image", name: "等待组队按钮", target: "button.team_up", command: "threshold=0.84", expect: "visible" },
      { type: "image_click", name: "进入组队", target: "button.team_up", command: "button=left; point=center", expect: "team.list.visible" },
      { type: "ocr_assert", name: "确认组队标题", target: "组队", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "image_click", name: "选择活动分类", target: "tab.daily_activity", command: "button=left", expect: "activity.filter.ready" },
      { type: "retry_until", name: "等待目标活动", target: "text.target_activity", command: "interval=800ms", expect: "text_found", timeoutMs: 7000, retry: 4 },
      { type: "click", name: "点击第一条队伍", target: "list.row.1", command: "button=left; mode=hwnd-message", expect: "team.detail.open" },
      { type: "image_click", name: "申请加入", target: "button.apply_join", command: "button=left", expect: "apply.sent" },
      { type: "delay", name: "等待申请反馈", target: "1200ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "snapshot", name: "记录队伍状态", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "guild-checkin",
    label: "帮派签到",
    category: "帮派",
    defaultPrefix: "帮派签到",
    description: "进入帮派福利，处理签到、累计奖励、结果确认和恢复。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开帮派", target: "ALT+B", command: "mode=hwnd-key", expect: "guild.panel.open" },
      { type: "wait_image", name: "等待帮派页", target: "page.guild.ready", command: "threshold=0.84", expect: "visible" },
      { type: "image_click", name: "进入帮派福利", target: "button.guild_welfare", command: "button=left", expect: "guild.welfare.ready" },
      { type: "ocr_assert", name: "确认福利文字", target: "帮派福利", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "等待签到按钮", target: "button.guild_checkin", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "点击签到", target: "button.guild_checkin", command: "button=left", expect: "reward.popup" },
      { type: "image_click", name: "领取累计", target: "button.cumulative_reward", command: "button=left", expect: "maybe.reward" },
      { type: "delay", name: "等待奖励动画", target: "900ms", command: "reason=reward_animation", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认领取结果", target: "已领取", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "snapshot", name: "记录帮派福利", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "mail-claim",
    label: "邮件领取",
    category: "日常",
    defaultPrefix: "邮件领取",
    description: "打开邮件/系统消息，识别可领取附件，确认领取并记录结果。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开消息入口", target: "ALT+M", command: "mode=hwnd-key", expect: "mail.panel.open" },
      { type: "wait_image", name: "等待邮件列表", target: "page.mail.ready", command: "threshold=0.84", expect: "visible" },
      { type: "ocr_assert", name: "确认邮件标题", target: "邮件", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "condition", name: "检查是否有未读附件", target: "state.mail_attachment", command: "guard=true", expect: "continue" },
      { type: "wait_image", name: "查找附件图标", target: "icon.mail_attachment", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "选择附件邮件", target: "icon.mail_attachment", command: "button=left; point=center", expect: "mail.detail.open" },
      { type: "image_click", name: "领取附件", target: "button.claim_attachment", command: "button=left; point=center", expect: "reward.popup" },
      { type: "image_click", name: "确认领取", target: "button.confirm", command: "button=left; point=center", expect: "popup.closed" },
      { type: "retry_until", name: "等待附件状态刷新", target: "state.mail_attachment_claimed", command: "interval=700ms", expect: "true", timeoutMs: 6000, retry: 3 },
      { type: "snapshot", name: "记录邮件结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "pet-care",
    label: "宠物照料",
    category: "宠物",
    defaultPrefix: "宠物照料",
    description: "打开宠物界面，检查状态、喂养或使用道具，并确认反馈。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开宠物界面", target: "ALT+P", command: "mode=hwnd-key", expect: "pet.panel.open" },
      { type: "wait_image", name: "等待宠物面板", target: "page.pet.ready", command: "threshold=0.84", expect: "visible" },
      { type: "ocr_assert", name: "确认宠物标题", target: "宠物", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "condition", name: "判断是否需要喂养", target: "state.pet_needs_food", command: "guard=true", expect: "continue" },
      { type: "wait_image", name: "查找喂养按钮", target: "button.pet_feed", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "点击喂养", target: "button.pet_feed", command: "button=left; point=center", expect: "bag.item.pick" },
      { type: "wait_image", name: "等待口粮物品", target: "item.pet_food", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "选择口粮", target: "item.pet_food", command: "button=left; point=center", expect: "item.selected" },
      { type: "image_click", name: "确认使用", target: "button.confirm", command: "button=left; point=center", expect: "pet.feed.done" },
      { type: "ocr_assert", name: "确认宠物状态", target: "气血", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "snapshot", name: "记录宠物结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "stall-search",
    label: "摊位搜索",
    category: "交易",
    defaultPrefix: "摊位搜索",
    description: "打开摊位/摆摊界面，输入搜索词，仅采集和确认结果，不默认购买。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开交易入口", target: "ALT+S", command: "mode=hwnd-key", expect: "market.panel.open" },
      { type: "wait_image", name: "等待摊位界面", target: "page.stall.ready", command: "threshold=0.84", expect: "visible" },
      { type: "ocr_assert", name: "确认交易标题", target: "摊位", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "image_click", name: "点击搜索框", target: "input.stall_search", command: "button=left; point=center", expect: "input.focused" },
      { type: "text_input", name: "输入搜索词", target: "搜索关键词", command: "mode=hwnd-char", expect: "text.sent" },
      { type: "image_click", name: "执行搜索", target: "button.search", command: "button=left; point=center", expect: "search.sent" },
      { type: "retry_until", name: "等待搜索结果", target: "list.search_result.ready", command: "interval=800ms", expect: "ready=true", timeoutMs: 8000, retry: 4 },
      { type: "ocr_assert", name: "确认结果文字", target: "价格", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "condition", name: "默认不购买", target: "state.purchase_allowed", command: "guard=false", expect: "manual_review" },
      { type: "snapshot", name: "记录搜索结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "quest-chain",
    label: "任务链检查",
    category: "任务",
    defaultPrefix: "任务链检查",
    description: "打开任务面板，定位当前任务、识别目标按钮，适合串成多窗口状态检查。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开任务面板", target: "ALT+Q", command: "mode=hwnd-key", expect: "quest.panel.open" },
      { type: "wait_image", name: "等待任务列表", target: "page.quest.ready", command: "threshold=0.84", expect: "visible" },
      { type: "ocr_assert", name: "确认任务标题", target: "任务", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "查找当前任务", target: "item.current_quest", command: "threshold=0.84", expect: "visible" },
      { type: "double_click", name: "双击当前任务", target: "item.current_quest", command: "button=left; point=center", expect: "quest.detail.open" },
      { type: "ocr_assert", name: "确认任务说明", target: "目标", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "condition", name: "判断是否可自动寻路", target: "state.quest_auto_path", command: "guard=true", expect: "continue" },
      { type: "image_click", name: "点击自动寻路", target: "button.auto_path", command: "button=left; point=center", expect: "path.started" },
      { type: "retry_until", name: "等待寻路状态", target: "state.pathing", command: "interval=1000ms", expect: "true", timeoutMs: 9000, retry: 5 },
      { type: "snapshot", name: "记录任务状态", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "material-prep",
    label: "材料整理",
    category: "背包",
    defaultPrefix: "材料整理",
    description: "检查背包材料、仓库入口和确认弹窗，适合做副本/生活技能前置准备。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开背包", target: "ALT+E", command: "mode=hwnd-key", expect: "bag.open" },
      { type: "wait_image", name: "等待背包界面", target: "page.bag.ready", command: "threshold=0.85", expect: "visible" },
      { type: "ocr_assert", name: "确认背包标题", target: "包裹", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "condition", name: "检查背包页识别可信度", target: "last.score", command: "guard=last.score>=0.5", expect: "continue" },
      { type: "wait_image", name: "查找目标材料", target: "item.target_material", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "选择目标材料", target: "item.target_material", command: "button=left; point=center", expect: "item.selected" },
      { type: "image_click", name: "移动到整理区", target: "button.sort_material", command: "button=left; point=center", expect: "sort.accepted" },
      { type: "delay", name: "等待整理反馈", target: "900ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认整理结果", target: "整理", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "snapshot", name: "记录材料状态", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
];

const exerciseSuiteBlueprintIds = [
  "home-vitality",
  "daily-reward",
  "bag-item-use",
  "team-prep",
  "guild-checkin",
  "mail-claim",
  "pet-care",
  "stall-search",
  "quest-chain",
  "material-prep",
];
const exerciseSuiteQueuePattern = [2, 5, 7, 3, 9, 4, 6, 8, 1, 10];

const state = {
  windows: [],
  selected: new Set(),
  activeHwnd: null,
  privilege: null,
  launchStatus: null,
  preview: null,
  previewSource: "window",
  roiSelection: null,
  roiDragStart: null,
  matchOverlay: null,
  previewClickCapture: false,
  previewClickButton: "left",
  workspace: createSeedWorkspace(),
  workspacePath: "",
  workspaceBackupPath: "",
  workspaceMigration: null,
  selectedStepId: null,
  selectedTargetId: "",
  inspectorTab: "workflow",
  targetVerification: null,
  targetSearch: "",
  targetKindFilter: "all",
  stepValidation: {},
  saveTimer: null,
  sessions: {},
  sessionSerial: 0,
  expandedFailureReportIds: new Set(),
};

const $ = (selector) => document.querySelector(selector);
const isTauriRuntime = Boolean(globalThis.__TAURI_INTERNALS__);
const appWindow = isTauriRuntime ? getCurrentWindow() : null;

function applyWorkbenchViewportContract() {
  const contract = workbenchViewportContract(window.innerWidth, window.innerHeight);
  document.body.dataset.workbenchMode = contract.mode;
  document.body.dataset.workbenchDensity = contract.density;
}

function setInspectorTab(tab, options = {}) {
  const selected = normalizeInspectorTab(tab, { hasStep: Boolean(selectedStep()) });
  state.inspectorTab = selected;
  for (const button of document.querySelectorAll("[data-inspector-tab]")) {
    const active = button.dataset.inspectorTab === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && options.focus) button.focus();
  }
  for (const panel of document.querySelectorAll("[data-inspector-panel]")) {
    panel.hidden = panel.dataset.inspectorPanel !== selected;
  }
}

function bindInspectorTabs() {
  const tabs = [...document.querySelectorAll("[data-inspector-tab]")];
  for (const button of tabs) {
    button.addEventListener("click", () => setInspectorTab(button.dataset.inspectorTab));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(button);
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setInspectorTab(tabs[next].dataset.inspectorTab, { focus: true });
    });
  }
  setInspectorTab(state.inspectorTab);
}

function backendUnavailableMessage(command) {
  return `桌面后端不可用：${command} 需要从 Tauri 应用窗口运行`;
}

async function invokeBackend(command, args) {
  if (!isTauriRuntime) {
    throw new Error(backendUnavailableMessage(command));
  }
  return invoke(command, args);
}

async function setupCloseToTray() {
  if (!appWindow) {
    appendLog("warn", "当前是浏览器预览环境，关闭到托盘和后台窗口控制不可用");
    return;
  }
  try {
    await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      await appWindow.hide();
    });
  } catch (error) {
    appendLog("warn", `关闭到托盘监听注册失败：${error}`);
  }
}

function setStatus(message) {
  $("#status").textContent = message;
}

function setRunState(value) {
  const element = $("#run-state");
  element.textContent = value;
  element.classList.remove("idle", "ready", "running", "paused", "blocked", "failed");
  element.classList.add(value);
  syncRunActionButtons();
  renderOpsDashboard();
}

function appendLog(level, message) {
  const row = document.createElement("div");
  row.className = `log-row ${level}`;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  row.innerHTML = `
    <span>${escapeHtml(time)}</span>
    <strong>${escapeHtml(level)}</strong>
    <p>${escapeHtml(message)}</p>
  `;
  const log = $("#run-log");
  log.prepend(row);
  while (log.children.length > MAX_LOG_ROWS) {
    log.lastElementChild?.remove();
  }
}

function createSeedWorkspace() {
  const workflows = createSampleWorkflows();
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeWorkflowId: workflows[0]?.id || null,
    workflows,
    assignments: {},
    targets: createTargetCatalogFromWorkflows(workflows),
    runHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createSampleWorkflows() {
  return [
    workflow("wf-daily-welfare", "每日福利领取", "日常", "从主界面进入活动与福利页，领取可见奖励后恢复首页。", [
      step("daily-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("daily-02", "hotkey", "打开活动面板", "ALT+N", "mode=hwnd-key", "activity.panel.open"),
      step("daily-03", "wait_image", "等待活动入口", "target.activity.icon", "threshold=0.86", "visible", 5000, 2, "retry", {
        targetStepId: "daily-04",
      }),
      step("daily-04", "image_click", "进入福利页", "button.welfare", "button=left; point=center", "welfare.visible"),
      step("daily-05", "delay", "等待切页动画", "700ms", "reason=panel_transition", "time.elapsed"),
      step("daily-06", "ocr_assert", "确认福利标题", "福利", "lang=zh; roi=top", "text_found"),
      step("daily-07", "image_click", "点击签到", "button.sign_in", "button=left; point=center", "reward.popup"),
      step("daily-08", "condition", "判断是否需要确认奖励", "last.status", "guard=last.status==ok", "claim_popup_ready", 1000, 0, "skip", {
        targetStepId: "daily-09",
        elseTargetStepId: "daily-10",
      }),
      step("daily-09", "image_click", "确认奖励", "button.confirm", "button=left; point=center", "popup.closed"),
      step("daily-10", "snapshot", "记录领取结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("daily-11", "retry_until", "等待回到福利页", "page.welfare.ready", "interval=600ms", "ready=true", 5000, 3),
      step("daily-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-team-activity", "组队活动准备", "组队", "选择活动、检查队伍入口和确认状态，适合多窗口分别跑准备流程。", [
      step("team-01", "detect_page", "确认当前页面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("team-02", "hotkey", "打开队伍", "ALT+T", "mode=hwnd-key", "team.panel.open"),
      step("team-03", "wait_image", "等待组队按钮", "button.team_up", "threshold=0.84", "visible"),
      step("team-04", "image_click", "进入组队", "button.team_up", "button=left; point=center", "team.list.visible"),
      step("team-05", "ocr_assert", "确认组队标题", "组队", "lang=zh; roi=top", "text_found"),
      step("team-06", "condition", "判断是否已有队伍", "state.in_team", "guard=false", "create_or_join"),
      step("team-07", "image_click", "选择活动分类", "tab.daily_activity", "button=left", "activity.filter.ready"),
      step("team-08", "retry_until", "等待目标活动", "text.target_activity", "interval=800ms", "text_found", 7000, 4),
      step("team-09", "click", "点击第一条队伍", "list.row.1", "button=left; mode=hwnd-message", "team.detail.open"),
      step("team-10", "image_click", "申请加入", "button.apply_join", "button=left", "apply.sent"),
      step("team-11", "delay", "等待申请反馈", "1200ms", "reason=server_response", "time.elapsed"),
      step("team-12", "snapshot", "记录队伍状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("team-13", "restore", "返回主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-treasure-map", "藏宝图处理", "背包", "识别背包与藏宝图，按状态打开或跳过，并记录处理结果。", [
      step("map-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("map-02", "hotkey", "打开背包", "ALT+E", "mode=hwnd-key", "bag.open"),
      step("map-03", "wait_image", "等待背包界面", "page.bag.ready", "threshold=0.85", "visible"),
      step("map-04", "ocr_assert", "确认背包标题", "包裹", "lang=zh; roi=top", "text_found"),
      step("map-05", "condition", "背包是否已满", "state.bag_full", "guard=false", "continue"),
      step("map-06", "wait_image", "查找藏宝图", "item.treasure_map", "threshold=0.88", "visible"),
      step("map-07", "double_click", "双击藏宝图", "item.treasure_map", "button=left; point=center", "map.dialog"),
      step("map-08", "click", "使用物品", "button.use_item", "button=right; mode=hwnd-message", "map.dialog"),
      step("map-09", "ocr_assert", "确认藏宝图提示", "藏宝图", "lang=zh; roi=dialog", "text_found"),
      step("map-10", "image_click", "确认使用", "button.confirm", "button=left", "action.accepted"),
      step("map-11", "retry_until", "等待状态变化", "state.map_consumed", "interval=900ms", "true", 7000, 4),
      step("map-12", "snapshot", "记录处理结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("map-13", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-guild-checkin", "帮派签到", "帮派", "从主界面进入帮派福利，处理签到和累计奖励。", [
      step("guild-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("guild-02", "hotkey", "打开帮派", "ALT+B", "mode=hwnd-key", "guild.panel.open"),
      step("guild-03", "wait_image", "等待帮派页", "page.guild.ready", "threshold=0.84", "visible"),
      step("guild-04", "image_click", "进入帮派福利", "button.guild_welfare", "button=left", "guild.welfare.ready"),
      step("guild-05", "ocr_assert", "确认福利文字", "帮派福利", "lang=zh; roi=top", "text_found"),
      step("guild-06", "condition", "判断今日是否已签", "state.guild_checked", "guard=false", "continue"),
      step("guild-07", "image_click", "点击签到", "button.guild_checkin", "button=left", "reward.popup"),
      step("guild-08", "image_click", "领取累计", "button.cumulative_reward", "button=left", "maybe.reward"),
      step("guild-09", "delay", "等待奖励动画", "900ms", "reason=reward_animation", "time.elapsed"),
      step("guild-10", "ocr_assert", "确认领取结果", "已领取", "lang=zh; roi=panel", "text_found"),
      step("guild-11", "snapshot", "记录帮派福利", "window.client", "dry-run log only", "snapshot.recorded"),
      step("guild-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-secret-realm", "秘境材料准备", "副本", "检查秘境入口、材料与队伍状态，失败时恢复到主界面。", [
      step("realm-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("realm-02", "hotkey", "打开活动", "ALT+N", "mode=hwnd-key", "activity.panel.open"),
      step("realm-03", "wait_image", "等待秘境入口", "entry.secret_realm", "threshold=0.84", "visible"),
      step("realm-04", "image_click", "进入秘境页", "entry.secret_realm", "button=left", "realm.panel.ready"),
      step("realm-05", "ocr_assert", "确认秘境标题", "秘境", "lang=zh; roi=top", "text_found"),
      step("realm-06", "condition", "检查上一识别可信度", "last.score", "guard=last.score>=0.5", "continue"),
      step("realm-07", "hotkey", "打开背包检查材料", "ALT+E", "mode=hwnd-key", "bag.open"),
      step("realm-08", "wait_image", "查找秘境材料", "item.realm_material", "threshold=0.86", "visible"),
      step("realm-09", "wait_image", "确认材料图标", "target.realm_material", "threshold=0.84", "material.visible"),
      step("realm-10", "image_click", "选择材料格", "grid.material_slot", "button=left; point=center; threshold=0.84", "item.selected"),
      step("realm-11", "retry_until", "等待准备就绪", "state.realm_ready", "interval=1000ms", "true", 9000, 5),
      step("realm-12", "snapshot", "记录准备状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("realm-13", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-mail-claim", "邮件领取", "日常", "识别系统邮件附件、领取并记录结果。", [
      step("mail-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("mail-02", "hotkey", "打开消息入口", "ALT+M", "mode=hwnd-key", "mail.panel.open"),
      step("mail-03", "wait_image", "等待邮件列表", "page.mail.ready", "threshold=0.84", "visible"),
      step("mail-04", "ocr_assert", "确认邮件标题", "邮件", "lang=zh; roi=top", "text_found"),
      step("mail-05", "condition", "检查未领附件", "state.mail_attachment", "guard=true", "continue"),
      step("mail-06", "wait_image", "查找附件图标", "icon.mail_attachment", "threshold=0.86", "visible"),
      step("mail-07", "image_click", "选择附件邮件", "icon.mail_attachment", "button=left; point=center", "mail.detail.open"),
      step("mail-08", "image_click", "领取附件", "button.claim_attachment", "button=left; point=center", "reward.popup"),
      step("mail-09", "image_click", "确认领取", "button.confirm", "button=left; point=center", "popup.closed"),
      step("mail-10", "retry_until", "等待附件状态刷新", "state.mail_attachment_claimed", "interval=700ms", "true", 6000, 3),
      step("mail-11", "snapshot", "记录邮件结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("mail-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-pet-care", "宠物照料", "宠物", "打开宠物界面，检查状态并执行喂养确认。", [
      step("pet-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("pet-02", "hotkey", "打开宠物界面", "ALT+P", "mode=hwnd-key", "pet.panel.open"),
      step("pet-03", "wait_image", "等待宠物面板", "page.pet.ready", "threshold=0.84", "visible"),
      step("pet-04", "ocr_assert", "确认宠物标题", "宠物", "lang=zh; roi=top", "text_found"),
      step("pet-05", "condition", "判断是否需要喂养", "state.pet_needs_food", "guard=true", "continue"),
      step("pet-06", "wait_image", "查找喂养按钮", "button.pet_feed", "threshold=0.86", "visible"),
      step("pet-07", "image_click", "点击喂养", "button.pet_feed", "button=left; point=center", "bag.item.pick"),
      step("pet-08", "wait_image", "等待口粮物品", "item.pet_food", "threshold=0.86", "visible"),
      step("pet-09", "image_click", "选择口粮", "item.pet_food", "button=left; point=center", "item.selected"),
      step("pet-10", "image_click", "确认使用", "button.confirm", "button=left; point=center", "pet.feed.done"),
      step("pet-11", "ocr_assert", "确认宠物状态", "气血", "lang=zh; roi=panel", "text_found"),
      step("pet-12", "snapshot", "记录宠物结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("pet-13", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-stall-search", "摊位搜索", "交易", "输入搜索词并采集摊位结果，默认不购买。", [
      step("stall-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("stall-02", "hotkey", "打开交易入口", "ALT+S", "mode=hwnd-key", "market.panel.open"),
      step("stall-03", "wait_image", "等待摊位界面", "page.stall.ready", "threshold=0.84", "visible"),
      step("stall-04", "ocr_assert", "确认交易标题", "摊位", "lang=zh; roi=top", "text_found"),
      step("stall-05", "image_click", "点击搜索框", "input.stall_search", "button=left; point=center", "input.focused"),
      step("stall-06", "text_input", "输入搜索词", "搜索关键词", "mode=hwnd-char", "text.sent"),
      step("stall-07", "image_click", "执行搜索", "button.search", "button=left; point=center", "search.sent"),
      step("stall-08", "retry_until", "等待搜索结果", "list.search_result.ready", "interval=800ms", "ready=true", 8000, 4),
      step("stall-09", "ocr_assert", "确认结果文字", "价格", "lang=zh; roi=panel", "text_found"),
      step("stall-10", "condition", "默认不购买", "state.purchase_allowed", "guard=false", "manual_review"),
      step("stall-11", "snapshot", "记录搜索结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("stall-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-quest-chain", "任务链检查", "任务", "定位当前任务、识别说明并尝试自动寻路。", [
      step("quest-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("quest-02", "hotkey", "打开任务面板", "ALT+Q", "mode=hwnd-key", "quest.panel.open"),
      step("quest-03", "wait_image", "等待任务列表", "page.quest.ready", "threshold=0.84", "visible"),
      step("quest-04", "ocr_assert", "确认任务标题", "任务", "lang=zh; roi=top", "text_found"),
      step("quest-05", "wait_image", "查找当前任务", "item.current_quest", "threshold=0.84", "visible"),
      step("quest-06", "double_click", "双击当前任务", "item.current_quest", "button=left; point=center", "quest.detail.open"),
      step("quest-07", "ocr_assert", "确认任务说明", "目标", "lang=zh; roi=panel", "text_found"),
      step("quest-08", "condition", "判断是否可自动寻路", "state.quest_auto_path", "guard=true", "continue"),
      step("quest-09", "image_click", "点击自动寻路", "button.auto_path", "button=left; point=center", "path.started"),
      step("quest-10", "retry_until", "等待寻路状态", "state.pathing", "interval=1000ms", "true", 9000, 5),
      step("quest-11", "snapshot", "记录任务状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("quest-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-material-prep", "材料整理", "背包", "检查背包材料、整理按钮和状态反馈。", [
      step("material-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("material-02", "hotkey", "打开背包", "ALT+E", "mode=hwnd-key", "bag.open"),
      step("material-03", "wait_image", "等待背包界面", "page.bag.ready", "threshold=0.85", "visible"),
      step("material-04", "ocr_assert", "确认背包标题", "包裹", "lang=zh; roi=top", "text_found"),
      step("material-05", "condition", "检查背包页识别可信度", "last.score", "guard=last.score>=0.5", "continue"),
      step("material-06", "wait_image", "查找目标材料", "item.target_material", "threshold=0.86", "visible"),
      step("material-07", "image_click", "选择目标材料", "item.target_material", "button=left; point=center", "item.selected"),
      step("material-08", "image_click", "移动到整理区", "button.sort_material", "button=left; point=center", "sort.accepted"),
      step("material-09", "loop", "回查材料一次", "control.loop", "mode=control-flow; preDelay=900ms", "bounded.repeat", 0, 0, "stop", {
        targetStepId: "material-06",
        maxIterations: 1,
      }),
      step("material-10", "ocr_assert", "确认整理结果", "整理", "lang=zh; roi=panel", "text_found"),
      step("material-11", "snapshot", "记录材料状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("material-12", "task_jump", "演练跳转到每日福利", "workflow.next", "mode=same-window-queue", "jump.workflow", 0, 0, "stop", { jumpWorkflowId: "wf-daily-welfare" }),
      step("material-13", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
  ];
}

function workflow(id, name, category, description, steps) {
  const workflowSteps = withDefaultRecoveryReferences(withDefaultRecoveryFragment(steps, `${id}-recovery`));
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id,
    name,
    category,
    description,
    tags: [category, "示例"],
    initialCheck: "page.home.ready",
    targetPolicy: {
      titleNeedle: TARGET_TITLE,
      inputMode: "hwnd-message",
      concurrency: "per-window-exclusive",
    },
    steps: workflowSteps,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function step(
  id,
  type,
  name,
  target,
  command,
  expect,
  timeoutMs = stepDefaults[type]?.timeoutMs ?? 3000,
  retry = stepDefaults[type]?.retry ?? 0,
  onFail = stepDefaults[type]?.onFail ?? "stop",
  options = {},
) {
  return {
    id,
    type,
    name,
    target,
    command,
    expect,
    timeoutMs,
    retry,
    onFail,
    enabled: true,
    notes: "",
    ...options,
  };
}

async function loadWorkspace() {
  try {
    const result = await invokeBackend("load_workflow_workspace");
    const sourceData = result.data;
    state.workspacePath = result.path;
    state.workspaceBackupPath = "";
    state.workspace = normalizeWorkspace(sourceData);
    state.workspaceMigration = workspaceMigrationAudit(sourceData, state.workspace, WORKSPACE_SCHEMA_VERSION);
    let shouldSave = state.workspaceMigration.shouldSave;
    if (!state.workspace.workflows.length) {
      state.workspace = createSeedWorkspace();
      state.workspaceMigration = workspaceMigrationAudit(sourceData, state.workspace, WORKSPACE_SCHEMA_VERSION);
      shouldSave = true;
      appendLog("info", `首次启动已写入 ${state.workspace.workflows.length} 个示例任务`);
    }
    const hydrated = await hydrateBuiltinTargetTemplates({ log: true });
    shouldSave = shouldSave || hydrated > 0;
    if (hydrated > 0) {
      state.workspaceMigration = workspaceMigrationAudit(sourceData, state.workspace, WORKSPACE_SCHEMA_VERSION);
    }
    if (shouldSave) await saveWorkspaceNow();
    $("#workspace-state").textContent = result.existed
      ? state.workspaceMigration?.actions?.length
        ? "migrated"
        : "loaded"
      : "seeded";
    $("#workspace-state").classList.add("ok");
    $("#workspace-path").textContent = state.workspacePath;
    renderWorkspaceMigrationAudit();
  } catch (error) {
    state.workspace = createSeedWorkspace();
    state.workspaceBackupPath = "";
    state.workspaceMigration = null;
    await hydrateBuiltinTargetTemplates({ log: true });
    $("#workspace-state").textContent = "memory";
    $("#workspace-state").classList.remove("ok");
    $("#workspace-path").textContent = "工作区载入失败，当前使用内存草稿";
    renderWorkspaceMigrationAudit();
    appendLog("error", `工作区载入失败：${error}`);
  }
}

function normalizeWorkspace(value) {
  return normalizeWorkspaceCore(value, {
    currentSchemaVersion: WORKSPACE_SCHEMA_VERSION,
    defaultImageThreshold: DEFAULT_IMAGE_THRESHOLD,
    stepDefaults,
    targetTitle: TARGET_TITLE,
    seedFactory: createSeedWorkspace,
    randomId,
  });
}

function normalizeWorkflow(value) {
  const typeSafeSteps = Array.isArray(value?.steps) ? value.steps.map(normalizeStep) : [];
  const concurrency = String(value?.targetPolicy?.concurrency || "per-window-exclusive");
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: String(value?.id || randomId("wf")),
    name: String(value?.name || "未命名任务"),
    category: String(value?.category || "未分类"),
    description: String(value?.description || ""),
    tags: Array.isArray(value?.tags) ? value.tags.map(String) : [],
    initialCheck: String(value?.initialCheck || "page.home.ready"),
    targetPolicy: {
      titleNeedle: String(value?.targetPolicy?.titleNeedle || TARGET_TITLE),
      inputMode: String(value?.targetPolicy?.inputMode || "hwnd-message"),
      concurrency: workflowConcurrencyOptions.has(concurrency) ? concurrency : "per-window-exclusive",
    },
    steps: typeSafeSteps,
    createdAt: value?.createdAt || new Date().toISOString(),
    updatedAt: value?.updatedAt || new Date().toISOString(),
  };
}

function normalizeStep(value) {
  const type = stepLabels[value?.type] ? value.type : "detect_page";
  const defaults = stepDefaults[type];
  const item = {
    id: String(value?.id || randomId("step")),
    type,
    name: String(value?.name || defaults.name),
    target: String(value?.target || defaults.target),
    command: String(value?.command || defaults.command),
    expect: String(value?.expect || defaults.expect),
    timeoutMs: Number(value?.timeoutMs ?? defaults.timeoutMs),
    retry: Number(value?.retry ?? defaults.retry),
    onFail: normalizeStepFailAction(value?.onFail, defaults.onFail),
    recoveryAction: normalizeRecoveryAction(value?.recoveryAction),
    enabled: value?.enabled !== false,
    requiresManualConfirmation: value?.requiresManualConfirmation === true,
    targetId: value?.targetId ? String(value.targetId) : value?.assetId ? String(value.assetId) : "",
    notes: String(value?.notes || ""),
    params: normalizeStepParams({
      ...value,
      type,
      target: String(value?.target || defaults.target),
      command: String(value?.command || defaults.command),
      expect: String(value?.expect || defaults.expect),
      timeoutMs: Number(value?.timeoutMs ?? defaults.timeoutMs),
    }),
  };
  for (const field of controlFlowStepReferenceFields) {
    item[field] = value?.[field] ? String(value[field]) : "";
  }
  for (const field of controlFlowWorkflowReferenceFields) {
    item[field] = value?.[field] ? String(value[field]) : "";
  }
  const maxIterations = Number(value?.maxIterations ?? 0);
  item.maxIterations = Number.isFinite(maxIterations) && maxIterations >= 0 ? Math.floor(maxIterations) : 0;
  return syncLegacyFromStepParams(item);
}

function syncLegacyFromStepParams(item) {
  if (!item) return item;
  Object.assign(item, syncStepParamsToLegacy(item));
  return item;
}

function syncParamsFromLegacyFields(item) {
  if (!item) return item;
  Object.assign(item, syncStepParamsFromLegacy(item));
  return item;
}

function projectedLegacyStep(item) {
  return syncStepParamsToLegacy(item || {});
}

function normalizeStepFailAction(value, fallback = "stop") {
  const action = String(value || "").trim();
  if (stepFailActions.has(action)) return action;
  const fallbackAction = String(fallback || "").trim();
  return stepFailActions.has(fallbackAction) ? fallbackAction : "stop";
}

function normalizeRecoveryAction(value, fallback = "stop") {
  return normalizeRecoveryActionCore(value, fallback);
}

function sanitizeStepControlFlowForType(item) {
  if (!item) return;
  if (item.type !== "condition") item.elseTargetStepId = "";
  if (item.type === "loop") item.jumpWorkflowId = "";
  if (plannedOnlyStepTypes.has(item.type)) {
    item.targetStepId = "";
    item.elseTargetStepId = "";
    item.jumpWorkflowId = "";
    item.maxIterations = 0;
  }
}

function normalizeTarget(value) {
  return normalizeTargetCore(value, {
    defaultImageThreshold: DEFAULT_IMAGE_THRESHOLD,
    randomId,
  });
}

function mergeTargetCatalog(targets, workflows) {
  const byId = new Map();
  for (const target of createTargetCatalogFromWorkflows(workflows)) {
    byId.set(target.id, target);
  }
  for (const target of targets) {
    byId.set(target.id, target);
  }
  return [...byId.values()];
}

function createTargetCatalogFromWorkflows(workflows) {
  const byId = new Map();
  for (const workflow of workflows || []) {
    for (const item of workflow.steps || []) {
      const id = catalogTargetIdForStep(item);
      if (!id) continue;
      if (byId.has(id)) continue;
      byId.set(
        id,
        normalizeTarget({
          id,
          name: friendlyTargetName(id),
          kind: targetKindForStep(item),
          match: {
            threshold: commandValue(item.command, "threshold") || defaultThresholdForStep(item),
            scope: commandValue(item.command, "roi") || "window",
          },
          click: {
            button: normalizedButton(item.command),
            point: commandValue(item.command, "point") || "center",
          },
          texts: item.type === "ocr_assert" ? [item.target] : [],
          safety: { requiresManualConfirmation: item.requiresManualConfirmation === true },
          note: "由任务步骤生成的逻辑目标，可直接粘贴图片或绑定 ROI",
        }),
      );
    }
  }
  return [...byId.values()];
}

function isLogicalTargetName(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("=") || durationMsFromText(text) != null) return false;
  if (/^[A-Z]+(?:\+[A-Z0-9]+)+$/i.test(text)) return false;
  return /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_.:-]*$/u.test(text);
}

function friendlyTargetName(id) {
  const text = String(id || "").trim();
  const names = {
    page: "页面",
    button: "按钮",
    target: "目标",
    text: "文本",
    state: "状态",
    item: "物品",
    tab: "页签",
    entry: "入口",
    grid: "格子",
    list: "列表",
    asset: "素材",
  };
  const [head, ...tail] = text.split(".");
  const prefix = names[head] || head || "目标";
  return tail.length ? `${prefix} · ${tail.join(".")}` : prefix;
}

function targetKindForStep(item) {
  if (item.type === "ocr_assert") return "ocr";
  if (item.type === "condition" || item.type === "retry_until") return "state";
  if (item.type === "detect_page") return "page";
  if (item.type === "click") return "click_target";
  if (item.type === "double_click") return parsePointText(item.target) ? "click_target" : "image";
  return "image";
}

function defaultThresholdForStep(item) {
  return ["image_click", "double_click", "wait_image", "detect_page"].includes(item.type)
    ? DEFAULT_IMAGE_THRESHOLD
    : "";
}

function catalogTargetIdForStep(item) {
  const explicitId = String(item.targetId || item.assetId || "").trim();
  if (explicitId) return explicitId;
  if (!targetBackedStepTypes.has(item?.type) || item.type === "retry_until") return "";
  return isLogicalTargetName(item.target) ? item.target.trim() : "";
}

function normalizeAssignments(value, workflows = state.workspace.workflows) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const workflowIds = new Set(workflows.map((item) => item.id));
  return Object.fromEntries(
    Object.entries(value)
      .map(([hwnd, assignment]) => [String(hwnd), normalizeAssignment(hwnd, assignment, workflowIds)])
      .filter(([, assignment]) => assignment.queue.length > 0),
  );
}

function normalizeAssignment(hwnd, value, workflowIds = new Set(state.workspace.workflows.map((item) => item.id))) {
  const source = value && typeof value === "object" ? value : {};
  const windowIdentity = normalizeWindowIdentity(source.windowIdentity || { ...source, hwnd });
  const legacyWorkflowId = source.workflowId ? String(source.workflowId) : "";
  const queue = Array.isArray(source.queue)
    ? source.queue.map(normalizeQueueItem)
    : legacyWorkflowId
      ? [normalizeQueueItem({ workflowId: legacyWorkflowId, addedAt: source.assignedAt })]
      : [];
  return {
    hwnd: source.hwnd ?? hwnd,
    title: String(source.title || ""),
    processId: source.processId ?? null,
    processName: String(source.processName || windowIdentity.processName || ""),
    clientWidth: Number(source.clientWidth || windowIdentity.clientWidth || 0),
    clientHeight: Number(source.clientHeight || windowIdentity.clientHeight || 0),
    elevated: typeof source.elevated === "boolean" ? source.elevated : windowIdentity.elevated,
    display: String(source.display || hwnd),
    windowIdentity,
    queue: queue
      .filter((item) => workflowIds.has(item.workflowId))
      .map((item, index) => ({ ...item, order: index + 1 })),
    assignedAt: String(source.assignedAt || new Date().toISOString()),
    updatedAt: String(source.updatedAt || source.assignedAt || new Date().toISOString()),
  };
}

function normalizeWindowIdentity(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    hwnd: Number(source.hwnd) || 0,
    title: String(source.title || ""),
    processId: Number(source.processId) || 0,
    processName: String(source.processName || ""),
    clientWidth: Number(source.clientWidth) || 0,
    clientHeight: Number(source.clientHeight) || 0,
    elevated: typeof source.elevated === "boolean" ? source.elevated : null,
  };
}

function normalizeQueueItem(value) {
  const source = value && typeof value === "object" ? value : {};
  const startDelayMs = normalizedNonNegativeInteger(source.startDelayMs) ?? 0;
  const afterDelayMs = normalizedNonNegativeInteger(source.afterDelayMs) ?? 0;
  return {
    id: String(source.id || randomId("queue")),
    workflowId: String(source.workflowId || ""),
    enabled: source.enabled !== false,
    order: Number(source.order || 0),
    startDelayMs,
    afterDelayMs,
    addedAt: String(source.addedAt || new Date().toISOString()),
  };
}

async function saveWorkspaceNow() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = null;
  try {
    state.workspace.updatedAt = new Date().toISOString();
    const previousTargets = Array.isArray(state.workspace?.targets) ? state.workspace.targets : [];
    const fileized = await fileizeWorkspaceAssets(state.workspace);
    const mergedTargets = (fileized.workspace.targets || []).map((target) => {
      if (target?.dataUrl) return target;
      const previous = previousTargets.find((item) => item && item.id === target?.id);
      if (previous?.dataUrl) return { ...target, dataUrl: previous.dataUrl };
      return target;
    });
    state.workspace = {
      ...fileized.workspace,
      targets: mergedTargets,
    };
    const prepared = prepareWorkspaceForPersistence(state.workspace);
    const result = await invokeBackend("save_workflow_workspace", { workspace: prepared.workspace });
    state.workspacePath = result.savedPath;
    state.workspaceBackupPath = result.backupPath || state.workspaceBackupPath || "";
    $("#workspace-state").textContent = "saved";
    $("#workspace-state").classList.add("ok");
    $("#workspace-path").textContent = `${result.savedPath} · ${result.bytes} bytes`;
    renderWorkspaceMigrationAudit();
    return result;
  } catch (error) {
    $("#workspace-state").textContent = "save failed";
    $("#workspace-state").classList.remove("ok");
    renderWorkspaceMigrationAudit();
    appendLog("error", `工作区保存失败：${error}`);
    return null;
  }
}

function renderWorkspaceMigrationAudit() {
  const element = $("#workspace-migration");
  if (!element) return;
  element.textContent = workspaceMigrationSummaryText(state.workspaceMigration, {
    backupPath: state.workspaceBackupPath,
  });
  element.title = state.workspaceMigration ? JSON.stringify(state.workspaceMigration, null, 2) : "";
}

function markDirty(reason = "draft") {
  const workflow = activeWorkflow();
  if (workflow) workflow.updatedAt = new Date().toISOString();
  if (reason !== "run logged") state.stepValidation = {};
  $("#task-model-state").textContent = reason;
  $("#task-model-state").classList.remove("ok");
  $("#workspace-state").textContent = "dirty";
  $("#workspace-state").classList.remove("ok");
  window.clearTimeout(state.saveTimer);
  if (!state.saveCoordinator) {
    state.saveCoordinator = createSaveCoordinator({ saveFn: saveWorkspaceNow });
  }
  state.saveCoordinator.schedule(500);
  renderWorkflowList();
  renderQueueWorkflowPicker();
  renderAssignments();
  renderOpsDashboard();
}

function activeWorkflow() {
  return (
    state.workspace.workflows.find((item) => item.id === state.workspace.activeWorkflowId) ||
    state.workspace.workflows[0] ||
    null
  );
}

function workflowById(id) {
  return state.workspace.workflows.find((item) => item.id === id) || null;
}

function selectedStep() {
  const workflow = activeWorkflow();
  return workflow?.steps.find((item) => item.id === state.selectedStepId) || null;
}

function activeWindow() {
  return state.windows.find((item) => String(item.hwnd) === String(state.activeHwnd)) || null;
}

function selectedWindows() {
  return state.windows.filter((item) => state.selected.has(String(item.hwnd)));
}

function isActiveSession(session) {
  return isActiveRunSession(session);
}

function activeRunSessions() {
  return Object.values(state.sessions || {}).filter((session) => isActiveSession(session));
}

function runningSessions() {
  return Object.values(state.sessions || {}).filter((session) => session.status === "running");
}

function startingSessions() {
  return Object.values(state.sessions || {}).filter((session) => session.status === "starting");
}

function pausedSessions() {
  return Object.values(state.sessions || {}).filter((session) => session.status === "paused" || session.pauseRequested);
}

function currentRunState() {
  if (startingSessions().length || runningSessions().length) return "running";
  if (pausedSessions().length) return "paused";
  return "idle";
}

function syncRunState() {
  setRunState(currentRunState());
}

function isQueueLocked(hwnd) {
  return isActiveSession(state.sessions[String(hwnd)]);
}

function selectedEditableWindows() {
  const skipped = [];
  const targets = selectedWindows().filter((target) => {
    if (!isQueueLocked(target.hwnd)) return true;
    skipped.push(target.display || target.hwnd);
    return false;
  });
  if (skipped.length) appendLog("warn", `已跳过运行中的窗口队列：${skipped.join("，")}`);
  return targets;
}

function assignmentForHwnd(hwnd) {
  return state.workspace.assignments[String(hwnd)] || null;
}

function windowForAssignment(assignment) {
  return (state.windows || []).find((item) => String(item.hwnd) === String(assignment?.hwnd)) || null;
}

function ensureAssignment(target) {
  const key = String(target.hwnd);
  const existing = state.workspace.assignments[key];
  const now = new Date().toISOString();
  const assignment = existing || {
    hwnd: target.hwnd,
    title: target.title,
    processId: target.processId,
    display: target.display,
    queue: [],
    assignedAt: now,
    updatedAt: now,
  };
  assignment.hwnd = target.hwnd;
  assignment.title = target.title;
  assignment.processId = target.processId;
  assignment.processName = target.processName || "";
  assignment.clientWidth = Number(target.clientWidth) || 0;
  assignment.clientHeight = Number(target.clientHeight) || 0;
  assignment.elevated = typeof target.elevated === "boolean" ? target.elevated : null;
  assignment.display = target.display;
  assignment.windowIdentity = windowIdentityForTarget(target);
  assignment.queue = Array.isArray(assignment.queue) ? assignment.queue.map(normalizeQueueItem) : [];
  assignment.updatedAt = now;
  state.workspace.assignments[key] = assignment;
  return assignment;
}

function queueRunEntriesForTarget(target) {
  const assignment = assignmentForHwnd(target.hwnd);
  return assignedQueueRunEntries(assignment, workflowById, normalizeQueueItem);
}

function renumberQueue(queue) {
  return queue.map((item, index) => normalizeQueueItem({ ...item, order: index + 1 }));
}

function selectedWorkflowIdsForQueue() {
  const select = $("#queue-workflow-picker");
  const selected = select ? [...select.selectedOptions].map((option) => option.value) : [];
  if (selected.length) return selected;
  return activeWorkflow()?.id ? [activeWorkflow().id] : [];
}

function queueTimingOptions() {
  return {
    staggerMs: normalizedNonNegativeInteger($("#queue-stagger-ms")?.value) ?? 0,
    gapMs: normalizedNonNegativeInteger($("#queue-gap-ms")?.value) ?? 0,
  };
}

function queueItemForWorkflow(workflowId, order = 1, options = {}) {
  return normalizeQueueItem({
    workflowId,
    order,
    startDelayMs: options.startDelayMs,
    afterDelayMs: options.afterDelayMs,
    addedAt: new Date().toISOString(),
  });
}

function cloneQueueItems(queue) {
  return (queue || [])
    .filter((item) => workflowById(item.workflowId))
    .map((item, index) =>
      normalizeQueueItem({
        workflowId: item.workflowId,
        enabled: item.enabled,
        order: index + 1,
        startDelayMs: item.startDelayMs,
        afterDelayMs: item.afterDelayMs,
        addedAt: new Date().toISOString(),
      }),
    );
}

function totalQueuedWorkflows() {
  return Object.values(state.workspace.assignments || {}).reduce(
    (sum, assignment) => sum + (assignment.queue?.length || 0),
    0,
  );
}

function renderQueueOverview() {
  const board = $("#queue-overview");
  if (!board) return;
  board.replaceChildren();
  const rows = Object.entries(state.workspace.assignments || {}).filter(
    ([, assignment]) => (assignment.queue || []).length,
  );
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "暂无窗口队列";
    board.append(empty);
    return;
  }
  for (const [hwnd, assignment] of rows.slice(0, 5)) {
    const target = state.windows.find((item) => String(item.hwnd) === String(hwnd));
    const readiness = queueReadinessSummary(assignment);
    const queue = readiness.queue;
    const enabled = readiness.runnableEntries;
    const stepTotal = enabled.reduce((sum, entry) => sum + (entry.workflow?.steps.length || 0), 0);
    const delayTotal = enabled.reduce(
      (sum, entry) => sum + (entry.item.startDelayMs || 0) + (entry.item.afterDelayMs || 0),
      0,
    );
    const row = document.createElement("article");
    row.className = `queue-overview-row ${readiness.level}`;
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(target?.display || assignment.display || `hwnd=${hwnd}`)}</strong>
        <small>${enabled.length}/${queue.length} 项可跑 · ${stepTotal} 步 · 等待 ${durationLabel(delayTotal)} · ${escapeHtml(readiness.detail)}</small>
      </div>
      <em class="readiness-pill ${readiness.level}" title="${escapeHtml(readiness.firstBlockingMessage || readiness.detail)}">${escapeHtml(readiness.label)}</em>
    `;
    const chips = document.createElement("div");
    chips.className = "queue-overview-chips";
    for (const { item, workflow } of enabled.slice(0, 4)) {
      const chip = document.createElement("span");
      chip.textContent = workflow.name;
      chip.title = queueItemSummary(item, workflow);
      chips.append(chip);
    }
    if (enabled.length > 4) {
      const more = document.createElement("span");
      more.textContent = `+${enabled.length - 4}`;
      chips.append(more);
    }
    row.append(chips);
    board.append(row);
  }
  if (rows.length > 5) {
    const more = document.createElement("div");
    more.className = "queue-overview-more";
    more.textContent = `还有 ${rows.length - 5} 个窗口队列`;
    board.append(more);
  }
}

function renderOpsDashboard() {
  const windows = state.windows || [];
  const selectedCount = selectedWindows().length;
  const elevatedCount = windows.filter((item) => item.elevated === true).length;
  const assignmentCount = Object.values(state.workspace.assignments || {}).filter(
    (assignment) => (assignment.queue || []).length,
  ).length;
  const queueTotal = totalQueuedWorkflows();
  const sessions = Object.values(state.sessions || {});
  const currentRunningSessions = sessions.filter((session) => session.status === "running" && !session.pauseRequested);
  const currentPausedSessions = sessions.filter((session) => session.status === "paused");
  const currentPauseRequestedSessions = sessions.filter(
    (session) => session.status === "running" && session.pauseRequested,
  );
  const active = activeWorkflow();
  const completion = active ? workflowCompletionState(active, validateWorkflow(active, "background")) : null;
  const workbenchItems = workbenchReadinessItems(completion);
  const workbenchSummary = readinessBucketSummary(workbenchItems);
  const issueCount = workbenchSummary.issues;
  const warningCount = workbenchSummary.warnings;
  const gapDetail = readinessDetailText(workbenchSummary);
  const lastRun = state.workspace.runHistory?.[0] || null;

  setText("#ops-window-total", windows.length);
  setText("#ops-window-detail", `已选 ${selectedCount} · 管理员 ${elevatedCount}`);
  setText("#ops-queue-total", queueTotal);
  setText("#ops-queue-detail", `${assignmentCount} 个窗口已分配`);
  setText("#ops-running-total", currentRunningSessions.length + currentPausedSessions.length + currentPauseRequestedSessions.length);
  setText(
    "#ops-running-detail",
    currentRunningSessions.length || currentPausedSessions.length || currentPauseRequestedSessions.length
      ? `运行 ${currentRunningSessions.length} · 暂停 ${currentPausedSessions.length} · 待暂停 ${currentPauseRequestedSessions.length}`
      : "idle",
  );
  setText("#ops-active-workflow", active?.name || "未载入");
  setText(
    "#ops-active-gaps",
    active
      ? `${active.steps.length} 步 · 阻塞 ${issueCount} · 提醒 ${warningCount}${gapDetail ? ` · ${gapDetail}` : ""}`
      : "等待工作区",
  );
  setText("#ops-dispatch-mode", state.privilege?.currentProcessElevated ? "Admin + PostMessageW" : "PostMessageW");
  setText(
    "#ops-dispatch-detail",
    workbenchSummary.permissionBlocks
      ? "需要管理员权限后再后台运行"
      : workbenchSummary.windowIdentityBlocks
        ? "窗口身份需要刷新确认"
        : workbenchSummary.missingWindows
          ? "等待选择目标窗口"
          : windows.length
            ? `hwnd 身份复核 · ${TARGET_TITLE}`
            : "等待扫描目标窗口",
  );
  setText("#ops-last-run-status", lastRun?.status || "none");
  setText(
    "#ops-last-run-detail",
    lastRun
      ? `${lastRun.display || lastRun.hwnd} · ${durationLabel(lastRun.durationMs)} · ${lastRun.endedAt || ""}`
      : "暂无运行记录",
  );
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = String(value ?? "");
}

function renderAll() {
  fillWorkflowBlueprintSelect($("#workflow-blueprint-select"));
  renderBlueprintPreview();
  renderBlueprintGallery();
  renderQueueWorkflowPicker();
  renderWorkflowList();
  renderWorkflowForm();
  renderSteps();
  renderStepEditor();
  renderTargets();
  renderWindows();
  renderAssignments();
  renderSessions();
  renderOpsDashboard();
}

function readinessBucketSummary(items = []) {
  const buckets = {
    issues: 0,
    warnings: 0,
    missingAssets: 0,
    missingCoords: 0,
    missingOcrTexts: 0,
    missingWindows: 0,
    permissionBlocks: 0,
    windowIdentityBlocks: 0,
    controlFlowBlocks: 0,
    targetIssues: 0,
    textIssues: 0,
    roiWarnings: 0,
    plannedSemantics: 0,
    restorePlans: 0,
    timingIssues: 0,
    hotkeyWarnings: 0,
    mouseWarnings: 0,
    thresholdWarnings: 0,
    sampleCoverageWarnings: 0,
  };
  for (const item of items) {
    if (item.severity === "issue") buckets.issues += 1;
    if (item.severity === "warning") buckets.warnings += 1;
    const category = item.category || readinessGapForMessage(item.message).category;
    if (category === "missing_asset") buckets.missingAssets += 1;
    if (category === "missing_coordinate") buckets.missingCoords += 1;
    if (category === "missing_ocr_text") buckets.missingOcrTexts += 1;
    if (category === "missing_window") buckets.missingWindows += 1;
    if (category === "permission") buckets.permissionBlocks += 1;
    if (category === "window_identity") buckets.windowIdentityBlocks += 1;
    if (["task_jump", "recovery_entry", "loop_control", "unsupported_guard"].includes(category)) buckets.controlFlowBlocks += 1;
    if (category === "missing_target") buckets.targetIssues += 1;
    if (category === "text_input") buckets.textIssues += 1;
    if (category === "roi_warning") buckets.roiWarnings += 1;
    if (category === "planned_semantic" || category === "restore_plan") buckets.plannedSemantics += 1;
    if (category === "restore_plan") buckets.restorePlans += 1;
    if (category === "timing") buckets.timingIssues += 1;
    if (category === "hotkey") buckets.hotkeyWarnings += 1;
    if (category === "mouse_button") buckets.mouseWarnings += 1;
    if (category === "threshold") buckets.thresholdWarnings += 1;
    if (category === "step_structure") buckets.sampleCoverageWarnings += 1;
  }
  return buckets;
}

function readinessDetailText(summary) {
  const details = [];
  if (summary.missingWindows) details.push(`缺窗口 ${summary.missingWindows}`);
  if (summary.permissionBlocks) details.push(`权限 ${summary.permissionBlocks}`);
  if (summary.windowIdentityBlocks) details.push(`窗口身份 ${summary.windowIdentityBlocks}`);
  if (summary.missingAssets) details.push(`缺素材 ${summary.missingAssets}`);
  if (summary.missingCoords) details.push(`缺坐标 ${summary.missingCoords}`);
  if (summary.missingOcrTexts) details.push(`OCR ${summary.missingOcrTexts}`);
  if (summary.targetIssues) details.push(`目标 ${summary.targetIssues}`);
  if (summary.textIssues) details.push(`文本 ${summary.textIssues}`);
  if (summary.roiWarnings) details.push(`ROI 提醒 ${summary.roiWarnings}`);
  if (summary.controlFlowBlocks) details.push(`流程 ${summary.controlFlowBlocks}`);
  if (summary.plannedSemantics) details.push(`计划态 ${summary.plannedSemantics}`);
  if (summary.restorePlans) details.push(`恢复计划 ${summary.restorePlans}`);
  if (summary.timingIssues) details.push(`时间 ${summary.timingIssues}`);
  return details.join(" · ");
}

function addReadinessBuckets(target, source = {}) {
  for (const key of [
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
  ]) {
    target[key] = (target[key] || 0) + (Number(source[key]) || 0);
  }
  return target;
}

function isPlannedSemanticMessage(message) {
  return /计划态|不会改变真实执行路径|不会执行真实条件分支/.test(String(message || ""));
}

function isRestorePlanMessage(message) {
  return /restore|恢复/.test(String(message || "")) && isPlannedSemanticMessage(message);
}

function readinessGapForMessage(message) {
  const text = String(message || "");
  if (isRestorePlanMessage(text)) {
    return {
      category: "restore_plan",
      kind: "恢复",
      action: "配恢复",
      focusSelector: "#param-control-recovery-step",
      statusMessage: "已定位恢复计划：确认恢复入口指向可执行恢复片段，而不是计划态 restore 步骤",
    };
  }
  if (isPlannedSemanticMessage(text)) {
    return {
      category: "planned_semantic",
      kind: "流程",
      action: "看计划",
      focusSelector: "",
      statusMessage: "已定位计划态流程：它会保留语义提醒，但不会投递后台输入",
    };
  }
  if (text.includes("Ctrl+V 图片") || text.includes("图像步骤")) {
    return {
      category: "missing_asset",
      kind: "缺素材",
      action: "粘贴图",
      focusSelector: "#param-target-select",
      statusMessage: "已定位缺图步骤：复制图片后直接 Ctrl+V，或在预览中框 ROI 后存为目标",
    };
  }
  if (text.includes("OCR 需要目标文本")) {
    return {
      category: "missing_ocr_text",
      kind: "OCR",
      action: "填文本",
      focusSelector: "#target-texts",
      statusMessage: "已定位 OCR 步骤：填写目标文本后即可用于后台识别",
    };
  }
  if (/后台(?:点击|双击)需要/.test(text)) {
    return {
      category: "missing_coordinate",
      kind: "坐标",
      action: "填坐标",
      focusSelector: "#param-click-x",
      statusMessage: "已定位点击步骤：填写 x/y 坐标或绑定 ROI 目标",
    };
  }
  if (text.includes("未限定 ROI")) {
    return {
      category: "roi_warning",
      kind: "ROI",
      action: "设 ROI",
      focusSelector: "#target-editor",
      statusMessage: "已定位 OCR ROI 提醒：可绑定 ROI 或在命令里设置 roi=top/panel/dialog",
    };
  }
  if (text.includes("识别目标已不存在") || text.includes("缺少目标")) {
    return {
      category: "missing_target",
      kind: "目标",
      action: "绑目标",
      focusSelector: "#param-target-select",
      statusMessage: "已定位目标绑定问题：选择共享目标，或用 Ctrl+V / ROI 创建一个新目标",
    };
  }
  if (text.includes("文本输入")) {
    return {
      category: "text_input",
      kind: "文本",
      action: "填文本",
      focusSelector: "#param-text-value",
      statusMessage: "已定位文本输入步骤：填写要发给目标窗口的文字",
    };
  }
  if (text.includes("快捷键")) {
    return {
      category: "hotkey",
      kind: "热键",
      action: "改热键",
      focusSelector: "#param-hotkey",
      statusMessage: "已定位快捷键步骤：使用 ALT+N、ESC 这类后端可投递的格式",
    };
  }
  if (text.includes("阈值")) {
    return {
      category: "threshold",
      kind: "阈值",
      action: "改阈值",
      focusSelector: "#param-image-threshold",
      statusMessage: "已定位阈值配置：将匹配阈值设在 0 到 1 之间",
    };
  }
  if (text.includes("鼠标键")) {
    return {
      category: "mouse_button",
      kind: "鼠标",
      action: "改按钮",
      focusSelector: "#param-click-button",
      statusMessage: "已定位鼠标按钮配置：后台点击当前只支持 left/right",
    };
  }
  if (text.includes("任务跳转")) {
    return {
      category: "task_jump",
      kind: "跳转",
      action: "选任务",
      focusSelector: "#param-control-workflow-jump",
      statusMessage: "已定位任务跳转：选择目标任务，并给可能成环的跳转设置最大次数",
    };
  }
  if (text.includes("guard=") || text.includes("条件")) {
    return {
      category: "unsupported_guard",
      kind: "条件",
      action: "改条件",
      focusSelector: "#param-condition-guard",
      statusMessage: "已定位条件判断：guard 只支持 true/false、last.matched、last.status、last.action 或 last.score 比较",
    };
  }
  if (text.includes("恢复入口")) {
    return {
      category: "recovery_entry",
      kind: "恢复",
      action: "配恢复",
      focusSelector: "#param-control-recovery-step",
      statusMessage: "已定位恢复入口：指向热键、等待、页面确认等可执行恢复片段第一步",
    };
  }
  if (text.includes("循环") || text.includes("后向跳转")) {
    return {
      category: "loop_control",
      kind: "循环",
      action: "设次数",
      focusSelector: "#param-control-max-iterations",
      statusMessage: "已定位循环控制：后向跳转必须设置最大循环次数",
    };
  }
  if (text.includes("延迟") || text.includes("间隔")) {
    return {
      category: "timing",
      kind: "时间",
      action: "改时间",
      focusSelector: text.includes("重试间隔") ? "#param-retry-interval" : "#param-delay-ms",
      statusMessage: "已定位时间参数：使用 300ms、1s 或非负毫秒数字",
    };
  }
  if (text.includes("权限") || text.includes("管理员") || text.includes("elevated")) {
    return {
      category: "permission",
      kind: "权限",
      action: "提权限",
      focusSelector: "#restart-admin",
      statusMessage: "已定位权限问题：以管理员身份运行控制器后再接管高权限窗口",
    };
  }
  if (text.includes("窗口身份") || text.includes("identity mismatch") || text.includes("身份不匹配")) {
    return {
      category: "window_identity",
      kind: "窗口身份",
      action: "刷新",
      focusSelector: "#refresh-windows",
      statusMessage: "已定位窗口身份问题：刷新窗口后重新选择并分配队列，避免 hwnd 漂移",
    };
  }
  if (text.includes("窗口") || text.includes("hwnd")) {
    return {
      category: "missing_window",
      kind: "缺窗口",
      action: "选窗口",
      focusSelector: "#refresh-windows",
      statusMessage: "已定位窗口问题：刷新窗口后重新选择或分配队列",
    };
  }
  if (text.includes("少于 10 步") || text.includes("步骤")) {
    return {
      category: "step_structure",
      kind: "步骤",
      action: "加步骤",
      focusSelector: "#step-block-preset",
      statusMessage: "已定位步骤结构问题：可插入完整任务骨架或继续添加步骤",
    };
  }
  return {
    category: text.includes("提醒") ? "warning" : "unknown",
    kind: text.includes("提醒") ? "提醒" : "检查",
    action: "定位",
    focusSelector: "",
    statusMessage: `已定位：${completionMessageDetail(text)}`,
  };
}

function readinessRuntimeItem(message, severity = "issue", title = "运行环境") {
  const gap = readinessGapForMessage(message);
  return {
    stepId: "",
    stepIndex: null,
    severity,
    category: gap.category,
    kind: gap.kind,
    title,
    action: gap.action,
    focusSelector: gap.focusSelector,
    statusMessage: gap.statusMessage,
    message,
  };
}

function workbenchReadinessItems(completion = null) {
  const items = [...(completion?.items || [])];
  const windows = state.windows || [];
  const selected = selectedWindows();
  if (!windows.length) {
    items.push(readinessRuntimeItem(`未找到标题包含“${TARGET_TITLE}”的目标窗口`));
  } else if (!selected.length) {
    items.push(readinessRuntimeItem("没有选中的目标窗口"));
  }
  const elevatedSelected = selected.filter((item) => item.elevated === true).length;
  if (elevatedSelected > 0 && state.privilege?.currentProcessElevated === false) {
    items.push(readinessRuntimeItem(`权限不足：已选 ${elevatedSelected} 个管理员目标窗口，请用管理员权限运行编排器`));
  }
  for (const target of selected) {
    const assignment = assignmentForHwnd(target.hwnd);
    if (!assignment?.queue?.length) continue;
    const mismatch = windowIdentityMismatchReason(assignment.windowIdentity, windowIdentityForTarget(target));
    if (mismatch) {
      items.push(readinessRuntimeItem(`${target.display || target.hwnd} 队列窗口身份不匹配：${mismatch}`));
    }
  }
  return items;
}

function queueRuntimeReadinessItems(assignment) {
  const items = [];
  if (!assignment?.hwnd) {
    items.push(readinessRuntimeItem("窗口队列缺少 hwnd，请刷新窗口后重新分配队列", "issue", "窗口队列"));
    return items;
  }
  const target = windowForAssignment(assignment);
  const label = assignment.display || assignment.title || `hwnd=${assignment.hwnd}`;
  if (!target) {
    items.push(readinessRuntimeItem(`${label} 当前不在窗口列表中，请刷新窗口后确认队列`, "issue", "窗口队列"));
    return items;
  }
  const expected = normalizeWindowIdentity(assignment.windowIdentity || assignment);
  const current = windowIdentityForTarget(target);
  const expectedIssue = requiredBackgroundWindowIdentityIssue(expected);
  if (expectedIssue) {
    items.push(readinessRuntimeItem(`${label} 队列窗口身份不完整：${expectedIssue}`, "issue", "窗口队列"));
  }
  const currentIssue = requiredBackgroundWindowIdentityIssue(current);
  if (currentIssue) {
    items.push(readinessRuntimeItem(`${target.display || label} 当前窗口身份不完整：${currentIssue}`, "issue", "窗口队列"));
  }
  const mismatch = windowIdentityMismatchReason(expected, current);
  if (mismatch) {
    items.push(readinessRuntimeItem(`${target.display || label} 队列窗口身份不匹配：${mismatch}`, "issue", "窗口队列"));
  }
  if (target.elevated === true && state.privilege?.currentProcessElevated === false) {
    items.push(readinessRuntimeItem(`${target.display || label} 是管理员目标窗口，请用管理员权限运行编排器`, "issue", "窗口队列"));
  }
  return items;
}

function workflowReadinessSummary(workflow, validation = null) {
  const completion = workflowCompletionState(workflow, validation || validateWorkflow(workflow, "background"));
  const summary = readinessBucketSummary(completion.items);
  const level = summary.issues ? "blocked" : summary.warnings ? "warning" : "ready";
  const label =
    level === "blocked"
      ? `需采样 ${summary.issues}`
      : summary.plannedSemantics
        ? `输入就绪 · 计划态 ${summary.plannedSemantics}`
        : level === "warning"
        ? `可执行 · ${summary.warnings} 提醒`
        : "后台就绪";
  return {
    ...summary,
    level,
    label,
    detail: readinessDetailText(summary),
    completion,
  };
}

function queueReadinessSummary(assignment) {
  const queue = (assignment?.queue || []).map(normalizeQueueItem);
  const runtimeItems = queueRuntimeReadinessItems(assignment);
  const runtimeBuckets = readinessBucketSummary(runtimeItems);
  const enabledItems = queue.filter((item) => item.enabled !== false);
  const runnableEntries = enabledItems
    .map((item) => ({ item, workflow: workflowById(item.workflowId) }))
    .filter((entry) => entry.workflow);
  const workflows = runnableEntries.map((entry) => entry.workflow);
  const missingWorkflowCount = enabledItems.length - workflows.length;
  const disabledCount = queue.length - enabledItems.length;
  const validation = workflows.length
    ? validateWorkflowQueue(workflows, "background")
    : { issues: [], warnings: [], firstBlockingWorkflow: null, firstBlockingValidation: null };
  const readinessBuckets = readinessBucketSummary([]);
  for (const workflow of workflows) {
    addReadinessBuckets(readinessBuckets, workflowReadinessSummary(workflow));
  }
  addReadinessBuckets(readinessBuckets, runtimeBuckets);
  const issueCount =
    validation.issues.length +
    missingWorkflowCount +
    runtimeBuckets.issues +
    (queue.length && !workflows.length ? 1 : 0);
  const warningCount = validation.warnings.length + disabledCount + runtimeBuckets.warnings;
  const level = issueCount ? "blocked" : warningCount ? "warning" : "ready";
  const label =
    level === "blocked"
      ? `阻塞 ${issueCount}`
      : level === "warning"
        ? `提醒 ${warningCount}`
        : "队列就绪";
  const details = [];
  if (workflows.length) details.push(`${workflows.length}/${queue.length} 项可跑`);
  if (missingWorkflowCount) details.push(`丢失任务 ${missingWorkflowCount}`);
  if (disabledCount) details.push(`停用 ${disabledCount}`);
  if (validation.issues.length) details.push(`校验阻塞 ${validation.issues.length}`);
  if (validation.warnings.length) details.push(`校验提醒 ${validation.warnings.length}`);
  if (runtimeBuckets.issues) details.push(`运行环境 ${runtimeBuckets.issues}`);
  if (runtimeBuckets.warnings) details.push(`环境提醒 ${runtimeBuckets.warnings}`);
  const classifiedDetail = readinessDetailText(readinessBuckets);
  if (classifiedDetail) details.push(classifiedDetail);
  const plannedWarningCount = validation.warnings.filter(isPlannedSemanticMessage).length;
  if (plannedWarningCount && !readinessBuckets.plannedSemantics) details.push(`计划态 ${plannedWarningCount}`);
  if (!queue.length) details.push("暂无任务");
  if (queue.length && !workflows.length && !missingWorkflowCount) details.push("没有启用任务");
  return {
    queue,
    enabledItems,
    runnableEntries,
    workflows,
    validation,
    level,
    label,
    issueCount,
    warningCount,
    missingWorkflowCount,
    disabledCount,
    runtimeItems,
    runtimeBuckets,
    readinessBuckets,
    detail: details.join(" · ") || "后台链路满足基础要求",
    firstBlockingMessage:
      validation.issues[0] ||
      runtimeItems.find((item) => item.severity === "issue")?.message ||
      (missingWorkflowCount ? "队列里有已删除或不可用任务" : "") ||
      validation.warnings[0] ||
      runtimeItems[0]?.message ||
      "",
  };
}

function renderWorkflowList() {
  $("#workflow-count").textContent = String(state.workspace.workflows.length);
  const list = $("#workflow-list");
  list.replaceChildren();
  for (const item of state.workspace.workflows) {
    const readiness = workflowReadinessSummary(item);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `workflow-row ${readiness.level}`;
    button.classList.toggle("active", item.id === state.workspace.activeWorkflowId);
    const detail = readiness.detail || "素材、坐标和 OCR 已满足后台基础要求";
    button.innerHTML = `
      <div class="workflow-row-head">
        <strong>${escapeHtml(item.name)}</strong>
        <em class="readiness-pill ${readiness.level}" title="${escapeHtml(detail)}">${escapeHtml(readiness.label)}</em>
      </div>
      <span>${escapeHtml(item.category || "未分类")} · ${item.steps.length} 步</span>
      <small>${escapeHtml(detail)} · ${escapeHtml(item.description || "无备注")}</small>
    `;
    button.addEventListener("click", () => {
      state.workspace.activeWorkflowId = item.id;
      state.selectedStepId = item.steps[0]?.id || null;
      setInspectorTab("workflow");
      renderWorkflowForm();
      renderWorkflowList();
      renderSteps();
      renderStepEditor();
      renderTargets();
      renderOpsDashboard();
      setStatus(`已选择任务：${item.name}`);
    });
    list.append(button);
  }
}

function renderWorkflowForm() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  $("#active-workflow-title").textContent = workflow.name;
  $("#workflow-name").value = workflow.name;
  $("#workflow-category").value = workflow.category || "";
  $("#workflow-initial-check").value = workflow.initialCheck || "";
  $("#workflow-concurrency").value = workflow.targetPolicy?.concurrency || "per-window-exclusive";
  $("#workflow-description").value = workflow.description || "";
}

function bindWorkflowInputs() {
  const updates = [
    ["#workflow-name", "name"],
    ["#workflow-category", "category"],
    ["#workflow-initial-check", "initialCheck"],
    ["#workflow-description", "description"],
  ];
  for (const [selector, field] of updates) {
    $(selector).addEventListener("input", (event) => {
      const workflow = activeWorkflow();
      if (!workflow) return;
      workflow[field] = event.target.value;
      markDirty("draft");
      renderWorkflowForm();
      renderSteps();
    });
  }
  $("#workflow-concurrency").addEventListener("change", (event) => {
    const workflow = activeWorkflow();
    if (!workflow) return;
    workflow.targetPolicy.concurrency = workflowConcurrencyOptions.has(event.target.value)
      ? event.target.value
      : "per-window-exclusive";
    markDirty("draft");
  });
}

function blueprintTargetId(definition, namespace) {
  if (
    !targetBackedStepTypes.has(definition.type) ||
    !isLogicalTargetName(definition.target)
  ) {
    return "";
  }
  const group = definition.type === "ocr_assert" ? "ocr" : "target";
  return `${namespace}.${group}.${definition.target.trim()}`;
}

function createBlueprintStep(definition, namespace) {
  return normalizeStep({
    ...definition,
    id: randomId("step"),
    targetId: blueprintTargetId(definition, namespace),
  });
}

function createWorkflowFromBlueprint(blueprintInput, index = 1, namePrefix = "") {
  const blueprint = typeof blueprintInput === "string" ? workflowBlueprintById(blueprintInput) : blueprintInput;
  const workflowId = randomId("wf");
  const namespace = `task.${blueprint.id}.${workflowId}`;
  const prefix = String(namePrefix || blueprint.defaultPrefix || blueprint.label || "任务").trim();
  const blueprintSteps = blueprint.steps.map((item) => createBlueprintStep(item, namespace));
  const steps = withDefaultRecoveryReferences(
    withDefaultRecoveryFragment(blueprintSteps, `${workflowId}-recovery`, {
      force: blueprint.autoRecovery === true,
    }),
  );
  const workflow = normalizeWorkflow({
    id: workflowId,
    name: index > 1 ? `${prefix} ${index}` : prefix,
    category: blueprint.category || "草稿",
    description: blueprint.description || "",
    tags: ["蓝图", blueprint.label || blueprint.id],
    steps,
  });
  ensureTargetsForSteps(workflow.steps);
  return workflow;
}

async function createWorkflowBatch(options = {}) {
  const blueprint = workflowBlueprintById(options.blueprintId || $("#workflow-blueprint-select")?.value);
  const countInput = Number($("#workflow-batch-count")?.value || 1);
  const count = Math.max(1, Math.min(10, Math.floor(Number.isFinite(countInput) ? countInput : 1)));
  const prefix = String(options.namePrefix ?? $("#workflow-name-prefix")?.value ?? "").trim();
  const workflows = Array.from({ length: count }, (_, index) =>
    createWorkflowFromBlueprint(blueprint, index + 1, prefix),
  );
  state.workspace.workflows.unshift(...workflows);
  state.workspace.activeWorkflowId = workflows[0]?.id || state.workspace.activeWorkflowId;
  state.selectedStepId = workflows[0]?.steps[0]?.id || null;
  selectFirstUnboundCapturedStep(workflows[0]?.steps || []);
  await hydrateBuiltinTargetTemplates({ log: true });
  markDirty("draft");
  renderAll();
  appendLog("info", `按蓝图生成 ${workflows.length} 个任务：${blueprint.label}`);
  if (options.assignToSelected) assignWorkflowsToSelected(workflows);
  return workflows;
}

async function importSampleWorkflowPack() {
  const existingIds = new Set(state.workspace.workflows.map((item) => item.id));
  const samples = createSampleWorkflows().filter((item) => !existingIds.has(item.id));
  if (!samples.length) {
    setStatus("内置示例包已存在");
    appendLog("info", "内置示例包已存在，没有重复导入");
    return [];
  }
  state.workspace.workflows.unshift(...samples);
  state.workspace.targets = mergeTargetCatalog(
    [...state.workspace.targets, ...createTargetCatalogFromWorkflows(samples)],
    state.workspace.workflows,
  );
  await hydrateBuiltinTargetTemplates({ log: true });
  state.workspace.activeWorkflowId = samples[0].id;
  state.selectedStepId = samples[0]?.steps[0]?.id || null;
  selectFirstUnboundCapturedStep(samples[0]?.steps || []);
  markDirty("sample pack");
  renderAll();
  setStatus(`已导入 ${samples.length} 个内置示例任务`);
  appendLog(
    "info",
    `导入示例包：${samples.map((item) => `${item.name}(${item.steps.length}步)`).join(" / ")}`,
  );
  return samples;
}

async function prepareExerciseWorkspace() {
  setStatus("正在准备多窗口演练...");
  await refreshWindows();
  selectGameWindows();
  const targets = selectedEditableWindows();
  const workflows = await ensureExerciseSuiteWorkflows();
  const queueResult = queueExerciseSuiteForTargets(workflows, targets, { onlyEmptyQueues: true });
  const hydrated = await hydrateBuiltinTargetTemplates({ log: true });
  state.workspace.activeWorkflowId = workflows[0]?.id || state.workspace.activeWorkflowId;
  state.selectedStepId = workflows[0]?.steps[0]?.id || state.selectedStepId;
  selectFirstUnboundCapturedStep(workflows[0]?.steps || []);
  markDirty("exercise prepared");
  renderAll();
  const validation = validateWorkflowQueue(workflows, "definition");
  if (validation.issues.length) {
    setRunState("blocked");
    $("#run-summary").textContent = validation.issues.join(" / ");
    appendLog("warn", `演练准备后定义校验未通过：${validation.issues.join("；")}`);
  } else {
    setRunState("ready");
    $("#run-summary").textContent =
      `演练准备完成：${workflows.length} 个任务 · ${queueResult.queued} 个窗口新写入队列 · ${queueResult.skipped} 个窗口保留原队列`;
  }
  await saveWorkspaceNow();
  setStatus(
    `演练已准备：${targets.length} 个窗口，新增队列 ${queueResult.queued} 个，保留 ${queueResult.skipped} 个，模板 ${hydrated} 个`,
  );
  appendLog(
    "info",
    `一键演练准备：任务 ${workflows.length} 个；窗口 ${targets.length} 个；新队列 ${queueResult.queueSizes.join(" / ") || "none"}；已保留已有队列 ${queueResult.skipped} 个`,
  );
}

async function ensureExerciseSuiteWorkflows() {
  const byBlueprintId = new Map();
  for (const workflow of state.workspace.workflows) {
    const labels = new Set((workflow.tags || []).map(String));
    for (const blueprintId of exerciseSuiteBlueprintIds) {
      const blueprint = workflowBlueprintById(blueprintId);
      if (
        labels.has(blueprint.label || blueprint.id) &&
        String(workflow.name || "").trim().startsWith("演练 ")
      ) {
        byBlueprintId.set(blueprintId, workflow);
      }
    }
  }

  const created = [];
  for (const blueprintId of exerciseSuiteBlueprintIds) {
    if (byBlueprintId.has(blueprintId)) continue;
    const blueprint = workflowBlueprintById(blueprintId);
    const workflow = createWorkflowFromBlueprint(blueprint, 1, `演练 ${blueprint.defaultPrefix || blueprint.label}`);
    byBlueprintId.set(blueprintId, workflow);
    created.push(workflow);
  }
  if (created.length) {
    state.workspace.workflows.unshift(...created);
    await hydrateBuiltinTargetTemplates({ log: true });
    appendLog("info", `补足演练任务：${created.map((item) => item.name).join(" / ")}`);
  }
  return exerciseSuiteBlueprintIds.map((blueprintId) => byBlueprintId.get(blueprintId)).filter(Boolean);
}

async function createExerciseSuite() {
  const workflows = exerciseSuiteBlueprintIds.map((blueprintId) => {
    const blueprint = workflowBlueprintById(blueprintId);
    return createWorkflowFromBlueprint(blueprint, 1, `演练 ${blueprint.defaultPrefix || blueprint.label}`);
  });
  state.workspace.workflows.unshift(...workflows);
  await hydrateBuiltinTargetTemplates({ log: true });
  state.workspace.activeWorkflowId = workflows[0]?.id || state.workspace.activeWorkflowId;
  state.selectedStepId = workflows[0]?.steps[0]?.id || null;
  selectFirstUnboundCapturedStep(workflows[0]?.steps || []);

  const targets = selectedEditableWindows();
  const queueResult = queueExerciseSuiteForTargets(workflows, targets);

  markDirty(targets.length ? "exercise suite queued" : "exercise suite");
  renderAll();
  const summary = `${workflows.length} 个任务 · 每个 ${workflows.map((item) => item.steps.length).join("/")} 步`;
  if (targets.length) {
    setStatus(`已生成演练套件并分配到 ${targets.length} 个窗口队列`);
    appendLog(
      "info",
      `演练套件：${summary}；窗口队列长度 ${queueResult.queueSizes.join(" / ")}；等待 ${queueResult.staggerMs}ms/${queueResult.gapMs}ms`,
    );
  } else {
    setStatus("已生成演练套件；选择窗口后可追加或复制队列");
    appendLog("info", `演练套件：${summary}；未选择窗口，暂未分配队列`);
  }
  return workflows;
}

function queueExerciseSuiteForTargets(workflows, targets, options = {}) {
  const timing = queueTimingOptions();
  const staggerMs = normalizedNonNegativeInteger(timing.staggerMs) ?? 0;
  const gapMs = normalizedNonNegativeInteger(timing.gapMs) ?? 0;
  const queueSizes = [];
  let queued = 0;
  let skipped = 0;
  for (const [targetIndex, target] of targets.entries()) {
    const assignment = ensureAssignment(target);
    if (options.onlyEmptyQueues && assignment.queue.length) {
      skipped += 1;
      continue;
    }
    const queueSize = Math.min(
      workflows.length,
      exerciseSuiteQueuePattern[targetIndex % exerciseSuiteQueuePattern.length],
    );
    queueSizes.push(queueSize);
    queued += 1;
    for (let workflowIndex = 0; workflowIndex < queueSize; workflowIndex += 1) {
      const workflow = workflows[(targetIndex + workflowIndex) % workflows.length];
      assignment.queue.push(
        queueItemForWorkflow(workflow.id, assignment.queue.length + 1, {
          startDelayMs: workflowIndex === 0 ? targetIndex * staggerMs : 0,
          afterDelayMs: gapMs,
        }),
      );
    }
    assignment.queue = renumberQueue(assignment.queue);
    assignment.updatedAt = new Date().toISOString();
  }
  return { queued, skipped, queueSizes, staggerMs, gapMs };
}

async function newWorkflow() {
  const blueprint = workflowBlueprintById($("#workflow-blueprint-select")?.value);
  const prefix = String($("#workflow-name-prefix")?.value || blueprint.defaultPrefix || "新任务").trim();
  const workflow = createWorkflowFromBlueprint(blueprint, 1, prefix);
  state.workspace.workflows.unshift(workflow);
  state.workspace.activeWorkflowId = workflow.id;
  state.selectedStepId = workflow.steps[0]?.id || null;
  selectFirstUnboundCapturedStep(workflow.steps);
  await hydrateBuiltinTargetTemplates({ log: true });
  markDirty("draft");
  renderAll();
}

function duplicateWorkflow() {
  const source = activeWorkflow();
  if (!source) return;
  const now = new Date().toISOString();
  const targetIdMap = new Map();
  const clonedTargets = [];
  const cloneTargetId = (oldTargetId, sourceStep) => {
    if (!oldTargetId) return "";
    if (targetIdMap.has(oldTargetId)) return targetIdMap.get(oldTargetId);
    const existing = state.workspace.targets.find((target) => target.id === oldTargetId);
    const cloned = cloneWorkflowTargetForDuplicate(existing, oldTargetId, sourceStep, source.name, now);
    targetIdMap.set(oldTargetId, cloned.id);
    clonedTargets.push(cloned);
    return cloned.id;
  };
  const copy = normalizeWorkflow(JSON.parse(JSON.stringify(source)));
  copy.id = randomId("wf");
  copy.name = `${source.name} 副本`;
  copy.createdAt = now;
  copy.updatedAt = copy.createdAt;
  const stepIdMap = new Map(source.steps.map((step) => [step.id, randomId("step")]));
  copy.steps = source.steps.map((sourceStep) => {
    const item = normalizeStep({
      ...JSON.parse(JSON.stringify(sourceStep)),
      id: stepIdMap.get(sourceStep.id) || randomId("step"),
    });
    remapStepControlFlowReferences(item, stepIdMap, { clearWorkflowReferences: false });
    if (item.jumpWorkflowId === source.id) item.jumpWorkflowId = copy.id;
    const oldTargetId = stepTargetId(sourceStep);
    const newTargetId = cloneTargetId(oldTargetId, sourceStep);
    if (newTargetId) {
      item.targetId = newTargetId;
      delete item.assetId;
      const sourceTargetText = String(sourceStep.target || "").trim();
      const oldExplicitTarget = String(sourceStep.targetId || sourceStep.assetId || "").trim();
      if (!sourceTargetText || sourceTargetText === oldTargetId || sourceTargetText === oldExplicitTarget) {
        item.target = newTargetId;
      } else {
        item.target = String(sourceStep.target || "");
      }
    }
    syncParamsFromLegacyFields(item);
    return item;
  });
  state.workspace.targets.unshift(...clonedTargets);
  state.workspace.workflows.unshift(copy);
  state.workspace.activeWorkflowId = copy.id;
  state.selectedStepId = copy.steps[0]?.id || null;
  markDirty("draft");
  renderAll();
  appendLog("info", `复制任务：${copy.name}，已克隆 ${clonedTargets.length} 个识别目标`);
}

function remapStepControlFlowReferences(item, stepIdMap, options = {}) {
  for (const field of controlFlowStepReferenceFields) {
    const current = item[field];
    item[field] = current && stepIdMap.has(current) ? stepIdMap.get(current) : "";
  }
  if (options.clearWorkflowReferences) {
    for (const field of controlFlowWorkflowReferenceFields) {
      item[field] = "";
    }
  }
}

function cloneWorkflowTargetForDuplicate(existingTarget, oldTargetId, sourceStep, sourceWorkflowName, timestamp) {
  const base = existingTarget
    ? JSON.parse(JSON.stringify(existingTarget))
    : {
        id: oldTargetId,
        name: friendlyTargetName(oldTargetId),
        kind: targetKindForStep(sourceStep),
        match: {
          threshold: defaultThresholdForStep(sourceStep) || DEFAULT_IMAGE_THRESHOLD,
          scope: commandValue(sourceStep.command, "roi") || "window",
        },
        click: {
          button: normalizedButton(sourceStep.command),
          point: commandValue(sourceStep.command, "point") || "center",
        },
        texts: sourceStep.type === "ocr_assert" ? [sourceStep.target] : [],
        note: "由复制任务补建的目标占位",
      };
  const originalNote = String(base.note || "").trim();
  return normalizeTarget({
    ...base,
    id: randomId("target"),
    name: `${base.name || friendlyTargetName(oldTargetId)} 副本`,
    createdAt: timestamp,
    updatedAt: timestamp,
    note: [originalNote, `由复制任务从“${sourceWorkflowName}”克隆，编辑不会影响原任务`]
      .filter(Boolean)
      .join("\n"),
  });
}

function deleteWorkflow() {
  const workflow = activeWorkflow();
  if (!workflow || state.workspace.workflows.length <= 1) {
    setStatus("至少保留一个任务");
    return;
  }
  state.workspace.workflows = state.workspace.workflows.filter((item) => item.id !== workflow.id);
  for (const [hwnd, assignment] of Object.entries(state.workspace.assignments)) {
    assignment.queue = (assignment.queue || []).filter((item) => item.workflowId !== workflow.id);
    if (!assignment.queue.length) delete state.workspace.assignments[hwnd];
  }
  state.workspace.activeWorkflowId = state.workspace.workflows[0]?.id || null;
  state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
  markDirty("draft");
  renderAll();
  appendLog("info", `删除任务：${workflow.name}`);
}

function fillStepTypeSelect(select) {
  select.replaceChildren(
    ...stepTypes.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${label} · ${value}`;
      return option;
    }),
  );
}

function fillStepBlockSelect(select) {
  select.replaceChildren(
    ...stepBlockPresets.map((preset) => {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      return option;
    }),
  );
}

function workflowBlueprintById(id) {
  return workflowBlueprints.find((item) => item.id === id) || workflowBlueprints[0];
}

function fillWorkflowBlueprintSelect(select) {
  if (!select) return;
  const current = select.value || workflowBlueprints[0]?.id || "";
  select.replaceChildren(
    ...workflowBlueprints.map((blueprint) => {
      const option = document.createElement("option");
      option.value = blueprint.id;
      option.textContent = `${blueprint.label} · ${blueprint.steps.length} 步`;
      return option;
    }),
  );
  select.value = workflowBlueprintById(current)?.id || workflowBlueprints[0]?.id || "";
  syncWorkflowBlueprintDefaults();
}

function syncWorkflowBlueprintDefaults(options = {}) {
  const input = $("#workflow-name-prefix");
  const blueprint = workflowBlueprintById($("#workflow-blueprint-select")?.value);
  if (!input || !blueprint) return;
  if (options.force || !input.value.trim()) input.value = blueprint.defaultPrefix || blueprint.label;
}

function renderBlueprintPreview() {
  const preview = $("#blueprint-preview");
  if (!preview) return;
  const blueprint = workflowBlueprintById($("#workflow-blueprint-select")?.value);
  if (!blueprint) {
    preview.replaceChildren();
    return;
  }
  const counts = blueprint.steps.reduce((sum, step) => {
    sum[step.type] = (sum[step.type] || 0) + 1;
    return sum;
  }, {});
  const actionStats = [
    ["hotkey", "热键"],
    ["image_click", "识图点击"],
    ["click", "坐标点击"],
    ["ocr_assert", "OCR"],
    ["wait_image", "等图"],
    ["text_input", "文本"],
    ["delay", "等待"],
  ]
    .filter(([type]) => counts[type])
    .map(([type, label]) => `${label} ${counts[type]}`)
    .join(" · ");

  preview.replaceChildren();
  const summary = document.createElement("div");
  summary.className = "blueprint-summary";
  summary.innerHTML = `
    <strong>${escapeHtml(blueprint.label)}</strong>
    <span>${escapeHtml(blueprint.category)} · ${blueprint.steps.length} 步 · ${escapeHtml(actionStats || "语义步骤")}</span>
    <small>${escapeHtml(blueprint.description || "")}</small>
  `;
  const track = document.createElement("div");
  track.className = "blueprint-step-track";
  blueprint.steps.slice(0, 12).forEach((step, index) => {
    const chip = document.createElement("span");
    chip.className = `blueprint-chip type-${step.type}`;
    chip.title = `${step.name} · ${step.target}`;
    chip.textContent = `${String(index + 1).padStart(2, "0")} ${stepLabels[step.type] || step.type}`;
    track.append(chip);
  });
  if (blueprint.steps.length > 12) {
    const more = document.createElement("span");
    more.className = "blueprint-chip more";
    more.textContent = `+${blueprint.steps.length - 12}`;
    track.append(more);
  }
  preview.append(summary, track);

  if (blueprint.id === HOME_VITALITY_BLUEPRINT_ID) {
    const assessment = assessActiveHomeVitalityReadiness();
    const gapSummary = summarizeHomeVitalityGaps(assessment);
    const liveGates = assessHomeVitalityLiveGates();
    const readiness = document.createElement("div");
    readiness.id = "home-vitality-readiness";
    readiness.className = `home-vitality-readiness ${assessment.offlineScaffoldReady ? "offline-ready" : "offline-gap"}`;
    const gapText = gapSummary.gaps.length
      ? gapSummary.gaps.slice(0, 4).map((item) => item.kind + (item.target ? `:${item.target}` : "")).join(" · ")
      : "无离线缺口（OCR/恢复仍非 live）";
    const liveBlocked = liveGates.items.filter((item) => item.required && !item.satisfied).map((item) => item.id);
    readiness.innerHTML = `
      <strong>家园活力离线就绪</strong>
      <span>${assessment.offlineScaffoldReady ? "脚手架已齐" : "脚手架未齐"} · liveReady=false · liveInputAuthorized=false</span>
      <small>缺口：${escapeHtml(gapText)}</small>
      <small>Live 门禁阻塞：${escapeHtml(liveBlocked.join(" · ") || "观察项未填写（fail-closed）")}</small>
    `;
    preview.append(readiness);
  }
}

function renderBlueprintGallery() {
  const gallery = $("#blueprint-gallery");
  const select = $("#workflow-blueprint-select");
  if (!gallery || !select) return;
  const activeId = workflowBlueprintById(select.value)?.id || workflowBlueprints[0]?.id || "";
  gallery.replaceChildren(
    ...workflowBlueprints.map((blueprint) => {
      const counts = blueprint.steps.reduce((sum, step) => {
        sum[step.type] = (sum[step.type] || 0) + 1;
        return sum;
      }, {});
      const button = document.createElement("button");
      button.type = "button";
      button.className = "blueprint-card";
      const visualActions = (counts.image_click || 0) + (counts.double_click || 0);
      button.classList.toggle("active", blueprint.id === activeId);
      button.innerHTML = `
        <span>${escapeHtml(blueprint.category)}</span>
        <strong>${escapeHtml(blueprint.label)}</strong>
        <small>${blueprint.steps.length} 步 · 热键 ${counts.hotkey || 0} · 识图动作 ${visualActions} · OCR ${counts.ocr_assert || 0}</small>
      `;
      button.addEventListener("click", () => {
        select.value = blueprint.id;
        syncWorkflowBlueprintDefaults({ force: true });
        renderBlueprintPreview();
        renderBlueprintGallery();
      });
      return button;
    }),
  );
}

function renderQueueWorkflowPicker() {
  const select = $("#queue-workflow-picker");
  if (!select) return;
  const previous = new Set([...select.selectedOptions].map((option) => option.value));
  const activeId = activeWorkflow()?.id || "";
  select.replaceChildren(
    ...state.workspace.workflows.map((workflow) => {
      const option = document.createElement("option");
      option.value = workflow.id;
      option.textContent = `${workflow.name} · ${workflow.steps.length} 步`;
      option.selected = previous.size ? previous.has(workflow.id) : workflow.id === activeId;
      return option;
    }),
  );
}

function renderSteps(validationOverride = null) {
  const workflow = activeWorkflow();
  $("#step-count").textContent = String(workflow?.steps.length || 0);
  const list = $("#step-list");
  list.replaceChildren();
  if (!workflow?.steps.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block";
    empty.textContent = "暂无步骤";
    list.append(empty);
    renderWorkflowCompletion(workflow);
    return;
  }
  if (!state.selectedStepId || !workflow.steps.some((item) => item.id === state.selectedStepId)) {
    state.selectedStepId = workflow.steps[0]?.id || null;
  }
  const validation = validationOverride || validateWorkflow(workflow, "background");
  state.stepValidation = buildStepValidationIndex(workflow, validation);
  workflow.steps.forEach((item, index) => {
    const row = document.createElement("button");
    const stepMessages = state.stepValidation[item.id] || { issues: [], warnings: [] };
    const badgeClass = stepMessages.issues.length ? "issue" : stepMessages.warnings.length ? "warning" : "";
    const badgeText = stepMessages.issues.length
      ? `问题 ${stepMessages.issues.length}`
      : stepMessages.warnings.length
        ? `提醒 ${stepMessages.warnings.length}`
        : "";
    const semanticBadges = [];
    if (plannedOnlyStepTypes.has(item.type)) {
      semanticBadges.push(`<em class="step-badge planned" title="此步骤当前只记录计划语义，不改变真实执行路径">计划态</em>`);
    }
    if (item.onFail === "restore") {
      const hasRecovery = Boolean(item.recoveryStepId);
      semanticBadges.push(
        `<em class="step-badge ${hasRecovery ? "flow" : "planned"}" title="${hasRecovery ? "失败时会跳转到恢复入口，恢复分支结束后停止当前窗口队列" : "未设置恢复入口，失败仍会停止队列"}">${hasRecovery ? "恢复分支" : "恢复待设"}</em>`,
      );
    }
    row.type = "button";
    row.className = "step-row";
    row.classList.toggle("active", item.id === state.selectedStepId);
    row.classList.toggle("disabled", item.enabled === false);
    row.classList.toggle("has-issue", stepMessages.issues.length > 0);
    row.classList.toggle("has-warning", !stepMessages.issues.length && stepMessages.warnings.length > 0);
    row.classList.toggle("planned-only", plannedOnlyStepTypes.has(item.type) || (item.onFail === "restore" && !item.recoveryStepId));
    row.innerHTML = `
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(item.name || stepLabels[item.type] || item.type)}</strong>
      <small>${item.enabled === false ? "停用 · " : ""}${escapeHtml(stepLabels[item.type] || item.type)} · ${escapeHtml(item.target || "target: none")}</small>
      ${badgeText ? `<em class="step-badge ${badgeClass}" title="${escapeHtml([...stepMessages.issues, ...stepMessages.warnings].join(" / "))}">${badgeText}</em>` : ""}
      ${semanticBadges.join("")}
    `;
    row.addEventListener("click", () => {
      state.selectedStepId = item.id;
      const boundTarget = targetForStep(item);
      if (boundTarget) state.selectedTargetId = boundTarget.id;
      setInspectorTab("step");
      renderSteps();
      renderStepEditor();
      renderTargets();
    });
    list.append(row);
  });
  renderWorkflowCompletion(workflow);
}

function renderWorkflowCompletion(workflow = activeWorkflow(), validation = null) {
  const board = $("#workflow-completion");
  if (!board) return;
  const title = $("#completion-title");
  const summary = $("#completion-summary");
  const list = $("#completion-list");
  const nextButton = $("#focus-next-gap");
  list.replaceChildren();
  if (!workflow) {
    title.textContent = "待补全";
    summary.textContent = "没有当前任务";
    nextButton.disabled = true;
    board.classList.remove("ready", "warning", "blocked");
    renderCompletionActionDock(null);
    return;
  }
  const completion = workflowCompletionState(workflow, validation || validateWorkflow(workflow, "background"));
  const readiness = readinessBucketSummary(completion.items);
  const issueCount = readiness.issues;
  const warningCount = readiness.warnings;
  const detail = readinessDetailText(readiness);
  board.classList.toggle("ready", completion.items.length === 0);
  board.classList.toggle("warning", issueCount === 0 && warningCount > 0);
  board.classList.toggle("blocked", issueCount > 0);
  nextButton.disabled = completion.items.length === 0;
  title.textContent = issueCount
    ? "仍需采样 / 配置"
    : readiness.plannedSemantics
      ? "输入链路就绪 / 流程仍是计划态"
      : warningCount
      ? "可后台执行（有建议）"
      : "后台真实执行就绪";
  summary.textContent = completion.items.length
    ? `${completion.items.length} 项待处理 · 阻塞 ${issueCount} · 提醒 ${warningCount}${detail ? ` · ${detail}` : ""}`
    : `${workflow.name} 输入链路可进入后台队列`;
  renderCompletionActionDock(completion);
  if (!completion.items.length) {
    const ready = document.createElement("div");
    ready.className = "empty-block compact";
    ready.textContent = "当前任务没有缺素材、缺坐标或缺 OCR 文本";
    list.append(ready);
    return;
  }
  for (const item of completion.items.slice(0, 8)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `completion-item ${item.severity}`;
    row.title = item.message;
    row.innerHTML = `
      <em>${escapeHtml(item.kind)}</em>
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(completionMessageDetail(item.message))}</small>
      </span>
      <b>${escapeHtml(item.action)}</b>
    `;
    row.addEventListener("click", () => {
      selectCompletionItem(item);
    });
    list.append(row);
  }
  if (completion.items.length > 8) {
    const more = document.createElement("div");
    more.className = "empty-block compact";
    more.textContent = `还有 ${completion.items.length - 8} 项，补完上面的项后会继续显示`;
    list.append(more);
  }
}

function renderCompletionActionDock(completion) {
  const dock = $("#completion-action-dock");
  if (!dock) return;
  dock.replaceChildren();
  const workflow = activeWorkflow();
  if (!workflow) {
    dock.hidden = true;
    return;
  }

  const items = completion?.items || [];
  const selectedGap = items.find((item) => item.stepId && item.stepId === state.selectedStepId);
  const environmentGap = workbenchReadinessItems(completion || { items: [] }).find((item) =>
    !item.stepId && ["missing_window", "permission", "window_identity"].includes(item.category),
  );
  const primary = selectedGap || items[0] || environmentGap || null;
  const actions = primary ? completionDockActionsForItem(primary, workflow) : completionReadyDockActions();
  if (!actions.length) {
    dock.hidden = true;
    return;
  }

  dock.hidden = false;
  const copy = document.createElement("div");
  copy.className = "completion-action-copy";
  copy.innerHTML = primary
    ? `
      <strong>${escapeHtml(primary.kind || "缺口")}</strong>
      <span>${escapeHtml(completionMessageDetail(primary.message || primary.statusMessage || "当前缺口"))}</span>
    `
    : `
      <strong>可演练</strong>
      <span>${escapeHtml(`${workflow.name} 已满足当前任务的输入链路要求`)}</span>
    `;
  const row = document.createElement("div");
  row.className = "completion-action-row";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `dock-action ${action.tone || "neutral"}`;
    button.dataset.dockAction = action.action;
    button.dataset.stepId = action.stepId || primary?.stepId || "";
    button.dataset.focusSelector = action.focusSelector || "";
    button.dataset.category = primary?.category || "";
    button.disabled = Boolean(action.disabled);
    button.title = action.title || "";
    button.textContent = action.label;
    row.append(button);
  }
  dock.append(copy, row);
}

function completionReadyDockActions() {
  return [
    completionDockAction("追加到已选窗口", "assign-active", { tone: "primary" }),
    completionDockAction("观察运行队列", "dry-run"),
    completionDockAction("准备演练", "prepare-exercise"),
  ];
}

function completionDockActionsForItem(item, workflow) {
  const stepItem = item?.stepId ? workflow.steps.find((step) => step.id === item.stepId) : null;
  const focusSelector = completionFocusSelector(item, stepItem) || item?.focusSelector || "";
  const actions = [];
  const addFocus = (label = item?.action || "定位字段") => {
    if (focusSelector) {
      actions.push(completionDockAction(label, "focus-gap", { focusSelector, stepId: item.stepId, tone: "primary" }));
    }
  };

  if (!item) return actions;
  if (item.category === "missing_asset") {
    actions.push(completionDockAction("剪贴板绑定图片", "clipboard-image", { stepId: item.stepId, tone: "primary" }));
    actions.push(completionDockAction("ROI 存为目标", "roi-target", { stepId: item.stepId }));
    actions.push(completionDockAction("接入内置素材", "builtin-templates", { stepId: item.stepId }));
    actions.push(completionDockAction("选择目标库", "target-library", { stepId: item.stepId, focusSelector }));
    return actions;
  }
  if (item.category === "missing_coordinate") {
    actions.push(completionDockAction("开启预览采点", "capture-point", { stepId: item.stepId, tone: "primary" }));
    actions.push(completionDockAction("用 ROI 中心", "roi-center", { stepId: item.stepId }));
    addFocus("填写 X/Y");
    return actions;
  }
  if (item.category === "missing_ocr_text") {
    addFocus("填写 OCR 文本");
    actions.push(completionDockAction("筛选 OCR 目标", "ocr-target-library", { stepId: item.stepId }));
    actions.push(completionDockAction("接入内置素材", "builtin-templates", { stepId: item.stepId }));
    return actions;
  }
  if (item.category === "missing_target") {
    actions.push(completionDockAction("选择目标库", "target-library", { stepId: item.stepId, tone: "primary" }));
    actions.push(completionDockAction("接入内置素材", "builtin-templates", { stepId: item.stepId }));
    actions.push(completionDockAction("剪贴板绑定图片", "clipboard-image", { stepId: item.stepId }));
    return actions;
  }
  if (item.category === "missing_window" || item.category === "window_identity") {
    actions.push(completionDockAction("刷新窗口", "refresh-windows", { tone: "primary" }));
    actions.push(completionDockAction("选择全部窗口", "select-windows"));
    return actions;
  }
  if (item.category === "permission") {
    actions.push(completionDockAction("管理员重启", "restart-admin", { tone: "primary" }));
    actions.push(completionDockAction("刷新窗口", "refresh-windows"));
    return actions;
  }
  if (item.category === "step_structure") {
    actions.push(completionDockAction("插入片段", "insert-step-block", { tone: "primary" }));
    addFocus("选择片段");
    return actions;
  }
  if (item.category === "recovery_entry") {
    actions.push(completionDockAction("插入恢复片段", "insert-recovery-fragment", { stepId: item.stepId, tone: "primary" }));
    actions.push(completionDockAction("标记当前为入口", "mark-recovery-entry", { stepId: item.stepId }));
    addFocus("选择恢复入口");
    return actions;
  }
  if (["task_jump", "loop_control", "unsupported_guard"].includes(item.category)) {
    addFocus(item.action || "定位流程");
    return actions;
  }
  addFocus(item.action || "定位字段");
  if (["text_input", "hotkey", "threshold", "mouse_button", "timing", "roi_warning"].includes(item.category)) {
    return actions;
  }
  if (item.stepId) actions.push(completionDockAction("选择目标库", "target-library", { stepId: item.stepId }));
  return actions;
}

function completionDockAction(label, action, options = {}) {
  return {
    label,
    action,
    stepId: options.stepId || "",
    focusSelector: options.focusSelector || "",
    tone: options.tone || "neutral",
    disabled: Boolean(options.disabled),
    title: options.title || "",
  };
}

function workflowCompletionState(workflow, validation = validateWorkflow(workflow, "background")) {
  const items = [];
  const stepMessages = new Set();
  const steps = workflow?.steps || [];
  for (const [index, item] of steps.entries()) {
    const messages = [
      ...(validation.stepIssues?.[item.id] || []).map((message) => ({ message, severity: "issue" })),
      ...(validation.stepWarnings?.[item.id] || []).map((message) => ({ message, severity: "warning" })),
    ];
    const hasSpecificGap = messages.some(({ message }) => isSpecificCompletionGap(message));
    for (const { message, severity } of messages) {
      stepMessages.add(message);
      if (hasSpecificGap && message.includes("缺少目标")) continue;
      const gap = readinessGapForMessage(message);
      items.push({
        stepId: item.id,
        stepIndex: index,
        severity,
        category: gap.category,
        kind: gap.kind,
        title: `${String(index + 1).padStart(2, "0")} ${item.name || stepLabels[item.type] || item.type}`,
        action: gap.action,
        focusSelector: gap.focusSelector,
        statusMessage: gap.statusMessage,
        message,
      });
    }
  }
  for (const message of validation.issues || []) {
    if (!stepMessages.has(message)) items.push(workflowCompletionItem(message, "issue", workflow));
  }
  for (const message of validation.warnings || []) {
    if (!stepMessages.has(message)) items.push(workflowCompletionItem(message, "warning", workflow));
  }
  items.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "issue" ? -1 : 1;
    return (left.stepIndex ?? 9999) - (right.stepIndex ?? 9999);
  });
  return { items, validation };
}

function workflowCompletionItem(message, severity, workflow) {
  const gap = readinessGapForMessage(message);
  return {
    stepId: "",
    stepIndex: null,
    severity,
    category: gap.category,
    kind: gap.kind,
    title: workflow?.name || "当前任务",
    action: gap.action,
    focusSelector: gap.focusSelector,
    statusMessage: gap.statusMessage,
    message,
  };
}

function isSpecificCompletionGap(message) {
  return /Ctrl\+V 图片|OCR 需要目标文本|文本输入需要|后台(?:点击|双击)需要|绑定的识别目标已不存在|匹配阈值|鼠标键|重试间隔|延迟步骤|计划态|不会自动执行恢复/.test(
    message,
  );
}

function completionKindForMessage(message) {
  return readinessGapForMessage(message).kind;
}

function completionActionForMessage(message) {
  return readinessGapForMessage(message).action;
}

function completionMessageDetail(message) {
  return String(message || "").replace(/^第\s+\d+\s+步\s*/, "");
}

function focusNextCompletionGap() {
  const workflow = activeWorkflow();
  const item = workflowCompletionState(workflow, validateWorkflow(workflow, "background")).items[0];
  if (!item) {
    setStatus("当前任务没有待补全项");
    return;
  }
  selectCompletionItem(item);
}

function selectCompletionItem(item) {
  const workflow = activeWorkflow();
  if (!workflow) return;
  if (item.stepId) {
    const stepItem = workflow.steps.find((step) => step.id === item.stepId);
    if (!selectStepAndTarget(stepItem)) return;
    revealCompletionTarget(stepItem, item);
    renderSteps();
    renderStepEditor();
    renderTargets();
    focusCompletionField(item, stepItem);
    setStatus(completionStatusMessage(item));
    return;
  }
  setInspectorTab("workflow");
  renderWorkflowForm();
  if (item.message.includes("少于 10 步")) {
    $("#step-block-preset")?.focus();
    setStatus("可插入完整任务骨架或继续添加步骤");
  } else {
    $("#workflow-name")?.focus();
    setStatus("已定位任务属性");
  }
}

function revealCompletionTarget(stepItem, completionItem) {
  const targetId = stepTargetId(stepItem);
  const target = targetId ? state.workspace.targets.find((item) => item.id === targetId) : null;
  if (target) {
    state.selectedTargetId = target.id;
    if (!targetPassesCurrentFilters(target)) {
      state.targetSearch = "";
      state.targetKindFilter = "all";
    }
    return;
  }
  if (completionItem.message.includes("缺少目标") || completionItem.message.includes("识别目标已不存在")) {
    state.selectedTargetId = "";
  }
}

function targetPassesCurrentFilters(target) {
  if (!target) return false;
  const query = state.targetSearch.trim().toLowerCase();
  if (state.targetKindFilter !== "all" && target.kind !== state.targetKindFilter) return false;
  return !query || targetSearchText(target).includes(query);
}

function focusCompletionField(item, stepItem) {
  const selector = completionFocusSelector(item, stepItem);
  setInspectorTab(inspectorTabForFocusSelector(selector));
  window.requestAnimationFrame(() => {
    const element = selector ? $(selector) : null;
    if (!element) return;
    openContainingDetails(element);
    element.focus();
    if (typeof element.select === "function") element.select();
  });
}

function openContainingDetails(element) {
  const details = element.closest?.("details");
  if (details) details.open = true;
}

function completionFocusSelector(item, stepItem) {
  if (item.category === "missing_ocr_text") {
    return targetForStep(stepItem) ? "#target-texts" : "#step-expect";
  }
  if (item.category === "mouse_button") {
    return ["image_click", "double_click"].includes(stepItem?.type) ? "#param-image-button" : "#param-click-button";
  }
  if (item.category === "timing") {
    return stepItem?.type === "retry_until" ? "#param-retry-interval" : "#param-delay-ms";
  }
  if (item.category === "loop_control" && item.message.includes("必须选择循环目标")) return "#param-control-target-step";
  return item.focusSelector || "";
}

function completionStatusMessage(item) {
  return item.statusMessage || readinessGapForMessage(item.message).statusMessage;
}

async function handleCompletionActionDock(event) {
  const button = event.target.closest("[data-dock-action]");
  if (!button) return;
  event.preventDefault();
  const action = button.dataset.dockAction;
  const stepId = button.dataset.stepId || "";
  if (stepId) focusCompletionDockStep(stepId);
  try {
    if (action === "focus-gap") {
      focusDockSelector(button.dataset.focusSelector);
    } else if (action === "clipboard-image") {
      await bindClipboardImageToCurrentStep();
    } else if (action === "roi-target") {
      await targetFromRoi();
    } else if (action === "capture-point") {
      enablePreviewClickCaptureFromDock();
    } else if (action === "roi-center") {
      applyRoiCenterToSelectedStep();
    } else if (action === "target-library") {
      focusTargetLibrary("all");
    } else if (action === "ocr-target-library") {
      focusTargetLibrary("ocr");
    } else if (action === "builtin-templates") {
      await applyBuiltinTemplatesToTargets();
    } else if (action === "refresh-windows") {
      await refreshWindows();
    } else if (action === "select-windows") {
      selectGameWindows();
    } else if (action === "restart-admin") {
      await restartAsAdmin();
    } else if (action === "assign-active") {
      assignWorkflowToSelected();
    } else if (action === "dry-run") {
      dryRunSelected();
    } else if (action === "prepare-exercise") {
      await prepareExerciseWorkspace();
    } else if (action === "insert-step-block") {
      insertStepBlock();
    } else if (action === "insert-recovery-fragment") {
      insertRecoveryFragmentForSelectedStep();
    } else if (action === "mark-recovery-entry") {
      markSelectedStepAsRecoveryEntry();
    }
  } catch (error) {
    setStatus(`动作执行失败：${error}`);
    appendLog("error", `补全动作失败：${action} / ${error}`);
  } finally {
    renderWorkflowCompletion();
  }
}

function focusCompletionDockStep(stepId) {
  const workflow = activeWorkflow();
  const stepItem = workflow?.steps.find((item) => item.id === stepId);
  if (!stepItem) return null;
  selectStepAndTarget(stepItem);
  renderSteps();
  renderStepEditor();
  renderTargets();
  return stepItem;
}

function focusDockSelector(selector) {
  if (!selector) {
    setStatus("当前缺口没有可聚焦字段");
    return;
  }
  window.requestAnimationFrame(() => {
    const element = $(selector);
    if (!element) {
      setStatus(`未找到字段：${selector}`);
      return;
    }
    openContainingDetails(element);
    element.scrollIntoView?.({ block: "center", behavior: "smooth" });
    element.focus();
    if (typeof element.select === "function") element.select();
    setStatus("已定位补全字段");
  });
}

function focusTargetLibrary(kind = "all") {
  state.targetSearch = "";
  state.targetKindFilter = kind === "ocr" ? "ocr" : "all";
  renderTargets();
  focusDockSelector("#target-search");
  setStatus(kind === "ocr" ? "已筛选 OCR 目标库" : "已定位目标库");
}

function enablePreviewClickCaptureFromDock() {
  if (!state.preview) {
    setStatus("请先刷新预览，再在预览图上采点");
  }
  if (!state.previewClickCapture) {
    togglePreviewClickCapture();
  } else {
    updatePreviewClickCaptureUi();
    setStatus("采点模式已开启：在预览图上点一下生成后台点击步骤");
  }
}

function applyRoiCenterToSelectedStep() {
  const item = selectedStep();
  if (!item) {
    setStatus("需要先选择点击步骤");
    return;
  }
  const target = selectedManagedTarget() || targetForStep(item);
  const roi = state.roiSelection || target?.roi;
  const point = roiCenterPoint(roi);
  if (!point) {
    setStatus("需要先框选 ROI，或选择带 ROI 的目标");
    return;
  }
  applyClickPointToStep(item, point, target?.click?.button || state.previewClickButton || "left");
  markDirty("draft");
  renderSteps();
  renderStepEditor();
  renderTargets();
  setStatus(`已用 ROI 中心写入后台点击坐标：${point.x},${point.y}`);
}

function createStep(type) {
  const defaults = stepDefaults[type] || stepDefaults.detect_page;
  return normalizeStep({
    id: randomId("step"),
    type,
    name: defaults.name,
    target: defaults.target,
    command: defaults.command,
    expect: defaults.expect,
    timeoutMs: defaults.timeoutMs,
    retry: defaults.retry,
    onFail: defaults.onFail,
  });
}

function selectedStepIndex(workflow = activeWorkflow()) {
  return workflow?.steps.findIndex((item) => item.id === state.selectedStepId) ?? -1;
}

function capturedStepNeedsImage(item) {
  return capturedImageStepTypes.has(item?.type) && !targetForStep(item)?.dataUrl;
}

function selectStepAndTarget(item) {
  if (!item) return false;
  state.selectedStepId = item.id;
  const boundTarget = targetForStep(item);
  state.selectedTargetId = boundTarget ? boundTarget.id : "";
  return true;
}

function selectFirstUnboundCapturedStep(steps) {
  return selectStepAndTarget(steps.find(capturedStepNeedsImage));
}

function selectNextUnboundCapturedStepAfter(stepId) {
  const workflow = activeWorkflow();
  const steps = workflow?.steps || [];
  const index = steps.findIndex((item) => item.id === stepId);
  if (index < 0) return false;
  return selectStepAndTarget(steps.slice(index + 1).find(capturedStepNeedsImage));
}

function ensureTargetsForSteps(steps) {
  for (const item of steps) {
    const id = catalogTargetIdForStep(item);
    if (!id) continue;
    if (state.workspace.targets.some((target) => target.id === id)) continue;
    state.workspace.targets.unshift(
      normalizeTarget({
        id,
        name: friendlyTargetName(id),
        kind: targetKindForStep(item),
        match: {
          threshold: defaultThresholdForStep(item) || DEFAULT_IMAGE_THRESHOLD,
          scope: "window",
        },
        click: {
          button: normalizedButton(item.command),
          point: commandValue(item.command, "point") || "center",
        },
        texts: item.type === "ocr_assert" ? [item.target] : [],
        safety: { requiresManualConfirmation: item.requiresManualConfirmation === true },
        note: "由步骤片段自动创建，可直接 Ctrl+V 粘贴图片或绑定 ROI",
      }),
    );
  }
}

function insertStepsAt(items, index) {
  const workflow = activeWorkflow();
  if (!workflow) return null;
  const nextItems = items.filter(Boolean);
  if (!nextItems.length) return null;
  ensureTargetsForSteps(nextItems);
  const safeIndex = Math.max(0, Math.min(index, workflow.steps.length));
  workflow.steps.splice(safeIndex, 0, ...nextItems);
  state.selectedStepId = nextItems[0].id;
  markDirty("draft");
  renderSteps();
  renderStepEditor();
  renderTargets();
  return nextItems;
}

function insertStepAt(item, index) {
  return insertStepsAt([item], index)?.[0] || null;
}

function addStep() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  const item = createStep($("#new-step-type").value);
  insertStepAt(item, workflow.steps.length);
  appendLog("info", `添加步骤：${item.name}`);
}

function insertStepBelowSelected() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  const item = createStep($("#new-step-type").value);
  const index = selectedStepIndex(workflow);
  insertStepAt(item, index >= 0 ? index + 1 : workflow.steps.length);
  appendLog("info", `插入步骤：${item.name}`);
}

function cloneStepForInsert(source) {
  if (!source) return null;
  const item = normalizeStep({
    ...JSON.parse(JSON.stringify(source)),
    id: randomId("step"),
    name: `${source.name || stepLabels[source.type] || "步骤"} 副本`,
  });
  item.target = String(source.target ?? "");
  item.command = String(source.command ?? "");
  item.expect = String(source.expect ?? "");
  item.targetId = source.targetId ? String(source.targetId) : "";
  item.notes = String(source.notes ?? "");
  item.enabled = source.enabled !== false;
  syncParamsFromLegacyFields(item);
  remapStepControlFlowReferences(item, new Map(), { clearWorkflowReferences: true });
  return item;
}

function duplicateSelectedStep() {
  const workflow = activeWorkflow();
  const index = selectedStepIndex(workflow);
  if (!workflow || index < 0) {
    setStatus("需要先选择步骤");
    return;
  }
  const item = cloneStepForInsert(workflow.steps[index]);
  insertStepAt(item, index + 1);
  appendLog("info", `复制步骤：${item.name}`);
}

function createStepFromBlockDefinition(definition) {
  const item = createStep(definition.type);
  return normalizeStep({
    ...item,
    ...definition,
    id: randomId("step"),
  });
}

function createStepBlock(presetId) {
  const preset = stepBlockPresets.find((item) => item.id === presetId) || stepBlockPresets[0];
  return {
    preset,
    steps: preset.steps.map(createStepFromBlockDefinition),
  };
}

function defaultRecoveryFragmentSteps(idPrefix = randomId("recovery")) {
  return [
    normalizeStep({
      id: `${idPrefix}-esc`,
      type: "hotkey",
      name: "关闭当前弹窗",
      target: "ESC",
      command: "mode=hwnd-key",
      expect: "dialog.closed",
      timeoutMs: 800,
      retry: 0,
      onFail: "stop",
      notes: recoveryFragmentMarker,
    }),
    normalizeStep({
      id: `${idPrefix}-settle`,
      type: "delay",
      name: "等待界面回稳",
      target: "600ms",
      command: "reason=recovery_settle",
      expect: "time.elapsed",
      timeoutMs: 600,
      retry: 0,
      onFail: "skip",
      notes: recoveryFragmentMarker,
    }),
    normalizeStep({
      id: `${idPrefix}-home`,
      type: "detect_page",
      name: "确认主界面",
      target: "page.home.ready",
      command: "threshold=0.86",
      expect: "home.visible",
      timeoutMs: 3000,
      retry: 1,
      onFail: "stop",
      notes: recoveryFragmentMarker,
    }),
    normalizeStep({
      id: `${idPrefix}-snapshot`,
      type: "snapshot",
      name: "记录恢复现场",
      target: "window.client",
      command: "dry-run log only",
      expect: "snapshot.recorded",
      timeoutMs: 1000,
      retry: 0,
      onFail: "skip",
      notes: recoveryFragmentMarker,
    }),
  ];
}

function hasDefaultRecoveryFragment(steps) {
  return (steps || []).some(isDefaultRecoveryFragmentStep);
}

function isDefaultRecoveryFragmentStep(item) {
  return String(item?.notes || "").trim() === recoveryFragmentMarker;
}

function withDefaultRecoveryFragment(steps, idPrefix = randomId("recovery"), options = {}) {
  if (!Array.isArray(steps) || hasDefaultRecoveryFragment(steps)) return steps;
  const restoreIndex = steps.findIndex((item) => item.type === "restore" && item.enabled !== false);
  if (restoreIndex < 0 && options.force !== true) return steps;
  const fragment = defaultRecoveryFragmentSteps(idPrefix);
  if (restoreIndex < 0) return [...steps, ...fragment];
  return [...steps.slice(0, restoreIndex), ...fragment, ...steps.slice(restoreIndex)];
}

function insertStepBlock() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  const { preset, steps } = createStepBlock($("#step-block-preset").value);
  const index = selectedStepIndex(workflow);
  const inserted = insertStepsAt(steps, index >= 0 ? index + 1 : workflow.steps.length);
  if (!inserted) return;
  if (selectFirstUnboundCapturedStep(inserted)) {
    renderSteps();
    renderStepEditor();
    renderTargets();
  }
  appendLog("info", `插入片段：${preset.label}（${inserted.length} 步）`);
  setStatus(`已插入片段：${preset.label}`);
}

function renderQuickStepActions() {
  const host = $("#quick-step-actions");
  if (!host) return;
  host.replaceChildren(
    ...quickStepActions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `quick-step-action action-${action.id}`;
      button.dataset.quickStepAction = action.id;
      button.innerHTML = `
        <span>${escapeHtml(action.kind)}</span>
        <strong>${escapeHtml(action.label)}</strong>
        <small>${escapeHtml(action.detail)}</small>
      `;
      return button;
    }),
  );
}

function insertQuickStepAction(actionId) {
  const action = quickStepActions.find((item) => item.id === actionId);
  const workflow = activeWorkflow();
  if (!action || !workflow) return;
  const index = selectedStepIndex(workflow);
  const insertIndex = index >= 0 ? index + 1 : workflow.steps.length;
  let inserted = [];
  let label = action.label;
  if (action.presetId) {
    const { preset, steps } = createStepBlock(action.presetId);
    inserted = insertStepsAt(steps, insertIndex) || [];
    label = preset.label;
  } else {
    const item = createStep(action.stepType);
    const insertedItem = insertStepAt(item, insertIndex);
    inserted = insertedItem ? [insertedItem] : [];
  }
  if (!inserted.length) return;
  selectStepAndTarget(inserted[0]);
  if (selectFirstUnboundCapturedStep(inserted)) {
    renderSteps();
    renderStepEditor();
    renderTargets();
  } else {
    renderStepEditor();
    renderTargets();
  }
  focusQuickStepActionTarget(action);
  appendLog("info", `快捷动作：${label}（插入 ${inserted.length} 步）`);
  setStatus(`已插入快捷动作：${label}`);
}

function focusQuickStepActionTarget(action) {
  window.requestAnimationFrame(() => {
    const selector = action.focusSelector || "";
    const element = selector ? $(selector) : null;
    if (!element) return;
    openContainingDetails(element);
    element.focus();
    if (typeof element.select === "function") element.select();
  });
}

function insertRecoveryFragmentForSelectedStep() {
  const workflow = activeWorkflow();
  const source = selectedStep();
  const sourceIndex = selectedStepIndex(workflow);
  if (!workflow || !source || sourceIndex < 0) {
    setStatus("需要先选择一个会触发恢复的步骤");
    return;
  }
  const restoreIndex = workflow.steps.findIndex((item) => item.type === "restore" && item.enabled !== false);
  const insertIndex = restoreIndex >= 0 ? restoreIndex : workflow.steps.length;
  const inserted = insertStepsAt(defaultRecoveryFragmentSteps(randomId("recovery")), insertIndex);
  if (!inserted?.length) return;
  source.onFail = "restore";
  source.recoveryStepId = inserted[0].id;
  markDirty("recovery fragment");
  state.selectedStepId = source.id;
  renderSteps();
  renderStepEditor();
  renderTargets();
  appendLog("info", `已为 ${source.name || stepLabels[source.type] || source.type} 插入恢复片段：${inserted[0].name}`);
  setStatus("已插入恢复片段并绑定到当前步骤");
}

function markSelectedStepAsRecoveryEntry() {
  const workflow = activeWorkflow();
  const entry = selectedStep();
  if (!workflow || !entry) {
    setStatus("需要先选择恢复入口步骤");
    return;
  }
  if (entry.enabled === false) {
    setStatus("停用步骤不能作为恢复入口");
    return;
  }
  if (plannedOnlyStepTypes.has(entry.type) || !recoveryExecutableStepTypes.has(entry.type)) {
    setStatus("恢复入口应选择热键、图像等待、图像点击、OCR 或页面确认等可执行步骤");
    return;
  }
  const candidates = workflow.steps.filter((item) => item.id !== entry.id && item.onFail === "restore");
  if (!candidates.length) {
    setStatus("当前任务没有 onFail=restore 的失败步骤");
    return;
  }
  let changed = 0;
  for (const item of candidates) {
    const currentEntryType = workflow.steps.find((step) => step.id === item.recoveryStepId)?.type || "";
    if (!item.recoveryStepId || plannedOnlyStepTypes.has(currentEntryType)) {
      item.recoveryStepId = entry.id;
      changed += 1;
    }
  }
  if (!changed) {
    setStatus("没有需要改绑的失败步骤");
    return;
  }
  markDirty("recovery entry");
  renderSteps();
  renderStepEditor();
  appendLog("info", `已把 ${entry.name || stepLabels[entry.type] || entry.type} 设为 ${changed} 个失败步骤的恢复入口`);
  setStatus("已设置恢复入口");
}

function moveSelectedStep(direction) {
  const workflow = activeWorkflow();
  const index = workflow?.steps.findIndex((item) => item.id === state.selectedStepId) ?? -1;
  const next = index + direction;
  if (!workflow || index < 0 || next < 0 || next >= workflow.steps.length) return;
  [workflow.steps[index], workflow.steps[next]] = [workflow.steps[next], workflow.steps[index]];
  markDirty("draft");
  renderSteps();
}

function deleteSelectedStep() {
  const workflow = activeWorkflow();
  const index = workflow?.steps.findIndex((item) => item.id === state.selectedStepId) ?? -1;
  if (!workflow || index < 0) return;
  const [removed] = workflow.steps.splice(index, 1);
  state.selectedStepId = workflow.steps[Math.min(index, workflow.steps.length - 1)]?.id || null;
  markDirty("draft");
  renderSteps();
  renderStepEditor();
  renderTargets();
  appendLog("info", `删除步骤：${removed.name}`);
}

function renderStepParamPanel(item) {
  const panel = $("#step-param-panel");
  if (!panel) return;
  for (const element of panel.querySelectorAll("[data-step-types]")) {
    const types = element.dataset.stepTypes.split(/\s+/).filter(Boolean);
    element.hidden = !types.includes(item.type);
  }
  for (const element of panel.querySelectorAll("[data-param-for]")) {
    const types = element.dataset.paramFor.split(/\s+/).filter(Boolean);
    element.hidden = !types.includes(item.type);
  }

  $("#step-param-summary").textContent = paramSummaryForStep(item);
  renderTargetSelect(item);
  renderControlFlowSelects(item);
  $("#param-pre-delay-ms").value = commandDurationMs(item.command, "preDelay") ?? "";
  $("#param-post-delay-ms").value = commandDurationMs(item.command, "postDelay") ?? "";
  $("#param-hotkey").value = item.type === "hotkey" ? item.target || "" : "";
  $("#param-text-value").value = item.type === "text_input" ? textInputValueForStep(item) : "";

  const boundTarget = targetForStep(item);
  const boundDefaults = targetCommandDefaults(boundTarget, item.command);
  const point = parsePointText(item.target) || parsePointText(item.command);
  $("#param-click-x").value = point?.x ?? "";
  $("#param-click-y").value = point?.y ?? "";
  $("#param-click-button").value = boundDefaults.button;

  $("#param-image-threshold").value = commandValue(item.command, "threshold") || boundDefaults.threshold;
  $("#param-image-button").value = boundDefaults.button;
  $("#param-image-point").value = commandValue(item.command, "point") || boundDefaults.point;
  $("#param-image-offset-x").value = commandIntegerValue(item.command, "offsetX") ?? "";
  $("#param-image-offset-y").value = commandIntegerValue(item.command, "offsetY") ?? "";
  $("#param-image-target").value = ["image_click", "double_click", "wait_image", "detect_page"].includes(item.type)
    ? item.target || ""
    : "";

  $("#param-delay-ms").value = durationMsFromText(item.target) ?? item.timeoutMs ?? "";
  $("#param-delay-reason").value = commandValue(item.command, "reason") || "";
  $("#param-condition-target").value = item.type === "condition" ? item.target || "" : "";
  $("#param-condition-guard").value = commandValue(item.command, "guard") || "";
  $("#param-control-max-iterations").value = item.maxIterations || "";
  renderWorkflowJumpSelect(item);
  $("#param-retry-target").value = item.type === "retry_until" ? item.target || "" : "";
  $("#param-retry-interval").value = durationMsFromText(commandValue(item.command, "interval")) ?? "";
  syncStepAdvancedPanels(item);
  syncRecoveryActionButtons(item);
}

function syncRecoveryActionButtons(item) {
  const workflow = activeWorkflow();
  const insertButton = $("#insert-recovery-fragment");
  const markButton = $("#mark-recovery-entry");
  const canInsert = Boolean(workflow && item && item.enabled !== false && !plannedOnlyStepTypes.has(item.type));
  const needsRecoveryEntry = (workflow?.steps || []).some((candidate) => {
    if (candidate.id === item?.id || candidate.onFail !== "restore") return false;
    const currentEntryType = workflow.steps.find((step) => step.id === candidate.recoveryStepId)?.type || "";
    return !candidate.recoveryStepId || plannedOnlyStepTypes.has(currentEntryType);
  });
  const canMark = Boolean(
    workflow &&
      item &&
      item.enabled !== false &&
      recoveryExecutableStepTypes.has(item.type) &&
      !plannedOnlyStepTypes.has(item.type) &&
      needsRecoveryEntry,
  );
  insertButton.disabled = !canInsert;
  insertButton.title = canInsert ? "为当前失败步骤插入默认恢复片段" : "请选择启用的非计划态步骤";
  markButton.disabled = !canMark;
  markButton.title = canMark ? "把当前可执行步骤设为缺失恢复入口的失败步骤入口" : "请选择可执行步骤，且任务中需要有待设置入口的 onFail=restore 步骤";
}

function syncStepAdvancedPanels(item) {
  const flow = $("#step-flow-advanced");
  if (flow && flow.hidden) {
    flow.open = false;
  } else if (flow) {
    flow.open = stepNeedsAdvancedFlowPanel(item);
  }
  const compat = $("#step-compat-fields");
  if (compat && !compat.open) {
    compat.open = stepHasCompatibilityDrift(item);
  }
}

function stepNeedsAdvancedFlowPanel(item) {
  if (!item) return false;
  const messages = [
    ...(state.stepValidation?.[item.id]?.issues || []),
    ...(state.stepValidation?.[item.id]?.warnings || []),
  ].join(" / ");
  return Boolean(
    item.type === "task_jump" ||
      item.jumpWorkflowId ||
      item.maxIterations ||
      /后向跳转|任务跳转|循环/.test(messages),
  );
}

function stepHasCompatibilityDrift(item) {
  if (!item) return false;
  const defaults = stepDefaults[item.type] || {};
  const commonStructuredTypes = new Set([
    "hotkey",
    "text_input",
    "click",
    "double_click",
    "image_click",
    "wait_image",
    "detect_page",
    "ocr_assert",
    "delay",
    "condition",
    "loop",
    "retry_until",
  ]);
  return Boolean(
    !commonStructuredTypes.has(item.type) &&
      !item.targetId &&
      ((item.target && item.target !== defaults.target) || (item.command && item.command !== defaults.command)),
  );
}

function renderTargetSelect(item) {
  const select = $("#param-target-select");
  if (!select) return;
  const currentId = stepTargetId(item);
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "未绑定目标库";
  select.append(empty);
  for (const target of state.workspace.targets) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = `${target.name} · ${target.kind}`;
    select.append(option);
  }
  select.value = state.workspace.targets.some((target) => target.id === currentId) ? currentId : "";
}

function renderControlFlowSelects(item) {
  const workflow = activeWorkflow();
  const options = (workflow?.steps || []).map((step, index) => ({
    value: step.id,
    label: `${String(index + 1).padStart(2, "0")} · ${step.name || stepLabels[step.type] || step.type} · ${stepLabels[step.type] || step.type}`,
  }));
  const fill = (selector, value, emptyLabel) => {
    const select = $(selector);
    if (!select) return;
    select.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyLabel;
    select.append(empty);
    for (const optionData of options) {
      if (optionData.value === item.id) continue;
      const option = document.createElement("option");
      option.value = optionData.value;
      option.textContent = optionData.label;
      select.append(option);
    }
    select.value = options.some((optionData) => optionData.value === value) && value !== item.id ? value : "";
  };
  fill("#param-control-target-step", item.targetStepId || "", "未设置，继续下一步");
  fill("#param-control-else-step", item.elseTargetStepId || "", "未设置，继续下一步");
  fill("#param-control-recovery-step", item.recoveryStepId || "", "未设置恢复入口");
}

function renderWorkflowJumpSelect(item) {
  const select = $("#param-control-workflow-jump");
  if (!select) return;
  const activeId = activeWorkflow()?.id || "";
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "未设置，留在当前队列";
  select.append(empty);
  for (const workflow of state.workspace.workflows) {
    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = `${workflow.name}${workflow.id === activeId ? " · 当前任务" : ""}`;
    select.append(option);
  }
  select.value = state.workspace.workflows.some((workflow) => workflow.id === item.jumpWorkflowId)
    ? item.jumpWorkflowId
    : "";
}

function paramSummaryForStep(item) {
  const target = targetForStep(item);
  const timing = timingSummaryForStep(item);
  const point = parsePointText(item.target) || parsePointText(item.command);
  if (item.type === "double_click" && !target?.dataUrl && (point || target?.roi)) {
    const base = point ? `双击 ${point.x},${point.y}` : "双击绑定 ROI 中心";
    return `${base}${timing}`;
  }
  if (["image_click", "double_click", "wait_image", "detect_page"].includes(item.type)) {
    const threshold = commandValue(item.command, "threshold") || target?.match?.threshold || DEFAULT_IMAGE_THRESHOLD;
    const offset = ["image_click", "double_click"].includes(item.type) ? clickOffsetSummary(item) : "";
    const base = target ? `${target.name} · threshold ${threshold}` : `未绑定图片目标 · threshold ${threshold}`;
    const action = item.type === "double_click" ? "双击" : "";
    return `${action}${base}${offset}${timing}`;
  }
  if (item.type === "click") {
    const base = point ? `点击 ${point.x},${point.y}` : target?.roi ? "点击绑定 ROI 中心" : "需要坐标或 ROI";
    return `${base}${timing}`;
  }
  if (item.type === "hotkey") return `${item.target || "输入快捷键"}${timing}`;
  if (item.type === "text_input") return `${textInputValueForStep(item) || "输入文本"}${timing}`;
  if (item.type === "delay") return `${durationMsFromText(item.target) ?? item.timeoutMs ?? 0} ms${timing}`;
  if (item.type === "condition") {
    const refs = controlFlowReferenceSummary(item);
    return `${item.target || "条件标签"} · guard=${commandValue(item.command, "guard") || "未设置"}${refs ? ` · ${refs}` : ""}${timing}`;
  }
  if (item.type === "loop") {
    const refs = controlFlowReferenceSummary(item);
    return `有限循环${refs ? ` · ${refs}` : " · 未设置循环目标/次数"}${timing}`;
  }
  if (item.type === "task_jump") {
    const refs = controlFlowReferenceSummary(item);
    return `切到 ${workflowNameById(item.jumpWorkflowId) || "未设置目标任务"}${refs ? ` · ${refs}` : ""}${timing}`;
  }
  if (item.type === "restore") {
    const refs = controlFlowReferenceSummary(item);
    return `恢复计划${refs ? ` · ${refs}` : ""}${timing}`;
  }
  return `保留为编排语义，当前后端不直接输入${timing}`;
}

function controlFlowReferenceSummary(item) {
  const workflow = activeWorkflow();
  const byId = new Map((workflow?.steps || []).map((step, index) => [
    step.id,
    `${String(index + 1).padStart(2, "0")} ${step.name || stepLabels[step.type] || step.type}`,
  ]));
  const parts = [];
  if (item.targetStepId) {
    const label = item.type === "condition" ? "true" : item.type === "loop" ? "loop" : "success";
    parts.push(`${label} -> ${byId.get(item.targetStepId) || "断链"}`);
  }
  if (item.elseTargetStepId) parts.push(`false -> ${byId.get(item.elseTargetStepId) || "断链"}`);
  if (item.recoveryStepId) parts.push(`restore -> ${byId.get(item.recoveryStepId) || "断链"}`);
  if (item.onFail === "restore") parts.push(`after ${normalizeRecoveryAction(item.recoveryAction)}`);
  if (item.jumpWorkflowId) parts.push(`task -> ${workflowNameById(item.jumpWorkflowId) || "断链"}`);
  if (item.maxIterations) parts.push(`max ${item.maxIterations}`);
  return parts.join(" / ");
}

function workflowNameById(id) {
  if (!id) return "";
  const workflow = workflowById(id);
  return workflow?.name || "";
}

function timingSummaryForStep(item) {
  const preDelay = commandDurationMs(item.command, "preDelay");
  const postDelay = commandDurationMs(item.command, "postDelay");
  const parts = [];
  if (preDelay) parts.push(`前 ${preDelay}ms`);
  if (postDelay) parts.push(`后 ${postDelay}ms`);
  return parts.length ? ` · ${parts.join(" / ")}` : "";
}

function clickOffsetSummary(item) {
  const x = commandIntegerValue(item.command, "offsetX") || 0;
  const y = commandIntegerValue(item.command, "offsetY") || 0;
  return x || y ? ` · offset ${x},${y}` : "";
}

function bindStepParamEditor() {
  $("#param-target-select").addEventListener("change", (event) => {
    const target = state.workspace.targets.find((item) => item.id === event.target.value);
    if (!target) {
      updateSelectedStepFromParams((item) => {
        unbindStepTarget(item);
      });
      renderTargets();
      return;
    }
    state.selectedTargetId = target.id;
    updateSelectedStepFromParams((item) => {
      bindTargetToStep(item, target, {
        preserveClick: item.type === "click" || (item.type === "double_click" && !target.dataUrl),
      });
    });
    renderTargets();
  });
  $("#param-pre-delay-ms").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithDelayValue(item.command, "preDelay", event.target.value);
    });
  });
  $("#param-post-delay-ms").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithDelayValue(item.command, "postDelay", event.target.value);
    });
  });
  $("#param-hotkey").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
      item.command = commandWithValues(item.command, { mode: "hwnd-key" });
    });
  });
  $("#param-text-value").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value;
      item.command = commandWithValues(item.command, { mode: "hwnd-char" });
    });
  });
  $("#param-click-x").addEventListener("input", updateClickPointFromParams);
  $("#param-click-y").addEventListener("input", updateClickPointFromParams);
  $("#param-click-button").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, {
        button: event.target.value,
        mode: "hwnd-message",
      });
    });
  });
  $("#param-image-threshold").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { threshold: event.target.value.trim() });
    });
  });
  $("#param-image-button").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { button: event.target.value });
    });
  });
  $("#param-image-point").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { point: event.target.value });
    });
  });
  $("#param-image-offset-x").addEventListener("input", updateImageOffsetFromParams);
  $("#param-image-offset-y").addEventListener("input", updateImageOffsetFromParams);
  $("#param-image-target").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
      if (item.targetId && item.targetId !== item.target) unbindStepTarget(item);
    });
    renderTargets();
  });
  $("#param-delay-ms").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      const ms = normalizedNonNegativeInteger(event.target.value);
      if (ms != null) {
        item.target = `${ms}ms`;
        item.timeoutMs = ms;
      }
    });
  });
  $("#param-delay-reason").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { reason: event.target.value.trim() });
    });
  });
  $("#param-condition-target").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
    });
  });
  $("#param-condition-guard").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { guard: event.target.value.trim() });
    });
  });
  $("#param-control-target-step").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.targetStepId = event.target.value;
    });
  });
  $("#param-control-else-step").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.elseTargetStepId = event.target.value;
    });
  });
  $("#param-control-recovery-step").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.recoveryStepId = event.target.value;
    });
  });
  $("#insert-recovery-fragment").addEventListener("click", insertRecoveryFragmentForSelectedStep);
  $("#mark-recovery-entry").addEventListener("click", markSelectedStepAsRecoveryEntry);
  $("#param-control-workflow-jump").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.jumpWorkflowId = event.target.value;
    });
  });
  $("#param-control-max-iterations").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.maxIterations = normalizedNonNegativeInteger(event.target.value) ?? 0;
    });
  });
  $("#param-retry-target").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
    });
  });
  $("#param-retry-interval").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      const ms = normalizedNonNegativeInteger(event.target.value);
      if (ms != null) item.command = commandWithValues(item.command, { interval: `${ms}ms` });
    });
  });
}

function bindTargetEditor() {
  $("#target-search").addEventListener("input", (event) => {
    state.targetSearch = event.target.value;
    renderTargets({ preserveEditor: true });
  });
  $("#target-kind-filter").addEventListener("change", (event) => {
    state.targetKindFilter = event.target.value;
    renderTargets({ preserveEditor: true });
  });
  $("#target-name").addEventListener("input", (event) => {
    updateSelectedTarget((target) => {
      target.name = event.target.value.trim() || target.id;
    });
  });
  $("#target-kind").addEventListener("change", (event) => {
    updateSelectedTarget((target) => {
      target.kind = event.target.value || "unknown";
    });
  });
  $("#target-threshold").addEventListener("input", (event) => {
    updateSelectedTarget(
      (target) => {
        target.match = {
          ...(target.match || {}),
          threshold: normalizedThreshold(event.target.value, target.match?.threshold ?? DEFAULT_IMAGE_THRESHOLD),
        };
      },
      { sync: { threshold: true } },
    );
  });
  $("#target-click-button").addEventListener("change", (event) => {
    updateSelectedTarget(
      (target) => {
        target.click = {
          ...(target.click || {}),
          button: normalizedTargetButton(event.target.value),
        };
      },
      { sync: { clickButton: true } },
    );
  });
  $("#target-click-point").addEventListener("change", (event) => {
    updateSelectedTarget(
      (target) => {
        target.click = {
          ...(target.click || {}),
          point: event.target.value || "center",
        };
      },
      { sync: { clickPoint: true } },
    );
  });
  $("#target-texts").addEventListener("input", (event) => {
    updateSelectedTarget((target) => {
      target.texts = event.target.value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
    });
  });
  $("#target-note").addEventListener("input", (event) => {
    updateSelectedTarget((target) => {
      target.note = event.target.value;
    });
  });
  $("#bind-selected-target").addEventListener("click", bindSelectedTargetToStep);
  $("#unbind-step-target").addEventListener("click", unbindCurrentStepTarget);
  $("#verify-selected-target").addEventListener("click", verifySelectedTarget);
  $("#confirm-manual-target").addEventListener("click", confirmSelectedTargetManual);
  $("#delete-target").addEventListener("click", deleteSelectedTarget);
  $("#apply-builtin-templates").addEventListener("click", applyBuiltinTemplatesToTargets);
  $("#export-target-library").addEventListener("click", exportTargetLibrary);
  $("#import-target-library").addEventListener("click", importTargetLibrary);
}

function updateClickPointFromParams() {
  updateSelectedStepFromParams((item) => {
    const x = normalizedNonNegativeInteger($("#param-click-x").value);
    const y = normalizedNonNegativeInteger($("#param-click-y").value);
    if (x != null && y != null) {
      item.target = `x=${x},y=${y}`;
      item.command = commandWithValues(item.command, { mode: "hwnd-message" });
    }
  });
}

function updateImageOffsetFromParams() {
  updateSelectedStepFromParams((item) => {
    item.command = commandWithIntegerValue(item.command, "offsetX", $("#param-image-offset-x").value);
    item.command = commandWithIntegerValue(item.command, "offsetY", $("#param-image-offset-y").value);
  });
}

function updateSelectedStepFromParams(mutator) {
  const item = selectedStep();
  if (!item) return;
  mutator(item);
  syncParamsFromLegacyFields(item);
  $("#step-target").value = item.target || "";
  $("#step-command").value = item.command || "";
  $("#step-timeout").value = String(item.timeoutMs ?? 0);
  markDirty("draft");
  renderSteps();
  renderStepParamPanel(item);
}

function renderStepEditor() {
  const item = selectedStep();
  $("#step-editor-empty").hidden = Boolean(item);
  $("#step-editor").hidden = !item;
  if (!item) return;
  renderStepValidationDetails(item);
  $("#step-name").value = item.name || "";
  $("#step-type").value = item.type;
  $("#step-enabled").checked = item.enabled !== false;
  $("#step-target").value = item.target || "";
  $("#step-command").value = item.command || "";
  $("#step-expect").value = item.expect || "";
  $("#step-timeout").value = String(item.timeoutMs ?? 0);
  $("#step-retry").value = String(item.retry ?? 0);
  $("#step-on-fail").value = item.onFail || "stop";
  $("#step-recovery-action").value = normalizeRecoveryAction(item.recoveryAction);
  $("#step-notes").value = item.notes || "";
  renderStepParamPanel(item);
}

function renderStepValidationDetails(item) {
  const box = $("#step-validation-detail");
  const messages = state.stepValidation[item?.id] || { issues: [], warnings: [] };
  const rows = [
    ...messages.issues.map((text) => ({ type: "issue", label: "问题", text })),
    ...messages.warnings.map((text) => ({ type: "warning", label: "提醒", text })),
  ];
  box.hidden = rows.length === 0;
  box.innerHTML = rows
    .slice(0, 4)
    .map(
      (row) => `
        <p class="${row.type}">
          <strong>${row.label}</strong>
          <span>${escapeHtml(row.text)}</span>
        </p>
      `,
    )
    .join("");
}

function bindStepEditor() {
  const update = (field, coerce = (value) => value) => (event) => {
    const item = selectedStep();
    if (!item) return;
    item[field] = coerce(event.target.value);
    if (field === "target" && item.targetId && item.targetId !== item.target) unbindStepTarget(item);
    if (["target", "command", "expect", "timeoutMs"].includes(field)) syncParamsFromLegacyFields(item);
    markDirty("draft");
    renderSteps();
    if (["target", "command", "expect", "timeoutMs"].includes(field)) renderStepParamPanel(item);
    if (field === "target") renderTargets();
  };
  $("#step-name").addEventListener("input", update("name"));
  $("#step-target").addEventListener("input", update("target"));
  $("#step-command").addEventListener("input", update("command"));
  $("#step-expect").addEventListener("input", update("expect"));
  $("#step-enabled").addEventListener("change", (event) => {
    const item = selectedStep();
    if (!item) return;
    item.enabled = event.target.checked;
    markDirty("draft");
    renderSteps();
  });
  $("#step-timeout").addEventListener("input", update("timeoutMs", (value) => Number(value) || 0));
  $("#step-retry").addEventListener("input", update("retry", (value) => Number(value) || 0));
  $("#step-on-fail").addEventListener("change", update("onFail"));
  $("#step-recovery-action").addEventListener("change", update("recoveryAction", normalizeRecoveryAction));
  $("#step-notes").addEventListener("input", update("notes"));
  $("#step-type").addEventListener("change", (event) => {
    const item = selectedStep();
    if (!item) return;
    const defaults = stepDefaults[event.target.value] || stepDefaults.detect_page;
    item.type = event.target.value;
    item.name = defaults.name;
    item.target = defaults.target;
    item.command = defaults.command;
    item.expect = defaults.expect;
    item.timeoutMs = defaults.timeoutMs;
    item.retry = defaults.retry;
    item.onFail = defaults.onFail;
    item.recoveryAction = normalizeRecoveryAction(item.recoveryAction);
    if (!targetBackedStepTypes.has(item.type)) {
      item.targetId = "";
    }
    sanitizeStepControlFlowForType(item);
    syncParamsFromLegacyFields(item);
    markDirty("draft");
    renderSteps();
    renderStepEditor();
  });
}

function commandParts(command) {
  return String(command || "")
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const splitAt = part.indexOf("=");
      if (splitAt < 0) return { raw: part };
      const key = part.slice(0, splitAt).trim();
      const value = part.slice(splitAt + 1).trim();
      return key ? { key, value } : { raw: part };
    });
}

function commandValue(command, key) {
  const expected = key.toLowerCase();
  for (const part of commandParts(command)) {
    if (part.key?.toLowerCase() === expected && part.value) return part.value;
  }
  return "";
}

function commandDurationMs(command, key) {
  const raw = commandValue(command, key);
  return raw ? durationMsFromText(raw) : null;
}

function commandIntegerValue(command, key) {
  const raw = commandValue(command, key);
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

function commandWithValues(command, updates) {
  const updateKeys = new Set(Object.keys(updates).map((key) => key.toLowerCase()));
  const parts = commandParts(command).filter((part) => !part.key || !updateKeys.has(part.key.toLowerCase()));
  for (const [key, value] of Object.entries(updates)) {
    const text = String(value ?? "").trim();
    if (text) parts.push({ key, value: text });
  }
  return parts.map((part) => (part.key ? `${part.key}=${part.value}` : part.raw)).join("; ");
}

function commandWithDelayValue(command, key, value) {
  const text = String(value ?? "").trim();
  if (!text) return commandWithValues(command, { [key]: "" });
  const ms = normalizedNonNegativeInteger(text);
  return ms == null ? command : commandWithValues(command, { [key]: `${ms}ms` });
}

function commandWithIntegerValue(command, key, value) {
  const text = String(value ?? "").trim();
  if (!text) return commandWithValues(command, { [key]: "" });
  const integer = normalizedInteger(text);
  return integer == null ? command : commandWithValues(command, { [key]: integer });
}

function parsePointText(value) {
  let x = null;
  let y = null;
  for (const part of String(value || "")
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [rawKey, rawValue] = part.split("=");
    if (!rawKey || !/^\d+$/.test(rawValue || "")) continue;
    if (rawKey.toLowerCase() === "x") x = Number(rawValue);
    if (rawKey.toLowerCase() === "y") y = Number(rawValue);
  }
  return x != null && y != null ? { x, y } : null;
}

function durationMsFromText(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  let match = text.match(/^(\d+)ms$/);
  if (match) return Number(match[1]);
  match = text.match(/^(\d+(?:\.\d+)?)s$/);
  if (match) return Math.round(Number(match[1]) * 1000);
  return /^\d+$/.test(text) ? Number(text) : null;
}

function normalizedNonNegativeInteger(value) {
  if (String(value ?? "").trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizedInteger(value) {
  if (String(value ?? "").trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function normalizedButton(command) {
  const value = commandValue(command, "button").toLowerCase();
  if (["right", "r", "secondary"].includes(value)) return "right";
  return "left";
}

function normalizedTargetButton(value) {
  return ["right", "r", "secondary"].includes(String(value || "").toLowerCase()) ? "right" : "left";
}

function normalizedThreshold(value, fallback = DEFAULT_IMAGE_THRESHOLD) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function stepTargetId(item) {
  if (!item) return "";
  if (item.targetId) return item.targetId;
  if (item.assetId) return item.assetId;
  return targetBackedStepTypes.has(item.type) && isLogicalTargetName(item.target) ? item.target.trim() : "";
}

function targetForStep(item) {
  const id = stepTargetId(item);
  return id ? state.workspace.targets.find((target) => target.id === id) || null : null;
}

function manualConfirmationRequiredForTarget(target) {
  if (!target?.id) return false;
  if (target.safety?.requiresManualConfirmation) return true;
  return state.workspace.workflows.some((workflow) =>
    workflow.steps.some(
      (stepItem) =>
        stepTargetId(stepItem) === target.id && requiresManualConfirmationForStep(stepItem, target),
    ),
  );
}

function unbindStepTarget(item, options = {}) {
  if (!item) return "";
  const previousId = stepTargetId(item);
  item.targetId = "";
  delete item.assetId;
  if (options.clearTarget || (previousId && item.target?.trim() === previousId)) {
    item.target = "";
  }
  syncParamsFromLegacyFields(item);
  return previousId;
}

function targetUsages(targetId) {
  if (!targetId) return [];
  const usages = [];
  for (const workflow of state.workspace.workflows || []) {
    for (const [stepIndex, item] of (workflow.steps || []).entries()) {
      if (stepTargetId(item) !== targetId) continue;
      usages.push({
        workflowId: workflow.id,
        workflowName: workflow.name,
        stepId: item.id,
        stepName: item.name,
        stepIndex,
      });
    }
  }
  return usages;
}

function selectedManagedTarget() {
  return state.selectedTargetId
    ? state.workspace.targets.find((target) => target.id === state.selectedTargetId) || null
    : null;
}

function visibleTargets() {
  const query = state.targetSearch.trim().toLowerCase();
  return state.workspace.targets.filter((target) => {
    if (state.targetKindFilter !== "all" && target.kind !== state.targetKindFilter) return false;
    if (!query) return true;
    return targetSearchText(target).includes(query);
  });
}

function targetSearchText(target) {
  return [
    target.id,
    target.name,
    target.kind,
    target.note,
    target.texts?.join(" "),
    target.source?.display,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function ensureSelectedTarget(filteredTargets = null) {
  const visibleIds = filteredTargets ? new Set(filteredTargets.map((target) => target.id)) : null;
  const current = selectedManagedTarget();
  if (current && (!visibleIds || visibleIds.has(current.id))) return current;
  const bound = targetForStep(selectedStep());
  if (bound && (!visibleIds || visibleIds.has(bound.id))) {
    state.selectedTargetId = bound.id;
  } else {
    state.selectedTargetId = filteredTargets ? filteredTargets[0]?.id || "" : state.workspace.targets[0]?.id || "";
  }
  return selectedManagedTarget();
}

function fillTargetKindSelects() {
  for (const selector of ["#target-kind-filter", "#target-kind"]) {
    const select = $(selector);
    if (!select) continue;
    const current = select.value || (selector === "#target-kind-filter" ? "all" : "image");
    const actualKinds = state.workspace.targets.map((target) => target.kind || "unknown");
    const kindOptions = [...new Set([...targetKindOptions, ...actualKinds])];
    const options = selector === "#target-kind-filter" ? ["all", ...kindOptions] : kindOptions;
    select.replaceChildren(
      ...options.map((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "all" ? "全部类型" : value;
        return option;
      }),
    );
    select.value = options.includes(current) ? current : options[0];
  }
}

function renderTargetEditor(filteredTargets = null) {
  const target = ensureSelectedTarget(filteredTargets);
  $("#target-editor-empty").hidden = Boolean(target);
  $("#target-editor").hidden = !target;
  if (!target) return;

  $("#target-name").value = target.name || "";
  $("#target-kind").value = [...$("#target-kind").options].some((option) => option.value === target.kind)
    ? target.kind
    : "unknown";
  $("#target-threshold").value = String(target.match?.threshold ?? DEFAULT_IMAGE_THRESHOLD);
  $("#target-click-button").value = target.click?.button || "left";
  $("#target-click-point").value = target.click?.point || "center";
  $("#target-texts").value = (target.texts || []).join("\n");
  $("#target-note").value = target.note || "";

  const usages = targetUsages(target.id);
  const usageText = usages.length
    ? `${usages.length} 处使用 · ${usages.slice(0, 3).map((item) => `${item.workflowName}/${item.stepName}`).join("，")}${usages.length > 3 ? "…" : ""}`
    : "0 处使用";
  $("#target-usage").textContent = usageText;
  $("#bind-selected-target").disabled = !selectedStep();
  $("#unbind-step-target").disabled = !stepTargetId(selectedStep());
  $("#verify-selected-target").disabled = !activeWindow() || !targetCanPreviewVerify(target);
  $("#delete-target").disabled = usages.length > 0;
  $("#delete-target").title = usages.length > 0 ? "目标仍被步骤使用，先解绑后再删除" : "删除当前未使用目标";
  const confirmationRequired = manualConfirmationRequiredForTarget(target);
  const confirmation = manualConfirmationStatus(target, { required: confirmationRequired });
  const confirmButton = $("#confirm-manual-target");
  const confirmationState = $("#target-manual-confirmation");
  confirmButton.hidden = !confirmationRequired;
  confirmButton.disabled = !confirmationRequired || !target.dataUrl;
  confirmButton.textContent = confirmation.valid ? "重新确认当前素材可后台点击" : "确认当前素材可后台点击";
  confirmationState.hidden = !confirmationRequired;
  confirmationState.className = `target-verify-state ${confirmation.valid ? "ok" : "warn"}`;
  confirmationState.textContent = confirmationRequired
    ? `人工确认：${manualConfirmationStatusText(confirmation)}${confirmation.valid && confirmation.confirmation?.approvedAt ? ` · ${confirmation.confirmation.approvedAt}` : ""}`
    : "";
  const verification = state.targetVerification?.targetId === target.id ? state.targetVerification : null;
  const verifyState = $("#target-verify-state");
  verifyState.className = `target-verify-state ${verification?.level || "idle"}`;
  verifyState.textContent = verification
    ? `${verification.label} · ${verification.detail}`
    : targetCanPreviewVerify(target)
      ? "可用当前窗口做只读验证"
      : "需要图片、ROI 或 OCR 目标文本后才能验证";
}

function updateSelectedTarget(mutator, options = {}) {
  const target = selectedManagedTarget();
  if (!target) return;
  mutator(target);
  target.updatedAt = new Date().toISOString();
  syncTargetDefaultsToBoundSteps(target, options.sync || {});
  markDirty("target");
  renderTargets({ preserveEditor: true });
  renderStepEditor();
  renderWorkflowCompletion();
}

function syncTargetDefaultsToBoundSteps(target, options = {}) {
  const updates = {};
  if (options.threshold) updates.threshold = normalizedThreshold(target.match?.threshold, DEFAULT_IMAGE_THRESHOLD);
  if (options.clickButton) updates.button = target.click?.button || "left";
  if (options.clickPoint) updates.point = target.click?.point || "center";
  if (!Object.keys(updates).length) return;
  for (const workflow of state.workspace.workflows || []) {
    for (const item of workflow.steps || []) {
      if (stepTargetId(item) !== target.id) continue;
      if (options.threshold && ["image_click", "double_click", "wait_image", "detect_page"].includes(item.type)) {
        item.command = commandWithValues(item.command, { threshold: updates.threshold });
      }
      if (options.clickButton && ["image_click", "double_click", "click"].includes(item.type)) {
        item.command = commandWithValues(item.command, { button: updates.button });
      }
      if (options.clickPoint && ["image_click", "double_click"].includes(item.type)) {
        item.command = commandWithValues(item.command, { point: updates.point });
      }
      syncParamsFromLegacyFields(item);
    }
  }
}

function bindSelectedTargetToStep() {
  const target = selectedManagedTarget();
  if (!target) {
    setStatus("需要先选择目标");
    return;
  }
  const item = selectedStep();
  if (!item) {
    setStatus("需要先选择步骤");
    return;
  }
  bindTargetToSelectedStep(target, {
    preserveClick: item.type === "click" || (item.type === "double_click" && !target.dataUrl),
  });
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  setStatus(`已绑定目标：${target.name}`);
}

function confirmSelectedTargetManual() {
  const target = selectedManagedTarget();
  if (!target) {
    setStatus("需要先选择目标");
    return;
  }
  if (!manualConfirmationRequiredForTarget(target)) {
    setStatus("当前目标不需要人工确认");
    return;
  }
  if (!target.dataUrl) {
    setStatus("需要先粘贴或绑定目标素材后再确认");
    return;
  }
  try {
    target.manualConfirmation = createManualConfirmation(target);
    target.updatedAt = new Date().toISOString();
    markDirty("target");
    renderTargets({ preserveEditor: true });
    renderStepEditor();
    renderWorkflowCompletion();
    const status = manualConfirmationStatus(target, { required: true });
    setStatus(`已确认目标可后台点击：${target.name || target.id}`);
    appendLog("info", `人工确认通过：${target.id} · ${status.fingerprint}`);
  } catch (error) {
    setStatus(`人工确认失败：${error}`);
    appendLog("error", `人工确认失败：${error}`);
  }
}

function targetCanPreviewVerify(target) {
  if (!target) return false;
  if (target.dataUrl || target.roi) return true;
  return target.kind === "ocr";
}

function targetVerificationStep(target) {
  const type = target.kind === "ocr" ? "ocr_assert" : target.kind === "page" ? "detect_page" : "wait_image";
  const threshold = normalizedThreshold(target.match?.threshold, DEFAULT_IMAGE_THRESHOLD);
  const command =
    type === "ocr_assert"
      ? commandWithValues("", {
          lang: "zh",
          roi: target.match?.scope && target.match.scope !== "window" ? target.match.scope : "",
        })
      : commandWithValues("", {
          threshold,
          button: target.click?.button || "left",
          point: target.click?.point || "center",
        });
  return normalizeStep({
    id: randomId("verify-step"),
    type,
    name: `验证 ${target.name || target.id}`,
    target: target.id,
    targetId: target.id,
    command,
    expect: type === "ocr_assert" ? "text_found" : "visible",
    timeoutMs: 2000,
    retry: 0,
    onFail: "stop",
  });
}

async function verifySelectedTarget() {
  const target = selectedManagedTarget();
  if (!target) {
    setStatus("需要先选择目标");
    return;
  }
  if (!targetCanPreviewVerify(target)) {
    const detail = "当前目标没有图片、ROI 或 OCR 配置，无法做预览验证";
    state.targetVerification = { targetId: target.id, level: "blocked", label: "无法验证", detail };
    appendLog("warn", `${target.name}: ${detail}`);
    renderTargets({ preserveEditor: true });
    setStatus(detail);
    return;
  }
  const windowTarget = activeWindow();
  if (!windowTarget) {
    const detail = "需要先选择一个目标窗口";
    state.targetVerification = { targetId: target.id, level: "blocked", label: "缺窗口", detail };
    renderTargets({ preserveEditor: true });
    setStatus(detail);
    return;
  }
  const verifyState = $("#target-verify-state");
  if (verifyState) {
    verifyState.className = "target-verify-state running";
    verifyState.textContent = "验证中 · 正在截图匹配/OCR";
  }
  const probe = targetVerificationStep(target);
  const probeSessionId = `target-probe-${target.id}-${Date.now()}`;
  const probeCancelTokenId = `${probeSessionId}-cancel`;
  try {
    const result = await invokeBackend("execute_workflow_step", {
      hwnd: Number(windowTarget.hwnd),
      step: backendStepPayload(probe),
      expectedWindow: windowIdentityForTarget(windowTarget),
      execution: {
        sessionId: probeSessionId,
        stepId: probe.id || `target-probe-${target.id}`,
        deadlineMs: Math.max(1, Number(probe.timeoutMs) || 5000),
        cancelTokenId: probeCancelTokenId,
      },
    });
    const matched = targetVerificationPassed(result);
    const level = matched ? "ready" : "blocked";
    const score = result.score == null ? "" : ` · score=${Number(result.score).toFixed(3)}`;
    const point = result.x != null && result.y != null ? ` · @${result.x},${result.y}` : "";
    const detail = `${result.status}/${result.action}${score}${point} · ${result.detail || "无详情"}`;
    state.targetVerification = {
      targetId: target.id,
      level,
      label: matched ? "验证通过" : "验证未通过",
      detail,
      result,
      checkedAt: new Date().toISOString(),
    };
    appendLog(level === "ready" ? "info" : "warn", `${target.name} 验证结果：${detail}`);
    setStatus(`${target.name}：${matched ? "验证通过" : "验证未通过"}`);
  } catch (error) {
    const detail = String(error);
    state.targetVerification = {
      targetId: target.id,
      level: "blocked",
      label: "验证失败",
      detail,
      checkedAt: new Date().toISOString(),
    };
    appendLog("warn", `${target.name} 验证失败：${detail}`);
    setStatus(`目标验证失败：${detail}`);
  } finally {
    await invokeBackend("complete_session", {
      sessionId: probeSessionId,
      cancelTokenId: probeCancelTokenId,
    }).catch((error) => {
      appendLog("warn", `目标验证后端会话清理失败：${probeSessionId} / ${error}`);
    });
  }
  renderTargets({ preserveEditor: true });
}

function unbindCurrentStepTarget() {
  const item = selectedStep();
  const targetId = stepTargetId(item);
  if (!item || !targetId) {
    setStatus("当前步骤没有绑定目标");
    return;
  }
  const previous = targetForStep(item);
  unbindStepTarget(item);
  syncParamsFromLegacyFields(item);
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  setStatus(`已解除步骤目标：${previous?.name || targetId}`);
}

function deleteSelectedTarget() {
  const target = selectedManagedTarget();
  if (!target) {
    setStatus("需要先选择目标");
    return;
  }
  const usages = targetUsages(target.id);
  if (usages.length) {
    appendLog("warn", `目标仍被 ${usages.length} 个步骤使用，拒绝删除：${target.name}`);
    setStatus("目标仍在使用，先解除绑定");
    renderTargetEditor();
    return;
  }
  const index = state.workspace.targets.findIndex((item) => item.id === target.id);
  state.workspace.targets = state.workspace.targets.filter((item) => item.id !== target.id);
  state.selectedTargetId =
    state.workspace.targets[Math.min(index, state.workspace.targets.length - 1)]?.id ||
    state.workspace.targets[0]?.id ||
    "";
  markDirty("target");
  renderTargets();
  renderStepEditor();
  appendLog("info", `删除未使用目标：${target.name}`);
  setStatus(`已删除目标：${target.name}`);
}

function targetLibraryExportPayload(targets = state.workspace.targets) {
  return targetLibraryExportPayloadCore(targets, {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    defaultImageThreshold: DEFAULT_IMAGE_THRESHOLD,
    randomId,
  });
}

function exportTargetLibrary() {
  const payload = targetLibraryExportPayload();
  const json = JSON.stringify(payload, null, 2);
  $("#workspace-json").value = json;
  navigator.clipboard?.writeText(json).catch(() => {});
  appendLog("info", `目标库已导出：${payload.targetCount} 个目标`);
  setStatus("目标库 JSON 已导出并尝试复制");
}

async function importTargetLibrary() {
  try {
    const parsed = JSON.parse($("#workspace-json").value);
    const importedTargets = targetLibraryTargetsFromPayload(parsed);
    const result = mergeImportedTargetLibrary(importedTargets);
    if (result.total === 0) {
      setStatus("目标库 JSON 没有可导入目标");
      return;
    }
    if (result.added || result.updated) {
      markDirty("target-library import");
      await saveWorkspaceNow();
    }
    renderAll();
    appendLog(
      "info",
      `目标库合并：新增 ${result.added}，补齐 ${result.updated}，保留 ${result.skipped}，来源 ${result.total}`,
    );
    setStatus(`目标库已合并：新增 ${result.added}，补齐 ${result.updated}，保留 ${result.skipped}`);
  } catch (error) {
    setStatus(`目标库 JSON 合并失败：${error.message}`);
    appendLog("error", `目标库 JSON 合并失败：${error.message}`);
  }
}

function targetLibraryTargetsFromPayload(value) {
  return targetLibraryTargetsFromPayloadCore(value, {
    defaultImageThreshold: DEFAULT_IMAGE_THRESHOLD,
    randomId,
  });
}

function mergeImportedTargetLibrary(importedTargets) {
  return mergeImportedTargetLibraryCore(state.workspace.targets, importedTargets);
}

function targetMatchesBuiltinBinding(targetId, logicalTargetId) {
  const id = String(targetId || "").trim();
  const logical = String(logicalTargetId || "").trim();
  return Boolean(id && logical && (id === logical || id.endsWith(`.${logical}`)));
}

function builtinBindingForTarget(target) {
  return builtinTargetTemplateBindings.find((binding) =>
    targetMatchesBuiltinBinding(target?.id, binding.target),
  );
}

function builtinTemplateCandidates() {
  return state.workspace.targets
    .map((target) => ({ target, binding: builtinBindingForTarget(target) }))
    .filter(({ target, binding }) => binding && !target.dataUrl && !target.roi);
}

function shouldRefreshGeneratedTargetName(target) {
  if (!target?.name) return true;
  const note = String(target.note || "");
  return note.includes("由任务步骤生成") || note.includes("由步骤片段自动创建");
}

function appendTargetNote(target, note) {
  const next = String(note || "").trim();
  if (!next) return;
  const current = String(target.note || "").trim();
  if (current.includes(next)) return;
  target.note = current ? `${current}\n${next}` : next;
}

function applyBuiltinTemplateToTarget(target, binding, template) {
  target.dataUrl = template.dataUrl || "";
  target.width = Number(template.width || 0);
  target.height = Number(template.height || 0);
  target.kind = binding.kind || target.kind || "image";
  if (shouldRefreshGeneratedTargetName(target) && binding.name) target.name = binding.name;
  target.match = {
    ...(target.match || {}),
    threshold: normalizedThreshold(binding.threshold ?? target.match?.threshold, DEFAULT_IMAGE_THRESHOLD),
    scope: target.match?.scope || "window",
  };
  target.click = {
    ...(target.click || {}),
    button: binding.button || target.click?.button || "left",
    point: binding.point || target.click?.point || "center",
  };
  if (binding.requiresManualConfirmation) {
    target.safety = {
      ...(target.safety || {}),
      requiresManualConfirmation: true,
    };
  }
  target.source = {
    type: "builtin-template",
    display: `内置素材 · ${template.key}`,
    key: template.key,
    path: template.replacementPath,
    sourceRoi: template.sourceRoi || null,
    sourceFrameWidth: Number(template.sourceFrameWidth || 0),
    sourceFrameHeight: Number(template.sourceFrameHeight || 0),
    matchScore: template.matchScore ?? null,
  };
  appendTargetNote(target, `内置素材：${template.key}${template.note ? `；${template.note}` : ""}`);
  target.updatedAt = new Date().toISOString();
  syncTargetDefaultsToBoundSteps(target, { threshold: true, clickButton: true, clickPoint: true });
}

async function applyBuiltinTemplatesToTargets() {
  const stateLabel = $("#builtin-template-state");
  const candidates = builtinTemplateCandidates();
  if (!candidates.length) {
    const message = "没有可补的空目标";
    if (stateLabel) stateLabel.textContent = message;
    setStatus(message);
    appendLog("info", "内置素材：当前目标都已绑定素材/ROI，或没有匹配的内置模板");
    return;
  }
  const keys = [...new Set(candidates.map(({ binding }) => binding.key))];
  if (stateLabel) stateLabel.textContent = `读取 ${keys.length} 个内置模板…`;
  try {
    const templates = await invokeBackend("load_builtin_target_templates", { keys });
    const byKey = new Map(templates.map((item) => [item.key, item]));
    let applied = 0;
    let missing = 0;
    for (const { target, binding } of candidates) {
      if (target.dataUrl || target.roi) continue;
      const template = byKey.get(binding.key);
      if (!template) {
        missing += 1;
        continue;
      }
      applyBuiltinTemplateToTarget(target, binding, template);
      applied += 1;
    }
    if (applied) {
      markDirty("builtin templates");
      renderTargets({ preserveEditor: true });
      renderStepEditor();
      renderWorkflowCompletion();
    }
    const message = `已接入 ${applied} 个内置素材${missing ? `，${missing} 个缺模板` : ""}`;
    if (stateLabel) stateLabel.textContent = message;
    setStatus(message);
    appendLog("info", `内置素材：${message}`);
  } catch (error) {
    const message = `内置素材读取失败：${error}`;
    if (stateLabel) stateLabel.textContent = "读取失败";
    setStatus(message);
    appendLog("error", message);
  }
}

async function hydrateBuiltinTargetTemplates(options = {}) {
  const candidates = builtinTemplateCandidates();
  if (!candidates.length) return 0;
  const keys = [...new Set(candidates.map(({ binding }) => binding.key))];
  let templates = [];
  try {
    templates = await invokeBackend("load_builtin_target_templates", { keys });
  } catch (error) {
    appendLog("warn", `内置素材自动接入失败：${error}`);
    return 0;
  }
  const byKey = new Map(templates.map((item) => [item.key, item]));
  let applied = 0;
  for (const { target, binding } of candidates) {
    if (target.dataUrl || target.roi) continue;
    const template = byKey.get(binding.key);
    if (!template) continue;
    applyBuiltinTemplateToTarget(target, binding, template);
    applied += 1;
  }
  if (applied && options.log !== false) {
    appendLog("info", `已自动接入 ${applied} 个内置素材目标`);
  }
  return applied;
}

function targetCommandDefaults(target, command = "") {
  return {
    threshold: normalizedThreshold(target?.match?.threshold, DEFAULT_IMAGE_THRESHOLD),
    button: target?.click?.button || normalizedButton(command),
    point: target?.click?.point || commandValue(command, "point") || "center",
  };
}

function commandWithMissingValues(command, defaults) {
  const missing = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (value != null && value !== "" && !commandValue(command, key)) missing[key] = value;
  }
  return Object.keys(missing).length ? commandWithValues(command, missing) : command;
}

async function refreshPrivilege() {
  try {
    state.privilege = await invokeBackend("privilege_status");
    const elevated = state.privilege.currentProcessElevated;
    $("#privilege-state").textContent = elevated ? "管理员" : "普通权限";
    $("#privilege-state").classList.toggle("ok", elevated);
    $("#restart-admin").disabled = elevated;
    $("#restart-admin").title = elevated ? "当前已是管理员权限" : "用 UAC 重新启动";
  } catch (error) {
    $("#privilege-state").textContent = "权限读取失败";
    $("#restart-admin").disabled = false;
    appendLog("error", `权限状态读取失败：${error}`);
  }
  renderOpsDashboard();
}

async function refreshGameLaunchStatus() {
  const button = $("#launch-game-client");
  const label = $("#launch-status");
  try {
    state.launchStatus = await invokeBackend("game_launch_status");
    button.disabled = !state.launchStatus.configured;
    button.title = state.launchStatus.message;
    label.textContent = state.launchStatus.configured
      ? `配置：${state.launchStatus.source}`
      : "未配置客户端路径";
    label.title = state.launchStatus.message;
  } catch (error) {
    state.launchStatus = null;
    button.disabled = true;
    label.textContent = "启动配置读取失败";
    label.title = String(error);
  }
}

async function refreshWindows() {
  setStatus("正在扫描目标窗口...");
  await refreshPrivilege();
  try {
    state.windows = await invokeBackend("list_game_windows", { titleNeedle: TARGET_TITLE });
  } catch (error) {
    state.windows = [];
    setStatus(`窗口扫描失败：${error}`);
    appendLog("error", `窗口扫描失败：${error}`);
  }

  const live = new Set(state.windows.map((item) => String(item.hwnd)));
  state.selected = new Set([...state.selected].filter((hwnd) => live.has(hwnd)));
  if (!state.activeHwnd || !live.has(String(state.activeHwnd))) {
    state.activeHwnd = state.selected.values().next().value || state.windows[0]?.hwnd || null;
  }
  if (state.activeHwnd) state.selected.add(String(state.activeHwnd));

  renderWindows();
  renderAssignments();
  renderOpsDashboard();
  await capturePreview();
  const elevatedTargets = state.windows.filter((item) => item.elevated === true).length;
  if (elevatedTargets > 0 && state.privilege?.currentProcessElevated === false) {
    setStatus(`找到 ${state.windows.length} 个窗口，其中 ${elevatedTargets} 个需要管理员权限`);
  } else {
    setStatus(`找到 ${state.windows.length} 个窗口`);
  }
}

function renderWindows() {
  $("#window-count").textContent = String(state.windows.length);
  const list = $("#window-list");
  list.replaceChildren();

  if (!state.windows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block";
    empty.textContent = `未找到标题包含“${TARGET_TITLE}”的窗口`;
    list.append(empty);
    updateActiveMeta();
    renderOpsDashboard();
    return;
  }

  for (const item of state.windows) {
    const row = document.createElement("label");
    row.className = "window-row";
    row.classList.toggle("active", String(item.hwnd) === String(state.activeHwnd));

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(String(item.hwnd));
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selected.add(String(item.hwnd));
        state.activeHwnd = item.hwnd;
      } else {
        state.selected.delete(String(item.hwnd));
        if (String(state.activeHwnd) === String(item.hwnd)) {
          state.activeHwnd = selectedWindows()[0]?.hwnd || null;
        }
      }
      renderWindows();
      renderAssignments();
      capturePreview();
    });

    const body = document.createElement("span");
    const privilege = item.elevated === true ? "管理员" : item.elevated === false ? "普通" : "未知";
    const assigned = state.workspace.assignments[String(item.hwnd)];
    const queued = assigned?.queue || [];
    const nextWorkflow = queued.filter((entry) => entry.enabled).map((entry) => workflowById(entry.workflowId)).find(Boolean);
    const assignedName = queued.length
      ? `队列 ${queued.length} 项 · 下一项：${nextWorkflow?.name || "无启用任务"}`
      : "未分配";
    body.innerHTML = `
      <strong>${escapeHtml(item.display)}</strong>
      <small>${escapeHtml(item.processName || "-")} · ${escapeHtml(item.clientWidth)}x${escapeHtml(item.clientHeight)} · ${privilege}</small>
      <em>${escapeHtml(assignedName)}</em>
    `;
    body.addEventListener("click", (event) => {
      event.preventDefault();
      state.activeHwnd = item.hwnd;
      state.selected.add(String(item.hwnd));
      renderWindows();
      renderAssignments();
      capturePreview();
    });

    row.append(checkbox, body);
    list.append(row);
  }
  updateActiveMeta();
  renderOpsDashboard();
}

function selectGameWindows() {
  state.selected = new Set(state.windows.map((item) => String(item.hwnd)));
  state.activeHwnd = state.windows[0]?.hwnd || null;
  renderWindows();
  renderAssignments();
  capturePreview();
  setStatus(`已选择 ${state.selected.size} 个窗口`);
}

function assignWorkflowToSelected() {
  const workflow = activeWorkflow();
  if (!workflow) {
    setStatus("需要先选择任务");
    return;
  }
  assignWorkflowsToSelected([workflow]);
}

function assignWorkflowsToSelected(workflows) {
  const validWorkflows = (workflows || []).filter(Boolean);
  const targets = selectedEditableWindows();
  if (!validWorkflows.length || !targets.length) {
    setStatus("需要先选择任务和可编辑窗口");
    return 0;
  }
  appendWorkflowIdsToTargets(
    validWorkflows.map((workflow) => workflow.id),
    targets,
  );
  setStatus(`已把 ${validWorkflows.length} 个任务追加到 ${targets.length} 个窗口队列`);
  return targets.length;
}

function appendPickedWorkflowsToSelected() {
  const workflowIds = selectedWorkflowIdsForQueue();
  const targets = selectedEditableWindows();
  if (!workflowIds.length || !targets.length) {
    setStatus("需要先选择任务和可编辑窗口");
    return 0;
  }
  appendWorkflowIdsToTargets(workflowIds, targets);
  setStatus(`已把 ${workflowIds.length} 个任务追加到 ${targets.length} 个窗口队列`);
  return targets.length;
}

function appendWorkflowIdsToTargets(workflowIds, targets, timing = queueTimingOptions()) {
  const validIds = workflowIds.filter((workflowId) => workflowById(workflowId));
  const staggerMs = normalizedNonNegativeInteger(timing.staggerMs) ?? 0;
  const gapMs = normalizedNonNegativeInteger(timing.gapMs) ?? 0;
  for (const [targetIndex, target] of targets.entries()) {
    const assignment = ensureAssignment(target);
    for (const [workflowIndex, workflowId] of validIds.entries()) {
      assignment.queue.push(
        queueItemForWorkflow(workflowId, assignment.queue.length + 1, {
          startDelayMs: workflowIndex === 0 ? targetIndex * staggerMs : 0,
          afterDelayMs: gapMs,
        }),
      );
    }
    assignment.queue = renumberQueue(assignment.queue);
    assignment.updatedAt = new Date().toISOString();
  }
  markDirty("queued");
  renderWindows();
  renderAssignments();
}

function copyActiveQueueToSelectedWindows() {
  const source = activeWindow();
  const sourceAssignment = source ? assignmentForHwnd(source.hwnd) : null;
  const sourceQueue = cloneQueueItems(sourceAssignment?.queue || []);
  const targets = selectedEditableWindows().filter((target) => String(target.hwnd) !== String(source?.hwnd));
  if (!source || !sourceQueue.length || !targets.length) {
    setStatus("需要先选中有队列的源窗口和目标窗口");
    return 0;
  }
  if (!window.confirm(`复制会覆盖 ${targets.length} 个窗口的现有队列，继续？`)) return 0;
  for (const target of targets) {
    const assignment = ensureAssignment(target);
    assignment.queue = cloneQueueItems(sourceQueue);
    assignment.updatedAt = new Date().toISOString();
  }
  markDirty("queued");
  renderWindows();
  renderAssignments();
  setStatus(`已复制当前窗口队列到 ${targets.length} 个窗口`);
  return targets.length;
}

function clearSelectedQueues() {
  const targets = selectedEditableWindows().filter((target) => assignmentForHwnd(target.hwnd)?.queue?.length);
  if (!targets.length) {
    setStatus("已选窗口没有可清空的队列");
    return 0;
  }
  if (!window.confirm(`将清空 ${targets.length} 个窗口的任务队列，继续？`)) return 0;
  for (const target of targets) {
    delete state.workspace.assignments[String(target.hwnd)];
  }
  markDirty("queued");
  renderWindows();
  renderAssignments();
  setStatus(`已清空 ${targets.length} 个窗口队列`);
  return targets.length;
}

function renderAssignments() {
  renderQueueOverview();
  const list = $("#assignment-list");
  list.replaceChildren();
  const entries = Object.entries(state.workspace.assignments || {}).filter(
    ([, assignment]) => assignment.queue?.length,
  );
  $("#assignment-count").textContent = String(totalQueuedWorkflows());
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "还没有窗口任务队列";
    list.append(empty);
    renderOpsDashboard();
    return;
  }
  for (const [hwnd, assignment] of entries) {
    const locked = isQueueLocked(hwnd);
    const queueReadiness = queueReadinessSummary(assignment);
    const row = document.createElement("div");
    row.className = `queue-window ${queueReadiness.level}`;
    row.classList.toggle("running", locked);
    row.innerHTML = `
      <button class="compact-row queue-window-head" type="button">
        <span>
          <strong>${escapeHtml(assignment.display || hwnd)}</strong>
          <small>${assignment.queue.length} 个任务 · hwnd=${escapeHtml(hwnd)}${locked ? " · 运行中锁定" : ""} · ${escapeHtml(queueReadiness.detail)}</small>
        </span>
        <em class="readiness-pill ${queueReadiness.level}" title="${escapeHtml(queueReadiness.firstBlockingMessage || queueReadiness.detail)}">${escapeHtml(queueReadiness.label)}</em>
      </button>
      <div class="queue-items"></div>
    `;
    row.querySelector(".queue-window-head").addEventListener("click", () => {
      state.activeHwnd = hwnd;
      state.selected.add(String(hwnd));
      const firstWorkflow = assignment.queue.map((item) => workflowById(item.workflowId)).find(Boolean);
      if (firstWorkflow) {
        state.workspace.activeWorkflowId = firstWorkflow.id;
        state.selectedStepId = firstWorkflow.steps[0]?.id || null;
      }
      renderAll();
      capturePreview();
    });
    const items = row.querySelector(".queue-items");
    assignment.queue.forEach((queueItem, index) => {
      const workflow = workflowById(queueItem.workflowId);
      const itemReadiness = workflow
        ? workflowReadinessSummary(workflow)
        : {
            level: "blocked",
            label: "任务丢失",
            detail: "队列引用的任务已删除",
          };
      const itemDetail = itemReadiness.detail || "素材、坐标和 OCR 已满足后台基础要求";
      const itemRow = document.createElement("div");
      itemRow.className = `queue-item ${itemReadiness.level}`;
      itemRow.classList.toggle("disabled", queueItem.enabled === false || !workflow);
      itemRow.innerHTML = `
        <button class="queue-item-title" type="button">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHtml(workflow?.name || "任务已删除")}</strong>
          <em class="readiness-pill ${itemReadiness.level}" title="${escapeHtml(itemDetail)}">${escapeHtml(itemReadiness.label)}</em>
          <small>${escapeHtml(queueItemSummary(queueItem, workflow))} · ${escapeHtml(itemDetail)}</small>
        </button>
        <div class="queue-item-timing">
          <label>
            前等
            <input type="number" min="0" step="100" value="${escapeHtml(queueItem.startDelayMs || 0)}" data-delay-field="startDelayMs" ${locked ? "disabled" : ""} />
          </label>
          <label>
            后等
            <input type="number" min="0" step="100" value="${escapeHtml(queueItem.afterDelayMs || 0)}" data-delay-field="afterDelayMs" ${locked ? "disabled" : ""} />
          </label>
        </div>
        <div class="queue-item-actions">
          <button type="button" data-action="toggle" ${locked ? "disabled" : ""}>${queueItem.enabled === false ? "启用" : "停用"}</button>
          <button type="button" data-action="up" ${locked ? "disabled" : ""}>上移</button>
          <button type="button" data-action="down" ${locked ? "disabled" : ""}>下移</button>
          <button type="button" data-action="remove" ${locked ? "disabled" : ""}>删除</button>
        </div>
      `;
      itemRow.querySelector(".queue-item-title").addEventListener("click", () => {
        if (!workflow) return;
        state.workspace.activeWorkflowId = workflow.id;
        state.selectedStepId = workflow.steps[0]?.id || null;
        state.activeHwnd = hwnd;
        renderAll();
        capturePreview();
      });
      itemRow.querySelector(".queue-item-timing").addEventListener("change", (event) => {
        const field = event.target?.dataset?.delayField;
        if (!field) return;
        updateQueueItemTiming(hwnd, queueItem.id, field, event.target.value);
      });
      itemRow.querySelector(".queue-item-actions").addEventListener("click", (event) => {
        const action = event.target?.dataset?.action;
        if (!action) return;
        updateQueueItem(hwnd, queueItem.id, action);
      });
      items.append(itemRow);
    });
    list.append(row);
  }
  renderOpsDashboard();
}

function queueItemSummary(queueItem, workflow) {
  if (queueItem.enabled === false) return "停用";
  const parts = [`${workflow?.steps?.length || 0} 步`];
  if (queueItem.startDelayMs) parts.push(`前等 ${durationLabel(queueItem.startDelayMs)}`);
  if (queueItem.afterDelayMs) parts.push(`后等 ${durationLabel(queueItem.afterDelayMs)}`);
  return parts.join(" · ");
}

function updateQueueItem(hwnd, queueItemId, action) {
  if (isQueueLocked(hwnd)) {
    setStatus("该窗口正在运行，队列已锁定");
    appendLog("warn", `运行中的窗口队列不可修改：hwnd=${hwnd}`);
    renderAssignments();
    return;
  }
  const assignment = assignmentForHwnd(hwnd);
  const queue = assignment?.queue || [];
  const index = queue.findIndex((item) => item.id === queueItemId);
  if (!assignment || index < 0) return;
  if (action === "remove") {
    queue.splice(index, 1);
  } else if (action === "up" && index > 0) {
    [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
  } else if (action === "down" && index < queue.length - 1) {
    [queue[index + 1], queue[index]] = [queue[index], queue[index + 1]];
  } else if (action === "toggle") {
    queue[index].enabled = queue[index].enabled === false;
  }
  assignment.queue = queue.map((item, orderIndex) => ({ ...item, order: orderIndex + 1 }));
  assignment.updatedAt = new Date().toISOString();
  if (!assignment.queue.length) delete state.workspace.assignments[String(hwnd)];
  markDirty("queued");
  renderAssignments();
  renderWindows();
}

function updateQueueItemTiming(hwnd, queueItemId, field, value) {
  if (isQueueLocked(hwnd)) {
    setStatus("该窗口正在运行，队列已锁定");
    appendLog("warn", `运行中的窗口队列不可修改：hwnd=${hwnd}`);
    renderAssignments();
    return;
  }
  if (!["startDelayMs", "afterDelayMs"].includes(field)) return;
  const assignment = assignmentForHwnd(hwnd);
  const queueItem = assignment?.queue?.find((item) => item.id === queueItemId);
  if (!assignment || !queueItem) return;
  queueItem[field] = normalizedNonNegativeInteger(value) ?? 0;
  assignment.updatedAt = new Date().toISOString();
  markDirty("queued");
  renderWindows();
  renderSessions();
}

async function restartAsAdmin() {
  try {
    await invokeBackend("restart_as_admin");
    setStatus("已请求管理员权限重启");
  } catch (error) {
    setStatus(`管理员重启失败：${error}`);
    appendLog("error", `管理员重启失败：${error}`);
  }
}

async function launchGameClient() {
  try {
    await refreshGameLaunchStatus();
    const result = await invokeBackend("launch_game_client");
    setStatus(`已启动客户端 pid=${result.pid}`);
    appendLog("info", `客户端启动：pid=${result.pid}`);
    window.setTimeout(refreshWindows, 3000);
  } catch (error) {
    setStatus(`启动客户端失败：${error}`);
    appendLog("error", `启动客户端失败：${error}`);
  } finally {
    await refreshGameLaunchStatus();
  }
}

async function capturePreview() {
  const target = activeWindow();
  clearRoiSelection();
  if (!target) {
    clearPreview("未选择窗口");
    return;
  }

  updateActiveMeta();
  try {
    const preview = await invokeBackend("capture_window_preview", {
      hwnd: Number(target.hwnd),
      expectedWindow: windowIdentityForTarget(target),
    });
    const capture = previewCaptureSummary(preview);
    setPreviewImage(preview.dataUrl, preview.width, preview.height, "window", capture);
    updateActiveMeta(
      `${target.display} · ${preview.width}x${preview.height} · ${capture.label} · ${capture.provider}/${capture.reliability}`,
    );
    setStatus(`窗口预览已刷新 · ${capture.label}`);
  } catch (error) {
    clearPreview("预览失败");
    setStatus(`预览失败：${error}`);
    appendLog("error", `预览失败：${error}`);
  }
}

async function loadOfflineImage() {
  const imagePath = $("#offline-image-path").value.trim();
  if (!imagePath) {
    setStatus("需要输入离线截图路径");
    return;
  }
  clearRoiSelection();
  try {
    const preview = await invokeBackend("import_preview_image", { imagePath, saveCopy: false });
    setPreviewImage(preview.dataUrl, preview.width, preview.height, "image");
    updateActiveMeta(`离线图 · ${preview.width}x${preview.height}`);
    setStatus(`已载入离线图：${imagePath}`);
  } catch (error) {
    clearPreview("离线图载入失败");
    setStatus(`载入离线图失败：${error}`);
    appendLog("error", `载入离线图失败：${error}`);
  }
}

function setPreviewImage(dataUrl, width, height, source, capture = null) {
  const image = $("#preview-image");
  image.src = dataUrl;
  state.preview = { width, height, capture };
  state.previewSource = source;
  $("#preview-empty").style.display = "none";
  updateRoiBox();
  updateMatchBox();
}

function clearPreview(message) {
  $("#preview-image").removeAttribute("src");
  $("#preview-empty").style.display = "grid";
  $("#preview-empty").textContent = message;
  state.preview = null;
  state.previewSource = "window";
  state.matchOverlay = null;
  updateActiveMeta();
  updateRoiMeta();
  updateMatchBox();
}

function updateActiveMeta(override = null) {
  if (override) {
    $("#active-window-meta").textContent = override;
    return;
  }
  const target = activeWindow();
  $("#active-window-meta").textContent = target
    ? `${target.display} · hwnd=${target.hwnd} · ${target.clientWidth}x${target.clientHeight}`
    : "未选择窗口";
}

async function saveSnapshot() {
  const target = activeWindow();
  if (!target) {
    setStatus("需要先选择窗口");
    return;
  }
  try {
    const result = await invokeBackend("save_window_snapshot", {
      hwnd: Number(target.hwnd),
      expectedWindow: windowIdentityForTarget(target),
    });
    setStatus(`已保存截图：${result.savedPath}`);
    appendLog("info", `截图保存：${result.savedPath}`);
    appendLog(
      "info",
      `截图来源：${result.captureProvider}/${result.captureReliability} · frame=${result.frameHash}`,
    );
  } catch (error) {
    setStatus(`保存截图失败：${error}`);
    appendLog("error", `保存截图失败：${error}`);
  }
}

function startRoiDrag(event) {
  if (state.previewClickCapture) {
    captureClickPointFromPreview(event);
    return;
  }
  if (event.button !== 0) return;
  const point = imagePointFromEvent(event);
  if (!point) return;
  event.preventDefault();
  state.roiDragStart = point;
  state.roiSelection = { x: point.x, y: point.y, w: 0, h: 0 };
  updateRoiBox();
}

function moveRoiDrag(event) {
  if (!state.roiDragStart) return;
  const point = imagePointFromEvent(event);
  if (!point) return;
  const start = state.roiDragStart;
  state.roiSelection = {
    x: Math.min(start.x, point.x),
    y: Math.min(start.y, point.y),
    w: Math.abs(point.x - start.x),
    h: Math.abs(point.y - start.y),
  };
  updateRoiBox();
}

function endRoiDrag() {
  if (!state.roiDragStart) return;
  state.roiDragStart = null;
  if (!state.roiSelection || state.roiSelection.w < 2 || state.roiSelection.h < 2) {
    clearRoiSelection();
    return;
  }
  updateRoiBox();
  appendLog("info", `ROI 更新：${roiText(state.roiSelection)}`);
}

function imagePointFromEvent(event) {
  const image = $("#preview-image");
  if (!state.preview || !image.getAttribute("src")) return null;
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  return {
    x: Math.round((x / rect.width) * state.preview.width),
    y: Math.round((y / rect.height) * state.preview.height),
  };
}

function clearRoiSelection() {
  state.roiDragStart = null;
  state.roiSelection = null;
  updateRoiBox();
}

function updateRoiBox() {
  const box = $("#roi-box");
  const image = $("#preview-image");
  const roi = state.roiSelection;
  if (!state.preview || !roi || roi.w < 1 || roi.h < 1 || !image.getAttribute("src")) {
    box.style.display = "none";
    updateRoiMeta();
    return;
  }
  const imageRect = image.getBoundingClientRect();
  const stageRect = $(".preview-stage").getBoundingClientRect();
  const scaleX = imageRect.width / state.preview.width;
  const scaleY = imageRect.height / state.preview.height;
  box.style.display = "block";
  box.style.left = `${imageRect.left - stageRect.left + roi.x * scaleX}px`;
  box.style.top = `${imageRect.top - stageRect.top + roi.y * scaleY}px`;
  box.style.width = `${roi.w * scaleX}px`;
  box.style.height = `${roi.h * scaleY}px`;
  updateRoiMeta();
}

function updateRoiMeta() {
  $("#roi-meta").textContent = state.roiSelection ? `ROI: ${roiText(state.roiSelection)}` : "ROI: none";
}

function setMatchOverlayFromResult(result) {
  const box = normalizeMatchBox(result);
  state.matchOverlay = box;
  updateMatchBox();
}

function clearMatchOverlay() {
  state.matchOverlay = null;
  updateMatchBox();
}

function updateMatchBox() {
  const boxEl = $("#match-box");
  const meta = $("#match-meta");
  if (meta) meta.textContent = matchBoxMetaText(state.matchOverlay);
  if (!boxEl) return;
  const image = $("#preview-image");
  const stage = $(".preview-stage");
  if (!state.preview || !state.matchOverlay || !image?.getAttribute("src") || !stage) {
    boxEl.style.display = "none";
    boxEl.removeAttribute("data-label");
    return;
  }
  const projected = projectMatchBoxToStage(
    state.matchOverlay,
    state.preview,
    image.getBoundingClientRect(),
    stage.getBoundingClientRect(),
  );
  if (!projected) {
    boxEl.style.display = "none";
    boxEl.removeAttribute("data-label");
    return;
  }
  boxEl.style.display = "block";
  boxEl.style.left = `${projected.left}px`;
  boxEl.style.top = `${projected.top}px`;
  boxEl.style.width = `${projected.width}px`;
  boxEl.style.height = `${projected.height}px`;
  boxEl.setAttribute("data-label", projected.label);
}

function togglePreviewClickCapture() {
  state.previewClickCapture = !state.previewClickCapture;
  updatePreviewClickCaptureUi();
  setStatus(state.previewClickCapture ? "采点模式已开启：在预览图上点一下生成后台点击步骤" : "采点模式已关闭");
}

function updatePreviewClickCaptureUi(point = null) {
  const button = $("#preview-click-capture");
  if (button) {
    button.classList.toggle("active", state.previewClickCapture);
    button.setAttribute("aria-pressed", String(state.previewClickCapture));
  }
  const select = $("#preview-click-button");
  if (select) select.value = state.previewClickButton;
  $(".preview-stage")?.classList.toggle("sampling", state.previewClickCapture);
  const meta = $("#preview-click-meta");
  if (!meta) return;
  if (point) {
    meta.textContent = `采点: ${point.x},${point.y} · ${state.previewClickButton === "right" ? "右键" : "左键"}`;
  } else {
    meta.textContent = state.previewClickCapture
      ? `采点: on · ${state.previewClickButton === "right" ? "右键" : "左键"}`
      : "采点: off";
  }
}

function setPreviewClickButton(value) {
  state.previewClickButton = normalizedTargetButton(value);
  updatePreviewClickCaptureUi();
}

function roiText(roi) {
  return `${roi.x},${roi.y},${roi.w},${roi.h}`;
}

function roiCenterPoint(roi) {
  if (!roi) return null;
  return {
    x: Math.round(Number(roi.x || 0) + Number(roi.w || 0) / 2),
    y: Math.round(Number(roi.y || 0) + Number(roi.h || 0) / 2),
  };
}

function captureClickPointFromPreview(event) {
  if (![0, 2].includes(event.button)) return;
  const point = imagePointFromEvent(event);
  if (!point) return;
  event.preventDefault();
  const button = event.button === 2 ? "right" : state.previewClickButton;
  state.previewClickButton = normalizedTargetButton(button);
  const destination = ensurePreviewClickStep();
  if (!destination.step) {
    setStatus("需要先创建任务");
    return;
  }
  applyClickPointToStep(destination.step, point, state.previewClickButton);
  markDirty("draft");
  clearRoiSelection();
  renderSteps();
  renderStepEditor();
  renderTargets();
  updatePreviewClickCaptureUi(point);
  const actionLabel = destination.step.type === "double_click" ? "后台双击" : "后台点击";
  appendLog(
    "info",
    `${destination.created ? "已自动新增" : "已更新"}${actionLabel}步骤：${point.x},${point.y} · ${state.previewClickButton}`,
  );
  setStatus(`${destination.created ? "已新增" : "已更新"}${actionLabel}：${point.x},${point.y}`);
}

function ensurePreviewClickStep() {
  const current = selectedStep();
  if (["click", "double_click"].includes(current?.type)) return { step: current, created: false };
  const workflow = activeWorkflow();
  if (!workflow) return { step: null, created: false };
  const item = createStep("click");
  const index = selectedStepIndex(workflow);
  const inserted = insertStepAt(item, index >= 0 ? index + 1 : workflow.steps.length);
  return { step: inserted, created: Boolean(inserted) };
}

function applyClickPointToStep(item, point, button = "left") {
  const isDoubleClick = item.type === "double_click";
  item.type = isDoubleClick ? "double_click" : "click";
  item.name = item.name || (isDoubleClick ? "后台双击" : "后台点击");
  item.target = `x=${point.x},y=${point.y}`;
  item.command = commandWithValues(item.command, {
    button: normalizedTargetButton(button),
    mode: "hwnd-message",
  });
  item.expect = item.expect || (isDoubleClick ? "double_click.accepted" : "click.accepted");
  item.timeoutMs = item.timeoutMs || (isDoubleClick ? stepDefaults.double_click.timeoutMs : stepDefaults.click.timeoutMs);
  item.onFail = normalizeStepFailAction(
    item.onFail,
    isDoubleClick ? stepDefaults.double_click.onFail : stepDefaults.click.onFail,
  );
  unbindStepTarget(item);
  syncParamsFromLegacyFields(item);
}

function ensureCapturedTargetStep(targetItem) {
  const current = selectedStep();
  const hasTemplateImage = Boolean(targetItem?.dataUrl);
  if (hasTemplateImage && current && capturedImageStepTypes.has(current.type)) {
    return { step: current, created: false };
  }
  if (!hasTemplateImage && ["click", "double_click"].includes(current?.type)) {
    return { step: current, created: false };
  }
  const workflow = activeWorkflow();
  if (!workflow) return { step: null, created: false };
  const item = createStep(hasTemplateImage ? "image_click" : "click");
  if (!hasTemplateImage) {
    const point = roiCenterPoint(targetItem?.roi);
    if (point) item.target = `x=${point.x},y=${point.y}`;
    item.command = commandWithValues(item.command, {
      button: targetItem?.click?.button || "left",
      mode: "hwnd-message",
    });
    syncParamsFromLegacyFields(item);
  }
  const index = selectedStepIndex(workflow);
  const inserted = insertStepAt(item, index >= 0 ? index + 1 : workflow.steps.length);
  return { step: inserted, created: true };
}

async function targetFromRoi() {
  const roi = state.roiSelection;
  if (!roi || !state.preview) {
    setStatus("需要先在预览图上框选 ROI");
    return;
  }
  const target = activeWindow();
  const dataUrl = await cropPreviewRoiDataUrl(roi).catch((error) => {
    appendLog("warn", `ROI 裁剪失败，仅保存坐标：${error}`);
    return "";
  });
  const targetItem = normalizeTarget({
    id: randomId("target"),
    name: `ROI ${roiText(roi)}`,
    kind: "roi",
    createdAt: new Date().toISOString(),
    dataUrl,
    roi,
    match: { threshold: DEFAULT_IMAGE_THRESHOLD, scope: "roi" },
    click: { button: "left", point: "center" },
    source: {
      type: state.previewSource,
      hwnd: target?.hwnd || null,
      display: target?.display || "",
    },
    width: state.preview.width,
    height: state.preview.height,
    note: "由预览框选生成",
  });
  const destination = ensureCapturedTargetStep(targetItem);
  if (!destination.step) {
    setStatus("需要先创建任务步骤");
    return;
  }
  const shouldAdvance = Boolean(targetItem.dataUrl) && !destination.created && capturedStepNeedsImage(destination.step);
  const savedTarget = saveTargetForStep(targetItem, destination.step, { allowReplace: !destination.created });
  state.selectedTargetId = savedTarget.id;
  bindTargetToStep(destination.step, savedTarget, { preserveClick: !targetItem.dataUrl });
  const advanced = shouldAdvance && selectNextUnboundCapturedStepAfter(destination.step.id);
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  setStatus(
    advanced
      ? `已保存 ROI 目标：${savedTarget.name}，已跳到下一个待绑定图像步骤`
      : `${destination.created ? "已自动新增步骤并保存" : "已保存"} ROI 目标：${savedTarget.name}`,
  );
}

async function cropPreviewRoiDataUrl(roi) {
  const image = $("#preview-image");
  if (!image.getAttribute("src")) throw new Error("preview image is empty");
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, roi.w);
  canvas.height = Math.max(1, roi.h);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas context unavailable");
  await image.decode().catch(() => {});
  context.drawImage(image, roi.x, roi.y, roi.w, roi.h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function handlePasteImage(event) {
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
  const editableTarget = isEditablePasteTarget(event.target);
  let payload = null;
  if (item) {
    event.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    const dataUrl = await readBlobAsDataUrl(file);
    payload = {
      dataUrl,
      size: await imageSize(dataUrl).catch(() => ({ width: 0, height: 0 })),
      note: "由 Ctrl+V 粘贴创建",
    };
  } else {
    if (editableTarget) return;
    payload = await clipboardImagePayloadFromBackend();
    if (!payload) return;
    event.preventDefault();
  }
  await createTargetFromClipboardImagePayload(payload);
}

async function bindClipboardImageToCurrentStep() {
  const payload = await clipboardImagePayloadFromBackend({ showEmptyStatus: true });
  if (!payload) return;
  await createTargetFromClipboardImagePayload(payload);
}

async function clipboardImagePayloadFromBackend(options = {}) {
  try {
    const imported = await invokeBackend("import_clipboard_image");
    return {
      dataUrl: imported.dataUrl || "",
      size: { width: imported.width || 0, height: imported.height || 0 },
      note: "由 Ctrl+V 后端剪贴板导入创建",
    };
  } catch (error) {
    const message = String(error);
    if (!message.includes("剪贴板里没有图片")) {
      appendLog("warn", `后端剪贴板图片导入失败：${message}`);
    } else if (options.showEmptyStatus) {
      setStatus("剪贴板里没有可绑定图片");
    }
    return null;
  }
}

async function createTargetFromClipboardImagePayload(payload) {
  const dataUrl = payload?.dataUrl || "";
  if (!dataUrl) return;
  const size = payload.size || { width: 0, height: 0 };
  const targetItem = normalizeTarget({
    id: randomId("target"),
    name: `粘贴图片 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
    kind: "image",
    createdAt: new Date().toISOString(),
    dataUrl,
    match: { threshold: DEFAULT_IMAGE_THRESHOLD, scope: "window" },
    click: { button: "left", point: "center" },
    width: size.width,
    height: size.height,
    note: payload.note || "由剪贴板图片创建",
  });
  const destination = ensureCapturedTargetStep(targetItem);
  if (!destination.step) {
    setStatus("需要先创建任务步骤");
    return;
  }
  const shouldAdvance = !destination.created && capturedStepNeedsImage(destination.step);
  const savedTarget = saveTargetForStep(targetItem, destination.step, { allowReplace: !destination.created });
  state.selectedTargetId = savedTarget.id;
  bindTargetToStep(destination.step, savedTarget);
  const advanced = shouldAdvance && selectNextUnboundCapturedStepAfter(destination.step.id);
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  appendLog(
    "info",
    advanced
      ? `已粘贴图片目标并跳到下一个待绑定图像步骤：${savedTarget.name}`
      : `${destination.created ? "已自动新增图像点击步骤并" : "已"}粘贴图片目标：${savedTarget.name}`,
  );
  return savedTarget;
}

function isEditablePasteTarget(target) {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
}

function bindTargetToSelectedStep(targetItem, options = {}) {
  const item = selectedStep();
  if (!item) return;
  bindTargetToStep(item, targetItem, options);
}

function bindTargetToStep(item, targetItem, options = {}) {
  item.targetId = targetItem.id;
  item.target = targetItem.id;
  const commandDefaults = targetCommandDefaults(targetItem, item.command);
  if (["click", "double_click"].includes(item.type) && options.preserveClick) {
    item.command = commandWithValues(item.command, {
      button: commandDefaults.button,
      mode: "hwnd-message",
    });
    syncParamsFromLegacyFields(item);
    return;
  }
  if (item.type === "ocr_assert" || targetItem.kind === "ocr") {
    item.type = "ocr_assert";
    item.name = item.name || "OCR 确认";
    item.command = commandWithMissingValues(item.command, { lang: "zh" });
    item.expect = item.expect || "text_found";
    syncParamsFromLegacyFields(item);
    return;
  }
  if (!["image_click", "double_click", "wait_image", "detect_page"].includes(item.type)) {
    item.type = "image_click";
    item.name = "图像点击";
    item.expect = "screen.changed";
  }
  item.command = commandWithValues(item.command, commandDefaults);
  syncParamsFromLegacyFields(item);
}

function saveTargetForStep(incomingTarget, item, options = {}) {
  const allowReplace = options.allowReplace !== false;
  const existing = allowReplace && item ? targetForStep(item) : null;
  const existingUsages = existing ? targetUsages(existing.id) : [];
  const canReplaceExisting = existing && (existingUsages.length <= 1 || isStepBlockPlaceholderTarget(existing));
  if (!canReplaceExisting) {
    state.workspace.targets.unshift(incomingTarget);
    return incomingTarget;
  }
  const next = normalizeTarget({
    ...existing,
    kind: incomingTarget.kind || existing.kind,
    dataUrl: incomingTarget.dataUrl || existing.dataUrl,
    roi: incomingTarget.roi || existing.roi,
    match: incomingTarget.match || existing.match,
    click: incomingTarget.click || existing.click,
    source: incomingTarget.source || existing.source,
    width: incomingTarget.width || existing.width,
    height: incomingTarget.height || existing.height,
    note: incomingTarget.note || existing.note,
    updatedAt: new Date().toISOString(),
  });
  Object.assign(existing, next);
  return existing;
}

function isStepBlockPlaceholderTarget(targetItem) {
  return !targetItem?.dataUrl && !targetItem?.roi && String(targetItem?.note || "").includes("步骤片段自动创建");
}

function targetThumbLabel(targetItem) {
  if (targetItem?.dataUrl) return "";
  if (isStepBlockPlaceholderTarget(targetItem)) return "待贴图";
  if (targetItem?.roi) return "ROI";
  if (targetItem?.kind === "ocr") return "OCR";
  if (targetItem?.kind === "click_target") return "XY";
  if (targetItem?.kind === "state") return "STATE";
  if (targetItem?.kind === "page") return "PAGE";
  if (targetItem?.kind === "image") return "IMG";
  return "?";
}

function buildTargetReadinessIndex() {
  const byTargetId = new Map();
  for (const workflow of state.workspace.workflows || []) {
    const completion = workflowCompletionState(workflow, validateWorkflow(workflow, "background"));
    if (!completion.items.length) continue;
    const stepsById = new Map((workflow.steps || []).map((item) => [item.id, item]));
    for (const item of completion.items) {
      const step = stepsById.get(item.stepId);
      const targetId = stepTargetId(step);
      if (!targetId) continue;
      const entry = byTargetId.get(targetId) || [];
      entry.push(item);
      byTargetId.set(targetId, entry);
    }
  }
  return byTargetId;
}

function targetReadinessForDisplay(targetItem, readinessIndex, usageCount = targetUsages(targetItem?.id).length) {
  const indexedItems = readinessIndex.get(targetItem?.id) || [];
  if (indexedItems.length) {
    const summary = readinessBucketSummary(indexedItems);
    const level = summary.issues ? "blocked" : "warning";
    const detail = readinessDetailText(summary) || `${summary.issues} 阻塞 · ${summary.warnings} 提醒`;
    return {
      level,
      label: summary.issues ? `阻塞 ${summary.issues}` : `提醒 ${summary.warnings}`,
      detail,
    };
  }
  if (!usageCount) return { level: "unused", label: "未使用", detail: "未被任何步骤引用" };
  if (targetItem?.dataUrl) return { level: "ready", label: "已采样", detail: "已有图像素材" };
  if (targetItem?.roi) return { level: "ready", label: "可定位", detail: "已有 ROI 定位" };
  if (targetItem?.kind === "ocr") {
    return (targetItem.texts || []).length
      ? { level: "ready", label: "OCR 文本", detail: "已有 OCR 期望文本" }
      : { level: "blocked", label: "缺文本", detail: "OCR 目标缺少期望文本" };
  }
  if (["image", "page"].includes(targetItem?.kind)) {
    return { level: "blocked", label: "缺素材", detail: "需要 Ctrl+V 图片或 ROI 裁剪图" };
  }
  if (targetItem?.kind === "click_target") {
    return { level: "blocked", label: "缺坐标", detail: "后台点击需要 x/y 坐标或 ROI 目标" };
  }
  return { level: "ready", label: "已配置", detail: "无需图像素材" };
}

function renderTargets(options = {}) {
  fillTargetKindSelects();
  $("#target-search").value = state.targetSearch;
  $("#target-kind-filter").value = state.targetKindFilter;
  const filteredTargets = visibleTargets();
  $("#target-count").textContent =
    filteredTargets.length === state.workspace.targets.length
      ? String(state.workspace.targets.length)
      : `${filteredTargets.length}/${state.workspace.targets.length}`;
  const list = $("#target-list");
  list.replaceChildren();
  const previousSelectedTargetId = state.selectedTargetId;
  if (!state.workspace.targets.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "暂无识别目标";
    list.append(empty);
    state.selectedTargetId = "";
    renderTargetEditor([]);
    return;
  }
  ensureSelectedTarget(filteredTargets);
  if (!filteredTargets.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "没有符合筛选条件的目标";
    list.append(empty);
    renderTargetEditor(filteredTargets);
    return;
  }
  const boundTargetId = stepTargetId(selectedStep());
  const readinessIndex = buildTargetReadinessIndex();
  for (const targetItem of filteredTargets) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "compact-row target-row";
    row.classList.toggle("active", targetItem.id === state.selectedTargetId);
    row.classList.toggle("bound", targetItem.id === boundTargetId);
    const usages = targetUsages(targetItem.id).length;
    const readiness = targetReadinessForDisplay(targetItem, readinessIndex, usages);
    row.classList.add(readiness.level);
    const thumb = targetItem.dataUrl
      ? `<img src="${targetItem.dataUrl}" alt="${escapeHtml(targetItem.name)}" />`
      : `<i>${escapeHtml(targetThumbLabel(targetItem))}</i>`;
    const threshold = targetItem.match?.threshold ?? DEFAULT_IMAGE_THRESHOLD;
    const click = `${targetItem.click?.button || "left"}@${targetItem.click?.point || "center"}`;
    row.innerHTML = `
      ${thumb}
      <span>
        <strong>${escapeHtml(targetItem.name)}</strong>
        <small>${escapeHtml(targetItem.kind)} · ${targetItem.width || "-"}x${targetItem.height || "-"} · t=${escapeHtml(threshold)} · ${escapeHtml(click)} · ${usages} 处 · <b class="target-readiness ${readiness.level}" title="${escapeHtml(readiness.detail)}">${escapeHtml(readiness.label)}</b></small>
      </span>
      <em>${targetItem.id === boundTargetId ? "已绑定" : "选择"}</em>
    `;
    row.addEventListener("click", () => {
      state.selectedTargetId = targetItem.id;
      setInspectorTab("target");
      renderTargets();
      setStatus(`已选择目标：${targetItem.name}`);
    });
    row.addEventListener("dblclick", () => {
      state.selectedTargetId = targetItem.id;
      bindSelectedTargetToStep();
    });
    list.append(row);
  }
  if (!options.preserveEditor || previousSelectedTargetId !== state.selectedTargetId) {
    renderTargetEditor(filteredTargets);
  }
}

function validateWorkflow(workflow = activeWorkflow(), mode = "definition") {
  const result = {
    issues: [],
    warnings: [],
    stepIssues: {},
    stepWarnings: {},
    firstIssueStepId: "",
  };
  const addStepMessage = (bucket, item, message) => {
    if (!item?.id) return;
    const group = bucket === "issues" ? result.stepIssues : result.stepWarnings;
    (group[item.id] ||= []).push(message);
    if (bucket === "issues" && !result.firstIssueStepId) result.firstIssueStepId = item.id;
  };
  const addIssue = (message, item = null) => {
    result.issues.push(message);
    addStepMessage("issues", item, message);
  };
  const addWarning = (message, item = null) => {
    result.warnings.push(message);
    addStepMessage("warnings", item, message);
  };
  if (!workflow) addIssue("没有当前任务");
  if (workflow && !workflow.name.trim()) addIssue("任务名称为空");
  if (workflow && workflow.steps.length === 0) addIssue("步骤为空");
  const enabledSteps = workflow?.steps.filter((item) => item.enabled !== false) || [];
  if (workflow && workflow.steps.length > 0 && !enabledSteps.length) {
    addIssue("没有启用步骤");
  }
  if (workflow && enabledSteps.length > 0 && enabledSteps.length < 10) {
    addWarning("少于 10 步，作为完整样例覆盖不足");
  }
  const jumpCycleFindings = unboundedWorkflowJumpCycleFindings(state.workspace?.workflows || []);
  for (const [index, item] of workflow?.steps.entries() || []) {
    const prefix = `第 ${index + 1} 步`;
    if (!stepLabels[item.type]) addIssue(`${prefix} 类型未知`, item);
    if (item.enabled === false) continue;
    if (!item.name.trim()) addIssue(`${prefix} 名称为空`, item);
    if (!item.target.trim() && !["delay", "snapshot", "text_input", "task_jump", "loop"].includes(item.type)) {
      addIssue(`${prefix} 缺少目标`, item);
    }
    if (!Number.isFinite(item.timeoutMs) || item.timeoutMs < 0) addIssue(`${prefix} 超时必须是非负数`, item);
    if (!Number.isFinite(item.retry) || item.retry < 0) addIssue(`${prefix} 重试必须是非负数`, item);
    if (item.type === "hotkey" && !/[+]/.test(item.target) && !isSingleKeyHotkey(item.target)) {
      addWarning(`${prefix} 快捷键建议使用 ALT+N 这类组合格式`, item);
    }
    validateStepControlFlowReferences(workflow, item, prefix, addIssue, addWarning, mode, jumpCycleFindings);
    validateStepRuntimeFields(item, prefix, addIssue, addWarning, mode);
  }
  return result;
}

function isSingleKeyHotkey(value) {
  return ["ESC", "ESCAPE", "ENTER", "RETURN", "TAB", "SPACE", "BACKSPACE"].includes(String(value || "").trim().toUpperCase());
}

function validateStepControlFlowReferences(workflow, item, prefix, addIssue, addWarning, mode, jumpCycleFindings = []) {
  const steps = workflow?.steps || [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const currentIndex = steps.findIndex((step) => step.id === item.id);
  const workflowIds = new Set((state.workspace?.workflows || []).map((workflowItem) => workflowItem.id));
  const addReferenceMessage = (message, options = {}) => {
    mode === "background" && options.executable !== false ? addIssue(message, item) : addWarning(message, item);
  };
  const checkStepReference = (field, label, options = {}) => {
    const targetId = String(item[field] || "").trim();
    if (!targetId) return;
    const targetStep = byId.get(targetId);
    if (!targetStep) {
      addReferenceMessage(`${prefix} ${label} 指向不存在的步骤`, options);
      return;
    }
    if (targetStep.id === item.id) {
      addReferenceMessage(`${prefix} ${label} 不能指向当前步骤`, options);
    }
    if (targetStep.enabled === false) {
      addReferenceMessage(`${prefix} ${label} 指向已停用步骤`, options);
    }
    const targetIndex = steps.findIndex((step) => step.id === targetId);
    if (options.executable !== false && currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex && !item.maxIterations) {
      addReferenceMessage(`${prefix} ${label} 是后向跳转，必须设置最大循环次数`, options);
    }
  };
  if (plannedOnlyStepTypes.has(item.type)) {
    if (item.targetStepId || item.elseTargetStepId || item.jumpWorkflowId) {
      addReferenceMessage(`${prefix} ${stepLabels[item.type] || item.type} 是计划态步骤，不能驱动成功/条件/任务跳转`, {
        executable: false,
      });
    }
  } else {
    checkStepReference(
      "targetStepId",
      item.type === "condition" ? "条件 true 分支" : item.type === "loop" ? "循环目标" : "成功分支",
    );
    if (item.type === "condition") {
      checkStepReference("elseTargetStepId", "条件 false 分支");
    } else if (item.elseTargetStepId) {
      addWarning(`${prefix} 只有 condition 步骤会使用 False 跳转，当前步骤后台不会读取该字段`, item);
    }
  }
  checkStepReference("recoveryStepId", "恢复入口", { executable: item.onFail === "restore" });
  if (item.onFail === "restore" && item.recoveryStepId) {
    const recoveryStep = byId.get(item.recoveryStepId);
    const recoveryIndex = steps.findIndex((step) => step.id === item.recoveryStepId);
    if (recoveryStep && plannedOnlyStepTypes.has(recoveryStep.type)) {
      addReferenceMessage(`${prefix} 恢复入口不能只指向计划态 restore；请指向热键、等待、页面确认等恢复片段第一步`);
    } else if (recoveryStep && recoveryIndex >= 0) {
      const fragment = recoveryFragmentStats(steps, recoveryIndex);
      if (!fragment.entryExecutable) {
        addReferenceMessage(`${prefix} 恢复入口必须指向恢复片段的可执行步骤`);
      }
      if (fragment.executableCount < 1) {
        addReferenceMessage(`${prefix} 恢复片段需要至少一个可执行步骤，不能只靠控制流或计划态步骤`);
      }
      if (fragment.verificationCount < 1) {
        addReferenceMessage(`${prefix} 恢复片段需要至少一个页面确认、等待图像、OCR、重试等待或截图记录步骤`);
      }
    }
  }
  const jumpWorkflowId = String(item.jumpWorkflowId || "").trim();
  if (item.type === "task_jump" && !jumpWorkflowId) {
    addReferenceMessage(`${prefix} 任务跳转需要选择目标任务`);
  }
  if (jumpWorkflowId && !workflowIds.has(jumpWorkflowId)) {
    addReferenceMessage(`${prefix} 任务跳转指向不存在的任务`);
  } else if (jumpWorkflowId) {
    if (item.targetStepId || item.elseTargetStepId) {
      addReferenceMessage(`${prefix} 任务跳转不能和同任务成功/条件跳转同时设置`);
    }
    if (jumpWorkflowId === workflow.id && !item.maxIterations) {
      addReferenceMessage(`${prefix} 任务跳转指向当前任务，必须设置最大循环次数`);
    }
    const cycleFinding = jumpCycleFindings.find((finding) => finding.workflowId === workflow.id && finding.stepId === item.id);
    if (cycleFinding) {
      addReferenceMessage(
        `${prefix} 任务跳转参与跨任务循环（${cycleFinding.cycleWorkflowNames.join(" -> ")}），该跳转必须设置最大循环次数`,
      );
    }
    addWarning(`${prefix} 任务跳转会在当前 hwnd 会话内切换任务，不改写持久化窗口队列`, item);
  }
  if (item.recoveryStepId && item.onFail !== "restore") {
    addWarning(`${prefix} 恢复入口已保存，但失败处理不是 restore，不会自动使用`, item);
  }
  if (item.recoveryAction && item.onFail !== "restore" && normalizeRecoveryAction(item.recoveryAction) !== "stop") {
    addWarning(`${prefix} 恢复后动作已保存，但失败处理不是 restore，不会自动使用`, item);
  }
  if (item.onFail === "restore" && normalizeRecoveryAction(item.recoveryAction) === "retry" && !item.maxIterations) {
    addReferenceMessage(`${prefix} 恢复后重试必须设置最大循环次数，避免恢复后无限重跑原失败步骤`);
  }
  if (item.maxIterations && (!Number.isInteger(Number(item.maxIterations)) || Number(item.maxIterations) < 0)) {
    addReferenceMessage(`${prefix} 最大循环次数必须是非负整数`);
  }
  if (item.type === "loop") {
    const targetId = String(item.targetStepId || "").trim();
    const targetIndex = steps.findIndex((step) => step.id === targetId);
    if (!targetId) {
      addReferenceMessage(`${prefix} 循环步骤必须选择循环目标`);
    }
    if (!item.maxIterations) {
      addReferenceMessage(`${prefix} 循环步骤必须设置最大循环次数`);
    }
    if (targetId && targetIndex > currentIndex) {
      addReferenceMessage(`${prefix} 循环目标应指向当前步骤之前的步骤，避免把跳过流程伪装成循环`);
    }
    if (item.elseTargetStepId) {
      addWarning(`${prefix} 循环步骤不会读取 False 跳转，已保留但不会执行`, item);
    }
    if (item.jumpWorkflowId) {
      addReferenceMessage(`${prefix} 循环步骤不能同时设置任务跳转`);
    }
  }
}

function recoveryFragmentStats(steps, startIndex) {
  const stats = { executableCount: 0, verificationCount: 0, entryExecutable: false };
  const start = Math.max(0, startIndex);
  const entry = steps[start];
  const entryIsDefaultFragment = isDefaultRecoveryFragmentStep(entry);
  stats.entryExecutable = Boolean(entry && entry.enabled !== false && recoveryExecutableStepTypes.has(entry.type));
  for (let index = start; index < steps.length; index += 1) {
    const stepItem = steps[index];
    if (!stepItem || stepItem.enabled === false) continue;
    if (index > start && entryIsDefaultFragment && !isDefaultRecoveryFragmentStep(stepItem)) break;
    if (!entryIsDefaultFragment && index > start && (plannedOnlyStepTypes.has(stepItem.type) || ["condition", "loop", "task_jump"].includes(stepItem.type))) break;
    if (!entryIsDefaultFragment && index - start >= 4) break;
    if (!plannedOnlyStepTypes.has(stepItem.type) && recoveryExecutableStepTypes.has(stepItem.type)) {
      stats.executableCount += 1;
    }
    if (!plannedOnlyStepTypes.has(stepItem.type) && recoveryVerificationStepTypes.has(stepItem.type)) {
      stats.verificationCount += 1;
    }
  }
  return stats;
}

function buildStepValidationIndex(workflow, validation) {
  const byId = {};
  const steps = workflow?.steps || [];
  for (const item of steps) {
    byId[item.id] = {
      issues: [...(validation.stepIssues?.[item.id] || [])],
      warnings: [...(validation.stepWarnings?.[item.id] || [])],
    };
  }
  return byId;
}

function validateStepRuntimeFields(item, prefix, addIssue, addWarning, mode) {
  const legacy = projectedLegacyStep(item);
  const button = commandValue(legacy.command, "button");
  if (button && !["left", "l", "primary", "right", "r", "secondary"].includes(button.toLowerCase())) {
    addIssue(`${prefix} 鼠标键只支持 left/right`, item);
  }
  const threshold = commandValue(legacy.command, "threshold");
  if (threshold) {
    const value = Number(threshold);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      addIssue(`${prefix} 匹配阈值必须在 0 到 1 之间`, item);
    }
  }
  for (const key of ["preDelay", "postDelay"]) {
    const raw = commandValue(legacy.command, key);
    if (raw && durationMsFromText(raw) == null) {
      addIssue(`${prefix} ${key} 必须是 300ms、1s 或非负毫秒数字`, item);
    }
  }
  for (const key of ["offsetX", "offsetY"]) {
    const raw = commandValue(legacy.command, key);
    if (raw && normalizedInteger(raw) == null) {
      addIssue(`${prefix} ${key} 必须是整数像素`, item);
    }
  }
  const clickPoint = commandValue(legacy.command, "point");
  if (["image_click", "double_click"].includes(item.type) && clickPoint && !imageClickPointOptions.has(clickPoint)) {
    addIssue(`${prefix} 图像点击点只支持 center/top-left/top-right/bottom-left/bottom-right`, item);
  }
  const point = parsePointText(legacy.target) || parsePointText(legacy.command);
  const targetId = stepTargetId(legacy);
  const targetItem = targetForStep(legacy);
  const manualConfirmation = manualConfirmationStatusForStep(legacy, targetItem);
  const hasRoi = Boolean(targetItem?.roi);
  const hasImage = Boolean(targetItem?.dataUrl);
  if (targetId && !targetItem) {
    addIssue(`${prefix} 绑定的识别目标已不存在`, item);
  }
  if (manualConfirmation.required && !manualConfirmation.valid) {
    const message = `${prefix} 受保护输入${manualConfirmationStatusText(manualConfirmation)}`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  if (["click", "double_click"].includes(item.type) && !point && !hasRoi && !(item.type === "double_click" && hasImage)) {
    const message = `${prefix} ${item.type === "double_click" ? "后台双击" : "后台点击"}需要 x/y 坐标、绑定 ROI 或图片目标`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  if (["image_click", "wait_image", "detect_page"].includes(item.type) && !hasImage) {
    const message = `${prefix} 图像步骤需要 Ctrl+V 图片或 ROI 裁剪图`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  if (["image_click", "double_click"].includes(item.type) && !hasImage && (point || hasRoi)) {
    addWarning(`${prefix} 没有图片时会退化为直接${item.type === "double_click" ? "双击" : "点击"}坐标/ROI，请确认这是有意行为`, item);
  }
  if (item.type === "ocr_assert") {
    validateOcrStepRuntimeFields(item, prefix, addIssue, addWarning, mode);
  }
  if (item.type === "delay" && durationMsFromText(legacy.target) == null && legacy.timeoutMs <= 0) {
    addIssue(`${prefix} 延迟步骤需要有效等待时长`, item);
  }
  if (item.type === "text_input") {
    const text = textInputValueForStep(item);
    if (!text) {
      addIssue(`${prefix} 文本输入需要内容`, item);
    } else if ([...text].length > MAX_TEXT_INPUT_CHARS) {
      addIssue(`${prefix} 文本输入最多 ${MAX_TEXT_INPUT_CHARS} 个字符`, item);
    }
  }
  if (item.type === "retry_until") {
    const interval = commandValue(legacy.command, "interval");
    if (interval && durationMsFromText(interval) == null) {
      addIssue(`${prefix} 重试间隔格式应为 800ms 或 1s`, item);
    }
    if (!retryUntilHasVisualTarget(item)) {
      const message = `${prefix} 重试直到需要绑定图片、ROI 或坐标目标；纯状态目标当前只是计划语义，后台不会判定成功`;
      mode === "background" ? addIssue(message, item) : addWarning(message, item);
    }
  }
  if (item.type === "condition") {
    const guard = evaluateConditionGuard(
      legacy,
      { status: "ok", action: "validation", matched: false, inputSent: false, score: 0 },
      null,
    );
    if (!guard.supported) {
      const message = `${prefix} 条件 guard=${guard.expression || "空"} 当前不支持；请使用 true/false、last.matched、last.status=...、last.action=... 或 last.score 比较`;
      mode === "background" ? addIssue(message, item) : addWarning(message, item);
    }
  }
  if (item.onFail === "restore") {
    const action = normalizeRecoveryAction(item.recoveryAction);
    const actionLabel =
      action === "retry"
        ? `恢复后重试原失败步骤，最多 ${item.maxIterations || 0} 次`
        : action === "continue"
          ? "恢复后继续原失败步骤后的正常路径"
          : "恢复后停止当前窗口队列并保留失败报告";
    const message = item.recoveryStepId
      ? `${prefix} 失败处理 restore 会跳转到恢复入口；${actionLabel}`
      : `${prefix} 失败处理 restore 未设置恢复入口；失败仍会停止队列`;
    addWarning(message, item);
  }
  if (plannedOnlyStepTypes.has(item.type)) {
    addWarning(`${prefix} ${stepLabels[item.type] || item.type} 当前只记录计划态，不会改变真实执行路径`, item);
  }
}

function validateOcrStepRuntimeFields(item, prefix, addIssue, addWarning, mode) {
  const legacy = projectedLegacyStep(item);
  const targetItem = targetForStep(legacy);
  const texts = ocrExpectedTextsForStep(legacy, targetItem);
  if (!texts.length) {
    const message = `${prefix} OCR 需要目标文本，可在目标库 OCR 文本里填写或在步骤目标/expect/text 参数里填写`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  const lang = ocrLanguageForStep(legacy);
  if (lang && !/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(lang)) {
    addWarning(`${prefix} OCR 语言标记建议使用 zh、zh-Hans、en-US 这类格式`, item);
  }
  if (mode === "background" && !targetItem?.roi && isUnboundedOcrRegion(ocrRegionForStep(legacy))) {
    addWarning(`${prefix} OCR 未限定 ROI，会识别整窗，建议绑定 ROI 或设置 roi=top/panel/dialog`, item);
  }
}

function isUnboundedOcrRegion(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || ["auto", "full", "window"].includes(normalized);
}

function ocrExpectedTextsForStep(item, targetItem = targetForStep(item)) {
  const legacy = projectedLegacyStep(item);
  const texts = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (!text || isGenericOcrExpectation(text)) return;
    if (!texts.some((item) => item.toLowerCase() === text.toLowerCase())) texts.push(text);
  };
  for (const text of targetItem?.texts || []) push(text);
  if (!texts.length) push(legacy?.target);
  push(legacy?.expect);
  push(commandValue(legacy?.command || "", "text"));
  push(commandValue(legacy?.command || "", "contains"));
  push(commandValue(legacy?.command || "", "expect"));
  return texts;
}

function isGenericOcrExpectation(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("text.") ||
    ["text_found", "text.visible", "found", "visible", "ready", "ready=true", "screen.changed", "panel.open"].includes(normalized)
  );
}

function ocrLanguageForStep(item) {
  const legacy = projectedLegacyStep(item);
  return commandValue(legacy?.command || "", "lang") || commandValue(legacy?.command || "", "language") || "zh";
}

function ocrRegionForStep(item) {
  const legacy = projectedLegacyStep(item);
  return commandValue(legacy?.command || "", "roi") || "";
}

function textInputValueForStep(item) {
  const legacy = projectedLegacyStep(item);
  return (
    commandValue(legacy?.command || "", "text") ||
    commandValue(legacy?.command || "", "value") ||
    String(legacy?.target || "")
  ).trim();
}

function validateActiveWorkflow() {
  const workflow = activeWorkflow();
  const result = validateWorkflow(workflow);
  if (result.issues.length) {
    if (result.firstIssueStepId) state.selectedStepId = result.firstIssueStepId;
    $("#task-model-state").textContent = "invalid";
    $("#task-model-state").classList.remove("ok");
    setRunState("blocked");
    $("#run-summary").textContent = result.issues.join(" / ");
    appendLog("warn", `定义校验未通过：${result.issues.join("；")}`);
    setStatus("任务定义需要补全");
    renderSteps();
    renderStepEditor();
    renderTargets();
    return false;
  }
  state.stepValidation = buildStepValidationIndex(workflow, result);
  $("#task-model-state").textContent = result.warnings.length ? "ready with warnings" : "ready";
  $("#task-model-state").classList.add("ok");
  setRunState("ready");
  const enabledSteps = workflow.steps.filter((item) => item.enabled !== false).length;
  $("#run-summary").textContent = `${workflow.name} · 启用 ${enabledSteps}/${workflow.steps.length} 步 · ${result.warnings.join(" / ") || "可运行"}`;
  appendLog("info", `定义校验通过：启用 ${enabledSteps}/${workflow.steps.length} 步`);
  renderSteps();
  renderStepEditor();
  return true;
}

function validateAllWorkflows() {
  const failures = [];
  const warnings = [];
  for (const workflow of state.workspace.workflows) {
    const result = validateWorkflow(workflow);
    if (result.issues.length) failures.push(`${workflow.name}: ${result.issues.length} 个问题`);
    if (result.warnings.length) warnings.push(`${workflow.name}: ${result.warnings.length} 个提醒`);
  }
  if (failures.length) {
    setRunState("blocked");
    $("#run-summary").textContent = failures.join(" / ");
    appendLog("warn", `全部校验未通过：${failures.join("；")}`);
    return false;
  }
  setRunState("ready");
  $("#run-summary").textContent = `全部 ${state.workspace.workflows.length} 个任务通过；${warnings.length ? warnings.join(" / ") : "样例覆盖完整"}`;
  appendLog("info", `全部任务校验通过：${state.workspace.workflows.length} 个`);
  return true;
}

function dryRunSelected() {
  void runSelected("dry");
}

function backgroundRunSelected() {
  void runSelected("background");
}

async function runSelected(mode) {
  const targets = selectedWindows();
  if (!targets.length) {
    setStatus("需要先选择窗口");
    return;
  }
  let launched = 0;
  for (const target of targets) {
    const assignment = assignmentForHwnd(target.hwnd);
    if (!assignment?.queue?.length) {
      appendLog("warn", `${target.display} 未配置窗口队列，已跳过；不会回退执行当前任务`);
      continue;
    }
    const source = "queue";
    const runEntries = queueRunEntriesForTarget(target);
    const workflows = runEntries.map((entry) => entry.workflow);
    const mismatch = windowIdentityMismatchReason(assignment.windowIdentity, windowIdentityForTarget(target));
    if (mismatch) {
      appendLog("warn", `${target.display} 队列窗口身份不匹配：${mismatch}；请刷新窗口后重新分配任务`);
      continue;
    }
    if (!workflows.length) {
      appendLog("warn", `${target.display} 没有可运行任务`);
      continue;
    }
    const validation = validateWorkflowQueue(workflows, mode);
    if (validation.issues.length) {
      if (validation.firstBlockingWorkflow?.id === activeWorkflow()?.id) {
        state.stepValidation = buildStepValidationIndex(
          validation.firstBlockingWorkflow,
          validation.firstBlockingValidation,
        );
        if (validation.firstBlockingValidation.firstIssueStepId) {
          state.selectedStepId = validation.firstBlockingValidation.firstIssueStepId;
        }
        renderSteps(validation.firstBlockingValidation);
        renderStepEditor();
      }
      appendLog("warn", `${target.display} 队列校验失败：${validation.issues.join("；")}`);
      continue;
    }
    if (validation.warnings.length) {
      appendLog("warn", `${target.display} 队列提醒：${validation.warnings.join("；")}`);
    }
    if (await startRunForWindow(target, runEntries, mode, source)) launched += 1;
  }
  setStatus(launched ? `已启动 ${launched} 个窗口队列` : "没有启动任何窗口队列");
}

function validateWorkflowQueue(workflows, mode = "definition") {
  const issues = [];
  const warnings = [];
  let firstBlockingWorkflow = null;
  let firstBlockingValidation = null;
  for (const [index, workflow] of workflows.entries()) {
    const result = validateWorkflow(workflow, mode);
    if (result.issues.length && !firstBlockingWorkflow) {
      firstBlockingWorkflow = workflow;
      firstBlockingValidation = result;
    }
    for (const issue of result.issues) issues.push(`${index + 1}.${workflow.name}: ${issue}`);
    for (const warning of result.warnings) warnings.push(`${index + 1}.${workflow.name}: ${warning}`);
  }
  return { issues, warnings, firstBlockingWorkflow, firstBlockingValidation };
}

async function startRunForWindow(target, runEntries, mode, source) {
  const key = String(target.hwnd);
  if (isActiveSession(state.sessions[key])) {
    appendLog("warn", `${target.display} 已有运行中的会话，同 hwnd 保持互斥`);
    return false;
  }
  const runPlan = runEntries.map((entry) => ({
    workflow: JSON.parse(JSON.stringify(entry.workflow)),
    queueItem: normalizeQueueItem(entry.queueItem || { workflowId: entry.workflow.id }),
  }));
  const enabledStepTotal = runPlan.reduce(
    (sum, entry) => sum + entry.workflow.steps.filter((item) => item.enabled !== false).length,
    0,
  );
  if (!enabledStepTotal) {
    appendLog("warn", `${target.display} 队列没有启用步骤`);
    return false;
  }
  const session = reserveStartingSession(state.sessions, {
    id: `run-${++state.sessionSerial}`,
    mode,
    source,
    hwnd: target.hwnd,
    display: target.display,
    runPlan,
    totalSteps: enabledStepTotal,
    startedAt: new Date().toISOString(),
  });
  if (!session) {
    appendLog("warn", `${target.display} 已有 starting/running/paused 会话，同 hwnd 保持互斥`);
    return false;
  }
  setRunState("running");
  renderSessions();
  let windowIdentity = null;
  try {
    windowIdentity = await currentWindowIdentityForRun(target, mode);
  } catch (error) {
    releaseStartingSession(state.sessions, target.hwnd, session);
    syncRunState();
    renderSessions();
    throw error;
  }
  if (!windowIdentity || !activateStartingSession(state.sessions, target.hwnd, session, windowIdentity)) {
    releaseStartingSession(state.sessions, target.hwnd, session);
    syncRunState();
    renderSessions();
    return false;
  }
  recordRunEvent(session, "session_start", {
    status: "running",
    detail: `${modeLabel(mode)} 启动：${target.display} -> ${session.workflowNames.join(" / ")}`,
    queueLength: runPlan.length,
  });
  appendLog("info", `${modeLabel(mode)} 启动：${target.display} -> ${session.workflowNames.join(" / ")}`);
  renderSessions();
  void runSession(session, runPlan);
  return true;
}

function pauseRuns() {
  let count = 0;
  for (const session of activeRunSessions()) {
    if (session.cancelRequested || session.pauseRequested) continue;
    session.pauseRequested = true;
    session.pauseRequestedAt = new Date().toISOString();
    session.logs.unshift("暂停请求已提交，当前步骤结束或到达等待点后挂起");
    count += 1;
  }
  appendLog(
    count ? "warn" : "info",
    count ? `暂停请求已提交 ${count} 个运行会话；已发出的单个后台步骤会先到达安全点` : "没有可暂停的运行会话",
  );
  renderSessions();
}

function resumeRuns() {
  let count = 0;
  for (const session of pausedSessions()) {
    if (session.cancelRequested) continue;
    resumeSession(session);
    count += 1;
  }
  appendLog(count ? "info" : "warn", count ? `已请求继续 ${count} 个运行会话` : "没有可继续的运行会话");
  renderSessions();
}

function setSessionPaused(session, reason = "pause requested", context = {}) {
  if (!session || session.cancelRequested || !session.pauseRequested) return;
  const workflow = context.workflow || null;
  const item = context.item || null;
  if (!session.pauseStartedAt) {
    session.pauseStartedAt = new Date().toISOString();
    session.pauseCount = (session.pauseCount || 0) + 1;
  }
  if (!session.activePauseEvent) {
    session.activePauseEvent = {
      workflowId: workflow?.id || "",
      workflowName: workflow?.name || session.currentWorkflowName || "",
      stepId: item?.id || "",
      stepName: item?.name || "",
      phase: "pause",
      reason,
      delayMs: 0,
      status: "paused",
      startedAt: session.pauseStartedAt,
      endedAt: "",
      durationMs: 0,
    };
    session.queueEvents.push(session.activePauseEvent);
    recordRunEvent(session, "pause", {
      ...session.activePauseEvent,
      workflow,
      item,
      timestamp: session.activePauseEvent.startedAt,
    });
    session.logs.unshift(`运行已暂停 · ${reason}`);
  } else if (workflow?.id && !session.activePauseEvent.workflowId) {
    session.activePauseEvent.workflowId = workflow.id;
    session.activePauseEvent.workflowName = workflow.name || "";
    session.activePauseEvent.stepId = item?.id || "";
    session.activePauseEvent.stepName = item?.name || "";
  }
  session.status = "paused";
  syncRunState();
}

function closePauseEvent(session, endedAt, status = "resumed") {
  const finishedAt = endedAt || new Date();
  if (!session?.pauseStartedAt && !session?.activePauseEvent) return 0;
  const startedAt = Number.isFinite(Date.parse(session.pauseStartedAt))
    ? new Date(session.pauseStartedAt)
    : finishedAt;
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  if (session.pauseStartedAt) {
    session.pausedDurationMs = (session.pausedDurationMs || 0) + durationMs;
  }
  if (session.activePauseEvent) {
    session.activePauseEvent.status = status;
    session.activePauseEvent.endedAt = finishedAt.toISOString();
    session.activePauseEvent.durationMs = durationMs;
  }
  session.pauseStartedAt = "";
  session.activePauseEvent = null;
  return durationMs;
}

function resumeSession(session) {
  if (!session) return;
  const endedAt = new Date();
  const pauseEvent = session.activePauseEvent;
  const wasPaused = Boolean(session.status === "paused" || session.pauseStartedAt || session.activePauseEvent);
  const durationMs = closePauseEvent(session, endedAt, "resumed");
  if (pauseEvent) {
    const resumeEvent = {
      workflowId: pauseEvent.workflowId || "",
      workflowName: pauseEvent.workflowName || session.currentWorkflowName || "",
      stepId: pauseEvent.stepId || "",
      stepName: pauseEvent.stepName || "",
      phase: "resume",
      reason: "manual resume",
      delayMs: 0,
      status: "done",
      startedAt: endedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: 0,
    };
    session.queueEvents.push(resumeEvent);
    recordRunEvent(session, "resume", { ...resumeEvent, pauseDurationMs: durationMs });
  } else if (session.pauseRequested) {
    recordRunEvent(session, "pause_cancel", {
      phase: "resume",
      status: "done",
      detail: "pause request was cancelled before a pause gate",
    });
  }
  session.pauseRequested = false;
  session.pauseRequestedAt = "";
  if (!session.cancelRequested && session.status === "paused") {
    session.status = "running";
  }
  session.logs.unshift(wasPaused ? `继续运行 · 暂停 ${durationLabel(durationMs)}` : "暂停请求已撤销");
  syncRunState();
}

function recordRunEvent(session, type, payload = {}) {
  if (!session) return null;
  const workflow = payload.workflow || null;
  const item = payload.item || payload.step || null;
  const timestamp = payload.timestamp || payload.endedAt || payload.startedAt || new Date().toISOString();
  session.runEventSerial = Math.max(0, Number(session.runEventSerial) || 0) + 1;
  const event = {
    order: session.runEventSerial,
    type,
    status: String(payload.status ?? session.status ?? ""),
    phase: String(payload.phase ?? ""),
    mode: session.mode || "",
    hwnd: session.hwnd || "",
    display: session.display || "",
    workflowId: String(payload.workflowId ?? workflow?.id ?? ""),
    workflowName: String(payload.workflowName ?? workflow?.name ?? session.currentWorkflowName ?? ""),
    stepId: String(payload.stepId ?? item?.id ?? payload.fromStepId ?? ""),
    stepName: String(payload.stepName ?? item?.name ?? payload.fromStepName ?? ""),
    stepType: String(payload.stepType ?? item?.type ?? payload.fromStepType ?? ""),
    action: String(payload.action ?? ""),
    detail: String(payload.detail ?? payload.reason ?? ""),
    timestamp,
  };
  const optionalFields = [
    "queueLength",
    "queueItemId",
    "delayMs",
    "durationMs",
    "pauseDurationMs",
    "stepOrder",
    "inputSent",
    "matched",
    "x",
    "y",
    "score",
    "captureProvider",
    "captureReliability",
    "capturedAtMs",
    "frameHash",
    "captureWidth",
    "captureHeight",
    "savedPath",
    "reason",
    "resultStatus",
    "resultAction",
    "toStepId",
    "toStepName",
    "toWorkflowId",
    "toWorkflowName",
    "fromStepId",
    "fromStepName",
    "maxIterations",
    "iterationCount",
    "startedAt",
    "endedAt",
  ];
  for (const field of optionalFields) {
    const value = payload[field];
    if (value !== undefined && value !== null && value !== "") event[field] = value;
  }
  session.runEvents ||= [];
  session.runEvents.push(event);
  if (session.runEvents.length > MAX_SESSION_RUN_EVENTS) {
    session.runEvents.splice(0, session.runEvents.length - MAX_SESSION_RUN_EVENTS);
  }
  return event;
}

async function waitIfPaused(session, workflow = null, context = {}) {
  if (!session || session.cancelRequested) return false;
  if (!session.pauseRequested && session.status !== "paused") return true;
  setSessionPaused(session, "pause gate", { ...context, workflow: context.workflow || workflow });
  renderSessions();
  while (!session.cancelRequested && session.pauseRequested) {
    await sleep(200);
  }
  if (session.cancelRequested) return false;
  if (session.status === "paused") resumeSession(session);
  renderSessions();
  return true;
}

function syncRunActionButtons() {
  const dryRunButton = $("#dry-run-selected");
  const backgroundRunButton = $("#background-run-selected");
  const pauseButton = $("#pause-runs");
  const resumeButton = $("#resume-runs");
  const launchPending = startingSessions().length > 0;
  if (dryRunButton) dryRunButton.disabled = launchPending;
  if (backgroundRunButton) backgroundRunButton.disabled = launchPending;
  if (pauseButton) {
    pauseButton.disabled = !runningSessions().some((session) => !session.cancelRequested && !session.pauseRequested);
  }
  if (resumeButton) {
    resumeButton.disabled = !pausedSessions().some((session) => !session.cancelRequested);
  }
}

function appendRunHistoryRecord(record, reason = "run logged") {
  state.workspace.runHistory = [record, ...(state.workspace.runHistory || []).filter((item) => item?.id !== record?.id)].slice(0, 80);
  markDirty(reason);
}

async function runSession(session, runPlan) {
  try {
    const pendingRunPlan = [...runPlan];
    for (let index = 0; index < pendingRunPlan.length; index += 1) {
      if (!(await waitIfPaused(session))) break;
      const entry = pendingRunPlan[index];
      session.workflowJumpRequest = null;
      const completed = await runWorkflowEntry(session, entry);
      if (!completed) break;
      const jumpRequest = session.workflowJumpRequest;
      session.workflowJumpRequest = null;
      if (jumpRequest?.workflowId) {
        const inserted = insertWorkflowJumpIntoRunPlan(session, pendingRunPlan, index + 1, jumpRequest);
        if (!inserted) break;
      }
    }
    if (session.activePauseEvent || session.pauseStartedAt) {
      closePauseEvent(session, new Date(), session.cancelRequested ? "stopped" : "resumed");
      session.pauseRequested = false;
      session.pauseRequestedAt = "";
    }
    if (session.status !== "failed") {
      session.status = session.cancelRequested ? "stopped" : "done";
      if (session.status === "stopped" && !session.failureReason) session.failureReason = "user requested stop";
    }
    session.endedAt = new Date().toISOString();
    session.durationMs = Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt));
    await attachEndedWindowIdentity(session);
    recordRunEvent(session, "session_end", {
      status: session.status,
      detail: session.failureReason || `${modeLabel(session.mode)} ${session.status}`,
      durationMs: session.durationMs || 0,
      endedAt: session.endedAt,
      timestamp: session.endedAt,
    });
    appendRunHistoryRecord(runHistoryEntryFromSession(session), "run logged");
    renderSessions();
    syncRunState();
    appendLog(
      session.status === "done" ? "info" : "warn",
      `${modeLabel(session.mode)} ${session.status}：${session.display}`,
    );
  } finally {
    if (session.mode === "background") {
      await invokeBackend("complete_session", {
        sessionId: session.id,
        cancelTokenId: session.id,
      }).catch((error) => {
        appendLog("warn", `后端会话清理失败：${session.id} / ${error}`);
      });
    }
  }
}

function insertWorkflowJumpIntoRunPlan(session, runPlan, insertIndex, request) {
  const beforeEvents = session.queueEvents?.length || 0;
  const inserted = insertWorkflowJumpIntoRunPlanCore(session, runPlan, insertIndex, request, {
    workflowById,
    normalizeQueueItem,
    randomId,
    failSession,
    renderSessions,
    maxWorkflowJumps: MAX_WORKFLOW_JUMPS,
  });
  if (inserted) {
    const queueEvent = (session.queueEvents || []).slice(beforeEvents).find((event) => event.phase === "task_jump");
    recordRunEvent(session, "task_jump", {
      ...(queueEvent || {}),
      workflowId: request.fromWorkflowId || "",
      workflowName: request.fromWorkflowName || "",
      stepId: request.fromStepId || "",
      stepName: request.fromStepName || "",
      detail: `inserted workflow ${request.workflowName || request.workflowId}`,
    });
  }
  return inserted;
}

async function runWorkflowEntry(session, entry) {
  const workflow = entry.workflow;
  const queueItem = entry.queueItem;
  if (session.cancelRequested || session.status === "failed") return false;
  session.currentWorkflowName = workflow.name;
  recordRunEvent(session, "workflow_start", {
    workflow,
    queueItemId: queueItem.id,
    status: "running",
    detail: "workflow queue item started",
  });
  if (!(await waitIfPaused(session, workflow))) return false;
  if (queueItem.startDelayMs > 0) {
    const completed = await runQueueDelay(session, workflow, "start", queueItem.startDelayMs);
    if (!completed) return false;
  }
  const steps = workflow.steps.filter((item) => item.enabled !== false);
  const stepIndexById = new Map(steps.map((item, index) => [item.id, index]));
  let pc = 0;
  let previousResult = null;
  let executedSteps = 0;
  while (true) {
  while (pc >= 0 && pc < steps.length) {
    if (session.cancelRequested) return false;
    if (executedSteps >= MAX_CONTROL_FLOW_STEPS) {
      failSession(session, workflow, steps[pc], `${workflow.name} 控制流超过 ${MAX_CONTROL_FLOW_STEPS} 步预算`);
      session.logs.unshift(`${workflow.name} / 控制流预算耗尽，已停止窗口会话`);
      renderSessions();
      return false;
    }
    const item = steps[pc];
    if (isDefaultRecoveryFragmentStep(item) && !session.recoveryContext) {
      pc += 1;
      continue;
    }
    if (!(await waitIfPaused(session, workflow, { item, phase: "before_step" }))) return false;
    const currentPc = pc;
    executedSteps += 1;
    session.currentStep += 1;
    const stepStartedAt = new Date();
    recordRunEvent(session, "step_start", {
      workflow,
      item,
      status: "running",
      phase: "before_step",
      stepOrder: session.currentStep,
      startedAt: stepStartedAt.toISOString(),
      timestamp: stepStartedAt.toISOString(),
    });
    let result = null;
    let stopAfterResult = false;
    const preDelay = await runStepDelay(session, workflow, item, "preDelay");
    if (!preDelay.completed) {
      result = withStepTimingDetail(
        {
          status: "stopped",
          action: "pre_delay",
          detail: "interrupted after stop request during step preDelay",
          inputSent: false,
          matched: false,
        },
        preDelay.elapsedMs,
        0,
      );
      recordSessionStepResult(session, workflow, item, result, stepStartedAt, new Date());
      renderSessions();
      return false;
    }
    if (!(await waitIfPaused(session, workflow, { item, phase: "before_action" }))) return false;
    if (session.mode === "background") {
      const identityIssue = await verifySessionWindowIdentityForStep(session, workflow, item);
      result = identityIssue
        ? {
            status: "error",
            action: "window_identity",
            detail: identityIssue,
            inputSent: false,
            matched: false,
          }
        : await executeBackgroundStepWithRetries(session, item).catch(backendInvokeFailureResult);
      session.logs.unshift(formatStepLog(session.currentStep - 1, workflow, item, result));
      stopAfterResult = shouldStopAfterResult(item, result);
    } else {
      result = {
        status: "observed",
        action: "dry_run",
        detail: "observation run only; no backend screenshot or input was invoked",
        inputSent: false,
        matched: false,
      };
      session.logs.unshift(formatStepLog(session.currentStep - 1, workflow, item, result));
      await cancellableSleep(session, dryRunDelay(item), { workflow, item, phase: "dry_run" });
    }
    const postDelay =
      session.cancelRequested || stopAfterResult
        ? { completed: true, elapsedMs: 0 }
        : await runStepDelay(session, workflow, item, "postDelay");
    if (!postDelay.completed) {
      result = {
        ...result,
        status: "stopped",
        action: "post_delay",
        detail: `${result?.detail || ""}; interrupted after stop request during step postDelay`,
      };
    }
    result = withStepTimingDetail(result, preDelay.elapsedMs, postDelay.elapsedMs);
    recordSessionStepResult(session, workflow, item, result, stepStartedAt, new Date());
    if (session.cancelRequested || result?.status === "stopped") {
      renderSessions();
      return false;
    }
    if (stopAfterResult) {
      const recovery = recoveryDecisionForFailedStep({
        session,
        workflow,
        steps,
        stepIndexById,
        item,
        currentPc,
        result,
      });
      recordControlFlowTransition(session, recovery.transition);
      if (recovery.message) session.logs.unshift(recovery.message);
      renderSessions();
      if (recovery.recovered) {
        previousResult = result;
        pc = recovery.nextPc;
        continue;
      }
      failSession(session, workflow, item, recovery.failureReason || failureReasonFromResult(result));
      renderSessions();
      return false;
    }
    if (shouldCompleteRecoveryAfterStep(session, item, currentPc, steps)) {
      const completion = completeRecoveryWithPolicy(session, steps, currentPc);
      recordControlFlowTransition(session, completion.transition);
      renderSessions();
      if (completion.stopped || session.status === "failed" || session.cancelRequested) return false;
      previousResult = result;
      pc = Number.isInteger(completion.nextPc) ? completion.nextPc : currentPc + 1;
      continue;
    }
    if (session.status === "failed") {
      renderSessions();
      return false;
    }
    const decision = controlFlowDecisionForStep({
      session,
      workflow,
      steps,
      stepIndexById,
      item,
      currentPc,
      result,
      previousResult,
    });
    recordControlFlowTransition(session, decision.transition);
    if (decision.workflowJumpId) {
      session.workflowJumpRequest = {
        workflowId: decision.workflowJumpId,
        workflowName: decision.workflowJumpName || "",
        fromWorkflowId: workflow.id,
        fromWorkflowName: workflow.name,
        fromStepId: item.id,
        fromStepName: item.name || stepLabels[item.type] || item.type,
        maxIterations: decision.maxIterations || 0,
        iterationCount: decision.iterationCount ?? null,
      };
    }
    previousResult = result;
    if (decision.message) session.logs.unshift(decision.message);
    renderSessions();
    if (session.status === "failed" || session.cancelRequested) return false;
    pc = Number.isInteger(decision.nextPc) ? decision.nextPc : currentPc + 1;
  }
  if (session.cancelRequested || session.status === "failed") return false;
  if (session.recoveryContext) {
    const recoveryCompletion = completeRecoveryWithPolicy(session, steps, steps.length - 1);
    recordControlFlowTransition(session, recoveryCompletion.transition);
    renderSessions();
    if (recoveryCompletion.stopped || session.cancelRequested || session.status === "failed") return false;
    if (Number.isInteger(recoveryCompletion.nextPc) && recoveryCompletion.nextPc >= 0 && recoveryCompletion.nextPc < steps.length) {
      previousResult = null;
      pc = recoveryCompletion.nextPc;
      continue;
    }
  }
  break;
  }
  if (queueItem.afterDelayMs > 0) {
    const completed = await runQueueDelay(session, workflow, "after", queueItem.afterDelayMs);
    if (!completed) return false;
  }
  recordRunEvent(session, "workflow_end", {
    workflow,
    queueItemId: queueItem.id,
    status: "done",
    detail: "workflow queue item completed",
  });
  return true;
}

function failSession(session, workflow, item, reason) {
  session.cancelRequested = true;
  session.status = "failed";
  session.failureReason = reason;
  session.failedWorkflowName = workflow?.name || "";
  session.failedStepName = item?.name || stepLabels[item?.type] || item?.type || "";
  recordRunEvent(session, "session_failure", {
    workflow,
    item,
    status: "failed",
    reason,
    detail: reason,
  });
}

function failureReasonFromResult(result) {
  return failureReasonFromResultCore(result);
}

function recoveryDecisionForFailedStep(context) {
  return recoveryDecisionForFailedStepCore(context, {
    backgroundFailureStatuses,
    stepLabels,
  });
}

function completeRecoveryAsFailed(session) {
  completeRecoveryAsFailedCore(session);
}

function completeRecoveryWithPolicy(session, steps, completedIndex) {
  return completeRecoveryWithPolicyCore(session, {
    steps,
    completedIndex,
    stepLabels,
  });
}

function shouldCompleteRecoveryAfterStep(session, item, currentPc, steps) {
  if (!session.recoveryContext) return false;
  if (item?.id === session.recoveryContext.failedStepId) return false;
  return item?.type === "restore" || currentPc >= steps.length - 1;
}

function controlFlowDecisionForStep(context) {
  return controlFlowDecisionForStepCore(context, {
    workflowById,
    stepLabels,
    terminalBackendStatuses,
    backgroundFailureStatuses,
    plannedOnlyStepTypes,
  });
}

function withDefaultRecoveryReferences(steps) {
  const recoveryStep =
    steps.find((item) => isDefaultRecoveryFragmentStep(item) && item.enabled !== false) ||
    steps.find((item) => item.type === "restore" && item.enabled !== false);
  if (!recoveryStep) return steps;
  return steps.map((item) => {
    if (item.id === recoveryStep.id || item.recoveryStepId || item.onFail !== "restore") return item;
    return { ...item, recoveryStepId: recoveryStep.id };
  });
}

function evaluateConditionGuard(item, result, previousResult) {
  return evaluateConditionGuardCore(item, result, previousResult);
}

function compareNumbers(left, operator, right) {
  return compareNumbersCore(left, operator, right);
}

function recordControlFlowTransition(session, transition) {
  recordControlFlowTransitionCore(session, transition, {
    maxControlFlowTransitions: MAX_CONTROL_FLOW_TRANSITIONS,
  });
  if (transition) {
    recordRunEvent(session, "control_flow", {
      ...transition,
      workflowId: transition.workflowId || "",
      workflowName: transition.workflowName || "",
      stepId: transition.fromStepId || "",
      stepName: transition.fromStepName || "",
      stepType: transition.fromStepType || "",
      status: transition.status || "",
      phase: transition.reason || "control_flow",
      reason: transition.reason || "",
      detail: formatHistoryTransition(transition),
      resultStatus: transition.resultStatus || "",
      resultAction: transition.resultAction || "",
    });
  }
}

function isSuccessfulStepResult(result) {
  return isSuccessfulStepResultCore(result, {
    terminalBackendStatuses,
    backgroundFailureStatuses,
  });
}

function stepLabelForExecution(item) {
  return stepLabelForExecutionCore(item, { stepLabels });
}

function recordSessionStepResult(session, workflow, item, result, startedAt, endedAt) {
  const record = {
    order: session.currentStep,
    workflowId: workflow.id,
    workflowName: workflow.name,
    stepId: item.id,
    stepName: item.name || stepLabels[item.type] || item.type,
    stepType: item.type,
    status: result?.status || "unknown",
    action: result?.action || "",
    detail: result?.detail || "",
    inputSent: Boolean(result?.inputSent),
    matched: Boolean(result?.matched),
    x: result?.x ?? null,
    y: result?.y ?? null,
    score: result?.score ?? null,
    ...pickMatchFieldsFromResult(result),
    captureProvider: result?.captureProvider || "",
    captureReliability: result?.captureReliability || "",
    capturedAtMs: result?.capturedAtMs ?? null,
    frameHash: result?.frameHash || "",
    captureWidth: result?.captureWidth ?? null,
    captureHeight: result?.captureHeight ?? null,
    savedPath: result?.savedPath || "",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
  };
  setMatchOverlayFromResult(result);
  session.stepResults.push(record);
  recordRunEvent(session, "step_result", {
    ...record,
    workflow,
    item,
    stepOrder: record.order,
    resultStatus: record.status,
    resultAction: record.action,
    timestamp: record.endedAt,
  });
  if (session.stepResults.length > MAX_SESSION_STEP_RESULTS) {
    session.stepResults.splice(0, session.stepResults.length - MAX_SESSION_STEP_RESULTS);
  }
}

async function runQueueDelay(session, workflow, phase, ms) {
  if (!(await waitIfPaused(session, workflow, { phase }))) return false;
  const label = phase === "start" ? "启动前错峰" : "任务后间隔";
  appendLog("info", `${session.display} / ${workflow.name} ${label} ${durationLabel(ms)}`);
  const startedAt = new Date();
  const completed = await cancellableSleep(session, ms, { workflow, phase });
  const endedAt = new Date();
  const event = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    phase,
    delayMs: ms,
    status: completed ? "done" : "stopped",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
  };
  session.queueEvents.push(event);
  recordRunEvent(session, "queue_event", {
    ...event,
    workflow,
    detail: label,
    timestamp: event.endedAt,
  });
  session.logs.unshift(`${workflow.name} / ${label} ${completed ? "完成" : "已停止"} · ${durationLabel(ms)}`);
  renderSessions();
  return completed;
}

async function runStepDelay(session, workflow, item, key) {
  const ms = stepTimingDelay(item, key);
  if (ms <= 0) return { completed: true, elapsedMs: 0 };
  if (!(await waitIfPaused(session, workflow, { item, phase: key }))) return { completed: false, elapsedMs: 0 };
  const label = key === "preDelay" ? "步骤前等待" : "步骤后等待";
  appendLog("info", `${session.display} / ${workflow.name} / ${item.name} ${label} ${durationLabel(ms)}`);
  const startedAt = Date.now();
  const completed = await cancellableSleep(session, ms, { workflow, item, phase: key });
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  session.logs.unshift(`${workflow.name} / ${item.name} / ${label} ${completed ? "完成" : "已停止"} · ${durationLabel(ms)}`);
  renderSessions();
  return { completed, elapsedMs: completed ? ms : elapsedMs };
}

function stepTimingDelay(item, key) {
  const legacy = projectedLegacyStep(item);
  return Math.max(0, commandDurationMs(legacy.command, key) ?? 0);
}

function withStepTimingDetail(result, preDelayMs, postDelayMs) {
  if (!preDelayMs && !postDelayMs) return result;
  return {
    ...result,
    detail: `${result?.detail || ""}; timing preDelay=${preDelayMs}ms postDelay=${postDelayMs}ms`,
  };
}

async function attachEndedWindowIdentity(session) {
  try {
    const current = await invokeBackend("current_window_identity", { hwnd: Number(session.hwnd) });
    session.endedWindowIdentity = windowIdentityForTarget(current);
    session.endedWindowIdentityError = "";
  } catch (error) {
    session.endedWindowIdentity = null;
    session.endedWindowIdentityError = String(error);
  }
}

function runHistoryEntryFromSession(session) {
  return {
    id: session.id,
    mode: session.mode,
    source: session.source,
    hwnd: session.hwnd,
    display: session.display,
    workflowId: session.workflowId,
    workflowName: session.workflowName,
    workflowIds: session.workflowIds,
    workflowNames: session.workflowNames,
    queueLength: session.workflowIds.length,
    status: session.status,
    totalSteps: session.totalSteps,
    completedSteps: session.currentStep,
    durationMs: session.durationMs || 0,
    pauseCount: session.pauseCount || 0,
    pausedDurationMs: session.pausedDurationMs || 0,
    failureReason: session.failureReason || "",
    failedWorkflowName: session.failedWorkflowName || "",
    failedStepName: session.failedStepName || "",
    windowIdentity: session.windowIdentity,
    endedWindowIdentity: session.endedWindowIdentity,
    endedWindowIdentityError: session.endedWindowIdentityError || "",
    queuePlan: session.queuePlan || [],
    queueEvents: session.queueEvents || [],
    pauseEvents: (session.queueEvents || []).filter((event) => event.phase === "pause" || event.phase === "resume"),
    runEvents: (session.runEvents || []).slice(-MAX_SESSION_RUN_EVENTS),
    controlFlowTransitions: (session.controlFlowTransitions || []).slice(-MAX_CONTROL_FLOW_TRANSITIONS),
    stepResults: session.stepResults.slice(-MAX_SESSION_STEP_RESULTS),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}

async function executeBackgroundStepWithRetries(session, item) {
  const retries = Math.max(0, Math.floor(Number.isFinite(Number(item.retry)) ? Number(item.retry) : 0));
  const attempts = retries + 1;
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!(await waitIfPaused(session, null, { item, phase: "retry_attempt" }))) {
      return {
        status: "stopped",
        action: "retry_wait",
        detail: "stopped while paused before retry attempt",
        inputSent: false,
        matched: false,
      };
    }
    result = await executeBackgroundStep(session, item);
    if (attempts > 1) {
      result = {
        ...result,
        detail: `${result.detail} (attempt ${attempt}/${attempts})`,
      };
    }
    if (!shouldRetryBackgroundStep(item, result) || attempt === attempts) return result;
    const completed = await cancellableSleep(session, backgroundRetryDelay(item), { item, phase: "retry_wait" });
    if (!completed) {
      return {
        ...result,
        status: "stopped",
        action: "retry_wait",
        detail: `${result.detail}; stopped during retry wait`,
      };
    }
  }
  return result;
}

async function executeBackgroundStep(session, item) {
  if (item.type === "delay") {
    const ms = backgroundStepDelay(item);
    const completed = await cancellableSleep(session, ms, { item, phase: "delay" });
    return {
      status: completed ? "ok" : "stopped",
      action: "delay",
      detail: completed ? `waited ${ms}ms` : `interrupted after stop request during ${ms}ms delay`,
      inputSent: false,
      matched: false,
    };
  }
  if (item.type === "task_jump") {
    return {
      status: "ok",
      action: "task_jump",
      detail: `same-window queue jump requested: ${workflowNameById(item.jumpWorkflowId) || item.jumpWorkflowId || "missing target"}`,
      inputSent: false,
      matched: false,
    };
  }
  if (item.type === "loop") {
    return {
      status: "ok",
      action: "loop",
      detail: `bounded loop requested: ${item.targetStepId || "missing target"}; maxIterations=${item.maxIterations || 0}`,
      inputSent: false,
      matched: false,
    };
  }
  if (item.type === "retry_until") {
    return executeRetryUntilStep(session, item);
  }
  return executeBackendStep(session, item);
}

async function executeRetryUntilStep(session, item) {
  if (!retryUntilHasVisualTarget(item)) {
    const result = await executeBackendStep(session, item);
    return {
      ...result,
      status: "missing_asset",
      action: "retry_until",
      detail: `${result.detail || ""}; no image, ROI, or point target is bound, so retry_until cannot verify readiness`,
      inputSent: false,
      matched: false,
    };
  }
  const timeoutMs = Math.max(0, Number(item.timeoutMs) || 0);
  const intervalMs = backgroundRetryDelay(item);
  const startedAt = Date.now();
  const pausedAtStart = session.pausedDurationMs || 0;
  const probe = { ...item, type: "wait_image" };
  let attempt = 0;
  let result = null;
  do {
    attempt += 1;
    if (!(await waitIfPaused(session, null, { item, phase: "retry_until_probe" }))) {
      return {
        ...(result || {}),
        status: "stopped",
        action: "retry_until",
        detail: "stopped while paused before retry_until probe",
        inputSent: false,
        matched: false,
      };
    }
    result = await executeBackendStep(session, probe);
    if (result.matched || result.status === "matched" || result.status === "sent") {
      return {
        ...result,
        status: "ok",
        action: "retry_until",
        detail: `${result.detail} (ready after ${attempt} attempt${attempt === 1 ? "" : "s"})`,
      };
    }
    if (["missing_template", "search_budget_exceeded", "missing_asset"].includes(result.status)) {
      return {
        ...result,
        action: "retry_until",
        matched: false,
        inputSent: false,
      };
    }
    if (!["below_threshold", "planned"].includes(result.status)) return result;
    const remainingTimeoutMs = Math.max(0, timeoutMs - activeElapsedMs(session, startedAt, pausedAtStart));
    if (remainingTimeoutMs <= 0) break;
    const completed = await cancellableSleep(session, Math.min(intervalMs, remainingTimeoutMs), {
      item,
      phase: "retry_until_wait",
    });
    if (!completed) return {
      ...(result || {}),
      status: "stopped",
      action: "retry_until",
      detail: `interrupted after stop request during retry_until wait; ${result?.detail || ""}`.trim(),
      inputSent: false,
      matched: false,
    };
  } while (timeoutMs > 0);
  return {
    ...(result || {}),
    status: "below_threshold",
    action: "retry_until",
    detail: `retry_until timeout after ${timeoutMs}ms${result?.detail ? `; ${result.detail}` : ""}`,
    inputSent: false,
    matched: false,
  };
}

function activeElapsedMs(session, startedAt, pausedAtStart = 0) {
  const pausedDuringSpan = Math.max(0, (session?.pausedDurationMs || 0) - pausedAtStart);
  return Math.max(0, Date.now() - startedAt - pausedDuringSpan);
}

function retryUntilHasVisualTarget(item) {
  const legacy = projectedLegacyStep(item);
  const targetItem = targetForStep(legacy);
  return Boolean(targetItem?.dataUrl || targetItem?.roi || parsePointText(legacy.target) || parsePointText(legacy.command));
}

function shouldRetryBackgroundStep(item, result) {
  if (result.status === "cancelled") return false;
  if (["missing_template", "search_budget_exceeded", "missing_asset"].includes(result.status)) {
    return false;
  }
  if (["timeout", "ocr_queue_full"].includes(result.status)) {
    return item.onFail === "retry" || item.type === "ocr_assert";
  }
  if (!["below_threshold", "text_miss", "ocr_unavailable"].includes(result.status)) return false;
  return item.onFail === "retry" || ["wait_image", "detect_page", "image_click", "double_click", "ocr_assert"].includes(item.type);
}

function backendInvokeFailureResult(error) {
  const detail = String(error);
  const normalized = detail.toLowerCase();
  const status = normalized.includes("cancelled") || normalized.includes("was cancelled")
    ? "cancelled"
    : normalized.includes("deadline") || normalized.includes("timed out")
      ? "timeout"
      : normalized.includes("search_budget_exceeded")
        ? "search_budget_exceeded"
        : normalized.includes("manual_confirmation_")
          ? "manual_confirmation_required"
        : normalized.includes("missing_template")
          ? "missing_template"
          : "error";
  return {
    status,
    action: "backend",
    detail,
    inputSent: false,
    matched: false,
  };
}

function backgroundRetryDelay(item) {
  const legacy = projectedLegacyStep(item);
  return Math.max(50, durationMsFromText(commandValue(legacy.command, "interval")) ?? 300);
}

function backgroundStepDelay(item) {
  const legacy = projectedLegacyStep(item);
  return Math.max(0, durationMsFromText(legacy.target) ?? legacy.timeoutMs ?? 0);
}

async function executeBackendStep(session, item) {
  const payload = backendStepPayload(item);
  return invokeBackend("execute_workflow_step", {
    hwnd: Number(session.hwnd),
    step: payload,
    expectedWindow: session.windowIdentity || null,
    execution: {
      sessionId: session.id,
      stepId: item.id || `${session.id}-step-${session.currentStep}`,
      deadlineMs: Math.max(1, Number(item.timeoutMs) || 1000),
      cancelTokenId: session.id,
    },
  });
}

function windowIdentityForTarget(target) {
  return {
    hwnd: Number(target.hwnd) || 0,
    title: target.title || "",
    processId: Number(target.processId) || 0,
    processName: target.processName || "",
    clientWidth: Number(target.clientWidth) || 0,
    clientHeight: Number(target.clientHeight) || 0,
    elevated: typeof target.elevated === "boolean" ? target.elevated : null,
  };
}

async function currentWindowIdentityForRun(target, mode) {
  const expected = windowIdentityForTarget(target);
  const expectedIssue = requiredBackgroundWindowIdentityIssue(expected);
  if (expectedIssue) {
    appendLog("warn", `${target.display} 窗口身份不完整：${expectedIssue}；请刷新窗口列表后再运行`);
    return null;
  }
  if (mode !== "background") return expected;
  let current = null;
  try {
    current = normalizeWindowIdentity(
      await invokeBackend("current_window_identity", {
        hwnd: Number(target.hwnd),
      }),
    );
  } catch (error) {
    appendLog("warn", `${target.display} 后端窗口身份复核失败：${error}`);
    return null;
  }
  const currentIssue = requiredBackgroundWindowIdentityIssue(current);
  if (currentIssue) {
    appendLog("warn", `${target.display} 后端窗口身份不完整：${currentIssue}；请刷新窗口列表后再运行`);
    return null;
  }
  const mismatch = windowIdentityMismatchReason(expected, current);
  if (mismatch) {
    appendLog("warn", `${target.display} 后端窗口身份已变化：${mismatch}；请刷新窗口列表后再运行`);
    return null;
  }
  return current;
}

async function verifySessionWindowIdentityForStep(session, workflow, item) {
  if (!session?.windowIdentity?.hwnd) return "缺少启动窗口身份快照";
  let current = null;
  try {
    current = normalizeWindowIdentity(
      await invokeBackend("current_window_identity", {
        hwnd: Number(session.hwnd),
      }),
    );
  } catch (error) {
    return `${workflow?.name || "任务"} / ${item?.name || "步骤"} 执行前窗口身份复核失败：${error}`;
  }
  const currentIssue = requiredBackgroundWindowIdentityIssue(current);
  if (currentIssue) {
    return `${workflow?.name || "任务"} / ${item?.name || "步骤"} 执行前窗口身份不完整：${currentIssue}`;
  }
  const mismatch = windowIdentityMismatchReason(session.windowIdentity, current);
  return mismatch ? `${workflow?.name || "任务"} / ${item?.name || "步骤"} 执行前窗口身份已变化：${mismatch}` : "";
}

function requiredBackgroundWindowIdentityIssue(identity) {
  const value = normalizeWindowIdentity(identity);
  if (!value.hwnd) return "缺少 hwnd";
  if (!value.title) return "缺少窗口标题";
  if (!value.processId) return "缺少进程 PID";
  if (!value.processName) return "缺少进程名";
  if (!value.clientWidth || !value.clientHeight) return "缺少客户区尺寸";
  if (typeof value.elevated !== "boolean") return "缺少权限状态";
  return "";
}

function windowIdentityMismatchReason(expected, actual) {
  const left = normalizeWindowIdentity(expected);
  const right = normalizeWindowIdentity(actual);
  if (left.hwnd && right.hwnd && left.hwnd !== right.hwnd) return `hwnd ${left.hwnd} -> ${right.hwnd}`;
  if (left.title && right.title && left.title !== right.title) return `title ${left.title} -> ${right.title}`;
  if (left.processId && right.processId && left.processId !== right.processId) return `pid ${left.processId} -> ${right.processId}`;
  if (left.processName && right.processName && left.processName.toLowerCase() !== right.processName.toLowerCase()) {
    return `process ${left.processName} -> ${right.processName}`;
  }
  if (left.clientWidth && right.clientWidth && Math.abs(left.clientWidth - right.clientWidth) > WINDOW_CLIENT_SIZE_TOLERANCE) {
    return `clientWidth ${left.clientWidth} -> ${right.clientWidth}`;
  }
  if (left.clientHeight && right.clientHeight && Math.abs(left.clientHeight - right.clientHeight) > WINDOW_CLIENT_SIZE_TOLERANCE) {
    return `clientHeight ${left.clientHeight} -> ${right.clientHeight}`;
  }
  if (typeof left.elevated === "boolean" && typeof right.elevated === "boolean" && left.elevated !== right.elevated) {
    return `elevated ${left.elevated} -> ${right.elevated}`;
  }
  return "";
}

function backendStepPayload(item) {
  const legacy = projectedLegacyStep(item);
  const targetItem = targetForStep(legacy);
  const targetId = stepTargetId(legacy);
  const manualConfirmation = manualConfirmationStatusForStep(legacy, targetItem);
  const command = effectiveCommandForStep(legacy, targetItem);
  const payload = {
    type: legacy.type,
    target: legacy.target || "",
    command,
    expect: legacy.expect || "",
    targetId,
    targetKind: targetItem?.kind || "",
    targetDataUrl: targetItem?.dataUrl || "",
    assetId: targetId,
    assetKind: targetItem?.kind || "",
    assetDataUrl: targetItem?.dataUrl || "",
    roi: targetItem?.roi || null,
    requiresManualConfirmation: manualConfirmation.required,
    targetBindingFingerprint: manualConfirmation.required ? manualConfirmation.fingerprint : "",
    manualConfirmation: manualConfirmation.valid ? manualConfirmation.confirmation : null,
  };
  if (legacy.type === "ocr_assert") {
    payload.targetTexts = ocrExpectedTextsForStep(legacy, targetItem);
    payload.ocrLanguage = ocrLanguageForStep(legacy);
    payload.ocrRegion = ocrRegionForStep(legacy);
  }
  return payload;
}

function effectiveCommandForStep(item, targetItem = null) {
  const legacy = projectedLegacyStep(item);
  const resolvedTarget = targetItem || targetForStep(legacy);
  if (!resolvedTarget) return legacy.command || "";
  const defaults = targetCommandDefaults(resolvedTarget, legacy.command);
  if (["image_click", "double_click", "wait_image", "detect_page"].includes(legacy.type)) {
    return commandWithMissingValues(legacy.command, defaults);
  }
  if (["click", "double_click"].includes(legacy.type)) {
    return commandWithMissingValues(legacy.command, {
      button: defaults.button,
      mode: "hwnd-message",
    });
  }
  return legacy.command || "";
}

function formatStepLog(index, workflow, item, result) {
  const point = result.x != null && result.y != null ? ` @${result.x},${result.y}` : "";
  const score = result.score != null ? ` score=${Number(result.score).toFixed(3)}` : "";
  const sent = result.inputSent ? " sent" : "";
  return `${String(index + 1).padStart(2, "0")} ${workflow.name} / ${item.name} [${item.type}] ${result.status}/${result.action}${point}${score}${sent} · ${result.detail}`;
}

function shouldStopAfterResult(item, result) {
  const status = result?.status || "unknown";
  if (terminalBackendStatuses.has(status)) return true;
  if (backgroundFailureStatuses.has(status)) return (item.onFail || "stop") !== "skip";
  return false;
}

function modeLabel(mode) {
  if (mode === "live_validation") return "Live 验收";
  return mode === "background" ? "后台运行" : "观察运行";
}

function dryRunDelay(item) {
  if (item.type === "delay") return Math.max(120, Math.min(480, durationMsFromText(item.target) ?? item.timeoutMs ?? 200));
  return Math.max(90, Math.min(260, Math.round((item.timeoutMs || 1000) / 24)));
}

function stopDryRun() {
  let count = 0;
  for (const session of Object.values(state.sessions)) {
    if (isActiveSession(session)) {
      const pauseEvent = session.activePauseEvent;
      if (session.status === "paused" || session.pauseRequested) {
        const endedAt = new Date();
        closePauseEvent(session, endedAt, "stopped");
        if (pauseEvent) {
          const resumeEvent = {
            workflowId: pauseEvent.workflowId || "",
            workflowName: pauseEvent.workflowName || session.currentWorkflowName || "",
            stepId: pauseEvent.stepId || "",
            stepName: pauseEvent.stepName || "",
            phase: "resume",
            reason: "stop while paused",
            delayMs: 0,
            status: "stopped",
            startedAt: endedAt.toISOString(),
            endedAt: endedAt.toISOString(),
            durationMs: 0,
          };
          session.queueEvents.push(resumeEvent);
          recordRunEvent(session, "resume", { ...resumeEvent, detail: "stop while paused" });
        }
      }
      recordRunEvent(session, "stop_request", {
        status: session.status === "paused" ? "paused" : "running",
        detail: "user requested stop",
      });
      session.cancelRequested = true;
      session.pauseRequested = false;
      if (session.mode === "background") {
        void invokeBackend("cancel_session", {
          sessionId: session.id,
          cancelTokenId: session.id,
        }).catch((error) => {
          appendLog("warn", `后端取消请求失败：${session.id} / ${error}`);
        });
      }
      count += 1;
    }
  }
  appendLog("warn", `已请求停止 ${count} 个运行会话`);
  renderSessions();
}

function renderSessions() {
  const lanes = $("#session-lanes");
  lanes.replaceChildren();
  const sessions = Object.values(state.sessions);
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "暂无运行会话";
    lanes.append(empty);
  }
  for (const session of sessions) {
    const lane = document.createElement("div");
    lane.className = `session-lane ${session.status}`;
    const pauseText = session.pauseCount ? ` · 暂停 ${session.pauseCount} 次` : "";
    lane.innerHTML = `
      <div>
        <strong>${escapeHtml(session.display)}</strong>
        <span>${escapeHtml(modeLabel(session.mode))} · ${escapeHtml(session.workflowName)} · ${session.currentStep}/${session.totalSteps}</span>
      </div>
      <progress max="${session.totalSteps}" value="${session.currentStep}"></progress>
      <small>${escapeHtml(session.status)} · ${escapeHtml(session.currentWorkflowName || "等待")} · hwnd=${escapeHtml(session.hwnd)}${escapeHtml(pauseText)}</small>
    `;
    if (session.logs.length) {
      const latest = document.createElement("small");
      latest.textContent = session.logs[0];
      lane.append(latest);
    }
    lanes.append(lane);
  }
  renderRunHistory(lanes);
  renderFailureReports();
  syncRunActionButtons();
  renderOpsDashboard();
}

function historyTransitionSummary(record) {
  const transitions = Array.isArray(record.controlFlowTransitions)
    ? record.controlFlowTransitions.slice(-3).map(formatHistoryTransition)
    : [];
  const taskJumpEvents = Array.isArray(record.queueEvents)
    ? record.queueEvents.filter((event) => event.phase === "task_jump").slice(-2).map(formatHistoryTaskJumpEvent)
    : [];
  const pauseEvents = Array.isArray(record.pauseEvents)
    ? record.pauseEvents.slice(-2).map(formatHistoryPauseEvent)
    : [];
  return [...transitions, ...taskJumpEvents, ...pauseEvents].filter(Boolean);
}

function formatHistoryTransition(transition) {
  if (!transition) return "";
  const status = transition.status || "unknown";
  const reason = transition.reason || "control";
  const from = transition.fromStepName || transition.fromStepId || "未知步骤";
  const target = transition.workflowJump
    ? transition.toWorkflowName || transition.requestedToWorkflowId || "未知任务"
    : transition.toStepName || transition.requestedToStepId || transition.defaultNextStepId || "顺序下一步";
  const skipped = transition.skippedReason ? ` · ${transition.skippedReason}` : "";
  const recovery = transition.recovery ? " · recovery" : "";
  const loop =
    transition.maxIterations || transition.iterationCount != null
      ? ` · ${transition.iterationCount ?? 0}/${transition.maxIterations || "∞"}`
      : "";
  return `${reason} ${status}: ${from} -> ${target}${recovery}${loop}${skipped}`;
}

function formatHistoryTaskJumpEvent(event) {
  const from = event.fromStepName || event.workflowName || "任务跳转";
  const to = event.toWorkflowName || event.toWorkflowId || "未知任务";
  const loop =
    event.maxIterations || event.iterationCount != null ? ` · ${event.iterationCount ?? 0}/${event.maxIterations || "∞"}` : "";
  return `queue task_jump ${event.status || "queued"}: ${from} -> ${to}${loop}`;
}

function formatHistoryPauseEvent(event) {
  if (event.phase === "pause") {
    const where = event.stepName || event.workflowName || "运行会话";
    return `pause ${event.status || "paused"}: ${where} · ${durationLabel(event.durationMs || 0)}`;
  }
  if (event.phase === "resume") {
    const where = event.stepName || event.workflowName || "运行会话";
    return `resume ${event.status || "done"}: ${where}`;
  }
  return "";
}

function renderRunHistory(container) {
  const records = state.workspace.runHistory.slice(0, 5);
  if (!records.length) return;
  const header = document.createElement("div");
  header.className = "run-history-title";
  header.textContent = "最近运行报告";
  container.append(header);
  for (const record of records) {
    const lane = document.createElement("div");
    const status = record.status || "unknown";
    const lastStep = Array.isArray(record.stepResults) ? record.stepResults.at(-1) : null;
    const transitionCount = Array.isArray(record.controlFlowTransitions) ? record.controlFlowTransitions.length : 0;
    const eventCount = Array.isArray(record.runEvents) ? record.runEvents.length : 0;
    const pauseText = record.pauseCount ? ` · 暂停 ${record.pauseCount} 次/${durationLabel(record.pausedDurationMs || 0)}` : "";
    const failed = record.failedStepName || (status === "failed" ? lastStep?.stepName : "");
    lane.className = `session-lane history ${status}`;
    lane.innerHTML = `
      <div>
        <strong>${escapeHtml(record.display || record.hwnd)}</strong>
        <span>${escapeHtml(modeLabel(record.mode))} · ${escapeHtml(record.workflowName || `${record.queueLength || 0} 个任务`)} · ${escapeHtml(status)}</span>
      </div>
      <small>${escapeHtml(record.completedSteps ?? record.stepResults?.length ?? 0)}/${escapeHtml(record.totalSteps || 0)} 步 · 事件 ${escapeHtml(eventCount)} · 控制流 ${escapeHtml(transitionCount)} · ${escapeHtml(durationLabel(record.durationMs))}${escapeHtml(pauseText)} · ${escapeHtml(record.endedAt || "")}</small>
      <small>${escapeHtml(failed ? `失败点：${failed}` : lastStep ? `末步：${lastStep.stepName} ${lastStep.status}/${lastStep.action}` : "无步骤明细")}</small>
    `;
    if (record.failureReason) {
      const reason = document.createElement("small");
      reason.textContent = record.failureReason;
      lane.append(reason);
    }
    const liveLine = liveValidationHistoryLine(record);
    if (liveLine) {
      const live = document.createElement("small");
      live.className = "history-detail";
      live.textContent = liveLine;
      lane.append(live);
    }
    if (record.endedWindowIdentityError) {
      const identity = document.createElement("small");
      identity.textContent = `结束窗口身份读取失败：${record.endedWindowIdentityError}`;
      lane.append(identity);
    }
    const transitionSummary = historyTransitionSummary(record);
    if (transitionSummary.length) {
      const detail = document.createElement("small");
      detail.className = "history-detail";
      detail.textContent = transitionSummary.join(" / ");
      lane.append(detail);
    }
    container.append(lane);
  }
}

function liveValidationHistoryLine(record) {
  const live = record?.liveValidation;
  if (!live) return "";
  const evidence = Array.isArray(record.externalEvidence) ? record.externalEvidence.find((item) => item.kind === "live-json") : null;
  return [
    `live=${live.status || "unknown"}`,
    `admin=${Boolean(live.admin)}`,
    `allowInput=${Boolean(live.allowInput)}`,
    live.git?.head ? `git=${live.git.head}` : "",
    evidence?.path ? `report=${evidence.path}` : "",
  ].filter(Boolean).join(" · ");
}

function renderFailureReports() {
  const board = $("#failure-report-board");
  if (!board) return;
  board.replaceChildren();
  const reports = failureReportRecords();
  const head = document.createElement("div");
  head.className = "failure-report-head";
  head.innerHTML = `
    <strong>失败报告</strong>
    <span>${reports.length ? `最近 ${reports.length} 条` : "暂无失败"}</span>
  `;
  board.append(head);
  if (!reports.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "后台运行失败、停止或窗口身份异常后，会在这里显示可定位的报告。";
    board.append(empty);
    return;
  }
  for (const report of reports) {
    const failedStep = failureStepFromRecord(report);
    const canFocusFailedStep = Boolean(failedStep?.workflowId && failedStep?.stepId);
    const identity = failureIdentitySummary(report);
    const steps = failureStepTrail(report);
    const transitions = historyTransitionSummary(report).slice(0, 2);
    const expanded = state.expandedFailureReportIds.has(report.id);
    const article = document.createElement("article");
    article.className = `failure-report ${report.status || "unknown"}${expanded ? " expanded" : ""}`;
    article.innerHTML = `
      <div class="failure-report-title">
        <span>
          <strong>${escapeHtml(report.display || report.hwnd || "未知窗口")}</strong>
          <small>${escapeHtml(report.workflowName || `${report.queueLength || 0} 个任务`)} · ${escapeHtml(report.status || "unknown")} · ${escapeHtml(report.endedAt || "")}</small>
        </span>
        <em class="readiness-pill ${failureReportLevel(report)}">${escapeHtml(report.status || "report")}</em>
      </div>
      <p title="${escapeHtml(report.failureReason || "无失败原因")}">${escapeHtml(failureReasonSummary(report))}</p>
      <small>${escapeHtml(failedStep ? `失败点：${failedStep.workflowName || report.failedWorkflowName || ""} / ${failedStep.stepName}` : "失败点：未记录步骤")}</small>
      <small>${escapeHtml(identity)}</small>
      ${steps.length ? `<ol>${steps.map((item) => `<li title="${escapeHtml(item)}">${escapeHtml(item)}</li>`).join("")}</ol>` : ""}
      ${transitions.length ? `<small class="history-detail">${escapeHtml(transitions.join(" / "))}</small>` : ""}
      ${expanded ? failureReportDetailHtml(report, failedStep, identity) : ""}
      <div class="failure-report-actions">
        <button type="button" data-report-action="focus" data-report-id="${escapeHtml(report.id)}"${canFocusFailedStep ? "" : " disabled"}>定位步骤</button>
        <button type="button" data-report-action="copy" data-report-id="${escapeHtml(report.id)}">复制报告</button>
        <button type="button" data-report-action="evidence" data-report-id="${escapeHtml(report.id)}">复制证据包</button>
        <button type="button" data-report-action="toggle" data-report-id="${escapeHtml(report.id)}">${expanded ? "收起详情" : "展开详情"}</button>
      </div>
    `;
    board.append(article);
  }
}

function failureReportRecords() {
  return (state.workspace.runHistory || [])
    .filter((record) => {
      const status = record.status || "";
      return status === "failed" || status === "stopped" || Boolean(record.failureReason) || Boolean(record.endedWindowIdentityError);
    })
    .slice(0, 6);
}

function failureReportLevel(record) {
  if (record.status === "failed" || record.failureReason) return "blocked";
  if (record.status === "stopped" || record.endedWindowIdentityError) return "warning";
  return "ready";
}

function failureReasonSummary(record) {
  if (record.failureReason) return record.failureReason;
  if (record.endedWindowIdentityError) return `结束窗口身份读取失败：${record.endedWindowIdentityError}`;
  return "运行停止，未记录失败原因";
}

function failureStepFromRecord(record) {
  return failureStepFromReportCore(record);
}

function failureIdentitySummary(record) {
  const start = record.windowIdentity;
  const end = record.endedWindowIdentity;
  const startText = compactWindowIdentity(start);
  const endText = compactWindowIdentity(end);
  if (record.endedWindowIdentityError) return `窗口身份：启动 ${startText} / 结束读取失败`;
  if (!startText && !endText) return "窗口身份：未记录";
  if (startText === endText || !endText) return `窗口身份：${startText || endText}`;
  return `窗口身份：启动 ${startText} / 结束 ${endText}`;
}

function compactWindowIdentity(identity) {
  if (!identity) return "";
  const process = identity.processName || identity.processId || "unknown";
  const size = identity.clientWidth && identity.clientHeight ? `${identity.clientWidth}x${identity.clientHeight}` : "";
  const admin = identity.elevated === true ? "admin" : identity.elevated === false ? "user" : "";
  return [process, size, admin].filter(Boolean).join(" · ");
}

function failureStepTrail(record) {
  const steps = Array.isArray(record.stepResults) ? record.stepResults : [];
  return steps.slice(-4).map((item) => {
    const score = item.score == null ? "" : ` · score=${Number(item.score).toFixed(3)}`;
    return `${item.order || "-"} ${item.stepName || item.stepType || "步骤"} · ${item.status || "unknown"}/${item.action || "-"}${score}`;
  });
}

function failureReportDetailHtml(report, failedStep, identity) {
  const reason = failureReasonSummary(report);
  const queuePlan = Array.isArray(report.queuePlan) ? report.queuePlan : [];
  const queueEvents = Array.isArray(report.queueEvents) ? report.queueEvents : [];
  const runEvents = Array.isArray(report.runEvents) ? report.runEvents : [];
  const transitions = Array.isArray(report.controlFlowTransitions) ? report.controlFlowTransitions : [];
  const pauseEvents = Array.isArray(report.pauseEvents) ? report.pauseEvents : [];
  const steps = Array.isArray(report.stepResults) ? report.stepResults : [];
  const groups = [
    failureDetailGroupHtml("原因", [reason, failedStep ? `失败点：${failedStep.workflowName || report.failedWorkflowName || ""} / ${failedStep.stepName}` : "失败点：未记录步骤"]),
    failureDetailGroupHtml("窗口", [
      identity,
      `hwnd=${report.hwnd || "-"} · mode=${modeLabel(report.mode)} · source=${report.source || "-"}`,
    ]),
    failureDetailGroupHtml("队列", queuePlan.slice(0, 6).map(formatFailureQueuePlan)),
    failureDetailGroupHtml("队列事件", queueEvents.slice(-6).map(formatFailureQueueEvent)),
    failureDetailGroupHtml("运行事件", runEvents.slice(-8).map(formatFailureRunEvent)),
    failureDetailGroupHtml("控制流", transitions.slice(-6).map(formatHistoryTransition)),
    failureDetailGroupHtml("暂停", pauseEvents.slice(-6).map(formatHistoryPauseEvent)),
    failureDetailGroupHtml("Live 验收", liveValidationDetailItems(report)),
    failureDetailGroupHtml("最近步骤", steps.slice(-8).map(formatFailureStepResult)),
  ].filter(Boolean);
  return `<div class="failure-report-detail" aria-label="失败报告详情">${groups.join("")}</div>`;
}

function liveValidationDetailItems(report) {
  const live = report?.liveValidation;
  if (!live) return [];
  const evidence = Array.isArray(report.externalEvidence) ? report.externalEvidence : [];
  const git = live.git || {};
  return [
    `状态：${live.status || "unknown"} · admin=${Boolean(live.admin)} · allowInput=${Boolean(live.allowInput)} · requireExecuted=${Boolean(live.requireExecuted)}`,
    git.head ? `Git：${git.branch || "-"} @ ${git.head}${git.statusShort ? " · 生成时有未提交改动" : ""}` : "",
    `进程快照：${live.processSnapshotStatus || "-"} · ${live.processSnapshotCount || 0} 个相关进程`,
    ...evidence.map((item) => `${item.kind}: ${item.path}`),
  ].filter(Boolean);
}

function failureDetailGroupHtml(title, items) {
  const values = (items || []).filter(Boolean);
  if (!values.length) return "";
  return `
    <section>
      <strong>${escapeHtml(title)}</strong>
      <ul>${values.map((item) => `<li title="${escapeHtml(item)}">${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
  `;
}

function formatFailureQueuePlan(item) {
  if (!item) return "";
  const waits = [
    item.startDelayMs ? `start ${durationLabel(item.startDelayMs)}` : "",
    item.afterDelayMs ? `after ${durationLabel(item.afterDelayMs)}` : "",
  ].filter(Boolean);
  return `${item.order || "-"} ${item.workflowName || item.workflowId || "任务"}${waits.length ? ` · ${waits.join(" / ")}` : ""}`;
}

function formatFailureQueueEvent(event) {
  if (!event) return "";
  const where = event.stepName || event.workflowName || event.workflowId || "队列";
  const duration = event.durationMs != null ? ` · ${durationLabel(event.durationMs)}` : "";
  const delay = event.delayMs ? ` · delay=${durationLabel(event.delayMs)}` : "";
  return `${event.phase || "event"} ${event.status || "unknown"}: ${where}${delay}${duration}`;
}

function formatFailureRunEvent(event) {
  if (!event) return "";
  const where = event.stepName || event.workflowName || event.display || "运行会话";
  const phase = event.phase ? `/${event.phase}` : "";
  const detail = event.detail ? ` · ${event.detail}` : "";
  const duration = event.durationMs != null ? ` · ${durationLabel(event.durationMs)}` : "";
  return `${event.order || "-"} ${event.type || "event"}${phase} ${event.status || "unknown"}: ${where}${duration}${detail}`;
}

function formatFailureStepResult(item) {
  if (!item) return "";
  const score = item.score == null ? "" : ` · score=${Number(item.score).toFixed(3)}`;
  const point = item.x == null || item.y == null ? "" : ` · (${item.x},${item.y})`;
  const input = item.inputSent ? " · input" : "";
  const detail = item.detail ? ` · ${item.detail}` : "";
  return `${item.order || "-"} ${item.workflowName || ""} / ${item.stepName || item.stepType || "步骤"} · ${item.status || "unknown"}/${item.action || "-"}${score}${point}${input}${detail}`;
}

function handleFailureReportAction(event) {
  const button = event.target.closest("[data-report-action]");
  if (!button) return;
  const report = (state.workspace.runHistory || []).find((item) => item.id === button.dataset.reportId);
  if (!report) return;
  if (button.dataset.reportAction === "toggle") {
    toggleFailureReportDetail(report.id);
    return;
  }
  if (button.dataset.reportAction === "copy") {
    copyFailureReport(report);
    return;
  }
  if (button.dataset.reportAction === "evidence") {
    copyFailureEvidenceBundle(report);
    return;
  }
  if (button.dataset.reportAction === "focus") {
    focusFailureReportStep(report);
  }
}

function toggleFailureReportDetail(reportId) {
  if (state.expandedFailureReportIds.has(reportId)) {
    state.expandedFailureReportIds.delete(reportId);
  } else {
    state.expandedFailureReportIds.add(reportId);
  }
  renderFailureReports();
}

function copyFailureReport(report) {
  const json = JSON.stringify(report, null, 2);
  $("#workspace-json").value = json;
  navigator.clipboard?.writeText(json).catch(() => {});
  setStatus("已复制失败报告 JSON，并放入工作区文本框");
}

function copyFailureEvidenceBundle(report) {
  const bundle = failureEvidenceBundle(report, { schemaVersion: WORKSPACE_SCHEMA_VERSION });
  const json = JSON.stringify(bundle, null, 2);
  const summary = failureEvidenceSummaryText(bundle);
  $("#workspace-json").value = json;
  navigator.clipboard?.writeText(json).catch(() => {});
  setStatus(`已复制失败证据包，并放入工作区文本框${summary ? `：${summary}` : ""}`);
}

function focusFailureReportStep(report) {
  const failedStep = failureStepFromRecord(report);
  const workflow = state.workspace.workflows.find((item) => item.id === failedStep?.workflowId);
  const stepItem = workflow?.steps.find((item) => item.id === failedStep?.stepId);
  if (!workflow || !stepItem) {
    setStatus("当前任务库中找不到这条失败报告对应的步骤，可能来自旧工作区或已删除任务");
    return;
  }
  state.workspace.activeWorkflowId = workflow.id;
  selectStepAndTarget(stepItem);
  setInspectorTab("step");
  renderAll();
  window.requestAnimationFrame(() => {
    $("#step-editor")?.scrollIntoView({ block: "nearest" });
  });
  setStatus(`已定位失败步骤：${workflow.name} / ${stepItem.name || stepLabels[stepItem.type] || stepItem.type}`);
}

function durationLabel(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function exportWorkspace() {
  const json = JSON.stringify(state.workspace, null, 2);
  $("#workspace-json").value = json;
  navigator.clipboard?.writeText(json).catch(() => {});
  setStatus("工作区 JSON 已导出并尝试复制");
}

async function importWorkspace() {
  try {
    const parsed = JSON.parse($("#workspace-json").value);
    state.workspace = normalizeWorkspace(parsed);
    state.workspaceMigration = workspaceMigrationAudit(parsed, state.workspace, WORKSPACE_SCHEMA_VERSION);
    state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
    markDirty("imported");
    await saveWorkspaceNow();
    renderAll();
    renderWorkspaceMigrationAudit();
    setStatus(`工作区 JSON 已载入；${workspaceMigrationSummaryText(state.workspaceMigration)}`);
  } catch (error) {
    setStatus(`工作区 JSON 载入失败：${error.message}`);
    appendLog("error", `工作区 JSON 载入失败：${error.message}`);
  }
}

async function importLiveValidationReport() {
  try {
    const parsed = JSON.parse($("#workspace-json").value);
    if (!isLiveValidationEvidence(parsed)) {
      throw new Error("文本框内容不是 live-background-hotkey JSON 报告");
    }
    const record = liveValidationRunHistoryEntry(parsed);
    state.workspace.runHistory = mergeLiveValidationRunHistory(state.workspace.runHistory, record, { limit: 80 });
    markDirty("live validation imported");
    await saveWorkspaceNow();
    renderSessions();
    renderOpsDashboard();
    const summary = record.failureReason || record.liveValidation?.status || record.status;
    setStatus(`已导入 live 验收报告到运行历史：${summary}`);
    appendLog("info", `已导入 live 验收报告：${record.id} · ${summary}`);
  } catch (error) {
    setStatus(`live 验收报告导入失败：${error.message}`);
    appendLog("error", `live 验收报告导入失败：${error.message}`);
  }
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function imageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new globalThis.Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function cancellableSleep(session, ms, context = {}) {
  let remainingMs = Math.max(0, Number(ms) || 0);
  while (!session.cancelRequested && remainingMs > 0) {
    if (session.pauseRequested || session.status === "paused") {
      const resumed = await waitIfPaused(session, context.workflow || null, context);
      if (!resumed) return false;
      continue;
    }
    const chunkMs = Math.min(250, remainingMs);
    const startedAt = Date.now();
    await sleep(chunkMs);
    remainingMs = Math.max(0, remainingMs - Math.max(1, Date.now() - startedAt));
  }
  return !session.cancelRequested;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function randomId(prefix) {
  const id =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${id}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

fillStepTypeSelect($("#new-step-type"));
fillStepTypeSelect($("#step-type"));
fillStepBlockSelect($("#step-block-preset"));
fillWorkflowBlueprintSelect($("#workflow-blueprint-select"));
renderQuickStepActions();

$("#refresh-windows").addEventListener("click", refreshWindows);
$("#launch-game-client").addEventListener("click", launchGameClient);
$("#select-game-windows").addEventListener("click", selectGameWindows);
$("#prepare-exercise-workspace").addEventListener("click", prepareExerciseWorkspace);
$("#restart-admin").addEventListener("click", restartAsAdmin);
$("#save-workspace").addEventListener("click", () => saveWorkspaceNow());
$("#capture-preview").addEventListener("click", capturePreview);
$("#save-snapshot").addEventListener("click", saveSnapshot);
$("#load-offline-image").addEventListener("click", loadOfflineImage);
$("#target-from-roi").addEventListener("click", targetFromRoi);
$("#assign-selected").addEventListener("click", assignWorkflowToSelected);
$("#append-picked-workflows").addEventListener("click", appendPickedWorkflowsToSelected);
$("#copy-active-queue-to-selected").addEventListener("click", copyActiveQueueToSelectedWindows);
$("#clear-selected-queues").addEventListener("click", clearSelectedQueues);
$("#workflow-blueprint-select").addEventListener("change", () => {
  syncWorkflowBlueprintDefaults({ force: true });
  renderBlueprintPreview();
  renderBlueprintGallery();
});
$("#create-workflow-from-blueprint").addEventListener("click", () => createWorkflowBatch());
$("#create-and-assign-blueprint").addEventListener("click", () => createWorkflowBatch({ assignToSelected: true }));
$("#create-exercise-suite").addEventListener("click", createExerciseSuite);
$("#new-workflow").addEventListener("click", newWorkflow);
$("#import-sample-pack").addEventListener("click", importSampleWorkflowPack);
$("#duplicate-workflow").addEventListener("click", duplicateWorkflow);
$("#delete-workflow").addEventListener("click", deleteWorkflow);
$("#add-step").addEventListener("click", addStep);
$("#insert-step-below").addEventListener("click", insertStepBelowSelected);
$("#duplicate-step").addEventListener("click", duplicateSelectedStep);
$("#insert-step-block").addEventListener("click", insertStepBlock);
$("#quick-step-actions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-quick-step-action]");
  if (!button) return;
  insertQuickStepAction(button.dataset.quickStepAction);
});
$("#move-step-up").addEventListener("click", () => moveSelectedStep(-1));
$("#move-step-down").addEventListener("click", () => moveSelectedStep(1));
$("#delete-step").addEventListener("click", deleteSelectedStep);
$("#focus-next-gap").addEventListener("click", focusNextCompletionGap);
$("#completion-action-dock").addEventListener("click", (event) => {
  void handleCompletionActionDock(event);
});
$("#validate-workflow").addEventListener("click", validateActiveWorkflow);
$("#validate-all-workflows").addEventListener("click", validateAllWorkflows);
$("#dry-run-selected").addEventListener("click", dryRunSelected);
$("#background-run-selected").addEventListener("click", backgroundRunSelected);
$("#pause-runs").addEventListener("click", pauseRuns);
$("#resume-runs").addEventListener("click", resumeRuns);
$("#stop-dry-run").addEventListener("click", stopDryRun);
$("#export-workspace").addEventListener("click", exportWorkspace);
$("#import-workspace").addEventListener("click", importWorkspace);
$("#import-live-report").addEventListener("click", importLiveValidationReport);
$("#failure-report-board").addEventListener("click", handleFailureReportAction);
$("#preview-click-capture").addEventListener("click", togglePreviewClickCapture);
$("#preview-click-button").addEventListener("change", (event) => setPreviewClickButton(event.target.value));
$("#preview-image").addEventListener("mousedown", startRoiDrag);
$("#preview-image").addEventListener("contextmenu", (event) => {
  if (state.previewClickCapture) event.preventDefault();
});
window.addEventListener("mousemove", moveRoiDrag);
window.addEventListener("mouseup", endRoiDrag);
window.addEventListener("resize", () => {
  updateRoiBox();
  updateMatchBox();
  applyWorkbenchViewportContract();
});
window.addEventListener("paste", handlePasteImage);

bindWorkflowInputs();
bindStepEditor();
bindStepParamEditor();
bindTargetEditor();
bindInspectorTabs();
applyWorkbenchViewportContract();
appendLog("info", "本地任务模型初始化中");
await setupCloseToTray();
await loadWorkspace();
state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
renderAll();
updatePreviewClickCaptureUi();
await refreshPrivilege();
await refreshGameLaunchStatus();
await refreshWindows();
