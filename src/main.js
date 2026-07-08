import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

const state = {
  windows: [],
  selected: new Set(),
  activeHwnd: null,
  inventory: null,
  selectedTemplate: null,
  selectedTaskId: null,
  optionValues: {},
  templateRows: [],
  privilege: null,
  launchStatus: null,
  ocr: null,
  currentRunIds: new Set(),
  currentRunsByHwnd: new Map(),
  cancelPreset: false,
  preview: null,
  previewSource: "window",
  offlineImagePath: "",
  roiSelection: null,
  roiDragStart: null,
  coverageReport: null,
  compatReport: null,
  migrationStatus: null,
  liveAcceptance: null,
  acceptancePlan: null,
  selectedRuntimeMissingTemplate: null,
  runtimeMissingReference: null,
  runtimeMissingCandidate: null,
  activeToolPanel: "migration",
};

const $ = (selector) => document.querySelector(selector);

function setStatus(message) {
  $("#status").textContent = message;
}

function createRunId(target, task) {
  const random =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${target.hwnd}-${task.entry}-${random}`;
}

function activeWindow() {
  return state.windows.find((item) => String(item.hwnd) === String(state.activeHwnd)) || null;
}

async function refreshWindows() {
  setStatus("正在扫描窗口...");
  await refreshPrivilege();
  state.windows = await invoke("list_game_windows", { titleNeedle: "梦幻西游：时空" });
  const live = new Set(state.windows.map((item) => String(item.hwnd)));
  state.selected = new Set([...state.selected].filter((hwnd) => live.has(hwnd)));
  if (!state.activeHwnd || !live.has(String(state.activeHwnd))) {
    state.activeHwnd = state.selected.values().next().value || state.windows[0]?.hwnd || null;
  }
  renderWindows();
  renderTabs();
  await capturePreview();
  const elevatedTargets = state.windows.filter((item) => item.elevated === true).length;
  if (elevatedTargets > 0 && state.privilege?.currentProcessElevated === false) {
    setStatus(`找到 ${state.windows.length} 个时空窗口，其中 ${elevatedTargets} 个是管理员权限；请用管理员权限启动接管台`);
  } else {
    setStatus(`找到 ${state.windows.length} 个时空窗口`);
  }
}

async function refreshPrivilege() {
  state.privilege = await invoke("privilege_status");
  $("#restart-admin").disabled = state.privilege.currentProcessElevated;
  $("#restart-admin").title = state.privilege.currentProcessElevated
    ? "当前已是管理员权限"
    : "用 UAC 重新启动接管台";
}

async function refreshGameLaunchStatus() {
  const button = $("#launch-game-client");
  const label = $("#launch-status");
  try {
    state.launchStatus = await invoke("game_launch_status");
    button.disabled = !state.launchStatus.configured;
    button.title = state.launchStatus.message;
    label.textContent = state.launchStatus.configured
      ? `启动配置有效：${state.launchStatus.source}`
      : "未配置客户端启动路径";
    label.title = state.launchStatus.message;
  } catch (error) {
    state.launchStatus = null;
    button.disabled = true;
    button.title = `读取启动配置失败：${error}`;
    label.textContent = "启动配置读取失败";
    label.title = String(error);
  }
}

async function restartAsAdmin() {
  try {
    await invoke("restart_as_admin");
    setStatus("已请求管理员权限重启；新窗口启动后可关闭当前接管台");
  } catch (error) {
    setStatus(`管理员重启失败：${error}`);
  }
}

async function launchGameClient() {
  try {
    await refreshGameLaunchStatus();
    const result = await invoke("launch_game_client");
    setStatus(`已启动客户端 pid=${result.pid}；稍后刷新窗口列表`);
    window.setTimeout(() => {
      refreshWindows();
    }, 3000);
  } catch (error) {
    setStatus(`启动客户端失败：${error}`);
  } finally {
    await refreshGameLaunchStatus();
  }
}

function renderWindows() {
  $("#window-count").textContent = String(state.windows.length);
  const list = $("#window-list");
  list.replaceChildren();
  if (!state.windows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-row";
    empty.textContent = "未找到标题包含“梦幻西游：时空”的窗口";
    list.append(empty);
    return;
  }
  for (const item of state.windows) {
    const row = document.createElement("label");
    row.className = "window-row";
    if (String(item.hwnd) === String(state.activeHwnd)) row.classList.add("active");

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
          state.activeHwnd = state.selected.values().next().value || null;
        }
      }
      renderWindows();
      renderTabs();
      capturePreview();
    });

    const text = document.createElement("span");
    const privilege = item.elevated === true ? "管理员" : item.elevated === false ? "普通" : "权限未知";
    text.innerHTML = `<strong>${escapeHtml(item.display)}</strong><small>${item.processName || "-"} · ${item.clientWidth}x${item.clientHeight} · ${privilege}</small>`;
    text.addEventListener("click", (event) => {
      event.preventDefault();
      state.selected.add(String(item.hwnd));
      state.activeHwnd = item.hwnd;
      renderWindows();
      renderTabs();
      capturePreview();
    });

    row.append(checkbox, text);
    list.append(row);
  }
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.replaceChildren();
  const selected = state.windows.filter((item) => state.selected.has(String(item.hwnd)));
  for (const item of selected) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    if (String(item.hwnd) === String(state.activeHwnd)) tab.classList.add("active");
    const activeRun = state.currentRunsByHwnd.get(String(item.hwnd));
    if (activeRun) tab.classList.add("running");
    tab.textContent = activeRun ? `${item.display} · 运行中` : item.display;
    tab.title = activeRun ? activeRun.label : `hwnd=${item.hwnd}`;
    tab.addEventListener("click", () => {
      state.activeHwnd = item.hwnd;
      renderWindows();
      renderTabs();
      capturePreview();
    });
    tabs.append(tab);
  }
}

function renderToolPanels() {
  document.querySelectorAll("[data-tool-tab]").forEach((button) => {
    const active = button.dataset.toolTab === state.activeToolPanel;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-tool-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.toolPanel === state.activeToolPanel);
  });
}

function selectToolPanel(name) {
  state.activeToolPanel = name;
  renderToolPanels();
}

async function capturePreview() {
  const target = activeWindow();
  $("#preview-image").removeAttribute("src");
  $("#preview-empty").style.display = target ? "none" : "grid";
  $("#active-window-meta").textContent = target
    ? `${target.display} · hwnd=${target.hwnd} · client=${target.clientWidth}x${target.clientHeight} · ${privilegeLabel(target)}`
    : "";
  if (!target) return;
  try {
    const preview = await invoke("capture_window_preview", { hwnd: Number(target.hwnd) });
    $("#preview-image").src = preview.dataUrl;
    state.preview = { width: preview.width, height: preview.height };
    state.previewSource = "window";
    state.offlineImagePath = "";
    clearRoiSelection();
    $("#active-window-meta").textContent =
      `${target.display} · ${preview.width}x${preview.height} · hwnd=${target.hwnd} · ${privilegeLabel(target)}`;
    setStatus("窗口预览已刷新");
  } catch (error) {
    setStatus(`预览失败：${error}`);
  }
}

async function loadOfflineImage() {
  const imagePath = $("#offline-image-path").value.trim();
  if (!imagePath) {
    setStatus("需要输入离线截图路径");
    return;
  }
  try {
    const preview = await invoke("import_preview_image", { imagePath, saveCopy: true });
    $("#preview-image").src = preview.dataUrl;
    $("#preview-empty").style.display = "none";
    state.preview = { width: preview.width, height: preview.height };
    state.previewSource = "image";
    state.offlineImagePath = imagePath;
    clearRoiSelection();
    $("#active-window-meta").textContent =
      `离线图 · ${preview.width}x${preview.height}${preview.savedPath ? ` · ${preview.savedPath}` : ""}`;
    setStatus(`已载入离线图：${imagePath}`);
  } catch (error) {
    setStatus(`载入离线图失败：${error}`);
  }
}

async function focusWindow() {
  const target = activeWindow();
  if (!target) return;
  await invoke("focus_window", { hwnd: Number(target.hwnd) });
  setStatus(`已接管 ${target.display}`);
}

async function saveSnapshot() {
  const target = activeWindow();
  if (!target) return;
  const result = await invoke("save_window_snapshot", { hwnd: Number(target.hwnd) });
  setStatus(`已保存截图：${result.savedPath}`);
}

async function refreshInventory() {
  state.inventory = await invoke("load_maa_inventory");
  state.templateRows = state.inventory.templates || [];
  if (!state.selectedTaskId && state.inventory.tasks.length) {
    state.selectedTaskId = state.inventory.tasks[0].id;
  }
  $("#task-count").textContent = String(state.inventory.tasks.length);
  updateTemplateCount();
  renderTasks();
  renderTemplates();
  renderPresets();
  const replaced = state.templateRows.filter((item) => item.replacementPath).length;
  setStatus(`Maa 清单已加载：${state.inventory.tasks.length} 个任务，${state.templateRows.length} 个模板引用，已替换 ${replaced} 个`);
}

async function refreshCoverageReport(showStatus = true) {
  state.coverageReport = await invoke("template_coverage_report");
  renderCoverageReport();
  renderTemplates();
  if (showStatus) {
    const report = state.coverageReport;
    setStatus(
      `覆盖报告：${report.replacedTemplates}/${report.uniqueTemplates} 个唯一模板已替换，${report.unreplacedRefs} 个引用待处理`,
    );
  }
}

async function refreshCompatReport(showStatus = true) {
  state.compatReport = await invoke("pipeline_compat_report");
  renderCompatReport();
  if (showStatus) {
    const report = state.compatReport;
    setStatus(
      `兼容报告：${report.taskEntriesFound}/${report.interfaceTasks} 任务入口，` +
        `${report.issues.length} 类待处理项，${report.missingNodeRefs.length} 个缺失节点引用`,
    );
  }
}

async function refreshMigrationStatus(showStatus = true) {
  try {
    state.migrationStatus = await invoke("migration_status_report");
    renderMigrationStatus();
    await loadRuntimeMissingReference(state.selectedRuntimeMissingTemplate, false);
    if (showStatus) {
      const summary = state.migrationStatus.summary || {};
      setStatus(
        `迁移门禁：${state.migrationStatus.complete ? "已完成" : "未完成"} · ` +
          `运行时 ${summary.runtimeCoveredTemplates || 0}/${summary.uniqueTemplates || 0} · ` +
          `任务可达 ${summary.interfaceRuntimeCoveredTemplates || 0}/${summary.interfaceReachableTemplates || 0}`,
      );
    }
  } catch (error) {
    state.migrationStatus = null;
    renderMigrationStatus();
    clearRuntimeMissingReference("迁移门禁读取失败");
    if (showStatus) setStatus(`迁移门禁读取失败：${error}`);
  }
}

async function refreshLiveAcceptanceStatus(showStatus = true, regenerate = false) {
  try {
    state.liveAcceptance = await invoke(regenerate ? "refresh_live_acceptance_report" : "live_acceptance_report");
    renderLiveAcceptanceStatus();
    await refreshAcceptancePlanStatus(false, regenerate);
    if (showStatus) {
      const summary = state.liveAcceptance.summary || {};
      setStatus(
        `实机验收：${state.liveAcceptance.passed ? "已通过" : "未通过"} · ` +
          `最佳窗口 ${summary.bestHwndCompletedInterfaceTasks || 0}/${summary.requiredInterfaceTasks || 0} · ` +
          `完整窗口 ${summary.fullCoverageHwnds || 0}`,
      );
    }
  } catch (error) {
    state.liveAcceptance = null;
    renderLiveAcceptanceStatus();
    state.acceptancePlan = null;
    renderAcceptancePlanStatus();
    if (showStatus) setStatus(`实机验收${regenerate ? "刷新" : "读取"}失败：${error}`);
  }
}

async function refreshAcceptancePlanStatus(showStatus = true, regenerate = false) {
  try {
    state.acceptancePlan = await invoke(regenerate ? "refresh_acceptance_plan_report" : "acceptance_plan_report");
    renderAcceptancePlanStatus();
    if (showStatus) {
      const summary = state.acceptancePlan.summary || {};
      setStatus(
        `验收计划：窗口 ${summary.windows || 0} · ` +
          `最佳 ${summary.bestCompleted || 0}/${summary.requiredTasks || 0} · ` +
          `待跑 ${summary.totalMissingWindowTasks || 0}`,
      );
    }
  } catch (error) {
    state.acceptancePlan = null;
    renderAcceptancePlanStatus();
    if (showStatus) setStatus(`验收计划${regenerate ? "刷新" : "读取"}失败：${error}`);
  }
}

function renderMigrationStatus() {
  const report = state.migrationStatus;
  const stateNode = $("#migration-state");
  const summaryNode = $("#migration-summary");
  if (!report) {
    stateNode.textContent = "not checked";
    summaryNode.textContent = "未读取迁移门禁报告";
    $("#migration-gates").replaceChildren();
    $("#migration-domains").replaceChildren();
    $("#migration-tasks").replaceChildren();
    renderRuntimeMissingTemplates([]);
    return;
  }
  const summary = report.summary || {};
  stateNode.textContent = report.complete ? "complete" : "incomplete";
  stateNode.className = report.complete ? "ok-text" : "warn-text";
  summaryNode.textContent =
    `任务入口 ${summary.taskEntriesFound || 0}/${summary.tasks || 0} · ` +
    `preset 缺失 ${summary.presetTaskRefsMissing || 0} · ` +
    `运行时 ${summary.runtimeCoveredTemplates || 0}/${summary.uniqueTemplates || 0} 覆盖 · ` +
    `任务可达 ${summary.interfaceRuntimeCoveredTemplates || 0}/${summary.interfaceReachableTemplates || 0} · ` +
    `图片映射 ${summary.mappedTemplates || 0}/${summary.uniqueTemplates || 0} · ` +
    `验证失败 ${summary.validationFailed || 0}`;
  renderMigrationGates(report.gates || []);
  renderMigrationGapRows("#migration-domains", report.domains || [], "domain");
  renderMigrationGapRows("#migration-tasks", report.tasks || [], "task");
  renderRuntimeMissingTemplates(runtimeMissingTemplates(report));
}

function renderLiveAcceptanceStatus() {
  const report = state.liveAcceptance;
  const stateNode = $("#live-acceptance-state");
  const summaryNode = $("#live-acceptance-summary");
  const checksNode = $("#live-acceptance-checks");
  const hwndNode = $("#live-acceptance-hwnds");
  const reportsNode = $("#live-acceptance-reports");
  if (!report) {
    stateNode.textContent = "not checked";
    stateNode.className = "warn-text";
    summaryNode.textContent = "未读取实机验收报告";
    checksNode.replaceChildren();
    hwndNode.replaceChildren();
    reportsNode.replaceChildren();
    renderAcceptancePlanStatus();
    return;
  }
  const summary = report.summary || {};
  stateNode.textContent = report.passed ? "passed" : "pending";
  stateNode.className = report.passed ? "ok-text" : "warn-text";
  summaryNode.textContent =
    `窗口 ${summary.windows || 0} · ` +
    `真实最佳 ${summary.bestHwndCompletedInterfaceTasks || 0}/${summary.requiredInterfaceTasks || 0} · ` +
    `Dry-run 最佳 ${summary.bestHwndDryRunCompletedInterfaceTasks || 0}/${summary.requiredInterfaceTasks || 0} · ` +
    `完整 hwnd ${summary.fullCoverageHwnds || 0} · ` +
    `Dry-run 完整 ${summary.fullDryRunCoverageHwnds || 0} · ` +
    `权限证据完整 hwnd ${summary.fullCoverageHwndsWithPrivilegeEvidence || 0} · ` +
    `客户区证据完整 hwnd ${summary.fullCoverageHwndsWithClientEvidence || 0} · ` +
    `真实报告 ${summary.realTaskReports || 0}`;
  renderLiveAcceptanceChecks(checksNode, report.checks || []);
  renderLiveAcceptanceHwnds(
    hwndNode,
    report.taskEvidence?.perHwndTaskCoverage || [],
    report.taskEvidence?.perHwndDryRunTaskCoverage || [],
  );
  renderLiveAcceptanceReports(reportsNode, report.taskEvidence?.latestReports || []);
}

function renderAcceptancePlanStatus() {
  const report = state.acceptancePlan;
  const summaryNode = $("#acceptance-plan-summary");
  const rowsNode = $("#acceptance-plan-rows");
  if (!summaryNode || !rowsNode) return;
  if (!report) {
    summaryNode.textContent = "未读取验收计划";
    rowsNode.replaceChildren();
    return;
  }
  const summary = report.summary || {};
  summaryNode.textContent =
    `补跑窗口 ${summary.windows || 0} · ` +
    `最佳 ${summary.bestCompleted || 0}/${summary.requiredTasks || 0} · ` +
    `待跑 ${summary.totalMissingWindowTasks || 0}`;
  rowsNode.replaceChildren();
  const windows = report.windows || [];
  if (!windows.length) {
    const row = document.createElement("div");
    row.className = "runtime-missing-empty";
    row.textContent = "计划中没有目标窗口";
    rowsNode.append(row);
    return;
  }
  for (const item of windows.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "bucket-row live-coverage-row";
    const missing = item.missingTaskNames || [];
    const missingText = missing.length
      ? `缺 ${missing.slice(0, 3).join(" / ")}${missing.length > 3 ? ` ... +${missing.length - 3}` : ""}`
      : "任务完整";
    row.title = `${item.nextAction || ""}\n${missing.slice(0, 20).join("\n")}`;
    row.innerHTML = `
      <span>hwnd ${escapeHtml(String(item.hwnd || "-"))}<small>${escapeHtml(missingText)}</small></span>
      <strong>${escapeHtml(String(item.completedTasks || 0))}/${escapeHtml(String(summary.requiredTasks || 0))}</strong>
    `;
    rowsNode.append(row);
  }
}

function renderLiveAcceptanceChecks(root, checks) {
  root.replaceChildren();
  for (const item of checks) {
    const row = document.createElement("div");
    row.className = "bucket-row";
    row.title = item.detail || "";
    row.innerHTML = `
      <span>${escapeHtml(item.name || "-")}</span>
      <strong class="${item.passed ? "ok-text" : "warn-text"}">${item.passed ? "pass" : "fail"}</strong>
    `;
    root.append(row);
  }
}

function renderLiveAcceptanceHwnds(root, rows, dryRows = []) {
  root.replaceChildren();
  const byHwnd = new Map();
  for (const row of rows) byHwnd.set(String(row.hwnd), { real: row, dry: null });
  for (const dry of dryRows) {
    const key = String(dry.hwnd);
    const current = byHwnd.get(key) || { real: null, dry: null };
    current.dry = dry;
    byHwnd.set(key, current);
  }
  const combined = [...byHwnd.entries()].map(([hwnd, value]) => ({
    hwnd,
    real: value.real,
    dry: value.dry,
  }));
  combined.sort((left, right) => {
    const leftScore = left.real?.completedInterfaceTasks || left.dry?.completedInterfaceTasks || 0;
    const rightScore = right.real?.completedInterfaceTasks || right.dry?.completedInterfaceTasks || 0;
    return rightScore - leftScore || String(left.hwnd).localeCompare(String(right.hwnd));
  });
  if (!combined.length) {
    const row = document.createElement("div");
    row.className = "runtime-missing-empty";
    row.textContent = "暂无真实任务日志";
    root.append(row);
    return;
  }
  for (const item of combined.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "bucket-row live-coverage-row";
    const realDone = item.real?.completedInterfaceTasks || 0;
    const dryDone = item.dry?.completedInterfaceTasks || 0;
    const missing = item.real?.missingTaskNames || item.dry?.missingTaskNames || [];
    const missingText = missing.length ? `缺 ${missing.slice(0, 4).join(" / ")}${missing.length > 4 ? ` ... +${missing.length - 4}` : ""}` : "任务完整";
    row.title = missing.slice(0, 20).join("\n") || "任务完整";
    row.innerHTML = `
      <span>hwnd ${escapeHtml(String(item.hwnd || "-"))}<small>${escapeHtml(missingText)}</small></span>
      <strong>real ${realDone}/${state.liveAcceptance?.summary?.requiredInterfaceTasks || 0} · dry ${dryDone}</strong>
    `;
    root.append(row);
  }
}

function renderLiveAcceptanceReports(root, rows) {
  root.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("div");
    row.className = "runtime-missing-empty";
    row.textContent = "暂无任务报告";
    root.append(row);
    return;
  }
  for (const item of rows.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "bucket-row live-report-row";
    const stateText = item.completed ? "done" : "stop";
    const mode = item.dryRun ? "dry" : "real";
    const capture = captureSourceSummary(item);
    row.title = `${item.path || ""}\n${item.stoppedReason || ""}\n${capture}`;
    row.innerHTML = `
      <span>${escapeHtml(item.taskName || item.entry || "-")} · hwnd ${escapeHtml(String(item.hwnd || "-"))}</span>
      <strong class="${item.completed ? "ok-text" : "warn-text"}">${stateText} · ${mode} · ${item.steps || 0} · ${escapeHtml(capture)}</strong>
    `;
    root.append(row);
  }
}

function renderMigrationGates(gates) {
  const root = $("#migration-gates");
  root.replaceChildren();
  for (const gate of gates) {
    const row = document.createElement("div");
    row.className = "bucket-row";
    row.title = gate.detail || "";
    const ok = gate.status === "pass";
    row.innerHTML = `
      <span>${escapeHtml(gate.name)}</span>
      <strong class="${ok ? "ok-text" : "warn-text"}">${escapeHtml(gate.status)}</strong>
    `;
    root.append(row);
  }
}

function renderMigrationGapRows(selector, rows, nameKey) {
  const root = $(selector);
  root.replaceChildren();
  for (const item of rows.slice(0, 8)) {
    const total = item.templates || 0;
    const mapped = item.mapped || 0;
    const missing = item.missing ?? Math.max(0, total - mapped);
    const ratio = total ? mapped / total : 0;
    const row = document.createElement("div");
    row.className = "bucket-row";
    row.title = `latest hit ${item.manifestHit || 0}/${total}`;
    row.innerHTML = `
      <span>${escapeHtml(item[nameKey])}</span>
      <strong>${mapped}/${total} · miss ${missing}</strong>
      <i style="--ratio:${ratio}"></i>
    `;
    root.append(row);
  }
}

function runtimeMissingTemplates(report) {
  return (report?.templates || []).filter((item) => item && !item.runtimeCovered);
}

function renderRuntimeMissingTemplates(items) {
  const root = $("#migration-runtime-missing");
  root.replaceChildren();
  if (!items.length) {
    const row = document.createElement("div");
    row.className = "runtime-missing-empty";
    row.textContent = "无运行时模板缺口";
    root.append(row);
    state.selectedRuntimeMissingTemplate = null;
    clearRuntimeMissingReference("无运行时模板缺口");
    clearRuntimeMissingCandidate("无运行时模板缺口");
    return;
  }
  if (!items.some((item) => item.template === state.selectedRuntimeMissingTemplate)) {
    state.selectedRuntimeMissingTemplate = items[0].template;
  }
  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "runtime-missing-row";
    if (item.template === state.selectedRuntimeMissingTemplate) row.classList.add("active");
    const nodes = (item.nodes || []).join(" | ") || "-";
    const score = item.bestManifestScore == null ? "-" : Number(item.bestManifestScore || 0).toFixed(3);
    row.title = `${nodes}\n${(item.pipelines || []).join("\n")}`;
    row.innerHTML = `
      <span>${escapeHtml(item.template)}</span>
      <small>${escapeHtml(item.domain || "-")} · score ${score} · ${escapeHtml(nodes)}</small>
    `;
    row.addEventListener("click", () => selectRuntimeMissingTemplate(item.template));
    root.append(row);
  }
}

async function selectRuntimeMissingTemplate(templatePath) {
  state.selectedRuntimeMissingTemplate = templatePath;
  const row = state.templateRows.find((item) => item.template === templatePath);
  if (row) {
    state.selectedTemplate = row.id;
    $("#template-filter").value = templatePath;
    $("#coverage-unreplaced-only").checked = false;
  }
  renderRuntimeMissingTemplates(runtimeMissingTemplates(state.migrationStatus));
  renderTemplates();
  clearRuntimeMissingCandidate("未预览拖框候选");
  await loadRuntimeMissingReference(templatePath, false);
  setStatus(`已选择运行时缺口：${templatePath}`);
}

async function loadRuntimeMissingReference(templatePath, showStatus = false) {
  if (!templatePath) {
    clearRuntimeMissingReference("未选择缺口模板");
    return;
  }
  const image = $("#runtime-missing-reference");
  const meta = $("#runtime-missing-reference-meta");
  image.removeAttribute("src");
  meta.textContent = `正在读取原 Maa 模板：${templatePath}`;
  try {
    const preview = await invoke("old_template_preview", { templatePath });
    state.runtimeMissingReference = preview;
    image.src = preview.dataUrl;
    meta.textContent = `${templatePath} · ${preview.width}x${preview.height} · ${preview.path}`;
    if (showStatus) setStatus(`已读取原 Maa 模板参考：${templatePath}`);
  } catch (error) {
    state.runtimeMissingReference = null;
    meta.textContent = `${templatePath} · 原 Maa 参考图读取失败：${error}`;
  }
}

function clearRuntimeMissingReference(message) {
  state.runtimeMissingReference = null;
  const image = $("#runtime-missing-reference");
  if (image) image.removeAttribute("src");
  const meta = $("#runtime-missing-reference-meta");
  if (meta) meta.textContent = message;
}

async function previewRuntimeMissingClientRoi(showStatus = true) {
  const target = activeWindow();
  if (!target) {
    if (showStatus) setStatus("需要先选择窗口");
    return;
  }
  const templatePath = state.selectedRuntimeMissingTemplate;
  if (!templatePath) {
    if (showStatus) setStatus("需要先选择运行时缺口模板");
    return;
  }
  if (!state.roiSelection) {
    if (showStatus) setStatus("需要先在窗口预览上拖出一个 ROI");
    return;
  }
  const image = $("#runtime-missing-candidate");
  const meta = $("#runtime-missing-candidate-meta");
  image.removeAttribute("src");
  meta.textContent = `正在预览拖框：${state.roiSelection.join(",")}`;
  try {
    const preview = await invoke("preview_client_roi", {
      hwnd: Number(target.hwnd),
      clientRoi: state.roiSelection,
    });
    state.runtimeMissingCandidate = preview;
    image.src = preview.dataUrl;
    meta.textContent = `${templatePath} · ROI ${state.roiSelection.join(",")} · ${preview.width}x${preview.height}`;
    if (showStatus) setStatus(`已预览拖框候选：${templatePath}`);
  } catch (error) {
    state.runtimeMissingCandidate = null;
    meta.textContent = `拖框候选预览失败：${error}`;
    if (showStatus) setStatus(`拖框候选预览失败：${error}`);
  }
}

function clearRuntimeMissingCandidate(message) {
  state.runtimeMissingCandidate = null;
  const image = $("#runtime-missing-candidate");
  if (image) image.removeAttribute("src");
  const meta = $("#runtime-missing-candidate-meta");
  if (meta) meta.textContent = message;
}

function renderCompatReport() {
  const report = state.compatReport;
  if (!report) return;
  $("#compat-state").textContent = `${report.pipelineFiles} files`;
  $("#compat-summary").textContent =
    `pipeline ${report.pipelineFiles} 文件 / ${report.nodeDefinitions} 节点 · ` +
    `任务入口 ${report.taskEntriesFound}/${report.interfaceTasks} · ` +
    `preset ${report.presetTaskRefs} 引用，缺失 ${report.presetTaskRefsMissing.length} · ` +
    `next/on_error ${report.nodeRefs} 引用，缺失 ${report.missingNodeRefs.length}`;
  renderCompatIssues(report.issues || []);
  renderCompatPipelines(report.pipelines || []);
}

function renderCompatIssues(issues) {
  const root = $("#compat-issues");
  root.replaceChildren();
  if (!issues.length) {
    const row = document.createElement("div");
    row.className = "bucket-row";
    row.innerHTML = "<span>无未支持 hook</span><strong>ok</strong>";
    root.append(row);
    return;
  }
  for (const issue of issues.slice(0, 10)) {
    const row = document.createElement("div");
    row.className = "bucket-row";
    row.title = `${issue.detail || ""}\n${(issue.examples || []).join("\n")}`;
    row.innerHTML = `
      <span>${escapeHtml(issue.category)}:${escapeHtml(issue.name)}</span>
      <strong>${escapeHtml(issue.status)} · ${issue.count}</strong>
    `;
    root.append(row);
  }
}

function renderCompatPipelines(pipelines) {
  const root = $("#compat-pipelines");
  root.replaceChildren();
  const ranked = [...pipelines].sort((left, right) => {
    const rank = { unsupported: 0, partial: 1, supported: 2 };
    return (rank[left.status] ?? 3) - (rank[right.status] ?? 3) || left.pipeline.localeCompare(right.pipeline);
  });
  for (const pipe of ranked.slice(0, 10)) {
    const row = document.createElement("div");
    row.className = "bucket-row";
    const taskText = (pipe.taskEntries || []).join(" | ") || "hidden";
    row.title = `${taskText}\nrec=${(pipe.recognitionTypes || []).join(", ")}\naction=${(pipe.actionTypes || []).join(", ")}`;
    row.innerHTML = `
      <span>${escapeHtml(pipe.pipeline)}</span>
      <strong>${escapeHtml(pipe.status)} · ${pipe.nodeCount}</strong>
    `;
    root.append(row);
  }
}

function renderCoverageReport() {
  const report = state.coverageReport;
  if (!report) return;
  const sourceSpaces = Object.entries(report.sourceSpaceCounts || {})
    .map(([name, count]) => `${name}:${count}`)
    .join(" · ");
  $("#coverage-summary").textContent =
    `引用 ${report.replacedRefs}/${report.totalRefs} 已替换 · ` +
    `唯一模板 ${report.replacedTemplates}/${report.uniqueTemplates} 已替换 · ` +
    `未替换唯一模板 ${report.unreplacedTemplates} · ${sourceSpaces || "无来源记录"}`;
  renderBucketList("#coverage-domains", report.domains);
  renderBucketList("#coverage-pipelines", report.pipelines);
  renderBucketList("#coverage-tasks", report.tasks);
}

function renderBucketList(selector, buckets) {
  const root = $(selector);
  root.replaceChildren();
  for (const bucket of (buckets || []).slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "bucket-row";
    const ratio = bucket.totalRefs ? bucket.replacedRefs / bucket.totalRefs : 0;
    row.innerHTML = `
      <span>${escapeHtml(bucket.name)}</span>
      <strong>${bucket.replacedRefs}/${bucket.totalRefs}</strong>
      <i style="--ratio:${ratio}"></i>
    `;
    root.append(row);
  }
}

function renderPresets() {
  const select = $("#preset-select");
  select.replaceChildren();
  const presets = state.inventory?.presets || [];
  if (!presets.length) {
    const option = document.createElement("option");
    option.value = "0";
    option.textContent = "无预设";
    select.append(option);
    return;
  }
  for (const [index, preset] of presets.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${preset.name || `预设 ${index + 1}`} · ${(preset.task || []).length} 任务`;
    select.append(option);
  }
}

function renderTasks() {
  const needle = $("#task-filter").value.trim().toLowerCase();
  const list = $("#task-list");
  list.replaceChildren();
  for (const task of state.inventory?.tasks || []) {
    const line = `${task.name} ${task.entry} ${task.pipeline || ""}`.toLowerCase();
    if (needle && !line.includes(needle)) continue;
    const row = document.createElement("div");
    row.className = "task-row";
    if (task.id === state.selectedTaskId) row.classList.add("active");
    row.addEventListener("click", () => {
      state.selectedTaskId = task.id;
      renderTasks();
    });
    row.innerHTML = `<strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.entry)} · ${(task.options || []).length} 选项 · ${escapeHtml(task.pipeline || "missing")}</small>`;
    list.append(row);
  }
  renderSelectedTask();
}

function renderSelectedTask() {
  const task = selectedTask();
  $("#selected-task-meta").textContent = task
    ? `${task.name} · ${task.entry}${task.description ? ` · ${stripHtml(task.description)}` : ""}`
    : "未选择任务";
  renderTaskOptions(task);
}

function selectedTask() {
  return (state.inventory?.tasks || []).find((item) => item.id === state.selectedTaskId) || null;
}

function selectedWindows() {
  return state.windows.filter((item) => state.selected.has(String(item.hwnd)));
}

function targetNeedsAdminRestart(target) {
  return target?.elevated === true && state.privilege?.currentProcessElevated === false;
}

function readMaxSteps() {
  return Math.max(1, Math.min(5000, Number($("#max-steps").value) || 2000));
}

function isStopAppTask(task) {
  return task?.entry === "stop" || task?.name === "停止游戏";
}

function acceptanceOrderedTasks(tasks) {
  const list = [...(tasks || [])];
  return [...list.filter((task) => !isStopAppTask(task)), ...list.filter(isStopAppTask)];
}

function renderTaskOptions(task) {
  const container = $("#task-options");
  container.replaceChildren();
  if (!task || !(task.options || []).length) {
    const empty = document.createElement("div");
    empty.className = "option-empty";
    empty.textContent = "此任务无 Maa 选项";
    container.append(empty);
    return;
  }
  const values = taskOptionState(task);
  for (const optionName of task.options || []) {
    renderOptionControl(optionName, container, values, new Set());
  }
  const summary = document.createElement("div");
  summary.className = "option-summary";
  const overrideCount = Object.keys(buildPipelineOverrides(task)).length;
  summary.textContent = `将覆盖 ${overrideCount} 个 pipeline 节点`;
  container.append(summary);
}

function taskOptionState(task) {
  const values = state.optionValues[task.id] || {};
  state.optionValues[task.id] = values;
  ensureOptionDefaults(task.options || [], values, new Set());
  return values;
}

function ensureOptionDefaults(optionNames, values, seen) {
  for (const optionName of optionNames || []) {
    if (seen.has(optionName)) continue;
    seen.add(optionName);
    const definition = optionDefinition(optionName);
    if (!definition) continue;
    if (values[optionName] === undefined) {
      values[optionName] = defaultOptionValue(definition);
    }
    for (const nested of nestedOptionNames(definition, values[optionName])) {
      ensureOptionDefaults([nested], values, seen);
    }
  }
}

function optionDefinition(optionName) {
  return state.inventory?.optionDefinitions?.[optionName] || null;
}

function defaultOptionValue(definition) {
  if (definition.type === "checkbox") {
    return [...(definition.default_case || [])];
  }
  if (definition.type === "input") {
    const values = {};
    for (const input of definition.inputs || []) {
      values[input.name] = input.default ?? "";
    }
    return values;
  }
  return definition.default_case || definition.cases?.[0]?.name || "";
}

function nestedOptionNames(definition, value) {
  if (!definition) return [];
  if (definition.type === "checkbox") {
    const selected = new Set(Array.isArray(value) ? value : []);
    return (definition.cases || [])
      .filter((item) => selected.has(item.name))
      .flatMap((item) => item.option || []);
  }
  if (definition.type === "select" || definition.type === "switch") {
    return (definition.cases || []).find((item) => item.name === value)?.option || [];
  }
  return [];
}

function renderOptionControl(optionName, parent, values, seen) {
  if (seen.has(optionName)) return;
  seen.add(optionName);
  const definition = optionDefinition(optionName);
  const group = document.createElement("div");
  group.className = "option-card";
  const title = document.createElement("div");
  title.className = "option-title";
  title.textContent = optionName;
  group.append(title);
  if (!definition) {
    const missing = document.createElement("div");
    missing.className = "option-empty";
    missing.textContent = "原 Maa interface 中没有找到此选项定义";
    group.append(missing);
    parent.append(group);
    return;
  }
  if (definition.description) {
    const desc = document.createElement("div");
    desc.className = "option-desc";
    desc.textContent = stripHtml(definition.description);
    group.append(desc);
  }

  if (definition.type === "input") {
    const current = values[optionName] || {};
    for (const inputDef of definition.inputs || []) {
      const row = document.createElement("label");
      row.className = "option-input-row";
      const input = document.createElement("input");
      input.type = inputDef.pipeline_type === "int" ? "number" : "text";
      input.value = current[inputDef.name] ?? inputDef.default ?? "";
      if (inputDef.verify) input.pattern = inputDef.verify;
      input.addEventListener("input", () => {
        values[optionName] = { ...(values[optionName] || {}), [inputDef.name]: input.value };
        renderSelectedTask();
      });
      row.append(document.createTextNode(inputDef.name), input);
      group.append(row);
    }
  } else if (definition.type === "checkbox") {
    const selected = new Set(Array.isArray(values[optionName]) ? values[optionName] : []);
    for (const item of definition.cases || []) {
      const row = document.createElement("label");
      row.className = "option-check-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(item.name);
      checkbox.addEventListener("change", () => {
        const next = new Set(Array.isArray(values[optionName]) ? values[optionName] : []);
        if (checkbox.checked) next.add(item.name);
        else next.delete(item.name);
        values[optionName] = [...next];
        renderSelectedTask();
      });
      row.append(checkbox, document.createTextNode(item.name));
      group.append(row);
    }
  } else {
    const select = document.createElement("select");
    select.value = values[optionName] || defaultOptionValue(definition);
    for (const item of definition.cases || []) {
      const option = document.createElement("option");
      option.value = item.name;
      option.textContent = item.name;
      select.append(option);
    }
    select.addEventListener("change", () => {
      values[optionName] = select.value;
      renderSelectedTask();
    });
    group.append(select);
  }

  const nested = nestedOptionNames(definition, values[optionName]);
  if (nested.length) {
    const nestedWrap = document.createElement("div");
    nestedWrap.className = "nested-options";
    for (const nestedName of nested) {
      renderOptionControl(nestedName, nestedWrap, values, new Set(seen));
    }
    group.append(nestedWrap);
  }
  parent.append(group);
}

function buildPipelineOverrides(task, values = null) {
  if (!task) return {};
  values ||= taskOptionState(task);
  const overrides = {};
  for (const optionName of task.options || []) {
    collectOptionOverride(optionName, values, overrides, new Set());
  }
  return overrides;
}

function collectOptionOverride(optionName, values, out, seen) {
  if (seen.has(optionName)) return;
  seen.add(optionName);
  const definition = optionDefinition(optionName);
  if (!definition) return;
  const value = values[optionName] ?? defaultOptionValue(definition);
  if (definition.type === "input") {
    deepMerge(out, substitutePlaceholders(definition.pipeline_override || {}, value, definition.inputs || []));
    return;
  }
  if (definition.type === "checkbox") {
    const selected = new Set(Array.isArray(value) ? value : []);
    for (const item of definition.cases || []) {
      if (!selected.has(item.name)) continue;
      deepMerge(out, item.pipeline_override || {});
      for (const nestedName of item.option || []) collectOptionOverride(nestedName, values, out, seen);
    }
    return;
  }
  const selectedCase = (definition.cases || []).find((item) => item.name === value);
  if (selectedCase) {
    deepMerge(out, selectedCase.pipeline_override || {});
    for (const nestedName of selectedCase.option || []) collectOptionOverride(nestedName, values, out, seen);
  }
}

function substitutePlaceholders(value, inputValues, inputDefinitions) {
  if (Array.isArray(value)) {
    return value.map((item) => substitutePlaceholders(item, inputValues, inputDefinitions));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = substitutePlaceholders(item, inputValues, inputDefinitions);
    }
    return result;
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{([^}]+)\}$/);
  if (exact) {
    return coerceInputValue(inputValues[exact[1]] ?? "", inputDefinitions.find((item) => item.name === exact[1]));
  }
  return value.replace(/\{([^}]+)\}/g, (_, name) => String(inputValues[name] ?? ""));
}

function coerceInputValue(value, inputDefinition) {
  if (inputDefinition?.pipeline_type === "int") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return String(value ?? "");
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = deepClone(value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function renderTemplates() {
  const needle = $("#template-filter").value.trim().toLowerCase();
  const rows = $("#template-rows");
  rows.replaceChildren();
  const coverageRank = new Map(
    (state.coverageReport?.templates || []).map((item, index) => [item.template, index]),
  );
  const onlyUnreplaced = $("#coverage-unreplaced-only")?.checked ?? false;
  const templates = [...state.templateRows].sort((left, right) => {
    const leftRank = coverageRank.get(left.template) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = coverageRank.get(right.template) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.template.localeCompare(right.template);
  });
  for (const item of templates) {
    const line = `${item.template} ${item.node} ${item.pipeline} ${item.replacementPath || ""} ${item.replacementSourceSpace || ""}`.toLowerCase();
    if (needle && !line.includes(needle)) continue;
    if (onlyUnreplaced && item.replacementPath) continue;
    const tr = document.createElement("tr");
    if (state.selectedTemplate === item.id) tr.classList.add("selected");
    if (item.replacementPath) tr.classList.add("replaced");
    tr.addEventListener("click", () => {
      state.selectedTemplate = item.id;
      renderTemplates();
    });
    tr.innerHTML = `
      <td>${item.replacementPath ? `已替换 · ${escapeHtml(item.replacementSourceSpace || "-")}` : "未替换"}</td>
      <td>${escapeHtml(item.template)}</td>
      <td>${escapeHtml(item.node)}</td>
      <td>${item.roi ? item.roi.join(",") : "-"}</td>
      <td>${escapeHtml(item.pipeline)}</td>
    `;
    rows.append(tr);
  }
}

function updateTemplateCount() {
  const total = state.templateRows.length;
  const replaced = state.templateRows.filter((item) => item.replacementPath).length;
  $("#template-count").textContent = `${replaced}/${total}`;
}

async function captureSelectedTemplate() {
  const target = activeWindow();
  const template = state.templateRows.find((item) => item.id === state.selectedTemplate);
  if (!target || !template) {
    setStatus("需要先选择窗口和模板");
    return;
  }
  let roiOverride = null;
  try {
    roiOverride = parseManualRoi();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  const result = await invoke("capture_template_roi", {
    hwnd: Number(target.hwnd),
    templateId: template.id,
    roiOverride,
    coordinateMode: $("#coordinate-mode").value,
  });
  await refreshInventory();
  setStatus(`已写入时空替换图：${result.savedPath}`);
}

async function captureSelectedClientRoi() {
  const target = activeWindow();
  const template = state.templateRows.find((item) => item.id === state.selectedTemplate);
  if (!target || !template) {
    setStatus("需要先选择窗口和模板");
    return;
  }
  if (!state.roiSelection) {
    setStatus("需要先在窗口预览上拖出一个 ROI");
    return;
  }
  const result = await invoke("capture_template_client_roi", {
    hwnd: Number(target.hwnd),
    templateId: template.id,
    clientRoi: state.roiSelection,
  });
  await refreshInventory();
  setStatus(`已按拖框写入时空替换图：${result.savedPath}`);
}

async function captureSelectedImageRoi() {
  const template = state.templateRows.find((item) => item.id === state.selectedTemplate);
  if (!template) {
    setStatus("需要先选择模板");
    return;
  }
  if (!state.offlineImagePath || state.previewSource !== "image") {
    setStatus("需要先载入离线截图");
    return;
  }
  if (!state.roiSelection) {
    setStatus("需要先在离线图预览上拖出一个 ROI");
    return;
  }
  const result = await invoke("capture_template_image_roi", {
    imagePath: state.offlineImagePath,
    templateId: template.id,
    imageRoi: state.roiSelection,
  });
  await refreshInventory();
  setStatus(`已按离线图拖框写入时空替换图：${result.savedPath}`);
}

async function captureRuntimeMissingClientRoi() {
  const target = activeWindow();
  if (!target) {
    setStatus("需要先选择窗口");
    return;
  }
  const templatePath = state.selectedRuntimeMissingTemplate;
  if (!templatePath) {
    setStatus("需要先选择运行时缺口模板");
    return;
  }
  if (!state.roiSelection) {
    setStatus("需要先在窗口预览上拖出一个 ROI");
    return;
  }
  let template = state.templateRows.find((item) => item.template === templatePath);
  if (!template) {
    await refreshInventory();
    template = state.templateRows.find((item) => item.template === templatePath);
  }
  if (!template) {
    setStatus(`Maa 清单中找不到模板：${templatePath}`);
    return;
  }
  const result = await invoke("capture_template_client_roi", {
    hwnd: Number(target.hwnd),
    templateId: template.id,
    clientRoi: state.roiSelection,
  });
  await refreshInventory();
  await refreshCoverageReport(false);
  await refreshMigrationStatus(false);
  setStatus(`已按拖框写入运行时缺口：${templatePath} -> ${result.savedPath}`);
}

async function writeCropPlan() {
  const planName = $("#crop-plan-name").value.trim() || null;
  const imagePath = $("#offline-image-path").value.trim() || null;
  const rawLimit = Number($("#crop-plan-limit").value);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.round(rawLimit) : null;
  const result = await invoke("write_crop_plan", {
    planName,
    imagePath,
    onlyUnreplaced: $("#coverage-unreplaced-only").checked,
    limit,
  });
  $("#crop-plan-path").value = result.planPath;
  setStatus(
    `已生成裁剪计划：${result.planPath}，${result.itemCount}/${result.unreplacedTemplates} 个未替换模板进入计划`,
  );
}

async function writeRuntimeMissingCropPlan() {
  const planName = $("#crop-plan-name").value.trim() || null;
  const imagePath = $("#offline-image-path").value.trim() || null;
  const rawLimit = Number($("#crop-plan-limit").value);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.round(rawLimit) : null;
  const result = await invoke("write_runtime_missing_crop_plan", {
    planName,
    imagePath,
    limit,
  });
  $("#crop-plan-path").value = result.planPath;
  setStatus(
    `已生成运行时缺口计划：${result.planPath}，${result.itemCount}/${result.unreplacedTemplates} 个缺口进入计划`,
  );
}

async function applyCropPlan() {
  const planPath = $("#crop-plan-path").value.trim();
  if (!planPath) {
    setStatus("需要输入裁剪计划 JSON 路径");
    return;
  }
  const report = await invoke("apply_crop_plan", { planPath });
  await refreshInventory();
  await refreshCoverageReport(false);
  setStatus(`裁剪计划完成：应用 ${report.applied} 项，跳过 ${report.skipped} 项：${report.planPath}`);
}

function parseManualRoi() {
  const text = $("#manual-roi").value.trim();
  if (!text) return null;
  const values = text
    .split(/[,\s，]+/)
    .filter(Boolean)
    .map((item) => Number(item));
  if (values.length !== 4 || values.some((item) => !Number.isFinite(item))) {
    throw new Error("手工 ROI 需要 4 个数字：x,y,w,h");
  }
  return values.map((item) => Math.round(item));
}

function imagePointFromEvent(event) {
  const image = $("#preview-image");
  if (!state.preview || !image.src) return null;
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.round(((event.clientX - rect.left) / rect.width) * state.preview.width);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * state.preview.height);
  return {
    x: Math.max(0, Math.min(state.preview.width, x)),
    y: Math.max(0, Math.min(state.preview.height, y)),
    rect,
  };
}

function startRoiDrag(event) {
  if (event.button !== 0) return;
  const point = imagePointFromEvent(event);
  if (!point) return;
  event.preventDefault();
  state.roiDragStart = { x: point.x, y: point.y };
  state.roiSelection = [point.x, point.y, 1, 1];
  updateRoiBox();
}

function moveRoiDrag(event) {
  if (!state.roiDragStart) return;
  const point = imagePointFromEvent(event);
  if (!point) return;
  const left = Math.min(state.roiDragStart.x, point.x);
  const top = Math.min(state.roiDragStart.y, point.y);
  const right = Math.max(state.roiDragStart.x, point.x);
  const bottom = Math.max(state.roiDragStart.y, point.y);
  state.roiSelection = [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
  updateRoiBox();
}

function endRoiDrag() {
  if (!state.roiDragStart) return;
  state.roiDragStart = null;
  $("#manual-roi").value = state.roiSelection.join(",");
  setStatus(`已选择客户端 ROI：${state.roiSelection.join(",")}`);
  if (state.selectedRuntimeMissingTemplate) {
    void previewRuntimeMissingClientRoi(false);
  }
}

function updateRoiBox() {
  const box = $("#roi-box");
  const image = $("#preview-image");
  if (!state.roiSelection || !state.preview || !image.src) {
    box.style.display = "none";
    return;
  }
  const imageRect = image.getBoundingClientRect();
  const stageRect = $(".preview-stage").getBoundingClientRect();
  const [x, y, width, height] = state.roiSelection;
  box.style.display = "block";
  box.style.left = `${imageRect.left - stageRect.left + (x / state.preview.width) * imageRect.width}px`;
  box.style.top = `${imageRect.top - stageRect.top + (y / state.preview.height) * imageRect.height}px`;
  box.style.width = `${(width / state.preview.width) * imageRect.width}px`;
  box.style.height = `${(height / state.preview.height) * imageRect.height}px`;
}

function clearRoiSelection() {
  state.roiSelection = null;
  state.roiDragStart = null;
  clearRuntimeMissingCandidate("未预览拖框候选");
  updateRoiBox();
}

async function refreshOcrStatus() {
  state.ocr = await invoke("ocr_status");
  $("#ocr-status").textContent = state.ocr.available
    ? `${state.ocr.backendName} ready`
    : state.ocr.reason;
}

async function runSelectedTask(dryRun) {
  const target = activeWindow();
  const task = selectedTask();
  if (!target || !task) {
    setStatus("需要先选择窗口和任务");
    return;
  }
  const maxSteps = readMaxSteps();
  state.cancelPreset = false;
  $("#run-log").replaceChildren();
  try {
    await runTaskOnWindow(target, task, dryRun, maxSteps, taskOptionState(task));
  } finally {
    if (!dryRun) await refreshLiveAcceptanceStatus(false, true);
  }
}

async function runSelectedTaskOnAll(dryRun) {
  const task = selectedTask();
  const targets = selectedWindows();
  if (!task || !targets.length) {
    setStatus("需要先选择任务和至少一个窗口");
    return;
  }
  const maxSteps = readMaxSteps();
  const values = taskOptionState(task);
  state.cancelPreset = false;
  $("#run-log").replaceChildren();
  $("#runtime-state").textContent = dryRun ? "multi dry-run" : "multi running";
  setStatus(`${dryRun ? "Dry-run" : "执行"}已选窗口任务：${task.name} x${targets.length}`);
  const results = await Promise.allSettled(
    targets.map((target, index) => runTaskOnWindow(
      target,
      task,
      dryRun,
      maxSteps,
      values,
      `${index + 1}/${targets.length} ${target.display} / ${task.name}`,
      false,
    )),
  );
  if (!dryRun) await refreshLiveAcceptanceStatus(false, true);
  const failures = results.filter((result) => result.status === "rejected" || !result.value?.completed);
  if (failures.length) {
    $("#runtime-state").textContent = "stopped";
    setStatus(`已选窗口任务完成但有 ${failures.length}/${targets.length} 个窗口中止或失败`);
    return;
  }
  $("#runtime-state").textContent = "done";
  setStatus(`已选窗口任务全部完成：${task.name} x${targets.length}`);
}

async function runAcceptanceMatrix(dryRun) {
  const target = activeWindow();
  const tasks = acceptanceOrderedTasks(state.inventory?.tasks || []);
  if (!target || !tasks.length) {
    setStatus("需要先选择窗口并载入 Maa 任务");
    return false;
  }
  const maxSteps = readMaxSteps();
  state.cancelPreset = false;
  $("#run-log").replaceChildren();
  $("#runtime-state").textContent = dryRun ? "acceptance dry-run" : "acceptance running";
  setStatus(`${dryRun ? "Dry-run" : "执行"}全任务验收：${tasks.length} 个 Maa 任务`);
  const ok = await runAcceptanceMatrixOnWindow(target, tasks, dryRun, maxSteps, "验收", true);
  await refreshLiveAcceptanceStatus(false, true);
  if (ok) {
    $("#runtime-state").textContent = "done";
    setStatus(`全任务验收完成：${tasks.length}/${tasks.length} 个 Maa 任务`);
  }
  return ok;
}

async function runAcceptanceMatrixOnAll(dryRun) {
  const targets = selectedWindows();
  const tasks = acceptanceOrderedTasks(state.inventory?.tasks || []);
  if (!targets.length || !tasks.length) {
    setStatus("需要选择至少一个窗口并载入 Maa 任务");
    return false;
  }
  const maxSteps = readMaxSteps();
  state.cancelPreset = false;
  $("#run-log").replaceChildren();
  $("#runtime-state").textContent = dryRun ? "multi acceptance dry-run" : "multi acceptance running";
  setStatus(`${dryRun ? "Dry-run" : "执行"}已选窗口全任务验收：${targets.length} 窗口 x ${tasks.length} 任务`);
  const results = await Promise.allSettled(
    targets.map((target, index) =>
      runAcceptanceMatrixOnWindow(
        target,
        tasks,
        dryRun,
        maxSteps,
        `验收 ${index + 1}/${targets.length} ${target.display}`,
        false,
      ),
    ),
  );
  const failures = results.filter((result) => result.status === "rejected" || result.value !== true);
  await refreshLiveAcceptanceStatus(false, true);
  if (failures.length) {
    $("#runtime-state").textContent = "stopped";
    setStatus(`已选窗口全任务验收完成但有 ${failures.length}/${targets.length} 个窗口中止或失败`);
    return false;
  }
  $("#runtime-state").textContent = "done";
  setStatus(`已选窗口全任务验收全部完成：${targets.length} 窗口 x ${tasks.length} 任务`);
  return true;
}

async function runMissingAcceptanceMatrix() {
  const target = activeWindow();
  const allTasks = state.inventory?.tasks || [];
  if (!target) {
    setStatus("需要先选择窗口");
    return false;
  }
  if (!allTasks.length) {
    setStatus("需要先载入 Maa 任务");
    return false;
  }
  const tasks = await missingAcceptanceTasksForWindow(target);
  if (!tasks.length) {
    setStatus(`当前窗口已无缺失 Maa 任务：hwnd ${target.hwnd}`);
    return true;
  }
  const maxSteps = readMaxSteps();
  state.cancelPreset = false;
  $("#run-log").replaceChildren();
  $("#runtime-state").textContent = "missing acceptance running";
  setStatus(`执行缺失验收：hwnd ${target.hwnd} · ${tasks.length} 个 Maa 任务`);
  const ok = await runAcceptanceMatrixOnWindow(target, tasks, false, maxSteps, "缺失验收", true);
  await refreshLiveAcceptanceStatus(false, true);
  if (ok) {
    $("#runtime-state").textContent = "done";
    setStatus(`缺失验收完成：hwnd ${target.hwnd} · ${tasks.length}/${tasks.length}`);
  }
  return ok;
}

async function runMissingAcceptanceMatrixOnAll() {
  const targets = selectedWindows();
  const allTasks = state.inventory?.tasks || [];
  if (!targets.length) {
    setStatus("需要选择至少一个窗口");
    return false;
  }
  if (!allTasks.length) {
    setStatus("需要先载入 Maa 任务");
    return false;
  }
  await refreshLiveAcceptanceStatus(false, true);
  const plans = targets.map((target) => ({
    target,
    tasks: missingAcceptanceTasksFromReport(target),
  }));
  const runnable = plans.filter((plan) => plan.tasks.length > 0);
  if (!runnable.length) {
    setStatus("已选窗口都没有缺失 Maa 任务");
    return true;
  }
  const maxSteps = readMaxSteps();
  state.cancelPreset = false;
  $("#run-log").replaceChildren();
  $("#runtime-state").textContent = "multi missing acceptance running";
  const totalTasks = runnable.reduce((sum, plan) => sum + plan.tasks.length, 0);
  setStatus(`执行已选窗口缺失验收：${runnable.length}/${targets.length} 窗口 · ${totalTasks} 个任务`);
  const results = await Promise.allSettled(
    runnable.map((plan, index) =>
      runAcceptanceMatrixOnWindow(
        plan.target,
        plan.tasks,
        false,
        maxSteps,
        `缺失验收 ${index + 1}/${runnable.length} ${plan.target.display}`,
        false,
      ),
    ),
  );
  const failures = results.filter((result) => result.status === "rejected" || result.value !== true);
  await refreshLiveAcceptanceStatus(false, true);
  if (failures.length) {
    $("#runtime-state").textContent = "stopped";
    setStatus(`已选窗口缺失验收完成但有 ${failures.length}/${runnable.length} 个窗口中止或失败`);
    return false;
  }
  $("#runtime-state").textContent = "done";
  setStatus(`已选窗口缺失验收全部完成：${runnable.length} 窗口 · ${totalTasks} 个任务`);
  return true;
}

async function missingAcceptanceTasksForWindow(target) {
  await refreshLiveAcceptanceStatus(false, true);
  return missingAcceptanceTasksFromReport(target);
}

function missingAcceptanceTasksFromReport(target) {
  const tasks = state.inventory?.tasks || [];
  if (!tasks.length) return [];
  const hwnd = String(target.hwnd);
  const coverage = (state.liveAcceptance?.taskEvidence?.perHwndTaskCoverage || [])
    .find((row) => String(row.hwnd) === hwnd);
  if (!coverage) return acceptanceOrderedTasks(tasks);
  const missingNames = new Set(coverage.missingTaskNames || []);
  return acceptanceOrderedTasks(tasks.filter((task) => missingNames.has(task.name)));
}

async function runAcceptanceMatrixOnWindow(target, tasks, dryRun, maxSteps, labelPrefix, updateGlobalState) {
  for (const [index, task] of tasks.entries()) {
    if (state.cancelPreset) {
      if (updateGlobalState) {
        $("#runtime-state").textContent = "stopped";
        setStatus(`全任务验收已停止：${index}/${tasks.length} 已处理`);
      }
      return false;
    }
    if (updateGlobalState) {
      state.selectedTaskId = task.id;
      renderTasks();
      renderSelectedTask();
    }
    const label = `${labelPrefix} ${index + 1}/${tasks.length}. ${task.name}`;
    if (updateGlobalState) setStatus(`${dryRun ? "Dry-run" : "执行"}：${label}`);
    let report;
    try {
      report = await runTaskOnWindow(
        target,
        task,
        dryRun,
        maxSteps,
        deepClone(taskOptionState(task)),
        label,
        false,
      );
    } catch (error) {
      if (updateGlobalState) {
        $("#runtime-state").textContent = "error";
        setStatus(`全任务验收错误：${label} -> ${error}`);
      }
      return false;
    }
    if (!report.completed) {
      if (updateGlobalState) {
        $("#runtime-state").textContent = "stopped";
        setStatus(`全任务验收中止：${label} -> ${report.stoppedReason}`);
      }
      return false;
    }
  }
  return true;
}

async function runTaskOnWindow(
  target,
  task,
  dryRun,
  maxSteps,
  optionValues,
  label = task.name,
  updateGlobalState = true,
) {
  if (!dryRun && targetNeedsAdminRestart(target)) {
    const detail = "目标窗口是管理员权限；请先点“管理员重启”或用管理员终端启动接管台";
    appendRunMessage("-", label, "blocked", detail);
    if (updateGlobalState) {
      $("#runtime-state").textContent = "blocked";
      setStatus(`${label} 已阻止：${detail}`);
    }
    return {
      hwnd: Number(target.hwnd),
      runId: null,
      completed: false,
      stoppedReason: detail,
      steps: [],
      durationMs: 0,
    };
  }
  const hwndKey = String(target.hwnd);
  const activeRun = state.currentRunsByHwnd.get(hwndKey);
  if (activeRun) {
    const detail = `窗口 ${target.display} 已在运行：${activeRun.label}`;
    appendRunMessage("-", label, "blocked", detail);
    if (updateGlobalState) {
      $("#runtime-state").textContent = "blocked";
      setStatus(`${label} 已阻止：${detail}`);
    }
    return {
      hwnd: Number(target.hwnd),
      runId: null,
      completed: false,
      stoppedReason: detail,
      steps: [],
      durationMs: 0,
    };
  }
  const runId = createRunId(target, task);
  state.currentRunIds.add(runId);
  state.currentRunsByHwnd.set(hwndKey, { runId, label });
  renderTabs();
  renderWindows();
  if (updateGlobalState) {
    $("#runtime-state").textContent = dryRun ? "dry-run" : "running";
    setStatus(`${dryRun ? "Dry-run" : "执行"}：${label}`);
  }
  try {
    const report = await invoke("run_maa_task", {
      request: {
        hwnd: Number(target.hwnd),
        entry: task.entry,
        taskName: task.name,
        dryRun,
        maxSteps,
        coordinateMode: $("#coordinate-mode").value,
        runId,
        pipelineOverrides: buildPipelineOverrides(task, optionValues),
      },
    });
    renderRunReport(report, label);
    if (updateGlobalState) {
      $("#runtime-state").textContent = report.completed ? "done" : "stopped";
      setStatus(`${label}：${report.stoppedReason}，${report.steps.length} 步，${report.durationMs}ms`);
    }
    return report;
  } catch (error) {
    appendRunMessage("-", label, "error", String(error));
    if (updateGlobalState) {
      $("#runtime-state").textContent = "error";
      setStatus(`${label} 失败：${error}`);
    }
    throw error;
  } finally {
    state.currentRunIds.delete(runId);
    if (state.currentRunsByHwnd.get(hwndKey)?.runId === runId) {
      state.currentRunsByHwnd.delete(hwndKey);
    }
    renderTabs();
    renderWindows();
  }
}

async function runSelectedPreset(dryRun) {
  const target = activeWindow();
  const preset = (state.inventory?.presets || [])[Number($("#preset-select").value) || 0];
  if (!target || !preset) {
    setStatus("需要先选择窗口和预设");
    return;
  }
  const maxSteps = readMaxSteps();
  state.cancelPreset = false;
  $("#run-log").replaceChildren();
  try {
    await runPresetOnWindow(target, preset, dryRun, maxSteps, preset.name || "预设");
  } finally {
    if (!dryRun) await refreshLiveAcceptanceStatus(false, true);
  }
}

async function runSelectedPresetOnAll(dryRun) {
  const preset = (state.inventory?.presets || [])[Number($("#preset-select").value) || 0];
  const targets = selectedWindows();
  if (!preset || !targets.length) {
    setStatus("需要先选择预设和至少一个窗口");
    return;
  }
  const maxSteps = readMaxSteps();
  state.cancelPreset = false;
  $("#run-log").replaceChildren();
  $("#runtime-state").textContent = dryRun ? "multi preset dry-run" : "multi preset running";
  setStatus(`${dryRun ? "Dry-run" : "执行"}已选窗口预设：${preset.name || "预设"} x${targets.length}`);
  const results = await Promise.allSettled(
    targets.map((target, index) => runPresetOnWindow(
      target,
      preset,
      dryRun,
      maxSteps,
      `${index + 1}/${targets.length} ${target.display} / ${preset.name || "预设"}`,
      false,
    )),
  );
  if (!dryRun) await refreshLiveAcceptanceStatus(false, true);
  const failures = results.filter((result) => result.status === "rejected" || result.value === false);
  if (failures.length) {
    $("#runtime-state").textContent = "stopped";
    setStatus(`已选窗口预设完成但有 ${failures.length}/${targets.length} 个窗口中止或失败`);
    return;
  }
  $("#runtime-state").textContent = "done";
  setStatus(`已选窗口预设全部完成：${preset.name || "预设"} x${targets.length}`);
}

async function runPresetOnWindow(target, preset, dryRun, maxSteps, label, updateGlobalState = true) {
  if (updateGlobalState) {
    $("#runtime-state").textContent = dryRun ? "preset dry-run" : "preset running";
    setStatus(`${dryRun ? "Dry-run" : "执行"}预设：${label}`);
  }
  for (const [index, presetTask] of (preset.task || []).entries()) {
    if (state.cancelPreset) {
      if (updateGlobalState) {
        $("#runtime-state").textContent = "stopped";
        setStatus(`预设已停止：${label}`);
      }
      return false;
    }
    const task = taskByPresetItem(presetTask);
    if (!task) {
      appendRunMessage(index + 1, presetTask.name || "-", "missing", "预设任务未在 Maa task 列表中找到");
      continue;
    }
    const values = optionValuesFromPreset(task, presetTask.option || {});
    const report = await runTaskOnWindow(
      target,
      task,
      dryRun,
      maxSteps,
      values,
      `${label} / ${index + 1}. ${task.name}`,
      updateGlobalState,
    );
    if (!report.completed) {
      if (updateGlobalState) {
        $("#runtime-state").textContent = "stopped";
        setStatus(`预设中止：${task.name} -> ${report.stoppedReason}`);
      }
      return false;
    }
  }
  if (updateGlobalState) {
    $("#runtime-state").textContent = "done";
    setStatus(`预设完成：${label}`);
  }
  return true;
}

function taskByPresetItem(presetTask) {
  const name = presetTask?.name || "";
  return (state.inventory?.tasks || []).find((task) => task.name === name) || null;
}

function optionValuesFromPreset(task, presetOptions) {
  const values = {};
  ensureOptionDefaults(task.options || [], values, new Set());
  for (const [optionName, value] of Object.entries(presetOptions || {})) {
    values[optionName] = deepClone(value);
  }
  ensureOptionDefaults(task.options || [], values, new Set());
  return values;
}

async function cancelCurrentTask() {
  state.cancelPreset = true;
  const runIds = [...state.currentRunIds];
  if (!runIds.length) {
    setStatus("当前没有运行中的任务");
    return;
  }
  const results = await Promise.all(runIds.map((runId) => invoke("cancel_maa_task", { runId })));
  const cancelled = results.filter(Boolean).length;
  setStatus(cancelled ? `已请求停止 ${cancelled}/${runIds.length} 个运行任务` : "未找到可停止的运行任务");
}

function renderRunReport(report, label = "") {
  const rows = $("#run-log");
  const sourceText = captureSourceSummary(report);
  $("#run-summary").textContent =
    `${label || report.taskName || report.entry || "任务"} · ` +
    `${report.completed ? "完成" : "未完成"} · ${report.stoppedReason || "-"} · ` +
    `${report.steps?.length || 0} 步 · 截图 ${sourceText}`;
  $("#run-summary").classList.toggle("warn-text", Boolean(report.usedScreenRegionFallback));
  for (const step of report.steps || []) {
    const tr = document.createElement("tr");
    const recognition = step.recognition
      ? `${step.recognition.kind} ${step.recognition.hit ? "hit" : "miss"} ${Number(step.recognition.score || 0).toFixed(3)} ${step.recognition.text || step.recognition.detail || ""}`
      : "-";
    tr.innerHTML = `
      <td>${step.index}</td>
      <td>${escapeHtml(label ? `${label} / ${step.node}` : step.node)}</td>
      <td>${escapeHtml(step.status)}</td>
      <td>${escapeHtml(recognition)}</td>
      <td>${escapeHtml(step.action || "-")}</td>
      <td class="run-detail">${escapeHtml(step.detail || "-")}</td>
      <td>${escapeHtml((step.queued || []).slice(0, 6).join(" -> "))}</td>
    `;
    rows.append(tr);
  }
}

function appendRunMessage(index, node, status, detail) {
  const rows = $("#run-log");
  $("#run-summary").textContent = `${node} · ${status} · ${detail}`;
  $("#run-summary").classList.toggle("warn-text", status !== "hit" && status !== "done");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${index}</td>
    <td>${escapeHtml(node)}</td>
    <td>${escapeHtml(status)}</td>
    <td>-</td>
    <td>-</td>
    <td class="run-detail">${escapeHtml(detail)}</td>
    <td>-</td>
  `;
  rows.append(tr);
}

function selectGameWindows() {
  state.selected = new Set(state.windows.map((item) => String(item.hwnd)));
  state.activeHwnd = state.windows[0]?.hwnd || null;
  renderWindows();
  renderTabs();
  capturePreview();
}

function privilegeLabel(item) {
  const target = item.elevated === true ? "目标管理员" : item.elevated === false ? "目标普通权限" : "目标权限未知";
  const current = state.privilege?.currentProcessElevated ? "接管台管理员" : "接管台普通权限";
  return `${target} / ${current}`;
}

function captureSourceSummary(item) {
  const sources = item?.captureSources || [];
  const sourceText = sources.length ? sources.join(",") : item?.clientEvidenceCaptureSource || "unknown";
  return item?.usedScreenRegionFallback ? `${sourceText} / fallback` : sourceText;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

$("#refresh-windows").addEventListener("click", refreshWindows);
$("#launch-game-client").addEventListener("click", launchGameClient);
$("#select-game-windows").addEventListener("click", selectGameWindows);
$("#refresh-inventory").addEventListener("click", refreshInventory);
$("#restart-admin").addEventListener("click", restartAsAdmin);
$("#refresh-coverage").addEventListener("click", refreshCoverageReport);
$("#refresh-compat").addEventListener("click", refreshCompatReport);
$("#refresh-migration").addEventListener("click", refreshMigrationStatus);
$("#refresh-live-acceptance").addEventListener("click", () => refreshLiveAcceptanceStatus(true, true));
$("#refresh-acceptance-plan").addEventListener("click", () => refreshAcceptancePlanStatus(true, true));
$("#capture-preview").addEventListener("click", capturePreview);
$("#focus-window").addEventListener("click", focusWindow);
$("#save-snapshot").addEventListener("click", saveSnapshot);
$("#load-offline-image").addEventListener("click", loadOfflineImage);
$("#capture-template").addEventListener("click", captureSelectedTemplate);
$("#capture-client-roi").addEventListener("click", captureSelectedClientRoi);
$("#capture-image-roi").addEventListener("click", captureSelectedImageRoi);
$("#write-crop-plan").addEventListener("click", writeCropPlan);
$("#write-runtime-missing-plan").addEventListener("click", writeRuntimeMissingCropPlan);
$("#apply-crop-plan").addEventListener("click", applyCropPlan);
$("#preview-runtime-missing-roi").addEventListener("click", () => previewRuntimeMissingClientRoi(true));
$("#capture-runtime-missing-roi").addEventListener("click", captureRuntimeMissingClientRoi);
$("#dry-run-task").addEventListener("click", () => runSelectedTask(true));
$("#run-task").addEventListener("click", () => runSelectedTask(false));
$("#dry-run-all-task").addEventListener("click", () => runSelectedTaskOnAll(true));
$("#run-all-task").addEventListener("click", () => runSelectedTaskOnAll(false));
$("#dry-run-acceptance").addEventListener("click", () => runAcceptanceMatrix(true));
$("#run-acceptance").addEventListener("click", () => runAcceptanceMatrix(false));
$("#dry-run-all-acceptance").addEventListener("click", () => runAcceptanceMatrixOnAll(true));
$("#run-all-acceptance").addEventListener("click", () => runAcceptanceMatrixOnAll(false));
$("#run-missing-acceptance").addEventListener("click", runMissingAcceptanceMatrix);
$("#run-all-missing-acceptance").addEventListener("click", runMissingAcceptanceMatrixOnAll);
$("#dry-run-preset").addEventListener("click", () => runSelectedPreset(true));
$("#run-preset").addEventListener("click", () => runSelectedPreset(false));
$("#dry-run-all-preset").addEventListener("click", () => runSelectedPresetOnAll(true));
$("#run-all-preset").addEventListener("click", () => runSelectedPresetOnAll(false));
$("#cancel-task").addEventListener("click", cancelCurrentTask);
$("#refresh-ocr").addEventListener("click", refreshOcrStatus);
$("#task-filter").addEventListener("input", renderTasks);
$("#template-filter").addEventListener("input", renderTemplates);
$("#coverage-unreplaced-only").addEventListener("change", renderTemplates);
document.querySelectorAll("[data-tool-tab]").forEach((button) => {
  button.addEventListener("click", () => selectToolPanel(button.dataset.toolTab));
});
$("#preview-image").addEventListener("mousedown", startRoiDrag);
window.addEventListener("mousemove", moveRoiDrag);
window.addEventListener("mouseup", endRoiDrag);
window.addEventListener("resize", updateRoiBox);

renderToolPanels();
await refreshPrivilege();
await refreshGameLaunchStatus();
await refreshOcrStatus();
await refreshInventory();
await refreshCompatReport(false);
await refreshCoverageReport(false);
await refreshMigrationStatus(false);
await refreshLiveAcceptanceStatus(false);
await refreshWindows();
