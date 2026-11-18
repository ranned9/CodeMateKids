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
const undoModule = await import(asUrl("frontend/js/editor/undo.js"));

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

const validation = model.validateTree(root);
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
history.undo();
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

assert.equal(JSON.stringify(richRoot).includes("fieldName"), false);
assert.equal(targetsModule.hasPlaceableTarget(emptyModel, numberDefinition, schema), false);
assert.equal(targetsModule.hasPlaceableTarget(emptyModel, moveDefinition, schema), true);
assert.equal(model.buildProgram(richRoot, { taskId: "main" }).courseRef.version, 1);
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
const dnd = new dndModule.DndController(editorStub, {
  env: {
    window: windowRecord,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {
      cancelFrameCount += 1;
    },
  },
});

const toolboxSource = makeSource("toolbox-button");
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
assert.equal(toolboxSource.record.captures, 1);
assert.equal(toolboxSource.record.classes.has("is-grabbing"), true);
assert.equal(previewCalls.length, 0);
const lastPointBefore = { ...dnd.session.lastPoint };
dnd.onMove({ pointerId: 8, clientX: 400, clientY: 300 });
assert.deepEqual(dnd.session.lastPoint, lastPointBefore);
dnd.session.frame = 99;
dnd.teardown("cancelled");
assert.equal(dnd.session, null);
assert.equal(previewCalls[previewCalls.length - 1], null);
assert.equal(toolboxSource.record.releases, 1);
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

previewCalls = [];
commitCalls = [];
toastCalls = [];
const startPoint = { x: dndBodyStartTarget.rect.x + 4, y: dndBodyStartTarget.rect.y + 4 };
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
assert.equal(canvasSource.record.captures, 1);
dnd.onMove({
  pointerId: 1,
  clientX: dndAfterRepeatTarget.rect.x + 4,
  clientY: dndAfterRepeatTarget.rect.y + 4,
});
assert.equal(dnd.session.lastResult.target.id, dndAfterRepeatTarget.id);
dnd.onUp({ pointerId: 1, clientX: startPoint.x, clientY: startPoint.y });
assert.equal(commitCalls.length, 1);
assert.equal(commitCalls[0][2].target.id, dndBodyStartTarget.id);
assert.equal(commitPreview, commitCalls[0][2]);
assert.equal(dnd.session, null);

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
  { pointerId: 3, clientX: startPoint.x, clientY: startPoint.y },
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
  { pointerId: 4, clientX: startPoint.x, clientY: startPoint.y },
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
  { pointerId: 5, clientX: startPoint.x, clientY: startPoint.y },
);
assert.equal(dnd.session.captureOk, false);
assert.equal(dnd.session.captureTarget, throwingSource);
dnd.onUp({ pointerId: 5, clientX: startPoint.x, clientY: startPoint.y });
assert.equal(commitCalls.length, 1);
assert.equal(throwingSource.record.releases, 0);
assert.equal(dnd.session, null);

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

console.log("JS-EDITOR-CHECK PASSED");