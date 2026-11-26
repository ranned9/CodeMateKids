/** 在 Canvas 积木的参数位置叠放可编辑的原生输入控件。 */
import { fieldControlRect, pickNode } from "./layout.js";

const COMPARISONS = {
  ">=": { symbol: "≥", label: "至少" },
  "==": { symbol: "=", label: "等于" },
  "<": { symbol: "<", label: "少于" },
};

export function fieldChoiceText(field, value) {
  if (field.name === "operator") return COMPARISONS[value]?.symbol ?? String(value ?? "");
  if ((field.name === "degrees" || field.suggestions) && value != null) return `${value}°`;
  return String(value ?? "");
}

function choiceOptionText(field, value) {
  return field.name === "operator" ? COMPARISONS[value]?.label ?? String(value) : fieldChoiceText(field, value);
}

function appendOptions(select, field, values) {
  for (const choice of values) {
    const option = document.createElement("option");
    option.value = String(choice);
    option.textContent = choiceOptionText(field, choice);
    select.appendChild(option);
  }
}

export class FieldControls {
  constructor(editor) {
    this.editor = editor;
    this.controls = new Map();
    this.layer = document.createElement("div");
    this.layer.className = "canvas-field-layer";
    editor.stage.appendChild(this.layer);
  }

  reset() {
    for (const control of this.controls.values()) {
      control.element.remove();
    }
    this.controls.clear();
  }

  get(blockId, fieldName) {
    return this.controls.get(`${blockId}.${fieldName}`);
  }

  sync(editable, hiddenBlockIds) {
    const { layout, canvas, width, height, scrollX, scrollY } = this.editor;
    const bounds = canvas.getBoundingClientRect();
    const scaleX = bounds.width / width;
    const scaleY = bounds.height / height;
    const visibleKeys = new Set();
    const visibleFields = new Set();

    for (const node of layout.nodes) {
      if (!node.visible || hiddenBlockIds?.has(node.blockId)) continue;
      for (const field of node.fields || []) {
        if (!field.inlineNumber && !(field.inHeader && field.valueType === "choice")) continue;
        const { x, y, w, h } = fieldControlRect(field);
        const hit = pickNode(layout, { x: x + w / 2, y: y + h / 2 });
        if (hit?.blockId !== node.blockId) continue;

        const key = `${node.blockId}.${field.name}`;
        const inputField = this.editor.fieldForEdit(node.blockId, field);
        let control = this.controls.get(key);
        if (!control || control.choices !== inputField.choices || control.suggestions !== inputField.suggestions) {
          control?.element.remove();
          control = this.create(node.blockId, inputField);
          this.controls.set(key, control);
        }
        const { element, input, caption, preset } = control;
        const value = node.inputs?.[field.name];
        if (control.value !== value || document.activeElement !== input) {
          input.value = String(value ?? "");
        }
        control.value = value;
        input.disabled = !editable;
        if (preset) {
          preset.disabled = !editable;
          preset.value = inputField.suggestions.includes(value) ? String(value) : "";
        }
        if (caption) {
          caption.textContent = fieldChoiceText(field, value);
        } else {
          control.min = inputField.range?.min;
          control.max = inputField.range?.max;
          input.min = control.min == null ? "" : String(control.min);
          input.max = control.max == null ? "" : String(control.max);
          input.step = inputField.valueType === "number" ? "any" : "1";
          input.inputMode = inputField.valueType === "number" ? "decimal" : "numeric";
        }
        element.style.left = `${(x - scrollX) * scaleX}px`;
        element.style.top = `${(y - scrollY) * scaleY}px`;
        element.style.width = `${w * scaleX}px`;
        element.style.height = `${h * scaleY}px`;
        visibleKeys.add(key);
        visibleFields.add(field);
      }
    }
    for (const [key, control] of this.controls) {
      if (!visibleKeys.has(key)) {
        control.element.remove();
        this.controls.delete(key);
      }
    }
    return visibleFields;
  }

  focus(blockId, fieldName) {
    const control = this.get(blockId, fieldName);
    if (control && !control.input.disabled) {
      control.input.focus();
      control.input.select?.();
    }
    return Boolean(control);
  }

  create(blockId, field) {
    const element = document.createElement("div");
    element.className = "canvas-field-control";
    const input = document.createElement(field.choices ? "select" : "input");
    const label = { times: "重复次数", degrees: "转弯角度", threshold: "比较步数", operator: "比较方式" }[field.name];
    input.setAttribute("aria-label", label || field.label || field.name);
    let caption = null;
    let preset = null;
    if (field.choices) {
      caption = document.createElement("span");
      caption.setAttribute("aria-hidden", "true");
      element.appendChild(caption);
      appendOptions(input, field, field.choices);
    } else {
      input.type = "number";
      input.addEventListener("focus", () => input.select());
    }

    if (field.suggestions?.length) {
      element.className += " has-presets";
      if (field.name === "degrees") element.dataset.unit = "°";
      preset = document.createElement("select");
      preset.setAttribute("aria-label", "选择预设角度");
      preset.title = "选择预设角度";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "选择预设角度";
      placeholder.disabled = true;
      placeholder.hidden = true;
      preset.appendChild(placeholder);
      appendOptions(preset, field, field.suggestions);
    }

    const control = { element, input, caption, preset, choices: field.choices, suggestions: field.suggestions };
    const commit = (value) => {
      if (!input.disabled) {
        this.editor.commitFieldValue(blockId, field.name, value);
      }
      input.value = String(control.value ?? "");
    };
    input.addEventListener("change", () => commit(input.value));
    if (!caption) {
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
          const delta = event.key === "ArrowDown" ? -1 : 1;
          const value = Math.min(control.max ?? Infinity, Math.max(control.min ?? -Infinity, control.value + delta));
          commit(String(value));
        }
      });
    }
    element.appendChild(input);
    if (preset) {
      preset.addEventListener("change", () => commit(preset.value));
      element.appendChild(preset);
    }
    this.layer.appendChild(element);
    return control;
  }
}
