/** 工具箱：类别筛选 + 只呈现当前画布确实能放下的积木。 */

import { emptyLayoutModel, hasPlaceableTarget } from "../editor/targets.js";

const CATEGORY_ORDER = ["开始", "动作", "循环", "显示", "其他"];
let activeCategory = "全部";

function categoryOf(kind) {
  if (kind.startsWith("event.")) return "开始";
  if (kind.startsWith("motion.")) return "动作";
  if (kind.startsWith("control.")) return "循环";
  if (kind.startsWith("look.") || kind.startsWith("text.")) return "显示";
  return "其他";
}

export function renderToolbox(container, state, callbacks) {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  const layout = callbacks.getLayout?.() || emptyLayoutModel({ w: 720, h: 460, scrollY: 0 });
  const task = state.tasks.get(state.activeTaskId);
  const allowed = new Set(task?.allowedBlockKinds || []);
  const heading = document.createElement("p");
  heading.className = "muted";
  heading.textContent = "按住一个积木，拖到画布上。";
  container.appendChild(heading);

  const definitions = [];
  for (const definition of state.blocksByKind.values()) {
    if (!allowed.has(definition.kind) || !definition.runnable) {
      continue;
    }
    definitions.push(definition);
  }
  const placeable = new Map(
    definitions.map((definition) => [
      definition.kind,
      hasPlaceableTarget(layout, definition, state.schema),
    ]),
  );
  const categories = ["全部"];
  for (const definition of definitions) {
    const category = categoryOf(definition.kind);
    if (!categories.includes(category)) {
      categories.push(category);
    }
  }
  categories.sort((a, b) => {
    if (a === "全部") return -1;
    if (b === "全部") return 1;
    return CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b);
  });
  if (!categories.includes(activeCategory)) {
    activeCategory = "全部";
  }

  const chips = document.createElement("div");
  chips.className = "toolbox-categories";
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "积木类别");
  const list = document.createElement("div");
  list.className = "toolbox-items";

  function renderItems() {
    list.innerHTML = "";
    const visible = definitions.filter(
      (definition) => activeCategory === "全部" || categoryOf(definition.kind) === activeCategory,
    );
    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "这一类暂时没有积木";
      list.appendChild(empty);
    }
    for (const definition of visible) {
      const mode = placeable.get(definition.kind) ? "normal" : "readonly";
      list.appendChild(buildItem(definition, state, callbacks, mode));
    }
  }

  for (const category of categories) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "toolbox-chip";
    chip.dataset.category = category;
    chip.textContent = category;
    chip.setAttribute("aria-pressed", String(category === activeCategory));
    chip.addEventListener("click", () => {
      activeCategory = category;
      for (const item of chips.querySelectorAll(".toolbox-chip")) {
        item.setAttribute("aria-pressed", String(item.dataset.category === activeCategory));
      }
      renderItems();
    });
    chips.appendChild(chip);
  }

  container.appendChild(chips);
  container.appendChild(list);
  renderItems();

  if (state.rejectedKinds.length > 0) {
    const divider = document.createElement("p");
    divider.className = "muted";
    divider.textContent = "还有一些积木暂时不能运行：";
    container.appendChild(divider);
    for (const rejected of state.rejectedKinds) {
      container.appendChild(buildItem(rejected, state, callbacks, "blocked"));
    }
  }
}

function buildItem(definition, state, callbacks, mode) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `toolbox-item${mode === "normal" ? "" : " blocked"}${mode === "readonly" ? " readonly" : ""}`;
  button.dataset.kind = definition.kind;
  const label =
    mode === "blocked"
      ? `${definition.displayName}，不能运行。`
      : mode === "readonly"
        ? `${definition.displayName}，暂时没有能放的位置。`
        : `${definition.displayName}，可拖动。按 Enter 也可以添加。`;
  button.setAttribute("aria-label", label);
  const strong = document.createElement("strong");
  strong.textContent = definition.displayName;
  const small = document.createElement("small");
  small.textContent =
    mode === "readonly" ? "这个积木暂时没有能放的位置" : definition.blockedHint || "";
  button.appendChild(strong);
  button.appendChild(small);
  if (mode === "normal") {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      callbacks.onDragStart(definition.kind, event, button);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        callbacks.onKeyboardAdd?.(definition.kind);
      }
    });
  } else {
    button.addEventListener("click", () => {
      if (mode === "blocked") {
        callbacks.onBlockedClick?.(definition);
      } else {
        callbacks.onUnplaceableClick?.(definition);
      }
    });
  }
  return button;
}