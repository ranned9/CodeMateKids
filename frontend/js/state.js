/** 全局前端状态与订阅。 */

export const state = {
  schema: null,
  blocksByKind: new Map(),
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
  lastRunContext: null,
  lastResultOwnership: null,
  workspaceId: null,
  studentId: null,
  predictionIds: new Map(),
  seenHintIds: [],
  learningRunRequestId: null,
  skippedTaskIds: new Set(),
  runIssue: "",
  lessonObservation: "",
  prediction: new Map(),
  predictionContext: new Map(),
  predictionPending: new Map(),
  saveStateSaving: false,
  saveError: null,
  draftSavedRevision: null,
  draftSaveFailed: false,
  lastSavedRevision: 0,
  readonly: false,
  mode: "mock",
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

export function setPhase(phase) {
  state.phase = phase;
  notify("phase");
}
