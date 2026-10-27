import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Writers' room -> People -> site. The publisher tier is the BFF's answer, not a guess from roles: a 403 on the grants read is the
// plain "you can't manage writers here" state, and no list or form is drawn for it.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn(), listCollections: vi.fn(), resolveAuthorNames: vi.fn() }));
vi.mock("@/lib/webdeskEditorial", () => ({ listEditorialGrants: vi.fn() }));
vi.mock("@/lib/webdeskEditorialActions", () => ({ grantRoleAction: vi.fn(), listGrantsAction: vi.fn(), revokeRoleAction: vi.fn() }));
vi.mock("@/lib/contributorsAdminActions", () => ({ listContributorsAction: vi.fn(), inviteContributorAction: vi.fn(), endContributorAction: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listCollections, listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { listEditorialGrants } from "@/lib/webdeskEditorial";
import { listContributorsAction } from "@/lib/contributorsAdminActions";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const collMock = vi.mocked(listCollections);
const namesMock = vi.mocked(resolveAuthorNames);
const grantsMock = vi.mocked(listEditorialGrants);
const ctxMock = vi.mocked(requireWebsiteCtx);
const contribMock = vi.mocked(listContributorsAction);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const grant = { grantId: "g1", userId: "u5", name: "Dewi", email: null, role: "webdesk_writer", tenantSlug: "gaiada", siteId: "site-1", allCollections: false, collections: ["service"], allLocales: true, locales: [], expiresAt: null, grantedBy: null, updatedAt: null };
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); collMock.mockReset(); namesMock.mockReset(); grantsMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", writersBase: "/departments/dept-1/website/writers" } as never);
  sitesMock.mockResolvedValue(sites() as never);
  collMock.mockResolvedValue({ kind: "ok", data: [{ key: "service" }, { key: "page" }] } as never);
  namesMock.mockResolvedValue({ u5: "Dewi" });
  contribMock.mockReset();
  contribMock.mockResolvedValue({ kind: "ok", data: [] });
});

describe("Website -> Writers' room -> People -> site", () => {
  it("a publisher (the BFF answers) sees the grants and the form", async () => {
    grantsMock.mockResolvedValue({ kind: "ok", data: { tenantSlug: "gaiada", siteId: "site-1", grants: [grant] } } as never);
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "writers");
    expect(grantsMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1");
    expect(screen.getAllByTestId("grant-row")).toHaveLength(1);
    expect(screen.getByTestId("grant-form")).toBeTruthy();
    expect(screen.getByLabelText("page")).toBeTruthy(); // the site's collections are offered
  });

  it("an empty grants list is a real answer: the form is still there", async () => {
    grantsMock.mockResolvedValue({ kind: "ok", data: { tenantSlug: "gaiada", siteId: "site-1", grants: [] } } as never);
    await mount();
    expect(screen.getByTestId("grants-empty")).toBeTruthy();
    expect(screen.getByTestId("grant-form")).toBeTruthy();
  });

  it("403 from the BFF: the plain 'you can't manage writers here' state, with NO list, form or empty claim", async () => {
    grantsMock.mockResolvedValue({ kind: "forbidden", reason: "forbidden" } as never);
    await mount();
    expect(screen.getByTestId("people-forbidden").textContent).toMatch(/You can't manage writers here/);
    expect(screen.queryByTestId("grants-manager")).toBeNull();
    expect(screen.queryByTestId("grant-form")).toBeNull();
    expect(screen.queryByTestId("grants-empty")).toBeNull();
    expect(collMock).not.toHaveBeenCalled();
  });

  it("any other refusal is a notice, never the 403 wording and never an empty list", async () => {
    grantsMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" } as never);
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("people-forbidden")).toBeNull();
    expect(screen.queryByTestId("grants-manager")).toBeNull();
  });

  it("drift on the grants body is the loud notice", async () => {
    grantsMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "grants.grants: expected array" } as never);
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
  });

  it("a site that is not this company's reads no grants", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(grantsMock).not.toHaveBeenCalled();
  });

  it("a failed collections read is a refusal (no form that would offer the wrong collections)", async () => {
    grantsMock.mockResolvedValue({ kind: "ok", data: { tenantSlug: "gaiada", siteId: "site-1", grants: [] } } as never);
    collMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" } as never);
    await mount();
    expect(screen.queryByTestId("grant-form")).toBeNull();
  });

  // M5-W1f: the freelance contributors block of the same page.
  it("shows the freelance contributors form beneath the roles, with the list the BFF returned", async () => {
    grantsMock.mockResolvedValue({ kind: "ok", data: { tenantSlug: "gaiada", siteId: "site-1", grants: [] } } as never);
    contribMock.mockResolvedValue({ kind: "ok", data: [{ contributorId: "c1", userId: "u9", name: "Ayu", email: "ayu@example.test", status: "active", live: true, validUntil: "2027-01-01T00:00:00Z", sponsorUserId: null, invitedAt: "t", activatedAt: null, endedAt: null, hasAccount: true }] });
    await mount();
    expect(screen.getByTestId("contributor-invite-form")).toBeTruthy();
    expect(screen.getAllByTestId("contributor-row")).toHaveLength(1);
  });

  it("a failed contributors read is a sentence, never an empty list or a form", async () => {
    grantsMock.mockResolvedValue({ kind: "ok", data: { tenantSlug: "gaiada", siteId: "site-1", grants: [] } } as never);
    contribMock.mockResolvedValue({ kind: "unavailable", code: "network", reason: "down" });
    await mount();
    expect(screen.getByTestId("contributors-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("contributors-empty")).toBeNull();
    expect(screen.queryByTestId("contributor-invite-form")).toBeNull();
    expect(screen.getByTestId("grant-form")).toBeTruthy();
  });
});
