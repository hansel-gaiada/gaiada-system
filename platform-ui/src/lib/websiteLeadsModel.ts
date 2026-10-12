// M5-L6 - Website -> Leads: the shape of platform-nest's `GET /api/:t/agency/web-leads/:siteSlug`
// (agency-leads.controller.ts::webLeads -> agency-web-leads.service.ts::listWebLeads), a strict-but-plain parser, and
// the words the tab uses. Pure: no server-only imports, so the browser and the tests can use it.
//
// Privacy shape, enforced on BOTH sides: the server sends click-id NAMES only ("gclid"), never a value. This parser
// refuses a click-id entry that is not one of the six known names, so a value can never be rendered by accident.

export const CLICK_ID_NAMES = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "li_fat_id"] as const;
export type ClickIdName = (typeof CLICK_ID_NAMES)[number];

export interface WebLeadAttribution {
  landing: string | null;
  formPage: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  clickIds: ClickIdName[];
}

export interface WebLead {
  id: string;
  orgName: string;
  contactName: string | null;
  originForm: string | null;
  createdAt: string;
  status: string;
  stage: string;
  attribution: WebLeadAttribution;
  /** true / false = the visitor's banner choice for marketing; null = unknown, which counts as no consent. */
  marketingConsent: boolean | null;
}

export interface WebLeadsBody {
  leadIntakeEnabled: boolean;
  truncated: boolean;
  leads: WebLead[];
}

export class WebLeadsShapeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const req = (v: unknown, what: string, at: string): never => {
  throw new WebLeadsShapeError(`${at}: expected ${what}`);
};
const str = (v: unknown, at: string): string => (typeof v === "string" ? v : req(v, "a string", at));
const strN = (v: unknown, at: string): string | null => (v === null ? null : str(v, at));
const bool = (v: unknown, at: string): boolean => (typeof v === "boolean" ? v : req(v, "a boolean", at));

function parseAttribution(v: unknown, at: string): WebLeadAttribution {
  if (!isObj(v)) return req(v, "an object", at);
  const ids = v.clickIds;
  if (!Array.isArray(ids)) req(ids, "an array", `${at}.clickIds`);
  const clickIds = (ids as unknown[]).map((x, i) => {
    if (typeof x !== "string" || !(CLICK_ID_NAMES as readonly string[]).includes(x)) return req(x, `a click-id name (${CLICK_ID_NAMES.join(", ")})`, `${at}.clickIds[${i}]`);
    return x as ClickIdName;
  });
  return {
    landing: strN(v.landing, `${at}.landing`), formPage: strN(v.formPage, `${at}.formPage`), referrer: strN(v.referrer, `${at}.referrer`),
    utmSource: strN(v.utmSource, `${at}.utmSource`), utmMedium: strN(v.utmMedium, `${at}.utmMedium`), utmCampaign: strN(v.utmCampaign, `${at}.utmCampaign`),
    clickIds,
  };
}

function parseLead(v: unknown, at: string): WebLead {
  if (!isObj(v)) return req(v, "an object", at);
  const consent = v.marketingConsent;
  if (consent !== null && typeof consent !== "boolean") req(consent, "a boolean or null", `${at}.marketingConsent`);
  return {
    id: str(v.id, `${at}.id`), orgName: str(v.orgName, `${at}.orgName`), contactName: strN(v.contactName, `${at}.contactName`),
    originForm: strN(v.originForm, `${at}.originForm`), createdAt: str(v.createdAt, `${at}.createdAt`),
    status: str(v.status, `${at}.status`), stage: str(v.stage, `${at}.stage`),
    attribution: parseAttribution(v.attribution, `${at}.attribution`), marketingConsent: consent as boolean | null,
  };
}

export function parseWebLeads(body: unknown): WebLeadsBody {
  if (!isObj(body)) return req(body, "an object", "web-leads");
  if (!Array.isArray(body.leads)) req(body.leads, "an array", "web-leads.leads");
  return {
    leadIntakeEnabled: bool(body.leadIntakeEnabled, "web-leads.leadIntakeEnabled"),
    truncated: bool(body.truncated, "web-leads.truncated"),
    leads: (body.leads as unknown[]).map((l, i) => parseLead(l, `web-leads.leads[${i}]`)),
  };
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────────

export const EMPTY_LEADS_COPY = "No website leads yet. Leads appear here once the site's forms post to WebDesk and lead intake is switched on.";
export const INTAKE_OFF_COPY = "Lead intake is off. Form submissions are not being filed as leads, so this list will not grow until it is switched on.";

/** `proposal` -> "Proposal"; `in_review` -> "In review". An unknown value is shown as itself, humanised, never dropped. */
export function humanize(v: string): string {
  const s = v.replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : v;
}

export interface ConsentBadge { label: string; tone: "ok" | "warn" | "neutral" }
/** Unknown is NOT shown as consent: it is its own words and its own tone. */
export function consentBadge(marketing: boolean | null): ConsentBadge {
  if (marketing === true) return { label: "Marketing consent", tone: "ok" };
  if (marketing === false) return { label: "No marketing consent", tone: "warn" };
  return { label: "Consent unknown", tone: "neutral" };
}

/** "gclid ✓" - the id's presence, never its value. */
export const clickIdLabel = (name: ClickIdName): string => `${name} ✓`;

/** A fixed, locale-independent UTC stamp, so a server render and a client render agree. */
export function receivedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

export function utmSummary(a: WebLeadAttribution): string | null {
  const parts = [a.utmSource, a.utmMedium, a.utmCampaign].filter((x): x is string => !!x);
  return parts.length ? parts.join(" / ") : null;
}
