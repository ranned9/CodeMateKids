/** 作品保存、打开与未保存修改确认。 */
import { API } from "../api.js";
import { captureContext, isCurrentContext } from "../core/viewContext.js";
import { buildProgram, cloneTree, programWorkspace } from "../editor/model.js";

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
        state.dirty = revision !== state.programRevision;
        toast(state.dirty ? "之前的版本已保存，新的改动还没保存。" : "作品已保存到本机。");
      }
      return !state.dirty;
    } catch (error) {
      toast(error.messageForChild || "没有保存成功，可以再试一次。", true);
      return false;
    }
  }

  async function openProject(file) {
    if (!file || !editorReady()) {
      return;
    }
    try {
      const text = await file.text();
      const data = await API.loadProject(text);
      const taskId = data.program?.courseRef?.taskId || "";
      const task = state.tasks.get(taskId);
      const validTask = Boolean(task && task.enterable && data.runnable);
      if (!(await confirmLeaveDirty())) {
        return;
      }
      await leaveRunContext("open-project");
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
