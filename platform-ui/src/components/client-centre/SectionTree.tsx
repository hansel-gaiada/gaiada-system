"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  parentOf,
  sectionHref,
  type RegistryArea,
  type ClientCentreRegistry,
} from "@/lib/clientCentre";

// The in-page Business areas tree: Home · Business details · each ACTIVE area (the industry area first).
// An area is one link to its page (Setup, Connections and, later, Services & results are parts of that
// page, reached from its part strip, not from here). Only Marketing has sub-areas, so only Marketing
// carries an expand/collapse chevron. Native `<details>` was considered and rejected: the row separates
// "go to this area" (the name) from "expand its sub-areas" (the chevron) — two different actions on one
// row — and a native `<summary>` collapses both into a single click target. `aria-expanded` on a
// dedicated toggle button keeps both reachable and announced.
// The standard chevron (a down-pointing line), used if the registry's icon set ever lacks it.
const CHEV_FALLBACK = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

export function SectionTree({
  registry,
  basePath,
  businessType,
  activeAreas,
  currentSectionId,
  onNavigate,
}: {
  registry: ClientCentreRegistry;
  basePath: string;
  businessType: string;
  activeAreas: RegistryArea[];
  /** The section id currently open (area or sub-area), or null on Home/Business details. */
  currentSectionId: string | null;
  /** Called after any link click — lets the mobile shell collapse the tree back down. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? basePath;

  // Auto-expand the branch containing the current location so a deep link never opens looking empty.
  const initialOpen = useMemo(() => {
    const s = new Set<string>();
    if (currentSectionId) {
      const parent = parentOf(registry, businessType, currentSectionId);
      if (parent) s.add(parent.id);
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only ever seeds the initial state
  }, []);
  const [open, setOpen] = useState(initialOpen);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const isActive = (href: string) => pathname === href;
  const icon = (id: string) => registry.icons[id] ?? registry.icons.gen;

  function renderArea(area: RegistryArea) {
    const href = sectionHref(basePath, { kind: "section", sectionId: area.id, part: "setup" });
    const subs = area.subAreas ?? [];
    const expanded = open.has(area.id);
    return (
      <div key={area.id}>
        <div className="cc-tree__row">
          <Link
            href={href}
            className="cc-tree__link"
            aria-current={currentSectionId === area.id ? "page" : undefined}
            onClick={onNavigate}
          >
            {icon(area.id) && (
              <span className="cc-tree__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(area.id) }} />
            )}
            {area.name}
          </Link>
          {subs.length > 0 && (
            <button
              type="button"
              className="cc-tree__toggle"
              aria-expanded={expanded}
              aria-label={`Toggle ${area.name} sub-areas`}
              onClick={() => toggle(area.id)}
            >
              <span className="cc-tree__chev" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon("chev") || CHEV_FALLBACK }} />
            </button>
          )}
        </div>
        {subs.length > 0 && expanded && (
          <div className="cc-tree__children">
            {subs.map((s) => (
              <Link
                key={s.id}
                href={sectionHref(basePath, { kind: "section", sectionId: s.id, part: "setup" })}
                className="cc-tree__link"
                aria-current={currentSectionId === s.id ? "page" : undefined}
                onClick={onNavigate}
              >
                {s.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  const homeHref = sectionHref(basePath, { kind: "home" });
  const companyHref = sectionHref(basePath, { kind: "company" });

  return (
    <nav className="cc-tree" aria-label="Business areas">
      <div className="cc-tree__row">
        <Link href={homeHref} className="cc-tree__link" aria-current={isActive(homeHref) ? "page" : undefined} onClick={onNavigate}>
          <span className="cc-tree__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon("home") }} />
          Home
        </Link>
      </div>
      <div className="cc-tree__row">
        <Link href={companyHref} className="cc-tree__link" aria-current={isActive(companyHref) ? "page" : undefined} onClick={onNavigate}>
          <span className="cc-tree__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon("gen") }} />
          Business details
        </Link>
      </div>
      {activeAreas.map((a) => renderArea(a))}
    </nav>
  );
}
