/** 通过应用入口验证保存、课程更新和重复次数编辑。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { API } from "../frontend/js/api.js";
import { createBlock } from "../frontend/js/editor/model.js";
import { readClassroomDraft } from "../frontend/js/workflows/classroom-drafts.js";

const noOp = () => {};
const canvasContext = new Proxy({ measureText: (text) => ({ width: text.length * 10 }) }, {
  get: (target, key) => target[key] ?? noOp,
});

class ElementStub {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.disabled = false;
  }
  get firstChild() {
    return this.children[0];
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
  }
  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }
  removeEventListener(name) {
    this.listeners.delete(name);
  }
  click() {
    return (this.onclick ?? this.listeners.get("click"))?.();
  }
  showModal() {
    assert.equal(Boolean(this.open), false);
    this.open = true;
  }
  closeWith(value) {
    assert.equal(this.open, true);
    this.open = false;
    this.returnValue = value;
    this.listeners.get("close")();
  }
  setAttribute() {}
  remove() {}
  closest() { return null; }
  getContext() {
    return canvasContext;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 720, height: 460 };
  }
}

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, new ElementStub());
  }
  return elements.get(id);
}
element("block-canvas").parentElement = new ElementStub();
globalThis.document = {
  getElementById: element,
  createElement: () => new ElementStub(),
  querySelectorAll: () => [],
  body: new ElementStub(),
  addEventListener: noOp,
};
globalThis.window = {
  setTimeout: noOp,
  clearTimeout: noOp,
  addEventListener: noOp,
  removeEventListener: noOp,
};

const schema = JSON.parse(readFileSync(new URL("../schemas/blocks.v1.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("../content/demo-loop/course.json", import.meta.url), "utf8"));
const initialVersion = fixture.contentVersion;
const newVersion = `${initialVersion.split(".").slice(0, 2).join(".")}.${Number(initialVersion.split(".")[2]) + 1}`;
let course = {
  course: { title: fixture.title, learningObjectives: fixture.learningObjectives },
  contentVersion: initialVersion,
  tasks: fixture.tasks.map((task) => ({ ...task, enterable: true })),
};
let startup = { status: "degraded", tutorMode: "mock", contentVersion: initialVersion };
let courseRequests = 0;
let courseUnavailable = false;
const saves = [];
API.schema = async () => schema;
API.startup = API.startupRefresh = async () => startup;
API.course = async () => {
  courseRequests += 1;
  if (courseUnavailable) {
    throw new Error("course unavailable");
  }
  return course;
};
API.saveProject = (program) => new Promise((resolve) => {
  saves.push({ program, resolve: () => resolve({ fileText: JSON.stringify(program) }) });
});

await import("../frontend/js/main.js");
await setImmediate();
const { __cmkState: state, __cmkEditor: editor } = window;
assert.equal(state.contentVersion, initialVersion);
assert.equal(state.root, null);
assert.equal(element("canvas-empty").hidden, false);
const toolbox = element("toolbox-list");
const categories = toolbox.children.find((item) => item.className === "toolbox-categories");
assert.deepEqual(categories.children.map((item) => item.dataset.category), ["全部", "开始", "动作", "循环", "分支"]);
const toolboxItems = toolbox.children.find((item) => item.className === "toolbox-items");
assert.deepEqual(toolboxItems.children.map((item) => item.dataset.kind).sort(),
  ["event.start", "control.repeat", "control.if", "control.else", "motion.move", "motion.turn"].sort());
const startItem = toolboxItems.children.find((item) => item.dataset.kind === "event.start");
startItem.listeners.get("pointerdown")({
  button: 0, pointerId: 1, clientX: 360, clientY: 230, preventDefault: noOp,
});
assert.deepEqual(editor.dnd.session.grabRatio, { x: 0.5, y: 0.5 });
assert.equal(editor.dnd.session.offset.x, editor.dnd.session.overlayLogical.w / 2);
editor.dnd.onCancel({ pointerId: 1 });
assert.equal(state.root, null);

assert.equal(editor.insertFromToolbox("event.start"), true);
assert.equal(editor.insertFromToolbox("control.repeat"), true);
assert.equal(editor.insertFromToolbox("motion.move"), true);
assert.equal(element("canvas-empty").hidden, true);

const repeatId = state.root.next.blockId;
const edit = (value) => editor.commitFieldValue(repeatId, "times", value);
const times = (root) => root.next.inputs.times;
const save = () => element("save-project").click();

edit("2");
const revision = state.programRevision;
edit("2.5");
assert.equal(times(state.root), 2);
assert.equal(state.programRevision, revision);
assert.match(element("toast").textContent, /整数/);
edit("1");
assert.equal(times(state.root), 1);
edit("100");
assert.equal(times(state.root), 100);
edit("101");
assert.equal(times(state.root), 100);

edit("3");
const firstSave = save();
edit("4");
saves[0].resolve();
assert.equal(await firstSave, false);
assert.equal(times(saves[0].program.root), 3);
assert.equal(times(state.savedSnapshot), 3);
assert.equal(times(state.root), 4);
assert.equal(state.dirty, true);

const olderSave = save();
edit("5");
const newerSave = save();
saves[2].resolve();
assert.equal(await newerSave, true);
saves[1].resolve();
await olderSave;
assert.equal(times(state.savedSnapshot), 5);
assert.equal(state.dirty, false);

edit("6");
const retry = element("startup-retry");
const dialog = element("confirm-dialog");
startup = { ...startup, status: "ready", contentVersion: newVersion };
course = { ...course, contentVersion: newVersion, course: { title: "更新后的课程" } };
courseUnavailable = true;
await retry.click();
assert.equal(state.contentVersion, initialVersion);
assert.equal(times(state.root), 6);
assert.equal(state.dirty, true);
assert.equal(retry.hidden, false);
assert.equal(retry.disabled, false);

courseUnavailable = false;
const cancelledRefresh = retry.click();
await setImmediate();
assert.equal(dialog.open, true);
const requestsWhilePrompting = courseRequests;
await retry.click();
assert.equal(courseRequests, requestsWhilePrompting);
dialog.closeWith("cancel");
await cancelledRefresh;
assert.equal(state.contentVersion, initialVersion);
assert.equal(times(state.root), 6);
assert.equal(retry.hidden, false);

const refreshAfterSave = retry.click();
await setImmediate();
dialog.closeWith("save");
await setImmediate();
edit("7");
saves[3].resolve();
await refreshAfterSave;
assert.equal(state.contentVersion, initialVersion);
assert.equal(times(state.root), 7);
assert.equal(times(state.savedSnapshot), 6);
assert.equal(state.dirty, true);

const successfulRefresh = retry.click();
await setImmediate();
dialog.closeWith("discard");
await successfulRefresh;
assert.equal(state.contentVersion, newVersion);
assert.equal(state.course.course.title, "更新后的课程");
assert.equal(state.dirty, false);
assert.equal(state.root, null);
assert.equal(retry.hidden, true);
assert.equal(retry.disabled, false);

const makeBlock = (kind, id) => createBlock(state.blocksByKind.get(kind), id);
const savedRoot = makeBlock("event.start", "saved-start");
savedRoot.next = makeBlock("control.repeat", "saved-repeat");
savedRoot.next.body = [makeBlock("motion.move", "saved-move")];
savedRoot.next.next = makeBlock("look.say", "saved-say");
const openedProgram = { ...fixture.tasks[1].initialProgram, root: savedRoot };
API.loadProject = async (fileText) => ({ program: JSON.parse(fileText), runnable: true });
const fileInput = element("project-file");
fileInput.value = "variant.json";
fileInput.files = [{ text: async () => JSON.stringify(openedProgram) }];
fileInput.listeners.get("change")();
await setImmediate();
assert.equal(state.activeTaskId, "variant");
assert.deepEqual(state.root, openedProgram.root);
assert.equal(state.dirty, false);
assert.equal(fileInput.value, "");

editor.selectBlock(null);
assert.equal(editor.insertFromToolbox("text.print"), true);
const printId = state.selectedBlockId;
assert.equal(editor.insertFromToolbox("value.calc"), true);
const outerCalcId = state.selectedBlockId;
assert.equal(editor.insertFromToolbox("value.number"), true);
editor.commitFieldValue(state.selectedBlockId, "value", "2");
editor.selectBlock(outerCalcId);
assert.equal(editor.insertFromToolbox("value.calc"), true);
const innerCalcId = state.selectedBlockId;
assert.equal(editor.insertFromToolbox("value.number"), true);
editor.commitFieldValue(state.selectedBlockId, "value", "3");
editor.selectBlock(innerCalcId);
assert.equal(editor.insertFromToolbox("value.number"), true);
const finalNumberId = state.selectedBlockId;
editor.commitFieldValue(finalNumberId, "value", "4");

const outer = state.root.next.next.next.inputs.value;
assert.equal(outer.blockId, outerCalcId);
assert.equal(outer.inputs.left.inputs.value, 2);
assert.equal(outer.inputs.right.inputs.right.inputs.value, 4);
assert.ok(editor.layout.targets.some((target) => target.id === `expr:${printId}.value`));
const finalNode = editor.layout.nodes.find((node) => node.blockId === finalNumberId);
assert.equal(finalNode.parentBlockId, innerCalcId);
assert.match(element("code-preview-text").textContent, /print\(\(2 \+ \(3 \+ 4\)\)\)/);
assert.equal(editor.history.undo(), true);
assert.match(element("code-preview-text").textContent, /print\(\(2 \+ \(3 \+ 1\)\)\)/);
assert.equal(editor.history.redo(), true);
assert.match(element("code-preview-text").textContent, /print\(\(2 \+ \(3 \+ 4\)\)\)/);

const beforeDelete = JSON.stringify(state.root);
const loopId = state.root.next.blockId;
assert.equal(editor.deleteBlock(loopId), true);
assert.equal(state.root.next.kind, "look.say");
assert.equal(state.root.next.next.blockId, printId);
assert.equal(editor.history.undo(), true);
assert.equal(JSON.stringify(state.root), beforeDelete);

const setControl = (control, value) => {
  control.input.value = String(value);
  control.input.listeners.get("change")();
};
const stepControl = (control, key) => control.input.listeners.get("keydown")({ key, preventDefault: noOp });
const repeatControl = editor.fieldControls.get(loopId, "times");
const beforeIncrement = state.root.next.inputs.times;
assert.equal(repeatControl.element.children.length, 1);
stepControl(repeatControl, "ArrowUp");
assert.equal(state.root.next.inputs.times, beforeIncrement + 1);
stepControl(repeatControl, "ArrowDown");
assert.equal(state.root.next.inputs.times, beforeIncrement);

const timesTarget = editor.layout.targets.find((target) => target.id === `expr:${loopId}.times`);
const targetPoint = { x: timesTarget.rect.x + timesTarget.rect.w / 2, y: timesTarget.rect.y + timesTarget.rect.h / 2 };
const numberPreview = editor.dnd.buildPreview(targetPoint, {
  kind: "value.number",
  definition: state.blocksByKind.get("value.number"),
});
assert.equal(numberPreview.target.id, timesTarget.id);
const calculatorPreview = editor.dnd.buildPreview(targetPoint, {
  kind: "value.calc",
  definition: state.blocksByKind.get("value.calc"),
});
assert.equal(calculatorPreview.valid, false);
assert.equal(editor.commitDrop(null, "value.number", numberPreview), true);
const countId = state.selectedBlockId;
assert.equal(state.root.next.inputs.times.blockId, countId);
assert.equal(editor.layout.nodes.find((node) => node.blockId === countId).parentBlockId, loopId);
const countControl = editor.fieldControls.get(countId, "value");
assert.equal(editor.fieldControls.get(loopId, "times"), undefined);
assert.equal(countControl.input.step, "1");
stepControl(countControl, "ArrowUp");
assert.equal(state.root.next.inputs.times.inputs.value, 2);
setControl(countControl, 3);
setControl(countControl, 3.5);
setControl(countControl, 101);
assert.equal(countControl.input.value, "3");
assert.equal(state.root.next.inputs.times.inputs.value, 3);
assert.match(element("code-preview-text").textContent, /range\(3\)/);
assert.equal(editor.commitDrop(countId, "value.number", { valid: true, freePosition: { x: 400, y: 40 } }), true);
assert.equal(state.root[0].root.next.inputs.times, 4);
assert.equal(state.root[1].root.inputs.value, 3);
assert.equal(editor.history.undo(), true);
assert.equal(state.root.next.inputs.times.blockId, countId);
assert.equal(editor.deleteBlock(countId), true);
assert.equal(state.root.next.inputs.times, 4);

const moveId = state.root.next.body[0].blockId;
assert.equal(editor.fieldControls.get(moveId, "steps"), undefined);
assert.equal(editor.layout.targets.some((target) => target.id === `expr:${moveId}.steps`), false);
assert.deepEqual(state.root.next.body[0].inputs, {});
assert.match(element("code-preview-text").textContent, /stage\.move\(1\)/);

editor.selectBlock(moveId);
assert.equal(editor.insertFromToolbox("motion.turn"), true);
const turnId = state.selectedBlockId;
const angleControl = editor.fieldControls.get(turnId, "degrees");
assert.deepEqual(angleControl.input.children.map((option) => option.textContent), ["90°", "180°", "270°"]);
setControl(angleControl, 180);
const angleTarget = editor.layout.targets.find((target) => target.id === `expr:${turnId}.degrees`);
const anglePoint = { x: angleTarget.rect.x + angleTarget.rect.w / 2, y: angleTarget.rect.y + angleTarget.rect.h / 2 };
const anglePreview = editor.dnd.buildPreview(anglePoint, {
  kind: "value.number",
  definition: state.blocksByKind.get("value.number"),
});
assert.equal(anglePreview.valid, true);
assert.equal(anglePreview.numberValue, 180);
assert.equal(editor.commitDrop(null, "value.number", anglePreview), true);
const angleId = state.selectedBlockId;
assert.match(element("code-preview-text").textContent, /stage\.turn\(180\)/);
editor.commitFieldValue(angleId, "value", "91");
assert.match(element("code-preview-text").textContent, /stage\.turn\(180\)/);
setControl(editor.fieldControls.get(angleId, "value"), 270);
assert.match(element("code-preview-text").textContent, /stage\.turn\(270\)/);
assert.equal(editor.deleteBlock(angleId), true);
assert.match(element("code-preview-text").textContent, /stage\.turn\(90\)/);

editor.selectBlock(loopId);
assert.equal(editor.insertFromToolbox("control.if"), true);
const ifId = state.selectedBlockId;
const operatorControl = editor.fieldControls.get(ifId, "operator");
const thresholdControl = editor.fieldControls.get(ifId, "threshold");
assert.deepEqual(operatorControl.input.children.map((option) => option.textContent), ["至少", "等于", "少于"]);
assert.equal(operatorControl.caption.textContent, "≥");
setControl(operatorControl, "<");
setControl(thresholdControl, 4);
assert.match(element("code-preview-text").textContent, /if stage\.steps < 4/);

let acceptReset = false;
window.confirm = () => acceptReset;
const rootBeforeReset = state.root;
await element("reset-button").click();
assert.equal(state.root, rootBeforeReset);
acceptReset = true;
await element("reset-button").click();
assert.equal(state.root, null);
assert.equal(element("canvas-empty").hidden, false);

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  };
}

window.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();
const student = "student-11111111111111111111111111111111";
API.students = async () => ({ students: [{ studentId: student, displayName: "小林" }] });
startup = { ...startup, tutorChatEnabled: true };
state.activeTaskId = "main";
await import("../frontend/js/main.js?classroom-drafts");
await setImmediate();
const guest = state.studentId;
assert.match(guest, /^guest-/);

const selectTask = (taskId) => element("task-list-panel").children
  .find((card) => card.firstChild?.textContent === state.tasks.get(taskId).title).children.at(-1).click();
const selectStudent = (value) => {
  const select = element("student-select");
  select.value = value;
  return select.listeners.get("change")();
};
let currentEditor = window.__cmkEditor;
assert.equal(currentEditor.insertFromToolbox("event.start"), true);
assert.equal(currentEditor.insertFromToolbox("motion.move"), true);
const guestMain = structuredClone(state.root);
assert.equal(element("save-state").textContent, "草稿已自动保存");
assert.equal(await selectTask("variant"), true);
assert.equal(state.root, null);
assert.equal(await selectTask("main"), true);
assert.deepEqual(state.root, guestMain);

await selectStudent(student);
assert.equal(state.studentId, student);
assert.equal(state.root, null);
assert.equal(await selectTask("variant"), true);
assert.equal(currentEditor.commitDrop(null, "event.start", { valid: true, freePosition: { x: 120, y: 70 } }), true);
assert.equal(currentEditor.insertFromToolbox("motion.move"), true);
const studentVariant = structuredClone(state.root);

globalThis.sessionStorage = memoryStorage();
state.activeTaskId = "main";
state.root = null;
await import("../frontend/js/main.js?classroom-reopened");
await setImmediate();
assert.equal(state.studentId, student);
assert.equal(state.activeTaskId, "variant");
assert.deepEqual(state.root, studentVariant);
assert.equal(state.dirty, false);
assert.equal(element("save-state").textContent, "草稿已自动保存");
currentEditor = window.__cmkEditor;

await selectStudent("");
assert.match(state.studentId, /^guest-/);
assert.notEqual(state.studentId, guest);
assert.equal(state.activeTaskId, "main");
assert.deepEqual(state.root, guestMain);
await selectStudent(student);
assert.equal(state.activeTaskId, "variant");
assert.deepEqual(state.root, studentVariant);

acceptReset = false;
await element("reset-button").click();
assert.deepEqual(state.root, studentVariant);
acceptReset = true;
await element("reset-button").click();
assert.equal(state.root, null);
assert.equal(readClassroomDraft(student, state.tasks.get("variant")), null);
assert.deepEqual(readClassroomDraft(guest, state.tasks.get("main")).root, guestMain);

const writeDraft = window.localStorage.setItem;
window.localStorage.setItem = () => { throw new Error("storage unavailable"); };
assert.equal(currentEditor.insertFromToolbox("event.start"), true);
assert.match(element("save-state").textContent, /自动保存失败/);
window.localStorage.setItem = writeDraft;

assert.equal(currentEditor.insertFromToolbox("control.else"), false);
assert.equal(currentEditor.insertFromToolbox("control.if"), true);
const conditionId = state.selectedBlockId;
currentEditor.commitFieldValue(conditionId, "threshold", "2");
currentEditor.commitFieldValue(conditionId, "operator", "<");
assert.equal(currentEditor.insertFromToolbox("motion.move"), true);
currentEditor.selectBlock(conditionId);
assert.equal(currentEditor.insertFromToolbox("control.else"), true);
assert.equal(currentEditor.insertFromToolbox("motion.turn"), true);
const condition = state.root.next;
assert.deepEqual(condition.inputs, { operator: "<", threshold: 2 });
assert.equal(condition.body[0].kind, "motion.move");
assert.equal(condition.next.kind, "control.else");
assert.equal(condition.next.body[0].kind, "motion.turn");
assert.match(element("code-preview-text").textContent, /if stage\.steps < 2:\n    stage\.move\(1\)\nelse:\n    stage\.turn\(90\)/);
currentEditor.selectBlock(conditionId);
assert.equal(currentEditor.insertFromToolbox("control.else"), false);

console.log("JS-PROJECT-COURSE-CHECK PASSED");
