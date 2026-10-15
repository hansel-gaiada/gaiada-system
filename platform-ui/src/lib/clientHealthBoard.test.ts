import { describe, it, expect } from "vitest";
import type { ClientHealthRow, ClientHealthSignals, HealthReasonCode, HealthState } from "./clientHealth";
import {
  BOARD_COLUMNS, NO_OWNER, SHORT_REASON, STATE_ORDER, ageInDays, agedCell, dueCell, filterBoard, healthBoardCells, healthBoardHref,
  healthRank, isHealthState, lateWorkCell, ownerOptions, shortReasons, siteCell, sortWorstFirst, stateOptions, unavailableSentence,
} from "./clientHealthBoard";

const ASOF = "2026-10-15T12:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(ASOF) - n * 86_400_000).toISOString();

const SIGNALS: ClientHealthSignals = {
  waitingOnUs: { count: 0, oldestSince: null }, waitingOnClient: { count: 0, oldestSince: null },
  lateDeliverables: { count: 0, oldestDue: null }, lateMilestones: { count: 0, oldestDue: null },
  openChangeRequests: 0, conversationsAwaitingReply: 0, overdueInvoices: { count: 0, oldestDue: null },
  site: { openIncidents: 0, oldestOpenSince: null, uptime30d: 100 }, deliveryOnTime: 1, activeProjects: 1, activeServices: 0,
};
const row = (name: string, state: HealthState, over: Partial<ClientHealthSignals> = {}, owner: [string, string] | null = null): ClientHealthRow => ({
  clientId: `id-${name}`, name, status: "active", ownerUserId: owner?.[0] ?? null, ownerName: owner?.[1] ?? null,
  state, reasons: [], signals: { ...SIGNALS, ...over },
});

describe("PV7-05 · the order, worst first", () => {
  it("is off track, at risk, unknown, on track, quiet", () => {
    expect(STATE_ORDER).toEqual(["off_track", "at_risk", "unknown", "on_track", "quiet"]);
    expect(STATE_ORDER.map(healthRank)).toEqual([0, 1, 2, 3, 4]);
  });

  it("sorts by state, then the oldest thing waiting on us, then the name", () => {
    const rows = [
      row("Quiet", "quiet"), row("OnTrack", "on_track"), row("Unknown", "unknown"),
      row("AtRiskB", "at_risk", { waitingOnUs: { count: 1, oldestSince: daysAgo(8) } }),
      row("AtRiskA", "at_risk", { waitingOnUs: { count: 1, oldestSince: daysAgo(9) } }),
      row("AtRiskNone", "at_risk"),
      row("OffOld", "off_track", { waitingOnUs: { count: 2, oldestSince: daysAgo(20) } }),
      row("OffNew", "off_track", { waitingOnUs: { count: 1, oldestSince: daysAgo(15) } }),
    ];
    expect(sortWorstFirst(rows, ASOF).map((r) => r.name)).toEqual(
      ["OffOld", "OffNew", "AtRiskA", "AtRiskB", "AtRiskNone", "Unknown", "OnTrack", "Quiet"],
    );
  });

  it("does not mutate its input", () => {
    const rows = [row("B", "quiet"), row("A", "off_track")];
    sortWorstFirst(rows, ASOF);
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
  });
});

describe("PV7-05 · the words", () => {
  it("every reason code has short words, and a reason list reads as a line", () => {
    const codes: HealthReasonCode[] = [
      "waiting_on_us_7d", "waiting_on_us_14d", "waiting_on_client_14d", "late_work", "late_work_14d", "invoice_overdue",
      "invoice_overdue_30d", "site_incident_open", "site_incident_open_24h", "no_active_work", "source_unavailable",
    ];
    expect(Object.keys(SHORT_REASON).sort()).toEqual([...codes].sort());
    expect(shortReasons([{ code: "late_work", count: 2, since: null }, { code: "invoice_overdue", count: 1, since: null }])).toBe("Late work · Invoice overdue");
  });

  it("a null signal is a dash and a real zero is None (an empty list is a claim)", () => {
    expect(agedCell(null, ASOF)).toBe("—");
    expect(agedCell({ count: 0, oldestSince: null }, ASOF)).toBe("None");
    expect(agedCell({ count: 3, oldestSince: daysAgo(9) }, ASOF)).toBe("3 · oldest 9 days");
    expect(agedCell({ count: 1, oldestSince: daysAgo(1) }, ASOF)).toBe("1 · oldest 1 day");
    expect(dueCell(null, ASOF)).toBe("—");
    expect(dueCell({ count: 2, oldestDue: "2026-10-05" }, ASOF)).toBe("2 · 10 days late");
  });

  it("late work adds deliverables and milestones; one failed read with nothing from the other is a dash, not None", () => {
    const base = row("X", "at_risk");
    const cell = (d: ClientHealthSignals["lateDeliverables"], m: ClientHealthSignals["lateMilestones"]) =>
      lateWorkCell({ ...base, signals: { ...base.signals, lateDeliverables: d, lateMilestones: m } }, ASOF);
    expect(cell(null, null)).toBe("—");
    expect(cell({ count: 0, oldestDue: null }, { count: 0, oldestDue: null })).toBe("None");
    expect(cell(null, { count: 0, oldestDue: null })).toBe("—");
    expect(cell({ count: 1, oldestDue: "2026-10-10" }, { count: 2, oldestDue: "2026-10-05" })).toBe("3 (1 deliverable, 2 milestones) · 10 days late");
    expect(cell(null, { count: 1, oldestDue: "2026-10-14" })).toBe("1 (0 deliverables, 1 milestone) · 1 day late");
  });

  it("the site cell: dash when monitoring is off or unread, incidents and uptime otherwise", () => {
    expect(siteCell({ ...row("S", "on_track"), signals: { ...SIGNALS, site: null } })).toBe("—");
    expect(siteCell(row("S", "on_track"))).toBe("No incidents · 100% up (30 days)");
    expect(siteCell({ ...row("S", "at_risk"), signals: { ...SIGNALS, site: { openIncidents: 2, oldestOpenSince: null, uptime30d: null } } })).toBe("2 open incidents");
  });

  it("ages count whole days and never go negative or throw", () => {
    expect(ageInDays(daysAgo(3), ASOF)).toBe(3);
    expect(ageInDays("2027-01-01", ASOF)).toBe(0);
    expect(ageInDays("not a date", ASOF)).toBeNull();
    expect(ageInDays(null, ASOF)).toBeNull();
  });

  it("names the sources that could not be read, and nothing when none failed", () => {
    expect(unavailableSentence([])).toBe("");
    expect(unavailableSentence(["site", "invoices"])).toBe("Could not be read: site monitoring, invoices.");
    expect(unavailableSentence(["reports"])).toBe("Could not be read: delivery on time.");
  });
});

describe("PV7-05 · the cells", () => {
  it("one row as a plain record: counts stay numbers (null stays null), delivery on time is a percent or a dash", () => {
    const r = row("Acme", "at_risk", { openChangeRequests: null, conversationsAwaitingReply: 2, deliveryOnTime: 0.75, activeProjects: 3 }, ["u-1", "Una"]);
    const c = healthBoardCells({ ...r, reasons: [{ code: "late_work", count: 1, since: null }] }, ASOF);
    expect(c).toMatchObject({
      id: "id-Acme", name: "Acme", owner: "Una", health: "at_risk", healthSort: "1", why: "Late work",
      openRequests: null, unanswered: 2, onTime: "75%", activeProjects: 3,
    });
    expect(healthBoardCells(row("N", "quiet", { deliveryOnTime: null }), ASOF)).toMatchObject({ onTime: "—", why: "—", owner: "—" });
  });

  it("every sortBy column points at a field the cells carry", () => {
    const cells = healthBoardCells(row("A", "on_track"), ASOF);
    for (const col of BOARD_COLUMNS) {
      expect(Object.keys(cells), col.key).toContain(col.key);
      if (col.sortBy) expect(Object.keys(cells), `${col.key} sortBy`).toContain(col.sortBy);
    }
    expect(BOARD_COLUMNS.map((c) => c.header)).toEqual([
      "Client", "Health", "Why", "Waiting on us", "Waiting on client", "Late work", "Open requests", "Unanswered messages",
      "Overdue invoices", "Site", "Delivery on time (this month)", "Active projects", "Owner",
    ]);
  });
});

describe("PV7-05 · the filters", () => {
  const rows = [
    row("A", "off_track", {}, ["u-1", "Una"]), row("B", "at_risk", {}, ["u-2", "Bo"]), row("C", "at_risk", {}, null), row("D", "quiet", {}, ["u-1", "Una"]),
  ];

  it("filters by state, owner (incl. no owner) and department client ids, together", () => {
    expect(filterBoard(rows, { state: "at_risk" }).map((r) => r.name)).toEqual(["B", "C"]);
    expect(filterBoard(rows, { owner: "u-1" }).map((r) => r.name)).toEqual(["A", "D"]);
    expect(filterBoard(rows, { owner: NO_OWNER }).map((r) => r.name)).toEqual(["C"]);
    expect(filterBoard(rows, { departmentClientIds: new Set(["id-B", "id-D"]) }).map((r) => r.name)).toEqual(["B", "D"]);
    expect(filterBoard(rows, { state: "at_risk", departmentClientIds: new Set(["id-B"]), owner: "u-2" }).map((r) => r.name)).toEqual(["B"]);
    expect(filterBoard(rows, { departmentClientIds: new Set() })).toEqual([]);
    expect(filterBoard(rows, { departmentClientIds: null })).toHaveLength(4);
  });

  it("the facets list only what exists, in order, with counts", () => {
    expect(stateOptions(rows)).toEqual([
      { key: "off_track", label: "Off track", count: 1 }, { key: "at_risk", label: "At risk", count: 2 }, { key: "quiet", label: "Quiet", count: 1 },
    ]);
    expect(ownerOptions(rows)).toEqual([
      { key: "u-2", label: "Bo", count: 1 }, { key: "u-1", label: "Una", count: 2 }, { key: NO_OWNER, label: "No owner", count: 1 },
    ]);
    expect(isHealthState("at_risk")).toBe(true);
    expect(isHealthState("bad")).toBe(false);
    expect(isHealthState(undefined)).toBe(false);
  });

  it("builds the board's own URL", () => {
    expect(healthBoardHref({})).toBe("/clients/health");
    expect(healthBoardHref({ state: "at_risk", owner: "u-1", department: "d-1" })).toBe("/clients/health?state=at_risk&owner=u-1&department=d-1");
  });
});
