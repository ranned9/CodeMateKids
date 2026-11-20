/** 键盘作用域：焦点在按钮/表单/链接/面板控件时交给控件处理，不吞掉输入框 Escape。 */

const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"]);

export function isFieldTarget(target) {
  return Boolean(target && (FIELD_TAGS.has(target.tagName) || target.isContentEditable === true));
}

export function isInteractiveTarget(target) {
  if (!target) {
    return false;
  }
  if (INTERACTIVE_TAGS.has(target.tagName) || target.isContentEditable === true) {
    return true;
  }
  return target.getAttribute?.("role") === "button";
}

export function attachKeyboard(editor, handlers) {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (isFieldTarget(target)) {
      if (event.key === "Escape") {
        editor.cancelFieldEdit();
      }
      return;
    }
    const inMirror = Boolean(target?.dataset?.blockId && editor.mirror?.contains(target));
    if (isInteractiveTarget(target) && (!inMirror || event.key === "Enter" || event.key === " ")) {
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "z") {
      event.preventDefault();
      handlers.undo?.();
      return;
    }
    if (ctrl && event.key.toLowerCase() === "y") {
      event.preventDefault();
      handlers.redo?.();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (editor.state.selectedBlockId) {
        event.preventDefault();
        handlers.deleteSelected?.();
      }
      return;
    }
    if (event.key === "Enter" && editor.state.selectedBlockId) {
      event.preventDefault();
      editor.openSelectedHint?.();
      return;
    }
    if ((event.key === "e" || event.key === "E") && editor.state.selectedBlockId) {
      event.preventDefault();
      editor.editFirstField?.();
      return;
    }
    if (event.key === "r" || event.key === "R") {
      handlers.run?.();
      return;
    }
    if (event.key === "h" || event.key === "H" || event.key === "?") {
      handlers.hint?.();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      editor.moveMirrorFocus(event.key === "ArrowDown" ? 1 : -1);
    }
  });
}
