// Company-data tools (WS2 §6): thin fronts over the PLATFORM API. The hub forwards the
// caller's OBO envelope; the platform mints the principal, applies RBAC + RLS, and the
// hub returns whatever the platform allowed — no DB access, no authz logic duplicated.
import { config } from "./config";
import { oboHeaders } from "./obo-headers";
import { registerTool } from "./registry";
import type { Principal } from "./principal";

async function platformGet(path: string, principal: Principal): Promise<string> {
  const res = await fetch(`${config.platformUrl}${path}`, {
    headers: {
      ...oboHeaders(principal, config.platformToken),
    },
  });
  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

const KNOWLEDGE_LIMIT_DEFAULT = 5; // the knowledge store's own default topK
const KNOWLEDGE_LIMIT_MAX = 20; // the platform route's maximum
const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface InternalKnowledge {
  status: "ok" | "unavailable" | "not_permitted";
  hits: unknown[];
  note?: string;
}

/** DW-D26: the internal tier, from the platform's `GET /api/:tenantId/knowledge/search` (BFF §46.1), which re-checks every hit
 *  against the caller's read right on its source record. Never throws: a refusal or an outage is REPORTED, as a status and a note,
 *  and never reads as "no internal hits". */
async function internalKnowledge(tenantId: string, query: string, limit: number, principal: Principal): Promise<InternalKnowledge> {
  const unavailable = (why: string): InternalKnowledge => ({
    status: "unavailable",
    hits: [],
    note: `Internal knowledge was unavailable (${why}); only public knowledge is shown.`,
  });
  let res: Response;
  try {
    res = await fetch(`${config.platformUrl}/api/${tenantId}/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
      headers: { ...oboHeaders(principal, config.platformToken) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return unavailable("the platform did not answer");
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "not_permitted", hits: [], note: "Internal knowledge is not permitted for this identity in this company; only public knowledge is shown." };
  }
  if (!res.ok) return unavailable(res.status === 400 ? "the query is too short or too long for an internal search" : `the platform answered ${res.status}`);
  let body: { results?: unknown };
  try {
    body = (await res.json()) as { results?: unknown };
  } catch {
    return unavailable("unreadable answer");
  }
  if (!Array.isArray(body.results)) return unavailable("unreadable answer");
  const hits = (body.results as Array<Record<string, unknown>>)
    .filter((r) => r && typeof r.sourceRef === "string")
    .map((r) => {
      const title = typeof r.title === "string" ? r.title : "";
      const snippet = typeof r.snippet === "string" ? r.snippet : "";
      return {
        tenantId,
        sourceRef: r.sourceRef as string,
        kind: typeof r.family === "string" ? r.family : "doc",
        text: title && snippet ? `${title}\n${snippet}` : title || snippet,
        score: typeof r.score === "number" ? r.score : 0,
        audience: "internal",
        title,
        ...(typeof r.href === "string" ? { href: r.href } : {}),
      };
    });
  return { status: "ok", hits };
}

export function registerPlatformTools(): void {
  registerTool({
    name: "projects.list",
    description: "List projects in a company you belong to (platform-authorized on your identity).",
    minAssurance: "low", // real authorization happens IN the platform per the OBO principal
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string", description: "Company id" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/projects`, principal),
  });

  registerTool({
    name: "projects.get",
    description: "Get one project's detail (client, owner, dates, custom fields).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, projectId: { type: "string" } },
      required: ["tenantId", "projectId"],
    },
    handler: (args, principal) =>
      platformGet(`/api/${String(args.tenantId)}/projects/${String(args.projectId)}`, principal),
  });

  registerTool({
    name: "tasks.list",
    description: "List a project's tasks.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["tenantId", "projectId"],
    },
    handler: (args, principal) =>
      platformGet(`/api/${String(args.tenantId)}/projects/${String(args.projectId)}/tasks`, principal),
  });

  registerTool({
    name: "tasks.get",
    description: "Get one task's detail (assignee, status, project, custom fields).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, taskId: { type: "string" } },
      required: ["tenantId", "taskId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/tasks/${String(args.taskId)}`, principal),
  });

  registerTool({
    name: "clients.list",
    description: "List the tenant's clients.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/clients`, principal),
  });

  registerTool({
    name: "clients.get",
    description: "Get one client's detail (contact, status, custom fields).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, clientId: { type: "string" } },
      required: ["tenantId", "clientId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/clients/${String(args.clientId)}`, principal),
  });

  registerTool({
    name: "deliverables.list",
    description: "List deliverables, optionally filtered by projectId or clientId.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, projectId: { type: "string" }, clientId: { type: "string" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const q = new URLSearchParams();
      if (args.projectId) q.set("projectId", String(args.projectId));
      if (args.clientId) q.set("clientId", String(args.clientId));
      const qs = q.toString();
      return platformGet(`/api/${String(args.tenantId)}/deliverables${qs ? `?${qs}` : ""}`, principal);
    },
  });

  registerTool({
    name: "deliverables.get",
    description: "Get one deliverable's detail.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, deliverableId: { type: "string" } },
      required: ["tenantId", "deliverableId"],
    },
    handler: (args, principal) =>
      platformGet(`/api/${String(args.tenantId)}/deliverables/${String(args.deliverableId)}`, principal),
  });

  registerTool({
    name: "time.list",
    description: "List time entries, optionally filtered by projectId, taskId, or mine=me.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        projectId: { type: "string" },
        taskId: { type: "string" },
        mine: { type: "string", description: "'me' to restrict to the caller's own entries" },
      },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const q = new URLSearchParams();
      if (args.projectId) q.set("projectId", String(args.projectId));
      if (args.taskId) q.set("taskId", String(args.taskId));
      if (args.mine) q.set("mine", String(args.mine));
      const qs = q.toString();
      return platformGet(`/api/${String(args.tenantId)}/time-entries${qs ? `?${qs}` : ""}`, principal);
    },
  });

  registerTool({
    name: "activity.feed",
    description: "Recent activity feed for the company (who did what, newest first).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, limit: { type: "number", description: "1..100 (default 20)" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const limit = args.limit ? `?limit=${Number(args.limit)}` : "";
      return platformGet(`/api/${String(args.tenantId)}/activity${limit}`, principal);
    },
  });

  registerTool({
    name: "knowledge.search",
    description:
      "Search company knowledge. Two tiers, and each hit says which it is: " +
      "`public` — published company information from gaiada.com, available to anyone; " +
      "`internal` — company records (clients, projects, tasks, deliverables, meetings, documents, files), " +
      "searched ONLY when you pass `tenantId` AND your identity resolves to a member of that company. " +
      "Internal hits are only records you could open in the ERP: each one is re-checked against your read " +
      "right on its source record, and reports, people and org structure are never returned. " +
      "Without `tenantId` (or with no identity) only the public tier is searched and the answer is a plain " +
      "array of hits. With `tenantId` the answer is `{ hits, internal, public }`, where `internal` says " +
      "`ok`, `unavailable` or `not_permitted` (with a note): when it is not `ok`, the hits are public-tier " +
      "only, and an absence of internal hits then means nothing. Never assume an empty result means the " +
      "fact does not exist — it may mean you are not authorized to see it.",
    minAssurance: "low", // the platform route (internal) and the knowledge service (public) both resolve the envelope (D9)
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tenantId: { type: "string", description: "Company id. Optional; required to search that company's internal knowledge." },
        limit: { type: "number", description: "Most hits to return, 1 to 20 (default 5)." },
        // Optional since D9.4: the public tier is not scope-gated, so a caller with no meaningful
        // scope (an agent, a web widget) can search without inventing one.
        scope: { type: "string", description: "Your current scope, e.g. group chat id. Optional; passed to the public-tier search. Internal hits are narrowed by `tenantId` and your read rights instead." },
        publicOnly: { type: "boolean", description: "Restrict to the public tier even if you are authorized for more." },
      },
      required: ["query"],
    },
    handler: async (args, principal) => {
      const query = String(args.query ?? "");
      const tenantId = typeof args.tenantId === "string" ? args.tenantId.trim() : "";
      const hasLimit = args.limit !== undefined && args.limit !== null && args.limit !== "";
      const limit = hasLimit ? Math.min(Math.max(Math.trunc(Number(args.limit)) || KNOWLEDGE_LIMIT_DEFAULT, 1), KNOWLEDGE_LIMIT_MAX) : KNOWLEDGE_LIMIT_DEFAULT;
      if (tenantId && !TENANT_ID_RE.test(tenantId)) throw new Error("tenantId is not a valid company id");

      // DW-D26 (BFF §46.9). The internal tier is NOT read from the knowledge service here: the store's rule is "every member of
      // the company", wider than the ERP's own reads. It comes from the platform's per-record-filtered search route instead.
      // Only a caller with an identity AND a company gets it; everyone else (a lead or client on WhatsApp) gets the public tier
      // exactly as before.
      const askInternal = tenantId !== "" && principal.assurance !== "anonymous" && args.publicOnly !== true;

      const publicCall = async (): Promise<unknown[]> => {
        const res = await fetch(`${config.knowledgeUrl}/search`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...oboHeaders(principal, config.knowledgeToken),
          },
          body: JSON.stringify({
            query,
            scope: String(args.scope ?? ""),
            // ALWAYS the public tier only: the store's internal tier is unfiltered ("every member of the company"), so the hub
            // never takes internal hits from it, for any caller. Internal hits come only from the platform route (above).
            publicOnly: true,
            ...(hasLimit ? { topK: limit } : {}),
          }),
        });
        if (!res.ok) throw new Error(`knowledge /search ${res.status}`);
        return ((await res.json()) as { hits: unknown[] }).hits;
      };

      if (!askInternal) return JSON.stringify(await publicCall());

      const [internal, pub] = await Promise.allSettled([internalKnowledge(tenantId, query, limit, principal), publicCall()]);
      const internalOut: InternalKnowledge =
        internal.status === "fulfilled" ? internal.value : { status: "unavailable", hits: [], note: "Internal knowledge was unavailable; only public knowledge is shown." };
      // The public tier failing is an error, as it always was, unless the internal tier answered: then its hits are not thrown away.
      if (pub.status === "rejected" && internalOut.status !== "ok") throw pub.reason;
      const publicHits = pub.status === "fulfilled" ? pub.value : [];
      return JSON.stringify({
        // Internal first, then public, never more than the requested limit.
        hits: [...internalOut.hits, ...publicHits].slice(0, limit),
        internal: { status: internalOut.status, ...(internalOut.note ? { note: internalOut.note } : {}) },
        public: { status: pub.status === "fulfilled" ? "ok" : "unavailable" },
      });
    },
  });

  registerTool({
    name: "knowledge.graph",
    description: "Traverse the company knowledge graph from an entity (WS8 semantic layer; results limited to what YOUR identity may see).",
    minAssurance: "low", // the knowledge service resolves the envelope and pre-filters the walk (D9.1)
    inputSchema: {
      type: "object",
      properties: {
        startKey: { type: "string", description: "entity key to start from, e.g. client:acme" },
        scope: { type: "string", description: "Your current scope, e.g. group chat / project id" },
        rel: { type: "string", description: "optional relation filter, e.g. owns" },
        maxDepth: { type: "number", description: "traversal depth (default 2)" },
      },
      required: ["startKey", "scope"],
    },
    handler: async (args, principal) => {
      const res = await fetch(`${config.knowledgeUrl}/graph/neighbors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...oboHeaders(principal, config.knowledgeToken),
        },
        body: JSON.stringify({ startKey: String(args.startKey ?? ""), scope: String(args.scope ?? ""), rel: args.rel, maxDepth: args.maxDepth }),
      });
      if (!res.ok) throw new Error(`knowledge /graph/neighbors ${res.status}`);
      return JSON.stringify(((await res.json()) as { nodes: unknown[] }).nodes);
    },
  });

  registerTool({
    name: "agent.feedback",
    description: "Give 👍/👎 feedback on an agent run (WS8 trainer signal). Your identity sets its trust: an unverified chat session's feedback is quarantined, never used to train.",
    minAssurance: "low", // knowledge derives trust from the resolved identity (D9.3); low ⇒ quarantined
    write: true,
    impact: "low", // appends a feedback row; never a business mutation
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "the agent run id being rated" },
        rating: { type: "string", enum: ["up", "down"] },
        note: { type: "string" },
      },
      required: ["runId", "rating"],
    },
    handler: async (args, principal) => {
      const res = await fetch(`${config.knowledgeUrl}/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...oboHeaders(principal, config.knowledgeToken),
        },
        body: JSON.stringify({ runId: String(args.runId ?? ""), rating: args.rating, note: args.note }),
      });
      if (!res.ok) throw new Error(`knowledge /feedback ${res.status}`);
      return JSON.stringify(await res.json());
    },
  });

  // NOTE: module-owned tools (e.g. agency.listCampaigns / agency.pendingApprovals) are no longer
  // hardcoded here — they are aggregated from the platform's ModuleContract.mcpTools at boot via
  // module-tools.ts (WS2 §6). Only core/cross-module tools live in this file.

  registerTool({
    name: "compliance.gates",
    description: "Compliance-gate statuses for a company (admin surface). Read-only.",
    minAssurance: "low", // the platform's Cerbos policy is the real gate (company_admin only)
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/compliance-gates`, principal),
  });
}
