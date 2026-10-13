import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ClientCentreShell } from "./ClientCentreShell";
import type { CentreProfile } from "@/lib/clientCentre";

vi.mock("next/navigation", () => ({ usePathname: () => "/clients/cl-1/profile" }));

function makeProfile(overrides: Partial<CentreProfile> = {}): CentreProfile {
  return {
    clientId: "cl-1",
    clientName: "Demo Harbour Hotel",
    clientStatus: "active",
    businessType: "hotel",
    profile: { trading: "Demo Harbour Hotel", description: "A boutique waterfront hotel." },
    connections: { pms: { status: "Connected", account: "harbour-42" } },
    areas: {},
    customConnections: {},
    revision: 1,
    updatedAt: null,
    updatedBy: null,
    canEdit: true,
    ...overrides,
  };
}

describe("ClientCentreShell", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("renders Home by default: client name, description lede, and Business area cards", () => {
    const patchAction = vi.fn();
    render(
      <ClientCentreShell clientId="cl-1" basePath="/clients/cl-1/profile" segments={[]} profile={makeProfile()} isPortal={false} patchAction={patchAction} />,
    );
    expect(screen.getByRole("heading", { name: "Demo Harbour Hotel" })).toBeInTheDocument();
    expect(screen.getByText("A boutique waterfront hotel.")).toBeInTheDocument();
    // The industry area for "hotel" ("Hotel Operations") plus the fixed Business areas — appear
    // twice each (tree + area card), so assert presence rather than uniqueness.
    expect(screen.getAllByText("Hotel Operations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reservations").length).toBeGreaterThan(0);
  });

  it("renders Business details: business type select, Business area toggles, read-only client name", () => {
    const patchAction = vi.fn();
    render(
      <ClientCentreShell
        clientId="cl-1" basePath="/clients/cl-1/profile" segments={["company"]} profile={makeProfile()} isPortal={false}
        patchAction={patchAction}
      />,
    );
    // CC-D9: "Business details", never "Company settings" — "company" is the ERP's own group company.
    expect(screen.getByRole("heading", { name: "Business details" })).toBeInTheDocument();
    expect(screen.queryByText(/company settings/i)).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Hotel / villa / accommodation")).toBeInTheDocument();
    // CC-D8: the view sits inside the client hub, so there is no "Edit in Clients" link; the help text
    // points at the hub header's Edit button, which is where the name is changed.
    expect(screen.queryByRole("link", { name: /in Clients/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Change it with Edit/i)).toBeInTheDocument();
    // CC-D5: the client name itself is read-only everywhere, never an input.
    expect(screen.getByText("Demo Harbour Hotel", { selector: ".cc-readonly-value" })).toBeInTheDocument();
  });

  it("read-only banner names the reason and who to ask, differently for staff vs the portal", () => {
    const patchAction = vi.fn();
    const { rerender } = render(
      <ClientCentreShell clientId="cl-1" basePath="/clients/cl-1/profile" segments={[]} profile={makeProfile({ canEdit: false })} isPortal={false} patchAction={patchAction} />,
    );
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    rerender(
      <ClientCentreShell clientId="cl-1" basePath="/portal/company" segments={[]} profile={makeProfile({ canEdit: false })} isPortal={true} patchAction={patchAction} />,
    );
    expect(screen.getByText(/ask your account manager/i)).toBeInTheDocument();
  });

  it("a read-only viewer sees values but no inputs on Business details", () => {
    const patchAction = vi.fn();
    render(
      <ClientCentreShell clientId="cl-1" basePath="/clients/cl-1/profile" segments={["company"]} profile={makeProfile({ canEdit: false })} isPortal={false} patchAction={patchAction} />,
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByText("Demo Harbour Hotel").length).toBeGreaterThan(0);
  });

  it("autosaves an edit ~600ms after the last keystroke, sending only the changed key, then flashes Saved", async () => {
    const patchAction = vi.fn().mockResolvedValue({ ok: true, profile: makeProfile({ profile: { trading: "New Name" } }) });
    const { container } = render(
      <ClientCentreShell
        clientId="cl-1" basePath="/clients/cl-1/profile" segments={["rs"]} profile={makeProfile()} isPortal={false}
        patchAction={patchAction}
      />,
    );
    const input = container.querySelector<HTMLInputElement>("#cc-field-trading")!;
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "New Name" } });
    expect(patchAction).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(patchAction).toHaveBeenCalledTimes(1);
    expect(patchAction).toHaveBeenCalledWith("cl-1", { profile: { trading: "New Name" } });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("does not autosave at all for a read-only viewer", async () => {
    const patchAction = vi.fn();
    const { container } = render(
      <ClientCentreShell
        clientId="cl-1" basePath="/clients/cl-1/profile" segments={["rs"]} profile={makeProfile({ canEdit: false })} isPortal={false}
        patchAction={patchAction}
      />,
    );
    // Read-only: no text input for a registry field, only the plain value.
    expect(container.querySelector("#cc-field-trading")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(patchAction).not.toHaveBeenCalled();
  });

  it("surfaces the server's error message and field on a failed save, and leaves the retry pending", async () => {
    const patchAction = vi.fn().mockResolvedValue({ ok: false, error: "trading looks like it contains a credential", field: "profile.trading" });
    const { container } = render(
      <ClientCentreShell
        clientId="cl-1" basePath="/clients/cl-1/profile" segments={["rs"]} profile={makeProfile()} isPortal={false}
        patchAction={patchAction}
      />,
    );
    const input = container.querySelector<HTMLInputElement>("#cc-field-trading")!;
    fireEvent.change(input, { target: { value: "sk-leaked-secret-value" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByRole("alert")).toHaveTextContent("trading looks like it contains a credential");
  });
});

// ── PV6-01: Business areas replace departments; the placeholder pages go ─────────────────────────────
describe("Business areas (PV6-01)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const mount = (segments: string[], over: Partial<CentreProfile> = {}, base = "/clients/cl-1/profile") =>
    render(<ClientCentreShell clientId="cl-1" basePath={base} segments={segments} profile={makeProfile(over)} isPortal={false} patchAction={vi.fn()} />);

  it("Home says Business areas, the tree is labelled Business areas, and no card says 'N areas' or 'Not set up yet'", () => {
    const { container } = mount([]);
    expect(screen.getByRole("heading", { name: "Business areas" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Business areas" })).toBeInTheDocument();
    expect(screen.getByText(/Turn business areas on or off/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d+ areas/);
    expect(container.textContent).not.toMatch(/not set up yet/i);
    expect(container.textContent).not.toMatch(/department/i);
    // each card carries how much of that area is set up
    const card = [...container.querySelectorAll("a.cc-area-card")].find((a) => a.textContent?.startsWith("Reservations"))!;
    expect(card.textContent).toMatch(/\d+ of \d+ fields · \d+ of \d+ connected/);
  });

  it("an area page has a header, a stats line, and a Setup / Connections strip with aria-current on the open part", () => {
    mount(["rs"]);
    expect(screen.getByRole("heading", { level: 2, name: "Reservations" })).toBeInTheDocument();
    expect(screen.getByText(/\d+ of \d+ setup fields completed · \d+ of \d+ connections connected/)).toBeInTheDocument();
    const strip = screen.getByRole("navigation", { name: "Reservations parts" });
    const links = [...strip.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")])).toEqual([
      ["Setup", "/clients/cl-1/profile/rs", "page"],
      ["Connections", "/clients/cl-1/profile/rs/connections", null],
    ]);
    // the tree marks the open area
    expect(screen.getAllByRole("link", { name: "Reservations" }).some((a) => a.getAttribute("aria-current") === "page")).toBe(true);
  });

  it("Setup lists the area's fields; Connections lists its connections and the no-credentials callout, not the fields", () => {
    const { container, unmount } = mount(["rs"]);
    expect(container.querySelector("#cc-field-trading")).toBeInTheDocument();
    expect(screen.queryByText(/Don't enter passwords/)).not.toBeInTheDocument();
    unmount();
    const c2 = mount(["rs", "connections"]);
    expect(screen.getByText(/Don't enter passwords, API keys or card numbers/)).toBeInTheDocument();
    expect(c2.container.querySelectorAll("details.cc-conn").length).toBeGreaterThan(0);
    expect(c2.container.querySelector("#cc-field-trading")).not.toBeInTheDocument();
    const strip = screen.getByRole("navigation", { name: "Reservations parts" });
    expect(strip.querySelector('a[aria-current="page"]')?.textContent).toBe("Connections");
  });

  it("🔴 a hotel's industry area `ix` Setup lists its 9 Hotel Operations fields (it used to show 0 of 0)", () => {
    const { container } = mount(["ix"]);
    expect(screen.getByRole("heading", { level: 2, name: "Hotel Operations" })).toBeInTheDocument();
    for (const k of ["rooms", "rating", "checkin", "adr", "seasonality", "capacity", "hours", "gm", "reviews"]) {
      expect(container.querySelector(`#cc-field-${k}`), k).toBeInTheDocument();
    }
    expect(screen.getByText(/\d+ of 9 setup fields completed · 1 of 9 connections connected/)).toBeInTheDocument(); // pms is Connected
  });

  it("an industry-area connection row appears on `ix` Connections", () => {
    const { container } = mount(["ix", "connections"]);
    expect(container.querySelectorAll("details.cc-conn")).toHaveLength(9);
  });

  it("Marketing lists its 19 sub-areas as cards above the strip; a sub-area page has a breadcrumb through Marketing", () => {
    const { container, unmount } = mount(["mk"]);
    const cards = container.querySelectorAll(".cc-area-grid--sub a.cc-area-card");
    expect(cards).toHaveLength(19);
    expect(cards[0].getAttribute("href")).toBe("/clients/cl-1/profile/mk_strat");
    const position = container.querySelector(".cc-area-grid--sub")!.compareDocumentPosition(screen.getByRole("navigation", { name: "Marketing parts" }));
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    const sub = mount(["se"]);
    expect(sub.container.querySelector(".cc-crumb")?.textContent).toBe("Demo Harbour HotelMarketingSEO, AEO & GEO");
    expect(sub.container.querySelector(".cc-area-grid--sub")).toBeNull(); // only Marketing itself lists them
  });

  it("only Marketing carries a sub-area toggle in the tree; opening it lists the 19 sub-areas as links", () => {
    mount([]);
    expect(screen.getAllByRole("button", { name: /sub-areas/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Toggle Marketing sub-areas" }));
    expect(screen.getByRole("navigation", { name: "Business areas" }).querySelectorAll(".cc-tree__children a")).toHaveLength(19);
  });

  it("🔴 no 'Coming soon' page exists: no route renders one, and the old leaf/settings tails are not views", () => {
    for (const segs of [["rs"], ["rs", "connections"], ["mk"], ["se"], ["ix"], ["rs", "settings"], ["rs", "3"], ["mk", "12"], []]) {
      const { container, unmount } = mount(segs);
      expect(container.textContent, segs.join("/")).not.toMatch(/coming soon|being built/i);
      unmount();
    }
  });

  it("the Business details toggle reads as Business areas, with the documented help line", () => {
    mount(["company"]);
    expect(screen.getByRole("heading", { name: "Business areas" })).toBeInTheDocument();
    expect(screen.getByText("Choose which business areas this business uses. The first one is specific to your business type.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Hotel Operations" })).toBeChecked();
  });

  it("toggling a Business area autosaves `areas`, never `departments`", async () => {
    const patchAction = vi.fn().mockResolvedValue({ ok: true, profile: makeProfile({ areas: { rs: false } }) });
    render(<ClientCentreShell clientId="cl-1" basePath="/clients/cl-1/profile" segments={["company"]} profile={makeProfile()} isPortal={false} patchAction={patchAction} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Reservations" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(patchAction).toHaveBeenCalledWith("cl-1", { areas: { rs: false } });
  });

  it("works on the portal base path too", () => {
    mount(["rs", "connections"], {}, "/portal/company");
    const strip = screen.getByRole("navigation", { name: "Reservations parts" });
    expect(strip.querySelector("a")?.getAttribute("href")).toBe("/portal/company/rs");
  });
});

describe("the word 'department' is not on the Business surface (PV6-01 finding 4)", () => {
  it("no component in this folder says it", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir).filter((f) => !/\.test\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(dir + f, "utf8"), f).not.toMatch(/department/i);
  });
});
