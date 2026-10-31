"use server";
// SCP-5 W5-A4 (BFF §63.25.3): the ideas' writes, on the monthly report's page.
//
//   addIdea     `POST engagements/:engagementId/ideas`   what we saw, the metric it rests on, what we suggest; carries the report's id; a replayed `id` is the same idea
//   shareIdea   `POST ideas/:ideaId/share`               proposed -> shared; on `shared` the server answers `alreadyApplied`
//   planIdea    `POST ideas/:ideaId/plan` {cycleId}      "Add to next plan": a `planned` post of the picked cycle, linked both ways, in one transaction
//   deleteIdea  `DELETE ideas/:ideaId`                   a soft delete while `proposed` or `shared`
//
// The gate is the client's would-be post (the officer and the four); the server's 403 is the boundary, and the list's `canWrite` only decides which buttons are drawn. Every refusal comes back as
// the contract's own code with the words for it (`ideaRefusalText`), never thrown.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { refusalFromBody, type Refusal } from "./socialPipeline";
import { asIdea, asIdeaAnswer, ideaRefusalText, type Idea, type IdeaWriteKind } from "./socialIdeas";

export type IdeaWrite<T = object> = ({ ok: true } & T) | { ok: false; refusal: Refusal; message: string };
export interface PlannedPost { id: string; title: string; cycleId: string; cycleMonth: string }

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (refusal: Refusal, kind: IdeaWriteKind): { ok: false; refusal: Refusal; message: string } => ({ ok: false, refusal, message: ideaRefusalText(refusal, kind) });

async function run<T extends object>(kind: IdeaWriteKind, fn: (c: { userId: string; tenant: string }) => Promise<T>): Promise<IdeaWrite<T>> {
  const userId = await getSessionUserId();
  if (!userId) return fail({ status: 401, error: "session_expired" }, kind);
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return fail({ status: 400, error: "no_company" }, kind);
  try {
    const out = await fn({ userId, tenant });
    revalidatePath("/departments", "layout");
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof PlatformError) return fail(refusalFromBody(e.status, e.message, e.body, e.field, e.reason), kind);
    throw e;
  }
}

const send = (c: { userId: string; tenant: string }, path: string, method: string, body?: unknown) =>
  platformFetch<unknown>(`${base(c.tenant)}/${path}`, c.userId, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** `POST engagements/:engagementId/ideas`. `id` is a fresh uuid for this click, so a replay of it is the same idea. */
export async function addIdea(engagementId: string, body: { saw: string; metric: string | null; suggestion: string; reportId?: string }, id: string): Promise<IdeaWrite<{ idea: Idea }>> {
  return run("add", async (c) => ({ idea: asIdeaAnswer(await send(c, `engagements/${encodeURIComponent(engagementId)}/ideas`, "POST", { id, ...body })) }));
}

/** `POST ideas/:ideaId/share`. */
export async function shareIdea(ideaId: string): Promise<IdeaWrite<{ idea: Idea }>> {
  return run("share", async (c) => ({ idea: asIdeaAnswer(await send(c, `ideas/${encodeURIComponent(ideaId)}/share`, "POST", {})) }));
}

/** `POST ideas/:ideaId/plan` {cycleId}: the idea becomes a `planned` post of that cycle. */
export async function planIdea(ideaId: string, cycleId: string): Promise<IdeaWrite<{ idea: Idea; post: PlannedPost }>> {
  return run("plan", async (c) => {
    const o = await send(c, `ideas/${encodeURIComponent(ideaId)}/plan`, "POST", { cycleId });
    if (!isObj(o) || !isObj(o.post) || typeof o.post.id !== "string") throw new Error("idea plan: not a plan answer");
    const p = o.post;
    return {
      idea: asIdea(o.idea),
      post: { id: p.id as string, title: typeof p.title === "string" ? p.title : "", cycleId: typeof p.cycleId === "string" ? p.cycleId : cycleId, cycleMonth: typeof p.cycleMonth === "string" ? p.cycleMonth : "" },
    };
  });
}

/** `DELETE ideas/:ideaId`. */
export async function deleteIdea(ideaId: string): Promise<IdeaWrite> {
  return run("delete", async (c) => { await send(c, `ideas/${encodeURIComponent(ideaId)}`, "DELETE"); return {}; });
}
