/** 启动报告、课程装入与版本刷新。 */
import { API } from "../api.js";
import { captureContext, isCurrentContext } from "../core/viewContext.js";
import { renderStartup } from "../views/startup.js";
import { prepareWorkspaceChange } from "./workspace-change.js";

export function createCourseWorkflow({
  state, elements, confirmLeaveDirty, leaveRunContext, applyTask, renderAll, updateRunControls, toast,
  onEnterClassroom = null,
}) {
  function hasPendingCourse() {
    const version = state.startup?.contentVersion;
    return !state.course || Boolean(version && version !== state.contentVersion);
  }

  function installCourse(course) {
    const tasks = new Map(course.tasks.map((task) => [task.taskId, task]));
    const current = tasks.get(state.activeTaskId);
    const target = current?.enterable ? current : course.tasks.find((task) => task.enterable);
    state.course = course;
    state.tasks = tasks;
    if (state.contentVersion !== course.contentVersion) {
      state.prediction?.clear();
      state.predictionContext?.clear();
      state.skippedTaskIds?.clear();
      state.lessonObservation = "";
    }
    state.contentVersion = course.contentVersion || null;
    const main = course.tasks.find((task) => task.type === "main");
    state.variantAvailable = Boolean(tasks.get(main?.variantTaskId || "variant")?.enterable);
    if (target) {
      applyTask(target.taskId);
    } else {
      renderAll("content");
    }
    return Boolean(target);
  }

  function renderReport() {
    const courseUpdatePending = hasPendingCourse();
    const enterClassroom = () => {
      if (onEnterClassroom) {
        onEnterClassroom();
      } else {
        elements.banner.hidden = true;
      }
    };
    renderStartup(state.startup, elements, {
      courseUpdatePending,
      onRetry: refreshStartup,
      onEnter: enterClassroom,
    });
    if (state.startup.status === "ready" && !courseUpdatePending && state.tasks.get(state.activeTaskId)?.enterable) {
      enterClassroom();
    }
  }

  async function reloadCourseForContent() {
    const ctx = captureContext(state);
    try {
      const course = await API.course();
      const outcome = await prepareWorkspaceChange({
        state, context: ctx, reason: "content", confirm: confirmLeaveDirty, leaveRunContext,
      });
      if (outcome !== "ready") {
        if (outcome === "run-pending") {
          toast("上一次运行还没有停下来，可以稍后再刷新课程。", true);
        }
        return;
      }
      if (installCourse(course)) {
        toast("课程内容已更新，界面已同步。");
      } else {
        toast("课程内容已更新，但当前没有可运行的任务。", true);
      }
    } catch (error) {
      if (isCurrentContext(state, ctx)) {
        toast(error.messageForChild || "课程内容刷新失败。", true);
      }
    }
  }

  async function refreshStartup() {
    const retry = elements.retry;
    if (retry.disabled) {
      return;
    }
    retry.disabled = true;
    try {
      const data = await API.startupRefresh();
      state.startup = data;
      state.mode = data.tutorMode;
      if (hasPendingCourse()) {
        await reloadCourseForContent();
      }
    } catch (error) {
      toast(error.messageForChild || "重新检查没有成功。", true);
    } finally {
      if (state.startup) {
        renderReport();
      }
      retry.disabled = false;
      updateRunControls();
    }
  }

  return { installCourse, renderReport };
}
