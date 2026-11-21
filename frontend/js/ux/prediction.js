/** 预测生命周期：提交单飞、失败保留旧值、再猜与沿用来源。 */

export function predictionSourceFor(state, taskId) {
  const recorded = state.predictionContext?.get(taskId);
  if (!recorded) {
    return "initial";
  }
  if (recorded.pageVersion !== state.pageVersion || recorded.programRevision !== state.programRevision) {
    return "carried";
  }
  return recorded.source;
}
