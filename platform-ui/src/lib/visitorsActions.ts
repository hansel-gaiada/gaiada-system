"use server";
// M5-V3-i — the interest rules' write, as a server action. PUT visitors/interest-rules takes the COMPLETE rule set (a rule
// left out is removed). Cerbos decides (`update` on the property); the UI never gates by role name. A refusal comes back as
// a sentence, never a code and never a silent no-op.
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import { checkRuleDrafts, parseInterestRules, ruleRefusalSentence, VisitorsShapeError, type InterestRule, type RuleDraft } from "./visitorsModel";

export type SaveRulesResult = { ok: true; rules: InterestRule[]; note: string } | { ok: false; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MATCHES = ["path_prefix", "section_prefix"];
const FACETS = ["industry", "service"];

/** Only the keys the API takes, in the shape it takes them: anything else is dropped here, never forwarded blind. */
function cleanDrafts(rules: unknown): RuleDraft[] | null {
  if (!Array.isArray(rules)) return null;
  const out: RuleDraft[] = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") return null;
    const x = r as Record<string, unknown>;
    if (typeof x.match !== "string" || !MATCHES.includes(x.match) || typeof x.facet !== "string" || !FACETS.includes(x.facet)) return null;
    out.push({
      match: x.match as RuleDraft["match"], facet: x.facet as RuleDraft["facet"],
      pattern: typeof x.pattern === "string" ? x.pattern.trim() : "", tag: typeof x.tag === "string" ? x.tag.trim() : "",
      weight: typeof x.weight === "number" ? x.weight : Number.NaN,
    });
  }
  return out;
}

export async function saveInterestRulesAction(propertyId: string, rules: RuleDraft[]): Promise<SaveRulesResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, message: ruleRefusalSentence(401, null) };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { ok: false, message: "No company is selected, so the rules were not saved." };
  if (typeof propertyId !== "string" || !UUID_RE.test(propertyId)) return { ok: false, message: ruleRefusalSentence(404, null) };
  // A cosmetic gate only (Cerbos is the authority and answers 403 below): the page that renders this form is already 404 without it.
  if (!can(me, "search.visitors.read", company)) return { ok: false, message: ruleRefusalSentence(403, null) };
  const clean = cleanDrafts(rules);
  if (!clean) return { ok: false, message: ruleRefusalSentence(400, "rules_invalid") };
  const bad = checkRuleDrafts(clean);
  if (bad) return { ok: false, message: bad };
  try {
    const body = await platformFetch<unknown>(
      `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(propertyId)}/visitors/interest-rules`,
      userId, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules: clean }) },
    );
    const out = parseInterestRules(body);
    return { ok: true, rules: out.rules, note: out.note };
  } catch (e) {
    if (e instanceof PlatformError) {
      const reason = e.reason ?? (e.body && typeof e.body === "object" && typeof (e.body as { reason?: unknown }).reason === "string" ? (e.body as { reason: string }).reason : null);
      return { ok: false, message: ruleRefusalSentence(e.status, reason) };
    }
    if (e instanceof VisitorsShapeError) return { ok: false, message: "The rules were sent, but the answer did not match what the ERP expects. Reload the page to see what was saved." };
    return { ok: false, message: ruleRefusalSentence(0, null) };
  }
}
