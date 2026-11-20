/** 主操作唯一写入入口：页面同时最多一个 [data-primary="true"]，结果区不得再出现 primary-button。 */

let warned = false;

export function applyPrimaryAction(doc, action) {
  if (!doc || typeof doc.querySelectorAll !== "function") {
    return null;
  }
  const previous = Array.from(doc.querySelectorAll("[data-primary]"));
  for (const element of previous) {
    if (typeof element.removeAttribute === "function") {
      element.removeAttribute("data-primary");
    }
  }
  if (!action || !action.controlId) {
    return null;
  }
  const target = doc.getElementById?.(action.controlId) || null;
  if (!target) {
    if (!warned) {
      warned = true;
      console.warn(`primary-action: 找不到控件 ${action.controlId}，本次不设置主操作。`);
    }
    return null;
  }
  const primaries = Array.from(doc.querySelectorAll(".primary-button"));
  for (const element of primaries) {
    if (element === target || !element.classList) {
      continue;
    }
    if (element.classList.contains("primary-button")) {
      element.classList.remove("primary-button");
      element.classList.add("ghost-button");
    }
  }
  if (typeof target.setAttribute === "function") {
    target.setAttribute("data-primary", "true");
  }
  if (target.classList && !target.classList.contains("primary-button")) {
    target.classList.remove("ghost-button");
    target.classList.add("primary-button");
  }
  return target;
}

export function resetPrimaryActionWarnForTest() {
  warned = false;
}