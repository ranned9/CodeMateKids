/** 结果摘要：目标派生与"预测对照 + 目标达成"两句话，缺数据不补零、不编造结论。 */

export function deriveTargetSteps(task) {
  const checks = (task?.successCriteria || []).filter(
    (item) => item?.check?.object === "stage" && item?.check?.field === "steps",
  );
  if (!checks.length) {
    return null;
  }
  const values = new Set();
  for (const item of checks) {
    if (item.check.op !== "eq" || !Number.isInteger(item.check.value) || item.check.value < 0) {
      return null;
    }
    values.add(item.check.value);
  }
  if (values.size !== 1) {
    return null;
  }
  return Array.from(values)[0];
}

export function buildResultSummary({
  data = null,
  task = null,
  predictionValue = null,
  predictionSource = "initial",
  ownership = "current",
} = {}) {
  const stage = (data?.objects || []).find((item) => item.id === "stage") || null;
  const moves = Number.isFinite(stage?.moves) ? stage.moves : null;
  const steps = Number.isFinite(stage?.steps) ? stage.steps : null;
  const targetSteps = deriveTargetSteps(task);
  const hasPrediction = Number.isFinite(predictionValue);
  const compareKnown = data?.status === "completed" && hasPrediction && moves != null;

  let compareLine = moves == null
    ? "这次没有记录动作次数。"
    : data?.status === "completed"
      ? `这次角色动了 ${moves} 次。`
      : `运行结束前记录到 ${moves} 次动作。`;
  let consistent = "unknown";
  if (compareKnown) {
    consistent = predictionValue === moves ? "consistent" : "inconsistent";
    const head = predictionSource === "carried" ? "沿用上次的猜想" : "你的猜想";
    const tail = consistent === "consistent" ? "，猜对啦。" : "，和实际不一样。";
    compareLine = `${head}是 ${predictionValue} 次，实际动了 ${moves} 次${tail}`;
  }

  let goalLine = "这次先看看角色走到了哪里。";
  let gap = 0;
  let reached = null;
  if (targetSteps != null && steps != null) {
    reached = data.status === "completed" ? steps === targetSteps : null;
    if (data.status !== "completed") {
      goalLine = `运行结束前记录到 ${steps} 步，目标是 ${targetSteps} 步。`;
    } else if (reached) {
      goalLine = `目标 ${targetSteps} 步，实际走了 ${steps} 步，正好到达目标。`;
    } else if (steps < targetSteps) {
      gap = targetSteps - steps;
      goalLine = `目标 ${targetSteps} 步，实际走了 ${steps} 步，还差 ${gap} 步。`;
    } else {
      gap = steps - targetSteps;
      goalLine = `目标 ${targetSteps} 步，实际走了 ${steps} 步，超出了 ${gap} 步。`;
    }
  }

  let nextAction = "backToBlocks";
  if (ownership === "stale") {
    nextAction = "rerun";
  } else if (data?.error) {
    nextAction = "backToBlocks";
  } else if (data?.success) {
    nextAction = task?.type === "variant" ? "summary" : "variant";
  } else if (data) {
    nextAction = "hint";
  }

  return {
    compareLine,
    goalLine,
    consistent,
    reached,
    gap,
    targetSteps,
    actualSteps: steps,
    moves,
    ownership,
    staleLabel: ownership === "stale" ? "上次运行 · 积木已修改" : "",
    nextAction,
    predictionSource,
  };
}
