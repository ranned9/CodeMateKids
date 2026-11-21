/** T-WM-08：前端配置镜像与后端常量一致；纯逻辑可断言。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asUrl = (relative) => pathToFileURL(path.join(root, relative)).href;

const expected = JSON.parse(
  readFileSync(path.join(root, "tests", "fixtures", "model-config-expected.json"), "utf-8"),
);
const mirror = await import(asUrl("frontend/js/ux/modelConfigState.js"));

assert.deepEqual([...mirror.SOURCES], expected.SOURCES);
assert.deepEqual([...mirror.EFFECTIVE_MODES], expected.EFFECTIVE_MODES);
assert.deepEqual([...mirror.FAILURE_CATEGORIES], expected.FAILURE_CATEGORIES);
assert.deepEqual([...mirror.ALLOWED_ACTIONS], expected.ALLOWED_ACTIONS);
assert.deepEqual([...mirror.TARGET_REFS], expected.TARGET_REFS);

for (const category of expected.FAILURE_CATEGORIES) {
  assert.equal(typeof mirror.FAILURE_TEXT[category], "string", `缺少 ${category} 文案`);
  assert.equal(typeof mirror.failureText(category), "string");
}
assert.equal(mirror.failureText("future"), "这次没有成功，稍后再试。");
assert.equal(mirror.sourceLabel("web"), "网页配置");

const empty = mirror.validateForm({ baseUrl: "", model: "", apiKey: "" });
assert.equal(empty.ok, false);
assert.deepEqual(empty.errors, ["baseUrl", "model", "apiKey"]);

const httpForm = { baseUrl: "http://provider.example/v1", model: "m", apiKey: "k" };
assert.equal(mirror.validateForm(httpForm).ok, false, "网页配置只允许 HTTPS");

const okayForm = { baseUrl: "https://provider.example/v1", model: "m", apiKey: "k" };
assert.equal(mirror.validateForm(okayForm).ok, true);
assert.deepEqual(mirror.toTestPayload(okayForm, "0"), {
  expectedRevision: 0,
  baseUrl: "https://provider.example/v1",
  model: "m",
  apiKey: "k",
});
assert.deepEqual(mirror.toActivatePayload("t-1", 2), { expectedRevision: 2, testId: "t-1" });
assert.deepEqual(mirror.toActivatePayload(null, 2), { expectedRevision: 2 });
const savedForm = { ...okayForm, apiKey: "" };
assert.equal(mirror.validateForm(savedForm, true).ok, true);
assert.equal(mirror.toTestPayload(savedForm, 0).apiKey, undefined);
assert.deepEqual(mirror.toDisablePayload(3), { expectedRevision: 3 });
assert.equal(mirror.isRevisionStale({ revision: 2 }, 1), true);
assert.equal(mirror.isRevisionStale({ revision: 2 }, 2), false);

const source = readFileSync(path.join(root, "frontend", "js", "ux", "modelConfigState.js"), "utf-8");
assert.equal(/function\s+classify|function\s+diagnose|function\s+decide/.test(source), false);
assert.equal(source.includes("PATTERN"), false);

const { bindModelConfig } = await import(asUrl("frontend/js/views/modelConfig.js"));
const elements = new Map();
const doc = { getElementById(id) {
  if (!elements.has(id)) {
    elements.set(id, { value: "", handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
  }
  return elements.get(id);
} };
const element = (id) => doc.getElementById(id);
const update = () => new Promise((resolve) => setImmediate(resolve));
const event = { preventDefault() {} };
const settings = { effectiveMode: "mock", revision: 0, source: "default", apiKeyConfigured: false };
let finishTest;
let activated;
const seen = [];
bindModelConfig(doc, (snapshot) => seen.push(snapshot), {
  modelConfig: async () => settings,
  testModel: (payload) => {
    assert.equal(payload.apiKey, "fixtures-only");
    return new Promise((resolve) => { finishTest = resolve; });
  },
  activateModel: async (payload) => {
    activated = payload;
    return { ...settings, revision: 1, source: "web", effectiveMode: "model", model: "m", apiKeyConfigured: true };
  },
});
element("system-info-trigger").handlers.click();
await update();
assert.equal(element("model-test").disabled, false);
element("model-base-url").value = "https://provider.example/v1";
element("model-name").value = "m";
element("model-api-key").value = "fixtures-only";
element("model-config").handlers.submit(event);
assert.equal(element("model-api-key").value, "");
element("model-name").handlers.input();
finishTest({ testId: "stale", revision: 0, model: "m", latencyMs: 50 });
await update();
assert.equal(element("model-activate").disabled, true, "编辑后晚到的测试结果不能启用");
element("model-api-key").value = "fixtures-only";
element("model-config").handlers.submit(event);
finishTest({ testId: "fresh", revision: 0, model: "m", latencyMs: 50 });
await update();
assert.equal(element("model-activate").disabled, false);
assert.equal(element("model-api-key").value, "");
assert.equal(element("model-api-key").placeholder, "密钥已保存，可留空");
assert.equal(element("model-config-active").textContent, "演示模式 · 密钥已保存");
assert.match(element("model-config-feedback").textContent, /密钥已保存/);
const saved = seen.at(-1);
element("model-activate").handlers.click();
await update();
assert.deepEqual(activated, { expectedRevision: 0, testId: "fresh" });
assert.equal(seen.at(-1).effectiveMode, "model");
assert.match(element("model-config-active").textContent, /真实模型已启用/);

elements.clear();
activated = null;
bindModelConfig(doc, () => {}, {
  modelConfig: async () => saved,
  activateModel: async (payload) => {
    activated = payload;
    return { ...settings, revision: 1, source: "web", effectiveMode: "model", model: "m", apiKeyConfigured: true };
  },
});
element("system-info-trigger").handlers.click();
await update();
assert.equal(element("model-base-url").value, "https://provider.example/v1");
assert.equal(element("model-name").value, "m");
assert.equal(element("model-api-key").required, false);
assert.equal(element("model-activate").disabled, false);
element("model-activate").handlers.click();
await update();
assert.deepEqual(activated, { expectedRevision: 0, testId: "fresh" });

console.log("JS-MODEL-CONFIG-CHECK PASSED");
