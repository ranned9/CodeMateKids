/** 运行快照与归属：会话 → 页面版本 → 程序修订号/指纹，三层判定。 */

export function programFingerprint(root) {
  if (root == null) {
    return "";
  }
  return JSON.stringify(root);
}

export function createRunViewContext({
  requestId = "",
  taskId = "",
  pageVersion = 0,
  programRevision = 0,
  predictionValue = null,
  predictionSource = "initial",
  fingerprint = "",
} = {}) {
  return Object.freeze({
    requestId,
    taskId,
    pageVersion,
    programRevision,
    predictionValue,
    predictionSource,
    fingerprint,
  });
}

export function classifyResult({ state, record, programRevision = null, fingerprint = null } = {}) {
  if (!record || !state) {
    return "discarded";
  }
  if (record.taskId !== state.activeTaskId) {
    return "discarded";
  }
  if (record.pageVersion !== (state.pageVersion || 0)) {
    return "discarded";
  }
  const revision = programRevision == null ? state.programRevision : programRevision;
  const currentFingerprint = fingerprint == null ? programFingerprint(state.root) : fingerprint;
  if (record.programRevision !== revision || record.fingerprint !== currentFingerprint) {
    return "stale";
  }
  return "current";
}

export function isOwnershipAccepted(ownership) {
  return ownership === "current" || ownership === "stale";
}