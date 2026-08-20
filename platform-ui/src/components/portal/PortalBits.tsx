import Link from "next/link";
import { Eyebrow } from "@/components/ui";
import { clientStatus, statusTone, socialReviewStatusLabel, socialReviewStatusTone, type PortalTone, type SocialReviewStatus } from "@/lib/portal";

// Small presentational pieces shared by every portal page. Server components (no "use client"): they
// render text and links and hold no state, so shipping them to the browser would be pure cost.
//
// These live here rather than in `components/ui.tsx` because they encode CLIENT-FACING conventions that
// would be wrong internally — `PortalStatus` says "Awaiting your action" where the staff `StatusBadge`
// says "Sent", and `PortalPageHead` uses a lead paragraph the staff pages do not have.

export function PortalPageHead({ eyebrow, title, lead, actions }: {
  eyebrow: string;
  title: string;
  lead?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="cp-page-head">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <Eyebrow style={{ color: "var(--erp-accent)" }}>{eyebrow}</Eyebrow>
          <h1>{title}</h1>
        </div>
        {actions}
      </div>
      {lead && <p>{lead}</p>}
    </div>
  );
}

/** A status pill in CLIENT vocabulary, coloured from the token layer only.
 *
 *  The tone is resolved to a `--status-*` token NAME and interpolated into a `var()` — never a colour
 *  literal. `styles/tokens.test.ts` fails the build on a hex or `rgb()` in `components/**.css`, and a
 *  literal in a `style` prop here would route straight around that guard while looking compliant. */
export function PortalStatus({ status, tone }: { status: string | null | undefined; tone?: PortalTone }) {
  const t = tone ?? statusTone(status);
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        font: "500 12px/1 var(--font-body)", whiteSpace: "nowrap",
        color: `var(--status-${t}-fg)`,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 7, height: 7, borderRadius: "50%", background: `var(--status-${t})` }}
      />
      {clientStatus(status)}
    </span>
  );
}

/** SMM-31/32 — the SAME pill `PortalStatus` draws, but labelled from `socialReviewStatusLabel`
 *  instead of `clientStatus`: the general map has no entry for `changes_requested`/`withdrawn` in
 *  this review-specific sense, and its `pending` entry ("Not started") is actively wrong here — a
 *  review that is `pending` is waiting on the CLIENT'S OWN decision, not unstarted work. A second,
 *  small component rather than teaching `PortalStatus`/`clientStatus` a status vocabulary that only
 *  makes sense for this one BFF surface. */
export function PortalSocialReviewStatus({ status }: { status: SocialReviewStatus }) {
  const t = socialReviewStatusTone(status);
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        font: "500 12px/1 var(--font-body)", whiteSpace: "nowrap",
        color: `var(--status-${t}-fg)`,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 7, height: 7, borderRadius: "50%", background: `var(--status-${t})` }}
      />
      {socialReviewStatusLabel(status)}
    </span>
  );
}

/** A labelled figure. `tone` is optional and only ever `danger` — a portal that colour-codes every
 *  number teaches the client to read none of them. */
export function PortalFigure({ label, value, tone, foot }: {
  label: string;
  value: React.ReactNode;
  tone?: "danger";
  foot?: string;
}) {
  return (
    <div>
      <Eyebrow style={{ display: "block", marginBottom: 4, opacity: 0.6 }}>{label}</Eyebrow>
      <div style={{
        font: "600 22px/1.1 var(--font-display)",
        color: tone === "danger" ? "var(--status-danger-fg)" : "var(--ink-strong)",
      }}>
        {value}
      </div>
      {foot && <div style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)", marginTop: 2 }}>{foot}</div>}
    </div>
  );
}

/** A horizontal progress bar with an accessible label. `role="img"` + `aria-label` rather than
 *  `progressbar`: this is a static rendering of a value, not a live-updating widget, and a progressbar
 *  role makes assistive tech announce it as one. */
export function PortalBar({ percent, thin }: { percent: number; thin?: boolean }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={`cp-bar${thin ? " cp-bar--thin" : ""}`} role="img" aria-label={`${p}% complete`}>
      <div className="cp-bar__fill" style={{ width: `${p}%` }} />
    </div>
  );
}

/** The "→" text link the portal uses instead of secondary buttons. */
export function PortalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)", textDecoration: "none" }}>
      {children} →
    </Link>
  );
}

/** Key/value facts. Rendered as a real `<dl>` so a screen reader announces the pairing — an invoice's
 *  terms read as a list of orphaned values otherwise. */
export function PortalFacts({ rows }: { rows: Array<{ k: string; v: React.ReactNode; strong?: boolean }> }) {
  return (
    <dl className="cp-facts">
      {rows.map((r, i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt className="cp-facts__k">{r.k}</dt>
          <dd className={`cp-facts__v${r.strong ? " cp-facts__v--strong" : ""}`} style={{ margin: 0 }}>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}
