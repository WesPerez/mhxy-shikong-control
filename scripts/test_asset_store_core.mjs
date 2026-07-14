import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseDataUrl,
  buildAssetRelativePath,
  fileizeWorkspaceAssets,
  prepareWorkspaceForPersistence,
  rehydrateTargetAssets,
  bytesToDataUrl,
} from "../src/asset-store-core.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngishDataUrl(label) {
  const bytes = Buffer.from(`fake-image:${label}`, "utf8");
  return bytesToDataUrl(bytes, "image/png");
}

function testParseDataUrl() {
  const parsed = parseDataUrl(pngishDataUrl("a"));
  assert.ok(parsed);
  assert.equal(parsed.mime, "image/png");
  assert.ok(parsed.bytes.length > 0);
  assert.equal(parseDataUrl("not-a-data-url"), null);
}

function testBuildPath() {
  const hash = "a".repeat(64);
  assert.equal(buildAssetRelativePath(hash, "image/png"), `assets/by-hash/aa/${hash}.png`);
}

async function testFileizeAndDedupe() {
  const shared = pngishDataUrl("same");
  const workspace = {
    targets: [
      { id: "t1", name: "one", dataUrl: shared },
      { id: "t2", name: "two", dataUrl: shared },
      { id: "t3", name: "three", dataUrl: pngishDataUrl("other") },
      { id: "t4", name: "empty" },
    ],
  };
  const result = await fileizeWorkspaceAssets(workspace, { hashBytes: async (b) => sha256(b) });
  assert.equal(result.stats.extracted, 3);
  assert.equal(result.stats.uniqueAssets, 2);
  assert.equal(result.stats.duplicateRefs, 1);
  assert.equal(result.workspace.targets[0].contentHash, result.workspace.targets[1].contentHash);
  assert.equal(result.workspace.targets[0].assetPath, result.workspace.targets[1].assetPath);
  assert.notEqual(result.workspace.targets[0].contentHash, result.workspace.targets[2].contentHash);
  assert.equal(result.assetsToWrite.length, 2);
  const sharedEntry = result.workspace.assetIndex.find((a) => a.targetIds.includes("t1"));
  assert.ok(sharedEntry.targetIds.includes("t2"));
}

async function testPrepareAndRehydrate() {
  const dataUrl = pngishDataUrl("persist");
  const fileized = await fileizeWorkspaceAssets(
    { targets: [{ id: "t1", dataUrl }] },
    { hashBytes: async (b) => sha256(b) },
  );
  // keep dataUrl in memory workspace
  assert.ok(fileized.workspace.targets[0].dataUrl);
  const prepared = prepareWorkspaceForPersistence(fileized.workspace);
  assert.equal(prepared.stats.stripped, 1);
  assert.equal(prepared.workspace.targets[0].dataUrl, undefined);
  assert.ok(prepared.workspace.targets[0].contentHash);
  assert.ok(prepared.workspace.targets[0].assetPath);

  const store = new Map(fileized.assetsToWrite.map((a) => [a.contentHash, a.bytes]));
  const rehydrated = await rehydrateTargetAssets(prepared.workspace.targets, async ({ contentHash }) => store.get(contentHash) || null);
  assert.equal(rehydrated.stats.restored, 1);
  assert.ok(rehydrated.targets[0].dataUrl.startsWith("data:image/png;base64,"));
}

testParseDataUrl();
testBuildPath();
await testFileizeAndDedupe();
await testPrepareAndRehydrate();
console.log("asset-store-core: 4 tests passed");
