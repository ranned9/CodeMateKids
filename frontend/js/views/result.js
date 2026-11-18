/** 结果区：输出、角色状态、预测对照、错误原因与再试入口。 */
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

export function renderResult(container, state, task, data, callbacks) {
  if (!container) {
    return;
  }
  if (!data) {
    clearNode(container);
    appendParagraph(container, "运行一次，就能看到结果啦。", "muted");
    return;
  }
  clearNode(container);
  const success = Boolean(data.success);
  const status = document.createElement("p");
  status.className = `result-status ${success ? "ok" : "bad"}`;
  if (data.status === "completed" && success) {
    status.textContent = "这次做到了！对照一下目标，看看角色是不是停在正确的位置。";
  } else if (data.status === "completed") {
    status.textContent = "运行完成啦，再对照一下目标看看差在哪里。";
  } else {
    status.textContent = "程序没有完整跑完。";
  }
  container.appendChild(status);

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
  container.appendChild(outputBlock);

  const objects = data.objects || [];
  const stage = objects.find((item) => item.id === "stage");
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
    container.appendChild(stateBlock);
  }

  const prediction = state.prediction.get(task?.taskId || state.activeTaskId);
  if (prediction != null && stage) {
    const compare = document.getElementById("prediction-compare");
    if (compare) {
      compare.hidden = false;
      document.getElementById("compare-prediction").textContent = `${prediction} 次`;
      const actualMoves = stage.moves ?? stage.steps;
      document.getElementById("compare-actual").textContent = `动了 ${actualMoves} 次，走了 ${stage.steps} 步`;
      const match = Number(prediction) === Number(actualMoves);
      const matchEl = document.getElementById("compare-match");
      matchEl.textContent = match ? "一致" : "不一样";
      matchEl.className = match ? "ok-text" : "warn-text";
    }
  }

  if (data.error) {
    const errorBox = document.createElement("div");
    errorBox.className = "error-box result-block";
    const title = document.createElement("strong");
    title.textContent = data.error.messageForChild || "这里出了点问题。";
    const next = document.createElement("div");
    next.className = "next-step";
    next.textContent = NEXT_STEP[data.error.code] || "修改一下积木，再试一次。";
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

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "primary-button";
  retry.textContent = "再试一次";
  retry.style.marginTop = "10px";
  retry.addEventListener("click", () => callbacks.onRetry());
  container.appendChild(retry);
}

export function updateObjectView(elements, objects) {
  const stage = (objects || []).find((item) => item.id === "stage");
  if (!stage) {
    elements.meta.textContent = "角色还没有动过。";
    elements.actor.style.left = "8px";
    return;
  }
  const percent = Math.min(82, 8 + (Number(stage.steps) || 0) * 8);
  elements.actor.style.left = `${percent}%`;
  elements.actor.style.transform = stage.heading === 180 ? "scaleX(-1)" : "none";
  elements.meta.textContent = `动了 ${stage.moves ?? stage.steps} 次，累计走了 ${stage.steps} 步，朝向 ${stage.heading}°${
    stage.said ? `，说：“${stage.said}”` : ""
  }。`;
}

export function resetObjectView(elements) {
  elements.meta.textContent = "角色还没有动过。";
  elements.actor.style.left = "8px";
  elements.actor.style.transform = "none";
}