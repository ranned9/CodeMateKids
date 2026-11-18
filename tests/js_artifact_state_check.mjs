/** RG-04：载入作品时派生状态复位与只读分支。 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this.style = {};
    this.hidden = false;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asUrl = (relative) => pathToFileURL(path.join(root, relative)).href;
const artifact = await import(asUrl("frontend/js/views/artifact.js"));

const dom = {
  "prediction-compare": new FakeElement(),
  "live-output": new FakeElement(),
  "object-meta": new FakeElement(),
  "stage-actor": new FakeElement(),
  "result-content": new FakeElement(),
  "canvas-title": new FakeElement(),
};
dom["prediction-compare"].hidden = false;
dom["live-output"].hidden = false;
dom["live-output"].textContent = "旧输出";

const state = {
  activeTaskId: "main",
  root: null,
  lastResult: { status: "completed" },
  lastRunStatus: "completed",
  errorBlockId: "b-1",
  runningBlockId: "b-2",
  highestHint: 3,
  phase: "result",
  selectedBlockId: "b-3",
  dirty: true,
  savedSnapshot: { old: true },
  runRecovery: "x",
  readonlyReason: "y",
  tasks: new Map([
    ["main", { taskId: "main", enterable: true, initialProgram: { root: { blockId: "b-task", kind: "event.start" } } }],
    ["variant", { taskId: "variant", enterable: true, initialProgram: { root: null } }],
  ]),
};

artifact.resetDerivedState(state, dom);
assert.equal(state.lastResult, null);
assert.equal(state.lastRunStatus, null);
assert.equal(state.errorBlockId, null);
assert.equal(state.runningBlockId, null);
assert.equal(state.highestHint, 0);
assert.equal(state.phase, "editing");
assert.equal(state.selectedBlockId, null);
assert.equal(state.dirty, false);
assert.equal(state.runRecovery, null);
assert.equal(dom["prediction-compare"].hidden, true);
assert.equal(dom["live-output"].hidden, true);
assert.equal(dom["live-output"].textContent, "");
assert.equal(dom["object-meta"].textContent, "角色还没有动过。");
assert.equal(dom["stage-actor"].style.left, "8px");
assert.equal(dom["result-content"].children.length, 1);

let editorProgram = null;
const editor = {
  setProgram: (program) => {
    editorProgram = program;
  },
};
let renderCalls = 0;
const runner = { updateControls: () => {} };

const descriptor = {
  source: "task",
  taskId: "main",
  root: { blockId: "b-task", kind: "event.start", inputs: {}, body: [], next: null },
  readonly: false,
};
artifact.applyArtifact({
  state,
  descriptor,
  dom,
  editor,
  renderAll: () => {
    renderCalls += 1;
  },
  runner,
});
assert.equal(state.activeTaskId, "main");
assert.equal(state.readonly, false);
assert.equal(state.dirty, false);
assert.notEqual(state.savedSnapshot, state.root, "保存快照必须是副本");
assert.equal(editorProgram, state.root);
assert.equal(renderCalls, 1);
assert.equal(dom["canvas-title"].textContent, "积木画布");

artifact.applyArtifact({
  state,
  descriptor: {
    source: "project",
    taskId: "",
    root: { blockId: "b-project", kind: "future.block", inputs: {}, body: [], next: null, unknown: true },
    readonly: true,
    readonlyReason: "这个作品对应的任务不在本机",
  },
  dom,
  editor,
  renderAll: () => {},
  runner,
});
assert.equal(state.readonly, true);
assert.equal(state.activeTaskId, "__artifact__");
assert.equal(state.artifactTaskId, null);
assert.equal(state.readonlyReason, "这个作品对应的任务不在本机");
assert.equal(dom["canvas-title"].textContent, "打开的作品");

const beforeCancelProgram = editorProgram;
assert.equal(beforeCancelProgram.blockId, "b-project");

console.log("JS-ARTIFACT-STATE-CHECK PASSED");