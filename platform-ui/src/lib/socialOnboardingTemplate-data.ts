import "server-only";
// SCP-5 W5-C5 (BFF §63.29.1): the project templates the onboarding picker offers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the list (the chosen template's steps among them);
//   forbidden   a 403: PM's template routes are `pm_task` · `manage`, which a Social approver may lack, so the page says what it cannot show instead of an empty picker;
//   unavailable anything else: "cannot tell".
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asProjectTemplates, type ProjectTemplate } from "./socialOnboardingTemplate";

/** `GET pm/templates?kind=project`. */
export function getProjectTemplates(userId: string, tenantId: string): Promise<ReadResult<ProjectTemplate[]>> {
  return readResult(platformFetch<unknown>(`/api/${encodeURIComponent(tenantId)}/pm/templates?kind=project`, userId).then(asProjectTemplates));
}
