"use client";
import { useMemo, useState, useTransition } from "react";
import { Card, Button, Toast, Eyebrow } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import "./systems.css";
import "./bot-extras.css";
import "@/components/forms/forms.css";

// A6 (doc §2.5): monitored-groups table + discovered-groups one-click add +
// single management-group radio, all committed by one Save → full-replace
// PUT to platform-nest's `api/admin/bot/groups` (doc §2.3/2.4 frozen contract).
// Mirrors TagEditor's "plain async action called via startTransition" pattern
// rather than useActionState/FormData, because the payload here is a dynamic
// array built up client-side, not a single form field.

export interface BotGroupConfig {
  id: string;
  name: string;
  category?: string;
  // Post this group's own digest back into it. The bot's PUT is a FULL REPLACE that normalizes
  // `optIn: Boolean(g.optIn)` — omitting it here silently turned it off for every group on save.
  optIn?: boolean;
  isManagement?: boolean;
}

export interface BotDiscoveredGroup {
  id: string;
  name: string;
  firstSeenAt: string | number;
}

export interface BotGroupsSnapshot {
  registryActive: boolean;
  groups: BotGroupConfig[];
  discovered: BotDiscoveredGroup[];
  managementGroupId: string | null;
  // An ignored group is dropped in BOTH registry modes — orthogonal to the mode switch above.
  // Optional on the wire (older bot builds / a not-yet-redeployed backend won't send it), so every
  // reader below falls back to `[]` rather than crashing on an absent field.
  ignored?: BotDiscoveredGroup[];
}

export interface GroupsActionState {
  ok: boolean;
  error?: string;
  field?: string;
}

type GroupsAction = (groups: BotGroupConfig[]) => Promise<GroupsActionState>;
type IgnoreAction = (ids: string[]) => Promise<GroupsActionState>;

export function GroupRegistry({
  elevated,
  initial,
  action,
  ignoreAction,
}: {
  elevated: boolean;
  initial: BotGroupsSnapshot | null;
  action: GroupsAction;
  // Additive/optional (same convention as Toast's onUndo): until the page wiring passes this
  // prop, the Ignored-groups section still renders (an operator can see what's already ignored)
  // but Save is disabled rather than throwing on a missing callback.
  ignoreAction?: IgnoreAction;
}) {
  const [groups, setGroups] = useState<BotGroupConfig[]>(initial?.groups ?? []);
  const [result, setResult] = useState<GroupsActionState | null>(null);
  const [pending, startTransition] = useTransition();

  // Ignore list: staged separately from the monitored table (its own Save, its own payload —
  // `PUT .../groups/ignored` is a full-replace of ids, unrelated to the groups full-replace above).
  const [ignoredIds, setIgnoredIds] = useState<string[]>((initial?.ignored ?? []).map((g) => g.id));
  const [ignoreResult, setIgnoreResult] = useState<GroupsActionState | null>(null);
  const [ignorePending, startIgnoreTransition] = useTransition();

  // Name lookup for anything that ends up in the ignored list — either already-ignored (from
  // `initial.ignored`) or just staged from the discovered list this session (from
  // `initial.discovered`, before it's saved).
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of initial?.ignored ?? []) map.set(g.id, g.name || g.id);
    for (const d of initial?.discovered ?? []) if (!map.has(d.id)) map.set(d.id, d.name || d.id);
    return map;
  }, [initial]);

  const ignoredEntries = useMemo(
    () => ignoredIds.map((id) => ({ id, name: nameById.get(id) ?? id })),
    [ignoredIds, nameById],
  );

  const discovered = useMemo(
    () =>
      (initial?.discovered ?? []).filter(
        (d) => !groups.some((g) => g.id === d.id) && !ignoredIds.includes(d.id),
      ),
    [initial, groups, ignoredIds],
  );

  if (!elevated) {
    return (
      <Card title="Monitored groups">
        <EmptyNote>Group registry edits are limited to superadmins/owners.</EmptyNote>
      </Card>
    );
  }

  if (!initial) {
    return (
      <Card title="Monitored groups">
        <EmptyNote>Group registry appears once the bot admin API is connected.</EmptyNote>
      </Card>
    );
  }

  function updateRow(id: string, patch: Partial<BotGroupConfig>) {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }

  function removeRow(id: string) {
    setGroups((prev) => prev.filter((g) => g.id !== id));
  }

  function addDiscovered(d: BotDiscoveredGroup) {
    // Same fallback as the discovered row: never seed the registry with a blank name (the
    // bot's validator accepts "" and the operator ends up with an unidentifiable entry).
    setGroups((prev) => [
      ...prev,
      { id: d.id, name: d.name || d.id, category: "", optIn: false, isManagement: false },
    ]);
  }

  function setManagement(id: string) {
    setGroups((prev) => prev.map((g) => ({ ...g, isManagement: g.id === id })));
  }

  function stageIgnore(id: string) {
    setIgnoredIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function unignore(id: string) {
    setIgnoredIds((prev) => prev.filter((x) => x !== id));
  }

  function save() {
    startTransition(async () => {
      const r = await action(groups);
      setResult(r);
    });
  }

  function saveIgnored() {
    if (!ignoreAction) return;
    startIgnoreTransition(async () => {
      const r = await ignoreAction(ignoredIds);
      setIgnoreResult(r);
    });
  }

  // The registry is a MODE SWITCH, not just a list. While it's empty the bot is in trial mode and
  // ingests every group it can see; the moment it has one entry, `bot.ts` drops every group that
  // isn't listed. Saving the first group therefore silently stops ingesting all the others —
  // surface that before the click, not after.
  const willActivateRegistry = !initial.registryActive && groups.length > 0;
  const otherDiscovered = discovered.length;

  return (
    <Card
      title="Monitored groups"
      headerRight={
        <Button type="button" size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      }
    >
      <p className="groups-explain">
        <strong>Monitored</strong> groups are read and summarised in digests. <strong>Ignored</strong>{" "}
        groups are never read — not even in trial mode, when every other group is read by default.
      </p>

      {willActivateRegistry && (
        <div className="bot-registry-warning" role="status">
          <strong>Saving this turns the registry on.</strong> The bot is currently in trial mode and
          reads every group it can see. Once the registry has entries it reads{" "}
          <strong>only the groups listed here</strong> — the other{" "}
          {otherDiscovered === 1 ? "discovered group" : `${otherDiscovered} discovered groups`} will
          stop being stored and will drop out of the digests. Already-stored history is kept.
        </div>
      )}

      {groups.length === 0 ? (
        <EmptyNote>No monitored groups yet — add one from the discovered list below.</EmptyNote>
      ) : (
        <div className="lux-table" style={{ ["--lux-tcols" as string]: "1.4fr 1fr 0.6fr 0.6fr 0.5fr" }}>
          <div className="lux-table__head">
            <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Name</Eyebrow>
            <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Category</Eyebrow>
            <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Digest back</Eyebrow>
            <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Management</Eyebrow>
            <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Remove</Eyebrow>
          </div>
          {groups.map((g) => (
            <div className="lux-table__row" key={g.id}>
              <input
                className="lux-field__control"
                aria-label={`Name for group ${g.id}`}
                value={g.name}
                onChange={(e) => updateRow(g.id, { name: e.target.value })}
              />
              <input
                className="lux-field__control"
                aria-label={`Category for group ${g.id}`}
                value={g.category ?? ""}
                onChange={(e) => updateRow(g.id, { category: e.target.value })}
              />
              <span style={{ display: "flex", justifyContent: "center" }}>
                <input
                  type="checkbox"
                  aria-label={`Post the digest back into ${g.name}`}
                  checked={!!g.optIn}
                  onChange={(e) => updateRow(g.id, { optIn: e.target.checked })}
                />
              </span>
              <span style={{ display: "flex", justifyContent: "center" }}>
                <input
                  type="radio"
                  name="bot-management-group"
                  aria-label={`Set ${g.name} as the management group`}
                  checked={!!g.isManagement}
                  onChange={() => setManagement(g.id)}
                />
              </span>
              <span style={{ display: "flex", justifyContent: "center" }}>
                <button
                  type="button"
                  className="lux-btn lux-btn--ghost lux-btn--sm"
                  aria-label={`Remove group ${g.name}`}
                  onClick={() => removeRow(g.id)}
                >
                  Remove
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {result?.error && (
        <Toast message={result.field ? `${result.error} (field: ${result.field})` : result.error} />
      )}
      {result?.ok && <Toast message="Group registry saved." />}

      <div style={{ marginTop: 20 }}>
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Discovered groups</Eyebrow>
        {discovered.length === 0 ? (
          <EmptyNote>No newly-discovered groups waiting to be added.</EmptyNote>
        ) : (
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}>
            {discovered.map((d) => (
              <li
                key={d.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 0",
                  borderBottom: "1px solid var(--erp-hairline, rgba(0,0,0,.08))",
                }}
              >
                {/* A group's subject is resolved out-of-band by the bot, so it can legitimately
                    be missing (WAHA unreachable, brand-new group). Fall back to the JID rather
                    than rendering a blank row next to an Add button. */}
                <span style={{ font: "400 13px var(--font-body)" }}>{d.name || d.id}</span>
                <span className="groups-discovered-row__actions">
                  <Button type="button" variant="ghost" size="sm" onClick={() => addDiscovered(d)}>
                    Add
                  </Button>
                  {/* Raw <button>, not the Button primitive — same reason as "Remove" below: it
                      needs an aria-label disambiguating which row it belongs to, and Button
                      doesn't forward unknown props. */}
                  <button
                    type="button"
                    className="lux-btn lux-btn--ghost lux-btn--sm"
                    aria-label={`Ignore ${d.name || d.id}`}
                    onClick={() => stageIgnore(d.id)}
                  >
                    Ignore
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 20 }}>
        <div className="groups-ignored__head">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Ignored groups</Eyebrow>
          <Button type="button" variant="ghost" size="sm" onClick={saveIgnored} disabled={ignorePending || !ignoreAction}>
            {ignorePending ? "Saving…" : "Save ignored list"}
          </Button>
        </div>
        {ignoredEntries.length === 0 ? (
          <EmptyNote>No ignored groups — spammy or irrelevant groups you Ignore above land here.</EmptyNote>
        ) : (
          <ul className="groups-ignored-list">
            {ignoredEntries.map((e) => (
              <li className="groups-ignored-row" key={e.id}>
                <span className="groups-ignored-row__name">{e.name}</span>
                <button
                  type="button"
                  className="lux-btn lux-btn--ghost lux-btn--sm"
                  aria-label={`Un-ignore ${e.name}`}
                  onClick={() => unignore(e.id)}
                >
                  Un-ignore
                </button>
              </li>
            ))}
          </ul>
        )}
        {ignoreResult?.error && (
          <Toast message={ignoreResult.field ? `${ignoreResult.error} (field: ${ignoreResult.field})` : ignoreResult.error} />
        )}
        {ignoreResult?.ok && <Toast message="Ignore list saved." />}
      </div>
    </Card>
  );
}
