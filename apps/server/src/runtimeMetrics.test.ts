import { afterEach, describe, expect, it } from "vitest";
import { constants } from "node:perf_hooks";
import {
  correlateGarbageCollections,
  createRuntimeMetrics,
  summarizeGarbageCollections,
  type RuntimeMetrics
} from "./runtimeMetrics.js";

let metrics: RuntimeMetrics | undefined;

afterEach(() => metrics?.close());

describe("runtime capacity metrics", () => {
  it("reports and resets simulation tick samples", async () => {
    metrics = createRuntimeMetrics();
    metrics.recordSimulationTick(10, 1);
    metrics.recordSimulationTick(20, 34);

    const first = await metrics.snapshot();
    const second = await metrics.snapshot();

    expect(first.simulationTick).toMatchObject({ count: 2, overBudgetCount: 1 });
    expect(first.simulationTick.maxMs).toBeGreaterThanOrEqual(34);
    expect(first.simulationTick.p50Ms).toBeGreaterThanOrEqual(1);
    expect(first.simulationTick.slowTicks).toHaveLength(1);
    expect(first.eventLoop.utilization).toBeGreaterThanOrEqual(0);
    expect(first.memory.rssBytes).toBeGreaterThan(0);
    expect(second.simulationTick).toMatchObject({ count: 0, overBudgetCount: 0 });
    expect(second.simulationTick.slowTicks).toEqual([]);
  });

  it("correlates a slow tick with only overlapping garbage collections", () => {
    const events = [
      { startTimeMs: 90, durationMs: 15, kind: constants.NODE_PERFORMANCE_GC_MINOR, flags: 0 },
      {
        startTimeMs: 120,
        durationMs: 10,
        kind: constants.NODE_PERFORMANCE_GC_MAJOR,
        flags: constants.NODE_PERFORMANCE_GC_FLAGS_FORCED
      },
      { startTimeMs: 145, durationMs: 5, kind: constants.NODE_PERFORMANCE_GC_MINOR, flags: 0 }
    ];
    const correlated = correlateGarbageCollections(
      { startTimeMs: 100, durationMs: 40, rssBytes: 1, heapUsedBytes: 1 },
      events
    );

    expect(correlated.gcOverlapMs).toBe(15);
    expect(correlated.garbageCollections).toHaveLength(2);
    expect(summarizeGarbageCollections(events)).toMatchObject({
      count: 3,
      totalMs: 30,
      maxMs: 15,
      majorCount: 1,
      minorCount: 2,
      forcedCount: 1
    });
  });

  it("bounds retained diagnostic events and reports dropped samples", async () => {
    metrics = createRuntimeMetrics();
    for (let index = 0; index < 4_097; index += 1) {
      metrics.recordSimulationTick(index, 34);
    }

    const snapshot = await metrics.snapshot();

    expect(snapshot.simulationTick.slowTicks).toHaveLength(4_096);
    expect(snapshot.simulationTick.droppedSlowTickCount).toBe(1);
  });
});
