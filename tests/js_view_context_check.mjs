/** 页面归属、工作区切换条件与跳过反馈重试。 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asUrl = (relative) => pathToFileURL(path.join(root, relative)).href;

const view = await import(asUrl("frontend/js/core/viewContext.js"));
const { createSkipRecorder } = await import(asUrl("frontend/js/core/asyncGuard.js"));
const { prepareWorkspaceChange } = await import(asUrl("frontend/js/workflows/workspace-change.js"));

const state = { activeTaskId: "main", pageVersion: 0 };
const oldContext = view.captureContext(state, "main");
assert.equal(view.isCurrentContext(state, oldContext), true);

view.nextPageVersion(state);
assert.equal(view.isCurrentContext(state, oldContext), false, "同任务旧版本必须失效");

const newContext = view.captureContext(state, "main");
assert.equal(view.isCurrentContext(state, newContext), true);
assert.equal(view.sameContext(oldContext, newContext), false);
assert.equal(view.sameContext(newContext, view.captureContext(state, "main")), true);

const disposedSession = { disposed: true };
assert.equal(view.isContextActive(state, newContext, disposedSession), false);
assert.equal(view.isContextActive(state, newContext, { disposed: false }), true);

state.activeTaskId = "variant";
view.nextPageVersion(state);
const crossContext = view.captureContext(state, "variant");
state.activeTaskId = "main";
assert.equal(view.isCurrentContext(state, crossContext), false, "跨任务回调必须丢弃");

state.programRevision = 1;
const options = { state, reason: "test", confirm: () => true };
assert.equal(await prepareWorkspaceChange({
  ...options,
  leaveRunContext() {
    view.nextPageVersion(state);
    return { stopped: false };
  },
}), "run-pending");
assert.equal(await prepareWorkspaceChange({
  ...options,
  leaveRunContext: async () => {
    view.nextPageVersion(state);
    await Promise.resolve();
    state.programRevision += 1;
    return { stopped: true };
  },
}), "superseded");
assert.equal(await prepareWorkspaceChange({
  ...options,
  isLatest: () => false,
  leaveRunContext() { assert.fail("过期操作不应改变课堂"); },
}), "superseded");

let sent = 0;
const recordSkip = createSkipRecorder(async (taskId) => {
  sent += 1;
  if (sent === 1) throw new Error("failed");
  return taskId;
});
const first = recordSkip("main");
assert.equal(recordSkip("main"), first);
await assert.rejects(first);
assert.equal(await recordSkip("main"), "main");
assert.equal(await recordSkip("main"), "main");
assert.equal(await recordSkip("variant"), "variant");
assert.equal(sent, 3);

console.log("JS-VIEW-CONTEXT-CHECK PASSED");
