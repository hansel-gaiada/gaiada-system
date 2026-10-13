import "server-only";
// PV5-04b — the readers behind the "Service lines" and "Number codes" sections of `/finance/settings/billing-profile` and the
// service-line picker on the staff invoice page. Types: `billingNumbering.ts`.
//
//   GET /api/:t/billing/service-lines -> ServiceLine[]   (`finance_config` read)
//   GET /api/:t/billing/number-codes  -> NumberCodes     (`finance_config` read; STAFF ONLY, never in a portal read)
//
// Both THROW on a refusal or a failure: the settings page wraps them in `readResult()` so a refused read is shown as a
// refusal, never as "no service lines yet" (which would invite adding a duplicate). The picker uses `serviceLinesOrNull`,
// which degrades to "no list" instead: the picker is a convenience, and the server's own check at Issue is the gate.
import { platformFetch, PlatformError } from "./platform";
import type { NumberCodes, ServiceLine } from "./billingNumbering";

export const getServiceLines = (userId: string, tenant: string) =>
  platformFetch<ServiceLine[]>(`/api/${tenant}/billing/service-lines`, userId);

export const getNumberCodes = (userId: string, tenant: string) =>
  platformFetch<NumberCodes>(`/api/${tenant}/billing/number-codes`, userId);

/** The lines for a picker, or null when the viewer may not read them (a 403) or the route is not served (a 404). */
export async function serviceLinesOrNull(userId: string, tenant: string): Promise<ServiceLine[] | null> {
  try {
    return await getServiceLines(userId, tenant);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}
