import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Writers' room -> Uploads awaiting review -> site (M5-W1q). Who may review is the BFF's answer, not a guess from roles: a 403 on the queue read is
// the plain "you can't review uploads here" state, and no list, buttons or empty claim are drawn for it.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn(), resolveAuthorNames: vi.fn() }));
vi.mock("@/lib/webdeskMediaReview", () => ({ listQuarantine: vi.fn() }));
vi.mock("@/lib/webdeskMediaReviewActions", () => ({ listQuarantineAction: vi.fn(), reviewUploadAction: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { listQuarantine } from "@/lib/webdeskMediaReview";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const namesMock = vi.mocked(resolveAuthorNames);
const queueMock = vi.mocked(listQuarantine);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [] }] }] } });
const upload = (id: string, allowedReview: boolean | null) => ({
  asset: { assetId: id, url: `/v1/t/gaiada/media/${id}`, mime: "image/png", sizeBytes: 1024, scanStatus: "clean", title: null, alt: {}, tags: [], originalFilename: `${id}.png`, width: null, height: null, createdBy: "contrib-1", createdAt: "2026-10-27T01:00:00Z", updatedAt: "2026-10-27T01:00:00Z", deletedAt: null },
  reviewState: "quarantined" as const,
  allowedReview,
});
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); namesMock.mockReset(); queueMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", writersBase: "/departments/dept-1/website/writers" } as never);
  sitesMock.mockResolvedValue(sites() as never);
  namesMock.mockResolvedValue({});
});

describe("Website -> Writers' room -> Uploads awaiting review -> site", () => {
  it("a reviewer (the BFF answers) sees the held uploads, each with its own buttons", async () => {
    queueMock.mockResolvedValue({ kind: "ok", data: { assets: [upload("a1", true), upload("a2", false)], page: { cursor: null, hasMore: false, limit: 50 } } } as never);
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "writers");
    expect(queueMock).toHaveBeenCalledWith("u", "co-1", "gaiada", "site-1");
    expect(screen.getAllByTestId("quarantine-row")).toHaveLength(2);
    expect(screen.getAllByTestId("quarantine-accept")).toHaveLength(1); // the second upload's `allowed.review` is false
  });

  it("an empty queue is a real answer, said as such", async () => {
    queueMock.mockResolvedValue({ kind: "ok", data: { assets: [], page: { cursor: null, hasMore: false, limit: 50 } } } as never);
    await mount();
    expect(screen.getByTestId("quarantine-empty")).toBeTruthy();
  });

  it("403 from the BFF: the plain 'you can't review uploads here' state, with NO list, buttons or empty claim", async () => {
    queueMock.mockResolvedValue({ kind: "forbidden", reason: "forbidden" } as never);
    await mount();
    expect(screen.getByTestId("uploads-forbidden").textContent).toMatch(/You can't review uploads here/);
    expect(screen.queryByTestId("quarantine-panel")).toBeNull();
    expect(screen.queryByTestId("quarantine-empty")).toBeNull();
    expect(namesMock).not.toHaveBeenCalled();
  });

  it("any other refusal is a notice, never the 403 wording and never an empty list", async () => {
    queueMock.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" } as never);
    await mount();
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("uploads-forbidden")).toBeNull();
    expect(screen.queryByTestId("quarantine-panel")).toBeNull();
  });

  it("drift on the queue body is the loud notice", async () => {
    queueMock.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "quarantine.assets: expected array" } as never);
    await mount();
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
  });

  it("a site that is not this company's reads no queue", async () => {
    sitesMock.mockResolvedValue({ kind: "ok", data: { tenants: [] } } as never);
    await mount();
    expect(queueMock).not.toHaveBeenCalled();
  });
});
