/** 辅导区：异步归属、纯文本渲染与跳过去重。 */
import { accept, markSkipSubmitted, nextSeq } from "../core/asyncGuard.js";
import { captureContext, isCurrentContext } from "../core/viewContext.js";
import { appendDiv, appendErrorBox, appendParagraph, clearNode } from "../util/dom.js";

const ACTION_LABEL = {
  ask_question: "提问",
  hint: "轻提示",
  point_to_block: "指向积木",
  show_execution: "看看执行过程",
  analogy: "换个说法",
  partial_example: "局部示例",
  break_down: "拆成小步骤",
  explain: "讲解",
  offer_variant: "换一个练习",
};

const EVIDENCE_LABEL = {
  answer: "你的预测",
  run_result: "运行结果",
  edit_trace: "修改过程",
  hint_usage: "用过的提示",
  transfer_task: "新任务表现",
  self_feedback: "你的自评",
};

export function createTutor({ elements, state, editor, toast, onChange }) {
  async function ask(choice, message = "") {
    const ctx = captureContext(state, state.activeTaskId);
    const seq = nextSeq();
    const task = state.tasks.get(ctx.taskId);
    if (!task) {
      return;
    }
    const programSummary = editor.summary();
    const programValid = editor.state.invalidBlockIds.size === 0;
    const lastRunStatus = state.lastRunStatus;
    const shouldSkip = choice === "skip" && markSkipSubmitted(ctx.taskId);

    clearNode(elements.message);
    appendParagraph(elements.message, "小老师正在想一想…", "muted");
    try {
      const data = await window.__cmkApi.hint({
        taskId: ctx.taskId,
        learnerChoice: choice,
        message,
        programSummary,
        programValid,
        lastRunStatus,
      });
      if (shouldSkip) {
        await window.__cmkApi.feedback(ctx.taskId, "skip");
      }
      if (!accept(seq) || !isCurrentContext(state, ctx)) {
        return;
      }
      renderReply(elements, data, state);
      if (shouldSkip) {
        toast("任务先留在这里，想回来时随时回来。");
      }
      onChange?.("hint");
    } catch (error) {
      if (!isCurrentContext(state, ctx)) {
        return;
      }
      clearNode(elements.message);
      appendErrorBox(
        elements.message,
        error.messageForChild || "小老师暂时没连上。",
        "可以先自己试试，或者重新点一次。",
      );
    }
  }

  for (const button of elements.buttons) {
    button.addEventListener("click", () => {
      ask(button.dataset.choice || "hint");
    });
  }
  elements.submit.addEventListener("click", () => {
    const text = elements.input.value.trim();
    if (!text) {
      toast("可以先写一句想问的话。");
      return;
    }
    ask("none", text);
    elements.input.value = "";
  });

  return { ask };
}

function renderReply(elements, data, state) {
  const level = Number(data.answerLevel || 0);
  state.highestHint = Math.max(0, Number(state.highestHint || 0), level);

  clearNode(elements.message);
  const levelText = level > 0 ? ` · 第 ${level} 级` : " · 这次没有追加提示";
  appendParagraph(
    elements.message,
    `小老师的动作：${ACTION_LABEL[data.action] || data.action}${levelText}`,
    "tutor-action",
  );
  appendParagraph(elements.message, data.message);
  appendParagraph(elements.message, `下一步：${data.nextStep}`, "tutor-next");

  const detail = elements.detail;
  clearNode(detail);
  const evidence = (data.evidenceUsed || []).map((item) => EVIDENCE_LABEL[item] || item).join("、");
  if (evidence) {
    appendDiv(detail, `依据：${evidence}`, "muted");
  }
  if (data.uncertainty) {
    appendDiv(detail, `还不确定：${data.uncertainty}`, "muted");
  }
  if (data.showAsDemo || data.mode === "mock") {
    appendDiv(detail, "当前是演示回复，不是真实模型输出。", "muted");
  }
  if (data.fallbackReason) {
    appendDiv(detail, "这次使用了预置回复继续学习。", "muted");
  }

  const badge = document.getElementById("tutor-mode-badge");
  if (badge) {
    badge.textContent = data.mode === "mock" ? "演示回复" : "真实模型";
  }
}