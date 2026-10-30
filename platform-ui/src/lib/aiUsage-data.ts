import "server-only";
// AIP-16 and AIP-05 (BFF §66): the AI usage readers. One egress (`platformFetch`). A refusal is data, never an empty month: a 403 is "forbidden";
// on the unit route a 404 (`unit_not_found`) is a real answer ("no such department"), so it is its own variant; anything else, including a
// malformed answer, is "unavailable" with the reason, never a month of nothing.
import { platformFetch, PlatformError } from "./platform";
import {
  asCompanyUsage, asMyUsage, asUnitUsage, companyUsagePath, myUsagePath, unitUsagePath,
  type CompanyUsage, type MyUsage, type UnitUsage,
} from "./aiUsage";

export type UsageRead<T> =
  | { kind: "ok"; data: T }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: string };

async function read<T>(path: string, userId: string, parse: (raw: unknown) => T, notFoundIsAnswer: boolean): Promise<UsageRead<T>> {
  try {
    return { kind: "ok", data: parse(await platformFetch<unknown>(path, userId)) };
  } catch (err) {
    if (err instanceof PlatformError) {
      if (err.status === 403) return { kind: "forbidden" };
      if (err.status === 404 && notFoundIsAnswer) return { kind: "not_found" };
      return { kind: "unavailable", reason: err.message };
    }
    return { kind: "unavailable", reason: (err as Error)?.message ?? "unknown error" };
  }
}

/** `GET /ai-usage/me?month=` (§66.3): the caller's own month. */
export const getMyAiUsage = (userId: string, tenantId: string, month: string): Promise<UsageRead<MyUsage>> =>
  read(myUsagePath(tenantId, month), userId, asMyUsage, false);

/** `GET /ai-usage/units/:unitNodeId?month=` (§66.4). 404 `unit_not_found` is `not_found`. */
export const getUnitAiUsage = (userId: string, tenantId: string, unitNodeId: string, month: string): Promise<UsageRead<UnitUsage>> =>
  read(unitUsagePath(tenantId, unitNodeId, month), userId, asUnitUsage, true);

/** `GET /ai-usage/company?month=` (§66.5). */
export const getCompanyAiUsage = (userId: string, tenantId: string, month: string): Promise<UsageRead<CompanyUsage>> =>
  read(companyUsagePath(tenantId, month), userId, asCompanyUsage, false);
