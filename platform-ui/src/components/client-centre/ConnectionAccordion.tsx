"use client";
import { useState } from "react";
import { registry, usedBy, type ConnectionEntry } from "@/lib/clientCentre";

interface ConnRow {
  id: string;
  name: string;
  idLabel: string;
  custom: boolean;
}

function dotClass(status: string | undefined): string {
  if (status === "Connected") return "cc-conn-dot cc-conn-dot--connected";
  if (status === "Needs attention") return "cc-conn-dot cc-conn-dot--attention";
  return "cc-conn-dot";
}

// CMC's connection accordion: one `<details>` per tool/data source, its summary line carrying the
// status dot + tool name + account + "Shared · N" + status word, its body the 8 sub-fields.
export function ConnectionAccordion({
  sectionId,
  sectionName,
  businessType,
  connectionIds,
  connections,
  customConnections,
  canEdit,
  onChange,
  onAddCustom,
  onRemoveCustom,
}: {
  sectionId: string;
  sectionName: string;
  businessType: string;
  connectionIds: string[];
  connections: Record<string, ConnectionEntry>;
  customConnections: { id: string; name: string }[];
  canEdit: boolean;
  onChange: (connId: string, patch: Partial<ConnectionEntry>) => void;
  onAddCustom: (name: string) => void;
  onRemoveCustom: (connId: string) => void;
}) {
  const [newName, setNewName] = useState("");

  const rows: ConnRow[] = [
    ...connectionIds.map((id) => ({ id, name: registry.connections[id]?.name ?? id, idLabel: registry.connections[id]?.idLabel ?? "Account / ID", custom: false })),
    ...customConnections.map((c) => ({ id: c.id, name: c.name, idLabel: "Account / ID", custom: true })),
  ];

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    onAddCustom(name);
    setNewName("");
  };

  return (
    <>
      <div className="cc-conn-list">
        {rows.map((row) => {
          const v = connections[row.id] ?? {};
          const status = v.status || registry.connectionStatuses[0];
          const others = row.custom ? [] : usedBy(registry, businessType, "connections", row.id, sectionId);
          return (
            <details className="cc-conn" key={row.id}>
              <summary>
                <span className={dotClass(status)} aria-hidden="true" />
                <span className="cc-conn-name">{v.tool || row.name}</span>
                <span className="cc-conn-meta">{v.account || ""}</span>
                {others.length > 0 && (
                  <em className="cc-shared" title={`Also used in: ${others.join(", ")}`}>Shared · {others.length}</em>
                )}
                <span className="cc-conn-status">{status}</span>
              </summary>
              <div className="cc-conn-body">
                <label className="cc-field">
                  <span className="cc-field__label">Tool / provider</span>
                  {canEdit ? (
                    <input className="cc-input" type="text" placeholder={row.name} value={v.tool ?? ""} onChange={(e) => onChange(row.id, { tool: e.target.value })} />
                  ) : (
                    <span className="cc-readonly-value">{v.tool || row.name}</span>
                  )}
                </label>
                <label className="cc-field">
                  <span className="cc-field__label">{row.idLabel}</span>
                  {canEdit ? (
                    <input className="cc-input" type="text" value={v.account ?? ""} onChange={(e) => onChange(row.id, { account: e.target.value })} />
                  ) : (
                    <span className="cc-readonly-value">{v.account || "—"}</span>
                  )}
                </label>
                <label className="cc-field">
                  <span className="cc-field__label">URL</span>
                  {canEdit ? (
                    <input className="cc-input" type="url" placeholder="https://" value={v.url ?? ""} onChange={(e) => onChange(row.id, { url: e.target.value })} />
                  ) : (
                    <span className="cc-readonly-value">{v.url || "—"}</span>
                  )}
                </label>
                <label className="cc-field">
                  <span className="cc-field__label">Owner</span>
                  {canEdit ? (
                    <input className="cc-input" type="text" placeholder="Who manages this" value={v.owner ?? ""} onChange={(e) => onChange(row.id, { owner: e.target.value })} />
                  ) : (
                    <span className="cc-readonly-value">{v.owner || "—"}</span>
                  )}
                </label>
                <label className="cc-field">
                  <span className="cc-field__label">Credentials stored in</span>
                  {canEdit ? (
                    <input className="cc-input" type="text" placeholder="e.g. 1Password → Marketing vault" value={v.creds ?? ""} onChange={(e) => onChange(row.id, { creds: e.target.value })} />
                  ) : (
                    <span className="cc-readonly-value">{v.creds || "—"}</span>
                  )}
                </label>
                <label className="cc-field">
                  <span className="cc-field__label">Connection method</span>
                  {canEdit ? (
                    <select className="cc-select" value={v.method || registry.connectionMethods[0]} onChange={(e) => onChange(row.id, { method: e.target.value })}>
                      {registry.connectionMethods.map((m) => <option key={m}>{m}</option>)}
                    </select>
                  ) : (
                    <span className="cc-readonly-value">{v.method || registry.connectionMethods[0]}</span>
                  )}
                </label>
                <label className="cc-field">
                  <span className="cc-field__label">Status</span>
                  {canEdit ? (
                    <select className="cc-select" value={status} onChange={(e) => onChange(row.id, { status: e.target.value })}>
                      {registry.connectionStatuses.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  ) : (
                    <span className="cc-readonly-value">{status}</span>
                  )}
                </label>
                <label className="cc-field cc-field--wide">
                  <span className="cc-field__label">Notes</span>
                  {canEdit ? (
                    <input className="cc-input" type="text" value={v.notes ?? ""} onChange={(e) => onChange(row.id, { notes: e.target.value })} />
                  ) : (
                    <span className="cc-readonly-value">{v.notes || "—"}</span>
                  )}
                </label>
                {row.custom && canEdit && (
                  <div className="cc-conn-remove">
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => onRemoveCustom(row.id)}>
                      Remove connection
                    </button>
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>
      {canEdit && (
        <div className="cc-add-conn">
          <input
            type="text"
            className="cc-input"
            placeholder={`Add another connection or data source for ${sectionName}`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          />
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={add}>Add</button>
        </div>
      )}
    </>
  );
}
