/** RG-03：运行会话重入保护与凭据不可改写。 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionModule = await import(pathToFileURL(path.join(root, "frontend/js/core/runSession.js")).href);
const { createRunner } = await import(pathToFileURL(path.join(root, "frontend/js/views/runner.js")).href);
const { state } = await import(pathToFileURL(path.join(root, "frontend/js/state.js")).href);

const {
  createRunSession,
  tryBegin,
  markAccepted,
  enterCancelling,
  markDisposed,
  release,
  isBusy,
} = sessionModule;

const session = createRunSession();
assert.equal(isBusy(session), false);
assert.equal(tryBegin(session), true);
assert.equal(tryBegin(session), false);
assert.equal(tryBegin(session), false);
assert.equal(isBusy(session), true);

assert.equal(
  markAccepted(session, {
    requestId: "run-aaaa",
    cancelToken: "token-aaaa",
    taskId: "main",
    pageVersion: 1,
  }),
  true,
);
assert.equal(session.requestId, "run-aaaa");
assert.equal(session.cancelToken, "token-aaaa");

assert.equal(
  markAccepted(session, {
    requestId: "run-bbbb",
    cancelToken: "token-bbbb",
    taskId: "variant",
    pageVersion: 2,
  }),
  false,
);
assert.equal(session.requestId, "run-aaaa");
assert.equal(session.cancelToken, "token-aaaa");

assert.equal(enterCancelling(session), true);
assert.equal(session.phase, "cancelling");
assert.equal(isBusy(session), true);

assert.equal(release(session), true);
assert.equal(isBusy(session), false);
assert.equal(tryBegin(session), true);
release(session);

const abandoned = createRunSession();
tryBegin(abandoned);
markDisposed(abandoned);
markAccepted(abandoned, {
  requestId: "run-cccc",
  cancelToken: "token-cccc",
  taskId: "main",
  pageVersion: 3,
});
assert.equal(abandoned.phase, "abandoned");
assert.equal(isBusy(abandoned), true);
release(abandoned);
assert.equal(isBusy(abandoned), false);

// 通过实际运行控制器验证 SSE 断线后的按钮状态与再次提交。
const requests = [];
const cancellations = [];
const toasts = [];
let stream;
let finished = true;
let nextCancelResponse = null;
let nextSubmitResponse = null;
globalThis.EventSource = class {
  constructor() {
    stream = this;
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
};
globalThis.window = {
  setTimeout: (callback) => callback(),
  __cmkApi: {
    async submitRun(payload) {
      requests.push(payload);
      return nextSubmitResponse;
    },
    async cancelRun(requestId, cancelToken) {
      cancellations.push({ requestId, cancelToken });
      const response = nextCancelResponse;
      nextCancelResponse = null;
      return response;
    },
    async getRun() {
      return { finished, status: finished ? "cancelled" : "running" };
    },
  },
};
Object.assign(state, {
  startup: { status: "ready" },
  tasks: new Map([["main", { taskId: "main", enterable: true }]]),
  blocksByKind: new Map([["event.start", { runnable: true }]]),
  root: { blockId: "b-start", kind: "event.start", inputs: {}, body: [], next: null },
  prediction: new Map([["main", 0]]),
});
const elements = Object.fromEntries(
  ["run", "stop", "reset", "hint", "stateChip"].map((key) => [key, { addEventListener() {} }]),
);
const runner = createRunner({
  elements,
  state,
  editor: { state, render() {} },
  api: window.__cmkApi,
  toast: (message) => toasts.push(message),
  refresh() {},
});

await runner.run();
assert.equal(elements.run.disabled, true);
assert.equal(elements.stop.disabled, false);
const firstStream = stream;
state.runningBlockId = "b-start";
await firstStream.onerror();
assert.equal(firstStream.closed, true);
assert.equal(runner.isBusy(), false);
assert.equal(state.runningBlockId, null);
assert.equal(elements.run.disabled, false);
assert.match(toasts.at(-1), /可以再试一次/);

await runner.run();
assert.equal(requests.length, 2);
assert.notEqual(requests[0].requestId, requests[1].requestId);
await firstStream.onerror();
assert.equal(cancellations.length, 1);
assert.equal(runner.getSession().requestId, requests[1].requestId);

finished = false;
await stream.onerror();
assert.equal(runner.isBusy(), true);
assert.equal(elements.run.disabled, true);
assert.equal(elements.stop.disabled, false);
await runner.run();
assert.equal(requests.length, 2);

finished = true;
await runner.stop();
assert.equal(runner.isBusy(), false);
assert.equal(elements.run.disabled, false);
assert.deepEqual(cancellations, [
  { requestId: requests[0].requestId, cancelToken: requests[0].cancelToken },
  { requestId: requests[1].requestId, cancelToken: requests[1].cancelToken },
  { requestId: requests[1].requestId, cancelToken: requests[1].cancelToken },
]);
await runner.run();
assert.equal(requests.length, 3);

let rejectPendingStop;
nextCancelResponse = new Promise((_, reject) => {
  rejectPendingStop = reject;
});
const pendingStop = runner.stop();
await stream.onerror();
rejectPendingStop(new Error("late cancel failure"));
await pendingStop;
assert.equal(runner.isBusy(), false);
assert.equal(elements.run.disabled, false);

state.predictionPending.set("main", {});
await runner.run();
assert.equal(requests.length, 3);
assert.equal(elements.run.disabled, true);
state.predictionPending.clear();

let acceptRun;
nextSubmitResponse = new Promise((resolve) => { acceptRun = resolve; });
const cancelBeforeAccept = runner.run();
assert.equal(elements.stop.disabled, false);
await runner.stop();
assert.equal(elements.stop.disabled, true);
acceptRun();
await cancelBeforeAccept;
assert.equal(cancellations.at(-1).requestId, requests[3].requestId);
await stream.onerror();
assert.equal(runner.isBusy(), false);

nextSubmitResponse = null;
await runner.run();
const lastRequestId = runner.getSession().requestId;
finished = false;
const failedLeave = await runner.leaveRunContext({ reason: "switch" });
assert.equal(failedLeave.stopped, false);
assert.equal(runner.getSession().disposed, true);
assert.equal(elements.stop.disabled, false);
finished = true;
await runner.stop();
assert.equal(runner.isBusy(), false);
assert.equal(state.runRecovery, null);
assert.equal(state.phase, "editing");
assert.equal(cancellations.at(-1).requestId, lastRequestId);

console.log("JS-RUN-SESSION-CHECK PASSED");
