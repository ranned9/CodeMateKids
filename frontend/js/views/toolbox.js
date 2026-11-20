/** 工具箱：积木分类与添加。 */
import { drawToolboxBlock } from "../editor/render.js";

const CATEGORY_ORDER = ["开始", "动作", "循环", "显示", "运算", "其他"];
let activeCategory = "全部";

function categoryOf(kind) {
  if (kind.startsWith("event.")) return "开始";
  if (kind.startsWith("motion.")) return "动作";
  if (kind.startsWith("control.")) return "循环";
  if (kind.startsWith("look.") || kind.startsWith("text.")) return "显示";
  if (kind.startsWith("value.")) return "运算";
  return "其他";
}

export function renderToolbox(container, state, callbacks) {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  const task = state.tasks.get(state.activeTaskId);
  const allowed = new Set(task?.allowedBlockKinds || []);
  const heading = document.createElement("p");
  heading.className = "muted";
  heading.textContent = "点一下或拖到画布添加。不要的积木可以拖回这里。";
  container.appendChild(heading);

  const definitions = [];
  for (const definition of state.blocksByKind.values()) {
    if (!allowed.has(definition.kind) || !definition.runnable) {
      continue;
    }
    definitions.push(definition);
  }
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
      list.appendChild(buildItem(definition, callbacks));
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
      container.appendChild(buildItem(rejected, callbacks, true));
    }
  }
}

function buildItem(definition, callbacks, blocked = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = blocked ? "toolbox-item blocked" : "toolbox-item";
  button.dataset.kind = definition.kind;
  const label = blocked
    ? `${definition.displayName}，不能运行。`
    : `${definition.displayName}，可拖动，点击或按 Enter 添加。`;
  button.setAttribute("aria-label", label);
  button.title = definition.blockedHint || definition.displayName;
  const artwork = document.createElement("canvas");
  if (!blocked && drawToolboxBlock(artwork, definition)) {
    artwork.className = "toolbox-block-art";
    artwork.setAttribute("aria-hidden", "true");
    button.appendChild(artwork);
  } else {
    const name = document.createElement("strong");
    name.textContent = definition.displayName;
    button.appendChild(name);
    if (blocked && definition.blockedHint) {
      const hint = document.createElement("small");
      hint.textContent = definition.blockedHint;
      button.appendChild(hint);
    }
  }
  if (!blocked) {
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      callbacks.onDragStart(definition.kind, event, button);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!event.repeat) {
          callbacks.onAdd?.(definition.kind);
        }
      }
    });
  } else {
    button.addEventListener("click", () => callbacks.onBlockedClick?.(definition));
  }
  return button;
}
