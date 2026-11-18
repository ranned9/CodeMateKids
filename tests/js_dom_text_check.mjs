/** RG-14：动态文案只走 textContent，不解析为节点。 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.className = "";
    this.textContent = "";
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const domUtil = await import(pathToFileURL(path.join(root, "frontend/js/util/dom.js")).href);

const parent = new FakeElement();
const payload = '<img src=x onerror=alert(1)><b>失败</b>';
const paragraph = domUtil.appendParagraph(parent, payload);
assert.equal(paragraph.textContent, payload);
assert.equal(paragraph.children.length, 0);
assert.equal(paragraph.innerHTML, undefined);

const box = domUtil.appendErrorBox(parent, payload, "下一步 <script>alert(2)</script>");
assert.equal(box.children[0].textContent, payload);
assert.equal(box.children[0].children.length, 0);
assert.equal(box.children[1].textContent, "下一步 <script>alert(2)</script>");

const list = domUtil.appendList(parent, ["<b>一</b>", "<img src=x>"], "steps-list");
assert.equal(list.children.length, 2);
assert.equal(list.children[0].textContent, "<b>一</b>");
assert.equal(list.children[1].children.length, 0);

const node = new FakeElement();
node.textContent = "旧内容";
domUtil.setText(node, payload);
assert.equal(node.textContent, payload);
domUtil.clearNode(node);
assert.equal(node.textContent, "");

console.log("JS-DOM-TEXT-CHECK PASSED");