"use client";
import { useMemo, useState, useTransition } from "react";
import { Card, Button, Toast, Eyebrow } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import "./systems.css";
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
}

export interface GroupsActionState {
  ok: boolean;
  error?: string;
  field?: string;
}

type GroupsAction = (groups: BotGroupConfig[]) => Promise<GroupsActionState>;

export function GroupRegistry({
  elevated,
  initial,
  action,
}: {
  elevated: boolean;
  initial: BotGroupsSnapshot | null;
  action: GroupsAction;
}) {
  const [groups, setGroups] = useState<BotGroupConfig[]>(initial?.groups ?? []);
  const [result, setResult] = useState<GroupsActionState | null>(null);
  const [pending, startTransition] = useTransition();

  const discovered = useMemo(
    () => (initial?.discovered ?? []).filter((d) => !groups.some((g) => g.id === d.id)),
    [initial, groups],
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
    setGroups((prev) => [...prev, { id: d.id, name: d.name, category: "", isManagement: false }]);
  }

  function setManagement(id: string) {
    setGroups((prev) => prev.map((g) => ({ ...g, isManagement: g.id === id })));
  }

  function save() {
    startTransition(async () => {
      const r = await action(groups);
      setResult(r);
    });
  }

  return (
    <Card
      title="Monitored groups"
      headerRight={
        <Button type="button" size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      }
    >
      {groups.length === 0 ? (
        <EmptyNote>No monitored groups yet — add one from the discovered list below.</EmptyNote>
      ) : (
        <div className="lux-table" style={{ ["--lux-tcols" as string]: "1.4fr 1fr 0.6fr 0.5fr" }}>
          <div className="lux-table__head">
            <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Name</Eyebrow>
            <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Category</Eyebrow>
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
                <span style={{ font: "400 13px var(--font-body)" }}>{d.name}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => addDiscovered(d)}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
