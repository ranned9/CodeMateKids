/** 结果区：简短结论、可展开的运行证据与下一步引导。 */
import { buildResultSummary, deriveTargetSteps } from "../ux/resultSummary.js";
import { completeStraightTail } from "../ux/stageRoute.js";
import { LOOP_OBSERVATION } from "../ux/loopEvidence.js";
import { appendDiv, appendList, appendParagraph, clearNode } from "../util/dom.js";
import { drawStagePath } from "./stagePath.js";

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
    status.textContent = "还没达到目标。";
  } else {
    status.textContent = "程序没有完整跑完。";
  }
  container.appendChild(status);

  const facts = [];
  if (summary.consistent !== "unknown") facts.push(`猜 ${predictionValue} 次`);
  if (summary.moves != null) facts.push(`动了 ${summary.moves} 次`);
  if (summary.actualSteps != null) {
    const goal = summary.targetSteps != null && summary.actualSteps !== summary.targetSteps
      ? `（目标 ${summary.targetSteps} 步）` : "";
    facts.push(`走了 ${summary.actualSteps} 步${goal}`);
  }
  if (facts.length) appendDiv(container, facts.join("，"), "result-line");

  const observations = document.createElement("div");
  observations.className = "result-block";
  appendDiv(observations, summary.compareLine);
  appendDiv(observations, summary.goalLine);
  if (data.loopBlockId) {
    appendDiv(observations, LOOP_OBSERVATION);
  } else if (data.status === "completed" && data.success && task?.teaching?.suggestedStepsPerMove) {
    appendDiv(observations, "再看看前进积木是不是放在重复里。");
  }
  const stage = data.objects?.find((item) => item.id === "stage");
  callbacks.details?.appendChild(observations);

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
    const message = data.error.messageForChild || "这里出了点问题。";
    appendDiv(container, message, "result-line result-error-summary");
    const errorBox = document.createElement("div");
    errorBox.className = "error-box result-block";
    const title = document.createElement("strong");
    title.textContent = message;
    const next = document.createElement("div");
    next.className = "next-step";
    next.textContent = NEXT_STEP[data.error.code] || "可以再运行一次。";
    errorBox.appendChild(title);
    errorBox.appendChild(next);
    callbacks.details?.appendChild(errorBox);
  } else if (data.failures && data.failures.length > 0) {
    const failBox = document.createElement("div");
    failBox.className = "result-block";
    const failHeading = document.createElement("h4");
    failHeading.textContent = "和目标比一比";
    failBox.appendChild(failHeading);
    appendList(failBox, data.failures);
    callbacks.details?.appendChild(failBox);
  }

  const actions = document.createElement("div");
  actions.className = "result-next-actions";
  const detailActions = document.createElement("div");
  detailActions.className = "result-next-actions";
  function addAction(label, handler, parent = actions) {
    if (!handler) {
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button";
    button.textContent = label;
    button.addEventListener("click", () => handler());
    parent.appendChild(button);
  }
  addAction("回到积木", callbacks.onBackToBlocks, detailActions);
  const target = data.error?.blockId || data.loopBlockId;
  if (target && ownership === "current" && callbacks.onLocate) {
    addAction(data.error ? "定位积木" : "看看重复里的前进", () => callbacks.onLocate(target), detailActions);
  }
  if (summary.nextAction === "hint") {
    addAction(callbacks.hintLabel || "给我一点提示", callbacks.onHint);
  } else if (summary.nextAction === "nextTask") {
    if (callbacks.onNextTask) {
      addAction(callbacks.nextTaskLabel || "去下一题", callbacks.onNextTask);
    } else {
      addAction("看小结", callbacks.onSummary);
    }
  } else if (summary.nextAction === "variant") {
    addAction("试试变式", callbacks.onVariant);
  } else if (summary.nextAction === "summary") {
    addAction("看小结", callbacks.onSummary);
  }
  if (ownership === "current" && data.success && data.learning?.pattern === "prediction_mismatch") {
    addAction("看看猜想和实际有什么不同", callbacks.onHint, detailActions);
  }
  if (actions.childElementCount) container.appendChild(actions);
  if (detailActions.childElementCount) (callbacks.details || container).appendChild(detailActions);
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

/** 所有任务共用二维舞台：运行前画出目标，运行后画实际路线；分步查看和单步调试画到当前这一步。 */
export function updateObjectView(elements, objects, task = null, learning = null, replayFrame = null, debugPath = null) {
  const stage = (objects || []).find((item) => item.id === "stage");
  let actions = debugPath ?? learning?.replay?.actions ?? [];
  // 后端只给了前几轮时，能确定是一直往前走的就把剩下的路线补齐，舞台画到最终位置。
  const tail = !debugPath && learning?.replay?.hasMore ? completeStraightTail(actions, stage) : null;
  const partial = !debugPath && Boolean(learning?.replay?.hasMore) && !tail;
  const full = tail ? [...actions, ...tail] : actions;
  let note = "";
  if (elements.path) {
    elements.path.hidden = false;
    const visible = replayFrame ? actions.slice(0, replayFrame.index) : full;
    const endpoint = replayFrame ? replayFrame.action : debugPath || tail ? stage : visible.at(-1) || stage;
    note = drawStagePath(elements.path, {
      actions: full, visible, endpoint,
      final: !replayFrame && Boolean(stage) && !partial,
      numbered: !tail || tail.length + actions.length <= 12,
      goal: task?.teaching?.stageGoal ?? null,
      goalLabel: task?.teaching?.goalLabel ?? null,
    }).note;
  }
  if (!elements.meta) return;
  const targetSteps = deriveTargetSteps(task);
  if (replayFrame) {
    const action = replayFrame.action;
    elements.meta.textContent = action
      ? `正在分步查看：动了 ${action.moves ?? 0} 次，累计走了 ${action.totalSteps ?? 0} 步。`
      : "正在分步查看：海龟在起点。";
    return;
  }
  if (!stage) {
    elements.meta.textContent = targetSteps != null ? `目标 ${targetSteps} 步。角色在起点。` : "海龟在起点。";
    return;
  }
  const overflow = targetSteps != null && stage.steps > targetSteps ? `（超出目标 ${stage.steps - targetSteps} 步）` : "";
  const traceStatus = stage.moves > 0 && !full.length
    ? "这次没有可核对的完整路线。" : partial ? "舞台显示路线的前一部分。" : "";
  elements.meta.textContent = `动了 ${stage.moves} 次，累计走了 ${stage.steps} 步${overflow}。`
    + `当前位置（${coordinateText(stage.x)}，${coordinateText(stage.y)}），朝向 ${stage.heading}°${speech(stage)}。${traceStatus}${note}`;
}

function coordinateText(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : value;
}

function speech(stage) {
  return stage.said ? `，说：“${stage.said}”` : "";
}

/** 回到运行前：清掉说明文字；给了任务时重画运行前的舞台（目标和起点）。 */
export function resetObjectView(elements, task = null) {
  if (task && elements.path) updateObjectView({ path: elements.path }, [], task);
  if (elements.meta) elements.meta.textContent = "角色还没有动过。";
}
