import "server-only";
// M5-V5-d — Website → Analytics → Experiments: the server reads and the call helper the actions use. The search property
// whose domain is the site's, then platform-nest's experiments API (docs/FRONTEND-BFF-CONTRACT.md §28e). Every body is
// parsed strictly; a failure is a state with words, never an empty list. platform-nest holds the Umami key.
import { platformFetch, PlatformError, getMe } from "./platform";
import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { listProperties } from "./websiteAnalytics";
import { matchProperty, AnalyticsShapeError } from "./websiteAnalyticsModel";
import { resultFromError } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import { ExperimentShapeError, parseExperimentBody, parseExperimentList, parseResults, type Experiment, type Results } from "./experimentsModel";

type Refusal = Exclude<WdResult<never>, { kind: "ok" }>;
const drift = (e: Error): Refusal => ({ kind: "unavailable", code: "contract_drift", reason: e.message });

const root = (company: string, propertyId: string) =>
  `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(propertyId)}/experiments`;

export type SiteExperiments =
  | { kind: "no_property" }
  | { kind: "ok"; propertyId: string; experiments: Experiment[] }
  | Refusal;

/** `domains`: the site's environment domains. `company` is the ERP tenant (not the WebDesk slug). */
export async function readSiteExperiments(userId: string, company: string, domains: Array<string | null>): Promise<SiteExperiments> {
  try {
    const property = matchProperty(await listProperties(userId, company), domains);
    if (!property) return { kind: "no_property" };
    const body = await platformFetch<unknown>(root(company, property.id), userId);
    return { kind: "ok", propertyId: property.id, experiments: parseExperimentList(body) };
  } catch (e) {
    if (e instanceof AnalyticsShapeError || e instanceof ExperimentShapeError) return drift(e);
    return resultFromError(e) as Refusal;
  }
}

export type ExperimentDetail =
  | { kind: "no_property" }
  | { kind: "ok"; propertyId: string; experiment: Experiment; results: Results }
  | Refusal;

export async function readExperimentDetail(userId: string, company: string, domains: Array<string | null>, experimentId: string): Promise<ExperimentDetail> {
  try {
    const property = matchProperty(await listProperties(userId, company), domains);
    if (!property) return { kind: "no_property" };
    const base = `${root(company, property.id)}/${encodeURIComponent(experimentId)}`;
    const [exp, res] = await Promise.all([platformFetch<unknown>(base, userId), platformFetch<unknown>(`${base}/results`, userId)]);
    return { kind: "ok", propertyId: property.id, experiment: parseExperimentBody(exp), results: parseResults(res) };
  } catch (e) {
    if (e instanceof AnalyticsShapeError || e instanceof ExperimentShapeError) return drift(e);
    return resultFromError(e) as Refusal;
  }
}

// ── for the server actions ("use server" files cannot export non-async helpers) ──

export type ExpCtx = { userId: string; company: string };
export async function expCtx(): Promise<ExpCtx | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const company = await getActiveTenant(await getMe(userId));
  return company ? { userId, company } : null;
}

export type CallResult<T> = { ok: true; data: T } | { ok: false; status: number; token?: string; existing?: Record<string, unknown> };

/** One write. A typed refusal keeps its token (`reason`) and its `existing` so the UI can say it in words. */
export async function expCall<T>(ctx: ExpCtx, propertyId: string, path: string, body: unknown): Promise<CallResult<T>> {
  try {
    const data = await platformFetch<T>(`${root(ctx.company, propertyId)}${path}`, ctx.userId, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
    });
    return { ok: true, data };
  } catch (e) {
    if (e instanceof PlatformError) {
      const token = e.reason ?? /^([a-z][a-z0-9_]+)(:|$)/.exec(e.message)?.[1];
      return { ok: false, status: e.status, token, existing: e.existing };
    }
    return { ok: false, status: 0 };
  }
}
