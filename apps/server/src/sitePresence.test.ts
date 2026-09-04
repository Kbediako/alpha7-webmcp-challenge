import { describe, expect, it } from "vitest";
import {
  MAX_SITE_VISITORS,
  SITE_PRESENCE_TTL_MS,
  countSiteVisitors,
  isSiteVisitorId,
  recordSiteVisitor
} from "./sitePresence.js";

describe("site presence", () => {
  it("deduplicates, refreshes, expires, validates, and caps visitors", () => {
    const visitors = new Map<string, number>();
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";

    expect(isSiteVisitorId(first)).toBe(true);
    expect(isSiteVisitorId("not-a-visitor")).toBe(false);
    expect(recordSiteVisitor(visitors, first, 0)).toBe(1);
    expect(recordSiteVisitor(visitors, first, 10_000)).toBe(1);
    expect(recordSiteVisitor(visitors, second, 20_000)).toBe(2);
    expect(countSiteVisitors(visitors, 10_000 + SITE_PRESENCE_TTL_MS)).toBe(1);
    expect(countSiteVisitors(visitors, 20_000 + SITE_PRESENCE_TTL_MS)).toBe(0);

    const full = new Map(
      Array.from({ length: MAX_SITE_VISITORS }, (_, index) => [
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        1
      ])
    );
    expect(recordSiteVisitor(full, first, 1)).toBeNull();
  });
});
