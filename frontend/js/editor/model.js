/** 程序模型树操作：节点创建、查找、事务化挂接、摘除与序列化。 */
import { numericFieldError, numberForNewBlock } from "./connector.js";

let idCounter = 0;
export const STACK_START = { x: 30, y: 26 };
export const STACK_LIMIT = { x: 4096, y: 8192 };

export function newId() {
  idCounter += 1;
  const random = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : `${Date.now().toString(36)}${idCounter}`;
  return `b-${random}-${idCounter}`;
}

/**
 * @param {any} definition
 */
export function createBlock(definition, blockId = newId()) {
  const inputs = {};
  for (const field of definition.fields || []) {
    if (field.valueType === "expression") {
      inputs[field.name] = null;
    } else if (field.valueType === "choice") {
      inputs[field.name] = field.defaultValue ?? field.choices?.[0] ?? "";
    } else if (field.valueType === "string") {
      inputs[field.name] = field.defaultValue ?? "";
    } else if (field.valueType === "boolean") {
      inputs[field.name] = field.defaultValue ?? false;
    } else if (field.valueType === "name") {
      inputs[field.name] = field.defaultValue ?? "";
    } else {
      inputs[field.name] = field.defaultValue ?? 0;
    }
  }
  return {
    blockId,
    kind: definition.kind,
    inputs,
    body: [],
    next: null,
  };
}

export function cloneTree(root) {
  return root == null ? null : JSON.parse(JSON.stringify(root));
}

export function numberInputValue(value) {
  return value?.kind === "value.number" ? value.inputs?.value : value;
}

export function workspaceStacks(root) {
  if (Array.isArray(root)) {
    return root;
  }
  return root ? [{ ...STACK_START, root, legacy: root.kind !== "event.start" }] : [];
}

export function runnableRoots(root) {
  return workspaceStacks(root)
    .filter((stack) => stack.legacy || stack.root.kind === "event.start")
    .map((stack) => stack.root);
}

/**
 * @param {any} node
 * @param {(node:any)=>void} visit
 */
export function walkNodes(node, visit, guard = { count: 0 }) {
  if (!node || guard.count > 2000) {
    return;
  }
  if (Array.isArray(node)) {
    for (const stack of node) {
      walkNodes(stack.root, visit, guard);
    }
    return;
  }
  guard.count += 1;
  visit(node);
  for (const child of node.body || []) {
    walkNodes(child, visit, guard);
  }
  if (node.next) {
    walkNodes(node.next, visit, guard);
  }
  for (const value of Object.values(node.inputs || {})) {
    if (value && typeof value === "object" && value.kind) {
      walkNodes(value, visit, guard);
    }
  }
}

export function findBlock(root, blockId) {
  let found = null;
  walkNodes(root, (node) => {
    if (node.blockId === blockId) {
      found = node;
    }
  });
  return found;
}

export function chainTail(node) {
  let current = node;
  let guard = 0;
  while (current?.next && guard < 200) {
    current = current.next;
    guard += 1;
  }
  return current;
}

// 循环体按数组顺序连接各条语句链，每条链按 next 遍历。
export function* bodyStatements(body) {
  for (const head of body || []) {
    let child = head;
    let count = 0;
    while (child && count < 200) {
      yield child;
      child = child.next;
      count += 1;
    }
  }
}

/**
 * 从语句链或表达式槽位摘除积木，可一并带走后续语句。
 * @returns {{root:any, node:any}}
 */
export function detachBlock(root, blockId, { keepTail = false, definitions } = {}) {
  if (!root) {
    return { root: null, node: null };
  }
  if (Array.isArray(root)) {
    for (const [index, stack] of root.entries()) {
      const detached = detachBlock(stack.root, blockId, { keepTail, definitions });
      if (detached.node) {
        if (detached.root) {
          stack.root = detached.root;
        } else {
          root.splice(index, 1);
        }
        return { root, node: detached.node };
      }
    }
    return { root, node: null };
  }
  if (root.blockId === blockId) {
    const node = root;
    const newRoot = keepTail ? null : node.next;
    if (!keepTail) {
      node.next = null;
    }
    return { root: newRoot, node };
  }

  function visit(owner) {
    if (!owner) {
      return null;
    }
    if (owner.next && owner.next.blockId === blockId) {
      const node = owner.next;
      owner.next = keepTail ? null : node.next;
      if (!keepTail) {
        node.next = null;
      }
      return node;
    }
    for (let index = 0; index < (owner.body || []).length; index += 1) {
      const child = owner.body[index];
      if (child.blockId === blockId) {
        const node = child;
        if (keepTail || !node.next) {
          owner.body.splice(index, 1);
        } else {
          owner.body[index] = node.next;
        }
        if (!keepTail) {
          node.next = null;
        }
        return node;
      }
      const nested = visit(child);
      if (nested) {
        return nested;
      }
    }
    if (owner.next) {
      const nestedNext = visit(owner.next);
      if (nestedNext) {
        return nestedNext;
      }
    }
    return null;
  }

  const statementNode = visit(root);
  if (statementNode) {
    return { root, node: statementNode };
  }

  let expressionNode = null;
  walkNodes(root, (node) => {
    for (const [field, value] of Object.entries(node.inputs || {})) {
      if (value && typeof value === "object" && value.blockId === blockId) {
        expressionNode = value;
        const input = definitions?.get(node.kind)?.fields?.find((item) => item.name === field);
        node.inputs[field] = input?.acceptsNumberBlock ? input.defaultValue : null;
      }
    }
  });
  if (expressionNode) {
    delete expressionNode.fieldName;
  }
  return { root, node: expressionNode };
}

export function attachToNext(owner, node) {
  node.next = owner.next;
  owner.next = node;
}

/**
 * @deprecated 使用 insertAfterAnchor()。
 */
export function attachToBody(owner, node) {
  node.next = null;
  if (!owner.body || owner.body.length === 0) {
    owner.body = [node];
  } else {
    chainTail(owner.body.at(-1)).next = node;
  }
}

export function attachToRoot(root, node) {
  node.next = root || null;
  return node;
}

/**
 * 表达式字段归属只由拥有者的 inputs[fieldName] 表示。
 * @param {any} owner
 * @param {string} fieldName
 * @param {any} node
 */
export function attachToSlot(owner, fieldName, node, { definitions, fromToolbox = false } = {}) {
  if (!owner || !fieldName) {
    const error = new Error("INVALID_FIELD");
    error.code = "INVALID_FIELD";
    throw error;
  }
  const field = definitions?.get(owner.kind)?.fields?.find((item) => item.name === fieldName);
  if (field?.acceptsNumberBlock) {
    if (node.kind !== "value.number") {
      throw new Error("这个位置只接收数字积木。");
    }
    if (fromToolbox) {
      node.inputs.value = numberForNewBlock(field, node.inputs.value, numberInputValue(owner.inputs?.[fieldName]));
    }
    const message = numericFieldError(field, node.inputs.value);
    if (message) {
      throw new Error(message);
    }
  }
  node.next = null;
  delete node.fieldName;
  owner.inputs = owner.inputs || {};
  owner.inputs[fieldName] = node;
  return node;
}

/**
 * @param {any} chain
 */
export function tailAnchorRef(chain) {
  if (!chain) {
    return "start";
  }
  return `after:${chainTail(chain).blockId}`;
}

/**
 * @param {any} workRoot
 * @param {string} containerRef
 * @returns {{kind:string, ownerId:string, owner:any, chain:any}|null}
 */
export function resolveContainer(workRoot, containerRef) {
  if (containerRef === "root") {
    return { kind: "root", ownerId: "root", owner: null, chain: workRoot || null };
  }
  if (typeof containerRef === "string" && containerRef.startsWith("body:")) {
    const ownerId = containerRef.slice(5);
    const owner = findBlock(workRoot, ownerId);
    if (!owner) {
      return null;
    }
    if (!Array.isArray(owner.body)) {
      owner.body = [];
    }
    return { kind: "body", ownerId, owner, chain: owner.body[0] || null };
  }
  return null;
}

/**
 * @param {any} workRoot
 * @param {{containerRef:string,anchorRef:string}} ref
 * @param {any} chain
 * @returns {any|null} 新根；失败返回 null
 */
export function insertAfterAnchor(workRoot, ref, chain) {
  if (!ref || !chain) {
    return null;
  }
  const container = resolveContainer(workRoot, ref.containerRef);
  if (!container) {
    return null;
  }
  if (ref.anchorRef === "start") {
    if (container.kind === "root") {
      if (!workRoot) {
        return chain;
      }
      chainTail(chain).next = workRoot;
      return chain;
    }
    if (!container.owner.body || container.owner.body.length === 0) {
      container.owner.body = [chain];
    } else {
      chainTail(chain).next = container.owner.body[0];
      container.owner.body[0] = chain;
    }
    return workRoot;
  }
  if (typeof ref.anchorRef === "string" && ref.anchorRef.startsWith("after:")) {
    const anchorId = ref.anchorRef.slice(6);
    const anchor = findBlock(workRoot, anchorId);
    if (!anchor) {
      return null;
    }
    if (container.kind === "body" && !isDirectBodyChild(container.owner, anchorId)) {
      return null;
    }

    chainTail(chain).next = anchor.next;
    anchor.next = chain;
    return workRoot;
  }
  return null;
}

function isDirectBodyChild(owner, blockId) {
  for (const child of bodyStatements(owner.body)) {
    if (child.blockId === blockId) {
      return true;
    }
  }
  return false;
}


function subtreeContains(node, blockId) {
  let found = false;
  walkNodes(node, (item) => {
    if (item.blockId === blockId) {
      found = true;
    }
  });
  return found;
}

function parseTargetId(targetId) {
  if (typeof targetId !== "string" || targetId.trim() === "") {
    return null;
  }
  const value = targetId.trim();
  if (value.startsWith("expr:")) {
    const body = value.slice(5);
    const dot = body.lastIndexOf(".");
    if (dot <= 0 || dot === body.length - 1) {
      return null;
    }
    return {
      containerRef: `expr:${body.slice(0, dot)}`,
      anchorRef: body.slice(dot + 1),
      ownerId: body.slice(0, dot),
      field: body.slice(dot + 1),
    };
  }
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1) {
    return null;
  }
  const containerRef = value.slice(0, at);
  const anchorRef = value.slice(at + 1);
  if (anchorRef !== "start" && !anchorRef.startsWith("after:")) {
    return null;
  }
  if (containerRef !== "root" && !containerRef.startsWith("body:")) {
    return null;
  }
  return { containerRef, anchorRef };
}

function findPosition(root, blockId, ownerRef = "root", previous = null) {
  if (!root) {
    return null;
  }
  let node = root;
  let guard = 0;
  while (node && guard < 300) {
    guard += 1;
    if (node.blockId === blockId) {
      return {
        containerRef: ownerRef,
        anchorRef: previous ? `after:${previous.blockId}` : "start",
        node,
      };
    }
    let previousChild = null;
    for (const child of node.body || []) {
      const nested = findPosition(child, blockId, `body:${node.blockId}`, previousChild);
      if (nested) {
        return nested;
      }
      previousChild = chainTail(child);
    }
    previous = node;
    node = node.next;
  }
  return null;
}

function checkLocalStructure(root) {
  const seen = new Set();
  let duplicate = null;
  walkNodes(root, (node) => {
    if (seen.has(node.blockId)) {
      duplicate = node.blockId;
    }
    seen.add(node.blockId);
  });
  return duplicate
    ? { ok: false, message: "这个积木已经在程序里了。", blockId: duplicate }
    : { ok: true, message: "", blockId: null };
}

/**
 * 在克隆副本上完成摘除、校验与挂接；失败返回入参原引用。
 * @param {any} root
 * @param {{blockId?:string|null,kind?:string,definition?:any,targetId:string}} request
 * @returns {{ok:boolean,message:string,root:any,node?:any}}
 */
export function planDrop(root, { blockId, definition, definitions, targetId }) {
  const ref = parseTargetId(targetId);
  if (!ref) {
    return { ok: false, message: "这个位置不能放积木。", root };
  }
  if (ref.field) {
    const owner = findBlock(root, ref.ownerId);
    if (!owner || !Object.prototype.hasOwnProperty.call(owner.inputs || {}, ref.field)) {
      return { ok: false, message: "找不到这个位置。", root };
    }
    if (blockId && owner.inputs[ref.field]?.blockId === blockId) {
      return { ok: true, message: "", root, node: owner.inputs[ref.field] };
    }
    const work = cloneTree(root);
    const workOwner = findBlock(work, ref.ownerId);
    let node;
    if (blockId) {
      const detached = detachBlock(work, blockId, { definitions });
      if (!detached.node) {
        return { ok: false, message: "这个积木已经不在画布上了。", root };
      }
      node = detached.node;
      if (subtreeContains(node, ref.ownerId)) {
        return { ok: false, message: "不能把积木放进它自己里面。", root };
      }
      try {
        attachToSlot(workOwner, ref.field, node, { definitions });
      } catch (error) {
        return { ok: false, message: error.message, root };
      }
      if (!checkLocalStructure(work).ok) {
        return { ok: false, message: "这个积木已经在程序里了。", root };
      }
      return { ok: true, message: "", root: work, node };
    }
    if (!definition) {
      return { ok: false, message: "这个积木还没有准备好。", root };
    }
    node = createBlock(definition);
    try {
      attachToSlot(workOwner, ref.field, node, { definitions, fromToolbox: true });
    } catch (error) {
      return { ok: false, message: error.message, root };
    }
    return { ok: true, message: "", root: work, node };
  }

  if (blockId) {
    const position = findPosition(root, blockId);
    if (!position) {
      return { ok: false, message: "这个积木已经不在画布上了。", root };
    }
    if (position.containerRef === ref.containerRef && position.anchorRef === ref.anchorRef) {
      return { ok: true, message: "", root, node: position.node };
    }
    const work = cloneTree(root);
    const detached = detachBlock(work, blockId, { definitions });
    if (!detached.node) {
      return { ok: false, message: "这个积木已经不在画布上了。", root };
    }
    const node = detached.node;
    if (ref.containerRef !== "root") {
      const containerId = ref.containerRef.slice(5);
      if (subtreeContains(node, containerId)) {
        return { ok: false, message: "不能把积木放进它自己里面。", root };
      }
    }
    const nextRoot = insertAfterAnchor(work, ref, node);
    if (!nextRoot) {
      return { ok: false, message: "找不到这个连接位置。", root };
    }
    const structure = checkLocalStructure(nextRoot);
    if (!structure.ok) {
      return { ok: false, message: structure.message, root };
    }
    return { ok: true, message: "", root: nextRoot, node };
  }

  if (!definition) {
    return { ok: false, message: "这个积木还没有准备好。", root };
  }
  const node = createBlock(definition);
  const work = cloneTree(root);
  const nextRoot = insertAfterAnchor(work, ref, node);
  if (!nextRoot) {
    return { ok: false, message: "找不到这个连接位置。", root };
  }
  return { ok: true, message: "", root: nextRoot, node };
}

/**
 * 提交前的轻量目标复核：只判断目标引用仍可解析，不替代 planDrop 的结构校验。
 * @param {any} root
 * @param {string} targetId
 * @returns {boolean}
 */
export function isTargetAlive(root, targetId) {
  const ref = parseTargetId(targetId);
  if (!ref) {
    return false;
  }
  if (ref.field) {
    const owner = findBlock(root, ref.ownerId);
    return Boolean(
      owner && owner.inputs && Object.prototype.hasOwnProperty.call(owner.inputs, ref.field),
    );
  }
  if (ref.containerRef === "root") {
    if (!root) {
      return ref.anchorRef === "start";
    }
    if (ref.anchorRef === "start") {
      return true;
    }
    const anchorId = ref.anchorRef.startsWith("after:") ? ref.anchorRef.slice(6) : "";
    const position = anchorId ? findPosition(root, anchorId) : null;
    return Boolean(position && position.containerRef === "root");
  }
  const ownerId = ref.containerRef.slice(5);
  const owner = findBlock(root, ownerId);
  if (!owner) {
    return false;
  }
  if (ref.anchorRef === "start") {
    return true;
  }
  const childId = ref.anchorRef.startsWith("after:") ? ref.anchorRef.slice(6) : "";
  return isDirectBodyChild(owner, childId);
}

function slotToTargetId(root, slot) {
  if (!slot) {
    return null;
  }
  if (slot.type === "root") {
    return "root@start";
  }
  if (slot.type === "next") {
    return `root@after:${slot.ownerId}`;
  }
  if (slot.type === "body") {
    const owner = findBlock(root, slot.ownerId);
    if (!owner) {
      return null;
    }
    return `body:${slot.ownerId}@${tailAnchorRef(owner.body?.at(-1))}`;
  }
  if (slot.type === "slot") {
    return `expr:${slot.ownerId}.${slot.field}`;
  }
  return null;
}

/**
 * 旧调用面适配器：把旧 slot 转译为稳定目标 ID。
 * @returns {{ok:boolean, message:string, root:any, node?:any}}
 */
export function applyDrop(root, { blockId, kind, slot, definition }) {
  const targetId = slotToTargetId(root, slot);
  if (!targetId) {
    return { ok: false, message: "这个位置不能放积木。", root };
  }
  return planDrop(root, { blockId, kind, definition, targetId });
}

export function removeBlock(root, blockId, options) {
  const detached = detachBlock(root, blockId, options);
  return { root: detached.root, removed: detached.node };
}

export function validateTree(root, definitions) {
  const issues = [];
  const invalidIds = new Set();
  const blockedKinds = new Set();
  if (!definitions) {
    return { ok: true, issues, invalidIds, blockedKinds };
  }
  for (const head of runnableRoots(root)) {
    walkNodes(head, (node) => {
      const definition = definitions.get(node.kind);
      if (!definition || !definition.runnable) {
        blockedKinds.add(node.kind);
        invalidIds.add(node.blockId);
        issues.push({ blockId: node.blockId, kind: node.kind, message: "这个积木现在不能运行" });
        return;
      }
      for (const field of definition.fields || []) {
        const value = node.inputs?.[field.name];
        if (!field.required) {
          continue;
        }
        if (field.valueType === "expression" && !value) {
          invalidIds.add(node.blockId);
          issues.push({ blockId: node.blockId, kind: node.kind, message: "这个位置还需要一个值" });
        } else if (value === "" || value == null) {
          invalidIds.add(node.blockId);
          issues.push({ blockId: node.blockId, kind: node.kind, message: "这个位置还需要填内容" });
        } else if (field.acceptsNumberBlock) {
          const message = numericFieldError(field, numberInputValue(value));
          if (message) {
            const blockId = value?.blockId || node.blockId;
            invalidIds.add(blockId);
            issues.push({ blockId, kind: node.kind, message });
          }
        }
      }
    });
  }
  return { ok: issues.length === 0, issues, invalidIds, blockedKinds };
}

export function programSummary(root, definitions) {
  if (Array.isArray(root)) {
    const summaries = runnableRoots(root).map((head) => programSummary(head, definitions));
    return summaries.join(" / ") || (root.length ? "积木还没有接到「当开始」" : "画布还是空的");
  }
  if (!root) {
    return "画布还是空的";
  }
  const parts = [];
  let node = root;
  let guard = 0;
  while (node && guard < 30) {
    guard += 1;
    const definition = definitions.get(node.kind);
    const name = definition?.displayName || "未知积木";
    if (node.kind === "control.repeat") {
      const bodyNames = [];
      for (const child of bodyStatements(node.body)) {
        bodyNames.push(definitions.get(child.kind)?.displayName || "未知积木");
        if (bodyNames.length === 10) {
          break;
        }
      }
      parts.push(`重复 ${numberInputValue(node.inputs?.times) ?? "?"} 次（${bodyNames.join("、") || "没有动作"}）`);
    } else {
      parts.push(name);
    }
    node = node.next;
  }
  return parts.join(" → ");
}

export function buildProgram(root, task, courseId, options = {}) {
  const taskCourse = task.initialProgram?.courseRef;
  const updatedAt = new Date().toISOString();
  return {
    format: "codematekids.program",
    formatVersion: Array.isArray(root) ? 2 : 1,
    target: { language: "python", version: "3.12" },
    courseRef: {
      courseId: courseId ?? taskCourse?.courseId ?? "demo-loop",
      version: options.courseVersion ?? taskCourse?.version ?? 1,
      taskId: task.taskId,
    },
    ...(Array.isArray(root) ? { stacks: root } : { root: root || null }),
    metadata: { createdAt: updatedAt, updatedAt },
  };
}

export function programWorkspace(program) {
  return program.formatVersion === 2 ? program.stacks : program.root;
}

export function countNodes(root) {
  let count = 0;
  walkNodes(root, () => {
    count += 1;
  });
  return count;
}
