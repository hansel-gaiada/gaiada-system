import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getSystemStatus, getSystemConfig, getEgressAudit } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge, HairlineTable } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { ConfigField } from "@/components/systems/ConfigField";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { updateGatewayConfig } from "./actions";

// Gateway is a global service (not tenant-scoped) — every provider AI call in
// the platform funnels through it, so its config/audit surfaces apply across
// all tenants, not to one.
export default async function GatewaySystemPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const [status, config, audit] = await Promise.all([
    getSystemStatus(userId, "gateway"),
    getSystemConfig(userId, "gateway"),
    getEgressAudit(userId),
  ]);

  // `providers` (provider chain order) gets its own read-only ordered-list
  // rendering per the plan, in addition to whatever generic Field it also
  // renders as below if editable.
  const providersField = config.find((f) => f.key === "providers");
  const providerChainValue = providersField?.value;
  const providerChain = Array.isArray(providerChainValue)
    ? (providerChainValue as unknown[]).map((p) => String(p).trim()).filter(Boolean)
    : typeof providerChainValue === "string" && providerChainValue.length > 0
      ? providerChainValue.split(",").map((p) => p.trim()).filter(Boolean)
      : [];

  // Secrets (provider API keys) are NEVER rendered with their value — only
  // whether one is present. This is the one hard rule on this page. Mirrors
  // the bot page's partition: read-only = everything that isn't editable
  // non-secret, so a non-secret non-editable field doesn't fall through the
  // cracks.
  const readOnlyItems: { label: string; value: ReactNode }[] = config
    .filter((f) => !(f.editable && f.kind !== "secretPresence"))
    .map((f) => ({
      label: f.label,
      value:
        f.kind === "secretPresence" ? (
          <StatusBadge label={f.value ? "Configured" : "Absent"} />
        ) : f.kind === "boolean" ? (
          f.value ? "On" : "Off"
        ) : (
          String(f.value ?? "—")
        ),
    }));

  const editableFields = config.filter((f) => f.editable && f.kind !== "secretPresence");

  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="AI Gateway"
        subtitle="The chokepoint for every provider AI call — failover chain, DLP, daily cost cap and egress audit. Provider keys are never shown, only whether one is configured."
      />

      <StatusCard status={status} />

      <div style={{ marginTop: 20 }}>
        <Card title="Provider chain">
          {providerChain.length > 0 ? (
            <ol style={{ margin: 0, paddingLeft: 20, font: "400 14px/1.7 var(--font-body)" }}>
              {providerChain.map((p, i) => (
                <li key={`${p}-${i}`}>{p}</li>
              ))}
            </ol>
          ) : (
            <EmptyNote>Provider chain order appears once the gateway admin API is connected.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Configuration">
          {config.length === 0 ? (
            <EmptyNote>Configuration appears once the gateway admin API is connected.</EmptyNote>
          ) : (
            <>
              {readOnlyItems.length > 0 && <DescriptionList items={readOnlyItems} />}
              {editableFields.length > 0 && (
                <div style={{ marginTop: readOnlyItems.length > 0 ? 20 : 0 }}>
                  {editableFields.map((field) => (
                    <ConfigField key={field.key} field={field} action={updateGatewayConfig.bind(null, field.key)} />
                  ))}
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Egress audit">
          {audit.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Time" }, { label: "Provider" }, { label: "Decision" }, { label: "Detail" }]}
              rows={audit.map((row, i) => [
                row.time,
                row.provider ?? "—",
                <StatusBadge key={`decision-${i}`} label={row.decision ?? "unknown"} />,
                row.detail ?? "—",
              ])}
            />
          ) : (
            <EmptyNote>Egress audit appears once the gateway admin API is connected.</EmptyNote>
          )}
        </Card>
      </div>
    </>
  );
}
