// The Office — pure, client-safe types + layout/pathfinding math for the `/office` prototype.
// See docs/superpowers/plans/2026-08-23-virtual-office-plan.md. This file holds NOTHING that
// needs a backend: room/avatar/event SHAPES, the deterministic layout of rooms into ONE connected
// floor plate (a corridor spine with rooms opening onto it — not a grid of detached boxes), room
// footprint derived from real headcount, hand-rolled grid pathfinding through the corridor
// network, and the pure geometry a replay animation walks through. `office-data.ts` (server-only)
// fills these shapes from real org data + fixtures; `components/office/OfficeCanvas.tsx` (client)
// draws them. Also holds the CAMERA math (zoom/pan/follow, 2026-08-23 addition) — pure, so its
// clamping/fit/cursor-anchor arithmetic is unit-tested directly rather than only by screenshot.
//
// Rewritten 2026-08-23 (owner feedback on the live grid-of-boxes prototype): "map the whole office
// into 1 building ... make another screen[per floor] if not enough ... movement can really look
// like walking the corridors". The load-bearing shift is that a room no longer owns an
// independent (col,row) grid cell — every room is placed by `buildFloors()` along a shared
// corridor, and its position, door and floor are all OUTPUTS of that one layout pass, never
// independently chosen.

import type { AgentRunEventKind } from "./agentEvents";
import type { ExecutionStatus } from "./approvalsShared";

// ── Taxonomy (shared with the Agent Floor's ops view — plan §4.4) ───────────────────────────────
export type OfficeKind = "human" | "agent" | "automation" | "external";
export type AssuranceTier = "anonymous" | "low" | "verified";

export const KIND_LABEL: Record<OfficeKind, string> = {
  human: "Human employee",
  agent: "Internal AI agent",
  automation: "Automation / workflow",
  external: "External agent",
};

export const ASSURANCE_LABEL: Record<AssuranceTier, string> = {
  anonymous: "Anonymous",
  low: "Low assurance",
  verified: "Verified",
};

// ── Emote bubbles (req #2, 2026-08-23) — one glyph per REAL agent-run event kind ─────────────────
// Maps `AgentRunEvent.kind` (agentEvents.ts) to the short label a bubble/roster row shows. Never
// used for a human: `activeRunId` (the thing that gates whether an avatar is even eligible for a
// bubble) is only ever set on an `agent`-kind avatar by office-data.ts — there is no equivalent
// activity feed for a human, and OfficeCanvas.tsx double-checks `kind === "agent"` at its own draw
// call site rather than trusting this alone (see that file's header comment on the two layers).
export const EMOTE_LABEL: Record<AgentRunEventKind, string> = {
  model: "Thinking",
  tool: "Working",
  delegate: "Handing over",
  approval_wait: "Waiting on you",
  error: "Error",
};

// ── Rooms ─────────────────────────────────────────────────────────────────────────────────────
// Binding model (plan §4.3): a Room is bound to a REAL entity, never invented. `deptId` is the
// org-structure department node id when kind === "department" — the same id every department
// console/nav row already uses, so a room can never point at a department that doesn't exist.
// "agents" is a first-class estate-level room (Operations — tenant-wide agents live here from
// day one, independent of org structure), never a fallback. "unassigned" stays reserved for a
// genuine binding failure — a real thing that has nowhere else to go.
export type OfficeRoomKind = "lobby" | "department" | "agents" | "utility" | "unassigned";

export interface OfficeRoomInput {
  key: string;
  label: string;
  kind: OfficeRoomKind;
  deptId?: string;
  /** What binds this room to a real thing, shown in its header. */
  boundTo: string;
  /** Real headcount this room must seat in its steady state (home room) — drives footprint
   *  (req #3: "rooms will grow to accommodate employee"). Never includes anyone only passing
   *  through mid-replay; that would make a room's SIZE depend on a moment-to-moment animation
   *  state, which is exactly the kind of derived-activity coupling plan §2 rules out elsewhere. */
  occupantCount: number;
}

export interface OfficeRoom extends OfficeRoomInput {
  /** Tile-space rect, absolute WITHIN ITS OWN FLOOR — floors are independent footprints, rendered
   *  one at a time (req #2), never stacked into one shared coordinate space. */
  x: number;
  y: number;
  wTiles: number;
  hTiles: number;
  /** Desk columns THIS room was laid out with — grows with occupantCount (req #3). Callers must
   *  use this instead of any fixed constant when computing desk slots. */
  deskCols: number;
  /** 0-based floor index (req #2). */
  floor: number;
  /** Which side of the corridor spine the room opens onto — its door sits on the wall touching
   *  the corridor (south wall for a "north" room, north wall for a "south" room). */
  side: "north" | "south";
  /** Door centre, in the room's own x-axis tile coordinate (same space as `x`) — where the
   *  doorway gap is cut into the corridor-facing wall. */
  doorX: number;
}

// Tile grid constants. 16px is the LPC/GBA-era convention the plan freezes for sprites (§4.3b).
export const TILE_PX = 16;
/** Integer-only zoom (plan §4.3b: "fractional scaling destroys pixel art") — the one multiplier
 *  between tile-space and canvas device pixels. */
export const ZOOM = 2;

export function tilesToPx(tiles: number): number {
  return tiles * TILE_PX * ZOOM;
}

// ── Room footprint from headcount (req #3) ───────────────────────────────────────────────────
// Desk slots inside a room — leaving a header band clear for the room's nameplate, and wide
// enough spacing that two neighbouring name labels don't collide.
export const DESK_MARGIN_TILES = 1.6;
/** Clearance from the room's own top edge to the FIRST desk row. Must clear the nameplate band
 *  mounted there (WALL_TILES + ~1.35 tiles of plate, in OfficeCanvas.tsx's drawNamePlate) PLUS the
 *  desk furniture's own header (a desk box sits visually above its seat tile, in the furniture
 *  pass) — 2.6 left the desk box overlapping the nameplate text on every room whose door faces
 *  south (nameplate stays up top); 3.6 was verified against a real render to clear it. */
export const DESK_TOP_TILES = 3.6;
export const DESK_SPACING_TILES = 3.0;
/** The real, gutter-safe width a desk's name label may use before it risks touching its neighbour
 *  — DERIVED from `DESK_SPACING_TILES` (never an independent literal chosen by eye in the canvas
 *  file) so the two can never drift apart. 0.3 tiles of clearance either side of a label is enough
 *  that two full-width labels on adjacent desks still leave a visible gap. */
export const NAME_SLOT_TILES = DESK_SPACING_TILES - 0.3;
/** A room with nobody real in it, and none imagined, is still a room — this is the floor beneath
 *  which a room never shrinks regardless of occupantCount. Matches roomSizeTiles's own one-row
 *  output so this is a real floor, not a lower number that the formula already exceeds. */
export const ROOM_MIN_W_TILES = 9;
export const ROOM_MIN_H_TILES = 7.6;

/** How many desk COLUMNS a room of this occupancy lays out with. A department of 2 stays a tidy
 *  3-wide room; a department of 9 widens rather than growing absurdly tall — the footprint reads
 *  as "bigger room" in both dimensions, not one long corridor of desks. */
export function deskColsForOccupancy(occupantCount: number): number {
  if (occupantCount <= 3) return 3;
  if (occupantCount <= 8) return 4;
  return 5;
}

/** The room footprint (in tiles) that fits `occupantCount` real desks plus the SAME "complete the
 *  current row" vacant-seat allowance the canvas already draws (a vacant desk is information, not
 *  clutter — never a fixed pad of three). Pure and deterministic: same occupantCount always
 *  produces the same size, which is what keeps the floor-plan allocator (`buildFloors`) stable
 *  across renders. */
export function roomSizeTiles(occupantCount: number): { wTiles: number; hTiles: number; deskCols: number } {
  const deskCols = deskColsForOccupancy(occupantCount);
  const seats = Math.max(occupantCount, 1); // an empty room still draws one row of vacant desks
  const rows = Math.max(1, Math.ceil(seats / deskCols));
  const w = DESK_MARGIN_TILES * 2 + (deskCols - 1) * DESK_SPACING_TILES + 1.4;
  const h = DESK_TOP_TILES + rows * DESK_SPACING_TILES + 1.0;
  return { wTiles: Math.max(ROOM_MIN_W_TILES, w), hTiles: Math.max(ROOM_MIN_H_TILES, h), deskCols };
}

// ── The floor plate — one connected building, not detached boxes (req #1) ───────────────────────
// A "double-loaded corridor" plan: a single corridor spine runs the width of the floor, and rooms
// open onto it from both sides, door aligned to the corridor. This is a real floor-plan topology
// (the standard office/hotel layout), not a decorative connector between independent boxes —
// walking from one room to another means walking the corridor, because the corridor is the only
// walkable path between rooms (see buildWalkableGrid/findPath below).
export const CORRIDOR_W_TILES = 4;
export const OUTER_MARGIN_TILES = 2;
/** Gap between two adjacent rooms on the same side of the same corridor. */
export const ROOM_GAP_TILES = 2;
/** When placing the next room would push a floor's corridor past this length, close the floor and
 *  start a new one (req #2: "if not enough make another screen"). Chosen so a small/medium
 *  tenant's real department count comfortably fits one floor, while a large one visibly splits. */
export const MAX_FLOOR_WIDTH_TILES = 96;
export const DOOR_WIDTH_TILES = 1.8;

export interface OfficeFloor {
  /** 0-based; the floor selector shows `index + 1`. Lobby is always placed first in the input
   *  order (office-data.ts's own room ordering), so it always lands on floor 0 — "Keep the Lobby
   *  on the ground floor" falls out of the algorithm rather than needing a special case. */
  index: number;
  rooms: OfficeRoom[];
  /** Top-of-corridor y, in this floor's own tile space. */
  corridorY: number;
  widthTiles: number;
  heightTiles: number;
}

/** Packs an ordered list of rooms into one or more connected floor plates. DETERMINISTIC: the
 *  only inputs are the room list's order and each room's occupantCount-derived size, so the same
 *  org data always assigns the same room to the same floor across renders (req #2: "a department
 *  must not move floors between renders") — there is no randomness and no reliance on wall-clock
 *  time anywhere in this function.
 *
 *  Greedy corridor fill: walk the rooms in order, always placing the next room on whichever side
 *  of the CURRENT floor's corridor is currently shorter (a simple balance heuristic, not a bin-
 *  packing optimum — legibility matters more than density here). When the next room would push
 *  the corridor past MAX_FLOOR_WIDTH_TILES, the current floor is closed and a new one started. */
export function buildFloors(inputs: OfficeRoomInput[]): OfficeFloor[] {
  const floors: OfficeFloor[] = [];
  let floorRooms: OfficeRoom[] = [];
  let cursorNorth = OUTER_MARGIN_TILES;
  let cursorSouth = OUTER_MARGIN_TILES;
  let northMaxH = 0;
  let southMaxH = 0;
  let floorIndex = 0;

  const closeFloor = () => {
    if (floorRooms.length === 0) return;
    const corridorY = OUTER_MARGIN_TILES + northMaxH;
    for (const r of floorRooms) {
      r.y = r.side === "north" ? corridorY - r.hTiles : corridorY + CORRIDOR_W_TILES;
    }
    const widthTiles = Math.max(cursorNorth, cursorSouth) - ROOM_GAP_TILES + OUTER_MARGIN_TILES;
    const heightTiles = OUTER_MARGIN_TILES + northMaxH + CORRIDOR_W_TILES + southMaxH + OUTER_MARGIN_TILES;
    floors.push({ index: floorIndex, rooms: floorRooms, corridorY, widthTiles, heightTiles });
    floorIndex += 1;
    floorRooms = [];
    cursorNorth = OUTER_MARGIN_TILES;
    cursorSouth = OUTER_MARGIN_TILES;
    northMaxH = 0;
    southMaxH = 0;
  };

  for (const input of inputs) {
    const size = roomSizeTiles(input.occupantCount);
    const provisionalSide: "north" | "south" = cursorNorth <= cursorSouth ? "north" : "south";
    const provisionalCursor = provisionalSide === "north" ? cursorNorth : cursorSouth;
    if (floorRooms.length > 0 && provisionalCursor + size.wTiles > MAX_FLOOR_WIDTH_TILES) {
      closeFloor();
    }
    const side: "north" | "south" = cursorNorth <= cursorSouth ? "north" : "south";
    const x = side === "north" ? cursorNorth : cursorSouth;
    const room: OfficeRoom = {
      ...input,
      x,
      y: 0, // fixed up in closeFloor, once the floor's corridor position is known
      wTiles: size.wTiles,
      hTiles: size.hTiles,
      deskCols: size.deskCols,
      floor: floorIndex,
      side,
      doorX: x + size.wTiles / 2,
    };
    floorRooms.push(room);
    if (side === "north") {
      cursorNorth = x + size.wTiles + ROOM_GAP_TILES;
      northMaxH = Math.max(northMaxH, size.hTiles);
    } else {
      cursorSouth = x + size.wTiles + ROOM_GAP_TILES;
      southMaxH = Math.max(southMaxH, size.hTiles);
    }
  }
  closeFloor();
  return floors;
}

export function allRooms(floors: OfficeFloor[]): OfficeRoom[] {
  return floors.flatMap((f) => f.rooms);
}

/** A room's rectangle in TILE units (not px) — multiply by TILE_PX*ZOOM (tilesToPx) for canvas
 *  coordinates. Trivial now that layout already stamped x/y/wTiles/hTiles onto the room. */
export function roomTileRect(room: OfficeRoom): { x: number; y: number; w: number; h: number } {
  return { x: room.x, y: room.y, w: room.wTiles, h: room.hTiles };
}

/** Centre of the Nth avatar's "desk" inside a room, in TILE units — uses the room's OWN deskCols
 *  (variable per room, from roomSizeTiles), never a fixed constant, so a wide 9-person room's
 *  desks line up with the walls that were actually sized for it.
 *
 *  Row anchoring is to the room's OWN NAMEPLATE WALL, never the doorway wall — consistently,
 *  regardless of which side of the corridor the room sits on (polish fix, 2026-08-23: rows used to
 *  anchor to `room.y`/the room's top edge unconditionally, which is the nameplate wall for a
 *  "north" room but the DOORWAY wall for a "south" one — desks hugged the nameplate in one and the
 *  door in the other. `drawNamePlate`/the back-corner plant already got this right by keying off
 *  `room.side`; this now matches them). A "north" room's nameplate is on `room.y` (its door is on
 *  the corridor-facing wall opposite it), so desks start `DESK_TOP_TILES` down from there and grow
 *  toward the door. A "south" room's nameplate is on its FAR edge (`room.y + hTiles`), so desks
 *  start `DESK_TOP_TILES` UP from there and grow toward the door at the top — the mirror image,
 *  not a re-run of the same formula. */
export function deskSlotTile(room: OfficeRoom, index: number): { x: number; y: number } {
  const cols = Math.max(1, room.deskCols);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const y = room.side === "north"
    ? room.y + DESK_TOP_TILES + row * DESK_SPACING_TILES
    : room.y + room.hTiles - DESK_TOP_TILES - row * DESK_SPACING_TILES;
  return {
    x: room.x + DESK_MARGIN_TILES + col * DESK_SPACING_TILES,
    y,
  };
}

export function roomCenterTile(room: OfficeRoom): { x: number; y: number } {
  return { x: room.x + room.wTiles / 2, y: room.y + room.hTiles / 2 };
}

// ── Pathfinding — walk the corridor, never through a wall (req #6) ──────────────────────────────
// A coarse 1-tile-resolution walkable grid: corridor cells, plus each room's interior (inset by
// one cell, standing in for its wall) with a doorway gap cut through to the corridor at the
// room's own doorX. Hand-rolled BFS over 4-connected neighbours — "simple grid pathfinding", no
// library, per the plan.
export interface FloorGrid {
  w: number;
  h: number;
  walk: Uint8Array; // 1 = walkable, 0 = wall/void
}

function cellIndex(grid: FloorGrid, x: number, y: number): number {
  return y * grid.w + x;
}

function isWalkable(grid: FloorGrid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return false;
  return grid.walk[cellIndex(grid, x, y)] === 1;
}

export function buildWalkableGrid(floor: OfficeFloor): FloorGrid {
  const w = Math.max(1, Math.ceil(floor.widthTiles));
  const h = Math.max(1, Math.ceil(floor.heightTiles));
  const walk = new Uint8Array(w * h);
  const mark = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi >= 0 && xi < w && yi >= 0 && yi < h) walk[yi * w + xi] = 1;
  };

  const corridorY0 = Math.round(floor.corridorY);
  const corridorY1 = Math.round(floor.corridorY + CORRIDOR_W_TILES);
  for (let y = corridorY0; y < corridorY1; y++) {
    for (let x = 0; x < w; x++) mark(x, y);
  }

  const doorHalf = Math.max(1, Math.round(DOOR_WIDTH_TILES / 2));
  for (const room of floor.rooms) {
    const x0 = Math.round(room.x);
    const y0 = Math.round(room.y);
    const x1 = Math.round(room.x + room.wTiles);
    const y1 = Math.round(room.y + room.hTiles);
    for (let y = y0 + 1; y < y1 - 1; y++) {
      for (let x = x0 + 1; x < x1 - 1; x++) mark(x, y);
    }
    const doorX = Math.round(room.doorX);
    const doorY = room.side === "north" ? y1 - 1 : y0;
    for (let x = doorX - doorHalf; x <= doorX + doorHalf; x++) mark(x, doorY);
  }
  return { w, h, walk };
}

/** Nearest walkable cell to a (possibly fractional, possibly wall-inset) point, searched in
 *  expanding rings. Lets callers hand in a room centre or desk slot without knowing exactly where
 *  this grid's walls fell. */
export function nearestWalkable(grid: FloorGrid, x: number, y: number, maxRadius = 6): { x: number; y: number } | null {
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (isWalkable(grid, cx, cy)) return { x: cx, y: cy };
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isWalkable(grid, cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
    }
  }
  return null;
}

/** Hand-rolled BFS over the walkable grid — unweighted 4-neighbour, which is exactly right for a
 *  tile corridor network (every step costs one tile). Returns an inclusive tile-centre waypoint
 *  list from `start` to `goal`, or null if either point has no nearby walkable cell or no route
 *  connects them. */
export function findPath(grid: FloorGrid, start: { x: number; y: number }, goal: { x: number; y: number }): { x: number; y: number }[] | null {
  const s = nearestWalkable(grid, start.x, start.y);
  const g = nearestWalkable(grid, goal.x, goal.y);
  if (!s || !g) return null;
  const startIdx = cellIndex(grid, s.x, s.y);
  const goalIdx = cellIndex(grid, g.x, g.y);
  if (startIdx === goalIdx) return [s];

  const visited = new Uint8Array(grid.w * grid.h);
  const prev = new Int32Array(grid.w * grid.h).fill(-1);
  visited[startIdx] = 1;
  const queue: number[] = [startIdx];
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let found = false;
  for (let qi = 0; qi < queue.length && !found; qi++) {
    const cur = queue[qi];
    const cx = cur % grid.w;
    const cy = Math.floor(cur / grid.w);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      const ni = cellIndex(grid, nx, ny);
      if (visited[ni]) continue;
      visited[ni] = 1;
      prev[ni] = cur;
      if (ni === goalIdx) { found = true; break; }
      queue.push(ni);
    }
  }
  if (!visited[goalIdx]) return null;

  const path: { x: number; y: number }[] = [];
  let cur = goalIdx;
  for (;;) {
    path.push({ x: cur % grid.w, y: Math.floor(cur / grid.w) });
    if (cur === startIdx) break;
    cur = prev[cur];
  }
  path.reverse();
  return path;
}

/** The full walking route between two rooms on the SAME floor: room centre → its own door → the
 *  corridor route between the two doors → the destination door → destination centre. Never a
 *  straight line through a wall (req #6). Returns null when no corridor route connects the two
 *  doors — callers fall back to a direct two-point line, which is a rendering simplification
 *  (never a fabricated fact) for the rare case pathfinding can't resolve. */
export function roomToRoomPath(grid: FloorGrid, fromRoom: OfficeRoom, toRoom: OfficeRoom): { x: number; y: number }[] | null {
  const fromCenter = roomCenterTile(fromRoom);
  const toCenter = roomCenterTile(toRoom);
  const fromDoor = { x: fromRoom.doorX, y: fromRoom.side === "north" ? fromRoom.y + fromRoom.hTiles : fromRoom.y };
  const toDoor = { x: toRoom.doorX, y: toRoom.side === "north" ? toRoom.y + toRoom.hTiles : toRoom.y };
  const corridorLeg = findPath(grid, fromDoor, toDoor);
  if (!corridorLeg) return null;
  return [fromCenter, ...corridorLeg, toCenter];
}

/** Total Euclidean length (in tiles) of a polyline path — the denominator `pointAlongPath` walks
 *  proportionally along. */
export function pathLength(path: { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  return total;
}

/** The point a fraction `t` of the way along a multi-segment path, by DISTANCE (not by segment
 *  count) — so a long corridor leg and a short doorway hop both advance at the same visual speed.
 *  Degenerates gracefully for 0/1-point paths and zero-length paths. */
export function pointAlongPath(path: { x: number; y: number }[], t: number): { x: number; y: number } {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return path[0];
  const total = pathLength(path);
  if (total === 0) return path[0];
  let remaining = clamp01(t) * total;
  for (let i = 1; i < path.length; i++) {
    const segLen = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (remaining <= segLen || i === path.length - 1) {
      const segT = segLen === 0 ? 0 : remaining / segLen;
      return { x: lerp(path[i - 1].x, path[i].x, segT), y: lerp(path[i - 1].y, path[i].y, segT) };
    }
    remaining -= segLen;
  }
  return path[path.length - 1];
}

// ── Camera — zoom / pan / follow (req #1, 2026-08-23) ────────────────────────────────────────────
// The camera is a VIEWPORT transform, never a redraw. `OfficeCanvas.tsx` still renders the whole
// floor plate into the canvas at its native content size (unchanged from before this feature); the
// camera only changes what CSS `transform` places that already-drawn bitmap under, inside a
// fixed-size viewport `<div>` with `overflow: hidden`. That is what "the camera is a transform on
// the existing canvas" (the ticket's own words) means literally — no second render path, no game
// engine, and the canvas keeps drawing in one coordinate space regardless of zoom/pan.
//
// Integer-only zoom (req #1: "fractional scaling destroys pixel art"): a CSS `scale()` of an
// integer multiplies whole device pixels onto whole device pixels, so nearest-neighbour sampling
// (the canvas already sets `image-rendering: pixelated`) reproduces every source pixel as an exact
// NxN block — no blending, no seams. A fractional CSS scale would resample between source pixels
// and blur the sprite art the same way an un-integer TILE_PX/ZOOM would (see that constant's own
// comment above).
export type ZoomLevel = 1 | 2 | 3;
export const ZOOM_LEVELS: readonly ZoomLevel[] = [1, 2, 3];

export interface Camera {
  scale: ZoomLevel;
  /** The content-space (css px, i.e. the SAME space `tilesToPx` already produces — pre-camera-
   *  scale) point currently centred in the viewport. */
  centerX: number;
  centerY: number;
}

/** The largest integer step in `ZOOM_LEVELS` that shows the WHOLE plate inside a viewport of the
 *  given size — "Fit" (req #1). Falls back to the smallest step (1) both when the content is
 *  degenerate (no floor yet) and when even 1x can't fit the whole plate in the viewport (a very
 *  wide floor plate on a small window) — 1 is still the closest any integer step gets to "the
 *  whole plate", and `clampCamera` below is what lets panning reach the rest. */
export function fitZoomLevel(contentW: number, contentH: number, viewportW: number, viewportH: number): ZoomLevel {
  if (contentW <= 0 || contentH <= 0 || viewportW <= 0 || viewportH <= 0) return 1;
  let best: ZoomLevel = 1;
  for (const z of ZOOM_LEVELS) {
    if (contentW * z <= viewportW && contentH * z <= viewportH) best = z;
  }
  return best;
}

/** Clamp a camera's centre so the plate can never be lost off-screen (req #1). On an axis where
 *  the SCALED plate is smaller than the viewport, there is nothing to pan — the centre locks to
 *  the plate's own centre on that axis (never lets the plate drift to one side leaving a gap on
 *  the other). Otherwise the centre is bounded so the viewport's edge never crosses the plate's
 *  own edge. */
export function clampCamera(camera: Camera, contentW: number, contentH: number, viewportW: number, viewportH: number): Camera {
  const clampAxis = (center: number, contentSize: number, viewportSize: number, scale: number): number => {
    const half = viewportSize / (2 * scale);
    if (contentSize <= viewportSize / scale) return contentSize / 2;
    return Math.min(contentSize - half, Math.max(half, center));
  };
  return {
    scale: camera.scale,
    centerX: clampAxis(camera.centerX, contentW, viewportW, camera.scale),
    centerY: clampAxis(camera.centerY, contentH, viewportH, camera.scale),
  };
}

/** Cursor-anchored zoom (req #1): change scale while keeping the CONTENT point currently under
 *  the pointer (given in viewport px, relative to the viewport's own top-left) fixed on screen —
 *  the same behaviour every pixel-editor/map app's scroll-zoom has. Pure: does not clamp its own
 *  result (callers run it through `clampCamera` after, same as any other camera mutation). */
export function zoomCameraAtPoint(
  camera: Camera, nextScale: ZoomLevel, pointerVX: number, pointerVY: number, viewportW: number, viewportH: number,
): Camera {
  if (nextScale === camera.scale) return camera;
  const contentX = camera.centerX + (pointerVX - viewportW / 2) / camera.scale;
  const contentY = camera.centerY + (pointerVY - viewportH / 2) / camera.scale;
  return {
    scale: nextScale,
    centerX: contentX - (pointerVX - viewportW / 2) / nextScale,
    centerY: contentY - (pointerVY - viewportH / 2) / nextScale,
  };
}

/** The CSS `transform` string that places the canvas (drawn at its native content size, top-left
 *  at the origin) so that `camera` is what the viewport shows. Derivation: a viewport-space point
 *  should land at `scale*(contentPoint - centre) + viewportSize/2`; `translate(t) scale(s)` (CSS
 *  composes right-to-left) computes `s*p + t`, so `t = viewportSize/2 - scale*centre`. */
export function cssTransformForCamera(camera: Camera, viewportW: number, viewportH: number): string {
  const tx = viewportW / 2 - camera.centerX * camera.scale;
  const ty = viewportH / 2 - camera.centerY * camera.scale;
  return `translate(${tx}px, ${ty}px) scale(${camera.scale})`;
}

/** Inverse of the transform above: a viewport-space point (e.g. a pointer event's coordinates
 *  relative to the viewport) back to content-space (the same space avatar tile positions are
 *  already computed in), for hit-testing under an active camera. */
export function viewportToContentPoint(
  camera: Camera, viewportX: number, viewportY: number, viewportW: number, viewportH: number,
): { x: number; y: number } {
  return {
    x: camera.centerX + (viewportX - viewportW / 2) / camera.scale,
    y: camera.centerY + (viewportY - viewportH / 2) / camera.scale,
  };
}

// ── Avatars ───────────────────────────────────────────────────────────────────────────────────
// Every avatar resolves to a real record — a person, an agent goal, a systems console, or (for the
// one external-agent demo seat) a plainly-labelled fixture. `recordHref`, when present, is a route
// that actually exists in this app; the office never invents a link.
export interface OfficeAvatar {
  id: string;
  kind: OfficeKind;
  name: string;
  /** Room the avatar sits in when no movement event has placed it elsewhere. */
  homeRoomKey: string;
  /** Stable slot index within its room — deterministic desk assignment. */
  deskIndex: number;
  recordKind: string;
  recordId: string;
  recordLabel: string;
  recordHref?: string;
  assurance?: AssuranceTier;
  /** Honesty note shown in the detail panel — e.g. "DEMO fixture", or what real data backs it. */
  note: string;
  /** O4 (req #5): the id of this agent's real, currently in-flight run — set ONLY for an
   *  `agent`-kind avatar whose goal genuinely has a run without an end time yet. The client polls
   *  `GET /api/admin/agents/runs/:runId/events` for this id to decide whether to show a working
   *  animation (recent real events) or a static "last heard" state (a run that's open but quiet).
   *  Never set for `human` — humans have no comparable real activity feed (see plan §3), so a
   *  human avatar must never carry this field, and OfficeCanvas never fabricates one. */
  activeRunId?: string;
  /** SIM-01 (2026-08-24) — the moment this avatar's REAL work signal goes stale, as an ISO string.
   *
   *  This is the humans' counterpart to `activeRunId`, and it is a SEPARATE field on purpose: the
   *  doc above says a human avatar must never carry `activeRunId`, and that rule is right — an
   *  agent run is a specific thing a person does not have. What a person does have is a stream of
   *  real recorded actions (`activities`: created / commented / updated), and `office-data.ts`
   *  turns the most recent one into this timestamp.
   *
   *  Semantics deliberately differ from `activeRunId`'s: there is nothing to poll. The value is
   *  computed once per scene from data the server already read, and the canvas simply compares it
   *  to the clock. That keeps the human feed free of the per-avatar polling the agent feed needs,
   *  which matters at 26 seats.
   *
   *  Absent means "no recent recorded action", which renders exactly as it does today — a still
   *  desk. It never means "idle": somebody can be working hard on something the ERP never sees.
   *  The detail-panel note says so, because a floor that implies otherwise would be a surveillance
   *  claim the data cannot support. */
  busyUntil?: string;
  /** Automations only (2026-08-24) — the real signal `resolveAutomationState` below turns into an
   *  animation. Undefined means "this avatar carries no execution-tracking claim at all" (e.g. the
   *  two estate-level systems-console seats, which are not gated through automation-approvals) —
   *  the canvas must render those exactly as before this field existed, never as "unknown" (that
   *  word is reserved for a signal that WAS checked and came back unresolved; see
   *  `AutomationSignal.checked`). Never set for `human` or `agent` — those have their own activity
   *  models. */
  automationSignal?: AutomationSignal;
  /** Automations only, COLOUR PURPOSES ONLY (owner override, 2026-08-24) — see
   *  `automationColorToken`'s own doc for the fallback chain this feeds, and for why it consciously
   *  overrides office-data.ts's earlier "automations carry no department tone" reasoning (kept in
   *  place there, not deleted, so that reasoning isn't silently erased). Undefined for every
   *  automation today — none has a real department binding yet — which correctly falls through to
   *  grey; this is never used to change WHERE an automation sits (`homeRoomKey`) or any other fact
   *  about it. */
  deptId?: string;
}

// ── Movement events — the ONLY thing that may move an avatar (plan §3: "motion is a claim") ─────
export interface OfficeMoveEvent {
  id: string;
  avatarId: string;
  fromRoomKey: string;
  toRoomKey: string;
  /** Real ISO timestamp of the recorded event — never fabricated as "now". */
  at: string;
  /** Short delegation/handover label shown on hover during replay and in the detail panel. */
  reason: string;
}

export interface OfficeScene {
  floors: OfficeFloor[];
  avatars: OfficeAvatar[];
  events: OfficeMoveEvent[];
  generatedAt: string;
}

/** Where an avatar actually is "as of" a given instant: the `toRoomKey` of its latest event at or
 *  before `asOfMs`, else its home room. Pure — no clock reads, so a fixed instant is reproducible
 *  in a test and in the demo banner alike. */
export function restingRoomKey(avatar: OfficeAvatar, events: OfficeMoveEvent[], asOfMs: number): string {
  let latest: OfficeMoveEvent | null = null;
  for (const e of events) {
    if (e.avatarId !== avatar.id) continue;
    const t = Date.parse(e.at);
    if (Number.isNaN(t) || t > asOfMs) continue;
    if (!latest || t > Date.parse(latest.at)) latest = e;
  }
  return latest ? latest.toRoomKey : avatar.homeRoomKey;
}

// ── Replay scheduling ─────────────────────────────────────────────────────────────────────────
// The RECORDED fact is `at` (a real past instant) and `fromRoomKey -> toRoomKey`; how fast the
// replay walks the sprite across the screen is a rendering choice, exactly like an animation
// duration always is. This never invents an event or a destination — it only re-paces existing
// ones for legibility, and the detail panel always shows the true recorded `at`.
export interface ReplayStep extends OfficeMoveEvent {
  startMs: number;
  endMs: number;
}

const REPLAY_STEP_MS = 1600;
const REPLAY_TRAVEL_FRACTION = 0.7;

/** Orders real events chronologically and assigns a fixed-cadence playback schedule. Reduced
 *  motion collapses every step's duration to 0 — an instant cut, never a skipped fact. */
export function buildReplaySteps(events: OfficeMoveEvent[], reducedMotion = false): ReplayStep[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return sorted.map((e, i) => {
    const startMs = i * REPLAY_STEP_MS;
    const travel = reducedMotion ? 0 : REPLAY_STEP_MS * REPLAY_TRAVEL_FRACTION;
    return { ...e, startMs, endMs: startMs + travel };
  });
}

export function totalReplayMs(steps: ReplayStep[]): number {
  if (steps.length === 0) return 0;
  return Math.max(...steps.map((s) => s.startMs)) + REPLAY_STEP_MS;
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

// ── Deterministic, art-free identity: a stable palette index from a principal id ────────────────
// No lookup table, no art request — the same id always draws the same tone, and the 8-tone
// categorical ramp (tokens/colors.css --cat-1..8) is already accessible-contrast-checked.
export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** `--cat-1`..`--cat-8`, deterministic per id. Used for human/agent department tone — never for
 *  automation (grey, no department tone by design) or the raw external palette. */
export function catToken(id: string): string {
  return `--cat-${(hashId(id) % 8) + 1}`;
}

// ── O4 — "genuinely working" (req #5) ────────────────────────────────────────────────────────
// A run is treated as actively working only while it has produced a REAL event within this
// window. Longer than the runner's own step cadence so a normal thinking pause doesn't flicker
// the animation off, short enough that a run that has gone quiet stops claiming to be live within
// well under a minute — matching the plan's "working, last heard 4m ago" being a DIFFERENT,
// non-animated state from this one.
export const WORKING_RECENCY_MS = 45_000;

// ── The same question, a DIFFERENT signal shape (2026-08-24) ───────────────────────────────────
// `WORKING_RECENCY_MS` above is correct for an AGENT RUN, and only for an agent run, because a run
// emits a continuous stream of events: 45s of silence genuinely means it stopped. An AUTOMATION
// emits nothing of the kind. Its `executed_at` is a POINT EVENT — one instant, recorded once, when
// the thing ran. Asking "was that instant inside 45 seconds" gives the desk an animation that
// exists for 45 seconds out of the automation's entire life, which is why the office looked dead:
// not a missing animation, a window measured against the wrong kind of signal.
//
// Ten minutes is chosen to mean "recently", not "now" — see `just_ran` below, which is the state
// that keeps this honest. Widening `executing` itself to ten minutes was the obvious fix and is
// the wrong one: it would have the desk claim "Executing now" for ten minutes after the run
// finished, trading a dead office for a lying one.
export const AUTOMATION_RECENCY_MS = 10 * 60_000;

/** Pure decision: given the latest known event timestamp for a run (ms epoch, or null if nothing
 *  has arrived yet) and the current instant, is this genuinely working right now? Kept as its own
 *  function so the 45s window is defined once and the component never re-derives it inline. */
export function isGenuinelyWorking(lastEventAtMs: number | null, nowMs: number): boolean {
  if (lastEventAtMs == null) return false;
  return nowMs - lastEventAtMs <= WORKING_RECENCY_MS;
}

// ── Automations — the SAME three-state honesty model, driven by automation_approvals ────────────
// (2026-08-24: "make the office visibly busy... from real data"). The real signal is
// `lib/automationApprovals.ts`'s per-tenant rows: a still-`pending` row means a human is being
// waited on; a DECIDED row's `execution_status`/`executed_at`/`execution_error` says what actually
// happened to the write once approved (that file's own header — a pending row is always
// `not_applicable` there, never confused with "idle"). office-data.ts assembles the raw
// `AutomationSignal` per automation from those real rows; everything below is the PURE decision
// over that signal, so it's testable with plain data and never needs a live backend to verify.
export interface AutomationSignal {
  /** False when the automation-approvals reader genuinely could not be consulted for this
   *  automation (a real fetch failure — NOT a 403/404, which `listAutomationApprovals` already
   *  degrades to a legitimate empty list, the same house rule every other lib/*.ts reader follows).
   *  `resolveAutomationState` treats `checked: false` as UNKNOWN regardless of what the other
   *  fields say — never coerced to "idle" just because they're empty too (the exact trap this
   *  ticket calls out: "a row the reader cannot see is ABSENT ... never as not_applicable"). */
  checked: boolean;
  /** True while a decision-pending row exists for this automation right now. */
  pendingApproval: boolean;
  /** The most recent DECIDED row's execution_status this reader could see, or null when nothing
   *  has ever been decided for this automation. Never read off a pending row (always
   *  `not_applicable` there per automationApprovals.ts's own header). */
  executionStatus: ExecutionStatus | null;
  /** ms epoch of the freshest REAL timestamp behind that execution attempt — `executed_at` when
   *  the automation actually ran, or (only for a `failed` status) `decided_at` when the attempt
   *  never got as far as recording one (e.g. "hub_unreachable" before it started). Null means
   *  genuinely nothing timestamped is known — never a fabricated "just now". */
  asOfMs: number | null;
  executionError: string | null;
}

/** Real automations share the SAME freshness window O4 already uses for "is an agent genuinely
 *  working right now" (`WORKING_RECENCY_MS` above) rather than inventing a second number — both
 *  questions are identical ("did something real happen here recently enough to still call it
 *  live"), and a second constant would just be two competing opinions about the same fact with no
 *  reason either value should differ. If a real difference is ever needed, extract a SECOND named
 *  constant with a comment saying why — don't let call sites drift by re-using the number inline. */
export type AutomationActivityState = "executing" | "just_ran" | "awaiting_approval" | "failed" | "idle" | "unknown";

/** Pure: signal in, state out — priority order matters. A pending approval is the LOUDEST fact
 *  regardless of any stale execution history (an automation blocked on a human is exactly what
 *  should be visible across a room, same rule as an agent's `approval_wait`). A `failed` status
 *  only reads as failed WITHIN the freshness window — outside it, the same failure fades to idle
 *  rather than staying alarming forever (req: "distinct and not alarming-by-default-forever"). A
 *  fresh `executed_at` with no failure — including a genuinely in-flight `executing` status, which
 *  needs no freshness check at all because "in-flight" is already a live fact — reads as executing:
 *  the desk just did (or is doing) something real. Everything else is idle: nothing recent, and
 *  idle is still. */
export function resolveAutomationState(signal: AutomationSignal, nowMs: number): AutomationActivityState {
  if (!signal.checked) return "unknown";
  if (signal.pendingApproval) return "awaiting_approval";
  const fresh = signal.asOfMs != null && nowMs - signal.asOfMs <= AUTOMATION_RECENCY_MS;
  if (signal.executionStatus === "failed") return fresh ? "failed" : "idle";
  // `executing` is a LIVE claim and takes no freshness check, because the status itself already
  // asserts in-flight. It is the only state that may animate as "happening now".
  if (signal.executionStatus === "executing") return "executing";
  // A finished run inside the window. Previously this returned `executing` — the desk asserting a
  // run was in flight when the row it read said the run had already completed. Separating the two
  // is what lets the window widen: `just_ran` can be generous precisely because it claims only
  // that something happened recently, which is exactly what the timestamp supports.
  return fresh ? "just_ran" : "idle";
}

/** Detail-panel copy for each state (req: unknown must "say so ... rather than rendering a
 *  confident idle") — parallel to `EMOTE_LABEL` above, kept as its own map because these are full
 *  sentences for the panel, not bubble-glyph labels. */
export const AUTOMATION_STATE_LABEL: Record<AutomationActivityState, string> = {
  executing: "Executing now — a run is in flight behind this desk.",
  just_ran: "Ran in the last few minutes — finished, not running now.",
  awaiting_approval: "Waiting on a human approval right now.",
  failed: "Failed on its last real execution attempt.",
  idle: "Idle — nothing recent.",
  unknown: "Unknown — the automation-approvals reader could not be confirmed just now. Not the same as idle.",
};

/** The desk-tint fallback's grey — the honest default for an automation bound to no department
 *  (still the common case: see `automationColorToken`'s own doc). Named so `OfficeCanvas.tsx`'s
 *  `readTokens()` and this fallback chain share one literal instead of two independent guesses at
 *  the same CSS custom property. */
export const AUTOMATION_GREY_TOKEN = "--n-8";

/** Automation colour fallback chain (owner override, 2026-08-24): automations DO get a department
 *  tone when one genuinely applies, consciously overriding office-data.ts's earlier "automations
 *  carry no department tone by design" reasoning — that reasoning is left in place on the avatars
 *  it was written for rather than deleted, so read THIS comment as superseding it, not erasing it.
 *  Resolution order: (1) a real per-automation colour SETTING, when one exists — no settings UI or
 *  storage ships in this pass, so `settingToken` is always `null`/`undefined` today; the parameter
 *  exists so a future setting slots into this exact chain without redesigning it (2) the
 *  department's own `--cat-N` tone — the SAME deterministic id -> tone hash `catToken` already
 *  gives every human bound to that department, just fed the department id instead of a person id,
 *  so the same department paints the same tone everywhere it appears (3) grey, the honest default
 *  when the automation is bound to no department at all (still every real automation today). Pure:
 *  takes the already-resolved ids, never reaches into a store itself. */
export function automationColorToken(settingToken: string | null | undefined, deptId: string | null | undefined): string {
  if (settingToken) return settingToken;
  if (deptId) return catToken(deptId);
  return AUTOMATION_GREY_TOKEN;
}
