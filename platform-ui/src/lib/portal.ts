import "server-only";
// WS11 client portal — data layer for the CLIENT-facing dashboard (transparency + the client's own
// sign-offs). Thin readers over the portal BFF (PortalController); the BFF enforces the `client` role +
// per-run ownership (run.client_id -> clients.portal_user_id), so a staff user sees nothing here.
// Degrades gracefully (empty/null) on 403/404 — same pattern as lib/pipeline.ts.
//
// PROD auth note: a client authenticates via the external client Keycloak realm; in dev they dev-login
// as a `client`-role user linked to a clients row. Same dashboard, different login realm.
import { platformFetch, PlatformError } from "./platform";

export interface PortalRun {
  id: string;
  title: string | null;
  status: string;
  currentBlockage: string;
}
export interface PortalGate {
  id: string;
  kind: "prd_sign" | "scope_signoff" | "customer_feedback" | string;
  status: "pending" | "decided";
  decision: string | null;
  created_at: string;
}
export interface PortalStage {
  track: string;
  name: string;
  status: string;
  artifact_ref: string | null;
}
export interface PortalRunDetail extends PortalRun {
  stages: PortalStage[];
  gates: PortalGate[];
  scopeSignoffs: Array<{ party: string; signer_name: string | null; signed_at: string }>;
}

async function safe<T>(p: Promise<T>, fb: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fb;
    throw e;
  }
}

export async function listPortalRuns(userId: string, tenant: string): Promise<PortalRun[]> {
  return safe(platformFetch<PortalRun[]>(`/api/${tenant}/portal/runs`, userId), []);
}

export async function getPortalRun(userId: string, tenant: string, runId: string): Promise<PortalRunDetail | null> {
  return safe(platformFetch<PortalRunDetail>(`/api/${tenant}/portal/runs/${runId}`, userId), null);
}
