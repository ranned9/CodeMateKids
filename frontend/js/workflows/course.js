/** 启动报告、课程装入与版本刷新。 */
import { API } from "../api.js";
import { captureContext, isCurrentContext } from "../core/viewContext.js";
import { renderStartup } from "../views/startup.js";

export function createCourseWorkflow({
  state, elements, confirmLeaveDirty, leaveRunContext, applyTask, renderAll, updateRunControls, toast,
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
    state.variantAvailable = Boolean(tasks.get("variant")?.enterable);
    if (target) {
      applyTask(target.taskId);
    } else {
      renderAll("content");
    }
    state.contentVersion = course.contentVersion || null;
    return Boolean(target);
  }

  function renderReport() {
    renderStartup(state.startup, elements, {
      courseUpdatePending: hasPendingCourse(),
      onRetry: refreshStartup,
      onEnter: () => {
        elements.banner.hidden = true;
      },
    });
  }

  async function reloadCourseForContent() {
    const ctx = captureContext(state);
    try {
      const course = await API.course();
      if (!isCurrentContext(state, ctx) || !(await confirmLeaveDirty()) || !isCurrentContext(state, ctx)) {
        return;
      }
      const revision = state.programRevision;
      const leaving = leaveRunContext("content");
      const nextContext = captureContext(state);
      await leaving;
      if (!isCurrentContext(state, nextContext) || revision !== state.programRevision) {
        return;
      }
      if (installCourse(course)) {
        toast("课程内容已更新，界面已同步。");
      } else {
        toast("课程内容已更新，但当前没有可运行的任务。", true);
      }
    } catch (error) {
      toast(error.messageForChild || "课程内容刷新失败。", true);
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
