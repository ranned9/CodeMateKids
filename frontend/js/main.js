/** 应用入口：装配视图、统一载入、异步归属与内容版本刷新。 */
import { API } from "./api.js";
import { cloneTree, buildProgram } from "./editor/model.js";
import { History } from "./editor/undo.js";
import { captureContext, isCurrentContext } from "./core/viewContext.js";
import { notify, setPhase, state, subscribe } from "./state.js";
import { applyArtifact } from "./views/artifact.js";
import { EditorView } from "./views/canvas.js";
import { renderCourse, renderPrediction } from "./views/course.js";
import { createRunner } from "./views/runner.js";
import { renderStartup, updateModeBadge } from "./views/startup.js";
import { showSummary } from "./views/summary.js";
import { renderToolbox } from "./views/toolbox.js";
import { createTutor } from "./views/tutor.js";

window.__cmkApi = API;
window.__cmkState = state;

const dom = {};

let editor = null;
let history = null;
let runner = null;
let tutor = null;
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
  renderToolbox(dom["toolbox-list"], state, {
    getLayout: () => editor?.layout,
    onDragStart: (kind, event, source) => editor?.dnd.startToolboxDrag(kind, event, source),
    onKeyboardAdd: (kind) => editor?.insertFromKeyboard(kind),
    onBlockedClick: (definition) => toast(definition.blockedHint || "这个积木暂时不能运行。"),
    onUnplaceableClick: () => toast("这个积木暂时没有能放的位置。"),
  });
  updateModeBadge(state.mode);
  runner?.updateControls();
  if (reason === "variant-completed") {
    openSummary();
  }
}

function applyTask(taskId, options = {}) {
  const task = state.tasks.get(taskId);
  if (!task) {
    toast("这个任务暂时打不开。", true);
    return false;
  }
  if (!task.enterable) {
    toast(task.blockedReason || "这个任务需要的积木暂不支持。", true);
    return false;
  }
  applyArtifact({
    state,
    descriptor: {
      source: "task",
      taskId,
      root: cloneTree(task.initialProgram.root),
      readonly: false,
      readonlyReason: "",
    },
    dom,
    editor,
    renderAll,
    runner,
  });
  setPhase("editing");
  state.dirty = false;
  return true;
}

function loadTask(taskId, options = {}) {
  return applyTask(taskId, options);
}

async function askUnsavedChoice() {
  if (!state.dirty) {
    return "discard";
  }
  const dialog = dom["confirm-dialog"];
  if (!dialog || typeof dialog.showModal !== "function") {
    return window.confirm("有还没保存的修改，继续会丢掉它们。继续吗？") ? "discard" : "cancel";
  }
  if (dom["confirm-title"]) {
    dom["confirm-title"].textContent = "还没保存的修改";
  }
  if (dom["confirm-text"]) {
    dom["confirm-text"].textContent = "要保存这个作品，还是放弃修改？";
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
    return await saveProject();
  }
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
  if (!(await confirmLeaveDirty())) {
    return;
  }
  if (runner) {
    await runner.leaveRunContext({ reason: "switch" });
  }
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

async function refreshStartup() {
  try {
    const data = await API.startupRefresh();
    const previousVersion = state.contentVersion;
    state.startup = data;
    state.mode = data.tutorMode;
    renderStartup(data, startupElements(), {
      onRetry: refreshStartup,
      onEnter: () => {
        dom["startup-banner"].hidden = true;
      },
    });
    runner?.updateControls();

    if (data.contentVersion) {
      state.contentVersion = data.contentVersion;
    }
    if (data.contentVersion && previousVersion && data.contentVersion !== previousVersion) {
      if (!(await confirmLeaveDirty())) {
        return;
      }
      if (runner) {
        await runner.leaveRunContext({ reason: "content" });
      }
      await reloadCourseForContent();
    }
  } catch (error) {
    toast(error.messageForChild || "重新检查没有成功。", true);
  }
}

async function reloadCourseForContent() {
  try {
    const course = await API.course();
    state.course = course;
    state.tasks = new Map(course.tasks.map((task) => [task.taskId, task]));
    state.variantAvailable = Boolean(course.tasks.find((task) => task.taskId === "variant")?.enterable);
    const current = state.tasks.get(state.activeTaskId);
    const target = current && current.enterable
      ? state.activeTaskId
      : Array.from(state.tasks.values()).find((task) => task.enterable)?.taskId;
    if (target) {
      applyTask(target, { reason: "content" });
      toast("课程内容已更新，界面已同步。");
    } else {
      renderAll("content");
      toast("课程内容已更新，但当前没有可运行的任务。", true);
    }
  } catch (error) {
    toast(error.messageForChild || "课程内容刷新失败。", true);
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

async function saveProject() {
  const task = state.tasks.get(state.activeTaskId) || state.tasks.get(state.artifactTaskId);
  if (!task || !editor) {
    toast("这个作品没有对应的课程任务，暂时不能保存。", true);
    return false;
  }
  try {
    const program = buildProgram(state.root, task);
    const payload = await API.saveProject(program, program.courseRef);
    downloadProject(payload);
    state.dirty = false;
    state.savedSnapshot = cloneTree(state.root);
    toast("作品已保存到本机。");
    return true;
  } catch (error) {
    toast(error.messageForChild || "没有保存成功，可以再试一次。", true);
    return false;
  }
}

async function openProject(file) {
  if (!file || !editor) {
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
    if (runner) {
      await runner.leaveRunContext({ reason: "open-project" });
    }
    applyArtifact({
      state,
      descriptor: {
        source: "project",
        taskId: validTask ? taskId : "",
        root: data.program.root,
        readonly: !validTask,
        readonlyReason: validTask ? "" : data.readOnlyReason || "这个作品对应的任务不在本机",
      },
      dom,
      editor,
      renderAll,
      runner,
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
    dom["project-file"].value = "";
  }
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
        if (runner) {
          await runner.leaveRunContext({ reason: "summary-variant" });
        }
        applyTask("variant", { reason: "summary" });
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
  if (reason === "program" || reason === "select") {
    renderPrediction(state, predictionElements(), {});
    runner?.updateControls();
    if (reason === "program") {
      state.dirty = true;
      dom["prediction-compare"].hidden = true;
    }
  }
}

async function boot() {
  collectDom();
  subscribe(handleStateChange);
  dom["prediction-submit"].addEventListener("click", submitPrediction);
  dom["prediction-input"].addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submitPrediction();
    }
  });
  dom["save-project"].addEventListener("click", saveProject);
  dom["open-project"].addEventListener("click", () => dom["project-file"].click());
  dom["project-file"].addEventListener("change", () => {
    const file = dom["project-file"].files?.[0];
    openProject(file);
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
    state.contentVersion = startup.contentVersion || null;
    renderStartup(startup, startupElements(), {
      onRetry: refreshStartup,
      onEnter: () => {
        dom["startup-banner"].hidden = true;
      },
    });

    const course = await API.course();
    state.course = course;
    state.tasks = new Map(course.tasks.map((task) => [task.taskId, task]));
    state.variantAvailable = Boolean(course.tasks.find((task) => task.taskId === "variant")?.enterable);
    if (course.contentVersion) {
      state.contentVersion = course.contentVersion;
    }

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
      resetToTask: (taskId) => applyTask(taskId),
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

    applyTask("main");
    if (startup.status === "ready") {
      toast("课堂准备好啦，先读一读目标，再猜一猜角色会动几次。");
    }
  } catch (error) {
    toast(error.messageForChild || "课堂没有加载成功，请刷新页面再试。", true);
  }
}

boot();