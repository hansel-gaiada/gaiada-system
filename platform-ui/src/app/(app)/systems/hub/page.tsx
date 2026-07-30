import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getSystemStatus, getHubTools, getHubDetail, getHubAudit } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge, KpiTile } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { HubToolsTable, HubAuditTable, HubResourcesTable, HubPromptsTable } from "@/components/systems/HubLists";
import "@/components/systems/systems.css";

// Hub is a global service (not tenant-scoped) — it fronts tool access for every tenant via
// OBO-minted principals, so its console applies platform-wide.
//
// The hub's job is deciding who may call what. That makes its accountability record (the decision
// audit) and its policy posture the primary content, not an afterthought: a tool list alone can't
// tell an operator whether Cerbos or the in-code fallback decided, or why a call was refused.

export default async function HubSystemPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; decision?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const sp = await searchParams;
  const sourceFilter = sp.source ?? "";
  const decisionFilter = sp.decision ?? "";

  const [status, tools, detail, audit] = await Promise.all([
    getSystemStatus(userId, "hub"),
    getHubTools(userId),
    getHubDetail(userId),
    getHubAudit(userId, 200),
  ]);

  const policy = detail?.policy;
  const limits = detail?.rateLimit;
  const transport = detail?.transport;

  const sources = [...new Set(tools.map((t) => t.source ?? "unknown"))].sort();
  const shownTools = sourceFilter ? tools.filter((t) => (t.source ?? "unknown") === sourceFilter) : tools;
  const shownAudit = decisionFilter ? audit.filter((a) => a.decision === decisionFilter) : audit;

  const denies = audit.filter((a) => a.decision === "deny").length;
  const writeTools = tools.filter((t) => t.write).length;

  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="MCP Hub"
        subtitle="Deny-by-default tool access for every principal — OBO identity minting, per-principal visibility, scoped automation accounts, and a decision audit for every call."
      />

      <StatusCard status={status} />

      {/* Which engine decided is the single most load-bearing fact about the hub. */}
      <div style={{ marginTop: 20 }}>
        <Card
          title="Authorization policy"
          headerRight={policy?.engine ? <StatusBadge label={policy.engine === "cerbos" ? "Cerbos authoritative" : "In-code fallback"} /> : undefined}
        >
          {policy ? (
            <>
              <div className="sys-status-card__counters" style={{ marginTop: 0 }}>
                <KpiTile label="Tools" value={String(tools.length)} foot={`${writeTools} write`} />
                <KpiTile label="Decisions logged" value={String(audit.length)} foot={`${denies} denied`} />
                <KpiTile label="Assurance floor" value={(policy.assuranceRanks ?? []).join(" < ") || "—"} />
                <KpiTile label="Revocation (D11)" value={policy.revocationCheck ? "On" : "Off"} />
              </div>
              <div style={{ marginTop: 18 }}>
                <DescriptionList
                  items={[
                    { label: "Deny by default", value: policy.denyByDefault === false ? "No" : "Yes" },
                    { label: "Automation write gate", value: policy.automationWriteGate ?? "—" },
                    {
                      label: "Revocation cache TTL",
                      value: policy.revocationTtlMs ? `${Math.round(policy.revocationTtlMs / 1000)}s` : "—",
                    },
                  ]}
                />
              </div>
            </>
          ) : (
            <EmptyNote>Policy posture appears once the hub admin API is reachable.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Limits & transport">
          {limits || transport ? (
            <DescriptionList
              items={[
                {
                  label: "Rate limit — per principal",
                  value: limits?.perPrincipalPerMin
                    ? `${limits.perPrincipalPerMin}/min (burst ${limits.perPrincipalBurst ?? "—"})`
                    : "—",
                },
                {
                  label: "Rate limit — per service token",
                  value: limits?.perServiceTokenPerMin
                    ? `${limits.perServiceTokenPerMin}/min (burst ${limits.perServiceTokenBurst ?? "—"})`
                    : "—",
                },
                { label: "mTLS mode", value: transport?.tlsMode ?? "—" },
                {
                  label: "Peer allowlist",
                  value: transport?.peerAllowlist?.length ? transport.peerAllowlist.join(", ") : "(none)",
                },
                { label: "Topology", value: transport?.topology ?? "—" },
                {
                  label: "Service auth",
                  value: <StatusBadge label={transport?.serviceAuthConfigured ? "Configured" : "Absent — rejects all"} />,
                },
              ]}
            />
          ) : (
            <EmptyNote>Limits appear once the hub admin API is reachable.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Tool registry" headerRight={<span className="sys-empty-note">{shownTools.length} of {tools.length}</span>}>
          {tools.length > 0 ? (
            <>
              {sources.length > 1 && (
                <div className="sys-filter-row">
                  <Link href="/systems/hub" className={`sys-filter${sourceFilter === "" ? " sys-filter--active" : ""}`}>
                    All sources
                  </Link>
                  {sources.map((s) => (
                    <Link
                      key={s}
                      href={`/systems/hub?source=${encodeURIComponent(s)}`}
                      className={`sys-filter${sourceFilter === s ? " sys-filter--active" : ""}`}
                    >
                      {s}
                    </Link>
                  ))}
                </div>
              )}
              <HubToolsTable
                tools={shownTools}
                emptyState={<EmptyNote>No tools registered under this source.</EmptyNote>}
              />
              {policy?.automationWriteGate && (
                <p className="sys-empty-note" style={{ marginTop: 12 }}>
                  Write gate: {policy.automationWriteGate}.
                </p>
              )}
            </>
          ) : (
            <HubToolsTable tools={shownTools} />
          )}
        </Card>
      </div>

      {/* The accountability record. Previously written to disk and readable nowhere. */}
      <div style={{ marginTop: 20 }}>
        <Card title="Decision audit" headerRight={<span className="sys-empty-note">{shownAudit.length} entries</span>}>
          <div className="sys-filter-row">
            {[
              { key: "", label: "All" },
              { key: "allow", label: "Allowed" },
              { key: "deny", label: "Denied" },
            ].map((d) => (
              <Link
                key={d.key || "all"}
                href={auditHref(sourceFilter, d.key)}
                className={`sys-filter${decisionFilter === d.key ? " sys-filter--active" : ""}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <HubAuditTable audit={shownAudit} hasUnfilteredEntries={audit.length > 0} />
        </Card>
      </div>

      {/* Least-privilege matrix: what each n8n workflow's scoped service account may call. */}
      <div style={{ marginTop: 20 }}>
        <Card title="Automation scopes">
          {detail?.workflowScopes && detail.workflowScopes.length > 0 ? (
            <ul className="sys-scope-list">
              {detail.workflowScopes.map((w) => (
                <li key={w.workflow} className="sys-scope-list__item">
                  <div className="sys-scope-list__name">{w.workflow}</div>
                  <p className="sys-scope-list__tools">{w.tools.join(" · ") || "(no tools — denied everything)"}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote>Workflow scopes appear once the hub admin API is reachable.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Resources">
          <HubResourcesTable resources={detail?.resources ?? []} />
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Prompts">
          <HubPromptsTable prompts={detail?.prompts ?? []} />
        </Card>
      </div>
    </>
  );
}

function auditHref(source: string, decision: string): string {
  const qs = new URLSearchParams();
  if (source) qs.set("source", source);
  if (decision) qs.set("decision", decision);
  const s = qs.toString();
  return s ? `/systems/hub?${s}` : "/systems/hub";
}
