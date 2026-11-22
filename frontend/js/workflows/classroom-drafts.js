/** 本机课堂草稿，跟随学生和任务保存。 */

function storageKey(studentId, task, taskId) {
  const owner = studentId?.startsWith("student-") ? studentId : "guest";
  const { courseId = "demo-loop", version = 1 } = task.initialProgram?.courseRef || {};
  return `cmk.classroom.v1:${JSON.stringify([owner, courseId, version, taskId])}`;
}

function isBlock(block) {
  return block && typeof block.blockId === "string" && typeof block.kind === "string" &&
    block.inputs && typeof block.inputs === "object" && !Array.isArray(block.inputs) &&
    Object.values(block.inputs).every((value) => !value?.kind || isBlock(value)) &&
    (block.body == null || (Array.isArray(block.body) && block.body.every(isBlock))) &&
    (block.next == null || isBlock(block.next));
}

export function readClassroomDraft(studentId, task) {
  try {
    const stored = window.localStorage.getItem(storageKey(studentId, task, task.taskId));
    if (stored === null) return null;
    const root = JSON.parse(stored);
    const valid = Array.isArray(root)
      ? root.every((stack) => stack && Number.isFinite(stack.x) && Number.isFinite(stack.y) && isBlock(stack.root))
      : root === null || isBlock(root);
    return valid ? { root } : null;
  } catch {
    return null;
  }
}

export function saveClassroomDraft(studentId, task, root) {
  try {
    window.localStorage.setItem(storageKey(studentId, task, task.taskId), JSON.stringify(root));
    return true;
  } catch {
    return false;
  }
}

export function clearClassroomDraft(studentId, task) {
  try {
    window.localStorage.removeItem(storageKey(studentId, task, task.taskId));
    return true;
  } catch {
    return false;
  }
}

export function lastClassroomTask(studentId, course) {
  try {
    return window.localStorage.getItem(storageKey(studentId, course.tasks[0], null));
  } catch {
    return null;
  }
}

export function rememberClassroomTask(studentId, task) {
  try {
    window.localStorage.setItem(storageKey(studentId, task, null), task.taskId);
  } catch {
    // 草稿仍可通过任务列表找回。
  }
}
