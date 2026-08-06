import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getApprovalDetailAcrossTenants, type ApprovalDetail } from "@/lib/approvals";
import { decideApprovalItem, type ApprovalDecideOrigin } from "../../actions";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { MailThreadPanel } from "@/components/mail/MailThreadPanel";
import { formatDateTime } from "@/lib/format";

// APPR-01 — the per-approval detail route emailed approval links actually land on now. Before
// this ticket, `entityHref()` mapped `automation_approval`/`agency_approval` to the bare
// `/approvals` LIST (confirmed gap, mail.ts's own header) — a decider clicking the emailed link
// had to hunt for the row. This page resolves the id against BOTH backing tables
// (`getApprovalDetail`, `lib/approvals.ts`) since the url carries only an id, renders the item's
// full context + a decide form (routed through the SAME `POST /api/:t/approvals/:id/decide`
// façade the unified inbox already uses — no new authorization model), and embeds the
// `MailThreadPanel` (MAIL-15's deferred embed — it had nowhere to live until this route existed).
//
// A caller who cannot READ this item gets the same 403 the unified inbox's per-origin leg would
// give it (propagated from `getApprovalDetail`, not swallowed) — `limitedState()` below, not a
// blank page and not a 404 (a 404 would misreport "doesn't exist" for something that does).
//
// MAIL-34 defect 2 — this used to resolve the tenant from `getActiveTenant(me)` alone, so a
// platform_admin/group_executive following a mail-log deep link got a false 404 whenever their
// active company differed from the approval's own tenant (reproduced live: an approval on "Gaia
// Digital Agency" 404'd with "Sanur Resort" active, loaded fine after switching). Chosen fix, of
// the three the ticket weighed:
//   - REJECTED: auto-switch the active company as a side effect of viewing a link — a visible,
//     surprising mutation of session state for something that should just render.
//   - REJECTED (as the DEFAULT): keep active-company scope, show a "belongs to «company» — switch
//     to view" affordance — adds a click for exactly the audience (an elevated cross-tenant admin
//     who is most likely to click a mail-log link) M11 says a valid session should carry straight
//     through for.
//   - CHOSEN: resolve the tenant from the entity itself (`getApprovalDetailAcrossTenants`, tried
//     against every tenant the caller already holds an active membership in — never wider than
//     that) and render it directly, without touching the active-company cookie. A lightweight,
//     non-blocking banner below still NAMES the owning company when it differs from the active
//     one (borrowing the transparency the rejected affordance offered) — orientation, not friction.
// Access is not widened by this: each candidate tenant hits the SAME per-tenant RLS-scoped read
// the direct URL always used, so an unauthorized caller still gets a real refusal (see
// `getApprovalDetailAcrossTenants`'s own header for why a wrong tenant can only ever 404 and the
// right one can only ever answer with the row or a genuine 403).
function limitedState() {
  return (
    <>
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Approvals", href: "/approvals" }, { label: "Not available" }]} />
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
          You don&apos;t have access to this approval. If you believe this is wrong, ask an admin
          to check your role.
        </p>
      </Card>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ font: "500 11px var(--font-body)", color: "var(--ink-subtle)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ font: "400 14px var(--font-body)", marginTop: 2 }}>{children}</div>
    </div>
  );
}

function titleFor(detail: ApprovalDetail): string {
  return detail.kind === "automation_approval" ? (detail.data.reason ?? `${detail.data.toolName} (${detail.data.workflowId})`) : detail.data.subject;
}

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/approvals");

  // MAIL-34 defect 2 — tries the active tenant first (zero extra cost in the common, same-company
  // case), then every OTHER tenant the caller already holds an active membership in. See this
  // file's header comment + `getApprovalDetailAcrossTenants`'s own for why this cannot widen
  // access: each candidate hits the identical per-tenant RLS-scoped read a direct URL would.
  const candidateTenants = [tenant, ...me.companies.map((c) => c.id)];
  let resolved: { tenantId: string; detail: ApprovalDetail } | null;
  try {
    resolved = await getApprovalDetailAcrossTenants(userId, candidateTenants, id);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return limitedState();
    throw e;
  }
  if (!resolved) notFound();
  const { tenantId: resolvedTenant, detail } = resolved;
  const crossTenant = resolvedTenant !== tenant;
  const resolvedCompanyName = crossTenant ? me.companies.find((c) => c.id === resolvedTenant)?.name ?? null : null;

  const mayDecide = can(me, "approvals.decide", resolvedTenant) && detail.data.status === "pending";

  // Hidden fields carry everything the façade needs (mirrors `pipeline/[runId]/page.tsx`'s
  // GateRow — `runId`/`gateId` hidden inputs, not a closure over the fetched row) so this action
  // doesn't serialize `detail`/`tenant` into the form's server-action reference.
  async function onDecide(formData: FormData) {
    "use server";
    const decision = formData.get("decision");
    if (decision !== "approved" && decision !== "rejected") return;
    const note = formData.get("note");
    const decideOrigin = String(formData.get("origin") ?? "") as ApprovalDecideOrigin;
    const approvalId = String(formData.get("approvalId") ?? "");
    const decideTenant = String(formData.get("tenantId") ?? "");
    if (!decideOrigin || !approvalId || !decideTenant) return;
    await decideApprovalItem(decideTenant, decideOrigin, approvalId, decision, typeof note === "string" && note ? note : undefined);
  }

  const title = titleFor(detail);
  // "automation_approval" carries three real sub-origins (automation/agent/hr); the mail entity
  // type stays constant while `detail.origin` is what the decide façade and the thread panel both
  // need — mirrors the unified inbox's own origin field, never re-derived differently here.
  const entityType = detail.kind;

  return (
    <>
      <div style={{ marginBottom: 22 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Approvals", href: "/approvals" }, { label: title }]} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Eyebrow style={{ color: "var(--erp-accent)" }}>
            {detail.kind === "automation_approval" ? detail.origin : "Agency"}
          </Eyebrow>
          <StatusBadge label={detail.data.status.replace(/_/g, " ")} />
        </div>
        <h1 style={{ margin: "6px 0 0", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 30, lineHeight: 1.1 }}>
          {title}
        </h1>
        <p style={{ margin: "8px 0 0", font: "400 13px var(--font-body)", color: "var(--ink-subtle)" }}>
          Requested {formatDateTime(detail.data.createdAt)}
        </p>
        {/* MAIL-34 defect 2 — orientation, not friction: this item is being rendered against ITS
            OWN tenant (`resolvedTenant`), which may differ from the sidebar's active-company
            selector. Named here so that difference is never a silent surprise, without forcing an
            extra click before the caller can act on it. */}
        {crossTenant && resolvedCompanyName && (
          <p style={{ margin: "8px 0 0", font: "400 13px var(--font-body)", color: "var(--ink-subtle)" }}>
            This approval belongs to <strong style={{ color: "var(--ink)" }}>{resolvedCompanyName}</strong>,
            not your active company — showing it directly.
          </p>
        )}
      </div>

      <div style={{ display: "grid", gap: 22 }}>
        <Card title="Overview">
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {detail.kind === "automation_approval" ? (
              <>
                <Field label="Workflow">{detail.data.workflowId}</Field>
                <Field label="Tool">{detail.data.toolName}</Field>
                <Field label="Impact"><StatusBadge label={detail.data.impact} /></Field>
                {detail.data.agentName && <Field label="Agent">{detail.data.agentName}</Field>}
                <Field label="Requested by">{detail.data.requestedByName ?? detail.data.requestedBy ?? "—"}</Field>
                {detail.data.status !== "pending" && (
                  <Field label="Decided by">{detail.data.decidedByName ?? detail.data.decidedBy ?? "—"}{detail.data.decidedAt ? ` · ${formatDateTime(detail.data.decidedAt)}` : ""}</Field>
                )}
                {detail.data.executionStatus && detail.data.executionStatus !== "not_applicable" && (
                  <Field label="Execution">
                    {detail.data.executionStatus}
                    {detail.data.executionError ? ` — ${detail.data.executionError}` : ""}
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label="Campaign">{detail.data.campaign}</Field>
                <Field label="Requested by">{detail.data.requestedByName ?? detail.data.requestedBy ?? "—"}</Field>
                {detail.data.status !== "pending" && (
                  <Field label="Decided by">{detail.data.decidedByName ?? detail.data.decidedBy ?? "—"}{detail.data.decidedAt ? ` · ${formatDateTime(detail.data.decidedAt)}` : ""}</Field>
                )}
              </>
            )}
          </div>
        </Card>

        {mayDecide && (
          <Card title="Decide">
            <form action={onDecide} style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <input type="hidden" name="tenantId" value={resolvedTenant} />
              <input type="hidden" name="approvalId" value={detail.data.id} />
              <input type="hidden" name="origin" value={detail.origin} />
              <label style={{ display: "grid", gap: 4, flex: "1 1 260px" }}>
                <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-subtle)" }}>Note (optional)</span>
                <input type="text" name="note" placeholder="Add a note for the record" />
              </label>
              <button type="submit" name="decision" value="approved" className="btn btn-primary" style={{ fontSize: 13 }}>Approve</button>
              <button type="submit" name="decision" value="rejected" className="btn" style={{ fontSize: 13 }}>Deny</button>
            </form>
          </Card>
        )}

        {/* APPR-01 — MAIL-15's deferred embed lands here: the entity-scoped thread panel had
            nowhere to live until this detail route existed. Self-contained (fetches its own data,
            authorized against THIS entity per A10, absence-degrades to empty on 404/405). */}
        <MailThreadPanel userId={userId} tenantId={resolvedTenant} entityType={entityType} entityId={detail.data.id} />
      </div>
    </>
  );
}
