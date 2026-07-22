// WSD-4: onboarding/offboarding checklist instantiation (design §1/§4). A tenant-scoped
// hr_checklist_templates row (or the built-in fallback when none is seeded) becomes an hr_case
// (kind='onboarding'|'offboarding') whose `details.items` is the live checklist. Shared by the
// `user.invited` eventHandler (auto-instantiate on invite) and the manual
// POST .../onboarding/instantiate endpoint (HrController) — one implementation, so neither path
// can drift from the other.
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import type { OutboxEvent } from "../../events/types";

export interface ChecklistItem {
  label: string;
  done: boolean;
  doneBy?: string | null;
  doneAt?: string | null;
}

/** Instantiate one onboarding/offboarding hr_case for `subjectUserId`, from `templateId` if given,
 *  else the tenant's default template for `kind`, else an empty checklist (never a hard failure —
 *  an unseeded template must not block onboarding a person). Returns the new case id, or null when
 *  hr is not enabled for this tenant (a defensive check the manual endpoint's ModuleEnabledGuard
 *  already covers; the event-handler call site needs its own since it isn't behind that guard). */
export async function instantiateChecklistCase(
  tenantId: string,
  subjectUserId: string,
  kind: "onboarding" | "offboarding",
  createdBy: string,
  templateId?: string,
): Promise<string | null> {
  return withTenants(
    [tenantId],
    async (c) => {
      const tmpl = templateId
        ? await c.query<{ id: string; name: string; items: Array<{ label: string }> }>(
            `SELECT id, name, items FROM hr_checklist_templates
             WHERE id = $1 AND tenant_id = $2 AND kind = $3 AND deleted_at IS NULL`,
            [templateId, tenantId, kind],
          )
        : await c.query<{ id: string; name: string; items: Array<{ label: string }> }>(
            `SELECT id, name, items FROM hr_checklist_templates
             WHERE tenant_id = $1 AND kind = $2 AND is_default = true AND deleted_at IS NULL
             ORDER BY created_at LIMIT 1`,
            [tenantId, kind],
          );
      const t = tmpl.rows[0];
      const items: ChecklistItem[] = (t?.items ?? []).map((i) => ({ label: i.label, done: false }));
      const id = newId();
      await c.query(
        `INSERT INTO hr_cases (id, tenant_id, subject_user_id, kind, title, details, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id, tenantId, subjectUserId, kind,
          t?.name ?? `${kind[0].toUpperCase()}${kind.slice(1)} checklist`,
          JSON.stringify({ items }), createdBy, config.originSite,
        ],
      );
      await emitEvent(c, tenantId, "hr_case", id, "hr.case.created", { kind, subjectUserId, templateId: t?.id ?? null });
      return id;
    },
    { modules: ["hr"] },
  );
}

/** eventHandlers["user.invited"] — auto-spawn the default onboarding checklist. A no-op (not an
 *  error) when the invite didn't carry an inviting actor (createdBy is a NOT NULL FK on hr_cases;
 *  fail-soft rather than crash the consumer's dispatch loop over a missing optional field). The
 *  consumer only calls this when isModuleEnabled(event.tenantId,'hr') is true (registry.ts), which
 *  covers BOTH enabled_modules and the served-via-assignment path (WSD-4 §4). */
export async function instantiateDefaultOnboarding(event: OutboxEvent): Promise<void> {
  const payload = event.payload as { invitedBy?: string | null };
  const invitedBy = payload.invitedBy;
  if (!invitedBy) return;
  await instantiateChecklistCase(event.tenantId, event.entityId, "onboarding", invitedBy);
}
