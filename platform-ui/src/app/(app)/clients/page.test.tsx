import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// PV3-04: the Clients list's review filter, "Business type: Other or not set", is built on the profile list
// the page already loads. What is pinned: the filter selects exactly the Other / not-set clients; a profile
// read that FAILS shows a refusal and withholds the filter, and never reads as "nobody has a type set".

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/rbac", () => ({ can: vi.fn(() => false) }));
vi.mock("@/lib/entities", () => ({ listClients: vi.fn() }));
vi.mock("@/lib/clientCentre-data", () => ({ listClientCentres: vi.fn() }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/components/BackendPending", () => ({ BackendPending: () => null }));
vi.mock("./ClientsTable", () => ({
  ClientsTable: ({ rows }: { rows: Record<string, unknown>[] }) => (
    <ul data-testid="rows">{rows.map((r) => <li key={String(r.id)}>{String(r.name)} | {String(r.businessType)} | {String(r.groupCompany)} | {String(r.badge)}</li>)}</ul>
  ),
}));

import { listClients } from "@/lib/entities";
import { listClientCentres } from "@/lib/clientCentre-data";
import ClientsPage from "./page";

const client = (id: string, name: string, groupCompany: { id: string; name: string } | null = null, isInternal = false) =>
  ({ id, name, contact: {}, status: "active", custom_fields: {}, owner_name: null, groupCompany, isInternal });
const centre = (clientId: string, businessType: string) => ({
  clientId, clientName: clientId, clientStatus: "active", businessType, city: null,
  fieldsFilled: { filled: 1, total: 10 }, connectionsConnected: { connected: 0, total: 3 }, updatedAt: null,
});
const mount = async (search: Record<string, string> = {}) => render(await ClientsPage({ searchParams: Promise.resolve(search) }));
const rowsText = () => [...screen.getByTestId("rows").querySelectorAll("li")].map((li) => li.textContent ?? "");

beforeEach(() => {
  vi.mocked(listClients).mockReset();
  vi.mocked(listClientCentres).mockReset();
  vi.mocked(listClients).mockResolvedValue([
    client("a", "Alpha Hotel"), client("b", "Beta Misc"), client("c", "Gamma Spa"), client("d", "Delta Sibling", { id: "co-sib", name: "Sibling Co" }),
  ] as never);
});

describe("Clients list · business type review (PV3-04)", () => {
  it("shows a chip with the count of Other or not-set clients, and the group company beside each client", async () => {
    vi.mocked(listClientCentres).mockResolvedValue([centre("a", "hotel"), centre("b", "other"), centre("c", "spa"), centre("d", "other")] as never);
    await mount();
    expect(rowsText()).toHaveLength(4);
    expect(rowsText().find((t) => t.startsWith("Delta"))).toContain("Sibling Co");
    const chip = screen.getByRole("link", { name: /Business type: Other or not set/ });
    expect(chip.textContent).toContain("2");
    expect(chip.getAttribute("href")).toBe("/clients?review=business-type");
  });

  it("🔴 ?review=business-type lists exactly the Other / not-set clients", async () => {
    vi.mocked(listClientCentres).mockResolvedValue([centre("a", "hotel"), centre("b", "other"), centre("c", "spa"), centre("d", "other")] as never);
    await mount({ review: "business-type" });
    expect(rowsText().map((t) => t.split(" | ")[0])).toEqual(["Beta Misc", "Delta Sibling"]);
    // The active chip links back to the unfiltered list.
    expect(screen.getByRole("link", { name: /Business type: Other or not set/ }).getAttribute("href")).toBe("/clients");
  });

  it("when every client has a type the filter says so, rather than drawing an empty table", async () => {
    vi.mocked(listClientCentres).mockResolvedValue([centre("a", "hotel"), centre("b", "retail"), centre("c", "spa"), centre("d", "agency")] as never);
    await mount({ review: "business-type" });
    expect(screen.queryByTestId("rows")).toBeNull();
    expect(screen.getByText(/Every client in this view has a business type/)).toBeTruthy();
  });

  it("🔴 a profile read that THROWS shows a refusal, withholds the filter, and keeps the list whole", async () => {
    vi.mocked(listClientCentres).mockRejectedValue(new Error("503 upstream"));
    await mount({ review: "business-type" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/could not be read/);
    expect(alert.textContent).toContain("503 upstream");
    expect(screen.queryByRole("link", { name: /Other or not set/ })).toBeNull();
    // The filter was requested, but a refused read must not narrow (or empty) the list.
    expect(rowsText()).toHaveLength(4);
  });

  it("🔴 an EMPTY profile list for a company that has clients is a refusal too, not 'no client has a type'", async () => {
    vi.mocked(listClientCentres).mockResolvedValue([] as never);
    await mount({ review: "business-type" });
    expect(screen.getByRole("alert").textContent).toMatch(/came back empty/);
    expect(screen.queryByRole("link", { name: /Other or not set/ })).toBeNull();
    expect(rowsText()).toHaveLength(4);
  });
});

describe("Clients list · the internal sentinel client (WSK-D36)", () => {
  const withInternal = () =>
    vi.mocked(listClients).mockResolvedValue([
      client("a", "Alpha Hotel"), client("b", "Beta Misc"), client("int", "Gaiada Internal", null, true),
    ] as never);

  it("🔴 shows the internal client with an 'Internal (our own sites)' badge, and no badge on any other row", async () => {
    withInternal();
    vi.mocked(listClientCentres).mockResolvedValue([centre("a", "hotel"), centre("b", "other")] as never);
    await mount();
    const rows = rowsText();
    expect(rows).toHaveLength(3);
    expect(rows.find((t) => t.startsWith("Gaiada Internal"))).toMatch(/\| Internal \(our own sites\)$/);
    expect(rows.filter((t) => t.includes("Internal (our own sites)"))).toHaveLength(1);
  });

  it("🔴 the review filter leaves the internal client out, even when the profile list calls it Other", async () => {
    withInternal();
    // The backend's centre list normally omits the sentinel; this proves the UI does not rely on that.
    vi.mocked(listClientCentres).mockResolvedValue([centre("a", "hotel"), centre("b", "other"), centre("int", "other")] as never);
    await mount({ review: "business-type" });
    expect(rowsText().map((t) => t.split(" | ")[0])).toEqual(["Beta Misc"]);
  });

  it("🔴 the review chip's count does not include the internal client", async () => {
    withInternal();
    vi.mocked(listClientCentres).mockResolvedValue([centre("a", "hotel"), centre("b", "other"), centre("int", "other")] as never);
    await mount();
    expect(screen.getByRole("link", { name: /Business type: Other or not set/ }).textContent).toContain("1");
    // Still listed in the unfiltered list, so staff can reach it.
    expect(rowsText().map((t) => t.split(" | ")[0])).toContain("Gaiada Internal");
  });
});
