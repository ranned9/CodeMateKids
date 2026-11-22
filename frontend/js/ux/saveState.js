/** 保存四态：未保存 / 保存中 / 已保存 / 保存失败，保存期间的新修改不得被误标为已保存。 */

export const SAVE_LABELS = {
  dirty: "还没保存",
  saving: "正在保存…",
  clean: "已保存",
  failed: "保存没成功，再试一次",
};

export function deriveSaveState({
  dirty = false,
  saving = false,
  lastSavedRevision = null,
  programRevision = 0,
  lastError = null,
  draftSaved = false,
  draftFailed = false,
} = {}) {
  if (saving) {
    const pendingRevision = lastSavedRevision != null && programRevision !== lastSavedRevision;
    return {
      status: "saving",
      needsResave: Boolean(dirty || pendingRevision),
      label: SAVE_LABELS.saving,
    };
  }
  if (lastError) {
    return { status: "failed", needsResave: true, label: SAVE_LABELS.failed, reason: lastError };
  }
  if (draftSaved) {
    return { status: "clean", needsResave: false, label: "草稿已自动保存" };
  }
  if (draftFailed && dirty) {
    return { status: "failed", needsResave: true, label: "自动保存失败，可导出作品" };
  }
  if (dirty) {
    return { status: "dirty", needsResave: true, label: SAVE_LABELS.dirty };
  }
  return { status: "clean", needsResave: false, label: SAVE_LABELS.clean };
}

export function saveStateClass(status) {
  return {
    dirty: "warn",
    saving: "warn",
    clean: "ok",
    failed: "bad",
  }[status] || "";
}
