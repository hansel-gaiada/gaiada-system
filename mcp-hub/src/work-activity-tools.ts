// WD-26 — hub-native tools fronting the platform's work_activity surface (P1-04/WSUX-15), the
// same "thin front, no DB access, forward OBO" shape as pipeline-tools.ts. Kept in their own file
// (not platform-tools.ts) because these are the digest/nag automation's ONLY data seam and the
// ticket's locked decision flags a real trap here worth naming loudly:
//
// ⚠ `activity.feed` (registered in platform-tools.ts) reads the LEGACY flat `activities` audit
// table, NOT work_activity — it does NOT serve digests. Do not wire wd-digests/wd-stale-nag to it.
import { config } from "./config";
import { registerTool } from "./registry";
import type { Principal } from "./principal";

async function platformGet(path: string, principal: Principal): Promise<string> {
  const res = await fetch(`${config.platformUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${config.platformToken}`,
      "x-obo-provider": principal.provider,
      "x-obo-external-id": principal.externalId,
    },
  });
  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

async function platformSend(method: "POST" | "PATCH", path: string, body: unknown, principal: Principal): Promise<string> {
  const res = await fetch(`${config.platformUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.platformToken}`,
      "x-obo-provider": principal.provider,
      "x-obo-external-id": principal.externalId,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

export function registerWorkActivityTools(): void {
  registerTool({
    name: "workActivity.feed",
    description:
      "Recent work_activity rows (pm/pipeline/github/google_drive/claude/manual/system), auto-linked to project/person/department. This is the WD-26 digest source — DISTINCT from `activity.feed`, which reads the legacy flat `activities` audit table and does NOT serve this feed. Optional filters: deptId, projectId, personId, since (ISO timestamp), limit (1..500, default 100).",
    minAssurance: "low", // the platform's Cerbos policy (resource_work_activity, member+) is the real gate
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        deptId: { type: "string" },
        projectId: { type: "string" },
        personId: { type: "string" },
        since: { type: "string", description: "ISO timestamp — only activity at/after this time" },
        limit: { type: "number", description: "1..500 (default 100)" },
      },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const qs = new URLSearchParams();
      if (args.deptId) qs.set("deptId", String(args.deptId));
      if (args.projectId) qs.set("projectId", String(args.projectId));
      if (args.personId) qs.set("personId", String(args.personId));
      if (args.since) qs.set("since", String(args.since));
      if (args.limit) qs.set("limit", String(args.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return platformGet(`/api/${String(args.tenantId)}/work-activity${suffix}`, principal);
    },
  });

  registerTool({
    name: "workActivity.staleTasks",
    description:
      "Open pm_tasks (status != done) with no linked work_activity in the last N days (default 5, 1..90). Each row carries assigneeUserId (nag target) + projectOwnerUserId (escalation target at 2N) + daysStale so the caller can bucket without a second call.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        days: { type: "number", description: "1..90 (default 5)" },
      },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const qs = args.days ? `?days=${Number(args.days)}` : "";
      return platformGet(`/api/${String(args.tenantId)}/work-activity/stale-tasks${qs}`, principal);
    },
  });

  registerTool({
    name: "workActivity.relink",
    description:
      "Deterministic relink sweep (LD-16): re-runs the pure auto-link engine over work_activity rows that currently have ZERO links, in a bounded batch (default 100). Idempotent — a row already linked is never revisited, so re-running with no new zero-link rows is a no-op. AI-suggested linking is explicitly out of v1.",
    minAssurance: "low",
    write: true,
    impact: "low", // append-only work_activity_links rows; no business mutation, no medium+ write
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        limit: { type: "number", description: "1..500 (default 100)" },
      },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const qs = args.limit ? `?limit=${Number(args.limit)}` : "";
      return platformSend("POST", `/api/${String(args.tenantId)}/work-activity/relink${qs}`, {}, principal);
    },
  });
}
