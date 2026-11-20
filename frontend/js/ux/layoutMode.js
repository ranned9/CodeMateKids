/** 断点唯一来源：阈值改动必须同步 app.css 媒体查询与 js_static_check 一致性断言。 */

export const BREAKPOINTS = {
  wide: { minWidth: 1366, minHeight: 760 },
  compact: { minWidth: 1200, maxWidth: 1365 },
  editorFirst: { minWidth: 1024, maxWidth: 1199 },
  lowHeight: { maxHeight: 759 },
  simple: { maxWidth: 1023 },
};

export const LAYOUT_MODES = ["wide", "compact3col", "editorFirst", "simple"];

export function resolveLayoutMode(snapshot = {}) {
  if (snapshot.wideAndTall) {
    return "wide";
  }
  if (snapshot.compactBand || (snapshot.lowHeight && snapshot.wideAndShort)) {
    return "compact3col";
  }
  if (snapshot.editorFirstBand) {
    return "editorFirst";
  }
  return "simple";
}

export function isLowHeight(snapshot = {}) {
  return Boolean(snapshot.lowHeight);
}

const QUERIES = {
  wideAndTall: `(min-width: ${BREAKPOINTS.wide.minWidth}px) and (min-height: ${BREAKPOINTS.wide.minHeight}px)`,
  wideAndShort: `(min-width: ${BREAKPOINTS.wide.minWidth}px) and (max-height: ${BREAKPOINTS.lowHeight.maxHeight}px)`,
  compactBand: `(min-width: ${BREAKPOINTS.compact.minWidth}px) and (max-width: ${BREAKPOINTS.compact.maxWidth}px)`,
  editorFirstBand: `(min-width: ${BREAKPOINTS.editorFirst.minWidth}px) and (max-width: ${BREAKPOINTS.editorFirst.maxWidth}px)`,
  lowHeight: `(max-height: ${BREAKPOINTS.lowHeight.maxHeight}px)`,
  simpleBand: `(max-width: ${BREAKPOINTS.simple.maxWidth}px)`,
};

export function createLayoutMode(environment = {}) {
  const matchMedia = environment.matchMedia
    || (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null);
  if (!matchMedia) {
    return {
      current: () => ({ mode: "wide", lowHeight: false, snapshot: {} }),
      onChange: () => () => {},
      dispose: () => {},
    };
  }
  const media = {};
  for (const [key, query] of Object.entries(QUERIES)) {
    media[key] = matchMedia(query);
  }
  const snapshot = () => ({
    wideAndTall: media.wideAndTall.matches,
    wideAndShort: media.wideAndShort.matches,
    compactBand: media.compactBand.matches,
    editorFirstBand: media.editorFirstBand.matches,
    simpleBand: media.simpleBand.matches,
    lowHeight: media.lowHeight.matches,
  });
  const listeners = new Set();
  const emit = () => {
    const value = current();
    for (const listener of listeners) {
      listener(value);
    }
  };
  for (const query of Object.values(media)) {
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", emit);
    } else if (typeof query.addListener === "function") {
      query.addListener(emit);
    }
  }
  function current() {
    const value = snapshot();
    return { mode: resolveLayoutMode(value), lowHeight: isLowHeight(value), snapshot: value };
  }
  return {
    current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
    },
  };
}
