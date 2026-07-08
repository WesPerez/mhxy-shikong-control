import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

const TARGET_TITLE = "梦幻西游：时空";
const WORKSPACE_SCHEMA_VERSION = 2;

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
  ["paste_image", "粘贴图片"],
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
  paste_image: {
    name: "粘贴图片",
    target: "asset.clipboard",
    command: "Ctrl+V creates asset",
    expect: "asset.bound",
    timeoutMs: 500,
    retry: 0,
    onFail: "skip",
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
  workspaceLoadedFromDisk: false,
  selectedStepId: null,
  selectedAssetId: null,
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
  $("#run-state").textContent = value;
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
  $("#run-log").prepend(row);
}

function createSeedWorkspace() {
  const workflows = createSampleWorkflows();
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeWorkflowId: workflows[0]?.id || null,
    workflows,
    assignments: {},
    assets: [],
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
      step("realm-09", "paste_image", "绑定材料样图", "asset.realm_material", "Ctrl+V creates asset", "asset.bound"),
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
    state.workspaceLoadedFromDisk = result.existed;
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
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeWorkflowId,
    workflows,
    assignments:
      source.assignments && typeof source.assignments === "object" && !Array.isArray(source.assignments)
        ? source.assignments
        : {},
    assets: Array.isArray(source.assets) ? source.assets.map(normalizeAsset) : [],
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
    assetId: value?.assetId ? String(value.assetId) : "",
    notes: String(value?.notes || ""),
  };
}

function normalizeAsset(value) {
  return {
    id: String(value?.id || randomId("asset")),
    name: String(value?.name || "未命名目标"),
    kind: String(value?.kind || "unknown"),
    createdAt: String(value?.createdAt || new Date().toISOString()),
    dataUrl: value?.dataUrl ? String(value.dataUrl) : "",
    roi: value?.roi || null,
    source: value?.source || null,
    width: Number(value?.width || 0),
    height: Number(value?.height || 0),
    note: String(value?.note || ""),
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

function renderAll() {
  renderWorkflowList();
  renderWorkflowForm();
  renderSteps();
  renderStepEditor();
  renderAssets();
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
    if (assignment.workflowId === workflow.id) delete state.workspace.assignments[hwnd];
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

function renderSteps() {
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
  workflow.steps.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "step-row";
    row.classList.toggle("active", item.id === state.selectedStepId);
    row.innerHTML = `
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(item.name || stepLabels[item.type] || item.type)}</strong>
      <small>${escapeHtml(stepLabels[item.type] || item.type)} · ${escapeHtml(item.target || "target: none")}</small>
    `;
    row.addEventListener("click", () => {
      state.selectedStepId = item.id;
      renderSteps();
      renderStepEditor();
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

function addStep() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  const item = createStep($("#new-step-type").value);
  workflow.steps.push(item);
  state.selectedStepId = item.id;
  markDirty("draft");
  renderSteps();
  renderStepEditor();
  appendLog("info", `添加步骤：${item.name}`);
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
  appendLog("info", `删除步骤：${removed.name}`);
}

function renderStepEditor() {
  const item = selectedStep();
  $("#step-editor-empty").hidden = Boolean(item);
  $("#step-editor").hidden = !item;
  if (!item) return;
  $("#step-name").value = item.name || "";
  $("#step-type").value = item.type;
  $("#step-target").value = item.target || "";
  $("#step-command").value = item.command || "";
  $("#step-expect").value = item.expect || "";
  $("#step-timeout").value = String(item.timeoutMs ?? 0);
  $("#step-retry").value = String(item.retry ?? 0);
  $("#step-on-fail").value = item.onFail || "stop";
  $("#step-on-success").value = item.onSuccess || "next";
  $("#step-notes").value = item.notes || "";
}

function bindStepEditor() {
  const update = (field, coerce = (value) => value) => (event) => {
    const item = selectedStep();
    if (!item) return;
    item[field] = coerce(event.target.value);
    markDirty("draft");
    renderSteps();
  };
  $("#step-name").addEventListener("input", update("name"));
  $("#step-target").addEventListener("input", update("target"));
  $("#step-command").addEventListener("input", update("command"));
  $("#step-expect").addEventListener("input", update("expect"));
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
    markDirty("draft");
    renderSteps();
    renderStepEditor();
  });
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
    const assignedName = workflowById(assigned?.workflowId)?.name || "未分配";
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
    state.workspace.assignments[String(target.hwnd)] = {
      workflowId: workflow.id,
      hwnd: target.hwnd,
      title: target.title,
      processId: target.processId,
      display: target.display,
      assignedAt: new Date().toISOString(),
    };
  }
  markDirty("assigned");
  renderWindows();
  renderAssignments();
  setStatus(`已把 ${workflow.name} 分配给 ${targets.length} 个窗口`);
}

function renderAssignments() {
  const list = $("#assignment-list");
  list.replaceChildren();
  const entries = Object.entries(state.workspace.assignments || {});
  $("#assignment-count").textContent = String(entries.length);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "还没有窗口分配";
    list.append(empty);
    return;
  }
  for (const [hwnd, assignment] of entries) {
    const workflow = workflowById(assignment.workflowId);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "compact-row";
    row.innerHTML = `
      <strong>${escapeHtml(assignment.display || hwnd)}</strong>
      <span>${escapeHtml(workflow?.name || "任务已删除")} · hwnd=${escapeHtml(hwnd)}</span>
    `;
    row.addEventListener("click", () => {
      state.activeHwnd = hwnd;
      state.selected.add(String(hwnd));
      if (workflow) state.workspace.activeWorkflowId = workflow.id;
      renderAll();
      capturePreview();
    });
    list.append(row);
  }
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

async function assetFromRoi() {
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
  const asset = {
    id: randomId("asset"),
    name: `ROI ${roiText(roi)}`,
    kind: "roi",
    createdAt: new Date().toISOString(),
    dataUrl,
    roi,
    source: {
      type: state.previewSource,
      hwnd: target?.hwnd || null,
      display: target?.display || "",
    },
    width: state.preview.width,
    height: state.preview.height,
    note: "由预览框选生成",
  };
  state.workspace.assets.unshift(asset);
  bindAssetToSelectedStep(asset);
  markDirty("asset");
  renderAssets();
  renderStepEditor();
  setStatus(`已保存 ROI 目标：${asset.name}`);
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
  if (!item) return;
  event.preventDefault();
  const file = item.getAsFile();
  if (!file) return;
  const dataUrl = await readBlobAsDataUrl(file);
  const size = await imageSize(dataUrl).catch(() => ({ width: 0, height: 0 }));
  const asset = {
    id: randomId("asset"),
    name: `粘贴图片 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
    kind: "clipboard-image",
    createdAt: new Date().toISOString(),
    dataUrl,
    width: size.width,
    height: size.height,
    note: "由 Ctrl+V 粘贴创建",
  };
  state.workspace.assets.unshift(asset);
  bindAssetToSelectedStep(asset);
  markDirty("asset");
  renderAssets();
  renderSteps();
  renderStepEditor();
  appendLog("info", `已粘贴图片目标：${asset.name}`);
}

function bindAssetToSelectedStep(asset) {
  const item = selectedStep();
  if (!item) return;
  item.assetId = asset.id;
  item.target = asset.id;
  if (!["image_click", "wait_image", "detect_page"].includes(item.type)) {
    item.type = "image_click";
    item.name = "图像点击";
    item.command = "button=left; point=center";
    item.expect = "screen.changed";
  }
}

function renderAssets() {
  $("#asset-count").textContent = String(state.workspace.assets.length);
  const list = $("#asset-list");
  list.replaceChildren();
  if (!state.workspace.assets.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "暂无识别目标";
    list.append(empty);
    return;
  }
  for (const asset of state.workspace.assets) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "compact-row asset-row";
    const thumb = asset.dataUrl ? `<img src="${asset.dataUrl}" alt="${escapeHtml(asset.name)}" />` : "<i>ROI</i>";
    row.innerHTML = `
      ${thumb}
      <span>
        <strong>${escapeHtml(asset.name)}</strong>
        <small>${escapeHtml(asset.kind)} · ${asset.width || "-"}x${asset.height || "-"}</small>
      </span>
    `;
    row.addEventListener("click", () => {
      state.selectedAssetId = asset.id;
      bindAssetToSelectedStep(asset);
      markDirty("asset");
      renderAssets();
      renderSteps();
      renderStepEditor();
      setStatus(`已绑定目标：${asset.name}`);
    });
    list.append(row);
  }
}

function validateWorkflow(workflow = activeWorkflow()) {
  const issues = [];
  const warnings = [];
  if (!workflow) issues.push("没有当前任务");
  if (workflow && !workflow.name.trim()) issues.push("任务名称为空");
  if (workflow && workflow.steps.length === 0) issues.push("步骤为空");
  if (workflow && workflow.steps.length > 0 && workflow.steps.length < 10) {
    warnings.push("少于 10 步，作为完整样例覆盖不足");
  }
  for (const [index, item] of workflow?.steps.entries() || []) {
    const prefix = `第 ${index + 1} 步`;
    if (!stepLabels[item.type]) issues.push(`${prefix} 类型未知`);
    if (!item.name.trim()) issues.push(`${prefix} 名称为空`);
    if (!item.target.trim() && !["delay", "snapshot"].includes(item.type)) {
      issues.push(`${prefix} 缺少目标`);
    }
    if (item.timeoutMs < 0) issues.push(`${prefix} 超时不能为负数`);
    if (item.retry < 0) issues.push(`${prefix} 重试不能为负数`);
    if (item.type === "hotkey" && !/[+]/.test(item.target)) warnings.push(`${prefix} 快捷键建议使用 ALT+N 这类组合格式`);
    if (item.type === "paste_image" && !item.assetId && item.target === "asset.clipboard") {
      warnings.push(`${prefix} 尚未绑定粘贴图片资产`);
    }
  }
  return { issues, warnings };
}

function validateActiveWorkflow() {
  const workflow = activeWorkflow();
  const result = validateWorkflow(workflow);
  if (result.issues.length) {
    $("#task-model-state").textContent = "invalid";
    $("#task-model-state").classList.remove("ok");
    setRunState("blocked");
    $("#run-summary").textContent = result.issues.join(" / ");
    appendLog("warn", `定义校验未通过：${result.issues.join("；")}`);
    setStatus("任务定义需要补全");
    return false;
  }
  $("#task-model-state").textContent = result.warnings.length ? "ready with warnings" : "ready";
  $("#task-model-state").classList.add("ok");
  setRunState("ready");
  $("#run-summary").textContent = `${workflow.name} · ${workflow.steps.length} 步 · ${result.warnings.join(" / ") || "可 dry-run"}`;
  appendLog("info", `定义校验通过：${workflow.steps.length} 步`);
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
  const workflow = activeWorkflow();
  const targets = selectedWindows();
  if (!workflow || !targets.length) {
    setStatus("需要先选择任务和窗口");
    return;
  }
  if (!validateActiveWorkflow()) return;
  for (const target of targets) {
    startRunForWindow(target, workflow, mode);
  }
}

function startRunForWindow(target, workflow, mode) {
  const key = String(target.hwnd);
  const running = state.sessions[key]?.status === "running";
  if (running) {
    appendLog("warn", `${target.display} 已有运行中的会话，同 hwnd 保持互斥`);
    return;
  }
  const session = {
    id: `run-${++state.sessionSerial}`,
    mode,
    hwnd: target.hwnd,
    display: target.display,
    processId: target.processId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "running",
    currentStep: 0,
    totalSteps: workflow.steps.length,
    startedAt: new Date().toISOString(),
    logs: [],
    cancelRequested: false,
  };
  state.sessions[key] = session;
  setRunState("running");
  appendLog("info", `${modeLabel(mode)} 启动：${target.display} -> ${workflow.name}`);
  renderSessions();
  void runSession(session, JSON.parse(JSON.stringify(workflow)));
}

async function runSession(session, workflow) {
  for (const [index, item] of workflow.steps.entries()) {
    if (session.cancelRequested) break;
    session.currentStep = index + 1;
    if (session.mode === "background") {
      const result = await executeBackendStep(session, item).catch((error) => ({
        status: "error",
        action: "backend",
        detail: String(error),
        inputSent: false,
        matched: false,
      }));
      session.logs.unshift(formatStepLog(index, item, result));
      if (shouldStopAfterResult(item, result)) {
        session.cancelRequested = true;
        session.status = "failed";
        break;
      }
    } else {
      session.logs.unshift(`${String(index + 1).padStart(2, "0")} ${item.name} [${item.type}]`);
      await sleep(dryRunDelay(item));
    }
    renderSessions();
  }
  if (session.status !== "failed") {
    session.status = session.cancelRequested ? "stopped" : "done";
  }
  session.endedAt = new Date().toISOString();
  state.workspace.runHistory.unshift({
    id: session.id,
    mode: session.mode,
    hwnd: session.hwnd,
    display: session.display,
    workflowId: session.workflowId,
    workflowName: session.workflowName,
    status: session.status,
    totalSteps: session.totalSteps,
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

async function executeBackendStep(session, item) {
  const payload = backendStepPayload(item);
  return invoke("execute_workflow_step", {
    hwnd: Number(session.hwnd),
    step: payload,
  });
}

function backendStepPayload(item) {
  const asset = item.assetId ? state.workspace.assets.find((entry) => entry.id === item.assetId) : null;
  return {
    type: item.type,
    target: item.target || "",
    command: item.command || "",
    expect: item.expect || "",
    assetId: item.assetId || "",
    assetKind: asset?.kind || "",
    assetDataUrl: asset?.dataUrl || "",
    roi: asset?.roi || null,
  };
}

function formatStepLog(index, item, result) {
  const point = result.x != null && result.y != null ? ` @${result.x},${result.y}` : "";
  const score = result.score != null ? ` score=${Number(result.score).toFixed(3)}` : "";
  const sent = result.inputSent ? " sent" : "";
  return `${String(index + 1).padStart(2, "0")} ${item.name} [${item.type}] ${result.status}/${result.action}${point}${score}${sent} · ${result.detail}`;
}

function shouldStopAfterResult(item, result) {
  if (result.status === "error") return true;
  if (["unsupported", "missing_asset", "below_threshold"].includes(result.status)) {
    return ["stop", "restore"].includes(item.onFail || "stop");
  }
  return false;
}

function modeLabel(mode) {
  return mode === "background" ? "后台运行" : "dry-run";
}

function dryRunDelay(item) {
  if (item.type === "delay") return Math.max(120, Math.min(480, Number.parseInt(item.target) || item.timeoutMs || 200));
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
      <small>${escapeHtml(session.status)} · hwnd=${escapeHtml(session.hwnd)}</small>
    `;
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

$("#refresh-windows").addEventListener("click", refreshWindows);
$("#launch-game-client").addEventListener("click", launchGameClient);
$("#select-game-windows").addEventListener("click", selectGameWindows);
$("#restart-admin").addEventListener("click", restartAsAdmin);
$("#save-workspace").addEventListener("click", () => saveWorkspaceNow());
$("#capture-preview").addEventListener("click", capturePreview);
$("#save-snapshot").addEventListener("click", saveSnapshot);
$("#load-offline-image").addEventListener("click", loadOfflineImage);
$("#asset-from-roi").addEventListener("click", assetFromRoi);
$("#assign-selected").addEventListener("click", assignWorkflowToSelected);
$("#new-workflow").addEventListener("click", newWorkflow);
$("#duplicate-workflow").addEventListener("click", duplicateWorkflow);
$("#delete-workflow").addEventListener("click", deleteWorkflow);
$("#add-step").addEventListener("click", addStep);
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
appendLog("info", "本地任务模型初始化中");
await setupCloseToTray();
await loadWorkspace();
state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
renderAll();
await refreshPrivilege();
await refreshGameLaunchStatus();
await refreshWindows();
