// M5-P4 (WSK-D92) — Website -> Analytics -> "Tracking tags": the contract's types, strict parsers, the partner-id rule and every refusal as a
// sentence. Pure and client-safe (no I/O, no `server-only`): the card is a client component. Contract: docs/FRONTEND-BFF-CONTRACT.md §28h.
// The reader is trackingTags.ts (server-only), the write is trackingTagsActions.ts ("use server").

/** The site's rule for a LinkedIn partner id (`parseLinkedInPartnerId`): digits only, 1 to 15 of them, after trimming. */
export const PARTNER_ID_RE = /^[0-9]{1,15}$/;

/** M5-P4g: the Google Ads variable contract (shared with the site and the server). */
export const ADS_ID_RE = /^AW-[0-9]{6,15}$/;
export const ADS_CONVERSION_RE = /^(AW-[0-9]{6,15})\/([A-Za-z0-9_-]{1,64})$/;
export const ADS_MAX_IDS = 5;
export const ADS_CONVERSION_KEYS = ["lead", "whatsapp", "phone", "email"] as const;
export type AdsConversionKey = (typeof ADS_CONVERSION_KEYS)[number];
export type AdsConversions = { [K in AdsConversionKey]?: string };
export interface GoogleAds { ids: string[]; conversions: AdsConversions }
/** The four conversion fields, in the order the server writes them. */
export const ADS_CONVERSION_LABELS: Record<AdsConversionKey, string> = {
  lead: "Form lead", whatsapp: "WhatsApp click", phone: "Phone click", email: "Email click",
};

export type TrackingState = "ok" | "no_build_target" | "github_unavailable";

export interface TrackingTagsView {
  linkedin: { partnerId: string | null };
  googleAds: GoogleAds;
  target: { repo: string; variable: string } | null;
  canManage: boolean;
  state: TrackingState;
  /** A sentence, present when `state` is not `ok`. */
  reason: string | null;
}

export type PutResult = "set" | "cleared" | "unchanged";

export class TrackingTagsShapeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (why: string): never => { throw new TrackingTagsShapeError(why); };

function parseTarget(v: unknown): { repo: string; variable: string } | null {
  if (v === null) return null;
  if (!isObj(v) || typeof v.repo !== "string" || typeof v.variable !== "string") return bad("target: expected {repo, variable} or null");
  return { repo: v.repo, variable: v.variable };
}

function parsePartnerId(v: unknown): string | null {
  if (!isObj(v)) return bad("linkedin: expected an object");
  const p = v.partnerId;
  if (p !== null && typeof p !== "string") return bad("linkedin.partnerId: expected a string or null");
  return p;
}

function parseGoogleAds(v: unknown): GoogleAds {
  if (!isObj(v)) return bad("googleAds: expected an object");
  if (!Array.isArray(v.ids) || v.ids.length > ADS_MAX_IDS || !v.ids.every((i) => typeof i === "string" && ADS_ID_RE.test(i))) return bad("googleAds.ids: expected up to 5 AW- ids");
  if (!isObj(v.conversions)) return bad("googleAds.conversions: expected an object");
  const conversions: AdsConversions = {};
  for (const k of Object.keys(v.conversions)) {
    if (!(ADS_CONVERSION_KEYS as readonly string[]).includes(k)) return bad("googleAds.conversions: unknown key");
    const val = v.conversions[k];
    if (typeof val !== "string" || !ADS_CONVERSION_RE.test(val)) return bad(`googleAds.conversions.${k}: expected AW-…/label`);
    conversions[k as AdsConversionKey] = val;
  }
  return { ids: v.ids as string[], conversions };
}

/** `GET …/tracking-tags` 200 body, strict: anything off-contract is a defect to show, never read as "not set". */
export function parseTrackingTags(b: unknown): TrackingTagsView {
  if (!isObj(b)) return bad("tracking tags: expected an object");
  const state = b.state;
  if (state !== "ok" && state !== "no_build_target" && state !== "github_unavailable") return bad("state: unknown value");
  if (typeof b.canManage !== "boolean") return bad("canManage: expected a boolean");
  const reason = b.reason === undefined ? null : b.reason;
  if (reason !== null && typeof reason !== "string") return bad("reason: expected a string");
  if (state !== "ok" && !reason) return bad("a state that is not ok must carry a reason");
  return { linkedin: { partnerId: parsePartnerId(b.linkedin) }, googleAds: parseGoogleAds(b.googleAds), target: parseTarget(b.target), canManage: b.canManage, state, reason };
}

/** `PUT …/tracking-tags/linkedin` 200 body, strict. */
export function parsePutResponse(b: unknown): { partnerId: string | null; result: PutResult; repo: string } {
  if (!isObj(b)) return bad("tracking tags save: expected an object");
  const result = b.result;
  if (result !== "set" && result !== "cleared" && result !== "unchanged") return bad("result: unknown value");
  const target = parseTarget(b.target);
  if (!target) return bad("target: missing");
  return { partnerId: parsePartnerId(b.linkedin), result, repo: target.repo };
}

export interface TrackingSiteRef { webdeskTenant: string; site: string; name: string }

/** `GET …/tracking-tags/site` 200 body, strict: a site, or `null` (a real answer: no site of this company has the property's domain). */
export function parseFoundSite(b: unknown): { site: TrackingSiteRef | null } {
  if (!isObj(b) || !("site" in b)) return bad("tracking site: expected {site}");
  const s = b.site;
  if (s === null) return { site: null };
  if (!isObj(s) || typeof s.webdeskTenant !== "string" || typeof s.site !== "string" || typeof s.name !== "string" || !s.webdeskTenant || !s.site) {
    return bad("site: expected {webdeskTenant, site, name} or null");
  }
  return { site: { webdeskTenant: s.webdeskTenant, site: s.site, name: s.name } };
}

/** `PUT …/tracking-tags/google-ads` 200 body, strict. */
export function parseAdsPutResponse(b: unknown): { googleAds: GoogleAds; result: PutResult; repo: string } {
  if (!isObj(b)) return bad("google ads save: expected an object");
  const result = b.result;
  if (result !== "set" && result !== "cleared" && result !== "unchanged") return bad("result: unknown value");
  if (!isObj(b.target) || typeof b.target.repo !== "string") return bad("target: missing");
  return { googleAds: parseGoogleAds(b.googleAds), result, repo: b.target.repo };
}

/** The input as typed -> the id to send, or the plain message to show. Trimmed, digits only. */
export function checkPartnerId(input: string): { ok: true; value: string } | { ok: false; message: string } {
  const t = input.trim();
  if (t === "") return { ok: false, message: "Type the LinkedIn partner id first, or use Clear to remove it." };
  if (!PARTNER_ID_RE.test(t)) return { ok: false, message: "The LinkedIn partner id is digits only, up to 15 of them (for example 1234567). Nothing was saved." };
  return { ok: true, value: t };
}

export const TAGS_HELP =
  "The LinkedIn partner id comes from LinkedIn Campaign Manager → Insight Tag. Only needed if you run LinkedIn ads. "
  + "The tag loads only after a visitor accepts marketing cookies, and only once the site's tracking is live. "
  + "A change takes effect on the next rebuild of the site.";

/** What each save outcome says. Never "done": the change reaches visitors only at the next rebuild. */
export function savedSentence(result: PutResult, partnerId: string | null, repo: string): string {
  if (result === "unchanged") return partnerId === null ? "The LinkedIn partner id was already not set. Nothing changed." : `The LinkedIn partner id was already ${partnerId}. Nothing changed.`;
  if (result === "cleared") return `The LinkedIn partner id was removed from ${repo}. The site stops loading the tag at its next rebuild.`;
  return `The LinkedIn partner id ${partnerId} was saved to ${repo}. It reaches the site at its next rebuild.`;
}

/** Every refusal of the PUT (and of the GET) as one sentence. A reason token wins over the status; an unknown one still gets words. */
export function trackingRefusalSentence(status: number, reason: string | null): string {
  switch (reason) {
    case "partner_id_invalid": return "The LinkedIn partner id is digits only, up to 15 of them. Nothing was saved.";
    case "ads_body_invalid": return "The page and the server disagree about the shape of the Google Ads settings. Reload the page and try again. Nothing was saved.";
    case "ads_id_invalid": return "A Google Ads tag id was not accepted: each looks like AW-123456789, at most 5, none twice. Nothing was saved.";
    case "ads_conversion_invalid": return "A Google Ads conversion was not accepted: each looks like AW-123456789/label, and its tag id must be one of the tag ids. Nothing was saved.";
    case "tracking_body_invalid":
    case "tracking_query_invalid": return "The page and the server disagree about which website this is. Reload the page and try again. Nothing was saved.";
    case "tracking_site_mismatch": return "This property is not the one for this website, so the ERP will not change its tracking tags. Nothing was saved.";
    case "property_not_found": return "This property was not found for this company. Nothing was saved.";
    case "no_build_target": return "This website has no build repository the ERP can write to yet, so there is nowhere to store the tag. Nothing was saved.";
    case "github_org_unavailable": return "GitHub cannot be reached for this company: its GitHub organization is not set up for this group. Nothing was saved.";
    case "github_not_configured": return "GitHub is not set up on this server yet, so the tag cannot be saved. Nothing was saved.";
    case "github_app_not_installed": return "The ERP's GitHub App cannot see this website's repository. Ask IT to install it on that repository, then try again. Nothing was saved.";
    case "github_permission_missing": return "GitHub refused: the ERP's GitHub App is not allowed to change repository variables yet (permission: actions_variables). The GitHub organization owner must grant it. Nothing was saved.";
    case "github_rate_limited": return "GitHub asked the ERP to slow down. Try again in a minute. Nothing was saved.";
    case "github_request_failed": return "GitHub did not accept the change. Try again in a moment; if it keeps failing, tell IT. Nothing was saved.";
    default: break;
  }
  if (status === 401) return "Your session has ended. Sign in again, then save. Nothing was saved.";
  if (status === 403) return "You are not allowed to change tracking tags for this website. Nothing was saved.";
  if (status === 404) return "This website or property was not found. Nothing was saved.";
  if (status === 400) return "The change was not accepted. Check the id and try again. Nothing was saved.";
  if (status === 409) return "The change conflicts with how this website is set up, so it was not saved.";
  return "The tracking tag could not be saved just now. Nothing was changed. Try again in a moment.";
}

/** The same words for a failed READ: the "Nothing was saved" tail is dropped, and a 403 is about seeing, not changing. */
export function trackingReadSentence(status: number, reason: string | null): string {
  if (reason === null && status === 403) return "You do not have access to this website's tracking tags.";
  const s = trackingRefusalSentence(status, reason).replace(/ ?Nothing was (saved|changed)\.( Try again in a moment\.)?$/, "").trim();
  return `The tracking tags could not be read: ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
}

// ── Google Ads (M5-P4g) ──────────────────────────────────────────────────────────────────────────

export const ADS_HELP = "Takes effect on the site's next rebuild. Google Ads loads only for visitors who accept marketing cookies.";

/** What the ids field shows for stored ids: one per line. */
export const adsIdsToText = (ids: readonly string[]): string => ids.join("\n");

/** The ids field as typed -> ids: split on commas, spaces and new lines, trimmed, empty pieces dropped. */
export function splitAdsIds(text: string): string[] {
  return text.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x !== "");
}

export type AdsDraft = { ids: string; conversions: Record<AdsConversionKey, string> };

/**
 * The section as typed -> the body to send, or the plain message to show. Mirrors the server's checks: ids `AW-` plus 6 to 15 digits, at
 * most 5, no duplicates; each conversion `AW-<digits>/<label>` with its AW id among the ids; no conversion without an id.
 */
export function checkGoogleAds(draft: AdsDraft): { ok: true; ids: string[]; conversions: AdsConversions } | { ok: false; message: string } {
  const ids = splitAdsIds(draft.ids);
  for (const id of ids) {
    if (!ADS_ID_RE.test(id)) return { ok: false, message: `"${id}" is not a Google Ads tag id. An id looks like AW-123456789 (AW- and 6 to 15 digits). Nothing was saved.` };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, message: "A Google Ads tag id is listed twice. List each id once. Nothing was saved." };
  if (ids.length > ADS_MAX_IDS) return { ok: false, message: `Use at most ${ADS_MAX_IDS} Google Ads tag ids. Nothing was saved.` };
  const conversions: AdsConversions = {};
  for (const k of ADS_CONVERSION_KEYS) {
    const t = draft.conversions[k].trim();
    if (t === "") continue;
    const m = ADS_CONVERSION_RE.exec(t);
    if (!m) return { ok: false, message: `${ADS_CONVERSION_LABELS[k]}: "${t}" is not a conversion. It looks like AW-123456789/AbCdEf (the tag id, a slash, then the conversion label). Nothing was saved.` };
    if (!ids.includes(m[1]!)) return { ok: false, message: `${ADS_CONVERSION_LABELS[k]}: ${m[1]} is not one of the tag ids above. Add it to the tag ids first. Nothing was saved.` };
    conversions[k] = t;
  }
  return { ok: true, ids, conversions };
}

/** What each Google Ads save outcome says. Never "done": the change reaches visitors only at the next rebuild. */
export function adsSavedSentence(result: PutResult, ads: GoogleAds, repo: string): string {
  if (result === "unchanged") return "Google Ads was already set this way. Nothing changed.";
  if (result === "cleared") return `Google Ads was removed from ${repo}. The site stops loading it at its next rebuild.`;
  const n = Object.keys(ads.conversions).length;
  return `Google Ads (${ads.ids.length} tag id${ads.ids.length === 1 ? "" : "s"}, ${n} conversion${n === 1 ? "" : "s"}) was saved to ${repo}. It reaches the site at its next rebuild.`;
}

/** A failed site lookup as one sentence for the engagement page (a 403 is about seeing the client's website, not about changing it). */
export function siteLookupSentence(status: number, reason: string | null): string {
  if (status === 403) return "You do not have access to this client's property, so its website's tracking tags are not shown here.";
  if (reason === "tracking_sites_unavailable") return "The ERP could not list this company's websites just now, so this client's tracking tags are not shown. Reload the page to try again.";
  if (status === 404) return "This client's property was not found, so its website's tracking tags are not shown here.";
  return "This client's website could not be looked up just now, so its tracking tags are not shown. Reload the page to try again.";
}
