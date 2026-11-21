/** 结果区：简短结论、可展开的运行证据与下一步引导。 */
import { buildResultSummary, deriveTargetSteps } from "../ux/resultSummary.js";
import { buildStageTrack, STAGE_INSET } from "../ux/stageTrack.js";
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
  } else if (data.status === "completed" && data.success && ["main", "variant"].includes(task?.taskId)) {
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

export function updateObjectView(elements, objects, task = null, learning = null, replayFrame = null) {
  const stage = (objects || []).find((item) => item.id === "stage");
  const square = task?.teaching?.goalKind === "square";
  if (elements.track) elements.track.hidden = square;
  if (elements.path) elements.path.hidden = !square;
  if (square && elements.path) {
    const actions = learning?.replay?.actions || [];
    const visible = replayFrame ? actions.slice(0, replayFrame.index) : actions;
    const endpoint = replayFrame ? replayFrame.action : visible.at(-1) || stage;
    drawStagePath(elements.path, actions, visible, endpoint);
    const status = replayFrame ? "正在分步查看。" : stage
      ? `动了 ${stage.moves} 次，累计走了 ${stage.steps} 步。当前位置（${stage.x}，${stage.y}），朝向 ${stage.heading}°。`
      : "海龟在起点。";
    const traceStatus = !replayFrame && stage && !actions.length && stage.moves > 0
      ? "这次没有可核对的完整路线。" : !replayFrame && learning?.replay?.hasMore ? "舞台显示路线的前一部分。" : "";
    elements.meta.textContent = `${status}${traceStatus}`;
    return;
  }
  const targetSteps = deriveTargetSteps(task);
  const display = replayFrame ? {
    steps: replayFrame.action?.totalSteps ?? 0,
    moves: replayFrame.action?.moves ?? 0,
    heading: replayFrame.action?.heading ?? 0,
  } : stage;
  const track = buildStageTrack({
    targetSteps,
    actualSteps: stage?.steps,
    displaySteps: display?.steps,
    viewportWidth: elements.track?.clientWidth,
  });
  if (elements.lane) {
    elements.lane.style.width = `${track.width}px`;
  }
  if (elements.target) {
    elements.target.hidden = track.targetPosition == null;
    if (track.targetPosition != null) elements.target.style.left = `${track.targetPosition}px`;
  }
  const tickKey = `${targetSteps}:${stage?.steps}:${track.ticks.at(-1).value}`;
  if (elements.ticks && elements.ticks.dataset.track !== tickKey) {
    elements.ticks.dataset.track = tickKey;
    clearNode(elements.ticks);
    for (const tick of track.ticks) {
      const label = document.createElement("span");
      label.className = "stage-tick";
      label.style.left = `${tick.position}px`;
      label.textContent = String(tick.value);
      elements.ticks.appendChild(label);
    }
  }
  if (!display) {
    resetObjectView(elements);
    if (track.targetPosition != null) {
      elements.meta.textContent = `目标 ${targetSteps} 步。角色在起点。`;
    }
    return;
  }
  elements.actor.style.left = `${track.actorPosition}px`;
  elements.actor.style.transform = display.heading === 180 ? "scaleX(-1)" : "none";
  if (elements.track) elements.track.scrollLeft = track.scrollLeft;
  const overflow = track.overflowLabel ? `（${track.overflowLabel}）` : "";
  const moves = Number.isFinite(display.moves) ? `动了 ${display.moves} 次，` : "";
  elements.meta.textContent = `${moves}累计走了 ${display.steps} 步${overflow}，朝向 ${display.heading}°${
    display.said ? `，说：“${display.said}”` : ""
  }。`;
}

function drawStagePath(canvas, actions, visible, endpoint) {
  const context = canvas.getContext?.("2d");
  if (!context) return;
  const { width, height } = canvas;
  const points = [...actions, ...(endpoint ? [endpoint] : [])];
  const extent = Math.max(2, ...points.map(({ x, y }) => Math.max(Math.abs(x), Math.abs(y))));
  const unit = (Math.min(width, height) / 2 - 16) / extent;
  const origin = { x: width / 2, y: height / 2 };
  const point = ({ x, y }) => [origin.x + x * unit, origin.y - y * unit];
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#bae0d8";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(12, origin.y);
  context.lineTo(width - 12, origin.y);
  context.moveTo(origin.x, 12);
  context.lineTo(origin.x, height - 12);
  context.stroke();
  context.strokeStyle = "#08796d";
  context.lineWidth = 3;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(origin.x, origin.y);
  for (const position of visible) context.lineTo(...point(position));
  context.stroke();
  context.fillStyle = "#08796d";
  context.beginPath();
  context.arc(origin.x, origin.y, 4, 0, Math.PI * 2);
  context.fill();
  const [x, y] = point(endpoint || { x: 0, y: 0 });
  context.save();
  context.translate(x, y);
  context.rotate(-(endpoint?.heading || 0) * Math.PI / 180);
  context.fillStyle = "#17554d";
  context.beginPath();
  context.moveTo(11, 0);
  context.lineTo(-4, -6);
  context.lineTo(-4, 6);
  context.closePath();
  context.fill();
  context.restore();
}

export function resetObjectView(elements) {
  if (elements.meta) elements.meta.textContent = "角色还没有动过。";
  if (elements.actor) {
    elements.actor.style.left = `${STAGE_INSET}px`;
    elements.actor.style.transform = "none";
  }
  if (elements.track) elements.track.scrollLeft = 0;
}
