/** Offline readiness for stall search (search only, never purchase). */
export const STALL_SEARCH_BLUEPRINT_ID = "stall-search";
export const STALL_SEARCH_BLUEPRINT = {
  id: STALL_SEARCH_BLUEPRINT_ID,
  label: "stall-search",
  category: "market",
  defaultPrefix: "stall-search",
  autoRecovery: true,
  description: "Open stall/search UI and only search; never purchase.",
  steps: [
    { type: "detect_page", name: "home", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible", onFail: "stop" },
    { type: "snapshot", name: "before", target: "window.client", command: "capture=strict", expect: "snapshot.observed", onFail: "stop" },
    { type: "hotkey", name: "open-market", target: "ALT+B", command: "mode=hwnd-key", expect: "market.open", onFail: "stop" },
    { type: "wait_image", name: "wait-market", target: "page.market.ready", command: "threshold=0.85", expect: "visible", onFail: "restore" },
    { type: "ocr_assert", name: "ocr-market", target: "market", command: "lang=zh; roi=top", expect: "text_found", onFail: "restore" },
    { type: "wait_image", name: "search-box", target: "target.market.search", command: "threshold=0.84", expect: "visible", onFail: "restore" },
    { type: "image_click", name: "focus-search", target: "target.market.search", command: "button=left; point=center; confirmation=manual-required", expect: "search.focused", onFail: "restore", requiresManualConfirmation: true },
    { type: "text_input", name: "type-query", target: "query", command: "mode=hwnd-text; text=demo", expect: "query.entered", onFail: "restore" },
    { type: "condition", name: "no-purchase", target: "last.status", command: "guard=last.status==ok", expect: "search.only", onFail: "skip" },
    { type: "snapshot", name: "results", target: "window.client", command: "capture=strict; purpose=stall_search", expect: "snapshot.observed", onFail: "restore" },
    { type: "delay", name: "settle", target: "600ms", command: "reason=search", expect: "time.elapsed", onFail: "restore" },
    { type: "hotkey", name: "close", target: "ESC", command: "mode=hwnd-key", expect: "closed", onFail: "stop", id: "stall-restore" },
    { type: "detect_page", name: "home-back", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible", onFail: "stop" },
  ],
};
export const STALL_SEARCH_TEMPLATE_BINDINGS = [
  { target: "page.home.ready", key: "zonghe/jiahao.png", kind: "page", name: "home", threshold: 0.86 },
  { target: "page.market.ready", key: "zonghe/jiahao.png", kind: "page", name: "market-page", threshold: 0.84 },
  { target: "target.market.search", key: "zonghe/jiahao.png", kind: "image", name: "search", threshold: 0.84, requiresManualConfirmation: true },
];
export function requiredVisualTargets(blueprint = STALL_SEARCH_BLUEPRINT) {
  const targets = new Set();
  for (const step of blueprint.steps || []) {
    if (!step?.target) continue;
    if (["hotkey","delay","text_input","condition","loop","task_jump","restore","snapshot","ocr_assert"].includes(step.type)) continue;
    if (String(step.target).includes("+") || /^\\d+ms$/i.test(String(step.target))) continue;
    targets.add(String(step.target));
  }
  return [...targets];
}
export function assessStallSearchReadiness(options = {}) {
  const blueprint = options.blueprint || STALL_SEARCH_BLUEPRINT;
  const bindings = options.bindings || STALL_SEARCH_TEMPLATE_BINDINGS;
  const targetAssets = options.targetAssets || {};
  const manuallyConfirmedTargets = new Set(options.manuallyConfirmedTargets || []);
  const gaps = [];
  if ((blueprint.steps || []).length < 10) gaps.push({ code: "insufficient_steps" });
  if (!(blueprint.steps || []).some((s) => s.onFail === "restore" || String(s.id || "").includes("restore"))) gaps.push({ code: "missing_recovery" });
  for (const target of requiredVisualTargets(blueprint)) {
    const binding = bindings.find((b) => b.target === target);
    const asset = targetAssets[target];
    const hasAsset = Boolean(asset && (asset.loaded || asset.dataUrl || asset.roi || binding?.key));
    const needsManual = Boolean(binding?.requiresManualConfirmation);
    const manualOk = !needsManual || manuallyConfirmedTargets.has(target) || asset?.manualConfirmed === true;
    if (!hasAsset) gaps.push({ code: "missing_asset", target });
    if (needsManual && !manualOk) gaps.push({ code: "manual_confirmation_required", target });
  }
  return { blueprintId: blueprint.id, stepCount: (blueprint.steps || []).length, readyOffline: gaps.every((g) => g.code === "manual_confirmation_required"), liveAuthorized: false, gaps, notes: ["Search only; never purchase."] };
}
