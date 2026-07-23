import "server-only";
// WSUX-8 (UX-2 daily-work spec, WS-UX plan v2) — thin BFF wrapper over the
// cross-company My-Work task read (`GET /api/tasks/mine`, WSUX-3, contract
// §9b) that backs the Tasks + Calendar pages' "all companies" scope. Mirrors
// `lib/approvals.ts`'s degrade convention exactly: a 404 (endpoint not yet
// deployed on the running backend) or any transport failure degrades to an
// empty, explicitly-flagged result — never throws into a page.
import { platformFetch, PlatformError } from "./platform";
import { normalizeEnvelope, type Envelope } from "./envelope";

export type AgendaTaskSource = "task" | "pm_task";

export interface AgendaTaskRow {
  id: string;
  title: string;
  status: string;
  dueDate: string | null; // YYYY-MM-DD
  tenantId: string;
  company: string;
  source: AgendaTaskSource;
  href: string;
}

export interface ListMyTasksOptions {
  scope?: "all" | string;
  status?: string;
  dueBefore?: string; // YYYY-MM-DD
}

export interface MyTasksResult {
  envelope: Envelope<AgendaTaskRow>;
  /** True when `/api/tasks/mine` itself couldn't be reached at all (vs. a
   *  per-company leg being excluded, which the envelope already reports) —
   *  same distinction `lib/approvals.ts` draws, so callers can show "not
   *  reachable yet" rather than a false "you have zero tasks". */
  unavailable: boolean;
}

export async function listMyTasks(userId: string, opts: ListMyTasksOptions = {}): Promise<MyTasksResult> {
  const p = new URLSearchParams();
  p.set("scope", opts.scope ?? "all");
  if (opts.status) p.set("status", opts.status);
  if (opts.dueBefore) p.set("dueBefore", opts.dueBefore);
  try {
    const raw = await platformFetch<unknown>(`/api/tasks/mine?${p.toString()}`, userId);
    return { envelope: normalizeEnvelope<AgendaTaskRow>(raw), unavailable: false };
  } catch (e) {
    // A 404 (route not deployed on the running backend yet) or any transport
    // failure degrades cleanly — never crashes Tasks/Calendar.
    void (e instanceof PlatformError ? e.status : 0);
    return { envelope: { items: [], companies: [] }, unavailable: true };
  }
}
