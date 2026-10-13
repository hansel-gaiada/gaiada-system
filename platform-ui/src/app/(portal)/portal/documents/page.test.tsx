import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { DocumentItem } from "@/lib/documents";

// PV5-08 — the portal Documents page, rendered as the server renders it. Pins: newest-first order is the backend's
// (the page does not re-sort), every download goes through the portal's OWN file route, a document being prepared says
// so in words (and an unsealed original is labelled as such), and a failed read is never shown as "no documents".

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind" })) }));
vi.mock("@/lib/portal-data", () => ({ listPortalDocuments: vi.fn() }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: () => null }));

import { listPortalDocuments } from "@/lib/portal-data";
import PortalDocumentsPage from "./page";

const listMock = vi.mocked(listPortalDocuments);
const mount = async (items: DocumentItem[] | null) => {
  listMock.mockResolvedValue(items);
  render(await PortalDocumentsPage());
};

const DOCS: DocumentItem[] = [
  { id: "i1", kind: "invoice", title: "INV/2026/0007", date: "2026-10-10T08:00:00Z", fileId: "f-inv", ready: true },
  { id: "k1", kind: "signed_contract", title: "Master agreement", date: "2026-10-05T08:00:00Z", fileId: "f-sealed", ready: true },
  { id: "k2", kind: "signed_contract", title: "Campaign SOW", date: "2026-10-04T08:00:00Z", fileId: "f-orig", ready: false },
  { id: "k3", kind: "signed_contract", title: "Body-only agreement", date: "2026-10-03T08:00:00Z", fileId: null, ready: false },
  { id: "p1", kind: "receipt", title: "Payment proof, INV/2026/0007", date: "2026-10-02", fileId: "f-proof", ready: true },
];

beforeEach(() => listMock.mockReset());

describe("portal Documents page", () => {
  it("lists every document in the backend's order, with its kind and date", async () => {
    await mount(DOCS);
    expect(screen.getByRole("heading", { level: 1, name: "Documents" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("INV/2026/0007");
    expect(rows[1]).toHaveTextContent("Master agreement");
    expect(rows[2]).toHaveTextContent("Campaign SOW");
    expect(rows[3]).toHaveTextContent("Body-only agreement");
    expect(rows[4]).toHaveTextContent("Payment proof, INV/2026/0007");
    expect(within(rows[0]).getByText(/Invoice · 10 Oct 2026/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Signed agreement · 05 Oct 2026/)).toBeInTheDocument();
    expect(within(rows[4]).getByText(/Payment receipt · 02 Oct 2026/)).toBeInTheDocument();
  });

  it("every download goes through the portal file route, never the staff one", async () => {
    await mount(DOCS);
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/api/northwind/portal/files/f-inv",
      "/api/northwind/portal/files/f-sealed",
      "/api/northwind/portal/files/f-orig",
      "/api/northwind/portal/files/f-proof",
    ]);
    for (const a of links) expect(a.getAttribute("href")).not.toMatch(/^\/api\/files\//);
  });

  it("a signed agreement still being sealed says so and links the unsealed original; with no file it has no link", async () => {
    await mount(DOCS);
    expect(screen.getByRole("link", { name: /Download the original \(not yet sealed\): Campaign SOW/ })).toBeInTheDocument();
    expect(screen.getByText(/The sealed copy is being prepared/)).toBeInTheDocument();
    expect(screen.getByText(/The signed copy is being prepared/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Body-only agreement/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Download: Master agreement" })).toBeInTheDocument();
  });

  it("an empty list is an honest 'no documents yet'", async () => {
    await mount([]);
    expect(screen.getByText(/No documents yet/)).toBeInTheDocument();
  });

  it("a failed read says it could not load, and is never shown as an empty list", async () => {
    await mount(null);
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText(/No documents yet/)).toBeNull();
  });
});
