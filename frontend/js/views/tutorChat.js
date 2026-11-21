/** 工作区内连续对话，积木与回放操作绑定发送时的快照。 */
import { API } from "../api.js";
import { captureLearningContext, isLearningContextCurrent } from "../core/viewContext.js";
import { buildProgram } from "../editor/model.js";
import { addSeenHint, buildLearningContext, createWorkspaceId, workspaceLearningScope } from "../ux/learningContext.js";
import { createReplayPlayer } from "../ux/replayPlayer.js";
import { appendDiv, appendParagraph, clearNode } from "../util/dom.js";
import { ACTION_LABEL, renderReplay } from "./tutor.js";

export function createTutorChat({ elements, state, editor, onLocate, onReplayFrame, api = API }) {
  const { log, form, input, submit, selection } = elements;
  let activeScope = null;
  let welcome = log.firstElementChild;
  let pending = null;
  let awaiting = null;
  let pendingEdit = null;
  let turns = [];

  function sameWorkspace(snapshot) {
    return snapshot.studentId === (state.studentId ?? null) &&
      snapshot.workspaceId === state.workspaceId && snapshot.taskId === state.activeTaskId &&
      snapshot.contentVersion === state.contentVersion;
  }

  function updateContext() {
    if (!activeScope || !sameWorkspace(activeScope)) {
      for (const turn of turns) turn.finishReplay?.();
      activeScope = captureLearningContext(state);
      pending = null;
      awaiting = null;
      pendingEdit = null;
      turns = [];
      input.value = "";
      clearNode(log);
      welcome = appendParagraph(log, "有哪一步想一起看看？", "muted");
    }
    const kind = editor.layout?.nodes.find((node) => node.blockId === state.selectedBlockId)?.kind;
    const definition = state.blocksByKind.get(kind);
    selection.hidden = !definition;
    selection.textContent = definition ? `当前积木 · ${definition.label || definition.title || kind}` : "";
    submit.disabled = Boolean(pending) || !state.tasks.has(state.activeTaskId);
    const visible = !log.closest("[hidden]");
    for (const turn of turns) {
      const current = isLearningContextCurrent(state, turn.snapshot);
      if (turn.staleNotice) turn.staleNotice.hidden = current;
      if (turn.controls) turn.controls.hidden = !current;
      if (!visible || !current) turn.finishReplay?.();
      if (visible && turn.hintId && !turn.seen) {
        state.seenHintIds = addSeenHint(state.seenHintIds, turn.hintId).seen;
        turn.seen = true;
      }
    }
    explainRunAfterEdit();
  }

  function explainRunAfterEdit() {
    if (!pendingEdit) return;
    if (pendingEdit.programRevision !== state.programRevision) {
      pendingEdit = null;
      return;
    }
    const result = state.lastResult;
    if (result?.status !== "completed" || state.lastResultOwnership !== "current" ||
        state.lastRunContext?.requestId === pendingEdit.originalRunId ||
        state.lastRunContext?.programRevision !== pendingEdit.programRevision) return;

    const row = appendDiv(log, "", "tutor-turn");
    appendParagraph(row, describeEditedRun(result, pendingEdit.edit), "tutor-chat-reply");
    pendingEdit = null;
    scrollToLatest();
  }

  async function submitTurn(turn) {
    pending = turn;
    clearNode(turn.answer);
    appendParagraph(turn.answer, "小老师正在想…", "tutor-chat-meta");
    updateContext();
    scrollToLatest();
    try {
      const reply = await api.chat(turn.payload, turn.snapshot.studentId);
      if (!sameWorkspace(turn.snapshot) || pending !== turn) return;

      clearNode(turn.answer);
      const isCurrent = () => sameWorkspace(turn.snapshot) && isLearningContextCurrent(state, turn.snapshot);
      if (reply.edit) {
        if (!isCurrent() || turn.payload.selectedBlockId !== state.selectedBlockId ||
            !editor.applyTeachingEdit(reply.edit)) {
          appendParagraph(turn.answer, "这次还没有改动积木。等当前操作结束后，可以再请我看看。", "tutor-chat-reply");
          awaiting = null;
          return;
        }
        pendingEdit = {
          edit: reply.edit, programRevision: state.programRevision, originalRunId: turn.snapshot.runRequestId,
        };
        turn.snapshot = captureLearningContext(state);
        if (reply.hintId) {
          state.seenHintIds = addSeenHint(state.seenHintIds, reply.hintId).seen;
          turn.seen = true;
        }
      }
      appendParagraph(turn.answer, reply.message, "tutor-chat-reply");
      if (!reply.edit) {
        turn.staleNotice = appendParagraph(turn.answer, "这条回复参考了之前的积木或运行。", "tutor-chat-meta");
      }
      turn.hintId = reply.hintId;
      awaiting = reply.awaitingAnswer ? reply.turnId : null;
      if (reply.mode !== "model" && !reply.edit) {
        appendParagraph(turn.answer, "本地教学回复", "tutor-chat-meta");
      }
      if (reply.memorySaved === false) {
        appendParagraph(turn.answer, "学习进度暂时无法保存。", "tutor-chat-meta");
      }
      if (reply.controls?.length && isCurrent()) {
        turn.controls = appendDiv(turn.answer, "", "tutor-chat-tools");
        for (const control of reply.controls) {
          if (control.type === "locate_block") {
            addButton(turn.controls, "看看这块积木", () => {
              if (isCurrent()) onLocate?.(control.blockId);
            });
          } else if (control.type === "replay" && control.runRequestId === turn.runId) {
            const player = createReplayPlayer(state.lastResult?.learning?.replay);
            if (player.snapshot().state === "ready") {
              ({ finishReplay: turn.finishReplay } = renderReplay(turn.controls, player, isCurrent, onReplayFrame));
            }
          }
        }
      }
      appendReplyDetails(turn.answer, reply);
    } catch (error) {
      if (!sameWorkspace(turn.snapshot) || pending !== turn) return;
      clearNode(turn.answer);
      appendParagraph(turn.answer, error.messageForChild || "这条消息暂时没发出去。", "tutor-chat-meta");
      const conflict = error.code === "TUTOR_TURN_CONFLICT";
      addButton(turn.answer, conflict ? "重新提问" : "再试一次", () => {
        if (!pending && sameWorkspace(turn.snapshot)) {
          if (!conflict && isLearningContextCurrent(state, turn.snapshot)) {
            submitTurn(turn);
          } else {
            input.value ||= turn.payload.message;
            input.focus();
          }
        }
      });
    } finally {
      if (pending === turn) {
        pending = null;
        updateContext();
        scrollToLatest();
      }
    }
  }

  function scrollToLatest() {
    log.scrollTop = log.scrollHeight;
  }

  function send(event) {
    event.preventDefault();
    const message = input.value.trim();
    if (pending || !message) return;

    const snapshot = captureLearningContext(state);
    const task = state.tasks.get(snapshot.taskId);
    const scope = workspaceLearningScope(state, snapshot.taskId);
    if (!task || !scope) return;
    const runId = state.lastResultOwnership === "current" ? state.lastRunContext?.requestId : null;
    const learningContext = buildLearningContext({
      scope, program: buildProgram(state.root, task), runRequestId: runId,
      predictionId: state.predictionIds?.get(snapshot.taskId), seenHintIds: state.seenHintIds,
      workspaceSource: state.artifactSource, turnId: createWorkspaceId("turn"), replyToTurnId: awaiting,
    });

    for (const turn of turns) turn.finishReplay?.();
    welcome?.remove();
    welcome = null;
    const row = appendDiv(log, "", "tutor-turn");
    appendParagraph(row, message, "tutor-chat-student");
    const turn = {
      snapshot, runId, answer: appendDiv(row, "", "tutor-turn"),
      payload: { taskId: snapshot.taskId, message, selectedBlockId: state.selectedBlockId, learningContext },
    };
    turns.push(turn);
    input.value = "";
    submitTurn(turn);
  }

  form.addEventListener("submit", send);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  return { updateContext, focus() {
    input.focus();
    scrollToLatest();
  } };
}

export function describeEditedRun(result, edit) {
  const stage = result.objects?.find((object) => object.id === "stage");
  const { steps, moves, heading } = stage || {};
  const observations = [];
  if (Number.isInteger(steps) && Number.isInteger(moves)) {
    observations.push(`调整后，海龟前进了 ${moves} 次，一共走了 ${steps} 步。`);
  }
  if (edit.field === "degrees" && Number.isInteger(heading)) {
    observations.push(`海龟最后朝向 ${heading}°。`);
  }
  const change = edit.field === "times" && Number.isInteger(edit.previousMoves) && Number.isInteger(moves)
    ? { after: moves, before: edit.previousMoves, label: "前进", unit: "次" }
    : edit.field === "steps" && Number.isInteger(edit.previousSteps) && Number.isInteger(steps)
      ? { after: steps, before: edit.previousSteps, label: "走", unit: "步" }
      : null;
  if (change && change.after !== change.before) {
    const delta = change.after - change.before;
    observations.push(`和改前相比，海龟${delta > 0 ? "多" : "少"}${change.label}了 ${Math.abs(delta)} ${change.unit}。`);
  }
  observations.push(result.success === true ? "这次达到任务目标了。" : "这次还没达到任务目标。");
  return observations.join("");
}

function appendReplyDetails(parent, reply) {
  const action = ACTION_LABEL[reply.action];
  if (!action) return;
  const details = document.createElement("details");
  details.className = "tutor-chat-meta";
  const summary = document.createElement("summary");
  summary.textContent = "回复详情";
  details.appendChild(summary);
  appendParagraph(details, reply.supportLevel ? `${action} · 提示级别 ${reply.supportLevel}` : action);
  if (reply.fallbackReason && reply.fallbackReason !== "unconfigured") {
    appendParagraph(details, "模型暂时无法完成这次回答。");
  }
  parent.appendChild(details);
}

function addButton(parent, label, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-button";
  button.textContent = label;
  button.addEventListener("click", callback);
  parent.appendChild(button);
}
