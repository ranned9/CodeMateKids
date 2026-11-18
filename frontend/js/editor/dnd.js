/** 拖放：稳定目标解析、单指针会话、统一清理与事务提交。 */
import { pickNode } from "./layout.js";
import { EXPR_SLOTS_ENABLED, normalizeTargetId, resolveDropTarget } from "./targets.js";
import { findBlock, isTargetAlive } from "./model.js";

const PREVIEW_OFFSET_X = 90;
const PREVIEW_OFFSET_Y = 20;

export const CLICK_MOVE_THRESHOLD = 6;

/**
 * @param {{x:number,y:number}} startClient
 * @param {{x:number,y:number}} currentClient
 * @param {number} threshold
 */
export function exceedsThreshold(startClient, currentClient, threshold = CLICK_MOVE_THRESHOLD) {
  const dx = (currentClient?.x ?? 0) - (startClient?.x ?? 0);
  const dy = (currentClient?.y ?? 0) - (startClient?.y ?? 0);
  return dx * dx + dy * dy > threshold * threshold;
}

export class DndController {
  /**
   * @param {any} editor EditorView
   * @param {{env?:any}} [options]
   */
  constructor(editor, options = {}) {
    this.editor = editor;
    this.session = null;
    const env = options.env || {};
    this.env = {
      window: env.window || globalThis.window || globalThis,
      requestAnimationFrame:
        env.requestAnimationFrame ||
        globalThis.requestAnimationFrame?.bind(globalThis) ||
        ((callback) => globalThis.setTimeout(callback, 16)),
      cancelAnimationFrame:
        env.cancelAnimationFrame ||
        globalThis.cancelAnimationFrame?.bind(globalThis) ||
        ((handle) => globalThis.clearTimeout(handle)),
    };
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onCancel = this.onCancel.bind(this);
    this.onLostCapture = this.onLostCapture.bind(this);
    this.onBlur = this.onBlur.bind(this);
    this.bound = false;
  }

  bind() {
    if (typeof this.editor.canvas?.addEventListener !== "function") {
      return;
    }
    this.editor.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.bound = true;
  }

  onPointerDown(event) {
    if (event.button !== 0 || this.session) {
      return;
    }
    const point = this.editor.pointFromEvent(event);
    const node = pickNode(this.editor.layout, point);
    if (!node) {
      this.editor.selectBlock(null);
      return;
    }
    const block = (this.editor.layout.blocks || []).find((item) => item.node.blockId === node.blockId);
    const section = this.editor.layout.sections?.[node.blockId];
    const field = (block?.fields || []).find(
      (item) =>
        point.x >= item.rect.x &&
        point.x <= item.rect.x + item.rect.w &&
        point.y >= item.rect.y &&
        point.y <= item.rect.y + item.rect.h,
    );
    if (field) {
      const value = block.node.inputs?.[field.name];
      if (field.valueType === "expression" && EXPR_SLOTS_ENABLED && value?.blockId) {
        this.startBlockDrag(value.blockId, event);
        return;
      }
      if (field.valueType !== "expression") {
        this.editor.startFieldEdit(block.node.blockId, field.name);
        return;
      }
      return;
    }
    if (section && section.bodyBox) {
      const inBody =
        point.x >= section.bodyBox.x &&
        point.x <= section.bodyBox.x + section.bodyBox.w &&
        point.y >= section.bodyBox.y &&
        point.y <= section.bodyBox.y + section.bodyBox.h;
      const hasChildren = (block?.node.body || []).length > 0;
      if (inBody && !hasChildren && node.blockId === block?.node.blockId) {
        this.editor.selectBlock(node.blockId);
        this.startBlockDrag(node.blockId, event);
        return;
      }
    }
    this.editor.selectBlock(node.blockId);
    this.startBlockDrag(node.blockId, event);
  }

  startToolboxDrag(kind, event, sourceElement) {
    if (this.session) {
      return;
    }
    const definition = this.editor.state.blocksByKind.get(kind);
    if (!definition || !definition.runnable) {
      this.editor.toast("这个积木现在不能运行。");
      return;
    }
    this.begin(
      {
        kind,
        blockId: null,
        definition,
        origin: "toolbox",
        sourceElement: sourceElement || event?.currentTarget || null,
      },
      event,
    );
  }

  startBlockDrag(blockId, event) {
    if (this.session) {
      return;
    }
    const node = findBlock(this.editor.state.root, blockId);
    if (!node) {
      return;
    }
    const definition = this.editor.state.blocksByKind.get(node.kind);
    this.begin(
      {
        kind: node.kind,
        blockId,
        definition,
        origin: "canvas",
        sourceElement: this.editor.canvas,
      },
      event,
    );
  }

  begin(drag, event) {
    if (this.editor.state.readonly) {
      this.editor.toast(this.editor.state.readonlyReason || "这个作品现在只能看。");
      return;
    }
    if (this.editor.state.phase !== "editing") {
      this.editor.toast("程序正在运行，可以先停止再修改。");
      return;
    }
    if (this.session) {
      return;
    }
    const startPoint = this.editor.pointFromEvent(event);
    const startClient = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    const session = {
      pointerId: event.pointerId ?? 1,
      pointerType: event.pointerType || "mouse",
      startedAt: Date.now(),
      origin: drag.origin,
      kind: drag.kind,
      blockId: drag.blockId,
      definition: drag.definition,
      sourceElement: drag.sourceElement || null,
      captureTarget: null,
      captureOk: false,
      startClient,
      startPoint,
      lastClient: { ...startClient },
      lastPoint: startPoint,
      moved: false,
      mode: "pressed",
      threshold: CLICK_MOVE_THRESHOLD,
      lastResult: null,
      frame: null,
      disposed: false,
    };
    this.session = session;
    this.armSession(session);
  }

  armSession(session) {
    this.env.window.addEventListener("pointermove", this.onMove);
    this.env.window.addEventListener("pointerup", this.onUp);
    this.env.window.addEventListener("pointercancel", this.onCancel);
    this.env.window.addEventListener("blur", this.onBlur);

    const capture = this.resolveCaptureTarget(session.sourceElement, session.pointerId);
    session.captureTarget = capture.target;
    session.captureOk = capture.canCapture;
    if (capture.canCapture) {
      try {
        capture.target.setPointerCapture(session.pointerId);
        session.captureTarget.addEventListener?.("lostpointercapture", this.onLostCapture);
      } catch (error) {
        session.captureOk = false;
      }
    }
    try {
      session.sourceElement?.classList?.add("is-grabbing");
    } catch (error) {
      // 源元素可能已被重渲染，样式失败不影响拖动。
    }

    if (session.origin === "canvas") {
      session.lastResult = this.buildPreview(session.startPoint, session);
      this.editor.setPreview(session.lastResult);
      this.announceResult(null, session.lastResult);
    }
  }

  resolveCaptureTarget(source, pointerId) {
    if (!source || typeof source.setPointerCapture !== "function") {
      return { target: null, canCapture: false };
    }
    return { target: source, canCapture: true };
  }

  announceResult(previous, result) {
    if (
      !this.editor.announceDrag ||
      !result ||
      (previous && previous.target?.id === result.target?.id && previous.valid === result.valid)
    ) {
      return;
    }
    this.editor.announceDrag(result.valid ? "可以放到这里" : result.message || "这里放不了");
  }

  buildPreview(point, session) {
    const context = {
      definition: session.definition,
      schema: this.editor.state.schema,
      movingBlockId: session.blockId,
      viewport: {
        w: this.editor.width,
        h: this.editor.height,
        scrollY: this.editor.scrollY,
      },
      exprSlotsEnabled: EXPR_SLOTS_ENABLED,
      isSelfNest: (containerRef) => {
        if (!session.blockId) {
          return false;
        }
        const targetId = containerRef.startsWith("body:") ? containerRef.slice(5) : null;
        return targetId ? this.editor.isInsideSubtree(session.blockId, targetId) : false;
      },
    };
    const result = resolveDropTarget(this.editor.layout, point, context);
    return {
      ...result,
      x: point.x - PREVIEW_OFFSET_X,
      y: point.y - PREVIEW_OFFSET_Y,
      kind: session.kind,
    };
  }

  onMove(event) {
    const session = this.session;
    if (!session || session.disposed || event.pointerId !== session.pointerId) {
      return;
    }
    session.lastClient = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    session.lastPoint = this.editor.pointFromEvent(event);
    if (!session.moved) {
      session.moved = true;
      session.mode = "dragging";
    }
    if (event.cancelable && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    const previous = session.lastResult;
    session.lastResult = this.buildPreview(session.lastPoint, session);
    this.editor.setPreview(session.lastResult);
    this.announceResult(previous, session.lastResult);
  }

  onUp(event) {
    const session = this.session;
    if (!session || session.disposed || event.pointerId !== session.pointerId) {
      return;
    }
    const finalPoint = this.editor.pointFromEvent(event);
    session.lastClient = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    this.finishDrag(session, finalPoint);
  }

  finishDrag(session, finalPoint) {
    let outcome = "cancelled";
    let message = "";
    let targetId = null;
    try {
      const finalResult = this.buildPreview(finalPoint, session);
      this.editor.setPreview(finalResult);
      targetId = finalResult.target?.id ?? null;
      if (finalResult.reason === "OUTSIDE_CANVAS") {
        outcome = "cancelled";
        return;
      }
      if (!finalResult.target) {
        outcome = "rejected";
        message = finalResult.message || "这里暂时放不了，试试拖到积木之间的空隙。";
        return;
      }
      if (!finalResult.valid) {
        outcome = "rejected";
        message = finalResult.message || "这个位置不能放积木。";
        return;
      }
      const normalized = normalizeTargetId(targetId);
      if (!normalized || !isTargetAlive(this.editor.state.root, targetId)) {
        outcome = "rejected";
        message = "这个位置刚刚变了，请再拖一次。";
        return;
      }
      const committed = this.editor.commitDrop(session.blockId, session.kind, finalResult);
      outcome = committed ? "committed" : "failed";
    } catch (error) {
      outcome = "commit-error";
      message = "这次没有放进去，请再试一次。";
    } finally {
      this.teardown(outcome, message, { targetId, point: finalPoint });
    }
  }

  onCancel(event) {
    if (this.session && event?.pointerId != null && event.pointerId !== this.session.pointerId) {
      return;
    }
    this.teardown("cancelled");
  }

  onLostCapture(event) {
    if (this.session && event?.pointerId != null && event.pointerId !== this.session.pointerId) {
      return;
    }
    this.teardown("cancelled");
  }

  onBlur() {
    this.teardown("cancelled");
  }

  teardown(reason = "cancelled", message = "", detail = {}) {
    const session = this.session;
    if (!session || session.disposed) {
      return;
    }
    session.disposed = true;
    if (session.frame != null) {
      this.env.cancelAnimationFrame(session.frame);
      session.frame = null;
    }
    this.env.window.removeEventListener("pointermove", this.onMove);
    this.env.window.removeEventListener("pointerup", this.onUp);
    this.env.window.removeEventListener("pointercancel", this.onCancel);
    this.env.window.removeEventListener("blur", this.onBlur);

    if (session.captureOk && session.captureTarget) {
      try {
        session.captureTarget.removeEventListener?.("lostpointercapture", this.onLostCapture);
      } catch (error) {
        // 已断开的元素忽略。
      }
      try {
        session.captureTarget.releasePointerCapture?.(session.pointerId);
      } catch (error) {
        // 捕获已丢失时忽略。
      }
    }
    try {
      session.sourceElement?.classList?.remove("is-grabbing");
    } catch (error) {
      // 源元素已被重渲染时忽略。
    }

    this.session = null;
    this.editor.setPreview(null);
    this.editor.announceDrag?.("");
    if ((reason === "rejected" || reason === "commit-error") && message) {
      this.editor.toast(message);
    }
  }

  cancel(reason = "cancelled") {
    this.teardown(reason);
  }

  get dragging() {
    return this.session !== null;
  }
}