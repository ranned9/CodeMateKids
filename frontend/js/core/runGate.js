/** 运行栅栏：读取后端 runCapability，叠加任务/只读/预测/本地校验；失败给出可执行原因码。 */
import { runnableRoots, validateTree, workspaceStacks } from "../editor/model.js";

const FALLBACK_WORKER_REASON = "运行环境没有准备好，可以点重新检查。";

function block(reason, reasonCode, blockId = null) {
  return { allowed: false, reason, reasonCode, blockId };
}

export function evaluateRunGate({ state, taskId = state.activeTaskId, root = state.root }) {
  if (!state.startup) {
    return block("运行环境还在检查。", "STARTUP_PENDING");
  }
  const capability = state.startup.runCapability;
  if (capability) {
    if (!capability.canRun) {
      return block(capability.reasonForChild || "运行环境还没有准备好。", "ENV_NOT_READY");
    }
    if (capability.workerReady === false) {
      return block(FALLBACK_WORKER_REASON, "WORKER_NOT_READY");
    }
    if ((capability.blockedTaskIds || []).includes(taskId)) {
      return block("这个任务现在打不开，可以先试试另一个任务。", "TASK_BLOCKED", taskId);
    }
  } else {
    if (state.startup.status === "fatal") {
      return block("运行环境需要先调整。", "ENV_FATAL");
    }
    const worker = (state.startup.checks || []).find((item) => item.name === "worker");
    if (state.startup.status === "degraded" && worker && worker.status !== "passed") {
      return block(FALLBACK_WORKER_REASON, "WORKER_DEGRADED");
    }
  }

  const task = state.tasks.get(taskId);
  if (!task) {
    return block("这个任务暂时不能运行。", "TASK_MISSING", taskId);
  }
  if (!task.enterable) {
    return block(task.blockedReason || "这个任务现在打不开。", "TASK_NOT_ENTERABLE", taskId);
  }
  if (state.readonly) {
    return block("这个作品现在是只读的。", "READONLY");
  }
  if (state.runRecovery) {
    return block(state.runRecovery, "RUN_RECOVERY");
  }
  if (state.predictionPending?.has(taskId)) {
    return block("正在记下你的猜想，稍等一下。", "PREDICTION_PENDING");
  }
  if (!state.prediction.has(taskId)) {
    return block("先猜一猜角色会动几次。", "NEED_PREDICTION");
  }
  if (!workspaceStacks(root).length) {
    return block("先拖一个积木到画布上。", "EMPTY_WORKSPACE");
  }
  if (!runnableRoots(root).length) {
    return block("把要运行的积木接在「当开始」下面。", "NO_RUNNABLE_ROOT");
  }
  const validation = validateTree(root, state.blocksByKind);
  if (!validation.ok) {
    const first = validation.issues[0];
    return block(first?.message || "先把缺的内容补上。", "INVALID_PROGRAM", first?.blockId || null);
  }
  return { allowed: true, reason: "", reasonCode: "", blockId: null };
}
