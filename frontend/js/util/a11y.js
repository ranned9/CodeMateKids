/** 语义镜像 DOM：按布局节点顺序呈现积木，颜色不是唯一状态提示。 */

export function syncMirror(mirrorEl, layoutNodes, state, selectBlock) {
  if (!mirrorEl) {
    return;
  }
  const focused = document.activeElement;
  const focusId = focused?.dataset?.blockId && mirrorEl.contains(focused) ? focused.dataset.blockId : null;
  let restoringFocus = false;
  mirrorEl.innerHTML = "";
  const list = document.createElement("div");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "画布中的积木列表");

  layoutNodes.forEach((node, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.blockId = node.blockId;
    button.className = "mirror-block";
    const statuses = [];
    if (node.blockId === state.selectedBlockId) statuses.push("已选中");
    if (node.blockId === state.runningBlockId) statuses.push("正在运行");
    if (node.blockId === state.errorBlockId) statuses.push("出错了");
    if (state.invalidBlockIds?.has(node.blockId)) statuses.push("需要填写");
    if (node.unknown) statuses.push("不可执行");
    const name = state.blocksByKind?.get(node.kind)?.displayName || "未知积木";
    button.setAttribute(
      "aria-label",
      `第 ${index + 1} 个积木，${name}，层级 ${node.depth + 1}${statuses.length ? "，" + statuses.join("，") : ""}`,
    );
    button.textContent = `${name}${statuses.length ? "（" + statuses.join("，") + "）" : ""}`;
    button.addEventListener("focus", () => {
      if (!restoringFocus) selectBlock(node.blockId, { skipNotify: true });
    });
    button.addEventListener("click", () => selectBlock(node.blockId));
    list.appendChild(button);
  });

  mirrorEl.appendChild(list);
  if (focusId) {
    const next = mirrorEl.querySelector(`[data-block-id="${state.selectedBlockId ?? focusId}"]`);
    if (next) {
      restoringFocus = true;
      next.focus({ preventScroll: true });
      restoringFocus = false;
    }
  }
}

export function announce(text) {
  const region = document.getElementById("drag-live") || document.getElementById("toast");
  if (!region) {
    return;
  }
  region.hidden = false;
  region.textContent = text;
  if (region.id === "toast") {
    window.clearTimeout(announce.timer);
    announce.timer = window.setTimeout(() => {
      region.hidden = true;
    }, 3200);
  }
}
