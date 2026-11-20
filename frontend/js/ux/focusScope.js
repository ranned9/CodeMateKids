/** 焦点域：进入容器、退出回焦、触发点失效回退。容器与触发点由调用方传入。 */

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])";

export function createFocusScope({ doc = null, fallbackAnchorId = "canvas-toolbar", warn = console.warn } = {}) {
  const documentRef = doc || (typeof document !== "undefined" ? document : null);
  let origin = null;

  function queryAll(container, selector) {
    if (!container || typeof container.querySelectorAll !== "function") {
      return [];
    }
    return Array.from(container.querySelectorAll(selector));
  }

  function enter(container, trigger = null, preferred = null) {
    if (!container) {
      return null;
    }
    origin = trigger || null;
    const autofocus = queryAll(container, "[data-autofocus]")[0];
    const first = preferred || autofocus || queryAll(container, FOCUSABLE)
      .find((element) => !element.disabled && !element.closest?.("[hidden]"));
    if (first && typeof first.focus === "function") {
      first.focus();
      return first;
    }
    if (typeof container.setAttribute === "function") {
      container.setAttribute("tabindex", "-1");
      if (typeof container.focus === "function") {
        container.focus();
      }
    }
    return container;
  }

  function exit(anchor = null) {
    const candidates = [origin, anchor];
    for (const candidate of candidates) {
      if (!candidate || candidate.isConnected === false || candidate.disabled || candidate.closest?.("[hidden]")) {
        continue;
      }
      if (typeof candidate.focus === "function") {
        candidate.focus();
        origin = null;
        return candidate;
      }
    }
    const fallback = documentRef?.getElementById?.(fallbackAnchorId) || null;
    if (fallback && typeof fallback.focus === "function") {
      fallback.focus();
      origin = null;
      return fallback;
    }
    if (origin) {
      warn("focus-scope: trigger 已移除且找不到回退锚点。");
    }
    origin = null;
    return null;
  }

  return {
    enter,
    exit,
    current() {
      return documentRef?.activeElement || null;
    },
  };
}
