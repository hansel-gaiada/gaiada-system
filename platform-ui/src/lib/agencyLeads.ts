// AD-11 — Agency Discovery Intake, staff console half. Client-safe types + pure helpers only (no
// fetch, no server-only import) — mirrors the lib/webdevChangeRequests.ts split so this file is
// importable from a "use client" queue/detail component as well as server pages and plain vitest.
//
// Contract: docs/FRONTEND-BFF-CONTRACT.md, "Agency Discovery Intake" section — read its six rules
// before touching this file; each encodes a real defect this feature must not reintroduce.
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md §4.1 (lifecycle),
//   §9.2 (reviewer needs).
// Backend: platform-nest/src/core/agency-leads.{controller,service}.ts (AD-4/AD-5),
//   agency-lead-convert.{controller,service}.ts (AD-6), agency-discovery-questionnaire.ts (AD-3).

export type LeadStatus = "new" | "invited" | "submitted" | "in_review" | "nurturing" | "declined" | "converted";
export type LeadSource = "staff" | "invite" | "open";

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  invited: "Invited",
  submitted: "Submitted",
  in_review: "In review",
  nurturing: "Nurturing",
  declined: "Declined",
  converted: "Converted",
};

/** The queue's own priority order (design §9.2 / contract rule 1): `submitted`(0) → `new`(1) →
 *  `invited`(2) → everything else(3). This mirrors `queueRank()` in
 *  `platform-nest/src/core/agency-leads.service.ts` byte-for-byte — kept here ONLY so a test can pin
 *  the two in lockstep, never to re-sort a queue this file receives. The BFF already returns rows in
 *  this exact order; contract rule 1 is explicit that a consumer re-sorting by `createdAt` "destroys
 *  the one signal the queue exists to carry" — so nothing in this module (or its callers) may reorder
 *  `listLeadsQueue`'s rows. If you are tempted to add a `sortQueue()` here the way
 *  `webdevChangeRequests.ts` has one, don't: that queue's backend does NOT segregate by status, this
 *  one already does. */
export function queueRank(status: LeadStatus | string): number {
  if (status === "submitted") return 0;
  if (status === "new") return 1;
  if (status === "invited") return 2;
  return 3;
}

/** `new` is the one queue state that means WE owe the prospect something (design §4.1: "we created
 *  the lead and never sent the form... the easiest thing in an agency pipeline to drop"). The queue
 *  renders this as an actionable affordance, not just a status chip — this is the single predicate
 *  that decides whether to show it. */
export function needsInvite(status: LeadStatus | string): boolean {
  return status === "new";
}

/** The row shape returned by `GET /:t/agency/leads` (agency-leads.service.ts::listLeadsQueue). Field
 *  names are transcribed VERBATIM from that SELECT's column aliases — do not rename without checking
 *  the backend first (CLAUDE.md's "frontend-first drift" trap: a field this file invents renders a
 *  confident wrong answer and nothing throws). */
export interface LeadQueueRow {
  id: string;
  orgName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: LeadSource;
  status: LeadStatus;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
  ageSeconds: number;
  hasSubmission: boolean;
}

/** `GET /:t/agency/leads/:leadId` (agency-leads.service.ts::getLeadDetail). The latest submission is
 *  joined in FLAT with a `latest*` prefix (a LATERAL join, not a nested object) — a lead with zero
 *  submissions still returns, with every `latest*` field `null`. Contract rule 4: `latestAnswers` is
 *  returned EXACTLY as Postgres hands it back, so a key the prospect never answered is ABSENT from
 *  the object, never an explicit `null` — see `sectionEntries()` below for how that is rendered. */
export interface LeadDetail {
  id: string;
  orgName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: LeadSource;
  status: LeadStatus;
  ownerId: string | null;
  ownerName: string | null;
  convertedClientId: string | null;
  convertedProjectId: string | null;
  pipelineRunId: string | null;
  declinedReason: string | null;
  triagedBy: string | null;
  triagedByName: string | null;
  triagedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestSubmissionId: string | null;
  latestSchemaVersion: string | null;
  latestAnswers: Record<string, unknown> | null;
  latestMeta: Record<string, unknown> | null;
  latestAnsweredCount: number | null;
  latestRequiredAnswered: number | null;
  latestRequiredTotal: number | null;
  latestRedactions: number | null;
  latestSupersedesId: string | null;
  latestSubmittedAt: string | null;
}

/** `GET /:t/agency/leads/:leadId/submissions` (agency-leads.service.ts::listLeadSubmissions) —
 *  newest first, `supersedesId` chains corrections. A SEPARATE Cerbos resource
 *  (`agency_discovery_submission`) from the lead itself (contract, rule 6: "a submission is
 *  INSERT-only"). */
export interface LeadSubmission {
  id: string;
  schemaVersion: string;
  answers: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  answeredCount: number;
  requiredAnswered: number;
  requiredTotal: number;
  supersedesId: string | null;
  redactions: number;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────── age rendering (queue)
/** A plain "Xd Yh" / "Xh Ym" / "Xm" style age string from `ageSeconds` — the queue's own age column
 *  (design §9.2: "show org, owner, age, whether a submission exists"). No locale/`Intl` dependency
 *  (CLAUDE.md's hydration-divergence trap doesn't apply to a relative duration, but keeping this
 *  ICU-free costs nothing and rules it out by construction). */
export function formatAge(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return "—";
  const m = Math.floor(ageSeconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return "just now";
}

// ─────────────────────────────────────────────────────────────────── the invite link (contract)
/** `…/discovery#t=<token>` — a URL FRAGMENT, never `?t=` (contract: "a query parameter is written to
 *  nginx access logs, sent in the `Referer` header of every outbound link on the page, and kept in
 *  browser history; a fragment is never transmitted to any server"). `formUrl` is the standalone
 *  prospect form's own address (design §9.1: hosting is a separate deployment, not this app) — any
 *  fragment it already carries is stripped first so a caller can never accidentally compose
 *  `#foo#t=…`. */
export function buildInviteLink(formUrl: string, token: string): string {
  const base = formUrl.replace(/#.*$/, "");
  return `${base}#t=${encodeURIComponent(token)}`;
}

// ─────────────────────────────────────────────────────────────────── the questionnaire (contract rule 4)
// A MIRROR of `platform-nest/src/core/agency-discovery-questionnaire.ts` — that file is the schema-
// version boundary (its own header: "bump SCHEMA_VERSION whenever a field is added, removed,
// renamed, or reworded"), and platform-ui cannot import it directly (root CLAUDE.md: components are
// separate standalone projects, nothing shared through packages). Field ids, section ids/titles, and
// `required` flags are transcribed VERBATIM from that file as of SCHEMA_VERSION below — if the
// backend bumps its version, this block must be re-transcribed in the same change, the same way
// `lib/reports.ts`'s header documents for `ReportDocument`. `options`/`help` text is intentionally
// NOT mirrored (this file only needs enough shape to group/label/render an ANSWER, never to
// re-render the question itself), but `left`/`right` (scale) and `rows`/`cols` (grid) ARE, because
// those are needed to make sense of the stored value.
export const SCHEMA_VERSION = "agency-discovery.2026-09-05.v1";

export type QFieldType = "text" | "textarea" | "date" | "radio" | "checkbox" | "scale" | "grid" | "group";

export interface QField {
  /** Absent only for `type: "group"` — a section subheading, never an answerable question and never
   *  counted toward answered/required totals (mirrors the backend's own `isAnswered`/`countAnswers`). */
  id?: string;
  type: QFieldType;
  label: string;
  required: boolean;
  left?: string;
  right?: string;
  rows?: string[];
  cols?: string[];
}

export interface QSection {
  id: string;
  title: string;
  blurb: string;
  fields: QField[];
}

function T(id: string, label: string, req: number): QField {
  return { id, type: "text", label, required: !!req };
}
function P(id: string, label: string, req: number): QField {
  return { id, type: "textarea", label, required: !!req };
}
function D(id: string, label: string, req: number): QField {
  return { id, type: "date", label, required: !!req };
}
function R(id: string, label: string, req: number): QField {
  return { id, type: "radio", label, required: !!req };
}
function C(id: string, label: string, req: number): QField {
  return { id, type: "checkbox", label, required: !!req };
}
function S(id: string, label: string, left: string, right: string): QField {
  return { id, type: "scale", label, left, right, required: true };
}
function G(id: string, label: string, rows: string[], cols: string[], req: number): QField {
  return { id, type: "grid", label, rows, cols, required: !!req };
}
function H(title: string): QField {
  return { type: "group", label: title, required: false };
}

export const QUESTIONNAIRE_SECTIONS: QSection[] = [
  {
    id: "project", title: "Project Overview",
    blurb: "The basics. Who you are, what you are trying to achieve, and when.",
    fields: [
      T("project_name", "Project / brand name", 1),
      T("org_name", "Business / organisation name", 1),
      T("current_url", "Current website URL", 1),
      H("Primary contact"),
      T("contact_name", "Name", 1),
      T("contact_role", "Role", 1),
      T("contact_email", "Email", 1),
      T("contact_phone", "Phone / WhatsApp", 0),
      H("Objectives"),
      P("objective", "What must this website accomplish?", 1),
      C("success_metrics", "Primary success metric", 1),
      T("primary_metric", "If you had to pick ONE success metric, which is it?", 1),
      D("launch_date", "Target launch date", 1),
      P("deadlines", "Hard deadlines and dependencies", 0),
      R("budget_range", "Budget range", 0),
    ],
  },
  {
    id: "business", title: "Your Business",
    blurb: "What you do, and what is not working today.",
    fields: [
      P("offering", "What do you sell or provide?", 1),
      P("differentiator", "What makes you different?", 1),
      P("priorities", "Your top 3 business priorities", 1),
      T("market", "Geographic market", 1),
      C("business_model", "Business model", 1),
      P("current_site_problems", "What is not working on your current website?", 1),
    ],
  },
  {
    id: "competitors", title: "Competitors",
    blurb: "Both the companies you lose deals to and the brands you would like to be mentioned alongside.",
    fields: [
      T("competitor_1_name", "Competitor 1 — name and URL", 1),
      P("competitor_1_assessment", "Competitor 1 — what they do well, and what they do badly", 1),
      T("competitor_2_name", "Competitor 2 — name and URL", 1),
      P("competitor_2_assessment", "Competitor 2 — what they do well, and what they do badly", 1),
      T("competitor_3_name", "Competitor 3 — name and URL", 0),
      P("competitor_3_assessment", "Competitor 3 — what they do well, and what they do badly", 0),
      P("competitors_other", "Any other competitors we should look at", 0),
      P("category_cliches_to_avoid", "What must we avoid doing that competitors do?", 1),
    ],
  },
  {
    id: "audience", title: "Your Audience",
    blurb: "Everything on the site gets designed for a specific person. This defines them.",
    fields: [
      P("primary_audience", "Who is your most important visitor?", 1),
      P("secondary_audiences", "Secondary audiences", 0),
      P("audience_pain", "What problems or frustrations do they have?", 1),
      P("audience_goals", "What are they trying to achieve?", 1),
      C("decision_drivers", "What drives their decision?", 1),
      P("objections", "Why might they hesitate?", 1),
      R("knowledge_level", "How much do they already know about what you offer?", 1),
    ],
  },
  {
    id: "brand", title: "Brand & Voice",
    blurb: "How the brand should feel, sound, and behave.",
    fields: [
      H("Personality"),
      T("brand_adjectives", "Describe the brand in 3–7 adjectives", 1),
      T("brand_avoid_traits", "Which traits must the brand NEVER communicate?", 1),
      P("brand_as_person", "If the brand were a person, how would they behave?", 1),
      H("Positioning"),
      P("category_in", "What category should customers place you in?", 1),
      P("category_out", "What category should customers NOT place you in?", 1),
      P("why_choose_you", "Why should someone choose you over the obvious alternative?", 1),
      P("proof", "What proof makes that claim credible?", 1),
      H("Messaging"),
      P("brand_promise", "Your brand promise", 1),
      T("brand_values", "Your core values", 1),
      T("tagline", "Existing tagline or key message", 0),
      P("simplest_explanation", "The simplest possible explanation of what you do", 1),
      P("homepage_core_message", "The single most important message on the homepage", 1),
      P("supporting_messages", "The 3–5 supporting messages", 1),
      H("Tone of voice"),
      C("tone", "How should the copy sound?", 1),
      S("voice_expert_approachable", "Expert ←→ Approachable", "Expert", "Approachable"),
      S("voice_concise_descriptive", "Concise ←→ Descriptive", "Concise", "Descriptive"),
      T("words_use", "Words or phrases we SHOULD use", 0),
      T("words_avoid", "Words or phrases we must AVOID", 0),
      P("cultural_considerations", "Any cultural or language considerations?", 0),
      H("Emotional outcome"),
      P("feel_5_seconds", "What should someone feel within 5 seconds of landing on the site?", 1),
      P("feel_after_convert", "What should they feel right after they convert?", 1),
    ],
  },
  {
    id: "visual", title: "Visual Direction",
    blurb: "Move each slider toward the end that feels right. The middle is a valid answer.",
    fields: [
      H("Overall style"),
      S("vis_minimal_expressive", "Minimal ←→ Expressive", "Minimal", "Expressive"),
      S("vis_corporate_editorial", "Corporate ←→ Editorial", "Corporate", "Editorial"),
      S("vis_luxury_accessible", "Luxury ←→ Accessible", "Luxury", "Accessible"),
      S("vis_technical_human", "Technical ←→ Human", "Technical", "Human"),
      S("vis_serious_playful", "Serious ←→ Playful", "Serious", "Playful"),
      H("Layout & typography"),
      S("vis_dense_spacious", "Dense ←→ Spacious", "Dense", "Spacious"),
      S("vis_grid_organic", "Structured grid ←→ Organic composition", "Structured grid", "Organic"),
      S("vis_neutral_distinctive", "Neutral type ←→ Distinctive type", "Neutral", "Distinctive"),
      H("Photography & colour"),
      S("vis_product_people", "Product-focused ←→ People-focused", "Product", "People"),
      S("vis_studio_natural", "Studio ←→ Natural / editorial", "Studio", "Natural"),
      S("vis_mono_colourful", "Monochrome ←→ Colourful", "Monochrome", "Colourful"),
      S("vis_contrast", "High contrast ←→ Soft contrast", "High contrast", "Soft contrast"),
      H("Motion & components"),
      R("motion_level", "How much motion should the site have?", 1),
      S("vis_standard_custom", "Standard components ←→ Highly custom", "Standard", "Highly custom"),
      H("References"),
      P("reference_1", "Reference site 1 — URL and what specifically you like", 1),
      P("reference_2", "Reference site 2 — URL and what specifically you like", 1),
      P("reference_3", "Reference site 3 — URL and what specifically you like", 0),
      P("dislike_reference", "A site or style you dislike — and why", 1),
      P("visual_avoid", "Visual things to avoid", 1),
    ],
  },
  {
    id: "assets", title: "Existing Brand Assets",
    blurb: "What already exists. If assets are not ready, say so — it affects the timeline.",
    fields: [
      R("has_brand_guidelines", "Do you have existing brand guidelines?", 1),
      R("logo_files", "Logo files", 1),
      P("brand_colours", "Brand colours", 1),
      P("brand_fonts", "Brand fonts", 1),
      C("photography_direction", "Photography direction", 1),
      C("illustration_direction", "Illustration and icon direction", 0),
      T("asset_link", "Link to your brand assets", 1),
    ],
  },
  {
    id: "ux", title: "Journey & Conversion",
    blurb: "How someone gets from arriving to doing the thing you want them to do.",
    fields: [
      P("journey", "Describe the ideal path from landing to conversion", 1),
      T("primary_cta", "The single most important action a visitor can take", 1),
      T("secondary_cta", "Supporting actions", 0),
      R("conversion_type", "What counts as a conversion?", 1),
      P("conversion_friction", "What currently stops people from converting?", 1),
      C("trust_signals", "What trust signals can we use?", 1),
      P("lead_routing", "Where do leads go, and who follows up?", 0),
      H("Navigation & access"),
      R("nav_style", "Navigation style", 1),
      R("mobile_priority", "How important is mobile?", 1),
      R("accessibility_target", "Accessibility target", 1),
      P("accessibility_notes", "Specific accessibility requirements", 0),
    ],
  },
  {
    id: "sitemap", title: "Pages & Features",
    blurb: "What the site is made of. A rough list is fine.",
    fields: [
      C("pages_required", "Which pages do you need?", 1),
      P("pages_other", "Any other pages?", 0),
      T("priority_pages", "Which pages matter most?", 1),
      C("features_required", "Which features do you need?", 1),
      P("feature_detail", "Describe any feature that needs explaining", 0),
      P("cms_editable", "What must you be able to edit yourself?", 1),
    ],
  },
  {
    id: "content", title: "Content & SEO",
    blurb: "Content is the most common cause of a delayed launch.",
    fields: [
      R("copy_owner", "Who is writing the copy?", 1),
      G(
        "asset_inventory", "What assets already exist?",
        ["Logo (vector)", "Brand guidelines", "Photography", "Video", "Written copy", "Product data", "Testimonials", "Case studies", "Legal / privacy text"],
        ["Ready to use", "Exists, needs work", "Does not exist", "Not sure"],
        1,
      ),
      P("content_owner_dates", "Who owns getting the missing content ready, and by when?", 1),
      P("existing_content", "Existing content we should look at", 0),
      R("migration_scope", "Does content need migrating from an existing site?", 1),
      C("languages", "Languages", 1),
      P("seo_requirements", "SEO requirements", 1),
    ],
  },
  {
    id: "technical", title: "Technical & Integrations",
    blurb: "The systems the site has to work with, and the constraints it must respect.",
    fields: [
      R("platform", "Preferred platform", 0),
      R("hosting", "Hosting", 0),
      T("dns_owner", "Who controls the domain and DNS?", 1),
      C("integrations", "Which systems must the site integrate with?", 1),
      P("integration_providers", "For each system above, name the provider", 0),
      C("analytics", "Analytics and tracking", 1),
      P("compliance", "Security and compliance requirements", 1),
      R("performance_target", "Performance expectations", 1),
      P("browser_support", "Browser and device support", 0),
    ],
  },
  {
    id: "governance", title: "Decisions, Scope & Aftercare",
    blurb: "Who signs off, what is in, what is out, and what happens after launch.",
    fields: [
      P("decision_makers", "Who are the decision makers?", 1),
      P("approval_process", "What is the approval process?", 1),
      R("revision_rounds", "How many revision rounds do you expect per deliverable?", 1),
      R("legal_review", "Is legal or regulatory review required?", 0),
      P("signoff_criteria", "What constitutes final sign-off?", 1),
      H("Scope"),
      P("in_scope", "What is explicitly IN scope?", 1),
      P("out_scope", "What is explicitly OUT of scope?", 1),
      P("dependencies", "Dependencies outside our control", 1),
      H("After launch"),
      T("maintenance_owner", "Who maintains the site after launch?", 1),
      R("training", "Do you need training?", 0),
      P("support_expectations", "Support expectations", 0),
    ],
  },
  {
    id: "close", title: "Anything Else",
    blurb: "The question that catches what the form missed.",
    fields: [
      P("anything_else", "Is there anything we have not asked that we should know?", 0),
      R("confidence", "How confident are you in the answers you have given?", 1),
    ],
  },
];

export const ALL_QUESTIONNAIRE_FIELDS: QField[] = QUESTIONNAIRE_SECTIONS.flatMap((s) => s.fields.filter((f) => f.type !== "group"));
export const QUESTIONNAIRE_REQUIRED_TOTAL: number = ALL_QUESTIONNAIRE_FIELDS.filter((f) => f.required).length;

// ─────────────────────────────────────────────────────────────────── rendering the answers (contract rule 4)
/** A section subheading (design's own `H(...)` groups), or one question paired with whatever
 *  `answers` did or didn't say about it. */
export type SectionEntry =
  | { kind: "heading"; label: string }
  | { kind: "field"; field: QField; present: boolean; answered: boolean; value: unknown };

/** THE function contract rule 4 exists for: "key absent" is NOT "answered empty". Every field in the
 *  section is represented — never skipped — so an unanswered OPTIONAL field renders as visibly
 *  skipped rather than as a blank value a reviewer can't tell apart from a real empty answer.
 *
 *  `present` — literally `Object.prototype.hasOwnProperty.call(answers, id)`. `answered` — the
 *  backend's own `isAnswered` rule (mirrors `countAnswers()`'s definition): empty string/array, or a
 *  grid missing any row, does not count even when the key IS present. Both are exposed because a
 *  reviewer's actual question ("what did they not tell us") is best served by knowing the
 *  difference — a key that is present-but-empty (they saw the question and left it blank) is a
 *  different fact from a key that is entirely absent (an older submission from a prior
 *  `schemaVersion`, or a JSON edit) — but NEITHER may render as a plain blank string. */
export function sectionEntries(section: QSection, answers: Record<string, unknown> | null | undefined): SectionEntry[] {
  const a = answers ?? {};
  return section.fields.map((f): SectionEntry => {
    if (f.type === "group") return { kind: "heading", label: f.label };
    const id = f.id as string;
    const present = Object.prototype.hasOwnProperty.call(a, id);
    const value = a[id];
    return { kind: "field", field: f, present, answered: present && isAnswerFilled(f, value), value };
  });
}

function isAnswerFilled(field: QField, value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (field.type === "grid") {
    if (typeof value !== "object") return false;
    const rows = field.rows ?? [];
    const obj = value as Record<string, unknown>;
    return rows.length > 0 && rows.every((r) => obj[r] !== undefined && obj[r] !== null && obj[r] !== "");
  }
  return true;
}

/** A short, safe-to-print rendering of one answer's value. Grids come back as a `{row, value}[]` so
 *  the caller can render a small table instead of a JSON blob; everything else collapses to a
 *  string. Never called for an unanswered field — the caller renders the "skipped" state instead. */
export function formatAnswerValue(field: QField, value: unknown): string | { row: string; value: string }[] {
  if (field.type === "grid") {
    const rows = field.rows ?? [];
    const obj = (value ?? {}) as Record<string, unknown>;
    return rows.map((row) => ({ row, value: obj[row] != null && obj[row] !== "" ? String(obj[row]) : "—" }));
  }
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (field.type === "scale" && (typeof value === "number" || typeof value === "string")) {
    return `${value} (${field.left} ←→ ${field.right})`;
  }
  if (typeof value === "object" && value !== null) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

// ─────────────────────────────────────────────────────────────────── convert / delegation (design §4.3, AD-6b)
/** The five canonical delegation roles `agency-lead-convert.service.ts::CANONICAL_DELEGATIONS`
 *  seeds from the prospect's own answers (design §4.3's table) — mirrored here so the convert form
 *  can describe them rather than presenting a blank free-for-all. As of AD-6b these are all
 *  SERVER-RESOLVED by default (a tenant "seat" for `resolution: "position"` roles, or the lead's
 *  owner otherwise) — a caller only needs to supply `delegations` at all to OVERRIDE a role's
 *  assignee or add a custom task; an empty array lets every canonical role resolve on its own. */
export interface CanonicalDelegationRole {
  role: string;
  title: string;
  /** "owner" — design's own default (the AM rows). "position" — tries the matching tenant seat's
   *  current holder first, falling back to the lead's owner only when no seat holder resolves (and
   *  that fallback is reported back as `source: "owner_fallback"`, never silent). */
  resolution: "owner" | "position";
}
export const CANONICAL_DELEGATION_ROLES: CanonicalDelegationRole[] = [
  { role: "discovery_review", title: "Review discovery answers & flag contradictions", resolution: "owner" },
  { role: "sitemap", title: "Produce sitemap from stated pages", resolution: "position" },
  { role: "integrations", title: "Confirm integrations & API access", resolution: "position" },
  { role: "content_owners", title: "Chase missing content owners", resolution: "owner" },
  { role: "dns", title: "Confirm domain/DNS control", resolution: "position" },
];

/** The request body shape `POST …/convert` accepts (agency-lead-convert.service.ts::DelegationInput).
 *  Per-role: naming an `assigneeId` here for one of the five canonical roles OVERRIDES its
 *  server-side resolution outright (rule 1 in that file: "an explicit caller-supplied assigneeId...
 *  always wins and is never second-guessed"); an entry with an unrecognised/absent `role` is an
 *  additive custom task instead. */
export interface DelegationInput {
  role?: string;
  assigneeId: string;
  dueAt?: string;
  title?: string;
}

/** Where a delegated task's assignee actually came from (AD-6b) — surfaced so the AM/PM can tell "I
 *  was assigned by design" from "I was assigned because nothing else resolved" from "nobody could be
 *  found; this needs a human". `"unresolved"` means NO task was created for this role at all —
 *  `assigneeId` is null and `reason` says why. Mirrors
 *  `agency-lead-convert.service.ts::DelegationReportEntry` verbatim. */
export type DelegationSource = "caller" | "position" | "owner" | "owner_fallback" | "unresolved";

export interface DelegationReportEntry {
  role: string;
  title: string;
  assigneeId: string | null;
  taskId?: string;
  source: DelegationSource;
  positionId?: string;
  positionTitle?: string;
  /** Set only for `source: "unresolved"` — why nothing could be created. */
  reason?: string;
}

/** `POST …/convert`'s success response (agency-lead-convert.controller.ts). `delegations` is kept
 *  OPTIONAL here even though the controller always sends it today: this file must not assume a field
 *  another, concurrently-shipped change added is present on every deployed backend during a rolling
 *  release — the detail page degrades to a plain success message when it is absent, rather than
 *  crashing on `undefined.map`. */
export interface ConvertSuccess {
  id: string;
  status: string;
  clientId: string;
  projectId: string;
  runId: string;
  delegations?: DelegationReportEntry[];
}

export const DELEGATION_SOURCE_LABEL: Record<DelegationSource, string> = {
  caller: "Chosen by you",
  position: "Current seat holder",
  owner: "Lead owner (by design)",
  owner_fallback: "Lead owner (fallback — no seat holder found)",
  unresolved: "Not created — nobody could be resolved",
};

/** The 409 "already converted" race artifact (agency-lead-convert.service.ts::ConvertLeadOutcome's
 *  `conflict` branch) — mirrors `ExistingTriageArtifact` in webdevChangeRequests.ts: the loser of a
 *  race gets what already exists, not just a failure. */
export interface ExistingConvertArtifact {
  clientId: string | null;
  projectId: string | null;
  runId: string | null;
}
