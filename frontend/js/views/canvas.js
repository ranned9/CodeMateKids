/** 自研 Canvas 工作区视图：布局、渲染、拖放、字段编辑、撤销与可访问性。 */
import { computeLayout } from "../editor/layout.js";
import { drawScene } from "../editor/render.js";
import { STACK_START, cloneTree, findBlock, numberInputValue, programSummary, removeBlock, runnableRoots, validateTree, walkNodes, workspaceStacks } from "../editor/model.js";
import { planWorkspaceDrop } from "../editor/workspace.js";
import { DndController } from "../editor/dnd.js";
import { emptyLayoutModel } from "../editor/targets.js";
import { canConnectToTarget, numericFieldError } from "../editor/connector.js";
import { attachKeyboard } from "../editor/keyboard.js";
import { FieldControls } from "../editor/number-controls.js";
import { syncMirror } from "../util/a11y.js";

function previewCode(root, definitions) {
  if (!workspaceStacks(root).length) {
    return "# 画布是空的\n";
  }
  const roots = runnableRoots(root);
  if (!roots.length) {
    return "# 把动作接在「当开始」下面就能运行\n";
  }
  const lines = [];
  function expression(node) {
    if (!node) {
      return "?";
    }
    if (node.kind === "value.number") {
      return String(node.inputs?.value ?? 0);
    }
    if (node.kind === "value.calc") {
      const left = expression(node.inputs?.left);
      const right = expression(node.inputs?.right);
      return `(${left} ${node.inputs?.op ?? "+"} ${right})`;
    }
    return "?";
  }
  function chain(node, indent) {
    let current = node;
    let guard = 0;
    while (current && guard < 100) {
      guard += 1;
      const pad = "    ".repeat(indent);
      if (current.kind === "event.start") {
        lines.push(`${pad}pass  # 当开始`);
      } else if (["control.repeat", "control.if", "control.else"].includes(current.kind)) {
        if (current.kind === "control.repeat") {
          lines.push(`${pad}for _repeat_${guard} in range(${numberInputValue(current.inputs?.times) ?? 0}):`);
        } else if (current.kind === "control.if") {
          const { operator, threshold } = current.inputs || {};
          lines.push(`${pad}if stage.steps ${operator ?? ">="} ${numberInputValue(threshold) ?? "?"}:`);
        } else {
          lines.push(`${pad}else:`);
        }
        if (current.body?.length) {
          for (const child of current.body) {
            chain(child, indent + 1);
          }
        } else {
          lines.push(`${pad}    pass`);
        }
      } else if (current.kind === "motion.move") {
        lines.push(`${pad}stage.move(${numberInputValue(current.inputs?.steps) ?? 1})`);
      } else if (current.kind === "motion.turn") {
        lines.push(`${pad}stage.turn(${numberInputValue(current.inputs?.degrees) ?? 90})`);
      } else if (current.kind === "look.say") {
        lines.push(`${pad}stage.say(${JSON.stringify(current.inputs?.text ?? "")})`);
      } else if (current.kind === "text.print") {
        lines.push(`${pad}print(${expression(current.inputs?.value)})`);
      } else {
        lines.push(`${pad}# ${definitions.get(current.kind)?.displayName || "未知积木"}`);
      }
      current = current.next;
    }
  }
  for (const script of roots) {
    chain(script, 0);
  }
  return `${lines.join("\n")}\n`;
}

export class EditorView {
  constructor(options) {
    this.canvas = options.canvas;
    this.stage = options.stage;
    this.mirror = options.mirror;
    this.empty = options.empty;
    this.code = options.code;
    this.state = options.state;
    this.history = options.history;
    this.onChange = options.onChange || (() => {});
    this.toast = options.toast || (() => {});
    this.handlers = options.handlers || {};
    this.ctx = this.canvas.getContext("2d");
    this.layout = emptyLayoutModel({ w: 720, h: 460, scrollY: 0 });
    this.preview = null;
    this.scrollX = 0;
    this.scrollY = 0;
    this.width = 720;
    this.height = 460;
    this.fieldEditor = null;
    this.fieldControls = new FieldControls(this);
    this.dnd = new DndController(this, { toolbox: options.toolbox });
    this.dnd.bind();
    attachKeyboard(this, this.handlers);
    this.stage.addEventListener("wheel", (event) => {
      const maxX = Math.max(0, this.layout.contentWidth - this.width + 24);
      const maxY = Math.max(0, this.layout.height - this.height + 24);
      const dx = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX;
      const dy = event.shiftKey ? 0 : event.deltaY;
      const x = Math.max(0, Math.min(maxX, this.scrollX + dx * 0.6));
      const y = Math.max(0, Math.min(maxY, this.scrollY + dy * 0.6));
      if (x === this.scrollX && y === this.scrollY) {
        return;
      }
      event.preventDefault();
      this.scrollX = x;
      this.scrollY = y;
      this.refresh();
    }, { passive: false });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.refresh());
      this.resizeObserver.observe(this.canvas);
    }
    this.refresh();
  }

  get root() {
    return this.state.root;
  }

  setProgram(root, { clearHistory = true, notify = true } = {}) {
    this.cancelDrag("context");
    this.cancelFieldEdit();
    this.fieldControls.reset();
    this.state.root = root;
    this.state.selectedBlockId = null;
    this.state.errorBlockId = null;
    this.state.runningBlockId = null;
    this.scrollX = 0;
    this.scrollY = 0;
    if (clearHistory) {
      this.history.clear();
    }
    this.refresh();
    if (notify) {
      this.onChange("program");
    }
  }

  measure() {
    const rect = this.canvas.getBoundingClientRect();
    const cssScale = Number.parseFloat(window.getComputedStyle?.(this.canvas)?.getPropertyValue("--block-scale"));
    this.blockScale = cssScale > 0 ? cssScale : 1;
    this.width = Math.max(360, Math.round(rect.width || 720)) / this.blockScale;
    this.height = Math.max(320, Math.round(rect.height || 460)) / this.blockScale;
  }

  refresh() {
    this.measure();
    const definitions = this.state.blocksByKind;
    this.layout = computeLayout(this.state.root, definitions, {
      w: this.width,
      h: this.height,
      scrollX: this.scrollX ?? 0,
      scrollY: this.scrollY,
    });
    const validation = validateTree(this.state.root, definitions);
    this.state.invalidBlockIds = validation.invalidIds;
    this.render();
    if (this.empty) {
      this.empty.hidden = workspaceStacks(this.state.root).length > 0;
    }
    if (this.mirror) {
      syncMirror(this.mirror, this.layout.nodes || [], this.state, (blockId, options) => this.selectBlock(blockId, options));
    }
    if (this.code) {
      this.code.textContent = previewCode(this.state.root, definitions);
    }
  }

  render() {
    this.measure();
    const editable = !this.state.readonly && ["editing", "result", "error"].includes(this.state.phase);
    const hiddenBlockIds = this.dnd.hiddenBlockIds;
    const fieldControls = this.fieldControls.sync(editable, hiddenBlockIds);
    const pixelsPerUnit = (window.devicePixelRatio || 1) * this.blockScale;
    if (this.canvas.width !== Math.round(this.width * pixelsPerUnit)) {
      this.canvas.width = Math.round(this.width * pixelsPerUnit);
    }
    if (this.canvas.height !== Math.round(this.height * pixelsPerUnit)) {
      this.canvas.height = Math.round(this.height * pixelsPerUnit);
    }
    this.ctx.setTransform(pixelsPerUnit, 0, 0, pixelsPerUnit, 0, 0);
    drawScene(this.ctx, this.layout, {
      width: this.width,
      height: this.height,
      definitions: this.state.blocksByKind,
      selectedId: this.state.selectedBlockId,
      runningId: this.state.runningBlockId,
      errorId: this.state.errorBlockId,
      invalidIds: this.state.invalidBlockIds,
      editable,
      fieldControls,
      hiddenBlockIds,
      previewLayer: this.preview,
      scrollX: this.scrollX,
      scrollY: this.scrollY,
    });
  }

  revealBlock(blockId, { select = true } = {}) {
    const node = (this.layout.nodes || []).find((item) => item.blockId === blockId);
    if (!node) {
      return false;
    }
    const rect = select ? node.rect : this.layout.sections?.[blockId]?.header || node.rect;
    const { scrollX, scrollY } = this;
    const maxX = Math.max(0, this.layout.contentWidth - this.width + 24);
    const maxY = Math.max(0, this.layout.height - this.height + 24);
    if (rect.y < this.scrollY) {
      this.scrollY = Math.max(0, rect.y - 16);
    } else if (rect.y + rect.h > this.scrollY + this.height) {
      this.scrollY = Math.min(maxY, rect.y + rect.h - this.height + 16);
    }
    if (rect.x < (this.scrollX ?? 0)) {
      this.scrollX = Math.max(0, rect.x - 16);
    } else if (rect.x + rect.w > (this.scrollX ?? 0) + this.width) {
      this.scrollX = Math.min(maxX, rect.x + rect.w - this.width + 16);
    }
    if (select) this.state.selectedBlockId = blockId;
    if (select || scrollX !== this.scrollX || scrollY !== this.scrollY) {
      this.refresh();
    } else {
      this.render();
    }
    return true;
  }

  pointFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.width / rect.width;
    const scaleY = this.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX + (this.scrollX ?? 0),
      y: (event.clientY - rect.top) * scaleY + this.scrollY,
    };
  }

  setPreview(preview) {
    this.preview = preview;
    this.render();
  }

  announceDrag(message) {
    const region = document.getElementById("drag-live");
    if (!region) {
      return;
    }
    if (region.textContent === message) {
      return;
    }
    region.textContent = message || "";
  }

  selectBlock(blockId, options = {}) {
    this.state.selectedBlockId = blockId;
    this.render();
    if (!options.skipNotify) {
      this.onChange("select");
    }
  }

  isInsideSubtree(ancestorId, targetId) {
    if (!ancestorId || !targetId) {
      return false;
    }
    if (ancestorId === targetId) {
      return true;
    }
    const ancestor = findBlock(this.state.root, ancestorId);
    if (!ancestor) {
      return false;
    }
    let found = false;
    walkNodes({ ...ancestor, next: null }, (node) => {
      if (node.blockId === targetId) {
        found = true;
      }
    });
    return found;
  }

  insertFromToolbox(kind) {
    if (this.state.readonly) {
      this.toast(this.state.readonlyReason || "这个作品现在只能看。");
      return false;
    }
    if (!["editing", "result", "error"].includes(this.state.phase)) {
      this.toast("程序正在运行，可以先停止再修改。");
      return false;
    }
    const definition = this.state.blocksByKind.get(kind);
    if (!definition || !definition.runnable) {
      this.toast("这个积木现在不能运行。");
      return false;
    }
    const target = this.defaultInsertTarget(definition);
    if (kind === "control.else" && !target) {
      this.toast("先选中一块没有接「否则」的「如果」，再添加「否则」。");
      return false;
    }
    const placement = target
      ? { valid: true, target, portType: target.portType }
      : {
          valid: true,
          freePosition: {
            x: (this.scrollX ?? 0) + STACK_START.x,
            y: this.layout.nodes.length ? this.layout.height : STACK_START.y,
          },
        };
    const placed = this.commitDrop(null, kind, placement);
    if (placed) {
      const selected = this.layout.nodes.find((node) => node.blockId === this.state.selectedBlockId);
      if (selected && (selected.rect.y < this.scrollY || selected.rect.y + 36 > this.scrollY + this.height)) {
        this.scrollY = Math.max(0, selected.rect.y - 16);
        this.refresh();
      }
    }
    return placed;
  }

  defaultInsertTarget(definition) {
    const { nodes, targets } = this.layout;
    const selected = this.state.selectedBlockId;
    if (definition.kind === "control.else") {
      const openings = targets.filter((target) => canConnectToTarget(this.state.schema, definition, target).ok);
      return openings.find((target) => target.anchorRef === `after:${selected}`)
        ?? (openings.length === 1 ? openings[0] : null);
    }
    if (nodes.length === 0) {
      return definition.kind === "event.start" && this.state.root == null ? targets[0] : null;
    }
    if (definition.kind === "event.start") {
      return null;
    }
    if (definition.outputType === "expression") {
      let firstEmpty = null;
      for (const target of targets) {
        if (target.portType !== "expression" || !canConnectToTarget(this.state.schema, definition, target).ok) {
          continue;
        }
        const owner = findBlock(this.state.root, target.ownerId);
        const value = owner?.inputs?.[target.field];
        if (target.ownerId === selected && (value == null || (target.numberField && typeof value === "number"))) {
          return target;
        }
        if (value == null) {
          firstEmpty ??= target;
        }
      }
      return firstEmpty;
    }
    let selectedNode = nodes.find((node) => node.blockId === selected);
    while (selectedNode?.ownerId.startsWith("expr:")) {
      selectedNode = nodes.find((node) => node.blockId === selectedNode.parentBlockId);
    }
    if (selectedNode) {
      const { blockId, ownerId, depth, isContainer } = selectedNode;
      const targetId = isContainer
        ? `body:${blockId}@start`
        : `${depth === 0 ? ownerId : `body:${ownerId}`}@after:${blockId}`;
      return targets.find((target) => target.id === targetId);
    }
    return targets.filter((target) => target.portType === "statement-next").at(-1);
  }

  editFirstField() {
    const blockId = this.state.selectedBlockId;
    if (!blockId) {
      return;
    }
    const block = this.layout.blocks.find((item) => item.node.blockId === blockId);
    const field = (block?.fields || []).find((item) => item.valueType !== "expression");
    if (field) {
      this.startFieldEdit(blockId, field.name);
    } else {
      this.toast("这个积木没有可以直接填写的参数。");
    }
  }

  commitDrop(blockId, kind, targetResult) {
    if (!targetResult || targetResult.valid !== true || (!targetResult.target && !targetResult.freePosition)) {
      if (targetResult?.message) {
        this.toast(targetResult.message);
      }
      return false;
    }
    const definition = this.state.blocksByKind.get(kind);
    if (!definition) {
      this.toast("这个积木现在不能运行。");
      return false;
    }
    if (targetResult.target) {
      const numberValue = kind === "value.number" && blockId
        ? findBlock(this.state.root, blockId)?.inputs?.value
        : undefined;
      const connection = canConnectToTarget(this.state.schema, definition, targetResult.target, numberValue);
      if (!connection.ok) {
        this.toast(connection.message);
        return false;
      }
    }
    const beforeRoot = cloneTree(this.state.root);
    const beforeSelected = this.state.selectedBlockId;
    const beforeDirty = this.state.dirty;
    const undoDepth = this.history.undoStack?.length ?? 0;
    const redoDepth = this.history.redoStack?.length ?? 0;
    const type = targetResult.portType === "expression" ? "connect" : blockId ? "move" : "insert";
    try {
      const plan = planWorkspaceDrop(this.state.root, {
        blockId: blockId || null,
        kind,
        definition,
        definitions: this.state.blocksByKind,
        targetId: targetResult.target?.id,
        freePosition: targetResult.freePosition,
      });
      if (!plan.ok) {
        if (plan.message) {
          this.toast(plan.message);
        }
        return false;
      }
      if (plan.root === this.state.root) {
        return true;
      }
      this.state.root = plan.root;
      if (plan.node) {
        this.state.selectedBlockId = plan.node.blockId;
      }
      this.state.dirty = true;
      this.refresh();
      this.onChange("program");
      this.history.record(type, beforeRoot, cloneTree(plan.root));
      return true;
    } catch (error) {
      this.state.root = beforeRoot;
      this.state.selectedBlockId = beforeSelected;
      this.state.dirty = beforeDirty;
      this.history.truncateTo?.(undoDepth, redoDepth);
      try {
        this.refresh();
      } catch (ignored) {
        // 刷新失败不再递归，保留原始快照。
      }
      this.toast("这次没有放进去，请再试一次。");
      return false;
    }
  }

  cancelDrag(reason = "cancelled") {
    this.dnd?.cancel(reason);
  }

  deleteSelected() {
    return this.deleteBlock(this.state.selectedBlockId, { confirmBody: true });
  }

  deleteBlock(blockId, { confirmBody = false } = {}) {
    if (!blockId) {
      return false;
    }
    if (this.state.readonly) {
      this.toast(this.state.readonlyReason || "这个作品现在只能看。");
      return false;
    }
    if (!["editing", "result", "error"].includes(this.state.phase)) {
      this.toast("程序正在运行，可以先停止再修改。");
      return false;
    }
    const node = findBlock(this.state.root, blockId);
    if (!node) {
      return false;
    }
    if (confirmBody && node.body?.length) {
      const confirmed = window.confirm("删除这个积木会同时移除里面的动作，确定吗？");
      if (!confirmed) {
        return false;
      }
    }
    const before = cloneTree(this.state.root);
    const result = removeBlock(this.state.root, blockId, { definitions: this.state.blocksByKind });
    this.state.root = result.root;
    this.state.selectedBlockId = null;
    this.state.dirty = true;
    this.history.record("delete", before, cloneTree(result.root));
    this.refresh();
    this.onChange("program");
    return true;
  }

  startFieldEdit(blockId, fieldName) {
    if (this.state.readonly || this.state.phase === "running") {
      this.toast("程序正在运行，可以先停止再修改。");
      return;
    }
    const block = this.layout.blocks.find((item) => item.node.blockId === blockId);
    if (!block) {
      return;
    }
    const field = this.fieldForEdit(blockId, block.fields?.find((item) => item.name === fieldName));
    if (!field || field.valueType === "expression") {
      return;
    }
    const currentValue = block.node.inputs?.[fieldName];
    if (field.acceptsNumberBlock && currentValue?.kind === "value.number") {
      this.startFieldEdit(currentValue.blockId, "value");
      return;
    }
    this.cancelFieldEdit();
    if (this.fieldControls.focus(blockId, fieldName)) {
      return;
    }
    const stageRect = this.stage.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / this.width;
    const scaleY = canvasRect.height / this.height;
    const left = (field.rect.x - (this.scrollX ?? 0)) * scaleX + (canvasRect.left - stageRect.left);
    const top = (field.rect.y - this.scrollY) * scaleY + (canvasRect.top - stageRect.top);
    const width = Math.max(70, field.rect.w * scaleX);

    let input;
    if (field.valueType === "choice") {
      input = document.createElement("select");
      for (const choice of field.choices || []) {
        const option = document.createElement("option");
        option.value = String(choice);
        option.textContent = String(choice);
        if (String(choice) === String(currentValue)) {
          option.selected = true;
        }
        input.appendChild(option);
      }
    } else {
      input = document.createElement("input");
      input.type = field.valueType === "number" || field.valueType === "integer" ? "number" : "text";
      if (field.valueType === "integer") {
        input.step = "1";
      }
      if (field.range) {
        if (field.range.min != null) input.min = String(field.range.min);
        if (field.range.max != null) input.max = String(field.range.max);
      }
      if (field.maxLength) {
        input.maxLength = field.maxLength;
      }
      input.value = currentValue == null ? "" : String(currentValue);
    }
    input.className = "field-editor";
    input.setAttribute("aria-label", `${block.def?.displayName || "积木"}的${field.label || field.name}`);
    input.style.left = `${left}px`;
    input.style.top = `${top}px`;
    input.style.width = `${width}px`;
    input.style.height = `${field.rect.h * scaleY}px`;
    input.dataset.blockId = blockId;
    input.dataset.field = fieldName;

    const commit = () => {
      if (!input.isConnected) {
        return;
      }
      const raw = input.value;
      input.remove();
      this.fieldEditor = null;
      this.commitFieldValue(blockId, fieldName, raw.endsWith(".") ? raw.slice(0, -1) : raw);
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.remove();
        this.fieldEditor = null;
      }
    });
    if (field.valueType === "choice") {
      input.addEventListener("change", commit);
    }
    this.stage.appendChild(input);
    this.fieldEditor = input;
    input.focus();
    if (input.select) {
      input.select();
    }
  }

  fieldForEdit(blockId, field) {
    if (field?.valueType !== "number") {
      return field;
    }
    let slot = null;
    walkNodes(this.state.root, (node) => {
      const fields = this.state.blocksByKind.get(node.kind)?.fields || [];
      slot ??= fields.find((item) => item.acceptsNumberBlock && node.inputs?.[item.name]?.blockId === blockId);
    });
    return slot ? {
      ...field,
      valueType: slot.valueType,
      range: slot.range,
      choices: slot.choices,
      acceptsNumberBlock: true,
    } : field;
  }

  commitFieldValue(blockId, fieldName, rawValue) {
    const block = findBlock(this.state.root, blockId);
    const definition = this.state.blocksByKind.get(block?.kind);
    const field = this.fieldForEdit(blockId, definition?.fields?.find((item) => item.name === fieldName));
    if (!block || !field) {
      return;
    }
    const currentValue = block.inputs[fieldName];
    if (field.acceptsNumberBlock && currentValue?.kind === "value.number") {
      return this.commitFieldValue(currentValue.blockId, "value", rawValue);
    }
    let value = rawValue;
    if (field.acceptsNumberBlock || field.valueType === "number" || field.valueType === "integer") {
      value = String(rawValue).trim() ? Number(rawValue) : NaN;
      const message = numericFieldError(field, value);
      if (message) {
        this.toast(message);
        return;
      }
    } else if (field.valueType === "choice") {
      if (!(field.choices || []).map(String).includes(String(rawValue))) {
        this.toast("这个选项还不能用。");
        return;
      }
      value = Number.isNaN(Number(rawValue)) ? rawValue : Number(rawValue);
    } else if (field.valueType === "string") {
      value = String(rawValue);
      if (field.maxLength && value.length > field.maxLength) {
        this.toast("这句话太长啦。");
        return;
      }
    }
    if (block.inputs[fieldName] === value) {
      this.render();
      return;
    }
    const before = cloneTree(this.state.root);
    block.inputs[fieldName] = value;
    this.state.dirty = true;
    this.history.record("edit_input", before, cloneTree(this.state.root));
    this.refresh();
    this.onChange("program");
    return true;
  }

  applyTeachingEdit({ blockId, field, before, after }) {
    if (this.state.readonly || !["editing", "result", "error"].includes(this.state.phase) ||
        this.fieldEditor || this.dnd.session || !Number.isInteger(before) || !Number.isInteger(after) || before === after) {
      return false;
    }
    const block = findBlock(this.state.root, blockId);
    const eligibleField = { "control.repeat": "times", "motion.turn": "degrees" }[block?.kind];
    if (!eligibleField || field !== eligibleField || numberInputValue(block.inputs?.[field]) !== before) {
      return false;
    }
    return this.commitFieldValue(blockId, field, after) === true;
  }

  cancelFieldEdit() {
    if (this.fieldEditor) {
      this.fieldEditor.remove();
      this.fieldEditor = null;
    }
  }

  moveMirrorFocus(delta) {
    const buttons = Array.from(this.mirror?.querySelectorAll("button[data-block-id]") || []);
    if (buttons.length === 0) {
      return;
    }
    const active = document.activeElement;
    let index = buttons.indexOf(active);
    if (index < 0) {
      index = 0;
    } else {
      index = (index + delta + buttons.length) % buttons.length;
    }
    buttons[index].focus();
  }

  summary() {
    return programSummary(this.state.root, this.state.blocksByKind);
  }
}
