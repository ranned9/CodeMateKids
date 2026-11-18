/**
 * 统一 API 解包入口：全站只通过这里访问后端。
 * @typedef {{code:string, category:string, messageForChild:string, blockId:(string|null), recoverable:boolean}} ApiErrorShape
 */

export class ApiClientError extends Error {
  /**
   * @param {ApiErrorShape} error
   */
  constructor(error) {
    super(error.messageForChild || "请求没有成功");
    this.name = "ApiClientError";
    this.code = error.code;
    this.category = error.category;
    this.blockId = error.blockId ?? null;
    this.recoverable = Boolean(error.recoverable);
    this.messageForChild = error.messageForChild || "请求没有成功";
  }
}

/**
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function unwrap(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ApiClientError({
      code: "NETWORK_ERROR",
      category: "network",
      messageForChild: "连接小老师的服务器时出了点问题。",
      blockId: null,
      recoverable: true,
    });
  }
  if (!payload || typeof payload !== "object") {
    throw new ApiClientError({
      code: "BAD_RESPONSE",
      category: "network",
      messageForChild: "收到的回复不太对。",
      blockId: null,
      recoverable: true,
    });
  }
  if (payload.ok === true) {
    return payload.data;
  }
  const error = payload.error || {};
  throw new ApiClientError({
    code: error.code || "UNKNOWN",
    category: error.category || "unknown",
    messageForChild: error.messageForChild || "这里遇到一点小问题。",
    blockId: error.blockId ?? null,
    recoverable: error.recoverable !== false,
  });
}

/** @param {string} path */
export async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  return unwrap(response);
}

/** @param {string} path @param {any} body */
export async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return unwrap(response);
}

export const API = {
  startup: () => getJson("/api/v1/startup/check"),
  startupRefresh: () => getJson("/api/v1/startup/check?refresh=true"),
  schema: () => getJson("/api/v1/blocks/schema"),
  course: (courseId = "demo-loop") => getJson(`/api/v1/course/${courseId}`),
  prediction: (taskId, value) => postJson("/api/v1/session/prediction", { taskId, value }),
  feedback: (taskId, kind, note = "") =>
    postJson("/api/v1/session/feedback", { taskId, kind, note }),
  summary: () => getJson("/api/v1/session/summary"),
  submitRun: (payload) => postJson("/api/v1/runs", payload),
  getRun: (requestId) => getJson(`/api/v1/runs/${requestId}`),
  cancelRun: (requestId, cancelToken) =>
    postJson(`/api/v1/runs/${requestId}/cancel`, { cancelToken }),
  hint: (payload) => postJson("/api/v1/tutor/hints", payload),
  saveProject: (program, courseRef) =>
    postJson("/api/v1/projects/save", { program, courseRef }),
  loadProject: (fileText) => postJson("/api/v1/projects/load", { fileText }),
  matrix: () => getJson("/api/v1/matrix"),
};