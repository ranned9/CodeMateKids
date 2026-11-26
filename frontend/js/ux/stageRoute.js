/** 路线舞台的几何判断：只服务展示（拐点、逐格路线、偏离位置），判题仍以后端为准。 */

const EPS = 1e-6;

const near = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const sameDir = (a, b) => a.x === b.x && a.y === b.y;
const step = (a, b) => ({ x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) });

function integral(value) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < EPS ? rounded : null;
}

/** 起点加上每次位置变化后的点；原地转弯不产生新点，所以每段对应一次前进。 */
export function pathVertices(points) {
  const vertices = [{ x: 0, y: 0 }];
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    if (!near(point, vertices.at(-1))) vertices.push({ x: point.x, y: point.y });
  }
  return vertices;
}

/** 把横平竖直的折线展开成逐格的点；出现斜线或非整数坐标时返回 null。 */
export function unitCells(vertices) {
  const cells = [];
  for (const vertex of vertices) {
    const x = integral(vertex.x);
    const y = integral(vertex.y);
    if (x == null || y == null) return null;
    const last = cells.at(-1);
    if (!last) {
      cells.push({ x, y });
      continue;
    }
    if (x !== last.x && y !== last.y) return null;
    const dir = step(last, { x, y });
    const count = Math.abs(x - last.x) + Math.abs(y - last.y);
    for (let k = 1; k <= count; k += 1) cells.push({ x: last.x + dir.x * k, y: last.y + dir.y * k });
  }
  return cells;
}

/** 目标路线上需要转弯的格子序号（第几步时转）。 */
export function cornerSteps(goalCells, startDir = { x: 1, y: 0 }) {
  const corners = [];
  let previous = startDir;
  for (let i = 1; i < goalCells.length; i += 1) {
    const dir = step(goalCells[i - 1], goalCells[i]);
    if (!sameDir(previous, dir)) corners.push(i - 1);
    previous = dir;
  }
  return corners;
}

/**
 * 把实际路线和目标路线逐格对照。
 * 返回 complete（完全走对）、partial（还在路线上，没走完）或 off（在 step 步时离开路线）。
 */
export function compareRoute(goalRoute, vertices) {
  const goal = unitCells(goalRoute.map(([x, y]) => ({ x, y })));
  const actual = unitCells(vertices);
  if (!goal || !actual) return null;
  let i = 0;
  while (i < goal.length && i < actual.length && sameDir(goal[i], actual[i])) i += 1;
  if (i === actual.length) {
    return i === goal.length ? { status: "complete" } : { status: "partial", remaining: goal.length - i };
  }
  const at = actual[i - 1];
  const stepIndex = i - 1;
  if (i === goal.length) return { status: "off", at, step: stepIndex, reason: "overshoot" };
  const before = i >= 2 ? step(actual[i - 2], actual[i - 1]) : { x: 1, y: 0 };
  const actualTurned = !sameDir(before, step(actual[i - 1], actual[i]));
  const goalTurns = !sameDir(before, step(goal[i - 1], goal[i]));
  const reason = goalTurns ? (actualTurned ? "wrong_way" : "missed_turn") : "early_turn";
  const corner = cornerSteps(goal).find((value) => value > stepIndex) ?? null;
  return { status: "off", at, step: stepIndex, reason, corner };
}

/** 偏离路线时在舞台上标出的短句和给结果文字的补充说明。 */
export function deviationText(check) {
  if (check?.status !== "off") return null;
  const { step: at, reason, corner } = check;
  if (reason === "overshoot") return { label: "走过终点了", note: "海龟到终点后还在继续走。" };
  if (reason === "missed_turn") return { label: "到路口要转弯", note: `第 ${at} 步就到路口了，这里要转弯。` };
  if (reason === "wrong_way") return { label: "转错方向了", note: `第 ${at} 步转弯没错，方向反了。` };
  const where = corner == null ? "" : `路口在第 ${corner} 步。`;
  return { label: at === 0 ? "一开始就转弯了" : `第 ${at} 步就转弯了`, note: `海龟走到草地上了。${where}` };
}

/** 正方形类路线：回到起点、朝向复原，且围出了面积。 */
export function isClosedLoop(vertices, heading) {
  if (vertices.length < 5 || !near(vertices.at(-1), vertices[0])) return false;
  if (((Number(heading) % 360) + 360) % 360 !== 0) return false;
  let area = 0;
  for (let i = 1; i < vertices.length; i += 1) {
    area += vertices[i - 1].x * vertices[i].y - vertices[i].x * vertices[i - 1].y;
  }
  return Math.abs(area) > EPS;
}

const HEADING_DIR = { 0: { x: 1, y: 0 }, 90: { x: 0, y: 1 }, 180: { x: -1, y: 0 }, 270: { x: 0, y: -1 } };
const MAX_TAIL_POINTS = 400;

/**
 * 后端只发回前几轮动作时（例如简单的“重复向前走”只给前两轮），按最后一次前进把剩下的路线补齐。
 * 只在能确定是“沿同一方向、每次同样步数一直走到最终位置”时补；补不出来返回 null，舞台照旧只画已知部分。
 * 补出的点超过 400 个时只补最终位置（这时序号也不会画）。
 */
export function completeStraightTail(actions, stage) {
  const last = actions.at(-1);
  if (!last || last.kind !== "motion.move" || !stage) return null;
  const remaining = stage.moves - last.moves;
  const size = last.steps;
  const dir = HEADING_DIR[((Number(last.heading) % 360) + 360) % 360];
  if (!dir || !Number.isInteger(remaining) || remaining <= 0 || !Number.isFinite(size)) return null;
  if (Number(stage.heading) !== Number(last.heading) || stage.steps - last.totalSteps !== remaining * size) return null;
  const at = (k) => ({ x: last.x + dir.x * size * k, y: last.y + dir.y * size * k });
  const target = at(remaining);
  if (Math.abs(target.x - stage.x) > EPS || Math.abs(target.y - stage.y) > EPS) return null;
  const points = remaining > MAX_TAIL_POINTS ? [target] : Array.from({ length: remaining }, (_, i) => at(i + 1));
  return points.map((point) => ({ ...point, heading: last.heading }));
}
