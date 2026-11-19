/** 让画布上的数字与次数使用可见的原生输入控件。 */
import { pickNode } from "./layout.js";

export class NumberControls {
  constructor(editor) {
    this.editor = editor;
    this.controls = new Map();
    this.layer = document.createElement("div");
    this.layer.className = "canvas-number-layer";
    editor.stage.appendChild(this.layer);
  }

  reset() {
    for (const control of this.controls.values()) {
      control.element.remove();
    }
    this.controls.clear();
  }

  sync(editable, dragging) {
    this.layer.hidden = dragging;
    if (dragging) {
      return null;
    }

    const { layout, canvas, width, height, scrollX, scrollY } = this.editor;
    const bounds = canvas.getBoundingClientRect();
    const scaleX = bounds.width / width;
    const scaleY = bounds.height / height;
    const visible = new Set();

    for (const node of layout.nodes) {
      const field = node.visible && node.fields?.find((item) => item.inlineNumber);
      if (!field) {
        continue;
      }
      const { x, y, w, h } = field.rect;
      const left = x + Math.min(43, Math.floor(w * 0.38));
      const controlWidth = Math.min(106, w - (left - x) - 4);
      const hit = pickNode(layout, { x: left + controlWidth / 2, y: y + h / 2 });
      if (hit?.blockId !== node.blockId) {
        continue;
      }

      const control = this.controls.get(node.blockId) || this.create(node.blockId, field.name);
      const { element, input, decrease, increase } = control;
      const value = node.inputs?.[field.name];
      const inputField = this.editor.fieldForEdit(node.blockId, field);
      const { min, max } = inputField.range || {};
      control.editable = editable;
      control.min = min;
      control.max = max;
      if (control.value !== value || document.activeElement !== input) {
        input.value = String(value ?? "");
      }
      control.value = value;
      input.disabled = !editable;
      input.min = min ?? "";
      input.max = max ?? "";
      input.step = inputField.valueType === "integer" ? "1" : "any";
      input.inputMode = inputField.valueType === "integer" ? "numeric" : "decimal";
      decrease.disabled = !editable || (min != null && value <= min);
      increase.disabled = !editable || (max != null && value >= max);
      element.style.left = `${(left - scrollX) * scaleX}px`;
      element.style.top = `${(y + 2 - scrollY) * scaleY}px`;
      element.style.width = `${controlWidth * scaleX}px`;
      element.style.height = `${(h - 4) * scaleY}px`;
      visible.add(node.blockId);
    }
    for (const [id, control] of this.controls) {
      if (!visible.has(id)) {
        control.element.remove();
        this.controls.delete(id);
      }
    }
    return visible;
  }

  focus(blockId) {
    const control = this.controls.get(blockId);
    if (control?.editable) {
      control.input.focus();
      control.input.select();
    }
    return Boolean(control);
  }

  create(blockId, fieldName) {
    const element = document.createElement("div");
    element.className = "canvas-number-control";
    const label = fieldName === "times" ? "重复次数" : "数字的数值";
    const input = document.createElement("input");
    input.type = "number";
    input.setAttribute("aria-label", label);
    const makeButton = (sign, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = sign;
      button.setAttribute("aria-label", action + label);
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.stopPropagation();
        }
      });
      return button;
    };
    const decrease = makeButton("−", "减少");
    const increase = makeButton("+", "增加");
    const control = { element, input, decrease, increase };
    const commit = (value) => {
      if (control.editable) {
        this.editor.commitFieldValue(blockId, fieldName, value);
      }
      input.value = String(control.value ?? "");
    };
    const step = (delta) => {
      const value = Math.min(control.max ?? Infinity, Math.max(control.min ?? -Infinity, control.value + delta));
      commit(String(value));
    };
    decrease.addEventListener("click", () => step(-1));
    increase.addEventListener("click", () => step(1));
    input.addEventListener("focus", () => input.select());
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") {
          commit(input.value);
        } else {
          input.value = String(control.value ?? "");
        }
        input.blur();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        step(event.key === "ArrowDown" ? -1 : 1);
      }
    });
    element.appendChild(decrease);
    element.appendChild(input);
    element.appendChild(increase);
    this.layer.appendChild(element);
    this.controls.set(blockId, control);
    return control;
  }
}
