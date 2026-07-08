import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getSystemStatus, getHubTools, getSystemConfig } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge, HairlineTable } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { ConnectionState } from "@/components/systems/ConnectionState";

// Hub is a global service (not tenant-scoped) — it fronts tool access for
// every tenant via OBO-minted principals, so its console applies platform-wide.
export default async function HubSystemPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const [status, tools, config] = await Promise.all([
    getSystemStatus(userId, "hub"),
    getHubTools(userId),
    getSystemConfig(userId, "hub"),
  ]);

  // Per-principal tool-visibility policy, if the admin API surfaces it as a
  // config field — shown read-only for now; editing arrives with a later task.
  const visibilityField = config.find((f) => f.key === "toolVisibilityPolicy" || f.key === "principalVisibility");

  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="MCP Hub"
        subtitle="Deny-by-default tool access for every principal — OBO identity minting, per-principal tool visibility, and a JSONL audit trail."
      />

      <StatusCard status={status} />

      <div style={{ marginTop: 20 }}>
        <Card title="Tool registry">
          {tools.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Tool" }, { label: "Description" }, { label: "Min assurance" }]}
              rows={tools.map((tool) => [
                tool.name,
                tool.description,
                <StatusBadge key="assurance" label={tool.minAssurance} />,
              ])}
            />
          ) : (
            <ConnectionState system="MCP Hub tool registry" />
          )}
        </Card>
      </div>

      {visibilityField && (
        <div style={{ marginTop: 20 }}>
          <Card title="Per-principal tool visibility">
            <DescriptionList
              items={[{ label: visibilityField.label, value: String(visibilityField.value ?? "—") }]}
            />
            <p style={{ margin: "10px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
              Editing this policy arrives in a later task — shown read-only for now.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
