/** 运行控制：门禁、重入保护、SSE 归属、停止与离开运行上下文。 */
import { buildProgram, programWorkspace, validateTree } from "../editor/model.js";
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
import { captureContext, isContextActive, nextPageVersion } from "../core/viewContext.js";
import { renderResult, resetObjectView, updateObjectView } from "./result.js";
import { setPhase } from "../state.js";

const POLL_INTERVAL_MS = 200;
const POLL_ATTEMPTS = 25;

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function createRunner({ elements, state, editor, toast, refresh, resetToTask }) {
  let streamText = "";
  let source = null;
  let lastStdoutSeq = 0;
  let recoveringRequestId = null;
  const session = createRunSession();

  function gateReason() {
    return evaluateRunGate({
      state,
      taskId: state.activeTaskId,
      root: state.root,
      validate: () => validateTree(state.root),
    }).reason;
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
    const canStop = session.phase === "running" || session.phase === "cancelling" || session.phase === "abandoned";
    elements.stop.disabled = !canStop || (recoveringRequestId !== null && recoveringRequestId === session.requestId);
    elements.hint.textContent = state.runRecovery || reason || "准备好了，点运行试试。";
    elements.hint.className = reason ? "hint-text bad" : "hint-text ok";
    elements.stateChip.textContent = busy ? phaseLabel() : phaseLabel();
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
    const requestId = `run-${crypto.randomUUID().slice(0, 12)}`;
    const cancelToken = crypto.randomUUID().replaceAll("-", "");
    const acceptedInfo = { requestId, cancelToken, taskId: ctx.taskId, pageVersion: ctx.pageVersion };
    const streamContext = { ...ctx, requestId };

    state.lastRunStatus = null;
    state.errorBlockId = null;
    state.runRecovery = null;
    editor.state.errorBlockId = null;
    editor.cancelDrag?.("running");
    setPhase("validating");
    updateControls();
    streamText = "";
    lastStdoutSeq = 0;

    try {
      await window.__cmkApi.submitRun({
        protocolVersion: 1,
        requestId,
        cancelToken,
        target: { language: "python", version: "3.12" },
        program: buildProgram(state.root, task),
        courseRef: { courseId: "demo-loop", version: 1, taskId: task.taskId },
        taskId: task.taskId,
        mode: "demo",
      });
    } catch (error) {
      if (session.disposed) {
        release(session);
        state.runRecovery = null;
        updateControls();
        return;
      }
      release(session);
      setPhase("error");
      state.lastResult = {
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
      state.errorBlockId = error.blockId ?? null;
      if (error.code === "RUN_IN_PROGRESS") {
        state.runRecovery = "上一次还没停下来，可以稍后再试。";
      }
      editor.state.errorBlockId = state.errorBlockId;
      editor.render();
      renderResult(elements.result, state, task, state.lastResult, { onRetry: run });
      toast(error.messageForChild || "运行没有开始。");
      updateControls();
      refresh();
      return;
    }

    markAccepted(session, acceptedInfo);
    state.runRequestId = requestId;
    state.cancelToken = cancelToken;

    if (session.disposed || session.phase === "abandoned" || ctx.pageVersion !== (state.pageVersion || 0)) {
      await cancelAccepted(requestId, cancelToken);
      const snapshot = await waitForTerminal(requestId, 10, 100);
      if (snapshot) {
        state.runRecovery = null;
        release(session);
      } else {
        state.runRecovery = "上一次还没停下来，可以再点停止。";
        session.phase = "cancelling";
      }
      updateControls();
      return;
    }

    state.lastResult = null;
    setPhase("running");
    updateControls();
    openStream(streamContext, task, requestId, cancelToken);
  }

  function openStream(ctx, task, requestId, cancelToken) {
    closeStream();
    const eventSource = new EventSource(`/api/v1/runs/${requestId}/events`);
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
      const exists = JSON.stringify(editor.state.root || "").includes(data.blockId);
      if (!exists) {
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
      if (!data) {
        return;
      }
      closeStream();
      state.runningBlockId = null;
      editor.state.runningBlockId = null;
      state.lastResult = data;
      state.lastRunStatus = data.status;
      state.errorBlockId = data.error?.blockId || null;
      state.runRecovery = null;
      editor.state.errorBlockId = state.errorBlockId;
      setPhase(data.status !== "completed" ? "error" : "result");
      editor.render();
      updateObjectView(elements.objectView, data.objects || []);
      renderResult(elements.result, state, task, data, { onRetry: run });
      if (data.success) {
        if (task.type === "main") {
          state.mainCompletedHint = true;
        }
        toast(task.type === "variant" ? "变式也完成啦，去看看小总结吧。" : "这次做到了！");
      } else if (data.status === "completed") {
        toast("运行完成，和目标比一比。");
      } else {
        toast("程序没有跑完，看看结果区的建议。");
      }
      release(session);
      updateControls();
      refresh();
      if (data.success && task.type === "variant") {
        refresh("variant-completed");
      }
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
    const ctx = captureContext(state, session.taskId);
    recoveringRequestId = requestId;
    session.phase = "cancelling";
    updateControls();
    try {
      await cancelAccepted(requestId, cancelToken);
      const snapshot = await waitForTerminal(requestId, 10, 100);
      if (session.requestId !== requestId || !isContextActive(state, ctx, session)) {
        return;
      }
      if (snapshot) {
        state.runRecovery = null;
        state.lastRunStatus = snapshot.status;
        state.runningBlockId = null;
        editor.state.runningBlockId = null;
        release(session);
        setPhase("error");
        editor.render();
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
      await window.__cmkApi.cancelRun(requestId, cancelToken);
    } catch {
      // 停止响应可能丢失，是否结束以随后查询的运行摘要为准。
    }
  }

  async function waitForTerminal(requestId, attempts = POLL_ATTEMPTS, interval = POLL_INTERVAL_MS) {
    for (let index = 0; index < attempts; index += 1) {
      try {
        const snapshot = await window.__cmkApi.getRun(requestId);
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
    if (!eventSource && !session.disposed) {
      await recoverDisconnectedRun(requestId, cancelToken);
      return;
    }
    enterCancelling(session);
    updateControls();
    try {
      await window.__cmkApi.cancelRun(requestId, cancelToken);
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
      await cancelAccepted(requestId, session.cancelToken);
      const snapshot = await waitForTerminal(requestId);
      if (snapshot) {
        state.runRecovery = null;
        release(session);
      } else {
        state.runRecovery = "上一次还没停下来，可以再点停止。";
        session.phase = "cancelling";
      }
    } else if (session.phase === "validating" || session.phase === "abandoned") {
      state.runRecovery = "正在等待提交结果，稍后再试。";
      session.phase = "abandoned";
    } else {
      release(session);
    }
    updateControls();
    return { stopped: !isBusy(session), reason };
  }

  async function reset() {
    const task = state.tasks.get(state.activeTaskId);
    if (!task) {
      return;
    }
    if (state.dirty && !window.confirm("丢弃还没保存的修改，恢复这个任务的初始程序？")) {
      return;
    }
    await leaveRunContext({ reason: "reset" });
    if (isBusy(session)) {
      toast("上一次运行还没有停下来，稍后再试。");
      return;
    }
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
