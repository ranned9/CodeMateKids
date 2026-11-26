/** 工作区内连续对话，积木与回放操作绑定发送时的快照。 */
import { API } from "../api.js";
import { captureLearningContext, isLearningContextCurrent } from "../core/viewContext.js";
import { buildProgram } from "../editor/model.js";
import { addSeenHint, buildLearningContext, createWorkspaceId, workspaceLearningScope } from "../ux/learningContext.js";
import { createReplayPlayer } from "../ux/replayPlayer.js";
import { AUDIO_FORMAT, PLAYBACK_STATES, RECORDER_STATES, createSpeechRecorder, mergeDraft, nextPlaybackState, snapshotMatches, speechCapabilities } from "../ux/speechRecorder.js";
import { appendDiv, appendParagraph, clearNode } from "../util/dom.js";
import { ACTION_LABEL, renderReplay } from "./tutor.js";

const PRESS_TO_TALK_MS = 350;

export function createTutorChat({ elements, state, editor, onLocate, onReplayFrame, api = API, speechEnabled = false, onSpeechStart }) {
  const { log, form, input, submit, selection, speechButton, voiceButton, speechNote } = elements;
  const speechControls = [[speechButton, "dictation"], [voiceButton, "voice"]].filter(([button]) => button);
  let activeScope = null;
  let welcome = log.firstElementChild;
  let pending = null;
  let awaiting = null;
  let pendingEdit = null;
  let turns = [];
  let recorder = null;
  let recognizeController = null;
  let voiceSourcePending = false;
  let currentPlayback = null;
  const speechPrivacyNotice = "录音结束后会发往华为云转写。";

  function sameWorkspace(snapshot) {
    return snapshot.studentId === (state.studentId ?? null) &&
      snapshot.workspaceId === state.workspaceId && snapshot.taskId === state.activeTaskId &&
      snapshot.contentVersion === state.contentVersion;
  }

  function updateContext() {
    if (!activeScope || !sameWorkspace(activeScope)) {
      cancelSpeech();
      recorder?.reset();
      showSpeechNotice("");
      releasePlayback();
      for (const turn of turns) turn.finishReplay?.();
      activeScope = captureLearningContext(state);
      pending = null;
      awaiting = null;
      pendingEdit = null;
      turns = [];
      input.value = "";
      voiceSourcePending = false;
      clearNode(log);
      welcome = appendParagraph(log, "你好，我是海龟老师。搭积木时卡住了，随时问我。", "tutor-welcome");
    }
    const kind = editor.layout?.nodes.find((node) => node.blockId === state.selectedBlockId)?.kind;
    const definition = state.blocksByKind.get(kind);
    selection.hidden = !definition;
    selection.textContent = definition ? `当前积木 · ${definition.label || definition.title || kind}` : "";
    submit.disabled = Boolean(pending) || !state.tasks.has(state.activeTaskId);
    if (recorder) setSpeechUi(recorder.state);
    const visible = !log.closest("[hidden]");
    for (const turn of turns) {
      const current = isLearningContextCurrent(state, turn.snapshot);
      if (turn.staleNotice) turn.staleNotice.hidden = current;
      if (turn.controls) turn.controls.hidden = !current;
      if (!visible || !current) turn.finishReplay?.();
      if (visible && turn.hintId && !turn.seen) {
        state.seenHintIds = addSeenHint(state.seenHintIds, turn.hintId).seen;
        turn.seen = true;
      }
    }
    explainRunAfterEdit();
  }

  function explainRunAfterEdit() {
    if (!pendingEdit) return;
    if (pendingEdit.programRevision !== state.programRevision) {
      pendingEdit = null;
      return;
    }
    const result = state.lastResult;
    if (result?.status !== "completed" || state.lastResultOwnership !== "current" ||
        state.lastRunContext?.requestId === pendingEdit.originalRunId ||
        state.lastRunContext?.programRevision !== pendingEdit.programRevision) return;

    const row = appendDiv(log, "", "tutor-turn");
    appendParagraph(row, describeEditedRun(result, pendingEdit.edit), "tutor-chat-reply");
    pendingEdit = null;
    scrollToLatest();
  }

  async function submitTurn(turn) {
    pending = turn;
    clearNode(turn.answer);
    appendParagraph(turn.answer, "小老师正在想…", "tutor-chat-meta");
    updateContext();
    scrollToLatest();
    try {
      const reply = await api.chat(turn.payload, turn.snapshot.studentId);
      if (!sameWorkspace(turn.snapshot) || pending !== turn) return;

      clearNode(turn.answer);
      const isCurrent = () => sameWorkspace(turn.snapshot) && isLearningContextCurrent(state, turn.snapshot);
      if (reply.edit) {
        if (!isCurrent() || turn.payload.selectedBlockId !== state.selectedBlockId ||
            !editor.applyTeachingEdit(reply.edit)) {
          appendParagraph(turn.answer, "这次还没有改动积木。等当前操作结束后，可以再请我看看。", "tutor-chat-reply");
          awaiting = null;
          return;
        }
        pendingEdit = {
          edit: reply.edit, programRevision: state.programRevision, originalRunId: turn.snapshot.runRequestId,
        };
        turn.snapshot = captureLearningContext(state);
        if (reply.hintId) {
          state.seenHintIds = addSeenHint(state.seenHintIds, reply.hintId).seen;
          turn.seen = true;
        }
      }
      appendParagraph(turn.answer, reply.message, "tutor-chat-reply");
      const casual = reply.action === "conversation";
      if (!reply.edit && !casual) {
        turn.staleNotice = appendParagraph(turn.answer, "这条回复参考了之前的积木或运行。", "tutor-chat-meta");
      }
      turn.hintId = reply.hintId;
      awaiting = reply.awaitingAnswer ? reply.turnId : null;
      if (reply.mode !== "model" && !reply.edit && !casual) {
        appendParagraph(turn.answer, "本地教学回复", "tutor-chat-meta");
      }
      if (reply.memorySaved === false) {
        appendParagraph(turn.answer, "学习进度暂时无法保存。", "tutor-chat-meta");
      }
      if (reply.controls?.length && isCurrent()) {
        turn.controls = appendDiv(turn.answer, "", "tutor-chat-tools");
        for (const control of reply.controls) {
          if (control.type === "locate_block") {
            addButton(turn.controls, "看看这块积木", () => {
              if (isCurrent()) onLocate?.(control.blockId);
            });
          } else if (control.type === "replay" && control.runRequestId === turn.runId) {
            const player = createReplayPlayer(state.lastResult?.learning?.replay);
            if (player.snapshot().state === "ready") {
              ({ finishReplay: turn.finishReplay } = renderReplay(turn.controls, player, isCurrent, onReplayFrame));
            }
          }
        }
      }
      appendReplyDetails(turn.answer, reply);
      if (speechEnabled) {
        buildPlaybackControls(turn);
        if (turn.source === "voice") {
          void playTurn(turn);
        }
      }
    } catch (error) {
      if (!sameWorkspace(turn.snapshot) || pending !== turn) return;
      clearNode(turn.answer);
      appendParagraph(turn.answer, error.messageForChild || "这条消息暂时没发出去。", "tutor-chat-meta");
      const conflict = error.code === "TUTOR_TURN_CONFLICT";
      addButton(turn.answer, conflict ? "重新提问" : "再试一次", () => {
        if (!pending && sameWorkspace(turn.snapshot)) {
          if (!conflict && isLearningContextCurrent(state, turn.snapshot)) {
            submitTurn(turn);
          } else {
            input.value ||= turn.payload.message;
            input.focus();
          }
        }
      });
    } finally {
      if (pending === turn) {
        pending = null;
        updateContext();
        scrollToLatest();
      }
    }
  }

  function scrollToLatest() {
    log.scrollTop = log.scrollHeight;
  }

  function setSpeechUi(next) {
    const pressed = next === RECORDER_STATES.RECORDING || next === RECORDER_STATES.REQUESTING;
    for (const [button, mode] of speechControls) {
      const active = pressed && recorder.snapshot.speechMode === mode;
      button.setAttribute("aria-pressed", String(active));
      button.dataset.recording = String(active && next === RECORDER_STATES.RECORDING);
      button.disabled = !pressed && (Boolean(pending) || !state.tasks.has(state.activeTaskId));
      button.setAttribute("aria-disabled", String(button.disabled || next === RECORDER_STATES.PROCESSING || (pressed && !active)));
    }
  }

  function showSpeechNotice(text) {
    if (!speechNote) return;
    speechNote.textContent = text;
    speechNote.hidden = !text;
  }

  function cancelSpeech() {
    if (!recorder) return;
    recognizeController?.abort();
    recognizeController = null;
    recorder.cancel();
    setSpeechUi(recorder.state);
  }

  function resetPlayButton(turn, label = turn.audioUrl ? "重播" : "听老师说") {
    const controls = turn.playControls;
    if (!controls) return;
    controls.playButton.disabled = false;
    controls.playButton.textContent = label;
    controls.stopButton.hidden = true;
  }

  function disablePlayback(turn, message) {
    const controls = turn.playControls;
    if (!controls) return;
    controls.playButton.disabled = true;
    controls.playButton.textContent = message || "语音播放不可用";
    controls.stopButton.hidden = true;
    turn.playbackState = nextPlaybackState(turn.playbackState, "failed", { hasAudio: false });
  }

  function stopPlayback() {
    const playback = currentPlayback;
    currentPlayback = null;
    if (!playback) return;
    playback.abort?.abort();
    try {
      playback.audio?.pause();
    } catch {
      // 音频已释放则忽略。
    }
    const turn = playback.turn;
    turn.playbackState = nextPlaybackState(turn.playbackState, "stopped", { hasAudio: Boolean(turn.audioUrl) });
    resetPlayButton(turn);
  }

  function releasePlayback() {
    stopPlayback();
    for (const turn of turns) {
      if (turn.audioUrl) {
        URL.revokeObjectURL(turn.audioUrl);
        turn.audioUrl = null;
        turn.playbackState = nextPlaybackState(turn.playbackState, "switch", { hasAudio: false });
        resetPlayButton(turn);
      }
    }
  }

  function buildPlaybackControls(turn) {
    const row = appendDiv(turn.answer, "", "tutor-chat-tools");
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "ghost-button";
    playButton.textContent = "听老师说";
    row.appendChild(playButton);
    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.className = "ghost-button";
    stopButton.textContent = "停止";
    stopButton.hidden = true;
    row.appendChild(stopButton);
    playButton.addEventListener("click", () => {
      void playTurn(turn);
    });
    stopButton.addEventListener("click", () => stopPlayback());
    const status = appendParagraph(row, "", "tutor-chat-meta");
    status.setAttribute("role", "status");
    status.hidden = true;
    turn.playControls = { playButton, stopButton, status };
    turn.playbackState = PLAYBACK_STATES.IDLE;
  }

  async function startPlayback(turn) {
    const audio = new Audio(turn.audioUrl);
    currentPlayback = { turn, audio };
    turn.playbackState = nextPlaybackState(turn.playbackState, "play", { hasAudio: true });
    turn.playControls.playButton.disabled = true;
    turn.playControls.playButton.textContent = "播放中…";
    turn.playControls.stopButton.hidden = false;
    audio.addEventListener("ended", () => {
      if (currentPlayback?.audio === audio) {
        currentPlayback = null;
        turn.playbackState = nextPlaybackState(turn.playbackState, "played", { hasAudio: true });
        resetPlayButton(turn);
      }
    });
    try {
      await audio.play();
    } catch {
      // 自动播放被浏览器拦截：不报错，恢复按钮由学生手动播放（R-05）。
      if (currentPlayback?.audio === audio) {
        currentPlayback = null;
        resetPlayButton(turn, "播放");
      }
    }
  }

  async function playTurn(turn) {
    const controls = turn?.playControls;
    if (!controls || controls.playButton.disabled) return;
    if (recorder?.state === RECORDER_STATES.RECORDING || recorder?.state === RECORDER_STATES.REQUESTING) return;
    controls.status.hidden = true;
    onSpeechStart?.();
    stopPlayback();
    if (turn.audioUrl) {
      await startPlayback(turn);
      return;
    }
    const abort = new AbortController();
    currentPlayback = { turn, audio: null, abort };
    turn.playbackState = nextPlaybackState(turn.playbackState, "play", { hasAudio: false });
    controls.playButton.disabled = true;
    controls.playButton.textContent = "正在合成…";
    controls.stopButton.hidden = false;
    try {
      const result = await api.speechSynthesize(
        turn.payload.learningContext.turnId,
        turn.payload.learningContext.scope,
        abort.signal,
        turn.snapshot.studentId ?? null,
      );
      if (currentPlayback?.abort !== abort) return;
      if (result?.playable === false) {
        currentPlayback = null;
        disablePlayback(turn, "这条回复太长，先看看文字吧。");
        return;
      }
      turn.audioUrl = URL.createObjectURL(result.blob);
      await startPlayback(turn);
    } catch (error) {
      if (currentPlayback?.abort !== abort) return;
      currentPlayback = null;
      resetPlayButton(turn, "重试播放");
      controls.status.textContent = error.messageForChild || "语音播放暂时不可用。";
      controls.status.hidden = false;
    }
  }

  function beginRecording(mode) {
    if (!recorder.press({ ...captureLearningContext(state), speechMode: mode })) return false;
    onSpeechStart?.();
    stopPlayback();
    return true;
  }

  function endRecording() {
    recorder?.release();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function submitRecognize(chunk, snapshot) {
    recognizeController?.abort();
    const controller = new AbortController();
    recognizeController = controller;
    const isCurrent = () => recognizeController === controller && snapshotMatches(snapshot, state);
    try {
      const audioBase64 = await blobToBase64(chunk);
      if (!isCurrent()) return;
      const data = await api.speechRecognize(audioBase64, controller.signal, snapshot.studentId ?? null);
      if (!isCurrent() || recorder?.state !== RECORDER_STATES.PROCESSING) return;
      applyDraft(String(data?.text ?? ""), snapshot.speechMode);
    } catch (error) {
      if (!isCurrent()) return;
      recorder?.fail();
      showSpeechNotice(error.messageForChild || "没听清这一句，可以再说一次或打字。");
    } finally {
      if (recognizeController === controller) recognizeController = null;
    }
  }

  function applyDraft(text, mode) {
    const merged = mergeDraft(input.value, text);
    if (merged.reason === "empty_text") {
      recorder?.fail();
      showSpeechNotice("没有听到声音，再试一次吧。");
      return;
    }
    if (merged.reason === "too_long") {
      recorder?.fail();
      showSpeechNotice("转写文字和已有内容放不下，先缩短一点。");
      return;
    }
    input.value = merged.value;
    recorder?.finish(text);
    showSpeechNotice("看看文字对不对，再点发送。");
    voiceSourcePending = mode === "voice";
    input.focus();
  }

  function startMediaRecorder(stream) {
    try {
      const mediaRecorder = new MediaRecorder(stream, { mimeType: AUDIO_FORMAT });
      const chunks = [];
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      mediaRecorder.start();
      return {
        stop: () => new Promise((resolve, reject) => {
          mediaRecorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: mediaRecorder.mimeType }) : null);
          mediaRecorder.onerror = (event) => reject(event.error);
          mediaRecorder.stop();
        }),
        abort: () => {
          try {
            mediaRecorder.stop();
          } catch {
            // 已停止则忽略。
          }
        },
      };
    } catch {
      return null;
    }
  }

  function setupSpeech() {
    if (!speechButton) return;
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    const recorderCtor = typeof window !== "undefined" ? window.MediaRecorder : null;
    if (!speechCapabilities(speechEnabled, mediaDevices, recorderCtor)) {
      const reason = speechEnabled ? "当前浏览器不支持录音。" : "语音未启用，请检查后端 SIS 配置并重启 Demo。";
      const hint = speechEnabled ? "浏览器不支持录音" : "SIS 语音未启用";
      for (const [button] of speechControls) {
        const tooltip = button.closest(".speech-tool")?.querySelector(".speech-tooltip");
        if (tooltip) tooltip.textContent = `${button.getAttribute("aria-label")} · ${hint}`;
        button.setAttribute("aria-description", reason);
        button.addEventListener("click", () => showSpeechNotice(reason));
      }
      return;
    }
    speechButton.setAttribute("aria-keyshortcuts", "Alt+Shift+D");
    recorder = createSpeechRecorder({
      media: {
        requestStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
        startRecorder: (stream) => startMediaRecorder(stream),
        stopStream: (granted) => {
          for (const track of granted.getTracks?.() ?? []) track.stop();
        },
      },
      onStateChange: (next, detail) => {
        setSpeechUi(next);
        if (next === RECORDER_STATES.REQUESTING) {
          showSpeechNotice(speechPrivacyNotice);
        } else if (next === RECORDER_STATES.RECORDING) {
          showSpeechNotice("录音中。再点一次结束，录音会发往华为云转写。");
        } else if (next === RECORDER_STATES.PROCESSING) {
          showSpeechNotice("正在识别…");
        } else if (next === RECORDER_STATES.DENIED) {
          showSpeechNotice("录音没有开始，可以直接打字提问。");
        } else if (detail.reason === "released_before_authorization") {
          showSpeechNotice("再点一次开始说话。");
        } else if (detail.reason === "empty_recording") {
          showSpeechNotice("没有听到声音，再试一次吧。");
        } else if (detail.reason === "recorder_failed" || detail.reason === "recorder_unavailable") {
          showSpeechNotice("录音没有完成，请再试一次或打字。");
        } else if (detail.reason === "cancelled") {
          showSpeechNotice("");
        }
      },
      onChunk: (chunk, snapshot) => {
        void submitRecognize(chunk, snapshot);
      },
    });
    setSpeechUi(recorder.state);
    let pointer = null;
    function toggleRecording(button, mode) {
      if (button.getAttribute("aria-disabled") === "true") return false;
      if (button.getAttribute("aria-pressed") === "true") {
        endRecording();
        return false;
      }
      return beginRecording(mode);
    }

    function cancelPointer(event) {
      if (event.pointerId !== pointer?.id) return;
      pointer = null;
      cancelSpeech();
    }

    for (const [button, mode] of speechControls) {
      button.addEventListener("pointerdown", (event) => {
        if (!event.isPrimary || event.button !== 0 || pointer) return;
        event.preventDefault();
        if (toggleRecording(button, mode)) {
          pointer = { id: event.pointerId, start: event.timeStamp };
          button.setPointerCapture(event.pointerId);
        }
      });
      button.addEventListener("pointerup", (event) => {
        if (event.pointerId !== pointer?.id) return;
        const held = event.timeStamp - pointer.start >= PRESS_TO_TALK_MS;
        pointer = null;
        if (held) endRecording();
      });
      button.addEventListener("pointercancel", cancelPointer);
      button.addEventListener("lostpointercapture", cancelPointer);
      button.addEventListener("click", (event) => {
        if (event.detail === 0) toggleRecording(button, mode);
      });
      button.addEventListener("keydown", (event) => {
        if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
      });
    }
    window.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.isComposing || form.closest("[hidden]")) return;
      if (event.code === "KeyD" && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (!event.repeat) toggleRecording(speechButton, "dictation");
      } else if (event.key === "Escape" && [RECORDER_STATES.REQUESTING, RECORDER_STATES.RECORDING, RECORDER_STATES.PROCESSING].includes(recorder.state)) {
        event.preventDefault();
        pointer = null;
        cancelSpeech();
      }
    });
    window.addEventListener("blur", () => {
      pointer = null;
      cancelSpeech();
    });
  }

  function send(event) {
    event.preventDefault();
    const message = input.value.trim();
    if (pending || !message) return;

    const snapshot = captureLearningContext(state);
    const task = state.tasks.get(snapshot.taskId);
    const scope = workspaceLearningScope(state, snapshot.taskId);
    if (!task || !scope) return;
    const runId = state.lastResultOwnership === "current" ? state.lastRunContext?.requestId : null;
    const learningContext = buildLearningContext({
      scope, program: buildProgram(state.root, task), runRequestId: runId,
      predictionId: state.predictionIds?.get(snapshot.taskId), seenHintIds: state.seenHintIds,
      workspaceSource: state.artifactSource, turnId: createWorkspaceId("turn"), replyToTurnId: awaiting,
    });

    for (const turn of turns) turn.finishReplay?.();
    welcome?.remove();
    welcome = null;
    const row = appendDiv(log, "", "tutor-turn");
    appendParagraph(row, message, "tutor-chat-student");
    const turn = {
      snapshot, runId, answer: appendDiv(row, "", "tutor-turn"),
      payload: { taskId: snapshot.taskId, message, selectedBlockId: state.selectedBlockId, learningContext },
    };
    turns.push(turn);
    if (voiceSourcePending) {
      turn.source = "voice";
      voiceSourcePending = false;
    }
    cancelSpeech();
    recorder?.reset();
    showSpeechNotice("");
    input.value = "";
    submitTurn(turn);
  }

  setupSpeech();
  form.addEventListener("submit", send);
  input.addEventListener("input", () => {
    if (!input.value.trim() && recorder?.reset()) {
      voiceSourcePending = false;
      showSpeechNotice("");
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  return { updateContext, interruptSpeech() {
    cancelSpeech();
    stopPlayback();
  }, focus() {
    input.focus();
    scrollToLatest();
  } };
}

export function describeEditedRun(result, edit) {
  const stage = result.objects?.find((object) => object.id === "stage");
  const { steps, moves, heading } = stage || {};
  const observations = [];
  if (Number.isInteger(steps) && Number.isInteger(moves)) {
    observations.push(`调整后，海龟前进了 ${moves} 次，一共走了 ${steps} 步。`);
  }
  if (edit.field === "degrees" && Number.isFinite(heading)) {
    observations.push(`海龟最后朝向 ${heading}°。`);
  }
  const change = edit.field === "times" && Number.isInteger(edit.previousMoves) && Number.isInteger(moves)
    ? { after: moves, before: edit.previousMoves, label: "前进", unit: "次" }
    : edit.field === "steps" && Number.isInteger(edit.previousSteps) && Number.isInteger(steps)
      ? { after: steps, before: edit.previousSteps, label: "走", unit: "步" }
      : null;
  if (change && change.after !== change.before) {
    const delta = change.after - change.before;
    observations.push(`和改前相比，海龟${delta > 0 ? "多" : "少"}${change.label}了 ${Math.abs(delta)} ${change.unit}。`);
  }
  observations.push(result.success === true ? "这次达到任务目标了。" : "这次还没达到任务目标。");
  return observations.join("");
}

function appendReplyDetails(parent, reply) {
  const action = ACTION_LABEL[reply.action];
  if (!action) return;
  const details = document.createElement("details");
  details.className = "tutor-chat-meta";
  const summary = document.createElement("summary");
  summary.textContent = "回复详情";
  details.appendChild(summary);
  appendParagraph(details, reply.supportLevel ? `${action} · 提示级别 ${reply.supportLevel}` : action);
  if (reply.fallbackReason === "invalid_response") {
    appendParagraph(details, "模型回复未通过校验，这次使用了本地教学回复。");
  } else if (reply.fallbackReason === "repeated_question") {
    appendParagraph(details, "模型重复了上一轮的问题，这次使用了本地教学回复。");
  } else if (reply.fallbackReason && reply.fallbackReason !== "unconfigured") {
    appendParagraph(details, "模型暂时无法完成这次回答。");
  }
  parent.appendChild(details);
}

function addButton(parent, label, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-button";
  button.textContent = label;
  button.addEventListener("click", callback);
  parent.appendChild(button);
}
