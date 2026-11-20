/** 失败定位：按布局节点矩形滚动并选中目标积木，失效时回退到画布工具栏。 */

export function locateBlock(editor, blockId) {
  if (!editor || !blockId) {
    return false;
  }
  const node = (editor.layout?.nodes || []).find((item) => item.blockId === blockId);
  if (!node) {
    return false;
  }
  try {
    editor.selectBlock(blockId);
  } catch {
    return false;
  }
  if (typeof editor.revealBlock === "function") {
    editor.revealBlock(blockId);
  }
  if (typeof document !== "undefined") {
    const toolbar = document.getElementById("canvas-toolbar");
    toolbar?.focus();
    const mirror = editor.mirror;
    const block = Array.from(mirror?.querySelectorAll("[data-block-id]") || [])
      .find((element) => element.dataset.blockId === blockId);
    block?.focus({ preventScroll: true });
  }
  return true;
}

export function locateTarget(editor, blockId, fallbackId = "canvas-toolbar") {
  const found = locateBlock(editor, blockId);
  if (found) {
    return { located: true, blockId };
  }
  const fallback = typeof document !== "undefined" ? document.getElementById(fallbackId) : null;
  if (fallback && typeof fallback.focus === "function") {
    fallback.focus();
  }
  return { located: false, blockId: null };
}
