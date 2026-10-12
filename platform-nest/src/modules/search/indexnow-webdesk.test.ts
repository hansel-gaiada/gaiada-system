// M5-P5a — the WebDesk publish hook and the notify body, without a database: which approvals it acts on, the
// stored-args parser, domain order, the wait-for-execution rule, the flag-off path (the resolver is never called),
// and the notify route's item validation. The publish -> ping flow itself is in indexnow.db.test.ts.
import { describe, it, expect, vi } from "vitest";
import type { OutboxEvent } from "../../events/types";
import { domainsOfEnvironments, handlePublishApprovalDecided, onApprovalDecided, parsePublishArgs, type WebdeskPageResolver } from "./indexnow-webdesk";
import { searchModule } from "./index";
import { parseNotifyItems } from "./indexnow.controller";

const ITEM = "11111111-2222-4333-8444-555555555555";
const SITE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ON = { SEARCH_INDEXNOW_ENABLED: "1" } as NodeJS.ProcessEnv;
const args = { command: "content.publish", tenantSlug: "gaiada", siteId: SITE, items: [{ itemId: ITEM, version: 3 }] };
const ev = (payload: Record<string, unknown>): OutboxEvent => ({
  id: "e1", tenantId: "t1", entityType: "automation_approval", entityId: "appr-1", eventType: "automation_approval.decided",
  payload: { decision: "approved", origin: "webdesk", workflowId: "content.publish", toolArgs: args, ...payload }, originSite: "central", schemaVersion: 1, createdAt: new Date().toISOString(),
});
const resolver = (items = 1): WebdeskPageResolver & { resolve: ReturnType<typeof vi.fn> } => ({
  resolve: vi.fn(async () => ({ domains: ["www.example.com"], notLive: 0, items: Array.from({ length: items }, () => ({ slug: "a", locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", version: 3 })) })),
});

describe("parsePublishArgs", () => {
  it("reads a content.publish approval's stored args", () => {
    expect(parsePublishArgs(args)).toEqual({ tenantSlug: "gaiada", siteId: SITE, items: [{ itemId: ITEM, version: 3 }] });
  });
  it("is null for anything else, never throws", () => {
    const bad: unknown[] = [
      null, "x", [], { ...args, command: "content.schedule" }, { ...args, tenantSlug: "Not A Slug" }, { ...args, siteId: "nope" }, { ...args, items: [] },
      { ...args, items: [{ itemId: "nope", version: 1 }] }, { ...args, items: [{ itemId: ITEM, version: 0 }] }, { ...args, items: [{ itemId: ITEM, version: 1.5 }] },
      { ...args, items: Array.from({ length: 201 }, () => ({ itemId: ITEM, version: 1 })) },
    ];
    for (const b of bad) expect(parsePublishArgs(b)).toBeNull();
  });
});

describe("domainsOfEnvironments", () => {
  it("puts production first and skips environments with no hostname", () => {
    expect(domainsOfEnvironments([{ name: "staging", domain: "stg.example.com" }, { name: "Production", domain: "www.example.com" }, { name: "dev", domain: "" }, { name: "x" }, null]))
      .toEqual(["www.example.com", "stg.example.com"]);
    expect(domainsOfEnvironments(undefined)).toEqual([]);
  });
});

describe("handlePublishApprovalDecided", () => {
  it("flag OFF: returns disabled and never reads WebDesk, the approval or anything else", async () => {
    const r = resolver();
    const status = vi.fn(async () => "executed");
    for (const env of [{}, { SEARCH_INDEXNOW_ENABLED: "" }, { SEARCH_INDEXNOW_ENABLED: "true" }] as NodeJS.ProcessEnv[]) {
      expect(await handlePublishApprovalDecided(ev({}), { env, resolver: r, executionStatus: status })).toBe("disabled");
    }
    expect(r.resolve).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
  it("ignores every approval that is not an approved webdesk content.publish", async () => {
    const r = resolver();
    const run = (p: Record<string, unknown>) => handlePublishApprovalDecided(ev(p), { env: ON, resolver: r, executionStatus: async () => "executed", moduleEnabled: async () => true });
    expect(await run({ decision: "rejected" })).toBe("ignored");
    expect(await run({ origin: "automation" })).toBe("ignored");
    expect(await run({ workflowId: "content.schedule" })).toBe("ignored");
    expect(await run({ workflowId: null })).toBe("ignored");
    expect(await run({ toolArgs: { command: "content.publish" } })).toBe("ignored");
    expect(r.resolve).not.toHaveBeenCalled();
  });
  it("throws (so the bus redelivers) while the publish has not finished executing", async () => {
    const r = resolver();
    for (const s of ["pending", "executing"]) {
      await expect(handlePublishApprovalDecided(ev({}), { env: ON, resolver: r, executionStatus: async () => s, moduleEnabled: async () => true })).rejects.toThrow(/not finished/);
    }
    expect(r.resolve).not.toHaveBeenCalled();
  });
  it("does nothing when the publish failed or the row is gone", async () => {
    const r = resolver();
    for (const s of ["failed", "not_applicable", null]) {
      expect(await handlePublishApprovalDecided(ev({}), { env: ON, resolver: r, executionStatus: async () => s, moduleEnabled: async () => true })).toBe("not_executed");
    }
    expect(r.resolve).not.toHaveBeenCalled();
  });
  it("a tenant without the search module is left alone (a core handler is not gated by the registry): nothing is read or resolved", async () => {
    const r = resolver();
    const status = vi.fn(async () => "executed");
    expect(await handlePublishApprovalDecided(ev({}), { env: ON, resolver: r, executionStatus: status, moduleEnabled: async () => false })).toBe("module_off");
    expect(r.resolve).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
  it("is wired as a CORE handler: the search module itself registers NO automation_approval.decided handler (the sem-apply guarantee)", async () => {
    expect(Object.keys(searchModule.eventHandlers ?? {})).not.toContain("automation_approval.decided");
    // the core handler ignores every other event type before looking at anything
    await expect(onApprovalDecided({ ...ev({}), eventType: "something.else" })).resolves.toBeUndefined();
  });
  it("an executed publish whose items are not live at the approved version pings nothing", async () => {
    const r = resolver(0);
    expect(await handlePublishApprovalDecided(ev({}), { env: ON, resolver: r, executionStatus: async () => "executed", moduleEnabled: async () => true })).toBe("not_live");
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.resolve).toHaveBeenCalledWith("t1", { tenantSlug: "gaiada", siteId: SITE, items: [{ itemId: ITEM, version: 3 }] });
  });
});

describe("notify body items", () => {
  const ok = { slug: "a", locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", version: 2 };
  it("accepts a well-formed item and fills the optional members", () => {
    expect(parseNotifyItems([ok])).toEqual([{ slug: "a", locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", version: 2 }]);
    expect(parseNotifyItems([{ slug: "a", locale: "en", defaultLocale: "en", localized: false }])[0]).toMatchObject({ localized: false, version: null, routePattern: undefined });
  });
  it("is a 400 for the wrong shape, unknown keys, bad types and size", () => {
    const bad: unknown[] = [
      undefined, [], "x", Array.from({ length: 201 }, () => ok), [null], [{ ...ok, extra: 1 }], [{ ...ok, slug: "" }], [{ ...ok, locale: 5 }],
      [{ ...ok, defaultLocale: undefined }], [{ ...ok, routePattern: 5 }], [{ ...ok, localized: "yes" }], [{ ...ok, version: 0 }], [{ ...ok, slug: "x".repeat(201) }],
    ];
    for (const b of bad) expect(() => parseNotifyItems(b)).toThrow();
  });
});
