import "server-only";
// CC-2 — the client hub reader. One call, one aggregate: `GET /api/:t/clients/:id/overview`
// (platform-nest `modules/clients/clients.controller.ts:clientOverview`).
//
// ── WHY THIS IS ONE FETCH AND MUST STAY ONE ──────────────────────────────────────────────────────
// The hub header shows projects, tasks, deliverables, money, the next milestone and BOTH ball lists.
// Assembling that from seven readers would put seven round trips on the page a manager opens most
// often, and the portal already paid that bill once (`/portal/runs` was 2N+1 — up to 201 requests for
// one screen). If a new tile is needed, extend the aggregate rather than adding a fetch here.
//
// ── DEGRADE RULE ────────────────────────────────────────────────────────────────────────────────
// A 404 means the client does not exist in this tenant — the PAGE should 404, so it is returned as
// `null` and the caller decides. Everything else (500, network) is allowed to THROW into the route's
// error boundary, deliberately: a hub that renders zeroes on a backend outage tells a manager their
// client has no work, no money owed and nobody waiting — the single most expensive wrong answer this
// screen can give. An empty state must mean "empty", never "we could not ask".
import { platformFetch, PlatformError } from "./platform";

/** One outstanding item, on either side of the relationship. */
export interface ClientBallItem {
  kind: "payment" | "review" | "request" | "contract" | "gate";
  id: string;
  label: string;
  context: string;
  href: string;
  since: string | null;
}

export interface ClientMoneyRow {
  currency: string;
  invoiced: number;
  drafted: number;
  paid: number;
  pendingConfirmation: number;
  outstanding: number;
  overdueCount: number;
  openCount: number;
}

export interface ClientOverview {
  client: { id: string; name: string; status: string | null; contact: Record<string, unknown> | null };
  projects: { total: number; active: number; done: number; percent: number };
  tasks: { total: number; open: number; overdue: number; blocked: number };
  deliverables: { total: number; delivered: number; overdue: number };
  nextMilestone: {
    id: string; name: string; dueDate: string | null; status: string;
    projectId: string; projectName: string;
  } | null;
  money: { byCurrency: ClientMoneyRow[]; primary: ClientMoneyRow | null };
  /** Outstanding items only WE can clear. The list nothing in the ERP rendered before CC-2. */
  needsUs: ClientBallItem[];
  /** Outstanding items only the CLIENT can clear — the staff view of what the portal is asking them. */
  needsClient: ClientBallItem[];
}

export async function getClientOverview(
  userId: string,
  tenant: string,
  clientId: string,
): Promise<ClientOverview | null> {
  try {
    return await platformFetch<ClientOverview>(`/api/${tenant}/clients/${clientId}/overview`, userId);
  } catch (err) {
    if (err instanceof PlatformError && err.status === 404) return null;
    throw err;
  }
}
