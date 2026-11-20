/** 系统信息：一次看全五项结论、耗时、缓存、Python 来源、课程与 schema 版本、辅导模式。 */

const CHECK_LABELS = {
  os: "系统",
  python: "Python",
  worker: "运行小助手",
  schema: "积木清单",
  course: "课程内容",
};

const STATUS_LABELS = {
  passed: "通过",
  warn: "注意",
  failed: "未通过",
};

function line(parent, label, value) {
  const row = document.createElement("div");
  row.className = "system-info-row";
  const name = document.createElement("span");
  name.className = "system-info-label";
  name.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value;
  row.appendChild(name);
  row.appendChild(content);
  parent.appendChild(row);
  return content;
}

export function buildSystemInfoModel(startup) {
  if (!startup) {
    return { ready: false, title: "正在检查", checks: [], lines: [] };
  }
  const checks = (startup.checks || []).map((check) => ({
    name: CHECK_LABELS[check.name] || check.name,
    status: check.status,
    label: STATUS_LABELS[check.status] || check.status,
    detail: check.detailForChild || "",
  }));
  const python = startup.python;
  let pythonText = "未读到";
  if (python && python.major != null) {
    const source = python.source === "worker_probe" ? "工作进程实测" : "其他来源";
    pythonText = `${python.major}.${python.minor}.${python.patch}（${source}）`;
  }
  const elapsed = startup.cached ? "上次检查" : "本次检查";
  const lines = [
    { label: "Python 版本", value: pythonText },
    { label: "课程版本", value: String(startup.courseVersion ?? "未读到") },
    { label: "积木清单版本", value: String(startup.schemaVersion ?? "未读到") },
    { label: "辅导模式", value: startup.tutorMode === "mock" ? "演示回复" : "真实模型" },
    { label: "检查耗时", value: `${elapsed} ${startup.elapsedMs ?? 0}ms` },
  ];
  return { ready: true, title: startup.status === "ready" ? "全部检查通过" : "有需要留意的地方", checks, lines };
}

export function renderSystemInfo(container, startup) {
  if (!container) {
    return;
  }
  container.textContent = "";
  const model = buildSystemInfoModel(startup);
  const title = document.createElement("p");
  title.className = "system-info-title";
  title.textContent = model.title;
  container.appendChild(title);
  const list = document.createElement("ul");
  list.className = "startup-checks";
  for (const check of model.checks) {
    const item = document.createElement("li");
    item.className = check.status;
    item.textContent = `${check.name}：${check.label}`;
    item.title = check.detail;
    list.appendChild(item);
  }
  container.appendChild(list);
  for (const item of model.lines) {
    line(container, item.label, item.value);
  }
}