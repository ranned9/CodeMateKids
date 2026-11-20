/** 预测生命周期：提交单飞、失败保留旧值、再猜与沿用来源。 */

export function predictionSourceFor(state, taskId) {
  const recorded = state.predictionContext?.get(taskId);
  if (!recorded) {
    return "initial";
  }
  if (recorded.pageVersion !== state.pageVersion || recorded.programRevision !== state.programRevision) {
    return "carried";
  }
  return recorded.source;
}

export function createPredictionStore() {
  const records = new Map();

  function recordFor(taskId) {
    if (!records.has(taskId)) {
      records.set(taskId, {
        confirmedValue: null,
        pendingValue: null,
        pending: false,
        source: null,
        error: null,
      });
    }
    return records.get(taskId);
  }

  function valueOf(taskId) {
    return recordFor(taskId).confirmedValue;
  }

  function begin(taskId, value, source = "initial") {
    const record = recordFor(taskId);
    if (record.pending) {
      return { accepted: false, reason: "pending" };
    }
    record.pending = true;
    record.pendingValue = value;
    record.error = null;
    record.source = source;
    return { accepted: true, record: { ...record } };
  }

  function confirm(taskId, value) {
    const record = recordFor(taskId);
    if (!record.pending) {
      return { accepted: false, reason: "not-pending" };
    }
    record.confirmedValue = value;
    record.pendingValue = null;
    record.pending = false;
    record.source = record.source || "initial";
    return { accepted: true, value, source: record.source };
  }

  function fail(taskId, error) {
    const record = recordFor(taskId);
    if (!record.pending) {
      return { accepted: false, reason: "not-pending" };
    }
    record.pending = false;
    record.pendingValue = null;
    record.error = error;
    return { accepted: true };
  }

  function reguess(taskId, value) {
    const record = recordFor(taskId);
    record.confirmedValue = value;
    record.source = "reguess";
    record.error = null;
    return { accepted: true, value, source: "reguess" };
  }

  function carryForward(taskId) {
    const record = recordFor(taskId);
    if (record.confirmedValue == null) {
      return { accepted: false, reason: "empty" };
    }
    record.source = "carried";
    return { accepted: true, value: record.confirmedValue, source: "carried" };
  }

  function clear(taskId) {
    records.delete(taskId);
  }

  function isPending(taskId) {
    return recordFor(taskId).pending;
  }

  function snapshot(taskId) {
    return { ...recordFor(taskId) };
  }

  return { valueOf, begin, confirm, fail, reguess, carryForward, clear, isPending, snapshot };
}
