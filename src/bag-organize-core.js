/** Offline readiness helpers for bag organize blueprint (no live input). */

export const BAG_ORGANIZE_BLUEPRINT_ID = "bag-organize";

export const BAG_ORGANIZE_BLUEPRINT = {
  id: BAG_ORGANIZE_BLUEPRINT_ID,
  label: "\u80cc\u5305\u6574\u7406",
  category: "\u80cc\u5305",
  defaultPrefix: "\u80cc\u5305\u6574\u7406",
  autoRecovery: true,
  description: "\u6253\u5f00\u80cc\u5305\uff0c\u67e5\u627e\u76ee\u6807\u6750\u6599\u5e76\u79fb\u5165\u6574\u7406\u533a\uff0c\u4ec5\u505a\u5b89\u5168\u89c2\u5bdf\u4e0e\u6574\u7406\u70b9\u51fb\uff0c\u4e0d\u505a\u4ea4\u6613\u3002",
  steps: [
    { type: "detect_page", name: "\u786e\u8ba4\u4e3b\u754c\u9762", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible", onFail: "stop" },
    { type: "snapshot", name: "\u8bb0\u5f55\u5f00\u59cb\u753b\u9762", target: "window.client", command: "capture=strict; purpose=bag_before", expect: "snapshot.observed", onFail: "stop" },
    { type: "hotkey", name: "\u6253\u5f00\u80cc\u5305", target: "ALT+E", command: "mode=hwnd-key", expect: "bag.open", onFail: "stop" },
    { type: "wait_image", name: "\u7b49\u5f85\u80cc\u5305\u754c\u9762", target: "page.bag.ready", command: "threshold=0.85", expect: "visible", onFail: "restore" },
    { type: "ocr_assert", name: "\u786e\u8ba4\u5305\u88f9\u6807\u9898", target: "\u5305\u88f9", command: "lang=zh; roi=top", expect: "text_found", onFail: "restore" },
    { type: "wait_image", name: "\u67e5\u627e\u76ee\u6807\u6750\u6599", target: "item.target_material", command: "threshold=0.86", expect: "visible", onFail: "restore" },
    { type: "image_click", name: "\u9009\u62e9\u76ee\u6807\u6750\u6599", target: "item.target_material", command: "button=left; point=center; confirmation=manual-required", expect: "item.selected", onFail: "restore", requiresManualConfirmation: true },
    { type: "image_click", name: "\u79fb\u52a8\u5230\u6574\u7406\u533a", target: "button.sort_material", command: "button=left; point=center; confirmation=manual-required", expect: "sort.accepted", onFail: "restore", requiresManualConfirmation: true },
    { type: "delay", name: "\u7b49\u5f85\u6574\u7406\u53cd\u9988", target: "900ms", command: "reason=ui_settle", expect: "time.elapsed", onFail: "restore" },
    { type: "ocr_assert", name: "\u786e\u8ba4\u6574\u7406\u7ed3\u679c", target: "\u6574\u7406", command: "lang=zh; roi=panel", expect: "text_found", onFail: "restore" },
    { type: "snapshot", name: "\u8bb0\u5f55\u6574\u7406\u540e\u72b6\u6001", target: "window.client", command: "capture=strict; purpose=bag_after", expect: "snapshot.observed", onFail: "restore" },
    { type: "hotkey", name: "\u5173\u95ed\u80cc\u5305", target: "ESC", command: "mode=hwnd-key", expect: "bag.closed", onFail: "stop", id: "bag-restore" },
    { type: "detect_page", name: "\u786e\u8ba4\u5df2\u8fd4\u56de\u4e3b\u754c\u9762", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible", onFail: "stop" },
  ],
};

export const BAG_ORGANIZE_TEMPLATE_BINDINGS = [
  { target: "page.home.ready", key: "zonghe/jiahao.png", kind: "page", name: "\u4e3b\u754c\u9762\u5224\u5b9a", threshold: 0.86 },
  { target: "page.bag.ready", key: "beibao/beibao_diduan.png", kind: "page", name: "\u80cc\u5305\u754c\u9762\u5224\u5b9a", threshold: 0.84 },
  { target: "item.target_material", key: "beibao/bailianjingtie.png", kind: "image", name: "\u76ee\u6807\u6750\u6599", threshold: 0.86, requiresManualConfirmation: true },
  { target: "button.sort_material", key: "beibao/beibao_diduan.png", kind: "image", name: "\u6574\u7406\u533a", threshold: 0.84, requiresManualConfirmation: true },
];

export function requiredVisualTargets(blueprint = BAG_ORGANIZE_BLUEPRINT) {
  const targets = new Set();
  for (const step of blueprint.steps || []) {
    if (!step || !step.target) continue;
    if (["hotkey", "delay", "text_input", "condition", "loop", "task_jump", "restore", "snapshot", "ocr_assert"].includes(step.type)) continue;
    if (String(step.target).includes("+") || /^\\d+ms$/i.test(String(step.target))) continue;
    targets.add(String(step.target));
  }
  return [...targets];
}

export function templateBindingForTarget(target, bindings = BAG_ORGANIZE_TEMPLATE_BINDINGS) {
  return bindings.find((item) => item.target === target) || null;
}

export function assessBagOrganizeReadiness(options = {}) {
  const blueprint = options.blueprint || BAG_ORGANIZE_BLUEPRINT;
  const bindings = options.bindings || BAG_ORGANIZE_TEMPLATE_BINDINGS;
  const targetAssets = options.targetAssets || {};
  const manuallyConfirmedTargets = new Set(options.manuallyConfirmedTargets || []);
  const steps = Array.isArray(blueprint.steps) ? blueprint.steps : [];
  const gaps = [];
  const targetStatus = {};
  if (steps.length < 10) gaps.push({ code: "insufficient_steps", detail: "need >=10 steps" });
  const hasRecovery = steps.some((s) => s.onFail === "restore" || String(s.id || "").includes("restore"));
  if (!hasRecovery) gaps.push({ code: "missing_recovery", detail: "missing recovery" });
  for (const target of requiredVisualTargets(blueprint)) {
    const binding = templateBindingForTarget(target, bindings);
    const asset = targetAssets[target] || null;
    const hasAsset = Boolean(asset && (asset.loaded || asset.dataUrl || asset.roi || binding?.key));
    const needsManual = Boolean(binding?.requiresManualConfirmation || asset?.requiresManualConfirmation);
    const manualOk = !needsManual || manuallyConfirmedTargets.has(target) || asset?.manualConfirmed === true;
    targetStatus[target] = { bound: hasAsset, bindingKey: binding?.key || null, needsManualConfirmation: needsManual, manualConfirmed: manualOk };
    if (!hasAsset) gaps.push({ code: "missing_asset", target });
    if (needsManual && !manualOk) gaps.push({ code: "manual_confirmation_required", target });
  }
  return {
    blueprintId: blueprint.id,
    stepCount: steps.length,
    readyOffline: gaps.every((g) => g.code === "manual_confirmation_required"),
    liveAuthorized: false,
    gaps,
    targetStatus,
    notes: ["Offline readiness never authorizes live HWND input."],
  };
}
