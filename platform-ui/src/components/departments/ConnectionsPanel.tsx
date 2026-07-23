"use client";
import { useState, useTransition } from "react";
import { StatusBadge, Button } from "@/components/ui";
import type { ConnectionRow, ConnectionProvider } from "@/lib/connections";
import type { SeatRow } from "@/lib/claudeSeats";

type Result<T = undefined> = { ok: boolean; error?: string; row?: T };

// "My connections" — self-service create/edit/revoke for GitHub + Google
// Drive (identity mapping only, no tokens — Phase-1 posture per contract §12)
// plus the Claude seat row (§12a). Every action prop is expected to already
// be `.bind(null, tenant, deptId)`-ed by the page (same idiom as
// `ServiceAssignmentRow`/`ConnectServicePanel` in components/org/) — this
// component owns no fetch of its own, only per-row pending/error/edit state.
export interface ConnectionsPanelActions {
  connect: (provider: ConnectionProvider, externalAccount: string) => Promise<Result<ConnectionRow>>;
  update: (id: string, externalAccount: string) => Promise<Result<ConnectionRow>>;
  revoke: (id: string) => Promise<Result>;
  mapSeat: (codeSeatEmail: string, designLogin?: string) => Promise<Result<SeatRow>>;
  updateSeat: (id: string, codeSeatEmail: string, designLogin?: string) => Promise<Result<SeatRow>>;
  unmapSeat: (id: string) => Promise<Result>;
}

function CredentialNote({ row }: { row?: ConnectionRow }) {
  if (!row) return null;
  // Never the token itself — only the hasToken/hasRefreshToken booleans the
  // vault surfaces (contract §12 security note). Phase-1 never sets these
  // (no HTTP path accepts a token), so this is forward-compat for Phase-2.
  if (!row.hasToken) return <span className="dept-conn-row__cred">Identity only — no credential yet.</span>;
  return <span className="dept-conn-row__cred">Credential linked{row.hasRefreshToken ? " (refreshable)" : ""}.</span>;
}

function ProviderRow({
  label, placeholder, row, onConnect, onUpdate, onRevoke,
}: {
  label: string;
  placeholder: string;
  row?: ConnectionRow;
  onConnect: (value: string) => Promise<Result<ConnectionRow>>;
  onUpdate: (id: string, value: string) => Promise<Result<ConnectionRow>>;
  onRevoke: (id: string) => Promise<Result>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row?.externalAccount ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const connected = !!row;

  const submit = () => {
    if (!value.trim()) { setError("Enter a value first."); return; }
    setError(null);
    startTransition(async () => {
      const res = connected && row ? await onUpdate(row.id, value.trim()) : await onConnect(value.trim());
      if (!res.ok) setError(res.error ?? "That didn't work.");
      else setEditing(false);
    });
  };

  const revoke = () => {
    if (!row) return;
    setError(null);
    startTransition(async () => {
      const res = await onRevoke(row.id);
      if (!res.ok) setError(res.error ?? "Couldn't revoke.");
    });
  };

  return (
    <li className="dept-conn-row">
      <div className="dept-conn-row__main">
        <span className="dept-conn-row__label">{label}</span>
        {connected && row ? (
          <>
            <StatusBadge label={row.status} />
            <span className="dept-conn-row__account">{row.externalAccount ?? "no account set"}</span>
          </>
        ) : (
          <StatusBadge label="unconfigured" />
        )}
      </div>

      {(editing || !connected) ? (
        <div className="dept-conn-row__form">
          <input
            className="dept-conn-row__input"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`${label} account`}
          />
          <Button size="sm" onClick={submit} disabled={pending}>{pending ? "Working…" : connected ? "Save" : "Connect"}</Button>
          {editing && (
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(row?.externalAccount ?? ""); setError(null); }} disabled={pending}>
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <div className="dept-conn-row__actions">
          <CredentialNote row={row} />
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={pending}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={revoke} disabled={pending}>Revoke</Button>
        </div>
      )}
      {error && <p className="dept-conn-row__error">{error}</p>}
    </li>
  );
}

function SeatRowView({
  seat, onMap, onUpdate, onUnmap,
}: {
  seat?: SeatRow;
  onMap: (codeSeatEmail: string, designLogin?: string) => Promise<Result<SeatRow>>;
  onUpdate: (id: string, codeSeatEmail: string, designLogin?: string) => Promise<Result<SeatRow>>;
  onUnmap: (id: string) => Promise<Result>;
}) {
  const mapped = !!(seat?.mapped);
  const [editing, setEditing] = useState(false);
  const [codeSeatEmail, setCodeSeatEmail] = useState(seat?.codeSeatEmail ?? "");
  const [designLogin, setDesignLogin] = useState(seat?.designLogin ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!codeSeatEmail.trim()) { setError("Enter the Claude Code seat email first."); return; }
    setError(null);
    startTransition(async () => {
      const res = mapped && seat
        ? await onUpdate(seat.id, codeSeatEmail.trim(), designLogin.trim() || undefined)
        : await onMap(codeSeatEmail.trim(), designLogin.trim() || undefined);
      if (!res.ok) setError(res.error ?? "That didn't work.");
      else setEditing(false);
    });
  };

  const unmap = () => {
    if (!seat) return;
    setError(null);
    startTransition(async () => {
      const res = await onUnmap(seat.id);
      if (!res.ok) setError(res.error ?? "Couldn't unmap.");
    });
  };

  return (
    <li className="dept-conn-row">
      <div className="dept-conn-row__main">
        <span className="dept-conn-row__label">Claude seat</span>
        <StatusBadge label={mapped ? "linked" : "unconfigured"} />
        {mapped && seat?.codeSeatEmail && <span className="dept-conn-row__account">{seat.codeSeatEmail}</span>}
        {mapped && seat?.designLogin && <span className="dept-conn-row__account">Design: {seat.designLogin}</span>}
      </div>

      {(editing || !mapped) ? (
        <div className="dept-conn-row__form">
          <input
            className="dept-conn-row__input"
            placeholder="Claude Code seat email"
            value={codeSeatEmail}
            onChange={(e) => setCodeSeatEmail(e.target.value)}
            aria-label="Claude Code seat email"
          />
          <input
            className="dept-conn-row__input"
            placeholder="Claude Design login (optional)"
            value={designLogin}
            onChange={(e) => setDesignLogin(e.target.value)}
            aria-label="Claude Design login"
          />
          <Button size="sm" onClick={submit} disabled={pending}>
            {pending ? "Working…" : mapped ? "Save" : "Map your seat"}
          </Button>
          {editing && (
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setCodeSeatEmail(seat?.codeSeatEmail ?? ""); setDesignLogin(seat?.designLogin ?? ""); setError(null); }} disabled={pending}>
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <div className="dept-conn-row__actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={pending}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={unmap} disabled={pending}>Unmap</Button>
        </div>
      )}
      {error && <p className="dept-conn-row__error">{error}</p>}
    </li>
  );
}

export function ConnectionsPanel({
  github, drive, seat, actions,
}: {
  github?: ConnectionRow;
  drive?: ConnectionRow;
  seat?: SeatRow;
  actions: ConnectionsPanelActions;
}) {
  return (
    <ul className="dept-conn-list">
      <ProviderRow
        label="GitHub"
        placeholder="GitHub username"
        row={github}
        onConnect={(v) => actions.connect("github", v)}
        onUpdate={actions.update}
        onRevoke={actions.revoke}
      />
      <ProviderRow
        label="Google Drive"
        placeholder="you@company.com"
        row={drive}
        onConnect={(v) => actions.connect("google_drive", v)}
        onUpdate={actions.update}
        onRevoke={actions.revoke}
      />
      <SeatRowView seat={seat} onMap={actions.mapSeat} onUpdate={actions.updateSeat} onUnmap={actions.unmapSeat} />
    </ul>
  );
}
