import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment } from "@/lib/departments";
import { toolkitFor, deptTabs } from "@/lib/deptToolkits";
import { listConnections, findConnection } from "@/lib/connections";
import { listClaudeSeats, mySeat } from "@/lib/claudeSeats";
import { listClients } from "@/lib/entities";
import { listGoogleConnections, listProperties } from "@/lib/searchMarketing";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { ConnectionsPanel } from "@/components/departments/ConnectionsPanel";
import { TeamConnectionsGrid, type TeamConnectionRow } from "@/components/departments/TeamConnectionsGrid";
import { GoogleConnectionsPanel } from "@/components/search/GoogleConnectionsPanel";
import { GithubOrgHealth } from "@/components/github/GithubOrgHealth";
import { getGithubOrgStatus } from "@/lib/githubOrgStatus-data";
import "@/components/departments/departments.css";
import {
  connectAction, updateConnectionAction, revokeConnectionAction,
  mapSeatAction, updateSeatAction, unmapSeatAction, adminMapSeatAction,
} from "./actions";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async — carries the Google OAuth callback's coarse outcome flag
// (app/api/search/google/callback/route.ts's own redirect).
type SearchParams = Promise<{ googleOAuth?: string; googleOAuthDetail?: string }>;

// Connections — GitHub / Google Drive / Claude-seat links (F1 §12, C1 §12a).
// "My connections" is self-service and person-scoped (not department-scoped
// — a connection is owned by the user or the company, per contract §12); the
// "Team status" grid below it is admin/manager-gated (company.manage) and
// scoped to THIS department's roster, matching the console's own IA (a
// department owner checks their own team's status, not the whole company's).
// Every read degrades on its own (WSUX-6's `unavailable` convention) so a
// pre-redeploy 404 on the running backend renders a clean banner + empty
// "not connected" rows instead of crashing the tab.
export default async function DepartmentConnectionsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const toolkit = toolkitFor(dept.name);
  const isAdmin = can(me, "company.manage", tenant);
  const isSeo = toolkit.slug === "seo";
  // Only departments that actually work in repositories get the org App card below. Keyed off the
  // toolkit's own tab set rather than a hard-coded slug list, so a second department gaining a
  // Repositories tab gets it automatically and one losing it stops claiming to care.
  const usesRepos = deptTabs(toolkit).some((t) => t.key === "repositories");
  const sp = await searchParams;

  const [myConnections, mySeats] = await Promise.all([
    listConnections(userId, tenant, { owner: "me" }),
    listClaudeSeats(userId, tenant, "me"),
  ]);
  const github = findConnection(myConnections.rows, "github");
  const drive = findConnection(myConnections.rows, "google_drive");
  const seat = mySeat(mySeats.rows, userId);
  const unavailable = myConnections.unavailable || mySeats.unavailable;

  let teamRows: TeamConnectionRow[] = [];
  let teamUnavailable = false;
  if (isAdmin && dept.people.length > 0) {
    const memberIds = dept.people.map((p) => p.id);
    // ── ONE read per member, not two (2026-09-03) ────────────────────────────────────────────────
    // This issued a `provider=github` call AND a `provider=google_drive` call for every person, so
    // a 20-person department cost 41 backend round trips to render a grid that mostly says "not
    // connected". Dropping the `provider` filter returns that member's rows for BOTH providers in
    // one response — `findConnection` was already picking the provider out of a list, so nothing
    // downstream changes — and halves it to 21.
    //
    // It is still one call per member, which is the real problem, and it CANNOT be fixed here: the
    // endpoint's `owner` selector accepts only `me | company | user:<id>` (integrations.controller
    // .ts 400s anything else), so there is no way to ask for several people at once. Batching needs
    // a backend `owner=users`-style selector plus a Cerbos decision about which action authorizes
    // reading a whole tenant's user-owned rows — a real authz question, not a UI change.
    const [perMember, teamSeats] = await Promise.all([
      Promise.all(memberIds.map((id) => listConnections(userId, tenant, { owner: `user:${id}` }))),
      listClaudeSeats(userId, tenant, "team"),
    ]);
    teamUnavailable = perMember.some((r) => r.unavailable) || teamSeats.unavailable;
    const seatByPerson = new Map(teamSeats.rows.map((s) => [s.personId, s]));
    teamRows = dept.people.map((p, i) => ({
      person: p,
      github: findConnection(perMember[i].rows, "github"),
      drive: findConnection(perMember[i].rows, "google_drive"),
      seat: seatByPerson.get(p.id),
    }));
  }

  const connect = connectAction.bind(null, tenant, deptId);
  const update = updateConnectionAction.bind(null, tenant, deptId);
  const revoke = revokeConnectionAction.bind(null, tenant, deptId);
  const mapSeat = mapSeatAction.bind(null, tenant, deptId);
  const updateSeat = updateSeatAction.bind(null, tenant, deptId);
  const unmapSeat = unmapSeatAction.bind(null, tenant, deptId);
  const adminMapSeat = adminMapSeatAction.bind(null, tenant, deptId);

  // SM-25a — Google (Search Console/GA4/Ads) connections, SEO department only (the "Connections gap"
  // FRONTEND-BFF-CONTRACT.md §14 records: "the SEO console's Connections tab still shows only GitHub
  // + Drive"). Company-level, not person-level, unlike the GitHub/Drive rows above — a Google
  // connection belongs to a CLIENT (`clientId`), not the logged-in user, so it is fetched once for
  // the whole tenant rather than per-person. `can("search.manage")` gates the write half only; every
  // signed-in member of this department can still SEE which accounts are linked.
  const canManageGoogle = can(me, "search.manage", tenant);
  const [googleConnections, searchClients, searchProperties] = isSeo
    ? await Promise.all([listGoogleConnections(userId, tenant), listClients(userId, tenant), listProperties(userId, tenant)])
    : [[], [], []];

  // ── The org GitHub App, read-only (2026-09-03) ────────────────────────────────────────────────
  // The GitHub row in "My connections" above is a username string with no credential behind it.
  // The credential that actually exists is the ORG-LEVEL App — a sealed private key under
  // `owner_kind='github_app'`, which is what mints the tokens the repo registry and provisioning
  // run on. It was visible only from the Repositories tab, three clicks away and buried under 200+
  // repo rows, so a reader on THIS tab saw one GitHub row, saw it hold nothing, and concluded
  // GitHub was not connected at all — while the App was installed and working.
  //
  // Strictly read-only here. Sealing or rotating that key is not a self-service act and has no HTTP
  // write path by design (credential-store.ts is service-layer only); this card reports state and
  // says where it lives. `getGithubOrgStatus` carries its own refused / no_org / unavailable result,
  // and `GithubOrgHealth` renders each as itself — never as a silent all-clear.
  const orgStatus = usesRepos ? await getGithubOrgStatus(userId, tenant) : null;

  return (
    <>
      <Card title="My connections">
        {unavailable && (
          <p className="dept-conn-banner">
            The connections service isn&apos;t reachable yet — status shown below may be incomplete. It will populate once the backend is deployed.
          </p>
        )}
        <ConnectionsPanel
          github={github}
          drive={drive}
          seat={seat}
          actions={{ connect, update, revoke, mapSeat, updateSeat, unmapSeat }}
        />
      </Card>

      {orgStatus && (
        <Card
          title="GitHub App (organisation)"
          hint="The credential the repository registry and provisioning actually run on. It belongs to the company, not to you, and is not self-service."
          style={{ marginTop: 16 }}
        >
          <p className="dept-conn-note">
            This is the org-wide GitHub App — separate from the personal GitHub row above, which
            only records your username. Repository lists, linking and provisioning authenticate
            through this, and it is managed from{" "}
            <Link href={`/departments/${deptId}/repositories`}>Repositories</Link>.
          </p>
          <GithubOrgHealth result={orgStatus} />
        </Card>
      )}

      {isAdmin && (
        <Card title="Team status" style={{ marginTop: 16 }}>
          {teamUnavailable && (
            <p className="dept-conn-banner">
              The connections service isn&apos;t reachable yet — the team grid below may be incomplete.
            </p>
          )}
          {teamRows.length === 0 ? (
            <TeachState
              glyph="⌁"
              title="No one placed yet"
              body="Add people to this department in the org structure editor to see their connection status here."
            />
          ) : (
            <TeamConnectionsGrid rows={teamRows} onMapSeat={adminMapSeat} />
          )}
        </Card>
      )}

      {isSeo && (
        <Card title="Google (Search Console / GA4 / Ads)" style={{ marginTop: 16 }}>
          <GoogleConnectionsPanel
            tenantId={tenant}
            returnPath={`/departments/${deptId}/connections`}
            connections={googleConnections}
            clients={searchClients.map((c) => ({ id: c.id, name: c.name }))}
            properties={searchProperties.map((p) => ({ id: p.id, domain: p.domain, clientId: p.clientId }))}
            canManage={canManageGoogle}
            oauthStatus={sp.googleOAuth}
            oauthDetail={sp.googleOAuthDetail}
          />
        </Card>
      )}
    </>
  );
}
