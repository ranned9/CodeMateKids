/** 载入作品/切换任务的唯一状态转换。 */
import { cloneTree } from "../editor/model.js";
import { appendParagraph, clearNode } from "../util/dom.js";

export function resetDerivedState(state, dom = {}) {
  state.lastResult = null;
  state.lastRunStatus = null;
  state.lastRunContext = null;
  state.lastResultOwnership = null;
  state.runIssue = "";
  state.errorBlockId = null;
  state.runningBlockId = null;
  state.highestHint = 0;
  state.phase = "editing";
  state.selectedBlockId = null;
  state.dirty = false;
  state.runRecovery = null;
  state.readonlyReason = "";
  state.saveStateSaving = false;
  state.saveError = null;

  if (dom["prediction-compare"]) {
    dom["prediction-compare"].hidden = true;
  }
  if (dom["live-output"]) {
    dom["live-output"].hidden = true;
    dom["live-output"].textContent = "";
  }
  if (dom["object-meta"]) {
    dom["object-meta"].textContent = "角色还没有动过。";
  }
  if (dom["stage-actor"]) {
    dom["stage-actor"].style.left = "8px";
    dom["stage-actor"].style.transform = "none";
  }
  if (dom["result-content"]) {
    clearNode(dom["result-content"]);
    appendParagraph(dom["result-content"], "运行一次，就能看到结果啦。", "muted");
  }
  if (dom["result-detail-content"]) {
    clearNode(dom["result-detail-content"]);
  }
  if (dom["tutor-message"]) {
    clearNode(dom["tutor-message"]);
    appendParagraph(dom["tutor-message"], "需要帮忙时，可以请小老师给一点提示。", "muted");
    dom["tutor-input"].value = "";
    clearNode(dom["tutor-detail"]);
  }
}

export function applyArtifact({
  state,
  descriptor,
  dom = {},
  editor,
  renderAll = () => {},
  runner = null,
}) {
  const source = descriptor.source === "project" ? "project" : "task";
  const taskId = source === "project" ? descriptor.taskId || "" : descriptor.taskId || state.activeTaskId;
  const task = taskId ? state.tasks.get(taskId) : undefined;
  const taskRunnable = Boolean(task && task.enterable);

  resetDerivedState(state, dom);
  state.artifactSource = source;
  state.root = descriptor.root || null;

  if (source === "task") {
    state.activeTaskId = taskId;
    state.artifactTaskId = null;
    state.readonly = false;
    state.readonlyReason = "";
  } else if (taskRunnable) {
    state.activeTaskId = taskId;
    state.artifactTaskId = null;
    state.readonly = Boolean(descriptor.readonly);
    state.readonlyReason = descriptor.readonlyReason || "";
  } else {
    state.activeTaskId = "__artifact__";
    state.artifactTaskId = taskId || null;
    state.readonly = true;
    state.readonlyReason = descriptor.readonlyReason || "这个作品对应的任务不在本机";
  }

  if (dom["canvas-title"]) {
    dom["canvas-title"].textContent = source === "project" ? "打开的作品" : "积木画布";
  }
  if (dom["prediction-box"]) {
    dom["prediction-box"].hidden = source === "project" && !taskRunnable;
  }

  editor.setProgram(state.root, { clearHistory: true, notify: false });
  state.dirty = false;
  state.savedSnapshot = cloneTree(state.root);
  state.lastSavedRevision = state.programRevision;
  renderAll("artifact");
  if (runner) {
    runner.updateControls();
  }
  return { source, taskId: state.activeTaskId, readonly: state.readonly };
}
