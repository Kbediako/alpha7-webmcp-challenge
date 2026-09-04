import {
  constants,
  createHistogram,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type PerformanceEntry
} from "node:perf_hooks";

const SIMULATION_TICK_BUDGET_MS = 1_000 / 30;
const MAX_RETAINED_RUNTIME_EVENTS = 4_096;

interface GarbageCollectionEvent {
  startTimeMs: number;
  durationMs: number;
  kind: number;
  flags: number;
}

interface SlowTickEvent {
  startTimeMs: number;
  durationMs: number;
  rssBytes: number;
  heapUsedBytes: number;
}

const milliseconds = (nanoseconds: number): number =>
  Number((nanoseconds / 1_000_000).toFixed(3));

const roundedMilliseconds = (value: number): number => Number(value.toFixed(3));

const retainRuntimeEvent = <T>(events: T[], event: T): boolean => {
  if (events.length >= MAX_RETAINED_RUNTIME_EVENTS) return false;
  events.push(event);
  return true;
};

export const summarizeGarbageCollections = (events: GarbageCollectionEvent[]) => ({
  count: events.length,
  totalMs: roundedMilliseconds(events.reduce((total, event) => total + event.durationMs, 0)),
  maxMs: roundedMilliseconds(
    events.reduce((maximum, event) => Math.max(maximum, event.durationMs), 0)
  ),
  majorCount: events.filter(
    (event) => (event.kind & constants.NODE_PERFORMANCE_GC_MAJOR) !== 0
  ).length,
  minorCount: events.filter(
    (event) => (event.kind & constants.NODE_PERFORMANCE_GC_MINOR) !== 0
  ).length,
  incrementalCount: events.filter(
    (event) => (event.kind & constants.NODE_PERFORMANCE_GC_INCREMENTAL) !== 0
  ).length,
  weakCbCount: events.filter(
    (event) => (event.kind & constants.NODE_PERFORMANCE_GC_WEAKCB) !== 0
  ).length,
  forcedCount: events.filter(
    (event) => (event.flags & constants.NODE_PERFORMANCE_GC_FLAGS_FORCED) !== 0
  ).length
});

export const correlateGarbageCollections = (
  tick: SlowTickEvent,
  events: GarbageCollectionEvent[]
) => {
  const tickEnd = tick.startTimeMs + tick.durationMs;
  const garbageCollections = events.flatMap((event) => {
    const overlapMs = Math.max(
      0,
      Math.min(tickEnd, event.startTimeMs + event.durationMs) -
        Math.max(tick.startTimeMs, event.startTimeMs)
    );
    return overlapMs > 0 ? [{ ...event, overlapMs: roundedMilliseconds(overlapMs) }] : [];
  });
  return {
    ...tick,
    gcOverlapMs: roundedMilliseconds(
      garbageCollections.reduce((total, event) => total + event.overlapMs, 0)
    ),
    garbageCollections
  };
};

export const createRuntimeMetrics = () => {
  const ticks = createHistogram();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  let previousUtilization = performance.eventLoopUtilization();
  let previousCpuUsage = process.cpuUsage();
  let overBudgetTicks = 0;
  let droppedGarbageCollections = 0;
  let droppedSlowTicks = 0;
  let garbageCollections: GarbageCollectionEvent[] = [];
  let slowTicks: SlowTickEvent[] = [];
  const recordGarbageCollections = (entries: PerformanceEntry[]): void => {
    for (const entry of entries) {
      const detail = (entry as PerformanceEntry & { detail?: unknown }).detail as
        | { kind?: unknown; flags?: unknown }
        | null
        | undefined;
      if (
        !retainRuntimeEvent(garbageCollections, {
          startTimeMs: roundedMilliseconds(entry.startTime),
          durationMs: roundedMilliseconds(entry.duration),
          kind: typeof detail?.kind === "number" ? detail.kind : 0,
          flags: typeof detail?.flags === "number" ? detail.flags : 0
        })
      ) {
        droppedGarbageCollections += 1;
      }
    }
  };
  const garbageCollectionObserver = new PerformanceObserver((entries) => {
    recordGarbageCollections(entries.getEntries());
  });
  garbageCollectionObserver.observe({ entryTypes: ["gc"] });
  eventLoopDelay.enable();

  return {
    recordSimulationTick(startTimeMs: number, durationMs: number): void {
      if (!Number.isFinite(startTimeMs) || !Number.isFinite(durationMs) || durationMs <= 0) return;
      ticks.record(BigInt(Math.max(1, Math.round(durationMs * 1_000_000))));
      if (durationMs > SIMULATION_TICK_BUDGET_MS) {
        overBudgetTicks += 1;
        const memory = process.memoryUsage();
        if (
          !retainRuntimeEvent(slowTicks, {
            startTimeMs: roundedMilliseconds(startTimeMs),
            durationMs: roundedMilliseconds(durationMs),
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed
          })
        ) {
          droppedSlowTicks += 1;
        }
      }
    },
    async snapshot() {
      await new Promise<void>(setImmediate);
      recordGarbageCollections(garbageCollectionObserver.takeRecords());
      const utilization = performance.eventLoopUtilization(previousUtilization);
      previousUtilization = performance.eventLoopUtilization();
      const currentCpuUsage = process.cpuUsage();
      const cpuUsage = {
        userMs: roundedMilliseconds((currentCpuUsage.user - previousCpuUsage.user) / 1_000),
        systemMs: roundedMilliseconds((currentCpuUsage.system - previousCpuUsage.system) / 1_000)
      };
      previousCpuUsage = currentCpuUsage;
      const memory = process.memoryUsage();
      const result = {
        simulationTick: {
          count: ticks.count,
          p50Ms: milliseconds(ticks.percentile(50)),
          p95Ms: milliseconds(ticks.percentile(95)),
          p99Ms: milliseconds(ticks.percentile(99)),
          maxMs: milliseconds(ticks.max),
          overBudgetCount: overBudgetTicks,
          droppedSlowTickCount: droppedSlowTicks,
          slowTicks: slowTicks.map((tick) =>
            correlateGarbageCollections(tick, garbageCollections)
          )
        },
        garbageCollection: {
          ...summarizeGarbageCollections(garbageCollections),
          droppedEventCount: droppedGarbageCollections
        },
        eventLoop: {
          utilization: Number(utilization.utilization.toFixed(4)),
          activeMs: roundedMilliseconds(utilization.active),
          idleMs: roundedMilliseconds(utilization.idle),
          p50DelayMs: milliseconds(eventLoopDelay.percentile(50)),
          p95DelayMs: milliseconds(eventLoopDelay.percentile(95)),
          p99DelayMs: milliseconds(eventLoopDelay.percentile(99)),
          maxDelayMs: milliseconds(eventLoopDelay.max)
        },
        cpu: cpuUsage,
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed
        },
        uptimeSeconds: Number(process.uptime().toFixed(1))
      };
      ticks.reset();
      overBudgetTicks = 0;
      droppedGarbageCollections = 0;
      droppedSlowTicks = 0;
      garbageCollections = [];
      slowTicks = [];
      eventLoopDelay.reset();
      return result;
    },
    close(): void {
      garbageCollectionObserver.disconnect();
      eventLoopDelay.disable();
    }
  };
};

export type RuntimeMetrics = ReturnType<typeof createRuntimeMetrics>;
