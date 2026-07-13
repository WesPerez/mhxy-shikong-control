/** Offline readiness helpers for the home-vitality blueprint (no live input). */

export const HOME_VITALITY_BLUEPRINT_ID = 'home-vitality';

export const HOME_VITALITY_BLUEPRINT = {
  id: HOME_VITALITY_BLUEPRINT_ID,
  label: '\u5bb6\u56ed\u6d3b\u529b',
  category: '\u5bb6\u56ed',
  defaultPrefix: '\u5bb6\u56ed\u6d3b\u529b',
  description:
    '\u6253\u5f00\u5bb6\u56ed/\u4eba\u7269\u76f8\u5173\u5165\u53e3\uff0c\u6309 OCR \u548c\u56fe\u50cf\u76ee\u6807\u5904\u7406\u6d3b\u529b\u3001\u6253\u7406\u4e0e\u786e\u8ba4\u52a8\u4f5c\u3002',
  steps: [
    { type: 'detect_page', name: '\u786e\u8ba4\u4e3b\u754c\u9762', target: 'page.home.ready', command: 'threshold=0.86', expect: 'home.visible' },
    { type: 'hotkey', name: '\u6253\u5f00\u529f\u80fd\u9762\u677f', target: 'ALT+N', command: 'mode=hwnd-key', expect: 'panel.open' },
    { type: 'delay', name: '\u7b49\u5f85\u754c\u9762\u52a8\u753b', target: '800ms', command: 'reason=panel_transition', expect: 'time.elapsed' },
    { type: 'ocr_assert', name: '\u786e\u8ba4\u529f\u80fd\u9762\u677f', target: '\u5bb6\u56ed', command: 'lang=zh; roi=top', expect: 'text_found' },
    { type: 'wait_image', name: '\u7b49\u5f85\u5bb6\u56ed\u5165\u53e3', target: 'entry.home', command: 'threshold=0.86', expect: 'visible' },
    { type: 'image_click', name: '\u8fdb\u5165\u5bb6\u56ed', target: 'entry.home', command: 'button=left; point=center', expect: 'home.panel.ready' },
    { type: 'retry_until', name: '\u7b49\u5f85\u5bb6\u56ed\u9875\u9762', target: 'page.home_yard.ready', command: 'interval=700ms', expect: 'ready=true', timeoutMs: 7000, retry: 3 },
    { type: 'wait_image', name: '\u7b49\u5f85\u6253\u7406\u6309\u94ae', target: 'button.home_clean', command: 'threshold=0.86', expect: 'visible' },
    { type: 'image_click', name: '\u6267\u884c\u6253\u7406', target: 'button.home_clean', command: 'button=left; point=center', expect: 'action.accepted' },
    { type: 'delay', name: '\u7b49\u5f85\u7ed3\u7b97', target: '1000ms', command: 'reason=server_response', expect: 'time.elapsed' },
    { type: 'ocr_assert', name: '\u786e\u8ba4\u6d3b\u529b\u72b6\u6001', target: '\u6d3b\u529b', command: 'lang=zh; roi=panel', expect: 'text_found' },
    { type: 'snapshot', name: '\u8bb0\u5f55\u5bb6\u56ed\u7ed3\u679c', target: 'window.client', command: 'dry-run log only', expect: 'snapshot.recorded' },
    { type: 'restore', name: '\u6062\u590d\u4e3b\u754c\u9762', target: 'restore.home', command: 'safe sequence', expect: 'page.home.ready' },
  ],
};

export const HOME_VITALITY_TEMPLATE_BINDINGS = [
  { target: 'page.home.ready', key: 'zonghe/jiahao.png', kind: 'page', name: '\u4e3b\u754c\u9762\u5224\u5b9a', threshold: 0.86 },
  { target: 'entry.home', key: 'jiayuan/jiayuan.png', kind: 'image', name: '\u5bb6\u56ed\u5165\u53e3', threshold: 0.82 },
  { target: 'page.home_yard.ready', key: 'jiayuan/dali.png', kind: 'page', name: '\u5bb6\u56ed\u6253\u7406\u9875\u5224\u5b9a' },
  { target: 'button.home_clean', key: 'jiayuan/dali.png', kind: 'image', name: '\u5bb6\u56ed\u6253\u7406\u6309\u94ae' },
];

/** Live e2e gates for P4; all stay blocked until real game windows and evidence exist. */
export const HOME_VITALITY_LIVE_GATE_CHECKLIST = [
  {
    id: 'game-window-identity',
    label: '\u81f3\u5c11 1 \u4e2a\u7ecf\u9a8c\u8bc1\u7684\u6e38\u620f HWND\uff08\u975e\u63a7\u5236\u5668\u7a97\u53e3\uff09',
    required: true,
    liveRequired: true,
  },
  {
    id: 'capture-health-verified',
    label: '\u76ee\u6807\u7a97\u53e3 health-verified \u6355\u83b7\uff08\u975e\u9ed1\u5e27/\u65e7\u5e27/\u684c\u9762\u56de\u9000\uff09',
    required: true,
    liveRequired: true,
  },
  {
    id: 'entry-home-live-match',
    label: 'entry.home \u5728\u6e38\u620f\u5ba2\u6237\u533a\u5b9e\u9645\u5339\u914d\u901a\u8fc7',
    required: true,
    liveRequired: true,
  },
  {
    id: 'non-destructive-single-step',
    label: '\u5148\u5b8c\u6210\u65e0\u7834\u574f\u5355\u6b65\uff08wait_image/\u5e72\u8dd1\u622a\u56fe\uff09\u518d\u53d1\u9001\u70b9\u51fb',
    required: true,
    liveRequired: true,
  },
  {
    id: 'foreground-unchanged',
    label: '\u8f93\u5165\u524d\u540e\u524d\u53f0 HWND \u4e0e\u9f20\u6807\u5750\u6807\u4e0d\u53d8',
    required: true,
    liveRequired: true,
  },
  {
    id: 'control-window-isolation',
    label: '\u5bf9\u7167\u7a97\u53e3\u4e0d\u63a5\u6536\u8bef\u8f93\u5165\uff08\u82e5\u5b58\u5728\u7b2c\u4e8c\u6e38\u620f\u7a97\u53e3\uff09',
    required: false,
    liveRequired: true,
  },
  {
    id: 'verified-head-and-app-gates',
    label: 'verifiedHead \u4e0e currentCommitBuilt/AppLaunched \u95e8\u7981\u901a\u8fc7\u4e14\u5de5\u4f5c\u6811\u4ea7\u54c1\u6e05\u6d01',
    required: true,
    liveRequired: true,
  },
];

const VISUAL_STEP_TYPES = new Set(['detect_page', 'wait_image', 'image_click', 'double_click', 'retry_until']);

export function isLogicalVisualTarget(target) {
  const text = String(target || '').trim();
  if (!text || text.includes('=')) return false;
  if (/^[A-Z]+(?:\+[A-Z0-9]+)+$/i.test(text)) return false;
  if (/^\d+ms$/i.test(text)) return false;
  return /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_.:-]*$/u.test(text);
}

export function requiredVisualTargets(blueprint = HOME_VITALITY_BLUEPRINT) {
  const targets = new Set();
  for (const step of blueprint.steps || []) {
    if (!VISUAL_STEP_TYPES.has(step.type)) continue;
    if (isLogicalVisualTarget(step.target)) targets.add(step.target);
  }
  return [...targets];
}

export function templateBindingForTarget(target, bindings = HOME_VITALITY_TEMPLATE_BINDINGS) {
  return bindings.find((item) => item.target === target) || null;
}

export function assessHomeVitalityReadiness(options = {}) {
  const blueprint = options.blueprint || HOME_VITALITY_BLUEPRINT;
  const bindings = options.bindings || HOME_VITALITY_TEMPLATE_BINDINGS;
  const targetAssets = options.targetAssets || {};
  const availableKeys = new Set(options.availableTemplateKeys || []);

  const steps = (blueprint.steps || []).map((step, index) => {
    const base = {
      order: index + 1,
      type: step.type,
      name: step.name || step.type,
      target: step.target || '',
      liveInput: false,
      ready: false,
      status: 'unknown',
      detail: '',
    };

    if (step.type === 'hotkey') {
      return { ...base, status: 'planned_hotkey', ready: true, detail: 'hotkey is offline-defined; live HWND send is not claimed' };
    }
    if (step.type === 'delay') {
      return { ...base, status: 'planned_delay', ready: true, detail: 'delay is offline-defined' };
    }
    if (step.type === 'ocr_assert') {
      return { ...base, status: 'needs_ocr_backend', ready: false, detail: 'OCR backend/live text proof is not claimed offline' };
    }
    if (step.type === 'snapshot') {
      return { ...base, status: 'planned_snapshot', ready: true, detail: 'snapshot is dry-run/log only offline' };
    }
    if (step.type === 'restore') {
      return { ...base, status: 'planned_restore', ready: false, detail: 'restore sequence is planned; live recovery not proven' };
    }
    if (!VISUAL_STEP_TYPES.has(step.type)) {
      return { ...base, status: 'planned_other', ready: true, detail: 'non-visual step is offline-defined' };
    }

    const binding = templateBindingForTarget(step.target, bindings);
    const asset = targetAssets[step.target] || null;
    const templateKey = binding?.key || '';
    const hasAsset = Boolean(asset && (asset.loaded || asset.dataUrl || asset.roi));
    const hasBuiltin = Boolean(templateKey && availableKeys.has(templateKey));

    if (hasAsset) {
      return {
        ...base,
        ready: true,
        status: 'target_asset_bound',
        templateKey,
        detail: 'workspace target asset/ROI bound; still not live-authorized',
      };
    }
    if (hasBuiltin) {
      return {
        ...base,
        ready: true,
        status: 'builtin_template_available',
        templateKey,
        detail: `builtin template available: ${templateKey}; still not live-authorized`,
      };
    }
    return {
      ...base,
      ready: false,
      status: 'needs_capture',
      templateKey,
      detail: templateKey
        ? `missing builtin key or workspace asset for ${templateKey}`
        : 'missing visual binding for logical target',
    };
  });

  const requiredTargets = requiredVisualTargets(blueprint);
  const missingTargets = requiredTargets.filter((target) => {
    const binding = templateBindingForTarget(target, bindings);
    const asset = targetAssets[target] || null;
    const hasAsset = Boolean(asset && (asset.loaded || asset.dataUrl || asset.roi));
    const hasBuiltin = Boolean(binding?.key && availableKeys.has(binding.key));
    return !(hasAsset || hasBuiltin);
  });
  const visualReady = steps
    .filter((step) => VISUAL_STEP_TYPES.has(step.type))
    .every((step) => step.ready);

  return {
    blueprintId: blueprint.id,
    label: blueprint.label,
    stepCount: steps.length,
    requiredVisualTargets: requiredTargets,
    missingVisualTargets: missingTargets,
    steps,
    offlineScaffoldReady: visualReady && missingTargets.length === 0,
    liveReady: false,
    liveInputAuthorized: false,
    notes: [
      'Offline readiness never authorizes live HWND input.',
      'OCR and restore steps do not count as live success.',
    ],
  };
}

export function summarizeHomeVitalityGaps(assessment) {
  const source = assessment || assessHomeVitalityReadiness();
  const gaps = [];
  for (const target of source.missingVisualTargets || []) {
    gaps.push({ kind: 'visual_target', target, status: 'needs_capture' });
  }
  for (const step of source.steps || []) {
    if (step.status === 'needs_ocr_backend') {
      gaps.push({ kind: 'ocr', target: step.target, status: step.status, step: step.name });
    }
    if (step.status === 'planned_restore') {
      gaps.push({ kind: 'restore', target: step.target, status: step.status, step: step.name });
    }
  }
  return {
    blueprintId: source.blueprintId,
    offlineScaffoldReady: source.offlineScaffoldReady,
    liveReady: false,
    gapCount: gaps.length,
    gaps,
  };
}

export function assessHomeVitalityLiveGates(options = {}) {
  const observations = options.observations || {};
  const items = HOME_VITALITY_LIVE_GATE_CHECKLIST.map((gate) => {
    const observed = Boolean(observations[gate.id]);
    return {
      ...gate,
      satisfied: observed,
      // Fail-closed: never claim live readiness from offline defaults.
      authorized: false,
    };
  });
  const required = items.filter((item) => item.required);
  const requiredSatisfied = required.every((item) => item.satisfied);
  return {
    blueprintId: HOME_VITALITY_BLUEPRINT_ID,
    liveReady: false,
    liveInputAuthorized: false,
    requiredSatisfied,
    blockedReason: requiredSatisfied
      ? 'required observations present but live authorization remains fail-closed until specialized live verifiers pass'
      : 'one or more required live gates lack observations',
    items,
  };
}
