/** Canvas 2D 渲染：外壳/积木/状态分层，插入线与容器高亮。 */
import { computeLayout, fieldControlRect, LAYOUT } from "./layout.js";
import { createBlock } from "./model.js";
import { fieldChoiceText } from "./number-controls.js";

const PREVIEW_WIDTH = 144;
const BLOCK_RADIUS = 10;
const CONNECTOR_OFFSET = 30;
const SOCKET_DEPTH = 6;
const TAB_DEPTH = 8;
const ART_PADDING = TAB_DEPTH + 2;
const toolboxPreviews = new WeakMap();
const canvasPreviews = new WeakMap();

function blockPreview(definition, blockWidth, numberValue) {
  const cache = blockWidth === PREVIEW_WIDTH ? toolboxPreviews : canvasPreviews;
  if (numberValue === undefined && cache.has(definition)) {
    return cache.get(definition);
  }
  const root = createBlock(definition, "preview");
  if (definition.kind === "value.number" && numberValue !== undefined) {
    root.inputs.value = numberValue;
  }
  const definitions = new Map([[definition.kind, definition]]);
  const layout = computeLayout([{ x: 0, y: 0, root }], definitions, { blockWidth });
  const node = layout.nodes[0];
  const preview = { node, layout, view: { definitions } };
  if (numberValue === undefined) {
    cache.set(definition, preview);
  }
  return preview;
}

export function toolboxDropSize(definition) {
  const { w, h } = blockPreview(definition, LAYOUT.WIDTH).node.rect;
  return { w, h };
}

function paintBlock(ctx, node, layout, view) {
  const section = layout.sections[node.blockId];
  drawContainerShell(ctx, node, section, view);
  drawBlockLayer(ctx, node, section, view);
}

export function drawToolboxBlock(canvas, definition) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { node, layout, view } = blockPreview(definition, PREVIEW_WIDTH);
  const padding = ART_PADDING;
  const ratio = globalThis.devicePixelRatio || 1;
  const width = node.rect.w + padding * 2;
  const height = node.rect.h + padding * 2;
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(height * ratio);
  canvas.style.width = `calc(${width * 0.8}px * var(--block-scale, 1))`;
  canvas.style.aspectRatio = `${width} / ${height}`;
  ctx.setTransform(ratio, 0, 0, ratio, padding * ratio, padding * ratio);
  paintBlock(ctx, node, layout, view);
  return { insetX: padding / width, insetY: padding / height };
}

/**
 * 为拖动浮层生成积木图像，复用既有积木画法（单一绘制来源，不另起外观实现）。
 * spec 两种形态之一：
 * - 单块：{definition, numberValue?}——用画布宽度排版，与放置后的积木一致。
 * - 整组：{layout, ids, definitions}——从当前布局按 ids 包围盒裁剪绘制集并对齐原点（0,0）。
 * 底部留出凸榫空间，抓取位置仍按积木本体的布局尺寸计算。
 * 绘制异常（spec 非法、layout 无效、canvas 不可用）返回 false 不抛出；成功返回 true。
 * 无拖动状态依赖：输入全部来自参数。
 * @param {any} canvas
 * @param {any} spec
 * @returns {boolean}
 */
export function drawOverlayImage(canvas, spec) {
  try {
    const ctx = canvas?.getContext?.("2d");
    if (!ctx || !spec || typeof spec !== "object") {
      return false;
    }
    const ratio = globalThis.devicePixelRatio || 1;
    if (spec.definition && spec.definition.kind) {
      const { node, layout, view } = blockPreview(spec.definition, LAYOUT.WIDTH, spec.numberValue);
      canvas.width = Math.ceil(node.rect.w * ratio);
      canvas.height = Math.ceil((node.rect.h + ART_PADDING) * ratio);
      canvas.style.height = `${100 * (1 + ART_PADDING / node.rect.h)}%`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintBlock(ctx, node, layout, view);
      return true;
    }
    if (spec.layout && spec.ids instanceof Set && Array.isArray(spec.layout.nodes)) {
      const byId = new Map(spec.layout.nodes.map((node) => [node.blockId, node]));
      const selected = spec.layout.nodes.filter((node) => spec.ids.has(node.blockId));
      if (selected.length === 0) {
        return false;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of selected) {
        minX = Math.min(minX, node.rect.x);
        minY = Math.min(minY, node.rect.y);
        maxX = Math.max(maxX, node.rect.x + node.rect.w);
        maxY = Math.max(maxY, node.rect.y + node.rect.h);
      }
      const width = maxX - minX;
      const height = maxY - minY;
      if (!(width > 0 && height > 0)) {
        return false;
      }
      const view = { definitions: spec.definitions };
      canvas.width = Math.ceil(width * ratio);
      canvas.height = Math.ceil((height + ART_PADDING) * ratio);
      canvas.style.height = `${100 * (1 + ART_PADDING / height)}%`;
      ctx.setTransform(ratio, 0, 0, ratio, -minX * ratio, -minY * ratio);
      for (const item of spec.layout.drawOrder || []) {
        // 浮层图像只画外壳与积木层（state 层是画布上的选中/运行标记，不属于积木外观）。
        if (item.layer !== "state" && spec.ids.has(item.blockId)) {
          drawLayer(ctx, item, byId.get(item.blockId), spec.layout, view);
        }
      }
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

const COLORS = {
  event: { fill: "#2f7f78", stroke: "#25635e", text: "#ffffff" },
  control: { fill: "#c4782b", stroke: "#9c5d1c", text: "#ffffff" },
  branch: { fill: "#7257a8", stroke: "#533c84", text: "#ffffff" },
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
  if (def.kind === "control.if" || def.kind === "control.else") return COLORS.branch;
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

function traceConnector(ctx, center, y, direction, depth) {
  const start = center - direction * 12;
  const end = center + direction * 12;
  ctx.arcTo(start, y, start + direction * 4, y + depth, 3);
  ctx.arcTo(start + direction * 4, y + depth, end - direction * 4, y + depth, 3);
  ctx.arcTo(end - direction * 4, y + depth, end, y, 3);
  ctx.arcTo(end, y, end + direction * 4, y, 3);
}

function traceBlock(ctx, node, section) {
  const { x, y, w, h } = node.rect;
  if (node.outputType !== "statement") {
    roundRect(ctx, x, y, w, h, BLOCK_RADIUS);
    return;
  }
  const right = x + w;
  const bottom = y + h;
  const center = x + CONNECTOR_OFFSET;
  const body = section?.bodyBox;
  const footRadius = body ? section.foot.h / 2 : BLOCK_RADIUS;
  ctx.beginPath();
  ctx.moveTo(x + BLOCK_RADIUS, y);
  if (node.kind !== "event.start") {
    traceConnector(ctx, center, y, 1, SOCKET_DEPTH);
  }
  ctx.arcTo(right, y, right, y + BLOCK_RADIUS, BLOCK_RADIUS);

  if (body) {
    const footY = section.foot.y;
    const childCenter = x + LAYOUT.INDENT + CONNECTOR_OFFSET;
    ctx.arcTo(right, body.y, body.x, body.y, BLOCK_RADIUS);
    traceConnector(ctx, childCenter, body.y, -1, TAB_DEPTH);
    ctx.arcTo(body.x, body.y, body.x, footY, 5);
    ctx.arcTo(body.x, footY, right, footY, 5);
    traceConnector(ctx, childCenter, footY, 1, SOCKET_DEPTH);
    ctx.arcTo(right, footY, right, bottom, footRadius);
  }
  ctx.arcTo(right, bottom, x, bottom, footRadius);
  if (node.portMarks?.some((port) => port.portType === "statement-next")) {
    traceConnector(ctx, center, bottom, -1, TAB_DEPTH);
  }
  ctx.arcTo(x, bottom, x, y, footRadius);
  ctx.arcTo(x, y, x + BLOCK_RADIUS, y, BLOCK_RADIUS);
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
    for (const item of layout.drawOrder) {
      if (!view.hiddenBlockIds?.has(item.blockId)) {
        drawLayer(ctx, item, byId.get(item.blockId), layout, view);
      }
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
  roundRect(ctx, body.x - 3, body.y - 3, body.w + 3, body.h + 6, 8);
  ctx.fill();
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawBlockLayer(ctx, node, section, view) {
  const def = nodeDef(node, view);
  const palette = paletteFor(def);
  const isUnknown = node.unknown;
  const fill = isUnknown ? COLORS.unknown.fill : palette.fill;
  const stroke = isUnknown ? COLORS.unknown.stroke : palette.stroke;

  traceBlock(ctx, node, section);
  ctx.save();
  ctx.shadowColor = "rgba(34, 55, 96, 0.18)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = palette.text;
  ctx.font = "700 15px 'Microsoft YaHei UI', sans-serif";
  if (node.labels) {
    for (const [text, offset] of node.labels) {
      ctx.fillText(text, node.rect.x + offset, node.rect.y + 22);
    }
  } else {
    ctx.fillText(truncate(def?.displayName || "未知积木", 10), node.rect.x + 12, node.rect.y + 22, node.rect.w - 24);
  }
  if (isUnknown) {
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = "700 11px 'Microsoft YaHei UI', sans-serif";
    ctx.fillText("不可执行", node.rect.x + node.rect.w - 62, node.rect.y + 20);
  }

  for (const field of node.fields || []) {
    drawField(ctx, node, field, view);
  }

  if (node.isContainer && section?.bodyBox && !node.hasBodyChildren) {
    ctx.save();
    ctx.fillStyle = "rgba(47, 64, 94, 0.72)";
    ctx.font = "12px 'Microsoft YaHei UI', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("拖入动作", section.bodyBox.x + 9, section.bodyBox.y + section.bodyBox.h / 2, section.bodyBox.w - 18);
    ctx.restore();
  }
}

function drawField(ctx, node, field, view) {
  if (field.inHeader) {
    if (!field.nestedValue && !view.fieldControls?.has(field)) {
      const choice = field.valueType === "choice";
      const value = choice ? fieldChoiceText(field, node.inputs?.[field.name]) : fieldValueText(node, field);
      drawValuePill(ctx, field.rect, value, choice);
    }
    return;
  }
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
    if (!view.fieldControls?.has(field)) {
      drawValuePill(ctx, fieldControlRect(field), fieldValueText(node, field));
    }
  } else {
    const labelWidth = ctx.measureText(String(field.label || field.name)).width;
    const valueOffset = Math.max(46, labelWidth + 14);
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 13px 'Microsoft YaHei UI', sans-serif";
    ctx.fillText(truncate(fieldValueText(node, field), 14), field.rect.x + valueOffset, baseline + 1, field.rect.w - valueOffset - 6);
  }
  if (view.editable && field.rect.w >= 212 && (field.valueType === "choice" || field.acceptsNumberBlock)) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "10px 'Microsoft YaHei UI', sans-serif";
    const hint = field.acceptsNumberBlock ? "可拖入数字" : "点击更换";
    ctx.fillText(hint, field.rect.x + field.rect.w - ctx.measureText(hint).width - 5, baseline);
  }
}

function drawValuePill(ctx, { x, y, w, h }, value, choice = false) {
  ctx.save();
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.fillStyle = "#253653";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 14px 'Microsoft YaHei UI', sans-serif";
  const centerY = y + h / 2;
  const labelWidth = w - (choice ? 16 : 0);
  ctx.fillText(value, x + labelWidth / 2, centerY, labelWidth - 6);
  if (choice) {
    ctx.strokeStyle = "#52627a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + w - 14, centerY - 2);
    ctx.lineTo(x + w - 11, centerY + 1);
    ctx.lineTo(x + w - 8, centerY - 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStateMarks(ctx, node, section, view) {
  const selected = view.selectedId === node.blockId;
  const running = view.runningId === node.blockId;
  const error = view.errorId === node.blockId;
  const invalid = view.invalidIds?.has(node.blockId);

  if (running) {
    drawRunningMark(ctx, section?.header || node.rect, view);
  } else if (selected || error || invalid) {
    ctx.save();
    ctx.strokeStyle = selected ? "#1b3f9e" : error ? "#ff6b6b" : "#ffd08a";
    ctx.lineWidth = selected ? 3 : 2.5;
    if (!selected) ctx.setLineDash([6, 4]);
    traceBlock(ctx, node, section);
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

function drawRunningMark(ctx, { x, y, w, h }, view) {
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

  const leftEdge = view.scrollX || 0;
  const right = x + w + 6;
  const badgeX = right + 58 <= leftEdge + view.width ? right : x - 64;
  if (badgeX >= leftEdge) {
    const badgeY = y + (h - 18) / 2;
    roundRect(ctx, badgeX, badgeY, 58, 18, 9);
    ctx.fillStyle = gold;
    ctx.fill();
    ctx.fillStyle = dark;
    ctx.font = "700 11px 'Microsoft YaHei UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("▶ 运行中", badgeX + 29, badgeY + 9);
  }
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

  // 0.9.0（EP-02 第 2 条）：积木幽灵绘制已删除——浮层承载积木本体，画布只画连接提示
  // （容器轮廓、目标框、插入线、非法徽标与消息气泡语义不变）。

  if (visual?.containerId) {
    const section = layout.sections?.[visual.containerId];
    const container = layout.nodes?.find((node) => node.blockId === visual.containerId);
    if (section?.bodyBox && container) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      traceBlock(ctx, container, section);
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
