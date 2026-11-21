/** DV-AI-01（前端侧）：展示枚举与共享夹具一致；不得出现判定集合。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asUrl = (relative) => pathToFileURL(path.join(root, relative)).href;

const expected = JSON.parse(readFileSync(path.join(root, "tests", "fixtures", "enums-expected.json"), "utf-8"));
const mirror = await import(asUrl("frontend/js/ux/enums.js"));

assert.deepEqual(mirror.NEXT_ACTION, expected.NEXT_ACTION);
assert.deepEqual(Object.keys(mirror.SUPPORT_LABEL).sort(), [...expected.SUPPORT].sort());
assert.deepEqual(mirror.TRANSFER_STATUS, expected.TRANSFER_STATUS);
assert.equal(mirror.NEXT_ACTION.length, 8);

for (const value of expected.NEXT_ACTION) {
  assert.equal(typeof mirror.NEXT_ACTION_LABEL[value], "string", `缺少 ${value} 的文案`);
}
assert.equal(mirror.nextActionLabel("future_action"), mirror.NEXT_ACTION_LABEL.none, "未知值必须兜底");
assert.equal(mirror.supportLabel("future_support"), mirror.SUPPORT_LABEL.unknown);
assert.equal(mirror.transferStatusLabel("future_status"), "还没开始");

const source = readFileSync(path.join(root, "frontend", "js", "ux", "enums.js"), "utf-8");
assert.equal(source.includes("PATTERN"), false, "前端不得导出判定用错因集合");
assert.equal(/function\s+classify|function\s+diagnose/.test(source), false, "前端不得包含判定函数");

console.log("JS-AI-TEACHING-CHECK PASSED");
const learning = await import(asUrl("frontend/js/ux/learningContext.js"));
const playerModule = await import(asUrl("frontend/js/ux/replayPlayer.js"));

const workspaceA = learning.createWorkspaceId("ws");
const workspaceB = learning.createWorkspaceId("ws");
assert.notEqual(workspaceA, workspaceB, "安装工作区必须生成新的 workspaceId");
assert.equal(learning.isIdentifier(workspaceA), true);
assert.equal(learning.isIdentifier("bad workspace id"), false);

const scope = learning.createLearningScope({ contentVersion: "1.2.1", taskId: "main", workspaceId: workspaceA });
assert.equal(scope.workspaceId, workspaceA);
assert.equal(learning.createLearningScope({ workspaceId: "bad id" }).workspaceId, null);

let seen = [];
for (let index = 0; index < 10; index += 1) {
  seen = learning.addSeenHint(seen, `hint-${index}`).seen;
}
assert.equal(seen.length, learning.MAX_SEEN_HINTS);
assert.equal(learning.addSeenHint(seen, seen[0]).added, false, "重复提示不得重复计数");
assert.equal(learning.addSeenHint(seen, "bad hint id").added, false);

const payload = learning.buildLearningContext({
  scope,
  program: { format: "codematekids.program" },
  predictionId: "pred-1",
  seenHintIds: seen,
  workspaceSource: "task",
  runRequestId: "run-1",
});
assert.equal(payload.scope.workspaceId, workspaceA);
assert.equal(payload.seenHintIds.length, learning.MAX_SEEN_HINTS);
assert.equal(payload.workspaceSource, "task");
assert.equal(learning.buildLearningContext({ workspaceSource: "other" }).workspaceSource, undefined);

const snapshot = { taskId: "main", workspaceId: workspaceA, programRevision: 3, runRequestId: "run-1" };
assert.equal(learning.isContextCurrent(snapshot, { ...snapshot }), true);
assert.equal(learning.isContextCurrent(snapshot, { ...snapshot, programRevision: 4 }), false, "程序改过即失效");

const unavailable = playerModule.createReplayPlayer(null);
assert.equal(unavailable.snapshot().state, "unavailable");
assert.equal(unavailable.next().index, 0);
assert.deepEqual(playerModule.replayControlIds(false), [], "不可用时不得显示分步控件");

const replay = { actions: [{ blockId: "b-move" }, { blockId: "b-turn" }], rounds: 1, hasMore: false };
const player = playerModule.createReplayPlayer(replay);
assert.equal(player.snapshot().state, "ready");
assert.deepEqual(playerModule.replayControlIds(true), ["replay-next", "replay-prev", "replay-reset"]);
assert.equal(player.next().index, 1);
assert.equal(player.next().index, 2);
assert.equal(player.next().index, 2, "到末尾后不得越界");
assert.equal(player.prev().index, 1);
player.goTo(99);
assert.equal(player.snapshot().index, 2);
player.reset();
assert.equal(player.snapshot().index, 0);

const { captureLearningContext, isLearningContextCurrent } = await import(asUrl("frontend/js/core/viewContext.js"));
const viewState = { activeTaskId: "variant", workspaceId: workspaceA, contentVersion: "1.3.0", programRevision: 2, learningRunRequestId: "run-1" };
const viewSnapshot = captureLearningContext(viewState);
assert.equal(isLearningContextCurrent(viewState, viewSnapshot), true);
assert.equal(isLearningContextCurrent({ ...viewState, learningRunRequestId: "run-2" }, viewSnapshot), false);
assert.equal(isLearningContextCurrent({ ...viewState, contentVersion: "1.3.1" }, viewSnapshot), false);
assert.equal(isLearningContextCurrent({ ...viewState, studentId: "student-other" }, viewSnapshot), false);
assert.deepEqual(learning.buildLearningContext({ scope, seenHintIds: [] }).seenHintIds, []);

const { buildResultSummary } = await import(asUrl("frontend/js/ux/resultSummary.js"));
const square = { type: "variant", teaching: { goalKind: "square" } };
const pathOnly = buildResultSummary({ task: square, data: { status: "completed", learning: { routeMet: true, structureMet: false } } });
assert.equal(pathOnly.reached, false);
assert.match(pathOnly.goalLine, /放进同一个循环/);
assert.equal(buildResultSummary({ task: { type: "variant", nextTaskId: "transfer-square" }, data: { status: "completed", success: true } }).nextAction, "nextTask");

console.log("JS-AI-TEACHING-EXTENDED PASSED");

const { createTutorChat, describeEditedRun } = await import(asUrl("frontend/js/views/tutorChat.js"));
assert.match(describeEditedRun({
  success: true, objects: [{ id: "stage", steps: 4, moves: 4 }],
}, { field: "times", previousMoves: 2 }), /前进了 4 次.*多前进了 2 次.*达到任务目标/);
let onChatKey;
let submissions = 0;
createTutorChat({
  elements: {
    log: {},
    form: { addEventListener() {}, requestSubmit: () => { submissions += 1; } },
    input: { addEventListener: (_type, handler) => { onChatKey = handler; } },
  },
  state: {},
  editor: {},
});
const enter = { key: "Enter", preventDefault() {} };
onChatKey({ ...enter, isComposing: true });
onChatKey({ ...enter, keyCode: 229 });
onChatKey({ ...enter, shiftKey: true });
assert.equal(submissions, 0);
onChatKey(enter);
assert.equal(submissions, 1);
