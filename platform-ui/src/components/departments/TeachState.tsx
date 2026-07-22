import Link from "next/link";

// Shared "teach" empty-state — used inside every dept-console component (KpiStrip's
// zero-project state, ActivityFeed with no events yet, MyWorkRail with nothing
// waiting, LauncherRow with no tools configured). Distinct from the plain
// `EmptyNote` (systems/EmptyNote.tsx): EmptyNote is one quiet caption line for
// "connected but empty"; TeachState is the warmer "here's what to do about it"
// moment for a first-run department — glyph + one-line title + one-line body +
// an optional CTA that sends the person to go fix it (usually the Connections tab).
// Dept-agnostic: everything is a prop, this file has zero fetching.
export interface TeachStateProps {
  /** Single glyph or short monogram, e.g. "＋", "⎇", "◐". Decorative — aria-hidden. */
  glyph: string;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaHref?: string;
}

export function TeachState({ glyph, title, body, ctaLabel, ctaHref }: TeachStateProps) {
  return (
    <div className="dept-teach">
      <span className="dept-teach__glyph" aria-hidden="true">{glyph}</span>
      <span className="dept-teach__title">{title}</span>
      <span className="dept-teach__body">{body}</span>
      {ctaLabel && ctaHref && (
        <Link href={ctaHref} className="lux-btn lux-btn--ghost lux-btn--sm dept-teach__cta">{ctaLabel}</Link>
      )}
    </div>
  );
}
