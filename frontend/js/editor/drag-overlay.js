/** 拖动浮层：挂在 document.body 的积木图像层，拿起/收回动画与抓取放置公式。 */

export const LIFT_MS = 150;
export const SETTLE_MS = 180;

const OVERLAY_CLASS = "drag-overlay";
const SETTLING_CLASS = "drag-overlay--settling";
const SETTLE_SHRINK = 0.6;
const SETTLE_GUARD_EXTRA_MS = 80;

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, number));
}

function easeOutCubic(progress) {
  const clamped = Math.max(0, Math.min(1, progress));
  return 1 - Math.pow(1 - clamped, 3);
}

/**
 * 创建拖动浮层。DOM 依赖经 env 注入保持 Node stub 可测（沿用 dnd.js 构造器注入范式）。
 * @param {any} env {document, window, requestAnimationFrame, cancelAnimationFrame, matchMedia}（缺省回落 globalThis）
 * @param {any} spec {image: () => canvas, grabRatio: {x,y}, startSize: {w,h}, targetSize: {w,h}, reducedMotion: boolean}
 * @returns {any|null} 浮层实例；DOM 创建失败返回 null（调用方降级为无浮层模式）
 */
export function createDragOverlay(env = {}, spec = {}) {
  try {
    const doc = env.document || globalThis.document;
    const win = env.window || globalThis.window || globalThis;
    const raf =
      env.requestAnimationFrame ||
      globalThis.requestAnimationFrame?.bind(globalThis) ||
      ((callback) => win.setTimeout(callback, 16));
    const caf =
      env.cancelAnimationFrame ||
      globalThis.cancelAnimationFrame?.bind(globalThis) ||
      ((handle) => win.clearTimeout(handle));
    if (!doc?.body || typeof doc.createElement !== "function" || typeof spec.image !== "function") {
      return null;
    }

    const reducedMotion = spec.reducedMotion === true;
    let phase = "active";
    let grabRatio = {
      x: clamp01(spec.grabRatio?.x ?? 0.5),
      y: clamp01(spec.grabRatio?.y ?? 0.5),
    };
    let displaySize = {
      w: spec.startSize?.w ?? 0,
      h: spec.startSize?.h ?? 0,
    };
    let liftTarget = spec.targetSize || displaySize;
    let lastClient = { x: 0, y: 0 };
    let rafHandle = null;
    let settleTimer = null;
    let settled = false;

    const element = doc.createElement("div");
    element.className = OVERLAY_CLASS;
    element.style.left = "0px";
    element.style.top = "0px";
    element.style.pointerEvents = "none";
    element.style.willChange = "transform";
    element.setAttribute?.("aria-hidden", "true");

    const firstImage = spec.image();
    if (!firstImage) {
      return null;
    }
    element.appendChild(firstImage);

    const place = (clientX, clientY) => {
      lastClient = { x: clientX ?? 0, y: clientY ?? 0 };
      const left = lastClient.x - grabRatio.x * displaySize.w;
      const top = lastClient.y - grabRatio.y * displaySize.h;
      element.style.transform = `translate(${left}px, ${top}px)`;
    };

    const applySize = (width, height) => {
      displaySize = { w: width ?? 0, h: height ?? 0 };
      element.style.width = `${displaySize.w}px`;
      element.style.height = `${displaySize.h}px`;
      place(lastClient.x, lastClient.y);
    };

    const cancelAnimation = () => {
      if (rafHandle != null) {
        try {
          caf(rafHandle);
        } catch (error) {
          // 句柄已失效时忽略。
        }
        rafHandle = null;
      }
      if (settleTimer != null) {
        try {
          win.clearTimeout(settleTimer);
        } catch (error) {
          // 定时器已失效时忽略。
        }
        settleTimer = null;
      }
    };

    const destroy = () => {
      if (phase === "destroyed") {
        return;
      }
      phase = "destroyed";
      cancelAnimation();
      try {
        element.remove();
      } catch (error) {
        // 移除失败不再传播。
      }
    };

    const state = () => phase;

    const playLift = (durationMs, onDone) => {
      if (phase !== "active") {
        return;
      }
      const duration = reducedMotion ? 0 : Math.max(0, Number(durationMs ?? LIFT_MS));
      const startSize = { ...displaySize };
      if (duration <= 0) {
        applySize(liftTarget.w, liftTarget.h);
        onDone?.();
        return;
      }
      const startedAt = Date.now();
      const step = () => {
        if (phase !== "active") {
          rafHandle = null;
          return;
        }
        const progress = (Date.now() - startedAt) / duration;
        const eased = easeOutCubic(progress);
        applySize(
          startSize.w + (liftTarget.w - startSize.w) * eased,
          startSize.h + (liftTarget.h - startSize.h) * eased,
        );
        if (progress >= 1) {
          rafHandle = null;
          onDone?.();
          return;
        }
        rafHandle = raf(step);
      };
      rafHandle = raf(step);
    };

    const setTargetSize = (size) => {
      liftTarget = size;
      if (phase === "active" && rafHandle == null) {
        applySize(size.w, size.h);
      }
    };

    const switchScope = (image, size, ratio = grabRatio) => {
      if (phase === "destroyed" || !image) {
        return;
      }
      try {
        element.replaceChildren(image);
      } catch (error) {
        while (element.firstChild) {
          element.removeChild(element.firstChild);
        }
        element.appendChild(image);
      }
      grabRatio = { x: clamp01(ratio.x), y: clamp01(ratio.y) };
      setTargetSize(size || displaySize);
    };

    const playSettle = (durationMs, onDone) => {
      if (phase === "destroyed" || phase === "settling") {
        return;
      }
      phase = "settling";
      const duration = reducedMotion ? 0 : Math.max(0, Number(durationMs ?? SETTLE_MS));
      try {
        element.classList.add(SETTLING_CLASS);
      } catch (error) {
        // 样式类不可用时仍走 JS 清理路径。
      }
      const complete = () => {
        if (settled) {
          return;
        }
        settled = true;
        destroy();
        onDone?.();
      };
      if (duration <= 0) {
        complete();
        return;
      }
      const startSize = { ...displaySize };
      const targetSize = {
        w: startSize.w * SETTLE_SHRINK,
        h: startSize.h * SETTLE_SHRINK,
      };
      const startedAt = Date.now();
      const step = () => {
        if (phase !== "settling" || settled) {
          rafHandle = null;
          return;
        }
        const progress = Math.min(1, (Date.now() - startedAt) / duration);
        const eased = easeOutCubic(progress);
        applySize(
          startSize.w + (targetSize.w - startSize.w) * eased,
          startSize.h + (targetSize.h - startSize.h) * eased,
        );
        if (progress >= 1) {
          rafHandle = null;
          complete();
          return;
        }
        rafHandle = raf(step);
      };
      rafHandle = raf(step);
      // 兜底定时器：动画回调丢失（如页面隐藏暂停 rAF）时保证浮层最终被清理。
      settleTimer = win.setTimeout(complete, duration + SETTLE_GUARD_EXTRA_MS);
    };

    applySize(displaySize.w, displaySize.h);
    doc.body.appendChild(element);

    return { place, setTargetSize, playLift, switchScope, playSettle, destroy, state };
  } catch (error) {
    return null;
  }
}
