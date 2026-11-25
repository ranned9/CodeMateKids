/** 前端编辑内核的 Node 断言：模型、端口、布局与撤销。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");

const schema = JSON.parse(readFileSync(path.join(rootDir, "schemas", "blocks.v1.json"), "utf-8"));
const definitions = new Map(schema.blocks.map((block) => [block.kind, block]));
globalThis.window = { __cmkState: { blocksByKind: definitions } };

const asUrl = (relative) => pathToFileURL(path.join(rootDir, relative)).href;
const model = await import(asUrl("frontend/js/editor/model.js"));
const connector = await import(asUrl("frontend/js/editor/connector.js"));
const layoutModule = await import(asUrl("frontend/js/editor/layout.js"));
const targetsModule = await import(asUrl("frontend/js/editor/targets.js"));
const dndModule = await import(asUrl("frontend/js/editor/dnd.js"));
const renderModule = await import(asUrl("frontend/js/editor/render.js"));
const { createDragOverlay, LIFT_MS, SETTLE_MS } = await import(asUrl("frontend/js/editor/drag-overlay.js"));
const { planWorkspaceDrop } = await import(asUrl("frontend/js/editor/workspace.js"));
const undoModule = await import(asUrl("frontend/js/editor/undo.js"));
const { EditorView } = await import(asUrl("frontend/js/views/canvas.js"));

const start = model.createBlock(definitions.get("event.start"));
const repeat = model.createBlock(definitions.get("control.repeat"));
const move = model.createBlock(definitions.get("motion.move"));
const print = model.createBlock(definitions.get("text.print"));
const number = model.createBlock(definitions.get("value.number"));

let root = start;
let result = model.applyDrop(root, {
  kind: "control.repeat",
  slot: { type: "next", ownerId: root.blockId },
  definition: definitions.get("control.repeat"),
});
assert.equal(result.ok, true);
root = result.root;
assert.equal(root.next.kind, "control.repeat");

const repeatId = root.next.blockId;
result = model.applyDrop(root, {
  kind: "motion.move",
  slot: { type: "body", ownerId: repeatId },
  definition: definitions.get("motion.move"),
});
assert.equal(result.ok, true);
root = result.root;
assert.equal(root.next.body.length, 1);
assert.equal(root.next.body[0].kind, "motion.move");

result = model.applyDrop(root, {
  kind: "text.print",
  slot: { type: "next", ownerId: repeatId },
  definition: definitions.get("text.print"),
});
root = result.root;
const printId = root.next.next.blockId;
assert.equal(root.next.next.kind, "text.print");

result = model.applyDrop(root, {
  kind: "value.number",
  slot: { type: "slot", ownerId: printId, field: "value" },
  definition: definitions.get("value.number"),
});
root = result.root;
assert.equal(root.next.next.inputs.value.kind, "value.number");

const expressionIntoBody = connector.canConnect(schema, definitions.get("value.number"), "statement-body");
assert.equal(expressionIntoBody.ok, false);
assert.equal(expressionIntoBody.reason, "NEEDS_ACTION");
assert.equal(expressionIntoBody.message, "这里需要的是动作积木");

const statementIntoValue = connector.canConnect(schema, definitions.get("motion.move"), "expression");
assert.equal(statementIntoValue.ok, false);
assert.equal(statementIntoValue.reason, "NEEDS_VALUE");

const validStatement = connector.canConnect(schema, definitions.get("motion.move"), "statement-next");
assert.equal(validStatement.ok, true);

const layout = layoutModule.computeLayout(root, definitions);
assert.ok(layout.blocks.length >= 3);
assert.ok(layout.slots.some((slot) => slot.type === "body" && slot.ownerId === repeatId));
assert.ok(layout.slots.some((slot) => slot.type === "slot" && slot.ownerId === printId));

const validation = model.validateTree(root, definitions);
assert.equal(validation.ok, true);

const snapshot = model.cloneTree(root);
const history = new undoModule.History({
  snapshot: () => model.cloneTree(root),
  restore: (value) => {
    root = value;
  },
});
const before = model.cloneTree(root);
const detached = model.removeBlock(root, repeatId);
root = detached.root;
history.record("delete", before, model.cloneTree(root));
assert.equal(root.next.kind, "text.print");
assert.equal(history.canUndo(), true);
const deletion = history.latestTransactionId();
const afterDeletion = model.cloneTree(root);
root.next.inputs.text = "删除后又改了这句";
history.record("edit_input", afterDeletion, model.cloneTree(root));
assert.equal(history.undo(deletion), false, "撤销删除不可误撤后续编辑");
assert.equal(root.next.inputs.text, "删除后又改了这句");
assert.equal(history.undo(), true);
assert.equal(history.undo(deletion), true);
assert.equal(root.next.kind, "control.repeat");
history.redo();
assert.equal(root.next.kind, "text.print");

const moved = model.applyDrop(snapshot, {
  blockId: history.onRestore.snapshot().blockId,
  kind: "event.start",
  slot: { type: "root" },
  definition: definitions.get("event.start"),
});
assert.equal(moved.ok, true);

const richRoot = snapshot;
const richMoveId = richRoot.next.body[0].blockId;
const richLayout = layoutModule.computeLayout(richRoot, definitions);
assert.ok(Array.isArray(richLayout.nodes));
assert.ok(Array.isArray(richLayout.drawOrder));
assert.ok(Array.isArray(richLayout.targets));
assert.equal(typeof richLayout.sections, "object");
assert.equal(new Set(richLayout.nodes.map((node) => node.blockId)).size, richLayout.nodes.length);
const blockLayerCount = richLayout.drawOrder.filter((item) => item.layer === "block").length;
assert.equal(blockLayerCount, richLayout.nodes.length);
assert.equal(
  richLayout.drawOrder.filter((item) => item.layer === "shell").length,
  richLayout.nodes.filter((node) => node.isContainer).length,
);
for (const node of richLayout.nodes) {
  if (!node.isContainer) {
    continue;
  }
  const section = richLayout.sections[node.blockId];
  assert.ok(section.header.y + section.header.h <= section.bodyBox.y);
  assert.ok(section.bodyBox.y + section.bodyBox.h <= section.foot.y);
  const children = richLayout.nodes.filter((child) => child.ownerId === node.blockId);
  for (const child of children) {
    assert.ok(child.rect.x >= section.bodyBox.x);
    assert.ok(child.rect.x + child.rect.w <= section.bodyBox.x + section.bodyBox.w);
    assert.ok(child.rect.y >= section.bodyBox.y);
    assert.ok(child.rect.y + child.rect.h <= section.bodyBox.y + section.bodyBox.h);
  }
}

const repeatLayoutNode = richLayout.nodes.find((node) => node.blockId === repeatId);
const moveLayoutNode = richLayout.nodes.find((node) => node.blockId === richMoveId);
const repeatHeader = richLayout.sections[repeatId].header;
const timesRect = repeatLayoutNode.fields[0].rect;
assert.ok(timesRect.y >= repeatHeader.y && timesRect.y + timesRect.h <= repeatHeader.y + repeatHeader.h);
assert.ok(moveLayoutNode.rect.w < repeatLayoutNode.rect.w);
assert.equal(
  layoutModule.pickNode(richLayout, {
    x: moveLayoutNode.rect.x + 10,
    y: moveLayoutNode.rect.y + 10,
  }).blockId,
  richMoveId,
);
assert.equal(
  layoutModule.pickNode(richLayout, {
    x: repeatLayoutNode.rect.x + 20,
    y: repeatLayoutNode.rect.y + 18,
  }).blockId,
  repeatId,
);

const outerStart = model.createBlock(definitions.get("event.start"));
const outerRepeat = model.createBlock(definitions.get("control.repeat"));
const innerRepeat = model.createBlock(definitions.get("control.repeat"));
const innerMove = model.createBlock(definitions.get("motion.move"));
innerRepeat.body = [innerMove];
outerRepeat.body = [innerRepeat];
outerStart.next = outerRepeat;
const nestedLayout = layoutModule.computeLayout(outerStart, definitions);
const outerNode = nestedLayout.nodes.find((node) => node.blockId === outerRepeat.blockId);
const innerNode = nestedLayout.nodes.find((node) => node.blockId === innerRepeat.blockId);
const innerMoveNode = nestedLayout.nodes.find((node) => node.blockId === innerMove.blockId);
assert.equal(
  layoutModule.pickNode(nestedLayout, { x: outerNode.rect.x + 20, y: outerNode.rect.y + 18 }).blockId,
  outerRepeat.blockId,
);
assert.equal(
  layoutModule.pickNode(nestedLayout, { x: innerNode.rect.x + 20, y: innerNode.rect.y + 18 }).blockId,
  innerRepeat.blockId,
);
assert.equal(
  layoutModule.pickNode(nestedLayout, { x: innerMoveNode.rect.x + 10, y: innerMoveNode.rect.y + 10 }).blockId,
  innerMove.blockId,
);

const emptyModel = targetsModule.emptyLayoutModel();
assert.equal(emptyModel.targets.length, 1);
assert.equal(emptyModel.targets[0].id, "root@start");
for (const target of richLayout.targets) {
  for (const key of ["x", "y", "w", "h"]) {
    assert.equal(Number.isFinite(target.rect[key]), true, `${target.id}.${key}`);
  }
}
assert.ok(richLayout.targets.some((target) => target.id === "root@start"));
assert.ok(richLayout.targets.some((target) => target.id === `root@after:${root.blockId}`));
assert.ok(richLayout.targets.some((target) => target.id === `body:${repeatId}@start`));
assert.ok(richLayout.targets.some((target) => target.id === `body:${repeatId}@after:${richMoveId}`));

const afterRepeat = targetsModule.resolveDropTarget(richLayout, {
  x: moveLayoutNode.rect.x + 20,
  y: repeatLayoutNode.rect.y + repeatLayoutNode.rect.h + 4,
}, { definition: definitions.get("motion.move"), schema });
assert.equal(afterRepeat.target.id, `root@after:${repeatId}`);

assert.deepEqual(targetsModule.normalizeTargetId("root@start"), {
  containerRef: "root",
  anchorRef: "start",
  portType: "statement-next",
});
assert.equal(targetsModule.normalizeTargetId(`body:${repeatId}@after:${richMoveId}`).portType, "statement-body");
assert.equal(targetsModule.normalizeTargetId("expr:b-1.value").portType, "expression");
assert.equal(targetsModule.normalizeTargetId(""), null);
assert.equal(targetsModule.normalizeTargetId("root@before:b-1"), null);
assert.equal(targetsModule.normalizeTargetId("root@end"), null);
assert.equal(targetsModule.normalizeTargetId("nope@start"), null);

const moveDefinition = definitions.get("motion.move");
const numberDefinition = definitions.get("value.number");
const viewport = { w: 720, h: 460, scrollY: 0 };
const bodyStartTarget = richLayout.targets.find((target) => target.id === `body:${repeatId}@start`);
const bodyPoint = { x: bodyStartTarget.rect.x + 4, y: bodyStartTarget.rect.y + 4 };
const legal = targetsModule.resolveDropTarget(richLayout, bodyPoint, {
  definition: moveDefinition,
  schema,
  movingBlockId: null,
  viewport,
});
assert.equal(legal.valid, true);
assert.equal(legal.portType, "statement-body");
const needsAction = targetsModule.resolveDropTarget(richLayout, bodyPoint, {
  definition: numberDefinition,
  schema,
  movingBlockId: null,
  viewport,
});
assert.equal(needsAction.valid, false);
assert.equal(needsAction.reason, "NEEDS_ACTION");
const selfNest = targetsModule.resolveDropTarget(richLayout, bodyPoint, {
  definition: moveDefinition,
  schema,
  movingBlockId: repeatId,
  viewport,
});
assert.equal(selfNest.valid, false);
assert.equal(selfNest.reason, "SELF_NEST");
assert.equal(
  targetsModule.resolveDropTarget(richLayout, { x: -5, y: 10 }, { definition: moveDefinition, schema, viewport }).reason,
  "OUTSIDE_CANVAS",
);
assert.equal(
  targetsModule.resolveDropTarget(richLayout, { x: 690, y: 440 }, { definition: moveDefinition, schema, viewport }).reason,
  "NO_TARGET",
);

const failedPlan = model.planDrop(richRoot, {
  kind: "motion.move",
  definition: moveDefinition,
  targetId: "expr:missing.value",
});
assert.equal(failedPlan.ok, false);
assert.equal(failedPlan.root, richRoot);
const selfPlan = model.planDrop(richRoot, {
  blockId: repeatId,
  kind: "control.repeat",
  definition: definitions.get("control.repeat"),
  targetId: `body:${repeatId}@start`,
});
assert.equal(selfPlan.ok, false);
assert.equal(selfPlan.root, richRoot);

const bodyRoot = model.createBlock(definitions.get("event.start"));
const bodyRepeat = model.createBlock(definitions.get("control.repeat"));
const firstChild = model.createBlock(definitions.get("motion.move"));
const lastChild = model.createBlock(definitions.get("motion.turn"));
firstChild.next = lastChild;
bodyRepeat.body = [firstChild];
bodyRoot.next = bodyRepeat;
const insertPlan = model.planDrop(bodyRoot, {
  kind: "motion.move",
  definition: moveDefinition,
  targetId: `body:${bodyRepeat.blockId}@after:${firstChild.blockId}`,
});
assert.equal(insertPlan.ok, true);
const insertedChain = insertPlan.root.next.body[0];
assert.equal(insertedChain.blockId, firstChild.blockId);
assert.equal(insertedChain.next.blockId, insertPlan.node.blockId);
assert.equal(insertedChain.next.next.blockId, lastChild.blockId);
const movePlan = model.planDrop(insertPlan.root, {
  blockId: lastChild.blockId,
  kind: "motion.turn",
  definition: definitions.get("motion.turn"),
  targetId: `root@after:${bodyRoot.blockId}`,
});
assert.equal(movePlan.ok, true);
assert.equal(movePlan.root.next.blockId, lastChild.blockId);
assert.equal(model.countNodes(movePlan.root), model.countNodes(insertPlan.root));

// 已有作品可能在同一个循环体内保存多条语句链。
const multiBodyRoot = model.cloneTree(bodyRoot);
const secondHead = model.createBlock(definitions.get("look.say"));
secondHead.inputs.text = "第二条链";
multiBodyRoot.next.body.push(secondHead);
const multiBodyLayout = layoutModule.computeLayout(multiBodyRoot, definitions);
const childIds = multiBodyLayout.nodes
  .filter((node) => node.ownerId === bodyRepeat.blockId)
  .map((node) => node.blockId);
assert.deepEqual(childIds, [firstChild.blockId, lastChild.blockId, secondHead.blockId]);
const secondTarget = `body:${bodyRepeat.blockId}@after:${secondHead.blockId}`;
assert.ok(multiBodyLayout.targets.some((target) => target.id === secondTarget));
assert.equal(model.isTargetAlive(multiBodyRoot, secondTarget), true);
const multiInsert = model.planDrop(multiBodyRoot, {
  kind: "motion.move",
  definition: moveDefinition,
  targetId: secondTarget,
});
assert.equal(multiInsert.ok, true);
assert.equal(multiInsert.root.next.body[1].next.blockId, multiInsert.node.blockId);
const multiMove = model.planDrop(multiBodyRoot, {
  blockId: secondHead.blockId,
  kind: "look.say",
  targetId: `body:${bodyRepeat.blockId}@start`,
});
assert.equal(multiMove.ok, true);
assert.equal(multiMove.root.next.body[0].blockId, secondHead.blockId);
assert.equal(multiMove.root.next.body[0].next.blockId, firstChild.blockId);
const preview = { textContent: "" };
EditorView.prototype.refresh.call({
  state: { root: multiBodyRoot, blocksByKind: definitions },
  code: preview,
  measure() {},
  render() {},
});
const firstChainEnd = preview.textContent.indexOf("    stage.turn(");
assert.ok(firstChainEnd >= 0);
assert.ok(preview.textContent.indexOf('    stage.say("第二条链")') > firstChainEnd);

assert.equal(JSON.stringify(richRoot).includes("fieldName"), false);
assert.equal(targetsModule.hasPlaceableTarget(emptyModel, numberDefinition, schema), false);
assert.equal(targetsModule.hasPlaceableTarget(emptyModel, moveDefinition, schema), true);
assert.equal(model.buildProgram(richRoot, { taskId: "main" }).courseRef.version, 1);
assert.deepEqual(model.buildProgram(richRoot, {
  taskId: "exercise",
  initialProgram: { courseRef: { courseId: "sample-course", version: 2 } },
}).courseRef, { courseId: "sample-course", taskId: "exercise", version: 2 });
assert.equal(
  model.buildProgram(richRoot, { taskId: "main" }, "demo-loop", { courseVersion: 2 }).courseRef.version,
  2,
);

assert.equal(dndModule.exceedsThreshold({ x: 0, y: 0 }, { x: 3, y: 4 }, 6), false);
assert.equal(dndModule.exceedsThreshold({ x: 0, y: 0 }, { x: 6, y: 1 }, 6), true);

function makeSource(name) {
  const record = { name, adds: 0, removes: 0, captures: 0, releases: 0, classes: new Set() };
  return {
    record,
    addEventListener: (type) => {
      if (type === "lostpointercapture") {
        record.adds += 1;
      }
    },
    removeEventListener: (type) => {
      if (type === "lostpointercapture") {
        record.removes += 1;
      }
    },
    setPointerCapture: () => {
      record.captures += 1;
    },
    releasePointerCapture: () => {
      record.releases += 1;
    },
    classList: {
      add: (name_) => record.classes.add(name_),
      remove: (name_) => record.classes.delete(name_),
    },
  };
}

let previewCalls = [];
let toastCalls = [];
let commitCalls = [];
let commitPreview = null;
const clickAdds = [];
let cancelFrameCount = 0;
const windowRecord = {
  adds: 0,
  removes: 0,
  addEventListener: () => {
    windowRecord.adds += 1;
  },
  removeEventListener: () => {
    windowRecord.removes += 1;
  },
};
const canvasSource = makeSource("canvas");
const toolboxChild = {};
const toolboxClasses = new Set();
const toolbox = {
  ownerDocument: {
    elementFromPoint: (x, y) => (x >= 750 && x <= 900 && y >= 40 && y <= 400 ? toolboxChild : null),
  },
  contains: (element) => element === toolboxChild,
  classList: {
    toggle: (name, active) => active ? toolboxClasses.add(name) : toolboxClasses.delete(name),
    remove: (name) => toolboxClasses.delete(name),
  },
};
const deletedBlocks = [];
const editorStub = {
  canvas: canvasSource,
  state: {
    blocksByKind: definitions,
    schema,
    root: richRoot,
    readonly: false,
    phase: "editing",
    readonlyReason: "",
  },
  layout: richLayout,
  width: 720,
  height: 460,
  scrollY: 0,
  pointFromEvent: (event) => ({ x: event.clientX, y: event.clientY }),
  setPreview: (preview) => {
    previewCalls.push(preview);
  },
  selectBlock: () => {},
  startFieldEdit: () => {},
  insertFromToolbox: (kind) => clickAdds.push(kind),
  deleteBlock: (blockId) => {
    deletedBlocks.push(blockId);
    return true;
  },
  toast: (message) => {
    toastCalls.push(message);
  },
  commitDrop: (...args) => {
    commitCalls.push(args);
    commitPreview = previewCalls[previewCalls.length - 1];
    return true;
  },
  isInsideSubtree: () => false,
  announceDrag: () => {},
};
// 0.9.0（T-EP-10）：画布预览重绘合并到 rAF——stub 记录挂起回调，由 flushFrames() 手动驱动，
// 以便断言"每帧 ≤1 次调度"与挂起帧取消语义。
const rafPending = new Map();
let rafSeq = 0;
const requestAnimationFrameStub = (callback) => {
  rafSeq += 1;
  rafPending.set(rafSeq, callback);
  return rafSeq;
};
const cancelAnimationFrameStub = (handle) => {
  cancelFrameCount += 1;
  rafPending.delete(handle);
};
const flushFrames = () => {
  const pending = [...rafPending.entries()];
  rafPending.clear();
  for (const [, callback] of pending) {
    callback();
  }
};
const dnd = new dndModule.DndController(editorStub, {
  toolbox,
  env: {
    window: windowRecord,
    requestAnimationFrame: requestAnimationFrameStub,
    cancelAnimationFrame: cancelAnimationFrameStub,
  },
});

// ===== 0.9.0 浮层测试基建（T-EP-20）：stub document/window/canvas，沿用 env 注入范式 =====
const stub2dContext = new Proxy({}, {
  get(target, prop) {
    if (prop === "measureText") {
      return () => ({ width: 24 });
    }
    if (typeof prop === "symbol") {
      return undefined;
    }
    if (!(prop in target)) {
      target[prop] = () => {};
    }
    return target[prop];
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
});

const makeStubCanvas = () => ({
  tagName: "canvas",
  width: 0,
  height: 0,
  style: {},
  children: [],
  parentNode: null,
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  },
  replaceChildren(...next) {
    for (const child of this.children) {
      child.parentNode = null;
    }
    this.children = [...next];
    for (const child of this.children) {
      child.parentNode = this;
    }
  },
  get firstChild() {
    return this.children[0] ?? null;
  },
  remove() {
    this.parentNode?.removeChild?.(this);
    this.parentNode = null;
  },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  getContext: () => stub2dContext,
});

const makeStubElement = (tag) => ({
  tagName: tag,
  className: "",
  style: {},
  children: [],
  parentNode: null,
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  },
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
    child.parentNode = null;
    return child;
  },
  replaceChildren(...next) {
    for (const child of this.children) {
      child.parentNode = null;
    }
    this.children = [...next];
    for (const child of this.children) {
      child.parentNode = this;
    }
  },
  get firstChild() {
    return this.children[0] ?? null;
  },
  remove() {
    this.parentNode?.removeChild?.(this);
    this.parentNode = null;
  },
  classList: {
    add() {},
    remove() {},
  },
});

const stubBody = {
  tagName: "BODY",
  style: {},
  children: [],
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  },
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
    child.parentNode = null;
    return child;
  },
  get firstChild() {
    return this.children[0] ?? null;
  },
  replaceChildren() {
    this.children = [];
  },
};
const stubDocument = {
  body: stubBody,
  createElement: (tag) => (tag === "canvas" ? makeStubCanvas() : makeStubElement(tag)),
};
const overlayElementCount = () => stubBody.children.length;

const makeStubWindow = () => {
  const timers = new Map();
  return {
    timers,
    addEventListener() {},
    removeEventListener() {},
    setTimeout(callback) {
      const handle = timers.size + 1;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
  };
};

const overlayRaf = { seq: 0, pending: new Map() };
const overlayRequestAnimationFrame = (callback) => {
  overlayRaf.seq += 1;
  overlayRaf.pending.set(overlayRaf.seq, callback);
  return overlayRaf.seq;
};
const overlayCancelAnimationFrame = (handle) => {
  overlayRaf.pending.delete(handle);
};

// 带浮层注入面的 DndController（EP-AC-02/03/04/05/06 断言用）。
const overlayDnd = new dndModule.DndController(editorStub, {
  toolbox,
  env: {
    window: makeStubWindow(),
    document: stubDocument,
    requestAnimationFrame: overlayRequestAnimationFrame,
    cancelAnimationFrame: overlayCancelAnimationFrame,
    matchMedia: () => ({ matches: false }),
  },
});

const toolboxSource = makeSource("toolbox-button");
dnd.startToolboxDrag("motion.move", { pointerId: 13, clientX: 20, clientY: 20 }, toolboxSource);
dnd.onMove({ pointerId: 13, clientX: 23, clientY: 24 });
assert.equal(previewCalls.length, 0);
dnd.onUp({ pointerId: 13, clientX: 23, clientY: 24 });
assert.deepEqual(clickAdds, ["motion.move"]);
assert.equal(commitCalls.length, 0);
previewCalls = [];
const capturesBefore = toolboxSource.record.captures;
const releasesBefore = toolboxSource.record.releases;
dnd.begin(
  {
    kind: "motion.move",
    blockId: null,
    definition: moveDefinition,
    origin: "toolbox",
    sourceElement: toolboxSource,
  },
  { pointerId: 7, clientX: 20, clientY: 20 },
);
assert.equal(dnd.session.pointerId, 7);
assert.equal(dnd.session.captureOk, true);
assert.equal(toolboxSource.record.captures, capturesBefore + 1);
assert.equal(toolboxSource.record.classes.has("is-grabbing"), true);
assert.equal(previewCalls.length, 0);
const lastPointBefore = { ...dnd.session.lastPoint };
dnd.onMove({ pointerId: 8, clientX: 400, clientY: 300 });
assert.deepEqual(dnd.session.lastPoint, lastPointBefore);
dnd.session.frame = 99;
dnd.teardown("cancelled");
assert.equal(dnd.session, null);
assert.equal(previewCalls[previewCalls.length - 1], null);
assert.equal(toolboxSource.record.releases, releasesBefore + 1);
assert.equal(toolboxSource.record.adds, toolboxSource.record.removes);
assert.equal(toolboxSource.record.classes.has("is-grabbing"), false);
assert.equal(windowRecord.adds, windowRecord.removes);
assert.equal(cancelFrameCount, 1);
const countsAfterTeardown = {
  windowAdds: windowRecord.adds,
  windowRemoves: windowRecord.removes,
  sourceAdds: toolboxSource.record.adds,
  sourceRemoves: toolboxSource.record.removes,
  toasts: toastCalls.length,
};
assert.doesNotThrow(() => dnd.teardown("cancelled"));
assert.deepEqual(
  {
    windowAdds: windowRecord.adds,
    windowRemoves: windowRecord.removes,
    sourceAdds: toolboxSource.record.adds,
    sourceRemoves: toolboxSource.record.removes,
    toasts: toastCalls.length,
  },
  countsAfterTeardown,
);

const dndAfterRepeatTarget = richLayout.targets.find(
  (target) => target.id === `root@after:${richRoot.next.blockId}`,
);
const dndBodyStartTarget = richLayout.targets.find((target) => target.id === `body:${repeatId}@start`);
assert.ok(dndAfterRepeatTarget);
assert.ok(dndBodyStartTarget);

for (const phase of ["result", "error"]) {
  editorStub.state.phase = phase;
  const commitCount = commitCalls.length;
  dnd.startToolboxDrag("motion.move", { pointerId: 12, clientX: 10, clientY: 10 }, toolboxSource);
  assert.equal(dnd.dragging, true);
  dnd.onUp({
    pointerId: 12,
    clientX: dndAfterRepeatTarget.rect.x + 4,
    clientY: dndAfterRepeatTarget.rect.y + 4,
  });
  assert.equal(commitCalls.length, commitCount + 1);
  assert.equal(dnd.dragging, false);
}
for (const phase of ["validating", "running", "cancelling"]) {
  editorStub.state.phase = phase;
  dnd.startToolboxDrag("motion.move", { pointerId: 12 }, toolboxSource);
  assert.equal(dnd.dragging, false);
}
editorStub.state.phase = "result";
editorStub.state.readonly = true;
dnd.startToolboxDrag("motion.move", { pointerId: 12 }, toolboxSource);
assert.equal(dnd.dragging, false);
editorStub.state.readonly = false;
editorStub.state.phase = "editing";

previewCalls = [];
commitCalls = [];
toastCalls = [];
const startPoint = { x: dndBodyStartTarget.rect.x + 4, y: dndBodyStartTarget.rect.y + 4 };
const canvasCapturesBefore = canvasSource.record.captures;
dnd.onPointerDown({ button: 0, pointerId: 14, clientX: moveLayoutNode.rect.x + 5, clientY: moveLayoutNode.rect.y + 5 });
dnd.onUp({ pointerId: 14, clientX: moveLayoutNode.rect.x + 5, clientY: moveLayoutNode.rect.y + 5 });
assert.equal(commitCalls.length, 0);
assert.equal(canvasSource.record.captures, canvasCapturesBefore + 1);
dnd.begin(
  {
    kind: "motion.move",
    blockId: richMoveId,
    definition: moveDefinition,
    origin: "canvas",
    sourceElement: canvasSource,
  },
  { pointerId: 1, clientX: startPoint.x, clientY: startPoint.y },
);
assert.equal(canvasSource.record.captures, canvasCapturesBefore + 2);
dnd.onMove({
  pointerId: 1,
  clientX: dndAfterRepeatTarget.rect.x + 4,
  clientY: dndAfterRepeatTarget.rect.y + 4,
});
flushFrames();
assert.equal(dnd.session.lastResult.target.id, dndAfterRepeatTarget.id);
dnd.onUp({ pointerId: 1, clientX: startPoint.x, clientY: startPoint.y });
assert.equal(commitCalls.length, 1);
assert.equal(commitCalls[0][2].target.id, dndBodyStartTarget.id);
assert.equal(commitPreview, commitCalls[0][2]);
assert.equal(dnd.session, null);

// 指针偏出连接位时，预览与松手提交采用同一吸附范围。
for (const target of [dndAfterRepeatTarget, dndBodyStartTarget]) {
  const point = { clientX: target.rect.x + target.rect.w + 20, clientY: target.rect.y + 2 };
  dnd.startToolboxDrag("motion.move", { pointerId: 41, clientX: -25, clientY: 10 }, toolboxSource);
  dnd.onMove({ pointerId: 41, ...point });
  flushFrames();
  assert.equal(dnd.session.lastResult.target.id, target.id);
  dnd.onUp({ pointerId: 41, ...point });
  assert.equal(commitCalls.at(-1)[2].target.id, target.id);
}

// 位于循环底边时，优先吸附到较近的外部连接位。
dnd.startToolboxDrag("motion.move", { pointerId: 42, clientX: -25, clientY: 10 }, toolboxSource);
dnd.onUp({
  pointerId: 42,
  clientX: moveLayoutNode.rect.x + 20,
  clientY: dndAfterRepeatTarget.rect.y - 2,
});
assert.equal(commitCalls.at(-1)[2].target.id, dndAfterRepeatTarget.id);

dnd.startToolboxDrag("motion.move", { pointerId: 43, clientX: -25, clientY: 10 }, toolboxSource);
dnd.onUp({
  pointerId: 43,
  clientX: dndAfterRepeatTarget.rect.x + dndAfterRepeatTarget.rect.w + 25,
  clientY: dndAfterRepeatTarget.rect.y + 2,
});
assert.equal(commitCalls.at(-1)[2].target, null);
assert.ok(commitCalls.at(-1)[2].freePosition);

commitCalls = [];
toastCalls = [];
dnd.begin(
  { kind: "motion.move", blockId: null, definition: moveDefinition, origin: "toolbox", sourceElement: toolboxSource },
  { pointerId: 2, clientX: startPoint.x, clientY: startPoint.y },
);
dnd.onUp({ pointerId: 2, clientX: -5, clientY: 10 });
assert.equal(commitCalls.length, 0);
assert.equal(toastCalls.length, 0);
assert.equal(dnd.session, null);

const originalCommit = editorStub.commitDrop;
editorStub.commitDrop = () => {
  throw new Error("boom");
};
toastCalls = [];
dnd.begin(
  { kind: "motion.move", blockId: null, definition: moveDefinition, origin: "toolbox", sourceElement: toolboxSource },
  { pointerId: 3, clientX: -25, clientY: startPoint.y },
);
assert.doesNotThrow(() => {
  dnd.onUp({ pointerId: 3, clientX: startPoint.x, clientY: startPoint.y });
});
assert.equal(dnd.session, null);
assert.equal(previewCalls[previewCalls.length - 1], null);
assert.ok(toastCalls.some((message) => message.includes("这次没有放进去")));

editorStub.commitDrop = () => false;
toastCalls = [];
dnd.begin(
  { kind: "motion.move", blockId: null, definition: moveDefinition, origin: "toolbox", sourceElement: toolboxSource },
  { pointerId: 4, clientX: -25, clientY: startPoint.y },
);
dnd.onUp({ pointerId: 4, clientX: startPoint.x, clientY: startPoint.y });
assert.equal(dnd.session, null);
assert.equal(toastCalls.length, 0);
editorStub.commitDrop = originalCommit;

const throwingSource = makeSource("toolbox-throwing");
throwingSource.setPointerCapture = () => {
  throw new Error("denied");
};
commitCalls = [];
dnd.begin(
  {
    kind: "motion.move",
    blockId: null,
    definition: moveDefinition,
    origin: "toolbox",
    sourceElement: throwingSource,
  },
  { pointerId: 5, clientX: -25, clientY: startPoint.y },
);
assert.equal(dnd.session.captureOk, false);
assert.equal(dnd.session.captureTarget, throwingSource);
dnd.onUp({ pointerId: 5, clientX: startPoint.x, clientY: startPoint.y });
assert.equal(commitCalls.length, 1);
assert.equal(throwingSource.record.releases, 0);
assert.equal(dnd.session, null);

const sourcePoint = { clientX: 200, clientY: 120 };
const toolboxPoint = { clientX: 780, clientY: 160 };
dnd.startBlockDrag(richMoveId, { pointerId: 15, ...sourcePoint });
dnd.onMove({ pointerId: 15, ...toolboxPoint });
assert.ok(toolboxClasses.has("is-remove-target"));
dnd.onUp({ pointerId: 15, clientX: 740, clientY: 160 });
assert.deepEqual(deletedBlocks, []);
assert.equal(toolboxClasses.size, 0);

dnd.startBlockDrag(richMoveId, { pointerId: 16, ...sourcePoint });
dnd.onMove({ pointerId: 16, ...sourcePoint, clientX: 300 });
dnd.onUp({ pointerId: 16, ...toolboxPoint });
assert.deepEqual(deletedBlocks, [richMoveId]);
assert.equal(toolboxClasses.size, 0);

dnd.startBlockDrag(richMoveId, { pointerId: 17, ...sourcePoint });
dnd.onMove({ pointerId: 17, ...toolboxPoint });
dnd.onCancel({ pointerId: 17 });
assert.deepEqual(deletedBlocks, [richMoveId]);
assert.equal(toolboxClasses.size, 0);

dnd.startToolboxDrag("motion.move", { pointerId: 18, ...toolboxPoint }, toolboxSource);
dnd.onMove({ pointerId: 18, ...sourcePoint });
dnd.onUp({ pointerId: 18, ...toolboxPoint });
assert.deepEqual(deletedBlocks, [richMoveId]);
assert.equal(toolboxClasses.size, 0);

assert.equal(model.isTargetAlive(richRoot, "root@start"), true);
assert.equal(model.isTargetAlive(richRoot, `root@after:${richRoot.blockId}`), true);
assert.equal(model.isTargetAlive(richRoot, "root@after:missing"), false);
assert.equal(model.isTargetAlive(richRoot, `body:${repeatId}@start`), true);
assert.equal(model.isTargetAlive(richRoot, `body:${repeatId}@after:${richMoveId}`), true);
assert.equal(model.isTargetAlive(richRoot, `body:${repeatId}@after:${printId}`), false);

const serializedRoot = JSON.stringify(richRoot);
assert.equal(serializedRoot.includes("pointerId"), false);
assert.equal(serializedRoot.includes("sourceElement"), false);
assert.equal(serializedRoot.includes("captureOk"), false);

const addToWorkspace = (workspace, kind, placement) => planWorkspaceDrop(workspace, {
  kind,
  definition: definitions.get(kind),
  ...placement,
});
const freeScript = addToWorkspace(null, "event.start", { freePosition: { x: 20, y: 35 } });
const startId = freeScript.node.blockId;
const action = addToWorkspace(freeScript.root, "motion.move", { targetId: `stack:${startId}@after:${startId}` });
const actionId = action.node.blockId;
const speaking = addToWorkspace(action.root, "look.say", { targetId: `stack:${startId}@after:${actionId}` });
const separated = addToWorkspace(speaking.root, "motion.move", { blockId: actionId, freePosition: { x: 420, y: 220 } });
assert.equal(separated.root[0].root.next, null);
assert.equal(separated.root[1].root.next.blockId, speaking.node.blockId);
assert.equal(model.runnableRoots(separated.root).length, 1);

const withDraft = addToWorkspace(separated.root, "text.print", { freePosition: { x: 80, y: 285 } });
assert.equal(model.validateTree(withDraft.root, definitions).ok, true);
const withLooseNumber = addToWorkspace(withDraft.root, "value.number", { freePosition: { x: 520, y: 55 } });
const numberId = withLooseNumber.node.blockId;
const withNumber = addToWorkspace(withLooseNumber.root, "value.number", {
  blockId: numberId,
  targetId: `expr:${withDraft.node.blockId}.value`,
});
assert.equal(withNumber.root.length, 3);
assert.equal(withNumber.root[2].root.inputs.value.blockId, numberId);

const movedStack = addToWorkspace(withNumber.root, "motion.move", { blockId: actionId, freePosition: { x: 430, y: 130 } });
assert.equal(movedStack.root[1].root.next.blockId, speaking.node.blockId);
const workspaceLayout = layoutModule.computeLayout(movedStack.root, definitions);
assert.ok(workspaceLayout.targets.some((target) => target.id === `stack:${actionId}@start`));
assert.equal(workspaceLayout.nodes.find((node) => node.blockId === actionId).rect.x, 430);
const secondScript = addToWorkspace(movedStack.root, "event.start", { targetId: `stack:${actionId}@start` });
assert.equal(model.runnableRoots(secondScript.root).length, 2);
assert.equal(secondScript.root[1].root.next.blockId, actionId);
const savedWorkspace = model.buildProgram(secondScript.root, { taskId: "main" });
assert.equal(savedWorkspace.formatVersion, 2);
assert.deepEqual(model.programWorkspace(JSON.parse(JSON.stringify(savedWorkspace))), secondScript.root);

editorStub.state.root = secondScript.root;
editorStub.layout = layoutModule.computeLayout(secondScript.root, definitions);

// ===== T-EP-19（0.9.0 D-04）：{16,16} 固定偏移断言改写为统一抓取公式断言 =====
// 正常路径：按下缩略图中心（ratio = 0.5），自由落点 = point − (ratio × 画面布局尺寸)。
const thumbnail = makeStubCanvas();
const thumbInsets = renderModule.drawToolboxBlock(thumbnail, numberDefinition);
const numberRect = layoutModule.computeLayout(
  [{ x: 0, y: 0, root: model.createBlock(numberDefinition, "drag-size") }],
  definitions,
).nodes[0].rect;
const grabCenter = {
  ratioX: 0.5,
  ratioY: 0.5,
  startWidth: thumbnail.width * (1 - 2 * thumbInsets.insetX),
  startHeight: thumbnail.height * (1 - 2 * thumbInsets.insetY),
};
const grabEdge = { ...grabCenter, ratioX: 1, ratioY: 1 };

overlayDnd.startToolboxDrag("value.number", { pointerId: 60, ...toolboxPoint }, toolboxSource, grabCenter);
assert.equal(parseFloat(stubBody.firstChild.style.width), grabCenter.startWidth);
assert.ok(grabCenter.startWidth < overlayDnd.session.targetSize.w);
assert.deepEqual(overlayDnd.session.targetSize, { w: numberRect.w, h: numberRect.h });
assert.equal(stubBody.firstChild.firstChild.width, numberRect.w);
overlayDnd.onUp({ pointerId: 60, clientX: 360, clientY: 390 });
assert.deepEqual(commitCalls.at(-1)[2].freePosition, {
  x: 360 - grabCenter.ratioX * numberRect.w,
  y: 390 - grabCenter.ratioY * numberRect.h,
});

// 边缘按住（ratio ≈ 1）：确认公式方向为减而非加。
overlayDnd.startToolboxDrag("value.number", { pointerId: 61, ...toolboxPoint }, toolboxSource, grabEdge);
overlayDnd.onUp({ pointerId: 61, clientX: 360, clientY: 390 });
assert.deepEqual(commitCalls.at(-1)[2].freePosition, {
  x: 360 - grabEdge.ratioX * numberRect.w,
  y: 390 - grabEdge.ratioY * numberRect.h,
});
assert.equal(overlayElementCount(), 0);

// 异常路径断言（stub 未提供 grabInfo 且无 document 注入）：退化 {16,16} 兜底，非正常行为。
dnd.startToolboxDrag("value.number", { pointerId: 20, ...toolboxPoint }, toolboxSource);
dnd.onUp({ pointerId: 20, clientX: 360, clientY: 390 });
assert.deepEqual(commitCalls.at(-1)[2].freePosition, { x: 344, y: 374 });

// ===== T-EP-20（EP-AC-02）：浮层生命周期 =====
// 切回 richRoot 上下文：后续画布来源用例的 blockId 与目标引用均属于 richLayout 域。
editorStub.state.root = richRoot;
editorStub.layout = richLayout;
// 创建后浮层在 body；提交替换后移除；取消清理后移除；任一路径后无残留元素。
overlayDnd.startToolboxDrag("motion.move", { pointerId: 62, clientX: 20, clientY: 20 }, toolboxSource, grabCenter);
assert.equal(overlayDnd.session.overlayPhase, "lifting");
assert.equal(overlayElementCount(), 1);
overlayDnd.onMove({ pointerId: 62, clientX: 400, clientY: 300 });
assert.equal(overlayElementCount(), 1);
overlayDnd.onUp({ pointerId: 62, clientX: startPoint.x, clientY: startPoint.y });
assert.equal(commitCalls.at(-1)[2].target.id, dndBodyStartTarget.id);
assert.equal(overlayDnd.session, null);
assert.equal(overlayElementCount(), 0);

overlayDnd.startToolboxDrag("motion.move", { pointerId: 63, clientX: 20, clientY: 20 }, toolboxSource, grabCenter);
overlayDnd.onCancel({ pointerId: 63 });
assert.equal(overlayElementCount(), 0);

// 重复 destroy 幂等（浮层模块单元级）：二次调用不抛错、body 元素计数不变。
const unitOverlay = createDragOverlay(
  {
    document: stubDocument,
    window: makeStubWindow(),
    requestAnimationFrame: overlayRequestAnimationFrame,
    cancelAnimationFrame: overlayCancelAnimationFrame,
  },
  {
    image: () => {
      const canvas = makeStubCanvas();
      renderModule.drawOverlayImage(canvas, { definition: moveDefinition });
      return canvas;
    },
    grabRatio: { x: 0.5, y: 0.5 },
    startSize: { w: 40, h: 20 },
    targetSize: { w: 80, h: 40 },
    reducedMotion: true,
  },
);
assert.ok(unitOverlay);
assert.equal(unitOverlay.state(), "active");
assert.equal(overlayElementCount(), 1);
unitOverlay.destroy();
assert.equal(unitOverlay.state(), "destroyed");
assert.doesNotThrow(() => unitOverlay.destroy());
assert.equal(overlayElementCount(), 0);

// ===== T-EP-20（EP-AC-04）：移除预览范围 =====
// 范围 = removalScopeIds() 输出：被删块 + 体内子块，不含 next 链后续。
const repeatScope = model.removalScopeIds(richRoot, repeatId);
assert.deepEqual([...repeatScope].sort(), [repeatId, richMoveId].sort());
assert.equal(repeatScope.has(printId), false);
const nestedScope = model.removalScopeIds(outerStart, outerRepeat.blockId);
assert.deepEqual(
  [...nestedScope].sort(),
  [outerRepeat.blockId, innerRepeat.blockId, innerMove.blockId].sort(),
);
assert.equal(model.removalScopeIds(richRoot, "missing").size, 0);

// 画布来源拖容器进入移除区：浮层成像范围与 removalScopeIds() 一致；离开恢复整组；边界往返一致。
const repeatRect = richLayout.nodes.find((node) => node.blockId === repeatId).rect;
overlayDnd.startBlockDrag(repeatId, {
  pointerId: 64, clientX: repeatRect.x + 20, clientY: repeatRect.y + 14,
});
overlayDnd.onMove({ pointerId: 64, clientX: 300, clientY: 130 });
assert.equal(overlayDnd.session.overlayPhase, "following");
assert.equal(overlayElementCount(), 1);
assert.equal(overlayDnd.hiddenBlockIds.has(printId), true);
overlayDnd.onMove({ pointerId: 64, ...toolboxPoint });
assert.equal(overlayDnd.session.overlayPhase, "remove-preview");
assert.deepEqual([...overlayDnd.session.removalScope].sort(), [repeatId, richMoveId].sort());
assert.deepEqual(overlayDnd.hiddenBlockIds, repeatScope);
assert.equal(
  stubBody.firstChild.style.transform,
  `translate(${toolboxPoint.clientX - 20}px, ${toolboxPoint.clientY - 14}px)`,
);
const pendingPreview = overlayDnd.session.frame;
const previewsBeforeRemovalFrame = previewCalls.length;
const flushPendingPreview = overlayRaf.pending.get(pendingPreview);
overlayRaf.pending.delete(pendingPreview);
flushPendingPreview();
assert.equal(previewCalls.length, previewsBeforeRemovalFrame);
overlayDnd.onMove({ pointerId: 64, clientX: 300, clientY: 130 });
assert.equal(overlayDnd.session.overlayPhase, "following");
assert.equal(overlayDnd.hiddenBlockIds.has(printId), true);
overlayDnd.onCancel({ pointerId: 64 });
assert.equal(overlayElementCount(), 0);
assert.equal(overlayDnd.hiddenBlockIds, null);

const deletesBeforeQuickRelease = deletedBlocks.length;
overlayDnd.startBlockDrag(repeatId, {
  pointerId: 164, clientX: repeatRect.x + 20, clientY: repeatRect.y + 14,
});
overlayDnd.onUp({ pointerId: 164, ...toolboxPoint });
assert.equal(deletedBlocks.length, deletesBeforeQuickRelease + 1);
assert.equal(overlayDnd.settlingOverlay.state(), "settling");
const removalBitmap = stubBody.firstChild.firstChild;
assert.ok(removalBitmap.height > repeatRect.h);
assert.equal(parseFloat(stubBody.firstChild.style.height), repeatRect.h);
assert.ok(Math.abs(parseFloat(removalBitmap.style.height) / 100 * repeatRect.h - removalBitmap.height) < 0.01);
overlayDnd.cancel("context");
assert.equal(overlayElementCount(), 0);

// ===== T-EP-20（EP-AC-05）：pointerup 提交前复核 =====
// 会话进行中变只读后松手：不提交、零事务、无动画、浮层清除（与 begin() 门禁构成双防线）。
overlayDnd.startBlockDrag(richMoveId, { pointerId: 65, clientX: 200, clientY: 120 });
overlayDnd.onMove({ pointerId: 65, clientX: 300, clientY: 130 });
editorStub.state.readonly = true;
const commitCountBefore = commitCalls.length;
const deleteCountBefore = deletedBlocks.length;
overlayDnd.onUp({ pointerId: 65, clientX: 300, clientY: 130 });
assert.equal(commitCalls.length, commitCountBefore);
assert.equal(deletedBlocks.length, deleteCountBefore);
assert.equal(overlayDnd.session, null);
assert.equal(overlayElementCount(), 0);
editorStub.state.readonly = false;

// 运行态下松手：同样按取消清理（复核失败不得产生事务、不得播放动画）。
overlayDnd.startBlockDrag(richMoveId, { pointerId: 66, clientX: 200, clientY: 120 });
overlayDnd.onMove({ pointerId: 66, clientX: 300, clientY: 130 });
editorStub.state.phase = "running";
overlayDnd.onUp({ pointerId: 66, clientX: 300, clientY: 130 });
assert.equal(commitCalls.length, commitCountBefore);
assert.equal(overlayElementCount(), 0);
editorStub.state.phase = "editing";

// ===== T-EP-20（EP-AC-06）：reduced-motion 立即路径 =====
// D-02 参数核对：拿起 150ms、收回 180ms。
assert.equal(LIFT_MS, 150);
assert.equal(SETTLE_MS, 180);
// reduce：拿起立即到位（无插值中间态、无动画 rAF 调度）；删除后 0ms 收回立即清除。
const reduceDnd = new dndModule.DndController(editorStub, {
  toolbox,
  env: {
    window: makeStubWindow(),
    document: stubDocument,
    requestAnimationFrame: overlayRequestAnimationFrame,
    cancelAnimationFrame: overlayCancelAnimationFrame,
    matchMedia: () => ({ matches: true }),
  },
});
reduceDnd.startToolboxDrag("motion.move", { pointerId: 67, clientX: 20, clientY: 20 }, toolboxSource, grabCenter);
assert.equal(reduceDnd.session.overlayPhase, "following");
assert.equal(overlayRaf.pending.size, 0);
assert.equal(overlayElementCount(), 1);
reduceDnd.teardown("cancelled");
assert.equal(overlayElementCount(), 0);

reduceDnd.startBlockDrag(richMoveId, { pointerId: 68, clientX: 200, clientY: 120 });
reduceDnd.onMove({ pointerId: 68, ...toolboxPoint });
const deleteCountMid = deletedBlocks.length;
reduceDnd.onUp({ pointerId: 68, ...toolboxPoint });
assert.equal(deletedBlocks.length, deleteCountMid + 1);
assert.equal(overlayElementCount(), 0);

// 拿起动画从缩略图连续放大，放大过程中抓取点仍在指针下。
const realNow = Date.now;
let animationTime = 0;
const advanceLift = (time) => {
  animationTime = time;
  const [handle, callback] = overlayRaf.pending.entries().next().value;
  overlayRaf.pending.delete(handle);
  callback();
};
Date.now = () => animationTime;
try {
  const moveGrab = { ...grabCenter, startWidth: 78, startHeight: 28 };
  overlayDnd.startToolboxDrag("motion.move", { pointerId: 69, clientX: 20, clientY: 20 }, toolboxSource, moveGrab);
  assert.equal(overlayDnd.session.overlayPhase, "lifting");
  const { w: targetWidth } = overlayDnd.session.targetSize;
  advanceLift(LIFT_MS / 2);
  const currentWidth = parseFloat(stubBody.firstChild.style.width);
  assert.ok(currentWidth > moveGrab.startWidth && currentWidth < targetWidth);
  assert.ok(stubBody.firstChild.style.transform.startsWith(`translate(${20 - currentWidth / 2}px,`));
  advanceLift(LIFT_MS);
  assert.equal(overlayDnd.session.overlayPhase, "following");
  assert.equal(parseFloat(stubBody.firstChild.style.width), targetWidth);
} finally {
  Date.now = realNow;
  overlayDnd.teardown("cancelled");
}
assert.equal(overlayElementCount(), 0);

// ===== T-EP-20：序列化守卫补强（新增会话字段不入程序序列化，spec 9.2 第 1 条） =====
overlayDnd.startToolboxDrag("motion.move", { pointerId: 70, clientX: 20, clientY: 20 }, toolboxSource, grabCenter);
const sessionSerialized = JSON.stringify(editorStub.state.root);
assert.equal(sessionSerialized.includes("grabRatio"), false);
assert.equal(sessionSerialized.includes("overlayPhase"), false);
assert.equal(sessionSerialized.includes("startSize"), false);
assert.equal(sessionSerialized.includes("targetSize"), false);
overlayDnd.teardown("cancelled");
assert.equal(overlayElementCount(), 0);

// ===== T-EP-20：调度合并断言（连续 move 下画布重绘 ≤ 每帧一次，T-EP-10 行为固化） =====
dnd.startBlockDrag(richMoveId, { pointerId: 71, clientX: 200, clientY: 120 });
dnd.onMove({ pointerId: 71, clientX: 300, clientY: 130 });
dnd.onMove({ pointerId: 71, clientX: 310, clientY: 140 });
dnd.onMove({ pointerId: 71, clientX: 320, clientY: 150 });
assert.equal(rafPending.size, 1);
dnd.teardown("cancelled");
assert.equal(rafPending.size, 0);

console.log("JS-EDITOR-CHECK PASSED");
