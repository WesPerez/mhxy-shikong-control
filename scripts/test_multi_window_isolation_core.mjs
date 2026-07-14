import assert from "node:assert/strict";
import { analyzeWindowEventTimeline, assessDualQueueIsolation, buildIsolationFixture } from "../src/multi-window-isolation-core.js";
const good = analyzeWindowEventTimeline([
  { hwnd: "1", startMs: 0, endMs: 10 },
  { hwnd: "1", startMs: 10, endMs: 20 },
  { hwnd: "2", startMs: 5, endMs: 15 },
]);
assert.equal(good.sameWindowSerial, true);
assert.equal(good.crossWindowOverlap, true);
const bad = analyzeWindowEventTimeline([
  { hwnd: "1", startMs: 0, endMs: 20 },
  { hwnd: "1", startMs: 10, endMs: 30 },
]);
assert.equal(bad.sameWindowSerial, false);
const assessment = assessDualQueueIsolation(buildIsolationFixture());
assert.equal(assessment.readyOffline, true);
assert.equal(assessment.liveAuthorized, false);
console.log("multi-window-isolation-core: ok");
