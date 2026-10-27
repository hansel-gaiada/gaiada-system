import { describe, expect, it } from "vitest";
import { ballHeadline, ballItemHref, ballItemLabel } from "./portal";
import { portalResultsHeadline, type BusinessResults, type ResultsKpi, type ResultsServiceCard } from "./clientCentre";

// PV7-03 — the portal's wording of a waiting item, where it links, and the results headline's selection rule.

describe("ballItemLabel", () => {
  it("words each kind for the side it sits on, in the client's terms", () => {
    expect(ballItemLabel("gate", "you")).toBe("An approval for you");
    expect(ballItemLabel("contract", "you")).toBe("An agreement to sign");
    expect(ballItemLabel("review", "you")).toBe("A post to review");
    expect(ballItemLabel("payment", "us")).toBe("A payment we are confirming");
    expect(ballItemLabel("review", "us")).toBe("A post we are changing for you");
    expect(ballItemLabel("request", "us")).toBe("A change request we have not picked up yet");
    expect(ballItemLabel("conversation", "us")).toBe("A message waiting for our reply");
  });
  it("an unknown kind (a newer server) still reads as a waiting item, never blank", () => {
    expect(ballItemLabel("hologram", "you")).toBe("Something waiting for you");
    expect(ballItemLabel("hologram", "us")).toBe("Something waiting for us");
  });
  it("SCP-2: a social_post item is a post to review, or one we are changing when the item says changes were asked; never a staff status", () => {
    expect(ballItemLabel("social_post", "you")).toBe("A post to review");
    expect(ballItemLabel("social_post", "you", "Studio tour")).toBe("A post to review");
    expect(ballItemLabel("social_post", "you", "changes_asked")).toBe("A post we are changing for you");
    expect(ballItemLabel("social_post", "us")).toBe("A post we are changing for you");
  });
  it("never uses staff phrasing", () => {
    for (const kind of ["gate", "contract", "review", "social_post", "payment", "request", "conversation"]) {
      for (const side of ["you", "us"] as const) expect(ballItemLabel(kind, side)).not.toMatch(/triage|client-recorded|drafted|staff/i);
    }
  });
});

describe("ballItemHref", () => {
  it("links only where the payload's id is the right id", () => {
    // A gate id is not a run id, so a gate links to the approvals list, never to /approvals/<gate id>.
    expect(ballItemHref("gate", "g-1")).toBe("/portal/approvals");
    expect(ballItemHref("contract", "ctr-1")).toBe("/portal/contracts/ctr-1");
    expect(ballItemHref("review", "rv-1")).toBe("/portal/social-reviews/rv-1");
    expect(ballItemHref("conversation", "th-1")).toBe("/portal/conversation/th-1");
    // SCP-2: a post opens the approval page at that post (the id is the post's id), encoded
    expect(ballItemHref("social_post", "soc-post-n-3")).toBe("/portal/social?post=soc-post-n-3");
    expect(ballItemHref("social_post", "a/b c")).toBe("/portal/social?post=a%2Fb%20c");
    // A request has no page of its own; a payment id is not an invoice id.
    expect(ballItemHref("request", "cr-1")).toBe("/portal/requests");
    expect(ballItemHref("payment", "pay-1")).toBe("/portal/invoices");
  });
  it("encodes the id and gives no link for an unknown kind", () => {
    expect(ballItemHref("contract", "a/b c")).toBe("/portal/contracts/a%2Fb%20c");
    expect(ballItemHref("hologram", "x")).toBeNull();
  });
});

describe("ballHeadline", () => {
  it("says the count and the oldest date, or 'nothing'", () => {
    expect(ballHeadline("you", { count: 2, oldestSince: "2026-10-12T08:00:00.000Z", items: [] })).toBe("Waiting on you: 2, oldest since 12 Oct 2026");
    expect(ballHeadline("us", { count: 1, oldestSince: null, items: [] })).toBe("Waiting on us: 1");
    expect(ballHeadline("us", { count: 0, oldestSince: null, items: [] })).toBe("Waiting on us: nothing");
  });
});

const kpi = (key: string, label: string, value: number | null): ResultsKpi => ({
  key, label, value, unit: "count", period: { from: "2026-09-01", to: "2026-09-30" }, previous: null, target: null, asOf: null,
});
const card = (service: ResultsServiceCard["service"], status: ResultsServiceCard["status"], kpis: ResultsKpi[], areaId: string = service): ResultsServiceCard => ({
  service, areaId, title: `${service} card`, status, since: null, items: [], kpis, clientVisible: true,
});
const results = (services: ResultsServiceCard[]): BusinessResults => ({ clientId: "cl-1", generatedAt: "2026-10-13T00:00:00Z", visible: true, services, unavailable: [] });

describe("portalResultsHeadline", () => {
  it("takes the FIRST KPI of each ACTIVE card, in payload order, at most four", () => {
    const r = results([
      card("social", "active", [kpi("followers", "Followers", 100), kpi("reach", "Reach", 5)]),
      card("search", "paused", [kpi("avg_position", "Position", 4)]),
      card("analytics", "active", [kpi("sessions", "Sessions", 9)]),
      card("website", "active", []),
      card("search_ads", "active", [kpi("clicks", "Clicks", 3)], "mk_paid"),
    ]);
    expect(portalResultsHeadline(r).map((h) => h.kpi.key)).toEqual(["followers", "sessions", "clicks"]);
    const many = results(Array.from({ length: 6 }, (_, i) => card("social", "active", [kpi(`k${i}`, `K${i}`, i)], `a${i}`)));
    expect(portalResultsHeadline(many)).toHaveLength(4);
    expect(portalResultsHeadline(many).map((h) => h.kpi.key)).toEqual(["k0", "k1", "k2", "k3"]);
  });

  it("🔴 never headlines search_ads.conversion_value: it is skipped for the card's next figure, or dropped", () => {
    const next = results([card("search_ads", "active", [kpi("conversion_value", "Conversion value", 18450), kpi("clicks", "Clicks", 3150)], "mk_paid")]);
    expect(portalResultsHeadline(next).map((h) => h.kpi.key)).toEqual(["clicks"]);
    const only = results([card("search_ads", "active", [kpi("conversion_value", "Conversion value", 18450)], "mk_paid")]);
    expect(portalResultsHeadline(only)).toEqual([]);
    // The ban is for search_ads: another service's figure of the same key is not touched.
    const other = results([card("analytics", "active", [kpi("conversion_value", "Value", 1)])]);
    expect(portalResultsHeadline(other)).toHaveLength(1);
  });

  it("keeps an unmeasured KPI as null (the page says 'Not measured yet', never 0)", () => {
    const r = results([card("social", "active", [kpi("engagement_rate", "Engagement rate", null)])]);
    expect(portalResultsHeadline(r)[0].kpi.value).toBeNull();
  });
});
