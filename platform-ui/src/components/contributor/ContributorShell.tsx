import Link from "next/link";
import { logout } from "@/app/(app)/account/actions";
import "@/components/portal/portal.css";

// M5-W1f: the freelance writer's chrome. A separate interface from the staff workspace and from the client portal (WSK-D84), reusing the portal's
// slim header classes (`cp-*`) and none of the staff shell. Deliberately ABSENT: the company and department switchers, search, the approvals inbox,
// notifications, every module console. A contributor reaches 23 backend routes and this shell links to exactly two places: their assignments and
// sign-out. Sign-out reuses the staff `logout` action (it clears the shared session cookie), as the portal's user menu does.
export function ContributorShell({ children, userName }: { children: React.ReactNode; userName: string | null }) {
  return (
    <div className="cp-shell" data-testid="contributor-shell">
      <header className="cp-head">
        <div className="cp-head__bar">
          <Link href="/contributor" className="cp-brand">
            <span className="cp-brand__mark">Writers&apos; room</span>
            <span className="cp-brand__sub">Freelance contributor</span>
          </Link>
          <span className="cp-head__spacer" />
          {userName && <div className="cp-head__who"><div className="cp-head__who-name">{userName}</div></div>}
          <form action={logout}>
            <button type="submit" className="btn" style={{ fontSize: 13 }} data-testid="contributor-signout">Sign out</button>
          </form>
        </div>
      </header>
      <main className="cp-main" id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="cp-foot">
        You only see the items assigned to you. Questions about an item or your access? Reply to the person who invited you.
      </footer>
    </div>
  );
}
