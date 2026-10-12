// PV3-04 (PV-D2) — which companies a platform operator may offer as "the group company this client IS".
// Pure and client-safe. None of this is a security boundary: the server re-checks that the caller is a
// platform operator and that the target is live and shares the client tenant's root (platform-nest
// `modules/clients/group-company.ts`); this only decides what is worth showing.
import type { Me } from "./platform";
import { activeCompany, isPlatformOperator } from "./companyContext";

export interface GroupCompanyOption { id: string; name: string }

/** The picker's options, or `null` when the person may not set the link at all (so the form renders no
 *  picker, rather than a disabled one). Same root as the active company, never the active company itself
 *  (a company is not its own client: PV-D10). `current` stays selectable even if the person is not a member
 *  of it, so saving an unrelated field never silently clears the link. */
export function groupCompanyOptions(
  me: Me,
  tenantId: string,
  current?: GroupCompanyOption | null,
): GroupCompanyOption[] | null {
  if (!isPlatformOperator(me)) return null;
  const root = activeCompany(me, tenantId)?.rootCompanyId ?? null;
  const options = me.companies
    .filter((c) => c.id !== tenantId && root !== null && c.rootCompanyId === root)
    .map((c) => ({ id: c.id, name: c.name }));
  if (current && !options.some((o) => o.id === current.id)) options.unshift({ id: current.id, name: current.name });
  return options;
}
