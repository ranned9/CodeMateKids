import { captureContext, isCurrentContext } from "../core/viewContext.js";

/**
 * 确认当前修改并等待运行终态。得到 ready 后，调用方应立即替换工作区。
 */
export async function prepareWorkspaceChange({
  state, reason, confirm, leaveRunContext,
  context = captureContext(state),
  isLatest = () => true,
}) {
  const stillRequested = () => isLatest() && isCurrentContext(state, context);
  if (!stillRequested() || !(await confirm()) || !stillRequested()) {
    return "superseded";
  }

  const revision = state.programRevision;
  const stopping = leaveRunContext(reason);
  const afterStop = captureContext(state);
  const result = await stopping;
  if (!isLatest() || !isCurrentContext(state, afterStop) || revision !== state.programRevision) {
    return "superseded";
  }
  return result?.stopped === false ? "run-pending" : "ready";
}
