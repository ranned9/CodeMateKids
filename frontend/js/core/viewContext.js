/** 页面版本与异步请求归属判定（纯逻辑，可在 Node 内断言）。 */

export function nextPageVersion(state) {
  state.pageVersion = (state.pageVersion || 0) + 1;
  return state.pageVersion;
}

export function captureContext(state, taskId) {
  return {
    taskId: taskId ?? state.activeTaskId,
    pageVersion: state.pageVersion || 0,
  };
}

export function captureLearningContext(state, taskId, predictionId = null) {
  return {
    taskId: taskId ?? state.activeTaskId,
    pageVersion: state.pageVersion || 0,
    studentId: state.studentId ?? null,
    workspaceId: state.workspaceId || null,
    contentVersion: state.contentVersion || null,
    programRevision: state.programRevision || 0,
    modelConfigRevision: state.modelConfigRevision || 0,
    predictionId: predictionId ?? null,
    runRequestId: state.learningRunRequestId ?? state.lastRunContext?.requestId ?? null,
  };
}

export function isLearningContextCurrent(state, snapshot) {
  if (!snapshot) {
    return false;
  }
  return (
    snapshot.taskId === state.activeTaskId &&
    snapshot.pageVersion === (state.pageVersion || 0) &&
    snapshot.studentId === (state.studentId ?? null) &&
    snapshot.workspaceId === (state.workspaceId || null) &&
    snapshot.contentVersion === (state.contentVersion || null) &&
    snapshot.programRevision === (state.programRevision || 0) &&
    snapshot.modelConfigRevision === (state.modelConfigRevision || 0) &&
    snapshot.runRequestId === (state.learningRunRequestId ?? state.lastRunContext?.requestId ?? null)
  );
}

export function isCurrentContext(state, ctx) {
  if (!ctx) {
    return false;
  }
  return ctx.taskId === state.activeTaskId && ctx.pageVersion === (state.pageVersion || 0);
}

export function sameContext(left, right) {
  if (!left || !right) {
    return false;
  }
  return left.taskId === right.taskId && left.pageVersion === right.pageVersion;
}

export function isContextActive(state, ctx, session = null) {
  if (session && session.disposed) {
    return false;
  }
  return isCurrentContext(state, ctx);
}
