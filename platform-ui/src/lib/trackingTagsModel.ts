// M5-P4 (WSK-D92) — Website -> Analytics -> "Tracking tags": the contract's types, strict parsers, the partner-id rule and every refusal as a
// sentence. Pure and client-safe (no I/O, no `server-only`): the card is a client component. Contract: docs/FRONTEND-BFF-CONTRACT.md §28h.
// The reader is trackingTags.ts (server-only), the write is trackingTagsActions.ts ("use server").

/** The site's rule for a LinkedIn partner id (`parseLinkedInPartnerId`): digits only, 1 to 15 of them, after trimming. */
export const PARTNER_ID_RE = /^[0-9]{1,15}$/;

export type TrackingState = "ok" | "no_build_target" | "github_unavailable";

export interface TrackingTagsView {
  linkedin: { partnerId: string | null };
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

/** `GET …/tracking-tags` 200 body, strict: anything off-contract is a defect to show, never read as "not set". */
export function parseTrackingTags(b: unknown): TrackingTagsView {
  if (!isObj(b)) return bad("tracking tags: expected an object");
  const state = b.state;
  if (state !== "ok" && state !== "no_build_target" && state !== "github_unavailable") return bad("state: unknown value");
  if (typeof b.canManage !== "boolean") return bad("canManage: expected a boolean");
  const reason = b.reason === undefined ? null : b.reason;
  if (reason !== null && typeof reason !== "string") return bad("reason: expected a string");
  if (state !== "ok" && !reason) return bad("a state that is not ok must carry a reason");
  return { linkedin: { partnerId: parsePartnerId(b.linkedin) }, target: parseTarget(b.target), canManage: b.canManage, state, reason };
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
