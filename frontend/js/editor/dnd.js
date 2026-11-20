/** 拖放：稳定目标解析、单指针会话、统一清理与事务提交。 */
import { pickNode } from "./layout.js";
import { pointInRect, resolveDropTarget } from "./targets.js";
import { findBlock, numberInputValue, walkNodes, workspaceStacks } from "./model.js";
import { numberForNewBlock } from "./connector.js";
import { clampStackPosition, isWorkspaceTargetAlive, workspaceOwnerId } from "./workspace.js";

const PREVIEW_OFFSET_X = 90;
const PREVIEW_OFFSET_Y = 20;
const FREE_DROP_SNAP = 12;
const EDITABLE_PHASES = new Set(["editing", "result", "error"]);

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
   * @param {{env?:any,toolbox?:HTMLElement}} [options]
   */
  constructor(editor, options = {}) {
    this.editor = editor;
    this.toolbox = options.toolbox;
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
    const field = (block?.fields || []).find(
      (item) =>
        point.x >= item.rect.x &&
        point.x <= item.rect.x + item.rect.w &&
        point.y >= item.rect.y &&
        point.y <= item.rect.y + item.rect.h,
    );
    if (field) {
      if (field.valueType !== "expression") {
        event.preventDefault();
        this.editor.startFieldEdit(block.node.blockId, field.name);
      } else {
        this.editor.selectBlock(node.blockId);
      }
      return;
    }
    this.editor.selectBlock(node.blockId);
    this.startBlockDrag(node.blockId, event);
  }

  startToolboxDrag(kind, event, sourceElement) {
    if (this.session || (event.button != null && event.button !== 0)) {
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
    if (!EDITABLE_PHASES.has(this.editor.state.phase)) {
      this.editor.toast("程序正在运行，可以先停止再修改。");
      return;
    }
    if (this.session) {
      return;
    }
    const startPoint = this.editor.pointFromEvent(event);
    const startClient = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    const stack = workspaceStacks(this.editor.state.root).find((item) => item.root.blockId === drag.blockId);
    const movingIds = new Set();
    walkNodes(findBlock(this.editor.state.root, drag.blockId), (node) => movingIds.add(node.blockId));
    const movesTail = Boolean(stack) || Array.isArray(this.editor.state.root);
    const rect = this.editor.layout.nodes?.find((node) => node.blockId === drag.blockId)?.rect;
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
      offset: rect ? { x: startPoint.x - rect.x, y: startPoint.y - rect.y } : { x: 16, y: 16 },
      stackOwner: stack ? workspaceOwnerId(this.editor.state.root, stack) : null,
      movingIds,
      movesTail,
      lastClient: { ...startClient },
      lastPoint: startPoint,
      moved: false,
      overToolbox: false,
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
      numberValue: session.kind === "value.number" && session.blockId
        ? findBlock(this.editor.state.root, session.blockId)?.inputs?.value
        : undefined,
      movingBlockId: session.blockId,
      viewport: {
        w: this.editor.width,
        h: this.editor.height,
        scrollX: this.editor.scrollX,
        scrollY: this.editor.scrollY,
      },
      allowTarget: (target) => {
        const nestedOwner = /^(body|expr):/.test(target.containerRef) ? target.containerRef.slice(5) : null;
        const anchorId = target.anchorRef?.startsWith("after:") ? target.anchorRef.slice(6) : null;
        if (target.containerRef === session.stackOwner ||
            (session.movesTail && (session.movingIds.has(nestedOwner) || session.movingIds.has(anchorId)))) {
          return false;
        }
        if (session.kind === "event.start") {
          const first = this.editor.layout.nodes.find((node) => node.ownerId === target.containerRef && node.order === 0);
          return target.portType === "statement-next" && target.anchorRef === "start" && first?.kind !== "event.start";
        }
        return true;
      },
      isSelfNest: (containerRef) => {
        if (!session.blockId) {
          return false;
        }
        const targetId = /^(body|expr):/.test(containerRef) ? containerRef.slice(5) : null;
        return targetId ? this.editor.isInsideSubtree(session.blockId, targetId) : false;
      },
    };
    const result = resolveDropTarget(this.editor.layout, point, context);
    const node = pickNode(this.editor.layout, point);
    const blank = !node || node.blockId === session.blockId || session.movingIds?.has(node.blockId);
    const nearSocket = result.target && pointInRect(point, result.target.rect, result.valid ? FREE_DROP_SNAP : 0);
    if (result.reason !== "OUTSIDE_CANVAS" && (!this.editor.layout.nodes?.length || (blank && !nearSocket))) {
      const offset = session.offset || { x: 16, y: 16 };
      const freePosition = clampStackPosition({ x: point.x - offset.x, y: point.y - offset.y });
      return {
        ...freePosition,
        freePosition,
        blockId: session.blockId,
        movingIds: session.movingIds,
        valid: true,
        target: null,
        kind: session.kind,
      };
    }
    const target = result.target;
    let numberValue;
    if (session.kind === "value.number" && !session.blockId && target?.numberField) {
      const defaultNumber = session.definition.fields.find((field) => field.name === "value")?.defaultValue;
      const owner = findBlock(this.editor.state.root, target.ownerId);
      const placedNumber = numberForNewBlock(target.numberField, defaultNumber, numberInputValue(owner?.inputs?.[target.field]));
      if (placedNumber !== defaultNumber) {
        numberValue = placedNumber;
      }
    }
    return {
      ...result,
      x: point.x - PREVIEW_OFFSET_X,
      y: point.y - PREVIEW_OFFSET_Y,
      kind: session.kind,
      blockId: session.blockId,
      numberValue,
    };
  }

  isToolboxDrop(session) {
    if (session.origin !== "canvas" || !session.blockId || !this.toolbox) {
      return false;
    }
    const { x, y } = session.lastClient;
    // 指针捕获会让事件目标仍指向画布，按实际坐标检查工具箱。
    return this.toolbox.contains(this.toolbox.ownerDocument.elementFromPoint(x, y));
  }

  onMove(event) {
    const session = this.session;
    if (!session || session.disposed || event.pointerId !== session.pointerId) {
      return;
    }
    session.lastClient = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    if (!session.moved && !exceedsThreshold(session.startClient, session.lastClient, session.threshold)) {
      return;
    }
    session.lastPoint = this.editor.pointFromEvent(event);
    if (!session.moved) {
      session.moved = true;
      session.mode = "dragging";
    }
    if (event.cancelable && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    const overToolbox = this.isToolboxDrop(session);
    if (overToolbox !== session.overToolbox) {
      session.overToolbox = overToolbox;
      this.toolbox.classList.toggle("is-remove-target", overToolbox);
      if (overToolbox) {
        session.lastResult = null;
        this.editor.setPreview(null);
        this.editor.announceDrag?.("松手移除积木");
      }
    }
    if (overToolbox) {
      return;
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
    session.lastClient = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    if (!session.moved && !exceedsThreshold(session.startClient, session.lastClient, session.threshold)) {
      this.teardown("click");
      if (session.origin === "toolbox") {
        this.editor.insertFromToolbox(session.kind);
      }
      return;
    }
    this.finishDrag(session, this.editor.pointFromEvent(event));
  }

  finishDrag(session, finalPoint) {
    let outcome = "cancelled";
    let message = "";
    let targetId = null;
    const remove = this.isToolboxDrop(session);
    try {
      if (remove) {
        if (this.editor.deleteBlock(session.blockId)) {
          outcome = "removed";
          this.editor.toast("积木已移除，可按 Ctrl+Z 撤销。");
        }
        return;
      }
      const finalResult = this.buildPreview(finalPoint, session);
      this.editor.setPreview(finalResult);
      targetId = finalResult.target?.id ?? null;
      if (finalResult.reason === "OUTSIDE_CANVAS") {
        outcome = "cancelled";
        return;
      }
      if (finalResult.freePosition) {
        outcome = this.editor.commitDrop(session.blockId, session.kind, finalResult) ? "committed" : "failed";
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
      if (!isWorkspaceTargetAlive(this.editor.state.root, targetId)) {
        outcome = "rejected";
        message = "这个位置刚刚变了，请再拖一次。";
        return;
      }
      const committed = this.editor.commitDrop(session.blockId, session.kind, finalResult);
      outcome = committed ? "committed" : "failed";
    } catch (error) {
      outcome = "commit-error";
      message = remove ? "积木没有移除，请再试一次。" : "这次没有放进去，请再试一次。";
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
    if (session.overToolbox) {
      this.toolbox.classList.remove("is-remove-target");
    }
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
