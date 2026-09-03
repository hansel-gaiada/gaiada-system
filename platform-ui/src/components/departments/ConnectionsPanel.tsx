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

/** What the badge should SAY, which is not the same as the vault's `status` column.
 *
 * ── THE BUG THIS CLOSES (2026-09-03) ──────────────────────────────────────────────────────────
 * This rendered `<StatusBadge label={row.status} />` verbatim. `createConnection` inserts
 * `status = 'unconfigured'` and the only path that ever sets `'linked'` is `setConnectionTokens`,
 * which the Phase-1 HTTP surface deliberately does not expose and which has NO caller for a
 * user-owned row. So the moment you typed your GitHub username and pressed the button, the row
 * came back saying **"unconfigured"** with your username printed beside it — a saved mapping
 * reporting itself as not saved. It reads as a broken write, and it is the opposite: the write
 * worked and the label was describing a different question.
 *
 * The states below are the ones that are actually distinguishable here:
 *   · no row              -> Not set
 *   · row, error status   -> Error (a real signal a Phase-2 refresh can set)
 *   · row, hasToken       -> Connected (Phase-2 only; no Phase-1 path reaches it)
 *   · row, no token       -> Mapped — the honest name for "we know who you are, we hold nothing"
 *
 * Exported because `TeamConnectionsGrid` had the identical bug in three more cells and must not
 * grow a second copy of this vocabulary. It lives in this client component rather than in
 * `lib/connections.ts` because that module is `server-only` and the grid is a client component —
 * the trio convention (`X.ts` client-safe / `X-data.ts` server) has no pure half for connections
 * yet, and inventing one for a single helper is a bigger change than this ticket earns.
 */
export function mappingLabel(row: ConnectionRow): string {
  if (row.status === "error") return "error";
  if (row.hasToken) return "connected";
  return "mapped";
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
            <StatusBadge label={mappingLabel(row)} />
            <span className="dept-conn-row__account">{row.externalAccount ?? "no account set"}</span>
          </>
        ) : (
          <StatusBadge label="not set" />
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
          {/* "Save", never "Connect", in both states. Pressing this writes an account NAME into the
              vault's mapping row; it does not authenticate, request a scope, or obtain a token, and
              nothing afterwards can act as you. Labelling that "Connect" is what made the badge
              beside it read as a failure — the word promised an integration the button never did. */}
          <Button size="sm" onClick={submit} disabled={pending}>{pending ? "Working…" : "Save"}</Button>
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
          {/* "Remove", not "Revoke". Revoke is the API's verb (DELETE soft-revokes the row and nulls
              the token columns) but there is no credential here to revoke — removing a mapping is
              all that happens, and the button should say the thing it does. */}
          <Button size="sm" variant="ghost" onClick={revoke} disabled={pending}>Remove</Button>
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
        {/* "mapped", not "linked": this row records WHICH Claude seat is yours so the launchers can
            say "opens as you@…". It does not verify the seat exists or that you can sign into it. */}
        <StatusBadge label={mapped ? "mapped" : "not set"} />
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
    <>
      {/* ── SAY WHAT THESE ROWS ARE (2026-09-03) ─────────────────────────────────────────────────
          The tab is called Connections and the button used to say Connect, so people reasonably
          read these as live integrations and then wondered why the badge said "unconfigured". They
          are ACCOUNT MAPPINGS: a note of who you are on each service. Phase-1's HTTP surface
          accepts no tokens at all (contract §12 — a credential can only ever be sealed by an
          internal Phase-2 OAuth callback), `google_drive` has no OAuth surface registered anywhere
          in the backend yet, and the real, working GitHub credential is the ORG-LEVEL App shown
          below this card, which has nothing to do with these rows.
          Saying so here is cheaper than the alternative, which is every reader discovering it. */}
      <p className="dept-conn-note">
        These are <strong>account mappings</strong>, not sign-ins: they record who you are on each
        service so work can be attributed to you. No credential is stored and nothing acts on your
        behalf — signing in to GitHub or Drive from the ERP is not built yet.
      </p>
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
    </>
  );
}
