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