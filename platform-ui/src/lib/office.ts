// The Office — pure, client-safe types + layout/interpolation math for the `/office` prototype.
// See docs/superpowers/plans/2026-08-23-virtual-office-plan.md. This file holds NOTHING that
// needs a backend: room/avatar/event SHAPES, the deterministic layout of rooms into a tile grid,
// where an avatar rests "as of" a given instant, and the pure geometry a replay animation walks
// through. `office-data.ts` (server-only) fills these shapes from real org data + fixtures;
// `components/office/OfficeCanvas.tsx` (client) draws them.
//
// NO SPRITES. Per legal/asset-licences.md, nothing third-party is committed tonight — avatars are
// drawn procedurally on canvas (shape + palette, keyed by kind — see KIND_LABEL/drawing notes
// below). Swapping in real sprites later only touches the draw function; every shape here stays
// the same, because "kind" and "position" are already the interface a sprite renderer would need.

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

// ── Rooms ─────────────────────────────────────────────────────────────────────────────────────
// Binding model (plan §4.3): a Room is bound to a REAL entity, never invented. `deptId` is the
// org-structure department node id when kind === "department" — the same id every department
// console/nav row already uses, so a room can never point at a department that doesn't exist.
export type OfficeRoomKind = "lobby" | "department" | "utility" | "unassigned";

export interface OfficeRoomInput {
  key: string;
  label: string;
  kind: OfficeRoomKind;
  deptId?: string;
  /** What binds this room to a real thing, shown in its header. */
  boundTo: string;
}

export interface OfficeRoom extends OfficeRoomInput {
  /** Grid cell, in ROOM-sized units (not tiles) — see layoutRooms(). */
  col: number;
  row: number;
}

// Tile grid constants. 16px is the LPC/GBA-era convention the plan freezes for when real sprites
// land (§4.3b) — kept here even though nothing is sprited yet, so the floor already reads at the
// scale a sprite renderer would need, and swapping in art later touches no geometry.
export const TILE_PX = 16;
export const ROOM_W_TILES = 10;
export const ROOM_H_TILES = 7;
export const ROOM_GAP_TILES = 2;
export const GRID_COLS = 3;
/** Integer-only zoom (plan §4.3b: "fractional scaling destroys pixel art") — the one multiplier
 *  between tile-space and canvas device pixels. */
export const ZOOM = 2;

export function tilesToPx(tiles: number): number {
  return tiles * TILE_PX * ZOOM;
}

/** Packs a fixed order of rooms into a wrapping grid. Order is the caller's call (lobby first,
 *  departments alphabetical, unassigned, utility last) — this only assigns cells. */
export function layoutRooms(inputs: OfficeRoomInput[]): OfficeRoom[] {
  return inputs.map((r, i) => ({ ...r, col: i % GRID_COLS, row: Math.floor(i / GRID_COLS) }));
}

/** A room's rectangle in TILE units (not px) — multiply by TILE_PX for canvas coordinates. */
export function roomTileRect(room: OfficeRoom): { x: number; y: number; w: number; h: number } {
  const x = room.col * (ROOM_W_TILES + ROOM_GAP_TILES);
  const y = room.row * (ROOM_H_TILES + ROOM_GAP_TILES);
  return { x, y, w: ROOM_W_TILES, h: ROOM_H_TILES };
}

/** Overall floor size in tiles, from the room with the largest col/row. */
export function floorSizeTiles(rooms: OfficeRoom[]): { w: number; h: number } {
  if (rooms.length === 0) return { w: ROOM_W_TILES, h: ROOM_H_TILES };
  const maxCol = Math.max(...rooms.map((r) => r.col));
  const maxRow = Math.max(...rooms.map((r) => r.row));
  return {
    w: (maxCol + 1) * (ROOM_W_TILES + ROOM_GAP_TILES) - ROOM_GAP_TILES,
    h: (maxRow + 1) * (ROOM_H_TILES + ROOM_GAP_TILES) - ROOM_GAP_TILES,
  };
}

// Desk slots inside a room — a small fixed grid, leaving a header band clear for the room's
// label + caption, and wide enough spacing that two neighbouring name labels don't collide.
const DESK_COLS = 3;
const DESK_MARGIN_TILES = 1.6;
const DESK_TOP_TILES = 3.4;
const DESK_SPACING_TILES = 3.0;

/** Centre of the Nth avatar's "desk" inside a room, in TILE units (fractional — used for both the
 *  resting position and the interpolation endpoints). Wraps past DESK_COLS onto further rows. */
export function deskSlotTile(room: OfficeRoom, index: number): { x: number; y: number } {
  const rect = roomTileRect(room);
  const col = index % DESK_COLS;
  const row = Math.floor(index / DESK_COLS);
  return {
    x: rect.x + DESK_MARGIN_TILES + col * DESK_SPACING_TILES,
    y: rect.y + DESK_TOP_TILES + row * DESK_SPACING_TILES,
  };
}

export function roomCenterTile(room: OfficeRoom): { x: number; y: number } {
  const rect = roomTileRect(room);
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
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
  rooms: OfficeRoom[];
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
