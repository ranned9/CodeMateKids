/** 运行栅栏：读取后端 runCapability，叠加任务/只读/预测/本地校验。 */
import { validateTree } from "../editor/model.js";

const FALLBACK_WORKER_REASON = "运行环境没有准备好，可以点重新检查。";

export function evaluateRunGate({ state, taskId, root, validate = null }) {
  if (!state.startup) {
    return { allowed: false, reason: "运行环境还在检查。" };
  }
  const capability = state.startup.runCapability;
  if (capability) {
    if (!capability.canRun) {
      return {
        allowed: false,
        reason: capability.reasonForChild || "运行环境还没有准备好。",
      };
    }
    if (capability.workerReady === false) {
      return { allowed: false, reason: FALLBACK_WORKER_REASON };
    }
    if ((capability.blockedTaskIds || []).includes(taskId)) {
      return { allowed: false, reason: "这个任务现在打不开，可以先试试另一个任务。" };
    }
  } else {
    if (state.startup.status === "fatal") {
      return { allowed: false, reason: "运行环境需要先调整。" };
    }
    const worker = (state.startup.checks || []).find((item) => item.name === "worker");
    if (state.startup.status === "degraded" && worker && worker.status !== "passed") {
      return { allowed: false, reason: FALLBACK_WORKER_REASON };
    }
  }

  const task = state.tasks.get(taskId);
  if (!task) {
    return { allowed: false, reason: "这个任务暂时不能运行。" };
  }
  if (!task.enterable) {
    return { allowed: false, reason: task.blockedReason || "这个任务现在打不开。" };
  }
  if (state.readonly) {
    return { allowed: false, reason: "这个作品现在是只读的。" };
  }
  if (state.runRecovery) {
    return { allowed: false, reason: state.runRecovery };
  }
  if (!state.prediction.has(taskId)) {
    return { allowed: false, reason: "先猜一猜角色会动几次。" };
  }
  if (!root) {
    return { allowed: false, reason: "先拖一个积木到画布上。" };
  }
  const validation = validate ? validate() : validateTree(root);
  if (!validation.ok) {
    return { allowed: false, reason: validation.issues[0]?.message || "先把缺的内容补上。" };
  }
  return { allowed: true, reason: "" };
}