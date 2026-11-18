/** DOM 安全构建：动态文本一律通过 textContent 呈现。 */

export function clearNode(node) {
  if (node) {
    node.textContent = "";
  }
}

export function setText(node, text) {
  if (node) {
    node.textContent = String(text ?? "");
  }
}

export function appendParagraph(parent, text, className = "") {
  if (!parent) {
    return null;
  }
  const paragraph = document.createElement("p");
  if (className) {
    paragraph.className = className;
  }
  paragraph.textContent = String(text ?? "");
  parent.appendChild(paragraph);
  return paragraph;
}

export function appendDiv(parent, text, className = "") {
  if (!parent) {
    return null;
  }
  const element = document.createElement("div");
  if (className) {
    element.className = className;
  }
  element.textContent = String(text ?? "");
  parent.appendChild(element);
  return element;
}

export function appendErrorBox(parent, message, nextStep = "") {
  if (!parent) {
    return null;
  }
  const box = document.createElement("div");
  box.className = "error-box";
  const title = document.createElement("strong");
  title.textContent = String(message ?? "这里遇到一点问题。");
  box.appendChild(title);
  if (nextStep) {
    const next = document.createElement("div");
    next.className = "next-step";
    next.textContent = String(nextStep);
    box.appendChild(next);
  }
  parent.appendChild(box);
  return box;
}

export function appendList(parent, items, className = "steps-list") {
  if (!parent) {
    return null;
  }
  const list = document.createElement("ul");
  list.className = className;
  for (const item of items || []) {
    const entry = document.createElement("li");
    entry.textContent = String(item ?? "");
    list.appendChild(entry);
  }
  parent.appendChild(list);
  return list;
}