export const SITE_PRESENCE_TTL_MS = 60_000;
export const MAX_SITE_VISITORS = 10_000;

const VISITOR_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isSiteVisitorId = (value: unknown): value is string =>
  typeof value === "string" && VISITOR_ID_PATTERN.test(value);

const pruneExpiredVisitors = (visitors: Map<string, number>, now: number): void => {
  const staleBefore = now - SITE_PRESENCE_TTL_MS;
  for (const [visitorId, lastSeenAt] of visitors) {
    if (lastSeenAt > staleBefore) break;
    visitors.delete(visitorId);
  }
};

export const countSiteVisitors = (visitors: Map<string, number>, now = Date.now()): number => {
  pruneExpiredVisitors(visitors, now);
  return visitors.size;
};

export const recordSiteVisitor = (
  visitors: Map<string, number>,
  visitorId: string,
  now = Date.now()
): number | null => {
  pruneExpiredVisitors(visitors, now);
  if (!visitors.has(visitorId) && visitors.size >= MAX_SITE_VISITORS) return null;
  visitors.delete(visitorId);
  visitors.set(visitorId, now);
  return visitors.size;
};
