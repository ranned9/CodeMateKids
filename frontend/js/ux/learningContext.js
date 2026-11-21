/** 学习上下文：一次练习的 scope/workspace 身份与上报载荷；
 *  只生成前端字段，不参与错因/等级判定。 */

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SEEN_HINTS = 8;

export function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

export function createWorkspaceId(source = "ws") {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${source}-${globalThis.crypto.randomUUID().slice(0, 13)}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${source}-${Date.now().toString(36)}${random}`.slice(0, 32);
}

export function createLearningScope({ contentVersion, taskId, workspaceId, courseId = "demo-loop" } = {}) {
  return {
    courseId,
    contentVersion: contentVersion || null,
    taskId: taskId || null,
    workspaceId: isIdentifier(workspaceId) ? workspaceId : null,
  };
}

export function workspaceLearningScope(state, taskId = state.activeTaskId) {
  if (!state.contentVersion || !isIdentifier(state.workspaceId)) return null;
  return createLearningScope({
    taskId,
    contentVersion: state.contentVersion,
    workspaceId: state.workspaceId,
    courseId: state.course?.course?.courseId,
  });
}

export function addSeenHint(seen = [], hintId) {
  if (!isIdentifier(hintId)) {
    return { seen: [...seen], added: false, reason: "invalid" };
  }
  if (seen.includes(hintId)) {
    return { seen: [...seen], added: false, reason: "duplicate" };
  }
  const next = [...seen, hintId].slice(-MAX_SEEN_HINTS);
  return { seen: next, added: true, reason: "" };
}

export function buildLearningContext({
  scope = null,
  program = null,
  predictionId = null,
  seenHintIds = null,
  workspaceSource = null,
  runRequestId = null,
  turnId = null,
  replyToTurnId = null,
} = {}) {
  const context = {};
  if (scope) {
    context.scope = { ...scope };
  }
  if (program) {
    context.program = program;
  }
  if (isIdentifier(predictionId)) {
    context.predictionId = predictionId;
  }
  if (Array.isArray(seenHintIds)) {
    context.seenHintIds = seenHintIds.filter(isIdentifier).slice(0, MAX_SEEN_HINTS);
  }
  if (workspaceSource === "task" || workspaceSource === "project") {
    context.workspaceSource = workspaceSource;
  }
  if (isIdentifier(runRequestId)) {
    context.runRequestId = runRequestId;
  }
  if (isIdentifier(turnId)) context.turnId = turnId;
  if (isIdentifier(replyToTurnId)) context.replyToTurnId = replyToTurnId;
  return context;
}

export function mergeContext(previous, next) {
  const base = previous || {};
  const merged = { ...base, ...next };
  return {
    taskId: next?.taskId ?? base.taskId,
    workspaceId: next?.workspaceId ?? base.workspaceId,
    programRevision: next?.programRevision ?? base.programRevision,
    runRequestId: next?.runRequestId ?? base.runRequestId,
    predictionId: next?.predictionId ?? base.predictionId,
  };
}

export function isContextCurrent(current, snapshot) {
  if (!current || !snapshot) {
    return false;
  }
  return (
    current.taskId === snapshot.taskId &&
    current.workspaceId === snapshot.workspaceId &&
    current.programRevision === snapshot.programRevision &&
    current.runRequestId === snapshot.runRequestId
  );
}
