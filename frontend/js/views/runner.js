/** 运行控制：门禁、重入保护、SSE 归属、停止与离开运行上下文。 */
import { API } from "../api.js";
import { buildProgram, cloneTree, findBlock, programWorkspace } from "../editor/model.js";
import { evaluateRunGate } from "../core/runGate.js";
import {
  createRunSession,
  enterCancelling,
  isBusy,
  markAccepted,
  markDisposed,
  release,
  tryBegin,
} from "../core/runSession.js";
import { captureContext, isContextActive, isCurrentContext, nextPageVersion } from "../core/viewContext.js";
import { classifyResult, createRunViewContext, programFingerprint } from "../ux/runContext.js";
import { renderResult, resetObjectView, updateObjectView } from "./result.js";
import { prepareWorkspaceChange } from "../workflows/workspace-change.js";
import { LOOP_OBSERVATION, repeatedMoveInLoop } from "../ux/loopEvidence.js";
import { predictionSourceFor } from "../ux/prediction.js";
import { buildLearningContext, workspaceLearningScope } from "../ux/learningContext.js";

const POLL_INTERVAL_MS = 200;
const POLL_ATTEMPTS = 25;

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function createRunner({
  elements, state, editor, toast, refresh, resetToTask, getResultActions = () => ({}),
  api = API, onPhaseChange = () => {},
}) {
  let streamText = "";
  let source = null;
  let lastStdoutSeq = 0;
  let recoveringRequestId = null;
  let terminalRequest = null;
  let currentRun = null;
  const session = createRunSession();

  function setPhase(phase) {
    state.phase = phase;
    onPhaseChange();
  }

  function gateReason() {
    return evaluateRunGate({ state }).reason;
  }

  function phaseLabel() {
    return {
      validating: "正在提交",
      running: "运行中",
      cancelling: "正在停止",
      abandoned: "正在离开",
      result: "运行完成",
      error: "需要修改",
    }[state.phase] || "准备中";
  }

  function updateControls() {
    const busy = isBusy(session);
    const reason = state.runRecovery || gateReason();
    elements.run.disabled = busy || Boolean(reason);
    const canStop = isBusy(session) && !(
      session.phase === "validating" && session.cancelOnAccept
    );
    elements.stop.disabled = !canStop || (recoveringRequestId !== null && recoveringRequestId === session.requestId);
    elements.hint.textContent = state.runRecovery || reason || "准备好了，点运行试试。";
    elements.hint.className = reason ? "hint-text bad" : "hint-text ok";
    elements.stateChip.textContent = phaseLabel();
    elements.stateChip.className = `status-chip${
      busy ? " warn" : state.phase === "result" ? " ok" : state.phase === "error" ? " bad" : ""
    }`;
  }

  async function run() {
    if (!tryBegin(session)) {
      toast("正在运行，先等这一轮结束。");
      return;
    }
    const ctx = captureContext(state, state.activeTaskId);
    const reason = gateReason();
    if (reason) {
      release(session);
      toast(reason);
      updateControls();
      return;
    }
    const task = state.tasks.get(ctx.taskId);
    const studentId = state.studentId ?? null;
    const requestId = `run-${crypto.randomUUID().slice(0, 12)}`;
    const cancelToken = crypto.randomUUID().replaceAll("-", "");
    const acceptedInfo = { requestId, cancelToken, taskId: ctx.taskId, pageVersion: ctx.pageVersion };
    const streamContext = { ...ctx, requestId, studentId };
    const root = cloneTree(state.root);
    const program = buildProgram(root, task);
    const learningScope = workspaceLearningScope(state, task.taskId);
    const learningContext = learningScope ? buildLearningContext({
      scope: learningScope,
      predictionId: state.predictionIds?.get(task.taskId),
      seenHintIds: state.seenHintIds || [],
      workspaceSource: state.artifactSource,
    }) : undefined;
    const runContext = createRunViewContext({
      requestId,
      taskId: ctx.taskId,
      pageVersion: ctx.pageVersion,
      programRevision: state.programRevision,
      predictionValue: state.prediction.get(ctx.taskId) ?? null,
      predictionSource: predictionSourceFor(state, ctx.taskId),
      fingerprint: programFingerprint(root),
    });
    currentRun = { context: runContext, task, studentId };
    state.learningRunRequestId = requestId;

    state.lastRunStatus = null;
    state.runIssue = "";
    state.errorBlockId = null;
    state.runningBlockId = null;
    state.runRecovery = null;
    editor.state.errorBlockId = null;
    editor.state.runningBlockId = null;
    editor.cancelDrag?.("running");
    setPhase("validating");
    updateControls();
    streamText = "";
    lastStdoutSeq = 0;

    try {
      await api.submitRun({
        protocolVersion: 1,
        requestId,
        cancelToken,
        target: { language: "python", version: "3.12" },
        program,
        courseRef: program.courseRef,
        taskId: task.taskId,
        mode: "demo",
        ...(learningContext ? { learningContext } : {}),
      }, studentId);
    } catch (error) {
      if (session.disposed || !isContextActive(state, ctx)) {
        finishAbandonedRun();
        updateControls();
        return;
      }
      const rejection = {
        status: "failed",
        success: false,
        error: {
          code: error.code,
          category: error.category,
          messageForChild: error.messageForChild,
          blockId: error.blockId,
          recoverable: error.recoverable,
        },
        stdout: "",
        objects: [],
        truncated: false,
      };
      release(session);
      state.runIssue = error.messageForChild || "运行没有开始，可以再试一次。";
      state.errorBlockId = error.blockId ?? null;
      editor.state.errorBlockId = state.errorBlockId;
      setPhase("error");
      if (!state.lastResult) {
        showResult(task, rejection, runContext);
      }
      toast(state.runIssue);
      updateControls();
      refresh();
      return;
    }

    markAccepted(session, acceptedInfo);

    if (session.disposed || session.phase === "abandoned" || ctx.pageVersion !== (state.pageVersion || 0)) {
      const snapshot = await cancelAndWait(requestId, cancelToken);
      if (session.requestId !== requestId) return;
      if (snapshot) {
        finishAbandonedRun();
      } else {
        state.runRecovery = "上一次还没停下来，可以再点停止。";
        session.phase = "cancelling";
      }
      updateControls();
      return;
    }

    if (elements.liveOutput) {
      elements.liveOutput.hidden = true;
      elements.liveOutput.textContent = "";
    }
    setPhase("running");
    updateControls();
    openStream(streamContext, task, requestId, cancelToken, runContext, root);
    if (session.cancelOnAccept) {
      await stop();
    }
  }

  function showResult(task, data, runContext) {
    state.lastResult = data;
    state.lastRunContext = runContext;
    state.lastResultOwnership = classifyResult({ state, record: runContext });
    if (elements.objectView) {
      updateObjectView(elements.objectView, data.objects || [], task, data.learning);
    }
    renderResult(elements.result, state, task, data, getResultActions());
  }

  function openStream(ctx, task, requestId, cancelToken, runContext, root) {
    closeStream();
    const owner = ctx.studentId ? `?studentId=${encodeURIComponent(ctx.studentId)}` : "";
    const eventSource = new EventSource(`/api/v1/runs/${requestId}/events${owner}`);
    source = eventSource;

    const active = () => {
      if (source !== eventSource || !isContextActive(state, ctx, session)) {
        return false;
      }
      return session.requestId === requestId;
    };

    eventSource.addEventListener("started", () => {
      if (!active()) {
        return;
      }
      toast("开始运行啦。");
    });

    eventSource.addEventListener("event", (message) => {
      if (!active()) {
        return;
      }
      const data = parse(message.data);
      if (!data || !data.blockId) {
        return;
      }
      if (!findBlock(editor.state.root, data.blockId)) {
        return;
      }
      state.runningBlockId = data.kind === "block_exit" ? null : data.blockId;
      editor.state.runningBlockId = state.runningBlockId;
      editor.render();
    });

    eventSource.addEventListener("stdout", (message) => {
      if (!active()) {
        return;
      }
      const data = parse(message.data);
      if (!data || Number(data.seq) <= lastStdoutSeq) {
        return;
      }
      lastStdoutSeq = Number(data.seq);
      streamText += data.text || "";
      elements.liveOutput.hidden = false;
      elements.liveOutput.textContent = streamText;
    });

    eventSource.addEventListener("result", (message) => {
      if (!active()) {
        return;
      }
      const data = parse(message.data);
      if (!data || data.requestId !== requestId) {
        return;
      }
      closeStream();
      release(session);
      state.runningBlockId = null;
      editor.state.runningBlockId = null;
      state.lastRunStatus = data.status;
      state.errorBlockId = data.error?.blockId || null;
      state.runRecovery = null;
      const loopBlockId = repeatedMoveInLoop(root, data);
      const stage = data.objects?.find((item) => item.id === "stage");
      if (loopBlockId) {
        state.lessonObservation = `${task.title} · ${LOOP_OBSERVATION}`;
      } else if (data.status === "completed" && Number.isFinite(stage?.steps)) {
        state.lessonObservation = `${task.title} · 这次角色累计走了 ${stage.steps} 步。`;
      }
      showResult(task, { ...data, loopBlockId }, runContext);
      editor.state.errorBlockId = state.errorBlockId;
      setPhase(data.status !== "completed" ? "error" : "result");
      if (data.success) {
        if (task.type === "main") {
          state.mainCompletedHint = true;
        }
        toast("这次做到了！");
      } else if (data.status === "completed") {
        toast("运行完成，和目标比一比。");
      } else {
        toast("程序没有跑完，看看结果区的建议。");
      }
      if (data.memorySaved === false) {
        toast("这次运行已结束，学习进度暂未保存。", true);
      }
      updateControls();
      refresh();
    });

    eventSource.onerror = async () => {
      if (!active()) {
        return;
      }
      closeStream();
      toast("运行连接中断了，正在检查运行状态。");
      await recoverDisconnectedRun(requestId, cancelToken);
    };
  }

  async function recoverDisconnectedRun(requestId, cancelToken) {
    if (recoveringRequestId === requestId) {
      return;
    }
    const ctx = captureContext(state);
    recoveringRequestId = requestId;
    session.phase = "cancelling";
    updateControls();
    try {
      const snapshot = await cancelAndWait(requestId, cancelToken, 10, 100);
      if (session.requestId !== requestId || !isCurrentContext(state, ctx)) {
        return;
      }
      if (snapshot) {
        if (session.disposed) {
          finishAbandonedRun();
          toast("上一次运行已结束，可以继续。");
          return;
        }
        state.runRecovery = null;
        state.lastRunStatus = snapshot.status;
        state.runningBlockId = null;
        editor.state.runningBlockId = null;
        release(session);
        if (currentRun?.context.requestId === requestId) {
          showResult(currentRun.task, {
            status: snapshot.status,
            error: { messageForChild: "连接中断了，这轮没有收到完整结果。" },
          }, currentRun.context);
        }
        setPhase("error");
        toast("运行连接中断了，可以再试一次。");
      } else {
        state.runRecovery = "上一次还没停下来，可以再点停止。";
        toast(state.runRecovery);
      }
    } finally {
      if (recoveringRequestId === requestId) {
        recoveringRequestId = null;
      }
      updateControls();
    }
  }

  function closeStream() {
    if (source) {
      source.close();
      source = null;
    }
  }

  async function cancelAccepted(requestId, cancelToken) {
    try {
      await api.cancelRun(requestId, cancelToken, currentRun?.studentId);
    } catch {
      // 停止响应可能丢失，是否结束以随后查询的运行摘要为准。
    }
  }

  async function waitForTerminal(requestId, attempts = POLL_ATTEMPTS, interval = POLL_INTERVAL_MS) {
    for (let index = 0; index < attempts; index += 1) {
      try {
        const snapshot = await api.getRun(requestId, currentRun?.studentId);
        if (snapshot.finished) {
          return snapshot;
        }
      } catch (error) {
        if (error.code === "RUN_NOT_FOUND") {
          return { finished: true, status: "crashed" };
        }
      }
      await sleep(interval);
    }
    return null;
  }

  function cancelAndWait(requestId, cancelToken, attempts, interval) {
    if (terminalRequest?.requestId === requestId) return terminalRequest.promise;
    const request = { requestId };
    request.promise = cancelAccepted(requestId, cancelToken)
      .then(() => waitForTerminal(requestId, attempts, interval))
      .finally(() => {
        if (terminalRequest === request) terminalRequest = null;
      });
    terminalRequest = request;
    return request.promise;
  }

  function finishAbandonedRun() {
    release(session);
    state.runRecovery = null;
    state.runningBlockId = null;
    editor.state.runningBlockId = null;
    setPhase("editing");
  }

  async function stop() {
    if (!session.requestId) {
      if (session.phase === "validating") {
        enterCancelling(session);
        toast("正在提交，马上停止。");
        updateControls();
      }
      return;
    }
    const { requestId, cancelToken } = session;
    const eventSource = source;
    if (!eventSource) {
      await recoverDisconnectedRun(requestId, cancelToken);
      return;
    }
    enterCancelling(session);
    updateControls();
    try {
      await api.cancelRun(requestId, cancelToken, currentRun?.studentId);
      if (session.requestId === requestId && source === eventSource) {
        state.runRecovery = null;
        toast("正在停止…");
      }
    } catch (error) {
      if (session.requestId === requestId && source === eventSource) {
        state.runRecovery = "上一次还没停下来，可以再点停止。";
        toast(error.messageForChild || "停止没有成功。");
      }
    } finally {
      updateControls();
    }
  }

  async function leaveRunContext({ reason = "leave" } = {}) {
    nextPageVersion(state);
    if (!isBusy(session)) {
      closeStream();
      return { stopped: true, reason };
    }
    markDisposed(session);
    closeStream();

    if (session.phase === "validating") {
      const deadline = Date.now() + 1500;
      while (session.phase === "validating" && Date.now() < deadline) {
        await sleep(50);
      }
    }

    const requestId = session.requestId;
    if (requestId) {
      const snapshot = await cancelAndWait(requestId, session.cancelToken);
      if (session.requestId === requestId) {
        if (snapshot) {
          finishAbandonedRun();
        } else {
          state.runRecovery = "上一次还没停下来，可以再点停止。";
          session.phase = "cancelling";
        }
      }
    } else if (session.phase === "validating" || session.phase === "abandoned") {
      state.runRecovery = "正在等待提交结果，稍后再试。";
      session.phase = "abandoned";
    }
    updateControls();
    return { stopped: !isBusy(session), reason };
  }

  async function reset() {
    const task = state.tasks.get(state.activeTaskId);
    if (!task) {
      return;
    }
    const outcome = await prepareWorkspaceChange({
      state,
      reason: "reset",
      confirm: () => !state.dirty || window.confirm("丢弃还没保存的修改，恢复这个任务的初始程序？"),
      leaveRunContext: (reason) => leaveRunContext({ reason }),
    });
    if (outcome === "run-pending") {
      toast("上一次运行还没有停下来，稍后再试。");
    }
    if (outcome !== "ready") return;
    if (resetToTask) {
      resetToTask(task.taskId);
    } else {
      editor.setProgram(programWorkspace(task.initialProgram));
      resetObjectView(elements.objectView);
      setPhase("editing");
    }
    updateControls();
    refresh();
  }

  elements.run.addEventListener("click", run);
  elements.stop.addEventListener("click", stop);
  elements.reset.addEventListener("click", reset);

  return {
    run,
    stop,
    reset,
    updateControls,
    leaveRunContext,
    closeStream,
    isBusy: () => isBusy(session),
    getSession: () => ({ ...session }),
  };
}

function parse(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}
