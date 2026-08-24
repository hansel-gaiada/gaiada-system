"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
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
  ZOOM_LEVELS, fitZoomLevel, clampCamera, zoomCameraAtPoint, cssTransformForCamera, viewportToContentPoint,
  resolveAutomationState, automationColorToken, AUTOMATION_GREY_TOKEN, AUTOMATION_STATE_LABEL,
  type OfficeScene, type OfficeRoom, type OfficeRoomKind, type OfficeFloor, type OfficeAvatar, type ReplayStep,
  type Camera, type ZoomLevel, type AutomationActivityState,
} from "@/lib/office";
import {
  LAYER_PATHS, LAYER_ORDER, POSE_FRAME, FRAME_PX, LIGHT_RAMP, SKIN_RAMPS,
  spriteAssetPath, pickGender, pickSkinTone, hexToRgb,
  type SpriteGender, type SpritePose,
} from "@/lib/office-sprites";
import {
  CHAR_PX, CHAR_DRAW_SCALE, agentSpritePath, automationSpritePath, activeBobPx,
} from "@/lib/officeChars";
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

/** Groups avatars into their CURRENT room (steady-state) and assigns each a stable desk slot —
 *  recomputed from the group's own order rather than trusting `avatar.deskIndex` in isolation, so
 *  an avatar that moved into a room it wasn't seeded in never overlaps a real occupant. */
function steadyPositions(scene: OfficeScene, roomByKey: Map<string, OfficeRoom>, nowMs: number, exclude: Set<string>): Positioned[] {
  const restRoomOf = new Map<string, string>();
  for (const a of scene.avatars) restRoomOf.set(a.id, restingRoomKey(a, scene.events, nowMs));
  const groups = new Map<string, string[]>();
  for (const a of scene.avatars) {
    if (exclude.has(a.id)) continue;
    const rk = restRoomOf.get(a.id) ?? a.homeRoomKey;
    if (!groups.has(rk)) groups.set(rk, []);
    groups.get(rk)!.push(a.id);
  }
  const out: Positioned[] = [];
  for (const a of scene.avatars) {
    if (exclude.has(a.id)) continue;
    const rk = restRoomOf.get(a.id) ?? a.homeRoomKey;
    const room = roomByKey.get(rk) ?? roomByKey.get(a.homeRoomKey);
    if (!room) continue;
    const idx = groups.get(rk)!.indexOf(a.id);
    out.push({ avatar: a, roomKey: rk, tile: deskSlotTile(room, idx), inTransit: false });
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

/** Real walls with thickness, and a doorway gap on the wall that faces the corridor — the SOUTH
 *  (bottom) wall for a "north"-side room, the NORTH (top) wall for a "south"-side room. This is
 *  the one piece of rendering that had to change shape entirely for the corridor model: a room's
 *  door is no longer "always the bottom wall", it's whichever wall genuinely touches circulation
 *  space. `unassigned` (plan §4.3: "no department binding exists") keeps its dashed-outline
 *  honesty marker instead of a load-bearing wall. */
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
  ctx.fillStyle = color;
  ctx.fillRect(x, y, wall, h); // left
  ctx.fillRect(x + w - wall, y, wall, h); // right
  if (corridorWallIsBottom) {
    ctx.fillRect(x, y, w, wall); // top — solid, away from the corridor
    ctx.fillRect(x, y + h - wall, doorX0 - x, wall); // bottom, left of the doorway
    ctx.fillRect(doorX1, y + h - wall, x + w - doorX1, wall); // bottom, right of the doorway
  } else {
    ctx.fillRect(x, y + h - wall, w, wall); // bottom — solid, away from the corridor
    ctx.fillRect(x, y, doorX0 - x, wall); // top, left of the doorway
    ctx.fillRect(doorX1, y, x + w - doorX1, wall); // top, right of the doorway
  }
  if (isHovered) {
    ctx.strokeStyle = tokens.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
}

/** A name plate mounted on the wall AWAY from the corridor (the room's "front of house" wall,
 *  opposite its own doorway) so it never collides with the doorway gap `drawWalls` just cut. */
function drawNamePlate(ctx: CanvasRenderingContext2D, room: OfficeRoom, tokens: TokenSet) {
  const rect = roomTileRect(room);
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), w = tilesToPx(rect.w), h = tilesToPx(rect.h);
  const plateW = Math.min(w - tilesToPx(1.2), tilesToPx(6.5));
  const plateH = tilesToPx(1.35);
  const px = x + (w - plateW) / 2;
  const onTop = room.side === "north"; // door is on the bottom, so the nameplate sits up top
  const py = onTop ? y + tilesToPx(WALL_TILES) - 1 : y + h - tilesToPx(WALL_TILES) - plateH + 1;
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

function drawDesk(ctx: CanvasRenderingContext2D, tile: { x: number; y: number }, tokens: TokenSet, occupied: boolean, activity: DeskActivity = "none", pulseOn = false) {
  const cx = tilesToPx(tile.x), cy = tilesToPx(tile.y);
  const r = tilesToPx(0.62);
  ctx.fillStyle = tokens.hairlineSoft;
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.55, r * 1.05, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  const deskW = tilesToPx(1.9), deskH = tilesToPx(0.55);
  const deskY = cy - r * 2.0 - deskH;
  ctx.fillStyle = tokens.raised;
  ctx.fillRect(cx - deskW / 2, deskY, deskW, deskH);
  ctx.strokeStyle = tokens.hairline;
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - deskW / 2 + 0.5, deskY + 0.5, deskW - 1, deskH - 1);
  const monW = tilesToPx(0.55), monH = tilesToPx(0.36);
  ctx.save();
  if (activity === "working") {
    ctx.fillStyle = tokens.accent;
    ctx.globalAlpha = pulseOn ? 1 : 0.5;
  } else if (activity === "quiet") {
    ctx.fillStyle = tokens.warning;
    ctx.globalAlpha = 0.85;
  } else if (activity === "failed") {
    ctx.fillStyle = tokens.danger;
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = occupied ? tokens.ink60 : tokens.hairlineSoft;
  }
  ctx.fillRect(cx - monW / 2, deskY - monH, monW, monH);
  ctx.restore();
  if (!occupied) {
    ctx.fillStyle = tokens.ink60;
    ctx.font = `italic 400 ${Math.round(tilesToPx(0.42))}px ${tokens.fontBody}`;
    ctx.textAlign = "center";
    ctx.fillText("Vacant seat", cx, cy + r * 1.6);
    ctx.textAlign = "left";
  }
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
 *  (plan §4.4a's layer order). Built once per (gender, pose, tone key) and cached from then on.
 *  Returns null until every layer image for this gender/pose has finished loading. */
function getComposedSprite(gender: SpriteGender, pose: SpritePose, toneKey: string, ramp: string[]): HTMLCanvasElement | null {
  const cacheKey = `${gender}:${pose}:${toneKey}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  const layers = LAYER_PATHS[gender];
  const frame = POSE_FRAME[pose];
  const frames: HTMLCanvasElement[] = [];
  for (const { key, recolorable } of LAYER_ORDER) {
    const variant = layers[key];
    const src = spriteAssetPath(variant, pose);
    const img = getRawImage(src);
    if (!img) return null; // any missing layer stalls the whole composite — never a partial figure
    frames.push(recolorFrame(img, frame, recolorable ? ramp : null, `${src}:${recolorable ? toneKey : "raw"}`));
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
  scale: ZoomLevel, emoteKind: AgentRunEventKind | null, pulseOn: boolean,
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
        const bob = activeBobPx(emoteKind !== null, pulseOn);
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
      const gender = pickGender(avatar.recordId);
      const pose: SpritePose = pos.inTransit ? "walk" : "sit";
      const toneKey: string = pickSkinTone(avatar.recordId);
      const ramp: string[] = SKIN_RAMPS[pickSkinTone(avatar.recordId)];
      const sprite = getComposedSprite(gender, pose, toneKey, ramp);
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
  if (pos.inTransit && pos.transitLabel) {
    ctx.fillStyle = tokens.ink60;
    ctx.font = `italic 400 ${Math.round(tilesToPx(0.5))}px ${tokens.fontBody}`;
    ctx.textAlign = "center";
    ctx.fillText(pos.transitLabel, cx, cy - r * 2.6, tilesToPx(6));
    ctx.textAlign = "left";
  }
  // The emote bubble (req #2) sits ABOVE the transit label's own y (r*2.6 up) so the rare overlap
  // of "in transit" + "genuinely working" never collides. `emoteKind` is null for every avatar
  // except a genuinely-working `agent` with a real event kind — see the Pass 3 call site for the
  // two-layer guarantee that a human never reaches this branch.
  if (emoteKind) drawEmoteBubble(ctx, cx, cy - r * 3.6, emoteKind, tokens, pulseOn);
}

const WORKING_POLL_MS = 8000;
const PULSE_TICK_MS = 450;

export function OfficeCanvas({ scene, initialZoom }: { scene: OfficeScene; initialZoom: OfficeZoom }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
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
  const [, startZoomTransition] = useTransition();
  const followReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ startVX: number; startVY: number; startCenter: { x: number; y: number }; moved: boolean } | null>(null);

  const scale = useMemo<ZoomLevel>(() => {
    const vw = viewportSize.w || cssW || 1, vh = viewportSize.h || cssH || 1;
    return zoomPref === "fit" ? fitZoomLevel(cssW, cssH, vw, vh) : zoomPref;
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
    const idx = ZOOM_LEVELS.indexOf(scaleRef.current);
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
      const idx = ZOOM_LEVELS.indexOf(scaleRef.current);
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
        drawPlant(ctx, tilesToPx(room.x + room.wTiles - 0.9), tilesToPx(backY), tokens);
      }
      for (const p of occupants) {
        const activity = deskActivityFor(p.avatar, workingIds, nowMs);
        drawDesk(ctx, p.tile, tokens, true, activity, pulseOnRef.current);
      }
      const vacant = vacantDeskSlots(occupants.length, room.deskCols);
      for (let i = 0; i < vacant; i++) drawDesk(ctx, deskSlotTile(room, occupants.length + i), tokens, false);
    }

    // Pass 3 — the people/agents/automations themselves, always on top of their own furniture.
    const animatedIds = new Set(elapsedMs !== null && replayRef.current ? replayRef.current.steps.map((s) => s.avatarId) : []);
    const positions = [
      ...steadyPositions(scene, roomByKey, nowMs, animatedIds),
      ...(elapsedMs !== null && replayRef.current ? replayPositions(scene, roomByKey, replayRef.current.steps, elapsedMs, getPath) : []),
    ].filter((p) => floorRoomKeys.has(p.roomKey));
    lastPositionsRef.current = positions;
    for (const pos of positions) {
      // Two independent layers keep an emote bubble off a human, not one: office-data.ts only ever
      // sets `activeRunId`/`automationSignal` on an `agent`/`automation`-kind avatar respectively
      // (humans have no comparable activity feed — see that file's own doc comment), AND
      // `emoteKindFor` re-checks `kind` itself rather than trusting either field alone. `workingIds`
      // is the same 45s-freshness gate the desk monitor tint already uses for agents; automations
      // resolve their own freshness inside `resolveAutomationState` using that identical window.
      const emoteKind = emoteKindFor(pos.avatar, workingIds, emoteKinds, nowMs);
      drawAvatar(ctx, pos, tokens, pos.avatar.id === selectedIdRef.current, pos.avatar.id === hoveredIdRef.current, scale, emoteKind, pulseOnRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, roomByKey, nowMs, cssW, cssH, floor, floorRoomKeys, getPath, workingIds, scale, emoteKinds]);

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
  const roster = useMemo(
    () => [...scene.avatars].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    [scene.avatars],
  );
  const selectedRoom = selected ? roomByKey.get(restingRoomKey(selected, scene.events, nowMs)) : null;
  const selectedEvents = selected ? scene.events.filter((e) => e.avatarId === selected.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) : [];
  const selectedLastHeard = selected ? lastHeardMs.get(selected.id) : undefined;
  const selectedIsWorking = selected ? workingIds.has(selected.id) : false;

  return (
    <div className="office">
      <div className="office__toolbar">
        <span className="office__demo-badge" role="status">DEMO — not live</span>
        <p className="office__hint">
          One connected floor — real departments open onto real corridors. Who is shown and any
          movement is fixture data; there is no live presence feed yet. Nothing here is tracked or stored.
        </p>
        <div className="office__zoom" role="group" aria-label="Camera zoom">
          <button type="button" className="office__zoom-btn" onClick={() => stepZoom(-1)} disabled={scale === ZOOM_LEVELS[0]} aria-label="Zoom out">−</button>
          <span className="office__zoom-level">{scale}×</span>
          <button type="button" className="office__zoom-btn" onClick={() => stepZoom(1)} disabled={scale === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} aria-label="Zoom in">+</button>
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
          aria-label={`Office floor ${selectedFloorIndex + 1} plan, at ${scale}× zoom${followingId && selected ? `, following ${selected.name}` : ""}. Drag or use the arrow keys to pan; scroll or the +/− buttons to zoom. Use the roster list below to browse avatars by keyboard.`}
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
        </div>
      </div>

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
