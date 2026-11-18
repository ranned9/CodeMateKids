/** RG-03：运行会话重入保护与凭据不可改写。 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionModule = await import(pathToFileURL(path.join(root, "frontend/js/core/runSession.js")).href);

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

console.log("JS-RUN-SESSION-CHECK PASSED");