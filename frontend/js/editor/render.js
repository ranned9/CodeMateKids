/** Canvas 2D 渲染：外壳/积木/状态分层，插入线与容器高亮。 */
import { computeLayout, numberControlRect } from "./layout.js";
import { createBlock } from "./model.js";

const PREVIEW_WIDTH = 144;
const previewCache = new WeakMap();

function blockPreview(definition, numberValue) {
  if (numberValue === undefined && previewCache.has(definition)) {
    return previewCache.get(definition);
  }
  const root = createBlock(definition, "preview");
  if (definition.kind === "value.number" && numberValue !== undefined) {
    root.inputs.value = numberValue;
  }
  const definitions = new Map([[definition.kind, definition]]);
  const layout = computeLayout([{ x: 0, y: 0, root }], definitions, { blockWidth: PREVIEW_WIDTH });
  const node = layout.nodes[0];
  const preview = { node, layout, view: { definitions } };
  if (numberValue === undefined) {
    previewCache.set(definition, preview);
  }
  return preview;
}

function paintBlock(ctx, node, layout, view) {
  const section = layout.sections[node.blockId];
  drawContainerShell(ctx, node, section, view);
  drawBlockLayer(ctx, node, section, view);
}

export function drawToolboxBlock(canvas, definition) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { node, layout, view } = blockPreview(definition);
  const padding = 6;
  const ratio = globalThis.devicePixelRatio || 1;
  const width = node.rect.w + padding * 2;
  const height = node.rect.h + padding * 2;
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(height * ratio);
  canvas.style.width = `calc(${width}px * var(--block-scale, 1))`;
  canvas.style.aspectRatio = `${width} / ${height}`;
  ctx.setTransform(ratio, 0, 0, ratio, padding * ratio, padding * ratio);
  paintBlock(ctx, node, layout, view);
  return true;
}

const COLORS = {
  event: { fill: "#2f7f78", stroke: "#25635e", text: "#ffffff" },
  control: { fill: "#c4782b", stroke: "#9c5d1c", text: "#ffffff" },
  motion: { fill: "#496dbe", stroke: "#36549b", text: "#ffffff" },
  look: { fill: "#6b5bb5", stroke: "#52449a", text: "#ffffff" },
  text: { fill: "#3f8f6f", stroke: "#307257", text: "#ffffff" },
  value: { fill: "#4f9a5f", stroke: "#3a7848", text: "#ffffff" },
  unknown: { fill: "#9aa2b1", stroke: "#6f7787", text: "#ffffff" },
};

function paletteFor(def) {
  if (!def) {
    return COLORS.unknown;
  }
  if (def.kind.startsWith("event.")) return COLORS.event;
  if (def.kind.startsWith("control.")) return COLORS.control;
  if (def.kind.startsWith("motion.")) return COLORS.motion;
  if (def.kind.startsWith("look.")) return COLORS.look;
  if (def.kind.startsWith("text.")) return COLORS.text;
  return COLORS.value;
}

function roundRect(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncate(text, maxChars) {
  const value = String(text ?? "");
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function fieldValueText(node, field) {
  const value = node.inputs?.[field.name];
  if (value === "" || value == null) {
    return "待填写";
  }
  return String(value);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} layout
 * @param {any} view
 */
export function drawScene(ctx, layout, view) {
  const { width, height } = view;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fdfefe";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#eef2f8";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 26) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 26) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(-(view.scrollX || 0), -(view.scrollY || 0));
  if (Array.isArray(layout.nodes) && layout.drawOrder?.length) {
    const byId = new Map(layout.nodes.map((node) => [node.blockId, node]));
    const preview = view.previewLayer;
    const movingHead = preview?.freePosition && byId.get(preview.blockId);
    const movingIds = movingHead ? preview.movingIds : null;
    for (const item of layout.drawOrder) {
      if (!movingIds?.has(item.blockId)) {
        drawLayer(ctx, item, byId.get(item.blockId), layout, view);
      }
    }
    if (movingHead) {
      ctx.save();
      ctx.translate(preview.x - movingHead.rect.x, preview.y - movingHead.rect.y);
      for (const item of layout.drawOrder) {
        if (movingIds.has(item.blockId)) {
          drawLayer(ctx, item, byId.get(item.blockId), layout, view);
        }
      }
      ctx.restore();
    }
  } else {
    for (const block of layout.blocks || []) {
      drawLegacyBlock(ctx, block, view);
    }
  }
  if (view.previewLayer) {
    drawPreview(ctx, view.previewLayer, layout, view);
  }
  ctx.restore();
}

function drawLayer(ctx, item, node, layout, view) {
  const section = layout.sections?.[node.blockId];
  if (item.layer === "shell") {
    drawContainerShell(ctx, node, section, view);
  } else if (item.layer === "block") {
    drawBlockLayer(ctx, node, section, view);
  } else {
    drawStateMarks(ctx, node, section, view);
  }
}

function nodeDef(node, view) {
  return view.definitions?.get?.(node.kind) || null;
}

function drawContainerShell(ctx, node, section, view) {
  if (!section?.bodyBox) {
    return;
  }
  const def = nodeDef(node, view);
  const palette = paletteFor(def);
  const body = section.bodyBox;
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = palette.fill;
  roundRect(ctx, body.x, body.y, body.w, body.h, 8);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = palette.fill;
  const wallWidth = Math.max(10, body.x - section.header.x);
  ctx.fillRect(section.header.x, body.y, wallWidth, body.h);
  ctx.fillRect(section.header.x, section.foot.y, node.rect.w, section.foot.h);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(section.header.x + wallWidth - 2, body.y + 2, 2, Math.max(0, body.h - 4));
}

function drawBlockLayer(ctx, node, section, view) {
  const def = nodeDef(node, view);
  const palette = paletteFor(def);
  const isUnknown = node.unknown;
  const fill = isUnknown ? COLORS.unknown.fill : palette.fill;
  const stroke = isUnknown ? COLORS.unknown.stroke : palette.stroke;

  ctx.save();
  if (node.isContainer && section?.header) {
    ctx.shadowColor = "rgba(34, 55, 96, 0.16)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    roundRect(ctx, section.header.x, section.header.y, section.header.w, section.header.h, 10);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = fill;
    ctx.fillRect(section.header.x, section.header.y + section.header.h - 10, section.header.w, 10);
  } else {
    ctx.shadowColor = "rgba(34, 55, 96, 0.16)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    roundRect(ctx, node.rect.x, node.rect.y, node.rect.w, node.rect.h, 10);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  if (node.isContainer && section?.header) {
    roundRect(ctx, section.header.x, section.header.y, section.header.w, section.header.h, 10);
    ctx.stroke();
  } else {
    roundRect(ctx, node.rect.x, node.rect.y, node.rect.w, node.rect.h, 10);
    ctx.stroke();
  }

  ctx.fillStyle = palette.text;
  ctx.font = "700 15px 'Microsoft YaHei UI', sans-serif";
  ctx.fillText(truncate(def?.displayName || "未知积木", 10), node.rect.x + 12, node.rect.y + 22, node.rect.w - 24);
  if (isUnknown) {
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = "700 11px 'Microsoft YaHei UI', sans-serif";
    ctx.fillText("不可执行", node.rect.x + node.rect.w - 62, node.rect.y + 20);
  }

  for (const field of node.fields || []) {
    drawField(ctx, node, field, view);
  }

  if ((def?.ports || []).some((port) => port.portType === "statement-next")) {
    roundRect(ctx, node.rect.x + node.rect.w / 2 - 14, node.rect.y + node.rect.h - 5, 28, 10, 5);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fill();
  }

  if (node.isContainer && section?.bodyBox && !node.hasBodyChildren) {
    ctx.save();
    ctx.fillStyle = "rgba(47, 64, 94, 0.72)";
    ctx.font = "12px 'Microsoft YaHei UI', sans-serif";
    ctx.fillText("把要重复的动作拖进来", section.bodyBox.x + 10, section.bodyBox.y + 24, section.bodyBox.w - 42);
    ctx.strokeStyle = "rgba(47, 64, 94, 0.5)";
    ctx.lineWidth = 2;
    const arrowX = section.bodyBox.x + section.bodyBox.w - 22;
    const arrowY = section.bodyBox.y + 14;
    ctx.beginPath();
    ctx.moveTo(arrowX, arrowY);
    ctx.lineTo(arrowX, arrowY + 10);
    ctx.moveTo(arrowX - 4, arrowY + 6);
    ctx.lineTo(arrowX, arrowY + 10);
    ctx.lineTo(arrowX + 4, arrowY + 6);
    ctx.stroke();
    ctx.restore();
  }
}

function drawField(ctx, node, field, view) {
  if (field.valueType === "expression" || (field.acceptsNumberBlock && field.nestedValue)) {
    const { x, y, w, h } = field.rect;
    ctx.font = "11px 'Microsoft YaHei UI', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(String(field.label || field.name), x + 6, y - 4);
    if (!node.inputs?.[field.name]) {
      roundRect(ctx, x, y, w, h, 8);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.65)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillText("放一个数值积木", x + 8, y + 15);
    }
    return;
  }
  ctx.fillStyle = "rgba(255,255,255,0.24)";
  roundRect(ctx, field.rect.x, field.rect.y, field.rect.w, field.rect.h, 6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "11px 'Microsoft YaHei UI', sans-serif";
  const baseline = field.rect.y + (field.inlineNumber ? 19 : 12);
  ctx.fillText(String(field.label || field.name), field.rect.x + 6, baseline);
  if (field.inlineNumber) {
    if (!view.numberControls?.has(node.blockId)) {
      drawNumberControl(ctx, field.rect, fieldValueText(node, field));
    }
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 13px 'Microsoft YaHei UI', sans-serif";
    ctx.fillText(truncate(fieldValueText(node, field), 14), field.rect.x + 46, baseline + 1, field.rect.w - 52);
  }
  if (view.editable && field.rect.w >= 212 && (field.valueType === "choice" || field.acceptsNumberBlock)) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "10px 'Microsoft YaHei UI', sans-serif";
    const hint = field.acceptsNumberBlock ? "可拖入数字" : "点击更换";
    ctx.fillText(hint, field.rect.x + field.rect.w - ctx.measureText(hint).width - 5, baseline);
  }
}

function drawNumberControl(ctx, fieldRect, value) {
  const { x, y, w, h } = numberControlRect(fieldRect);
  ctx.save();
  roundRect(ctx, x, y, w, h, 6);
  ctx.clip();
  ctx.fillStyle = "#eaf0fa";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + w / 4, y, w / 2, h);
  ctx.fillStyle = "#253653";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 14px 'Microsoft YaHei UI', sans-serif";
  ctx.fillText("−", x + w / 8, y + h / 2);
  ctx.fillText(value, x + w / 2, y + h / 2, w / 2 - 4);
  ctx.fillText("+", x + w * 7 / 8, y + h / 2);
  ctx.restore();
}

function drawStateMarks(ctx, node, section, view) {
  const selected = view.selectedId === node.blockId;
  const running = view.runningId === node.blockId;
  const error = view.errorId === node.blockId;
  const invalid = view.invalidIds?.has(node.blockId);

  if (running) {
    drawRunningMark(ctx, section?.header || node.rect);
  } else if (selected || error || invalid) {
    ctx.save();
    ctx.strokeStyle = selected ? "#1b3f9e" : error ? "#ff6b6b" : "#ffd08a";
    ctx.lineWidth = selected ? 3 : 2.5;
    if (!selected) ctx.setLineDash([6, 4]);
    if (node.isContainer && section?.outline) {
      ctx.beginPath();
      for (const [index, { x, y }] of section.outline.entries()) {
        if (index === 0) {
          ctx.moveTo(x - 2, y - 2);
        } else {
          ctx.lineTo(x - 2, y - 2);
        }
      }
      ctx.closePath();
    } else {
      roundRect(ctx, node.rect.x - 2, node.rect.y - 2, node.rect.w + 4, node.rect.h + 4, 12);
    }
    ctx.stroke();
    ctx.restore();
  }
  if (error || invalid) {
    ctx.fillStyle = error ? "#7c2622" : "#7a4b00";
    ctx.font = "700 12px 'Microsoft YaHei UI', sans-serif";
    ctx.fillText(
      error ? "! 出错了" : "! 需要填写",
      node.rect.x + node.rect.w - 70,
      node.rect.y + (node.isContainer ? section.header.h - 4 : node.rect.h - 6),
    );
  }
}

function drawRunningMark(ctx, { x, y, w, h }) {
  const gold = "#ffe45c";
  const dark = "#3b2800";
  ctx.save();
  roundRect(ctx, x + 3, y + 3, w - 6, h - 6, 8);
  ctx.strokeStyle = dark;
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.strokeStyle = gold;
  ctx.lineWidth = 4;
  ctx.stroke();

  const badgeX = x + w - 66;
  const badgeY = y + 8;
  roundRect(ctx, badgeX, badgeY, 58, 18, 9);
  ctx.fillStyle = gold;
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.font = "700 11px 'Microsoft YaHei UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("▶ 运行中", badgeX + 29, badgeY + 9);
  ctx.restore();
}

function drawLegacyBlock(ctx, block, view) {
  if (!block) {
    return;
  }
  const def = block.def;
  const palette = paletteFor(def);
  ctx.save();
  roundRect(ctx, block.x, block.y, block.w, block.h, 10);
  ctx.fillStyle = block.unknown ? COLORS.unknown.fill : palette.fill;
  ctx.fill();
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = palette.text;
  ctx.font = "700 15px 'Microsoft YaHei UI', sans-serif";
  ctx.fillText(truncate(block.def?.displayName || "未知积木", 10), block.x + 12, block.y + 22);
}

function drawPreview(ctx, preview, layout, view) {
  const target = preview.target;
  const valid = preview.valid;
  const accent = valid ? "#2f9e63" : "#d9534f";
  const visual = target?.visual;

  if (preview.kind && !(preview.freePosition && preview.blockId)) {
    const definition = view.definitions.get(preview.kind);
    const existing = layout.nodes?.find((node) => node.blockId === preview.blockId);
    if (definition) {
      const artwork = existing ? { node: existing, layout, view } : blockPreview(definition, preview.numberValue);
      ctx.save();
      ctx.translate(preview.x - artwork.node.rect.x, preview.y - artwork.node.rect.y);
      ctx.globalAlpha = 0.87;
      paintBlock(ctx, artwork.node, artwork.layout, artwork.view);
      ctx.restore();
    }
  }

  if (visual?.containerId) {
    const section = layout.sections?.[visual.containerId];
    if (section?.outline) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      section.outline.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  if (visual?.type === "rect") {
    ctx.save();
    ctx.setLineDash(valid ? [6, 4] : [2, 3]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    roundRect(ctx, visual.x - 2, visual.y - 2, visual.w + 4, visual.h + 4, 8);
    ctx.stroke();
    ctx.restore();
  } else if (visual?.type === "line") {
    drawInsertLine(ctx, visual, accent, valid);
    if (!valid) {
      drawInvalidBadge(ctx, visual.x + visual.w - 6, visual.y - 10);
    }
  }

  if (preview.message) {
    const text = truncate(preview.message, 24);
    ctx.save();
    ctx.font = "12px 'Microsoft YaHei UI', sans-serif";
    const textWidth = ctx.measureText(text).width;
    const boxW = Math.min(textWidth + 20, view.width - 16);
    const scrollX = view.scrollX || 0;
    const scrollY = view.scrollY || 0;
    const boxX = scrollX + Math.min(Math.max(preview.x - scrollX - 10, 8), Math.max(8, view.width - boxW - 8));
    const boxY = Math.min(preview.y + 50, scrollY + view.height - 34);
    roundRect(ctx, boxX, boxY, boxW, 24, 8);
    ctx.fillStyle = valid ? "#e8f7f0" : "#fdeceb";
    ctx.fill();
    ctx.strokeStyle = valid ? "#bfe6d6" : "#f3c7c5";
    ctx.stroke();
    ctx.fillStyle = valid ? "#17795e" : "#b3342f";
    ctx.fillText(text, boxX + 10, boxY + 16);
    ctx.restore();
  }
}

function drawInsertLine(ctx, visual, color, valid) {
  const length = Math.max(24, visual.w - 24);
  const startX = visual.x + 12;
  const y = visual.y;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(valid ? [] : [2, 3]);
  ctx.beginPath();
  ctx.moveTo(startX, y);
  ctx.lineTo(startX + length, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  roundRect(ctx, startX - 3, y - 3, 6, 6, 2);
  ctx.fill();
  roundRect(ctx, startX + length - 3, y - 3, 6, 6, 2);
  ctx.fill();
  ctx.restore();
}

function drawInvalidBadge(ctx, x, y) {
  ctx.save();
  ctx.strokeStyle = "#d9534f";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 5);
  ctx.lineTo(x + 5, y + 5);
  ctx.moveTo(x + 5, y - 5);
  ctx.lineTo(x - 5, y + 5);
  ctx.stroke();
  ctx.restore();
}
