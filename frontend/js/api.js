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

let classroomStudent = null;

export function setClassroomStudent(studentId) {
  classroomStudent = studentId;
}

/** @param {string} path */
export async function getJson(path, studentId = null) {
  const headers = { Accept: "application/json" };
  if (studentId) headers["X-CMK-Student-Id"] = studentId;
  const response = await fetch(path, { headers });
  return unwrap(response);
}

/** @param {string} path @param {any} body */
export async function postJson(path, body, studentId = null, signal = null) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (studentId) headers["X-CMK-Student-Id"] = studentId;
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  return unwrap(response);
}

const SPEECH_TIMEOUT_MS = 12000;

function speechTimeout(signal) {
  const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** @param {string} path @param {any} body @param {string|null} studentId @param {AbortSignal|null} signal */
export function postSpeech(path, body, studentId = classroomStudent, signal = null) {
  return postJson(path, body, studentId, speechTimeout(signal));
}

/**
 * 合成请求双形态分流：audio/mpeg → Blob；application/json → unwrap 语义。
 * @param {string} turnId @param {object} scope @param {string|null} studentId @param {AbortSignal|null} signal
 * @returns {Promise<{playable:true,blob:Blob}|{playable:false,reasonCode:string}>}
 */
export async function fetchSpeechSynthesize(turnId, scope, studentId = classroomStudent, signal = null) {
  return fetchSpeechAudio("/api/v1/speech/synthesize", { turnId, scope }, studentId, signal);
}

async function fetchSpeechAudio(path, body, studentId, signal) {
  const headers = { "Content-Type": "application/json", Accept: "audio/mpeg, application/json" };
  if (studentId) headers["X-CMK-Student-Id"] = studentId;
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: speechTimeout(signal),
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (response.ok && contentType.startsWith("audio/")) {
    return {
      playable: true,
      blob: await response.blob(),
      hasMore: response.headers.get("X-CMK-Speech-More") === "1",
    };
  }
  return await unwrap(response);
}

export const API = {
  startup: () => getJson("/api/v1/startup/check"),
  startupRefresh: () => getJson("/api/v1/startup/check?refresh=true"),
  schema: () => getJson("/api/v1/blocks/schema"),
  course: (courseId = "demo-loop") => getJson(`/api/v1/course/${courseId}`),
  prediction: (taskId, value, learningContext) =>
    postJson("/api/v1/session/prediction", { taskId, value, learningContext }, classroomStudent),
  feedback: (taskId, kind, note = "") =>
    postJson("/api/v1/session/feedback", { taskId, kind, note }, classroomStudent),
  summary: () => getJson("/api/v1/session/summary", classroomStudent),
  submitRun: (payload, studentId = classroomStudent) => postJson("/api/v1/runs", payload, studentId),
  getRun: (requestId, studentId = classroomStudent) => getJson(`/api/v1/runs/${requestId}`, studentId),
  cancelRun: (requestId, cancelToken, studentId = classroomStudent) =>
    postJson(`/api/v1/runs/${requestId}/cancel`, { cancelToken }, studentId),
  stepRun: (requestId, cancelToken, seq, studentId = classroomStudent) =>
    postJson(`/api/v1/runs/${requestId}/step`, { cancelToken, seq }, studentId),
  hint: (payload) => postJson("/api/v1/tutor/hints", payload, classroomStudent),
  chat: (payload, studentId = classroomStudent) => postJson("/api/v1/tutor/chat", payload, studentId),
  speechRecognize: (audioBase64, signal = null, studentId = classroomStudent) =>
    postSpeech("/api/v1/speech/recognize", { audioBase64 }, studentId, signal),
  speechSynthesize: (turnId, scope, signal = null, studentId = classroomStudent) =>
    fetchSpeechSynthesize(turnId, scope, studentId, signal),
  speechTask: (taskId, contentVersion, part, signal, studentId = classroomStudent) =>
    fetchSpeechAudio("/api/v1/speech/task", { taskId, contentVersion, part }, studentId, signal),
  students: () => getJson("/api/v1/students"),
  createStudent: (displayName) => postJson("/api/v1/students", { displayName }),
  studentProgress: (studentId) => getJson(`/api/v1/students/${encodeURIComponent(studentId)}/progress`),
  modelConfig: () => getJson("/api/v1/tutor/model-config"),
  testModel: (payload) => postJson("/api/v1/tutor/model-config/test", payload),
  activateModel: (payload) => postJson("/api/v1/tutor/model-config/activate", payload),
  disableModel: (payload) => postJson("/api/v1/tutor/model-config/disable", payload),
  saveProject: (program, courseRef) =>
    postJson("/api/v1/projects/save", { program, courseRef }),
  loadProject: (fileText) => postJson("/api/v1/projects/load", { fileText }),
  matrix: () => getJson("/api/v1/matrix"),
};
