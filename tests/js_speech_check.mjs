/** 0.8.0 语音链路纯逻辑断言：录音状态机、草稿合并、迟到丢弃与出口唯一。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  AUDIO_FORMAT,
  PLAYBACK_STATES,
  RECORDER_STATES,
  RECORDING_LIMIT_MS,
  createSpeechRecorder,
  mergeDraft,
  nextPlaybackState,
  playbackNeedsSynthesize,
  snapshotMatches,
  speechCapabilities,
} from "../frontend/js/ux/speechRecorder.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let hits = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    hits += 1;
    process.stderr.write(`  FAIL ${name}: ${error.message}\n`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    hits += 1;
    process.stderr.write(`  FAIL ${name}: ${error.message}\n`);
  }
}

function fakeTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    setTimeout(fn) {
      seq += 1;
      pending.set(seq, fn);
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(id) {
      const fn = pending.get(id);
      pending.delete(id);
      fn?.();
    },
    pendingCount: () => pending.size,
  };
}

function fakeMedia(overrides = {}) {
  const grant = overrides.grant !== undefined ? overrides.grant : { id: "stream-1" };
  const stopResult = overrides.stopResult ?? "chunk-data";
  const calls = { request: 0, stopStream: 0, start: 0, aborted: 0 };
  return {
    calls,
    requestStream: async () => {
      calls.request += 1;
      return grant;
    },
    startRecorder: () => {
      calls.start += 1;
      return {
        stop: () => Promise.resolve(stopResult),
        abort: () => {
          calls.aborted += 1;
        },
      };
    },
    stopStream: () => {
      calls.stopStream += 1;
    },
  };
}

const FLUSH = () => new Promise((resolve) => setImmediate(resolve));

const IDLE = RECORDER_STATES.IDLE;
const REQUESTING = RECORDER_STATES.REQUESTING;
const RECORDING = RECORDER_STATES.RECORDING;
const PROCESSING = RECORDER_STATES.PROCESSING;
const DRAFT = RECORDER_STATES.DRAFT;
const DENIED = RECORDER_STATES.DENIED;

async function main() {
  console.log("JS-SPEECH-CHECK");

  // 24.1 状态迁移矩阵
  await checkAsync("迁移 idle→requesting→recording→processing→draft→idle", async () => {
    const timers = fakeTimers();
    const media = fakeMedia();
    const states = [];
    const chunks = [];
    const recorder = createSpeechRecorder({
      media, timers,
      onStateChange: (state) => states.push(state),
      onChunk: (chunk) => chunks.push(chunk),
    });
    assert.equal(recorder.state, IDLE);
    assert.equal(recorder.press({ studentId: null, workspaceId: "ws", taskId: "main", contentVersion: "1.0.0" }), true);
    assert.equal(recorder.state, REQUESTING);
    await FLUSH();
    assert.equal(recorder.state, RECORDING);
    assert.equal(media.calls.start, 1);
    assert.equal(recorder.release(), true);
    assert.equal(recorder.state, PROCESSING);
    await FLUSH();
    assert.equal(recorder.state, PROCESSING);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "chunk-data");
    assert.equal(recorder.finish("你好"), true);
    assert.equal(recorder.state, DRAFT);
    assert.equal(recorder.detail.text, "你好");
    assert.equal(recorder.reset(), true);
    assert.equal(recorder.state, IDLE);
    assert.deepEqual(states, [REQUESTING, RECORDING, PROCESSING, DRAFT, IDLE]);
  });

  await checkAsync("processing 中识别失败→idle；重复 press 被拒绝", async () => {
    const timers = fakeTimers();
    const media = fakeMedia();
    const recorder = createSpeechRecorder({ media, timers, onStateChange: () => {}, onChunk: () => {} });
    recorder.press({ studentId: null, workspaceId: "ws", taskId: "main", contentVersion: "1.0.0" });
    await FLUSH();
    assert.equal(recorder.state, RECORDING);
    assert.equal(recorder.press({}), false);
    recorder.release();
    assert.equal(recorder.fail(), true);
    assert.equal(recorder.state, IDLE);
  });

  // 24.2 15 秒定时与授权时序
  await checkAsync("15 秒定时自动结束且 release 后清理定时器", async () => {
    const timers = fakeTimers();
    const media = fakeMedia();
    const chunks = [];
    const recorder = createSpeechRecorder({
      media, timers, limitMs: RECORDING_LIMIT_MS, onStateChange: () => {}, onChunk: (c) => chunks.push(c),
    });
    recorder.press({ studentId: null, workspaceId: "ws", taskId: "main", contentVersion: "1.0.0" });
    await FLUSH();
    assert.equal(recorder.state, RECORDING);
    assert.equal(timers.pendingCount(), 1);
    timers.fire(1);
    assert.equal(recorder.state, PROCESSING);
    assert.equal(timers.pendingCount(), 0);
    await FLUSH();
    assert.equal(chunks.length, 1);
  });

  await checkAsync("授权完成晚于松手 → 不发送音频、提示再按一次", async () => {
    const timers = fakeTimers();
    const media = fakeMedia();
    const details = [];
    const recorder = createSpeechRecorder({
      media, timers, onStateChange: (state, extra) => details.push([state, extra]), onChunk: () => {
        throw new Error("授权前松手不得产生音频");
      },
    });
    recorder.press({ studentId: null, workspaceId: "ws", taskId: "main", contentVersion: "1.0.0" });
    assert.equal(recorder.state, REQUESTING);
    assert.equal(recorder.release(), true);
    await FLUSH();
    assert.equal(recorder.state, IDLE);
    assert.equal(recorder.detail.reason, "released_before_authorization");
    assert.equal(media.calls.start, 0);
    assert.equal(media.calls.stopStream, 1);
    assert.equal(media.calls.request, 1);
  });

  await checkAsync("授权被拒 → denied，打字始终可用", async () => {
    const timers = fakeTimers();
    const media = fakeMedia({ grant: null });
    const recorder = createSpeechRecorder({ media, timers, onStateChange: () => {}, onChunk: () => {} });
    recorder.press({ studentId: null, workspaceId: "ws", taskId: "main", contentVersion: "1.0.0" });
    await FLUSH();
    assert.equal(recorder.state, DENIED);
    assert.equal(recorder.detail.reason, "permission_denied");
    assert.equal(media.calls.stopStream, 0);
  });

  // 24.3 取消矩阵与迟到丢弃
  await checkAsync("取消矩阵：recording/requesting/processing 取消均回 idle", async () => {
    const timers = fakeTimers();
    const media = fakeMedia();
    const recorder = createSpeechRecorder({ media, timers, onStateChange: () => {}, onChunk: () => {} });
    recorder.press({ studentId: null, workspaceId: "ws", taskId: "main", contentVersion: "1.0.0" });
    await FLUSH();
    assert.equal(recorder.cancel(), true);
    assert.equal(recorder.state, IDLE);
    assert.equal(recorder.detail.reason, "cancelled");
    assert.equal(media.calls.aborted, 1);
    assert.equal(media.calls.stopStream, 1);
    assert.equal(timers.pendingCount(), 0);

    const media2 = fakeMedia();
    const recorder2 = createSpeechRecorder({ media: media2, timers, onStateChange: () => {}, onChunk: () => {} });
    recorder2.press({});
    assert.equal(recorder2.cancel(), true);
    assert.equal(recorder2.state, IDLE);
    await FLUSH();
    assert.equal(recorder2.state, IDLE);
    assert.equal(media2.calls.start, 0);

    const recorder3 = createSpeechRecorder({ media: fakeMedia(), timers, onStateChange: () => {}, onChunk: () => {} });
    assert.equal(recorder3.cancel(), false);
    assert.equal(recorder3.cancel(), false);
  });

  await checkAsync("迟到丢弃：快照四维核对", () => {
    const state = { studentId: "student-a", workspaceId: "ws-1", activeTaskId: "main", contentVersion: "1.0.0" };
    assert.equal(snapshotMatches({ studentId: "student-a", workspaceId: "ws-1", taskId: "main", contentVersion: "1.0.0" }, state), true);
    assert.equal(snapshotMatches({ studentId: "student-b", workspaceId: "ws-1", taskId: "main", contentVersion: "1.0.0" }, state), false);
    assert.equal(snapshotMatches({ studentId: "student-a", workspaceId: "ws-2", taskId: "main", contentVersion: "1.0.0" }, state), false);
    assert.equal(snapshotMatches({ studentId: "student-a", workspaceId: "ws-1", taskId: "other", contentVersion: "1.0.0" }, state), false);
    assert.equal(snapshotMatches({ studentId: "student-a", workspaceId: "ws-1", taskId: "main", contentVersion: "2.0.0" }, state), false);
    assert.equal(snapshotMatches(null, state), false);
    const headless = { studentId: null, workspaceId: "ws-1", activeTaskId: "main", contentVersion: "1.0.0" };
    assert.equal(snapshotMatches({ studentId: null, workspaceId: "ws-1", taskId: "main", contentVersion: "1.0.0" }, headless), true);
  });

  // 24.4 草稿四分支
  check("草稿合并：空稿直放", () => {
    const merged = mergeDraft("", "小车走了三步");
    assert.equal(merged.inserted, true);
    assert.equal(merged.value, "小车走了三步");
    assert.equal(merged.reason, null);
  });

  check("草稿合并：保留原稿以空格追加", () => {
    const merged = mergeDraft("为什么", "要重复三次");
    assert.equal(merged.inserted, true);
    assert.equal(merged.value, "为什么 要重复三次");
  });

  check("草稿合并：超 300 字不插入并提示", () => {
    const current = "原".repeat(150);
    const text = "新".repeat(151);
    const merged = mergeDraft(current, text);
    assert.equal(merged.inserted, false);
    assert.equal(merged.reason, "too_long");
    assert.equal(merged.value, current);
  });

  check("草稿合并：空文本不插入", () => {
    const merged = mergeDraft("已有草稿", "   ");
    assert.equal(merged.inserted, false);
    assert.equal(merged.reason, "empty_text");
    assert.equal(merged.value, "已有草稿");
  });

  await checkAsync("已取消的录音完成后不会上传或打断新录音", async () => {
    const chunks = [];
    let finishOldRecording;
    const media = fakeMedia();
    const startRecorder = media.startRecorder;
    media.startRecorder = () => {
      if (media.calls.start > 0) return startRecorder();
      media.calls.start += 1;
      return { stop: () => new Promise((resolve) => { finishOldRecording = resolve; }) };
    };
    const recorder = createSpeechRecorder({ media, timers: fakeTimers(), onChunk: (chunk) => chunks.push(chunk) });
    recorder.press({ workspaceId: "old" });
    await FLUSH();
    recorder.release();
    await FLUSH();
    recorder.cancel();
    recorder.press({ workspaceId: "new" });
    await FLUSH();
    finishOldRecording("old");
    await FLUSH();
    assert.equal(recorder.state, RECORDING);
    assert.deepEqual(chunks, []);
    assert.equal(media.calls.stopStream, 1);
    recorder.release();
    await FLUSH();
    assert.deepEqual(chunks, ["chunk-data"]);
  });

  // 能力检测四条件
  check("能力检测四条件", () => {
    const mediaDevices = { getUserMedia: () => {} };
    function recorderCtor() {}
    recorderCtor.isTypeSupported = (format) => format === AUDIO_FORMAT;
    assert.equal(speechCapabilities(true, mediaDevices, recorderCtor), true);
    assert.equal(speechCapabilities(false, mediaDevices, recorderCtor), false);
    assert.equal(speechCapabilities(true, {}, recorderCtor), false);
    assert.equal(speechCapabilities(true, null, recorderCtor), false);
    assert.equal(speechCapabilities(true, mediaDevices, null), false);
    assert.equal(speechCapabilities(true, mediaDevices, { isTypeSupported: () => true }), false);
    assert.equal(speechCapabilities(true, mediaDevices, function MediaRecorder() {}), false);
  });

  // 24.5 出口唯一：语音确认发送只走既有表单提交
  check("出口唯一：语音路径不新增提交调用", () => {
    const source = readFileSync(path.join(root, "frontend", "js", "views", "tutorChat.js"), "utf-8");
    assert.equal((source.match(/requestSubmit/g) || []).length, 1, "语音确认发送不得新增 requestSubmit 调用");
    assert.ok(!source.includes("api.chat(turn.payload, turn.snapshot.studentId);\n      applyDraft"), "草稿插入不得直接提交");
    const draftBlock = source.slice(source.indexOf("function applyDraft"), source.indexOf("function startMediaRecorder"));
    assert.ok(!draftBlock.includes("api.chat"), "applyDraft 不得直接调用对话接口");
    assert.ok(draftBlock.includes('voiceSourcePending = mode === "voice"'), "语音对话草稿必须标记为自动播报");
    assert.ok(source.includes('turn.source = "voice"'), "发送时必须落语音来源标记");
    assert.ok(!source.includes("source: \"voice\""), "来源标记不得进入请求载荷字面量");
  });

  // 24.6 只能由 C 类人工验收覆盖的条目
  console.log("  note C 类条目（浏览器人工验收，本脚本不可替代）：");
  console.log("    - 真实麦克风权限弹窗与录音指示器");
  console.log("    - MediaRecorder 实际产出 WebM/Opus 与识别可用性（开-2）");
  console.log("    - window blur/pointercancel 的真实触发");
  console.log("    - 键盘 Enter/Space 激活与听写快捷键");
  console.log("    - aria 状态在真实辅助技术下的播报");
  console.log("    - 真实 Audio 元素播放与自动播放拦截兜底（R-05）");

  // 29.1 播报状态机矩阵
  check("播报状态矩阵：play 分流（有音频→playing / 无音频→synthesizing）", () => {
    const IDLE = PLAYBACK_STATES.IDLE;
    assert.equal(nextPlaybackState(IDLE, "play", { hasAudio: false }), PLAYBACK_STATES.SYNTHESIZING);
    assert.equal(nextPlaybackState(IDLE, "play", { hasAudio: true }), PLAYBACK_STATES.PLAYING);
    assert.equal(nextPlaybackState(PLAYBACK_STATES.SYNTHESIZING, "ready", {}), PLAYBACK_STATES.PLAYING);
    assert.equal(nextPlaybackState(PLAYBACK_STATES.PLAYING, "played", {}), IDLE);
    assert.equal(nextPlaybackState(IDLE, "played", {}), IDLE);
    for (const event of ["stopped", "new_play", "press", "switch"]) {
      assert.equal(nextPlaybackState(PLAYBACK_STATES.PLAYING, event, {}), IDLE, event);
      assert.equal(nextPlaybackState(PLAYBACK_STATES.SYNTHESIZING, event, {}), IDLE, event);
      assert.equal(nextPlaybackState(PLAYBACK_STATES.FAILED, event, {}), PLAYBACK_STATES.FAILED, event);
    }
    assert.equal(nextPlaybackState(IDLE, "failed", {}), PLAYBACK_STATES.FAILED);
  });

  // 29.2 重播零新请求
  check("重播零新请求：已取得音频不再合成", () => {
    assert.equal(playbackNeedsSynthesize({ audioUrl: "blob:cached" }), false);
    assert.equal(playbackNeedsSynthesize({}), true);
    assert.equal(playbackNeedsSynthesize(null), false);
  });

  // 29.3 切换清理矩阵与单路互斥（静态源码断言）
  check("单路互斥：playTurn 先停旧播放、录音 press 先停播报", () => {
    const source = readFileSync(path.join(root, "frontend", "js", "views", "tutorChat.js"), "utf-8");
    const playBlock = source.slice(source.indexOf("async function playTurn"), source.indexOf("function blobToBase64"));
    assert.ok(playBlock.includes("stopPlayback()"), "playTurn 必须先停旧播放");
    const beginBlock = source.slice(source.indexOf("function beginRecording"), source.indexOf("function blobToBase64"));
    assert.ok(beginBlock.includes("stopPlayback()"), "录音 press 必须先停播报");
    assert.ok(source.includes("let currentPlayback = null;"), "组件级 currentPlayback 指针必须存在");
  });

  check("切换清理：停止 + abort + revokeObjectURL 三动作齐备", () => {
    const source = readFileSync(path.join(root, "frontend", "js", "views", "tutorChat.js"), "utf-8");
    const releaseBlock = source.slice(source.indexOf("function releasePlayback"), source.indexOf("function buildPlaybackControls"));
    assert.ok(releaseBlock.includes("stopPlayback()"), "清理必须先停播放");
    assert.ok(releaseBlock.includes("URL.revokeObjectURL"), "清理必须释放音频 URL");
    const stopBlock = source.slice(source.indexOf("function stopPlayback"), source.indexOf("function releasePlayback"));
    assert.ok(stopBlock.includes("abort?.abort()"), "停止必须中断在途合成");
    assert.ok(stopBlock.includes("pause()"), "停止必须暂停音频");
    const updateBlock = source.slice(source.indexOf("function updateContext"), source.indexOf("function explainRunAfterEdit"));
    assert.ok(updateBlock.includes("releasePlayback()"), "updateContext 清理点必须挂播报释放");
    assert.ok(updateBlock.includes("cancelSpeech()"), "updateContext 清理点必须挂录音取消");
  });

  check("文字先行：播报请求在回复渲染完成之后发起", () => {
    const source = readFileSync(path.join(root, "frontend", "js", "views", "tutorChat.js"), "utf-8");
    const renderPoint = source.indexOf("appendReplyDetails(turn.answer, reply);");
    const controlsPoint = source.indexOf("buildPlaybackControls(turn);");
    const autoPoint = source.indexOf('turn.source === "voice"');
    assert.ok(renderPoint > 0 && controlsPoint > renderPoint, "播放控件必须晚于回复渲染");
    assert.ok(autoPoint > controlsPoint, "自动播报必须晚于控件构建（文字先行）");
  });

  check("双形态响应：api.js 按 Content-Type 分流", () => {
    const source = readFileSync(path.join(root, "frontend", "js", "api.js"), "utf-8");
    const synthBlock = source.slice(source.indexOf("fetchSpeechSynthesize"));
    assert.ok(synthBlock.includes('startsWith("audio/")'), "audio/mpeg 分支必须返回 Blob");
    assert.ok(synthBlock.includes("await unwrap(response)"), "JSON 分支必须复用 unwrap 语义");
    assert.ok(synthBlock.includes("playable"), "双形态返回必须携带 playable 标记");
  });

  if (hits > 0) {
    process.stderr.write(`JS-SPEECH-CHECK FAILED: ${hits} failure(s)\n`);
    process.exitCode = 1;
  } else {
    console.log("JS-SPEECH-CHECK PASSED");
  }
}

await main();
