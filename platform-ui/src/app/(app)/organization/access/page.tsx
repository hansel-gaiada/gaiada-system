import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, isElevated } from "@/lib/rbac";
import { listMembers } from "@/lib/entities";
import { listRoles } from "@/lib/adminData";
import { getOrgStructure, flattenOrgUnits } from "@/lib/org";
import {
  listPositions, listAttachableRoles, listRoleGrants, positionsByUnit, sortPositions,
  GRANT_SOURCE_LABEL, type Position, type RoleGrant,
} from "@/lib/iam";
import { grantRole, requestOverride, unassignPosition } from "@/lib/iamActions";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PersonAccess } from "@/components/iam/PersonAccess";
import { IamAction } from "@/components/iam/IamAction";
import "@/components/iam/iam.css";

// P2-11 — the department-head access page. Design §5 (the boundary), §6.2 (who may grant), §6.5
// (the routed override).
//
// ── WHAT THIS PAGE IS FOR ────────────────────────────────────────────────────────────────────────
// The owner requirement behind the whole wave was "the department head handles permissions for their
// own department". This is that surface: the roster of their subtree, the seats in it, and the grants
// each person actually holds — plus the two writes a dept head is allowed (place/remove within their
// seats, grant within their ceiling) and the one escalation they need (request an override).
//
// ── THE §5 BOUNDARY, HONOURED ────────────────────────────────────────────────────────────────────
// Effective access is shown at SCOPE level (which roles, at which scope, from where) and NEVER as a
// per-resource claim. `IAM-05c`'s own caveat: the scope-level answer cannot say "can Ana edit THIS
// document" — that depends on resource attributes Cerbos evaluates per request. Displaying it as if it
// could would be a confident lie, so this page says what a grant IS and stops there.
//
// ── REACHABILITY ─────────────────────────────────────────────────────────────────────────────────
// The page is reachable only with `role_grant` reach, and the check that matters is the SERVER's: every
// read here is a real endpoint that 403s on its own. `canGrant` below gates the CONTROLS so a viewer is
// not handed a button that will refuse — it is not the boundary.

export default async function AccessPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const company = me.companies.find((c) => c.id === tenant) ?? { id: tenant, name: tenant, type: null };
  const [{ positions, scope }, attachable, members, roles, org] = await Promise.all([
    listPositions(userId, tenant),
    listAttachableRoles(userId, tenant),
    listMembers(userId, tenant).catch(() => []),
    listRoles(userId, tenant).catch(() => []),
    getOrgStructure(userId, tenant, company),
  ]);

  if (scope === null) {
    return (
      <>
        <PageHeader
          eyebrow="Organization"
          title="Access"
          breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Access" }]}
        />
        <EmptyNote>
          You don&apos;t have access management for this company. A department head reaches this page by
          holding a lead position whose role-set carries <code>org_unit_lead</code>.
        </EmptyNote>
      </>
    );
  }

  const canGrant = can(me, "admin.access", tenant) || can(me, "org.edit", tenant) || isElevated(me);

  // The roster: everyone who currently holds a seat the viewer can see. For a dept head that IS their
  // subtree, because the server already narrowed `positions` to the units they lead — the narrowing is
  // the server's, not a filter re-derived here.
  const seatsByUnit = positionsByUnit(positions.filter((p) => p.status !== "retired"));
  const memberById = new Map(members.map((m) => [m.user_id, m]));

  // Grants are fetched per person, and only for people in scope. `listRoleGrants` degrades to [] on a
  // 403, which is honest here: "you may not read this person's grants" and "they hold none" both render
  // as an empty list, and neither claims anything false about access.
  const holders = [...new Set(positions.flatMap((p) => (p.currentHolders > 0 ? [p.id] : [])))];
  const rosterUserIds = [...new Set(members.map((m) => m.user_id))];
  const grantsByUser = new Map<string, RoleGrant[]>();
  await Promise.all(
    rosterUserIds.map(async (uid) => {
      grantsByUser.set(uid, await listRoleGrants(userId, tenant, uid));
    }),
  );

  const unitOptions = flattenOrgUnits(org.structure).map((u) => ({
    value: u.id,
    label: `${"— ".repeat(Math.max(0, u.depth - 1))}${u.name}`,
  }));
  const roleOptions = attachable.length
    ? attachable.map((r) => ({
        value: r.roleId,
        label: r.role,
        disabled: !r.attachable,
        hint: r.attachable ? undefined : r.reason ?? "not grantable",
      }))
    : roles.map((r) => ({ value: r.id, label: r.name }));

  const peopleWithGrants = rosterUserIds.filter((uid) => (grantsByUser.get(uid) ?? []).length > 0);
  const positionGrants = [...grantsByUser.values()].flat().filter((g) => g.source === "position").length;
  const manualGrants = [...grantsByUser.values()].flat().filter((g) => g.source === "manual").length;
  const expiring = [...grantsByUser.values()].flat().filter((g) => g.expiresAt).length;

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Access"
        subtitle="Who holds what in your departments, and where each grant comes from."
        breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Access" }]}
      />

      {scope === "subtree" ? (
        <div className="iam-scope-note">
          <strong>Your departments.</strong>
          <span>
            You are seeing the units you lead. People and seats elsewhere in the company are not shown,
            and you cannot grant outside this subtree — the server enforces that, not this page.
          </span>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="People" value={String(rosterUserIds.length)} />
        <KpiTile label="With grants" value={String(peopleWithGrants.length)} />
        <KpiTile label="From a position" value={String(positionGrants)} foot="follows the org chart" />
        <KpiTile label="Granted by hand" value={String(manualGrants)} foot="does not follow moves" />
        <KpiTile label="Expiring" value={String(expiring)} foot="temporary grants" />
      </div>

      {/* ── the seats ──────────────────────────────────────────────────────────────────────────── */}
      <Card
        title="Seats in your departments"
        headerRight={
          <Link href="/organization/positions" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>
            Manage positions
          </Link>
        }
      >
        {seatsByUnit.size === 0 ? (
          <EmptyNote>
            No seats defined in your departments. Until a seat exists, access here has to be granted by
            hand and will not follow anyone when they move.
          </EmptyNote>
        ) : (
          [...seatsByUnit.entries()].map(([unit, list]) => (
            <div key={unit} style={{ marginBottom: 14 }}>
              <div style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)", marginBottom: 6 }}>
                {unit}
              </div>
              <HairlineTable
                columns={[{ label: "Seat" }, { label: "Role-set" }, { label: "Holders", align: "right" }]}
                rows={sortPositions(list).map((p: Position) => [
                  <span key="s" style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ font: "400 13px var(--font-body)", color: "var(--text-primary)" }}>{p.title}</span>
                    {p.isLead ? <span className="iam-badge iam-badge--lead">lead</span> : null}
                    {p.orphaned ? <span className="iam-badge iam-badge--orphaned">orphaned</span> : null}
                    {p.currentHolders === 0 && !p.orphaned ? <span className="iam-badge iam-badge--vacant">vacant</span> : null}
                  </span>,
                  p.roleSet.length === 0 ? (
                    <span key="r" className="iam-roleset--empty">confers no access</span>
                  ) : (
                    <span key="r" className="iam-roleset">
                      {p.roleSet.map((r) => (
                        <span key={r.roleId} className="iam-role">
                          {r.role}
                          <span className="iam-role__scope">{r.scopeKind === "own_unit" ? " @ unit" : " @ company"}</span>
                        </span>
                      ))}
                    </span>
                  ),
                  String(p.currentHolders),
                ])}
                tcols="1.5fr 2.5fr 0.5fr"
              />
            </div>
          ))
        )}
      </Card>

      {/* ── the people ─────────────────────────────────────────────────────────────────────────── */}
      <Card title="Effective access" hint="Scope-level, not per-resource — see the note below." style={{ marginTop: 16 }}>
        {rosterUserIds.length === 0 ? (
          <EmptyNote>No people in scope.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Person" }, { label: "Grants" }, { label: canGrant ? "Actions" : "" }]}
            rows={rosterUserIds.map((uid) => {
              const m = memberById.get(uid);
              const gs = grantsByUser.get(uid) ?? [];
              return [
                <span key="p" style={{ display: "grid", gap: 2 }}>
                  <Link href={`/people/${uid}`} style={{ font: "400 13px var(--font-body)", color: "var(--text-primary)", textDecoration: "none" }}>
                    {m?.name ?? uid}
                  </Link>
                  <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>{m?.email ?? ""}</span>
                </span>,
                gs.length === 0 ? (
                  <span key="g" style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                    No roles in this company.
                  </span>
                ) : (
                  <span key="g" style={{ display: "grid", gap: 5 }}>
                    {gs.map((g) => (
                      <span key={g.grantId} className="iam-grant">
                        <span style={{ font: "400 12px var(--font-body)", color: "var(--text-primary)" }}>
                          {g.role}
                          <span className="iam-role__scope">
                            {g.scopeType === "org_unit" ? ` @ ${g.scopeId}` : g.scopeType === "company" ? " @ company" : ` @ ${g.scopeType}`}
                          </span>
                        </span>
                        {/* Provenance is the whole reason to show this list: a position-managed grant
                            must not be hand-revoked, so it is LABELLED rather than merely listed. */}
                        <span className="iam-grant__source">{GRANT_SOURCE_LABEL[g.source]}</span>
                        {g.expiresAt ? (
                          <span className="iam-grant__expiry">expires {new Date(g.expiresAt).toLocaleDateString("en-GB")}</span>
                        ) : null}
                      </span>
                    ))}
                  </span>
                ),
                canGrant ? (
                  <PersonAccess
                    key="a"
                    userId={uid}
                    personLabel={m?.name ?? uid}
                    roleOptions={roleOptions}
                    unitOptions={unitOptions}
                    canGrant={canGrant}
                    grantRole={grantRole}
                    requestOverride={requestOverride}
                  />
                ) : (
                  ""
                ),
              ];
            })}
            tcols="1.2fr 2fr 1.6fr"
          />
        )}
      </Card>

      <div className="iam-scope-note" style={{ marginTop: 16 }}>
        <strong>Scope-level, deliberately.</strong>
        <span>
          This page says which roles a person holds and at what scope. It does NOT say whether they can
          act on a particular document or project — that depends on the resource itself and is decided
          per request. A page that claimed otherwise would be confidently wrong some of the time.
        </span>
      </div>

      {canGrant && holders.length > 0 ? (
        <Card title="Remove someone from a seat" style={{ marginTop: 16 }}>
          <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 0 }}>
            Removing a placement revokes the grants that only that seat justified. A grant a second seat
            also justifies survives, with its reference count decremented.
          </p>
          <IamAction
            label="Remove from seat"
            title="Remove a placement"
            fields={[
              {
                name: "positionId",
                label: "Seat",
                type: "select",
                required: true,
                options: positions.filter((p) => p.currentHolders > 0).map((p) => ({ value: p.id, label: `${p.title} (${p.unitNodeId})` })),
              },
              {
                name: "userId",
                label: "Person",
                type: "select",
                required: true,
                options: members.map((m) => ({ value: m.user_id, label: `${m.name} (${m.email})` })),
              },
            ]}
            action={unassignPosition}
            confirm="Remove this placement? Grants justified only by this seat are revoked."
          />
        </Card>
      ) : null}
    </>
  );
}
