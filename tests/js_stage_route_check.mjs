import assert from "node:assert/strict";
import { compareRoute, completeStraightTail, deviationText, isClosedLoop, pathVertices, unitCells } from "../frontend/js/ux/stageRoute.js";

const road = [[0, 0], [3, 0], [3, 2]];
const walk = (...points) => pathVertices(points.map(([x, y]) => ({ x, y })));

// 原地转弯不产生新拐点，每次前进一段。
assert.deepEqual(pathVertices([{ x: 1, y: 0 }, { x: 1, y: 0, heading: 90 }, { x: 1, y: 1 }]), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
assert.equal(unitCells([{ x: 0, y: 0 }, { x: 2, y: 0 }]).length, 3);
assert.equal(unitCells([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null);

assert.equal(compareRoute(road, walk()).status, "partial");
assert.equal(compareRoute(road, walk([1, 0], [2, 0], [3, 0], [3, 1], [3, 2])).status, "complete");
assert.deepEqual(compareRoute(road, walk([1, 0], [2, 0])), { status: "partial", remaining: 3 });

const early = compareRoute(road, walk([1, 0], [2, 0], [2, 1], [2, 2]));
assert.equal(early.reason, "early_turn");
assert.equal(early.step, 2);
assert.equal(early.corner, 3);
assert.deepEqual(early.at, { x: 2, y: 0 });
assert.equal(deviationText(early).label, "第 2 步就转弯了");
assert.match(deviationText(early).note, /路口在第 3 步/);

assert.equal(compareRoute(road, walk([4, 0], [5, 0])).reason, "missed_turn");
assert.equal(compareRoute(road, walk([3, 0], [3, -2])).reason, "wrong_way");
assert.equal(compareRoute(road, walk([3, 0], [3, 3])).reason, "overshoot");
assert.equal(deviationText(compareRoute(road, walk([0, 1]))).label, "一开始就转弯了");

const square = walk([1, 0], [1, 1], [0, 1], [0, 0]);
assert.equal(isClosedLoop(square, 0), true);
assert.equal(isClosedLoop(square, 270), false);
assert.equal(isClosedLoop(walk([2, 0], [2, -2], [0, -2], [0, 0]), 360), true);
assert.equal(isClosedLoop(walk([1, 0], [0, 0]), 0), false);

// 只发回前两轮的“重复向前走”：按最后一次前进补齐到最终位置。
const twoRounds = [
  { kind: "motion.move", steps: 1, x: 1, y: 0, heading: 0, totalSteps: 1, moves: 1 },
  { kind: "motion.move", steps: 1, x: 2, y: 0, heading: 0, totalSteps: 2, moves: 2 },
];
assert.deepEqual(completeStraightTail(twoRounds, { x: 4, y: 0, heading: 0, steps: 4, moves: 4 }).map((p) => p.x), [3, 4]);
// 掉头后最终位置对不上，就不补，舞台只画已知部分。
assert.equal(completeStraightTail(twoRounds, { x: 0, y: 0, heading: 180, steps: 4, moves: 4 }), null);
assert.equal(completeStraightTail(twoRounds, { x: 2, y: 0, heading: 0, steps: 2, moves: 2 }), null);
// 很长的直线只补最终位置。
assert.deepEqual(completeStraightTail(twoRounds, { x: 1000, y: 0, heading: 0, steps: 1000, moves: 1000 }), [{ x: 1000, y: 0, heading: 0 }]);

console.log("stage route checks passed");
