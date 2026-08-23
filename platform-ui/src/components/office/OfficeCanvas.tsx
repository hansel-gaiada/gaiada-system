"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import {
  KIND_LABEL, ASSURANCE_LABEL, tilesToPx,
  roomTileRect, floorSizeTiles, deskSlotTile, roomCenterTile,
  restingRoomKey, buildReplaySteps, totalReplayMs, lerp, catToken,
  type OfficeScene, type OfficeRoom, type OfficeRoomKind, type OfficeAvatar, type ReplayStep,
} from "@/lib/office";
import {
  LAYER_PATHS, LAYER_ORDER, POSE_FRAME, FRAME_PX, LIGHT_RAMP, SKIN_RAMPS, STEEL_RAMP,
  spriteAssetPath, pickGender, pickSkinTone, hexToRgb,
  type SpriteGender, type SpritePose,
} from "@/lib/office-sprites";
import "./office.css";

// The Office canvas — hand-rolled Canvas 2D, no engine, no new dependency (platform-ui's four-dep
// discipline holds). REAL SPRITES: human and internal-agent avatars are composited from the 24
// licensed LPC sheets under public/office-sprites/ (see lib/office-sprites.ts for the layer
// contract and legal/asset-licences.md for the licence position). Automations stay the procedural
// grey box (LPC ships no robot) and external agents keep their procedural foreign silhouette —
// only human/agent kinds gained real art.
//
// The sprite swap DID land almost entirely inside `drawAvatar()`, as this file's previous header
// promised — layout, positions, hit-testing and interaction below are byte-for-byte what they were
// before. One thing that promise understated: a real asset must be FETCHED and DECODED before it
// can be drawn, which a procedural shape never needed. The "Sprite loading + compositing" block
// just above `drawAvatar()` is that plumbing — an image cache, a palette-swap cache, and a tiny
// pub/sub so a still-loading sprite's eventual arrival triggers exactly one extra redraw. It adds
// new module-level state and one new subscription effect on the component; it does not touch
// steadyPositions/replayPositions/pointerToAvatar or any other existing function's behaviour.
//
// Two render paths, both imperative (never a persistent requestAnimationFrame loop):
//   1. `draw()` — called on mount, on scene/theme/resize/selection change. One-shot.
//   2. The replay RAF loop — runs ONLY while a demo replay is playing, and is paused (not just
//      throttled) on `visibilitychange` and whenever the canvas leaves the viewport
//      (IntersectionObserver). This estate has had a busy loop pin a core at 46% CPU; a game loop
//      in a background tab is the same bug wearing a costume. There is no "ambient" motion for this
//      loop to drive in the first place — an avatar only moves from a real fixture event (plan §3).

interface TokenSet {
  page: string; card: string; raised: string; sunken: string;
  hairline: string; hairlineSoft: string; ink: string; ink60: string;
  accent: string; steel: string; grey: string; external: string;
  ok: string; warning: string; danger: string; fontBody: string;
  /** Resolves a principal id to its `--cat-N` colour, live from the token layer — never a literal,
   *  and never cached across a theme change (this closure re-reads on every draw() call). */
  catColor: (id: string) => string;
}

function readTokens(el: HTMLElement): TokenSet {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim() || "#888888";
  return {
    page: v("--surface-page"), card: v("--surface-card"), raised: v("--surface-raised"), sunken: v("--surface-sunken"),
    hairline: v("--erp-hairline"), hairlineSoft: v("--erp-hairline-soft"),
    ink: v("--ink-strong"), ink60: v("--erp-ink-60"),
    accent: v("--accent"), steel: v("--n-7"), grey: v("--n-8"), external: v("--accent-secondary"),
    ok: v("--status-ok"), warning: v("--status-warning"), danger: v("--status-danger"),
    fontBody: v("--font-body") || "sans-serif",
    catColor: (id: string) => v(catToken(id)),
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

/** Positions for avatars currently walking a replay step — placed at the room CENTRE (a meeting
 *  point, not a desk) while unsettled, and interpolated between room centres mid-transit. */
function replayPositions(scene: OfficeScene, roomByKey: Map<string, OfficeRoom>, steps: ReplayStep[], elapsedMs: number): Positioned[] {
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
      const a0 = roomCenterTile(fromRoom), a1 = roomCenterTile(toRoom);
      out.push({
        avatar, roomKey: t < 1 ? current.fromRoomKey : current.toRoomKey,
        tile: { x: lerp(a0.x, a1.x, t), y: lerp(a0.y, a1.y, t) },
        inTransit: t < 1, transitLabel: current.reason,
      });
    } else {
      out.push({ avatar, roomKey: current.toRoomKey, tile: roomCenterTile(toRoom), inTransit: false });
    }
  }
  return out;
}

// Room shell geometry — a real wall band with a doorway gap, not a stroked rectangle. Kept as
// module constants (not exported from lib/office.ts) because they are a RENDERING choice, not
// layout math another consumer needs; the desk grid still has to agree with deskSlotTile()'s own
// private DESK_COLS=3, called out at each use below.
const WALL_TILES = 0.4;
const DOOR_WIDTH_TILES = 1.8;
const DESK_COLS = 3; // mirrors office.ts's own (private) desk-grid width — must stay in lock-step
                      // with deskSlotTile() or a "vacant" desk would be drawn on top of an occupied one.

/** Tiled floor: a base fill plus a checkerboard wash at low alpha — reads as a real floor surface
 *  instead of one flat rectangle with gridlines. Clipped to the wall-inset interior so the wash
 *  never bleeds under the walls drawn over it. */
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
  ctx.fillStyle = tokens.hairlineSoft;
  ctx.globalAlpha = 0.4;
  const cols = Math.ceil(w / tile) + 1, rows = Math.ceil(h / tile) + 1;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if ((tx + ty) % 2 === 0) continue;
      ctx.fillRect(x + tx * tile, y + ty * tile, tile, tile);
    }
  }
  ctx.restore();
}

/** Real walls with thickness, and a doorway gap centred on the bottom edge. `unassigned` (plan
 *  §4.3: "no department binding exists") keeps its PRE-EXISTING dashed-outline honesty marker —
 *  it gets a thin dashed line instead of a solid wall band, never the load-bearing wall a bound
 *  room gets, so the claim "this room isn't real" survives the new rendering unchanged. */
function drawWalls(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }, tokens: TokenSet, isHovered: boolean, kind: OfficeRoomKind) {
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), w = tilesToPx(rect.w), h = tilesToPx(rect.h);
  const color = isHovered ? tokens.accent : tokens.ink60;

  if (kind === "unassigned") {
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
  const doorX0 = x + (w - doorW) / 2;
  const doorX1 = doorX0 + doorW;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, wall); // top
  ctx.fillRect(x, y, wall, h); // left
  ctx.fillRect(x + w - wall, y, wall, h); // right
  ctx.fillRect(x, y + h - wall, doorX0 - x, wall); // bottom, left of the doorway
  ctx.fillRect(doorX1, y + h - wall, x + w - doorX1, wall); // bottom, right of the doorway
  if (isHovered) {
    ctx.strokeStyle = tokens.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
}

/** A name plate mounted on the top wall, replacing the previous floating text — reads as signage
 *  rather than a label hovering over the floor. */
function drawNamePlate(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }, room: OfficeRoom, tokens: TokenSet) {
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), w = tilesToPx(rect.w);
  const plateW = Math.min(w - tilesToPx(1.2), tilesToPx(6.5));
  const plateH = tilesToPx(1.35);
  const px = x + (w - plateW) / 2;
  const py = y + tilesToPx(WALL_TILES) - 1;
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
 *  drawn with no avatar and an explicit "Vacant seat" caption. */
function vacantDeskSlots(occupantCount: number): number {
  if (occupantCount === 0) return DESK_COLS;
  const rem = occupantCount % DESK_COLS;
  return rem === 0 ? 0 : DESK_COLS - rem;
}

/** A desk + chair + monitor suggestion at one desk slot. Drawn in the FURNITURE pass, before any
 *  avatar — so an occupied desk's seated figure (drawn afterward, in the avatars pass) naturally
 *  occludes the chair's centre instead of floating over an empty tile. */
function drawDesk(ctx: CanvasRenderingContext2D, tile: { x: number; y: number }, tokens: TokenSet, occupied: boolean) {
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
  ctx.fillStyle = occupied ? tokens.ink60 : tokens.hairlineSoft;
  ctx.fillRect(cx - monW / 2, deskY - monH, monW, monH);
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

function drawAvatar(ctx: CanvasRenderingContext2D, pos: Positioned, tokens: TokenSet, isSelected: boolean, isHovered: boolean) {
  const cx = tilesToPx(pos.tile.x), cy = tilesToPx(pos.tile.y);
  const r = tilesToPx(0.62);
  const { avatar } = pos;
  drawContactShadow(ctx, cx, cy, r, tokens);
  // Desks sit DESK_SPACING_TILES apart; leave a little gutter so adjacent labels never touch.
  const slotWidthPx = tilesToPx(2.7);
  switch (avatar.kind) {
    case "human":
    case "agent": {
      // Kind taxonomy (plan §4.4): humans get a deterministic human skin ramp; internal agents
      // reuse the identical sprite under the fixed "steel" ramp so they read as synthetic without
      // ever being mistakable for a person. Sit is the default pose — an office is mostly people
      // at desks; walk is used only for the brief window a replay has this avatar in transit.
      const gender = pickGender(avatar.recordId);
      const pose: SpritePose = pos.inTransit ? "walk" : "sit";
      const toneKey: string = avatar.kind === "human" ? pickSkinTone(avatar.recordId) : "steel";
      const ramp: string[] = avatar.kind === "human" ? SKIN_RAMPS[pickSkinTone(avatar.recordId)] : STEEL_RAMP;
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
        drawHumanoid(ctx, cx, cy, r, avatar.kind === "human" ? tokens.catColor(avatar.recordId) : tokens.steel, tokens.ink, avatar.kind === "agent");
      }
      break;
    }
    case "automation":
      drawAutomation(ctx, cx, cy, r, tokens.grey, tokens.ink);
      break;
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
}

export function OfficeCanvas({ scene }: { scene: OfficeScene }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  // Stable "now" for the whole session — a demo snapshot, not a clock. Re-reading Date.now() per
  // render would make an avatar's resting room silently shift as fixture timestamps age past it.
  const [nowMs] = useState(() => Date.now());

  const roomByKey = useMemo(() => new Map(scene.rooms.map((r) => [r.key, r] as const)), [scene.rooms]);
  const floorSize = useMemo(() => floorSizeTiles(scene.rooms), [scene.rooms]);
  const cssW = tilesToPx(floorSize.w), cssH = tilesToPx(floorSize.h);

  const replayRef = useRef<{ steps: ReplayStep[]; startPerf: number; pausedAtPerf: number | null; total: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastPositionsRef = useRef<Positioned[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  hoveredIdRef.current = hoveredId;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const draw = useCallback((elapsedMs: number | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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

    // Pass 1 — floor + walls + nameplate for every room.
    for (const room of scene.rooms) {
      const rect = roomTileRect(room);
      drawFloor(ctx, rect, tokens, room.kind);
      drawWalls(ctx, rect, tokens, room.key === hoveredRoomKey, room.kind);
      drawNamePlate(ctx, rect, room, tokens);
    }

    // Pass 2 — furniture, keyed to who CANONICALLY rests in each room (ignoring any in-flight
    // replay animation) so desks never flicker empty/full while someone is mid-walk elsewhere —
    // the walking figure (pass 3) is drawn on top of its own still-occupied-looking desk during a
    // replay, which reads as "stepped away," not as a rendering glitch.
    const canonical = steadyPositions(scene, roomByKey, nowMs, new Set());
    const canonicalByRoom = new Map<string, Positioned[]>();
    for (const p of canonical) {
      if (!canonicalByRoom.has(p.roomKey)) canonicalByRoom.set(p.roomKey, []);
      canonicalByRoom.get(p.roomKey)!.push(p);
    }
    for (const room of scene.rooms) {
      const occupants = canonicalByRoom.get(room.key) ?? [];
      if (room.kind === "lobby") {
        drawLobbyChairs(ctx, room, tokens);
        for (const p of occupants) drawWaitingChair(ctx, p.tile, tokens);
        continue;
      }
      if (room.kind === "utility") drawServerRack(ctx, room, tokens);
      for (const p of occupants) drawDesk(ctx, p.tile, tokens, true);
      const vacant = vacantDeskSlots(occupants.length);
      for (let i = 0; i < vacant; i++) drawDesk(ctx, deskSlotTile(room, occupants.length + i), tokens, false);
    }

    // Pass 3 — the people/agents/automations themselves, always on top of their own furniture.
    const animatedIds = new Set(elapsedMs !== null && replayRef.current ? replayRef.current.steps.map((s) => s.avatarId) : []);
    const positions = [
      ...steadyPositions(scene, roomByKey, nowMs, animatedIds),
      ...(elapsedMs !== null && replayRef.current ? replayPositions(scene, roomByKey, replayRef.current.steps, elapsedMs) : []),
    ];
    lastPositionsRef.current = positions;
    for (const pos of positions) {
      drawAvatar(ctx, pos, tokens, pos.avatar.id === selectedIdRef.current, pos.avatar.id === hoveredIdRef.current);
    }
  }, [scene, roomByKey, nowMs, cssW, cssH]);

  // One-shot redraw on mount, scene change, resize, and theme flips (data-theme is an attribute
  // change, not a resize — MutationObserver is the only signal for it).
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

  // ── Replay: a RAF loop that exists ONLY while playing, paused (not merely throttled) when the
  // tab is hidden or the canvas leaves the viewport. Nothing runs at all otherwise. ──────────────
  const pausedByVisibility = useRef(false);
  const pausedByOffscreen = useRef(false);

  const tick = useCallback(() => {
    const r = replayRef.current;
    if (!r) return;
    if (pausedByVisibility.current || pausedByOffscreen.current) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const elapsed = performance.now() - r.startPerf;
    draw(elapsed);
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

  const pointerToAvatar = useCallback((clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let best: { id: string; d2: number } | null = null;
    for (const pos of lastPositionsRef.current) {
      const cx = tilesToPx(pos.tile.x), cy = tilesToPx(pos.tile.y);
      const d2 = (cx - x) ** 2 + (cy - y) ** 2;
      const hitR = tilesToPx(1.1);
      if (d2 <= hitR * hitR && (!best || d2 < best.d2)) best = { id: pos.avatar.id, d2 };
    }
    return best?.id ?? null;
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const id = pointerToAvatar(e.clientX, e.clientY);
    if (id !== hoveredIdRef.current) setHoveredId(id);
  }, [pointerToAvatar]);

  const onClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const id = pointerToAvatar(e.clientX, e.clientY);
    if (id) setSelectedId(id);
  }, [pointerToAvatar]);

  const selected = scene.avatars.find((a) => a.id === selectedId) ?? null;
  const roster = useMemo(
    () => [...scene.avatars].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    [scene.avatars],
  );
  const selectedRoomLabel = selected ? roomByKey.get(restingRoomKey(selected, scene.events, nowMs))?.label : null;
  const selectedEvents = selected ? scene.events.filter((e) => e.avatarId === selected.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) : [];

  return (
    <div className="office">
      <div className="office__toolbar">
        <span className="office__demo-badge" role="status">DEMO — not live</span>
        <p className="office__hint">
          Rooms are real (this company&apos;s departments). Who is shown and any movement is fixture data —
          there is no live presence feed yet. Nothing here is tracked or stored.
        </p>
        <button
          type="button"
          className="office__replay-btn"
          onClick={startReplay}
          disabled={replaying || scene.events.length === 0}
          title={scene.events.length === 0 ? "No recorded movement events for this company" : "Replay the recorded delegation events"}
        >
          {replaying ? "Replaying…" : "Replay movement"}
        </button>
      </div>

      <div className="office__body">
        <div className="office__canvas-wrap" style={{ width: cssW, height: cssH }}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Office floor plan. Use the roster list to browse avatars by keyboard."
            style={{ width: cssW, height: cssH }}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setHoveredId(null)}
            onClick={onClick}
          />
        </div>

        <div className="office__side">
          <div className="office__legend" aria-hidden="true">
            <div><span className="office__legend-swatch office__legend-swatch--human" /> Human — warm, by person</div>
            <div><span className="office__legend-swatch office__legend-swatch--agent" /> Internal agent — steel, synthetic</div>
            <div><span className="office__legend-swatch office__legend-swatch--automation" /> Automation — grey box, no face</div>
            <div><span className="office__legend-swatch office__legend-swatch--external" /> External agent — foreign shape + assurance</div>
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
                onClick={() => setSelectedId(a.id)}
              >
                <span className="office__roster-kind">{KIND_LABEL[a.kind]}</span>
                <span className="office__roster-name">{a.name}</span>
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
                  <dt>Room</dt><dd>{selectedRoomLabel ?? "—"}</dd>
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
