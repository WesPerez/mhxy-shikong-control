import assert from "node:assert/strict";
import { TEAM_OBSERVE_BLUEPRINT, assessTeamObserveReadiness, requiredVisualTargets } from "../src/team-observe-core.js";
assert.ok(TEAM_OBSERVE_BLUEPRINT.steps.length >= 10);
const a = assessTeamObserveReadiness({ targetAssets: Object.fromEntries(requiredVisualTargets().map(t=>[t,{loaded:true}])) });
assert.equal(a.liveAuthorized,false); assert.equal(a.readyOffline,true);
console.log("team-observe-core: ok");
