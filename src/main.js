import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

const TARGET_TITLE = "梦幻西游：时空";
const WORKSPACE_SCHEMA_VERSION = 4;
const DEFAULT_IMAGE_THRESHOLD = 0.86;
const WINDOW_CLIENT_SIZE_TOLERANCE = 2;
const MAX_LOG_ROWS = 500;
const targetBackedStepTypes = new Set(["image_click", "wait_image", "detect_page", "click", "ocr_assert"]);
const capturedImageStepTypes = new Set(["image_click", "wait_image", "detect_page"]);
const targetKindOptions = ["image", "roi", "page", "ocr", "click_target", "state", "unknown"];

const stepTypes = [
  ["detect_page", "检测页面"],
  ["wait_image", "等待图像"],
  ["image_click", "图像点击"],
  ["ocr_assert", "OCR 确认"],
  ["click", "后台点击"],
  ["hotkey", "快捷键"],
  ["delay", "延迟等待"],
  ["condition", "条件判断"],
  ["retry_until", "重试直到"],
  ["snapshot", "截图记录"],
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
    onSuccess: "next",
  },
  wait_image: {
    name: "等待图像",
    target: "target.image",
    command: "threshold=0.86",
    expect: "visible",
    timeoutMs: 5000,
    retry: 2,
    onFail: "retry",
    onSuccess: "next",
  },
  image_click: {
    name: "图像点击",
    target: "button.target",
    command: "button=left; point=center",
    expect: "screen.changed",
    timeoutMs: 2600,
    retry: 1,
    onFail: "retry",
    onSuccess: "next",
  },
  ocr_assert: {
    name: "OCR 确认",
    target: "text.keyword",
    command: "lang=zh; roi=auto",
    expect: "text_found",
    timeoutMs: 4200,
    retry: 2,
    onFail: "restore",
    onSuccess: "next",
  },
  click: {
    name: "后台点击",
    target: "x=0,y=0",
    command: "button=left; mode=hwnd-message",
    expect: "click.accepted",
    timeoutMs: 1300,
    retry: 0,
    onFail: "stop",
    onSuccess: "next",
  },
  hotkey: {
    name: "快捷键",
    target: "ALT+N",
    command: "mode=hwnd-key",
    expect: "panel.open",
    timeoutMs: 1200,
    retry: 0,
    onFail: "stop",
    onSuccess: "next",
  },
  delay: {
    name: "延迟等待",
    target: "800ms",
    command: "reason=animation",
    expect: "time.elapsed",
    timeoutMs: 800,
    retry: 0,
    onFail: "skip",
    onSuccess: "next",
  },
  condition: {
    name: "条件判断",
    target: "state.flag",
    command: "guard=true",
    expect: "branch.next",
    timeoutMs: 1000,
    retry: 0,
    onFail: "branch",
    onSuccess: "next",
  },
  retry_until: {
    name: "重试直到",
    target: "page.target.ready",
    command: "interval=800ms",
    expect: "ready=true",
    timeoutMs: 8000,
    retry: 5,
    onFail: "restore",
    onSuccess: "next",
  },
  snapshot: {
    name: "截图记录",
    target: "window.client",
    command: "dry-run log only",
    expect: "snapshot.recorded",
    timeoutMs: 1000,
    retry: 0,
    onFail: "skip",
    onSuccess: "next",
  },
  restore: {
    name: "恢复状态",
    target: "restore.home",
    command: "safe sequence",
    expect: "page.home.ready",
    timeoutMs: 6000,
    retry: 1,
    onFail: "stop",
    onSuccess: "next",
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
  workspace: createSeedWorkspace(),
  workspacePath: "",
  selectedStepId: null,
  selectedTargetId: "",
  targetSearch: "",
  targetKindFilter: "all",
  stepValidation: {},
  saveTimer: null,
  sessions: {},
  sessionSerial: 0,
};

const $ = (selector) => document.querySelector(selector);
const appWindow = getCurrentWindow();

async function setupCloseToTray() {
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
  element.classList.remove("idle", "ready", "running", "blocked");
  element.classList.add(value);
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
      step("daily-03", "wait_image", "等待活动入口", "target.activity.icon", "threshold=0.86", "visible"),
      step("daily-04", "image_click", "进入福利页", "button.welfare", "button=left; point=center", "welfare.visible"),
      step("daily-05", "delay", "等待切页动画", "700ms", "reason=panel_transition", "time.elapsed"),
      step("daily-06", "ocr_assert", "确认福利标题", "福利", "lang=zh; roi=top", "text_found"),
      step("daily-07", "image_click", "点击签到", "button.sign_in", "button=left; point=center", "reward.popup"),
      step("daily-08", "condition", "判断是否已领取", "state.reward_claimed", "guard=false", "continue"),
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
      step("map-07", "image_click", "选择藏宝图", "item.treasure_map", "button=left; point=center", "item.selected"),
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
      step("realm-06", "condition", "检查次数是否可用", "state.realm_attempts", "guard=>0", "continue"),
      step("realm-07", "hotkey", "打开背包检查材料", "ALT+E", "mode=hwnd-key", "bag.open"),
      step("realm-08", "wait_image", "查找秘境材料", "item.realm_material", "threshold=0.86", "visible"),
      step("realm-09", "wait_image", "确认材料图标", "target.realm_material", "threshold=0.84", "material.visible"),
      step("realm-10", "click", "选择材料格", "grid.material_slot", "button=left; mode=hwnd-message", "item.selected"),
      step("realm-11", "retry_until", "等待准备就绪", "state.realm_ready", "interval=1000ms", "true", 9000, 5),
      step("realm-12", "snapshot", "记录准备状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("realm-13", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
  ];
}

function workflow(id, name, category, description, steps) {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id,
    name,
    category,
    description,
    tags: [category, "示例"],
    initialCheck: "page.home.ready",
    restorePolicy: "restore_home",
    targetPolicy: {
      titleNeedle: TARGET_TITLE,
      inputMode: "hwnd-message",
      concurrency: "per-window-exclusive",
    },
    steps,
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
  onSuccess = stepDefaults[type]?.onSuccess ?? "next",
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
    onSuccess,
    enabled: true,
    notes: "",
  };
}

async function loadWorkspace() {
  try {
    const result = await invoke("load_workflow_workspace");
    state.workspacePath = result.path;
    state.workspace = normalizeWorkspace(result.data);
    if (!state.workspace.workflows.length) {
      state.workspace = createSeedWorkspace();
      await saveWorkspaceNow();
      appendLog("info", "首次启动已写入 5 个示例任务");
    }
    $("#workspace-state").textContent = result.existed ? "loaded" : "seeded";
    $("#workspace-state").classList.add("ok");
    $("#workspace-path").textContent = state.workspacePath;
  } catch (error) {
    state.workspace = createSeedWorkspace();
    $("#workspace-state").textContent = "memory";
    $("#workspace-state").classList.remove("ok");
    $("#workspace-path").textContent = "工作区载入失败，当前使用内存草稿";
    appendLog("error", `工作区载入失败：${error}`);
  }
}

function normalizeWorkspace(value) {
  const seed = createSeedWorkspace();
  const source = value && typeof value === "object" ? value : {};
  const workflows = Array.isArray(source.workflows)
    ? source.workflows.map(normalizeWorkflow)
    : seed.workflows;
  const activeWorkflowId = workflows.some((item) => item.id === source.activeWorkflowId)
    ? source.activeWorkflowId
    : workflows[0]?.id || null;
  const targetSource = [
    ...(Array.isArray(source.assets) ? source.assets : []),
    ...(Array.isArray(source.targets) ? source.targets : []),
  ];
  const targets = targetSource.length
    ? mergeTargetCatalog(targetSource.map(normalizeTarget), workflows)
    : createTargetCatalogFromWorkflows(workflows);
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeWorkflowId,
    workflows,
    assignments: normalizeAssignments(source.assignments, workflows),
    targets,
    runHistory: Array.isArray(source.runHistory) ? source.runHistory.slice(0, 80) : [],
    createdAt: source.createdAt || new Date().toISOString(),
    updatedAt: source.updatedAt || new Date().toISOString(),
  };
}

function normalizeWorkflow(value) {
  const typeSafeSteps = Array.isArray(value?.steps) ? value.steps.map(normalizeStep) : [];
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: String(value?.id || randomId("wf")),
    name: String(value?.name || "未命名任务"),
    category: String(value?.category || "未分类"),
    description: String(value?.description || ""),
    tags: Array.isArray(value?.tags) ? value.tags.map(String) : [],
    initialCheck: String(value?.initialCheck || "page.home.ready"),
    restorePolicy: String(value?.restorePolicy || "restore_home"),
    targetPolicy: {
      titleNeedle: String(value?.targetPolicy?.titleNeedle || TARGET_TITLE),
      inputMode: String(value?.targetPolicy?.inputMode || "hwnd-message"),
      concurrency: String(value?.targetPolicy?.concurrency || "per-window-exclusive"),
    },
    steps: typeSafeSteps,
    createdAt: value?.createdAt || new Date().toISOString(),
    updatedAt: value?.updatedAt || new Date().toISOString(),
  };
}

function normalizeStep(value) {
  const type = stepLabels[value?.type] ? value.type : "detect_page";
  const defaults = stepDefaults[type];
  return {
    id: String(value?.id || randomId("step")),
    type,
    name: String(value?.name || defaults.name),
    target: String(value?.target || defaults.target),
    command: String(value?.command || defaults.command),
    expect: String(value?.expect || defaults.expect),
    timeoutMs: Number(value?.timeoutMs ?? defaults.timeoutMs),
    retry: Number(value?.retry ?? defaults.retry),
    onFail: String(value?.onFail || defaults.onFail),
    onSuccess: String(value?.onSuccess || defaults.onSuccess),
    enabled: value?.enabled !== false,
    targetId: value?.targetId ? String(value.targetId) : value?.assetId ? String(value.assetId) : "",
    notes: String(value?.notes || ""),
  };
}

function normalizeTarget(value) {
  const threshold = normalizedThreshold(value?.match?.threshold ?? value?.threshold, DEFAULT_IMAGE_THRESHOLD);
  return {
    id: String(value?.id || randomId("target")),
    name: String(value?.name || "未命名目标"),
    kind: String(value?.kind || (value?.dataUrl ? "image" : value?.roi ? "roi" : "unknown")),
    createdAt: String(value?.createdAt || new Date().toISOString()),
    updatedAt: String(value?.updatedAt || value?.createdAt || new Date().toISOString()),
    dataUrl: value?.dataUrl ? String(value.dataUrl) : "",
    roi: value?.roi || null,
    match: {
      threshold,
      scope: String(value?.match?.scope || (value?.roi ? "roi" : "window")),
    },
    texts: Array.isArray(value?.texts) ? value.texts.map(String).filter(Boolean) : [],
    click: {
      button: normalizedTargetButton(value?.click?.button || value?.button || "left"),
      point: String(value?.click?.point || value?.point || "center"),
    },
    source: value?.source || null,
    width: Number(value?.width || 0),
    height: Number(value?.height || 0),
    note: String(value?.note || ""),
  };
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
      if (!targetBackedStepTypes.has(item.type) || !isLogicalTargetName(item.target)) continue;
      const id = item.target.trim();
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
  return "image";
}

function defaultThresholdForStep(item) {
  return ["image_click", "wait_image", "detect_page"].includes(item.type) ? DEFAULT_IMAGE_THRESHOLD : "";
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
  return {
    id: String(source.id || randomId("queue")),
    workflowId: String(source.workflowId || ""),
    enabled: source.enabled !== false,
    order: Number(source.order || 0),
    addedAt: String(source.addedAt || new Date().toISOString()),
  };
}

async function saveWorkspaceNow() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = null;
  try {
    state.workspace.updatedAt = new Date().toISOString();
    const result = await invoke("save_workflow_workspace", { workspace: state.workspace });
    state.workspacePath = result.savedPath;
    $("#workspace-state").textContent = "saved";
    $("#workspace-state").classList.add("ok");
    $("#workspace-path").textContent = `${result.savedPath} · ${result.bytes} bytes`;
    return result;
  } catch (error) {
    $("#workspace-state").textContent = "save failed";
    $("#workspace-state").classList.remove("ok");
    appendLog("error", `工作区保存失败：${error}`);
    return null;
  }
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
  state.saveTimer = window.setTimeout(saveWorkspaceNow, 500);
  renderWorkflowList();
  renderAssignments();
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

function assignmentForHwnd(hwnd) {
  return state.workspace.assignments[String(hwnd)] || null;
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

function queueWorkflowsForTarget(target) {
  const assignment = assignmentForHwnd(target.hwnd);
  const queue = assignment?.queue || [];
  return queue
    .filter((item) => item.enabled)
    .map((item) => workflowById(item.workflowId))
    .filter(Boolean);
}

function totalQueuedWorkflows() {
  return Object.values(state.workspace.assignments || {}).reduce(
    (sum, assignment) => sum + (assignment.queue?.length || 0),
    0,
  );
}

function renderAll() {
  renderWorkflowList();
  renderWorkflowForm();
  renderSteps();
  renderStepEditor();
  renderTargets();
  renderWindows();
  renderAssignments();
  renderSessions();
}

function renderWorkflowList() {
  $("#workflow-count").textContent = String(state.workspace.workflows.length);
  const list = $("#workflow-list");
  list.replaceChildren();
  for (const item of state.workspace.workflows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workflow-row";
    button.classList.toggle("active", item.id === state.workspace.activeWorkflowId);
    button.innerHTML = `
      <strong>${escapeHtml(item.name)}</strong>
      <span>${escapeHtml(item.category || "未分类")} · ${item.steps.length} 步</span>
      <small>${escapeHtml(item.description || "无备注")}</small>
    `;
    button.addEventListener("click", () => {
      state.workspace.activeWorkflowId = item.id;
      state.selectedStepId = item.steps[0]?.id || null;
      renderWorkflowForm();
      renderWorkflowList();
      renderSteps();
      renderStepEditor();
      renderTargets();
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
  $("#workflow-restore-policy").value = workflow.restorePolicy || "restore_home";
  $("#workflow-concurrency").value = workflow.targetPolicy?.concurrency || "per-window-exclusive";
  $("#workflow-description").value = workflow.description || "";
}

function bindWorkflowInputs() {
  const updates = [
    ["#workflow-name", "name"],
    ["#workflow-category", "category"],
    ["#workflow-initial-check", "initialCheck"],
    ["#workflow-restore-policy", "restorePolicy"],
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
    workflow.targetPolicy.concurrency = event.target.value;
    markDirty("draft");
  });
}

function newWorkflow() {
  const workflow = normalizeWorkflow({
    id: randomId("wf"),
    name: "新任务",
    category: "草稿",
    description: "从这里开始组合检测、点击、等待和恢复步骤。",
    steps: [createStep("detect_page"), createStep("hotkey"), createStep("wait_image")],
  });
  state.workspace.workflows.unshift(workflow);
  state.workspace.activeWorkflowId = workflow.id;
  state.selectedStepId = workflow.steps[0]?.id || null;
  markDirty("draft");
  renderAll();
}

function duplicateWorkflow() {
  const source = activeWorkflow();
  if (!source) return;
  const copy = normalizeWorkflow(JSON.parse(JSON.stringify(source)));
  copy.id = randomId("wf");
  copy.name = `${source.name} 副本`;
  copy.createdAt = new Date().toISOString();
  copy.updatedAt = copy.createdAt;
  copy.steps = copy.steps.map((item) => ({ ...item, id: randomId("step") }));
  state.workspace.workflows.unshift(copy);
  state.workspace.activeWorkflowId = copy.id;
  state.selectedStepId = copy.steps[0]?.id || null;
  markDirty("draft");
  renderAll();
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
    return;
  }
  if (!state.selectedStepId || !workflow.steps.some((item) => item.id === state.selectedStepId)) {
    state.selectedStepId = workflow.steps[0]?.id || null;
  }
  const validation = validationOverride || validateWorkflow(workflow);
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
    row.type = "button";
    row.className = "step-row";
    row.classList.toggle("active", item.id === state.selectedStepId);
    row.classList.toggle("disabled", item.enabled === false);
    row.classList.toggle("has-issue", stepMessages.issues.length > 0);
    row.classList.toggle("has-warning", !stepMessages.issues.length && stepMessages.warnings.length > 0);
    row.innerHTML = `
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(item.name || stepLabels[item.type] || item.type)}</strong>
      <small>${item.enabled === false ? "停用 · " : ""}${escapeHtml(stepLabels[item.type] || item.type)} · ${escapeHtml(item.target || "target: none")}</small>
      ${badgeText ? `<em class="step-badge ${badgeClass}" title="${escapeHtml([...stepMessages.issues, ...stepMessages.warnings].join(" / "))}">${badgeText}</em>` : ""}
    `;
    row.addEventListener("click", () => {
      state.selectedStepId = item.id;
      const boundTarget = targetForStep(item);
      if (boundTarget) state.selectedTargetId = boundTarget.id;
      renderSteps();
      renderStepEditor();
      renderTargets();
    });
    list.append(row);
  });
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
    onSuccess: defaults.onSuccess,
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
  if (boundTarget) state.selectedTargetId = boundTarget.id;
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
    if (!targetBackedStepTypes.has(item.type) || !isLogicalTargetName(item.target)) continue;
    const id = item.target.trim();
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
  $("#param-hotkey").value = item.type === "hotkey" ? item.target || "" : "";

  const boundTarget = targetForStep(item);
  const boundDefaults = targetCommandDefaults(boundTarget, item.command);
  const point = parsePointText(item.target) || parsePointText(item.command);
  $("#param-click-x").value = point?.x ?? "";
  $("#param-click-y").value = point?.y ?? "";
  $("#param-click-button").value = boundDefaults.button;

  $("#param-image-threshold").value = commandValue(item.command, "threshold") || boundDefaults.threshold;
  $("#param-image-button").value = boundDefaults.button;
  $("#param-image-point").value = commandValue(item.command, "point") || boundDefaults.point;
  $("#param-image-target").value = ["image_click", "wait_image", "detect_page"].includes(item.type)
    ? item.target || ""
    : "";

  $("#param-delay-ms").value = durationMsFromText(item.target) ?? item.timeoutMs ?? "";
  $("#param-delay-reason").value = commandValue(item.command, "reason") || "";
  $("#param-condition-target").value = item.type === "condition" ? item.target || "" : "";
  $("#param-condition-guard").value = commandValue(item.command, "guard") || "";
  $("#param-retry-target").value = item.type === "retry_until" ? item.target || "" : "";
  $("#param-retry-interval").value = durationMsFromText(commandValue(item.command, "interval")) ?? "";
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

function paramSummaryForStep(item) {
  const target = targetForStep(item);
  if (["image_click", "wait_image", "detect_page"].includes(item.type)) {
    const threshold = commandValue(item.command, "threshold") || target?.match?.threshold || DEFAULT_IMAGE_THRESHOLD;
    return target ? `${target.name} · threshold ${threshold}` : `未绑定图片目标 · threshold ${threshold}`;
  }
  if (item.type === "click") {
    const point = parsePointText(item.target) || parsePointText(item.command);
    return point ? `点击 ${point.x},${point.y}` : target?.roi ? "点击绑定 ROI 中心" : "需要坐标或 ROI";
  }
  if (item.type === "hotkey") return item.target || "输入快捷键";
  if (item.type === "delay") return `${durationMsFromText(item.target) ?? item.timeoutMs ?? 0} ms`;
  return "保留为编排语义，当前后端不直接输入";
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
      bindTargetToStep(item, target, { preserveClick: item.type === "click" });
    });
    renderTargets();
  });
  $("#param-hotkey").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
      item.command = commandWithValues(item.command, { mode: "hwnd-key" });
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
  $("#delete-target").addEventListener("click", deleteSelectedTarget);
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

function updateSelectedStepFromParams(mutator) {
  const item = selectedStep();
  if (!item) return;
  mutator(item);
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
  $("#step-on-success").value = item.onSuccess || "next";
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
    markDirty("draft");
    renderSteps();
    if (["target", "command"].includes(field)) renderStepParamPanel(item);
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
  $("#step-on-success").addEventListener("change", update("onSuccess"));
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
    item.onSuccess = defaults.onSuccess;
    if (!targetBackedStepTypes.has(item.type)) {
      item.targetId = "";
    }
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

function commandWithValues(command, updates) {
  const updateKeys = new Set(Object.keys(updates).map((key) => key.toLowerCase()));
  const parts = commandParts(command).filter((part) => !part.key || !updateKeys.has(part.key.toLowerCase()));
  for (const [key, value] of Object.entries(updates)) {
    const text = String(value ?? "").trim();
    if (text) parts.push({ key, value: text });
  }
  return parts.map((part) => (part.key ? `${part.key}=${part.value}` : part.raw)).join("; ");
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

function unbindStepTarget(item, options = {}) {
  if (!item) return "";
  const previousId = stepTargetId(item);
  item.targetId = "";
  delete item.assetId;
  if (options.clearTarget || (previousId && item.target?.trim() === previousId)) {
    item.target = "";
  }
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
  $("#delete-target").disabled = usages.length > 0;
  $("#delete-target").title = usages.length > 0 ? "目标仍被步骤使用，先解除绑定后再删除" : "删除当前未使用目标";
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
      if (options.threshold && ["image_click", "wait_image", "detect_page"].includes(item.type)) {
        item.command = commandWithValues(item.command, { threshold: updates.threshold });
      }
      if (options.clickButton && ["image_click", "click"].includes(item.type)) {
        item.command = commandWithValues(item.command, { button: updates.button });
      }
      if (options.clickPoint && item.type === "image_click") {
        item.command = commandWithValues(item.command, { point: updates.point });
      }
    }
  }
}

function bindSelectedTargetToStep() {
  const target = selectedManagedTarget();
  if (!target) {
    setStatus("需要先选择目标");
    return;
  }
  if (!selectedStep()) {
    setStatus("需要先选择步骤");
    return;
  }
  bindTargetToSelectedStep(target, { preserveClick: true });
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  setStatus(`已绑定目标：${target.name}`);
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
    state.privilege = await invoke("privilege_status");
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
}

async function refreshGameLaunchStatus() {
  const button = $("#launch-game-client");
  const label = $("#launch-status");
  try {
    state.launchStatus = await invoke("game_launch_status");
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
    state.windows = await invoke("list_game_windows", { titleNeedle: TARGET_TITLE });
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
  const targets = selectedWindows();
  if (!workflow || !targets.length) {
    setStatus("需要先选择任务和窗口");
    return;
  }
  for (const target of targets) {
    const assignment = ensureAssignment(target);
    assignment.queue.push(
      normalizeQueueItem({
        workflowId: workflow.id,
        order: assignment.queue.length + 1,
        addedAt: new Date().toISOString(),
      }),
    );
    assignment.queue = assignment.queue.map((item, index) => ({ ...item, order: index + 1 }));
  }
  markDirty("queued");
  renderWindows();
  renderAssignments();
  setStatus(`已把 ${workflow.name} 追加到 ${targets.length} 个窗口队列`);
}

function renderAssignments() {
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
    return;
  }
  for (const [hwnd, assignment] of entries) {
    const row = document.createElement("div");
    row.className = "queue-window";
    row.innerHTML = `
      <button class="compact-row queue-window-head" type="button">
        <strong>${escapeHtml(assignment.display || hwnd)}</strong>
        <span>${assignment.queue.length} 个任务 · hwnd=${escapeHtml(hwnd)}</span>
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
      const itemRow = document.createElement("div");
      itemRow.className = "queue-item";
      itemRow.classList.toggle("disabled", queueItem.enabled === false || !workflow);
      itemRow.innerHTML = `
        <button class="queue-item-title" type="button">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHtml(workflow?.name || "任务已删除")}</strong>
          <small>${queueItem.enabled === false ? "停用" : `${workflow?.steps?.length || 0} 步`}</small>
        </button>
        <div class="queue-item-actions">
          <button type="button" data-action="toggle">${queueItem.enabled === false ? "启用" : "停用"}</button>
          <button type="button" data-action="up">上移</button>
          <button type="button" data-action="down">下移</button>
          <button type="button" data-action="remove">删除</button>
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
      itemRow.querySelector(".queue-item-actions").addEventListener("click", (event) => {
        const action = event.target?.dataset?.action;
        if (!action) return;
        updateQueueItem(hwnd, queueItem.id, action);
      });
      items.append(itemRow);
    });
    list.append(row);
  }
}

function updateQueueItem(hwnd, queueItemId, action) {
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

async function restartAsAdmin() {
  try {
    await invoke("restart_as_admin");
    setStatus("已请求管理员权限重启");
  } catch (error) {
    setStatus(`管理员重启失败：${error}`);
    appendLog("error", `管理员重启失败：${error}`);
  }
}

async function launchGameClient() {
  try {
    await refreshGameLaunchStatus();
    const result = await invoke("launch_game_client");
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
    const preview = await invoke("capture_window_preview", { hwnd: Number(target.hwnd) });
    setPreviewImage(preview.dataUrl, preview.width, preview.height, "window");
    updateActiveMeta(`${target.display} · ${preview.width}x${preview.height} · hwnd=${target.hwnd}`);
    setStatus("窗口预览已刷新");
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
    const preview = await invoke("import_preview_image", { imagePath, saveCopy: false });
    setPreviewImage(preview.dataUrl, preview.width, preview.height, "image");
    updateActiveMeta(`离线图 · ${preview.width}x${preview.height}`);
    setStatus(`已载入离线图：${imagePath}`);
  } catch (error) {
    clearPreview("离线图载入失败");
    setStatus(`载入离线图失败：${error}`);
    appendLog("error", `载入离线图失败：${error}`);
  }
}

function setPreviewImage(dataUrl, width, height, source) {
  const image = $("#preview-image");
  image.src = dataUrl;
  state.preview = { width, height };
  state.previewSource = source;
  $("#preview-empty").style.display = "none";
  updateRoiBox();
}

function clearPreview(message) {
  $("#preview-image").removeAttribute("src");
  $("#preview-empty").style.display = "grid";
  $("#preview-empty").textContent = message;
  state.preview = null;
  state.previewSource = "window";
  updateActiveMeta();
  updateRoiMeta();
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
    const result = await invoke("save_window_snapshot", { hwnd: Number(target.hwnd) });
    setStatus(`已保存截图：${result.savedPath}`);
    appendLog("info", `截图保存：${result.savedPath}`);
  } catch (error) {
    setStatus(`保存截图失败：${error}`);
    appendLog("error", `保存截图失败：${error}`);
  }
}

function startRoiDrag(event) {
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

function ensureCapturedTargetStep(targetItem) {
  const current = selectedStep();
  const hasTemplateImage = Boolean(targetItem?.dataUrl);
  if (hasTemplateImage && current && capturedImageStepTypes.has(current.type)) {
    return { step: current, created: false };
  }
  if (!hasTemplateImage && current?.type === "click") {
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
  if (isEditablePasteTarget(event.target)) return;
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
  if (!item) return;
  event.preventDefault();
  const file = item.getAsFile();
  if (!file) return;
  const dataUrl = await readBlobAsDataUrl(file);
  const size = await imageSize(dataUrl).catch(() => ({ width: 0, height: 0 }));
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
    note: "由 Ctrl+V 粘贴创建",
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
  if (item.type === "click" && options.preserveClick) {
    item.command = commandWithValues(item.command, {
      button: commandDefaults.button,
      mode: "hwnd-message",
    });
    return;
  }
  if (item.type === "ocr_assert" || targetItem.kind === "ocr") {
    item.type = "ocr_assert";
    item.name = item.name || "OCR 确认";
    item.command = commandWithMissingValues(item.command, { lang: "zh" });
    item.expect = item.expect || "text_found";
    return;
  }
  if (!["image_click", "wait_image", "detect_page"].includes(item.type)) {
    item.type = "image_click";
    item.name = "图像点击";
    item.expect = "screen.changed";
  }
  item.command = commandWithValues(item.command, commandDefaults);
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
  for (const targetItem of filteredTargets) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "compact-row target-row";
    row.classList.toggle("active", targetItem.id === state.selectedTargetId);
    row.classList.toggle("bound", targetItem.id === boundTargetId);
    const thumb = targetItem.dataUrl
      ? `<img src="${targetItem.dataUrl}" alt="${escapeHtml(targetItem.name)}" />`
      : `<i>${escapeHtml(targetThumbLabel(targetItem))}</i>`;
    const threshold = targetItem.match?.threshold ?? DEFAULT_IMAGE_THRESHOLD;
    const click = `${targetItem.click?.button || "left"}@${targetItem.click?.point || "center"}`;
    const usages = targetUsages(targetItem.id).length;
    row.innerHTML = `
      ${thumb}
      <span>
        <strong>${escapeHtml(targetItem.name)}</strong>
        <small>${escapeHtml(targetItem.kind)} · ${targetItem.width || "-"}x${targetItem.height || "-"} · t=${escapeHtml(threshold)} · ${escapeHtml(click)} · ${usages} 处</small>
      </span>
      <em>${targetItem.id === boundTargetId ? "已绑定" : "选择"}</em>
    `;
    row.addEventListener("click", () => {
      state.selectedTargetId = targetItem.id;
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
  for (const [index, item] of workflow?.steps.entries() || []) {
    const prefix = `第 ${index + 1} 步`;
    if (!stepLabels[item.type]) addIssue(`${prefix} 类型未知`, item);
    if (item.enabled === false) continue;
    if (!item.name.trim()) addIssue(`${prefix} 名称为空`, item);
    if (!item.target.trim() && !["delay", "snapshot"].includes(item.type)) {
      addIssue(`${prefix} 缺少目标`, item);
    }
    if (!Number.isFinite(item.timeoutMs) || item.timeoutMs < 0) addIssue(`${prefix} 超时必须是非负数`, item);
    if (!Number.isFinite(item.retry) || item.retry < 0) addIssue(`${prefix} 重试必须是非负数`, item);
    if (item.type === "hotkey" && !/[+]/.test(item.target)) {
      addWarning(`${prefix} 快捷键建议使用 ALT+N 这类组合格式`, item);
    }
    validateStepRuntimeFields(item, prefix, addIssue, addWarning, mode);
  }
  return result;
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
  const button = commandValue(item.command, "button");
  if (button && !["left", "l", "primary", "right", "r", "secondary"].includes(button.toLowerCase())) {
    addIssue(`${prefix} 鼠标键只支持 left/right`, item);
  }
  const threshold = commandValue(item.command, "threshold");
  if (threshold) {
    const value = Number(threshold);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      addIssue(`${prefix} 匹配阈值必须在 0 到 1 之间`, item);
    }
  }
  const point = parsePointText(item.target) || parsePointText(item.command);
  const targetId = stepTargetId(item);
  const targetItem = targetForStep(item);
  const hasRoi = Boolean(targetItem?.roi);
  const hasImage = Boolean(targetItem?.dataUrl);
  if (targetId && !targetItem) {
    addIssue(`${prefix} 绑定的识别目标已不存在`, item);
  }
  if (item.type === "click" && !point && !hasRoi) {
    const message = `${prefix} 后台点击需要 x/y 坐标或绑定 ROI 目标`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  if (["image_click", "wait_image", "detect_page"].includes(item.type) && !hasImage) {
    const message = `${prefix} 图像步骤需要 Ctrl+V 图片或 ROI 裁剪图`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  if (item.type === "image_click" && !hasImage && (point || hasRoi)) {
    addWarning(`${prefix} 没有图片时会退化为直接点击坐标/ROI，请确认这是有意行为`, item);
  }
  if (item.type === "ocr_assert" && mode === "background") {
    addIssue(`${prefix} OCR 后端尚未实现，请先停用或替换为图像/点击步骤`, item);
  }
  if (item.type === "delay" && durationMsFromText(item.target) == null && item.timeoutMs <= 0) {
    addIssue(`${prefix} 延迟步骤需要有效等待时长`, item);
  }
  if (item.type === "retry_until") {
    const interval = commandValue(item.command, "interval");
    if (interval && durationMsFromText(interval) == null) {
      addIssue(`${prefix} 重试间隔格式应为 800ms 或 1s`, item);
    }
  }
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
  runSelected("dry");
}

function backgroundRunSelected() {
  runSelected("background");
}

function runSelected(mode) {
  const targets = selectedWindows();
  if (!targets.length) {
    setStatus("需要先选择窗口");
    return;
  }
  let launched = 0;
  for (const target of targets) {
    const assignment = assignmentForHwnd(target.hwnd);
    const queuedWorkflows = queueWorkflowsForTarget(target);
    const hasWindowQueue = Boolean(assignment?.queue?.length);
    const source = hasWindowQueue ? "queue" : "active";
    const workflows = hasWindowQueue ? queuedWorkflows : activeWorkflow() ? [activeWorkflow()] : [];
    if (hasWindowQueue) {
      const mismatch = windowIdentityMismatchReason(assignment.windowIdentity, windowIdentityForTarget(target));
      if (mismatch) {
        appendLog("warn", `${target.display} 队列窗口身份不匹配：${mismatch}；请刷新窗口后重新分配任务`);
        continue;
      }
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
    if (startRunForWindow(target, workflows, mode, source)) launched += 1;
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

function startRunForWindow(target, workflows, mode, source) {
  const key = String(target.hwnd);
  const running = state.sessions[key]?.status === "running";
  if (running) {
    appendLog("warn", `${target.display} 已有运行中的会话，同 hwnd 保持互斥`);
    return false;
  }
  const workflowCopies = JSON.parse(JSON.stringify(workflows));
  const enabledStepTotal = workflowCopies.reduce(
    (sum, workflow) => sum + workflow.steps.filter((item) => item.enabled !== false).length,
    0,
  );
  if (!enabledStepTotal) {
    appendLog("warn", `${target.display} 队列没有启用步骤`);
    return false;
  }
  const session = {
    id: `run-${++state.sessionSerial}`,
    mode,
    source,
    hwnd: target.hwnd,
    display: target.display,
    windowIdentity: windowIdentityForTarget(target),
    workflowIds: workflowCopies.map((workflow) => workflow.id),
    workflowNames: workflowCopies.map((workflow) => workflow.name),
    workflowId: workflowCopies[0]?.id || "",
    workflowName: workflowCopies.length === 1 ? workflowCopies[0].name : `${workflowCopies.length} 个任务`,
    currentWorkflowName: "",
    status: "running",
    currentStep: 0,
    totalSteps: enabledStepTotal,
    startedAt: new Date().toISOString(),
    logs: [],
    cancelRequested: false,
  };
  state.sessions[key] = session;
  setRunState("running");
  appendLog("info", `${modeLabel(mode)} 启动：${target.display} -> ${session.workflowNames.join(" / ")}`);
  renderSessions();
  void runSession(session, workflowCopies);
  return true;
}

async function runSession(session, workflows) {
  for (const workflow of workflows) {
    if (session.cancelRequested || session.status === "failed") break;
    session.currentWorkflowName = workflow.name;
    const steps = workflow.steps.filter((item) => item.enabled !== false);
    for (const item of steps) {
      if (session.cancelRequested) break;
      session.currentStep += 1;
      if (session.mode === "background") {
        const result = await executeBackgroundStepWithRetries(session, item).catch((error) => ({
          status: "error",
          action: "backend",
          detail: String(error),
          inputSent: false,
          matched: false,
        }));
        session.logs.unshift(formatStepLog(session.currentStep - 1, workflow, item, result));
        if (shouldStopAfterResult(item, result)) {
          session.cancelRequested = true;
          session.status = "failed";
          break;
        }
      } else {
        session.logs.unshift(
          `${String(session.currentStep).padStart(2, "0")} ${workflow.name} / ${item.name} [${item.type}]`,
        );
        await sleep(dryRunDelay(item));
      }
      renderSessions();
    }
  }
  if (session.status !== "failed") {
    session.status = session.cancelRequested ? "stopped" : "done";
  }
  session.endedAt = new Date().toISOString();
  state.workspace.runHistory.unshift({
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
    windowIdentity: session.windowIdentity,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  });
  state.workspace.runHistory = state.workspace.runHistory.slice(0, 80);
  markDirty("run logged");
  renderSessions();
  const stillRunning = Object.values(state.sessions).some((item) => item.status === "running");
  setRunState(stillRunning ? "running" : "idle");
  appendLog(
    session.status === "done" ? "info" : "warn",
    `${modeLabel(session.mode)} ${session.status}：${session.display}`,
  );
}

async function executeBackgroundStepWithRetries(session, item) {
  const retries = Math.max(0, Math.floor(Number.isFinite(Number(item.retry)) ? Number(item.retry) : 0));
  const attempts = retries + 1;
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await executeBackgroundStep(session, item);
    if (attempts > 1) {
      result = {
        ...result,
        detail: `${result.detail} (attempt ${attempt}/${attempts})`,
      };
    }
    if (!shouldRetryBackgroundStep(item, result) || attempt === attempts) return result;
    await sleep(backgroundRetryDelay(item));
  }
  return result;
}

async function executeBackgroundStep(session, item) {
  if (item.type === "delay") {
    const ms = backgroundStepDelay(item);
    await sleep(ms);
    return {
      status: "ok",
      action: "delay",
      detail: `waited ${ms}ms`,
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
      action: "retry_until",
      detail: `${result.detail}; no image or ROI target is bound, kept as planned state wait`,
    };
  }
  const timeoutMs = Math.max(0, Number(item.timeoutMs) || 0);
  const intervalMs = backgroundRetryDelay(item);
  const deadline = Date.now() + timeoutMs;
  const probe = { ...item, type: "wait_image" };
  let attempt = 0;
  let result = null;
  do {
    attempt += 1;
    result = await executeBackendStep(session, probe);
    if (result.matched || result.status === "matched" || result.status === "sent") {
      return {
        ...result,
        status: "ok",
        action: "retry_until",
        detail: `${result.detail} (ready after ${attempt} attempt${attempt === 1 ? "" : "s"})`,
      };
    }
    if (!["below_threshold", "planned"].includes(result.status)) return result;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
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

function retryUntilHasVisualTarget(item) {
  const targetItem = targetForStep(item);
  return Boolean(targetItem?.dataUrl || targetItem?.roi || parsePointText(item.target) || parsePointText(item.command));
}

function shouldRetryBackgroundStep(item, result) {
  if (result.status !== "below_threshold") return false;
  return item.onFail === "retry" || ["wait_image", "detect_page", "image_click"].includes(item.type);
}

function backgroundRetryDelay(item) {
  return Math.max(50, durationMsFromText(commandValue(item.command, "interval")) ?? 300);
}

function backgroundStepDelay(item) {
  return Math.max(0, durationMsFromText(item.target) ?? item.timeoutMs ?? 0);
}

async function executeBackendStep(session, item) {
  const payload = backendStepPayload(item);
  return invoke("execute_workflow_step", {
    hwnd: Number(session.hwnd),
    step: payload,
    expectedWindow: session.windowIdentity || null,
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
  const targetItem = targetForStep(item);
  const targetId = stepTargetId(item);
  const command = effectiveCommandForStep(item, targetItem);
  return {
    type: item.type,
    target: item.target || "",
    command,
    expect: item.expect || "",
    targetId,
    targetKind: targetItem?.kind || "",
    targetDataUrl: targetItem?.dataUrl || "",
    assetId: targetId,
    assetKind: targetItem?.kind || "",
    assetDataUrl: targetItem?.dataUrl || "",
    roi: targetItem?.roi || null,
  };
}

function effectiveCommandForStep(item, targetItem = targetForStep(item)) {
  if (!targetItem) return item.command || "";
  const defaults = targetCommandDefaults(targetItem, item.command);
  if (["image_click", "wait_image", "detect_page"].includes(item.type)) {
    return commandWithMissingValues(item.command, defaults);
  }
  if (item.type === "click") {
    return commandWithMissingValues(item.command, {
      button: defaults.button,
      mode: "hwnd-message",
    });
  }
  return item.command || "";
}

function formatStepLog(index, workflow, item, result) {
  const point = result.x != null && result.y != null ? ` @${result.x},${result.y}` : "";
  const score = result.score != null ? ` score=${Number(result.score).toFixed(3)}` : "";
  const sent = result.inputSent ? " sent" : "";
  return `${String(index + 1).padStart(2, "0")} ${workflow.name} / ${item.name} [${item.type}] ${result.status}/${result.action}${point}${score}${sent} · ${result.detail}`;
}

function shouldStopAfterResult(item, result) {
  if (result.status === "error") return true;
  if (["unsupported", "missing_asset", "below_threshold"].includes(result.status)) {
    return ["stop", "restore"].includes(item.onFail || "stop");
  }
  return false;
}

function modeLabel(mode) {
  return mode === "background" ? "后台运行" : "观察运行";
}

function dryRunDelay(item) {
  if (item.type === "delay") return Math.max(120, Math.min(480, durationMsFromText(item.target) ?? item.timeoutMs ?? 200));
  return Math.max(90, Math.min(260, Math.round((item.timeoutMs || 1000) / 24)));
}

function stopDryRun() {
  let count = 0;
  for (const session of Object.values(state.sessions)) {
    if (session.status === "running") {
      session.cancelRequested = true;
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
    return;
  }
  for (const session of sessions) {
    const lane = document.createElement("div");
    lane.className = `session-lane ${session.status}`;
    lane.innerHTML = `
      <div>
        <strong>${escapeHtml(session.display)}</strong>
        <span>${escapeHtml(modeLabel(session.mode))} · ${escapeHtml(session.workflowName)} · ${session.currentStep}/${session.totalSteps}</span>
      </div>
      <progress max="${session.totalSteps}" value="${session.currentStep}"></progress>
      <small>${escapeHtml(session.status)} · ${escapeHtml(session.currentWorkflowName || "等待")} · hwnd=${escapeHtml(session.hwnd)}</small>
    `;
    if (session.logs.length) {
      const latest = document.createElement("small");
      latest.textContent = session.logs[0];
      lane.append(latest);
    }
    lanes.append(lane);
  }
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
    state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
    markDirty("imported");
    await saveWorkspaceNow();
    renderAll();
    setStatus("工作区 JSON 已载入");
  } catch (error) {
    setStatus(`工作区 JSON 载入失败：${error.message}`);
    appendLog("error", `工作区 JSON 载入失败：${error.message}`);
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

$("#refresh-windows").addEventListener("click", refreshWindows);
$("#launch-game-client").addEventListener("click", launchGameClient);
$("#select-game-windows").addEventListener("click", selectGameWindows);
$("#restart-admin").addEventListener("click", restartAsAdmin);
$("#save-workspace").addEventListener("click", () => saveWorkspaceNow());
$("#capture-preview").addEventListener("click", capturePreview);
$("#save-snapshot").addEventListener("click", saveSnapshot);
$("#load-offline-image").addEventListener("click", loadOfflineImage);
$("#target-from-roi").addEventListener("click", targetFromRoi);
$("#assign-selected").addEventListener("click", assignWorkflowToSelected);
$("#new-workflow").addEventListener("click", newWorkflow);
$("#duplicate-workflow").addEventListener("click", duplicateWorkflow);
$("#delete-workflow").addEventListener("click", deleteWorkflow);
$("#add-step").addEventListener("click", addStep);
$("#insert-step-below").addEventListener("click", insertStepBelowSelected);
$("#duplicate-step").addEventListener("click", duplicateSelectedStep);
$("#insert-step-block").addEventListener("click", insertStepBlock);
$("#move-step-up").addEventListener("click", () => moveSelectedStep(-1));
$("#move-step-down").addEventListener("click", () => moveSelectedStep(1));
$("#delete-step").addEventListener("click", deleteSelectedStep);
$("#validate-workflow").addEventListener("click", validateActiveWorkflow);
$("#validate-all-workflows").addEventListener("click", validateAllWorkflows);
$("#dry-run-selected").addEventListener("click", dryRunSelected);
$("#background-run-selected").addEventListener("click", backgroundRunSelected);
$("#stop-dry-run").addEventListener("click", stopDryRun);
$("#export-workspace").addEventListener("click", exportWorkspace);
$("#import-workspace").addEventListener("click", importWorkspace);
$("#preview-image").addEventListener("mousedown", startRoiDrag);
window.addEventListener("mousemove", moveRoiDrag);
window.addEventListener("mouseup", endRoiDrag);
window.addEventListener("resize", updateRoiBox);
window.addEventListener("paste", handlePasteImage);

bindWorkflowInputs();
bindStepEditor();
bindStepParamEditor();
bindTargetEditor();
appendLog("info", "本地任务模型初始化中");
await setupCloseToTray();
await loadWorkspace();
state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
renderAll();
await refreshPrivilege();
await refreshGameLaunchStatus();
await refreshWindows();
