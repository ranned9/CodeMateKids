/** 自研 Canvas 工作区视图：布局、渲染、拖放、字段编辑、撤销与可访问性。 */
import { computeLayout } from "../editor/layout.js";
import { drawScene } from "../editor/render.js";
import { cloneTree, findBlock, planDrop, programSummary, removeBlock, validateTree, walkNodes } from "../editor/model.js";
import { DndController } from "../editor/dnd.js";
import { emptyLayoutModel } from "../editor/targets.js";
import { attachKeyboard } from "../editor/keyboard.js";
import { syncMirror } from "../util/a11y.js";

function previewCode(root, definitions) {
  if (!root) {
    return "# 画布是空的\n";
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
      } else if (current.kind === "control.repeat") {
        lines.push(`${pad}for _repeat_${guard} in range(${current.inputs?.times ?? 0}):`);
        const body = current.body?.[0];
        if (body) {
          chain(body, indent + 1);
        } else {
          lines.push(`${pad}    pass`);
        }
      } else if (current.kind === "motion.move") {
        lines.push(`${pad}stage.move(${current.inputs?.steps ?? 0})`);
      } else if (current.kind === "motion.turn") {
        lines.push(`${pad}stage.turn(${current.inputs?.degrees ?? 90})`);
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
  chain(root, 0);
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
    this.scrollY = 0;
    this.width = 720;
    this.height = 460;
    this.fieldEditor = null;
    window.__cmkState = this.state;
    window.__cmkEditor = this;
    this.dnd = new DndController(this);
    this.dnd.bind();
    attachKeyboard(this, this.handlers);
    this.canvas.addEventListener("wheel", (event) => {
      const maxScroll = Math.max(0, this.layout.height - this.height + 24);
      if (maxScroll <= 0) {
        this.scrollY = 0;
        return;
      }
      event.preventDefault();
      this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY + event.deltaY * 0.6));
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
    this.state.root = root;
    this.state.selectedBlockId = null;
    this.state.errorBlockId = null;
    this.state.runningBlockId = null;
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
    this.width = Math.max(360, Math.round(rect.width || 720));
    this.height = Math.max(320, Math.round(rect.height || 460));
  }

  refresh() {
    this.measure();
    const definitions = this.state.blocksByKind;
    this.layout = computeLayout(this.state.root, definitions, {
      w: this.width,
      h: this.height,
      scrollY: this.scrollY,
    });
    const validation = validateTree(this.state.root);
    this.state.invalidBlockIds = validation.invalidIds;
    this.render();
    if (this.empty) {
      this.empty.hidden = Boolean(this.state.root);
    }
    if (this.mirror) {
      syncMirror(this.mirror, this.layout.nodes || [], this.state);
    }
    if (this.code) {
      this.code.textContent = previewCode(this.state.root, definitions);
    }
  }

  render() {
    this.measure();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(this.width * dpr)) {
      this.canvas.width = Math.round(this.width * dpr);
    }
    if (this.canvas.height !== Math.round(this.height * dpr)) {
      this.canvas.height = Math.round(this.height * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(this.ctx, this.layout, {
      width: this.width,
      height: this.height,
      definitions: this.state.blocksByKind,
      selectedId: this.state.selectedBlockId,
      runningId: this.state.runningBlockId,
      errorId: this.state.errorBlockId,
      invalidIds: this.state.invalidBlockIds,
      editable: !this.state.readonly && this.state.phase !== "running",
      previewLayer: this.preview,
      scrollY: this.scrollY,
    });
  }

  pointFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.width / rect.width;
    const scaleY = this.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
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
    walkNodes(ancestor, (node) => {
      if (node.blockId === targetId) {
        found = true;
      }
    });
    return found;
  }

  insertFromKeyboard(kind) {
    if (this.state.readonly || this.state.phase === "running") {
      this.toast("程序正在运行，可以先停止再修改。");
      return false;
    }
    const definition = this.state.blocksByKind.get(kind);
    if (!definition || !definition.runnable) {
      this.toast("这个积木现在不能运行。");
      return false;
    }
    if (definition.outputType === "expression") {
      this.toast("当前课程暂时不能放这个积木。");
      return false;
    }
    const targetId = this.keyboardTargetId();
    const target = (this.layout.targets || []).find((item) => item.id === targetId);
    if (!target) {
      this.toast("这里暂时放不了，试试先选中一个积木。");
      return false;
    }
    return this.commitDrop(null, kind, { valid: true, message: "", target, portType: target.portType });
  }

  keyboardTargetId() {
    if (!this.state.root) {
      return "root@start";
    }
    const selected = this.state.selectedBlockId;
    if (selected && findBlock(this.state.root, selected)) {
      const selectedNode = (this.layout.nodes || []).find((node) => node.blockId === selected);
      if (selectedNode && selectedNode.ownerId !== "root") {
        return `body:${selectedNode.ownerId}@after:${selected}`;
      }
      return `root@after:${selected}`;
    }
    const rootNodes = (this.layout.nodes || [])
      .filter((node) => node.ownerId === "root")
      .sort((a, b) => a.order - b.order);
    const last = rootNodes[rootNodes.length - 1];
    return last ? `root@after:${last.blockId}` : "root@start";
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
    if (!targetResult || targetResult.valid !== true || !targetResult.target) {
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
    const beforeRoot = cloneTree(this.state.root);
    const beforeSelected = this.state.selectedBlockId;
    const beforeDirty = this.state.dirty;
    const undoDepth = this.history.undoStack?.length ?? 0;
    const redoDepth = this.history.redoStack?.length ?? 0;
    const type = targetResult.portType === "expression" ? "connect" : blockId ? "move" : "insert";
    try {
      const plan = planDrop(this.state.root, {
        blockId: blockId || null,
        kind,
        definition,
        targetId: targetResult.target.id,
      });
      if (!plan.ok) {
        if (plan.message) {
          this.toast(plan.message);
        }
        return false;
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
    if (this.state.readonly || this.state.phase === "running") {
      this.toast("程序正在运行，可以先停止再修改。");
      return;
    }
    const blockId = this.state.selectedBlockId;
    if (!blockId) {
      return;
    }
    const node = findBlock(this.state.root, blockId);
    if (!node) {
      return;
    }
    if (node.body && node.body.length > 0) {
      const confirmed = window.confirm("删除这个积木会同时移除里面的动作，确定吗？");
      if (!confirmed) {
        return;
      }
    }
    const before = cloneTree(this.state.root);
    const result = removeBlock(this.state.root, blockId);
    this.state.root = result.root;
    this.state.selectedBlockId = null;
    this.state.dirty = true;
    this.history.record("delete", before, cloneTree(result.root));
    this.refresh();
    this.onChange("program");
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
    const field = (block.fields || []).find((item) => item.name === fieldName);
    if (!field || field.valueType === "expression") {
      return;
    }
    this.cancelFieldEdit();
    const stageRect = this.stage.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / this.width;
    const scaleY = canvasRect.height / this.height;
    const left = field.rect.x * scaleX + (canvasRect.left - stageRect.left);
    const top = (field.rect.y - this.scrollY) * scaleY + (canvasRect.top - stageRect.top);
    const width = Math.max(70, field.rect.w * scaleX);
    const currentValue = block.node.inputs?.[fieldName];

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
      input.type = field.valueType === "number" ? "number" : "text";
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

  commitFieldValue(blockId, fieldName, rawValue) {
    const block = findBlock(this.state.root, blockId);
    const definition = this.state.blocksByKind.get(block?.kind);
    const field = (definition?.fields || []).find((item) => item.name === fieldName);
    if (!block || !field) {
      return;
    }
    let value = rawValue;
    if (field.valueType === "number") {
      value = Number(rawValue);
      if (!Number.isFinite(value)) {
        this.toast("这个位置需要一个数字。");
        return;
      }
      if (field.range?.min != null && value < field.range.min) {
        this.toast(`数字不能小于 ${field.range.min}。`);
        return;
      }
      if (field.range?.max != null && value > field.range.max) {
        this.toast(`数字不能大于 ${field.range.max}。`);
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