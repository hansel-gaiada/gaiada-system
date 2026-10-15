import { describe, it, expect } from "vitest";
import { buildDemoClientHealthBoard } from "./demoClientHealthBoard";
import { evaluateClientHealth } from "./clientHealthRules";
import { sortWorstFirst } from "./clientHealthBoard";

// PV7-05 — the demo board. Its states come from the rules mirror (the golden-table-pinned copy), and between the two
// variants every state is drivable in the browser.
const NOW = new Date("2026-10-15T12:00:00.000Z");

describe("the demo health board", () => {
  const board = buildDemoClientHealthBoard(NOW);

  it("covers off track, at risk, on track and quiet, and names no unavailable source", () => {
    expect(new Set(board.clients.map((c) => c.state))).toEqual(new Set(["off_track", "at_risk", "on_track", "quiet"]));
    expect(board.unavailable).toEqual([]);
    expect(board.clients.length).toBeGreaterThanOrEqual(7);
  });

  it("every row's state is exactly what the rules mirror says for its own signals (no private verdict)", () => {
    for (const r of board.clients) {
      const s = r.signals;
      const verdict = evaluateClientHealth({
        waitingOnUs: s.waitingOnUs, waitingOnClient: s.waitingOnClient, lateDeliverables: s.lateDeliverables, lateMilestones: s.lateMilestones,
        overdueInvoices: s.overdueInvoices, site: s.site, activeProjects: s.activeProjects, activeServices: s.activeServices,
      }, board.unavailable, NOW);
      expect({ state: r.state, reasons: r.reasons }, r.name).toEqual(verdict);
    }
  });

  it("uses the demo's real client ids for the clients that have a hub page, and is worst first once sorted", () => {
    expect(board.clients.slice(0, 4).map((c) => c.clientId)).toEqual(["cl-1", "cl-2", "cl-3", "cl-4"]);
    const order = sortWorstFirst(board.clients, board.asOf).map((c) => c.state);
    expect(order).toEqual([...order].sort((a, b) => ["off_track", "at_risk", "unknown", "on_track", "quiet"].indexOf(a) - ["off_track", "at_risk", "unknown", "on_track", "quiet"].indexOf(b)));
    expect(order[0]).toBe("off_track");
    expect(order[order.length - 1]).toBe("quiet");
  });

  it("is relative to now, so it does not rot (the same fixture a month later has the same states)", () => {
    const later = buildDemoClientHealthBoard(new Date("2026-11-15T12:00:00.000Z"));
    expect(later.clients.map((c) => c.state)).toEqual(board.clients.map((c) => c.state));
  });

  it("the degraded variant: the site source is unavailable, its signal is null everywhere, and would-be On track and Quiet rows read Unknown", () => {
    const d = buildDemoClientHealthBoard(NOW, { degraded: true });
    expect(d.unavailable).toEqual(["site"]);
    expect(d.clients.every((c) => c.signals.site === null)).toBe(true);
    const unknown = d.clients.filter((c) => c.state === "unknown");
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    for (const u of unknown) expect(u.reasons).toEqual([{ code: "source_unavailable", count: 1, since: null }]);
    // A real finding is never hidden by a failed source.
    expect(d.clients.find((c) => c.clientId === "cl-1")!.state).toBe("off_track");
    expect(d.clients.filter((c) => c.state === "on_track" || c.state === "quiet")).toEqual([]);
  });
});
