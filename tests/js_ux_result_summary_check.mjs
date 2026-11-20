/** RG-UX-07/08/11/15：目标派生、结果两句话、保存四态、舞台刻度与课堂状态。 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asUrl = (relative) => pathToFileURL(path.join(root, relative)).href;

const summaryModule = await import(asUrl("frontend/js/ux/resultSummary.js"));
const saveModule = await import(asUrl("frontend/js/ux/saveState.js"));
const trackModule = await import(asUrl("frontend/js/ux/stageTrack.js"));
const classroomModule = await import(asUrl("frontend/js/ux/classroomState.js"));
const summarySections = await import(asUrl("frontend/js/ux/summarySections.js"));
const { repeatedMoveInLoop } = await import(asUrl("frontend/js/ux/loopEvidence.js"));

const sections = summarySections.buildSummarySections({ completedTasks: ["主任务"] }, {});
assert.equal(sections[0].key, "done");
assert.match(sections[0].text, /主任务/);
assert.equal(sections.some((section) => section.key === "observation"), false, "无证据时省略观察段");
const withObservation = summarySections.buildSummarySections({ completedTasks: ["主任务"] }, { observation: "你把重复次数从 4 改成了 3。" });
assert.equal(withObservation.length, 3);
assert.match(withObservation[1].text, /4 改成了 3/);
assert.equal(summarySections.hasEvaluationLabel(withObservation), false);
assert.equal(summarySections.hasEvaluationLabel([{ text: "你是最棒的" }]), false);

const mainTask = {
  taskId: "main",
  type: "main",
  successCriteria: [
    { code: "stage_reached_four", description: "走到 4 步", check: { object: "stage", field: "steps", op: "eq", value: 4 } },
  ],
};
const variantTask = {
  taskId: "variant",
  type: "variant",
  successCriteria: [
    { code: "stage_reached_six", description: "走到 6 步", check: { object: "stage", field: "steps", op: "eq", value: 6 } },
  ],
};

assert.equal(summaryModule.deriveTargetSteps(mainTask), 4);
assert.equal(summaryModule.deriveTargetSteps(variantTask), 6);
assert.equal(summaryModule.deriveTargetSteps(null), null);
assert.equal(
  summaryModule.deriveTargetSteps({ successCriteria: [{ check: { object: "stage", field: "steps", op: "gte", value: 4 } }] }),
  null,
  "非 eq 不得派生出唯一目标",
);
assert.equal(
  summaryModule.deriveTargetSteps({
    successCriteria: [
      { check: { object: "stage", field: "steps", op: "eq", value: 4 } },
      { check: { object: "stage", field: "steps", op: "eq", value: 6 } },
    ],
  }),
  null,
  "多值不得派出唯一目标",
);

const data = {
  status: "completed",
  success: false,
  stdout: "",
  objects: [{ id: "stage", steps: 3, moves: 3, heading: 0 }],
};
const summary = summaryModule.buildResultSummary({
  data,
  task: mainTask,
  predictionValue: 0,
  predictionSource: "initial",
  ownership: "current",
});
assert.equal(summary.moves, 3);
assert.equal(summary.actualSteps, 3);
assert.equal(summary.targetSteps, 4);
assert.equal(summary.gap, 1);
assert.match(summary.compareLine, /0 次/);
assert.match(summary.compareLine, /3 次/);
assert.match(summary.goalLine, /还差 1 步/);
assert.equal(summary.nextAction, "hint");

const missingMoves = summaryModule.buildResultSummary({
  data: { status: "completed", success: false, objects: [{ id: "stage", steps: 4 }] },
  task: mainTask,
  predictionValue: 4,
  ownership: "current",
});
assert.equal(missingMoves.moves, null, "缺 moves 不得补零");
assert.equal(missingMoves.consistent, "unknown");
assert.doesNotMatch(missingMoves.compareLine, /4 次/);

const stale = summaryModule.buildResultSummary({
  data,
  task: mainTask,
  predictionValue: 3,
  ownership: "stale",
});
assert.equal(stale.staleLabel, "上次运行 · 积木已修改");
assert.equal(stale.nextAction, "rerun");
assert.match(stale.compareLine, /猜对啦/);

const variantDone = summaryModule.buildResultSummary({
  data: { status: "completed", success: true, objects: [{ id: "stage", steps: 6, moves: 6 }] },
  task: variantTask,
  predictionValue: 6,
  ownership: "current",
});
assert.equal(variantDone.nextAction, "summary");
assert.equal(variantDone.reached, true);
assert.match(variantDone.goalLine, /正好到达目标/);

const overflow = summaryModule.buildResultSummary({
  data: { status: "completed", success: true, objects: [{ id: "stage", steps: 8, moves: 8 }] },
  task: variantTask,
  predictionValue: 6,
  ownership: "current",
});
assert.equal(overflow.gap, 2);
assert.match(overflow.goalLine, /超出了 2 步/);

assert.equal(saveModule.deriveSaveState({ dirty: false, saving: false }).status, "clean");
assert.equal(saveModule.deriveSaveState({ dirty: true }).status, "dirty");
const saving = saveModule.deriveSaveState({ dirty: true, saving: true, lastSavedRevision: 2, programRevision: 3 });
assert.equal(saving.status, "saving");
assert.equal(saving.needsResave, true, "保存期间的新修改不得被当成已保存");
assert.equal(
  saveModule.deriveSaveState({ saving: true, lastSavedRevision: 3, programRevision: 3, dirty: false }).needsResave,
  false,
);
const failed = saveModule.deriveSaveState({ dirty: false, lastError: "网络断了" });
assert.equal(failed.status, "failed");
assert.equal(failed.needsResave, true);
assert.match(failed.label, /再试一次/);
assert.equal(saveModule.saveStateClass("failed"), "bad");

const track = trackModule.buildStageTrack({ targetSteps: 4, actualSteps: 2 });
assert.equal(track.hasTarget, true);
assert.equal(track.ratio, 0.5);
assert.equal(track.overflowSteps, 0);
assert.equal(trackModule.buildStageTrack({ targetSteps: 4, actualSteps: 6 }).overflowSteps, 2);
assert.equal(trackModule.buildStageTrack({ targetSteps: null, actualSteps: 6 }).hasTarget, false);
assert.equal(trackModule.actorPercent(track), 45);
assert.deepEqual(trackModule.stageTicks(4).map((tick) => tick.value), [0, 1, 2, 3, 4]);
assert.equal(trackModule.stageTicks(6).at(-1).percent, 82);

const loopCourse = JSON.parse(readFileSync(path.join(root, "content/demo-loop/course.json"), "utf8"));
const mainRoot = loopCourse.tasks[0].initialProgram.root;
const moveId = mainRoot.next.body[0].blockId;
const events = ["block_enter", "block_exit", "block_enter", "block_exit"]
  .map((kind, index) => ({ kind, seq: index + 1, blockId: moveId }));
const result = { status: "completed", events };
assert.equal(repeatedMoveInLoop(mainRoot, result), moveId);
assert.equal(repeatedMoveInLoop(mainRoot, { ...result, status: "cancelled" }), null);
assert.equal(repeatedMoveInLoop(mainRoot, { ...result, events: events.slice(0, 3) }), null);
assert.equal(repeatedMoveInLoop(mainRoot, { ...result, events: [...events.slice(0, 2), ...events.slice(0, 2)] }), null);
assert.equal(repeatedMoveInLoop({ ...mainRoot, next: { ...mainRoot.next.body[0] } }, result), null);
assert.equal(repeatedMoveInLoop([
  { root: { ...mainRoot, next: null }, x: 0, y: 0 },
  { root: mainRoot.next, x: 0, y: 0 },
], result), null);

assert.equal(
  classroomModule.deriveClassroomState({ startup: null }).state,
  "startup-pending",
);
assert.equal(
  classroomModule.deriveClassroomState({ startup: { status: "fatal" } }).state,
  "environment-blocked",
);
assert.equal(
  classroomModule.deriveClassroomState({ startup: { status: "ready" }, task: { enterable: false } }).state,
  "task-blocked",
);
assert.equal(
  classroomModule.deriveClassroomState({ startup: { status: "ready" }, task: { enterable: true }, readonly: true }).state,
  "readonly",
);
assert.equal(
  classroomModule.deriveClassroomState({ startup: { status: "ready" }, task: { enterable: true }, phase: "running" }).state,
  "running",
);
assert.equal(
  classroomModule.deriveClassroomState({ startup: { status: "ready" }, task: { enterable: true }, phase: "editing" }).state,
  "needs-prediction",
);
const needsFix = classroomModule.deriveClassroomState({
  startup: { status: "ready" },
  task: { enterable: true },
  phase: "editing",
  predictionValue: 4,
  gate: { allowed: false, reason: "先把数字填上。", blockId: "b-9" },
});
assert.equal(needsFix.state, "needs-fix");
assert.equal(needsFix.blockId, "b-9");
assert.equal(needsFix.primary.controlId, "run-locate");
assert.equal(classroomModule.stateHintTone("needs-fix"), "bad");

console.log("JS-UX-RESULT-SUMMARY-CHECK PASSED");
