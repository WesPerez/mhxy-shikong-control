/** Offline readiness for team prepare observe-only blueprint. */
export const TEAM_OBSERVE_BLUEPRINT_ID = "team-observe";
export const TEAM_OBSERVE_BLUEPRINT = {
  id: TEAM_OBSERVE_BLUEPRINT_ID,
  label: "team-observe",
  category: "team",
  defaultPrefix: "team-observe",
  autoRecovery: true,
  description: "Open team panel and only observe safe state; never auto apply/create unknown teams.",
  steps: [
    { type: "detect_page", name: "home", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible", onFail: "stop" },
    { type: "snapshot", name: "before", target: "window.client", command: "capture=strict", expect: "snapshot.observed", onFail: "stop" },
    { type: "hotkey", name: "open-team", target: "ALT+T", command: "mode=hwnd-key", expect: "team.open", onFail: "stop" },
    { type: "wait_image", name: "wait-team", target: "page.team.ready", command: "threshold=0.85", expect: "visible", onFail: "restore" },
    { type: "ocr_assert", name: "ocr-team", target: "team", command: "lang=zh; roi=top", expect: "text_found", onFail: "restore" },
    { type: "wait_image", name: "wait-member", target: "target.team.member", command: "threshold=0.84", expect: "visible", onFail: "restore" },
    { type: "condition", name: "safe-observe-only", target: "last.status", command: "guard=last.status==ok", expect: "observe.ok", onFail: "skip" },
    { type: "snapshot", name: "observe", target: "window.client", command: "capture=strict; purpose=team_observe", expect: "snapshot.observed", onFail: "restore" },
    { type: "delay", name: "settle", target: "600ms", command: "reason=observe", expect: "time.elapsed", onFail: "restore" },
    { type: "ocr_assert", name: "status-text", target: "status", command: "lang=zh; roi=panel", expect: "text_found", onFail: "restore" },
    { type: "hotkey", name: "close", target: "ESC", command: "mode=hwnd-key", expect: "closed", onFail: "stop", id: "team-restore" },
    { type: "detect_page", name: "home-back", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible", onFail: "stop" },
  ],
};
export const TEAM_OBSERVE_TEMPLATE_BINDINGS = [
  { target: "page.home.ready", key: "zonghe/jiahao.png", kind: "page", name: "home", threshold: 0.86 },
  { target: "page.team.ready", key: "zonghe/jiahao.png", kind: "page", name: "team-page", threshold: 0.84 },
  { target: "target.team.member", key: "zonghe/jiahao.png", kind: "image", name: "member", threshold: 0.84, requiresManualConfirmation: true },
];
export function requiredVisualTargets(blueprint = TEAM_OBSERVE_BLUEPRINT) {
  const targets = new Set();
  for (const step of blueprint.steps || []) {
    if (!step?.target) continue;
    if (["hotkey","delay","text_input","condition","loop","task_jump","restore","snapshot","ocr_assert"].includes(step.type)) continue;
    if (String(step.target).includes("+") || /^\\d+ms$/i.test(String(step.target))) continue;
    targets.add(String(step.target));
  }
  return [...targets];
}
export function assessTeamObserveReadiness(options = {}) {
  const blueprint = options.blueprint || TEAM_OBSERVE_BLUEPRINT;
  const bindings = options.bindings || TEAM_OBSERVE_TEMPLATE_BINDINGS;
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
  return { blueprintId: blueprint.id, stepCount: (blueprint.steps || []).length, readyOffline: gaps.every((g) => g.code === "manual_confirmation_required"), liveAuthorized: false, gaps, notes: ["Observe only; never auto-apply/create teams."] };
}
