/** 二维舞台：沙滩、方格纸或小路背景，目标虚线、实际路线、前进序号、转弯角度、偏离标记和完成效果。所有任务共用。 */
import { compareRoute, deviationText, isClosedLoop, pathVertices, unitCells, cornerSteps } from "../ux/stageRoute.js";

/** 逻辑画布尺寸；实际像素按 canvas.width 等比放大，高分屏不糊。 */
const W = 360;
const H = 200;
const MAX_UNIT = 60;
/** 一格最少 14 逻辑像素；路线再长就只画画得下的部分，并在边上标出海龟在哪个方向、还有多远。 */
const MIN_UNIT = 14;
/** 沙滩上方海水的高度。 */
const SEA = 30;
const FONT = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const COLOR = {
  ink: "#1d2b3a", inkSoft: "#5b6878", turtle: "#4e9a5b", turtleDark: "#2f6b3c",
  coral: "#e9724c", coralSoft: "#fbe3d9", danger: "#b23a2a",
  paper: "#fffdf7", paperLine: "#e3d6b9", sand: "#f6ebcf", sandLine: "#eadbb5", sea: "#cfe7ec", grass: "#e7f2da", grassLine: "#c9ddb4", road: "#ebddb8", post: "#8a6a3c",
};

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ actions: object[], visible: object[], endpoint: object|null, goal: object|null, final: boolean,
 *   goalLabel?: string|null, numbered?: boolean }} view numbered=false 时不标前进序号（路线是补全出来的，段数不代表前进次数）
 * @returns {{ note: string }} 给舞台说明文字的补充
 */
export function drawStagePath(canvas, { actions, visible, endpoint, goal, final, goalLabel = null, numbered = true }) {
  const context = canvas.getContext?.("2d");
  if (!context) return { note: "" };
  const scale = Number(canvas.width) / W || 1;
  context.setTransform(scale, 0, 0, scale, 0, 0);

  const scene = goal?.scene || "grid";
  const route = goal?.route || null;
  const vertices = pathVertices([...visible, ...(endpoint ? [endpoint] : [])]);
  const moved = vertices.length > 1;
  const branches = scene === "road" && route ? roadBranches(route) : [];
  const goalPoints = [...(route || []).map(([x, y]) => ({ x, y })), ...branches.flat()];
  const frame = viewFrame({
    goal: route ? goalPoints : [{ x: -2, y: -2 }, { x: 2, y: 2 }],
    actual: [...pathVertices(actions), ...vertices],
    focus: endpoint || { x: 0, y: 0 },
    margin: scene === "road" ? 0.9 : 1,
    top: scene === "beach" ? SEA : 0,
  });
  const px = (point) => frame.px(point);
  const end = route ? { x: route.at(-1)[0], y: route.at(-1)[1] } : null;
  const closed = Boolean(end) && end.x === 0 && end.y === 0;

  let check = null;
  let complete = false;
  if (route && scene === "road") {
    check = compareRoute(route, vertices);
    complete = final && check?.status === "complete";
  } else if (closed) {
    complete = final && isClosedLoop(vertices, endpoint?.heading);
  } else if (route) {
    complete = final && moved && Math.abs(vertices.at(-1).x - end.x) < 1e-6 && Math.abs(vertices.at(-1).y - end.y) < 1e-6;
  }
  const deviation = deviationText(check);

  drawBackground(context, scene, frame);
  if (scene === "beach") drawRuler(context, frame, end);
  if (scene === "road" && route) drawRoad(context, route, branches, frame);
  if (complete && closed) fillLoop(context, vertices, frame);
  if (route && !complete) drawGoalLine(context, route, frame, moved ? 0.35 : 0.55);
  if (scene === "road" && route) {
    drawCornerPosts(context, route, frame);
    drawFinish(context, route.at(-1), frame, complete);
    if (!moved) drawGoalSteps(context, route, frame);
  }
  if (scene === "beach" && end) drawGoalFlag(context, frame, end);
  if (scene !== "road" && route) drawStartPad(context, frame, !moved && scene !== "beach");
  else drawStartDot(context, frame);
  drawRoute(context, vertices, frame);
  drawCorners(context, vertices, frame);
  if (numbered) drawMoveNumbers(context, vertices, frame);
  if (closed && !moved && goalLabel) drawGoalLabel(context, route, frame, goalLabel);
  if (deviation) drawDeviation(context, px(check.at), deviation.label);

  const turtleAt = endpoint || { x: 0, y: 0 };
  if (frame.contains(turtleAt)) {
    const [tx, ty] = px(turtleAt);
    context.save();
    context.translate(tx, ty);
    context.rotate(-(turtleAt.heading || 0) * Math.PI / 180);
    drawTurtle(context, Math.min(0.62, Math.max(0.42, frame.unit / 100)));
    context.restore();
  } else {
    drawOffStage(context, frame, turtleAt);
  }

  if (complete) drawBadge(context, scene === "road" ? "到达终点" : closed ? "回到起点" : "走到目标");
  return { note: stageNote({ route, scene, closed, check, deviation, complete, vertices, final }) };
}

function stageNote({ route, scene, closed, check, deviation, complete, vertices, final }) {
  if (!route || !final) return "";
  if (deviation) return deviation.note;
  if (scene === "road") return check?.status === "partial" && vertices.length > 1 ? `还差 ${check.remaining} 步到终点。` : "";
  if (!closed) return "";
  const sides = route.length - 1;
  const moves = vertices.length - 1;
  return !complete && moves > 0 && moves < sides ? `还差 ${sides - moves} 条边。` : "";
}

/** 路口处顺着来时的方向再画两格岔路，表示不转弯也能继续走。 */
function roadBranches(route) {
  const cells = unitCells(route.map(([x, y]) => ({ x, y }))) || [];
  return cornerSteps(cells).filter((index) => index > 0).map((index) => {
    const corner = cells[index];
    const before = cells[index - 1];
    const dir = { x: corner.x - before.x, y: corner.y - before.y };
    return [corner, { x: corner.x + dir.x * 2, y: corner.y + dir.y * 2 }];
  });
}

/**
 * 比例尺：目标路线和实际路线都画得下时一起放进画面，一格不超过 60 逻辑像素。
 * 路线太长时一格取 14 逻辑像素，画面保证目标路线完整，再尽量往海龟所在的方向挪。
 * top 是画面上方留给海水等装饰的高度。
 */
function viewFrame({ goal, actual, focus, margin, top = 0 }) {
  const height = H - top;
  const bounds = (points) => {
    const xs = points.map((p) => p.x).concat(0);
    const ys = points.map((p) => p.y).concat(0);
    return { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minY: Math.min(...ys) - margin, maxY: Math.max(...ys) + margin };
  };
  const all = bounds([...goal, ...actual]);
  let unit = Math.min(W / (all.maxX - all.minX), height / (all.maxY - all.minY), MAX_UNIT);
  let cx = (all.minX + all.maxX) / 2;
  let cy = (all.minY + all.maxY) / 2;
  if (unit < MIN_UNIT) {
    unit = MIN_UNIT;
    const g = bounds(goal);
    const halfW = W / 2 / unit;
    const halfH = height / 2 / unit;
    const clamp = (value, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, value)));
    cx = clamp(focus.x, g.maxX - halfW, g.minX + halfW);
    cy = clamp(focus.y, g.maxY - halfH, g.minY + halfH);
  }
  const ox = W / 2 - cx * unit;
  const oy = top + height / 2 + cy * unit;
  const px = ({ x, y }) => [ox + x * unit, oy - y * unit];
  const contains = (point) => {
    const [x, y] = px(point);
    return x >= 8 && x <= W - 8 && y >= top + 8 && y <= H - 8;
  };
  return { unit, ox, oy, top, px, contains, minX: -ox / unit, maxX: (W - ox) / unit };
}

function drawBackground(context, scene, { unit, ox, oy }) {
  context.clearRect(0, 0, W, H);
  const fill = { road: COLOR.grass, beach: COLOR.sand }[scene] || COLOR.paper;
  context.fillStyle = fill;
  context.fillRect(0, 0, W, H);
  context.strokeStyle = { road: COLOR.grassLine, beach: COLOR.sandLine }[scene] || COLOR.paperLine;
  context.lineWidth = 1;
  context.setLineDash([]);
  context.beginPath();
  for (let x = ox - Math.ceil(ox / unit) * unit; x <= W; x += unit) {
    context.moveTo(Math.round(x) + 0.5, 0);
    context.lineTo(Math.round(x) + 0.5, H);
  }
  for (let y = oy - Math.ceil(oy / unit) * unit; y <= H; y += unit) {
    context.moveTo(0, Math.round(y) + 0.5);
    context.lineTo(W, Math.round(y) + 0.5);
  }
  context.stroke();
  if (scene === "beach") drawSea(context);
}

/** 沙滩上方一条海水，带一排浪花，和原来的沙滩舞台一致。 */
function drawSea(context) {
  context.save();
  context.fillStyle = COLOR.sea;
  context.fillRect(0, 0, W, SEA);
  context.strokeStyle = "rgba(255, 255, 255, 0.8)";
  context.lineWidth = 1.5;
  context.beginPath();
  for (let x = 0; x < W + 20; x += 20) {
    context.moveTo(x + 9, SEA - 10);
    context.arc(x, SEA - 10, 9, 0, Math.PI);
  }
  context.stroke();
  context.restore();
}

/** 沿起点那条横线标出每一格的步数；0 是起点，目标那一格加粗。格子太密时隔几格标一个。 */
function drawRuler(context, frame, end) {
  const every = Math.max(1, Math.ceil(22 / frame.unit));
  const [, y] = frame.px({ x: 0, y: 0 });
  context.save();
  context.font = `700 11px ${FONT}`;
  context.textAlign = "center";
  context.textBaseline = "top";
  for (let value = Math.ceil(frame.minX); value <= Math.floor(frame.maxX); value += 1) {
    const special = value === 0 || (end && value === end.x && end.y === 0);
    if (!special && value % every) continue;
    const [x] = frame.px({ x: value, y: 0 });
    context.fillStyle = value === 0 ? COLOR.danger : special ? COLOR.ink : COLOR.inkSoft;
    context.fillText(String(value), x, y + Math.min(26, frame.unit * 0.45) + 2);
  }
  context.restore();
}

/** 目标格插一面珊瑚色小旗。 */
function drawGoalFlag(context, frame, end) {
  if (!frame.contains(end)) return;
  const [x, y] = frame.px(end);
  context.save();
  context.strokeStyle = COLOR.ink;
  context.lineWidth = 2;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(x, y + 2);
  context.lineTo(x, y - 30);
  context.stroke();
  context.fillStyle = COLOR.coral;
  context.beginPath();
  context.moveTo(x + 1, y - 30);
  context.lineTo(x + 20, y - 24);
  context.lineTo(x + 1, y - 18);
  context.closePath();
  context.fill();
  context.restore();
}

/** 海龟走出画面时，在画面边上标出它在哪个方向、离画面还有多少格。 */
function drawOffStage(context, frame, point) {
  const [x, y] = frame.px(point);
  const cx = Math.min(W - 8, Math.max(8, x));
  const cy = Math.min(H - 8, Math.max(frame.top + 8, y));
  const cells = Math.ceil(Math.max(Math.abs(x - cx), Math.abs(y - cy)) / frame.unit);
  const arrow = Math.abs(x - cx) >= Math.abs(y - cy) ? (x > cx ? "→" : "←") : (y > cy ? "↓" : "↑");
  const label = arrow === "←" || arrow === "↑" ? `${arrow} 海龟在 ${cells} 格外` : `海龟在 ${cells} 格外 ${arrow}`;
  context.save();
  context.font = `700 12px ${FONT}`;
  const width = (context.measureText(label)?.width || label.length * 12) + 20;
  const left = Math.min(W - width - 6, Math.max(6, cx - width / 2));
  const top = Math.min(H - 30, Math.max(frame.top + 6, cy - 12));
  context.fillStyle = COLOR.turtle;
  pill(context, left, top, width, 24, 12);
  context.fill();
  context.fillStyle = "#fff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, left + width / 2, top + 12.5);
  context.restore();
}

function strokePolyline(context, points, frame) {
  context.beginPath();
  points.forEach((point, i) => {
    const [x, y] = frame.px(point);
    if (i) context.lineTo(x, y);
    else context.moveTo(x, y);
  });
  context.stroke();
}

function drawRoad(context, route, branches, frame) {
  context.save();
  context.strokeStyle = COLOR.road;
  context.lineWidth = frame.unit * 0.7;
  context.lineCap = "round";
  context.lineJoin = "round";
  strokePolyline(context, route.map(([x, y]) => ({ x, y })), frame);
  for (const branch of branches) strokePolyline(context, branch, frame);
  context.restore();
}

function drawGoalLine(context, route, frame, alpha) {
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = COLOR.turtle;
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  context.setLineDash([7, 6]);
  strokePolyline(context, route.map(([x, y]) => ({ x, y })), frame);
  context.restore();
}

function fillLoop(context, vertices, frame) {
  context.save();
  context.globalAlpha = 0.18;
  context.fillStyle = COLOR.turtle;
  context.beginPath();
  vertices.forEach((point, i) => {
    const [x, y] = frame.px(point);
    if (i) context.lineTo(x, y);
    else context.moveTo(x, y);
  });
  context.closePath();
  context.fill();
  context.restore();
}

function drawStartDot(context, frame) {
  const [x, y] = frame.px({ x: 0, y: 0 });
  context.fillStyle = COLOR.turtle;
  context.beginPath();
  context.arc(x, y, 4, 0, Math.PI * 2);
  context.fill();
}

function drawRoute(context, vertices, frame) {
  if (vertices.length < 2) return;
  context.save();
  context.strokeStyle = COLOR.turtle;
  context.lineWidth = 4;
  context.lineCap = "round";
  context.lineJoin = "round";
  strokePolyline(context, vertices, frame);
  context.restore();
}

/** 屏幕坐标下的单位方向（y 向下）。 */
function screenDir(frame, from, to) {
  const [ax, ay] = frame.px(from);
  const [bx, by] = frame.px(to);
  const length = Math.hypot(bx - ax, by - ay) || 1;
  return { x: (bx - ax) / length, y: (by - ay) / length };
}

/** 每个直角拐弯画一段小圆弧，第一个拐角标出角度。 */
function drawCorners(context, vertices, frame) {
  let labelled = false;
  for (let i = 1; i < vertices.length - 1; i += 1) {
    const incoming = screenDir(frame, vertices[i - 1], vertices[i]);
    const outgoing = screenDir(frame, vertices[i], vertices[i + 1]);
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    if (Math.abs(dot) > 0.01) continue;
    const r = 12;
    const [x, y] = frame.px(vertices[i]);
    const cx = x - incoming.x * r + outgoing.x * r;
    const cy = y - incoming.y * r + outgoing.y * r;
    const a1 = Math.atan2(y - incoming.y * r - cy, x - incoming.x * r - cx);
    const a2 = Math.atan2(y + outgoing.y * r - cy, x + outgoing.x * r - cx);
    const sweep = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
    context.save();
    context.strokeStyle = COLOR.turtleDark;
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(cx, cy, r, a1, a2, sweep < 0);
    context.stroke();
    if (!labelled) {
      const inside = { x: outgoing.x - incoming.x, y: outgoing.y - incoming.y };
      context.fillStyle = COLOR.turtleDark;
      context.font = `700 10px ${FONT}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("90°", x + inside.x * 22, y + inside.y * 16);
      labelled = true;
    }
    context.restore();
  }
}

/** 每次前进在这段路线外侧（远离路线中心的一侧）标序号，方便和“前进了几次”的预测对数。 */
function drawMoveNumbers(context, vertices, frame) {
  const segments = vertices.length - 1;
  if (segments < 1 || segments > 12) return;
  const center = vertices.reduce((sum, p) => { const [x, y] = frame.px(p); return [sum[0] + x, sum[1] + y]; }, [0, 0])
    .map((value) => value / vertices.length);
  for (let i = 1; i <= segments; i += 1) {
    const dir = screenDir(frame, vertices[i - 1], vertices[i]);
    const [ax, ay] = frame.px(vertices[i - 1]);
    const [bx, by] = frame.px(vertices[i]);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    let nx = -dir.y;
    let ny = dir.x;
    if (nx * (mx - center[0]) + ny * (my - center[1]) < -0.5) { nx = -nx; ny = -ny; }
    const x = mx + nx * 20;
    const y = my + ny * 20;
    numberBadge(context, x, y, String(i), COLOR.turtle, frame.unit < 50 ? 8 : 9);
  }
}

function numberBadge(context, x, y, text, color, r = 9) {
  context.save();
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, r, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#fff";
  context.font = `700 ${r + 3}px ${FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, x, y + 0.5);
  context.restore();
}

/** 运行前在路边标出走到第一个路口的步数。 */
function drawGoalSteps(context, route, frame) {
  const cells = unitCells(route.map(([x, y]) => ({ x, y }))) || [];
  const last = cornerSteps(cells).find((index) => index > 0) ?? cells.length - 1;
  context.save();
  context.fillStyle = COLOR.inkSoft;
  context.font = `700 11px ${FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let i = 1; i <= last; i += 1) {
    const dir = screenDir(frame, cells[i - 1], cells[i]);
    const [x, y] = frame.px(cells[i]);
    context.fillText(String(i), x - dir.y * frame.unit * 0.6, y + dir.x * frame.unit * 0.6);
  }
  context.restore();
}

/** 路牌立在转弯的内侧。 */
function drawCornerPosts(context, route, frame) {
  for (let i = 1; i < route.length - 1; i += 1) {
    const [x, y] = frame.px({ x: route[i][0], y: route[i][1] });
    const incoming = screenDir(frame, { x: route[i - 1][0], y: route[i - 1][1] }, { x: route[i][0], y: route[i][1] });
    const outgoing = screenDir(frame, { x: route[i][0], y: route[i][1] }, { x: route[i + 1][0], y: route[i + 1][1] });
    // 立在拐角外侧（来向与去向之和），转早的路线走在内侧，不会压住路牌。
    const sx = x + (outgoing.x + incoming.x) * frame.unit * 0.85;
    const sy = y + (outgoing.y + incoming.y) * frame.unit * 0.85;
    context.save();
    context.strokeStyle = COLOR.post;
    context.lineWidth = 2.5;
    context.beginPath();
    context.moveTo(sx, sy - 6);
    context.lineTo(sx, sy + 22);
    context.stroke();
    context.fillStyle = COLOR.post;
    pill(context, sx - 17, sy - 14, 34, 16, 3);
    context.fill();
    context.fillStyle = "#fff";
    context.font = `700 10px ${FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("路口", sx, sy - 6);
    context.restore();
  }
}

function drawFinish(context, [ex, ey], frame, eaten) {
  const [x, y] = frame.px({ x: ex, y: ey });
  context.save();
  if (!eaten) {
    context.strokeStyle = COLOR.coral;
    context.lineWidth = 2;
    context.setLineDash([5, 4]);
    context.beginPath();
    context.arc(x, y, Math.min(20, frame.unit * 0.5), 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = COLOR.inkSoft;
    context.font = `700 11px ${FONT}`;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText("终点", x + frame.unit * 0.6, y);
  }
  // 吃完后生菜挪到前方一点，被咬掉一角。
  const lx = eaten ? x + frame.unit * 0.75 : x;
  const ly = eaten ? y - frame.unit * 0.2 : y;
  drawLettuce(context, lx, ly, eaten ? 0.7 : 1);
  if (eaten) {
    context.fillStyle = COLOR.grass;
    context.beginPath();
    context.arc(lx + 6, ly - 4, 4, 0, Math.PI * 2);
    context.arc(lx + 7.5, ly + 1, 3, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawLettuce(context, x, y, size) {
  context.save();
  context.translate(x, y);
  context.scale(size, size);
  context.fillStyle = "#8fcb6b";
  for (const cx of [-6, 6]) {
    context.beginPath();
    context.arc(cx, 2, 8, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "#a7da82";
  context.beginPath();
  context.arc(0, -5, 9, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#5e9e45";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(0, -10);
  context.lineTo(0, 8);
  context.moveTo(-6, -2);
  context.lineTo(0, 4);
  context.lineTo(6, -2);
  context.stroke();
  context.restore();
}

/** 起点圈画在海龟脚下，正好套住路线的起点；运行前在圈下方写“起点”。 */
function drawStartPad(context, frame, labelled) {
  const [x, y] = frame.px({ x: 0, y: 0 });
  const r = Math.min(24, frame.unit * 0.4);
  context.save();
  context.fillStyle = COLOR.coralSoft;
  context.strokeStyle = COLOR.coral;
  context.lineWidth = 2;
  context.setLineDash([5, 4]);
  context.beginPath();
  context.arc(x, y, r, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  if (labelled) {
    context.fillStyle = COLOR.danger;
    context.font = `700 11px ${FONT}`;
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText("起点", x, y + r + 4);
  }
  context.restore();
}

function drawGoalLabel(context, route, frame, label) {
  const maxX = Math.max(...route.map(([x]) => x));
  const ys = route.map(([, y]) => y);
  const [x, y] = frame.px({ x: maxX, y: (Math.min(...ys) + Math.max(...ys)) / 2 });
  context.save();
  context.fillStyle = COLOR.inkSoft;
  context.font = `700 11px ${FONT}`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(`目标：${label}`, x + 16, y);
  context.restore();
}

/** 偏离处画珊瑚色“!”，说明文字放在左上角，不压住路线和序号。 */
function drawDeviation(context, [x, y], label) {
  numberBadge(context, x, y, "!", COLOR.coral, 10);
  context.save();
  context.font = `700 13px ${FONT}`;
  const width = (context.measureText(label)?.width || label.length * 13) + 28;
  context.fillStyle = COLOR.coralSoft;
  pill(context, 12, 12, width, 28, 14);
  context.fill();
  context.fillStyle = COLOR.danger;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 12 + width / 2, 26.5);
  context.restore();
}

function drawBadge(context, text) {
  context.save();
  context.fillStyle = COLOR.turtle;
  pill(context, W - 96, 12, 84, 28, 14);
  context.fill();
  context.fillStyle = "#fff";
  context.font = `700 13px ${FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, W - 54, 26.5);
  context.restore();
}

function pill(context, x, y, w, h, r) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

/** 与 index.html 中 #turtle 图标同形（viewBox 64x48，头朝右），以龟壳中心为原点。 */
export function drawTurtle(context, size = 0.5) {
  const ellipse = (cx, cy, rx, ry) => {
    context.beginPath();
    context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  };
  context.scale(size, size);
  context.translate(-30, -24);
  context.fillStyle = "#86be79";
  for (const [cx, cy] of [[18, 9], [42, 9], [18, 39], [42, 39]]) {
    ellipse(cx, cy, 6, 4.5);
    context.fill();
  }
  context.beginPath();
  context.moveTo(6, 24);
  context.lineTo(1, 21);
  context.lineTo(1, 27);
  context.closePath();
  context.fill();
  ellipse(55, 24, 7.5, 7.5);
  context.fill();
  context.fillStyle = "#1d2b3a";
  ellipse(57.5, 21, 1.8, 1.8);
  context.fill();
  context.strokeStyle = "#2f6b3c";
  context.fillStyle = "#4e9a5b";
  context.lineWidth = 2.5;
  ellipse(30, 24, 21, 16.5);
  context.fill();
  context.stroke();
  context.fillStyle = "#6db37a";
  context.lineWidth = 1.6;
  context.beginPath();
  [[30, 15], [38, 19.5], [38, 28.5], [30, 33], [22, 28.5], [22, 19.5]]
    .forEach(([px, py], i) => (i ? context.lineTo(px, py) : context.moveTo(px, py)));
  context.closePath();
  context.fill();
  context.stroke();
  context.beginPath();
  for (const [x1, y1, x2, y2] of [[30, 15, 30, 8.5], [38, 19.5, 46, 15], [38, 28.5, 46, 33], [30, 33, 30, 39.5], [22, 28.5, 14, 33], [22, 19.5, 14, 15]]) {
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
  }
  context.stroke();
}
