/** 运行会话状态机：提交占用、凭据一次性写入与幂等释放。 */

const BUSY_PHASES = new Set(["validating", "running", "cancelling", "abandoned"]);

export function createRunSession() {
  return {
    phase: "idle",
    requestId: null,
    cancelToken: null,
    taskId: null,
    pageVersion: null,
    disposed: false,
    cancelOnAccept: false,
  };
}

export function isBusy(session) {
  return BUSY_PHASES.has(session.phase);
}

export function tryBegin(session) {
  if (isBusy(session)) {
    return false;
  }
  session.phase = "validating";
  session.disposed = false;
  session.cancelOnAccept = false;
  return true;
}

export function markAccepted(session, { requestId, cancelToken, taskId, pageVersion }) {
  if (session.requestId) {
    return false;
  }
  session.requestId = requestId;
  session.cancelToken = cancelToken;
  session.taskId = taskId;
  session.pageVersion = pageVersion;
  session.phase = session.disposed ? "abandoned" : "running";
  return true;
}

export function enterCancelling(session) {
  if (!isBusy(session)) {
    return false;
  }
  if (session.phase === "validating") {
    session.cancelOnAccept = true;
    return true;
  }
  session.phase = "cancelling";
  return true;
}

export function markDisposed(session) {
  session.disposed = true;
  session.cancelOnAccept = true;
}

export function release(session) {
  session.phase = "idle";
  session.requestId = null;
  session.cancelToken = null;
  session.taskId = null;
  session.pageVersion = null;
  session.disposed = false;
  session.cancelOnAccept = false;
  return true;
}

export function resetForTest(session) {
  release(session);
  return session;
}