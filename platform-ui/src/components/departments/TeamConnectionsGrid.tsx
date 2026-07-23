"use client";
import { useState, useTransition } from "react";
import { StatusBadge, Button } from "@/components/ui";
import type { ConnectionRow } from "@/lib/connections";
import type { SeatRow } from "@/lib/claudeSeats";

type Result<T = undefined> = { ok: boolean; error?: string; row?: T };

export interface TeamConnectionRow {
  person: { id: string; name: string };
  github?: ConnectionRow;
  drive?: ConnectionRow;
  seat?: SeatRow;
}

// Admin/manager-only (company.manage) team status grid — per-member ×
// provider, gated the same way the backend gates `owner=company`/`owner=team`
// (contract §12/§12a). A plain member never receives this data at all (the
// page only fetches + renders it when `can(me, "company.manage", tenant)`),
// so there is no client-side-only secret here — the RBAC boundary is real,
// this is just the view. The only WRITE this grid offers is mapping a
// teammate's Claude seat on their behalf (§12a's `userId` admin path);
// GitHub/Google Drive are Phase-1 identity-only and self-service, so an
// admin here can see status but re-linking someone else's account is left to
// that person until Phase-2 OAuth exists (re-flagged in the ticket report,
// not a blocker).
export function TeamConnectionsGrid({
  rows, onMapSeat,
}: {
  rows: TeamConnectionRow[];
  onMapSeat: (userId: string, codeSeatEmail: string, designLogin?: string) => Promise<Result<SeatRow>>;
}) {
  return (
    <div className="erp-scroll">
      <table className="dept-conn-grid">
        <thead>
          <tr>
            <th>Person</th>
            <th>GitHub</th>
            <th>Google Drive</th>
            <th>Claude seat</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.person.id}>
              <td className="dept-conn-grid__person">{r.person.name}</td>
              <td><StatusBadge label={r.github?.status ?? "unconfigured"} /></td>
              <td><StatusBadge label={r.drive?.status ?? "unconfigured"} /></td>
              <td>
                <SeatCell userId={r.person.id} seat={r.seat} onMapSeat={onMapSeat} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeatCell({
  userId, seat, onMapSeat,
}: {
  userId: string;
  seat?: SeatRow;
  onMapSeat: (userId: string, codeSeatEmail: string, designLogin?: string) => Promise<Result<SeatRow>>;
}) {
  const mapped = !!seat?.mapped;
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (mapped) {
    return (
      <div className="dept-conn-grid__cell">
        <StatusBadge label="linked" />
        <span className="dept-conn-row__account">{seat?.codeSeatEmail}</span>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="dept-conn-grid__cell">
        <StatusBadge label="unconfigured" />
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Map seat</Button>
      </div>
    );
  }

  const submit = () => {
    if (!email.trim()) { setError("Enter a seat email."); return; }
    setError(null);
    startTransition(async () => {
      const res = await onMapSeat(userId, email.trim());
      if (!res.ok) setError(res.error ?? "Couldn't map.");
      else setEditing(false);
    });
  };

  return (
    <div className="dept-conn-grid__cell">
      <input
        className="dept-conn-row__input"
        placeholder="Claude Code seat email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-label={`Claude seat email for ${userId}`}
      />
      <div className="dept-conn-row__actions">
        <Button size="sm" onClick={submit} disabled={pending}>{pending ? "Working…" : "Save"}</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={pending}>Cancel</Button>
      </div>
      {error && <p className="dept-conn-row__error">{error}</p>}
    </div>
  );
}
