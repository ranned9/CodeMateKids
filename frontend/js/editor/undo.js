/** 事务式撤销/重做：一次拖动只提交一个事务，栈深 50。 */

export class History {
  constructor(onRestore) {
    this.onRestore = onRestore;
    this.undoStack = [];
    this.redoStack = [];
    this.maxDepth = 50;
  }

  snapshot() {
    return this.onRestore.snapshot();
  }

  record(type, before, after) {
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return;
    }
    this.undoStack.push({ type, before, after });
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) {
      return false;
    }
    this.redoStack.push(entry);
    this.onRestore.restore(entry.before, false);
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) {
      return false;
    }
    this.undoStack.push(entry);
    this.onRestore.restore(entry.after, false);
    return true;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  truncateTo(undoDepth, redoDepth) {
    this.undoStack = this.undoStack.slice(0, Math.max(0, undoDepth));
    this.redoStack = this.redoStack.slice(0, Math.max(0, redoDepth));
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}