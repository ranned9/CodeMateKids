/** 工具箱：积木分类与添加。 */
import { drawToolboxBlock } from "../editor/render.js";

const CATEGORY_ORDER = ["开始", "动作", "循环", "分支", "其他"];
const UNAVAILABLE_CATEGORY = "暂不可用";
let activeCategory = "全部";

function categoryOf(kind) {
  if (kind.startsWith("event.")) return "开始";
  if (kind.startsWith("motion.")) return "动作";
  if (kind === "control.if" || kind === "control.else") return "分支";
  if (kind.startsWith("control.")) return "循环";
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
  if (state.rejectedKinds.length > 0) {
    categories.push(UNAVAILABLE_CATEGORY);
  }
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
    const blocked = activeCategory === UNAVAILABLE_CATEGORY;
    heading.hidden = blocked;
    const visible = blocked ? state.rejectedKinds : definitions.filter(
      (definition) => activeCategory === "全部" || categoryOf(definition.kind) === activeCategory,
    );
    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "这一类暂时没有积木";
      list.appendChild(empty);
    }
    for (const definition of visible) {
      list.appendChild(buildItem(definition, callbacks, blocked));
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
      for (const item of chips.children) {
        item.setAttribute("aria-pressed", String(item.dataset.category === activeCategory));
      }
      renderItems();
    });
    chips.appendChild(chip);
  }

  container.appendChild(chips);
  container.appendChild(list);
  renderItems();
}

function clampRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, number));
}

/**
 * 0.9.0：在 pointerdown 事件处理内同步读取缩略图实际绘制边界（CSS 像素）与按下相对位置，
 * 作为拿起动画起点尺寸与抓取公式的输入。读取失败时以按钮边界兜底，仍不可得返回 null。
 */
function buildGrabInfo(event, button, artwork, inset) {
  try {
    for (const element of [artwork, button]) {
      if (!element?.getBoundingClientRect) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
        continue;
      }
      const insetX = element === artwork ? rect.width * inset.insetX : 0;
      const insetY = element === artwork ? rect.height * inset.insetY : 0;
      const width = rect.width - 2 * insetX;
      const height = rect.height - 2 * insetY;
      return {
        ratioX: clampRatio((event.clientX - rect.left - insetX) / width),
        ratioY: clampRatio((event.clientY - rect.top - insetY) / height),
        startWidth: width,
        startHeight: height,
      };
    }
  } catch (error) {
    // 边界读取失败时返回 null，由 dnd.js 异常路径兜底。
  }
  return null;
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
  let artwork = null;
  const canvas = document.createElement("canvas");
  const inset = !blocked && drawToolboxBlock(canvas, definition);
  if (inset) {
    canvas.className = "toolbox-block-art";
    canvas.setAttribute("aria-hidden", "true");
    button.appendChild(canvas);
    artwork = canvas;
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
      // 读取在事件处理内同步完成，规避工具箱类别切换重渲染导致的边界失真。
      callbacks.onDragStart(definition.kind, event, button, buildGrabInfo(event, button, artwork, inset));
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
