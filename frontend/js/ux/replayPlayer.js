/** 回放状态机：只消费后端 replay；不可用时不得提供分步控件。 */

export const REPLAY_STATES = ["ready", "unavailable"];

export function createReplayPlayer(replay = null, options = {}) {
  const actions = Array.isArray(replay?.actions) ? replay.actions : [];
  const available = Boolean(replay) && actions.length > 0;
  let index = 0;

  function snapshot() {
    return {
      state: available ? "ready" : "unavailable",
      index,
      total: actions.length,
      hasMore: Boolean(replay?.hasMore),
      atStart: index === 0,
      atEnd: index >= actions.length,
      action: available && index > 0 ? actions[index - 1] : null,
    };
  }

  return {
    snapshot,
    next() {
      if (!available || index >= actions.length) {
        return snapshot();
      }
      index += 1;
      return snapshot();
    },
    prev() {
      if (!available || index === 0) {
        return snapshot();
      }
      index -= 1;
      return snapshot();
    },
    reset() {
      index = 0;
      return snapshot();
    },
    goTo(target) {
      if (!available) {
        return snapshot();
      }
      const value = Math.max(0, Math.min(actions.length, Number(target) || 0));
      index = value;
      return snapshot();
    },
    current() {
      return snapshot();
    },
    onChange(listener) {
      const wrapped = () => listener(snapshot());
      wrapped();
      return wrapped;
    },
  };
}

export function replayControlIds(available) {
  return available ? ["replay-next", "replay-prev", "replay-reset"] : [];
}