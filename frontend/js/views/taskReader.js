import { API } from "../api.js";
import { captureLearningContext } from "../core/viewContext.js";
import { snapshotMatches } from "../ux/speechRecorder.js";

export function createTaskReader({ state, onStart, api = API }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-button task-read-button";
  button.textContent = "朗读任务";

  const status = document.createElement("p");
  status.className = "muted task-reader-status";
  status.setAttribute("role", "status");

  let context = null;
  let playback = null;
  let clips = new Map();

  function stop() {
    const active = playback;
    playback = null;
    active?.controller.abort();
    active?.audio?.pause();
    button.textContent = "朗读任务";
    status.textContent = "";
  }

  function updateContext() {
    if (!snapshotMatches(context, state)) {
      stop();
      for (const clip of clips.values()) URL.revokeObjectURL(clip.url);
      clips.clear();
      context = captureLearningContext(state);
    }
    button.setAttribute("aria-disabled", String(state.startup?.tutorSpeechEnabled !== true));
  }

  async function playPart(active, part) {
    try {
      let clip = clips.get(part);
      if (!clip) {
        status.textContent = "正在准备朗读…";
        const { taskId, contentVersion, studentId } = active.context;
        const result = await api.speechTask(taskId, contentVersion, part, active.controller.signal, studentId);
        if (playback !== active) return;
        clip = { url: URL.createObjectURL(result.blob), hasMore: result.hasMore };
        clips.set(part, clip);
      }

      const audio = new Audio(clip.url);
      active.audio = audio;
      audio.addEventListener("ended", () => {
        if (playback !== active || active.audio !== audio) return;
        if (clip.hasMore) {
          void playPart(active, part + 1);
        } else {
          stop();
        }
      }, { once: true });
      audio.addEventListener("error", () => {
        if (playback !== active || active.audio !== audio) return;
        URL.revokeObjectURL(clip.url);
        clips.delete(part);
        stop();
        status.textContent = "暂时无法播放，可以再试一次。";
      }, { once: true });
      await audio.play();
      if (playback === active && active.audio === audio) status.textContent = "";
    } catch (error) {
      if (playback !== active) return;
      stop();
      status.textContent = error.messageForChild || "暂时读不了这个任务，可以再试一次。";
    }
  }

  button.addEventListener("click", () => {
    updateContext();
    if (button.getAttribute("aria-disabled") === "true") {
      status.textContent = "SIS 语音未启用，请检查后端配置。";
      return;
    }
    if (playback) {
      stop();
      return;
    }
    onStart?.();
    playback = { context, controller: new AbortController(), audio: null };
    button.textContent = "停止朗读";
    void playPart(playback, 0);
  });

  return { button, status, stop, updateContext };
}
