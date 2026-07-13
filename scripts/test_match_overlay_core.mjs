import assert from "node:assert/strict";
import {
  matchBoxMetaText,
  normalizeMatchBox,
  pickMatchFieldsFromResult,
  projectMatchBoxToStage,
} from "../src/match-overlay-core.js";

function testNormalizeMatchBoxAcceptsCamelAndSnake() {
  assert.deepEqual(
    normalizeMatchBox({ matchX: 10, matchY: 20, matchWidth: 32, matchHeight: 18 }),
    { x: 10, y: 20, width: 32, height: 18 },
  );
  assert.deepEqual(
    normalizeMatchBox({ match_x: 1.4, match_y: 2.6, match_width: 8.2, match_height: 9.7 }),
    { x: 1, y: 3, width: 8, height: 10 },
  );
}

function testNormalizeMatchBoxRejectsIncompleteGeometry() {
  assert.equal(normalizeMatchBox(null), null);
  assert.equal(normalizeMatchBox({ matchX: 1, matchY: 2, matchWidth: 0, matchHeight: 4 }), null);
  assert.equal(normalizeMatchBox({ matchX: 1, matchY: 2, matchWidth: 3 }), null);
  assert.equal(normalizeMatchBox({ matchX: "x", matchY: 2, matchWidth: 3, matchHeight: 4 }), null);
}

function testProjectMatchBoxToStageScalesWithImageRect() {
  const projected = projectMatchBoxToStage(
    { matchX: 10, matchY: 20, matchWidth: 40, matchHeight: 20 },
    { width: 200, height: 100 },
    { left: 50, top: 30, width: 100, height: 50 },
    { left: 10, top: 10 },
  );
  assert.deepEqual(projected, {
    left: 45,
    top: 30,
    width: 20,
    height: 10,
    label: "match: 10,20 40x20",
  });
  assert.equal(projectMatchBoxToStage({ matchX: 1 }, { width: 10, height: 10 }, { width: 10, height: 10 }, { left: 0, top: 0 }), null);
}

function testPickMatchFieldsAndMeta() {
  assert.deepEqual(
    pickMatchFieldsFromResult({ match_x: 5, match_y: 6, match_width: 7, match_height: 8, score: 0.9 }),
    { matchX: 5, matchY: 6, matchWidth: 7, matchHeight: 8 },
  );
  assert.equal(matchBoxMetaText({ matchX: 5, matchY: 6, matchWidth: 7, matchHeight: 8 }), "Match: 5,6 7x8");
  assert.equal(matchBoxMetaText(null), "Match: none");
}

const tests = [
  testNormalizeMatchBoxAcceptsCamelAndSnake,
  testNormalizeMatchBoxRejectsIncompleteGeometry,
  testProjectMatchBoxToStageScalesWithImageRect,
  testPickMatchFieldsAndMeta,
];

for (const test of tests) test();
console.log(`match-overlay-core: ${tests.length} tests passed`);
