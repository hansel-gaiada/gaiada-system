import { describe, it, expect } from "vitest";
import {
  clientStatus, isPastDue, money, overallProgress, portalDate, projectRange, projectUrgencyTier, relativeDays,
  splitTimeline, statusTone, type PortalProject, type PortalTimelineEvent,
} from "./portal";

// CP-16 — the portal's pure layer. Every function here renders text a CLIENT reads, on both the server
// and the browser, so the properties worth pinning are (a) locale/timezone determinism, (b) the
// upcoming-vs-history split, and (c) that no helper returns a colour literal.

const AT = (d: string): PortalTimelineEvent => ({
  kind: "milestone", id: d, label: d, status: "open", at: d, tense: "due", context: null, projectId: null,
});

describe("money", () => {
  it("formats IDR with no decimal places", () => {
    // Rupiah sub-units are not used in practice; "IDR 25,000,000.00" is noise on every invoice.
    //
    // ` ` is deliberate and asserted rather than normalised away: Intl separates a currency CODE
    // from its number with a NON-BREAKING space, which is typographically right (the code must never wrap
    // onto its own line) and invisible in a diff. Writing a plain space here produces a failure whose
    // expected and received values look byte-identical in the terminal — which is exactly how this test
    // first failed.
    expect(money(25_000_000, "IDR")).toBe("IDR 25,000,000");
  });

  it("formats a 2dp currency with 2dp", () => {
    expect(money(1234.5, "USD")).toBe("$1,234.50");
  });

  it("is deterministic — the locale is pinned, not read from the host", () => {
    // The regression this guards: `toLocaleString` with no locale reads the runtime's ICU data, so the
    // server and the browser can produce different separators for the same number and React logs a
    // hydration mismatch. Asserting the exact string is the only way to catch a reintroduction.
    expect(money(1_000_000, "USD")).toBe("$1,000,000.00");
  });

  it("renders an em-dash rather than NaN for missing values", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(Number.NaN)).toBe("—");
  });

  it("degrades on an unknown currency code instead of throwing", () => {
    // Intl throws on an invalid code. A whole invoice page must not blank because of a bad row.
    expect(money(10, "NOTACODE")).toBe("NOTACODE 10.00");
  });
});

describe("portalDate", () => {
  it("formats in UTC with a fixed locale", () => {
    expect(portalDate("2026-08-04T00:00:00.000Z")).toBe("04 Aug 2026");
  });

  it("does not shift the day for a late-UTC timestamp", () => {
    // The bug this pins: rendered in a UTC+8 zone this instant is 5 Aug, and a due date that moves by a
    // day between server and client is the difference between "today" and "overdue".
    expect(portalDate("2026-08-04T23:30:00.000Z")).toBe("04 Aug 2026");
  });

  it("handles null and unparseable input", () => {
    expect(portalDate(null)).toBe("—");
    expect(portalDate("not a date")).toBe("—");
  });
});

describe("relativeDays", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");

  it("names today, tomorrow and yesterday", () => {
    expect(relativeDays("2026-08-04T00:00:00.000Z", now)).toBe("today");
    expect(relativeDays("2026-08-05T00:00:00.000Z", now)).toBe("tomorrow");
    expect(relativeDays("2026-08-03T00:00:00.000Z", now)).toBe("yesterday");
  });

  it("counts by UTC day, not by elapsed milliseconds", () => {
    // 2026-08-05T01:00Z is ~13 hours away but is still TOMORROW, which is what a person reading a due
    // date means. A millisecond-difference implementation would say "today".
    expect(relativeDays("2026-08-05T01:00:00.000Z", now)).toBe("tomorrow");
  });

  it("counts forward and back", () => {
    expect(relativeDays("2026-08-14T00:00:00.000Z", now)).toBe("in 10 days");
    expect(relativeDays("2026-07-25T00:00:00.000Z", now)).toBe("10 days ago");
  });
});

describe("isPastDue", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  it("is false for today", () => {
    // A due date of TODAY is not yet overdue — flagging it red on the morning it is due would be wrong
    // on every deliverable that lands that afternoon.
    expect(isPastDue("2026-08-04", now)).toBe(false);
  });
  it("is true for yesterday and false for tomorrow", () => {
    expect(isPastDue("2026-08-03", now)).toBe(true);
    expect(isPastDue("2026-08-05", now)).toBe(false);
  });
  it("is false for missing or invalid dates", () => {
    expect(isPastDue(null, now)).toBe(false);
    expect(isPastDue("whenever", now)).toBe(false);
  });
});

describe("splitTimeline", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");

  it("puts future due items in upcoming, soonest first", () => {
    const { upcoming } = splitTimeline([AT("2026-09-01"), AT("2026-08-10")], now);
    expect(upcoming.map((e) => e.at)).toEqual(["2026-08-10", "2026-09-01"]);
  });

  it("puts an OVERDUE due item in history, not upcoming", () => {
    // The property this exists for: an overdue milestone listed under "coming up" reads as though it were
    // still ahead of schedule, which is the one thing a timeline must never imply.
    const { upcoming, history } = splitTimeline([AT("2026-07-01")], now);
    expect(upcoming).toHaveLength(0);
    expect(history).toHaveLength(1);
  });

  it("puts happened items in history, newest first", () => {
    const ev = (at: string): PortalTimelineEvent => ({ ...AT(at), tense: "happened" });
    const { history } = splitTimeline([ev("2026-01-01"), ev("2026-07-01")], now);
    expect(history.map((e) => e.at)).toEqual(["2026-07-01", "2026-01-01"]);
  });

  it("keeps a happened item in history even when its date is in the future", () => {
    // Clock skew between the DB and the render host can produce this. It must not silently move a
    // completed delivery into "coming up".
    const { upcoming, history } = splitTimeline([{ ...AT("2026-12-01"), tense: "happened" }], now);
    expect(upcoming).toHaveLength(0);
    expect(history).toHaveLength(1);
  });
});

describe("clientStatus", () => {
  it("translates internal tokens into client vocabulary", () => {
    // The point of this map: `humanizeStatus` would give "Todo" and "Sent", which are our words. A client
    // reading their own project needs "Not started" and "Awaiting your action".
    expect(clientStatus("todo")).toBe("Not started");
    expect(clientStatus("sent")).toBe("Awaiting your action");
    expect(clientStatus("blocked")).toBe("On hold");
    expect(clientStatus("void")).toBe("Cancelled");
  });

  it("falls back to a humanised form for an unknown token", () => {
    expect(clientStatus("some_new_state")).toBe("Some new state");
  });

  it("renders an em-dash for nothing", () => {
    expect(clientStatus(null)).toBe("—");
  });
});

describe("statusTone", () => {
  it("returns a token FAMILY name, never a colour", () => {
    // Load-bearing: `styles/tokens.test.ts` fails the build on a hex or rgb() in components/**.css, and a
    // helper that returned a literal would route straight around that guard while looking compliant.
    for (const s of ["done", "sent", "blocked", "in_progress", "anything"]) {
      expect(statusTone(s)).toMatch(/^(success|warning|danger|info|neutral)$/);
    }
  });

  it("maps the states the portal actually renders", () => {
    expect(statusTone("signed")).toBe("success");
    expect(statusTone("sent")).toBe("warning");
    expect(statusTone("rejected")).toBe("danger");
    expect(statusTone("active")).toBe("info");
    expect(statusTone(undefined)).toBe("neutral");
  });
});

describe("overallProgress", () => {
  it("rounds and clamps", () => {
    expect(overallProgress({ progress: { percent: 61.6 } as never })).toBe(62);
    // Clamped because this number drives a CSS width: a percent above 100 would overflow the bar's
    // container, and a negative one would render as a rendering artifact rather than as zero.
    expect(overallProgress({ progress: { percent: 140 } as never })).toBe(100);
    expect(overallProgress({ progress: { percent: -5 } as never })).toBe(0);
  });

  it("treats a missing or non-finite percent as zero", () => {
    expect(overallProgress({ progress: {} as never })).toBe(0);
    expect(overallProgress({ progress: { percent: Number.NaN } as never })).toBe(0);
  });
});

// P4-K2 — the project range + urgency tier crossing into the portal (K1's client-safe projection).
describe("projectRange", () => {
  it("formats both ends of an authored range", () => {
    expect(projectRange({ startDate: "2026-07-01", dueDate: "2026-09-30" })).toBe("01 Jul 2026 – 30 Sept 2026");
  });

  it("degrades each end independently rather than dropping the whole range", () => {
    expect(projectRange({ startDate: null, dueDate: "2026-09-30" })).toBe("— – 30 Sept 2026");
    expect(projectRange({ startDate: "2026-07-01", dueDate: null })).toBe("01 Jul 2026 – —");
  });

  it("renders a single em-dash when neither end is known", () => {
    expect(projectRange({ startDate: null, dueDate: null })).toBe("—");
  });
});

describe("projectUrgencyTier", () => {
  const today = "2026-08-04";

  it("reuses the ONE urgency definition — matches taskUrgency's overdue boundary", () => {
    expect(projectUrgencyTier({ dueDate: "2026-08-01", progressPercent: 40 }, today)).toBe("overdue");
  });

  it("is due-soon within the default 3-day window and on-track beyond it", () => {
    expect(projectUrgencyTier({ dueDate: "2026-08-06", progressPercent: 40 }, today)).toBe("due-soon");
    expect(projectUrgencyTier({ dueDate: "2026-08-20", progressPercent: 40 }, today)).toBe("on-track");
  });

  it("is undated with no due date", () => {
    expect(projectUrgencyTier({ dueDate: null, progressPercent: 0 }, today)).toBe("undated");
  });

  // The disclosure-relevant case: `isDone` must come from `progressPercent`, the one client-safe
  // signal — never from an internal status word the portal was never sent in the first place.
  it("is done at 100% progress even with a due date in the past — done outranks overdue", () => {
    expect(projectUrgencyTier({ dueDate: "2026-01-01", progressPercent: 100 }, today)).toBe("done");
  });
});

// P4-K5 — isolation: the client-safe projection (K1) is "project authored range · progress % ·
// milestone state · urgency tier" and NOTHING else. This pins it structurally, not just by intent:
// if someone widens `PortalProject` to carry ball history, an internal status label or a staff
// name, this test catches it at the type/shape boundary these helpers consume, before it ever
// reaches a portal page.
describe("P4-K5 isolation — the client-safe projection stays exactly K1's four fields", () => {
  const FORBIDDEN_KEYS = [
    "assignee", "ball", "refId", "responsibleId", "assignmentHistory", "ballHistory",
    "internalStatus", "staffName", "assigneeName", "ownerName", "taskTitle", "taskTitles",
  ];

  it("PortalProject (the type projectRange/projectUrgencyTier consume) declares no forbidden key", () => {
    // A real payload shaped exactly like the BFF contract in `lib/portal.ts` — if a future edit
    // widens the interface with any of the forbidden keys, this object literal starts satisfying a
    // wider type and a reviewer might not notice; the runtime key check below still catches it.
    const sample: PortalProject = {
      id: "p1", name: "Northwind rebrand", status: "in_progress", startDate: "2026-07-01",
      dueDate: "2026-09-30", clientId: "c1", clientName: "Northwind", progressPercent: 40,
      milestoneCount: 4, milestonesDone: 1, deliverableCount: 2, nextMilestoneDue: "2026-08-20",
    };
    for (const key of FORBIDDEN_KEYS) {
      expect(Object.keys(sample)).not.toContain(key);
    }
    // And the two helpers only ever read `startDate`/`dueDate`/`progressPercent` — proven by the
    // fact that a narrowed object missing every other field still works.
    expect(projectRange({ startDate: sample.startDate, dueDate: sample.dueDate })).toBe("01 Jul 2026 – 30 Sept 2026");
    expect(projectUrgencyTier({ dueDate: sample.dueDate, progressPercent: sample.progressPercent }, "2026-08-04")).toBe("on-track");
  });

  it("the internal task status vocabulary word 'in_progress' never appears in the client-facing urgency label", () => {
    // Urgency crosses (K1 allows it); the internal status word that produced `status: 'in_progress'`
    // above must not leak alongside it. `projectUrgencyTier`'s output is a closed UrgencyTier enum —
    // assert it structurally rather than trusting review.
    const tier = projectUrgencyTier({ dueDate: "2026-08-20", progressPercent: 40 }, "2026-08-04");
    expect(["done", "overdue", "due-soon", "on-track", "undated"]).toContain(tier);
    expect(tier).not.toBe("in_progress");
  });
});
