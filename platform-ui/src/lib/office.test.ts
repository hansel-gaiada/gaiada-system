import { describe, it, expect } from "vitest";
import {
  buildFloors, allRooms, roomTileRect, deskSlotTile, roomCenterTile,
  roomSizeTiles, deskColsForOccupancy,
  buildWalkableGrid, findPath, nearestWalkable, roomToRoomPath, pathLength, pointAlongPath,
  restingRoomKey, buildReplaySteps, totalReplayMs, hashId, catToken, lerp, clamp01,
  isGenuinelyWorking, WORKING_RECENCY_MS,
  CORRIDOR_W_TILES, MAX_FLOOR_WIDTH_TILES, ROOM_MIN_W_TILES, ROOM_MIN_H_TILES,
  type OfficeAvatar, type OfficeMoveEvent, type OfficeRoomInput, type OfficeRoom, type OfficeFloor,
} from "./office";

function room(key: string, kind: OfficeRoomInput["kind"], occupantCount: number, extra: Partial<OfficeRoomInput> = {}): OfficeRoomInput {
  return { key, label: key, kind, boundTo: `test:${key}`, occupantCount, ...extra };
}

describe("roomSizeTiles / deskColsForOccupancy — footprint from real headcount (req #3)", () => {
  it("never shrinks below the minimum, even for zero occupants", () => {
    const size = roomSizeTiles(0);
    expect(size.wTiles).toBeGreaterThanOrEqual(ROOM_MIN_W_TILES);
    expect(size.hTiles).toBeGreaterThanOrEqual(ROOM_MIN_H_TILES);
  });

  it("grows monotonically (never smaller) as occupancy increases", () => {
    const sizes = [0, 1, 2, 3, 4, 6, 9, 12, 20].map(roomSizeTiles);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i].wTiles).toBeGreaterThanOrEqual(sizes[i - 1].wTiles);
      expect(sizes[i].hTiles).toBeGreaterThanOrEqual(sizes[i - 1].hTiles);
    }
  });

  it("a 9-person room is strictly bigger (both dimensions or at least one, never smaller) than a 2-person room", () => {
    const small = roomSizeTiles(2);
    const big = roomSizeTiles(9);
    expect(big.wTiles + big.hTiles).toBeGreaterThan(small.wTiles + small.hTiles);
  });

  it("widens the desk grid rather than only growing tall, once occupancy passes small-room thresholds", () => {
    expect(deskColsForOccupancy(2)).toBe(3);
    expect(deskColsForOccupancy(3)).toBe(3);
    expect(deskColsForOccupancy(4)).toBeGreaterThan(3);
    expect(deskColsForOccupancy(9)).toBeGreaterThan(deskColsForOccupancy(4));
  });

  it("is deterministic — same occupancy always yields the same footprint", () => {
    expect(roomSizeTiles(7)).toEqual(roomSizeTiles(7));
  });
});

describe("buildFloors — one connected building, not detached boxes (req #1/#2)", () => {
  const smallOffice: OfficeRoomInput[] = [
    room("lobby", "lobby", 0),
    room("agents", "agents", 2),
    room("dept-1", "department", 4, { deptId: "d1" }),
    room("dept-2", "department", 2, { deptId: "d2" }),
    room("utility", "utility", 0),
  ];

  it("places every room of a small office on one floor", () => {
    const floors = buildFloors(smallOffice);
    expect(floors).toHaveLength(1);
    expect(allRooms(floors)).toHaveLength(smallOffice.length);
  });

  it("keeps the Lobby on the ground floor (floor 0) — it is first in room order by construction", () => {
    const floors = buildFloors(smallOffice);
    const lobby = allRooms(floors).find((r) => r.key === "lobby")!;
    expect(lobby.floor).toBe(0);
  });

  it("gives every room a real door on the wall that touches its floor's corridor", () => {
    const floors = buildFloors(smallOffice);
    for (const floor of floors) {
      for (const r of floor.rooms) {
        const rect = roomTileRect(r);
        expect(r.doorX).toBeGreaterThan(rect.x);
        expect(r.doorX).toBeLessThan(rect.x + rect.w);
        if (r.side === "north") {
          // Bottom-aligned to the corridor's top edge.
          expect(rect.y + rect.h).toBeCloseTo(floor.corridorY, 5);
        } else {
          expect(rect.y).toBeCloseTo(floor.corridorY + CORRIDOR_W_TILES, 5);
        }
      }
    }
  });

  it("gives every room in the same floor a non-overlapping footprint", () => {
    const floors = buildFloors(smallOffice);
    for (const floor of floors) {
      const rects = floor.rooms.map(roomTileRect);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          // Same-side neighbours never overlap in x; opposite-side rooms are separated by the
          // corridor band in y — either way this must be false.
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  it("computes a floor size that bounds every one of its rooms", () => {
    const floors = buildFloors(smallOffice);
    for (const floor of floors) {
      for (const r of floor.rooms) {
        const rect = roomTileRect(r);
        expect(rect.x + rect.w).toBeLessThanOrEqual(floor.widthTiles + 0.01);
        expect(rect.y + rect.h).toBeLessThanOrEqual(floor.heightTiles + 0.01);
      }
    }
  });

  it("is DETERMINISTIC — a department never moves floors between renders of the same data", () => {
    const a = buildFloors(smallOffice);
    const b = buildFloors(smallOffice);
    const keyToFloor = (fs: OfficeFloor[]) => new Map(allRooms(fs).map((r) => [r.key, r.floor]));
    expect(keyToFloor(a)).toEqual(keyToFloor(b));
  });

  it("splits onto a second floor when the roster doesn't fit one legible plate", () => {
    const bigOffice: OfficeRoomInput[] = [
      room("lobby", "lobby", 0),
      ...Array.from({ length: 14 }, (_, i) => room(`dept-${i}`, "department", 10, { deptId: `d${i}` })),
    ];
    const floors = buildFloors(bigOffice);
    expect(floors.length).toBeGreaterThan(1);
    // Every room still lands SOMEWHERE, and each floor still individually respects the width cap
    // (with a little slack — a single very wide room is allowed to slightly exceed it rather than
    // spinning up an empty floor for it).
    expect(allRooms(floors)).toHaveLength(bigOffice.length);
    for (const floor of floors) expect(floor.widthTiles).toBeLessThanOrEqual(MAX_FLOOR_WIDTH_TILES + 40);
  });

  it("floors stay stable in count/composition across repeated calls even for the split case", () => {
    const bigOffice: OfficeRoomInput[] = [
      room("lobby", "lobby", 0),
      ...Array.from({ length: 14 }, (_, i) => room(`dept-${i}`, "department", 10, { deptId: `d${i}` })),
    ];
    const a = buildFloors(bigOffice).map((f) => f.rooms.map((r) => r.key));
    const b = buildFloors(bigOffice).map((f) => f.rooms.map((r) => r.key));
    expect(a).toEqual(b);
  });
});

describe("deskSlotTile / roomCenterTile — desk grid follows the room's OWN deskCols", () => {
  it("keeps desk slots inside the room's own rect for a small roster", () => {
    const [floor] = buildFloors([room("dept-1", "department", 3, { deptId: "d1" })]);
    const [r] = floor.rooms;
    const rect = roomTileRect(r);
    for (let i = 0; i < 3; i++) {
      const slot = deskSlotTile(r, i);
      expect(slot.x).toBeGreaterThanOrEqual(rect.x);
      expect(slot.x).toBeLessThan(rect.x + rect.w);
      expect(slot.y).toBeGreaterThanOrEqual(rect.y);
      expect(slot.y).toBeLessThan(rect.y + rect.h);
    }
  });

  it("still keeps every desk inside the room once occupancy widens the desk grid", () => {
    const [floor] = buildFloors([room("dept-1", "department", 9, { deptId: "d1" })]);
    const [r] = floor.rooms;
    const rect = roomTileRect(r);
    for (let i = 0; i < 9; i++) {
      const slot = deskSlotTile(r, i);
      expect(slot.x).toBeGreaterThanOrEqual(rect.x);
      expect(slot.x).toBeLessThan(rect.x + rect.w);
      expect(slot.y).toBeGreaterThanOrEqual(rect.y);
      expect(slot.y).toBeLessThan(rect.y + rect.h);
    }
  });

  it("gives distinct desk slots for distinct indices", () => {
    const [floor] = buildFloors([room("dept-1", "department", 4, { deptId: "d1" })]);
    const [r] = floor.rooms;
    expect(deskSlotTile(r, 0)).not.toEqual(deskSlotTile(r, 1));
  });

  it("centres a room within its own rect", () => {
    const [floor] = buildFloors([room("dept-1", "department", 2, { deptId: "d1" })]);
    const [r] = floor.rooms;
    const rect = roomTileRect(r);
    const center = roomCenterTile(r);
    expect(center.x).toBeGreaterThan(rect.x);
    expect(center.x).toBeLessThan(rect.x + rect.w);
  });
});

describe("buildWalkableGrid / findPath — walk the corridor, never through a wall (req #6)", () => {
  const office: OfficeRoomInput[] = [
    room("lobby", "lobby", 1),
    room("agents", "agents", 2),
    room("dept-1", "department", 4, { deptId: "d1" }),
    room("dept-2", "department", 3, { deptId: "d2" }),
    room("utility", "utility", 1),
  ];
  const [floor] = buildFloors(office);
  const grid = buildWalkableGrid(floor);
  const byKey = new Map(floor.rooms.map((r) => [r.key, r] as const));

  it("finds a route between two rooms on the same floor", () => {
    const a = byKey.get("dept-1")!;
    const b = byKey.get("dept-2")!;
    const path = roomToRoomPath(grid, a, b);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(1);
  });

  it("the route actually passes through the corridor band, not a straight cut between rooms", () => {
    const a = byKey.get("dept-1")!;
    const b = byKey.get("dept-2")!;
    const path = roomToRoomPath(grid, a, b)!;
    const touchesCorridor = path.some((p) => p.y >= floor.corridorY - 0.01 && p.y <= floor.corridorY + CORRIDOR_W_TILES + 0.01);
    expect(touchesCorridor).toBe(true);
  });

  it("every waypoint the BFS itself returns is a genuinely walkable cell", () => {
    const a = byKey.get("lobby")!;
    const b = byKey.get("utility")!;
    const fromDoor = { x: a.doorX, y: a.side === "north" ? a.y + a.hTiles : a.y };
    const toDoor = { x: b.doorX, y: b.side === "north" ? b.y + b.hTiles : b.y };
    const path = findPath(grid, fromDoor, toDoor);
    expect(path).not.toBeNull();
    for (const p of path!) {
      expect(grid.walk[p.y * grid.w + p.x]).toBe(1);
    }
  });

  it("returns null when the goal is nowhere near a walkable cell", () => {
    const path = findPath(grid, { x: 1, y: 1 }, { x: -500, y: -500 });
    expect(path).toBeNull();
  });

  it("nearestWalkable snaps a fractional room-centre point onto the grid", () => {
    const center = roomCenterTile(byKey.get("dept-1")!);
    const snapped = nearestWalkable(grid, center.x, center.y);
    expect(snapped).not.toBeNull();
    expect(grid.walk[snapped!.y * grid.w + snapped!.x]).toBe(1);
  });
});

describe("pathLength / pointAlongPath — distance-proportional interpolation along a corridor route", () => {
  const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];

  it("computes the total polyline length", () => {
    expect(pathLength(path)).toBeCloseTo(20, 5);
  });

  it("t=0 is the start and t=1 is the end", () => {
    expect(pointAlongPath(path, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAlongPath(path, 1)).toEqual({ x: 10, y: 10 });
  });

  it("t=0.5 is halfway BY DISTANCE along the whole route, not by segment index", () => {
    const mid = pointAlongPath(path, 0.5);
    expect(mid).toEqual({ x: 10, y: 0 });
  });

  it("degrades gracefully for a single-point or empty path", () => {
    expect(pointAlongPath([{ x: 3, y: 4 }], 0.7)).toEqual({ x: 3, y: 4 });
    expect(pointAlongPath([], 0.5)).toEqual({ x: 0, y: 0 });
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

describe("isGenuinelyWorking — an agent works ONLY while a real run event backs it (req #5)", () => {
  it("is false when nothing has ever arrived", () => {
    expect(isGenuinelyWorking(null, Date.now())).toBe(false);
  });

  it("is true right at the recency boundary and false just past it", () => {
    const now = 1_000_000;
    expect(isGenuinelyWorking(now - WORKING_RECENCY_MS, now)).toBe(true);
    expect(isGenuinelyWorking(now - WORKING_RECENCY_MS - 1, now)).toBe(false);
  });

  it("is true for an event that just happened", () => {
    const now = 1_000_000;
    expect(isGenuinelyWorking(now, now)).toBe(true);
  });
});
