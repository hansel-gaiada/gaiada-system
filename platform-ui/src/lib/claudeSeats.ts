import "server-only";
// C1 Claude seat registry (WSUX-17 backend, WSUX-16 UI) — a thin,
// provider-scoped projection over lib/connections.ts's vault: a "seat" IS an
// `integration_connections` row with owner_kind='user', provider='claude'
// (FRONTEND-BFF-CONTRACT.md §12a). No new table, no new secret path — this
// file just talks to the reshaped endpoint instead of the generic one so
// callers get `mapped`/`codeSeatEmail`/`designLogin` without re-deriving them.
//
// BFF CONTRACT (§12a, mounted /api/:t/integrations/claude-seats):
//   GET    ?owner=me|team|user:<id>                       -> SeatRow[]
//   POST   {userId?, codeSeatEmail, designLogin?}          -> 201 SeatRow
//   PATCH  /:id {codeSeatEmail?, designLogin?, status?}    -> 200 SeatRow
//   DELETE /:id                                            -> 200 SeatRow (unmap)
import { platformFetch, PlatformError } from "./platform";
import type { ClientSettableStatus, ConnectionStatus } from "./connections";

export interface SeatRow {
  id: string;
  tenantId: string;
  personId: string;
  codeSeatEmail: string | null;
  designLogin: string | null;
  status: ConnectionStatus;
  scopes: string[];
  /** codeSeatEmail set AND not revoked — NOT derived from status alone. */
  mapped: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SeatOwner = "me" | "team" | `user:${string}`;

export interface SeatsResult {
  rows: SeatRow[];
  /** Same "endpoint unreachable" convention as `ConnectionsResult.unavailable`. */
  unavailable: boolean;
}

export async function listClaudeSeats(u: string, t: string, owner: SeatOwner = "me"): Promise<SeatsResult> {
  try {
    const rows = await platformFetch<SeatRow[]>(`/api/${t}/integrations/claude-seats?owner=${encodeURIComponent(owner)}`, u);
    return { rows, unavailable: false };
  } catch (e) {
    void (e instanceof PlatformError ? e.status : 0);
    return { rows: [], unavailable: true };
  }
}

export async function mapClaudeSeat(
  u: string,
  t: string,
  body: { userId?: string; codeSeatEmail: string; designLogin?: string },
): Promise<SeatRow> {
  return platformFetch<SeatRow>(`/api/${t}/integrations/claude-seats`, u, { method: "POST", body: JSON.stringify(body) });
}

export async function patchClaudeSeat(
  u: string,
  t: string,
  id: string,
  body: { codeSeatEmail?: string; designLogin?: string; status?: ClientSettableStatus },
): Promise<SeatRow> {
  return platformFetch<SeatRow>(`/api/${t}/integrations/claude-seats/${id}`, u, { method: "PATCH", body: JSON.stringify(body) });
}

export async function unmapClaudeSeat(u: string, t: string, id: string): Promise<SeatRow> {
  return platformFetch<SeatRow>(`/api/${t}/integrations/claude-seats/${id}`, u, { method: "DELETE" });
}

// ---------------- Pure helpers (unit-tested) ----------------

/** This person's mapped seat, if any — a person has at most one per company. */
export function mySeat(rows: SeatRow[], userId: string): SeatRow | undefined {
  return rows.find((r) => r.personId === userId && r.mapped);
}

/** `LauncherRow`'s `seatStatus`/`seatLabel` forward-compat props, derived from
 * a (possibly absent/unreachable) seat read — never guesses "unmapped" when
 * the read itself failed, since that would misreport a reachability problem
 * as a real seat state. */
export function launcherSeatProps(seat: SeatRow | undefined, unavailable: boolean): { seatStatus?: "mapped" | "unmapped"; seatLabel?: string } {
  if (unavailable) return {};
  if (seat?.mapped && seat.codeSeatEmail) return { seatStatus: "mapped", seatLabel: `opens as ${seat.codeSeatEmail}` };
  return { seatStatus: "unmapped" };
}
