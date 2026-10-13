import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ResultsView, RESULTS_EMPTY_COPY, RESULTS_HIDDEN_COPY, RESULTS_UNAVAILABLE_COPY } from "./ResultsView";
import { ClientCentreShell } from "./ClientCentreShell";
import { NOT_ENOUGH_DATA, NOT_MEASURED } from "./ServiceCard";
import { registry, findArea, findSection, type BusinessResults, type CentreProfile, type ResultsKpi, type ResultsServiceCard } from "@/lib/clientCentre";

vi.mock("next/navigation", () => ({ usePathname: () => "/clients/cl-1/profile" }));

// PV6-03 — every state of the Services & results part. THE TOOTH: a `null` figure must read "Not measured yet",
// never 0 (the "null KPI" tests below fail the moment ServiceCard renders null as a number).

const kpi = (over: Partial<ResultsKpi> & { key: string }): ResultsKpi => ({
  label: over.key, value: 10, unit: "count", period: { from: "2026-09-01", to: "2026-09-30" }, previous: 8, target: null, asOf: "2026-09-30", ...over,
});
const card = (over: Partial<ResultsServiceCard> = {}): ResultsServiceCard => ({
  service: "social", areaId: "mk_social", title: "Social media management", status: "active", since: "2026-03-01",
  items: [{ label: "Instagram", detail: "@acme" }], kpis: [kpi({ key: "followers", label: "Followers" })], clientVisible: true, ...over,
});
const results = (services: ResultsServiceCard[], over: Partial<BusinessResults> = {}): BusinessResults => ({
  clientId: "cl-1", generatedAt: "2026-10-13T00:00:00Z", visible: true, services, unavailable: [], ...over,
});
const social = findSection(registry, "hotel", "mk_social")!;
const marketing = findArea(registry, "hotel", "mk")!;

const view = (r: BusinessResults | null, over: { section?: typeof social; staff?: boolean; websiteHref?: string | null } = {}) =>
  render(<ResultsView section={over.section ?? social} results={r} showClientMarker={over.staff ?? false} websiteHref={over.websiteHref} />);

describe("ResultsView states", () => {
  it("a card shows the service, status, since, its items and each KPI with period", () => {
    const { container } = view(results([card()]));
    expect(screen.getByRole("heading", { name: "Social media management" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Since 2026-03-01")).toBeInTheDocument();
    expect(screen.getByText("Instagram")).toBeInTheDocument();
    expect(screen.getByText(/@acme/)).toBeInTheDocument();
    expect(screen.getByText("Followers")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("2026-09-01 to 2026-09-30")).toBeInTheDocument();
    expect(container.textContent).not.toContain(RESULTS_EMPTY_COPY);
  });

  it("🔴 a null KPI reads 'Not measured yet', never 0", () => {
    const { container } = view(results([card({ kpis: [kpi({ key: "engagement", label: "Engagement", value: null, previous: null })] })]));
    expect(screen.getByText(NOT_MEASURED)).toBeInTheDocument();
    expect(container.querySelector(".cc-kpi__value")?.textContent).toBe(NOT_MEASURED);
    expect(container.textContent).not.toMatch(/(^|\D)0(\D|$)/);
    // an unmeasured figure has no change line to claim
    expect(container.querySelector(".cc-kpi__change")).toBeNull();
  });

  it("a real zero is shown as 0 (and is not 'Not measured yet')", () => {
    view(results([card({ kpis: [kpi({ key: "conv", label: "Conversions", value: 0, previous: 12 })] })]));
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText(NOT_MEASURED)).not.toBeInTheDocument();
  });

  it("the change against the previous period is words: up, down, flat", () => {
    const { container } = view(results([card({ kpis: [
      kpi({ key: "a", value: 12, previous: 10 }),
      kpi({ key: "b", value: 7, previous: 10 }),
      kpi({ key: "c", value: 10, previous: 10 }),
    ] })]));
    const dir = (k: string) => container.querySelector(`[data-kpi="${k}"] .cc-kpi__change`);
    expect(dir("a")).toHaveTextContent("Up 2 on the previous period");
    expect(dir("b")).toHaveTextContent("Down 3 on the previous period");
    expect(dir("c")).toHaveTextContent("No change on the previous period");
  });

  it("no previous period reads 'Not enough data to compare' (not a change against 0)", () => {
    view(results([card({ kpis: [kpi({ key: "x", value: 40, previous: null })] })]));
    expect(screen.getByText(NOT_ENOUGH_DATA)).toBeInTheDocument();
    expect(screen.queryByText(/^Up /)).not.toBeInTheDocument();
  });

  it("a target is shown, met or missed (a lower search position is better)", () => {
    const { container } = view(results([card({ kpis: [
      kpi({ key: "met", value: 15000, target: 12000 }),
      kpi({ key: "missed", value: 9000, target: 12000 }),
      kpi({ key: "pos", value: 4.2, unit: "position", target: 3 }),
      kpi({ key: "none", value: 5, target: null }),
    ] })]));
    const t = (k: string) => container.querySelector(`[data-kpi="${k}"] .cc-kpi__target`);
    expect(t("met")).toHaveTextContent("Target 12,000 · target met");
    expect(t("missed")).toHaveTextContent("Target 12,000 · target missed");
    expect(t("pos")).toHaveTextContent("Target 3 · target missed");
    expect(t("none")).toBeNull();
  });

  it("a website card with no figures shows the card and its item, no numbers and no 'Not measured yet'", () => {
    const { container } = view(
      results([card({ service: "website", areaId: "mk_web", title: "Website", items: [{ label: "acme.example", detail: null }], kpis: [] })]),
      { section: findSection(registry, "hotel", "mk_web")! },
    );
    expect(screen.getByText("acme.example")).toBeInTheDocument();
    expect(container.querySelector(".cc-service__kpis")).toBeNull();
    expect(container.textContent).not.toContain(NOT_MEASURED);
  });

  it("the website card links to the Website tab only when given the link (a website editor); otherwise it is read-only", () => {
    const web = card({ service: "website", areaId: "mk_web", title: "Website", kpis: [] });
    const sec = findSection(registry, "hotel", "mk_web")!;
    const a = view(results([web]), { section: sec, websiteHref: "/portal/website" });
    expect(screen.getByRole("link", { name: "Open the Website tab" })).toHaveAttribute("href", "/portal/website");
    a.unmount();
    view(results([web]), { section: sec, websiteHref: null });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("`unavailable` shows one notice and is never an empty area; the cards that did load still show", () => {
    const only = view(results([], { unavailable: ["analytics"] }));
    expect(screen.getAllByText(RESULTS_UNAVAILABLE_COPY)).toHaveLength(1);
    expect(only.container.textContent).not.toContain(RESULTS_EMPTY_COPY);
    only.unmount();
    view(results([card()], { unavailable: ["search"] }));
    expect(screen.getAllByText(RESULTS_UNAVAILABLE_COPY)).toHaveLength(1);
    expect(screen.getByText("Social media management")).toBeInTheDocument();
  });

  it("a failed read (null) is the same notice, never the empty-area copy", () => {
    const { container } = view(null);
    expect(screen.getByText(RESULTS_UNAVAILABLE_COPY)).toBeInTheDocument();
    expect(container.textContent).not.toContain(RESULTS_EMPTY_COPY);
  });

  it("visible:false reads the shared-with-main-contacts sentence and nothing else", () => {
    const { container } = view(results([card()], { visible: false }));
    expect(container.textContent).toBe(RESULTS_HIDDEN_COPY);
  });

  it("an area with no card says we don't run a service there yet", () => {
    view(results([card()]), { section: findArea(registry, "hotel", "rs")! });
    expect(screen.getByText(RESULTS_EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByText("Social media management")).not.toBeInTheDocument();
  });

  it("Marketing rolls up its sub-areas' cards, grouped by sub-area", () => {
    const r = results([
      card(),
      card({ service: "search", areaId: "se", title: "Search engine optimisation" }),
      card({ service: "analytics", areaId: "mk_analytics", title: "Site analytics", status: "setting_up" }),
    ]);
    const { container } = view(r, { section: marketing });
    const groups = [...container.querySelectorAll(".cc-results-group")];
    // registry order of the sub-areas, not the payload's
    expect(groups.map((g) => g.querySelector("h3")?.textContent)).toEqual(["SEO, AEO & GEO", "Social Media", "Analytics & Reporting"]);
    for (const g of groups) expect(within(g as HTMLElement).getAllByRole("heading", { level: 4 })).toHaveLength(1);
  });

  it("staff see 'Client sees this' on every card; the portal never shows the marker", () => {
    const r = results([card(), card({ service: "search", areaId: "se", title: "SEO" })]);
    const staff = view(r, { section: marketing, staff: true });
    expect(staff.container.querySelectorAll('[data-visibility="client"]')).toHaveLength(2);
    staff.unmount();
    const portal = view(r, { section: marketing, staff: false });
    expect(portal.container.querySelector(".ch-vis")).toBeNull();
  });
});

// ── Through the shell: the part strip, and the counts on Home and the area header ─────────────────────
function profile(): CentreProfile {
  return {
    clientId: "cl-1", clientName: "Demo Harbour Hotel", clientStatus: "active", businessType: "hotel", profile: {}, connections: {},
    areas: {}, customConnections: {}, revision: 1, updatedAt: null, updatedBy: null, canEdit: true,
  };
}
const mount = (segments: string[], r: BusinessResults | null | undefined, isPortal = false) =>
  render(<ClientCentreShell clientId="cl-1" basePath="/clients/cl-1/profile" segments={segments} profile={profile()} isPortal={isPortal} patchAction={vi.fn()} results={r} />);

describe("Services & results through the shell", () => {
  it("the results part is the third link of the strip and is marked current", () => {
    mount(["mk_social", "results"], results([card()]));
    const strip = screen.getByRole("navigation", { name: "Social Media parts" });
    const links = [...strip.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["Setup", "Connections", "Services & results"]);
    expect(links[2].getAttribute("href")).toBe("/clients/cl-1/profile/mk_social/results");
    expect(links[2].getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Social media management" })).toBeInTheDocument();
  });

  it("Home counts the running services per area from the one read; a paused service does not count", () => {
    const r = results([card(), card({ service: "search", areaId: "se" }), card({ service: "search_ads", areaId: "mk_paid", status: "paused" })]);
    const { container } = mount([], r);
    const mk = [...container.querySelectorAll("a.cc-area-card")].find((a) => a.textContent?.startsWith("Marketing"))!;
    expect(mk.textContent).toContain("2 services running");
    const rs = [...container.querySelectorAll("a.cc-area-card")].find((a) => a.textContent?.startsWith("Reservations"))!;
    expect(rs.textContent).toContain("0 services running");
  });

  it("Home says nothing about services when there is no read, or the portal contact may not see them", () => {
    const a = mount([], undefined);
    expect(a.container.textContent).not.toMatch(/services? running/);
    a.unmount();
    const b = mount([], results([card()], { visible: false }), true);
    expect(b.container.textContent).not.toMatch(/services? running/);
    b.unmount();
    const c = mount([], null);
    expect(c.container.textContent).not.toMatch(/services? running/);
  });

  it("the area header counts the services running there", () => {
    mount(["mk", "results"], results([card(), card({ service: "search", areaId: "se" })]));
    expect(screen.getByText(/2 services running/)).toBeInTheDocument();
  });

  it("the Setup part does not render results (the page does not fetch them either)", () => {
    const { container } = mount(["mk_social"], undefined);
    expect(container.querySelector(".cc-results")).toBeNull();
    expect(container.textContent).not.toMatch(/services? running/);
  });
});
