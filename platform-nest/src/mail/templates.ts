// MAIL-04 — code templates (design A6: "Templates are code (TS functions keyed by `template_key`),
// not DB rows"). `mail_log.payload` is the ONLY thing persisted (§5: "never bodies twice") — the
// sender worker re-renders `{subject, html, text}` from `(template_key, payload)` at send time, and
// `enqueueMail` renders once at enqueue time purely to populate the `mail_log.subject` column for
// the admin log list (so it can show a subject without re-rendering every row).
//
// A12 (grep-gate binding): NOTHING in this file may contain a real-root-domain literal (the
// company's live `.com`/`.online` TLDs). Every link a template renders is a `href` the CALLER
// already built from `config.mail.linkBaseUrl`
// and handed in via `payload.href` — this module never constructs a URL itself, so it never needs
// to know a domain at all.
//
// Ships exactly the three templates design plan row MAIL-04 lists: `approval.warning`,
// `approval.actionable` (the two wording classes M9/§7.4 requires — the tap that PICKS between
// them is MAIL-05, out of scope here) and `auth.shell` (the base auth-stream template later
// auth-mail templates, e.g. MAIL-10's magic link, will specialize — no magic-link-specific
// wording lives here, per M11: this file must never grow approval semantics into the auth shell
// or vice versa).
import { stripHeaderInjection } from "./sanitize";
import type { RenderedMail } from "./types";

export class UnknownMailTemplateError extends Error {
  constructor(templateKey: string) {
    super(`unknown mail template_key: ${templateKey}`);
    this.name = "UnknownMailTemplateError";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** MAIL-18 gate follow-up (2026-08-08) — hardening, not a live bug fix.
 *
 *  `escapeHtml()` is the right tool for TEXT but not for a URL: a `javascript:alert(1)` payload
 *  contains no `<`, `>`, `"` or `'`, so it passes through completely untouched and lands inside
 *  `<a href="...">` as a working script URL. Escaping and scheme-safety are different problems and
 *  the former does not imply the latter.
 *
 *  Not exploitable when this was written — every writer of `payload.href` (`intake.ts`'s
 *  `absoluteEntityHref()` and the magic-link service) prefixes the trusted `MAIL_LINK_BASE_URL`
 *  before storage, so a raw scheme could not reach a stored row. That is a property of today's
 *  CALLERS, though, not of this renderer, and MAIL-38 has since made these templates render into an
 *  elevated-only admin page — so the renderer should hold on its own rather than inherit safety from
 *  every present and future caller getting it right.
 *
 *  Allowlist, not denylist: `javascript:`, `data:`, `vbscript:` and friends are unbounded, while the
 *  set we legitimately emit is exactly two. Anything else renders as inert text via the caller's
 *  normal escaping, so a bad URL becomes visible rather than clickable. */
const SAFE_URL_SCHEME = /^https?:\/\//i;

function safeHref(raw: string): string {
  if (!raw) return "";
  // Leading control characters and whitespace are stripped by browsers before scheme detection
  // (`java\nscript:` is a classic bypass), so normalise before testing rather than after.
  const normalized = raw.replace(/[\x00-\x20]/g, "");
  return SAFE_URL_SCHEME.test(normalized) ? raw : "";
}

/** Shared payload shape for both approval wording classes (§7.2–§7.4). `href` is a PLAIN entity
 *  deep link with no token/session/capability (M11) — the caller builds it from
 *  `config.mail.linkBaseUrl`, never a literal domain. */
export interface ApprovalMailPayload {
  href: string;
  companyName?: string;
  subjectTitle: string; // e.g. "update campaign budget" | "sign the PRD gate"
  tool?: string; // automation/agent origin only
  impact?: "medium" | "high" | "unclassified"; // automation/agent origin only
  [key: string]: unknown;
}

function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** M12-locked wording: informational only, and explicitly states nothing ran. MUST NEVER contain
 *  approve/reject/decide-executes language — pinned by templates.test.ts's wording gate and
 *  re-asserted end to end by MAIL-18. Used for origin ∈ {automation, agent} — deciding today
 *  records a verdict but re-drives nothing (D14 gap, §7.4). */
function renderApprovalWarning(payload: ApprovalMailPayload): RenderedMail {
  const company = asStr(payload.companyName, "your company");
  const tool = asStr(payload.tool, "an automation");
  const impact = asStr(payload.impact, "unclassified");
  const href = asStr(payload.href);
  const subject = stripHeaderInjection(`Suspended for review: ${asStr(payload.subjectTitle, "an automated action")}`);
  const text =
    `${tool} requested "${asStr(payload.subjectTitle, "an action")}" (impact: ${impact}) in ${company}. ` +
    `It is suspended; nothing has run. Review it in the ERP: ${href}`;
  const html =
    `<p>${escapeHtml(tool)} requested "${escapeHtml(asStr(payload.subjectTitle, "an action"))}" ` +
    `(impact: ${escapeHtml(impact)}) in ${escapeHtml(company)}.</p>` +
    `<p><strong>It is suspended; nothing has run.</strong></p>` +
    `<p>Review it in the ERP: <a href="${escapeHtml(safeHref(href))}">${escapeHtml(href)}</a></p>`;
  return { subject, html, text };
}

/** Used for origins where deciding today actually executes the effect (pipeline/hr/agency, §7.4).
 *  No action buttons, no token in the link (M11) — the href is a plain URL; auth happens at the
 *  door, not in the mail. */
function renderApprovalActionable(payload: ApprovalMailPayload): RenderedMail {
  const href = asStr(payload.href);
  const title = asStr(payload.subjectTitle, "something");
  const subject = stripHeaderInjection(`Your decision is needed: ${title}`);
  const text = `Your decision is needed on ${title}: ${href}`;
  const html =
    `<p>Your decision is needed on <strong>${escapeHtml(title)}</strong>:</p>` +
    `<p><a href="${escapeHtml(safeHref(href))}">${escapeHtml(href)}</a></p>`;
  return { subject, html, text };
}

/** Auth-stream base shell (design §9 wires the real magic-link wording on top of this later —
 *  MAIL-10, its own ticket/migration). `payload.body`/`payload.href` are generic so this shell
 *  never has to know what kind of auth mail it is rendering. Explicit non-goal restated here per
 *  M11: this template (and anything derived from it) is NEVER an approval mechanism and must
 *  never appear on an approval/warning send path. */
export interface AuthShellPayload {
  href?: string;
  body: string;
  [key: string]: unknown;
}

function renderAuthShell(payload: AuthShellPayload): RenderedMail {
  const body = asStr(payload.body, "");
  const href = asStr(payload.href, "");
  const subject = stripHeaderInjection("Gaiada sign-in");
  const text = href ? `${body}\n\n${href}` : body;
  const html = href
    ? `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(safeHref(href))}">${escapeHtml(href)}</a></p>`
    : `<p>${escapeHtml(body)}</p>`;
  return { subject, html, text };
}

/** MAIL-10 (design §9). `payload.href` is the ONE place in this whole file a link is allowed to
 *  carry a bearer credential — every other template's `href` (approval.warning/actionable) is a
 *  PLAIN entity URL with no token, by M11. That asymmetry is the entire point of M11, restated
 *  here at the render site so it cannot be missed by anyone editing this function:
 *
 *  ── M11 HARD NON-GOAL — READ BEFORE TOUCHING THIS FUNCTION ──────────────────────────────────
 *  A magic link is a bearer credential sitting in an inbox. It is a LOGIN convenience ONLY and
 *  must NEVER become an approval mechanism — approval/warning mail must stay exactly what
 *  renderApprovalWarning/renderApprovalActionable above already are: a plain entity URL, no
 *  token, auth at the door. This function must never be called from the approval/warning send
 *  path, and no future edit here may add approval semantics (approve/reject wording, a decision
 *  payload, anything actioned by clicking). Pinned by
 *  `src/mail/magic-link/m11-non-goal.test.ts`, re-asserted end to end by MAIL-18/MAIL-11.
 *  ──────────────────────────────────────────────────────────────────────────────────────────── */
export interface AuthMagicLinkPayload {
  href: string;
  ttlMinutes: number;
  [key: string]: unknown;
}

function renderAuthMagicLink(payload: AuthMagicLinkPayload): RenderedMail {
  const href = asStr(payload.href);
  const ttl = Number.isFinite(payload.ttlMinutes) && payload.ttlMinutes > 0 ? payload.ttlMinutes : 15;
  const subject = stripHeaderInjection("Your Gaiada sign-in link");
  const text =
    `Click the link below to sign in to Gaiada. This link expires in ${ttl} minute(s) and can ` +
    `only be used once.\n\n${href}\n\nIf you did not request this, you can safely ignore this email.`;
  const html =
    `<p>Click the link below to sign in to Gaiada. This link expires in ${escapeHtml(String(ttl))} ` +
    `minute(s) and can only be used once.</p>` +
    `<p><a href="${escapeHtml(safeHref(href))}">${escapeHtml(href)}</a></p>` +
    `<p>If you did not request this, you can safely ignore this email.</p>`;
  return { subject, html, text };
}

const TEMPLATES: Record<string, (payload: Record<string, unknown>) => RenderedMail> = {
  "approval.warning": (p) => renderApprovalWarning(p as ApprovalMailPayload),
  "approval.actionable": (p) => renderApprovalActionable(p as ApprovalMailPayload),
  "auth.shell": (p) => renderAuthShell(p as AuthShellPayload),
  "auth.magic_link": (p) => renderAuthMagicLink(p as AuthMagicLinkPayload),
};

export function knownTemplateKeys(): string[] {
  return Object.keys(TEMPLATES);
}

/** Throws `UnknownMailTemplateError` for anything not registered above — a caller enqueuing a
 *  typo'd template_key must fail loudly at enqueue time, not silently at send time three retries
 *  later with a useless "sent" row that carries the wrong body forever (there is no body column
 *  to inspect after the fact). */
export function renderTemplate(templateKey: string, payload: Record<string, unknown>): RenderedMail {
  const fn = TEMPLATES[templateKey];
  if (!fn) throw new UnknownMailTemplateError(templateKey);
  return fn(payload ?? {});
}
