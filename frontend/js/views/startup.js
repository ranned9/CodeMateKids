/** 启动页与模式标识：逐项门禁、版本来源与故障分支。 */

const STATUS_TEXT = {
  ready: "课堂准备好啦",
  degraded: "部分功能可以先用",
  fatal: "运行环境需要调整",
};

export function renderStartup(data, elements, callbacks) {
  const banner = elements.banner;
  const title = elements.title;
  const checks = elements.checks;
  const pythonChip = elements.pythonChip;
  const versionChip = elements.versionChip;
  const modeChip = elements.modeChip;
  const retry = elements.retry;
  const enter = elements.enter;

  const entered = banner.classList?.contains("entered") ? " entered" : "";
  const pending = callbacks.courseUpdatePending ? " update-pending" : "";
  banner.className = `startup-banner ${data.status === "ready" ? "" : data.status}${entered}${pending}`;
  title.textContent = STATUS_TEXT[data.status] || "启动检查完成";

  checks.innerHTML = "";
  for (const check of data.checks || []) {
    const item = document.createElement("li");
    item.className = check.status;
    item.textContent = `${labelFor(check.name)}：${statusLabel(check.status)}`;
    item.title = check.detailForChild;
    checks.appendChild(item);
  }

  if (data.python?.source === "worker_probe") {
    pythonChip.textContent = `Python ${data.python.major}.${data.python.minor}.${data.python.patch}（工作进程实测）`;
    pythonChip.className = "status-chip ok";
  } else {
    pythonChip.textContent = "Python 版本未读到";
    pythonChip.className = "status-chip bad";
  }
  const elapsedLabel = data.cached ? "上次检查" : "本次检查";
  versionChip.textContent = `课程 v${data.courseVersion} · schema ${data.schemaVersion} · ${elapsedLabel} ${data.elapsedMs}ms`;
  versionChip.className = "status-chip ok";

  const isMock = data.tutorMode === "mock";
  modeChip.textContent = isMock ? "辅导模式：演示回复" : "辅导模式：真实模型";
  modeChip.className = "status-chip mode-chip";

  if (elements.modeBadge) {
    elements.modeBadge.textContent = isMock ? "演示回复" : "真实模型";
  }

  retry.hidden = data.status === "ready" && !callbacks.courseUpdatePending;
  enter.hidden = data.status !== "ready" || Boolean(callbacks.courseUpdatePending);
  retry.onclick = () => callbacks.onRetry();
  enter.onclick = () => callbacks.onEnter();

  if (data.status === "fatal") {
    title.textContent = "需要先调整运行环境";
  } else if (callbacks.courseUpdatePending) {
    title.textContent = "课程等待载入";
  } else if (data.runCapability?.canRun === false && data.runCapability.reasonForChild) {
    title.textContent = data.runCapability.reasonForChild;
  }
  return data.status;
}

function labelFor(name) {
  return {
    os: "系统",
    python: "Python",
    worker: "运行小助手",
    schema: "积木清单",
    course: "课程内容",
  }[name] || name;
}

function statusLabel(status) {
  return {
    passed: "通过",
    warn: "注意",
    failed: "未通过",
  }[status] || status;
}

export function updateModeBadge(mode) {
  const badge = document.getElementById("tutor-mode-badge");
  if (badge) {
    badge.textContent = mode === "mock" ? "演示回复" : "真实模型";
  }
}
