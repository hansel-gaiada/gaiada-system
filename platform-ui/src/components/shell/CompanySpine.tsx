"use client";
import Link from "next/link";
import { switchTenant } from "@/lib/tenant";
import { companyToneVar } from "@/lib/companyColor";
import { useRailTooltip } from "./railTooltip";

// The company spine — UI redesign §"the company spine (the signature element)". A narrow,
// full-height strip between the sidebar and the content area: one segment per accessible company
// (deterministic --cat-N tone, §7 of the design-language spec), a striped "whole group" cap at the
// top, and click-to-switch on each segment. Client component because switching is an immediate
// interaction (hover/focus reveal a label, click submits); the actual switch is still the SAME
// `switchTenant` server action `TenantSwitcher.tsx` already posts to — this is a second, always-
// visible way to reach it, not a new mutation path.
//
// Hidden entirely below one company (nothing to switch — matches the sidebar's own
// `canSwitchCompany` "single reachable company -> static label" convention rather than drawing a
// one-segment strip that would carry no information) and, per spec, on narrow viewports (CSS only —
// see `.erp-spine` in shell.css).
export function CompanySpine({ companies, current, capHref }: {
  companies: { id: string; name: string }[];
  current: string | null;
  capHref: string | null;
}) {
  if (companies.length <= 1) return null;
  return (
    <div className="erp-spine" role="group" aria-label="Companies">
      {capHref && <SpineCap companies={companies} href={capHref} />}
      {companies.map((c) => (
        <SpineSegment key={c.id} company={c} active={c.id === current} />
      ))}
    </div>
  );
}

function SpineCap({ companies, href }: { companies: { id: string; name: string }[]; href: string }) {
  const { tip, triggerProps } = useRailTooltip("Whole group — every company", { always: true });
  return (
    <Link href={href} className="erp-spine__cap" aria-label="Whole group — cross-company view" {...triggerProps}>
      <span className="erp-spine__cap-stripe" aria-hidden="true">
        {companies.slice(0, 8).map((c) => (
          <span key={c.id} className="erp-spine__cap-tone" style={{ background: companyToneVar(c.id) }} />
        ))}
      </span>
      {tip}
    </Link>
  );
}

function SpineSegment({ company, active }: { company: { id: string; name: string }; active: boolean }) {
  const { tip, triggerProps } = useRailTooltip(company.name, { always: true });
  // `--seg-tone` (a custom property, not the `background` itself) so shell.css can mix inactive
  // segments toward `--surface-chrome` (color-mix, same technique --cat-N-area already uses) rather
  // than dimming with plain opacity: opacity interacts with each hue's own inherent brightness (an
  // inactive amber at 55% can still read brighter than an active purple at 100%), which undermines
  // "active reads as obviously active" across all 8 tones. Mixing toward the chrome surface also
  // gives the spec's "lifted on light theme" requirement for free — the same partial mix lightens on
  // a light --surface-chrome and darkens on a dark one, automatically, per theme.
  const style = { "--seg-tone": companyToneVar(company.id) } as React.CSSProperties;
  return (
    <form action={switchTenant} className="erp-spine__form">
      <input type="hidden" name="tenantId" value={company.id} />
      <button
        type="submit"
        className={`erp-spine__seg${active ? " erp-spine__seg--active" : ""}`}
        style={style}
        aria-label={company.name}
        aria-current={active ? "true" : undefined}
        {...triggerProps}
      />
      {tip}
    </form>
  );
}
