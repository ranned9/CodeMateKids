/** 按住说话录音状态机纯逻辑：状态迁移、授权时序、15 秒上限、取消矩阵与迟到丢弃。 */

export const RECORDER_STATES = {
  IDLE: "idle",
  REQUESTING: "requesting",
  RECORDING: "recording",
  PROCESSING: "processing",
  DRAFT: "draft",
  DENIED: "denied",
};

export const RECORDING_LIMIT_MS = 15000;

export const AUDIO_FORMAT = "audio/webm;codecs=opus";

/** 能力检测四条件：启动开关 + getUserMedia + MediaRecorder + WebM/Opus 支持。 */
export function speechCapabilities(enabled, mediaDevices, recorder) {
  return Boolean(
    enabled &&
    typeof mediaDevices?.getUserMedia === "function" &&
    typeof recorder === "function" &&
    typeof recorder.isTypeSupported === "function" &&
    recorder.isTypeSupported(AUDIO_FORMAT)
  );
}

/** 迟到丢弃判定：发起快照与当前工作区四维核对。 */
export function snapshotMatches(snapshot, state) {
  return Boolean(snapshot) &&
    snapshot.studentId === (state?.studentId ?? null) &&
    snapshot.workspaceId === state?.workspaceId &&
    snapshot.taskId === state?.activeTaskId &&
    snapshot.contentVersion === state?.contentVersion;
}

/** 草稿合并策略：空稿直放、非空空格追加、超 300 不插入。 */
export function mergeDraft(currentValue, text, limit = 300) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return { value: currentValue, inserted: false, reason: "empty_text" };
  }
  const base = String(currentValue ?? "").trim();
  const merged = base ? `${base} ${trimmed}` : trimmed;
  if (merged.length > limit) {
    return { value: currentValue, inserted: false, reason: "too_long" };
  }
  return { value: merged, inserted: true, reason: null };
}

export const PLAYBACK_STATES = {
  IDLE: "idle",
  SYNTHESIZING: "synthesizing",
  PLAYING: "playing",
  FAILED: "failed",
};

/** 播报状态迁移矩阵（纯逻辑）：play/ready/played/stopped/new_play/press/switch/failed。 */
export function nextPlaybackState(state, event, { hasAudio = false } = {}) {
  switch (event) {
    case "play":
      return hasAudio ? PLAYBACK_STATES.PLAYING : PLAYBACK_STATES.SYNTHESIZING;
    case "ready":
      return state === PLAYBACK_STATES.SYNTHESIZING ? PLAYBACK_STATES.PLAYING : state;
    case "played":
      return state === PLAYBACK_STATES.PLAYING ? PLAYBACK_STATES.IDLE : state;
    case "stopped":
    case "new_play":
    case "press":
    case "switch":
      return state === PLAYBACK_STATES.PLAYING || state === PLAYBACK_STATES.SYNTHESIZING
        ? PLAYBACK_STATES.IDLE
        : state;
    case "failed":
      return PLAYBACK_STATES.FAILED;
    default:
      return state;
  }
}

/** 重播零新请求：已取得音频（Blob URL）时不发合成请求。 */
export function playbackNeedsSynthesize(turn) {
  return Boolean(turn) && !turn.audioUrl;
}

/**
 * 录音状态机。media/timers 全部注入，纯逻辑无 DOM、无网络：
 * - media.requestStream(): Promise<stream|null>  授权请求，null 表示拒绝或不可用
 * - media.startRecorder(stream): {stop(): Promise<chunk|null>, abort?: () => void} | null
 * - media.stopStream(stream): void
 * - onChunk(chunk, snapshot): void  录音就绪，由视图发起识别
 * - onStateChange(state, detail): void
 */
export function createSpeechRecorder({ media, timers, onStateChange, onChunk, limitMs = RECORDING_LIMIT_MS }) {
  const safeTimers = timers ?? { setTimeout, clearTimeout };
  let state = RECORDER_STATES.IDLE;
  let detail = {};
  let snapshot = null;
  let holdActive = false;
  let stream = null;
  let recorder = null;
  let timerId = null;
  let recordingId = 0;

  function transition(next, extra = {}) {
    state = next;
    detail = extra;
    onStateChange?.(next, extra);
  }

  function clearTimer() {
    if (timerId != null) {
      safeTimers.clearTimeout(timerId);
      timerId = null;
    }
  }

  function teardownStream() {
    if (stream != null) {
      media.stopStream(stream);
      stream = null;
    }
  }

  function finishRecording() {
    const current = recorder;
    const finishedId = recordingId;
    const finishedSnapshot = snapshot;
    recorder = null;
    clearTimer();
    transition(RECORDER_STATES.PROCESSING);
    Promise.resolve()
      .then(() => (current ? current.stop() : null))
      .then((chunk) => {
        if (finishedId !== recordingId) return;
        teardownStream();
        if (chunk == null) {
          transition(RECORDER_STATES.IDLE, { reason: "empty_recording" });
          return;
        }
        onChunk?.(chunk, finishedSnapshot);
      })
      .catch(() => {
        if (finishedId !== recordingId) return;
        teardownStream();
        transition(RECORDER_STATES.IDLE, { reason: "recorder_failed" });
      });
  }

  function startRecording() {
    recorder = media.startRecorder(stream);
    if (recorder == null) {
      teardownStream();
      transition(RECORDER_STATES.IDLE, { reason: "recorder_unavailable" });
      return;
    }
    transition(RECORDER_STATES.RECORDING);
    timerId = safeTimers.setTimeout(() => {
      timerId = null;
      if (state === RECORDER_STATES.RECORDING && recorder != null) {
        finishRecording();
      }
    }, limitMs);
  }

  return {
    get state() {
      return state;
    },
    get detail() {
      return detail;
    },
    get snapshot() {
      return snapshot;
    },
    press(pressedSnapshot) {
      if (state !== RECORDER_STATES.IDLE && state !== RECORDER_STATES.DENIED && state !== RECORDER_STATES.DRAFT) {
        return false;
      }
      const requestedId = ++recordingId;
      snapshot = pressedSnapshot;
      holdActive = true;
      transition(RECORDER_STATES.REQUESTING);
      Promise.resolve()
        .then(() => media.requestStream())
        .then((granted) => {
          if (requestedId !== recordingId) {
            if (granted != null) media.stopStream(granted);
            return;
          }
          if (granted == null) {
            transition(RECORDER_STATES.DENIED, { reason: "permission_denied" });
            return;
          }
          stream = granted;
          if (!holdActive) {
            teardownStream();
            transition(RECORDER_STATES.IDLE, { reason: "released_before_authorization" });
            return;
          }
          startRecording();
        })
        .catch(() => {
          if (requestedId === recordingId && state === RECORDER_STATES.REQUESTING) {
            teardownStream();
            transition(RECORDER_STATES.DENIED, { reason: "request_failed" });
          }
        });
      return true;
    },
    release() {
      if (state === RECORDER_STATES.REQUESTING) {
        holdActive = false;
        return true;
      }
      if (state === RECORDER_STATES.RECORDING && recorder != null) {
        finishRecording();
        return true;
      }
      return false;
    },
    cancel() {
      if (state === RECORDER_STATES.REQUESTING) {
        recordingId++;
        holdActive = false;
        transition(RECORDER_STATES.IDLE, { reason: "cancelled" });
        return true;
      }
      if (state === RECORDER_STATES.RECORDING && recorder != null) {
        clearTimer();
        const current = recorder;
        recorder = null;
        try {
          current.abort?.();
        } catch {
          // 录音器停止失败时忽略，音频随后随 stopStream 丢弃。
        }
        teardownStream();
        transition(RECORDER_STATES.IDLE, { reason: "cancelled" });
        return true;
      }
      if (state === RECORDER_STATES.PROCESSING) {
        recordingId++;
        teardownStream();
        transition(RECORDER_STATES.IDLE, { reason: "cancelled" });
        return true;
      }
      return false;
    },
    finish(text) {
      if (state !== RECORDER_STATES.PROCESSING) return false;
      transition(RECORDER_STATES.DRAFT, { text });
      return true;
    },
    fail() {
      if (state !== RECORDER_STATES.PROCESSING) return false;
      transition(RECORDER_STATES.IDLE, { reason: "recognize_failed" });
      return true;
    },
    reset() {
      if (state !== RECORDER_STATES.DRAFT) return false;
      transition(RECORDER_STATES.IDLE);
      return true;
    },
  };
}
