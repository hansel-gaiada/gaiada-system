import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getSystemStatus, getSystemConfig, getEgressAudit, getGatewayDetail } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge, KpiTile } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { ChainTable } from "@/components/systems/ChainTable";
import { DrModeCard } from "@/components/systems/DrModeCard";
import { OverridableConfigField } from "@/components/systems/OverridableConfigField";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { GatewayProvidersTable, GatewayAuditTable, GatewayTenantSpendTable } from "@/components/systems/GatewayLists";
import { updateGatewayConfig, revertGatewayConfigField, toggleDrMode } from "./actions";

// Gateway is a global service (not tenant-scoped) — every provider AI call in the platform funnels
// through it, so its config/audit surfaces apply across all tenants, not to one.
//
// The console reports three things an operator actually acts on: WHERE calls are going (the
// failover chain and each provider's breaker state), WHAT they cost (budget, per tenant), and WHAT
// was blocked and why (the egress audit's block taxonomy). Provider keys are never rendered.

const CAPABILITIES = ["llm", "media", "embed"];
const DECISIONS = [
  { key: "", label: "All" },
  { key: "allow", label: "Allowed" },
  { key: "blocked", label: "Blocked" },
  { key: "dlp", label: "DLP" },
  { key: "budget", label: "Budget" },
  { key: "rate_limit", label: "Rate limit" },
  { key: "timeout", label: "Timeout" },
  { key: "provider_error", label: "Provider error" },
  { key: "auth", label: "Auth" },
];

export default async function GatewaySystemPage({
  searchParams,
}: {
  searchParams: Promise<{ decision?: string; capability?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const sp = await searchParams;
  const decision = sp.decision ?? "";
  const capability = sp.capability ?? "";

  const [me, status, config, detail, audit] = await Promise.all([
    getMe(userId),
    getSystemStatus(userId, "gateway"),
    getSystemConfig(userId, "gateway"),
    getGatewayDetail(userId),
    getEgressAudit(userId, { limit: 200, decision: decision || undefined, capability: capability || undefined }),
  ]);

  const elevated = isElevated(me);
  const budget = detail?.budget;
  const security = detail?.security;
  const tenantSpend = Object.entries(budget?.tenants ?? {}).sort((a, b) => b[1] - a[1]);

  // `providers` and `llmChain` are the same underlying value: one is the read-only ordered-list
  // rendering (its own card above), the other the writable text field. Showing both in the
  // Configuration card would read as two different settings that happen to agree.
  const configFields = config.filter((f) => f.key !== "providers");
  const overridden = detail?.overriddenKeys ?? {};

  // Secrets (provider API keys) are NEVER rendered with their value — only whether one is present.
  // This is the one hard rule on this page. The partition is "read-only = everything that isn't an
  // editable non-secret", so a non-secret non-editable field can't fall through the cracks.
  const readOnlyItems: { label: string; value: ReactNode }[] = configFields
    .filter((f) => !(f.editable && f.kind !== "secretPresence"))
    .map((f) => ({
      label: f.label,
      value:
        f.kind === "secretPresence" ? (
          <StatusBadge label={f.value ? "Configured" : "Absent"} />
        ) : f.kind === "boolean" ? (
          f.value ? "On" : "Off"
        ) : Array.isArray(f.value) ? (
          f.value.join(" → ")
        ) : (
          String(f.value ?? "—")
        ),
    }));

  // `editable` is set by the BACKEND from the gateway's own writableKeys allowlist, so this page
  // never offers a save the gateway would refuse — and an older gateway with no write route yields a
  // fully read-only card automatically.
  const editableFields = configFields.filter((f) => f.editable && f.kind !== "secretPresence");

  const capPct =
    budget?.effectiveCap && budget.effectiveCap > 0 ? Math.round(((budget.used ?? 0) / budget.effectiveCap) * 100) : null;

  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="AI Gateway"
        subtitle="The chokepoint for every provider AI call — failover chain, DLP, daily budget and egress audit. Provider keys are never shown, only whether one is configured."
      />

      <StatusCard status={status} />

      {/* Spend first: it is the only thing here that degrades the whole platform when exhausted. */}
      <div style={{ marginTop: 20 }}>
        <Card
          title="Budget"
          headerRight={budget?.day ? <StatusBadge label={`day ${budget.day}`} /> : undefined}
        >
          {budget ? (
            <>
              <div className="sys-status-card__counters" style={{ marginTop: 0 }}>
                <KpiTile
                  label="Calls today"
                  value={String(budget.used ?? 0)}
                  foot={capPct !== null ? `${capPct}% of the effective cap` : undefined}
                />
                <KpiTile label="Daily cap" value={String(budget.cap ?? "—")} hint="Provider CALLS allowed per day across the whole platform — not tokens, not currency. Set by GATEWAY_DAILY_CALL_CAP; the gateway refuses further calls once it is reached." />
                <KpiTile
                  label="Effective cap"
                  value={String(budget.effectiveCap ?? budget.cap ?? "—")}
                  foot={budget.drActive ? "raised by DR burst" : undefined}
                />
                <KpiTile label="Per-tenant cap" value={String(budget.perTenantCap ?? "—")} hint="Per-company share of the daily call budget, so one tenant cannot consume the platform ceiling alone. “—” means none is configured and only the platform cap applies." />
              </div>
              <div style={{ marginTop: 18 }}>
                <GatewayTenantSpendTable tenantSpend={tenantSpend} perTenantCap={budget.perTenantCap} />
              </div>
            </>
          ) : (
            <EmptyNote>Budget detail appears once the gateway admin API is reachable.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <DrModeCard
          budget={budget}
          drBurstCap={detail?.topology?.drBurstCap}
          drDurationMinutes={detail?.topology?.drDurationMinutes}
          action={toggleDrMode}
          canEdit={elevated}
        />
      </div>

      {/* One chain per capability — they fail over independently. */}
      {CAPABILITIES.map((cap) => (
        <div key={cap} style={{ marginTop: 20 }}>
          <ChainTable
            title={`${cap === "llm" ? "LLM" : cap === "media" ? "Media" : "Embedding"} failover chain`}
            chain={detail?.chains?.[cap as "llm" | "media" | "embed"]}
            note={
              cap === "llm" && detail?.reliability
                ? `Breaker opens after ${detail.reliability.breakerThreshold} consecutive failures and cools down for ` +
                  `${Math.round((detail.reliability.breakerCooldownMs ?? 0) / 1000)}s; each attempt is capped at ` +
                  `${Math.round((detail.reliability.providerTimeoutMs ?? 0) / 1000)}s.`
                : undefined
            }
          />
        </div>
      ))}

      <div style={{ marginTop: 20 }}>
        <Card title="Providers">
          <GatewayProvidersTable providers={detail?.providers ?? []} />
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card
          title="Data-loss prevention"
          headerRight={
            security ? (
              <StatusBadge label={security.dlpClassifierEnabled ? "Classifier on" : "Regex only"} />
            ) : undefined
          }
        >
          {security ? (
            <DescriptionList
              items={[
                { label: "Model-assisted classifier", value: security.dlpClassifierEnabled ? "Enabled" : "Disabled" },
                { label: "Classifier model", value: security.dlpClassifierModel ?? "—" },
                {
                  label: "Classifier reachable",
                  value: security.dlpClassifierEnabled ? (
                    <StatusBadge label={security.classifierReachable ? "Reachable" : "Unreachable"} />
                  ) : (
                    "—"
                  ),
                },
                { label: "Internal TLS mode", value: security.tlsMode ?? "—" },
                {
                  label: "Egress allowlist",
                  value:
                    security.egressAllowlist && security.egressAllowlist.length > 0
                      ? security.egressAllowlist.join(", ")
                      : "(none — outbound hosts are unrestricted)",
                },
              ]}
            />
          ) : (
            <EmptyNote>Security posture appears once the gateway admin API is reachable.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card
          title="Configuration"
          headerRight={
            editableFields.length === 0 && config.length > 0 ? <StatusBadge label="read-only" /> : undefined
          }
        >
          {config.length === 0 ? (
            <EmptyNote>Configuration appears once the gateway admin API is connected.</EmptyNote>
          ) : (
            <>
              {editableFields.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  {editableFields.map((field) => (
                    <OverridableConfigField
                      key={field.key}
                      field={field}
                      overridden={overridden[field.key]}
                      action={updateGatewayConfig.bind(null, field.key)}
                      revertAction={revertGatewayConfigField.bind(null, field.key)}
                    />
                  ))}
                  <p className="sys-empty-note">
                    Saved values are applied immediately and persist across restarts as overrides on top of the
                    environment. Credentials, the egress allowlist, TLS mode and topology stay environment-only —
                    a console session must not be able to widen the gateway&apos;s own security boundary.
                  </p>
                </div>
              )}
              {readOnlyItems.length > 0 && <DescriptionList items={readOnlyItems} />}
            </>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card
          title="Egress audit"
          headerRight={<span className="sys-empty-note">{audit.length} entries</span>}
        >
          {/* Filters are links, not client state: the page stays a server component and a filtered
              view is shareable/bookmarkable. */}
          <div className="sys-filter-row">
            {DECISIONS.map((d) => (
              <Link
                key={d.key || "all"}
                href={filterHref(d.key, capability)}
                className={`sys-filter${decision === d.key ? " sys-filter--active" : ""}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="sys-filter-row">
            {["", ...CAPABILITIES].map((c) => (
              <Link
                key={c || "any"}
                href={filterHref(decision, c)}
                className={`sys-filter${capability === c ? " sys-filter--active" : ""}`}
              >
                {c === "" ? "Any capability" : c}
              </Link>
            ))}
          </div>
          <GatewayAuditTable audit={audit} hasFilter={Boolean(decision || capability)} />
        </Card>
      </div>
    </>
  );
}

/** Build a filter link that preserves the other axis. */
function filterHref(decision: string, capability: string): string {
  const qs = new URLSearchParams();
  if (decision) qs.set("decision", decision);
  if (capability) qs.set("capability", capability);
  const s = qs.toString();
  return s ? `/systems/gateway?${s}` : "/systems/gateway";
}
