"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatDateTime } from "@/lib/format";
import { formatRelativeTime } from "@/lib/timeFormat";
import { nextCursor, type AgentRunEvent, type AgentRunEventKind } from "@/lib/agentEvents";
import type { OfficeZoom } from "@/lib/prefs";
import { setOfficeZoomAction } from "@/lib/prefsActions";
import {
  KIND_LABEL, ASSURANCE_LABEL, EMOTE_LABEL, tilesToPx, NAME_SLOT_TILES,
  roomTileRect, deskSlotTile, roomCenterTile, allRooms,
  buildWalkableGrid, roomToRoomPath, pointAlongPath, isGenuinelyWorking,
  restingRoomKey, buildReplaySteps, totalReplayMs, catToken, hashId,
  DOOR_WIDTH_TILES, CORRIDOR_W_TILES,
  ZOOM_LEVELS, fitScale, nearestZoomLevel, clampCamera, zoomCameraAtPoint, cssTransformForCamera, viewportToContentPoint,
  resolveAutomationState, automationColorToken, AUTOMATION_GREY_TOKEN, AUTOMATION_STATE_LABEL,
  ambientWalkState, pickAmbientLine,
  type OfficeScene, type OfficeRoom, type OfficeRoomKind, type OfficeFloor, type OfficeAvatar, type ReplayStep,
  type Camera, type AutomationActivityState, type AmbientWalk,
} from "@/lib/office";
import {
  LAYER_PATHS, LAYER_ORDER, POSE_FRAME, FRAME_PX, LIGHT_RAMP, SKIN_RAMPS,
  spriteAssetPath, pickGender, pickSkinTone, facingRow, hexToRgb,
  type SpriteGender, type SpritePose,
} from "@/lib/office-sprites";
import {
  CHAR_PX, CHAR_DRAW_SCALE, agentSpritePath, automationSpritePath, personPropSpritePath, activeBobPx, walkBobPx,
} from "@/lib/officeChars";
import { OfficeCastStrip, type CastMember } from "./OfficeCastStrip";
import "./office.css";

// The Office canvas — hand-rolled Canvas 2D, no engine, no new dependency (platform-ui's four-dep
// discipline holds). Rewritten 2026-08-23 for owner feedback on the live prototype: ONE connected
// floor plate with real corridors (not detached room boxes), floors when one plate isn't enough,
// rooms sized to headcount, page-level scroll, and a working animation gated STRICTLY to real
// agent-run activity (O4) — never to humans, who have no comparable activity feed. Extended
// 2026-08-24 to automations: the SAME three-state honesty model (executing / waiting on a human /
// failed, resolved by `resolveAutomationState` in lib/office.ts), driven by real
// automation_approvals rows rather than a run's event feed, but sharing every rendering mechanism
// below with agents (the emote bubble, the desk-tint pulse, the shared pulse timer) rather than
// duplicating them.
//
// Two render paths, both imperative:
//   1. `draw()` — called on mount, on scene/floor/theme/resize/selection/working-state change.
//      One-shot.
//   2. The replay RAF loop — runs ONLY while a demo replay is playing, paused on
//      `visibilitychange` and off-screen (IntersectionObserver).
//   3. A THIRD, much coarser timer — the working-animation "pulse" — exists only while at least one
//      agent avatar has been proven genuinely active by real run events in the last
//      WORKING_RECENCY_MS (lib/office.ts), OR at least one automation currently resolves to
//      `executing`/`awaiting_approval`. It is a ~450ms `setInterval`, not a per-frame RAF, shared by
//      both sources rather than one loop each, and it stops entirely (cleared) the moment neither
//      is true. Paused by the SAME visibility/offscreen refs as the replay loop.
//   4. A FOURTH timer — ambient WALKING (owner decision 2026-08-26, revised same day for "too
//      rigid" feedback) — the two-tier honesty rule this canvas now draws: room-to-room movement is
//      REAL (paths #2 above, untouched by this), motion WITHIN a room is decorative and means
//      nothing. ONE shared ~200ms `setInterval` (never one per avatar — this must scale to 80+
//      seats) redraws every steady-state avatar at a small offset from `lib/office.ts`'s
//      `ambientWalkState`, which is a pure function of (avatarId, wall-clock time) ONLY — no
//      `activeRunId`, `busyUntil`, `automationSignal` or working state is ever read by it, because
//      that is precisely what would turn decoration into a claim (plan §3: "motion is a claim").
//      `ambientWalkState` walks a short discrete leg out, pauses, and walks back — not the
//      continuous sine curve `ambientDriftOffset` (still in lib/office.ts, still tested, just no
//      longer called from here) traced, which glided every avatar all the time and read as
//      sliding rather than walking. The SAME timer occasionally puts a curated, hard-coded line
//      (never generated — plan §6) in a speech bubble over one or two avatars at a time. Paused by
//      the SAME visibility/offscreen refs as everything else, and killed outright by
//      `prefers-reduced-motion` (avatars sit at their desks; no bubbles either).

type RailTab = "cast" | "detail" | "activity" | "legend";
const RAIL_TABS: { key: RailTab; label: string }[] = [
  { key: "cast", label: "Cast" },
  { key: "detail", label: "Detail" },
  { key: "activity", label: "Activity" },
  { key: "legend", label: "Legend" },
];

interface TokenSet {
  page: string; card: string; raised: string; sunken: string;
  hairline: string; hairlineSoft: string; ink: string; ink60: string;
  accent: string; steel: string; grey: string; external: string;
  ok: string; warning: string; danger: string; fontBody: string;
  /** Resolves a principal id to its `--cat-N` colour, live from the token layer — never a literal,
   *  and never cached across a theme change (this closure re-reads on every draw() call). */
  catColor: (id: string) => string;
  /** Resolves an ARBITRARY CSS custom property name to its live value — the generic form
   *  `catColor` is built on, exposed directly for `automationColorToken`'s fallback chain (which
   *  can hand back any of a settable token, a `catToken(deptId)`, or the fixed grey token, and
   *  doesn't need its own bespoke resolver for that). */
  resolveToken: (name: string) => string;
}

/** Zoom readout. An integer step reads as "2", never "2.0"; a fractional Fit scale reads to one
 *  decimal ("0.9"), which is enough to tell someone the floor has been shrunk to fit without
 *  implying a precision the value does not have. */
function formatZoom(scale: number): string {
  return Number.isInteger(scale) ? String(scale) : scale.toFixed(1);
}

function readTokens(el: HTMLElement): TokenSet {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim() || "#888888";
  return {
    page: v("--surface-page"), card: v("--surface-card"), raised: v("--surface-raised"), sunken: v("--surface-sunken"),
    hairline: v("--erp-hairline"), hairlineSoft: v("--erp-hairline-soft"),
    ink: v("--ink-strong"), ink60: v("--erp-ink-60"),
    accent: v("--accent"), steel: v("--n-7"), grey: v(AUTOMATION_GREY_TOKEN), external: v("--accent-secondary"),
    ok: v("--status-ok"), warning: v("--status-warning"), danger: v("--status-danger"),
    fontBody: v("--font-body") || "sans-serif",
    catColor: (id: string) => v(catToken(id)),
    resolveToken: v,
  };
}

// Short form for the on-canvas badge — the full word ("Low assurance") is what the detail panel
// shows; canvas space is tight, and the shape (a hexagon) already carries "external agent".
const ASSURANCE_SHORT: Record<"anonymous" | "low" | "verified", string> = { anonymous: "ANONYMOUS", low: "LOW", verified: "VERIFIED" };

function assuranceColor(tokens: TokenSet, tier: "anonymous" | "low" | "verified" | undefined): string {
  if (tier === "verified") return tokens.ok;
  if (tier === "low") return tokens.warning;
  return tokens.danger; // anonymous, or missing (fails closed toward the loudest tier)
}

interface Positioned {
  avatar: OfficeAvatar;
  roomKey: string;
  tile: { x: number; y: number };
  inTransit: boolean;
  transitLabel?: string;
}

/** Tile-space addition — trivial, but named so the ambient-drift render call site below reads as
 *  "desk tile plus a small offset" rather than an anonymous object literal. */
function addTile(tile: { x: number; y: number }, d: { dx: number; dy: number }): { x: number; y: number } {
  return { x: tile.x + d.dx, y: tile.y + d.dy };
}

/** Groups avatars into their CURRENT room (steady-state) and assigns each a stable desk slot —
 *  recomputed from the group's own order rather than trusting `avatar.deskIndex` in isolation, so
 *  an avatar that moved into a room it wasn't seeded in never overlaps a real occupant. */
function steadyPositions(scene: OfficeScene, roomByKey: Map<string, OfficeRoom>, nowMs: number, exclude: Set<string>): Positioned[] {
  // Keyed by avatar OBJECT, not id, for the same reason as `slotOf` below: with duplicate ids a
  // Map keyed by id keeps only the LAST writer, so every avatar sharing an id inherited that one's
  // resting room and was teleported out of its own department. On the live org structure that
  // silently moved three people from Creatives / Web Dev into GM.
  const restRoomOf = new Map<OfficeAvatar, string>();
  for (const a of scene.avatars) restRoomOf.set(a, restingRoomKey(a, scene.events, nowMs));
  // Slot is assigned by POSITION as each avatar joins its room's group, and remembered per avatar
  // OBJECT. The previous form pushed ids and recovered the slot with `indexOf(a.id)`, which returns
  // the FIRST match — so any two avatars sharing an id collapsed onto one desk and drew on top of
  // each other, names and all, with no error anywhere.
  //
  // That is not hypothetical: the live org structure returns FOUR different people in GM sharing
  // the node id `p-019fb652`, and the office silently rendered one desk for the four of them. The
  // duplicate ids are a real backend defect and need fixing there, but this layer must not depend
  // on their uniqueness to place people correctly — a floor that hides four employees because of an
  // upstream id collision is a worse failure than the collision itself.
  const groups = new Map<string, OfficeAvatar[]>();
  const slotOf = new Map<OfficeAvatar, number>();
  for (const a of scene.avatars) {
    if (exclude.has(a.id)) continue;
    const rk = restRoomOf.get(a) ?? a.homeRoomKey;
    let list = groups.get(rk);
    if (!list) { list = []; groups.set(rk, list); }
    slotOf.set(a, list.length);
    list.push(a);
  }
  const out: Positioned[] = [];
  for (const a of scene.avatars) {
    if (exclude.has(a.id)) continue;
    const rk = restRoomOf.get(a) ?? a.homeRoomKey;
    const room = roomByKey.get(rk) ?? roomByKey.get(a.homeRoomKey);
    if (!room) continue;
    out.push({ avatar: a, roomKey: rk, tile: deskSlotTile(room, slotOf.get(a) ?? 0), inTransit: false });
  }
  return out;
}

/** Positions for avatars currently walking a replay step. Routes THROUGH THE CORRIDOR NETWORK
 *  (req #6) via `getPath` — a room-centre → door → corridor → door → room-centre polyline built by
 *  `lib/office.ts`'s hand-rolled BFS — rather than a straight line through whatever sits between
 *  the two rooms. `getPath` returns null when the two rooms aren't on the same floor (or no route
 *  resolves), in which case this falls back to the ORIGINAL two-point line between room centres —
 *  a rendering simplification for a case the corridor model can't show on one floor, never a
 *  fabricated route. */
function replayPositions(
  scene: OfficeScene, roomByKey: Map<string, OfficeRoom>, steps: ReplayStep[], elapsedMs: number,
  getPath: (fromKey: string, toKey: string) => { x: number; y: number }[] | null,
): Positioned[] {
  const byAvatar = new Map<string, ReplayStep[]>();
  for (const s of steps) {
    if (!byAvatar.has(s.avatarId)) byAvatar.set(s.avatarId, []);
    byAvatar.get(s.avatarId)!.push(s);
  }
  const out: Positioned[] = [];
  for (const [avatarId, mySteps] of byAvatar) {
    const avatar = scene.avatars.find((a) => a.id === avatarId);
    if (!avatar) continue;
    const first = mySteps[0];
    if (elapsedMs < first.startMs) {
      const room = roomByKey.get(first.fromRoomKey);
      if (!room) continue;
      out.push({ avatar, roomKey: first.fromRoomKey, tile: roomCenterTile(room), inTransit: false });
      continue;
    }
    let current = mySteps[0];
    for (const s of mySteps) if (elapsedMs >= s.startMs) current = s;
    const fromRoom = roomByKey.get(current.fromRoomKey);
    const toRoom = roomByKey.get(current.toRoomKey);
    if (!fromRoom || !toRoom) continue;
    if (elapsedMs < current.endMs) {
      const t = current.endMs === current.startMs ? 1 : (elapsedMs - current.startMs) / (current.endMs - current.startMs);
      const route = getPath(current.fromRoomKey, current.toRoomKey) ?? [roomCenterTile(fromRoom), roomCenterTile(toRoom)];
      out.push({
        avatar, roomKey: t < 1 ? current.fromRoomKey : current.toRoomKey,
        tile: pointAlongPath(route, t),
        inTransit: t < 1, transitLabel: current.reason,
      });
    } else {
      out.push({ avatar, roomKey: current.toRoomKey, tile: roomCenterTile(toRoom), inTransit: false });
    }
  }
  return out;
}

// Room shell geometry — a real wall band with a doorway gap, not a stroked rectangle. Kept as a
// module constant (not exported from lib/office.ts) because it's a RENDERING choice, not layout
// math another consumer needs.
const WALL_TILES = 0.4;

/** Tiled floor: a base fill plus a checkerboard wash at low alpha — reads as a real floor surface
 *  instead of one flat rectangle with gridlines. Clipped to the wall-inset interior so the wash
 *  never bleeds under the walls drawn over it. */
/** Authored floor textures (Waha pack, 2026-08-24 — see legal/asset-licences.md). One per room
 *  kind, tiled at TILE_PX so the material grid and the engine grid are the SAME grid; a texture
 *  drawn at any other size makes furniture stop agreeing with the floor it stands on. */
const FLOOR_TEXTURE: Record<OfficeRoomKind, string> = {
  lobby: "/office-env/floors/floor_light_wood.png",
  agents: "/office-env/floors/floor_tile.png",
  department: "/office-env/floors/floor_carpet_blue.png",
  utility: "/office-env/floors/floor_carpet_gray.png",
  unassigned: "/office-env/floors/floor_tile.png",
};

/** How much of the authored texture is allowed through, over the themed base fill.
 *  NOT 1.0, and this is the whole reason the base fill below survives. The textures are authored
 *  at fixed colours and know nothing about our palette, so painting them opaque would hand the
 *  office a cream floor in dark mode and glare straight through the theme the rest of the ERP
 *  respects. Compositing them OVER the token fill keeps `--surface-*` driving the tone — the
 *  texture contributes material and grain, the theme still contributes the colour. */
const FLOOR_TEXTURE_ALPHA = 0.5;

/** The BUILDING's own floor and outer wall — the surface every room sits on, distinct from any one
 *  room's carpet. Neutral on purpose: it should read as circulation space, not compete with the
 *  per-kind room floors that carry the actual meaning. */
const BUILDING_FLOOR_TEXTURE = "/office-env/floors/floor_tile.png";
const BUILDING_WALL_TEXTURE = "/office-env/walls/wall_03_gray.png";

function drawFloor(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }, tokens: TokenSet, kind: OfficeRoomKind) {
  const wall = tilesToPx(WALL_TILES);
  const x = tilesToPx(rect.x) + wall, y = tilesToPx(rect.y) + wall;
  const w = tilesToPx(rect.w) - wall * 2, h = tilesToPx(rect.h) - wall * 2;
  // Operations (agents) reads with the same raised tone as the Lobby — both are estate-level
  // shared spaces, distinct from a department's own card-tone floor.
  ctx.fillStyle = kind === "lobby" || kind === "agents" ? tokens.raised : kind === "department" ? tokens.card : tokens.sunken;
  ctx.fillRect(x, y, w, h);

  const tile = tilesToPx(1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const tex = getRawImage(FLOOR_TEXTURE[kind]);
  if (tex) {
    ctx.globalAlpha = FLOOR_TEXTURE_ALPHA;
    ctx.imageSmoothingEnabled = false;
    const cols = Math.ceil(w / tile), rows = Math.ceil(h / tile);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) ctx.drawImage(tex, x + tx * tile, y + ty * tile, tile, tile);
    }
  } else {
    // The procedural checkerboard stays as the fallback, exactly as it rendered before the
    // textures existed — a floor that has not finished decoding must still read as a floor, not
    // as a flat void that pops into a room a moment later.
    ctx.fillStyle = tokens.hairlineSoft;
    ctx.globalAlpha = 0.4;
    const cols = Math.ceil(w / tile) + 1, rows = Math.ceil(h / tile) + 1;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        if ((tx + ty) % 2 === 0) continue;
        ctx.fillRect(x + tx * tile, y + ty * tile, tile, tile);
      }
    }
  }
  ctx.restore();
}

/** Authored wall textures (same Waha pack as FLOOR_TEXTURE), one per room kind — the load-bearing
 *  "walls read as shared partitions of one building" cue: every department shares the SAME wall
 *  material, every utility room shares a different one, exactly the way FLOOR_TEXTURE already
 *  varies floors by kind rather than by individual room. `unassigned` is never actually looked up
 *  (that kind keeps its dashed-outline marker below, no load-bearing wall at all) but carries an
 *  entry anyway so this stays a total map over OfficeRoomKind, same shape as FLOOR_TEXTURE. */
const WALL_TEXTURE: Record<OfficeRoomKind, string> = {
  lobby: "/office-env/walls/wall_01_cream.png",
  agents: "/office-env/walls/wall_03_gray.png",
  department: "/office-env/walls/wall_02_blue.png",
  utility: "/office-env/walls/wall_06_brick.png",
  unassigned: "/office-env/walls/wall_03_gray.png",
};

/** Same compositing trade-off as FLOOR_TEXTURE_ALPHA and for the same reason: the authored texture
 *  is painted OVER the existing themed `color` fill (accent on hover, ink60 otherwise) rather than
 *  replacing it, so the wall keeps reading in the app's own palette — and keeps its hover tint —
 *  in both themes, with the pack contributing material grain on top. */
/** Wall tiles draw at FULL strength. They were composited at 0.55 over the flat colour bar, which
 *  averaged the texture back into the bar and left the walls reading as the same flat rectangles the
 *  art pack was added to replace. The flat bar still paints first, so a tile that has not decoded
 *  yet (or 404s) degrades to exactly the old appearance instead of a hole. */
const WALL_TEXTURE_ALPHA = 1;

/** One tiled wall segment: the existing solid fill first (so a missing/unloaded texture degrades
 *  to EXACTLY the flat bar this canvas always drew — never a blank gap), then the material texture
 *  tiled across it at `tile` px squares and clipped to the segment, same tiling technique drawFloor
 *  already uses for its own texture. A no-op for a zero-size segment (the two doorway-side bars are
 *  routinely zero-width when the door sits flush against a corner). */
function drawWallBand(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  color: string, texImg: HTMLImageElement | null, tile: number,
) {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  if (!texImg) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.globalAlpha = WALL_TEXTURE_ALPHA;
  ctx.imageSmoothingEnabled = false;
  const cols = Math.ceil(w / tile) + 1, rows = Math.ceil(h / tile) + 1;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) ctx.drawImage(texImg, x + tx * tile, y + ty * tile, tile, tile);
  }
  ctx.restore();
}

/** Real walls with thickness, and a doorway gap on the wall that faces the corridor — the SOUTH
 *  (bottom) wall for a "north"-side room, the NORTH (top) wall for a "south"-side room. This is
 *  the one piece of rendering that had to change shape entirely for the corridor model: a room's
 *  door is no longer "always the bottom wall", it's whichever wall genuinely touches circulation
 *  space. `unassigned` (plan §4.3: "no department binding exists") keeps its dashed-outline
 *  honesty marker instead of a load-bearing wall.
 *
 *  Geometry is UNCHANGED from the original flat-fill version — same wall thickness (WALL_TILES),
 *  same doorway gap (doorX0/doorX1), same six band rects. Only what fills each band changed, via
 *  `drawWallBand` above. `buildWalkableGrid`/`roomToRoomPath` (lib/office.ts) derive the corridor
 *  network from `room.x/y/wTiles/hTiles/doorX` directly, never from anything drawn here, so no
 *  pathfinding geometry moves when the wall's fill does. */
function drawWalls(ctx: CanvasRenderingContext2D, room: OfficeRoom, tokens: TokenSet, isHovered: boolean) {
  const rect = roomTileRect(room);
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), w = tilesToPx(rect.w), h = tilesToPx(rect.h);
  const color = isHovered ? tokens.accent : tokens.ink60;

  if (room.kind === "unassigned") {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = isHovered ? 2 : 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
    return;
  }

  const wall = tilesToPx(WALL_TILES);
  const doorW = tilesToPx(DOOR_WIDTH_TILES);
  const doorCx = tilesToPx(room.doorX);
  const doorX0 = doorCx - doorW / 2;
  const doorX1 = doorCx + doorW / 2;
  const corridorWallIsBottom = room.side === "north";
  const wallImg = getRawImage(WALL_TEXTURE[room.kind]);
  drawWallBand(ctx, x, y, wall, h, color, wallImg, wall); // left
  drawWallBand(ctx, x + w - wall, y, wall, h, color, wallImg, wall); // right
  if (corridorWallIsBottom) {
    drawWallBand(ctx, x, y, w, wall, color, wallImg, wall); // top — solid, away from the corridor
    drawWallBand(ctx, x, y + h - wall, doorX0 - x, wall, color, wallImg, wall); // bottom, left of the doorway
    drawWallBand(ctx, doorX1, y + h - wall, x + w - doorX1, wall, color, wallImg, wall); // bottom, right of the doorway
  } else {
    drawWallBand(ctx, x, y + h - wall, w, wall, color, wallImg, wall); // bottom — solid, away from the corridor
    drawWallBand(ctx, x, y, doorX0 - x, wall, color, wallImg, wall); // top, left of the doorway
    drawWallBand(ctx, doorX1, y, x + w - doorX1, wall, color, wallImg, wall); // top, right of the doorway
  }
  if (isHovered) {
    ctx.strokeStyle = tokens.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
}

/** The nameplate's own rect, in CANVAS px — factored out of `drawNamePlate` so `drawRoomDressing`
 *  can compute exactly where NOT to put a painting/bookshelf/clock without re-deriving (and
 *  risking drifting from) the nameplate's own geometry. Mounted on the wall AWAY from the corridor
 *  (the room's "front of house" wall, opposite its own doorway) so it never collides with the
 *  doorway gap `drawWalls` cuts. */
function namePlateRect(room: OfficeRoom): { x: number; y: number; w: number; h: number } {
  const rect = roomTileRect(room);
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), w = tilesToPx(rect.w), h = tilesToPx(rect.h);
  const plateW = Math.min(w - tilesToPx(1.2), tilesToPx(6.5));
  const plateH = tilesToPx(1.35);
  const px = x + (w - plateW) / 2;
  const onTop = room.side === "north"; // door is on the bottom, so the nameplate sits up top
  const py = onTop ? y + tilesToPx(WALL_TILES) - 1 : y + h - tilesToPx(WALL_TILES) - plateH + 1;
  return { x: px, y: py, w: plateW, h: plateH };
}

function drawNamePlate(ctx: CanvasRenderingContext2D, room: OfficeRoom, tokens: TokenSet) {
  const { x: px, y: py, w: plateW, h: plateH } = namePlateRect(room);
  ctx.fillStyle = tokens.raised;
  ctx.fillRect(px, py, plateW, plateH);
  ctx.strokeStyle = tokens.hairline;
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, plateW - 1, plateH - 1);
  ctx.fillStyle = tokens.ink;
  ctx.font = `700 ${Math.round(tilesToPx(0.5))}px ${tokens.fontBody}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(fitLabel(ctx, room.label, plateW - 10), px + plateW / 2, py + 3);
  ctx.fillStyle = tokens.ink60;
  ctx.font = `400 ${Math.round(tilesToPx(0.36))}px ${tokens.fontBody}`;
  ctx.fillText(fitLabel(ctx, room.boundTo, plateW - 10), px + plateW / 2, py + tilesToPx(0.62));
  ctx.textAlign = "left";
}

/** How many EXTRA desks to draw empty, beyond the real occupants — always completes the current
 *  row (or draws one full row for an empty room) so a real workspace still reads as a workspace
 *  with nobody in it, rather than looking unfurnished. Never invents a person: these desks are
 *  drawn with no avatar and an explicit "Vacant seat" caption. `deskCols` is THIS room's own grid
 *  width (lib/office.ts's `roomSizeTiles`, which grows with headcount) — never a fixed constant. */
function vacantDeskSlots(occupantCount: number, deskCols: number): number {
  if (occupantCount === 0) return deskCols;
  const rem = occupantCount % deskCols;
  return rem === 0 ? 0 : deskCols - rem;
}

/** Authored desk textures, one per room kind — the same "shared material per room kind" idea as
 *  FLOOR_TEXTURE/WALL_TEXTURE, so a department's desks all read as the same furniture line rather
 *  than each seat rolling its own. `lobby` is never actually looked up (the lobby draws waiting
 *  chairs via drawWaitingChair, never a desk) but carries an entry anyway to keep this a total map,
 *  same shape as FLOOR_TEXTURE. */
const DESK_TEXTURE: Record<OfficeRoomKind, string> = {
  lobby: "/office-env/furniture/desks/reception_desk.png",
  agents: "/office-env/furniture/desks/desk_03_blue.png",
  department: "/office-env/furniture/desks/desk_02_cream.png",
  utility: "/office-env/furniture/desks/shared_workbench.png",
  unassigned: "/office-env/furniture/desks/desk_01_wood.png",
};
const CHAIR_TEXTURE = "/office-env/furniture/seating/office_chair.png";
const MONITOR_TEXTURE = "/office-env/office_equipment/desktop_monitor.png";

/** A desk's monitor tint is the ONLY visual difference a working animation makes (req #5) — no new
 *  sprite, no invented gesture. Three honest states, never a fourth: no real run behind this desk
 *  at all (dim, unchanged from before); a run that is genuinely open but has gone quiet (a static
 *  amber tint — "a visible state, not a looping animation implying live contact", plan §3); and a
 *  run with a real event inside the last WORKING_RECENCY_MS (a soft accent glow that ALTERNATES
 *  with `pulseOn`, the one animation in this whole canvas that runs continuously, and only while
 *  this is true for at least one desk on screen). A FOURTH state, `failed` (2026-08-24), extends
 *  this to real automations: a steady danger tint, deliberately never pulsing (req: "distinct and
 *  not alarming-by-default-forever" — the freshness window in `resolveAutomationState` is what
 *  already bounds how long this shows, so the tint itself doesn't need to shout on top of that). */
type DeskActivity = "none" | "quiet" | "working" | "failed";

/** Real furniture (2026-08-26, art pack wire-up): a chair at the seat, a desk sprite keyed to the
 *  room's kind, and a monitor sprite carrying the SAME activity colour this always drew — just as a
 *  screen-glow composited over the sprite instead of a bare coloured rectangle. Every sprite lookup
 *  degrades independently to its OLD procedural shape the instant it's null (still loading, or a
 *  404), so a slow-decoding image can never leave a desk half-drawn or blank — matching the exact
 *  fallback discipline drawFloor already established for the floor texture.
 *
 *  Anchor point and footprint are UNCHANGED: `tile` is still exactly what `deskSlotTile()` (lib/
 *  office.ts) computed, and every new sprite is centred on the same (cx, cy) / deskY the old
 *  fillRect plate used, so an occupant avatar (drawn later, in Pass 3, at this identical tile) still
 *  lines up with its seat pixel-for-pixel. */
function drawDesk(
  ctx: CanvasRenderingContext2D, tile: { x: number; y: number }, tokens: TokenSet, occupied: boolean,
  roomKind: OfficeRoomKind, activity: DeskActivity = "none", pulseOn = false,
) {
  const cx = tilesToPx(tile.x), cy = tilesToPx(tile.y);
  const r = tilesToPx(0.62);
  ctx.fillStyle = tokens.hairlineSoft;
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.55, r * 1.05, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();

  // The chair sits AT the seat tile — drawn before the desk plate/monitor above it and before Pass
  // 3 draws any occupant on top, so an occupied desk reads as "someone sitting in the chair" and a
  // vacant one reads as an empty chair, without moving the seat anchor at all.
  const chairImg = getRawImage(CHAIR_TEXTURE);
  if (chairImg) {
    const chairSize = tilesToPx(1.05);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(chairImg, cx - chairSize / 2, cy - chairSize * 0.5, chairSize, chairSize);
  }

  // The desk sprite is a 32x32 source. It was drawn into a 1.9 x 0.55 tile box, i.e. squashed to
  // roughly 30x9px, which is why it read as a thin plank rather than furniture. Draw it on its own
  // aspect ratio instead; the taller row pitch (DESK_ROW_TILES) is what makes the room for it.
  const deskW = tilesToPx(1.9), deskH = tilesToPx(1.9);
  // The desk's BOTTOM edge sits essentially on the seat tile, so the occupant (drawn later, in
  // Pass 3) overlaps its lower edge and reads as sitting AT the desk. The previous r*1.5 offset
  // left a visible gap that made everyone look like they were standing a pace behind their own
  // workstation. Pass ordering is what makes the overlap read correctly: desk first, person on top.
  const deskY = cy - r * 0.15 - deskH;
  const deskImg = getRawImage(DESK_TEXTURE[roomKind]);
  if (deskImg) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(deskImg, cx - deskW / 2, deskY, deskW, deskH);
  } else {
    // Unchanged fallback — exactly the flat plate this canvas always drew.
    ctx.fillStyle = tokens.raised;
    ctx.fillRect(cx - deskW / 2, deskY, deskW, deskH);
    ctx.strokeStyle = tokens.hairline;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - deskW / 2 + 0.5, deskY + 0.5, deskW - 1, deskH - 1);
  }

  // Square, and standing ON the desk surface rather than floating above its top edge — the monitor
  // is also a 32x32 source and was being flattened the same way the desk was.
  const monW = tilesToPx(0.8), monH = tilesToPx(0.8);
  const monY = deskY + deskH * 0.1;
  const monitorImg = getRawImage(MONITOR_TEXTURE);
  if (monitorImg) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(monitorImg, cx - monW / 2, monY, monW, monH);
  }
  ctx.save();
  if (activity === "working") {
    ctx.fillStyle = tokens.accent;
    ctx.globalAlpha = monitorImg ? (pulseOn ? 0.7 : 0.32) : (pulseOn ? 1 : 0.5);
  } else if (activity === "quiet") {
    ctx.fillStyle = tokens.warning;
    ctx.globalAlpha = monitorImg ? 0.6 : 0.85;
  } else if (activity === "failed") {
    ctx.fillStyle = tokens.danger;
    ctx.globalAlpha = monitorImg ? 0.8 : 1;
  } else if (!monitorImg) {
    // No activity AND no monitor sprite yet — the original flat "is anyone sitting here" tint.
    ctx.fillStyle = occupied ? tokens.ink60 : tokens.hairlineSoft;
    ctx.globalAlpha = 1;
  } else {
    ctx.globalAlpha = 0; // the monitor sprite alone reads fine idle; no extra tint needed
  }
  if (ctx.globalAlpha > 0) ctx.fillRect(cx - monW / 2, monY, monW, monH);
  ctx.restore();
  if (!occupied) {
    ctx.fillStyle = tokens.ink60;
    ctx.font = `italic 400 ${Math.round(tilesToPx(0.42))}px ${tokens.fontBody}`;
    ctx.textAlign = "center";
    ctx.fillText("Vacant seat", cx, cy + r * 1.6);
    ctx.textAlign = "left";
  }
}

/** A small personal item on a HUMAN's own desk (owner feedback 2026-08-26: "identical people...
 *  reads as GENERATED"). Deterministic per AVATAR id, never per desk or room, so the same person
 *  keeps the same item if they ever change seats — see `officeChars.ts`'s own doc on why these 36
 *  files sit beside a person's desk rather than replacing their (real, walking) LPC body. Drawn
 *  after `drawDesk` (Pass 2 ordering) so it sits ON the desk surface, and only ever for an OCCUPIED
 *  human desk — a vacant seat has no person to own an item, and an agent/automation already carries
 *  its own fixed visual identity from the same pack. */
function drawDeskFigurine(ctx: CanvasRenderingContext2D, tile: { x: number; y: number }, avatarId: string) {
  const img = getRawImage(personPropSpritePath(avatarId, hashId));
  if (!img) return; // still loading, or 404'd — the desk reads fine without it
  const cx = tilesToPx(tile.x), cy = tilesToPx(tile.y);
  const r = tilesToPx(0.62);
  const deskH = tilesToPx(1.9);
  const deskY = cy - r * 0.15 - deskH;
  const size = tilesToPx(0.55);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, cx + tilesToPx(0.55), deskY + deskH * 0.15, size, size);
}

/** Wall-mounted dressing for rooms that have desks — printer/whiteboard/filing/bookshelf/notice
 *  board (the original furniture set) PLUS the two previously-committed-but-unreferenced pools
 *  named in the owner's 2026-08-26 "bare walls" feedback: all 12 `office-env/paintings/*` and a
 *  second, taller bookshelf + wall clock. Picked and placed by a STABLE hash of the room's own key
 *  (`hashId`, lib/office.ts — the same deterministic-identity helper the avatar sprites already use
 *  for their own art variant) so the same room always earns the same items in the same spots on
 *  every render. Nothing here may read `nowMs`, avatar state, or draw order — a jittering prop
 *  would be worse than none (req #4: "nothing jitters between frames or re-renders"). */
const ROOM_DRESSING_PROPS = [
  "/office-env/furniture/common/whiteboard.png",
  "/office-env/furniture/common/printer_stand.png",
  "/office-env/furniture/storage/filing_cabinet.png",
  "/office-env/furniture/storage/bookshelf.png",
  "/office-env/furniture/storage/bookshelf_tall.png",
  "/office-env/furniture/common/notice_board.png",
  "/office-env/office_equipment/clock.png",
  "/office-env/paintings/abstract_blue.png",
  "/office-env/paintings/abstract_warm.png",
  "/office-env/paintings/cityscape.png",
  "/office-env/paintings/forest.png",
  "/office-env/paintings/geometric.png",
  "/office-env/paintings/green_botanical.png",
  "/office-env/paintings/landscape_mountain.png",
  "/office-env/paintings/minimal_arch.png",
  "/office-env/paintings/ocean.png",
  "/office-env/paintings/office_motivational.png",
  "/office-env/paintings/pixel_moon.png",
  "/office-env/paintings/sunset.png",
] as const;

/** Footprint of one wall-dressing item, and the gap between neighbours — both tuned so a run of
 *  items never has to spill past the nameplate's own Y band into the desk furniture below it (see
 *  `DESK_TOP_TILES`'s own doc in lib/office.ts for the clearance this all rests on). */
const WALL_ART_ITEM_TILES = 0.85;
const WALL_ART_GAP_TILES = 0.25;

/** Hangs 0-3 items per side, FLANKING the nameplate rather than fighting it — the two runs start
 *  flush against the plate's own left/right edge (with one gap's worth of breathing room) and grow
 *  outward toward the room's side walls, vertically centred on the plate's own Y band. That band is
 *  guaranteed clear of both the nameplate (disjoint X ranges by construction — a run never crosses
 *  `plate.x`/`plate.x + plate.w`) and the desk furniture below it (`DESK_TOP_TILES` already reserves
 *  this whole band for the nameplate; anything sharing its Y sits inside that same reservation).
 *  `count` is derived from how many items ACTUALLY fit the room's own margin — never a fixed number
 *  guessed by eye — so a narrow department gets fewer items than a wide one instead of overflowing
 *  into a wall it was never sized to clear. */
function drawRoomDressing(ctx: CanvasRenderingContext2D, room: OfficeRoom) {
  const plate = namePlateRect(room);
  const rect = roomTileRect(room);
  const wall = tilesToPx(WALL_TILES);
  const innerLeft = tilesToPx(rect.x) + wall;
  const innerRight = tilesToPx(rect.x + rect.w) - wall;
  const itemPx = tilesToPx(WALL_ART_ITEM_TILES);
  const gapPx = tilesToPx(WALL_ART_GAP_TILES);
  const stridePx = itemPx + gapPx;
  const centerY = plate.y + plate.h / 2;

  const leftMarginPx = plate.x - innerLeft;
  const rightMarginPx = innerRight - (plate.x + plate.w);
  const leftCount = Math.max(0, Math.min(3, Math.floor(leftMarginPx / stridePx)));
  const rightCount = Math.max(0, Math.min(3, Math.floor(rightMarginPx / stridePx)));

  let slot = 0;
  const draw = (cx: number) => {
    const path = ROOM_DRESSING_PROPS[hashId(`${room.key}:${slot}`) % ROOM_DRESSING_PROPS.length];
    slot += 1;
    const img = getRawImage(path);
    if (!img) return; // still loading, or 404'd — the wall reads fine bare, no fallback shape needed
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, cx - itemPx / 2, centerY - itemPx / 2, itemPx, itemPx);
  };
  for (let i = 0; i < leftCount; i++) draw(plate.x - gapPx - itemPx / 2 - i * stridePx);
  for (let i = 0; i < rightCount; i++) draw(plate.x + plate.w + gapPx + itemPx / 2 + i * stridePx);
}

/** The lobby is the airlock waiting area (plan §4.3), not a workspace — a simple chair, no desk,
 *  at whatever avatar sits there (the external-agent demo seat), plus a few ambient chairs along
 *  the left wall so an empty lobby still reads as a waiting room. */
function drawWaitingChair(ctx: CanvasRenderingContext2D, tile: { x: number; y: number }, tokens: TokenSet) {
  const cx = tilesToPx(tile.x), cy = tilesToPx(tile.y);
  const r = tilesToPx(0.62);
  ctx.fillStyle = tokens.raised;
  ctx.fillRect(cx - r * 0.9, cy - r * 0.1, r * 1.8, r * 1.3);
  ctx.strokeStyle = tokens.hairline;
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - r * 0.9 + 0.5, cy - r * 0.1 + 0.5, r * 1.8 - 1, r * 1.3 - 1);
  ctx.fillRect(cx - r * 0.9, cy - r * 1.3, r * 1.8, r * 1.2);
}

function drawLobbyChairs(ctx: CanvasRenderingContext2D, room: OfficeRoom, tokens: TokenSet) {
  const rect = roomTileRect(room);
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), h = tilesToPx(rect.h);
  const wall = tilesToPx(WALL_TILES);
  const startY = y + tilesToPx(2.3);
  const spacing = tilesToPx(1.3);
  for (let i = 0; i < 3; i++) {
    const cy = startY + i * spacing;
    if (cy > y + h - wall - tilesToPx(0.6)) break;
    const cx = x + wall + tilesToPx(0.7);
    ctx.fillStyle = tokens.raised;
    ctx.fillRect(cx - tilesToPx(0.32), cy, tilesToPx(0.64), tilesToPx(0.5));
    ctx.strokeStyle = tokens.hairline;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - tilesToPx(0.32) + 0.5, cy + 0.5, tilesToPx(0.64) - 1, tilesToPx(0.5) - 1);
    ctx.fillRect(cx - tilesToPx(0.32), cy - tilesToPx(0.4), tilesToPx(0.64), tilesToPx(0.4));
  }
}

/** A reception counter opposite the waiting chairs — the "real luxury setups" ask (req #7) reads
 *  most in the lobby, since it's the one room every visitor sees first. Purely decorative
 *  furniture, drawn once per lobby; it makes no binding claim of its own (the lobby's binding is
 *  still the airlock queue, per its `boundTo` caption). */
function drawReceptionDesk(ctx: CanvasRenderingContext2D, room: OfficeRoom, tokens: TokenSet) {
  const rect = roomTileRect(room);
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), w = tilesToPx(rect.w), h = tilesToPx(rect.h);
  const wall = tilesToPx(WALL_TILES);
  const deskW = tilesToPx(3.4), deskH = tilesToPx(0.9);
  const dx = x + w - wall - deskW - tilesToPx(0.6);
  const dy = y + h - wall - deskH - tilesToPx(0.5);
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = tokens.ink;
  ctx.beginPath();
  ctx.ellipse(dx + deskW / 2, dy + deskH + 3, deskW * 0.55, deskH * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = tokens.raised;
  ctx.fillRect(dx, dy, deskW, deskH);
  ctx.strokeStyle = tokens.hairline;
  ctx.lineWidth = 1;
  ctx.strokeRect(dx + 0.5, dy + 0.5, deskW - 1, deskH - 1);
  // A slim accent trim along the counter's front face — the one warm "considered furniture" touch.
  ctx.fillStyle = tokens.accent;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(dx, dy + deskH - 3, deskW, 3);
  ctx.globalAlpha = 1;
}

/** A small procedural potted plant — no new asset, just a pot + a cluster of leaves in the status-
 *  ok green token. Static (never animated), placed at fixed, deterministic spots per room so the
 *  same company always renders the same plant in the same place. */
function drawPlant(ctx: CanvasRenderingContext2D, cx: number, baselineY: number, tokens: TokenSet) {
  const potW = tilesToPx(0.5), potH = tilesToPx(0.42);
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = tokens.ink;
  ctx.beginPath();
  ctx.ellipse(cx, baselineY + 2, potW * 0.8, potH * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = tokens.raised;
  ctx.beginPath();
  ctx.moveTo(cx - potW / 2, baselineY - potH);
  ctx.lineTo(cx + potW / 2, baselineY - potH);
  ctx.lineTo(cx + potW / 2 - 2, baselineY);
  ctx.lineTo(cx - potW / 2 + 2, baselineY);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = tokens.hairline;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = tokens.ok;
  const leafR = tilesToPx(0.34);
  for (const [ox, oy] of [[0, -0.55], [-0.42, -0.15], [0.42, -0.15]] as const) {
    ctx.beginPath();
    ctx.ellipse(cx + ox * leafR * 2, baselineY - potH + oy * leafR * 2, leafR, leafR * 0.75, ox * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The two previously-committed-but-unreferenced corner plants named in the owner's 2026-08-26
 *  feedback — a real sprite where `drawPlant` above draws a procedural one, picked deterministically
 *  per `seed` (a room key) so the same corner always gets the same plant. Degrades to the exact
 *  procedural plant above the instant either sprite hasn't decoded yet (or 404s), matching every
 *  other sprite in this file's fallback discipline — the corner never goes bare while loading. */
const CORNER_PLANT_SPRITES = ["/office-env/plants/plant_corner.png", "/office-env/plants/plant_tall.png"] as const;

function drawPottedPlant(ctx: CanvasRenderingContext2D, cx: number, baselineY: number, tokens: TokenSet, seed: string) {
  const img = getRawImage(CORNER_PLANT_SPRITES[hashId(seed) % CORNER_PLANT_SPRITES.length]);
  if (!img) { drawPlant(ctx, cx, baselineY, tokens); return; }
  const w = tilesToPx(0.9), h = tilesToPx(0.9);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, cx - w / 2, baselineY - h, w, h);
}

/** The utility room is "where the automations sit" (no department tone, plan §4.3) — a rack/server
 *  suggestion along the right wall gives it a visual identity distinct from a department room, on
 *  top of the same desk furniture its automation avatars still sit at. Status LEDs are STATIC
 *  (never animated — no ambient motion is the rule this whole canvas is built against). */
function drawServerRack(ctx: CanvasRenderingContext2D, room: OfficeRoom, tokens: TokenSet) {
  const rect = roomTileRect(room);
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), w = tilesToPx(rect.w);
  const wall = tilesToPx(WALL_TILES);
  const rackW = tilesToPx(1.3), rackH = tilesToPx(3.0);
  const rx = x + w - wall - rackW - tilesToPx(0.4);
  const ry = y + tilesToPx(2.2);
  ctx.fillStyle = tokens.raised;
  ctx.fillRect(rx, ry, rackW, rackH);
  ctx.strokeStyle = tokens.hairline;
  ctx.lineWidth = 1;
  ctx.strokeRect(rx + 0.5, ry + 0.5, rackW - 1, rackH - 1);
  const slats = 5;
  const slatH = rackH / slats;
  for (let i = 0; i < slats; i++) {
    const sy = ry + i * slatH;
    ctx.strokeStyle = tokens.hairlineSoft;
    ctx.beginPath();
    ctx.moveTo(rx + 4, sy + slatH - 4);
    ctx.lineTo(rx + rackW - 4, sy + slatH - 4);
    ctx.stroke();
    ctx.fillStyle = i % 3 === 0 ? tokens.warning : tokens.ok;
    ctx.beginPath();
    ctx.arc(rx + rackW - 8, sy + 6, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The building's outer shell — a single connected plate (req #1), not a set of independent
 *  boxes. Drawn once per floor, behind everything else. */
function drawOuterShell(ctx: CanvasRenderingContext2D, floor: OfficeFloor, tokens: TokenSet) {
  const w = tilesToPx(floor.widthTiles), h = tilesToPx(floor.heightTiles);

  // The shell used to be a 3px strokeRect and NOTHING else, so every gap between rooms showed the
  // PAGE background through it. That is why the floor read as detached room boxes floating on a
  // void rather than one building: the rooms were the only thing with a floor. Filling the whole
  // plate first makes the gaps read as the building's own circulation space, which is what they
  // are — the corridor, doorways and room walls are then things sitting ON a floor rather than
  // islands with a gap between them.
  ctx.fillStyle = tokens.raised;
  ctx.fillRect(0, 0, w, h);

  const tile = tilesToPx(1);
  const tex = getRawImage(BUILDING_FLOOR_TEXTURE);
  if (tex) {
    ctx.save();
    ctx.globalAlpha = FLOOR_TEXTURE_ALPHA;
    ctx.imageSmoothingEnabled = false;
    const cols = Math.ceil(w / tile), rows = Math.ceil(h / tile);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) ctx.drawImage(tex, tx * tile, ty * tile, tile, tile);
    }
    ctx.restore();
  }

  // Outer wall, tiled like the room walls so the building is bounded by the same material rather
  // than a hairline. Falls back to the original stroke when the tile has not decoded.
  const wallImg = getRawImage(BUILDING_WALL_TEXTURE);
  const band = tilesToPx(0.75);
  if (wallImg) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const run = (bx: number, by: number, bw: number, bh: number) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx, by, bw, bh);
      ctx.clip();
      const cols = Math.ceil(bw / band), rows = Math.ceil(bh / band);
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) ctx.drawImage(wallImg, bx + tx * band, by + ty * band, band, band);
      }
      ctx.restore();
    };
    run(0, 0, w, band);            // top
    run(0, h - band, w, band);     // bottom
    run(0, 0, band, h);            // left
    run(w - band, 0, band, h);     // right
    ctx.restore();
  }

  ctx.strokeStyle = tokens.ink60;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
}

/** The corridor is what makes this ONE building rather than a grid of rooms (req #1) — a warm
 *  "runner" floor tint (a single restrained accent wash, per req #7's "restrained warm palette"),
 *  a hairline edge trim where it meets every room, and a few static, evenly-spaced ceiling light
 *  pools for "a consistent single light direction" without an actual lighting engine. Nothing here
 *  animates. */
function drawCorridorFloor(ctx: CanvasRenderingContext2D, floor: OfficeFloor, tokens: TokenSet) {
  const x = 0, y = tilesToPx(floor.corridorY), w = tilesToPx(floor.widthTiles), h = tilesToPx(CORRIDOR_W_TILES);
  ctx.fillStyle = tokens.sunken;
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = tokens.accent;
  const runnerInset = h * 0.22;
  ctx.fillRect(x, y + runnerInset, w, h - runnerInset * 2);
  ctx.restore();
  ctx.strokeStyle = tokens.hairlineSoft;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5); ctx.lineTo(x + w, y + 0.5);
  ctx.moveTo(x, y + h - 0.5); ctx.lineTo(x + w, y + h - 0.5);
  ctx.stroke();
  // Static ceiling light pools — evenly spaced, single light direction, never animated.
  const poolSpacing = tilesToPx(9);
  ctx.save();
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = tokens.raised;
  for (let px = poolSpacing / 2; px < w; px += poolSpacing) {
    ctx.beginPath();
    ctx.ellipse(px, y + h / 2, poolSpacing * 0.32, h * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A small round table + two chairs set into a wide stretch of the ground-floor corridor — the
 *  informal "commons" a real office corridor has, and the one piece of furniture in this file that
 *  is deliberately NOT inside a bound room (it makes no binding claim; it's corridor furniture,
 *  same honesty tier as the lobby's ambient chairs). Skipped when the corridor is too short to fit
 *  it without crowding a doorway. */
function drawCorridorNook(ctx: CanvasRenderingContext2D, floor: OfficeFloor, tokens: TokenSet) {
  if (floor.index !== 0 || floor.widthTiles < 34) return;
  const cx = tilesToPx(Math.min(floor.widthTiles - 10, 22));
  const cy = tilesToPx(floor.corridorY + CORRIDOR_W_TILES / 2);
  const r = tilesToPx(0.85);
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = tokens.ink;
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.5, r * 1.2, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  for (const [ox, oy] of [[-1.5, 0], [1.5, 0]] as const) {
    ctx.fillStyle = tokens.raised;
    ctx.beginPath();
    ctx.ellipse(cx + ox * r, cy + oy * r, r * 0.34, r * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = tokens.card;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * 0.62, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = tokens.hairline;
  ctx.lineWidth = 1;
  ctx.stroke();
  drawPlant(ctx, cx + r * 2.2, cy + r * 0.6, tokens);
}

/** A soft contact shadow under a figure, single light direction (straight down) for every avatar
 *  on the floor — cheap depth without a lighting model. Drawn first inside drawAvatar so the shape
 *  composites on top of it. */
function drawContactShadow(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, tokens: TokenSet) {
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = tokens.ink;
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.85, r * 0.9, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHumanoid(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, ink: string, synthetic: boolean) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy + r * 0.2, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy - r * 0.75, r * 0.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (synthetic) {
    // A small sensor stub on the head — reads as plainly synthetic without a licensed sprite.
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 1.35); ctx.lineTo(cx, cy - r * 1.6);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.arc(cx, cy - r * 1.65, 2, 0, Math.PI * 2); ctx.fill();
  }
}

function drawAutomation(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, ink: string) {
  const s = r * 1.5;
  ctx.fillStyle = fill;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
  ctx.strokeRect(cx - s / 2, cy - s / 2, s, s);
  // Tread lines — mechanical, no face, no department tone (it owns no decisions).
  ctx.beginPath();
  ctx.moveTo(cx - s / 2, cy + s / 2 - 3); ctx.lineTo(cx + s / 2, cy + s / 2 - 3);
  ctx.moveTo(cx - s / 2, cy + s / 2 - 6); ctx.lineTo(cx + s / 2, cy + s / 2 - 6);
  ctx.stroke();
}

function drawExternal(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string, ink: string) {
  // Angular/foreign silhouette — a hexagon, never mistakable for the rounded human/agent figures.
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Shorten `text` only as far as it must go to fit `maxPx` at the context's CURRENT font.
 *  Returns the original string untouched when it already fits, which is the common case — the
 *  previous fixed 9-character cap truncated nearly every name for no reason. */
function fitLabel(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let lo = 1, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

// ── Sprite loading + compositing (real LPC art) ─────────────────────────────────────────────────
// A procedural shape needed none of this — it was drawn directly, every frame, from nothing but a
// colour. A real PNG must be fetched and decoded first, so this block exists to pay that cost
// exactly once per (gender, pose, tone) and never again. Nothing here is a layout or interaction
// concern: it only ever hands `drawAvatar()` back a ready-to-draw 64x64 canvas, or `null` while
// still loading (the caller falls back to the old procedural humanoid meanwhile).
const rawImageCache = new Map<string, HTMLImageElement>();
const recolorCache = new Map<string, HTMLCanvasElement>();
const spriteCache = new Map<string, HTMLCanvasElement>();
const spriteReadyListeners = new Set<() => void>();

function notifySpriteReady() {
  for (const fn of spriteReadyListeners) fn();
}

/** Returns the decoded image once loaded; otherwise starts the load (once) and returns null. */
function getRawImage(src: string): HTMLImageElement | null {
  const existing = rawImageCache.get(src);
  if (existing) return existing.complete && existing.naturalWidth > 0 ? existing : null;
  const img = new Image();
  rawImageCache.set(src, img);
  img.onload = () => notifySpriteReady();
  // onerror deliberately left as a permanent miss — the caller's procedural fallback keeps the
  // avatar visible even if a sprite path 404s, rather than the office silently losing a figure.
  img.src = src;
  return null;
}

/** One 64x64 crop of a layer's sheet, optionally palette-swapped from LIGHT_RAMP to `ramp` —
 *  identical-length ramps, index for index, exact-value match (see office-sprites.ts). Only
 *  body/head crops ever pass a ramp; clothing, shoes and hair are drawn exactly as authored. */
function recolorFrame(img: HTMLImageElement, frame: { col: number; row: number }, ramp: string[] | null, cacheKey: string): HTMLCanvasElement {
  const cached = recolorCache.get(cacheKey);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_PX;
  canvas.height = FRAME_PX;
  const cctx = canvas.getContext("2d")!;
  cctx.drawImage(img, frame.col * FRAME_PX, frame.row * FRAME_PX, FRAME_PX, FRAME_PX, 0, 0, FRAME_PX, FRAME_PX);
  if (ramp) {
    const sources = LIGHT_RAMP.map(hexToRgb);
    const targets = ramp.map(hexToRgb);
    const image = cctx.getImageData(0, 0, FRAME_PX, FRAME_PX);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      for (let s = 0; s < sources.length; s++) {
        const [sr, sg, sb] = sources[s];
        if (Math.abs(d[i] - sr) <= 2 && Math.abs(d[i + 1] - sg) <= 2 && Math.abs(d[i + 2] - sb) <= 2) {
          const [tr, tg, tb] = targets[s];
          d[i] = tr; d[i + 1] = tg; d[i + 2] = tb;
          break;
        }
      }
    }
    cctx.putImageData(image, 0, 0);
  }
  recolorCache.set(cacheKey, canvas);
  return canvas;
}

/** A fully composited, tone-applied 64x64 character frame — body, head, bottom, top, shoes, hair
 *  (plan §4.4a's layer order). Built once per (gender, pose, FRAME, tone key) and cached from then
 *  on — extended 2026-08-26 to key on `frame` (not just `pose`) so ambient walking can request a
 *  facing row other than `POSE_FRAME[pose]`'s own default without thrashing the cache: with 80+
 *  avatars, at most a handful of distinct (gender, tone, frame) combinations are ever actually
 *  drawn, so this stays bounded by avatar count, never by the full cross-product. `frame` defaults
 *  to `POSE_FRAME[pose]` — every EXISTING caller (sit, and corridor-transit walk) is byte-for-byte
 *  unchanged, only a caller that explicitly overrides it (ambient walking, below) sees new rows.
 *  Returns null until every layer image for this gender/pose has finished loading. */
function getComposedSprite(
  gender: SpriteGender, pose: SpritePose, toneKey: string, ramp: string[],
  frame: { col: number; row: number } = POSE_FRAME[pose],
): HTMLCanvasElement | null {
  const cacheKey = `${gender}:${pose}:${frame.col}:${frame.row}:${toneKey}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  const layers = LAYER_PATHS[gender];
  const frames: HTMLCanvasElement[] = [];
  for (const { key, recolorable } of LAYER_ORDER) {
    const variant = layers[key];
    const src = spriteAssetPath(variant, pose);
    const img = getRawImage(src);
    if (!img) return null; // any missing layer stalls the whole composite — never a partial figure
    // frame.row is part of the cache key here too — recolorCache is shared across every distinct
    // frame cropped from the SAME sheet (`src` alone does not vary by row), so two different rows
    // of the same walk.png must not collide onto one cached crop.
    frames.push(recolorFrame(img, frame, recolorable ? ramp : null, `${src}:${frame.col}:${frame.row}:${recolorable ? toneKey : "raw"}`));
  }

  const canvas = document.createElement("canvas");
  canvas.width = FRAME_PX;
  canvas.height = FRAME_PX;
  const cctx = canvas.getContext("2d")!;
  cctx.imageSmoothingEnabled = false;
  for (const f of frames) cctx.drawImage(f, 0, 0);
  spriteCache.set(cacheKey, canvas);
  return canvas;
}

/** A speech-bubble above a genuinely-working agent's head, one glyph per REAL event `kind`
 *  (req #2). Purely procedural canvas drawing — no image asset, so it survives zoom/pan (it is
 *  drawn every content-space redraw, at content-space size, same as everything else on this
 *  canvas; the camera's CSS transform magnifies it along with the sprite). `approval_wait` gets
 *  deliberately the LOUDEST treatment (bigger radius, a solid warning fill instead of the neutral
 *  "raised" tone every other kind uses, full opacity with no pulse-fade) — "an agent stuck waiting
 *  on a person is exactly what someone should spot across a room" (ticket). The caller is what
 *  guarantees this never renders for a human — see drawAvatar's own call site. */
/** The delegation reason shown while an avatar is walking a replay step.
 *
 *  This used to be bare `ink60` italic text with no backing, drawn straight over the floor — so it
 *  smeared across whatever happened to be behind it (desk captions, "Vacant seat", other avatars'
 *  name labels) and was unreadable in exactly the moment it mattered. Every other floating overlay
 *  on this canvas (the emote bubble, the corridor envelope) sits on its own plate; this one now
 *  does too, for the same reason.
 *
 *  It also truncates by MEASUREMENT, like `fitLabel` does for names, rather than passing a
 *  `maxWidth` to `fillText`. That argument does not truncate — it horizontally CONDENSES the glyphs
 *  to fit, which is why a long reason rendered as a squashed unreadable line instead of an honest
 *  ellipsis. The full reason is always in the detail panel's event list regardless. */
function drawTransitLabel(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string, tokens: TokenSet, lane = 0,
) {
  const fontPx = Math.round(tilesToPx(0.5));
  ctx.save();
  ctx.font = `italic 400 ${fontPx}px ${tokens.fontBody}`;
  const label = fitLabel(ctx, text, tilesToPx(9));
  const padX = Math.round(tilesToPx(0.3));
  const padY = Math.round(tilesToPx(0.18));
  const w = ctx.measureText(label).width + padX * 2;
  const h = fontPx + padY * 2;
  const x = cx - w / 2;
  // Lane 1 rides above lane 0 by a full plate plus a hairline gap, so stacked labels read as two
  // separate lines rather than one smudge. The lane shifts the label's CENTRE — plate and text
  // both derive from it, or the plate moves and the text stays behind on the floor.
  const midY = cy - lane * (h + 3);
  const y = midY - h / 2;
  const radius = Math.min(h / 2, tilesToPx(0.25));

  ctx.beginPath();
  // `roundRect` is Canvas2D and present in every browser this app supports, but it is absent from
  // the jsdom context the unit tests use — fall back rather than throw in a test render.
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
  ctx.fillStyle = tokens.raised;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = tokens.hairline;
  ctx.stroke();

  // Full-strength ink on the plate, not ink60: the plate supplies the separation that the faded
  // colour was previously (and unsuccessfully) trying to supply on its own.
  ctx.fillStyle = tokens.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, midY);
  ctx.restore();
}

function drawEmoteBubble(ctx: CanvasRenderingContext2D, cx: number, cy: number, kind: AgentRunEventKind, tokens: TokenSet, pulseOn: boolean) {
  const isAlert = kind === "approval_wait";
  const isError = kind === "error";
  const r = tilesToPx(isAlert ? 0.58 : 0.42);
  const bg = isAlert ? tokens.warning : isError ? tokens.danger : tokens.raised;
  const border = isAlert || isError ? tokens.ink : tokens.hairline;
  const fg = isAlert || isError ? tokens.page : tokens.ink;

  ctx.save();
  ctx.globalAlpha = isAlert ? 1 : (pulseOn ? 1 : 0.7); // the alert tier never fades — always fully lit
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = isAlert ? 2 : 1;
  ctx.strokeStyle = border;
  ctx.stroke();
  // A small pointer tail toward the avatar's head, like a speech bubble.
  ctx.beginPath();
  ctx.moveTo(cx - 3, cy + r - 1);
  ctx.lineTo(cx + 3, cy + r - 1);
  ctx.lineTo(cx, cy + r + 5);
  ctx.closePath();
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = fg;
  ctx.strokeStyle = fg;
  switch (kind) {
    case "model": { // thinking — an ellipsis
      ctx.lineWidth = 1;
      for (const dx of [-4, 0, 4]) { ctx.beginPath(); ctx.arc(cx + dx, cy, 1.4, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case "tool": { // working — a small gear
      ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1.8;
      for (const [dx, dy] of [[0, -5], [0, 5], [-5, 0], [5, 0]] as const) {
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke();
      }
      break;
    }
    case "delegate": { // handing over — an arrow
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 3, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 3, cy - 3); ctx.lineTo(cx + 6, cy); ctx.lineTo(cx + 3, cy + 3); ctx.closePath(); ctx.fill();
      break;
    }
    case "approval_wait": { // blocked on a human — bold, unmissable
      ctx.font = `900 ${Math.round(r * 1.25)}px ${tokens.fontBody}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", cx, cy - 1);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      break;
    }
    case "error": {
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(cx - 3.5, cy - 3.5); ctx.lineTo(cx + 3.5, cy + 3.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 3.5, cy - 3.5); ctx.lineTo(cx - 3.5, cy + 3.5); ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/** Ambient speech bubble (owner decision 2026-08-26, plan §6: curated bank only, never generated).
 *  Visually a rounded plate with a small pointer tail, same shape language as `drawEmoteBubble`, but
 *  never confused with it: this one carries WORDS from `AMBIENT_LINES` (lib/office.ts) and fires on
 *  ANY avatar occasionally; the glyph bubble fires only on a genuinely-working agent/automation. The
 *  Pass 3 call site never schedules this on an avatar that already has a real `emoteKind`, so the
 *  two never stack — this function does not need to know that; it only draws what it is handed. */
function drawSpeechBubble(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string, tokens: TokenSet) {
  const fontPx = Math.round(tilesToPx(0.46));
  ctx.save();
  ctx.font = `500 ${fontPx}px ${tokens.fontBody}`;
  const label = fitLabel(ctx, text, tilesToPx(10));
  const padX = Math.round(tilesToPx(0.32));
  const padY = Math.round(tilesToPx(0.2));
  const w = ctx.measureText(label).width + padX * 2;
  const h = fontPx + padY * 2;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const radius = Math.min(h / 2, tilesToPx(0.3));

  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
  ctx.fillStyle = tokens.card;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = tokens.hairline;
  ctx.stroke();
  // Small pointer tail toward the avatar's head, same idea as drawEmoteBubble's tail.
  ctx.beginPath();
  ctx.moveTo(cx - 3, cy + h / 2 - 1);
  ctx.lineTo(cx + 3, cy + h / 2 - 1);
  ctx.lineTo(cx, cy + h / 2 + 5);
  ctx.closePath();
  ctx.fillStyle = tokens.card;
  ctx.fill();

  ctx.fillStyle = tokens.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, cy);
  ctx.restore();
}

/** The one place that decides which emote glyph (if any) an avatar earns — agent and automation
 *  share this so the bubble/desk-tint/roster-badge call sites never re-derive the mapping three
 *  different ways. An agent's kind comes from its own real, currently-fresh run event (O4,
 *  unchanged); an automation's comes from `resolveAutomationState` (2026-08-24) reusing the exact
 *  same bubble glyphs — `tool` for executing, `approval_wait` for the loud "blocked on a human"
 *  case, `error` for a fresh failure. `idle`/`unknown` earn no bubble at all: idle is still, and
 *  unknown is a quiet detail-panel fact, not a loud one. Never called for `human` — humans have no
 *  comparable activity model at either call site (see office.ts's own doc on why). */
function emoteKindFor(
  avatar: OfficeAvatar, workingIds: Set<string>, emoteKinds: Map<string, AgentRunEventKind | null>, nowMs: number,
): AgentRunEventKind | null {
  if (avatar.kind === "agent" && avatar.activeRunId && workingIds.has(avatar.id)) {
    return emoteKinds.get(avatar.id) ?? null;
  }
  if (avatar.kind === "automation" && avatar.automationSignal) {
    const state = resolveAutomationState(avatar.automationSignal, nowMs);
    if (state === "executing") return "tool";
    if (state === "awaiting_approval") return "approval_wait";
    if (state === "failed") return "error";
  }
  return null;
}

/** Desk-tint activity for an avatar's own furniture (Pass 2) — the same real signals
 *  `emoteKindFor` reads, translated into the coarser `DeskActivity` the desk drawing understands.
 *  An automation `executing` OR `awaiting_approval` both read as "working" (the accent glow) —
 *  matching how an agent's own `approval_wait` already glows too, with the LOUD distinction carried
 *  by the bubble on top, not the desk tint underneath. `just_ran` takes the static "quiet" tint.
 *  `idle`/`unknown` draw nothing extra. */
function deskActivityFor(avatar: OfficeAvatar, workingIds: Set<string>, nowMs: number): DeskActivity {
  if (avatar.activeRunId) return workingIds.has(avatar.id) ? "working" : "quiet";
  if (avatar.kind === "automation" && avatar.automationSignal) {
    const state: AutomationActivityState = resolveAutomationState(avatar.automationSignal, nowMs);
    if (state === "executing" || state === "awaiting_approval") return "working";
    if (state === "failed") return "failed";
    // `just_ran` lands on the EXISTING "quiet" tint, which was written for precisely this shape of
    // fact: "a visible state, not a looping animation implying live contact". A finished run gets
    // a steady tint and never joins the pulse set below — the pulse is reserved for things that
    // are actually happening, and a settled desk that blinks would undo the distinction the
    // `just_ran` state exists to draw.
    if (state === "just_ran") return "quiet";
  }
  // SIM-01 (2026-08-24) — the HUMANS' busy signal, and the reason it is a different mechanism from
  // `activeRunId` above rather than a reuse of it.
  //
  // `activeRunId` is a POLLED feed: it has a "quiet" state because a run can be open but silent, and
  // the canvas learns that only by asking. `busyUntil` is a PRECOMPUTED deadline that office-data.ts
  // derives from the tenant's real `activities` stream, so there is nothing to poll and no "quiet"
  // state to represent — either a real recorded action is still inside its window or the desk is
  // still. That also keeps 26 human seats from adding 26 pollers to the page.
  //
  // Checked LAST so it can never override a more specific signal, and gated on `Number.isFinite`
  // rather than truthiness because Date.parse of a malformed timestamp is NaN, and every comparison
  // against NaN is false — which would silently read as "not busy" instead of surfacing bad data.
  if (avatar.busyUntil) {
    const busyUntilMs = Date.parse(avatar.busyUntil);
    if (Number.isFinite(busyUntilMs) && busyUntilMs > nowMs) return "working";
  }
  return "none";
}

function drawAvatar(
  ctx: CanvasRenderingContext2D, pos: Positioned, tokens: TokenSet, isSelected: boolean, isHovered: boolean,
  scale: number, emoteKind: AgentRunEventKind | null, pulseOn: boolean, transitLane = 0,
  ambientLine: string | null = null,
  // Ambient WALKING (owner feedback 2026-08-26: "movement can really look like walking" / current
  // motion is "too rigid") — null while paused at the desk (or while reduced motion/replay-transit
  // already own the moment; see the Pass 3 call site's own guards). `walking` gates the "walk" pose
  // + a facing row instead of "sit" for a human, and the existing `walkBobPx` step instead of the
  // working pulse for an agent/automation — never BOTH a real transit AND an ambient walk at once.
  ambientWalk: AmbientWalk | null = null,
) {
  const cx = tilesToPx(pos.tile.x), cy = tilesToPx(pos.tile.y);
  const r = tilesToPx(0.62);
  const { avatar } = pos;
  drawContactShadow(ctx, cx, cy, r, tokens);
  // Desks sit DESK_SPACING_TILES apart; NAME_SLOT_TILES (lib/office.ts) is the gutter-safe width
  // derived from that same spacing, never an independent guess.
  //
  // NO ZOOM MULTIPLIER. A previous pass widened this budget to 1.6x at zoom >= 2, reasoning that a
  // reader who zoomed in wants the full name. That is wrong, and the Utility room proved it: four
  // automations with long names rendered as one run-on smear
  // ("A/TG summ…n8n workflow r…device alert…nightly report"). Zooming scales the whole canvas —
  // the text AND the gap between desks grow together — so the label never gains room relative to
  // its neighbour. Allowing 1.6x guarantees overlap at exactly the zoom level someone chose in
  // order to read more clearly.
  //
  // The real fix for long names is the detail panel and the roster, which both show them in full.
  // A label is a locator, not the content.
  const slotWidthPx = tilesToPx(NAME_SLOT_TILES);
  switch (avatar.kind) {
    case "agent": {
      // Purpose-drawn android (2026-08-24). Replaces the LPC body under a steel ramp, which was
      // always a stand-in for exactly this: "an unmistakably synthetic look". A recoloured human
      // reads as a grey person; this reads as a machine.
      const sprite = getRawImage(agentSpritePath(avatar.recordId, hashId));
      if (sprite) {
        ctx.imageSmoothingEnabled = false;
        const size = CHAR_PX * CHAR_DRAW_SCALE;
        // In transit — OR taking an ambient step (owner feedback 2026-08-26) — the bob comes from
        // DISTANCE (walkBobPx) so the android steps instead of gliding; paused at a desk it comes
        // from the working pulse. Never more than one of the three at once.
        const stepping = pos.inTransit || (ambientWalk?.walking ?? false);
        const bob = stepping ? walkBobPx(true, cx) : activeBobPx(emoteKind !== null, pulseOn);
        ctx.drawImage(sprite, cx - size / 2, cy - size * 0.6 - bob, size, size);
      } else {
        drawHumanoid(ctx, cx, cy, r, tokens.steel, tokens.ink, true);
      }
      break;
    }
    case "human": {
      // Kind taxonomy (plan §4.4): humans get a deterministic human skin ramp; internal agents
      // reuse the identical sprite under the fixed "steel" ramp so they read as synthetic without
      // ever being mistakable for a person. Sit is the default pose — an office is mostly people
      // at desks; walk is used only for the brief window a replay has this avatar in transit.
      // Humans stay on LPC ON PURPOSE. Those sheets carry real `walk` and `sit` poses; the new
      // 32px pack has one frame and one direction, so switching would trade a working walk cycle
      // for correct scale. That trade is worth making when the four directions land, not before.
      //
      // Ambient walking (owner feedback 2026-08-26) reuses that SAME real walk pose — never a
      // replay transit's own fixed "toward viewer" row, but a row chosen to FACE the direction of
      // travel (`facingRow`, office-sprites.ts), so a person taking a short lap actually turns to
      // walk it instead of sliding sideways. A real transit always wins when both could apply (the
      // Pass 3 call site already never hands both at once, but the `pos.inTransit` check here is
      // the second, redundant guard the rest of this file's honesty layers all carry).
      const inAmbientWalk = !pos.inTransit && (ambientWalk?.walking ?? false);
      const gender = pickGender(avatar.recordId);
      const pose: SpritePose = pos.inTransit || inAmbientWalk ? "walk" : "sit";
      const toneKey: string = pickSkinTone(avatar.recordId);
      const ramp: string[] = SKIN_RAMPS[pickSkinTone(avatar.recordId)];
      const frame = inAmbientWalk
        ? { col: POSE_FRAME.walk.col, row: facingRow(ambientWalk!.dirX, ambientWalk!.dirY) }
        : POSE_FRAME[pose];
      const sprite = getComposedSprite(gender, pose, toneKey, ramp, frame);
      if (sprite) {
        ctx.imageSmoothingEnabled = false;
        // Native 64x64 frame at integer 1x scale = exactly 2 tiles at this canvas's TILE_PX*ZOOM
        // (16*2=32px/tile) — the same footprint the old procedural figure already occupied, so no
        // change was needed to office.ts's TILE_PX/ZOOM/desk-spacing constants (plan §4.3b:
        // "integer scaling only"). Anchored so the sprite's feet land where the old figure's own
        // base — and the contact shadow under it — already sat.
        ctx.drawImage(sprite, cx - FRAME_PX / 2, cy - FRAME_PX * 0.6, FRAME_PX, FRAME_PX);
      } else {
        // Still loading (or a path 404'd) — same procedural stand-in this canvas always drew,
        // never a blank tile.
        drawHumanoid(ctx, cx, cy, r, tokens.catColor(avatar.recordId), tokens.ink, false);
      }
      break;
    }
    case "automation": {
      // Colour fallback chain (owner override, 2026-08-24) — see automationColorToken's own doc.
      // No per-automation colour SETTING exists yet (no settings UI ships in this pass), so the
      // first argument is always null today; department, then grey, is the real chain exercised.
      const colorToken = automationColorToken(null, avatar.deptId ?? null);
      const sprite = getRawImage(automationSpritePath(avatar.recordId, hashId));
      if (sprite) {
        // The department colour moves to a ring UNDER the sprite rather than being lost. The
        // owner's override asked for a settable department tone on automations; purpose-drawn
        // animals arrive with their own fixed palettes, so tinting the art would both fight the
        // artwork and make twelve distinguishable variants look like twelve muddied ones. A ring
        // keeps the binding visible and keeps the identity readable — and it is still the exact
        // `automationColorToken` chain, so the setting slots in unchanged when it ships.
        ctx.save();
        ctx.strokeStyle = tokens.resolveToken(colorToken);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy + r * 0.55, r * 1.05, r * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        ctx.imageSmoothingEnabled = false;
        const size = CHAR_PX * CHAR_DRAW_SCALE;
        // Unchanged: an automation never walks, even ambiently (legal/asset-licences.md's own
        // design note — "it fires and completes... a walking robot would be inventing a journey
        // that does not exist"). It still receives the small ambient POSITION offset every avatar
        // gets (see the Pass 3 call site), just never the walking BOB — only the working pulse.
        const bob = activeBobPx(emoteKind !== null, pulseOn);
        ctx.drawImage(sprite, cx - size / 2, cy - size * 0.6 - bob, size, size);
      } else {
        drawAutomation(ctx, cx, cy, r, tokens.resolveToken(colorToken), tokens.ink);
      }
      break;
    }
    case "external":
      drawExternal(ctx, cx, cy, r, tokens.external, tokens.ink);
      break;
  }
  if (isSelected || isHovered) {
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.1, r * 1.9, 0, Math.PI * 2);
    ctx.strokeStyle = tokens.accent;
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.setLineDash(isSelected ? [] : [3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Name label. Truncation is MEASURED, not a fixed character count: a hardcoded cap clipped
  // almost every name ("Supervis…", "Dewi San…") while rooms had hundreds of spare pixels, because
  // the cap could not know how wide a desk slot actually is. Measure the real string against the
  // slot and only shorten when it genuinely overflows — so short names are never touched and long
  // ones lose the minimum. The full name is always in the detail panel regardless.
  ctx.fillStyle = tokens.ink;
  ctx.font = `600 ${Math.round(tilesToPx(0.5))}px ${tokens.fontBody}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const label = fitLabel(ctx, avatar.name, slotWidthPx);
  let belowY = cy + r * 1.6;
  ctx.fillText(label, cx, belowY);
  belowY += tilesToPx(0.55);
  ctx.textAlign = "left";
  // Assurance is drawn BELOW the avatar (with the name), never above it — the room's own
  // label/caption band lives above every desk row, and a badge drawn upward would collide with it
  // the moment a room's caption runs long. "Assurance is drawn, never implied" (plan §4.4) still
  // holds; only the placement is chosen to never fight the layout above it.
  if (avatar.kind === "external") {
    const tier = avatar.assurance ?? "anonymous";
    ctx.fillStyle = assuranceColor(tokens, tier);
    ctx.font = `700 ${Math.round(tilesToPx(0.42))}px ${tokens.fontBody}`;
    ctx.textAlign = "center";
    ctx.fillText(ASSURANCE_SHORT[tier], cx, belowY);
    ctx.textAlign = "left";
  }
  if (pos.inTransit && pos.transitLabel) drawTransitLabel(ctx, cx, cy - r * 2.6, pos.transitLabel, tokens, transitLane);
  // The emote bubble (req #2) sits ABOVE the transit label's own y (r*2.6 up) so the rare overlap
  // of "in transit" + "genuinely working" never collides. `emoteKind` is null for every avatar
  // except a genuinely-working `agent` with a real event kind — see the Pass 3 call site for the
  // two-layer guarantee that a human never reaches this branch.
  if (emoteKind) drawEmoteBubble(ctx, cx, cy - r * 3.6, emoteKind, tokens, pulseOn);
  // Ambient speech bubble (owner decision 2026-08-26) — same slot as the emote bubble, mutually
  // exclusive with it (the Pass 3 call site never hands both at once), decoration only.
  else if (ambientLine) drawSpeechBubble(ctx, cx, cy - r * 3.6, ambientLine, tokens);
}

const WORKING_POLL_MS = 8000;

/** How often the whole SCENE is re-fetched from the server (2026-08-24, for the simulation).
 *  The 8s poll above refreshes agent run events ONLY. Everything else the floor draws — automation
 *  execution state, busy desks, and the derived handoff movement events — is assembled server-side
 *  in office-data.ts and, before this, was fetched exactly once when the page loaded. With a
 *  simulator driving real work into the estate, that meant the office quietly showed a snapshot
 *  from whenever the tab was opened and looked frozen while the floor was genuinely busy.
 *  Longer than the run poll because this re-runs a whole server component, not one endpoint. */
const SCENE_REFRESH_MS = 15_000;
const PULSE_TICK_MS = 450;

// ── Ambient walking + speech bubbles (owner decision 2026-08-26) ────────────────────────────────
// One shared tick for both. 200ms is plenty of resolution for motion this slow (`ambientWalkState`
// cycles run 14-22s, with ~1.1-1.5s walk legs) and far cheaper than a 60fps RAF across 80+ avatars.
const AMBIENT_TICK_MS = 200;
/** "on at most one or two avatars at a time" — the whole reason bubble scheduling needs shared
 *  state at all, rather than each avatar rolling its own dice independently. */
const AMBIENT_BUBBLE_MAX_CONCURRENT = 2;
/** Per-tick chance of starting ONE new bubble, checked only while under the concurrency cap above —
 *  tuned for "occasionally": at a 200ms tick this is roughly one new bubble every ~20s while the
 *  floor has spare capacity, never a queue and never silence for whole minutes. */
const AMBIENT_BUBBLE_CHANCE_PER_TICK = 0.01;
const AMBIENT_BUBBLE_DURATION_MS = 3600;

export function OfficeCanvas({ scene, initialZoom }: { scene: OfficeScene; initialZoom: OfficeZoom }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const router = useRouter();
  const [replaying, setReplaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [selectedFloorIndex, setSelectedFloorIndex] = useState(0);

  // Stable "now" for the whole session — a demo snapshot, not a clock. Re-reading Date.now() per
  // render would make an avatar's resting room silently shift as fixture timestamps age past it.
  const [nowMs] = useState(() => Date.now());

  const floors = scene.floors;
  const floor = floors[selectedFloorIndex] ?? floors[0] ?? null;
  const roomByKey = useMemo(() => new Map(allRooms(floors).map((r) => [r.key, r] as const)), [floors]);
  const floorRoomKeys = useMemo(() => new Set((floor?.rooms ?? []).map((r) => r.key)), [floor]);
  const grid = useMemo(() => (floor ? buildWalkableGrid(floor) : null), [floor]);
  const getPath = useMemo(() => {
    const cache = new Map<string, { x: number; y: number }[] | null>();
    return (fromKey: string, toKey: string) => {
      if (!floor || !grid) return null;
      const cacheKey = `${fromKey}=>${toKey}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey)!;
      const fromRoom = floor.rooms.find((r) => r.key === fromKey);
      const toRoom = floor.rooms.find((r) => r.key === toKey);
      const path = fromRoom && toRoom ? roomToRoomPath(grid, fromRoom, toRoom) : null;
      cache.set(cacheKey, path);
      return path;
    };
  }, [floor, grid]);

  const cssW = tilesToPx(floor?.widthTiles ?? 0), cssH = tilesToPx(floor?.heightTiles ?? 0);

  // ── Camera — zoom / pan / follow (req #1) ──────────────────────────────────────────────────
  // `zoomPref` is the persisted PREFERENCE ("fit" or a pinned integer step — see lib/prefs.ts's
  // OfficeZoom, same auto-vs-pinned shape Theme already uses); the actual `scale` used to render
  // is always DERIVED from it plus the current floor's content size and the measured viewport size
  // — never stored redundantly, so it can never disagree with either. `center` is the one piece of
  // camera state that's a plain value: the content-space point the viewport is centred on.
  const [zoomPref, setZoomPref] = useState<OfficeZoom>(initialZoom);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [center, setCenter] = useState<{ x: number; y: number }>(() => ({ x: cssW / 2, y: cssH / 2 }));
  const [followingId, setFollowingId] = useState<string | null>(null);
  const [followReleasedNotice, setFollowReleasedNotice] = useState(false);
  // Which rail tab is showing. The rail used to stack legend + roster + detail in one long column,
  // which pushed the detail panel below the fold on a real floor. Tabs are presentation only — no
  // tab shows anything the page did not already have, and none implies a capability that is not
  // built (the office plan §3 rules that out explicitly).
  const [railTab, setRailTab] = useState<RailTab>("cast");
  // Fullscreen is a CSS state, not the Fullscreen API: the app shell stays mounted (so the sidebar
  // and its nav are still there on exit) and Escape returns. The browser API would take over the
  // whole document and fight the shell's own focus management.
  const [fullscreen, setFullscreen] = useState(false);
  const [, startZoomTransition] = useTransition();
  const followReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ startVX: number; startVY: number; startCenter: { x: number; y: number }; moved: boolean } | null>(null);

  // A pinned step is always the integer the person chose. Only "fit" may come back fractional, and
  // only when no integer step can show the whole plate — see `fitScale`.
  const scale = useMemo<number>(() => {
    const vw = viewportSize.w || cssW || 1, vh = viewportSize.h || cssH || 1;
    return zoomPref === "fit" ? fitScale(cssW, cssH, vw, vh) : zoomPref;
  }, [zoomPref, cssW, cssH, viewportSize]);

  const camera = useMemo<Camera>(() => {
    const vw = viewportSize.w || cssW || 1, vh = viewportSize.h || cssH || 1;
    return clampCamera({ scale, centerX: center.x, centerY: center.y }, cssW, cssH, vw, vh);
  }, [scale, center, cssW, cssH, viewportSize]);

  // Mirrored into refs for the wheel listener below, which registers ONCE (native, non-passive —
  // React's synthetic wheel handler is passive and can't preventDefault) and must always read the
  // LATEST camera/scale/size rather than closing over the values from whenever it was attached.
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const viewportSizeRef = useRef(viewportSize); viewportSizeRef.current = viewportSize;
  const cssSizeRef = useRef({ w: cssW, h: cssH }); cssSizeRef.current = { w: cssW, h: cssH };

  /** Clicking an avatar, a manual pan, or a manual zoom releases follow (req #1: "make releasing
   *  obvious") — a transient notice is set alongside so the release is announced, not just a chip
   *  silently vanishing. Cheap to call unconditionally: a no-op when nothing was being followed. */
  const releaseFollow = useCallback(() => {
    setFollowingId((prev) => {
      if (prev === null) return prev;
      setFollowReleasedNotice(true);
      if (followReleaseTimerRef.current) clearTimeout(followReleaseTimerRef.current);
      followReleaseTimerRef.current = setTimeout(() => setFollowReleasedNotice(false), 2500);
      return null;
    });
  }, []);

  useEffect(() => () => { if (followReleaseTimerRef.current) clearTimeout(followReleaseTimerRef.current); }, []);

  // Measure the viewport's real rendered size — the camera's viewport-space math (fit/clamp/
  // cursor-anchored zoom) needs actual pixels, not a CSS length string.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewportSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Switching floors changes the content-space coordinate system entirely (each floor is its own
  // independent footprint) — recentre on the new floor and drop any in-flight follow, which would
  // otherwise keep pointing at wherever the old floor's coordinates happened to land.
  useEffect(() => {
    setCenter({ x: cssW / 2, y: cssH / 2 });
    setFollowingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFloorIndex]);

  const stepZoom = useCallback((delta: 1 | -1) => {
    const idx = ZOOM_LEVELS.indexOf(nearestZoomLevel(scaleRef.current));
    const nextScale = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, idx + delta))];
    if (nextScale === scaleRef.current) return;
    const vw = viewportSizeRef.current.w || cssSizeRef.current.w || 1, vh = viewportSizeRef.current.h || cssSizeRef.current.h || 1;
    const next = zoomCameraAtPoint(cameraRef.current, nextScale, vw / 2, vh / 2, vw, vh);
    setCenter({ x: next.centerX, y: next.centerY });
    setZoomPref(nextScale);
    releaseFollow();
    startZoomTransition(() => { void setOfficeZoomAction(nextScale); });
  }, [releaseFollow]);

  const goToFit = useCallback(() => {
    setZoomPref("fit");
    setCenter({ x: cssSizeRef.current.w / 2, y: cssSizeRef.current.h / 2 });
    releaseFollow();
    startZoomTransition(() => { void setOfficeZoomAction("fit"); });
  }, [releaseFollow]);

  // Cursor-anchored scroll-wheel zoom (req #1) — a native, non-passive listener: React's own
  // onWheel is attached passive by default, so `preventDefault()` inside it is silently ignored
  // and the page would scroll underneath the zoom. Registers ONCE; reads current values via the
  // refs above rather than re-subscribing on every camera change.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const vx = e.clientX - rect.left, vy = e.clientY - rect.top;
      const idx = ZOOM_LEVELS.indexOf(nearestZoomLevel(scaleRef.current));
      const dir = e.deltaY < 0 ? 1 : -1;
      const nextScale = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, idx + dir))];
      if (nextScale === scaleRef.current) return;
      const vw = viewportSizeRef.current.w || cssSizeRef.current.w || 1, vh = viewportSizeRef.current.h || cssSizeRef.current.h || 1;
      const next = zoomCameraAtPoint(cameraRef.current, nextScale, vx, vy, vw, vh);
      setCenter({ x: next.centerX, y: next.centerY });
      setZoomPref(nextScale);
      releaseFollow();
      startZoomTransition(() => { void setOfficeZoomAction(nextScale); });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Arrow-key panning (req #1: keyboard accessibility) on the focusable viewport. `+`/`-` mirror
   *  the toolbar zoom buttons for a keyboard user who has already tabbed to the viewport. */
  const onViewportKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = 64 / scale;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      releaseFollow();
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      setCenter((c) => ({ x: c.x + dx, y: c.y + dy }));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      stepZoom(1);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      stepZoom(-1);
    }
  }, [scale, releaseFollow, stepZoom]);

  const replayRef = useRef<{ steps: ReplayStep[]; startPerf: number; pausedAtPerf: number | null; total: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastPositionsRef = useRef<Positioned[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const followingIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  hoveredIdRef.current = hoveredId;
  followingIdRef.current = followingId;

  // Paused refs shared by BOTH the replay RAF loop and the working-animation pulse timer below —
  // one visibility/offscreen story for every continuously-ticking thing this canvas can run.
  const pausedByVisibility = useRef(false);
  const pausedByOffscreen = useRef(false);
  // Current phase of the working-animation pulse (req #5) — a ref, not state, because `draw()`
  // reads it synchronously at call time and a redraw is already triggered explicitly wherever this
  // flips; making it state too would just double every working-desk redraw for no benefit.
  const pulseOnRef = useRef(false);
  // Active ambient speech bubbles, keyed by avatar id (owner decision 2026-08-26) — a ref for the
  // same reason as `pulseOnRef`: `draw()` reads it synchronously, and the ambient timer below is
  // what mutates it and triggers the redraw explicitly. Scheduling (who gets a bubble, and when)
  // lives in that timer's own callback, never inside `draw()` itself — `draw()` also runs once per
  // replay animation frame (up to 60/s) and once per hover/selection change, and rolling dice on
  // every one of those calls would make bubbles far more frequent than "occasionally" and burn
  // cycles for no visual gain.
  const ambientBubbleRef = useRef<Map<string, { text: string; untilMs: number }>>(new Map());

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // ── O4 — genuinely working (req #5) ────────────────────────────────────────────────────────
  // Polls ONLY the avatars office-data.ts proved have a real, currently-open run (`activeRunId`)
  // — never humans, who carry no such field at all (see office.ts's own doc comment on why). A
  // plain `setInterval`, not a loop tied to rendering: it exists only while there is at least one
  // such avatar, stops when the list is empty, and skips its own fetch while the tab is hidden.
  const activeRunAvatars = useMemo(() => scene.avatars.filter((a): a is OfficeAvatar & { activeRunId: string } => !!a.activeRunId), [scene.avatars]);
  const workingStateRef = useRef(new Map<string, { cursor: number; lastEventAtMs: number | null; lastEventKind: AgentRunEventKind | null }>());
  const [workingIds, setWorkingIds] = useState<Set<string>>(new Set());
  const [lastHeardMs, setLastHeardMs] = useState<Map<string, number | null>>(new Map());
  // The latest REAL event kind per avatar (req #2) — drives which emote glyph draws. Kept separate
  // from `lastHeardMs` (rather than folding kind into that map) because most existing consumers of
  // `lastHeardMs` only ever wanted the timestamp; adding kind there would force them to unwrap it.
  const [emoteKinds, setEmoteKinds] = useState<Map<string, AgentRunEventKind | null>>(new Map());
  // Mirrored into refs for the ambient-bubble scheduler below, which must NOT re-subscribe its
  // setInterval every time a poll updates either of these (see that effect's own deps for why).
  const workingIdsRef = useRef(workingIds);
  const emoteKindsRef = useRef(emoteKinds);
  workingIdsRef.current = workingIds;
  emoteKindsRef.current = emoteKinds;

  // Automations (2026-08-24): no poll exists for these — office-data.ts already resolved the real
  // signal server-side, once, at this page's own render; there is nothing further to fetch client-
  // side (single-egress rule: adding a poll route here for a signal that doesn't change second-to-
  // second would just be a second loop for no real freshness gain). `automationPulseIds` is the
  // static (per this render's `nowMs`) set of automations currently `executing` or
  // `awaiting_approval` — the ONLY thing the shared pulse timer below needs to decide whether it
  // has any automation reason to keep running, on top of its existing agent reason.
  const automationPulseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of scene.avatars) {
      if (a.kind !== "automation" || !a.automationSignal) continue;
      const state = resolveAutomationState(a.automationSignal, nowMs);
      if (state === "executing" || state === "awaiting_approval") ids.add(a.id);
    }
    return ids;
  }, [scene.avatars, nowMs]);

  useEffect(() => {
    if (activeRunAvatars.length === 0) {
      setWorkingIds(new Set());
      setLastHeardMs(new Map());
      setEmoteKinds(new Map());
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (document.hidden) return;
      const results = await Promise.all(activeRunAvatars.map(async (a) => {
        const prior = workingStateRef.current.get(a.id) ?? { cursor: 0, lastEventAtMs: null, lastEventKind: null };
        try {
          const res = await fetch(`/api/admin/agents/runs/${encodeURIComponent(a.activeRunId)}/events?since=${prior.cursor}`, { cache: "no-store" });
          if (!res.ok) return { id: a.id, state: prior };
          const data: { events?: AgentRunEvent[] } = await res.json();
          const events = Array.isArray(data.events) ? data.events : [];
          if (events.length === 0) return { id: a.id, state: prior };
          const cursor = nextCursor(events, prior.cursor);
          let latestTs = prior.lastEventAtMs ?? 0;
          let latestKind = prior.lastEventKind;
          for (const e of events) {
            const t = Date.parse(e.ts);
            if (Number.isNaN(t) || t < latestTs) continue;
            latestTs = t;
            latestKind = e.kind;
          }
          return { id: a.id, state: { cursor, lastEventAtMs: latestTs, lastEventKind: latestKind } };
        } catch {
          return { id: a.id, state: prior };
        }
      }));
      if (cancelled) return;
      for (const r of results) workingStateRef.current.set(r.id, r.state);
      const now = Date.now();
      const nextWorking = new Set<string>();
      const nextHeard = new Map<string, number | null>();
      const nextEmotes = new Map<string, AgentRunEventKind | null>();
      for (const [id, st] of workingStateRef.current) {
        nextHeard.set(id, st.lastEventAtMs);
        nextEmotes.set(id, st.lastEventKind);
        if (isGenuinelyWorking(st.lastEventAtMs, now)) nextWorking.add(id);
      }
      setWorkingIds(nextWorking);
      setLastHeardMs(nextHeard);
      setEmoteKinds(nextEmotes);
    };
    poll();
    const interval = setInterval(poll, WORKING_POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunAvatars.map((a) => a.activeRunId).join(",")]);

  const draw = useCallback((elapsedMs: number | null) => {
    const canvas = canvasRef.current;
    if (!canvas || !floor) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const tokens = readTokens(canvas);
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = tokens.page;
    ctx.fillRect(0, 0, cssW, cssH);

    const hoveredRoomKey = hoveredIdRef.current ? lastPositionsRef.current.find((p) => p.avatar.id === hoveredIdRef.current)?.roomKey : null;

    // Pass 0 — the building shell + corridor. This is what makes it ONE floor plate (req #1).
    drawOuterShell(ctx, floor, tokens);
    drawCorridorFloor(ctx, floor, tokens);
    drawCorridorNook(ctx, floor, tokens);

    // Pass 1 — floor + walls + nameplate for every room ON THIS FLOOR.
    for (const room of floor.rooms) {
      const rect = roomTileRect(room);
      drawFloor(ctx, rect, tokens, room.kind);
      drawWalls(ctx, room, tokens, room.key === hoveredRoomKey);
      drawNamePlate(ctx, room, tokens);
    }

    // Pass 2 — furniture, keyed to who CANONICALLY rests in each room on THIS floor (ignoring any
    // in-flight replay animation elsewhere) so desks never flicker empty/full mid-replay.
    const canonical = steadyPositions(scene, roomByKey, nowMs, new Set()).filter((p) => floorRoomKeys.has(p.roomKey));
    const canonicalByRoom = new Map<string, Positioned[]>();
    for (const p of canonical) {
      if (!canonicalByRoom.has(p.roomKey)) canonicalByRoom.set(p.roomKey, []);
      canonicalByRoom.get(p.roomKey)!.push(p);
    }
    for (const room of floor.rooms) {
      const occupants = canonicalByRoom.get(room.key) ?? [];
      if (room.kind === "lobby") {
        drawLobbyChairs(ctx, room, tokens);
        drawReceptionDesk(ctx, room, tokens);
        drawPlant(ctx, tilesToPx(room.x + room.wTiles - 1.1), tilesToPx(room.y + room.hTiles - 1.0), tokens);
        for (const p of occupants) drawWaitingChair(ctx, p.tile, tokens);
        continue;
      }
      if (room.kind === "utility") drawServerRack(ctx, room, tokens);
      if (room.kind === "department") {
        // A plant in the back inner corner, opposite the doorway — never on top of a desk slot.
        const backY = room.side === "north" ? room.y + 0.9 : room.y + room.hTiles - 0.7;
        drawPottedPlant(ctx, tilesToPx(room.x + room.wTiles - 0.9), tilesToPx(backY), tokens, room.key);
      }
      // A deterministic wall prop (whiteboard/printer/filing cabinet/bookshelf/notice board) for
      // every room that has desks — mirrors the plant/server-rack corner above onto the OPPOSITE
      // wall, so it never fights either. See drawRoomDressing's own doc for why this can't jitter.
      if (room.kind === "department" || room.kind === "agents" || room.kind === "utility") {
        drawRoomDressing(ctx, room);
      }
      for (const p of occupants) {
        const activity = deskActivityFor(p.avatar, workingIds, nowMs);
        drawDesk(ctx, p.tile, tokens, true, room.kind, activity, pulseOnRef.current);
        if (p.avatar.kind === "human") drawDeskFigurine(ctx, p.tile, p.avatar.id);
      }
      const vacant = vacantDeskSlots(occupants.length, room.deskCols);
      for (let i = 0; i < vacant; i++) drawDesk(ctx, deskSlotTile(room, occupants.length + i), tokens, false, room.kind);
    }

    // Pass 3 — the people/agents/automations themselves, always on top of their own furniture.
    const animatedIds = new Set(elapsedMs !== null && replayRef.current ? replayRef.current.steps.map((s) => s.avatarId) : []);
    const positions = [
      ...steadyPositions(scene, roomByKey, nowMs, animatedIds),
      ...(elapsedMs !== null && replayRef.current ? replayPositions(scene, roomByKey, replayRef.current.steps, elapsedMs, getPath) : []),
    ].filter((p) => floorRoomKeys.has(p.roomKey));
    lastPositionsRef.current = positions;
    // Transit-label lanes. Two avatars walking near each other produced two plates at the SAME
    // height, and the second one painted over the first — the label was there but unreadable, which
    // is the failure the plate was added to prevent. Ordering the in-transit avatars by x and
    // alternating lanes guarantees any two neighbours sit at different heights, so they stack
    // instead of occluding. Deterministic, so a label does not jitter between frames.
    const transitLanes = new Map<string, number>();
    positions
      .filter((pp) => pp.inTransit && pp.transitLabel)
      .sort((a, b) => a.tile.x - b.tile.x)
      .forEach((pp, i) => transitLanes.set(pp.avatar.id, i % 2));

    // Ambient drift's own clock (owner decision 2026-08-26) — REAL wall-clock time, deliberately
    // NOT the frozen `nowMs` state above (that is a fixed demo snapshot; drift needs an actual
    // clock that moves). Read once per draw() call so every avatar drawn this frame agrees on "now".
    const ambientMs = Date.now();
    for (const pos of positions) {
      // Two independent layers keep an emote bubble off a human, not one: office-data.ts only ever
      // sets `activeRunId`/`automationSignal` on an `agent`/`automation`-kind avatar respectively
      // (humans have no comparable activity feed — see that file's own doc comment), AND
      // `emoteKindFor` re-checks `kind` itself rather than trusting either field alone. `workingIds`
      // is the same 45s-freshness gate the desk monitor tint already uses for agents; automations
      // resolve their own freshness inside `resolveAutomationState` using that identical window.
      const emoteKind = emoteKindFor(pos.avatar, workingIds, emoteKinds, nowMs);
      // Ambient WALKING (owner feedback 2026-08-26: replaces the old continuous lissajous drift,
      // which glided every avatar all the time and read as "too rigid") is a RENDER-ONLY offset off
      // the canonical `pos.tile` computed above — `positions`/`lastPositionsRef` stay canonical so
      // hit-testing and camera-follow are never thrown off by a few tenths of a tile of pure
      // decoration. It applies only to a steady, non-transit avatar (a real transit already owns
      // its own path — the plan's "always wins" rule) and never while reduced motion is on, which
      // is this feature's hard kill switch. `ambientWalkState` itself takes no signal beyond
      // (avatarId, time) — see its doc in lib/office.ts for why that is load-bearing, not
      // incidental; `ambientDriftOffset` stays in lib/office.ts, untouched and still tested, this
      // is simply a different caller choice.
      const walk = !reducedMotion && !pos.inTransit ? ambientWalkState(pos.avatar.id, ambientMs) : null;
      const renderPos = walk ? { ...pos, tile: addTile(pos.tile, walk) } : pos;
      const bubble = !reducedMotion && !pos.inTransit && !emoteKind ? ambientBubbleRef.current.get(pos.avatar.id) : undefined;
      const ambientLine = bubble && bubble.untilMs > ambientMs ? bubble.text : null;
      drawAvatar(ctx, renderPos, tokens, pos.avatar.id === selectedIdRef.current, pos.avatar.id === hoveredIdRef.current, scale, emoteKind, pulseOnRef.current, transitLanes.get(pos.avatar.id) ?? 0, ambientLine, walk);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, roomByKey, nowMs, cssW, cssH, floor, floorRoomKeys, getPath, workingIds, scale, emoteKinds, reducedMotion]);

  // One-shot redraw on mount, scene/floor change, resize, and theme flips (data-theme is an
  // attribute change, not a resize — MutationObserver is the only signal for it).
  useEffect(() => {
    draw(null);
    const onResize = () => draw(replayRef.current && replaying ? performance.now() - replayRef.current.startPerf : null);
    window.addEventListener("resize", onResize);
    const mo = new MutationObserver(() => draw(null));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { window.removeEventListener("resize", onResize); mo.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw]);

  // Sprites load asynchronously (real PNGs, not a procedural shape) — this is the one-line
  // subscription that turns "a composite finally became ready" into a redraw, matching the
  // one-shot-redraw discipline above rather than starting any kind of loop. No RAF, no polling.
  useEffect(() => {
    const onReady = () => draw(replayRef.current && replaying ? performance.now() - replayRef.current.startPerf : null);
    spriteReadyListeners.add(onReady);
    return () => { spriteReadyListeners.delete(onReady); };
  }, [draw, replaying]);

  // ── The working-animation "pulse" (req #5) — a coarse setInterval, never a RAF loop, that
  // exists ONLY while `workingIds` is non-empty and stops the instant it's empty again. Reduced
  // motion collapses this to a single static "on" state (no toggling at all) rather than an
  // instant cut mid-pulse, matching how buildReplaySteps treats reduced motion elsewhere. ────────
  useEffect(() => {
    // ONE shared interval covers every animating principal — agents AND automations both feed the
    // same boolean gate, never a second timer per source (perf req: "several animating principals
    // at once must not spin up several loops").
    if (workingIds.size === 0 && automationPulseIds.size === 0) { pulseOnRef.current = false; return; }
    if (reducedMotion) { pulseOnRef.current = true; draw(null); return; }
    const id = setInterval(() => {
      if (pausedByVisibility.current || pausedByOffscreen.current) return;
      pulseOnRef.current = !pulseOnRef.current;
      draw(replayRef.current && replaying ? performance.now() - replayRef.current.startPerf : null);
    }, PULSE_TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingIds, automationPulseIds, reducedMotion, draw, replaying]);

  // ── Ambient walking + speech bubbles (owner decision 2026-08-26) — the second, decorative
  // movement tier. UNCONDITIONAL and ALWAYS ON while motion is allowed at all: unlike the pulse
  // timer above, this does not gate on any real activity signal — every avatar takes its short
  // walks, all the time, precisely because doing otherwise would make the walk a claim about who it
  // is (see `ambientWalkState`'s own doc in lib/office.ts). ONE shared `setInterval` for both the
  // walk and bubble scheduling, never
  // one per avatar — this is what lets it scale to 80+ seats. Paused by the SAME visibility/
  // offscreen refs as the replay loop and the pulse timer, and reduced motion kills it outright:
  // the branch below does one settling `draw()` (so any drift/bubble already on screen is cleared)
  // and starts no interval at all.
  useEffect(() => {
    if (reducedMotion) {
      ambientBubbleRef.current.clear();
      draw(replayRef.current && replaying ? performance.now() - replayRef.current.startPerf : null);
      return;
    }
    const id = setInterval(() => {
      if (pausedByVisibility.current || pausedByOffscreen.current) return;
      // Bubble scheduling lives HERE, not inside draw() — draw() also runs on every replay animation
      // frame (up to 60/s) and every hover/selection change, and rolling dice there would make
      // bubbles far more frequent than "occasionally" for no visual gain. This tick is the only
      // place a bubble is started or expired.
      const now = Date.now();
      for (const [id2, b] of ambientBubbleRef.current) {
        if (now >= b.untilMs) ambientBubbleRef.current.delete(id2);
      }
      if (ambientBubbleRef.current.size < AMBIENT_BUBBLE_MAX_CONCURRENT && Math.random() < AMBIENT_BUBBLE_CHANCE_PER_TICK) {
        // Candidates come from the CURRENT floor's last-drawn positions (already scoped to
        // `floorRoomKeys` by draw()'s own filter) — never an avatar mid-transit (a real handover
        // owns the moment) and never one that already carries a real emote bubble (the two bubble
        // kinds must never stack; see drawAvatar's own doc).
        const candidates = lastPositionsRef.current.filter(
          (p) => !p.inTransit && !ambientBubbleRef.current.has(p.avatar.id)
            && !emoteKindFor(p.avatar, workingIdsRef.current, emoteKindsRef.current, nowMs),
        );
        if (candidates.length > 0) {
          const pick = candidates[Math.floor(Math.random() * candidates.length)];
          const line = pickAmbientLine(hashId(pick.avatar.id) ^ Math.floor(now / 4000));
          ambientBubbleRef.current.set(pick.avatar.id, { text: line, untilMs: now + AMBIENT_BUBBLE_DURATION_MS });
        }
      }
      draw(replayRef.current && replaying ? performance.now() - replayRef.current.startPerf : null);
    }, AMBIENT_TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, draw, replaying]);

  // ── Replay: a RAF loop that exists ONLY while playing, paused (not merely throttled) when the
  // tab is hidden or the canvas leaves the viewport. Nothing runs at all otherwise. ──────────────
  const tick = useCallback(() => {
    const r = replayRef.current;
    if (!r) return;
    if (pausedByVisibility.current || pausedByOffscreen.current) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const elapsed = performance.now() - r.startPerf;
    draw(elapsed);
    // Follow mode (req #1): re-centre on the followed avatar's just-drawn position every frame —
    // `draw()` above just populated `lastPositionsRef` for this exact instant. This is the ONLY
    // place camera follow keeps up with movement, because a replay step is the ONLY way an avatar's
    // position changes at all (steady-state avatars don't move between renders).
    if (followingIdRef.current) {
      const followed = lastPositionsRef.current.find((p) => p.avatar.id === followingIdRef.current);
      if (followed) setCenter({ x: tilesToPx(followed.tile.x), y: tilesToPx(followed.tile.y) });
    }
    if (elapsed >= r.total) {
      replayRef.current = null;
      setReplaying(false);
      draw(null);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [draw]);

  const startReplay = useCallback(() => {
    if (scene.events.length === 0) return;
    const steps = buildReplaySteps(scene.events, reducedMotion);
    const total = totalReplayMs(steps);
    replayRef.current = { steps, startPerf: performance.now(), pausedAtPerf: null, total };
    setReplaying(true);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [scene.events, reducedMotion, tick]);

  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState !== "visible";
      const r = replayRef.current;
      if (!r) { pausedByVisibility.current = hidden; return; }
      if (hidden && !pausedByVisibility.current) {
        r.pausedAtPerf = performance.now();
      } else if (!hidden && pausedByVisibility.current && r.pausedAtPerf != null) {
        r.startPerf += performance.now() - r.pausedAtPerf;
        r.pausedAtPerf = null;
      }
      pausedByVisibility.current = hidden;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ── Keep the scene current while the tab is watched ───────────────────────────────────────────
  // `router.refresh()` re-runs the server component and hands back a fresh scene; React keeps this
  // component's own state (camera, zoom, selection) across it, so the view does not jump.
  // Skipped while hidden — a background tab re-rendering the floor every 15s is pure waste — and
  // skipped mid-replay, where swapping the event list under a running animation would stutter it.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (replayRef.current && replayRef.current.pausedAtPerf == null && replaying) return;
      router.refresh();
    }, SCENE_REFRESH_MS);
    return () => clearInterval(id);
  }, [router, replaying]);

  // ── Play movement when it ARRIVES, instead of waiting for a click ─────────────────────────────
  // The replay button stays (it is how you re-watch), but a floor whose movement only ever plays on
  // demand cannot show a live simulation: the events would land, sit still, and be replaced by the
  // next refresh without anyone seeing them.
  //
  // Keyed on the SET of event ids, so this fires when the movement genuinely changes and never on
  // a refresh that returned the same handoffs. A floor with no new events never auto-plays, which
  // is what keeps this from becoming ambient motion the data does not support.
  const lastEventKey = useRef<string | null>(null);
  useEffect(() => {
    const key = scene.events.map((e) => e.id).sort().join("|");
    if (lastEventKey.current === key) return;
    lastEventKey.current = key;
    if (key === "" || replaying) return;
    startReplay();
  }, [scene.events, replaying, startReplay]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      const offscreen = !entry.isIntersecting;
      const r = replayRef.current;
      if (!r) { pausedByOffscreen.current = offscreen; return; }
      if (offscreen && !pausedByOffscreen.current) {
        r.pausedAtPerf = performance.now();
      } else if (!offscreen && pausedByOffscreen.current && r.pausedAtPerf != null) {
        r.startPerf += performance.now() - r.pausedAtPerf;
        r.pausedAtPerf = null;
      }
      pausedByOffscreen.current = offscreen;
    }, { threshold: 0.05 });
    io.observe(canvas);
    return () => io.disconnect();
  }, []);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Redraw (one-shot) whenever hover/selection changes — a discrete state change, not an animation.
  useEffect(() => { if (!replaying) draw(null); }, [selectedId, hoveredId, replaying, draw]);

  /** Hit-test a point given in VIEWPORT space (relative to the fixed, un-transformed viewport div
   *  — never the canvas's own bounding rect, which moves/scales under the camera transform) —
   *  inverted through the current camera into content space before comparing against
   *  `lastPositionsRef`, which is always in content space regardless of zoom. */
  const pointerToAvatarAtViewport = useCallback((vx: number, vy: number): string | null => {
    const vw = viewportSize.w || cssW || 1, vh = viewportSize.h || cssH || 1;
    const content = viewportToContentPoint(camera, vx, vy, vw, vh);
    let best: { id: string; d2: number } | null = null;
    for (const pos of lastPositionsRef.current) {
      const cx = tilesToPx(pos.tile.x), cy = tilesToPx(pos.tile.y);
      const d2 = (cx - content.x) ** 2 + (cy - content.y) ** 2;
      const hitR = tilesToPx(1.1);
      if (d2 <= hitR * hitR && (!best || d2 < best.d2)) best = { id: pos.avatar.id, d2 };
    }
    return best?.id ?? null;
  }, [camera, viewportSize, cssW, cssH]);

  /** Selecting an avatar (from the canvas or the roster) jumps the floor selector to wherever it
   *  actually is, AND engages follow mode (req #1: "clicking an avatar centres the camera on it and
   *  keeps it centred while it moves"). Centres from `steadyPositions` directly rather than
   *  `lastPositionsRef` — a roster click that also switches floors needs the NEW floor's position
   *  before the next draw() has even run, and `lastPositionsRef` would still hold the OLD floor's
   *  contents at that instant. */
  const selectAvatar = useCallback((id: string) => {
    setSelectedId(id);
    const avatar = scene.avatars.find((a) => a.id === id);
    if (!avatar) return;
    const room = roomByKey.get(restingRoomKey(avatar, scene.events, nowMs));
    if (room && room.floor !== selectedFloorIndex) setSelectedFloorIndex(room.floor);
    const pos = steadyPositions(scene, roomByKey, nowMs, new Set()).find((p) => p.avatar.id === id);
    if (pos) setCenter({ x: tilesToPx(pos.tile.x), y: tilesToPx(pos.tile.y) });
    setFollowingId(id);
  }, [scene, roomByKey, nowMs, selectedFloorIndex]);

  /** Pointer handling on the fixed VIEWPORT (never the canvas, which moves under the camera
   *  transform) — one state machine covering hover, click-to-select, and drag-to-pan (req #1),
   *  unified via Pointer Events so mouse/touch/pen all get the same behaviour. A press only becomes
   *  a "drag" once it moves past a small threshold; short of that it resolves as a click (select),
   *  matching how every drag-capable map/canvas UI distinguishes the two. */
  const onViewportPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = { startVX: e.clientX - rect.left, startVY: e.clientY - rect.top, startCenter: { x: camera.centerX, y: camera.centerY }, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [camera]);

  const onViewportPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = e.clientX - rect.left, vy = e.clientY - rect.top;
    const drag = dragRef.current;
    if (drag) {
      const dx = vx - drag.startVX, dy = vy - drag.startVY;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; releaseFollow(); }
      if (drag.moved) {
        setCenter({ x: drag.startCenter.x - dx / scale, y: drag.startCenter.y - dy / scale });
        return;
      }
    }
    const id = pointerToAvatarAtViewport(vx, vy);
    if (id !== hoveredIdRef.current) setHoveredId(id);
  }, [scale, releaseFollow, pointerToAvatarAtViewport]);

  const onViewportPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && drag.moved) return; // it was a pan, not a click
    const rect = e.currentTarget.getBoundingClientRect();
    const id = pointerToAvatarAtViewport(e.clientX - rect.left, e.clientY - rect.top);
    if (id) selectAvatar(id);
  }, [pointerToAvatarAtViewport, selectAvatar]);

  const onViewportPointerLeave = useCallback(() => {
    if (!dragRef.current) setHoveredId(null);
  }, []);

  const selected = scene.avatars.find((a) => a.id === selectedId) ?? null;
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    document.addEventListener("keydown", onKey);
    // The page behind must not scroll while the floor is covering it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [fullscreen]);

  const roster = useMemo(
    () => [...scene.avatars].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    [scene.avatars],
  );
  const selectedRoom = selected ? roomByKey.get(restingRoomKey(selected, scene.events, nowMs)) : null;
  const selectedEvents = selected ? scene.events.filter((e) => e.avatarId === selected.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) : [];
  const selectedLastHeard = selected ? lastHeardMs.get(selected.id) : undefined;
  const selectedIsWorking = selected ? workingIds.has(selected.id) : false;

  /** Rows for the bottom cast strip. `emoteKindFor` is the single source of "is this thing
   *  actually doing something", and it re-checks `kind` itself — a human can never reach a status,
   *  which is the plan §3 rule (no comparable activity feed; a badge would be a surveillance
   *  claim). Absence of a status is therefore never rendered as "idle": it claims nothing. */
  const castMembers = useMemo<CastMember[]>(() => roster.map((a) => {
    const kind = emoteKindFor(a, workingIds, emoteKinds, nowMs);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      roomLabel: roomByKey.get(a.homeRoomKey)?.label ?? "—",
      status: kind
        ? {
            label: EMOTE_LABEL[kind],
            tone: kind === "approval_wait" ? "warning" as const
              : kind === "error" ? "danger" as const
              : "ok" as const,
          }
        : null,
    };
  }), [roster, workingIds, emoteKinds, nowMs, roomByKey]);

  return (
    <div className={`office${fullscreen ? " office--fullscreen" : ""}`}>
      <div className="office__toolbar">
        <span className="office__demo-badge" role="status">DEMO — not live</span>
        <p className="office__hint">
          One connected floor — real departments open onto real corridors. Who is shown, and any
          movement BETWEEN rooms, is DERIVED from real recorded handoffs — two people acting on one
          record. Movement WITHIN a room is just ambient background life and means nothing about the
          person. Never location tracking, nothing stored.
        </p>
        <div className="office__zoom" role="group" aria-label="Camera zoom">
          <button type="button" className="office__zoom-btn" onClick={() => stepZoom(-1)} disabled={scale <= ZOOM_LEVELS[0]} aria-label="Zoom out">−</button>
          <span className="office__zoom-level">{formatZoom(scale)}×</span>
          <button type="button" className="office__zoom-btn" onClick={() => stepZoom(1)} disabled={scale >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} aria-label="Zoom in">+</button>
          <button type="button" className={`office__zoom-fit${zoomPref === "fit" ? " office__zoom-fit--active" : ""}`} onClick={goToFit}>Fit</button>
        </div>
        {followingId && selected && (
          <div className="office__follow-chip">
            Following {selected.name}
            <button type="button" onClick={() => releaseFollow()}>Release</button>
          </div>
        )}
        {!followingId && followReleasedNotice && <span className="office__follow-notice">Follow released — camera moved</span>}
        <div aria-live="polite" className="office-sr-only">
          {followingId && selected ? `Following ${selected.name}.` : followReleasedNotice ? "Follow released." : ""}
        </div>
        <button
          type="button"
          className="office__fs-btn"
          onClick={() => setFullscreen((f) => !f)}
          aria-pressed={fullscreen}
          title={fullscreen ? "Leave fullscreen (Esc)" : "Expand the floor to fill the window"}
        >
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <button
          type="button"
          className="office__replay-btn"
          onClick={startReplay}
          disabled={replaying || scene.events.length === 0}
          title={scene.events.length === 0 ? "No recorded movement events for this company" : "Replay the recorded delegation events, walking the corridors"}
        >
          {replaying ? "Replaying…" : "Replay movement"}
        </button>
      </div>

      {floors.length > 1 && (
        <div className="office__floor-selector" role="tablist" aria-label="Floor">
          {floors.map((f, i) => (
            <button
              key={f.index}
              type="button"
              role="tab"
              aria-selected={i === selectedFloorIndex}
              className={`office__floor-btn${i === selectedFloorIndex ? " office__floor-btn--active" : ""}`}
              onClick={() => setSelectedFloorIndex(i)}
            >
              Floor {i + 1}{i === 0 ? " · Lobby" : ""}
            </button>
          ))}
        </div>
      )}

      <div className="office__body">
        <div
          ref={viewportRef}
          className="office__viewport"
          tabIndex={0}
          role="img"
          aria-label={`Office floor ${selectedFloorIndex + 1} plan, at ${formatZoom(scale)}× zoom${followingId && selected ? `, following ${selected.name}` : ""}. Drag or use the arrow keys to pan; scroll or the +/− buttons to zoom. Use the roster list below to browse avatars by keyboard.`}
          onPointerDown={onViewportPointerDown}
          onPointerMove={onViewportPointerMove}
          onPointerUp={onViewportPointerUp}
          onPointerLeave={onViewportPointerLeave}
          onKeyDown={onViewportKeyDown}
        >
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            style={{ width: cssW, height: cssH, transform: cssTransformForCamera(camera, viewportSize.w || cssW || 1, viewportSize.h || cssH || 1) }}
          />
        </div>

        <div className="office__side">
          <div className="office__tabs" role="tablist" aria-label="Office panels">
            {RAIL_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`office-tab-${t.key}`}
                aria-selected={railTab === t.key}
                aria-controls="office-rail-panel"
                className={`office__tab${railTab === t.key ? " office__tab--active" : ""}`}
                onClick={() => setRailTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div
            className="office__panel"
            role="tabpanel"
            id="office-rail-panel"
            aria-labelledby={`office-tab-${railTab}`}
          >
          {railTab === "legend" && (<>
          <div className="office__legend" aria-hidden="true">
            <div><span className="office__legend-swatch office__legend-swatch--human" /> Human — warm, by person</div>
            <div><span className="office__legend-swatch office__legend-swatch--agent" /> Internal agent — steel, synthetic</div>
            <div><span className="office__legend-swatch office__legend-swatch--automation" /> Automation — grey box, no face</div>
            <div><span className="office__legend-swatch office__legend-swatch--external" /> External agent — foreign shape + assurance</div>
          </div>

          <div className="office__legend office__legend-emotes" aria-hidden="true">
            <Eyebrow>Emote bubbles — working agents &amp; automations only</Eyebrow>
            {(Object.keys(EMOTE_LABEL) as AgentRunEventKind[]).map((k) => (
              <div key={k} className={`office__legend-emote${k === "approval_wait" ? " office__legend-emote--alert" : ""}`}>{EMOTE_LABEL[k]}</div>
            ))}
          </div>
          </>)}

          {railTab === "cast" && (
          <div className="office__roster" role="listbox" aria-label="Everyone on the floor">
            {roster.length === 0 && <p className="office__empty">No avatars for this company yet.</p>}
            {roster.map((a) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={a.id === selectedId}
                className={`office__roster-item${a.id === selectedId ? " office__roster-item--selected" : ""}`}
                onFocus={() => setHoveredId(a.id)}
                onBlur={() => setHoveredId((h) => (h === a.id ? null : h))}
                onMouseEnter={() => setHoveredId(a.id)}
                onMouseLeave={() => setHoveredId((h) => (h === a.id ? null : h))}
                onClick={() => selectAvatar(a.id)}
              >
                <span className="office__roster-kind">{KIND_LABEL[a.kind]}</span>
                <span className="office__roster-name">{a.name}</span>
                {(() => {
                  const kind = emoteKindFor(a, workingIds, emoteKinds, nowMs);
                  if (!kind) return null;
                  const cls = kind === "approval_wait" ? " office__roster-working--alert"
                    : kind === "error" ? " office__roster-working--error" : "";
                  return <span className={`office__roster-working${cls}`}>{EMOTE_LABEL[kind]}</span>;
                })()}
              </button>
            ))}
          </div>
          )}

          {railTab === "detail" && (
          <div className="office__detail" aria-live="polite">
            {!selected && <p className="office__empty">Select an avatar to see who or what it is, and the record it resolves to.</p>}
            {selected && (
              <>
                <Eyebrow>{KIND_LABEL[selected.kind]}</Eyebrow>
                <h3 className="office__detail-name">{selected.name}</h3>
                <dl className="office__detail-list">
                  <dt>Room</dt><dd>{selectedRoom ? `${selectedRoom.label} — Floor ${selectedRoom.floor + 1}` : "—"}</dd>
                  <dt>Record</dt>
                  <dd>
                    <code>{selected.recordKind}:{selected.recordId}</code>
                    {selected.recordHref && (
                      <>
                        {" — "}
                        <a href={selected.recordHref}>Open record →</a>
                      </>
                    )}
                  </dd>
                  <dt>What it is</dt><dd>{selected.recordLabel}</dd>
                  {selected.assurance && (
                    <>
                      <dt>Assurance</dt>
                      <dd className={`office__assurance office__assurance--${selected.assurance}`}>{ASSURANCE_LABEL[selected.assurance]}</dd>
                    </>
                  )}
                  {selected.activeRunId && (
                    <>
                      <dt>Activity</dt>
                      <dd>
                        {selectedIsWorking
                          ? `Working now (${EMOTE_LABEL[emoteKinds.get(selected.id) ?? "tool"]}) — real-time run events in the last minute.`
                          : selectedLastHeard != null
                            ? `Run open, quiet — last heard ${formatRelativeTime(selectedLastHeard, nowMs)}.`
                            : "Run open — no events observed yet."}
                      </dd>
                    </>
                  )}
                  {selected.kind === "automation" && selected.automationSignal && (
                    <>
                      <dt>Activity</dt>
                      <dd>
                        {AUTOMATION_STATE_LABEL[resolveAutomationState(selected.automationSignal, nowMs)]}
                        {selected.automationSignal.executionError ? ` (${selected.automationSignal.executionError})` : ""}
                      </dd>
                    </>
                  )}
                </dl>
                <p className="office__note">{selected.note}</p>
                {selectedEvents.length > 0 && (
                  <div className="office__events">
                    <Eyebrow>Recorded movement</Eyebrow>
                    <ul>
                      {selectedEvents.map((e) => (
                        <li key={e.id}>{e.reason} — <time dateTime={e.at}>{formatDateTime(e.at)}</time></li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {railTab === "activity" && (
          <div className="office__activity">
            {scene.events.length === 0 ? (
              /* Empty is a CLAIM here, so it says WHY rather than rendering a bare blank panel.
                 A snapshot and a tenant with no recorded handoffs both land here legitimately. */
              <p className="office__empty">
                No recorded movement for this company. Movement is derived from two people acting on
                one record — it is never location tracking — so an empty list means the ERP has
                logged no such handoff, not that nobody moved.
              </p>
            ) : (
              <ul className="office__activity-list">
                {scene.events.map((e) => {
                  const who = scene.avatars.find((a) => a.id === e.avatarId);
                  return (
                    <li key={e.id}>
                      <span className="office__activity-who">{who?.name ?? "Someone"}</span>
                      <span className="office__activity-reason">{e.reason}</span>
                      <time dateTime={e.at}>{formatDateTime(e.at)}</time>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          )}
          </div>
        </div>
      </div>

      <OfficeCastStrip
        members={castMembers}
        selectedId={selectedId}
        onSelect={selectAvatar}
        onHover={setHoveredId}
      />

      <p className="office__footnote">
        Generated {formatDateTime(scene.generatedAt)}. Character art is the Universal LPC
        Spritesheet Character Generator, used under its OGA-BY / CC0 licence terms —
        {" "}
        <a href="/office/credits">see the full credits</a>.
      </p>
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="type-eyebrow office__eyebrow">{children}</span>;
}
