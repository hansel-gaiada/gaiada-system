import Link from "next/link";
import { PortalTabs } from "./PortalTabs";
import { PortalLive } from "./PortalLive";
import { PortalUserMenu } from "./PortalUserMenu";
import "./portal.css";

// CP-7 — the client portal's chrome. A separate interface from the staff ERP (owner decision
// 2026-08-04), reusing the design system and none of the staff layout.
//
// What is deliberately ABSENT, and why each absence is a decision rather than an omission:
//   * The STAFF company switcher. The portal has its own (PV2-05, `PortalCompanySwitch`), offered only
//     to a contact of more than one company and listing only those companies, never workspaces.
//   * Global search. It searches internal entities.
//   * The approvals inbox, notifications bell, departments rail, module consoles. All internal.
//   * Density and width preferences. The staff shell reads `gaiada_prefs` for people who live in the
//     app all day; a client visits to answer one question. Fewer controls, larger defaults.
// The THEME preference is not read here either — the portal follows the OS via the token layer's
// `prefers-color-scheme` block, so it is still dark-mode-correct without a control the client would
// have to discover.
export function PortalShell({
  children, companyName, companySwitch, clientName, userName, userInitials, projectsBadge, billingBadge, overviewBadge = 0, staff = false, showWebsite = false,
}: {
  children: React.ReactNode;
  /** The serving company's name, the brand (PV-D13: never our holding's name). Null renders
   *  "Client Portal" alone. */
  companyName: string | null;
  /** `PortalCompanySwitch`, passed only when the caller is a client of more than one company. */
  companySwitch?: React.ReactNode;
  clientName: string | null;
  userName: string;
  userInitials: string;
  /** Gates waiting on the client, badged onto the Projects area. */
  projectsBadge: number;
  /** Unsigned contracts plus overdue invoices, badged onto Contracts & billing. */
  billingBadge: number;
  /** PV7-04b: published reports this user has not opened, badged onto the Overview area and its Reports tab. */
  overviewBadge?: number;
  /** PV2-06: the viewer also holds a staff role (`isStaff(me)`), so the user menu offers "Back to
   *  workspace". Navigation only; the portal's authorization does not read it. */
  staff?: boolean;
  /** WSK-49d: the viewer holds a website-editor grant for the active client, so the Business area offers its Website tab. */
  showWebsite?: boolean;
}) {
  return (
    <div className="cp-shell">
      <header className="cp-head">
        <div className="cp-head__bar">
          {/* The brand links to the portal root, not to `/` — `/` is the staff dashboard and would
              bounce a client through a redirect back to here. */}
          <Link href="/portal" className="cp-brand">
            {companyName ? (
              <>
                <span className="cp-brand__mark">{companyName}</span>
                <span className="cp-brand__sub">Client Portal</span>
              </>
            ) : (
              <span className="cp-brand__mark">Client Portal</span>
            )}
          </Link>
          <span className="cp-head__spacer" />
          {/* Unfiltered on purpose: the header is present on every page, so it must react to anything,
              not only to the topics of the page beneath it. */}
          <PortalLive />
          {companySwitch}
          <div className="cp-head__who">
            <div className="cp-head__who-name">{userName}</div>
            {clientName && <div className="cp-head__who-org">{clientName}</div>}
          </div>
          <PortalUserMenu initials={userInitials} staff={staff} />
        </div>
        <PortalTabs projectsBadge={projectsBadge} billingBadge={billingBadge} overviewBadge={overviewBadge} showWebsite={showWebsite} />
      </header>

      {/* The skip target the a11y pass requires; `tabIndex={-1}` so the skip link can focus it. */}
      <main className="cp-main" id="main" tabIndex={-1}>
        {children}
      </main>

      <footer className="cp-foot">
        Questions about anything here? Reply to your account manager — every page on this portal is
        generated from the same records our team works from.
      </footer>
    </div>
  );
}
