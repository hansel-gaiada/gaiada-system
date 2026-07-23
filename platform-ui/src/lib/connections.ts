import "server-only";
// F1 connections subsystem (WSUX-14 vault, WSUX-16 UI) — the per-company
// integration-credential vault: github / google_drive / claude account
// links. Backend is BUILT (`src/core/integrations.controller.ts`,
// FRONTEND-BFF-CONTRACT.md §12); this is the first UI consumer.
//
// Phase-1 posture (locked, do not relax without a backend-owner decision):
// the HTTP create/patch surface accepts NO tokens at all — a credential can
// only ever be sealed by an internal Phase-2 OAuth callback. So every write
// this file makes is identity/mapping-only (externalAccount, scopes, meta);
// `hasToken`/`hasRefreshToken` are read-only booleans the UI may DISPLAY but
// must never try to set or unmask — there is no raw secret to unmask.
//
// BFF CONTRACT (§12, mounted /api/:t/integrations/connections):
//   GET    ?owner=me|company|user:<id>&provider=        -> ConnectionRow[]
//   POST   {provider, ownerKind?, ownerId?, externalAccount?, scopes?, meta?} -> 201 ConnectionRow
//   PATCH  /:id {externalAccount?, meta?, status?, scopes?}                   -> 200 ConnectionRow
//   DELETE /:id                                          -> 200 ConnectionRow (soft revoke)
import { platformFetch, PlatformError } from "./platform";

export type ConnectionProvider = "github" | "google_drive" | "claude";
export const CONNECTION_PROVIDERS: ConnectionProvider[] = ["github", "google_drive", "claude"];

export type ConnectionStatus = "unconfigured" | "pending" | "linked" | "error" | "revoked";
// Client-settable subset (contract §12: `linked` is set only by the token
// path, `revoked` only by DELETE — a PATCH sending either is a 400).
export type ClientSettableStatus = "unconfigured" | "pending" | "error";

export interface ConnectionRow {
  id: string;
  tenantId: string;
  ownerKind: "user" | "company";
  ownerId: string;
  provider: ConnectionProvider;
  externalAccount: string | null;
  scopes: string[];
  status: ConnectionStatus;
  hasToken: boolean;
  hasRefreshToken: boolean;
  tokenExpiresAt: string | null;
  tokenKeyVersion: string | null;
  meta: Record<string, unknown>;
  createdBy: string | null;
  originSite: string;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionOwner = "me" | "company" | `user:${string}`;

export interface ConnectionsResult {
  rows: ConnectionRow[];
  /** True when the endpoint itself couldn't be reached (404 — not deployed
   *  yet on the running backend — or any transport failure), distinct from a
   *  genuinely-empty result. Same convention as `lib/approvals.ts`'s
   *  `ApprovalsResult.unavailable` (WSUX-6) — never throws into a page. */
  unavailable: boolean;
}

function qs(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : "";
}

export async function listConnections(
  u: string,
  t: string,
  q: { owner?: ConnectionOwner; provider?: ConnectionProvider } = {},
): Promise<ConnectionsResult> {
  const path = `/api/${t}/integrations/connections${qs({ owner: q.owner, provider: q.provider })}`;
  try {
    const rows = await platformFetch<ConnectionRow[]>(path, u);
    return { rows, unavailable: false };
  } catch (e) {
    void (e instanceof PlatformError ? e.status : 0);
    return { rows: [], unavailable: true };
  }
}

// ---------------- Writers (throw PlatformError — the caller is an explicit
// user action inside a server action, which needs the real error message). ----

export async function createConnection(
  u: string,
  t: string,
  body: {
    provider: ConnectionProvider;
    ownerKind?: "user" | "company";
    ownerId?: string;
    externalAccount?: string;
    scopes?: string[];
    meta?: Record<string, unknown>;
  },
): Promise<ConnectionRow> {
  return platformFetch<ConnectionRow>(`/api/${t}/integrations/connections`, u, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function patchConnection(
  u: string,
  t: string,
  id: string,
  body: { externalAccount?: string; meta?: Record<string, unknown>; status?: ClientSettableStatus; scopes?: string[] },
): Promise<ConnectionRow> {
  return platformFetch<ConnectionRow>(`/api/${t}/integrations/connections/${id}`, u, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function revokeConnection(u: string, t: string, id: string): Promise<ConnectionRow> {
  return platformFetch<ConnectionRow>(`/api/${t}/integrations/connections/${id}`, u, { method: "DELETE" });
}

// ---------------- Pure helpers (unit-tested) ----------------

export function providerLabel(p: ConnectionProvider): string {
  if (p === "github") return "GitHub";
  if (p === "google_drive") return "Google Drive";
  return "Claude";
}

// The row for a given provider that still represents a live mapping — a
// soft-revoked row is excluded (the UI treats it the same as "never
// connected", matching §12's own DELETE convention of keeping-but-hiding it).
export function findConnection(rows: ConnectionRow[], provider: ConnectionProvider): ConnectionRow | undefined {
  return rows.find((r) => r.provider === provider && r.status !== "revoked");
}
