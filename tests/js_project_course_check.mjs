/** 通过应用入口验证保存、课程更新和重复次数编辑。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { API } from "../frontend/js/api.js";

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
globalThis.window = { setTimeout: noOp, clearTimeout: noOp, addEventListener: noOp };

const schema = JSON.parse(readFileSync(new URL("../schemas/blocks.v1.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("../content/demo-loop/course.json", import.meta.url), "utf8"));
const initialVersion = fixture.contentVersion;
const newVersion = "1.3.0";
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

const repeatId = state.root.next.blockId;
const edit = (value) => editor.commitFieldValue(repeatId, "times", value);
const times = (root) => root.next.inputs.times;
const save = () => element("save-project").click();

edit("2.5");
assert.equal(times(state.root), 2);
assert.equal(state.dirty, false);
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
assert.equal(times(state.root), 2);
assert.equal(retry.hidden, true);
assert.equal(retry.disabled, false);

const openedProgram = fixture.tasks[1].initialProgram;
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

const repeatControl = editor.numberControls.controls.get(loopId);
const beforeIncrement = state.root.next.inputs.times;
repeatControl.increase.click();
assert.equal(state.root.next.inputs.times, beforeIncrement + 1);
repeatControl.decrease.click();
assert.equal(state.root.next.inputs.times, beforeIncrement);

const timesTarget = editor.layout.targets.find((target) => target.id === `expr:${loopId}.times`);
const targetPoint = { x: timesTarget.rect.x + 55, y: timesTarget.rect.y + timesTarget.rect.h / 2 };
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
const countControl = editor.numberControls.controls.get(countId);
assert.equal(editor.numberControls.controls.has(loopId), false);
assert.equal(countControl.input.step, "1");
countControl.increase.click();
assert.equal(state.root.next.inputs.times.inputs.value, 2);
const typeCount = (value) => {
  countControl.input.value = value;
  countControl.input.listeners.get("change")();
};
typeCount("3");
typeCount("3.5");
typeCount("101");
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
assert.equal(editor.numberControls.controls.has(moveId), true);
editor.selectBlock(moveId);
assert.equal(editor.insertFromToolbox("value.number"), true);
const stepsId = state.selectedBlockId;
editor.numberControls.controls.get(stepsId).increase.click();
editor.commitFieldValue(stepsId, "value", "2.5");
assert.equal(state.root.next.body[0].inputs.steps.inputs.value, 2);
assert.match(element("code-preview-text").textContent, /stage\.move\(2\)/);

editor.selectBlock(moveId);
assert.equal(editor.insertFromToolbox("motion.turn"), true);
const turnId = state.selectedBlockId;
editor.numberControls.controls.get(turnId).increase.click();
const angleTarget = editor.layout.targets.find((target) => target.id === `expr:${turnId}.degrees`);
const anglePoint = { x: angleTarget.rect.x + 70, y: angleTarget.rect.y + angleTarget.rect.h / 2 };
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
editor.numberControls.controls.get(angleId).increase.click();
assert.match(element("code-preview-text").textContent, /stage\.turn\(270\)/);
assert.equal(editor.deleteBlock(angleId), true);
assert.match(element("code-preview-text").textContent, /stage\.turn\(90\)/);

console.log("JS-PROJECT-COURSE-CHECK PASSED");
