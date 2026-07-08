import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getSystemStatus, getSystemConfig } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { ConfigField } from "@/components/systems/ConfigField";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { updateBotConfig } from "./actions";

export default async function BotSystemPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const [status, config] = await Promise.all([
    getSystemStatus(userId, "bot"),
    getSystemConfig(userId, "bot"),
  ]);

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

  const detail = status?.detail ?? {};
  const detailRows: { label: string; value: ReactNode }[] = [];
  if (detail.groups != null) detailRows.push({ label: "Group registry", value: String(detail.groups) });
  if (detail.media != null) detailRows.push({ label: "Media pipeline", value: String(detail.media) });
  if (detail.telegram != null) detailRows.push({ label: "Telegram fallback", value: String(detail.telegram) });

  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="WhatsApp / Telegram Bot"
        subtitle="Status, configuration and delivery health for the WA-first messaging bot. No message content is ever shown here."
      />

      <StatusCard status={status} />

      <div style={{ marginTop: 20 }}>
        <Card title="Configuration">
          {config.length === 0 ? (
            <EmptyNote>Configuration appears once the bot admin API is connected.</EmptyNote>
          ) : (
            <>
              {readOnlyItems.length > 0 && <DescriptionList items={readOnlyItems} />}
              {editableFields.length > 0 && (
                <div style={{ marginTop: readOnlyItems.length > 0 ? 20 : 0 }}>
                  {editableFields.map((field) => (
                    <ConfigField key={field.key} field={field} action={updateBotConfig.bind(null, field.key)} />
                  ))}
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Pipeline detail">
          {detailRows.length > 0 ? (
            <DescriptionList items={detailRows} />
          ) : (
            <EmptyNote>
              Group registry, media pipeline and Telegram fallback details appear once the bot admin API is connected.
            </EmptyNote>
          )}
        </Card>
      </div>
    </>
  );
}
