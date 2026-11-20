/** RG-UX：断点映射、面板默认策略、焦点域、主操作唯一性与阈值同源。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asUrl = (relative) => pathToFileURL(path.join(root, relative)).href;

const layout = await import(asUrl("frontend/js/ux/layoutMode.js"));
const panelsModule = await import(asUrl("frontend/js/ux/panels.js"));
const focusModule = await import(asUrl("frontend/js/ux/focusScope.js"));
const primaryModule = await import(asUrl("frontend/js/ux/primaryAction.js"));

assert.equal(layout.resolveLayoutMode({ wideAndTall: true }), "wide");
assert.equal(layout.resolveLayoutMode({ compactBand: true }), "compact3col");
assert.equal(layout.resolveLayoutMode({ editorFirstBand: true }), "editorFirst");
assert.equal(layout.resolveLayoutMode({ simpleBand: true }), "simple");
assert.equal(
  layout.resolveLayoutMode({ wideAndTall: true, compactBand: true, editorFirstBand: true, simpleBand: true }),
  "wide",
  "多模式同真时按 wide 优先",
);
assert.equal(layout.resolveLayoutMode({ compactBand: true, editorFirstBand: true }), "compact3col");
assert.equal(layout.isLowHeight({ lowHeight: true }), true);
assert.deepEqual(panelsModule.defaultPanelPolicy("wide"), ["result", "tutor"]);
assert.deepEqual(panelsModule.defaultPanelPolicy("simple"), ["result"]);

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.set = new Set();
  }
  add(name) {
    this.set.add(name);
    this.sync();
  }
  remove(name) {
    this.set.delete(name);
    this.sync();
  }
  contains(name) {
    return this.set.has(name);
  }
  sync() {
    this.element.className = Array.from(this.set).join(" ");
  }
}

class FakeElement {
  constructor(id = "", tagName = "div") {
    this.id = id;
    this.tagName = tagName;
    this.hidden = false;
    this.attrs = {};
    this.children = [];
    this.focusables = [];
    this.isConnected = true;
    this.className = "";
    this.classList = new FakeClassList(this);
    this.textContent = "";
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  querySelectorAll(selector) {
    if (selector === "[data-autofocus]") {
      return this.focusables.filter((element) => element.getAttribute("data-autofocus") === "true");
    }
    return this.focusables;
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  addEventListener() {}
}

const fakeDocument = {
  activeElement: null,
  querySelectorAll: () => [],
  getElementById: (id) => fakeDocument.ids?.get(id) || null,
  ids: new Map(),
};
globalThis.document = fakeDocument;

const panelElements = {
  result: new FakeElement("result-panel"),
  tutor: new FakeElement("tutor-panel"),
  systemInfo: new FakeElement("system-info"),
  taskList: new FakeElement("task-list-panel"),
};
const triggers = {
  result: new FakeElement("result-trigger", "button"),
  tutor: new FakeElement("tutor-trigger", "button"),
  systemInfo: new FakeElement("system-info-trigger", "button"),
  taskList: new FakeElement("task-list-trigger", "button"),
};
const focus = focusModule.createFocusScope({ doc: fakeDocument, fallbackAnchorId: "canvas-toolbar" });
fakeDocument.ids.set("canvas-toolbar", new FakeElement("canvas-toolbar"));

const controller = panelsModule.createPanelController({
  getPanel: (id) => panelElements[id] || null,
  getTrigger: (id) => triggers[id] || null,
  focusScope: focus,
  mode: "wide",
});

assert.equal(controller.open("unknownPanel"), false);
assert.equal(controller.open("systemInfo"), true);
assert.equal(panelElements.systemInfo.hidden, false);
assert.equal(triggers.systemInfo.getAttribute("aria-expanded"), "true");
controller.open("taskList");
assert.equal(controller.isOpen("systemInfo"), false, "导航互斥组先关后开");
assert.equal(controller.isOpen("taskList"), true);
controller.close("taskList");
assert.equal(triggers.taskList.getAttribute("aria-expanded"), "false");
assert.equal(fakeDocument.activeElement, triggers.taskList, "关闭后焦点回到触发控件");

controller.applyMode("simple");
assert.equal(controller.getState().mode, "simple");
controller.open("result");
controller.open("tutor");
assert.equal(controller.isOpen("result"), false, "窄模式下结果与辅导互斥");
assert.equal(controller.isOpen("tutor"), true);

const snapshot = controller.getState();
snapshot.panes.result.open = true;
assert.equal(controller.isOpen("result"), false, "getState 必须返回快照");

const first = new FakeElement("first", "button");
const second = new FakeElement("second", "button");
const auto = new FakeElement("auto", "input");
const container = new FakeElement("container");
container.focusables = [new FakeElement("plain", "button"), auto];
auto.setAttribute("data-autofocus", "true");
const trigger = new FakeElement("open", "button");
assert.equal(focus.enter(container, trigger), auto);
assert.equal(focus.exit(), trigger);
trigger.isConnected = false;
assert.equal(focus.exit(), fakeDocument.ids.get("canvas-toolbar"));
const emptyContainer = new FakeElement("empty");
focus.enter(emptyContainer, first);
assert.equal(emptyContainer.getAttribute("tabindex"), "-1");

const doc = {
  ids: new Map([
    ["run-button", new FakeElement("run-button", "button")],
    ["stop-button", new FakeElement("stop-button", "button")],
  ]),
  querySelectorAll(selector) {
    if (selector === "[data-primary]") {
      return Array.from(doc.ids.values()).filter((element) => element.getAttribute("data-primary") === "true");
    }
    if (selector === ".primary-button") {
      return Array.from(doc.ids.values()).filter((element) => element.classList.contains("primary-button"));
    }
    return [];
  },
  getElementById(id) {
    return doc.ids.get(id) || null;
  },
};
doc.ids.get("run-button").classList.add("primary-button");
doc.ids.get("stop-button").classList.add("ghost-button");
primaryModule.applyPrimaryAction(doc, { controlId: "run-button" });
assert.equal(doc.ids.get("run-button").getAttribute("data-primary"), "true");
primaryModule.applyPrimaryAction(doc, { controlId: "stop-button" });
assert.equal(doc.ids.get("run-button").getAttribute("data-primary"), null);
assert.equal(doc.ids.get("stop-button").getAttribute("data-primary"), "true");
assert.equal(doc.ids.get("run-button").classList.contains("primary-button"), false, "其余主样式降为次级");
const primaries = doc.querySelectorAll("[data-primary]");
assert.equal(primaries.length, 1);
primaryModule.applyPrimaryAction(doc, { controlId: "missing" });
assert.equal(doc.querySelectorAll("[data-primary]").length, 0);

const css = readFileSync(path.join(root, "frontend/css/app.css"), "utf-8");
for (const token of ["--space-1", "--space-6", "--control-h", "--focus-ring", "--motion-fast", "--motion-base"]) {
  assert.ok(css.includes(token), `app.css 缺少 token ${token}`);
}
for (const token of ["--ink", "--brand", "--radius"]) {
  assert.ok(css.includes(token), `app.css 不得删除既有变量 ${token}`);
}
for (const query of [
  `min-width: ${layout.BREAKPOINTS.wide.minWidth}px`,
  `min-height: ${layout.BREAKPOINTS.wide.minHeight}px`,
  `min-width: ${layout.BREAKPOINTS.compact.minWidth}px`,
  `max-width: ${layout.BREAKPOINTS.compact.maxWidth}px`,
  `min-width: ${layout.BREAKPOINTS.editorFirst.minWidth}px`,
  `max-width: ${layout.BREAKPOINTS.editorFirst.maxWidth}px`,
  `max-width: ${layout.BREAKPOINTS.simple.maxWidth}px`,
  `max-height: ${layout.BREAKPOINTS.lowHeight.maxHeight}px`,
]) {
  assert.ok(css.includes(query), `app.css 媒体查询缺少 ${query}`);
}
assert.equal(css.includes("minmax(420px"), false, "不得保留固定最小行高");
assert.equal(css.includes("minmax(220px"), false, "不得保留固定最小行高");
assert.ok(css.includes("prefers-reduced-motion"), "必须提供减少动态效果退化");
assert.ok(css.includes(":focus-visible"), "必须提供统一焦点环");

console.log("JS-UX-PANELS-CHECK PASSED");