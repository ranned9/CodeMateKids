/** 拖放：稳定目标解析、单指针会话、统一清理与事务提交；0.9.0 接入视口浮层与两段动画。 */
import { pickNode } from "./layout.js";
import { isWithinDropRange, pointInRect, resolveDropTarget } from "./targets.js";
import { findBlock, numberInputValue, removalScopeIds, walkNodes, workspaceStacks } from "./model.js";
import { numberForNewBlock } from "./connector.js";
import { clampStackPosition, isWorkspaceTargetAlive, workspaceOwnerId } from "./workspace.js";
import { drawOverlayImage, toolboxDropSize } from "./render.js";
import { createDragOverlay, LIFT_MS, SETTLE_MS } from "./drag-overlay.js";

const EDITABLE_PHASES = new Set(["editing", "result", "error"]);

export const CLICK_MOVE_THRESHOLD = 6;

function clampRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, number));
}

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
    // 上一轮收回动画移交的浮层；由 begin() 入口清扫（EP-BD 无残留）。
    this.settlingOverlay = null;
    const env = options.env || {};
    this.env = {
      window: env.window || globalThis.window || globalThis,
      document: env.document || globalThis.document || null,
      matchMedia: env.matchMedia || globalThis.matchMedia?.bind(globalThis) || null,
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

  prefersReducedMotion() {
    try {
      return Boolean(this.env.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch (error) {
      return false;
    }
  }

  /** 清扫挂起中的收回动画浮层（幂等，无事务、不改树、不播报）。 */
  sweepSettlingOverlay() {
    const pending = this.settlingOverlay;
    this.settlingOverlay = null;
    if (!pending) {
      return;
    }
    try {
      pending.destroy();
    } catch (error) {
      // 清扫失败不阻塞新会话。
    }
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

  /**
   * 工具箱来源拖动入口。grabInfo 由 toolbox.js 在 pointerdown 时同步读取缩略图边界产出；
   * 缺省 null 时维持可用（异常路径，落点退化兜底偏移）。
   */
  startToolboxDrag(kind, event, sourceElement, grabInfo = null) {
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
        grabInfo,
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
    // EP-BD：新手势开始前先清扫上一轮收回动画残留（幂等）。
    this.sweepSettlingOverlay();
    const startPoint = this.editor.pointFromEvent(event);
    const startClient = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    const stack = workspaceStacks(this.editor.state.root).find((item) => item.root.blockId === drag.blockId);
    const movingIds = new Set();
    walkNodes(findBlock(this.editor.state.root, drag.blockId), (node) => movingIds.add(node.blockId));
    const movesTail = Boolean(stack) || Array.isArray(this.editor.state.root);
    const rect = this.editor.layout.nodes?.find((node) => node.blockId === drag.blockId)?.rect;
    // 抓取相对位置（本体域）：工具箱来源取缩略图按下位置；画布来源取既有 offset 的归一化。
    let grabRatio = null;
    if (drag.origin === "toolbox") {
      grabRatio = drag.grabInfo
        ? { x: clampRatio(drag.grabInfo.ratioX), y: clampRatio(drag.grabInfo.ratioY) }
        : null;
    } else if (rect && rect.w > 0 && rect.h > 0) {
      grabRatio = {
        x: clampRatio((startPoint.x - rect.x) / rect.w),
        y: clampRatio((startPoint.y - rect.y) / rect.h),
      };
    }
    // D-04 统一抓取公式：offset = grabRatio × 布局尺寸（画布局部逻辑坐标）。
    // 兜底 {16,16} 仅用于"无法取得边界信息"的异常路径（如测试 stub 未提供 grabInfo），
    // 工具箱来源按画布布局尺寸计算，即使浮层无法成像也保留抓取位置。
    const offset =
      drag.origin === "canvas" && rect
        ? { x: startPoint.x - rect.x, y: startPoint.y - rect.y }
        : { x: 16, y: 16 };
    const groupBounds = drag.origin === "canvas" ? this.movingBounds(movingIds) : null;
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
      offset,
      grabRatio,
      startSize:
        drag.origin === "toolbox" && drag.grabInfo
          ? { w: drag.grabInfo.startWidth, h: drag.grabInfo.startHeight }
          : null,
      targetSize: null,
      groupBounds,
      overlayImage: null,
      removalImage: null,
      removalScope: null,
      overlayLogical: null,
      overlay: null,
      overlayPhase: "cleaned",
      scale: this.displayScale(),
      reducedMotion: this.prefersReducedMotion(),
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
    if (session.origin === "toolbox") {
      this.attachToolboxOverlay(session);
    }
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

  movingBounds(movingIds) {
    let bounds = null;
    for (const node of this.editor.layout?.nodes || []) {
      if (!movingIds?.has(node.blockId)) {
        continue;
      }
      const rect = node.rect;
      if (!bounds) {
        bounds = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
        continue;
      }
      const maxX = Math.max(bounds.x + bounds.w, rect.x + rect.w);
      const maxY = Math.max(bounds.y + bounds.h, rect.y + rect.h);
      bounds.x = Math.min(bounds.x, rect.x);
      bounds.y = Math.min(bounds.y, rect.y);
      bounds.w = maxX - bounds.x;
      bounds.h = maxY - bounds.y;
    }
    return bounds;
  }

  displayScale() {
    const { canvas, width, height, blockScale = 1 } = this.editor;
    const rect = canvas?.getBoundingClientRect?.();
    return {
      x: (rect?.width / width) || blockScale,
      y: (rect?.height / height) || blockScale,
    };
  }

  overlaySize(session) {
    return {
      w: session.overlayLogical.w * session.scale.x,
      h: session.overlayLogical.h * session.scale.y,
    };
  }

  ratioInBounds(session, bounds) {
    return {
      x: clampRatio((session.startPoint.x - bounds.x) / bounds.w),
      y: clampRatio((session.startPoint.y - bounds.y) / bounds.h),
    };
  }

  createOverlayImage(spec) {
    const doc = this.env.document;
    if (!doc || typeof doc.createElement !== "function") {
      return null;
    }
    const canvas = doc.createElement("canvas");
    if (!canvas || !drawOverlayImage(canvas, spec)) {
      return null;
    }
    return canvas;
  }

  /** 工具箱来源：pointerdown 立即创建浮层并启动拿起放大动画；失败降级为无浮层模式。 */
  attachToolboxOverlay(session) {
    try {
      const logical = toolboxDropSize(session.definition);
      if (session.grabRatio) {
        session.offset = {
          x: session.grabRatio.x * logical.w,
          y: session.grabRatio.y * logical.h,
        };
      }
      const image = this.createOverlayImage({ definition: session.definition });
      if (!image) {
        return;
      }
      session.overlayImage = image;
      session.overlayLogical = logical;
      session.targetSize = this.overlaySize(session);
      const overlay = createDragOverlay(this.env, {
        image: () => session.overlayImage,
        grabRatio: session.grabRatio || { x: session.offset.x / logical.w, y: session.offset.y / logical.h },
        startSize: session.startSize || session.targetSize,
        targetSize: session.targetSize,
        reducedMotion: session.reducedMotion,
      });
      if (!overlay) {
        return;
      }
      session.overlay = overlay;
      session.sourceElement?.classList?.add("has-drag-overlay");
      session.overlayPhase = "lifting";
      overlay.place(session.startClient.x, session.startClient.y);
      overlay.playLift(LIFT_MS, () => {
        if (this.session === session && session.overlayPhase === "lifting") {
          session.overlayPhase = "following";
        }
      });
    } catch (error) {
      this.destroySessionOverlay(session);
    }
  }

  /** 画布来源：越阈值时以原位尺寸创建浮层（无放大段），同时原位绘制层隐藏（T-EP-09）。 */
  attachCanvasOverlay(session) {
    if (session.overlay || !session.groupBounds || !this.env.document) {
      return;
    }
    try {
      const image = this.createOverlayImage({
        layout: this.editor.layout,
        ids: session.movingIds,
        definitions: this.editor.state.blocksByKind,
      });
      if (!image) {
        return;
      }
      const bounds = session.groupBounds;
      session.overlayImage = image;
      session.overlayLogical = bounds;
      session.targetSize = this.overlaySize(session);
      const overlay = createDragOverlay(this.env, {
        image: () => session.overlayImage,
        grabRatio: this.ratioInBounds(session, bounds),
        startSize: session.targetSize,
        targetSize: session.targetSize,
        reducedMotion: session.reducedMotion,
      });
      if (!overlay) {
        return;
      }
      session.overlay = overlay;
      session.overlayPhase = "following";
      overlay.place(session.lastClient.x, session.lastClient.y);
    } catch (error) {
      this.destroySessionOverlay(session);
    }
  }

  /** 进入移除区：浮层切换为仅呈现将被移除部分（被删块 + 体内子块，不含 next 链后续）。 */
  enterRemovalPreview(session) {
    if (!session.overlay || !session.blockId || session.overlayPhase === "remove-preview") {
      return;
    }
    try {
      const scope = removalScopeIds(this.editor.state.root, session.blockId);
      const bounds = this.movingBounds(scope);
      if (!bounds) {
        this.destroySessionOverlay(session);
        return;
      }
      const image = this.createOverlayImage({
        layout: this.editor.layout,
        ids: scope,
        definitions: this.editor.state.blocksByKind,
      });
      if (!image) {
        this.destroySessionOverlay(session);
        return;
      }
      session.removalImage = image;
      session.removalScope = scope;
      session.overlayLogical = bounds;
      session.targetSize = this.overlaySize(session);
      session.overlay.switchScope(image, session.targetSize, this.ratioInBounds(session, bounds));
      session.overlayPhase = "remove-preview";
    } catch (error) {
      this.destroySessionOverlay(session);
    }
  }

  /** 离开移除区后恢复整组积木，并保持指针在被抓取积木上的位置。 */
  exitRemovalPreview(session) {
    if (!session.overlay) {
      this.attachCanvasOverlay(session);
      return;
    }
    if (session.overlayPhase !== "remove-preview") {
      return;
    }
    try {
      session.overlayLogical = session.groupBounds;
      session.targetSize = this.overlaySize(session);
      session.overlay.switchScope(
        session.overlayImage,
        session.targetSize,
        this.ratioInBounds(session, session.groupBounds),
      );
      session.overlayPhase = "following";
    } catch (error) {
      // 恢复失败保留当前画面。
    }
  }

  /** 画布显示比例变化时同步浮层目标尺寸。 */
  syncOverlayScale(session) {
    const scale = this.displayScale();
    if (scale.x === session.scale.x && scale.y === session.scale.y) {
      return;
    }
    session.scale = scale;
    if (session.overlay) {
      session.targetSize = this.overlaySize(session);
      session.overlay.setTargetSize(session.targetSize);
    }
  }

  destroySessionOverlay(session) {
    const overlay = session.overlay;
    session.overlay = null;
    if (overlay) {
      try {
        overlay.destroy();
      } catch (error) {
        // 幂等销毁。
      }
    }
    session.overlayPhase = "cleaned";
  }

  /** 删除提交前快照：只持位图与坐标，不引用程序树节点（spec 9.1 第 5 条）。 */
  captureRemovalSnapshot(session) {
    return {
      image: session.overlayPhase === "remove-preview" ? session.removalImage : null,
      releasePoint: { x: session.lastClient.x, y: session.lastClient.y },
    };
  }

  /** 删除提交成功后启动收回缩小淡出动画；动画只负责清理，不参与提交、撤销与自动保存。 */
  startSettle(session, snapshot) {
    const overlay = session.overlay;
    if (!overlay || !snapshot?.image) {
      return;
    }
    try {
      overlay.place(snapshot.releasePoint.x, snapshot.releasePoint.y);
      overlay.playSettle(SETTLE_MS, () => {
        if (this.settlingOverlay === overlay) {
          this.settlingOverlay = null;
        }
      });
      session.overlayPhase = "settling";
    } catch (error) {
      this.destroySessionOverlay(session);
    }
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
    const nearSocket = result.target && (result.valid
      ? isWithinDropRange(point, result.target)
      : pointInRect(point, result.target.rect));
    const offset = session.offset || { x: 16, y: 16 };
    if (result.reason !== "OUTSIDE_CANVAS" && (!this.editor.layout.nodes?.length || (blank && !nearSocket))) {
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
      x: point.x - offset.x,
      y: point.y - offset.y,
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
    this.syncOverlayScale(session);
    // 浮层即时放置（每事件，transform 级开销），不等帧合并（跟手感优先）。
    if (session.overlay) {
      try {
        session.overlay.place(session.lastClient.x, session.lastClient.y);
      } catch (error) {
        // 放置失败不阻塞事件路径。
      }
    }
    if (!session.moved && !exceedsThreshold(session.startClient, session.lastClient, session.threshold)) {
      return;
    }
    session.lastPoint = this.editor.pointFromEvent(event);
    if (!session.moved) {
      session.moved = true;
      session.mode = "dragging";
      if (session.origin === "canvas") {
        this.attachCanvasOverlay(session);
      }
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
        this.enterRemovalPreview(session);
        this.editor.setPreview(null);
        this.editor.announceDrag?.("松手移除积木");
      } else {
        this.exitRemovalPreview(session);
      }
    }
    if (overToolbox) {
      return;
    }
    // 画布预览重绘合并到 requestAnimationFrame（每帧 ≤1 次，D-06）。
    if (session.frame == null) {
      session.frame = this.env.requestAnimationFrame(() => {
        session.frame = null;
        if (session.disposed || this.session !== session || session.overToolbox) {
          return;
        }
        const previous = session.lastResult;
        session.lastResult = this.buildPreview(session.lastPoint, session);
        this.editor.setPreview(session.lastResult);
        this.announceResult(previous, session.lastResult);
      });
    }
  }

  onUp(event) {
    const session = this.session;
    if (!session || session.disposed || event.pointerId !== session.pointerId) {
      return;
    }
    session.lastClient = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    if (!session.moved && !exceedsThreshold(session.startClient, session.lastClient, session.threshold)) {
      // 短按未越阈值：立即销毁浮层后走点击添加（行为与 0.8.0 基线一致）。
      this.teardown("click");
      if (session.origin === "toolbox") {
        this.editor.insertFromToolbox(session.kind);
      }
      return;
    }
    this.finishDrag(session, this.editor.pointFromEvent(event));
  }

  finishDrag(session, finalPoint) {
    // D-07：提交前显式复核可编辑（与 begin() 门禁语义一致，与"状态变化即取消"兜底构成双防线）。
    // 复核失败按取消处理：零事务、无动画、浮层与预览全部清理。
    if (this.editor.state.readonly || !EDITABLE_PHASES.has(this.editor.state.phase)) {
      this.teardown("cancelled");
      return;
    }
    let outcome = "cancelled";
    let message = "";
    let targetId = null;
    const remove = this.isToolboxDrop(session);
    try {
      if (remove) {
        this.syncOverlayScale(session);
        this.attachCanvasOverlay(session);
        this.enterRemovalPreview(session);
        // 快照先于提交（硬阻塞点 3）：动画素材来自提交前的浮层位图。
        const snapshot = this.captureRemovalSnapshot(session);
        if (this.editor.deleteBlock(session.blockId)) {
          outcome = "removed";
          this.editor.toast("积木已移除，可按 Ctrl+Z 撤销。");
          this.startSettle(session, snapshot);
        } else {
          // 删除失败：不播放收回动画，浮层立即清理，结构不变。
          this.destroySessionOverlay(session);
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
    // 浮层清理（插在取消挂起帧之后）：提交成功转收回动画时移交所有权（动画完成自清），
    // 其余全部结束路径立即销毁，document.body 零残留。
    const overlay = session.overlay;
    session.overlay = null;
    if (overlay) {
      if (overlay.state() === "settling") {
        this.settlingOverlay = overlay;
      } else {
        try {
          overlay.destroy();
        } catch (error) {
          // 幂等销毁。
        }
      }
    }
    session.overlayPhase = "cleaned";
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
      session.sourceElement?.classList?.remove("has-drag-overlay");
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
    this.sweepSettlingOverlay();
  }

  get hiddenBlockIds() {
    const session = this.session;
    if (!session?.blockId || !session.overlay) {
      return null;
    }
    return session.overToolbox ? session.removalScope : session.movingIds;
  }

  get dragging() {
    return this.session !== null;
  }
}
