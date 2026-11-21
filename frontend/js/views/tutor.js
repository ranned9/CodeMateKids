/** 辅导区：异步归属、纯文本渲染与跳过去重。 */
import { API } from "../api.js";
import { createSkipRecorder } from "../core/asyncGuard.js";
import { captureLearningContext, isLearningContextCurrent } from "../core/viewContext.js";
import { buildProgram } from "../editor/model.js";
import { nextActionLabel } from "../ux/enums.js";
import { addSeenHint, buildLearningContext, createWorkspaceId, workspaceLearningScope } from "../ux/learningContext.js";
import { createReplayPlayer } from "../ux/replayPlayer.js";
import { failureText } from "../ux/modelConfigState.js";
import { appendDiv, appendErrorBox, appendParagraph, clearNode } from "../util/dom.js";

export const ACTION_LABEL = {
  ask_question: "提问",
  hint: "轻提示",
  point_to_block: "指向积木",
  show_execution: "看看执行过程",
  analogy: "换个说法",
  partial_example: "局部示例",
  break_down: "拆成小步骤",
  explain: "讲解",
  offer_variant: "换一个练习",
  stop_guidance: "自己试试",
  edit_block: "修改一处积木",
};

const EVIDENCE_LABEL = {
  answer: "你的预测",
  run_result: "运行结果",
  edit_trace: "修改过程",
  hint_usage: "用过的提示",
  transfer_task: "新任务表现",
  self_feedback: "你的自评",
};

export function createTutor({ elements, state, editor, toast, onChange, onLocate, actions = {}, onReplayFrame, onAnswer, api = API }) {
  let latestRequest = 0;
  let displayedReply = null;
  let pendingContext = null;
  const recordSkip = createSkipRecorder((taskId) => api.feedback(taskId, "skip"));

  function updateContext() {
    if (pendingContext && !isLearningContextCurrent(state, pendingContext)) {
      pendingContext = null;
      clearNode(elements.message);
      appendParagraph(elements.message, "积木或运行有更新。需要时，可以再请小老师看看。", "muted");
    }
    if (!displayedReply?.notice.isConnected) {
      return;
    }
    const { context, notice, control, finishReplay, hintId } = displayedReply;
    const stale = !isLearningContextCurrent(state, context);
    const visible = !elements.message.closest?.("[hidden]");
    notice.hidden = !stale;
    if (control) control.hidden = stale;
    if (stale || !visible) finishReplay?.();
    if (!stale && hintId && visible) {
      state.seenHintIds = addSeenHint(state.seenHintIds, hintId).seen;
    }
  }

  async function ask(choice, message = "", retry = null) {
    const ctx = captureLearningContext(state);
    const task = state.tasks.get(ctx.taskId);
    if (!task) {
      return;
    }
    if (pendingContext && isLearningContextCurrent(state, pendingContext)) {
      toast("小老师正在回答上一条，请稍等。");
      return;
    }
    if (["validating", "running", "cancelling"].includes(state.phase) && choice !== "skip") {
      toast("等这次运行结束，再请小老师一起看。");
      return;
    }
    const seq = ++latestRequest;
    const current = () => seq === latestRequest && isLearningContextCurrent(state, ctx);
    const runId = state.lastResultOwnership === "current" ? state.lastRunContext?.requestId : null;
    const blockId = state.lastResultOwnership === "current"
      ? state.errorBlockId || state.lastResult?.loopBlockId
      : null;
    const programSummary = editor.summary();
    const programValid = editor.state.invalidBlockIds.size === 0;
    const lastRunStatus = state.lastRunStatus;
    const shouldSkip = choice === "skip";
    const scope = workspaceLearningScope(state, ctx.taskId);
    const replyTo = choice === "none" && displayedReply?.awaitingAnswer && isLearningContextCurrent(state, displayedReply.context)
      ? displayedReply : null;
    const turn = retry || { id: createWorkspaceId("turn"), replyTo: replyTo?.turnId, question: replyTo?.question };
    const learningContext = scope ? buildLearningContext({
      scope, program: buildProgram(state.root, task), runRequestId: runId, seenHintIds: state.seenHintIds || [],
      turnId: turn.id, replyToTurnId: turn.replyTo,
    }) : undefined;

    displayedReply?.finishReplay?.();
    pendingContext = ctx;
    clearNode(elements.message);
    displayedReply = null;
    appendParagraph(elements.message, "小老师正在想一想…", "muted");
    try {
      const data = await api.hint({
        taskId: ctx.taskId,
        learnerChoice: choice,
        message,
        programSummary,
        programValid,
        lastRunStatus,
        ...(learningContext ? { learningContext } : {}),
      });
      if (shouldSkip) {
        await recordSkip(ctx.taskId);
        if (state.contentVersion === ctx.contentVersion) state.skippedTaskIds?.add(ctx.taskId);
      }
      if (!current()) {
        return;
      }
      pendingContext = null;
      renderReply(elements, data, state);
      if (turn.question && data.learning?.turnId) {
        appendDiv(elements.detail, `上一个问题：${turn.question}`, "muted");
      }
      const notice = appendDiv(elements.message, "这条提示参考了之前的积木或运行结果。", "muted");
      const payload = data.learning;
      let control = null;
      let finishReplay = null;
      const action = payload?.nextAction;
      if (payload?.awaitingAnswer) {
        control = addButton(elements.message, "回答小老师", () => {
          if (!current()) return;
          onAnswer?.();
          elements.input.focus();
        });
      } else if (action === "replay" && runId && payload.runRequestId === runId && current()) {
        const player = createReplayPlayer(state.lastResult?.learning?.replay);
        if (player.snapshot().state === "ready") {
          ({ control, finishReplay } = renderReplay(elements.message, player, current, onReplayFrame));
        }
      } else {
        const anchor = payload ? payload.anchorBlockId : blockId;
        const callback = anchor && onLocate ? () => onLocate(anchor) : actions[action];
        if (callback) {
          control = addButton(elements.message, anchor ? "看看这块积木" : nextActionLabel(action), () => {
            if (current()) callback({ choice, task });
          });
        }
      }
      displayedReply = {
        context: ctx, notice, control, finishReplay, hintId: data.answerLevel > 0 && scope ? data.requestId : null,
        awaitingAnswer: payload?.awaitingAnswer === true, turnId: payload?.turnId, question: data.message,
      };
      updateContext();
      if (shouldSkip) {
        toast("任务先留在这里，想回来时随时回来。");
      }
      onChange?.("hint");
    } catch (error) {
      if (!current()) {
        return;
      }
      pendingContext = null;
      clearNode(elements.message);
      appendErrorBox(
        elements.message,
        error.messageForChild || "小老师暂时没连上。",
        "可以先自己试试，或者重新点一次。",
      );
      if (error.code !== "RUN_ID_CONFLICT") {
        addButton(elements.message, "再试一次", () => {
          if (current()) ask(choice, message, turn);
        });
      }
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

  return { ask, updateContext };
}

function addButton(parent, label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-button";
  button.textContent = label;
  button.addEventListener("click", handler);
  parent.appendChild(button);
  return button;
}

export function renderReplay(parent, player, isCurrent, onFrame) {
  const control = appendDiv(parent, "", "tutor-replay");
  const steps = appendDiv(control, "", "tutor-replay-steps");
  steps.hidden = true;
  const text = appendParagraph(steps, "", "muted");
  text.setAttribute("role", "status");
  const previous = addButton(steps, "上一步", () => update(player.prev()));
  const next = addButton(steps, "下一步", () => update(player.next()));
  const finish = addButton(steps, "结束回放", () => {
    finishReplay();
    open.focus();
  });
  const open = addButton(control, "看看怎么走的", () => {
    if (!isCurrent()) return;
    steps.hidden = false;
    open.hidden = true;
    update(player.reset());
    next.focus();
  });
  function update(frame) {
    if (!isCurrent()) return;
    const action = frame.action;
    const round = action?.round ? `第 ${action.round} 轮，` : "";
    const motion = action?.kind === "motion.turn" ? `转弯 ${action.degrees}°` : `累计走了 ${action?.totalSteps} 步`;
    text.textContent = action ? `${round}${motion}。第 ${frame.index} 步，共展示 ${frame.total} 步。${frame.atEnd && frame.hasMore ? "后面还有动作。" : ""}` : "海龟在起点。";
    previous.disabled = frame.atStart;
    next.disabled = frame.atEnd;
    if (frame.atEnd && document.activeElement === next) finish.focus();
    if (frame.atStart && document.activeElement === previous) next.focus();
    onFrame?.(frame);
  }
  function finishReplay() {
    if (steps.hidden) return;
    steps.hidden = true;
    open.hidden = false;
    onFrame?.(null);
  }
  return { control, finishReplay };
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
  if (data.fallbackReason) {
    const category = data.fallbackReason.split(":").at(-1);
    const description = category === "configuration_changed" ? "模型设置已更新。"
      : category === "run_changed" ? "已有新的运行结果。" : failureText(category);
    appendParagraph(elements.message, `已使用演示回复。${description}`, "muted");
  }

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
    badge.textContent = data.mode === "model" ? "真实模型" : "演示回复";
    badge.hidden = false;
  }
}
