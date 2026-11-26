/** 顶栏任务标签：当前任务高亮，点击其他任务走与“其他任务”面板相同的切换流程。 */
import { clearNode } from "../util/dom.js";

const SHORT_TITLE = /^(?:让)?(?:角色|小海龟|海龟)?/;

export function shortTaskTitle(title = "") {
  const trimmed = String(title).replace(SHORT_TITLE, "");
  return trimmed || String(title);
}

export function renderTaskTabs(container, state, { onSelectTask } = {}) {
  if (!container) return;
  clearNode(container);
  if (!state.course) return;
  for (const [taskId, task] of state.tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-tab";
    button.textContent = shortTaskTitle(task.title);
    button.title = task.title;
    const active = taskId === state.activeTaskId;
    if (active) button.setAttribute("aria-current", "step");
    if (!task.enterable) {
      button.disabled = true;
      button.title = task.blockedReason || "这个任务暂时不能运行";
    } else if (!active) {
      button.addEventListener("click", () => onSelectTask?.(taskId));
    }
    container.appendChild(button);
  }
}
