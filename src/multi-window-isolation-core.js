/** Offline multi-window queue isolation helpers (no live input). */

export function analyzeWindowEventTimeline(events = []) {
  const byWindow = new Map();
  for (const event of events) {
    const hwnd = String(event?.hwnd || event?.windowId || "");
    if (!hwnd) continue;
    const start = Number(event?.startMs ?? event?.startedAtMs ?? event?.t0);
    const end = Number(event?.endMs ?? event?.endedAtMs ?? event?.t1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return { ok: false, reason: "invalid_event_bounds", event };
    }
    if (!byWindow.has(hwnd)) byWindow.set(hwnd, []);
    byWindow.get(hwnd).push({ ...event, hwnd, startMs: start, endMs: end });
  }
  const windows = [...byWindow.entries()].map(([hwnd, list]) => {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    let overlapSameWindow = false;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].startMs < sorted[i - 1].endMs) {
        overlapSameWindow = true;
        break;
      }
    }
    return { hwnd, events: sorted, overlapSameWindow, count: sorted.length };
  });
  const sameWindowSerial = windows.every((w) => !w.overlapSameWindow);
  let crossWindowOverlap = false;
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      for (const a of windows[i].events) {
        for (const b of windows[j].events) {
          if (a.startMs < b.endMs && b.startMs < a.endMs) crossWindowOverlap = true;
        }
      }
    }
  }
  return { ok: sameWindowSerial && windows.length >= 1, windowCount: windows.length, sameWindowSerial, crossWindowOverlap, windows };
}

export function assessDualQueueIsolation(plan = {}) {
  const windowA = plan.windowA || {};
  const windowB = plan.windowB || {};
  const queueA = Array.isArray(plan.queueA) ? plan.queueA : [];
  const queueB = Array.isArray(plan.queueB) ? plan.queueB : [];
  const gaps = [];
  if (!windowA.hwnd || !windowB.hwnd) gaps.push({ code: "missing_window_identity" });
  if (String(windowA.hwnd) === String(windowB.hwnd)) gaps.push({ code: "same_hwnd" });
  if (!queueA.length || !queueB.length) gaps.push({ code: "empty_queue" });
  const events = [
    ...(plan.eventsA || []).map((e) => ({ ...e, hwnd: windowA.hwnd })),
    ...(plan.eventsB || []).map((e) => ({ ...e, hwnd: windowB.hwnd })),
  ];
  const timeline = analyzeWindowEventTimeline(events);
  if (!timeline.sameWindowSerial) gaps.push({ code: "same_window_overlap" });
  if (plan.requireCrossWindowOverlap !== false && !timeline.crossWindowOverlap) gaps.push({ code: "missing_cross_window_overlap" });
  return { readyOffline: gaps.length === 0, liveAuthorized: false, gaps, timeline, notes: ["Same HWND serial", "Cross HWND may overlap"] };
}

export function buildIsolationFixture() {
  return {
    windowA: { hwnd: "111", pid: 1, title: "A" },
    windowB: { hwnd: "222", pid: 2, title: "B" },
    queueA: [{ id: "a1", workflowId: "wf-welfare", windowId: "111" }, { id: "a2", workflowId: "wf-bag", windowId: "111" }],
    queueB: [{ id: "b1", workflowId: "wf-team", windowId: "222" }, { id: "b2", workflowId: "wf-stall", windowId: "222" }, { id: "b3", workflowId: "wf-home", windowId: "222" }],
    eventsA: [{ id: "ea1", startMs: 0, endMs: 100 }, { id: "ea2", startMs: 120, endMs: 200 }],
    eventsB: [{ id: "eb1", startMs: 50, endMs: 150 }, { id: "eb2", startMs: 160, endMs: 220 }],
    requireCrossWindowOverlap: true,
  };
}
