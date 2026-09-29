"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  isSub,
  parentOf,
  sectionHref,
  type RegistryPage,
  type RegistrySection,
  type ClientCentreRegistry,
} from "@/lib/clientCentre";

// The CMC-style in-page department tree: Home · Business details · each ACTIVE department
// (industry module first), expandable into its sub-sections and leaf pages, each branch ending in
// its own "Settings" link. Native `<details>` was considered and rejected: CMC's own affordance
// separates "navigate to this section's overview" (clicking the name) from "expand/collapse its
// children" (the chevron) — two different actions on one row — and a native `<summary>` collapses
// both into a single click target. `aria-expanded` on a dedicated toggle button keeps both actions
// reachable and announced, matching the plan's a11y requirement.
// CMC's own chevron (a down-pointing line), used if the registry's icon set ever lacks it.
const CHEV_FALLBACK = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

export function SectionTree({
  registry,
  clientId,
  basePath,
  businessType,
  activeDepts,
  currentSectionId,
  onNavigate,
}: {
  registry: ClientCentreRegistry;
  clientId: string;
  basePath: string;
  businessType: string;
  activeDepts: RegistrySection[];
  /** The section id currently open (department or sub-section), or null on Home/Business details. */
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
      if (currentSectionId !== parent?.id) s.add(currentSectionId);
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

  const renderChildRow = (page: RegistryPage, sectionId: string, index: number) => {
    if (isSub(page)) return renderSection(page, 1);
    const href = sectionHref(basePath, { kind: "section", sectionId, sub: "page", pageIndex: index });
    return (
      <Link key={index} href={href} className="cc-tree__link" aria-current={isActive(href) ? "page" : undefined} onClick={onNavigate}>
        {page.name}
      </Link>
    );
  };

  function renderSection(section: RegistrySection, depth: number) {
    const overviewHref = sectionHref(basePath, { kind: "section", sectionId: section.id, sub: "overview" });
    const settingsHref = sectionHref(basePath, { kind: "section", sectionId: section.id, sub: "settings" });
    const expanded = open.has(section.id);
    return (
      <div key={section.id}>
        <div className="cc-tree__row">
          <Link
            href={overviewHref}
            className="cc-tree__link"
            aria-current={isActive(overviewHref) ? "page" : undefined}
            onClick={onNavigate}
          >
            {depth === 0 && icon(section.id) && (
              <span className="cc-tree__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(section.id) }} />
            )}
            {section.name}
          </Link>
          <button
            type="button"
            className="cc-tree__toggle"
            aria-expanded={expanded}
            aria-label={`Toggle ${section.name} menu`}
            onClick={() => toggle(section.id)}
          >
            <span className="cc-tree__chev" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon("chev") || CHEV_FALLBACK }} />
          </button>
        </div>
        {expanded && (
          <div className="cc-tree__children">
            {section.pages.map((p, i) => renderChildRow(p, section.id, i))}
            <Link
              href={settingsHref}
              className="cc-tree__link cc-tree__settings-link"
              aria-current={isActive(settingsHref) ? "page" : undefined}
              onClick={onNavigate}
            >
              Settings
            </Link>
          </div>
        )}
      </div>
    );
  }

  const homeHref = sectionHref(basePath, { kind: "home" });
  const companyHref = sectionHref(basePath, { kind: "company" });

  return (
    <nav className="cc-tree" aria-label="Profile sections">
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
      {activeDepts.map((d) => renderSection(d, 0))}
    </nav>
  );
}
