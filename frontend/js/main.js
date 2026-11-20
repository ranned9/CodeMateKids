/** 应用入口：装配编辑器、派生层、视图与工作流。 */
import { API } from "./api.js";
import { evaluateRunGate } from "./core/runGate.js";
import { captureContext, isCurrentContext } from "./core/viewContext.js";
import { cloneTree, programWorkspace, validateTree } from "./editor/model.js";
import { History } from "./editor/undo.js";
import { notify, setPhase, state, subscribe } from "./state.js";
import { classifyResult } from "./ux/runContext.js";
import { deriveClassroomState, stateHintTone } from "./ux/classroomState.js";
import { createFocusScope } from "./ux/focusScope.js";
import { createLayoutMode } from "./ux/layoutMode.js";
import { locateTarget } from "./ux/locate.js";
import { createPanelController } from "./ux/panels.js";
import { applyPrimaryAction } from "./ux/primaryAction.js";
import { deriveSaveState, saveStateClass } from "./ux/saveState.js";
import { renderSystemInfo } from "./ux/systemInfo.js";
import { applyArtifact } from "./views/artifact.js";
import { EditorView } from "./views/canvas.js";
import { renderCourse, renderCoursePanels, renderPrediction } from "./views/course.js";
import { createRunner } from "./views/runner.js";
import { renderResult, updateObjectView } from "./views/result.js";
import { updateModeBadge } from "./views/startup.js";
import { showSummary } from "./views/summary.js";
import { renderToolbox } from "./views/toolbox.js";
import { createTutor } from "./views/tutor.js";
import { createCourseWorkflow } from "./workflows/course.js";
import { createProjectWorkflow } from "./workflows/projects.js";

window.__cmkApi = API;
window.__cmkState = state;

const dom = {};
const ui = { panels: null, layoutMode: null, focusScope: null };

let editor = null;
let history = null;
let runner = null;
let tutor = null;
let projects = null;
let toastTimer = null;
let deleteUndo = null;
let deleteUndoTimer = null;
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
    "undo-delete-banner",
    "undo-delete-action",
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
    "stop-button",
    "reset-button",
    "run-hint",
    "run-locate",
    "stage-ticks",
    "stage-target",
    "stage-actor",
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
  ];
  for (const id of ids) {
    dom[id] = document.getElementById(id);
  }
  dom.tutorButtons = Array.from(document.querySelectorAll(".tutor-actions button[data-choice]"));
}

function collectPanelMaps() {
  const panelMap = {};
  const triggerMap = {};
  if (typeof document.querySelectorAll !== "function") {
    return { panelMap, triggerMap };
  }
  for (const element of document.querySelectorAll("[data-panel]")) {
    const id = element.getAttribute?.("data-panel");
    if (id) {
      panelMap[id] = element;
    }
  }
  for (const element of document.querySelectorAll("[data-panel-trigger]")) {
    const id = element.getAttribute?.("data-panel-trigger");
    if (id) {
      (triggerMap[id] ||= []).push(element);
    }
  }
  return { panelMap, triggerMap };
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

function currentGate() {
  return evaluateRunGate({
    state,
    taskId: state.activeTaskId,
    root: state.root,
    validate: () => validateTree(state.root),
  });
}

function updateSaveState() {
  const derived = deriveSaveState({
    dirty: state.dirty,
    saving: state.saveStateSaving,
    lastSavedRevision: state.lastSavedRevision,
    programRevision: state.programRevision,
    lastError: state.saveError,
  });
  const element = dom["save-state"];
  if (element) {
    element.textContent = derived.label;
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
    gate: currentGate(),
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
  return {
    details: dom["result-detail-content"],
    onBackToBlocks: () => returnToWorkspace(),
    onLocate: (blockId) => returnToWorkspace(blockId),
    onHint: () => askForHint(),
    onVariant: state.variantAvailable ? () => switchTask("variant") : null,
    onSummary: openSummary,
  };
}

function returnToWorkspace(blockId = state.selectedBlockId) {
  locateTarget(editor, blockId);
}

function askForHint() {
  setSlot("tutor");
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
  renderCourse(dom["course-content"], state, {
    onSelectTask: (taskId) => switchTask(taskId),
  });
  renderCoursePanels(
    {
      taskList: dom["task-list-panel"],
      learningObjectives: dom["learning-objectives-panel"],
      otherThemes: dom["other-themes-panel"],
    },
    state,
    { onSelectTask: (taskId) => switchTask(taskId) },
  );
  renderPrediction(state, predictionElements(), {});
  renderEditorToolbox();
  updateHistoryControls();
  updateModeBadge(state.mode);
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
    onDragStart: (kind, event, source) => editor?.dnd.startToolboxDrag(kind, event, source),
    onAdd: (kind) => editor?.insertFromToolbox(kind),
    onBlockedClick: (definition) => toast(definition.blockedHint || "这个积木暂时不能运行。"),
  });
}

function installArtifact(descriptor) {
  applyArtifact({ state, descriptor, dom, editor, renderAll, runner });
  clearDeleteUndo();
  dom["result-details"].open = false;
  ui.panels?.close("tutorEvidence", { silentFocus: true });
  updateObjectView(stageElements(), [], state.tasks.get(state.activeTaskId));
}

function leaveRunContext(reason) {
  return runner?.leaveRunContext({ reason });
}

function applyTask(taskId) {
  const task = state.tasks.get(taskId);
  if (!task) {
    toast("这个任务暂时打不开。", true);
    return false;
  }
  if (!task.enterable) {
    toast(task.blockedReason || "这个任务需要的积木暂不支持。", true);
    return false;
  }
  installArtifact({
    source: "task",
    taskId,
    root: cloneTree(programWorkspace(task.initialProgram)),
    readonly: false,
    readonlyReason: "",
  });
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
  const ctx = captureContext(state);
  try {
    if (!(await projects.confirmLeaveDirty()) || !isCurrentContext(state, ctx)) {
      return false;
    }
    const revision = state.programRevision;
    const leaving = leaveRunContext("switch");
    const nextContext = captureContext(state);
    if ((await leaving)?.stopped === false) {
      toast("上一次运行还没有停下来，可以稍后再切换任务。", true);
      return false;
    }
    if (!isCurrentContext(state, nextContext) || revision !== state.programRevision || !applyTask(taskId)) {
      return false;
    }
    ui.panels?.close("taskList", { silentFocus: true });
    toast(`已切换到：${task.title}`);
    return true;
  } finally {
    switchingTask = false;
  }
}

async function submitPrediction() {
  const ctx = captureContext(state, state.activeTaskId);
  const task = state.tasks.get(ctx.taskId);
  if (!task?.enterable || state.readonly || runner?.isBusy()) {
    return;
  }
  if (state.predictionPending.has(ctx.taskId)) {
    toast("正在记下这个猜想，稍等一下。");
    return;
  }
  const raw = dom["prediction-input"].value.trim();
  const value = Number(raw);
  if (raw === "" || !Number.isInteger(value) || value < 0 || value > 1000) {
    dom["prediction-feedback"].textContent = "请填一个 0 到 1000 之间的整数。";
    dom["prediction-feedback"].className = "hint-text bad";
    dom["prediction-input"].focus();
    return;
  }
  const contentVersion = state.contentVersion;
  const prediction = {
    ...ctx,
    programRevision: state.programRevision,
    source: state.prediction.has(ctx.taskId) ? "reguess" : "initial",
  };
  state.predictionPending.set(ctx.taskId, prediction);
  renderPrediction(state, predictionElements());
  runner?.updateControls();
  updateClassroom();
  let failure = "";
  try {
    const ack = await API.prediction(ctx.taskId, value);
    if (state.contentVersion === contentVersion) {
      state.prediction.set(ctx.taskId, ack?.value ?? value);
      state.predictionContext.set(ctx.taskId, prediction);
    }
  } catch (error) {
    failure = error.messageForChild || "预测没有记下来，可以再试一次。";
  } finally {
    state.predictionPending.delete(ctx.taskId);
    if (ctx.taskId === state.activeTaskId) {
      const current = isCurrentContext(state, ctx);
      renderPrediction(state, predictionElements(), { preserveInput: current && Boolean(failure) });
      if (current && failure) {
        dom["prediction-feedback"].textContent = failure;
        dom["prediction-feedback"].className = "hint-text bad";
      }
      runner?.updateControls();
      updateClassroom();
    }
  }
}

function stageElements() {
  return {
    actor: dom["stage-actor"],
    meta: dom["object-meta"],
    target: dom["stage-target"],
    ticks: dom["stage-ticks"],
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
    modeBadge: dom["tutor-mode-badge"],
  };
}

function openSummary() {
  showSummary({
    panel: dom["summary-panel"],
    content: dom["summary-content"],
    state,
    callbacks: {
      onVariant: async () => {
        if (await switchTask("variant", { restart: true })) {
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

function clearDeleteUndo() {
  window.clearTimeout(deleteUndoTimer);
  deleteUndo = null;
  dom["undo-delete-banner"].hidden = true;
}

function canEditHistory() {
  return !state.readonly && ["editing", "result", "error"].includes(state.phase);
}

function updateHistoryControls() {
  dom["undo-button"].disabled = !canEditHistory() || !history?.canUndo();
  dom["redo-button"].disabled = !canEditHistory() || !history?.canRedo();
  if (deleteUndo && (deleteUndo.pageVersion !== state.pageVersion || deleteUndo.id !== history?.latestTransactionId())) {
    clearDeleteUndo();
  }
  dom["undo-delete-action"].disabled = !canEditHistory();
}

function changeHistory(action, transactionId) {
  if (canEditHistory() && history?.[action](transactionId)) {
    toast(action === "undo" ? "已撤销。" : "已重做。");
  }
}

function handleStateChange(reason) {
  if (reason === "phase") {
    editor?.render();
    renderPrediction(state, predictionElements());
    updateHistoryControls();
    updateClassroom();
  }
  if (reason === "program") {
    state.programRevision += 1;
    state.dirty = true;
    refreshResultOwnership();
    tutor?.updateContext();
    updateSaveState();
    updateHistoryControls();
  }
  if (reason === "program" || reason === "select") {
    renderPrediction(state, predictionElements(), {});
    runner?.updateControls();
    updateClassroom();
  }
  if (reason === "save") {
    updateSaveState();
    updateClassroom();
  }
}

function refreshResultTabs(mode) {
  const tabs = dom["result-tabs"];
  if (tabs) {
    tabs.hidden = !(mode === "editorFirst" || mode === "simple");
  }
}

function setSlot(slot) {
  ui.panels?.open(slot, { keepDefault: true, silentFocus: true });
  dom["result-tab-result"]?.setAttribute("aria-pressed", String(slot === "result"));
  dom["result-tab-tutor"]?.setAttribute("aria-pressed", String(slot === "tutor"));
}

function enterClassroom() {
  const banner = dom["startup-banner"];
  if (banner) {
    if (banner.classList) {
      banner.classList.add("entered");
    } else {
      banner.className = `${banner.className || ""} entered`;
    }
  }
  ui.panels?.close("startupDetails", { keepOverridden: true, silentFocus: true });
  updateClassroom();
}

function setupUx() {
  ui.focusScope = createFocusScope({ fallbackAnchorId: "canvas-toolbar" });
  const maps = collectPanelMaps();
  ui.panels = createPanelController({
    getPanel: (id) => maps.panelMap[id] || null,
    getTrigger: (id) => maps.triggerMap[id] || null,
    focusScope: ui.focusScope,
  });
  if (typeof document.querySelectorAll === "function") {
    for (const trigger of document.querySelectorAll("[data-panel-trigger]")) {
      const panelId = trigger.getAttribute?.("data-panel-trigger");
      if (!panelId) {
        continue;
      }
      trigger.addEventListener("click", () => {
        ui.panels.toggleFromTrigger(panelId, trigger);
      });
    }
  }
  if (typeof document.addEventListener === "function") {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || dom["summary-panel"].open || dom["confirm-dialog"].open) {
        return;
      }
      const tag = event.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      const panelId = event.target?.closest?.("[data-panel]")?.dataset.panel
        || event.target?.closest?.("[data-panel-trigger]")?.dataset.panelTrigger;
      if (panelId && !["result", "tutor"].includes(panelId) && ui.panels.isOpen(panelId)) {
        event.preventDefault();
        ui.panels.close(panelId);
        return;
      }
      for (const panelId of ["systemInfo", "taskList", "learningObjectives", "otherThemes", "codePreview", "tutorMore", "tutorInput", "tutorEvidence", "startupDetails"]) {
        if (ui.panels.isOpen(panelId)) {
          ui.panels.close(panelId);
          break;
        }
      }
    });
  }
  ui.panels.open("result", { keepDefault: true, silentFocus: true });
  ui.panels.open("tutor", { keepDefault: true, silentFocus: true });

  ui.layoutMode = createLayoutMode();
  const applyLayout = (value) => {
    if (ui.currentLayout && ui.currentLayout !== value.mode) {
      editor?.cancelDrag("layout");
    }
    ui.currentLayout = value.mode;
    document.body?.setAttribute?.("data-layout-mode", value.mode);
    ui.panels.applyMode(value.mode);
    refreshResultTabs(value.mode);
    const tutorOpen = ui.panels.isOpen("tutor") && !ui.panels.isOpen("result");
    dom["result-tab-result"].setAttribute("aria-pressed", String(!tutorOpen));
    dom["result-tab-tutor"].setAttribute("aria-pressed", String(tutorOpen));
    editor?.refresh?.();
  };
  applyLayout(ui.layoutMode.current());
  ui.layoutMode.onChange?.(applyLayout);
}

async function boot() {
  collectDom();
  setupUx();
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
    onEnterClassroom: enterClassroom,
  });
  subscribe(handleStateChange);
  dom["prediction-submit"].addEventListener("click", submitPrediction);
  dom["prediction-input"].addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submitPrediction();
    }
  });
  dom["save-project"].addEventListener("click", projects.saveProject);
  dom["open-project"].addEventListener("click", () => dom["project-file"].click());
  dom["project-file"].addEventListener("change", () => {
    const file = dom["project-file"].files?.[0];
    projects.openProject(file);
  });
  if (dom["summary-open"]) {
    dom["summary-open"].addEventListener("click", openSummary);
  }
  dom["summary-skipped"].addEventListener("click", () => toast("可以先继续练习，稍后再回来。"));
  dom["summary-close"].addEventListener("click", closeSummary);
  dom["result-tab-result"]?.addEventListener("click", () => setSlot("result"));
  dom["result-tab-tutor"]?.addEventListener("click", () => setSlot("tutor"));
  dom["run-locate"].addEventListener("click", () => returnToWorkspace(dom["run-locate"].dataset.blockId));
  dom["undo-button"].addEventListener("click", () => changeHistory("undo"));
  dom["redo-button"].addEventListener("click", () => changeHistory("redo"));
  dom["undo-delete-action"]?.addEventListener("click", () => {
    if (deleteUndo?.pageVersion === state.pageVersion) {
      changeHistory("undo", deleteUndo.id);
    }
    clearDeleteUndo();
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  try {
    const schema = await API.schema();
    state.schema = schema;
    state.blocksByKind = new Map(schema.blocks.map((block) => [block.kind, block]));
    state.portRules = schema.portRules || {};
    state.rejectedKinds = schema.rejectedKinds || [];
    window.__cmkState = state;

    history = new History({
      snapshot: () => cloneTree(state.root),
      restore: (root) => {
        editor.setProgram(root, { clearHistory: false });
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
        onDeleted: (id) => {
          clearDeleteUndo();
          if (id) {
            deleteUndo = { id, pageVersion: state.pageVersion };
            dom["undo-delete-banner"].hidden = false;
            deleteUndoTimer = window.setTimeout(clearDeleteUndo, 6500);
          }
        },
      },
    });

    editor.openSelectedHint = askForHint;
    const startup = await API.startup();
    state.startup = startup;
    state.mode = startup.tutorMode;

    runner = createRunner({
      elements: {
        run: dom["run-button"],
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
      resetToTask: applyTask,
      getResultActions: resultCallbacks,
    });

    tutor = createTutor({
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
    });

    const course = await API.course();
    if (courses.installCourse(course) && startup.status === "ready") {
      toast("课堂准备好啦，先读一读目标，再猜一猜角色会动几次。");
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
