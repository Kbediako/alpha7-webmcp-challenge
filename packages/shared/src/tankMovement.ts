import type { TankHandlingConfig } from "./constants.js";

export interface TankMovementState {
  x: number;
  y: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
}

export interface TankMovementInput {
  moveX: number;
  moveY: number;
}

export interface TankMovementStepOptions {
  state: TankMovementState;
  input: TankMovementInput;
  deltaSeconds: number;
  maxSpeed: number;
  handling: TankHandlingConfig;
  speedMultiplier?: number;
  deadZone?: number;
}

export interface TankMovementStep {
  x: number;
  y: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  forwardSpeed: number;
  targetForwardSpeed: number;
  isReversing: boolean;
  inputMagnitude: number;
}

export interface TankCollisionPoint {
  x: number;
  y: number;
}

export interface TankCollisionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TankCollisionRect extends TankCollisionPoint {
  width: number;
  height: number;
}

export type TankCollisionRectOrigin = "center" | "top-left";

export interface TankCollisionMovementOptions {
  current: TankCollisionPoint;
  desired: TankCollisionPoint;
  radius: number;
  bounds: TankCollisionBounds;
  obstacles: readonly TankCollisionRect[];
  obstacleOrigin?: TankCollisionRectOrigin;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const normalizeAngle = (angle: number): number => {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
};

const approach = (current: number, target: number, maxDelta: number): number => {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
};

export const circleIntersectsCollisionRect = (
  point: TankCollisionPoint,
  radius: number,
  rect: TankCollisionRect,
  origin: TankCollisionRectOrigin = "top-left"
): boolean => {
  const centerX = origin === "center" ? rect.x : rect.x + rect.width / 2;
  const centerY = origin === "center" ? rect.y : rect.y + rect.height / 2;
  const dx = Math.max(Math.abs(point.x - centerX) - rect.width / 2, 0);
  const dy = Math.max(Math.abs(point.y - centerY) - rect.height / 2, 0);
  return Math.hypot(dx, dy) <= Math.max(radius, 0);
};

export const resolveTankCollisionMovement = ({
  current,
  desired,
  radius,
  bounds,
  obstacles,
  obstacleOrigin = "top-left"
}: TankCollisionMovementOptions): TankCollisionPoint => {
  const safeRadius = Math.max(radius, 0);
  const clampPoint = (point: TankCollisionPoint): TankCollisionPoint => ({
    x: clamp(point.x, bounds.minX + safeRadius, bounds.maxX - safeRadius),
    y: clamp(point.y, bounds.minY + safeRadius, bounds.maxY - safeRadius)
  });
  const collides = (point: TankCollisionPoint): boolean => {
    for (const obstacle of obstacles) {
      if (circleIntersectsCollisionRect(point, safeRadius, obstacle, obstacleOrigin)) return true;
    }
    return false;
  };

  const start = clampPoint(current);
  const target = clampPoint(desired);
  if (target.x === start.x && target.y === start.y) return start;
  if (!collides(target)) return target;

  const slideX = { x: target.x, y: start.y };
  if (slideX.x !== start.x && !collides(slideX)) return slideX;

  const slideY = { x: start.x, y: target.y };
  if (slideY.y !== start.y && !collides(slideY)) return slideY;

  const deltaX = target.x - start.x;
  const deltaY = target.y - start.y;
  let best = start;
  let bestProgress = 0;

  for (const obstacle of obstacles) {
    if (!circleIntersectsCollisionRect(target, safeRadius, obstacle, obstacleOrigin)) continue;

    const centerX = obstacleOrigin === "center"
      ? obstacle.x
      : obstacle.x + obstacle.width / 2;
    const centerY = obstacleOrigin === "center"
      ? obstacle.y
      : obstacle.y + obstacle.height / 2;
    const closestX = clamp(start.x, centerX - obstacle.width / 2, centerX + obstacle.width / 2);
    const closestY = clamp(start.y, centerY - obstacle.height / 2, centerY + obstacle.height / 2);
    const normalX = start.x - closestX;
    const normalY = start.y - closestY;
    const normalLength = Math.hypot(normalX, normalY);
    if (normalLength <= Number.EPSILON) continue;

    const unitX = normalX / normalLength;
    const unitY = normalY / normalLength;
    const inward = deltaX * unitX + deltaY * unitY;
    if (inward >= 0) continue;

    const candidate = clampPoint({
      x: start.x + deltaX - unitX * inward,
      y: start.y + deltaY - unitY * inward
    });
    if (collides(candidate)) continue;

    const progress = (candidate.x - start.x) * deltaX + (candidate.y - start.y) * deltaY;
    if (progress > bestProgress) {
      best = candidate;
      bestProgress = progress;
    }
  }

  return best;
};

export const integrateTankMovement = ({
  state,
  input,
  deltaSeconds,
  maxSpeed,
  handling,
  speedMultiplier = 1,
  deadZone = 0.04
}: TankMovementStepOptions): TankMovementStep => {
  const dt = clamp(deltaSeconds, 0, 0.1);
  const rawMagnitude = Math.hypot(input.moveX, input.moveY);
  const inputMagnitude = rawMagnitude > deadZone ? Math.min(rawMagnitude, 1) : 0;
  const safeRotation = Number.isFinite(state.rotation) ? state.rotation : 0;
  let rotation = safeRotation;
  let targetForwardSpeed = 0;
  let isReversing = false;

  if (inputMagnitude > 0 && dt > 0) {
    const moveX = input.moveX / rawMagnitude;
    const moveY = input.moveY / rawMagnitude;
    const desiredHeading = Math.atan2(moveY, moveX);
    const headingDelta = normalizeAngle(desiredHeading - rotation);
    isReversing = Math.abs(headingDelta) > Math.PI / 2;
    const targetHeading = isReversing
      ? normalizeAngle(desiredHeading + Math.PI)
      : desiredHeading;
    const turnDelta = normalizeAngle(targetHeading - rotation);
    const maxTurn = handling.turnRate * dt;

    rotation = normalizeAngle(rotation + clamp(turnDelta, -maxTurn, maxTurn));

    const turnPenalty = 1 - Math.min(Math.abs(turnDelta) / Math.PI, 1) * handling.turnSlowdown;
    targetForwardSpeed =
      maxSpeed *
      Math.max(0, speedMultiplier) *
      inputMagnitude *
      turnPenalty *
      (isReversing ? -handling.reverseSpeedMultiplier : 1);
  }

  const forwardX = Math.cos(rotation);
  const forwardY = Math.sin(rotation);
  const currentForwardSpeed = state.velocityX * forwardX + state.velocityY * forwardY;
  const needsBraking =
    inputMagnitude <= 0 ||
    currentForwardSpeed * targetForwardSpeed < 0 ||
    Math.abs(targetForwardSpeed) < Math.abs(currentForwardSpeed);
  const response = needsBraking ? handling.brakeDeceleration : handling.acceleration;
  const forwardSpeed =
    inputMagnitude <= 0
      ? 0
      : approach(currentForwardSpeed, targetForwardSpeed, response * dt);

  const velocityX = forwardX * forwardSpeed;
  const velocityY = forwardY * forwardSpeed;

  return {
    x: state.x + velocityX * dt,
    y: state.y + velocityY * dt,
    rotation,
    velocityX,
    velocityY,
    forwardSpeed,
    targetForwardSpeed,
    isReversing,
    inputMagnitude
  };
};
