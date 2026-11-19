/** 画布上的积木组与跨组连接。 */
import {
  STACK_LIMIT,
  attachToSlot,
  cloneTree,
  createBlock,
  detachBlock,
  findBlock,
  insertAfterAnchor,
  isTargetAlive,
  planDrop,
  workspaceStacks,
} from "./model.js";
import { normalizeTargetId } from "./targets.js";

export function workspaceOwnerId(root, stack) {
  return Array.isArray(root) ? `stack:${stack.root.blockId}` : "root";
}

export function clampStackPosition({ x, y }) {
  return {
    x: Math.max(0, Math.min(STACK_LIMIT.x, Math.round(x))),
    y: Math.max(0, Math.min(STACK_LIMIT.y, Math.round(y))),
  };
}

function stackTarget(stacks, targetId) {
  const ref = normalizeTargetId(targetId);
  if (!ref) {
    return null;
  }
  if (ref.containerRef.startsWith("stack:")) {
    const stack = stacks.find((item) => workspaceOwnerId(stacks, item) === ref.containerRef);
    const localId = `root@${ref.anchorRef}`;
    return stack && isTargetAlive(stack.root, localId)
      ? { stack, ref: { ...ref, containerRef: "root" }, localId }
      : null;
  }
  const stack = stacks.find((item) => isTargetAlive(item.root, targetId));
  return stack ? { stack, ref, localId: targetId } : null;
}

export function isWorkspaceTargetAlive(root, targetId) {
  return Array.isArray(root) ? Boolean(stackTarget(root, targetId)) : isTargetAlive(root, targetId);
}

export function planWorkspaceDrop(root, request) {
  const { blockId, kind, definition, definitions, targetId, freePosition } = request;
  if (!Array.isArray(root) && !freePosition) {
    return planDrop(root, request);
  }

  const stacks = workspaceStacks(cloneTree(root));
  const originalStack = stacks.find((stack) => stack.root.blockId === blockId);
  if (freePosition && originalStack) {
    Object.assign(originalStack, clampStackPosition(freePosition));
    return { ok: true, root: stacks, node: originalStack.root };
  }

  const target = freePosition ? null : stackTarget(stacks, targetId);
  if (!freePosition && !target) {
    return { ok: false, root, message: "这个位置刚刚变了，请再拖一次。" };
  }
  if (target && originalStack === target.stack) {
    return { ok: false, root, message: "不能把一组积木接回它自己。" };
  }
  if (target && kind === "event.start" && (target.ref.field || target.ref.containerRef !== "root" || target.ref.anchorRef !== "start")) {
    return { ok: false, root, message: "「当开始」要放在一组积木最上面。" };
  }
  if (target?.ref.field && blockId) {
    const owner = findBlock(target.stack.root, target.ref.ownerId);
    if (owner?.inputs?.[target.ref.field]?.blockId === blockId) {
      return { ok: true, root, node: owner.inputs[target.ref.field] };
    }
  }
  let node;
  if (originalStack) {
    node = originalStack.root;
    stacks.splice(stacks.indexOf(originalStack), 1);
  } else if (blockId) {
    node = detachBlock(stacks, blockId, { keepTail: true, definitions }).node;
  } else if (definition) {
    node = createBlock(definition);
  }
  if (!node) {
    return { ok: false, root, message: "这个积木已经不在画布上了。" };
  }
  if (freePosition) {
    stacks.push({ ...clampStackPosition(freePosition), root: node });
  } else if (!isTargetAlive(target.stack.root, target.localId)) {
    return { ok: false, root, message: "不能把积木接到自己里面。" };
  } else if (target.ref.field) {
    const owner = findBlock(target.stack.root, target.ref.ownerId);
    attachToSlot(owner, target.ref.field, node);
  } else {
    const connected = insertAfterAnchor(target.stack.root, target.ref, node);
    if (!connected) {
      return { ok: false, root, message: "找不到这个连接位置。" };
    }
    target.stack.root = connected;
  }
  return { ok: true, root: stacks, node };
}
