/** 放置目标解析：稳定目标 ID、矩形命中带、附近吸附与端口映射。 */

import { canConnect, portTypeOfTarget } from "./connector.js";

export const HIT_PAD = 10;
export const SNAP_X = 40;
export const SNAP_Y_MAX = 56;
export const INSERT_BAND_MIN = 20;
export const EXPR_SLOTS_ENABLED = false;

const EMPTY_ROOT = { x: 30, y: 26, w: 272, h: 64 };
const EMPTY_HEIGHT = 180;

function targetIdOf(containerRef, anchorRef) {
  return `${containerRef}@${anchorRef}`;
}

function rectOfNode(node) {
  return { x: node.rect.x, y: node.rect.y, w: node.rect.w, h: node.rect.h };
}

function lineVisual(x, y, w, containerId) {
  return { type: "line", x, y, w, containerId: containerId || null };
}

function bandRect(node, y, w) {
  return { x: node.rect.x, y, w: w ?? node.rect.w, h: INSERT_BAND_MIN };
}

/** @returns {{nodes:any[],drawOrder:any[],sections:any,targets:any[],blocks:any[],slots:any[],height:number,contentWidth:number,viewport:any}} */
export function emptyLayoutModel(viewport = { w: 720, h: 460, scrollY: 0 }) {
  const target = {
    id: "root@start",
    containerRef: "root",
    anchorRef: "start",
    rect: { ...EMPTY_ROOT },
    visual: { type: "rect", x: EMPTY_ROOT.x, y: EMPTY_ROOT.y, w: EMPTY_ROOT.w, h: EMPTY_ROOT.h },
    portType: "statement-next",
    depth: 0,
    priority: 0,
    rank: 0,
    visible: true,
  };
  return {
    nodes: [],
    drawOrder: [],
    sections: {},
    targets: [target],
    blocks: [],
    slots: [{ type: "root", x: EMPTY_ROOT.x, y: EMPTY_ROOT.y, w: EMPTY_ROOT.w, h: EMPTY_ROOT.h }],
    height: EMPTY_HEIGHT,
    contentWidth: EMPTY_ROOT.w,
    viewport: { ...viewport },
  };
}

/**
 * @param {{nodes:any[],sections:any,viewport?:any}} layout
 * @param {{exprSlotsEnabled?:boolean}} [options]
 */
export function buildTargets(layout, { exprSlotsEnabled = false } = {}) {
  const nodes = layout.nodes || [];
  const sections = layout.sections || {};
  const targets = [];

  if (nodes.length === 0) {
    targets.push({
      id: "root@start",
      containerRef: "root",
      anchorRef: "start",
      rect: { ...EMPTY_ROOT },
      visual: { type: "rect", x: EMPTY_ROOT.x, y: EMPTY_ROOT.y, w: EMPTY_ROOT.w, h: EMPTY_ROOT.h },
      portType: "statement-next",
      depth: 0,
      priority: 0,
      rank: 0,
      visible: true,
    });
    return targets;
  }

  const rootNodes = nodes.filter((node) => node.ownerId === "root").sort((a, b) => a.order - b.order);
  const firstRoot = rootNodes[0];
  if (firstRoot) {
    targets.push({
      id: "root@start",
      containerRef: "root",
      anchorRef: "start",
      rect: bandRect(firstRoot, firstRoot.rect.y - INSERT_BAND_MIN, firstRoot.rect.w),
      visual: lineVisual(firstRoot.rect.x + 8, firstRoot.rect.y - 2, firstRoot.rect.w - 16),
      portType: "statement-next",
      depth: 0,
      priority: 0,
      rank: 0,
      visible: firstRoot.visible,
    });
  }

  for (const node of rootNodes) {
    const afterY = node.rect.y + node.rect.h;
    targets.push({
      id: `root@after:${node.blockId}`,
      containerRef: "root",
      anchorRef: `after:${node.blockId}`,
      rect: bandRect(node, afterY, node.rect.w),
      visual: lineVisual(node.rect.x + 8, afterY + 4, node.rect.w - 16),
      portType: "statement-next",
      depth: 0,
      priority: 1,
      rank: 0,
      visible: node.visible,
    });
  }

  for (const node of nodes) {
    if (!node.isContainer) {
      continue;
    }
    const section = sections[node.blockId];
    if (!section || !section.bodyBox) {
      continue;
    }
    const bodyBox = section.bodyBox;
    targets.push({
      id: `body:${node.blockId}@start`,
      containerRef: `body:${node.blockId}`,
      anchorRef: "start",
      rect: { x: bodyBox.x, y: bodyBox.y, w: bodyBox.w, h: INSERT_BAND_MIN },
      visual: lineVisual(bodyBox.x + 8, bodyBox.y + 4, bodyBox.w - 16, node.blockId),
      portType: "statement-body",
      depth: node.depth + 1,
      priority: 0,
      rank: 0,
      visible: node.visible,
    });
    const children = nodes
      .filter((child) => child.ownerId === node.blockId)
      .sort((a, b) => a.order - b.order);
    for (const child of children) {
      const afterY = child.rect.y + child.rect.h;
      targets.push({
        id: `body:${node.blockId}@after:${child.blockId}`,
        containerRef: `body:${node.blockId}`,
        anchorRef: `after:${child.blockId}`,
        rect: bandRect(child, afterY, child.rect.w),
        visual: lineVisual(child.rect.x + 8, afterY + 4, child.rect.w - 16, node.blockId),
        portType: "statement-body",
        depth: node.depth + 1,
        priority: 1,
        rank: 0,
        visible: node.visible && child.visible,
      });
    }
  }

  if (exprSlotsEnabled) {
    for (const node of nodes) {
      for (const field of node.fields || []) {
        if (field.valueType !== "expression") {
          continue;
        }
        targets.push({
          id: `expr:${node.blockId}.${field.name}`,
          containerRef: `expr:${node.blockId}`,
          anchorRef: field.name,
          rect: { x: field.rect.x, y: field.rect.y, w: field.rect.w, h: field.rect.h },
          visual: { type: "rect", x: field.rect.x, y: field.rect.y, w: field.rect.w, h: field.rect.h },
          portType: "expression",
          depth: node.depth + 1,
          priority: 0,
          rank: 0,
          visible: node.visible,
          ownerId: node.blockId,
          field: field.name,
        });
      }
    }
  }

  return targets;
}

/**
 * @param {string} targetId
 * @returns {{containerRef:string,anchorRef:string,portType:string,ownerId?:string,field?:string}|null}
 */
export function normalizeTargetId(targetId) {
  if (typeof targetId !== "string" || targetId.trim() === "") {
    return null;
  }
  const value = targetId.trim();
  if (value.startsWith("expr:")) {
    const body = value.slice(5);
    const dot = body.indexOf(".");
    if (dot <= 0 || dot === body.length - 1) {
      return null;
    }
    const ownerId = body.slice(0, dot);
    const field = body.slice(dot + 1);
    return { containerRef: `expr:${ownerId}`, anchorRef: field, portType: "expression", ownerId, field };
  }
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1) {
    return null;
  }
  const containerRef = value.slice(0, at);
  const anchorRef = value.slice(at + 1);
  if (anchorRef.startsWith("before:") || anchorRef === "end") {
    return null;
  }
  if (anchorRef !== "start" && !anchorRef.startsWith("after:")) {
    return null;
  }
  if (containerRef !== "root" && !containerRef.startsWith("body:")) {
    return null;
  }
  const portType = containerRef === "root" ? "statement-next" : "statement-body";
  return { containerRef, anchorRef, portType };
}

function pointInRect(point, rect, pad = 0) {
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.w + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.h + pad
  );
}

function gapOf(point, rect) {
  const dx = point.x < rect.x ? rect.x - point.x : point.x > rect.x + rect.w ? point.x - rect.x - rect.w : 0;
  const dy = point.y < rect.y ? rect.y - point.y : point.y > rect.y + rect.h ? point.y - rect.y - rect.h : 0;
  return { dx, dy, distance: Math.hypot(dx, dy) };
}

function insideCanvas(point, viewport) {
  const scrollY = viewport?.scrollY || 0;
  const w = viewport?.w || 720;
  const h = viewport?.h || 460;
  return point.x >= 0 && point.x <= w && point.y >= scrollY && point.y <= scrollY + h;
}

/**
 * @param {any} layout
 * @param {{x:number,y:number}} point
 * @param {{definition?:any,schema?:any,movingBlockId?:string|null,viewport?:any,exprSlotsEnabled?:boolean,isSelfNest?:(containerRef:string)=>boolean}} ctx
 */
export function resolveDropTarget(layout, point, ctx = {}) {
  const viewport = ctx.viewport || layout.viewport || { w: 720, h: 460, scrollY: 0 };
  if (!insideCanvas(point, viewport)) {
    return { valid: false, reason: "OUTSIDE_CANVAS", message: "", target: null, portType: null };
  }
  const targets = (layout.targets || []).filter((target) => target.visible);

  let candidates = targets
    .filter((target) => pointInRect(point, target.rect, HIT_PAD))
    .map((target) => ({ target, ...gapOf(point, target.rect) }));

  if (candidates.length === 0) {
    candidates = targets
      .map((target) => ({ target, ...gapOf(point, target.rect) }))
      .filter((item) => item.dx <= SNAP_X && item.dy <= SNAP_Y_MAX);
  }

  if (candidates.length === 0) {
    return {
      valid: false,
      reason: "NO_TARGET",
      message: "这里暂时放不了，试试拖到积木之间的空隙。",
      target: null,
      portType: null,
    };
  }

  candidates.sort((a, b) => {
    if (b.target.depth !== a.target.depth) {
      return b.target.depth - a.target.depth;
    }
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    return a.target.priority - b.target.priority;
  });

  const target = candidates[0].target;
  const portType = target.portType || portTypeOfTarget(target.id);
  const connection = canConnect(ctx.schema, ctx.definition, portType);
  if (!connection.ok) {
    return {
      valid: false,
      reason: connection.reason,
      message: connection.message,
      target,
      portType,
    };
  }
  const movingBlockId = ctx.movingBlockId || null;
  const containerRef = target.containerRef || "";
  const selfNest =
    Boolean(movingBlockId) &&
    (containerRef === movingBlockId ||
      (containerRef.startsWith("body:") && containerRef.slice(5) === movingBlockId) ||
      Boolean(ctx.isSelfNest?.(containerRef)));
  if (selfNest) {
    return {
      valid: false,
      reason: "SELF_NEST",
      message: "不能把积木放进它自己里面。",
      target,
      portType,
    };
  }
  return { valid: true, reason: null, message: "松手放到这里", target, portType };
}

/**
 * @param {any} layout
 * @param {any} definition
 * @param {any} schema
 */
export function hasPlaceableTarget(layout, definition, schema) {
  if (!definition) {
    return false;
  }
  for (const target of layout?.targets || []) {
    const connection = canConnect(schema, definition, target.portType || portTypeOfTarget(target.id));
    if (connection.ok) {
      return true;
    }
  }
  return false;
}

export { targetIdOf };