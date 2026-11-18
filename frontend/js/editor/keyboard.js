/** 键盘与可访问性操作：聚焦、选择、移动、运行、求助、读取错误。 */

export function attachKeyboard(editor, handlers) {
  document.addEventListener("keydown", (event) => {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (event.key === "Escape") {
        editor.cancelFieldEdit();
      }
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