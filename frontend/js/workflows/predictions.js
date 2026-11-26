import { API } from "../api.js";
import { captureContext, isCurrentContext } from "../core/viewContext.js";
import { buildProgram } from "../editor/model.js";
import { buildLearningContext, workspaceLearningScope } from "../ux/learningContext.js";
import { renderPrediction } from "../views/course.js";

/** 提交由任务负责，表单回写由当前工作区负责。 */
export function createPredictionWorkflow({ state, elements, isRunning, onChange, toast, api = API }) {
  function render(options) {
    renderPrediction(state, elements, options);
  }

  function showError(message) {
    elements.feedback.textContent = message;
    elements.feedback.className = "hint-text bad";
  }

  async function submit() {
    const ctx = captureContext(state);
    const taskId = ctx.taskId;
    if (!state.tasks.get(taskId)?.enterable || state.readonly || isRunning()) {
      return;
    }
    if (state.predictionPending.has(taskId)) {
      toast("正在记下这个猜想，稍等一下。");
      return;
    }

    const raw = elements.input.value.trim();
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < 0 || value > 1000) {
      showError("请填一个 0 到 1000 之间的整数。");
      elements.input.focus();
      return;
    }

    const contentVersion = state.contentVersion;
    const studentId = state.studentId;
    const scope = workspaceLearningScope(state, taskId);
    const learningContext = scope ? buildLearningContext({ scope, program: buildProgram(state.root, state.tasks.get(taskId)) }) : undefined;
    const record = {
      ...ctx,
      programRevision: state.programRevision,
      source: state.prediction.has(taskId) ? "reguess" : "initial",
    };
    const courseId = state.course?.course?.courseId;
    const belongsToCourse = () => state.contentVersion === contentVersion && state.studentId === studentId
      && state.course?.course?.courseId === courseId;
    state.predictionPending.set(taskId, record);
    render();
    onChange();

    let failure = "";
    try {
      const ack = await api.prediction(taskId, value, learningContext);
      if (belongsToCourse()) {
        state.prediction.set(taskId, ack?.value ?? value);
        state.predictionContext.set(taskId, record);
        if (ack?.predictionId && state.workspaceId === scope?.workspaceId) {
          state.predictionIds.set(taskId, ack.predictionId);
        }
      }
    } catch (error) {
      failure = error.messageForChild || "预测没有记下来，可以再试一次。";
    } finally {
      if (state.predictionPending.get(taskId) === record) {
        state.predictionPending.delete(taskId);
      }
      if (belongsToCourse() && taskId === state.activeTaskId) {
        const showFailure = belongsToCourse() && isCurrentContext(state, ctx) && Boolean(failure);
        render({ preserveInput: showFailure });
        if (showFailure) showError(failure);
        onChange();
      }
    }
  }

  elements.submit.addEventListener("click", submit);
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  return { render };
}
