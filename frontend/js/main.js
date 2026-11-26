/** 应用入口：装配编辑器、派生层、视图与工作流。 */
import { API, setClassroomStudent } from "./api.js";
import { evaluateRunGate } from "./core/runGate.js";
import { cloneTree, programWorkspace } from "./editor/model.js";
import { History } from "./editor/undo.js";
import { notify, setPhase, state, subscribe } from "./state.js";
import { classifyResult } from "./ux/runContext.js";
import { deriveClassroomState, stateHintTone } from "./ux/classroomState.js";
import { locateTarget } from "./ux/locate.js";
import { applyPrimaryAction } from "./ux/primaryAction.js";
import { deriveSaveState, saveStateClass } from "./ux/saveState.js";
import { renderSystemInfo } from "./ux/systemInfo.js";
import { bindWorkbenchPanels } from "./ux/workbenchPanels.js";
import { applyArtifact } from "./views/artifact.js";
import { EditorView } from "./views/canvas.js";
import { renderCourse, renderCoursePanels } from "./views/course.js";
import { createRunner } from "./views/runner.js";
import { renderResult, updateObjectView } from "./views/result.js";
import { bindModelConfig } from "./views/modelConfig.js";
import { bindStudents } from "./views/students.js";
import { showSummary } from "./views/summary.js";
import { createTaskReader } from "./views/taskReader.js";
import { renderTaskTabs, shortTaskTitle } from "./views/taskTabs.js";
import { renderToolbox } from "./views/toolbox.js";
import { createTutor } from "./views/tutor.js";
import { createTutorChat } from "./views/tutorChat.js";
import {
  clearClassroomDraft,
  lastClassroomTask,
  readClassroomDraft,
  rememberClassroomTask,
  saveClassroomDraft,
} from "./workflows/classroom-drafts.js";
import { createCourseWorkflow } from "./workflows/course.js";
import { createPredictionWorkflow } from "./workflows/predictions.js";
import { createProjectWorkflow } from "./workflows/projects.js";
import { prepareWorkspaceChange } from "./workflows/workspace-change.js";

window.__cmkApi = API;
window.__cmkState = state;

const dom = {};
let panels = null;

let editor = null;
let history = null;
let runner = null;
let tutor = null;
let taskReader = null;
let projects = null;
let predictions = null;
let toastTimer = null;
let switchingTask = false;

function collectDom() {
  const ids = [
    "startup-banner",
    "startup-title",
    "startup-checks",
    "startup-retry",
    "startup-enter",
    "startup-details-trigger",
    "python-chip",
    "version-chip",
    "mode-chip",
    "run-state-chip",
    "system-info",
    "system-info-trigger",
    "system-info-body",
    "save-state",
    "student-controls",
    "student-select",
    "student-dialog",
    "student-form",
    "student-name",
    "student-create",
    "student-save",
    "student-cancel",
    "course-panel",
    "course-content",
    "prediction-box",
    "prediction-label",
    "prediction-input",
    "prediction-submit",
    "prediction-feedback",
    "task-list-trigger",
    "task-list-panel",
    "learning-objectives-panel",
    "other-themes-panel",
    "undo-button",
    "redo-button",
    "toolbox",
    "toolbox-list",
    "block-canvas",
    "canvas-empty",
    "canvas-title",
    "canvas-toolbar",
    "code-preview-panel",
    "a11y-mirror",
    "code-preview-text",
    "run-button",
    "debug-button",
    "debug-panel",
    "debug-step",
    "debug-play",
    "debug-speed",
    "debug-status",
    "stop-button",
    "reset-button",
    "run-hint",
    "run-locate",
    "stage-path",
    "object-meta",
    "result-panel",
    "result-tabs",
    "result-tab-result",
    "result-tab-tutor",
    "result-content",
    "result-details",
    "result-detail-content",
    "prediction-compare",
    "compare-prediction",
    "compare-actual",
    "compare-match",
    "live-output",
    "tutor-panel",
    "tutor-chat",
    "tutor-chat-log",
    "tutor-chat-form",
    "tutor-chat-input",
    "tutor-chat-selection",
    "tutor-chat-send",
    "tutor-speech-button",
    "tutor-voice-button",
    "tutor-speech-note",
    "tutor-legacy",
    "tutor-message",
    "tutor-detail",
    "tutor-input",
    "tutor-submit",
    "tutor-ask",
    "tutor-ask-toggle",
    "tutor-more",
    "tutor-mode-badge",
    "summary-panel",
    "summary-content",
    "summary-variant",
    "summary-skipped",
    "summary-finish",
    "summary-close",
    "toast",
    "save-project",
    "open-project",
    "project-file",
    "summary-open",
    "confirm-dialog",
    "confirm-title",
    "confirm-text",
    "task-tabs",
    "project-menu",
    "tutor-quick",
    "tutor-expand",
    "tutor-stage-mini",
    "tutor-stage-mini-text",
  ];
  for (const id of ids) {
    dom[id] = document.getElementById(id);
  }
  dom.tutorButtons = Array.from(document.querySelectorAll(".tutor-actions button[data-choice]"));
}

function toast(message, bad = false) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  dom.toast.className = `toast${bad ? " bad" : ""}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, 3600);
}

function predictionElements() {
  return {
    label: dom["prediction-label"],
    input: dom["prediction-input"],
    submit: dom["prediction-submit"],
    feedback: dom["prediction-feedback"],
    runHint: dom["run-hint"],
  };
}

function updateSaveState() {
  const derived = deriveSaveState({
    dirty: state.dirty,
    saving: state.saveStateSaving,
    lastSavedRevision: state.lastSavedRevision,
    programRevision: state.programRevision,
    lastError: state.saveError,
    draftSaved: state.draftSavedRevision === state.programRevision,
    draftFailed: state.draftSaveFailed,
  });
  const element = dom["save-state"];
  if (element) {
    if (element.textContent !== derived.label) element.textContent = derived.label;
    element.className = `save-state ${saveStateClass(derived.status)}`;
    element.title = derived.needsResave ? "再保存一次，新的改动就会写进作品。" : "";
  }
}

function updateClassroom() {
  const task = state.tasks.get(state.activeTaskId);
  const derived = deriveClassroomState({
    startup: state.startup,
    task,
    readonly: state.readonly,
    phase: state.phase,
    gate: evaluateRunGate({ state }),
    predictionValue: state.prediction.get(state.activeTaskId) ?? null,
    runRecovery: state.runRecovery,
    lastRunOwnership: state.lastResultOwnership,
    errorBlockId: state.errorBlockId,
    runIssue: state.runIssue,
  });
  if (dom["run-hint"]) {
    dom["run-hint"].textContent = derived.hint;
    dom["run-hint"].className = `hint-text ${stateHintTone(derived.state)}`;
  }
  dom["run-button"].textContent = state.lastResult ? "重新运行" : "运行";
  dom["run-locate"].hidden = !derived.blockId;
  dom["run-locate"].dataset.blockId = derived.blockId || "";
  applyPrimaryAction(document, derived.primary);
  const workspace = document.getElementById("workspace");
  if (workspace && typeof workspace.setAttribute === "function") {
    workspace.setAttribute("data-classroom-state", derived.state);
  }
  return derived;
}

function resultCallbacks() {
  const next = nextTask(state.tasks.get(state.activeTaskId));
  return {
    details: dom["result-detail-content"],
    onBackToBlocks: () => returnToWorkspace(),
    onLocate: (blockId) => returnToWorkspace(blockId),
    onHint: () => askForHint(),
    hintLabel: tutor?.focus ? "问小老师" : undefined,
    onVariant: next ? () => switchTask(next.taskId) : null,
    onNextTask: next ? () => switchTask(next.taskId) : null,
    nextTaskLabel: next ? `下一题：${shortTaskTitle(next.title)}` : "",
    onSummary: openSummary,
  };
}

function nextTask(task) {
  const candidate = state.tasks.get(task?.nextTaskId === undefined ? task?.variantTaskId : task.nextTaskId);
  return candidate?.enterable ? candidate : null;
}

function showReplayFrame(frame) {
  if (!state.lastResult || runner?.isBusy()) return;
  const task = state.tasks.get(state.activeTaskId);
  const showFrame = state.lastResultOwnership === "current" ? frame : null;
  updateObjectView(stageElements(), state.lastResult.objects, task, state.lastResult.learning, showFrame);
  editor.state.runningBlockId = showFrame?.action?.blockId || null;
  editor.render();
}

function returnToWorkspace(blockId = state.selectedBlockId) {
  locateTarget(editor, blockId);
}

function askForHint() {
  panels.showResultSlot("tutor");
  if (tutor?.focus) {
    tutor.focus();
    return;
  }
  dom["tutor-message"].focus();
  return tutor?.ask("hint");
}

function refreshResultOwnership() {
  if (!state.lastRunContext || !state.lastResult) {
    return;
  }
  state.lastResultOwnership = classifyResult({ state, record: state.lastRunContext });
  if (state.lastResultOwnership === "discarded") {
    return;
  }
  const task = state.tasks.get(state.activeTaskId);
  renderResult(dom["result-content"], state, task, state.lastResult, resultCallbacks());
}

function renderAll(reason = "all") {
  if (!state.course) {
    return;
  }
  taskReader?.updateContext();
  renderCourse(dom["course-content"], state, { taskReader });
  renderTaskTabs(dom["task-tabs"], state, { onSelectTask: (taskId) => switchTask(taskId) });
  renderCoursePanels(
    {
      taskList: dom["task-list-panel"],
      learningObjectives: dom["learning-objectives-panel"],
      otherThemes: dom["other-themes-panel"],
    },
    state,
    { onSelectTask: (taskId) => switchTask(taskId), onSkip: tutor?.focus ? skipTask : null },
  );
  predictions.render();
  renderEditorToolbox();
  updateHistoryControls();
  tutor?.updateContext();
  renderSystemInfo(dom["system-info-body"], state.startup);
  updateSaveState();
  runner?.updateControls();
  updateClassroom();
  if (reason === "variant-completed") {
    toast("变式完成啦，可以点“学习总结”看看这次的收获。");
  }
}

function renderEditorToolbox() {
  renderToolbox(dom["toolbox-list"], state, {
    onDragStart: (kind, event, source, grabInfo) => editor?.dnd.startToolboxDrag(kind, event, source, grabInfo),
    onAdd: (kind) => editor?.insertFromToolbox(kind),
    onBlockedClick: (definition) => toast(definition.blockedHint || "这个积木暂时不能运行。"),
  });
}

function installArtifact(descriptor) {
  applyArtifact({ state, descriptor, dom, editor, renderAll, runner });
  dom["result-details"].open = false;
  panels.close("tutorEvidence");
  updateObjectView(stageElements(), [], state.tasks.get(state.activeTaskId));
}

function leaveRunContext(reason) {
  return runner?.leaveRunContext({ reason });
}

function applyTask(taskId, { reset = false } = {}) {
  const task = state.tasks.get(taskId);
  if (!task) {
    toast("这个任务暂时打不开。", true);
    return false;
  }
  if (!task.enterable) {
    toast(task.blockedReason || "这个任务需要的积木暂不支持。", true);
    return false;
  }
  const draft = readClassroomDraft(state.studentId, task);
  if (reset && !clearClassroomDraft(state.studentId, task) && (draft || state.draftSavedRevision != null)) {
    toast("这道题的草稿暂时无法清除，可以再试一次。", true);
    return false;
  }
  installArtifact({
    source: "task",
    taskId,
    root: draft && !reset ? draft.root : cloneTree(programWorkspace(task.initialProgram)),
    draftSaved: Boolean(draft && !reset),
    readonly: false,
    readonlyReason: "",
  });
  rememberClassroomTask(state.studentId, task);
  setPhase("editing");
  state.dirty = false;
  return true;
}

async function switchTask(taskId, { restart = false } = {}) {
  if (switchingTask || (!restart && taskId === state.activeTaskId)) {
    return false;
  }
  const task = state.tasks.get(taskId);
  if (!task?.enterable) {
    toast(task?.blockedReason || "这个任务暂时打不开。", true);
    return false;
  }
  switchingTask = true;
  try {
    const outcome = await prepareWorkspaceChange({
      state, reason: "switch", confirm: projects.confirmLeaveDirty, leaveRunContext,
    });
    if (outcome === "run-pending") {
      toast("上一次运行还没有停下来，可以稍后再切换任务。", true);
    }
    if (outcome !== "ready" || !applyTask(taskId)) {
      return false;
    }
    if (state.skippedTaskIds.has(taskId)) {
      const studentId = state.studentId;
      API.feedback(taskId, "resume").then(() => {
        if (studentId === state.studentId) state.skippedTaskIds.delete(taskId);
      }).catch(() => {});
    }
    panels.close("taskList");
    toast(`已切换到：${task.title}`);
    return true;
  } finally {
    switchingTask = false;
  }
}

async function skipTask() {
  const taskId = state.activeTaskId;
  const studentId = state.studentId;
  try {
    await API.feedback(taskId, "skip");
    if (studentId !== state.studentId) return;
    state.skippedTaskIds.add(taskId);
    toast("任务先留在这里，想回来时随时回来。");
  } catch (error) {
    if (studentId === state.studentId) toast(error.messageForChild || "暂时没记下这次跳过。", true);
  }
}

function setStudent(studentId) {
  state.studentId = studentId;
  setClassroomStudent(studentId);
}

async function switchStudent(studentId) {
  if (switchingTask || !state.course) return false;
  switchingTask = true;
  try {
    const outcome = await prepareWorkspaceChange({
      state, reason: "student", confirm: projects.confirmLeaveDirty, leaveRunContext,
    });
    if (outcome !== "ready") {
      if (outcome === "run-pending") toast("等这次运行结束后再切换学生。", true);
      return false;
    }
    setStudent(studentId);
    const recent = lastClassroomTask(studentId, state.course);
    const next = [recent, state.activeTaskId].find((taskId) => state.tasks.get(taskId)?.enterable)
      ?? [...state.tasks.values()].find((task) => task.enterable)?.taskId;
    state.prediction.clear();
    state.predictionContext.clear();
    state.predictionPending.clear();
    state.skippedTaskIds.clear();
    state.mainCompletedHint = false;
    state.lessonObservation = "";
    dom["prediction-input"].value = "";
    if (dom["summary-panel"].open) closeSummary();
    if (next) applyTask(next);
    return true;
  } finally {
    switchingTask = false;
  }
}

function stageElements() {
  return {
    path: dom["stage-path"],
    meta: dom["object-meta"],
  };
}

function startupElements() {
  return {
    banner: dom["startup-banner"],
    title: dom["startup-title"],
    checks: dom["startup-checks"],
    pythonChip: dom["python-chip"],
    versionChip: dom["version-chip"],
    modeChip: dom["mode-chip"],
    retry: dom["startup-retry"],
    enter: dom["startup-enter"],
  };
}

function openSummary() {
  showSummary({
    panel: dom["summary-panel"],
    content: dom["summary-content"],
    state,
    callbacks: {
      onVariant: async (taskId) => {
        if (await switchTask(taskId, { restart: true })) {
          closeSummary();
          returnToWorkspace();
        }
      },
      onShowSkipped: (skipped) => {
        toast(skipped.length ? `先跳过的任务：${skipped.join("、")}` : "这次没有跳过的任务。");
      },
      onFinish: () => {
        closeSummary();
        toast("演示结束，谢谢你今天的练习。");
      },
    },
  });
}

function closeSummary() {
  dom["summary-panel"].close();
}

function canEditHistory() {
  return !state.readonly && ["editing", "result", "error"].includes(state.phase);
}

function updateHistoryControls() {
  dom["undo-button"].disabled = !canEditHistory() || !history?.canUndo();
  dom["redo-button"].disabled = !canEditHistory() || !history?.canRedo();
}

function changeHistory(action) {
  if (canEditHistory() && history?.[action]()) {
    toast(action === "undo" ? "已撤销。" : "已重做。");
  }
}

/** 海龟老师“展开”：面板盖住舞台和运行区，顶部留一行舞台状态；运行开始或按 Esc 时收起。 */
function setTutorExpanded(open, { focus = false } = {}) {
  const column = dom["tutor-panel"]?.closest?.(".feedback-column");
  const button = dom["tutor-expand"];
  if (!column || !button) return;
  column.classList.toggle("tutor-expanded", open);
  button.setAttribute("aria-expanded", String(open));
  button.querySelector("span").textContent = open ? "收起" : "展开";
  dom["tutor-stage-mini"].hidden = !open;
  if (open) syncTutorStageMini();
  if (focus) (open ? dom["tutor-chat-input"] : button)?.focus();
  editor?.refresh?.();
}

function syncTutorStageMini() {
  const text = dom["tutor-stage-mini-text"];
  if (!text) return;
  const verdict = dom["result-content"]?.querySelector?.(".result-status")?.textContent || "";
  text.textContent = `舞台：${dom["object-meta"]?.textContent || ""}${verdict ? ` ${verdict}` : ""}`;
}

function bindTutorExpand() {
  const button = dom["tutor-expand"];
  if (!button) return;
  button.addEventListener("click", () => {
    setTutorExpanded(button.getAttribute("aria-expanded") !== "true", { focus: true });
  });
  dom["tutor-panel"].addEventListener("keydown", (event) => {
    if (event.key === "Escape" && button.getAttribute("aria-expanded") === "true") {
      event.stopPropagation();
      setTutorExpanded(false, { focus: true });
    }
  });
  if (typeof MutationObserver === "function") {
    const observer = new MutationObserver(() => {
      if (!dom["tutor-stage-mini"].hidden) syncTutorStageMini();
    });
    for (const target of [dom["object-meta"], dom["result-content"]]) {
      if (target) observer.observe(target, { childList: true, characterData: true, subtree: true });
    }
  }
}

function handleStateChange(reason) {
  if (reason === "phase" && ["validating", "running"].includes(state.phase)) {
    setTutorExpanded(false);
  }
  if (reason === "phase") {
    tutor?.updateContext();
    editor?.render();
    predictions.render();
    updateHistoryControls();
    updateClassroom();
  }
  if (reason === "program") {
    state.programRevision += 1;
    state.dirty = true;
    const task = state.tasks.get(state.activeTaskId);
    if (task?.enterable && !state.readonly) {
      const saved = saveClassroomDraft(state.studentId, task, state.root);
      state.draftSavedRevision = saved ? state.programRevision : null;
      state.draftSaveFailed = !saved;
      if (saved) rememberClassroomTask(state.studentId, task);
    }
    refreshResultOwnership();
    tutor?.updateContext();
    updateSaveState();
    updateHistoryControls();
  }
  if (reason === "program" || reason === "select") {
    if (reason === "select") tutor?.updateContext();
    predictions.render();
    runner?.updateControls();
    updateClassroom();
  }
  if (reason === "save") {
    updateSaveState();
    updateClassroom();
  }
}

async function boot() {
  collectDom();
  bindModelConfig(document, (config) => {
    state.modelConfigRevision = config.revision;
    tutor?.updateContext();
  });
  panels = bindWorkbenchPanels(dom, (changed) => {
    if (changed) editor?.cancelDrag("layout");
    editor?.refresh();
    tutor?.updateContext();
  });
  dom["result-tab-tutor"].addEventListener("click", () => tutor?.focus?.());
  projects = createProjectWorkflow({
    state,
    elements: {
      dialog: dom["confirm-dialog"],
      title: dom["confirm-title"],
      text: dom["confirm-text"],
      file: dom["project-file"],
    },
    editorReady: () => Boolean(editor),
    applyProject: installArtifact,
    leaveRunContext,
    toast,
  });
  const courses = createCourseWorkflow({
    state,
    elements: startupElements(),
    confirmLeaveDirty: projects.confirmLeaveDirty,
    leaveRunContext,
    applyTask,
    renderAll,
    updateRunControls: () => runner?.updateControls(),
    toast,
    onEnterClassroom: () => {
      panels.enterClassroom();
      updateClassroom();
    },
  });
  predictions = createPredictionWorkflow({
    state,
    elements: predictionElements(),
    isRunning: () => runner?.isBusy(),
    onChange: () => {
      runner?.updateControls();
      updateClassroom();
    },
    toast,
  });
  subscribe(handleStateChange);
  const closeProjectMenu = () => {
    if (dom["project-menu"]) dom["project-menu"].open = false;
  };
  dom["save-project"].addEventListener("click", () => {
    closeProjectMenu();
    return projects.saveProject();
  });
  dom["open-project"].addEventListener("click", () => {
    closeProjectMenu();
    dom["project-file"].click();
  });
  document.addEventListener("click", (event) => {
    if (dom["project-menu"]?.open && !dom["project-menu"].contains(event.target)) closeProjectMenu();
  });
  dom["project-menu"]?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dom["project-menu"].open) {
      event.stopPropagation();
      closeProjectMenu();
      dom["project-menu"].querySelector("summary")?.focus();
    }
  });
  bindTutorExpand();
  dom["tutor-quick"]?.addEventListener("click", (event) => {
    const chip = event.target.closest?.("[data-quick]");
    const input = dom["tutor-chat-input"];
    const form = dom["tutor-chat-form"];
    if (!chip || !input || !form || dom["tutor-chat-send"]?.disabled) return;
    input.value = chip.dataset.quick;
    form.requestSubmit();
  });
  dom["project-file"].addEventListener("change", () => {
    const file = dom["project-file"].files?.[0];
    projects.openProject(file);
  });
  if (dom["summary-open"]) {
    dom["summary-open"].addEventListener("click", openSummary);
  }
  dom["summary-skipped"].addEventListener("click", () => toast("可以先继续练习，稍后再回来。"));
  dom["summary-close"].addEventListener("click", closeSummary);
  dom["run-locate"].addEventListener("click", () => returnToWorkspace(dom["run-locate"].dataset.blockId));
  dom["undo-button"].addEventListener("click", () => changeHistory("undo"));
  dom["redo-button"].addEventListener("click", () => changeHistory("redo"));
  window.addEventListener("beforeunload", (event) => {
    if (state.dirty && state.draftSavedRevision !== state.programRevision) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  try {
    const schema = await API.schema();
    state.schema = schema;
    state.blocksByKind = new Map(schema.blocks.map((block) => [block.kind, block]));
    state.rejectedKinds = schema.rejectedKinds || [];

    history = new History({
      snapshot: () => cloneTree(state.root),
      restore: (root) => {
        editor.setProgram(root, { clearHistory: false, notify: false });
        state.dirty = true;
        notify("program");
      },
    });

    editor = new EditorView({
      canvas: dom["block-canvas"],
      toolbox: dom.toolbox,
      stage: dom["block-canvas"].parentElement,
      mirror: dom["a11y-mirror"],
      empty: dom["canvas-empty"],
      code: dom["code-preview-text"],
      state,
      history,
      toast,
      onChange: (reason) => notify(reason),
      handlers: {
        run: () => runner?.run(),
        hint: askForHint,
        undo: () => changeHistory("undo"),
        redo: () => changeHistory("redo"),
        deleteSelected: () => editor.deleteSelected(),
      },
    });

    window.__cmkEditor = editor;
    editor.openSelectedHint = askForHint;
    const startup = await API.startup();
    state.startup = startup;
    state.mode = startup.tutorMode;
    taskReader = createTaskReader({ state, onStart: () => tutor?.interruptSpeech?.() });

    runner = createRunner({
      elements: {
        run: dom["run-button"],
        debug: dom["debug-button"],
        debugPanel: dom["debug-panel"],
        debugStep: dom["debug-step"],
        debugPlay: dom["debug-play"],
        debugSpeed: dom["debug-speed"],
        debugStatus: dom["debug-status"],
        stop: dom["stop-button"],
        reset: dom["reset-button"],
        hint: dom["run-hint"],
        stateChip: dom["run-state-chip"],
        result: dom["result-content"],
        objectView: stageElements(),
        liveOutput: dom["live-output"],
      },
      state,
      editor,
      toast,
      refresh: (reason) => renderAll(reason || "run"),
      resetToTask: (taskId) => applyTask(taskId, { reset: true }),
      getResultActions: resultCallbacks,
      onPhaseChange: () => notify("phase"),
    });

    const chatEnabled = startup.tutorChatEnabled === true;
    dom["tutor-chat"].hidden = !chatEnabled;
    dom["tutor-legacy"].hidden = chatEnabled;
    tutor = chatEnabled ? createTutorChat({
      elements: {
        log: dom["tutor-chat-log"],
        form: dom["tutor-chat-form"],
        input: dom["tutor-chat-input"],
        selection: dom["tutor-chat-selection"],
        submit: dom["tutor-chat-send"],
        speechButton: dom["tutor-speech-button"],
        voiceButton: dom["tutor-voice-button"],
        speechNote: dom["tutor-speech-note"],
      },
      state, editor, onLocate: returnToWorkspace, onReplayFrame: showReplayFrame,
      speechEnabled: startup.tutorSpeechEnabled === true,
      onSpeechStart: () => taskReader.stop(),
    }) : createTutor({
      elements: {
        message: dom["tutor-message"],
        detail: dom["tutor-detail"],
        input: dom["tutor-input"],
        submit: dom["tutor-submit"],
        buttons: dom.tutorButtons,
      },
      state,
      editor,
      toast,
      onLocate: returnToWorkspace,
      onAnswer: () => panels.open("tutorInput"),
      onReplayFrame: showReplayFrame,
      actions: {
        predict: () => dom["prediction-input"].focus(),
        run: () => runner?.run(),
        compare: () => {
          panels.showResultSlot("result");
          dom["result-content"].setAttribute("tabindex", "-1");
          dom["result-content"].focus();
        },
        edit_one: () => returnToWorkspace(),
        open_next_task: ({ task, choice }) => {
          if (choice === "skip") return panels.open("taskList");
          const next = nextTask(task);
          return next ? switchTask(next.taskId) : openSummary();
        },
      },
    });

    const course = await API.course();
    if (chatEnabled) {
      await bindStudents({
        elements: {
          container: dom["student-controls"], select: dom["student-select"], dialog: dom["student-dialog"],
          form: dom["student-form"], input: dom["student-name"], create: dom["student-create"],
          save: dom["student-save"], cancel: dom["student-cancel"],
        },
        onInitial: setStudent, onSwitch: switchStudent, toast,
      });
    }
    const recent = lastClassroomTask(state.studentId, course);
    if (course.tasks.some((task) => task.taskId === recent && task.enterable)) state.activeTaskId = recent;
    if (courses.installCourse(course) && startup.status === "ready") {
      toast(state.draftSavedRevision === state.programRevision
        ? "已恢复本题草稿，可以接着搭积木。"
        : "课堂准备好啦，先读一读目标，再搭积木。");
    }
    updateSaveState();
    updateClassroom();
  } catch (error) {
    toast(error.messageForChild || "课堂没有加载成功，请刷新页面再试。", true);
  } finally {
    if (state.startup) {
      courses.renderReport();
      renderSystemInfo(dom["system-info-body"], state.startup);
    }
  }
}

boot();
