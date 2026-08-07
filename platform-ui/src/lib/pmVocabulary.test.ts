import { describe, it, expect } from "vitest";
import { PM_TERMS, PM_STATUS_LADDER, PM_RENAMES } from "./pmVocabulary";
import { DEFAULT_STATUSES, intakeStatusId, readyStatusId } from "./pm";

describe("PM_TERMS", () => {
  it("has no empty or untrimmed labels", () => {
    for (const [key, label] of Object.entries(PM_TERMS)) {
      expect(label, key).toBeTruthy();
      expect(label, key).toBe(label.trim());
    }
  });

  // Two keys resolving to the same word means one of them is a concept we failed to name.
  it("maps distinct concepts to distinct words", () => {
    const labels = Object.values(PM_TERMS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("PM_STATUS_LADDER", () => {
  it("is the five statuses the owner specified, in order", () => {
    expect(PM_STATUS_LADDER.map((s) => s.label)).toEqual(["Backlog", "ToDo", "Doing", "Blocked", "Done"]);
  });

  it("has exactly one done and one blocked tier", () => {
    expect(PM_STATUS_LADDER.filter((s) => s.isDone)).toHaveLength(1);
    expect(PM_STATUS_LADDER.filter((s) => s.isBlocked)).toHaveLength(1);
  });

  it("uses unique ids", () => {
    const ids = PM_STATUS_LADDER.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // THE load-bearing test. Renaming "In progress" to "Doing" must not touch the persisted id: every
  // existing pm_task row, every per-project registry row and every bookmarked ?status= carries
  // `in_progress`. Changing it would orphan real data and present as tasks losing their status.
  it("keeps the persisted ids of the statuses that already existed", () => {
    const byLabel = new Map(PM_STATUS_LADDER.map((s) => [s.label, s.id]));
    expect(byLabel.get("Doing")).toBe("in_progress");
    expect(byLabel.get("ToDo")).toBe("todo");
    expect(byLabel.get("Blocked")).toBe("blocked");
    expect(byLabel.get("Done")).toBe("done");
  });

  // P4-B8 wired DEFAULT_STATUSES to derive FROM this ladder, so these now assert the derivation
  // rather than a superset relationship. If someone re-hardcodes DEFAULT_STATUSES, these fail —
  // which is the point: two hardcoded lists of statuses is how the board and the picker start
  // disagreeing about what a status is called.
  it("is the source DEFAULT_STATUSES derives from — same ids, labels, order", () => {
    expect(DEFAULT_STATUSES.map((s) => s.id)).toEqual(PM_STATUS_LADDER.map((s) => s.id));
    expect(DEFAULT_STATUSES.map((s) => s.label)).toEqual(PM_STATUS_LADDER.map((s) => s.label));
  });

  it("hands its done/blocked flags through to DEFAULT_STATUSES unchanged", () => {
    for (const [i, s] of PM_STATUS_LADDER.entries()) {
      expect(DEFAULT_STATUSES[i].isDone, s.id).toBe(s.isDone);
      expect(DEFAULT_STATUSES[i].isBlocked, s.id).toBe(s.isBlocked);
    }
  });

  it("produces a contiguous position order and a themed colour for every status", () => {
    // A missing hue renders an invisible column head; a gap in `position` reorders the board.
    expect(DEFAULT_STATUSES.map((s) => s.position)).toEqual(PM_STATUS_LADDER.map((_, i) => i));
    for (const s of DEFAULT_STATUSES) expect(s.color, s.id).toMatch(/^var\(--pm-status-[a-z-]+\)$/);
  });

  it("includes backlog, so projects on the synthesized defaults actually get the new ladder", () => {
    expect(DEFAULT_STATUSES.map((s) => s.id)).toContain("backlog");
    expect(DEFAULT_STATUSES).toHaveLength(5);
  });
});

// P4-B8: the two "where does a new task start?" intents. These diverged the moment Backlog took
// position 0, and every silent misplacement bug in this area came from one expression serving both.
describe("intakeStatusId / readyStatusId", () => {
  const st = (id: string, position: number, isDone = false, isBlocked = false) =>
    ({ id, label: id, color: "", isDone, isBlocked, position });

  it("send uncommitted work to Backlog and ready work to ToDo, on the default ladder", () => {
    expect(intakeStatusId(DEFAULT_STATUSES)).toBe("backlog");
    expect(readyStatusId(DEFAULT_STATUSES)).toBe("todo");
  });

  it("sort by position, not array order", () => {
    const shuffled = [st("done", 4, true), st("todo", 1), st("backlog", 0), st("in_progress", 2)];
    expect(intakeStatusId(shuffled)).toBe("backlog");
    expect(readyStatusId(shuffled)).toBe("todo");
  });

  // The defect the platform-nest suite caught: the `todo` preference is BY ID, so it has to be
  // re-checked against the flags. A project may mark `todo` done — and new work must never be born
  // complete, nor land in a blocked column.
  it("never return a 'todo' the project has flagged done or blocked", () => {
    const doneTodo = [st("backlog", 0), st("todo", 1, true), st("in_progress", 2), st("done", 3, true)];
    expect(readyStatusId(doneTodo)).toBe("backlog");
    const blockedTodo = [st("todo", 0, false, true), st("in_progress", 1), st("done", 2, true)];
    expect(readyStatusId(blockedTodo)).toBe("in_progress");
  });

  it("fall back sensibly for a registry with none of our ids", () => {
    const custom = [st("queued", 0), st("active", 1), st("shipped", 2, true)];
    expect(intakeStatusId(custom)).toBe("queued");
    expect(readyStatusId(custom)).toBe("queued");
  });

  it("skip a blocked status when choosing where ready work lands", () => {
    const blockedFirst = [st("waiting", 0, false, true), st("open", 1), st("done", 2, true)];
    expect(readyStatusId(blockedFirst)).toBe("open");
    // Intake only cares about done-ness, so it may legitimately return the blocked one.
    expect(intakeStatusId(blockedFirst)).toBe("waiting");
  });

  it("degrade to 'todo' rather than undefined on an empty registry", () => {
    expect(intakeStatusId([])).toBe("todo");
    expect(readyStatusId([])).toBe("todo");
  });
});

describe("PM_RENAMES", () => {
  it("never renames a term to itself", () => {
    for (const r of PM_RENAMES) expect(r.was, r.was).not.toBe(r.now);
  });

  it("resolves every target to a word we actually publish in PM_TERMS or the ladder", () => {
    const published = new Set<string>([
      ...Object.values(PM_TERMS) as string[],
      ...PM_STATUS_LADDER.map((s) => s.label),
    ]);
    for (const r of PM_RENAMES) expect(published.has(r.now), r.now).toBe(true);
  });

  it("records the unchanged persisted id for the status renames", () => {
    const statusRenames = PM_RENAMES.filter((r) => ["In progress", "To do"].includes(r.was));
    expect(statusRenames).toHaveLength(2);
    for (const r of statusRenames) expect(r.idUnchanged).toBeTruthy();
  });
});
