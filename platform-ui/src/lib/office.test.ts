import { describe, it, expect } from "vitest";
import {
  buildFloors, allRooms, roomTileRect, deskSlotTile, roomCenterTile,
  roomSizeTiles, deskColsForOccupancy,
  buildWalkableGrid, findPath, nearestWalkable, roomToRoomPath, pathLength, pointAlongPath,
  restingRoomKey, buildReplaySteps, totalReplayMs, hashId, catToken, lerp, clamp01,
  isGenuinelyWorking, WORKING_RECENCY_MS,
  resolveAutomationState, automationColorToken, AUTOMATION_GREY_TOKEN, AUTOMATION_RECENCY_MS,
  CORRIDOR_W_TILES, MAX_FLOOR_WIDTH_TILES, ROOM_MIN_W_TILES, ROOM_MIN_H_TILES, DESK_TOP_TILES,
  ZOOM_LEVELS, fitZoomLevel, clampCamera, zoomCameraAtPoint, cssTransformForCamera, viewportToContentPoint,
  type OfficeAvatar, type OfficeMoveEvent, type OfficeRoomInput, type OfficeRoom, type OfficeFloor, type Camera,
  type AutomationSignal,
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

describe("deskSlotTile — desk rows anchor to the room's OWN nameplate wall, consistently (polish fix)", () => {
  it("a north room's first row sits DESK_TOP_TILES below its own top edge (its nameplate wall)", () => {
    const [floor] = buildFloors([{ key: "d1", label: "d1", kind: "department", boundTo: "x", occupantCount: 4 }]);
    const [r] = floor.rooms;
    expect(r.side).toBe("north"); // the very first room always lands north (shorter-side heuristic)
    const slot = deskSlotTile(r, 0);
    expect(slot.y).toBeCloseTo(r.y + DESK_TOP_TILES, 5);
  });

  it("a south room's first row sits DESK_TOP_TILES above its own bottom edge (its nameplate wall) — the MIRROR of north, not a re-run of the same formula", () => {
    // Two same-height rooms in a row: buildFloors' "shorter side" heuristic puts the second one
    // south, since the first already grew the north cursor past the south cursor.
    const [floor] = buildFloors([
      { key: "d1", label: "d1", kind: "department", boundTo: "x", occupantCount: 4 },
      { key: "d2", label: "d2", kind: "department", boundTo: "x", occupantCount: 4 },
    ]);
    const south = floor.rooms.find((r) => r.side === "south")!;
    expect(south).toBeTruthy();
    const slot = deskSlotTile(south, 0);
    expect(slot.y).toBeCloseTo(south.y + south.hTiles - DESK_TOP_TILES, 5);
  });

  it("both anchoring directions keep every desk inside the room's own rect (existing invariant, still holds)", () => {
    const [floor] = buildFloors([
      { key: "d1", label: "d1", kind: "department", boundTo: "x", occupantCount: 9 },
      { key: "d2", label: "d2", kind: "department", boundTo: "x", occupantCount: 9 },
    ]);
    for (const r of floor.rooms) {
      const rect = roomTileRect(r);
      for (let i = 0; i < 9; i++) {
        const slot = deskSlotTile(r, i);
        expect(slot.y).toBeGreaterThanOrEqual(rect.y);
        expect(slot.y).toBeLessThan(rect.y + rect.h);
      }
    }
  });
});

describe("Camera — zoom / pan / follow maths (req #1, pure functions per the ticket's own instruction)", () => {
  const camera1x: Camera = { scale: 1, centerX: 500, centerY: 300 };

  describe("fitZoomLevel", () => {
    it("picks the largest integer step that shows the whole plate", () => {
      // Content 300x200 fits at 2x (600x400) inside an 800x600 viewport, but not at 3x (900x600 > 800 wide).
      expect(fitZoomLevel(300, 200, 800, 600)).toBe(2);
    });

    it("never returns a fractional or a step outside ZOOM_LEVELS", () => {
      const z = fitZoomLevel(1000, 800, 400, 300);
      expect(ZOOM_LEVELS).toContain(z);
    });

    it("falls back to the smallest step (1) when even 1x can't fit the whole plate", () => {
      expect(fitZoomLevel(5000, 4000, 800, 600)).toBe(1);
    });

    it("falls back to 1 for a degenerate (zero-size) plate rather than picking the largest step", () => {
      expect(fitZoomLevel(0, 0, 800, 600)).toBe(1);
    });

    it("is deterministic for the same inputs", () => {
      expect(fitZoomLevel(640, 480, 900, 700)).toBe(fitZoomLevel(640, 480, 900, 700));
    });
  });

  describe("clampCamera — the plate can never be lost off-screen", () => {
    it("leaves an in-bounds centre untouched", () => {
      const c = clampCamera(camera1x, 2000, 1500, 800, 600);
      expect(c.centerX).toBeCloseTo(500, 5);
      expect(c.centerY).toBeCloseTo(300, 5);
    });

    it("pulls a centre that would show past the LEFT/TOP edge back to the boundary", () => {
      const c = clampCamera({ scale: 1, centerX: -1000, centerY: -1000 }, 2000, 1500, 800, 600);
      expect(c.centerX).toBeCloseTo(400, 5); // half the viewport, in content px at scale 1
      expect(c.centerY).toBeCloseTo(300, 5);
    });

    it("pulls a centre that would show past the RIGHT/BOTTOM edge back to the boundary", () => {
      const c = clampCamera({ scale: 1, centerX: 10_000, centerY: 10_000 }, 2000, 1500, 800, 600);
      expect(c.centerX).toBeCloseTo(2000 - 400, 5);
      expect(c.centerY).toBeCloseTo(1500 - 300, 5);
    });

    it("locks to the plate's own centre on an axis where the SCALED plate is smaller than the viewport — no pan is possible there", () => {
      // A 300x200 plate at 2x is 600x400 — smaller than an 800x600 viewport on both axes.
      const c = clampCamera({ scale: 2, centerX: 999, centerY: -999 }, 300, 200, 800, 600);
      expect(c.centerX).toBeCloseTo(150, 5);
      expect(c.centerY).toBeCloseTo(100, 5);
    });

    it("is idempotent — clamping an already-clamped camera changes nothing", () => {
      const once = clampCamera({ scale: 1, centerX: 10_000, centerY: -10_000 }, 2000, 1500, 800, 600);
      const twice = clampCamera(once, 2000, 1500, 800, 600);
      expect(twice).toEqual(once);
    });
  });

  describe("zoomCameraAtPoint — cursor-anchored zoom", () => {
    it("keeps the CONTENT point under the pointer fixed on screen across a zoom change", () => {
      const viewportW = 800, viewportH = 600;
      const pointerVX = 200, pointerVY = 150; // somewhere off-centre in the viewport
      const before = camera1x;
      const beforeContent = viewportToContentPoint(before, pointerVX, pointerVY, viewportW, viewportH);
      const after = zoomCameraAtPoint(before, 3, pointerVX, pointerVY, viewportW, viewportH);
      const afterContent = viewportToContentPoint(after, pointerVX, pointerVY, viewportW, viewportH);
      expect(afterContent.x).toBeCloseTo(beforeContent.x, 6);
      expect(afterContent.y).toBeCloseTo(beforeContent.y, 6);
      expect(after.scale).toBe(3);
    });

    it("zooming exactly at the viewport's own centre leaves the centre unchanged (a button-style zoom, not cursor-anchored)", () => {
      const viewportW = 800, viewportH = 600;
      const after = zoomCameraAtPoint(camera1x, 2, viewportW / 2, viewportH / 2, viewportW, viewportH);
      expect(after.centerX).toBeCloseTo(camera1x.centerX, 6);
      expect(after.centerY).toBeCloseTo(camera1x.centerY, 6);
    });

    it("is a no-op (same object identity) when the target scale equals the current one", () => {
      const after = zoomCameraAtPoint(camera1x, 1, 123, 456, 800, 600);
      expect(after).toBe(camera1x);
    });
  });

  describe("cssTransformForCamera / viewportToContentPoint — inverse of each other", () => {
    it("round-trips a content point through the transform and back", () => {
      const viewportW = 800, viewportH = 600;
      const camera: Camera = { scale: 2, centerX: 1234, centerY: 567 };
      // A point at the exact centre of the viewport must map back to the camera's own centre.
      const content = viewportToContentPoint(camera, viewportW / 2, viewportH / 2, viewportW, viewportH);
      expect(content.x).toBeCloseTo(camera.centerX, 6);
      expect(content.y).toBeCloseTo(camera.centerY, 6);
    });

    it("produces a translate+scale string using the camera's own integer scale", () => {
      const camera: Camera = { scale: 3, centerX: 100, centerY: 100 };
      const css = cssTransformForCamera(camera, 800, 600);
      expect(css).toContain("scale(3)");
      expect(css).toMatch(/^translate\(-?\d+(\.\d+)?px, -?\d+(\.\d+)?px\) scale\(3\)$/);
    });
  });
});

// ── Automations — the same three-state honesty model, driven by automation_approvals (2026-08-24)
function signal(overrides: Partial<AutomationSignal> = {}): AutomationSignal {
  return { checked: true, pendingApproval: false, executionStatus: null, asOfMs: null, executionError: null, ...overrides };
}

describe("resolveAutomationState — pure signal-in, state-out (the resolver 'motion is a claim' rides on)", () => {
  it("is UNKNOWN whenever checked is false, regardless of what the other fields claim", () => {
    // The exact trap the ticket calls out: every other field here looks exactly like "idle" would,
    // but `checked: false` means the reader never actually confirmed that — must never be coerced
    // into a confident idle.
    expect(resolveAutomationState(signal({ checked: false }), 1_000_000)).toBe("unknown");
    expect(resolveAutomationState(signal({ checked: false, pendingApproval: true }), 1_000_000)).toBe("unknown");
    expect(resolveAutomationState(signal({ checked: false, executionStatus: "executing" }), 1_000_000)).toBe("unknown");
  });

  it("is IDLE, not unknown, when checked is true and genuinely nothing is happening", () => {
    // The other half of the same distinction: a real, confirmed "nothing to report" is idle, not
    // unknown — the two must never collapse into the same value from opposite reasons.
    expect(resolveAutomationState(signal(), 1_000_000)).toBe("idle");
  });

  it("a pending approval wins even over a fresh in-flight execution — the loudest fact always shows", () => {
    const now = 1_000_000;
    const s = signal({ pendingApproval: true, executionStatus: "executing", asOfMs: now });
    expect(resolveAutomationState(s, now)).toBe("awaiting_approval");
  });

  it("an in-flight execution_status is EXECUTING with no freshness check at all", () => {
    const now = 1_000_000;
    const s = signal({ executionStatus: "executing", asOfMs: null });
    expect(resolveAutomationState(s, now)).toBe("executing");
  });

  it("a FINISHED run inside the window is JUST_RAN, never executing — the desk must not claim a run is in flight after it completed", () => {
    // The behaviour change of 2026-08-24, and the reason the window could be widened at all. This
    // row says the run is DONE (`executed`), so the only honest claim left is that it happened
    // recently. Returning "executing" here — as this resolver used to — had the desk asserting an
    // in-flight run against a row that recorded a completed one.
    const now = 1_000_000;
    const s = signal({ executionStatus: "executed", asOfMs: now - AUTOMATION_RECENCY_MS });
    expect(resolveAutomationState(s, now)).toBe("just_ran");
    expect(resolveAutomationState({ ...s, asOfMs: now - AUTOMATION_RECENCY_MS - 1 }, now)).toBe("idle");
  });

  it("uses the AUTOMATION window, not the agent-run one — the two measure different kinds of signal", () => {
    // Guards the actual defect: an automation's `executed_at` is a POINT event, not a heartbeat, so
    // measuring it against the agent-run silence window gave every automation a 45-second animated
    // life. A run finished 5 minutes ago is still recent for an automation and long dead for an
    // agent run; if these two constants are ever collapsed back into one, this fails.
    const now = 1_000_000;
    const fiveMinutesAgo = now - 5 * 60_000;
    expect(fiveMinutesAgo).toBeLessThan(now - WORKING_RECENCY_MS); // stale by the AGENT window
    expect(resolveAutomationState(signal({ executionStatus: "executed", asOfMs: fiveMinutesAgo }), now)).toBe("just_ran");
    expect(AUTOMATION_RECENCY_MS).toBeGreaterThan(WORKING_RECENCY_MS);
  });

  it("an in-flight status still outranks the window — executing is a live claim, just_ran is a recent one", () => {
    const now = 1_000_000;
    // Same timestamp, different status: the row that says it is still running reads as executing.
    const running = signal({ executionStatus: "executing", asOfMs: now - 5 * 60_000 });
    const finished = signal({ executionStatus: "executed", asOfMs: now - 5 * 60_000 });
    expect(resolveAutomationState(running, now)).toBe("executing");
    expect(resolveAutomationState(finished, now)).toBe("just_ran");
  });

  it("a failed execution is FAILED only within the freshness window, then fades to idle — never alarming forever", () => {
    const now = 1_000_000;
    const fresh = signal({ executionStatus: "failed", asOfMs: now - AUTOMATION_RECENCY_MS, executionError: "boom" });
    expect(resolveAutomationState(fresh, now)).toBe("failed");
    const stale = signal({ executionStatus: "failed", asOfMs: now - AUTOMATION_RECENCY_MS - 1, executionError: "boom" });
    expect(resolveAutomationState(stale, now)).toBe("idle");
  });

  it("a failed status with no asOfMs at all (never even reached executed_at) is idle, never a fabricated failure", () => {
    const s = signal({ executionStatus: "failed", asOfMs: null, executionError: "hub_unreachable" });
    expect(resolveAutomationState(s, 1_000_000)).toBe("idle");
  });
});

describe("automationColorToken — settable colour, then department tone, then grey (owner override, 2026-08-24)", () => {
  it("falls all the way to grey when neither a setting nor a department applies", () => {
    expect(automationColorToken(null, null)).toBe(AUTOMATION_GREY_TOKEN);
    expect(automationColorToken(undefined, undefined)).toBe(AUTOMATION_GREY_TOKEN);
  });

  it("uses the department's own deterministic --cat-N tone when one applies and no setting overrides it", () => {
    const token = automationColorToken(null, "dept-42");
    expect(token).toMatch(/^--cat-[1-8]$/);
    expect(token).toBe(catToken("dept-42")); // same hash every human bound to that department gets
  });

  it("a real per-automation setting wins over the department tone", () => {
    expect(automationColorToken("--cat-3", "dept-42")).toBe("--cat-3");
  });
});
