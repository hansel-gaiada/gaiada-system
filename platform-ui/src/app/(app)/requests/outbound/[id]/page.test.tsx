import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { HOTEL, me as meFixture, member } from "@/lib/workspaceFixtures";

// DW-10e: the sender's page for a request their company sent to another group company (BFF §60.5, §60.9). Server page: the readers are mocked
// (with the REAL normalisers, so what reaches the page is what the wire can carry), the page's element tree is rendered.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children?: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-h") }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/requests-data", () => ({ readOutboundDetail: vi.fn(), readOutboundFiles: vi.fn() }));
vi.mock("@/lib/requestActions", () => ({ cancelOutboundRequestAction: vi.fn(), cancelRequestAction: vi.fn(), declineRequestAction: vi.fn(), deliverRequestAction: vi.fn() }));

import { getMe } from "@/lib/platform";
import { readOutboundDetail, readOutboundFiles } from "@/lib/requests-data";
import { normalizeOutboundFiles, normalizeRequestDetail } from "@/lib/requests";
import OutboundRequestPage from "./page";

const wire = (over: Record<string, unknown> = {}) => ({
  id: "x1", kind: "assets", title: "Reception banners", status: "open", neededBy: "2026-11-05", createdAt: "2026-10-12T03:00:00.000Z", closedAt: null,
  fromUnit: { id: "hosp-dept-1", name: "Front Office", unitMissing: false }, toUnit: { id: "dept-2", name: "Creatives", unitMissing: false },
  requestedBy: { id: "u-1", name: "Ni Luh Sekar" }, campaign: null,
  work: { type: "pm_task", status: "in_progress", isDone: false, responsibleName: "Putu Rani" }, assetCount: 0,
  receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" }, routeId: "rt-1", price: null,
  brief: "Three banners for the front desk.", form: { deliverables: [{ format: "image", size: "1920x1080", quantity: 3 }], channel: "Screens", references: ["https://example.com/ref"] },
  declineReason: null, assets: [], ...over,
});
const eng = (price: unknown, over: Record<string, unknown> = {}) => wire({
  kind: "engineering", title: "Booking page change", work: { type: "change_request", status: "new" }, form: { kind: "feature" }, price, ...over,
});
const files = [{ id: "f1", filename: "brief.pdf", contentType: "application/pdf", byteSize: 100, createdAt: null, url: null }];

function reads(detail: unknown, filesRead: "ok" | "unavailable" | "forbidden" = "ok", rows: unknown = files) {
  vi.mocked(readOutboundDetail).mockResolvedValue(
    detail === "notfound" ? { kind: "ok", data: null } : { kind: "ok", data: normalizeRequestDetail(detail, { outbound: true }) },
  );
  vi.mocked(readOutboundFiles).mockResolvedValue(
    filesRead === "ok" ? { kind: "ok", data: normalizeOutboundFiles(rows)! } : filesRead === "forbidden" ? { kind: "forbidden" } : { kind: "unavailable", reason: "files are down" },
  );
}
const mount = async () => render(await OutboundRequestPage({ params: Promise.resolve({ id: "x1" }) }));
const requester = () => vi.mocked(getMe).mockResolvedValue(meFixture([member("co-h")], [HOTEL], { userId: "u-1" }));
const colleague = () => vi.mocked(getMe).mockResolvedValue(meFixture([member("co-h")], [HOTEL], { userId: "u-2" }));
const manager = () => vi.mocked(getMe).mockResolvedValue(meFixture([{ role: "manager", scopeType: "company", scopeId: "co-h" }], [HOTEL], { userId: "u-3" }));
const main = () => document.body;

/** A number with a currency, either side: the page must never hold one (DW-D41). */
const CURRENCY = /(?:rp\.?|idr|usd|eur|\$|€|£)\s?\d|\d[\d.,]*\s?(?:rp|idr|usd|eur|rupiah|\$|€|£)/i;

beforeEach(() => {
  vi.mocked(readOutboundDetail).mockReset();
  vi.mocked(readOutboundFiles).mockReset();
  requester();
});

describe("the sender's page: what it says", () => {
  it("shows the ask, its status, who it was sent to ('<unit> · <company>'), the work's progress, the brief and the form as plain text", async () => {
    reads(wire());
    await mount();
    expect(screen.getAllByText("Reception banners").length).toBeGreaterThan(0);
    expect(screen.getByText("Sent to")).toBeInTheDocument();
    expect(screen.getByText("To Creatives · Gaia Digital Agency")).toBeInTheDocument();
    expect(screen.getByText("Front Office")).toBeInTheDocument();
    expect(screen.getByText("In progress. Responsible: Putu Rani")).toBeInTheDocument();
    expect(screen.getByText("Three banners for the front desk.")).toBeInTheDocument();
    expect(screen.getByText("3 x Image, 1920x1080")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.com/ref" })).toHaveAttribute("href", "https://example.com/ref");
    // An asset request has no price card.
    expect(screen.queryByText("Price")).toBeNull();
  });

  it("is a 404 for a request that is absent, or another person's, and says a refusal and a failure as themselves", async () => {
    reads("notfound");
    await expect(mount()).rejects.toThrow("notFound");
    vi.mocked(readOutboundDetail).mockResolvedValue({ kind: "forbidden" });
    vi.mocked(readOutboundFiles).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to this request\./)).toBeInTheDocument();
  });

  it("says a failed read is unavailable, never an empty page", async () => {
    vi.mocked(readOutboundDetail).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    vi.mocked(readOutboundFiles).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/This request cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText("The work")).toBeNull();
  });

  it("does not show the receiver's task, project or change-request ids anywhere", async () => {
    reads(wire({ work: { type: "pm_task", status: "new", isDone: false, responsibleName: null, id: "task-secret", projectId: "proj-secret" } }));
    await mount();
    expect(main().innerHTML).not.toMatch(/task-secret|proj-secret/);
  });
});

describe("the price state: words, never an amount (DW-D41)", () => {
  const names = (provider = "Gaia Digital Agency", requester = "Hotel") => ({ provider, requester });

  it.each([
    [{ impact: "unassessed", agreement: null }, "Not assessed yet"],
    [{ impact: "none", agreement: null }, "No price change"],
    [{ impact: "changes_price", agreement: "preparing" }, `${names().provider} is preparing a price agreement`],
    [{ impact: "changes_price", agreement: "awaiting_signature" }, `Waiting for ${names().requester}'s signature in ${names().provider}'s client portal`],
    [{ impact: "changes_price", agreement: "signed" }, "Price agreed"],
    [{ impact: "changes_price", agreement: "closed" }, `The price agreement was declined or withdrawn; ${names().provider} will re-assess`],
  ])("says %j as a sentence", async (price, sentence) => {
    reads(eng(price));
    await mount();
    const card = screen.getByText("Price").closest("section")!;
    expect(within(card).getByText(sentence)).toBeInTheDocument();
  });

  it("holds no number with a currency, even when the wire carries an amount, a currency and a contract", async () => {
    reads(eng({ impact: "changes_price", agreement: "signed", amount: 12_500_000, currency: "IDR", contractId: "ctr-1", value: "Rp 12.500.000", terms: "USD 800 per month" }));
    await mount();
    const text = main().textContent ?? "";
    expect(text).not.toMatch(CURRENCY);
    expect(text).not.toMatch(/12\.?500\.?000|ctr-1|800/);
    expect(screen.getByText("Price agreed")).toBeInTheDocument();
  });

  it("the guard has teeth: the currency pattern catches an amount if one ever reached the text", () => {
    for (const bad of ["Rp 12.500.000", "IDR 5000", "5000 IDR", "$800", "800 USD", "€ 10", "Rp5.000"]) expect(bad, bad).toMatch(CURRENCY);
    for (const fine of ["Price agreed", "Not assessed yet", "3 x Image, 1920x1080", "26 Oct 2026"]) expect(fine, fine).not.toMatch(CURRENCY);
  });

  it("says the price cannot be read when the wire's price is not one it knows", async () => {
    reads(eng({ impact: "enormous", agreement: null }));
    await mount();
    expect(screen.getByText("The price state cannot be read.")).toBeInTheDocument();
  });

  it("says the amounts are never shown here", async () => {
    reads(eng({ impact: "none", agreement: null }));
    await mount();
    expect(screen.getByText(/The amounts are never shown on this page\./)).toBeInTheDocument();
  });
});

describe("Cancel: offered, or not", () => {
  const cancelButton = () => screen.queryByRole("button", { name: "Cancel request" });

  it("is offered to the requester while an asset request is open", async () => {
    reads(wire());
    await mount();
    expect(cancelButton()).toBeInTheDocument();
  });

  it("is offered to the company's manager for another person's request", async () => {
    manager();
    reads(wire());
    await mount();
    expect(cancelButton()).toBeInTheDocument();
  });

  it("is not offered to a colleague who is neither the requester nor a manager", async () => {
    colleague();
    reads(wire());
    await mount();
    expect(cancelButton()).toBeNull();
  });

  it("is not offered once the request is closed", async () => {
    for (const status of ["delivered", "declined", "cancelled"]) {
      reads(wire({ status, closedAt: "2026-10-13T00:00:00Z" }));
      const r = await mount();
      expect(cancelButton(), status).toBeNull();
      r.unmount();
    }
  });

  it("is offered for an engineering request whose change request is new with no live agreement, and not while an agreement is live", async () => {
    reads(eng({ impact: "none", agreement: null }));
    const open = await mount();
    expect(cancelButton()).toBeInTheDocument();
    open.unmount();
    for (const agreement of ["preparing", "awaiting_signature", "signed"]) {
      reads(eng({ impact: "changes_price", agreement }));
      const r = await mount();
      expect(cancelButton(), agreement).toBeNull();
      r.unmount();
    }
    reads(eng({ impact: "changes_price", agreement: "closed" }));
    await mount();
    expect(cancelButton()).toBeInTheDocument();
  });
});

describe("assets and files", () => {
  it("lists the delivered assets with download links through the sender's proxy", async () => {
    reads(wire({ status: "delivered", closedAt: "2026-10-13T00:00:00Z", assetCount: 1, assets: [{ id: "a1", name: "banner.png", contentType: "image/png", href: "/api/co-agency/x" }] }));
    await mount();
    const card = screen.getByText("Delivered assets").closest("section")!;
    expect(within(card).getByText("banner.png")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/requests/outbound/x1/assets/a1");
  });

  it("says nothing has been delivered yet, rather than hiding the card", async () => {
    reads(wire());
    await mount();
    expect(screen.getByText("Nothing has been delivered yet.")).toBeInTheDocument();
  });

  it("lists the files with a download link through the sender's proxy, and opens a link row as a link", async () => {
    reads(wire(), "ok", [...files, { id: "f2", filename: "Drive brief", contentType: "", byteSize: null, createdAt: null, url: "https://drive.example/doc" }]);
    await mount();
    const card = screen.getByText("Files").closest("section")!;
    expect(within(card).getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/requests/outbound/x1/files/f1");
    expect(within(card).getByRole("link", { name: "Open link" })).toHaveAttribute("href", "https://drive.example/doc");
  });

  it("says the files could not be listed, not that there are none", async () => {
    reads(wire(), "unavailable");
    await mount();
    expect(screen.getByText(/This request's files cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText("No files are attached to this request.")).toBeNull();
  });

  it("says there are none only when the read answered", async () => {
    reads(wire(), "ok", []);
    await mount();
    expect(screen.getByText("No files are attached to this request.")).toBeInTheDocument();
  });
});
