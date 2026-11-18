/** 逻辑坐标布局：绘制顺序、命中区域与放置目标共用同一份几何。 */

import { buildTargets } from "./targets.js";

export const LAYOUT = {
  WIDTH: 272,
  HEADER: 36,
  FIELD: 24,
  CAP: 12,
  GAP: 10,
  INDENT: 22,
  BODY_MIN: 34,
  BODY_PAD: 6,
  START_X: 30,
  START_Y: 26,
};

const DEFAULT_VIEWPORT = { w: 720, h: 460, scrollY: 0 };

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
  if (!root) {
    collector.slots.push({
      type: "root",
      x: LAYOUT.START_X,
      y: LAYOUT.START_Y,
      w: LAYOUT.WIDTH,
      h: 64,
    });
  } else {
    let y = LAYOUT.START_Y;
    let node = root;
    let guard = 0;
    while (node && guard < 200) {
      guard += 1;
      y = layoutBlock(node, LAYOUT.START_X, y, LAYOUT.WIDTH, 0, "root", definitions, collector);
      node = node.next;
    }
    height = y + 40;
  }

  for (const node of collector.nodes) {
    node.visible =
      node.rect.y + node.rect.h >= view.scrollY - 40 &&
      node.rect.y <= view.scrollY + view.h + 40 &&
      node.rect.x <= view.w + 40;
  }

  const drawOrder = [];
  for (const node of collector.nodes) {
    if (!node.visible) {
      continue;
    }
    if (node.isContainer) {
      drawOrder.push({ blockId: node.blockId, layer: "shell", depth: node.depth, order: node.order });
    }
    drawOrder.push({ blockId: node.blockId, layer: "block", depth: node.depth, order: node.order });
    drawOrder.push({ blockId: node.blockId, layer: "state", depth: node.depth, order: node.order });
  }
  drawOrder.sort((a, b) => {
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
    contentWidth: LAYOUT.WIDTH,
    viewport: view,
  };
  layout.targets = buildTargets(layout, { exprSlotsEnabled: false });
  return layout;
}

function layoutBlock(node, x, y, width, depth, ownerId, definitions, collector) {
  const definition = definitions.get(node.kind);
  const order = collector.order;
  collector.order += 1;

  if (!definition) {
    const unknownHeight = 48;
    collector.nodes.push({
      blockId: node.blockId,
      kind: node.kind,
      depth,
      ownerId,
      rect: { x, y, w: width, h: unknownHeight },
      layer: "block",
      order,
      visible: true,
      isContainer: false,
      parentBlockId: ownerId === "root" ? null : ownerId,
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
  const headerH = LAYOUT.HEADER + fieldDefinitions.length * LAYOUT.FIELD;
  const fields = [];

  fieldDefinitions.forEach((field, index) => {
    const fieldY = y + LAYOUT.HEADER + index * LAYOUT.FIELD + 2;
    const rect = {
      x: field.valueType === "expression" ? x + 84 : x + 12,
      y: fieldY,
      w: field.valueType === "expression" ? width - 96 : width - 24,
      h: LAYOUT.FIELD - 6,
    };
    fields.push({ ...field, rect });
    if (field.valueType === "expression") {
      collector.slots.push({
        type: "slot",
        ownerId: node.blockId,
        field: field.name,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        depth,
      });
    }
  });

  let bodyBox = null;
  let contentY = y + headerH;
  if (hasBody) {
    const childX = x + LAYOUT.INDENT;
    const childWidth = Math.max(120, width - LAYOUT.INDENT - 4);
    const childStartY = y + headerH + LAYOUT.BODY_PAD;
    let childY = childStartY;
    let child = node.body?.[0];
    let childGuard = 0;
    while (child && childGuard < 100) {
      childGuard += 1;
      childY = layoutBlock(child, childX, childY, childWidth, depth + 1, node.blockId, definitions, collector);
      child = child.next;
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
    rect: { x, y, w: width, h: height },
    layer: "block",
    order,
    visible: true,
    isContainer: hasBody,
    parentBlockId: ownerId === "root" ? null : ownerId,
    fields,
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