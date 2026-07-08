import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

const TARGET_TITLE = "梦幻西游：时空";

const stepDefaults = {
  detect_page: { name: "检测页面", timeoutMs: 3000, retry: 2, onFail: "stop" },
  image_click: { name: "图片点击", timeoutMs: 2500, retry: 1, onFail: "retry" },
  mouse_move: { name: "鼠标移动", timeoutMs: 1000, retry: 0, onFail: "skip" },
  hotkey: { name: "快捷键", timeoutMs: 1200, retry: 0, onFail: "stop" },
  restore: { name: "恢复状态", timeoutMs: 5000, retry: 1, onFail: "stop" },
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
  workflow: {
    id: "local-draft",
    name: "新任务",
    description: "",
    initialCheck: "detect_page",
    restorePolicy: "none",
    steps: [],
  },
  selectedStepId: null,
};

const $ = (selector) => document.querySelector(selector);

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

function activeWindow() {
  return state.windows.find((item) => String(item.hwnd) === String(state.activeHwnd)) || null;
}

function selectedWindows() {
  return state.windows.filter((item) => state.selected.has(String(item.hwnd)));
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
  if (state.activeHwnd) {
    state.selected.add(String(state.activeHwnd));
  }

  renderWindows();
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
      capturePreview();
    });

    const body = document.createElement("span");
    const privilege = item.elevated === true ? "管理员" : item.elevated === false ? "普通" : "未知";
    body.innerHTML = `
      <strong>${escapeHtml(item.display)}</strong>
      <small>${escapeHtml(item.processName || "-")} · ${escapeHtml(item.clientWidth)}x${escapeHtml(item.clientHeight)} · ${privilege}</small>
    `;
    body.addEventListener("click", (event) => {
      event.preventDefault();
      state.activeHwnd = item.hwnd;
      state.selected.add(String(item.hwnd));
      renderWindows();
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
  capturePreview();
  setStatus(`已选择 ${state.selected.size} 个窗口`);
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

async function focusWindow() {
  const target = activeWindow();
  if (!target) {
    setStatus("需要先选择窗口");
    return;
  }
  try {
    await invoke("focus_window", { hwnd: Number(target.hwnd) });
    setStatus(`已置前：${target.display}`);
  } catch (error) {
    setStatus(`置前失败：${error}`);
    appendLog("error", `置前失败：${error}`);
  }
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

function syncWorkflowForm() {
  $("#flow-name").value = state.workflow.name;
  $("#flow-description").value = state.workflow.description || "";
  $("#initial-check").value = state.workflow.initialCheck || "";
  $("#restore-policy").value = state.workflow.restorePolicy || "none";
}

function bindWorkflowInputs() {
  $("#flow-name").addEventListener("input", (event) => {
    state.workflow.name = event.target.value;
    markDraft();
  });
  $("#flow-description").addEventListener("input", (event) => {
    state.workflow.description = event.target.value;
    markDraft();
  });
  $("#initial-check").addEventListener("input", (event) => {
    state.workflow.initialCheck = event.target.value;
    markDraft();
  });
  $("#restore-policy").addEventListener("change", (event) => {
    state.workflow.restorePolicy = event.target.value;
    markDraft();
  });
}

function markDraft() {
  $("#task-model-state").textContent = "draft";
  $("#task-model-state").classList.remove("ok");
  setRunState("idle");
}

function addStep() {
  const type = $("#new-step-type").value;
  const step = createStep(type);
  state.workflow.steps.push(step);
  state.selectedStepId = step.id;
  renderSteps();
  renderStepEditor();
  markDraft();
  appendLog("info", `添加步骤：${step.name}`);
}

function createStep(type) {
  const defaults = stepDefaults[type] || stepDefaults.detect_page;
  return {
    id: randomId("step"),
    name: defaults.name,
    type,
    target: "",
    timeoutMs: defaults.timeoutMs,
    retry: defaults.retry,
    onFail: defaults.onFail,
  };
}

function renderSteps() {
  $("#step-count").textContent = String(state.workflow.steps.length);
  const list = $("#step-list");
  list.replaceChildren();

  if (!state.workflow.steps.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block";
    empty.textContent = "暂无步骤";
    list.append(empty);
    return;
  }

  state.workflow.steps.forEach((step, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "step-row";
    row.classList.toggle("active", step.id === state.selectedStepId);
    row.innerHTML = `
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(step.name || step.type)}</strong>
      <small>${escapeHtml(step.type)} · ${escapeHtml(step.target || "target: none")}</small>
    `;
    row.addEventListener("click", () => {
      state.selectedStepId = step.id;
      renderSteps();
      renderStepEditor();
    });
    list.append(row);
  });
}

function selectedStep() {
  return state.workflow.steps.find((step) => step.id === state.selectedStepId) || null;
}

function renderStepEditor() {
  const step = selectedStep();
  $("#step-editor-empty").hidden = Boolean(step);
  $("#step-editor").hidden = !step;
  if (!step) return;
  $("#step-name").value = step.name || "";
  $("#step-type").value = step.type;
  $("#step-target").value = step.target || "";
  $("#step-timeout").value = String(step.timeoutMs ?? 0);
  $("#step-retry").value = String(step.retry ?? 0);
  $("#step-on-fail").value = step.onFail || "stop";
}

function bindStepEditor() {
  const update = (field, coerce = (value) => value) => (event) => {
    const step = selectedStep();
    if (!step) return;
    step[field] = coerce(event.target.value);
    renderSteps();
    markDraft();
  };
  $("#step-name").addEventListener("input", update("name"));
  $("#step-type").addEventListener("change", update("type"));
  $("#step-target").addEventListener("input", update("target"));
  $("#step-timeout").addEventListener("input", update("timeoutMs", (value) => Number(value) || 0));
  $("#step-retry").addEventListener("input", update("retry", (value) => Number(value) || 0));
  $("#step-on-fail").addEventListener("change", update("onFail"));
}

function moveSelectedStep(direction) {
  const index = state.workflow.steps.findIndex((step) => step.id === state.selectedStepId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= state.workflow.steps.length) return;
  const steps = state.workflow.steps;
  [steps[index], steps[next]] = [steps[next], steps[index]];
  renderSteps();
  renderStepEditor();
  markDraft();
}

function deleteSelectedStep() {
  const index = state.workflow.steps.findIndex((step) => step.id === state.selectedStepId);
  if (index < 0) return;
  const [removed] = state.workflow.steps.splice(index, 1);
  state.selectedStepId = state.workflow.steps[Math.min(index, state.workflow.steps.length - 1)]?.id || null;
  renderSteps();
  renderStepEditor();
  markDraft();
  appendLog("info", `删除步骤：${removed.name || removed.type}`);
}

function exportWorkflow() {
  const json = JSON.stringify(state.workflow, null, 2);
  $("#workflow-json").value = json;
  navigator.clipboard?.writeText(json).catch(() => {});
  $("#task-model-state").textContent = "exported";
  $("#task-model-state").classList.add("ok");
  setStatus("任务定义已导出");
}

function importWorkflow() {
  try {
    const parsed = JSON.parse($("#workflow-json").value);
    state.workflow = normalizeWorkflow(parsed);
    state.selectedStepId = state.workflow.steps[0]?.id || null;
    syncWorkflowForm();
    renderSteps();
    renderStepEditor();
    markDraft();
    setStatus("任务定义已载入");
    appendLog("info", `载入任务定义：${state.workflow.name}`);
  } catch (error) {
    setStatus(`JSON 载入失败：${error.message}`);
    appendLog("error", `JSON 载入失败：${error.message}`);
  }
}

function normalizeWorkflow(value) {
  const steps = Array.isArray(value?.steps) ? value.steps : [];
  return {
    id: String(value?.id || randomId("task")),
    name: String(value?.name || "未命名任务"),
    description: String(value?.description || ""),
    initialCheck: String(value?.initialCheck || ""),
    restorePolicy: String(value?.restorePolicy || "none"),
    steps: steps.map((step) => ({
      id: String(step?.id || randomId("step")),
      name: String(step?.name || stepDefaults[step?.type]?.name || "步骤"),
      type: String(step?.type || "detect_page"),
      target: String(step?.target || ""),
      timeoutMs: Number(step?.timeoutMs ?? 3000),
      retry: Number(step?.retry ?? 0),
      onFail: String(step?.onFail || "stop"),
    })),
  };
}

function validateWorkflow() {
  const issues = [];
  if (!state.workflow.name.trim()) issues.push("任务名称为空");
  if (!state.workflow.steps.length) issues.push("步骤为空");
  for (const [index, step] of state.workflow.steps.entries()) {
    if (!step.name.trim()) issues.push(`第 ${index + 1} 步名称为空`);
    if (!step.type.trim()) issues.push(`第 ${index + 1} 步类型为空`);
    if (step.timeoutMs < 0) issues.push(`第 ${index + 1} 步超时不能为负数`);
    if (step.retry < 0) issues.push(`第 ${index + 1} 步重试不能为负数`);
  }

  if (issues.length) {
    $("#task-model-state").textContent = "invalid";
    $("#task-model-state").classList.remove("ok");
    setRunState("blocked");
    $("#run-summary").textContent = issues.join(" / ");
    appendLog("warn", `定义校验未通过：${issues.join("；")}`);
    setStatus("任务定义需要补全");
    return;
  }

  $("#task-model-state").textContent = "ready";
  $("#task-model-state").classList.add("ok");
  setRunState("ready");
  $("#run-summary").textContent = `${state.workflow.name} · ${state.workflow.steps.length} 步 · ${state.workflow.restorePolicy}`;
  appendLog("info", `定义校验通过：${state.workflow.steps.length} 步`);
  setStatus("任务定义可导出");
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

$("#refresh-windows").addEventListener("click", refreshWindows);
$("#launch-game-client").addEventListener("click", launchGameClient);
$("#select-game-windows").addEventListener("click", selectGameWindows);
$("#restart-admin").addEventListener("click", restartAsAdmin);
$("#focus-window").addEventListener("click", focusWindow);
$("#capture-preview").addEventListener("click", capturePreview);
$("#save-snapshot").addEventListener("click", saveSnapshot);
$("#load-offline-image").addEventListener("click", loadOfflineImage);
$("#preview-image").addEventListener("mousedown", startRoiDrag);
window.addEventListener("mousemove", moveRoiDrag);
window.addEventListener("mouseup", endRoiDrag);
window.addEventListener("resize", updateRoiBox);
$("#add-step").addEventListener("click", addStep);
$("#validate-workflow").addEventListener("click", validateWorkflow);
$("#export-workflow").addEventListener("click", exportWorkflow);
$("#import-workflow").addEventListener("click", importWorkflow);
$("#move-step-up").addEventListener("click", () => moveSelectedStep(-1));
$("#move-step-down").addEventListener("click", () => moveSelectedStep(1));
$("#delete-step").addEventListener("click", deleteSelectedStep);

bindWorkflowInputs();
bindStepEditor();
syncWorkflowForm();
renderSteps();
renderStepEditor();
appendLog("info", "本地任务模型已初始化");
await refreshPrivilege();
await refreshGameLaunchStatus();
await refreshWindows();
