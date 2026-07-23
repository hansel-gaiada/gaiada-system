import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment } from "@/lib/departments";
import { listConnections, findConnection } from "@/lib/connections";
import { listClaudeSeats, mySeat } from "@/lib/claudeSeats";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { ConnectionsPanel } from "@/components/departments/ConnectionsPanel";
import { TeamConnectionsGrid, type TeamConnectionRow } from "@/components/departments/TeamConnectionsGrid";
import "@/components/departments/departments.css";
import {
  connectAction, updateConnectionAction, revokeConnectionAction,
  mapSeatAction, updateSeatAction, unmapSeatAction, adminMapSeatAction,
} from "./actions";

type Params = Promise<{ deptId: string }>;

// Connections — GitHub / Google Drive / Claude-seat links (F1 §12, C1 §12a).
// "My connections" is self-service and person-scoped (not department-scoped
// — a connection is owned by the user or the company, per contract §12); the
// "Team status" grid below it is admin/manager-gated (company.manage) and
// scoped to THIS department's roster, matching the console's own IA (a
// department owner checks their own team's status, not the whole company's).
// Every read degrades on its own (WSUX-6's `unavailable` convention) so a
// pre-redeploy 404 on the running backend renders a clean banner + empty
// "not connected" rows instead of crashing the tab.
export default async function DepartmentConnectionsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const isAdmin = can(me, "company.manage", tenant);

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
    const [perMemberGithub, perMemberDrive, teamSeats] = await Promise.all([
      Promise.all(memberIds.map((id) => listConnections(userId, tenant, { owner: `user:${id}`, provider: "github" }))),
      Promise.all(memberIds.map((id) => listConnections(userId, tenant, { owner: `user:${id}`, provider: "google_drive" }))),
      listClaudeSeats(userId, tenant, "team"),
    ]);
    teamUnavailable = perMemberGithub.some((r) => r.unavailable) || perMemberDrive.some((r) => r.unavailable) || teamSeats.unavailable;
    const seatByPerson = new Map(teamSeats.rows.map((s) => [s.personId, s]));
    teamRows = dept.people.map((p, i) => ({
      person: p,
      github: findConnection(perMemberGithub[i].rows, "github"),
      drive: findConnection(perMemberDrive[i].rows, "google_drive"),
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
    </>
  );
}
