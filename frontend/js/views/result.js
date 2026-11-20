/** 结果区：首屏两句话（预测对照 + 目标达成）、旧结果标记与下一步引导。 */
import { buildResultSummary, deriveTargetSteps } from "../ux/resultSummary.js";
import { actorPercent, buildStageTrack, stageTicks } from "../ux/stageTrack.js";
import { LOOP_OBSERVATION } from "../ux/loopEvidence.js";
import { appendDiv, appendList, appendParagraph, clearNode } from "../util/dom.js";

const NEXT_STEP = {
  RUN_TIMEOUT: "检查一下重复次数，或者把大循环改小。",
  RUN_RESOURCE_LIMIT: "简化程序，或者减少一次输出的内容。",
  PYTHON_RUNTIME_ERROR: "看看标出来的积木，检查它的参数。",
  PYTHON_FEATURE_BLOCKED: "换一个能运行的积木再试。",
  PYTHON_COMPILE_ERROR: "检查一下积木里的数字和参数。",
  PYTHON_VERSION_MISMATCH: "需要 Python 3.12 的运行环境。",
  RUNNER_CRASHED: "再运行一次，通常就能恢复。",
  RUN_CANCELLED: "修改好之后再点运行。",
  RUNNER_UNAVAILABLE: "点重新检查，或稍后再运行。",
  TASK_NOT_RUNNABLE: "换一个能运行的任务试试。",
  RUN_START_FAILED: "休息一下，再点一次运行。",
  RUN_REQUEST_INVALID: "刷新页面后再试。",
  RUN_ID_CONFLICT: "刷新页面后再运行。",
};

export function renderResult(container, state, task, data, callbacks = {}) {
  if (!container) {
    return;
  }
  clearNode(container);
  if (callbacks.details) {
    clearNode(callbacks.details);
  }
  if (!data) {
    appendParagraph(container, "运行一次，就能看到结果啦。", "muted");
    return;
  }
  const ownership = state.lastResultOwnership || "current";
  const runContext = state.lastRunContext;
  const taskId = task?.taskId || state.activeTaskId;
  const predictionValue = runContext ? runContext.predictionValue : state.prediction.get(taskId) ?? null;
  const predictionSource = runContext?.predictionSource || "initial";
  const summary = buildResultSummary({ data, task, predictionValue, predictionSource, ownership });

  const success = Boolean(data.success);
  const status = document.createElement("p");
  status.className = `result-status ${ownership === "stale" ? "warn" : success ? "ok" : "bad"}`;
  status.setAttribute("data-result-ownership", ownership);
  if (ownership === "stale") {
    status.textContent = summary.staleLabel;
  } else if (data.status === "cancelled") {
    status.textContent = "这轮已停止。";
  } else if (data.error) {
    status.textContent = "这轮需要再试一下。";
  } else if (data.status === "completed" && success) {
    status.textContent = "这次做到了！";
  } else if (data.status === "completed") {
    status.textContent = "运行完成啦，看看和目标的差距。";
  } else {
    status.textContent = "程序没有完整跑完。";
  }
  container.appendChild(status);

  const firstScreen = document.createElement("div");
  firstScreen.className = "result-block";
  appendDiv(firstScreen, summary.compareLine, "result-line");
  appendDiv(firstScreen, summary.goalLine, "result-line");
  if (data.loopBlockId) {
    appendDiv(firstScreen, LOOP_OBSERVATION, "result-line");
  } else if (data.status === "completed" && data.success && ["main", "variant"].includes(task?.taskId)) {
    appendDiv(firstScreen, "再看看前进积木是不是放在重复里。", "result-line");
  }
  const stage = data.objects?.find((item) => item.id === "stage");
  if (stage?.said) {
    appendDiv(firstScreen, `小海龟说：“${stage.said}”`, "result-line");
  }
  container.appendChild(firstScreen);

  const outputBlock = document.createElement("div");
  outputBlock.className = "result-block";
  const outputTitle = document.createElement("h4");
  outputTitle.textContent = "输出";
  const output = document.createElement("div");
  output.className = "result-output";
  output.textContent = (data.stdout || "").trim() || "这次没有输出。";
  outputBlock.appendChild(outputTitle);
  outputBlock.appendChild(output);
  if (data.truncated) {
    const flag = document.createElement("div");
    flag.className = "truncated-flag";
    flag.textContent = "输出过多，已经截断。";
    outputBlock.appendChild(flag);
  }
  callbacks.details?.appendChild(outputBlock);
  if (stage) {
    const stateBlock = document.createElement("div");
    stateBlock.className = "result-block";
    const heading = document.createElement("h4");
    heading.textContent = "角色状态";
    stateBlock.appendChild(heading);
    appendDiv(
      stateBlock,
      `累计走了 ${stage.steps} 步，朝向 ${stage.heading}°${
        stage.said ? `，说：“${stage.said}”` : ""
      }。`,
    );
    callbacks.details?.appendChild(stateBlock);
  }

  updatePredictionCompare(summary, predictionValue);

  if (data.error) {
    const errorBox = document.createElement("div");
    errorBox.className = "error-box result-block";
    const title = document.createElement("strong");
    title.textContent = data.error.messageForChild || "这里出了点问题。";
    const next = document.createElement("div");
    next.className = "next-step";
    next.textContent = NEXT_STEP[data.error.code] || "可以再运行一次。";
    errorBox.appendChild(title);
    errorBox.appendChild(next);
    container.appendChild(errorBox);
  } else if (data.failures && data.failures.length > 0) {
    const failBox = document.createElement("div");
    failBox.className = "result-block";
    const failHeading = document.createElement("h4");
    failHeading.textContent = "和目标比一比";
    failBox.appendChild(failHeading);
    appendList(failBox, data.failures);
    container.appendChild(failBox);
  }

  const actions = document.createElement("div");
  actions.className = "result-next-actions";
  function addAction(label, handler) {
    if (!handler) {
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button";
    button.textContent = label;
    button.addEventListener("click", () => handler());
    actions.appendChild(button);
  }
  addAction("回到积木", callbacks.onBackToBlocks);
  const target = data.error?.blockId || data.loopBlockId;
  if (target && ownership === "current" && callbacks.onLocate) {
    addAction(data.error ? "定位积木" : "看看重复里的前进", () => callbacks.onLocate(target));
  }
  if (summary.nextAction === "hint") {
    addAction("给我一点提示", callbacks.onHint);
  } else if (summary.nextAction === "variant") {
    addAction("试试变式", callbacks.onVariant);
  } else if (summary.nextAction === "summary") {
    addAction("看小结", callbacks.onSummary);
  }
  container.appendChild(actions);
  return summary;
}

function updatePredictionCompare(summary, prediction) {
  const compare = typeof document !== "undefined" ? document.getElementById("prediction-compare") : null;
  if (!compare) {
    return;
  }
  if (summary.moves == null) {
    compare.hidden = true;
    return;
  }
  compare.hidden = false;
  const known = prediction != null;
  const predictionEl = document.getElementById("compare-prediction");
  const actualEl = document.getElementById("compare-actual");
  const matchEl = document.getElementById("compare-match");
  if (predictionEl) {
    predictionEl.textContent = known ? `${prediction} 次` : "—";
  }
  if (actualEl) {
    actualEl.textContent = `动了 ${summary.moves} 次，走了 ${summary.actualSteps ?? "—"} 步`;
  }
  if (matchEl) {
    const comparable = known && summary.consistent !== "unknown";
    matchEl.textContent = comparable
      ? summary.consistent === "consistent" ? "一致" : "不一样"
      : "无法判断";
    matchEl.className = summary.consistent === "consistent" ? "ok-text" : comparable ? "warn-text" : "muted";
  }
}

export function updateObjectView(elements, objects, task = null) {
  const stage = (objects || []).find((item) => item.id === "stage");
  const targetSteps = deriveTargetSteps(task);
  const track = buildStageTrack({ targetSteps, actualSteps: stage?.steps });
  if (elements.target) {
    elements.target.hidden = !track.hasTarget;
    elements.target.style.left = "82%";
  }
  if (elements.ticks && elements.ticks.dataset.target !== String(targetSteps)) {
    elements.ticks.dataset.target = String(targetSteps);
    clearNode(elements.ticks);
    for (const tick of stageTicks(targetSteps)) {
      const label = document.createElement("span");
      label.className = "stage-tick";
      label.style.left = `${tick.percent}%`;
      label.textContent = String(tick.value);
      elements.ticks.appendChild(label);
    }
  }
  if (!stage) {
    resetObjectView(elements);
    if (track.hasTarget) {
      elements.meta.textContent = `${track.label}。角色在起点。`;
    }
    return;
  }
  const percent = track.ratio == null
    ? Math.min(82, 8 + (Number(stage.steps) || 0) * 8)
    : actorPercent(track);
  elements.actor.style.left = `${percent}%`;
  elements.actor.style.transform = stage.heading === 180 ? "scaleX(-1)" : "none";
  const overflow = track.overflowLabel ? `（${track.overflowLabel}）` : "";
  const moves = Number.isFinite(stage.moves) ? `动了 ${stage.moves} 次，` : "";
  elements.meta.textContent = `${moves}累计走了 ${stage.steps} 步${overflow}，朝向 ${stage.heading}°${
    stage.said ? `，说：“${stage.said}”` : ""
  }。`;
}

export function resetObjectView(elements) {
  elements.meta.textContent = "角色还没有动过。";
  elements.actor.style.left = "8%";
  elements.actor.style.transform = "none";
}
