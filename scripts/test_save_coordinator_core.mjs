import assert from "node:assert/strict";
import { createSaveCoordinator } from "../src/save-coordinator-core.js";

async function testSerializesOverlappingFlushes() {
  let active = 0;
  let maxActive = 0;
  let saves = 0;
  const coordinator = createSaveCoordinator({
    saveFn: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      saves += 1;
      return saves;
    },
  });
  const a = coordinator.flush();
  const b = coordinator.flush();
  await Promise.all([a, b]);
  assert.equal(maxActive, 1);
  assert.ok(saves >= 1);
}

async function testScheduleDebounce() {
  let saves = 0;
  const coordinator = createSaveCoordinator({
    saveFn: async () => {
      saves += 1;
      return saves;
    },
  });
  coordinator.schedule(40);
  coordinator.schedule(40);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(saves, 1);
}

await testSerializesOverlappingFlushes();
await testScheduleDebounce();
console.log("save-coordinator-core: 2 tests passed");
