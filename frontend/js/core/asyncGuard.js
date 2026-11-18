/** 辅导请求序号与跳过请求去重。 */

let currentSeq = 0;
let lastAcceptedSeq = 0;
const skipSubmitted = new Set();

export function nextSeq() {
  currentSeq += 1;
  return currentSeq;
}

export function accept(seq) {
  if (seq < lastAcceptedSeq) {
    return false;
  }
  lastAcceptedSeq = seq;
  return true;
}

export function markSkipSubmitted(taskId) {
  if (skipSubmitted.has(taskId)) {
    return false;
  }
  skipSubmitted.add(taskId);
  if (skipSubmitted.size > 20) {
    const first = skipSubmitted.values().next().value;
    skipSubmitted.delete(first);
  }
  return true;
}

export function wasSkipSubmitted(taskId) {
  return skipSubmitted.has(taskId);
}

export function resetAsyncGuard() {
  currentSeq = 0;
  lastAcceptedSeq = 0;
  skipSubmitted.clear();
}