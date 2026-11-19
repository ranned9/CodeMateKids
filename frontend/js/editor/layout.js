/** 逻辑坐标布局：绘制顺序、命中区域与放置目标共用同一份几何。 */

import { buildTargets, EXPR_SLOTS_ENABLED } from "./targets.js";
import { bodyStatements, STACK_START, workspaceStacks } from "./model.js";
import { workspaceOwnerId } from "./workspace.js";

export const LAYOUT = {
  WIDTH: 272,
  HEADER: 36,
  FIELD: 24,
  CAP: 12,
  GAP: 10,
  INDENT: 22,
  BODY_MIN: 34,
  BODY_PAD: 6,
  START_X: STACK_START.x,
  START_Y: STACK_START.y,
};

const DEFAULT_VIEWPORT = { w: 720, h: 460, scrollX: 0, scrollY: 0 };

/**
 * @param {any} root
 * @param {Map<string, any>} definitions
 * @param {{w:number,h:number,scrollY:number}} [viewport]
 */
export function computeLayout(root, definitions, viewport = DEFAULT_VIEWPORT) {
  const view = { ...DEFAULT_VIEWPORT, ...(viewport || {}) };
  const collector = {
    nodes: [],
    sections: {},
    blocks: [],
    slots: [],
    order: 0,
  };
  let height = 180;
  const stacks = workspaceStacks(root);
  if (!stacks.length) {
    collector.slots.push({
      type: "root",
      x: LAYOUT.START_X,
      y: LAYOUT.START_Y,
      w: LAYOUT.WIDTH,
      h: 64,
    });
  } else {
    for (const [group, stack] of stacks.entries()) {
      let y = stack.y;
      collector.group = group;
      collector.order = 0;
      for (const node of bodyStatements([stack.root])) {
        y = layoutBlock(node, stack.x, y, LAYOUT.WIDTH, 0, workspaceOwnerId(root, stack), definitions, collector);
      }
      height = Math.max(height, y + 40);
    }
  }

  let contentWidth = LAYOUT.WIDTH;
  for (const node of collector.nodes) {
    contentWidth = Math.max(contentWidth, node.rect.x + node.rect.w);
    node.visible =
      node.rect.y + node.rect.h >= view.scrollY - 40 &&
      node.rect.y <= view.scrollY + view.h + 40 &&
      node.rect.x + node.rect.w >= view.scrollX - 40 &&
      node.rect.x <= view.scrollX + view.w + 40;
  }

  const drawOrder = [];
  for (const node of collector.nodes) {
    if (!node.visible) {
      continue;
    }
    if (node.isContainer) {
      drawOrder.push({ blockId: node.blockId, layer: "shell", depth: node.depth, order: node.order, group: node.group });
    }
    drawOrder.push({ blockId: node.blockId, layer: "block", depth: node.depth, order: node.order, group: node.group });
    drawOrder.push({ blockId: node.blockId, layer: "state", depth: node.depth, order: node.order, group: node.group });
  }
  drawOrder.sort((a, b) => {
    if (a.group !== b.group) {
      return a.group - b.group;
    }
    const rank = { shell: 0, block: 1, state: 2 };
    if (rank[a.layer] !== rank[b.layer]) {
      return rank[a.layer] - rank[b.layer];
    }
    if (a.depth !== b.depth) {
      return a.depth - b.depth;
    }
    return a.order - b.order;
  });

  const layout = {
    nodes: collector.nodes,
    drawOrder,
    sections: collector.sections,
    targets: [],
    blocks: collector.blocks,
    slots: collector.slots,
    height,
    contentWidth,
    viewport: view,
  };
  layout.targets = buildTargets(layout, { exprSlotsEnabled: EXPR_SLOTS_ENABLED });
  return layout;
}

function layoutBlock(node, x, y, width, depth, ownerId, definitions, collector) {
  const definition = definitions.get(node.kind);
  const parentBlockId = depth === 0 ? null : ownerId.replace(/^expr:/, "");
  const order = collector.order;
  collector.order += 1;

  if (!definition) {
    const unknownHeight = 48;
    collector.nodes.push({
      blockId: node.blockId,
      kind: node.kind,
      depth,
      ownerId,
      group: collector.group,
      rect: { x, y, w: width, h: unknownHeight },
      layer: "block",
      order,
      visible: true,
      isContainer: false,
      parentBlockId,
      fields: [],
      portMarks: [],
      unknown: true,
    });
    collector.sections[node.blockId] = {
      header: { x, y, w: width, h: unknownHeight },
      bodyBox: null,
      foot: { x, y: y + unknownHeight, w: width, h: 0 },
      outline: null,
    };
    collector.blocks.push({
      node,
      def: null,
      depth,
      x,
      y,
      w: width,
      h: unknownHeight,
      headerH: unknownHeight,
      fields: [],
      bodyArea: null,
      unknown: true,
    });
    collector.slots.push({ type: "next", ownerId: node.blockId, x, y: y + 44, w: width, h: 12, depth });
    return y + unknownHeight + LAYOUT.GAP;
  }

  const ports = definition.ports || [];
  const hasBody = ports.some((port) => port.portType === "statement-body");
  const hasNext = ports.some((port) => port.portType === "statement-next");
  const fieldDefinitions = definition.fields || [];
  let fieldY = y + LAYOUT.HEADER;
  const fields = [];

  for (const field of fieldDefinitions) {
    const value = node.inputs?.[field.name];
    const nestedValue = Boolean(value && typeof value === "object");
    const inlineNumber = (node.kind === "value.number" && field.name === "value")
      || (field.acceptsNumberBlock && !nestedValue);
    const rect = {
      x: x + 12,
      y: fieldY + 2,
      w: width - 24,
      h: inlineNumber ? 30 : LAYOUT.FIELD - 6,
    };
    if (field.valueType === "expression" || (field.acceptsNumberBlock && nestedValue)) {
      const inset = Math.min(12, Math.max(0, (width - 120) / 2));
      rect.x = x + inset;
      rect.w = width - 2 * inset;
      rect.y = fieldY + 17;
      rect.h = 23;
      if (nestedValue) {
        const childBottom = layoutBlock(
          value, rect.x, rect.y, rect.w, depth + 1, `expr:${node.blockId}`, definitions, collector,
        );
        rect.h = childBottom - LAYOUT.GAP - rect.y;
      }
    }
    if (field.valueType === "expression" || field.acceptsNumberBlock) {
      collector.slots.push({ type: "slot", ownerId: node.blockId, field: field.name, ...rect, depth });
    }
    fields.push({ ...field, rect, nestedValue, inlineNumber });
    fieldY = rect.y + rect.h + 4;
  }
  const headerH = fieldY - y;

  let bodyBox = null;
  let contentY = y + headerH;
  if (hasBody) {
    const childX = x + LAYOUT.INDENT;
    const childWidth = Math.max(120, width - LAYOUT.INDENT - 4);
    const childStartY = y + headerH + LAYOUT.BODY_PAD;
    let childY = childStartY;
    for (const child of bodyStatements(node.body)) {
      childY = layoutBlock(child, childX, childY, childWidth, depth + 1, node.blockId, definitions, collector);
    }
    const bodyHeight = Math.max(LAYOUT.BODY_MIN, childY - childStartY);
    contentY = childStartY + bodyHeight;
    bodyBox = {
      x: childX - LAYOUT.BODY_PAD,
      y: y + headerH,
      w: width - LAYOUT.INDENT + 4,
      h: contentY - (y + headerH),
    };
    collector.slots.push({
      type: "body",
      ownerId: node.blockId,
      x: bodyBox.x,
      y: bodyBox.y,
      w: bodyBox.w,
      h: bodyBox.h,
      depth,
    });
  }

  const footY = contentY;
  const height = footY + LAYOUT.CAP - y;
  const foot = { x, y: footY, w: width, h: LAYOUT.CAP };
  const header = { x, y, w: width, h: headerH };
  const outline = hasBody
    ? [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: footY },
        { x: x + width - LAYOUT.CAP, y: footY },
        { x: x + width - LAYOUT.CAP, y: y + headerH },
        { x: x + LAYOUT.INDENT - LAYOUT.BODY_PAD, y: y + headerH },
        { x: x + LAYOUT.INDENT - LAYOUT.BODY_PAD, y: footY },
        { x, y: footY },
      ]
    : null;

  collector.sections[node.blockId] = {
    header,
    bodyBox,
    foot,
    outline,
  };
  collector.nodes.push({
    blockId: node.blockId,
    kind: node.kind,
    depth,
    ownerId,
    group: collector.group,
    outputType: definition.outputType,
    rect: { x, y, w: width, h: height },
    layer: "block",
    order,
    visible: true,
    isContainer: hasBody,
    parentBlockId,
    fields,
    inputs: node.inputs,
    hasBodyChildren: Boolean(node.body?.length),
    portMarks: ports.map((port) => ({ portType: port.portType })),
    unknown: false,
  });
  collector.blocks.push({
    node,
    def: definition,
    depth,
    x,
    y,
    w: width,
    h: height,
    headerH,
    fields,
    bodyArea: bodyBox,
    unknown: false,
  });
  if (hasNext) {
    collector.slots.push({
      type: "next",
      ownerId: node.blockId,
      x,
      y: y + height - 4,
      w: width,
      h: 14,
      depth,
    });
  }
  return y + height + LAYOUT.GAP;
}

export function findSlotAt(slots, point, radius = 24) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const centerX = slot.x + slot.w / 2;
    const centerY = slot.y + slot.h / 2;
    const inside =
      point.x >= slot.x - radius &&
      point.x <= slot.x + slot.w + radius &&
      point.y >= slot.y - radius &&
      point.y <= slot.y + slot.h + radius;
    if (!inside) {
      continue;
    }
    const distance = Math.hypot(point.x - centerX, point.y - centerY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }
  return best;
}

/**
 * 最深可见命中：先取 node.rect 内的最深节点，再按区域细化。
 * @param {any} layout
 * @param {{x:number,y:number}} point
 */
export function pickNode(layout, point) {
  const candidates = (layout?.nodes || []).filter(
    (node) =>
      node.visible &&
      point.x >= node.rect.x &&
      point.x <= node.rect.x + node.rect.w &&
      point.y >= node.rect.y &&
      point.y <= node.rect.y + node.rect.h,
  );
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    if (a.group !== b.group) {
      return b.group - a.group;
    }
    if (b.depth !== a.depth) {
      return b.depth - a.depth;
    }
    if (b.order !== a.order) {
      return b.order - a.order;
    }
    return 0;
  });
  return candidates[0];
}

/**
 * @deprecated 使用 pickNode()。
 */
export function findBlockAt(blocks, point) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      point.x >= block.x &&
      point.x <= block.x + block.w &&
      point.y >= block.y &&
      point.y <= block.y + block.h
    ) {
      return block;
    }
  }
  return null;
}
