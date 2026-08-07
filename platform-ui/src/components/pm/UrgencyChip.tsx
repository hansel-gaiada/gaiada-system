import type { UrgencyTier } from "@/lib/pmUrgency";
import { URGENCY_LABEL } from "@/lib/pmUrgency";
import { PM_TERMS } from "@/lib/pmVocabulary";
import "./pm.css";      // the folder sheet — carries the shared `.pm-sr-only` helper
import "./urgency.css";

// Urgency indicator (P4-G3) — the "overdue · almost late · in time" affordance the owner asked for,
// rendered identically everywhere: board card, List row, Gantt label, Home columns, project card.
//
// NOT a client component and deliberately hook-free, so both server pages and the existing client
// components (Board, Gantt) can render it without a second variant.
//
// NEVER COLOUR-ONLY. Each tier carries a distinct SHAPE as well as a distinct hue, because the whole
// point is glanceability across many projects and a colour-blind or greyscale reader has to reach the
// same reading. Shape, not just hue, is also what survives being 10px tall in a dense list:
//   overdue   → filled triangle (the only pointed shape)
//   due-soon  → circle with a clock hand
//   on-track  → check mark
// Inline SVG rather than an emoji/dingbat (Repsona uses a skull glyph): ☠ and friends render at
// wildly different weights and baselines across platforms, and several fall back to a tofu box.
//
// `done` and `undated` render NOTHING in dot mode and a muted label in chip mode. A finished task
// must not glow on a board however late it ran, and "no due date" is not a warning — badging either
// one turns the indicator into noise and people stop reading it.

const GLYPH: Record<UrgencyTier, React.ReactNode> = {
  overdue: <path d="M5 0.5 9.5 9H0.5z" />,
  "due-soon": (
    <>
      <circle cx="5" cy="5" r="4.2" fill="none" strokeWidth="1.4" />
      <path d="M5 2.6V5.2l1.9 1.2" fill="none" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  "on-track": <path d="M1.2 5.4 4 8.2 8.8 2.4" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  done: null,
  undated: null,
};

// The owner's wording, not the code-side tier names: "Almost late", never "Due soon".
const TEXT: Record<UrgencyTier, string> = {
  overdue: PM_TERMS.overdue,
  "due-soon": PM_TERMS.almostLate,
  "on-track": PM_TERMS.inTime,
  done: URGENCY_LABEL.done,
  undated: URGENCY_LABEL.undated,
};

interface UrgencyChipProps {
  tier: UrgencyTier;
  /** `dot` for dense rows (icon only, tooltip + screen-reader label); `chip` adds the visible word. */
  variant?: "dot" | "chip";
  /** Roll-up count, e.g. "3 Overdue" on a project card (P4-G2). */
  count?: number;
  /** Appended to the accessible label — e.g. a due date — so a dot is never a bare colour to AT. */
  detail?: string;
}

export function UrgencyChip({ tier, variant = "dot", count, detail }: UrgencyChipProps) {
  const glyph = GLYPH[tier];
  // Nothing to say: no shape for this tier and no label being asked for.
  if (!glyph && variant === "dot") return null;

  const word = TEXT[tier];
  const label = [count !== undefined ? `${count} ${word.toLowerCase()}` : word, detail].filter(Boolean).join(" · ");

  return (
    <span className={`pm-urg pm-urg--${tier} pm-urg--${variant}`} title={label}>
      {glyph && (
        <svg className="pm-urg__icon" viewBox="0 0 10 10" aria-hidden focusable="false">
          {glyph}
        </svg>
      )}
      {variant === "chip" && <span className="pm-urg__text">{count !== undefined ? `${count} ${word}` : word}</span>}
      {/* The dot's only accessible name. Without this a dot is pure colour to a screen reader —
          `title` is not reliably announced, so it cannot be the sole carrier. */}
      {variant === "dot" && <span className="pm-sr-only">{label}</span>}
    </span>
  );
}
