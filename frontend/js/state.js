/** 全局前端状态与订阅。 */

export const state = {
  schema: null,
  blocksByKind: new Map(),
  portRules: {},
  rejectedKinds: [],
  startup: null,
  course: null,
  tasks: new Map(),
  activeTaskId: "main",
  root: null,
  dirty: false,
  programRevision: 0,
  phase: "idle",
  selectedBlockId: null,
  runningBlockId: null,
  errorBlockId: null,
  invalidBlockIds: new Set(),
  lastResult: null,
  lastRunStatus: null,
  prediction: new Map(),
  readonly: false,
  mode: "mock",
  runRequestId: null,
  cancelToken: null,
  eventSource: null,
  highestHint: 0,
  savedSnapshot: null,
  pageVersion: 0,
  artifactTaskId: null,
  artifactSource: "task",
  contentVersion: null,
  runRecovery: null,
  readonlyReason: "",
  skippedTasks: [],
  variantAvailable: false,
};

let listener = null;

/** @param {(reason:string)=>void} fn */
export function subscribe(fn) {
  listener = fn;
}

/** @param {string} reason */
export function notify(reason) {
  if (listener) {
    listener(reason);
  }
}

export function getDefinition(kind) {
  return state.blocksByKind.get(kind) || null;
}

export function getActiveTask() {
  return state.tasks.get(state.activeTaskId) || null;
}

export function setPhase(phase) {
  state.phase = phase;
  notify("phase");
}

export function currentPrediction(taskId = state.activeTaskId) {
  return state.prediction.get(taskId) ?? null;
}

export function markDirty() {
  state.dirty = true;
}
