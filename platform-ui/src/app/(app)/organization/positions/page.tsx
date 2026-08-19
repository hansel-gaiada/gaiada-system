import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, isElevated } from "@/lib/rbac";
import { listMembers } from "@/lib/entities";
import { getOrgStructure, flattenOrgUnits } from "@/lib/org";
import { listPositions, listAttachableRoles, sortPositions, type Position } from "@/lib/iam";
import {
  attachRole, detachRole, assignPosition, requestAssignment, updatePosition, retirePosition, createPosition,
} from "@/lib/iamActions";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { IamAction } from "@/components/iam/IamAction";
import { PositionRow } from "@/components/iam/PositionRow";
import "@/components/iam/iam.css";

// P2-12-FE — the positions admin. Design §2.2/§2.3 (the seat + its role-set template), §3.3 (orphans),
// §7 (the ui_grantable allow-list).
//
// ⚠ THE COMPOSER NEVER FILTERS. `GET /positions/attachable-roles` returns unattachable roles WITH a
// reason, and they are rendered disabled-with-reason rather than dropped. Three layers bound a role-set
// (Cerbos, the ui_grantable allow-list, and 0109's DB trigger) and the server owns all three; a UI that
// silently omitted the refusals would turn a stated boundary into an invisible one, and the next person
// to ask "why can't I attach platform_admin?" would have no answer in front of them.
//
// ⚠ `scope` FROM THE SERVER IS NOT COSMETIC. `subtree` means the list was narrowed to the caller's own
// lead units. Rendering a narrowed list as if it were the whole company would tell a department head
// that seats they cannot see do not exist. The banner says which they are looking at.

export default async function PositionsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // `getOrgStructure` wants the COMPANY, not the viewer — same resolution admin/users/page.tsx uses.
  const company = me.companies.find((c) => c.id === tenant) ?? { id: tenant, name: tenant, type: null };
  const [{ positions, scope }, roles, members, org] = await Promise.all([
    listPositions(userId, tenant),
    listAttachableRoles(userId, tenant),
    listMembers(userId, tenant).catch(() => []),
    getOrgStructure(userId, tenant, company),
  ]);

  // `scope === null` means the read was refused or failed. Positions are not a security finding when
  // absent (unlike the IT worklist), so an empty state is honest — but "refused" and "none defined" are
  // still different sentences.
  if (scope === null) {
    return (
      <>
        <PageHeader
          eyebrow="Organization"
          title="Positions"
          breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Positions" }]}
        />
        <EmptyNote>
          You don&apos;t have access to the position registry for this company, or it could not be read.
        </EmptyNote>
      </>
    );
  }

  const unitOptions = flattenOrgUnits(org.structure).map((u) => ({
    value: u.id,
    label: `${"— ".repeat(Math.max(0, u.depth - 1))}${u.name}`,
  }));
  const roleOptions = roles.map((r) => ({
    value: r.roleId,
    label: r.role,
    disabled: !r.attachable,
    // The reason is shown, not swallowed — see the header.
    hint: r.attachable ? undefined : r.reason ?? "not attachable",
  }));
  const memberOptions = members.map((m) => ({ value: m.user_id, label: `${m.name} (${m.email})` }));

  // `org.edit` is the capability that owns the org chart (lib/rbac.ts) — there is no `org.manage`.
  // The SERVER is the boundary either way (`position · create/update/retire` in Cerbos); this only
  // decides whether to render controls that would 403.
  const canCompose = can(me, "org.edit", tenant) || isElevated(me);
  const canPlace = canCompose || can(me, "people.directory", tenant);

  const active = positions.filter((p) => p.status === "active");
  const vacant = active.filter((p) => p.currentHolders === 0);
  const orphaned = positions.filter((p) => p.orphaned);
  const noRoleSet = active.filter((p) => p.roleSet.length === 0);
  const shown = sortPositions(positions);

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Positions"
        subtitle="Seats in the org chart. A seat's role-set is what its holder's access follows."
        breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Positions" }]}
      />

      {scope === "subtree" ? (
        <div className="iam-scope-note">
          <strong>Your departments only.</strong>
          <span>
            You are seeing the seats inside the units you lead. Seats elsewhere in the company exist but
            are not shown — this is not the whole registry.
          </span>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="Active seats" value={String(active.length)} />
        <KpiTile label="Vacant" value={String(vacant.length)} foot="nobody placed" />
        <KpiTile label="No role-set" value={String(noRoleSet.length)} foot="confers nothing" />
        <KpiTile label="Orphaned" value={String(orphaned.length)} foot="unit deleted from the chart" />
      </div>

      {orphaned.length > 0 ? (
        <div className="iam-scope-note" style={{ marginBottom: 16 }}>
          <strong>{orphaned.length} orphaned seat(s).</strong>
          <span>
            Their org-chart unit was deleted, so the reconciler has FROZEN their holders&apos; access
            rather than tearing it down. Move the seat to a live unit or retire it — leaving it frozen
            means those grants stop tracking reality.
          </span>
        </div>
      ) : null}

      <Card
        title="Seats"
        headerRight={
          canCompose ? (
            <IamAction
              label="New position"
              title="Create a position"
              variant="solid"
              fields={[
                { name: "title", label: "Title", required: true, placeholder: "e.g. Frontend Lead" },
                { name: "unitNodeId", label: "Org unit", type: "select", required: true, options: unitOptions },
                {
                  name: "isLead",
                  label: "Is the lead of that unit",
                  type: "select",
                  options: [
                    { value: "", label: "No" },
                    { value: "on", label: "Yes" },
                  ],
                  hint: "Display only. Lead AUTHORITY comes from attaching org_unit_lead to the role-set, never from this flag.",
                },
              ]}
              action={createPosition}
            />
          ) : undefined
        }
      >
        {shown.length === 0 ? (
          <EmptyNote>
            No positions defined yet. Until a seat exists, nobody can be placed and access cannot follow
            the org chart — every grant has to be made by hand.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Seat" },
              { label: "Role-set" },
              { label: "Holders", align: "right" },
              { label: "" },
            ]}
            rows={shown.map((p: Position) => [
              <span key="s" style={{ display: "grid", gap: 3 }}>
                <span style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ font: "400 13px var(--font-body)", color: "var(--text-primary)" }}>{p.title}</span>
                  {p.isLead ? <span className="iam-badge iam-badge--lead">lead</span> : null}
                  {p.orphaned ? <span className="iam-badge iam-badge--orphaned">orphaned</span> : null}
                  {p.status === "retired" ? <span className="iam-badge iam-badge--retired">retired</span> : null}
                  {p.status === "active" && p.currentHolders === 0 ? (
                    <span className="iam-badge iam-badge--vacant">vacant</span>
                  ) : null}
                </span>
                <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>{p.unitNodeId}</span>
              </span>,
              p.roleSet.length === 0 ? (
                // Stated in the row, not just counted in a tile: a seat with no role-set looks finished
                // in a list and confers nothing at all.
                <span key="r" className="iam-roleset--empty">confers no access — attach a role</span>
              ) : (
                <span key="r" className="iam-roleset">
                  {p.roleSet.map((r) => (
                    <span key={r.roleId} className="iam-role">
                      {r.role}
                      <span className="iam-role__scope">
                        {r.scopeKind === "own_unit" ? " @ unit" : " @ company"}
                      </span>
                    </span>
                  ))}
                </span>
              ),
              String(p.currentHolders),
              <PositionRow
                key="a"
                positionId={p.id}
                title={p.title}
                status={p.status}
                unitOptions={unitOptions}
                roleOptions={roleOptions}
                memberOptions={memberOptions}
                attachedRoles={p.roleSet.map((r) => ({ roleId: r.roleId, role: r.role }))}
                canCompose={canCompose}
                canPlace={canPlace}
                attachRole={attachRole}
                detachRole={detachRole}
                assignPosition={assignPosition}
                requestAssignment={requestAssignment}
                updatePosition={updatePosition}
                retirePosition={retirePosition}
              />,
            ])}
            tcols="1.5fr 2fr 0.5fr 2fr"
          />
        )}
      </Card>

      <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 14 }}>
        Who holds what, and the grants behind it, is on the{" "}
        <Link href="/organization/access" style={{ color: "var(--erp-accent)" }}>access page</Link>.
      </p>
    </>
  );
}
