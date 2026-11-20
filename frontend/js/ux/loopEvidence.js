import { runnableRoots } from "../editor/model.js";

export function repeatedMoveInLoop(root, result) {
  if (result?.status !== "completed" || !Array.isArray(result.events)) {
    return null;
  }

  const candidates = new Set();
  function collect(node, insideLoop) {
    for (let block = node; block; block = block.next) {
      if (insideLoop && block.kind === "motion.move") {
        candidates.add(block.blockId);
      }
      for (const child of block.body || []) {
        collect(child, insideLoop || block.kind === "control.repeat");
      }
    }
  }
  for (const entry of runnableRoots(root)) {
    collect(entry, false);
  }

  const entered = new Set();
  const observed = new Set();
  let lastSeq = -1;
  for (const { seq, blockId, kind } of result.events) {
    if (!Number.isInteger(seq) || seq <= lastSeq) {
      continue;
    }
    lastSeq = seq;
    if (!candidates.has(blockId)) {
      continue;
    }
    if (kind === "block_enter") {
      entered.add(blockId);
    } else if (kind === "block_exit" && entered.delete(blockId)) {
      if (observed.has(blockId)) {
        return blockId;
      }
      observed.add(blockId);
    }
  }
  return null;
}

export const LOOP_OBSERVATION = "这块放在重复里的前进积木，至少执行了两次。";
