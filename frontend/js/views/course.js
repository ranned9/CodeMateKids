/** 课程区：目标、任务卡片、预测与中性鼓励。 */
import { appendParagraph, clearNode } from "../util/dom.js";

export function renderCourse(container, state, callbacks) {
  if (!container) {
    return;
  }
  clearNode(container);
  const course = state.course;
  if (!course) {
    appendParagraph(container, "正在读取课程…", "muted");
    return;
  }

  const title = document.createElement("h3");
  title.textContent = course.course.title;
  container.appendChild(title);

  const objectives = document.createElement("ul");
  objectives.className = "objective-list";
  for (const objective of course.course.learningObjectives || []) {
    const item = document.createElement("li");
    item.textContent = objective;
    objectives.appendChild(item);
  }
  container.appendChild(objectives);

  for (const taskId of state.tasks.keys()) {
    const task = state.tasks.get(taskId);
    container.appendChild(buildTaskCard(task, state, callbacks));
  }

  const themes = document.createElement("div");
  themes.className = "theme-list";
  for (const theme of course.otherThemes || []) {
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

function buildTaskCard(task, state, callbacks) {
  const card = document.createElement("div");
  card.className = `task-card${task.taskId === state.activeTaskId ? " active" : ""}`;
  const heading = document.createElement("h3");
  heading.textContent = task.title;
  const tag = document.createElement("span");
  tag.className = "task-tag";
  tag.textContent = task.type === "main" ? "主任务" : "变式任务";
  heading.appendChild(tag);
  card.appendChild(heading);

  const objective = document.createElement("p");
  objective.textContent = task.objective;
  card.appendChild(objective);

  const criterion = document.createElement("p");
  criterion.className = "muted";
  criterion.textContent = `完成标准：${(task.successCriteria || []).map((item) => item.description).join("；")}`;
  card.appendChild(criterion);

  const prediction = document.createElement("p");
  prediction.textContent = task.predictionQuestion;
  card.appendChild(prediction);

  if (!task.enterable) {
    const blocked = document.createElement("p");
    blocked.className = "blocked";
    blocked.textContent = `${task.blockedReason || "这个任务暂时不能运行"}`;
    card.appendChild(blocked);
  } else {
    const enter = document.createElement("button");
    enter.type = "button";
    enter.className = task.taskId === state.activeTaskId ? "ghost-button" : "primary-button";
    enter.textContent = task.taskId === state.activeTaskId ? "正在练习" : "开始这个任务";
    enter.disabled = task.taskId === state.activeTaskId;
    enter.addEventListener("click", () => callbacks.onSelectTask(task.taskId));
    card.appendChild(enter);
  }
  if (task.type === "variant" && !state.mainCompletedHint) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "可以试试，不过主任务还没完成哦。";
    card.appendChild(note);
  }
  return card;
}

export function renderPrediction(state, elements, callbacks) {
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
  if (document.activeElement !== input) {
    input.value = value == null ? "" : String(value);
  }
  const locked = Boolean(task.blockedReason);
  submit.disabled = locked;
  input.disabled = locked;
  if (value != null) {
    feedback.textContent = `已经记下：角色会动 ${value} 次。`;
    feedback.className = "hint-text ok";
  } else if (elements.runHint) {
    feedback.textContent = "先猜一猜，再运行。";
    feedback.className = "hint-text";
  }
}