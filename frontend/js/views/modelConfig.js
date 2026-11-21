import { API } from "../api.js";
import { failureText, sourceLabel, toActivatePayload, toDisablePayload, toTestPayload, validateForm } from "../ux/modelConfigState.js";

export function bindModelConfig(doc, onConfig, api = API) {
  const find = (id) => doc.getElementById(id);
  const form = find("model-config");
  const base = find("model-base-url");
  const model = find("model-name");
  const key = find("model-api-key");
  const test = find("model-test");
  const activate = find("model-activate");
  const disable = find("model-disable");
  const active = find("model-config-active");
  const feedback = find("model-config-feedback");
  let snapshot = null;
  let formVersion = 0;
  let busy = false;

  function formBaseUrl() {
    return base.value.trim().replace(/\/+$/, "");
  }

  function usesSavedKey() {
    const address = formBaseUrl();
    return snapshot?.testedConfig?.baseUrl === address
      || (snapshot?.source === "web" && snapshot.baseUrl === address);
  }

  function testedForForm() {
    const saved = snapshot?.testedConfig;
    if (saved?.baseUrl === formBaseUrl() && saved.model === model.value.trim() && !key.value.trim()) {
      return saved;
    }
    return null;
  }

  function canResume() {
    return snapshot?.effectiveMode === "mock" && snapshot.source === "web"
      && snapshot.baseUrl === formBaseUrl() && snapshot.model === model.value.trim() && !key.value.trim();
  }

  function render() {
    test.disabled = busy || !snapshot;
    activate.disabled = busy || (!testedForForm() && !canResume());
    disable.disabled = busy || snapshot?.effectiveMode !== "model";
    key.required = !usesSavedKey();
    key.placeholder = usesSavedKey() ? "密钥已保存，可留空" : "";
    if (snapshot) {
      const status = snapshot.effectiveMode === "model"
        ? `真实模型已启用 · ${snapshot.model || sourceLabel(snapshot.source)}` : "演示模式";
      const saved = snapshot.testedConfig || (snapshot.source === "web" && snapshot.apiKeyConfigured);
      const keyStatus = saved ? "已保存" : (snapshot.apiKeyConfigured ? "已配置" : "未配置");
      active.textContent = `${status} · 密钥${keyStatus}`;
    }
  }

  function applySnapshot(next) {
    snapshot = next;
    onConfig(next);
  }

  async function refresh() {
    const latest = await api.modelConfig();
    applySnapshot(latest);
    const saved = latest.testedConfig || latest;
    if (!base.value && saved.baseUrl) base.value = saved.baseUrl;
    if (!model.value && saved.model) model.value = saved.model;
  }

  async function perform(operation, waiting) {
    if (busy) return;
    busy = true;
    if (waiting) feedback.textContent = waiting;
    render();
    try {
      await operation();
    } catch (error) {
      feedback.textContent = error.category === "forbidden" && error.messageForChild
        ? error.messageForChild : failureText(error.category);
      if (error.category === "conflict" || error.category === "expired") {
        try { await refresh(); } catch { /* A later panel open can refresh. */ }
      }
    } finally {
      busy = false;
      render();
    }
  }

  for (const input of [base, model, key]) {
    input.addEventListener("input", () => {
      formVersion += 1;
      feedback.textContent = "";
      render();
    });
  }
  find("system-info-trigger").addEventListener("click", () => perform(async () => {
    await refresh();
    feedback.textContent = "";
  }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!snapshot || busy) return;
    const fields = { baseUrl: base.value, model: model.value, apiKey: key.value };
    if (!validateForm(fields, usesSavedKey()).ok) {
      feedback.textContent = failureText("invalid");
      return;
    }
    const version = formVersion;
    key.value = "";
    perform(async () => {
      try {
        const data = await api.testModel(toTestPayload(fields, snapshot.revision));
        if (version !== formVersion) return;
        applySnapshot({
          ...snapshot,
          apiKeyConfigured: true,
          testedConfig: { baseUrl: formBaseUrl(), model: data.model, testId: data.testId },
        });
        feedback.textContent = `连接测试通过 · ${data.model} · ${data.latencyMs} ms。密钥已保存，可以启用模型。`;
      } catch (error) {
        if (version === formVersion) {
          key.value = fields.apiKey;
          throw error;
        }
      }
    }, "正在测试连接…");
  });
  activate.addEventListener("click", () => {
    const testId = testedForForm()?.testId;
    if (!testId && !canResume()) return;
    perform(async () => {
      const next = await api.activateModel(toActivatePayload(testId, snapshot.revision));
      applySnapshot(next);
      feedback.textContent = "模型已启用并保存。运行一次积木后，可以请小老师看看。";
    }, "正在启用模型…");
  });
  disable.addEventListener("click", () => {
    if (!snapshot) return;
    perform(async () => {
      applySnapshot(await api.disableModel(toDisablePayload(snapshot.revision)));
      key.value = "";
      feedback.textContent = "课堂已切换为演示回复。已保存的模型配置可以再次启用。";
    }, "正在切换…");
  });
}
