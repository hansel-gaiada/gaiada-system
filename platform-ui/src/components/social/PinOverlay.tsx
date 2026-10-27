"use client";
// SCP-1l (BFF §63.8) — numbered pins drawn over a post's image, with a place-a-pin mode. Used by the post page (SCP-1e,
// staff: every comment's pin) and by the portal (SCP-2, client: only the client-visible comments' pins).
//
// A pin is an anchor `{x, y, fileId}`: x and y are fractions of the image (0 to 1), so a pin stays on the same spot at any
// rendered size. The number on a pin is its place among ALL the anchored comments of the post (`pinsFromComments`), so the
// thread's "Pin 2" label and the pin on the image agree; this overlay draws only the pins of the file it shows.
//
// Keyboard: every pin is a button with a label. Place mode is a focusable surface: the mouse places where it clicks; from
// the keyboard the arrow keys move a marker (Shift: a finer step) and Enter or Space places it; Escape cancels.
// Tokens only (pin.css), no colour literal and no uppercase transform.
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Comment, CommentAnchor } from "@/lib/pm";
import "./comment-pins.css";

export interface Pin {
  /** The comment this pin belongs to. */
  id: string;
  /** Its number: the place among the post's anchored comments, from 1. */
  n: number;
  anchor: CommentAnchor;
  /** A few words for the pin's accessible name (the comment's start). */
  label?: string;
}

/** PURE. The post's anchored comments as numbered pins, in thread order (the order `comments` arrives in). */
export function pinsFromComments(comments: ReadonlyArray<Pick<Comment, "id" | "body" | "anchor">>): Pin[] {
  const out: Pin[] = [];
  for (const c of comments) {
    if (!c.anchor) continue;
    out.push({ id: c.id, n: out.length + 1, anchor: c.anchor, label: c.body.length > 60 ? `${c.body.slice(0, 57)}…` : c.body });
  }
  return out;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const STEP = 0.05;
const FINE_STEP = 0.01;

export interface PinOverlayProps {
  /** The image, and the file it is (a pin sits on a file: `anchor.fileId`). */
  src: string;
  alt: string;
  fileId: string;
  pins: ReadonlyArray<Pin>;
  /** Place mode: a click (or Enter at the marker) answers `onPlace` with the new anchor. */
  placing?: boolean;
  onPlace?: (anchor: CommentAnchor) => void;
  /** Escape in place mode. */
  onCancelPlace?: () => void;
  /** A click on a pin: the page scrolls to or opens its comment. */
  onSelectPin?: (pin: Pin) => void;
  selectedId?: string | null;
  /** The image's loading hint. The portal's grids and lists pass "lazy" (SCP-2); the post page keeps the browser's default. */
  loading?: "lazy" | "eager";
}

export function PinOverlay({ src, alt, fileId, pins, placing = false, onPlace, onCancelPlace, onSelectPin, selectedId = null, loading }: PinOverlayProps) {
  const [marker, setMarker] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const shown = pins.filter((p) => p.anchor.fileId === fileId);

  function place(x: number, y: number) {
    onPlace?.({ x: clamp01(x), y: clamp01(y), fileId });
  }

  function onSurfaceClick(e: MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    // A keyboard-synthesised click has no pointer position (detail 0): the marker is the answer then.
    if (e.detail === 0 || r.width === 0 || r.height === 0) { place(marker.x, marker.y); return; }
    place((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }

  function onSurfaceKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? FINE_STEP : STEP;
    const move = (dx: number, dy: number) => { e.preventDefault(); setMarker((m) => ({ x: clamp01(m.x + dx), y: clamp01(m.y + dy) })); };
    if (e.key === "ArrowLeft") move(-step, 0);
    else if (e.key === "ArrowRight") move(step, 0);
    else if (e.key === "ArrowUp") move(0, -step);
    else if (e.key === "ArrowDown") move(0, step);
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); place(marker.x, marker.y); }
    // stopPropagation: inside a dialog (the portal's "Ask for changes"), Escape cancels the pin and does not also close the dialog.
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancelPlace?.(); }
  }

  return (
    <div className="scp-pinbox">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="scp-pinbox__img" src={src} alt={alt} loading={loading} />
      {shown.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`scp-pin${selectedId === p.id ? " scp-pin--selected" : ""}`}
          style={{ left: `${p.anchor.x * 100}%`, top: `${p.anchor.y * 100}%` }}
          aria-label={p.label ? `Pin ${p.n}: ${p.label}` : `Pin ${p.n}`}
          aria-pressed={selectedId === p.id}
          onClick={() => onSelectPin?.(p)}
        >
          {p.n}
        </button>
      ))}
      {placing && (
        <div
          className="scp-pinbox__place"
          role="button"
          tabIndex={0}
          aria-label="Place a pin on the image. Click where it goes, or use the arrow keys to move the marker and Enter to place it. Escape cancels."
          onClick={onSurfaceClick}
          onKeyDown={onSurfaceKey}
        >
          <span className="scp-pin scp-pin--marker" style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
