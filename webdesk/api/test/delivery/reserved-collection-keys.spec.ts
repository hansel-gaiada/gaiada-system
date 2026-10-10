// WSK M3 T1 (D1) — the reserved-collection-key list is COMPUTED, not asserted: this boots the real
// app, records every route Fastify registers (an `onRoute` hook installed before Nest registers any
// route), and fails if a static first segment under `/v1/t/:tenantSlug/` is missing from
// RESERVED_COLLECTION_KEYS. Adding a controller route there without reserving its segment turns this
// red. (The schema.apply refusal itself is test/schema-reserved-keys.spec.ts.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import "../helpers/app"; // sets the test env (DB url, pepper) before the app module loads
import { buildApp, createFastifyAdapter } from "../../src/app";
import {
  API_ROUTE_SEGMENTS,
  isReservedCollectionKey,
  RESERVED_COLLECTION_KEYS,
  SEARCH_SEGMENT,
  SITEMAP_SEGMENT,
} from "../../src/delivery/reserved-collection-keys";

/** The static first segment after `/v1/t/:tenantSlug/` of a registered route url, if it has one. */
function staticSegmentUnderTenant(url: string): string | null {
  const parts = url.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "t" || parts.length < 4) return null;
  const seg = parts[3];
  return seg.startsWith(":") || seg.startsWith("*") ? null : seg;
}

describe("M3 T1 D1 — reserved collection keys", () => {
  let app: NestFastifyApplication;
  const registeredUrls: string[] = [];

  beforeAll(async () => {
    const adapter = createFastifyAdapter();
    adapter.getInstance().addHook("onRoute", (route) => {
      registeredUrls.push(route.url);
    });
    app = await buildApp(adapter);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("the hook saw the real route table (guards against a vacuous pass)", () => {
    expect(registeredUrls).toContain("/v1/*"); // the delivery wildcard
    expect(registeredUrls.some((u) => u.startsWith("/v1/t/:tenantSlug/media"))).toBe(true);
    expect(registeredUrls.some((u) => u.startsWith("/v1/t/:tenantSlug/forms"))).toBe(true);
  });

  it("every static segment registered under /v1/t/:tenantSlug/ is reserved", () => {
    const found = new Set<string>();
    for (const url of registeredUrls) {
      const seg = staticSegmentUnderTenant(url);
      if (seg) found.add(seg);
    }
    expect([...found].sort()).toEqual(expect.arrayContaining(["forms", "media"]));
    const missing = [...found].filter((seg) => !isReservedCollectionKey(seg));
    expect(missing, `static /v1/t/:tenantSlug/<segment> routes missing from RESERVED_COLLECTION_KEYS: ${missing.join(", ")}`).toEqual([]);
  });

  it("the router's own special segments are reserved, and the list has nothing else hidden in it", () => {
    expect(isReservedCollectionKey(SEARCH_SEGMENT)).toBe(true);
    expect(isReservedCollectionKey(SITEMAP_SEGMENT)).toBe(true);
    expect([...RESERVED_COLLECTION_KEYS].sort()).toEqual([...API_ROUTE_SEGMENTS, SEARCH_SEGMENT, SITEMAP_SEGMENT].sort());
  });

  it("matching is case-insensitive and exact", () => {
    for (const k of ["Media", "FORMS", "Search", "SiteMap.XML"]) expect(isReservedCollectionKey(k)).toBe(true);
    for (const k of ["media-gallery", "form", "searches", "sitemap", "case-study", "redirect"]) expect(isReservedCollectionKey(k)).toBe(false);
  });
});
