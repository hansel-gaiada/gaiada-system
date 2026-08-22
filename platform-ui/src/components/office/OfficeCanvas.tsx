"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import {
  KIND_LABEL, ASSURANCE_LABEL, tilesToPx,
  roomTileRect, floorSizeTiles, deskSlotTile, roomCenterTile,
  restingRoomKey, buildReplaySteps, totalReplayMs, lerp, catToken,
  type OfficeScene, type OfficeRoom, type OfficeAvatar, type ReplayStep,
} from "@/lib/office";
import "./office.css";

// The Office canvas — hand-rolled Canvas 2D, no engine, no new dependency (platform-ui's four-dep
// discipline holds). NO SPRITES: every avatar is drawn procedurally from shape + a design token,
// per legal/asset-licences.md ("no third-party art committed tonight"). Swapping in real sprites
// later touches only `drawAvatar()` below — every other function (layout, positions, interaction)
// is already the interface a sprite renderer would need.
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

function drawRoom(ctx: CanvasRenderingContext2D, room: OfficeRoom, tokens: TokenSet, isHovered: boolean) {
  const rect = roomTileRect(room);
  const x = tilesToPx(rect.x), y = tilesToPx(rect.y), w = tilesToPx(rect.w), h = tilesToPx(rect.h);
  ctx.fillStyle = room.kind === "lobby" ? tokens.raised : room.kind === "department" ? tokens.card : tokens.sunken;
  ctx.fillRect(x, y, w, h);
  // A faint tile grid inside the room — reads as a tile map even with no sprites on it yet.
  ctx.strokeStyle = tokens.hairlineSoft;
  ctx.lineWidth = 1;
  const tilePx = tilesToPx(1);
  for (let tx = 1; tx < rect.w; tx++) { ctx.beginPath(); ctx.moveTo(x + tx * tilePx, y); ctx.lineTo(x + tx * tilePx, y + h); ctx.stroke(); }
  for (let ty = 1; ty < rect.h; ty++) { ctx.beginPath(); ctx.moveTo(x, y + ty * tilePx); ctx.lineTo(x + w, y + ty * tilePx); ctx.stroke(); }
  ctx.strokeStyle = isHovered ? tokens.accent : tokens.hairline;
  ctx.lineWidth = isHovered ? 2 : 1;
  if (room.kind === "unassigned") ctx.setLineDash([6, 4]); else ctx.setLineDash([]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = tokens.ink;
  ctx.font = `700 ${Math.round(tilesToPx(0.85))}px ${tokens.fontBody}`;
  ctx.textBaseline = "top";
  ctx.fillText(room.label, x + 6, y + 4);
  ctx.fillStyle = tokens.ink60;
  ctx.font = `400 ${Math.round(tilesToPx(0.6))}px ${tokens.fontBody}`;
  ctx.fillText(room.boundTo, x + 6, y + tilesToPx(1) + 2, w - 12);
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

function drawAvatar(ctx: CanvasRenderingContext2D, pos: Positioned, tokens: TokenSet, isSelected: boolean, isHovered: boolean) {
  const cx = tilesToPx(pos.tile.x), cy = tilesToPx(pos.tile.y);
  const r = tilesToPx(0.62);
  const { avatar } = pos;
  // Desks sit DESK_SPACING_TILES apart; leave a little gutter so adjacent labels never touch.
  const slotWidthPx = tilesToPx(2.7);
  switch (avatar.kind) {
    case "human":
      drawHumanoid(ctx, cx, cy, r, tokens.catColor(avatar.recordId), tokens.ink, false);
      break;
    case "agent":
      drawHumanoid(ctx, cx, cy, r, tokens.steel, tokens.ink, true);
      break;
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
    for (const room of scene.rooms) drawRoom(ctx, room, tokens, room.key === hoveredRoomKey);

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
        Generated {formatDateTime(scene.generatedAt)}. Sprites drop in later behind this same
        interface (kind + position) — nothing here is a rendering dead end.
      </p>
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="type-eyebrow office__eyebrow">{children}</span>;
}
