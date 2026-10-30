"use server";
// SCP-5h (BFF §63.29.4): the onboarding page's writes.
//
//   startOnboarding   `POST engagements/:engagementId/onboarding`   the four, with the project's manage right too; PM's apply, idempotent on `id`
//   tickStep          `PATCH pm/tasks/:taskId` {status}              PM's own route and gate: ticking closes the PM task
//   moveKickoff       `PATCH pm/template-applications/:applicationId` PM's own route: re-dates the open steps
//   openBaselineAudit `POST audits`                                  the client's audit (63.28): a client with a draft answers it, so this "creates or opens" it
//
// The gates here are hints; the server's refusal is the boundary. Every refusal comes back as the contract's own code in `error` plus the words for it in `message`.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { asStarted, kickoffProblem, onboardingRefusalText, type OnboardingWrite, type StartedOnboarding } from "./socialOnboarding";

export type OnboardingActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; field?: string; message: string };

const social = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const pm = (t: string) => `/api/${encodeURIComponent(t)}/pm`;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

async function run<T extends object>(kind: OnboardingWrite, fn: (c: { userId: string; tenant: string }) => Promise<T>): Promise<OnboardingActionResult<T>> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "session_expired", message: onboardingRefusalText("session_expired", kind) };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "no_company", message: onboardingRefusalText("no_company", kind) };
  try {
    const out = await fn({ userId, tenant });
    revalidatePath("/departments", "layout");
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field, message: onboardingRefusalText(e.message, kind, e.field) };
    throw e;
  }
}

/** Starts a client's onboarding on `kickoff` (`YYYY-MM-DD`). `id` is a fresh uuid for this dialog, so a retry of it is the same application. */
export async function startOnboarding(engagementId: string, id: string, kickoff: string): Promise<OnboardingActionResult<{ started: StartedOnboarding }>> {
  const problem = kickoffProblem(kickoff);
  if (problem) return { ok: false, error: "invalid_field", field: "kickoff", message: problem };
  return run("start", async (c) => ({
    started: asStarted(await platformFetch<unknown>(`${social(c.tenant)}/engagements/${encodeURIComponent(engagementId)}/onboarding`, c.userId, {
      method: "POST", body: JSON.stringify({ id, kickoff }),
    })),
  }));
}

/** Ticks one step: the PM task moves to the project's done status. */
export async function tickStep(taskId: string, doneStatusId: string): Promise<OnboardingActionResult> {
  return run("tick", async (c) => {
    await platformFetch<unknown>(`${pm(c.tenant)}/tasks/${encodeURIComponent(taskId)}`, c.userId, { method: "PATCH", body: JSON.stringify({ status: doneStatusId }) });
    return {};
  });
}

/** Moves the kickoff: the application's open steps and milestones re-date from it (done steps never move). */
export async function moveKickoff(applicationId: string, kickoff: string): Promise<OnboardingActionResult> {
  const problem = kickoffProblem(kickoff);
  if (problem) return { ok: false, error: "invalid_field", field: "kickoff", message: problem };
  return run("move", async (c) => {
    await platformFetch<unknown>(`${pm(c.tenant)}/template-applications/${encodeURIComponent(applicationId)}`, c.userId, { method: "PATCH", body: JSON.stringify({ kickoff }) });
    return {};
  });
}

/** "Open baseline audit": creates the client's audit for its last full month, or opens the draft it already has. Answers the audit's id. */
export async function openBaselineAudit(engagementId: string): Promise<OnboardingActionResult<{ auditId: string }>> {
  return run("audit", async (c) => {
    const raw = await platformFetch<unknown>(`${social(c.tenant)}/audits`, c.userId, { method: "POST", body: JSON.stringify({ subject: "client", engagementId }) });
    const audit = isObj(raw) && isObj(raw.audit) ? raw.audit : null;
    if (!audit || typeof audit.id !== "string") throw new Error("onboarding: not an audit");
    return { auditId: audit.id };
  });
}
