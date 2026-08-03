import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui";
import { Breadcrumbs, type Crumb } from "@/components/Breadcrumbs";

// The standard page title block. Reworked to carry ONE piece of text where it used to carry four.
//
// What was removed and why — the header used to stack breadcrumb + eyebrow + H1 + subtitle above
// every page, ~292px before any content on a 1080p screen, and on a top-level page three of those
// four rows said the same word: the TopBar says "MY WORKSPACE", the sidebar group says
// "WORKSPACE" with the current item highlighted inside it, the eyebrow said "WORKSPACE", and the
// breadcrumb's last crumb was the H1 verbatim.
//
//  - `eyebrow` is no longer rendered. The sidebar already shows which section you are in, and it
//    stays highlighted while you are on the page — the eyebrow only repeated it. (`.type-eyebrow`
//    is still the system's signature gesture; it now earns its place on cards and tables, where it
//    labels something the surrounding UI does NOT already state.)
//  - `subtitle` is no longer rendered. It was descriptive boilerplate restating the title, capped
//    at 560px so it wrapped to two ragged lines against an empty right-hand side.
//  - Breadcrumbs render only at real depth. `Home / Calendar` above an H1 reading "Calendar" is a
//    zero-value hop; a genuine trail (Departments / Web Dev / Projects) still renders in full.
//
// Both props are KEPT in the signature deliberately: 61 pages pass them, and preserving the API
// means this is one component change rather than a 61-file sweep. A page that needs its subtitle
// visible should put it in the page body where it belongs, not in the chrome.
export function PageHeader({ title, actions, breadcrumbs }: {
  /** @deprecated No longer rendered — the sidebar states the section. Accepted so call sites compile. */
  eyebrow?: string;
  title: string;
  /** @deprecated No longer rendered — put descriptive copy in the page body. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
}) {
  const trail: Crumb[] = [{ label: "Home", href: "/" }, ...(breadcrumbs ?? [])];
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 24, flexWrap: "wrap", marginBottom: 18 }}>
      <div>
        {trail.length > 2 && <Breadcrumbs items={trail} />}
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 26, lineHeight: 1.15 }}>
          {title}
        </h1>
      </div>
      {actions && <div style={{ display: "flex", gap: 12, alignItems: "center" }}>{actions}</div>}
    </div>
  );
}
