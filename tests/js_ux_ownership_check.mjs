/** RG-UX-08：结果归属三层判定（会话 / 页面版本 / 程序修订号与指纹）。 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asUrl = (relative) => pathToFileURL(path.join(root, relative)).href;

const runContext = await import(asUrl("frontend/js/ux/runContext.js"));
const { predictionSourceFor } = await import(asUrl("frontend/js/ux/prediction.js"));

const rootTree = { blockId: "b-1", kind: "event.start", inputs: {}, next: null };
const state = { activeTaskId: "main", pageVersion: 3, programRevision: 5, root: rootTree };
const record = runContext.createRunViewContext({
  requestId: "run-1",
  taskId: "main",
  pageVersion: 3,
  programRevision: 5,
  predictionValue: 4,
  predictionSource: "initial",
  fingerprint: runContext.programFingerprint(rootTree),
});
assert.equal(Object.isFrozen(record), true, "快照必须冻结");
assert.equal(runContext.classifyResult({ state, record }), "current");
assert.equal(runContext.isOwnershipAccepted("current"), true);
assert.equal(runContext.isOwnershipAccepted("stale"), true);
assert.equal(runContext.isOwnershipAccepted("discarded"), false);

state.programRevision = 6;
assert.equal(runContext.classifyResult({ state, record }), "stale", "程序改过但仍在同一页面");

state.activeTaskId = "variant";
assert.equal(runContext.classifyResult({ state, record }), "discarded", "跨任务先判丢弃");

state.activeTaskId = "main";
state.pageVersion = 4;
assert.equal(runContext.classifyResult({ state, record }), "discarded", "同任务换页也丢弃");

const secondState = { activeTaskId: "main", pageVersion: 4, programRevision: 7, root: rootTree };
const secondRecord = runContext.createRunViewContext({
  requestId: "run-2",
  taskId: "main",
  pageVersion: 4,
  programRevision: 7,
  predictionValue: 4,
  predictionSource: "reguess",
  fingerprint: runContext.programFingerprint(rootTree),
});
assert.equal(runContext.classifyResult({ state: secondState, record: secondRecord }), "current");
secondState.root = { blockId: "b-2", kind: "move.forward", inputs: {}, next: null };
assert.equal(
  runContext.classifyResult({ state: secondState, record: secondRecord }),
  "stale",
  "修订号相同但指纹不同也必须判陈旧",
);
secondState.root = rootTree;
assert.equal(
  runContext.classifyResult({ state: secondState, record: secondRecord }),
  "current",
  "改后又撤回，指纹一致时恢复当前",
);
assert.equal(runContext.classifyResult({ state: secondState, record: null }), "discarded");

secondState.predictionContext = new Map([["main", { pageVersion: 4, programRevision: 7, source: "reguess" }]]);
assert.equal(predictionSourceFor(secondState, "main"), "reguess");
secondState.programRevision += 1;
assert.equal(predictionSourceFor(secondState, "main"), "carried");
secondState.programRevision -= 1;
secondState.pageVersion += 1;
assert.equal(predictionSourceFor(secondState, "main"), "carried");

console.log("JS-UX-OWNERSHIP-CHECK PASSED");
