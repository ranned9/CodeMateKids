/** 课程区：只突出当前任务；任务列表、学习目标与后续主题按需展开。 */
import { appendParagraph, clearNode } from "../util/dom.js";

const TYPE_LABEL = { main: "主任务", variant: "变式任务" };

export function renderCourse(container, state, callbacks) {
  if (!container) {
    return;
  }
  clearNode(container);
  if (!state.course) {
    appendParagraph(container, "正在读取课程…", "muted");
    return;
  }
  const task = state.tasks.get(state.activeTaskId);
  if (!task) {
    appendParagraph(container, "先选一个任务再开始。", "muted");
    return;
  }
  container.appendChild(buildCurrentTask(task, state, callbacks));
}

export function renderCoursePanels(panels = {}, state, callbacks = {}) {
  renderTaskList(panels.taskList, state, callbacks);
  renderLearningObjectives(panels.learningObjectives, state);
  renderOtherThemes(panels.otherThemes, state);
}

export function buildCurrentTask(task, state, callbacks = {}) {
  const card = document.createElement("div");
  card.className = "task-card active";

  const heading = document.createElement("h3");
  heading.textContent = task.title;
  const tag = document.createElement("span");
  tag.className = "task-tag";
  tag.textContent = task.teaching?.goalKind === "square" ? "迁移挑战" : TYPE_LABEL[task.type] || "任务";
  heading.appendChild(tag);
  card.appendChild(heading);

  const objective = document.createElement("p");
  objective.textContent = task.objective;
  card.appendChild(objective);

  const criterion = document.createElement("p");
  criterion.className = "muted";
  const first = (task.successCriteria || [])[0];
  criterion.textContent = `完成标准：${first?.description || "按目标完成这一轮练习"}`;
  card.appendChild(criterion);

  const extraCriteria = (task.successCriteria || []).slice(1);
  if (extraCriteria.length) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "还有别的完成标准";
    details.appendChild(summary);
    const list = document.createElement("ul");
    list.className = "steps-list";
    for (const item of extraCriteria) {
      const entry = document.createElement("li");
      entry.textContent = item.description;
      list.appendChild(entry);
    }
    details.appendChild(list);
    card.appendChild(details);
  }

  if (!task.enterable) {
    const blocked = document.createElement("p");
    blocked.className = "blocked";
    blocked.textContent = task.blockedReason || "这个任务暂时不能运行";
    card.appendChild(blocked);
  }
  if (task.type === "variant" && !state.mainCompletedHint) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "可以试试，不过主任务还没完成哦。";
    card.appendChild(note);
  }
  return card;
}

function renderTaskList(container, state, callbacks) {
  if (!container) {
    return;
  }
  clearNode(container);
  if (!state.course) {
    return;
  }
  const heading = document.createElement("h4");
  heading.textContent = "其他任务";
  container.appendChild(heading);
  if (callbacks.onSkip && state.tasks.get(state.activeTaskId)?.enterable) {
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "ghost-button";
    skip.textContent = "先跳过这题";
    skip.addEventListener("click", callbacks.onSkip);
    container.appendChild(skip);
  }
  let count = 0;
  for (const taskId of state.tasks.keys()) {
    if (taskId === state.activeTaskId) {
      continue;
    }
    const task = state.tasks.get(taskId);
    count += 1;
    const card = document.createElement("div");
    card.className = "task-card";
    const title = document.createElement("h3");
    title.textContent = task.title;
    const tag = document.createElement("span");
    tag.className = "task-tag";
    tag.textContent = task.teaching?.goalKind === "square" ? "迁移挑战" : TYPE_LABEL[task.type] || "任务";
    title.appendChild(tag);
    card.appendChild(title);
    appendParagraph(card, task.objective, "muted");
    if (task.enterable) {
      const enter = document.createElement("button");
      enter.type = "button";
      enter.className = "ghost-button";
      enter.textContent = "开始这个任务";
      enter.addEventListener("click", () => callbacks.onSelectTask?.(task.taskId));
      card.appendChild(enter);
    } else {
      appendParagraph(card, task.blockedReason || "这个任务暂时不能运行", "blocked");
    }
    container.appendChild(card);
  }
  if (!count) {
    appendParagraph(container, "这次只有一个任务。", "muted");
  }
}

function renderLearningObjectives(container, state) {
  if (!container) {
    return;
  }
  clearNode(container);
  const heading = document.createElement("h4");
  heading.textContent = "学习目标";
  container.appendChild(heading);
  const list = document.createElement("ul");
  list.className = "objective-list";
  for (const objective of state.course?.course?.learningObjectives || []) {
    const item = document.createElement("li");
    item.textContent = objective;
    list.appendChild(item);
  }
  container.appendChild(list);
}

function renderOtherThemes(container, state) {
  if (!container) {
    return;
  }
  clearNode(container);
  const heading = document.createElement("h4");
  heading.textContent = "后续主题";
  container.appendChild(heading);
  const themes = document.createElement("div");
  themes.className = "theme-list";
  for (const theme of state.course?.otherThemes || []) {
    const row = document.createElement("div");
    row.className = "theme-item";
    const name = document.createElement("span");
    name.textContent = theme.title;
    const tag = document.createElement("span");
    tag.textContent = "后续课程";
    row.appendChild(name);
    row.appendChild(tag);
    themes.appendChild(row);
  }
  container.appendChild(themes);
}

export function renderPrediction(state, elements, { preserveInput = false } = {}) {
  const task = state.tasks.get(state.activeTaskId);
  if (!task) {
    return;
  }
  const label = elements.label;
  const feedback = elements.feedback;
  const submit = elements.submit;
  const input = elements.input;
  if (label) {
    label.textContent = task.predictionQuestion;
  }
  const value = state.prediction.get(state.activeTaskId);
  const pending = state.predictionPending?.has(state.activeTaskId);
  if (!pending && !preserveInput && document.activeElement !== input) {
    input.value = value == null ? "" : String(value);
  }
  const locked = state.readonly || !task.enterable || ["validating", "running", "cancelling"].includes(state.phase);
  submit.disabled = locked || pending;
  input.disabled = locked || pending;
  submit.textContent = value == null ? "提交预测" : "再猜一次";
  if (pending) {
    feedback.textContent = "正在记下你的猜想…";
    feedback.className = "hint-text";
  } else if (value != null) {
    feedback.textContent = `已经记下：角色会动 ${value} 次。`;
    feedback.className = "hint-text ok";
  } else if (elements.runHint) {
    feedback.textContent = "先猜一猜，再运行。";
    feedback.className = "hint-text";
  }
}
