import { describe, expect, it } from "vitest";
import {
  aimStickIntent,
  circleIntersectsCenteredRect,
  controlMoveToWorldMove,
  frameRateIndependentLerp,
  lerpAngle,
  lightningFlashAlpha,
  movementStickIntent,
  movementIsSettling,
  normalizeVector,
  resolvePredictedMovement,
  stepCameraOrbit,
  shouldHoldIdlePose,
  shouldHoldActivePosition,
  shouldKeepResolvedProjectile
} from "./inputMath";

const expectVectorClose = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 5);
  expect(actual.y).toBeCloseTo(expected.y, 5);
};

describe("camera-relative input math", () => {
  it("maps screen movement into world movement at the default camera orbit", () => {
    expectVectorClose(controlMoveToWorldMove(0, -1, 0), { x: 0, y: -1 });
    expectVectorClose(controlMoveToWorldMove(1, 0, 0), { x: 1, y: 0 });
  });

  it("rotates movement with the camera orbit instead of the startup camera angle", () => {
    expectVectorClose(controlMoveToWorldMove(0, -1, Math.PI / 2), { x: -1, y: 0 });
    expectVectorClose(controlMoveToWorldMove(1, 0, Math.PI / 2), { x: 0, y: -1 });
  });

  it("preserves analog joystick magnitude after camera rotation", () => {
    const worldMove = controlMoveToWorldMove(0, -0.5, Math.PI / 2);
    expect(Math.hypot(worldMove.x, worldMove.y)).toBeCloseTo(0.5, 5);
    expectVectorClose(worldMove, { x: -0.5, y: 0 });
  });

  it("normalizes only oversized vectors", () => {
    expectVectorClose(normalizeVector(0.3, 0.4), { x: 0.3, y: 0.4 });
    expectVectorClose(normalizeVector(3, 4), { x: 0.6, y: 0.8 });
  });

  it("keeps orbit easing identical at 30, 60, and 120 FPS", () => {
    const simulate = (fps: number) => {
      let angle = 0;
      for (let frame = 0; frame < fps; frame += 1) {
        angle = lerpAngle(
          angle,
          Math.PI / 2,
          frameRateIndependentLerp(0.22, 1000 / fps)
        );
      }
      return angle;
    };

    expect(simulate(30)).toBeCloseTo(simulate(60), 10);
    expect(simulate(120)).toBeCloseTo(simulate(60), 10);
    expect(lerpAngle(Math.PI * 2, 0, 0.22)).toBeCloseTo(0, 10);
  });

  it("preserves signed relative rotation through complete turns", () => {
    const simulate = (degrees: number, fps: number) => {
      let angle = 0;
      let pendingDelta = degrees * Math.PI / 180;
      let appliedDelta = 0;
      let reversed = false;
      for (let frame = 0; frame < fps * 2; frame += 1) {
        const previousPendingDelta = pendingDelta;
        ({ angle, pendingDelta } = stepCameraOrbit(
          angle,
          pendingDelta,
          frameRateIndependentLerp(0.22, 1000 / fps)
        ));
        const frameDelta = previousPendingDelta - pendingDelta;
        reversed ||= Math.sign(frameDelta) !== Math.sign(degrees);
        appliedDelta += frameDelta;
      }
      return { angle, appliedDelta, reversed };
    };

    for (const fps of [30, 60, 120]) {
      const clockwise = simulate(360, fps);
      const counterClockwise = simulate(-360, fps);
      const beyondHalfTurn = simulate(206, fps);

      expect(clockwise.appliedDelta).toBeCloseTo(Math.PI * 2, 8);
      expect(clockwise.angle).toBeCloseTo(0, 8);
      expect(clockwise.reversed).toBe(false);
      expect(counterClockwise.appliedDelta).toBeCloseTo(-Math.PI * 2, 8);
      expect(counterClockwise.angle).toBeCloseTo(0, 8);
      expect(counterClockwise.reversed).toBe(false);
      expect(beyondHalfTurn.appliedDelta).toBeCloseTo(206 * Math.PI / 180, 8);
      expect(beyondHalfTurn.angle).toBeCloseTo(-154 * Math.PI / 180, 8);
      expect(beyondHalfTurn.reversed).toBe(false);
    }
  });
});

describe("predicted wall movement", () => {
  it("accepts a safe diagonal endpoint before trying axis slides", () => {
    const current = { x: 50, y: 70 };
    const desired = { x: 55, y: 65 };
    const walls = [{ x: 100, y: 100, width: 40, height: 40 }];

    expect(resolvePredictedMovement(current, desired, 28, 240, 240, walls)).toEqual(desired);
  });

  it("keeps oblique input moving safely around a rounded corner", () => {
    const wall = { x: 148, y: 148, width: 96, height: 96 };
    let point = { x: 80, y: 80 };

    for (let step = 0; step < 12; step += 1) {
      const next = resolvePredictedMovement(
        point,
        { x: point.x + 4, y: point.y + 2 },
        28,
        300,
        300,
        [wall]
      );
      expect(Math.hypot(next.x - point.x, next.y - point.y)).toBeGreaterThan(0);
      expect(circleIntersectsCenteredRect(next.x, next.y, 28, wall)).toBe(false);
      point = next;
    }
  });

  it("stops a radial corner command without choosing a side", () => {
    const current = { x: 80, y: 80 };
    expect(resolvePredictedMovement(
      current,
      { x: 84, y: 84 },
      28,
      300,
      300,
      [{ x: 148, y: 148, width: 96, height: 96 }]
    )).toEqual(current);
  });

  it("clamps at arena bounds while preserving the safe tangent", () => {
    expect(resolvePredictedMovement(
      { x: 270, y: 100 },
      { x: 278, y: 106 },
      28,
      300,
      300,
      []
    )).toEqual({ x: 272, y: 106 });
  });
});

describe("mobile aim stick math", () => {
  it("keeps small thumb movement inside the cancellation deadzone", () => {
    const intent = aimStickIntent(8, 6, 48, 18);

    expect(intent.active).toBe(false);
    expectVectorClose(intent.knob, { x: 8, y: 6 });
  });

  it("normalizes aim direction and clamps the visible knob", () => {
    const intent = aimStickIntent(60, 80, 40, 18);

    expect(intent.active).toBe(true);
    expectVectorClose(intent.direction, { x: 0.6, y: 0.8 });
    expectVectorClose(intent.knob, { x: 24, y: 32 });
  });
});

describe("mobile movement stick math", () => {
  it("ignores center jitter and remaps the remaining travel continuously", () => {
    expectVectorClose(movementStickIntent(5, 0, 40, 6), { x: 0, y: 0 });
    expectVectorClose(movementStickIntent(6, 0, 40, 6), { x: 0, y: 0 });
    expectVectorClose(movementStickIntent(23, 0, 40, 6), { x: 0.5, y: 0 });
    expectVectorClose(movementStickIntent(40, 0, 40, 6), { x: 1, y: 0 });
    expectVectorClose(movementStickIntent(60, 80, 40, 6), { x: 0.6, y: 0.8 });
  });
});

describe("movement prediction math", () => {
  it("matches circular server collision at wall corners", () => {
    const wall = { x: 100, y: 100, width: 40, height: 40 };

    expect(circleIntersectsCenteredRect(135, 135, 20, wall)).toBe(false);
    expect(circleIntersectsCenteredRect(134, 134, 20, wall)).toBe(true);
  });

  it("keeps reconciliation strength stable across frame rates", () => {
    expect(frameRateIndependentLerp(0.08, 1000 / 60)).toBeCloseTo(0.08, 6);
    expect(frameRateIndependentLerp(0.08, 1000 / 30)).toBeCloseTo(1 - 0.92 ** 2, 6);
    expect(frameRateIndependentLerp(0.08, 0)).toBe(0);
  });

  it("keeps movement reconciliation gentle until input and velocity settle", () => {
    expect(movementIsSettling({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(true);
    expect(movementIsSettling({ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 0 })).toBe(true);
    expect(movementIsSettling({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 8, y: 0 })).toBe(true);
    expect(movementIsSettling({ x: 0, y: 0 }, { x: 0.49, y: 0 }, { x: 0, y: 0 })).toBe(false);
  });

  it("holds a settled local tank inside the collision-radius reconciliation deadband", () => {
    expect(
      shouldHoldIdlePose(
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        27,
        28
      )
    ).toBe(true);
    expect(
      shouldHoldIdlePose(
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        29,
        28
      )
    ).toBe(false);
    expect(
      shouldHoldIdlePose(
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        12,
        28
      )
    ).toBe(false);
  });

  it("keeps active position prediction inside the bounded network-latency deadband", () => {
    expect(shouldHoldActivePosition({ x: 1, y: 0 }, 55, 56)).toBe(true);
    expect(shouldHoldActivePosition({ x: 1, y: 0 }, 57, 56)).toBe(false);
    expect(shouldHoldActivePosition({ x: 0, y: 0 }, 12, 56)).toBe(false);
  });

  it("keeps an impact tombstone through stale projectile snapshots", () => {
    expect(shouldKeepResolvedProjectile(100, 1_099, false)).toBe(true);
    expect(shouldKeepResolvedProjectile(100, 1_100, false)).toBe(false);
    expect(shouldKeepResolvedProjectile(100, 1_100, true)).toBe(true);
  });

  it("produces a deterministic two-stage lightning flash with a dark interval", () => {
    expect(lightningFlashAlpha(0.04, 10, 0)).toBeCloseTo(1);
    expect(lightningFlashAlpha(0.19, 10, 0)).toBeGreaterThan(0.6);
    expect(lightningFlashAlpha(2, 10, 0)).toBe(0);
    expect(lightningFlashAlpha(10.04, 10, 0)).toBeCloseTo(lightningFlashAlpha(0.04, 10, 0));
  });
});
