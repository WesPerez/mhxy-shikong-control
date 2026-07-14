import assert from "node:assert/strict";
import { STALL_SEARCH_BLUEPRINT, assessStallSearchReadiness, requiredVisualTargets } from "../src/stall-search-core.js";
assert.ok(STALL_SEARCH_BLUEPRINT.steps.length >= 10);
const a = assessStallSearchReadiness({ targetAssets: Object.fromEntries(requiredVisualTargets().map(t=>[t,{loaded:true}])) });
assert.equal(a.liveAuthorized,false); assert.equal(a.readyOffline,true);
console.log("stall-search-core: ok");
