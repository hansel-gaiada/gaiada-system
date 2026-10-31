"use server";
// SCP-5 W5-C5 (BFF §63.29.1, §63.29.2): the onboarding template's two writes.
//
//   chooseOnboardingTemplate   `PUT settings`                 `{onboardingTemplateId}`: the company's template (null clears it); `social_engagement` · `plan`, the four
//   saveTemplateSteps          `PATCH pm/templates/:id`       `{payload}`: PM's own route, `pm_task` · `manage`; a template already applied keeps its own copy (63.29.1), so only the next onboardings change
//
// The gates here are hints; the server's refusal is the boundary. Every refusal comes back as the contract's code in `refusal.error` with the words for it in `message`.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { refusalFromBody, type Refusal } from "./socialPipeline";
import { templateBody, templateRefusalText, type TemplatePayload, type TemplateWrite } from "./socialOnboardingTemplate";

export type TemplateActionResult = { ok: true } | { ok: false; refusal: Refusal; message: string };

const fail = (refusal: Refusal, kind: TemplateWrite): { ok: false; refusal: Refusal; message: string } => ({ ok: false, refusal, message: templateRefusalText(refusal, kind) });

async function run(kind: TemplateWrite, fn: (c: { userId: string; tenant: string }) => Promise<unknown>): Promise<TemplateActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return fail({ status: 401, error: "session_expired" }, kind);
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return fail({ status: 400, error: "no_company" }, kind);
  try {
    await fn({ userId, tenant });
    revalidatePath("/departments", "layout");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return fail(refusalFromBody(e.status, e.message, e.body, e.field, e.reason), kind);
    throw e;
  }
}

/** Choose the company's onboarding template, or clear the choice with null. */
export async function chooseOnboardingTemplate(templateId: string | null): Promise<TemplateActionResult> {
  return run("choose", (c) => platformFetch<unknown>(`/api/${encodeURIComponent(c.tenant)}/modules/social/settings`, c.userId, { method: "PUT", body: JSON.stringify({ onboardingTemplateId: templateId }) }));
}

/** Save the template's phases, roles and steps through PM's route. */
export async function saveTemplateSteps(templateId: string, payload: TemplatePayload): Promise<TemplateActionResult> {
  return run("save", (c) => platformFetch<unknown>(`/api/${encodeURIComponent(c.tenant)}/pm/templates/${encodeURIComponent(templateId)}`, c.userId, { method: "PATCH", body: JSON.stringify(templateBody(payload)) }));
}
