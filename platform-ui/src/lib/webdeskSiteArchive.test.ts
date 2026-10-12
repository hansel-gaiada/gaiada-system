import { describe, it, expect, vi, beforeEach } from "vitest";

// "Archive site" (owner ruling 2026-10-12): the filing action's route and body, its error mapping, the optional site `status` on the
// sites read, and the pure helpers. The filing answer is the key request's exact shape, so its strict parser is shared and covered by
// webdeskContentKeys.test.ts; this file covers what is specific to the archive.

vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ id: "u1", companies: [], roles: [] })) };
});
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./entities", () => ({ listMembers: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { getSessionUserId } from "./session-server";
import { parseArchiveRequest, parseSites } from "./webdeskContent";
import { requestSiteArchiveAction } from "./webdeskContentActions";
import {
  ARCHIVE_SITE_COPY, archiveFailureCopy, isSiteArchiveApproval, isSiteArchived, parseSiteArchiveArgs, type WdResult,
} from "./webdeskContentModel";

const fetchMock = vi.mocked(platformFetch);
const session = vi.mocked(getSessionUserId);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const notOk = (r: WdResult<unknown>) => r as Exclude<WdResult<unknown>, { kind: "ok" }>;

function problem(status: number, slug: string) {
  return new PlatformError(status, slug, undefined, undefined, undefined, { type: `https://webdesk.gaiada.online/errors/${slug}`, title: slug, status });
}

beforeEach(() => { fetchMock.mockReset(); session.mockResolvedValue("u1"); });

describe("requestSiteArchiveAction: route, body and error mapping", () => {
  it("POSTs the control-plane archive route (siteId in the path, ONLY tenantSlug in the body) and returns the filed approval", async () => {
    fetchMock.mockResolvedValue({ approvalId: "ap-1" });
    const r = await requestSiteArchiveAction(SCOPE);
    expect(r).toEqual({ kind: "ok", data: { approvalId: "ap-1", alreadyPending: false } });
    const [path, userId, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/co-1/modules/webdev/control/sites/site-1/archive");
    expect(userId).toBe("u1");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ tenantSlug: "gaiada" });
  });

  it("202 alreadyPending", async () => {
    fetchMock.mockResolvedValue({ approvalId: "ap-0", alreadyPending: true });
    expect(await requestSiteArchiveAction(SCOPE)).toEqual({ kind: "ok", data: { approvalId: "ap-0", alreadyPending: true } });
  });

  it("a body that is not the filing shape is drift, never a quiet 'filed'", async () => {
    fetchMock.mockResolvedValue({ approvalId: "ap-1", status: "archived" });
    const r = await requestSiteArchiveAction(SCOPE);
    expect(r.kind).toBe("unavailable");
    expect(() => parseArchiveRequest({ approvalId: "ap-1", status: "archived" })).toThrow();
  });

  it("403 (Cerbos `promote`) is forbidden", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "forbidden"));
    const r = await requestSiteArchiveAction(SCOPE);
    expect(r.kind).toBe("forbidden");
    expect(archiveFailureCopy(notOk(r))).toBe(ARCHIVE_SITE_COPY.forbidden);
  });

  it("404 site-not-found (another company's site) is not_found, in plain words", async () => {
    fetchMock.mockRejectedValue(problem(404, "site-not-found"));
    const r = await requestSiteArchiveAction(SCOPE);
    expect(r).toEqual({ kind: "not_found", slug: "site-not-found" });
    expect(archiveFailureCopy(notOk(r))).toMatch(/site doesn't exist or isn't one of your company's/);
  });

  it("409 site-archived is a conflict that reads 'already archived'", async () => {
    fetchMock.mockRejectedValue(problem(409, "site-archived"));
    const r = await requestSiteArchiveAction(SCOPE);
    expect(r.kind).toBe("conflict");
    expect(archiveFailureCopy(notOk(r))).toBe(ARCHIVE_SITE_COPY.alreadyArchived);
  });

  it("503 is the workspace's unavailable state with the archive's own sentence", async () => {
    fetchMock.mockRejectedValue(new PlatformError(503, "editorial_unavailable", undefined, undefined, undefined, { error: "editorial_unavailable" }));
    const r = await requestSiteArchiveAction(SCOPE);
    expect(r.kind).toBe("unavailable");
    expect(archiveFailureCopy(notOk(r))).toBe(ARCHIVE_SITE_COPY.unavailable);
  });

  it("an empty scope sends nothing", async () => {
    const r = await requestSiteArchiveAction({ tenantSlug: "", siteId: "" });
    expect(r.kind).not.toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the sites read carries the optional site status", () => {
  const body = (status?: unknown) => ({
    tenants: [{
      slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"],
      sites: [{ siteId: "s1", name: "Main", kind: "astro", environments: [], ...(status === undefined ? {} : { status }) }],
    }],
  });

  it("an older WebDesk that sends no status still parses, and the site reads as active", () => {
    const site = parseSites(body()).tenants[0].sites[0];
    expect(site.status).toBeUndefined();
    expect(isSiteArchived(site)).toBe(false);
  });

  it("status 'archived' is carried and reads as archived; 'active' does not", () => {
    expect(isSiteArchived(parseSites(body("archived")).tenants[0].sites[0])).toBe(true);
    expect(isSiteArchived(parseSites(body("active")).tenants[0].sites[0])).toBe(false);
  });

  it("a status that is not a string is drift", () => {
    expect(() => parseSites(body(7))).toThrow();
  });
});

describe("approval helpers", () => {
  it("parseSiteArchiveArgs accepts exactly a site.archive row's args and nothing else", () => {
    expect(parseSiteArchiveArgs({ command: "site.archive", tenantSlug: "gaiada", siteId: "s1", summary: {}, commandHash: "h" })).toEqual({ tenantSlug: "gaiada", siteId: "s1" });
    for (const bad of [null, "x", {}, { command: "key.mint", tenantSlug: "g", siteId: "s" }, { command: "site.archive", tenantSlug: "", siteId: "s" }, { command: "site.archive", tenantSlug: "g" }]) {
      expect(parseSiteArchiveArgs(bad)).toBeNull();
    }
  });

  it("isSiteArchiveApproval matches the workflow or the tool, and not a key mint or a publish", () => {
    expect(isSiteArchiveApproval({ workflowId: "site.archive" })).toBe(true);
    expect(isSiteArchiveApproval({ toolName: "webdesk.site.archive" })).toBe(true);
    expect(isSiteArchiveApproval({ workflowId: "key.mint", toolName: "webdesk.key.mint" })).toBe(false);
    expect(isSiteArchiveApproval({ workflowId: "content.publish", toolName: "webdesk.content.requestPublish" })).toBe(false);
  });

  it("the copy says it needs approval and cannot be undone, and the success line never claims the site is archived", () => {
    expect(ARCHIVE_SITE_COPY.explain).toMatch(/cannot be undone/);
    expect(ARCHIVE_SITE_COPY.explain).toMatch(/approval/);
    expect(ARCHIVE_SITE_COPY.filed).toBe("Archive requested — waiting for approval.");
  });
});
