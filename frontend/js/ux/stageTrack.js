export const STAGE_INSET = 24;
const STEP_WIDTH = 42;
const MAX_TRACK_SPAN = 24_000;
const MAX_TICK_INTERVALS = 120;

function validSteps(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** 刻度、目标旗和海龟共用累计步数坐标。过长的路线按同一比例缩小。 */
export function buildStageTrack({ targetSteps, actualSteps, displaySteps = actualSteps, viewportWidth = 0 } = {}) {
  const target = validSteps(targetSteps);
  const actual = validSteps(actualSteps);
  const displayed = validSteps(displaySteps);
  const extent = Math.max(1, target ?? 0, actual ?? 0, displayed ?? 0);
  const span = Math.min(extent * STEP_WIDTH, MAX_TRACK_SPAN);
  const position = (steps) => STAGE_INSET + (steps / extent) * span;
  const actorPosition = position(displayed ?? 0);
  // 终点右侧留出半个视口，使海龟走到最后一格时也能居中。
  const width = Math.ceil(Math.max(viewportWidth, position(extent) + Math.max(STAGE_INSET, viewportWidth / 2)));
  const overflowSteps = target == null || displayed == null ? 0 : Math.max(0, displayed - target);

  const tickCount = Math.min(MAX_TICK_INTERVALS, Math.max(1, Math.floor(span / STEP_WIDTH)));
  const stride = Math.ceil(extent / tickCount);
  const ticks = new Set([0, extent]);
  for (let step = stride; step < extent; step += stride) {
    ticks.add(step);
  }
  if (target != null) ticks.add(target);
  if (actual != null) ticks.add(actual);

  return {
    width,
    actorPosition,
    scrollLeft: Math.max(0, actorPosition - viewportWidth / 2),
    targetPosition: target == null ? null : position(target),
    ticks: [...ticks].sort((a, b) => a - b).map((value) => ({ value, position: position(value) })),
    overflowLabel: overflowSteps ? `超出目标 ${overflowSteps} 步` : "",
  };
}
