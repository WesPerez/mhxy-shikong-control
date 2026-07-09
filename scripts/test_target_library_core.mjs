#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  TARGET_LIBRARY_KIND,
  mergeImportedTargetLibrary,
  targetLibraryExportPayload,
  targetLibraryTargetsFromPayload,
} from "../src/target-library-core.js";

const fixedNow = "2026-07-10T00:00:00.000Z";
const options = {
  schemaVersion: 9,
  defaultImageThreshold: 0.91,
  now: () => fixedNow,
  randomId: (prefix) => `${prefix}.generated`,
};

function imageTarget(overrides = {}) {
  return {
    id: "target.image",
    name: "Image target",
    kind: "image",
    dataUrl: "data:image/png;base64,aaa",
    match: { threshold: 0.88, scope: "window" },
    click: { button: "left", point: "center" },
    texts: [],
    note: "",
    ...overrides,
  };
}

function testExportPayloadMetadata() {
  const payload = targetLibraryExportPayload([imageTarget({ match: {} })], options);

  assert.equal(payload.kind, TARGET_LIBRARY_KIND);
  assert.equal(payload.schemaVersion, 9);
  assert.equal(payload.exportedAt, fixedNow);
  assert.equal(payload.targetCount, 1);
  assert.equal(payload.targets[0].id, "target.image");
  assert.equal(payload.targets[0].match.threshold, 0.91);
}

function testImportAcceptsWorkspaceTargets() {
  const imported = targetLibraryTargetsFromPayload(
    {
      schemaVersion: 9,
      workflows: [],
      targets: [imageTarget({ id: "target.from-workspace", name: "From workspace" })],
    },
    options,
  );

  assert.equal(imported.length, 1);
  assert.equal(imported[0].id, "target.from-workspace");
  assert.equal(imported[0].name, "From workspace");
}

function testImportDedupesById() {
  const imported = targetLibraryTargetsFromPayload(
    {
      kind: TARGET_LIBRARY_KIND,
      targets: [
        imageTarget({ id: "target.same", name: "Old" }),
        imageTarget({ id: "target.same", name: "New", dataUrl: "data:image/png;base64,new" }),
      ],
    },
    options,
  );

  assert.equal(imported.length, 1);
  assert.equal(imported[0].id, "target.same");
  assert.equal(imported[0].name, "New");
  assert.equal(imported[0].dataUrl, "data:image/png;base64,new");
}

function testImportAcceptsEmptyTargetsArray() {
  const imported = targetLibraryTargetsFromPayload({ kind: TARGET_LIBRARY_KIND, targets: [] }, options);

  assert.deepEqual(imported, []);
}

function testMergeAddsMissingTarget() {
  const existing = [imageTarget({ id: "target.existing" })];
  const incoming = [imageTarget({ id: "target.new", name: "New target" })];

  const result = mergeImportedTargetLibrary(existing, incoming, options);

  assert.deepEqual(result, { total: 1, added: 1, updated: 0, skipped: 0 });
  assert.equal(existing[0].id, "target.new");
  assert.equal(existing[1].id, "target.existing");
}

function testMergeFillsPlaceholderWithoutOverwritingUserAsset() {
  const existing = [
    imageTarget({
      id: "target.shared",
      name: "User sample",
      dataUrl: "data:image/png;base64,user",
      note: "用户手工采样",
      match: { threshold: 0.77, scope: "window" },
      click: { button: "right", point: "top-left" },
      updatedAt: "2026-07-09T00:00:00.000Z",
    }),
    imageTarget({
      id: "target.placeholder",
      name: "Placeholder",
      kind: "unknown",
      dataUrl: "",
      roi: null,
      texts: [],
      note: "由任务步骤生成",
      match: { threshold: 0.86, scope: "window" },
      click: { button: "left", point: "center" },
    }),
  ];
  const incoming = [
    imageTarget({
      id: "target.shared",
      name: "Imported shared",
      dataUrl: "data:image/png;base64,imported",
      note: "Imported note",
      match: { threshold: 0.99, scope: "roi" },
      click: { button: "left", point: "bottom-right" },
    }),
    imageTarget({
      id: "target.placeholder",
      name: "Imported placeholder",
      dataUrl: "data:image/png;base64,filled",
      note: "Imported placeholder note",
      match: { threshold: 0.7, scope: "roi" },
      click: { button: "right", point: "bottom-right" },
      source: { package: "fixture" },
      width: 128,
      height: 64,
    }),
  ];

  const result = mergeImportedTargetLibrary(existing, incoming, options);

  assert.deepEqual(result, { total: 2, added: 0, updated: 1, skipped: 1 });
  assert.equal(existing[0].dataUrl, "data:image/png;base64,user");
  assert.equal(existing[0].note, "用户手工采样");
  assert.equal(existing[0].match.threshold, 0.77);
  assert.equal(existing[0].click.button, "right");
  assert.equal(existing[0].updatedAt, "2026-07-09T00:00:00.000Z");

  assert.equal(existing[1].kind, "image");
  assert.equal(existing[1].dataUrl, "data:image/png;base64,filled");
  assert.equal(existing[1].note, "Imported placeholder note");
  assert.equal(existing[1].match.threshold, 0.7);
  assert.equal(existing[1].click.button, "right");
  assert.equal(existing[1].source.package, "fixture");
  assert.equal(existing[1].width, 128);
  assert.equal(existing[1].height, 64);
  assert.equal(existing[1].updatedAt, fixedNow);
}

function testMergeFillsOcrTextsWhenEmpty() {
  const existing = [
    imageTarget({
      id: "target.ocr",
      kind: "ocr",
      dataUrl: "",
      texts: [],
      note: "",
    }),
  ];
  const incoming = [
    imageTarget({
      id: "target.ocr",
      kind: "ocr",
      dataUrl: "",
      texts: ["活力", "体力"],
      note: "OCR hints",
    }),
  ];

  const result = mergeImportedTargetLibrary(existing, incoming, options);

  assert.deepEqual(result, { total: 1, added: 0, updated: 1, skipped: 0 });
  assert.deepEqual(existing[0].texts, ["活力", "体力"]);
  assert.equal(existing[0].note, "OCR hints");
  assert.equal(existing[0].updatedAt, fixedNow);
}

const tests = [
  testExportPayloadMetadata,
  testImportAcceptsWorkspaceTargets,
  testImportDedupesById,
  testImportAcceptsEmptyTargetsArray,
  testMergeAddsMissingTarget,
  testMergeFillsPlaceholderWithoutOverwritingUserAsset,
  testMergeFillsOcrTextsWhenEmpty,
];

for (const test of tests) {
  test();
}

console.log(`target-library-core: ${tests.length} tests passed`);
