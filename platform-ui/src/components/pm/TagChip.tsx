import type { CSSProperties } from "react";
// Client-safe by design (imports only lib/tagColors, never lib/pm — pm.ts is
// "server-only" and this chip is rendered from client components too, e.g.
// the task-detail tag picker and the board card). One `.pm-tag` class carries
// the tone as two per-instance CSS vars (`--pm-tag-onlight`/`--pm-tag-ondark`)
// so pm.css alone decides which one wins depending on ambient context
// (plain card vs. `.lux-card--dark`) — see tagColors.ts for the AA
// verification of every tone against both surfaces (P2-02, design spec §6/§9).
import { TAG_COLOR_HEX, type TagColor } from "@/lib/tagColors";
import "./pm.css";

interface Props {
  label: string;
  color: TagColor;
  // Toggled-ON state for the task-detail picker (design spec §6): an opaque
  // fill using the tone's `onDark` hex + a fixed ink text color, so the
  // "selected" state reads correctly no matter which surface the picker
  // itself sits on (it's a fill, not text-on-card).
  selected?: boolean;
  className?: string;
}

export function TagChip({ label, color, selected = false, className }: Props) {
  const hex = TAG_COLOR_HEX[color];
  const style: CSSProperties & Record<string, string> = {
    "--pm-tag-onlight": hex.onLight,
    "--pm-tag-ondark": hex.onDark,
  };
  return (
    <span className={`pm-tag${selected ? " pm-tag--selected" : ""}${className ? ` ${className}` : ""}`} style={style}>
      {label}
    </span>
  );
}
