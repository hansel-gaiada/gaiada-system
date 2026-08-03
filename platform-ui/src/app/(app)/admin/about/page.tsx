import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { can } from "@/lib/rbac";
import { getActiveTenant } from "@/lib/tenant";
import { getAbout, uiBuild, uiFlags } from "@/lib/about-data";
import { isUnknownVersion, mismatchedServices, parseAppVersion, tagForVersion } from "@/lib/about";
import { PageHeader } from "@/components/PageHeader";
import { Card, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { HairlineTable } from "@/components/ui";

// Settings → About. Answers "what exactly is running here?" — the deployed app version, the build
// each service reports, and the runtime switches in effect. Read-only; elevated-only (the backend
// enforces it, this is the matching UI gate).
export const dynamic = "force-dynamic";

const SERVICE_LABEL: Record<string, string> = {
  bot: "WhatsApp / Telegram bot",
  gateway: "AI Gateway",
  hub: "MCP Hub",
  agents: "Agent runner",
  knowledge: "Knowledge service",
  automation: "Automation (n8n)",
};

export default async function AboutPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenantId = await getActiveTenant(me);
  if (!can(me, "admin.access", tenantId)) {
    return (
      <>
        <PageHeader eyebrow="Settings" title="About" />
        <EmptyNote>Software information is available to platform administrators only.</EmptyNote>
      </>
    );
  }

  const ui = uiBuild();
  const info = await getAbout(userId);
  const appVersion = info?.app.version ?? ui.version;
  const parsed = parseAppVersion(appVersion);
  const tag = tagForVersion(appVersion);
  const mismatches = info ? mismatchedServices(info) : [];

  const appItems = [
    {
      label: "App version",
      value: isUnknownVersion(appVersion) ? (
        <span>
          unknown{" "}
          <span style={{ color: "var(--erp-ink-60)" }}>
            — APP_VERSION is not set on this deployment
          </span>
        </span>
      ) : (
        appVersion
      ),
    },
    ...(tag ? [{ label: "Git tag", value: tag }] : []),
    ...(parsed
      ? [
          { label: "Stage", value: <StatusBadge label={parsed.stage.toLowerCase()} /> },
          { label: "Milestone", value: parsed.milestone },
          { label: "Release", value: parsed.release },
          { label: "Module bumps", value: `${parsed.moduleRef} (rev ${parsed.revision})` },
        ]
      : []),
    { label: "Origin site", value: info?.app.originSite ?? "—" },
  ];

  const runtimeItems = [
    { label: "UI build", value: isUnknownVersion(ui.version) ? "unknown" : ui.version },
    { label: "Next.js", value: ui.next },
    { label: "Node (UI)", value: ui.node },
    { label: "Node (platform)", value: info?.app.node ?? "—" },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="About"
        subtitle="What is actually deployed here — the app version, each service's reported build, and the runtime switches in effect."
      />

      {mismatches.length > 0 && (
        <p className="sys-empty-note" role="status" style={{ marginBottom: 14 }}>
          {mismatches.length} service{mismatches.length === 1 ? "" : "s"} report a different version
          than the platform. Per the versioning rules a disagreement means the running build is
          suspect — check for a container that was not recreated on the last deploy.
        </p>
      )}

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <Card title="Application">
          <DescriptionList items={appItems} />
        </Card>

        <Card title="Runtime">
          <DescriptionList items={runtimeItems} />
        </Card>

        <Card title="Switches">
          <DescriptionList
            items={uiFlags().map((f) => ({
              label: f.label,
              value: <StatusBadge label={f.on ? "on" : "off"} />,
            }))}
          />
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Services">
          {!info ? (
            <EmptyNote>
              The platform did not return software information — showing nothing rather than a
              guess.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Service" }, { label: "Version" }, { label: "Status", align: "right" }]}
              rows={info.services.map((s) => [
                SERVICE_LABEL[s.key] ?? s.key,
                s.version ?? <span style={{ color: "var(--erp-ink-60)" }}>unknown</span>,
                <StatusBadge key={s.key} label={s.reachable ? "ok" : "unreachable"} />,
              ])}
            />
          )}
        </Card>
      </div>

      {info && info.app.modules.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <Card title="Compiled-in modules">
            <p style={{ margin: 0, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {info.app.modules.map((m) => (
                <span key={m} className="type-eyebrow" style={{ border: "1px solid var(--erp-hairline)", padding: "4px 8px" }}>
                  {m}
                </span>
              ))}
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
