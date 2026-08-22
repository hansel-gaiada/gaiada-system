import { describe, it, expect } from "vitest";
import {
  layoutRooms, roomTileRect, floorSizeTiles, deskSlotTile, roomCenterTile,
  restingRoomKey, buildReplaySteps, totalReplayMs, hashId, catToken, lerp, clamp01,
  type OfficeAvatar, type OfficeMoveEvent, type OfficeRoomInput,
} from "./office";

const rooms: OfficeRoomInput[] = [
  { key: "lobby", label: "Lobby", kind: "lobby", boundTo: "Airlock intent queue" },
  { key: "dept-1", label: "Web Dev", kind: "department", deptId: "dept-1", boundTo: "Department dept-1" },
  { key: "dept-2", label: "SEO", kind: "department", deptId: "dept-2", boundTo: "Department dept-2" },
  { key: "unassigned", label: "Unassigned", kind: "unassigned", boundTo: "No department binding" },
  { key: "utility", label: "Utility", kind: "utility", boundTo: "Automations" },
];

describe("layoutRooms / roomTileRect / floorSizeTiles", () => {
  it("packs rooms into a wrapping grid in input order", () => {
    const laid = layoutRooms(rooms);
    expect(laid.map((r) => [r.col, r.row])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]);
  });

  it("gives every room a non-overlapping tile rect", () => {
    const laid = layoutRooms(rooms);
    const rects = laid.map(roomTileRect);
    // Two rooms in the same row must not overlap on x.
    const row0 = rects.slice(0, 3);
    for (let i = 1; i < row0.length; i++) {
      expect(row0[i].x).toBeGreaterThanOrEqual(row0[i - 1].x + row0[i - 1].w);
    }
  });

  it("computes a floor size that bounds every room", () => {
    const laid = layoutRooms(rooms);
    const size = floorSizeTiles(laid);
    for (const r of laid) {
      const rect = roomTileRect(r);
      expect(rect.x + rect.w).toBeLessThanOrEqual(size.w);
      expect(rect.y + rect.h).toBeLessThanOrEqual(size.h);
    }
  });

  it("floorSizeTiles degrades to one room's size for an empty list", () => {
    const size = floorSizeTiles([]);
    expect(size.w).toBeGreaterThan(0);
    expect(size.h).toBeGreaterThan(0);
  });
});

describe("deskSlotTile / roomCenterTile", () => {
  it("keeps desk slots inside the room's own rect for a small roster", () => {
    const [room] = layoutRooms([rooms[1]]);
    const rect = roomTileRect(room);
    for (let i = 0; i < 4; i++) {
      const slot = deskSlotTile(room, i);
      expect(slot.x).toBeGreaterThanOrEqual(rect.x);
      expect(slot.x).toBeLessThan(rect.x + rect.w);
      expect(slot.y).toBeGreaterThanOrEqual(rect.y);
      expect(slot.y).toBeLessThan(rect.y + rect.h);
    }
  });

  it("gives distinct desk slots for distinct indices", () => {
    const [room] = layoutRooms([rooms[1]]);
    const a = deskSlotTile(room, 0);
    const b = deskSlotTile(room, 1);
    expect(a).not.toEqual(b);
  });

  it("centres a room within its own rect", () => {
    const [room] = layoutRooms([rooms[1]]);
    const rect = roomTileRect(room);
    const center = roomCenterTile(room);
    expect(center.x).toBeGreaterThan(rect.x);
    expect(center.x).toBeLessThan(rect.x + rect.w);
  });
});

describe("restingRoomKey — where an avatar is 'as of' an instant", () => {
  const avatar: OfficeAvatar = {
    id: "a1", kind: "agent", name: "Supervisor", homeRoomKey: "unassigned", deskIndex: 0,
    recordKind: "agent-goal", recordId: "g1", recordLabel: "Goal g1", note: "test fixture",
  };
  const events: OfficeMoveEvent[] = [
    { id: "e1", avatarId: "a1", fromRoomKey: "unassigned", toRoomKey: "dept-1", at: "2026-08-23T09:00:00Z", reason: "Handed off" },
    { id: "e2", avatarId: "a1", fromRoomKey: "dept-1", toRoomKey: "dept-2", at: "2026-08-23T09:10:00Z", reason: "Handed off again" },
    { id: "e3", avatarId: "other", fromRoomKey: "lobby", toRoomKey: "utility", at: "2026-08-23T09:05:00Z", reason: "Unrelated" },
  ];

  it("returns the home room before any event fires", () => {
    expect(restingRoomKey(avatar, events, Date.parse("2026-08-23T08:59:00Z"))).toBe("unassigned");
  });

  it("returns the destination of the most recent event at or before the instant", () => {
    expect(restingRoomKey(avatar, events, Date.parse("2026-08-23T09:05:00Z"))).toBe("dept-1");
    expect(restingRoomKey(avatar, events, Date.parse("2026-08-23T09:10:00Z"))).toBe("dept-2");
    expect(restingRoomKey(avatar, events, Date.parse("2026-08-23T10:00:00Z"))).toBe("dept-2");
  });

  it("ignores another avatar's events entirely", () => {
    expect(restingRoomKey(avatar, events, Date.parse("2026-08-23T09:05:30Z"))).not.toBe("utility");
  });
});

describe("buildReplaySteps / totalReplayMs", () => {
  const events: OfficeMoveEvent[] = [
    { id: "e2", avatarId: "a1", fromRoomKey: "dept-1", toRoomKey: "dept-2", at: "2026-08-23T09:10:00Z", reason: "second" },
    { id: "e1", avatarId: "a1", fromRoomKey: "unassigned", toRoomKey: "dept-1", at: "2026-08-23T09:00:00Z", reason: "first" },
  ];

  it("orders steps chronologically by the real recorded timestamp, not input order", () => {
    const steps = buildReplaySteps(events);
    expect(steps.map((s) => s.id)).toEqual(["e1", "e2"]);
    expect(steps[0].startMs).toBeLessThan(steps[1].startMs);
  });

  it("gives every step a non-zero travel window by default", () => {
    const steps = buildReplaySteps(events, false);
    for (const s of steps) expect(s.endMs).toBeGreaterThan(s.startMs);
  });

  it("collapses travel to an instant cut under reduced motion, without dropping the event", () => {
    const steps = buildReplaySteps(events, true);
    for (const s of steps) expect(s.endMs).toBe(s.startMs);
    expect(steps).toHaveLength(2);
  });

  it("never mutates the real `at` timestamp when re-pacing playback", () => {
    const steps = buildReplaySteps(events);
    expect(steps.find((s) => s.id === "e1")!.at).toBe("2026-08-23T09:00:00Z");
  });

  it("totalReplayMs covers every step and is 0 for an empty timeline", () => {
    const steps = buildReplaySteps(events);
    const total = totalReplayMs(steps);
    for (const s of steps) expect(s.endMs).toBeLessThanOrEqual(total);
    expect(totalReplayMs([])).toBe(0);
  });
});

describe("hashId / catToken — deterministic, art-free identity", () => {
  it("is deterministic for the same id", () => {
    expect(hashId("person-42")).toBe(hashId("person-42"));
    expect(catToken("person-42")).toBe(catToken("person-42"));
  });

  it("resolves to one of the 8 categorical tokens", () => {
    for (const id of ["a", "b", "c", "person-1", "agent-goal-9"]) {
      expect(catToken(id)).toMatch(/^--cat-[1-8]$/);
    }
  });

  it("spreads across tones rather than collapsing to one", () => {
    const tones = new Set(Array.from({ length: 50 }, (_, i) => catToken(`id-${i}`)));
    expect(tones.size).toBeGreaterThan(1);
  });
});

describe("lerp / clamp01", () => {
  it("clamps outside [0,1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });

  it("interpolates and clamps past the endpoints", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 2)).toBe(10);
  });
});
