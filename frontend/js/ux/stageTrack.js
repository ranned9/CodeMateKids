/** 舞台目标刻度：按目标步数计算角色比例与溢出提示，缺目标时降级为普通舞台。 */

export function buildStageTrack({ targetSteps = null, actualSteps = null } = {}) {
  const hasTarget = Number.isFinite(targetSteps) && targetSteps > 0;
  const hasActual = Number.isFinite(actualSteps);
  const ratio = hasTarget && hasActual ? Math.min(1, actualSteps / targetSteps) : null;
  let overflowSteps = 0;
  if (hasTarget && hasActual && actualSteps > targetSteps) {
    overflowSteps = actualSteps - targetSteps;
  }
  return {
    hasTarget,
    hasActual,
    targetSteps: hasTarget ? targetSteps : null,
    actualSteps: hasActual ? actualSteps : null,
    ratio,
    overflowSteps,
    label: hasTarget ? `目标 ${targetSteps} 步` : "",
    overflowLabel: overflowSteps > 0 ? `超出目标 ${overflowSteps} 步` : "",
  };
}

export function actorPercent(track, fallback = 8) {
  if (!track || track.ratio == null) {
    return fallback;
  }
  return Math.min(82, fallback + track.ratio * 74);
}

export function stageTicks(target) {
  if (!Number.isInteger(target) || target <= 0) {
    return [];
  }
  const stride = Math.ceil(target / 8);
  const steps = [0];
  for (let step = stride; step < target; step += stride) {
    steps.push(step);
  }
  steps.push(target);
  return steps.map((value) => ({ value, percent: actorPercent({ ratio: value / target }) }));
}
