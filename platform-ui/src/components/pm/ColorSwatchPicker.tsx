"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
// Shared 8-swatch color popover (P2-02, design spec §6 — reused verbatim by
// the custom-status editor, P2-05). Client-safe: imports only lib/tagColors
// (never lib/pm, which is "server-only"). Fully keyboard-operable: the
// trigger is a real <button>, the popover is a `role="listbox"` of
// `role="option"` buttons, arrow keys move focus across the grid, Enter/Space
// picks (native button activation), Escape closes and returns focus to the
// trigger — same open/close/focus-return contract as Board's own `Popover`.
import { TAG_COLORS, TAG_COLOR_HEX, TAG_COLOR_LABEL, type TagColor } from "@/lib/tagColors";
import "./pm.css";

interface Props {
  value: TagColor;
  onChange: (color: TagColor) => void;
  label?: string; // accessible name for the trigger + popover, e.g. "Tag color"
}

export function ColorSwatchPicker({ value, onChange, label = "Color" }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node) && e.target !== triggerRef.current) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    popRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function moveFocus(idx: number, delta: number) {
    const opts = popRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    if (!opts || opts.length === 0) return;
    const next = (idx + delta + opts.length) % opts.length;
    opts[next]?.focus();
  }

  function pick(c: TagColor) {
    onChange(c);
    setOpen(false);
    triggerRef.current?.focus();
  }

  const dotStyle = (c: TagColor): CSSProperties & Record<string, string> => ({ "--pm-swatch-hex": TAG_COLOR_HEX[c].onDark });

  return (
    <span className="pm-swatch-wrap">
      <button
        type="button"
        ref={triggerRef}
        className="pm-swatch-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${TAG_COLOR_LABEL[value]}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pm-swatch-trigger__dot" style={dotStyle(value)} />
      </button>
      {open && (
        <div ref={popRef} role="listbox" aria-label={label} className="pm-swatch-pop">
          {TAG_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={c === value}
              className={`pm-swatch${c === value ? " pm-swatch--active" : ""}`}
              title={TAG_COLOR_LABEL[c]}
              onClick={() => pick(c)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); moveFocus(i, 1); }
                if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); moveFocus(i, -1); }
              }}
            >
              <span className="pm-swatch__dot" style={dotStyle(c)} />
              <span className="pm-sr-only">{TAG_COLOR_LABEL[c]}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
