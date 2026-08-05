// Cerbos policy-decision client (5b.4). Replaces the in-code check() with the SAME
// signature — call sites are unchanged. The principal's raw grants + authorized-tenant
// set + assurance become Cerbos principal attributes; the scope cascade lives in the
// versioned policy repo (cerbos/policies). PlanResources (D16) turns a list authorization
// into a predicate the RLS query can push down instead of N per-row checks.
import { config } from "../config";
import type { Principal } from "./principal";

export interface Resource {
  kind: string;
  id?: string;
  tenantId?: string;
  ownerId?: string;
  projectId?: string;
  teamId?: string;
  module?: string;
  /** WSD-4: the HR-case/record/leave "subject" (the employee the row is about), so the
   *  member-self-service derived-role rules (resource_hr_case.yaml et al.) can match
   *  `resource.attr.subjectUserId == principal.id`. Omitted -> "" -> those rules fail
   *  closed (never a leak from a handler that forgot to pass it). */
  subjectUserId?: string;
  /** ASST-21: a free-text origin marker (currently only `"assistant_handoff"`) so the additive
   *  `agent_run` rule (resource_agent_run.yaml) can be scoped to EXACTLY runs created through the
   *  assistant's handoff endpoint, never every owner-attributed run in the platform. Omitted -> "" ->
   *  that rule's `==` comparison fails closed, same convention as every other optional attr here. */
  origin?: string;
}

export type Decision = { allow: true } | { allow: false; reason: string };

function principalPayload(p: Principal) {
  return {
    id: p.userId ?? "anonymous",
    roles: ["user"], // base role; the real logic is in derived roles over attr.grants
    attr: {
      assurance: p.assurance,
      companies: p.companies,
      grants: p.roles.map((g) => ({ role: g.role, scopeType: g.scopeType, scopeId: g.scopeId ?? "" })),
    },
  };
}

function resourcePayload(r: Resource) {
  return {
    kind: r.kind,
    id: r.id ?? "new",
    attr: {
      id: r.id ?? "",
      tenantId: r.tenantId ?? "",
      ownerId: r.ownerId ?? "",
      projectId: r.projectId ?? "",
      teamId: r.teamId ?? "",
      module: r.module ?? "",
      subjectUserId: r.subjectUserId ?? "",
      origin: r.origin ?? "",
    },
  };
}

/** Single authorization decision (Cerbos CheckResources). */
export async function check(p: Principal, r: Resource, action: string): Promise<Decision> {
  const res = await fetch(`${config.cerbosUrl}/api/check/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "platform",
      principal: principalPayload(p),
      resources: [{ actions: [action], resource: resourcePayload(r) }],
    }),
  });
  if (!res.ok) throw new Error(`cerbos ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ actions?: Record<string, string> }> };
  const effect = data.results?.[0]?.actions?.[action];
  return effect === "EFFECT_ALLOW" ? { allow: true } : { allow: false, reason: `cerbos denied ${action} on ${r.kind}` };
}

export interface QueryPlan {
  kind: "always-allowed" | "always-denied" | "conditional";
  /** For conditional plans: the raw Cerbos AST (the RLS layer maps the parts it supports). */
  condition?: unknown;
}

/**
 * PlanResources (D16): the authorization for a set-returning action as a PREDICATE rather
 * than N per-row checks. Callers apply the allowed-tenant filter (which the platform
 * already enforces via RLS) and treat "always-denied" as an early empty result.
 */
export async function planResources(p: Principal, kind: string, action: string): Promise<QueryPlan> {
  const res = await fetch(`${config.cerbosUrl}/api/plan/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "platform",
      principal: principalPayload(p),
      resource: { kind, attr: {} },
      action,
    }),
  });
  if (!res.ok) throw new Error(`cerbos plan ${res.status}`);
  const data = (await res.json()) as { filter?: { kind?: string; condition?: unknown } };
  const k = data.filter?.kind ?? "";
  if (k === "KIND_ALWAYS_ALLOWED") return { kind: "always-allowed" };
  if (k === "KIND_ALWAYS_DENIED") return { kind: "always-denied" };
  return { kind: "conditional", condition: data.filter?.condition };
}
