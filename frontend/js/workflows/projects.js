/** 作品保存、打开与未保存修改确认。 */
import { API } from "../api.js";
import { captureContext, isCurrentContext } from "../core/viewContext.js";
import { buildProgram, cloneTree, programWorkspace } from "../editor/model.js";
import { notify } from "../state.js";

function downloadProject(payload) {
  const blob = new Blob([payload.fileText], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = payload.fileName || "codematekids-project.json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function createProjectWorkflow({ state, elements, editorReady, applyProject, leaveRunContext, toast }) {
  let saveRequestSequence = 0;
  let latestAppliedSave = 0;

  async function askUnsavedChoice() {
    if (!state.dirty) {
      return "discard";
    }
    const { dialog, title, text } = elements;
    if (!dialog || typeof dialog.showModal !== "function") {
      return window.confirm("有还没保存的修改，继续会丢掉它们。继续吗？") ? "discard" : "cancel";
    }
    if (dialog.open) {
      return "cancel";
    }
    if (title) {
      title.textContent = "还没保存的修改";
    }
    if (text) {
      text.textContent = "要保存这个作品，还是放弃修改？";
    }
    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue || "cancel");
      };
      dialog.addEventListener("close", onClose);
      dialog.returnValue = "cancel";
      dialog.showModal();
    });
  }

  async function confirmLeaveDirty() {
    const choice = await askUnsavedChoice();
    if (choice === "cancel") {
      return false;
    }
    if (choice === "save") {
      return saveProject();
    }
    return true;
  }

  async function saveProject() {
    const task = state.tasks.get(state.activeTaskId) || state.tasks.get(state.artifactTaskId);
    if (!task || !editorReady()) {
      toast("这个作品没有对应的课程任务，暂时不能保存。", true);
      return false;
    }
    const requestId = ++saveRequestSequence;
    const ctx = captureContext(state);
    const revision = state.programRevision;
    const snapshot = cloneTree(state.root);
    state.saveStateSaving = true;
    state.saveError = null;
    notify("save");
    try {
      const program = buildProgram(snapshot, task);
      const payload = await API.saveProject(program, program.courseRef);
      downloadProject(payload);
      if (!isCurrentContext(state, ctx)) {
        return false;
      }
      if (requestId >= latestAppliedSave) {
        latestAppliedSave = requestId;
        state.savedSnapshot = snapshot;
        state.lastSavedRevision = revision;
        state.dirty = revision !== state.programRevision;
        toast(state.dirty ? "之前的版本已保存，新的改动还没保存。" : "作品已保存到本机。");
      }
      if (requestId === saveRequestSequence) {
        state.saveStateSaving = false;
        state.saveError = null;
      }
      notify("save");
      return !state.dirty;
    } catch (error) {
      if (requestId === saveRequestSequence && isCurrentContext(state, ctx)) {
        state.saveStateSaving = false;
        state.saveError = error.messageForChild || "没有保存成功，可以再试一次。";
        notify("save");
        toast(state.saveError, true);
      }
      return false;
    }
  }

  async function openProject(file) {
    if (!file || !editorReady()) {
      return;
    }
    const ctx = captureContext(state);
    try {
      const text = await file.text();
      const data = await API.loadProject(text);
      const taskId = data.program?.courseRef?.taskId || "";
      const task = state.tasks.get(taskId);
      const validTask = Boolean(task && task.enterable && data.runnable);
      if (!isCurrentContext(state, ctx) || !(await confirmLeaveDirty()) || !isCurrentContext(state, ctx)) {
        return;
      }
      const revision = state.programRevision;
      const leaving = leaveRunContext("open-project");
      const nextContext = captureContext(state);
      if ((await leaving)?.stopped === false) {
        toast("上一次运行还没有停下来，可以稍后再打开作品。", true);
        return;
      }
      if (!isCurrentContext(state, nextContext) || revision !== state.programRevision) {
        return;
      }
      applyProject({
        source: "project",
        taskId: validTask ? taskId : "",
        root: programWorkspace(data.program),
        readonly: !validTask,
        readonlyReason: validTask ? "" : data.readOnlyReason || "这个作品对应的任务不在本机",
      });
      if (data.migratedFrom != null) {
        toast(`作品已从旧版本 ${data.migratedFrom} 升级。`);
      }
      if (!validTask) {
        toast(data.readOnlyReason || "这个作品现在只能看，不能运行。", true);
      } else {
        toast("作品打开啦。");
      }
    } catch (error) {
      toast(error.messageForChild || "这个文件不是我们的项目文件。", true);
    } finally {
      elements.file.value = "";
    }
  }

  return { confirmLeaveDirty, saveProject, openProject };
}
