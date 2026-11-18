/** RG-06 / RG-15：页面版本归属、旧辅导丢弃与 skip 去重。 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asUrl = (relative) => pathToFileURL(path.join(root, relative)).href;

const view = await import(asUrl("frontend/js/core/viewContext.js"));
const guardModule = await import(asUrl("frontend/js/core/asyncGuard.js"));

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

guardModule.resetAsyncGuard();
const first = guardModule.nextSeq();
const second = guardModule.nextSeq();
assert.equal(guardModule.accept(first), true);
assert.equal(guardModule.accept(second), true);
assert.equal(guardModule.accept(first), false, "较旧回复必须被丢弃");

guardModule.resetAsyncGuard();
assert.equal(guardModule.markSkipSubmitted("main"), true);
assert.equal(guardModule.markSkipSubmitted("main"), false);
assert.equal(guardModule.wasSkipSubmitted("main"), true);
assert.equal(guardModule.markSkipSubmitted("variant"), true);

console.log("JS-VIEW-CONTEXT-CHECK PASSED");