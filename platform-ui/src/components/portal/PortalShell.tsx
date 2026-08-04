import Link from "next/link";
import { PortalTabs } from "./PortalTabs";
import { PortalLive } from "./PortalLive";
import { PortalUserMenu } from "./PortalUserMenu";
import "./portal.css";

// CP-7 — the client portal's chrome. A separate interface from the staff ERP (owner decision
// 2026-08-04), reusing the design system and none of the staff layout.
//
// What is deliberately ABSENT, and why each absence is a decision rather than an omission:
//   * The company switcher. A client belongs to the one company that serves them. A switcher would at
//     best be a dropdown of one and at worst leak the existence of other tenants.
//   * Global search. It searches internal entities.
//   * The approvals inbox, notifications bell, departments rail, module consoles. All internal.
//   * Density and width preferences. The staff shell reads `gaiada_prefs` for people who live in the
//     app all day; a client visits to answer one question. Fewer controls, larger defaults.
// The THEME preference is not read here either — the portal follows the OS via the token layer's
// `prefers-color-scheme` block, so it is still dark-mode-correct without a control the client would
// have to discover.
export function PortalShell({
  children, clientName, userName, userInitials, pendingCount,
}: {
  children: React.ReactNode;
  clientName: string | null;
  userName: string;
  userInitials: string;
  /** Things waiting on the client, badged onto the Approvals tab. */
  pendingCount: number;
}) {
  return (
    <div className="cp-shell">
      <header className="cp-head">
        <div className="cp-head__bar">
          {/* The brand links to the portal root, not to `/` — `/` is the staff dashboard and would
              bounce a client through a redirect back to here. */}
          <Link href="/portal" className="cp-brand">
            <span className="cp-brand__mark">Syrowatka</span>
            <span className="cp-brand__sub">Client Portal</span>
          </Link>
          <span className="cp-head__spacer" />
          {/* Unfiltered on purpose: the header is present on every page, so it must react to anything,
              not only to the topics of the page beneath it. */}
          <PortalLive />
          <div className="cp-head__who">
            <div className="cp-head__who-name">{userName}</div>
            {clientName && <div className="cp-head__who-org">{clientName}</div>}
          </div>
          <PortalUserMenu initials={userInitials} />
        </div>
        <nav className="cp-tabs" aria-label="Portal sections">
          <PortalTabs pendingCount={pendingCount} />
        </nav>
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
