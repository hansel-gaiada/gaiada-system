import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getSystemStatus, getSystemConfig } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, StatusBadge } from "@/components/ui";
import { StatusCard } from "@/components/systems/StatusCard";
import { ConfigField } from "@/components/systems/ConfigField";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { WhatsAppConnect } from "@/components/systems/WhatsAppConnect";
import { GroupRegistry, type BotGroupsSnapshot } from "@/components/systems/GroupRegistry";
import { ChatsTab } from "@/components/systems/ChatsTab";
import { LogsTab } from "@/components/systems/LogsTab";
import { ControlsTab } from "@/components/systems/ControlsTab";
import { BotTabs } from "@/components/systems/BotTabs";
import { updateBotConfig } from "./actions";
import { updateBotGroups, updateIgnoredGroups } from "./group-actions";
import { startBotSession, stopBotSession, restartBotSession, logoutBotSession } from "./session-actions";

// Server-side load for the Group registry surface (A6, doc §2.3/2.4). Fails
// soft to `null` — same convention as the rest of this page — so
// GroupRegistry renders its EmptyNote instead of throwing when the bot admin
// API is unconfigured/unreachable (404/502).
async function getBotGroups(userId: string): Promise<BotGroupsSnapshot | null> {
  try {
    return await platformFetch<BotGroupsSnapshot>("/api/admin/bot/groups", userId);
  } catch (e) {
    if (e instanceof PlatformError) return null;
    throw e;
  }
}

export default async function BotSystemPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const elevated = isElevated(me);

  const [status, config, groups] = await Promise.all([
    getSystemStatus(userId, "bot"),
    getSystemConfig(userId, "bot"),
    getBotGroups(userId),
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
        subtitle="Status, connection, chat viewer, group registry, logs and configuration for the WA-first messaging bot."
      />

      <StatusCard status={status} />

      <div style={{ marginTop: 20 }}>
        <BotTabs
          connect={
            <WhatsAppConnect
              elevated={elevated}
              startAction={startBotSession}
              stopAction={stopBotSession}
              restartAction={restartBotSession}
              logoutAction={logoutBotSession}
            />
          }
          controls={<ControlsTab elevated={elevated} />}
          chats={<ChatsTab elevated={elevated} />}
          groups={
            <GroupRegistry
              elevated={elevated}
              initial={groups}
              action={updateBotGroups}
              ignoreAction={updateIgnoredGroups}
            />
          }
          logs={<LogsTab elevated={elevated} />}
          config={
            <>
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

              <div style={{ marginTop: 20 }}>
                <Card title="Pipeline detail">
                  {detailRows.length > 0 ? (
                    <DescriptionList items={detailRows} />
                  ) : (
                    <EmptyNote>
                      Group registry, media pipeline and Telegram fallback details appear once the bot admin API is
                      connected.
                    </EmptyNote>
                  )}
                </Card>
              </div>
            </>
          }
        />
      </div>
    </>
  );
}
