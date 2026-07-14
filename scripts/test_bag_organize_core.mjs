import assert from "node:assert/strict";
import { BAG_ORGANIZE_BLUEPRINT, assessBagOrganizeReadiness, requiredVisualTargets } from "../src/bag-organize-core.js";
assert.ok(BAG_ORGANIZE_BLUEPRINT.steps.length >= 10);
assert.ok(requiredVisualTargets().includes("item.target_material"));
const a = assessBagOrganizeReadiness({ targetAssets: Object.fromEntries(requiredVisualTargets().map((t)=>[t,{loaded:true}])) });
assert.equal(a.liveAuthorized, false);
assert.equal(a.readyOffline, true);
console.log("bag-organize-core: 1 test suite passed");
