"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Button, Toast, StatusBadge, Eyebrow, HairlineTable } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { SearchableTable } from "./SearchableTable";
import { formatRelativeTime } from "@/lib/timeFormat";
import "./systems.css";

// Controls tab: the bot's safety + operations surface — the actions kill
// switch, manual digest runs, media-queue health, and the read-only skills
// catalog (frozen nest contract `/api/admin/bot/{actions,digests,media/status,
// skills}`), reached through this app's own no-store proxy routes exactly
// like LogsTab/ChatsTab. Self-contained: every path here already has its own
// route.ts proxy, so — unlike WhatsAppConnect — this component owns its own
// fetch+mutate cycle instead of taking server actions as page.tsx props.
//
// Turning actions OFF is the safe direction and fires on a single click.
// Turning them back ON re-arms the bot's ability to mutate real WhatsApp
// groups, so it is gated behind an explicit confirm step (mirrors
// WhatsAppConnect's logout confirm), and the displayed switch state is ALWAYS
// reconciled from the server's response — never flipped optimistically —
// because this is a real safety control, not a UI preference.

interface ActionsAuditPoll {
  enabled: boolean;
  entries: unknown[] | null;
  error?: string;
}

interface ActionsMutation {
  enabled: boolean | null;
  error?: string;
}

interface DigestRecord {
  ts: number;
  slot: "noon" | "evening";
  trigger: "scheduled" | "manual";
  groupsCovered: number;
  delivered: number;
  failed: number;
  managementDelivered: number;
  error?: string;
}

interface DigestsPoll {
  history: DigestRecord[] | null;
  nextRun: { noon: number | null; evening: number | null } | null;
  timezone: string | null;
  error?: string;
}

interface DigestRunResult {
  ok: boolean;
  started?: boolean;
  startedAt?: number;
  conflict?: boolean;
  error?: string;
}

interface GroupOption {
  id: string;
  name?: string;
}

interface GroupsForPreview {
  groups: GroupOption[] | null;
  discovered: GroupOption[] | null;
  error?: string;
}

interface DigestPreviewResult {
  chatId: string | null;
  digest: string | null;
  error?: string;
}

// The real digest run measured ~90s over 11 groups (each summarized through the AI gateway) —
// poll comfortably past that before giving up and telling the operator to check back later.
export const DIGEST_POLL_INTERVAL_MS = 5000;
export const DIGEST_POLL_MAX_ATTEMPTS = 30; // 30 * 5s = 150s bound

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MediaStatusPoll {
  queueEnabled: boolean | null;
  pending: number | null;
  oldestPendingTs: number | null;
  error?: string;
}

interface BotSkill {
  name: string;
  description: string;
}

interface SkillsPoll {
  commandPrefix: string | null;
  botMention: string | null;
  skills: BotSkill[] | null;
  error?: string;
}

// A pending-media item older than this reads as "stuck", not just "queued".
const STUCK_MEDIA_MS = 10 * 60 * 1000;

export function ControlsTab({ elevated }: { elevated: boolean }) {
  // -- Actions kill switch --
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [switchError, setSwitchError] = useState<string | undefined>();
  const [switchPending, setSwitchPending] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);

  // -- Digests --
  const [digests, setDigests] = useState<DigestsPoll | null>(null);
  const [digestsError, setDigestsError] = useState<string | undefined>();
  const [runningSlot, setRunningSlot] = useState<"noon" | "evening" | null>(null);
  const [runError, setRunError] = useState<string | undefined>();
  const [runNotice, setRunNotice] = useState<string | undefined>();

  // -- Digest preview (sends nothing) --
  const [groupOptions, setGroupOptions] = useState<GroupOption[] | null>(null);
  const [groupsError, setGroupsError] = useState<string | undefined>();
  const [previewChatId, setPreviewChatId] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | undefined>();

  // -- Media queue --
  const [media, setMedia] = useState<MediaStatusPoll | null>(null);
  const [mediaError, setMediaError] = useState<string | undefined>();

  // -- Bot capabilities (skills) --
  const [skills, setSkills] = useState<SkillsPoll | null>(null);
  const [skillsError, setSkillsError] = useState<string | undefined>();

  // `digests.history` is typed nullable at the field level (independent of
  // `digests` itself being null) because the proxy route's discriminator is
  // that field — but fetchDigests only ever calls setDigests(body) once it
  // has already checked `body.history != null`, so this is always populated
  // by the time `digests` is non-null. Derived here so JSX below never has to
  // re-narrow it.
  const historyList: DigestRecord[] = digests?.history ?? [];

  const fetchSwitch = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bot/actions/audit", { cache: "no-store" });
      const body = (await res.json()) as ActionsAuditPoll;
      if (!res.ok || body.entries == null) {
        setSwitchError(body.error ?? "Could not load the actions switch.");
        return;
      }
      setEnabled(body.enabled);
      setSwitchError(undefined);
    } catch {
      setSwitchError("Could not reach the bot admin proxy.");
    }
  }, []);

  // Returns the fetched body (or null on failure) so the "Run now" poll loop below can inspect
  // the freshly-read history for a new entry, without duplicating the fetch/parse logic.
  const fetchDigests = useCallback(async (): Promise<DigestsPoll | null> => {
    try {
      const res = await fetch("/api/admin/bot/digests", { cache: "no-store" });
      const body = (await res.json()) as DigestsPoll;
      if (!res.ok || body.history == null) {
        setDigestsError(body.error ?? "Could not load digest history.");
        return null;
      }
      setDigests(body);
      setDigestsError(undefined);
      return body;
    } catch {
      setDigestsError("Could not reach the bot admin proxy.");
      return null;
    }
  }, []);

  const fetchGroupOptions = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bot/digests/groups", { cache: "no-store" });
      const body = (await res.json()) as GroupsForPreview;
      if (!res.ok || (body.groups == null && body.discovered == null)) {
        setGroupsError(body.error ?? "Could not load the group list.");
        return;
      }
      const merged = [...(body.groups ?? []), ...(body.discovered ?? [])];
      setGroupOptions(merged.map((g) => ({ id: g.id, name: g.name || g.id })));
      setGroupsError(undefined);
    } catch {
      setGroupsError("Could not reach the bot admin proxy.");
    }
  }, []);

  const fetchMedia = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bot/media/status", { cache: "no-store" });
      const body = (await res.json()) as MediaStatusPoll;
      if (!res.ok || body.pending == null) {
        setMediaError(body.error ?? "Could not load media queue status.");
        return;
      }
      setMedia(body);
      setMediaError(undefined);
    } catch {
      setMediaError("Could not reach the bot admin proxy.");
    }
  }, []);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bot/skills", { cache: "no-store" });
      const body = (await res.json()) as SkillsPoll;
      if (!res.ok || body.skills == null) {
        setSkillsError(body.error ?? "Could not load the skills catalog.");
        return;
      }
      setSkills(body);
      setSkillsError(undefined);
    } catch {
      setSkillsError("Could not reach the bot admin proxy.");
    }
  }, []);

  useEffect(() => {
    if (!elevated) return;
    fetchSwitch();
    fetchDigests();
    fetchGroupOptions();
    fetchMedia();
    fetchSkills();
  }, [elevated, fetchSwitch, fetchDigests, fetchGroupOptions, fetchMedia, fetchSkills]);

  if (!elevated) {
    return (
      <Card title="Controls">
        <EmptyNote>Bot controls (kill switch, digests, media queue, skills) are limited to superadmins/owners.</EmptyNote>
      </Card>
    );
  }

  async function setActionsState(state: "on" | "off") {
    setSwitchPending(true);
    setConfirmOn(false);
    try {
      const res = await fetch(`/api/admin/bot/actions/${state}`, { method: "POST", cache: "no-store" });
      const body = (await res.json()) as ActionsMutation;
      if (!res.ok || body.enabled == null) {
        setSwitchError(body.error ?? "Could not change the actions switch.");
        return;
      }
      // Reconcile from the server's response only — never assume the flip took.
      setEnabled(body.enabled);
      setSwitchError(undefined);
    } catch {
      setSwitchError("Could not reach the bot admin proxy.");
    } finally {
      setSwitchPending(false);
    }
  }

  // Polls digest history until an entry newer than `baselineTs` for this slot shows up, or gives
  // up after DIGEST_POLL_MAX_ATTEMPTS. Returns the fresh entry (found) or null (gave up) — never
  // throws; a transient poll failure just costs one attempt out of the budget.
  async function waitForNewDigestEntry(slot: "noon" | "evening", baselineTs: number): Promise<DigestRecord | null> {
    for (let attempt = 0; attempt < DIGEST_POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(DIGEST_POLL_INTERVAL_MS);
      const body = await fetchDigests();
      const fresh = body?.history?.find((h) => h.slot === slot && h.ts > baselineTs);
      if (fresh) return fresh;
    }
    return null;
  }

  async function runDigest(slot: "noon" | "evening") {
    setRunningSlot(slot);
    setRunError(undefined);
    setRunNotice(undefined);
    const label = slot === "noon" ? "Noon" : "Evening";
    // The newest existing entry for this slot, so the poll below can tell "a fresh run landed"
    // apart from "the old one is still sitting there".
    const baselineTs = historyList.reduce((max, h) => (h.slot === slot && h.ts > max ? h.ts : max), 0);
    try {
      const res = await fetch(`/api/admin/bot/digests/run/${slot}`, { method: "POST", cache: "no-store" });
      const body = (await res.json()) as DigestRunResult;
      if (!res.ok || !body.ok) {
        setRunError(
          body.error ??
            (body.conflict ? `A ${slot} digest run is already in progress.` : `Could not start the ${slot} digest run.`),
        );
        return;
      }
      // Reports STARTED, not finished — the run itself can take well over a minute. The digest
      // history table (polled below) is the authoritative record of the eventual outcome.
      setRunNotice(`${label} digest run started — watching history for the result…`);
      const entry = await waitForNewDigestEntry(slot, baselineTs);
      if (entry) {
        setRunNotice(
          `${label} digest run finished — delivered ${entry.delivered}, failed ${entry.failed}` +
            (entry.error ? ` (error: ${entry.error}).` : "."),
        );
      } else {
        setRunNotice(`${label} digest run started but hasn't shown up in history yet — check back shortly.`);
      }
    } catch {
      setRunError("Could not reach the bot admin proxy.");
    } finally {
      setRunningSlot(null);
    }
  }

  async function runPreview() {
    if (!previewChatId) return;
    setPreviewLoading(true);
    setPreviewError(undefined);
    setPreviewText(null);
    try {
      const res = await fetch(`/api/admin/bot/digests/preview?chatId=${encodeURIComponent(previewChatId)}`, {
        cache: "no-store",
      });
      const body = (await res.json()) as DigestPreviewResult;
      if (!res.ok || body.digest == null) {
        setPreviewError(body.error ?? "Could not generate a preview.");
        return;
      }
      setPreviewText(body.digest);
    } catch {
      setPreviewError("Could not reach the bot admin proxy.");
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <>
      {/* 1. Actions kill switch */}
      <Card
        title="Actions kill switch"
        headerRight={
          <Button type="button" variant="ghost" size="sm" onClick={fetchSwitch}>
            Refresh
          </Button>
        }
      >
        <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 0 }}>
          Off stops the bot from making any change in WhatsApp (adding/removing members, promoting
          admins, renaming groups); reads, Q&amp;A and digests keep working either way.
        </p>
        {switchError && <Toast message={switchError} />}
        {enabled == null && switchError ? (
          <EmptyNote>The actions switch couldn&apos;t be loaded — see the error above, then Refresh.</EmptyNote>
        ) : enabled == null ? (
          <EmptyNote>Loading the actions switch…</EmptyNote>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge label={enabled ? "on" : "off"} />
            {enabled && !confirmOn && (
              <Button type="button" variant="ghost" disabled={switchPending} onClick={() => setActionsState("off")}>
                {switchPending ? "Turning off…" : "Turn off"}
              </Button>
            )}
            {!enabled && !confirmOn && (
              <Button type="button" variant="ghost" disabled={switchPending} onClick={() => setConfirmOn(true)}>
                Turn on
              </Button>
            )}
            {!enabled && confirmOn && (
              <span
                style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                role="alertdialog"
                aria-label="Confirm re-arming bot actions"
              >
                <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
                  This re-arms the bot&apos;s ability to mutate real WhatsApp groups.
                </span>
                <Button type="button" disabled={switchPending} onClick={() => setActionsState("on")}>
                  {switchPending ? "Turning on…" : "Yes, turn on"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmOn(false)}>
                  Cancel
                </Button>
              </span>
            )}
          </div>
        )}
      </Card>

      {/* 2. Digests */}
      <div style={{ marginTop: 20 }}>
        <Card
          title="Digests"
          headerRight={
            <Button type="button" variant="ghost" size="sm" onClick={fetchDigests}>
              Refresh
            </Button>
          }
        >
          {digestsError && <Toast message={digestsError} />}
          {runError && <Toast message={runError} />}
          {runNotice && <Toast message={runNotice} />}
          {digests == null && digestsError ? (
            <EmptyNote>Digest history couldn&apos;t be loaded — see the error above, then Refresh.</EmptyNote>
          ) : digests == null ? (
            <EmptyNote>Loading digest history…</EmptyNote>
          ) : (
            <>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16 }}>
                <div>
                  <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Next noon run</Eyebrow>
                  <div style={{ font: "400 14px var(--font-body)" }}>
                    {digests.nextRun?.noon != null ? new Date(digests.nextRun.noon).toLocaleString("en-GB") : "—"}
                  </div>
                </div>
                <div>
                  <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Next evening run</Eyebrow>
                  <div style={{ font: "400 14px var(--font-body)" }}>
                    {digests.nextRun?.evening != null
                      ? new Date(digests.nextRun.evening).toLocaleString("en-GB")
                      : "—"}
                  </div>
                </div>
                {digests.timezone && (
                  <div>
                    <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Timezone</Eyebrow>
                    <div style={{ font: "400 14px var(--font-body)" }}>{digests.timezone}</div>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                <Button type="button" disabled={runningSlot != null} onClick={() => runDigest("noon")}>
                  {runningSlot === "noon" ? "Running…" : "Run noon now"}
                </Button>
                <Button type="button" disabled={runningSlot != null} onClick={() => runDigest("evening")}>
                  {runningSlot === "evening" ? "Running…" : "Run evening now"}
                </Button>
                <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                  Posts real messages into WhatsApp groups.
                </span>
              </div>

              <SearchableTable
                items={[...historyList].sort((a, b) => b.ts - a.ts)}
                columns={[
                  { label: "Time" },
                  { label: "Slot" },
                  { label: "Trigger" },
                  { label: "Groups" },
                  { label: "Delivered" },
                  { label: "Failed" },
                  { label: "Error" },
                ]}
                renderRow={(r) => [
                  formatRelativeTime(r.ts),
                  r.slot,
                  r.trigger,
                  String(r.groupsCovered),
                  String(r.delivered),
                  String(r.failed),
                  r.error ?? "—",
                ]}
                getSearchText={(r) => `${r.slot} ${r.trigger} ${r.error ?? ""}`}
                searchLabel="Search digest history"
                searchPlaceholder="Filter by slot, trigger or error…"
                emptyState={<EmptyNote>No digest runs recorded yet.</EmptyNote>}
              />
            </>
          )}

          {/* Preview is independent of the history load above — a failed/slow digest-history
              fetch must not hide the (separately loaded/errored) preview control. */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "0.5px solid var(--erp-hairline)" }}>
            <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Preview a digest</Eyebrow>
            <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)", margin: "4px 0 0" }}>
              Generates the digest text for one group so you can check it before it ever reaches WhatsApp. This
              sends nothing — no message is posted anywhere.
            </p>
            {groupsError && <Toast message={groupsError} />}
            {previewError && <Toast message={previewError} />}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
              <select
                aria-label="Group to preview"
                value={previewChatId}
                onChange={(e) => {
                  setPreviewChatId(e.target.value);
                  setPreviewText(null);
                  setPreviewError(undefined);
                }}
                disabled={groupOptions == null || groupOptions.length === 0}
                style={{
                  font: "400 13px var(--font-body)",
                  padding: "6px 8px",
                  border: "0.5px solid var(--erp-hairline)",
                  background: "var(--surface-card)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="">
                  {groupOptions == null
                    ? groupsError
                      ? "Groups unavailable"
                      : "Loading groups…"
                    : groupOptions.length === 0
                      ? "No groups yet"
                      : "Select a group…"}
                </option>
                {(groupOptions ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <Button type="button" variant="ghost" disabled={!previewChatId || previewLoading} onClick={runPreview}>
                {previewLoading ? "Generating preview…" : "Preview (sends nothing)"}
              </Button>
            </div>
            {previewText != null && (
              <div style={{ marginTop: 12 }}>
                <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Preview only — nothing was sent</Eyebrow>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    font: "400 13px var(--font-body)",
                    background: "var(--surface-card)",
                    color: "var(--text-primary)",
                    padding: 12,
                    marginTop: 4,
                    border: "0.5px solid var(--erp-hairline)",
                  }}
                >
                  {previewText}
                </pre>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* 3. Media queue */}
      <div style={{ marginTop: 20 }}>
        <Card
          title="Media queue"
          headerRight={
            <Button type="button" variant="ghost" size="sm" onClick={fetchMedia}>
              Refresh
            </Button>
          }
        >
          {mediaError && <Toast message={mediaError} />}
          {media == null && mediaError ? (
            <EmptyNote>Media queue status couldn&apos;t be loaded — see the error above, then Refresh.</EmptyNote>
          ) : media == null ? (
            <EmptyNote>Loading media queue status…</EmptyNote>
          ) : (
            <>
              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <StatusBadge label={media.queueEnabled ? "active" : "off"} />
                <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
                  {media.pending} pending
                </span>
                {media.oldestPendingTs != null && (
                  <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
                    Oldest: {formatRelativeTime(media.oldestPendingTs)}
                  </span>
                )}
              </div>
              {(media.pending ?? 0) === 0 ? (
                <div style={{ marginTop: 12 }}>
                  <EmptyNote>No media pending — the queue is caught up.</EmptyNote>
                </div>
              ) : (
                media.oldestPendingTs != null &&
                Date.now() - media.oldestPendingTs > STUCK_MEDIA_MS && (
                  <p className="sys-alert-band" style={{ marginTop: 12 }}>
                    A backlog this old usually means enrichment is stuck — check the media worker.
                  </p>
                )
              )}
            </>
          )}
        </Card>
      </div>

      {/* 4. Bot capabilities */}
      <div style={{ marginTop: 20 }}>
        <Card
          title="Bot capabilities"
          headerRight={
            <Button type="button" variant="ghost" size="sm" onClick={fetchSkills}>
              Refresh
            </Button>
          }
        >
          {skillsError && <Toast message={skillsError} />}
          {skills == null && skillsError ? (
            <EmptyNote>The skills catalog couldn&apos;t be loaded — see the error above, then Refresh.</EmptyNote>
          ) : skills == null ? (
            <EmptyNote>Loading the skills catalog…</EmptyNote>
          ) : skills.skills == null || skills.skills.length === 0 ? (
            <EmptyNote>No skills registered.</EmptyNote>
          ) : (
            <>
              {skills.botMention && (
                <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 0 }}>
                  Mention trigger: <strong>{skills.botMention}</strong>
                </p>
              )}
              <HairlineTable
                columns={[{ label: "Command" }, { label: "Description" }]}
                rows={skills.skills.map((s) => [`${skills.commandPrefix ?? ""}${s.name}`, s.description])}
              />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
