/** 课堂状态派生：把启动、任务、门禁、运行、结果归属收敛为一个状态与唯一主操作。 */

export const CLASSROOM_STATES = [
  "startup-pending",
  "environment-blocked",
  "task-blocked",
  "readonly",
  "running",
  "needs-prediction",
  "needs-fix",
  "result-current",
  "result-stale",
  "ready",
];

function result(state, hint, controlId, extra = {}) {
  return {
    state,
    hint,
    primary: { controlId, label: extra.label || "" },
    blockId: extra.blockId || null,
  };
}

export function deriveClassroomState(input = {}) {
  const {
    startup = null,
    task = null,
    readonly = false,
    phase = "idle",
    gate = null,
    predictionValue = null,
    runRecovery = null,
    lastRunOwnership = null,
    errorBlockId = null,
    runIssue = "",
  } = input;

  if (!startup) {
    return result("startup-pending", "正在准备课堂，稍等一下。", "startup-retry", { label: "重新检查" });
  }
  if (startup.status === "fatal") {
    return result("environment-blocked", "运行环境需要先调整，看看系统信息里的原因。", "startup-retry", { label: "重新检查" });
  }
  if (readonly) {
    return result("readonly", "这个作品现在是只读的，可以看但不能改。", "open-project", { label: "打开其他作品" });
  }
  if (!task) {
    return result("task-blocked", "先选一个任务再开始。", "task-list-trigger");
  }
  if (!task.enterable) {
    return result("task-blocked", task.blockedReason || "这个任务暂时不能运行。", "task-list-trigger");
  }
  if (phase === "validating" || phase === "running" || phase === "cancelling" || phase === "abandoned") {
    const hint = phase === "validating" ? "正在提交，可以点停止。" :
      phase === "cancelling" ? "正在确认这轮运行已停止。" : "正在运行，可以点停止。";
    return result("running", hint, "stop-button", { label: "停止" });
  }
  if (runRecovery) {
    return result("needs-fix", runRecovery, "stop-button");
  }
  if (gate?.reasonCode === "PREDICTION_PENDING") {
    return result("needs-prediction", gate.reason, null);
  }
  if (["ENV_NOT_READY", "WORKER_NOT_READY", "WORKER_DEGRADED"].includes(gate?.reasonCode)) {
    return result("environment-blocked", gate.reason, "startup-retry");
  }
  if (!Number.isFinite(predictionValue)) {
    return result("needs-prediction", "先猜一猜角色会动几次。", "prediction-submit", { label: "提交预测" });
  }
  if (gate && !gate.allowed) {
    return result("needs-fix", gate.reason || "先把缺的内容补上。", gate.blockId ? "run-locate" : null, {
      blockId: gate.blockId || null,
      label: "再运行一次",
    });
  }
  if (runIssue) {
    return result("needs-fix", runIssue, errorBlockId ? "run-locate" : "run-button", {
      blockId: errorBlockId,
    });
  }
  if (lastRunOwnership === "stale") {
    return result("result-stale", "积木改过了，这是上次的结果。再运行一次看看新的变化。", "run-button", {
      label: "再运行一次",
    });
  }
  if (lastRunOwnership === "current" && phase === "result") {
    return result("result-current", "这一轮结果在这里，看看和小猜想的对照。", "run-button", { label: "再运行一次" });
  }
  if (phase === "error") {
    return result("needs-fix", "积木里有要修的地方，看看标出来的位置。", "run-button", {
      blockId: errorBlockId,
      label: "再运行一次",
    });
  }
  return result("ready", "准备好了，点运行试试。", "run-button", { label: "运行" });
}

export function stateHintTone(state) {
  return {
    "environment-blocked": "bad",
    "task-blocked": "bad",
    "needs-fix": "bad",
    "result-stale": "warn",
    "result-current": "ok",
    ready: "ok",
  }[state] || "";
}
