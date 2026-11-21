/** 模型接入配置的前端镜像：只做展示与表单状态，不参与任何判定。
 *  判定真源为 backend/tutor/model_config.py。 */

export const SOURCES = Object.freeze(["default", "environment", "web"]);
export const EFFECTIVE_MODES = Object.freeze(["mock", "model"]);
export const FAILURE_CATEGORIES = Object.freeze([
  "invalid",
  "forbidden",
  "conflict",
  "expired",
  "auth",
  "endpoint",
  "rate_limit",
  "timeout",
  "refusal",
  "invalid_response",
  "storage",
]);
export const ALLOWED_ACTIONS = Object.freeze([
  "ask_question",
  "point_to_block",
  "show_execution",
  "hint",
  "offer_variant",
]);
export const TARGET_REFS = Object.freeze([
  "loopBlock",
  "moveBlock",
  "outsideMoveBlock",
  "verifiedReplay",
  "nextTask",
]);

export const FAILURE_TEXT = Object.freeze({
  invalid: "地址或参数格式不对，检查一下再试。",
  forbidden: "这个地址不能使用，换一个公开的服务地址吧。",
  conflict: "配置刚刚变过，刷新后再试一次。",
  expired: "这次测试已经失效，请重新测试。",
  auth: "服务没有认可这把钥匙，检查一下密钥。",
  endpoint: "连不上这个地址，检查地址是否正确。",
  rate_limit: "请求太频繁了，稍等一下再试。",
  timeout: "服务响应太慢，稍后再试。",
  refusal: "服务不愿意回答这次请求，稍后再试。",
  invalid_response: "服务的回复格式不对，换一个模型试试。",
  storage: "本机配置文件写入失败，请检查项目日志目录是否可写后重试。",
});

export const SOURCE_TEXT = Object.freeze({
  default: "默认演示回复",
  environment: "启动配置",
  web: "网页配置",
});

export function sourceLabel(value) {
  return SOURCE_TEXT[value] || SOURCE_TEXT.default;
}

export function failureText(category) {
  return FAILURE_TEXT[category] || "这次没有成功，稍后再试。";
}

export function createEmptyForm() {
  return { baseUrl: "", model: "", apiKey: "", expectedRevision: 0 };
}

export function validateForm(form, reuseSavedKey = false) {
  const errors = [];
  const baseUrl = String(form?.baseUrl || "").trim();
  const model = String(form?.model || "").trim();
  const apiKey = String(form?.apiKey || "").trim();
  if (!baseUrl) {
    errors.push("baseUrl");
  } else if (baseUrl.length > 512 || !/^https:\/\//i.test(baseUrl)) {
    errors.push("baseUrl");
  }
  if (!model || model.length > 160) {
    errors.push("model");
  }
  if ((!apiKey && !reuseSavedKey) || apiKey.length > 2048) {
    errors.push("apiKey");
  }
  return { ok: errors.length === 0, errors };
}

export function toTestPayload(form, expectedRevision) {
  const apiKey = String(form?.apiKey || "").trim();
  return {
    expectedRevision: Number(expectedRevision) || 0,
    baseUrl: String(form?.baseUrl || "").trim(),
    model: String(form?.model || "").trim(),
    ...(apiKey ? { apiKey } : {}),
  };
}

export function toActivatePayload(testId, expectedRevision) {
  return { expectedRevision: Number(expectedRevision) || 0, ...(testId ? { testId } : {}) };
}

export function toDisablePayload(expectedRevision) {
  return { expectedRevision: Number(expectedRevision) || 0 };
}

export function isRevisionStale(snapshot, formRevision) {
  return Number(snapshot?.revision ?? 0) !== Number(formRevision ?? 0);
}
