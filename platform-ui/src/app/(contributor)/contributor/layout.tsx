import { contributorCtx } from "@/lib/contributorServer";
import { ContributorShell } from "@/components/contributor/ContributorShell";
import { AssuranceNotice } from "@/components/contributor/AssuranceNotice";

// M5-W1f: the `(contributor)` route group: the freelance writer's own screens (my assignments, the editor in contributor mode, preview, comments).
// Mirrors `(portal)`: its own layout and chrome, none of the staff shell. Access is decided by `contributorCtx()`: a person whose `/me` says
// `kind: "contributor"` is in; a person who is not goes to "/" (staff workspace, which sends a client on to the portal); a session the backend's
// fence refuses at `/api/me` (no real second factor yet) is shown the two-step notice INSTEAD of the page, so no page below ever has to read
// anything the fence would refuse. Authorization stays server-side (the fence, Cerbos, the grants); this only decides what chrome to draw.
export default async function ContributorLayout({ children }: { children: React.ReactNode }) {
  const c = await contributorCtx();
  if (c.kind === "fenced") return <ContributorShell userName={null}><AssuranceNotice /></ContributorShell>;
  return <ContributorShell userName={c.me.name ?? c.me.email ?? null}>{children}</ContributorShell>;
}
