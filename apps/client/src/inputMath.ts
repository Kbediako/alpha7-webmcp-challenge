import {
  circleIntersectsCollisionRect,
  resolveTankCollisionMovement
} from "@alpha7/shared";

export interface Vector2Like {
  x: number;
  y: number;
}

export interface CenteredRectLike extends Vector2Like {
  width: number;
  height: number;
}

export interface AimStickIntent {
  active: boolean;
  direction: Vector2Like;
  knob: Vector2Like;
}

export const normalizeVector = (x: number, y: number): Vector2Like => {
  const length = Math.hypot(x, y);
  if (length <= 1) return { x, y };
  return { x: x / length, y: y / length };
};

export const movementStickIntent = (
  x: number,
  y: number,
  maxRadius: number,
  deadzoneRadius: number
): Vector2Like => {
  const length = Math.hypot(x, y);
  const safeMax = Math.max(1, maxRadius);
  const safeDeadzone = Math.min(Math.max(0, deadzoneRadius), safeMax - 1);
  if (length <= safeDeadzone) return { x: 0, y: 0 };

  const magnitude = Math.min(1, (length - safeDeadzone) / (safeMax - safeDeadzone));
  return { x: (x / length) * magnitude, y: (y / length) * magnitude };
};

export const aimStickIntent = (
  x: number,
  y: number,
  maxRadius: number,
  deadzoneRadius: number
): AimStickIntent => {
  const length = Math.hypot(x, y);
  const safeMax = Math.max(1, maxRadius);
  const knobScale = length > safeMax ? safeMax / length : 1;

  return {
    active: length >= Math.max(0, deadzoneRadius),
    direction: length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 },
    knob: { x: x * knobScale, y: y * knobScale }
  };
};

export const circleIntersectsCenteredRect = (
  x: number,
  y: number,
  radius: number,
  rect: CenteredRectLike
): boolean => {
  return circleIntersectsCollisionRect({ x, y }, radius, rect, "center");
};

export const resolvePredictedMovement = (
  current: Vector2Like,
  desired: Vector2Like,
  radius: number,
  width: number,
  height: number,
  walls: readonly CenteredRectLike[]
): Vector2Like => resolveTankCollisionMovement({
  current,
  desired,
  radius,
  bounds: { minX: 0, minY: 0, maxX: width, maxY: height },
  obstacles: walls,
  obstacleOrigin: "center"
});

export const frameRateIndependentLerp = (amountAt60Fps: number, deltaMs: number): number =>
  1 - Math.pow(1 - Math.min(Math.max(amountAt60Fps, 0), 1), Math.max(deltaMs, 0) / (1000 / 60));

export const normalizeAngle = (angle: number): number =>
  Math.atan2(Math.sin(angle), Math.cos(angle));

export const lerpAngle = (from: number, to: number, amount: number): number =>
  normalizeAngle(from + normalizeAngle(to - from) * Math.min(Math.max(amount, 0), 1));

export const stepCameraOrbit = (
  angle: number,
  pendingDelta: number,
  amount: number
): { angle: number; pendingDelta: number } => {
  const appliedDelta = pendingDelta * Math.min(Math.max(amount, 0), 1);
  return {
    angle: normalizeAngle(angle + appliedDelta),
    pendingDelta: pendingDelta - appliedDelta
  };
};

export const movementIsSettling = (
  input: Vector2Like,
  localVelocity: Vector2Like,
  serverVelocity: Vector2Like
): boolean =>
  Math.hypot(input.x, input.y) >= 0.04 ||
  Math.hypot(localVelocity.x, localVelocity.y) >= 0.5 ||
  Math.hypot(serverVelocity.x, serverVelocity.y) >= 0.5;

export const shouldHoldIdlePose = (
  input: Vector2Like,
  localVelocity: Vector2Like,
  serverVelocity: Vector2Like,
  drift: number,
  deadband: number
): boolean =>
  !movementIsSettling(input, localVelocity, serverVelocity) &&
  drift <= deadband;

export const shouldHoldActivePosition = (
  input: Vector2Like,
  drift: number,
  deadband: number
): boolean => Math.hypot(input.x, input.y) >= 0.04 && drift <= deadband;

export const shouldKeepResolvedProjectile = (
  resolvedAt: number,
  now: number,
  isStillActive: boolean
): boolean => isStillActive || now - resolvedAt < 1_000;

export const lightningFlashAlpha = (
  seconds: number,
  cycleSeconds: number,
  phase: number
): number => {
  const cycle = Math.max(1, cycleSeconds);
  const elapsed = ((((seconds / cycle + phase) % 1) + 1) % 1) * cycle;
  const firstPulse = Math.max(0, 1 - Math.abs(elapsed - 0.04) / 0.045);
  const secondPulse = Math.max(0, 1 - Math.abs(elapsed - 0.19) / 0.07) * 0.72;
  const afterglow = elapsed < 0.05 || elapsed > 0.48 ? 0 : (1 - (elapsed - 0.05) / 0.43) * 0.22;
  return Math.min(1, Math.max(firstPulse, secondPulse, afterglow));
};

export const controlMoveToWorldMove = (
  moveX: number,
  moveY: number,
  cameraOrbitAngle: number
): Vector2Like => {
  const length = Math.hypot(moveX, moveY);
  if (length < 0.04) return { x: 0, y: 0 };

  const cos = Math.cos(cameraOrbitAngle);
  const sin = Math.sin(cameraOrbitAngle);
  return normalizeVector(moveX * cos + moveY * sin, -moveX * sin + moveY * cos);
};
