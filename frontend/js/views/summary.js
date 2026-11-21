/** 学习总结：三段（完成/观察/挑战）+ 本次会话明细，不出现分数、排名或等级。 */
import { API } from "../api.js";
import { buildSummarySections } from "../ux/summarySections.js";
import { appendParagraph, clearNode } from "../util/dom.js";

let requestSequence = 0;

export async function showSummary({ panel, content, state, callbacks, api = API }) {
  if (!panel || !content) {
    return;
  }
  if (!panel.open) {
    panel.showModal();
  }
  const request = ++requestSequence;
  clearNode(content);
  appendParagraph(content, "正在整理这次的学习记录…", "muted");
  let data;
  try {
    data = await api.summary();
  } catch (error) {
    if (!panel.open || request !== requestSequence) {
      return;
    }
    clearNode(content);
    appendParagraph(content, "这次还没有整理出小结，可以先继续练习。", "muted");
    return;
  }

  if (!panel.open || request !== requestSequence) {
    return;
  }
  clearNode(content);
  const sections = buildSummarySections(data, { observation: state.lessonObservation });
  for (const section of sections) {
    const card = document.createElement("div");
    card.className = "summary-section";
    card.setAttribute("data-summary-section", section.key);
    const title = document.createElement("h3");
    title.textContent = section.title;
    const text = document.createElement("p");
    text.textContent = section.text;
    card.appendChild(title);
    card.appendChild(text);
    content.appendChild(card);
  }

  const grid = document.createElement("dl");
  grid.className = "summary-grid";
  appendRow(grid, "这节课在练", (data.concepts || []).join("；") || "循环");
  appendRow(grid, "完成的任务", (data.completedTasks || []).join("、") || "这次还没有完成的任务");
  appendRow(grid, "能独立做到的事", (data.independentThings || []).join("、") || "这次还没有独立完成的记录");
  appendRow(grid, "还要再看看", (data.toVerify || []).join("；") || "还需要更多观察");
  appendRow(grid, "下一步", data.nextStep || "再试一次主任务");
  if (data.skippedTasks?.length) {
    appendRow(grid, "先跳过的任务", data.skippedTasks.join("、"));
  }
  if (data.missing?.length) {
    appendRow(grid, "这次没观察到的", data.missing.join("；"));
  }
  const details = document.createElement("details");
  const disclosure = document.createElement("summary");
  disclosure.textContent = "看看本次练习记录";
  details.append(disclosure, grid);
  content.appendChild(details);

  const note = document.createElement("p");
  note.className = "summary-note";
  note.textContent = data.note || "仅代表本次会话观察，不代表长期能力结论。";
  content.appendChild(note);

  const variantButton = document.getElementById("summary-variant");
  const variantId = [...state.tasks.values()].find((task) => task.type === "main")?.variantTaskId || "variant";
  const nextTask = state.tasks.get(data.nextTaskId || variantId);
  if (variantButton) {
    variantButton.disabled = !nextTask?.enterable;
    variantButton.textContent = nextTask?.enterable ? `去练习 · ${nextTask.title}` : "这节课的加练还没准备好";
  }
  const skippedButton = document.getElementById("summary-skipped");
  if (skippedButton) {
    skippedButton.onclick = () => {
      const skipped = data.skippedTasks || [];
      callbacks.onShowSkipped?.(skipped);
    };
  }
  if (variantButton) {
    variantButton.onclick = () => callbacks.onVariant?.(nextTask?.taskId);
  }
  const finishButton = document.getElementById("summary-finish");
  if (finishButton) {
    finishButton.onclick = () => callbacks.onFinish?.();
  }
}

function appendRow(grid, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  grid.appendChild(dt);
  grid.appendChild(dd);
}
