/** 应用入口：装配编辑器、视图与工作流。 */
import { API } from "./api.js";
import { cloneTree, programWorkspace } from "./editor/model.js";
import { History } from "./editor/undo.js";
import { captureContext, isCurrentContext } from "./core/viewContext.js";
import { notify, setPhase, state, subscribe } from "./state.js";
import { applyArtifact } from "./views/artifact.js";
import { EditorView } from "./views/canvas.js";
import { renderCourse, renderPrediction } from "./views/course.js";
import { createRunner } from "./views/runner.js";
import { updateModeBadge } from "./views/startup.js";
import { showSummary } from "./views/summary.js";
import { renderToolbox } from "./views/toolbox.js";
import { createTutor } from "./views/tutor.js";
import { createCourseWorkflow } from "./workflows/course.js";
import { createProjectWorkflow } from "./workflows/projects.js";

window.__cmkApi = API;
window.__cmkState = state;

const dom = {};

let editor = null;
let history = null;
let runner = null;
let tutor = null;
let projects = null;
let toastTimer = null;

function collectDom() {
  const ids = [
    "startup-banner",
    "startup-title",
    "startup-checks",
    "startup-retry",
    "startup-enter",
    "python-chip",
    "version-chip",
    "mode-chip",
    "run-state-chip",
    "course-panel",
    "course-content",
    "prediction-box",
    "prediction-label",
    "prediction-input",
    "prediction-submit",
    "prediction-feedback",
    "toolbox",
    "toolbox-list",
    "block-canvas",
    "canvas-empty",
    "canvas-title",
    "a11y-mirror",
    "code-preview-text",
    "run-button",
    "stop-button",
    "reset-button",
    "run-hint",
    "stage-actor",
    "object-meta",
    "result-content",
    "prediction-compare",
    "compare-prediction",
    "compare-actual",
    "compare-match",
    "live-output",
    "tutor-message",
    "tutor-detail",
    "tutor-input",
    "tutor-submit",
    "tutor-mode-badge",
    "summary-panel",
    "summary-content",
    "summary-variant",
    "summary-skipped",
    "summary-finish",
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

function renderAll(reason = "all") {
  if (!state.course) {
    return;
  }
  renderCourse(dom["course-content"], state, {
    onSelectTask: (taskId) => switchTask(taskId),
  });
  renderPrediction(state, predictionElements(), {});
  renderEditorToolbox();
  updateModeBadge(state.mode);
  runner?.updateControls();
  if (reason === "variant-completed") {
    openSummary();
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

async function switchTask(taskId) {
  if (taskId === state.activeTaskId) {
    return;
  }
  if (!state.tasks.has(taskId)) {
    toast("这个任务暂时打不开。", true);
    return;
  }
  if (!(await projects.confirmLeaveDirty())) {
    return;
  }
  await leaveRunContext("switch");
  applyTask(taskId);
  toast(`已切换到：${state.tasks.get(taskId)?.title || taskId}`);
}

async function submitPrediction() {
  const ctx = captureContext(state, state.activeTaskId);
  const task = state.tasks.get(ctx.taskId);
  if (!task) {
    return;
  }
  const raw = dom["prediction-input"].value.trim();
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value) || value < 0 || value > 1000) {
    dom["prediction-feedback"].textContent = "先猜一猜角色会动几次，填一个数字吧。";
    dom["prediction-feedback"].className = "hint-text bad";
    dom["prediction-input"].focus();
    return;
  }
  try {
    await API.prediction(ctx.taskId, Math.trunc(value));
    state.prediction.set(ctx.taskId, Math.trunc(value));
    if (!isCurrentContext(state, ctx)) {
      return;
    }
    renderPrediction(state, predictionElements(), {});
    runner?.updateControls();
    toast("预测记下了，现在可以运行啦。");
  } catch (error) {
    if (!isCurrentContext(state, ctx)) {
      return;
    }
    dom["prediction-feedback"].textContent = error.messageForChild || "预测没有记下来。";
    dom["prediction-feedback"].className = "hint-text bad";
  }
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
        dom["summary-panel"].hidden = true;
        if (state.variantAvailable === false) {
          toast("这节课的加练还没准备好。");
          return;
        }
        await leaveRunContext("summary-variant");
        applyTask("variant");
      },
      onShowSkipped: (skipped) => {
        toast(skipped.length ? `先跳过的任务：${skipped.join("、")}` : "这次没有跳过的任务。");
      },
      onFinish: () => {
        dom["summary-panel"].hidden = true;
        toast("演示结束，谢谢你今天的练习。");
      },
    },
  });
}

function handleStateChange(reason) {
  if (reason === "phase") {
    editor?.render();
  }
  if (reason === "program") {
    state.programRevision += 1;
    state.dirty = true;
    dom["prediction-compare"].hidden = true;
  }
  if (reason === "program" || reason === "select") {
    renderPrediction(state, predictionElements(), {});
    runner?.updateControls();
  }
}

async function boot() {
  collectDom();
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
        hint: () => tutor?.ask("hint"),
        undo: () => {
          if (history.undo()) {
            toast("已撤销。");
          }
        },
        redo: () => {
          if (history.redo()) {
            toast("已重做。");
          }
        },
        deleteSelected: () => editor.deleteSelected(),
      },
    });

    editor.openSelectedHint = () => tutor?.ask("hint");
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
        objectView: { actor: dom["stage-actor"], meta: dom["object-meta"] },
        liveOutput: dom["live-output"],
      },
      state,
      editor,
      toast,
      refresh: (reason) => renderAll(reason || "run"),
      resetToTask: applyTask,
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
      onChange: () => {},
    });

    const course = await API.course();
    if (courses.installCourse(course) && startup.status === "ready") {
      toast("课堂准备好啦，先读一读目标，再猜一猜角色会动几次。");
    }
  } catch (error) {
    toast(error.messageForChild || "课堂没有加载成功，请刷新页面再试。", true);
  } finally {
    if (state.startup) {
      courses.renderReport();
    }
  }
}

boot();
