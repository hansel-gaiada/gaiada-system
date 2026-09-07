import "server-only";
// AD-11 — TEMP DEMO MODE. Stateful in-memory store for `/agency/leads` (queue + detail + triage +
// invite + convert), mirroring the convention `demoWebdevChangeRequests.ts`'s header documents. Lets
// the whole lifecycle — new -> invited -> submitted -> in_review -> {declined|nurturing|converted} —
// be driven in a browser with NO backend. Wired from `demoFixtures.getDemoResponse`. Session-only,
// resets on restart.
//
// Seeded with one row in EVERY queue-relevant status so the "needs an invite" affordance, the
// answered-vs-skipped rendering (contract rule 4), redactions, a supersedes_id chain, and the 409
// "already converted" race are all drivable without typing through the whole form by hand.
import { QUESTIONNAIRE_SECTIONS } from "./agencyLeads";

export type DemoLeadStatus = "new" | "invited" | "submitted" | "in_review" | "nurturing" | "declined" | "converted";

interface DemoSubmission {
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

interface DemoLead {
  id: string;
  orgName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: "staff" | "invite" | "open";
  status: DemoLeadStatus;
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
  submissions: DemoSubmission[]; // newest first
}

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });

let seq = 0;
const nid = (p: string) => `${p}-demo-${++seq}`;

const SCHEMA_VERSION = "agency-discovery.2026-09-05.v1";

const PARTIAL_ANSWERS: Record<string, unknown> = {
  project_name: "Northwind Storefront Refresh",
  org_name: "Northwind Traders",
  current_url: "https://northwind.example",
  contact_name: "Dana Whitfield",
  contact_role: "Marketing Director",
  contact_email: "dana@northwind.example",
  objective: "Cut our cart-abandonment rate and look credible to a B2B buyer, not just consumers.",
  success_metrics: ["Online sales", "Qualified leads"],
  primary_metric: "Online sales",
  launch_date: "2026-11-01",
  // budget_range deliberately absent — an optional field they skipped.
};

const FULL_ANSWERS: Record<string, unknown> = {
  ...PARTIAL_ANSWERS,
  deadlines: "",
  budget_range: "USD 15,000 – 30,000",
  offering: "Wholesale outdoor gear, B2B and B2C.",
  differentiator: "The only regional distributor with same-week delivery.",
  priorities: "1) Grow B2B accounts 2) Cut cart abandonment 3) Refresh the brand",
  market: "Indonesia, wider SE Asia",
  business_model: ["B2B", "B2C"],
  current_site_problems: "Checkout is a 6-step form and half of it is unreadable on mobile.",
  competitor_1_name: "Trailhead Supply — trailheadsupply.example",
  competitor_1_assessment: "Good product photography, terrible search.",
  competitor_2_name: "BaseCamp Wholesale — basecampwholesale.example",
  competitor_2_assessment: "Fast site, ugly brand.",
  category_cliches_to_avoid: "Stock photos of mountains with a lens flare.",
  primary_audience: "A procurement manager at a mid-size retailer comparing 3 distributors.",
  audience_pain: "Slow quoting, no visibility into stock levels.",
  audience_goals: "Get a reliable supplier and stop chasing emails for a quote.",
  decision_drivers: ["Trust / reputation", "Speed", "Price"],
  objections: "\"How do I know you'll actually have stock?\"",
  knowledge_level: "Informed — understands the category, comparing options",
  brand_adjectives: "Rugged, reliable, no-nonsense, fast",
  brand_avoid_traits: "Cheap, gimmicky, overly playful",
  brand_as_person: "A logistics manager who always picks up the phone.",
  category_in: "Serious wholesale outdoor gear",
  category_out: "Hobbyist consumer camping brand",
  why_choose_you: "Same-week delivery, backed by real-time stock visibility.",
  proof: "12 years trading, 400+ active accounts.",
  brand_promise: "If we say it's in stock, it ships this week.",
  brand_values: "Reliability, speed, honesty",
  simplest_explanation: "We supply outdoor gear to retailers, fast and honestly.",
  homepage_core_message: "Stock you can actually trust, delivered the same week.",
  supporting_messages: "Real-time stock. B2B pricing. Same-week delivery.",
  tone: ["Direct / no-nonsense", "Authoritative"],
  voice_expert_approachable: 3,
  voice_concise_descriptive: 2,
  feel_5_seconds: "This company actually knows logistics.",
  feel_after_convert: "Confident their order will actually arrive.",
  vis_minimal_expressive: 2, vis_corporate_editorial: 3, vis_luxury_accessible: 4,
  vis_technical_human: 3, vis_serious_playful: 2, vis_dense_spacious: 3, vis_grid_organic: 2,
  vis_neutral_distinctive: 3, vis_product_people: 2, vis_studio_natural: 3, vis_mono_colourful: 3,
  vis_contrast: 3, motion_level: "Subtle — gentle fades and reveals", vis_standard_custom: 2,
  reference_1: "trailheadsupply.example — like the sticky stock-level badge on product cards",
  reference_2: "basecampwholesale.example — like the one-click reorder from order history",
  dislike_reference: "Anything with autoplay video heroes — kills our mobile load time.",
  visual_avoid: "Lens-flare mountain stock photography.",
  has_brand_guidelines: "Partial — logo and colours, nothing formal",
  logo_files: "Yes — vector, single variant",
  brand_colours: "Forest green #1F3D2B, safety orange #E85D2A",
  brand_fonts: "Inter for body; no licensed display face yet",
  photography_direction: ["Product", "Real / documentary"],
  asset_link: "https://drive.example/northwind-brand",
  journey: "Arrive from a Google search for a specific SKU, see live stock, request a quote or buy direct.",
  primary_cta: "Request a quote",
  conversion_type: ["Form submission / lead", "Online purchase"],
  conversion_friction: "The 6-step checkout, and no visible stock count until step 4.",
  trust_signals: ["Years in business", "Client logos", "Certifications / accreditations"],
  nav_style: "Standard — top level with dropdowns",
  mobile_priority: "High — roughly an even split",
  accessibility_target: "WCAG 2.2 AA — our standard, recommended",
  pages_required: ["Homepage", "Services / Products", "Contact", "FAQ"],
  priority_pages: "Homepage, Product catalogue, Request a quote",
  features_required: ["Contact form", "Multi-step form / quote builder", "Search"],
  cms_editable: "Product stock counts and pricing tiers — nothing else.",
  copy_owner: "Shared — we draft, you refine",
  asset_inventory: {
    "Logo (vector)": "Ready to use",
    "Brand guidelines": "Exists, needs work",
    "Photography": "Does not exist",
    "Video": "Does not exist",
    "Written copy": "Exists, needs work",
    "Product data": "Ready to use",
    "Testimonials": "Does not exist",
    "Case studies": "Does not exist",
    "Legal / privacy text": "Exists, needs work",
  },
  content_owner_dates: "Dana owns photography — needs a shoot booked by end of September.",
  migration_scope: "Yes — under 20 pages",
  languages: ["English", "Bahasa Indonesia"],
  seo_requirements: "Do not lose ranking for \"wholesale outdoor gear Jakarta\" — currently #3.",
  dns_owner: "Dana Whitfield (registrar: existing hosting provider)",
  integrations: ["CRM", "Analytics", "WhatsApp Business"],
  analytics: ["Google Analytics 4", "Google Search Console"],
  compliance: "Standard Indonesian consumer-data handling; nothing sector-specific.",
  performance_target: "Standard — fast, sensible defaults",
  decision_makers: "Dana Whitfield (final say), plus the ops director on pricing pages.",
  approval_process: "Dana reviews first, ops director signs off on anything touching pricing.",
  revision_rounds: "2 — our standard",
  signoff_criteria: "Dana and the ops director both approve the staging build.",
  in_scope: "New storefront, quote-request flow, product catalogue with live stock.",
  out_scope: "No native mobile app. No multi-currency in phase 1.",
  dependencies: "Stock API access from their WMS vendor — Dana is chasing this.",
  maintenance_owner: "Dana (content), existing hosting provider (infra).",
  anything_else: "A previous agency ghosted them mid-project — they are wary of over-promising.",
  confidence: "Mostly — a few need internal confirmation",
};

function countAnswers(answers: Record<string, unknown>): { answeredCount: number; requiredAnswered: number; requiredTotal: number } {
  const all = QUESTIONNAIRE_SECTIONS.flatMap((s) => s.fields.filter((f) => f.type !== "group"));
  let answeredCount = 0;
  let requiredAnswered = 0;
  for (const f of all) {
    const id = f.id as string;
    const v = answers[id];
    const filled = v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
    if (!filled) continue;
    answeredCount += 1;
    if (f.required) requiredAnswered += 1;
  }
  return { answeredCount, requiredAnswered, requiredTotal: all.filter((f) => f.required).length };
}

function submission(id: string, answers: Record<string, unknown>, supersedesId: string | null, createdAt: string, redactions: number): DemoSubmission {
  return { id, schemaVersion: SCHEMA_VERSION, answers, meta: {}, ...countAnswers(answers), supersedesId, redactions, createdAt };
}

const LEADS: DemoLead[] = [
  {
    id: "lead-demo-1", orgName: "Aurora Wellness Clinic", contactName: "Priya Kapoor", contactEmail: "priya@aurorawellness.example", contactPhone: "+62 812-0001-0001",
    source: "staff", status: "new", ownerId: "demo-hansel", ownerName: "Clement Hansel",
    convertedClientId: null, convertedProjectId: null, pipelineRunId: null, declinedReason: null,
    triagedBy: null, triagedByName: null, triagedAt: null,
    createdAt: "2026-09-06T09:00:00Z", updatedAt: "2026-09-06T09:00:00Z", submissions: [],
  },
  {
    id: "lead-demo-2", orgName: "Sumatra Coffee Roasters", contactName: "Budi Santoso", contactEmail: "budi@sumatraroasters.example", contactPhone: null,
    source: "staff", status: "invited", ownerId: "demo-hansel", ownerName: "Clement Hansel",
    convertedClientId: null, convertedProjectId: null, pipelineRunId: null, declinedReason: null,
    triagedBy: null, triagedByName: null, triagedAt: null,
    createdAt: "2026-08-28T09:00:00Z", updatedAt: "2026-08-29T10:00:00Z", submissions: [],
  },
  {
    id: "lead-demo-3", orgName: "Northwind Traders", contactName: "Dana Whitfield", contactEmail: "dana@northwind.example", contactPhone: "+62 812-0003-0003",
    source: "invite", status: "submitted", ownerId: "demo-hansel", ownerName: "Clement Hansel",
    convertedClientId: null, convertedProjectId: null, pipelineRunId: null, declinedReason: null,
    triagedBy: null, triagedByName: null, triagedAt: null,
    createdAt: "2026-08-20T08:00:00Z", updatedAt: "2026-08-30T14:00:00Z",
    submissions: [
      submission("sub-demo-2", FULL_ANSWERS, "sub-demo-1", "2026-08-30T14:00:00Z", 2),
      submission("sub-demo-1", PARTIAL_ANSWERS, null, "2026-08-25T11:00:00Z", 1),
    ],
  },
  {
    id: "lead-demo-4", orgName: "Java Batik Collective", contactName: "Retno Wulandari", contactEmail: "retno@javabatik.example", contactPhone: "+62 812-0004-0004",
    source: "invite", status: "in_review", ownerId: "gede-ic", ownerName: "Gede Wirawan",
    convertedClientId: null, convertedProjectId: null, pipelineRunId: null, declinedReason: null,
    triagedBy: "demo-hansel", triagedByName: "Clement Hansel", triagedAt: "2026-08-15T10:00:00Z",
    createdAt: "2026-08-05T08:00:00Z", updatedAt: "2026-08-15T10:00:00Z",
    submissions: [submission("sub-demo-3", { ...PARTIAL_ANSWERS, org_name: "Java Batik Collective" }, null, "2026-08-14T09:00:00Z", 0)],
  },
  {
    id: "lead-demo-5", orgName: "Bali Freight Logistics", contactName: "Wayan Suarta", contactEmail: "wayan@balifreight.example", contactPhone: null,
    source: "invite", status: "nurturing", ownerId: "demo-hansel", ownerName: "Clement Hansel",
    convertedClientId: null, convertedProjectId: null, pipelineRunId: null, declinedReason: null,
    triagedBy: "demo-hansel", triagedByName: "Clement Hansel", triagedAt: "2026-07-20T10:00:00Z",
    createdAt: "2026-07-01T08:00:00Z", updatedAt: "2026-07-20T10:00:00Z",
    submissions: [submission("sub-demo-4", PARTIAL_ANSWERS, null, "2026-07-18T09:00:00Z", 0)],
  },
  {
    id: "lead-demo-6", orgName: "Denpasar Dental Group", contactName: "Made Ariawan", contactEmail: "made@denpasardental.example", contactPhone: null,
    source: "invite", status: "declined", ownerId: "demo-hansel", ownerName: "Clement Hansel",
    convertedClientId: null, convertedProjectId: null, pipelineRunId: null,
    declinedReason: "Budget was under our minimum engagement size — revisit next fiscal year.",
    triagedBy: "demo-hansel", triagedByName: "Clement Hansel", triagedAt: "2026-06-10T10:00:00Z",
    createdAt: "2026-06-01T08:00:00Z", updatedAt: "2026-06-10T10:00:00Z",
    submissions: [submission("sub-demo-5", PARTIAL_ANSWERS, null, "2026-06-08T09:00:00Z", 0)],
  },
  {
    id: "lead-demo-7", orgName: "Lombok Dive Charters", contactName: "Sri Handayani", contactEmail: "sri@lombokdive.example", contactPhone: null,
    source: "invite", status: "converted", ownerId: "demo-hansel", ownerName: "Clement Hansel",
    convertedClientId: "cl-demo-lombok", convertedProjectId: "p-demo-lombok", pipelineRunId: "run-demo-2",
    declinedReason: null, triagedBy: "demo-hansel", triagedByName: "Clement Hansel", triagedAt: "2026-05-15T10:00:00Z",
    createdAt: "2026-05-01T08:00:00Z", updatedAt: "2026-05-15T10:00:00Z",
    submissions: [submission("sub-demo-6", PARTIAL_ANSWERS, null, "2026-05-10T09:00:00Z", 0)],
  },
];

function ageSeconds(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
}

function toRow(l: DemoLead) {
  return {
    id: l.id, orgName: l.orgName, contactName: l.contactName, contactEmail: l.contactEmail, contactPhone: l.contactPhone,
    source: l.source, status: l.status, ownerId: l.ownerId, ownerName: l.ownerName,
    createdAt: l.createdAt, updatedAt: l.updatedAt, ageSeconds: ageSeconds(l.createdAt), hasSubmission: l.submissions.length > 0,
  };
}

function toDetail(l: DemoLead) {
  const latest = l.submissions[0] ?? null;
  return {
    id: l.id, orgName: l.orgName, contactName: l.contactName, contactEmail: l.contactEmail, contactPhone: l.contactPhone,
    source: l.source, status: l.status, ownerId: l.ownerId, ownerName: l.ownerName,
    convertedClientId: l.convertedClientId, convertedProjectId: l.convertedProjectId, pipelineRunId: l.pipelineRunId,
    declinedReason: l.declinedReason, triagedBy: l.triagedBy, triagedByName: l.triagedByName, triagedAt: l.triagedAt,
    createdAt: l.createdAt, updatedAt: l.updatedAt,
    latestSubmissionId: latest?.id ?? null,
    latestSchemaVersion: latest?.schemaVersion ?? null,
    latestAnswers: latest?.answers ?? null,
    latestMeta: latest?.meta ?? null,
    latestAnsweredCount: latest?.answeredCount ?? null,
    latestRequiredAnswered: latest?.requiredAnswered ?? null,
    latestRequiredTotal: latest?.requiredTotal ?? null,
    latestRedactions: latest?.redactions ?? null,
    latestSupersedesId: latest?.supersedesId ?? null,
    latestSubmittedAt: latest?.createdAt ?? null,
  };
}

const REQUIRED_TENANT_RE = "[^/]+";
const tokens = new Map<string, { leadId: string; revoked: boolean }>();

/** Returns a DemoResult for any /agency/leads route, or null if it doesn't match. Signature order
 *  matches `webdevChangeRequestsDemo`'s (method, path, searchParams, body, userId) even though this
 *  store doesn't read query params today — kept for consistency with its `demoFixtures.ts` sibling. */
export function agencyLeadsDemo(method: string, p: string, _params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();
  const base = new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads`);
  if (!base.test(p)) return null;

  const listM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads$`));
  if (listM && m === "GET") {
    const rank = (s: DemoLeadStatus) => (s === "submitted" ? 0 : s === "new" ? 1 : s === "invited" ? 2 : 3);
    const sorted = [...LEADS].sort((a, b) => rank(a.status) - rank(b.status) || a.createdAt.localeCompare(b.createdAt));
    return ok(sorted.map(toRow));
  }
  if (listM && m === "POST") {
    const b = JSON.parse(body || "{}") as { orgName?: string; contactName?: string; contactEmail?: string; contactPhone?: string };
    if (!b.orgName?.trim()) return { status: 400, json: { error: "orgName required" } };
    const id = nid("lead");
    const now = new Date().toISOString();
    LEADS.push({
      id, orgName: b.orgName.trim(), contactName: b.contactName?.trim() || null, contactEmail: b.contactEmail?.trim() || null,
      contactPhone: b.contactPhone?.trim() || null, source: "staff", status: "new", ownerId: userId, ownerName: userId,
      convertedClientId: null, convertedProjectId: null, pipelineRunId: null, declinedReason: null,
      triagedBy: null, triagedByName: null, triagedAt: null, createdAt: now, updatedAt: now, submissions: [],
    });
    return ok({ id, status: "new" }, 201);
  }

  const inviteM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads/([^/]+)/invite$`));
  if (inviteM && m === "POST") {
    const lead = LEADS.find((l) => l.id === inviteM[1]);
    if (!lead) return { status: 404, json: { error: "lead not found" } };
    if (lead.status === "converted" || lead.status === "declined") {
      return { status: 409, json: { error: `cannot invite a lead in status '${lead.status}'`, reason: "lead_already_dispositioned" } };
    }
    const tokenId = nid("tok");
    const token = `demo-${tokenId}-${Math.random().toString(36).slice(2)}`;
    tokens.set(tokenId, { leadId: lead.id, revoked: false });
    if (lead.status === "new") { lead.status = "invited"; lead.updatedAt = new Date().toISOString(); }
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return ok({ tokenId, token, expiresAt }, 201);
  }

  const revokeM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads/([^/]+)/invite/([^/]+)/revoke$`));
  if (revokeM && m === "POST") {
    const t = tokens.get(revokeM[2]);
    if (!t || t.leadId !== revokeM[1] || t.revoked) return ok({ revoked: false });
    t.revoked = true;
    return ok({ revoked: true });
  }

  const openM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads/([^/]+)/open$`));
  if (openM && m === "POST") {
    const lead = LEADS.find((l) => l.id === openM[1]);
    if (!lead) return { status: 404, json: { error: "lead not found" } };
    if (lead.status !== "submitted") return { status: 409, json: { error: `cannot open a lead in status '${lead.status}' — expected 'submitted'` } };
    lead.status = "in_review"; lead.ownerId = lead.ownerId ?? userId; lead.updatedAt = new Date().toISOString();
    return ok({ id: lead.id, status: lead.status });
  }

  const declineM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads/([^/]+)/decline$`));
  if (declineM && m === "POST") {
    const lead = LEADS.find((l) => l.id === declineM[1]);
    if (!lead) return { status: 404, json: { error: "lead not found" } };
    const b = JSON.parse(body || "{}") as { reason?: string };
    const reason = (b.reason ?? "").trim();
    if (!reason) return { status: 400, json: { error: "reason required when declining" } };
    if (lead.status !== "in_review") return { status: 409, json: { error: `cannot decline a lead in status '${lead.status}' — expected 'in_review'` } };
    lead.status = "declined"; lead.declinedReason = reason; lead.triagedBy = userId; lead.triagedByName = userId;
    lead.triagedAt = new Date().toISOString(); lead.updatedAt = lead.triagedAt;
    return ok({ id: lead.id, status: lead.status });
  }

  const nurtureM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads/([^/]+)/nurture$`));
  if (nurtureM && m === "POST") {
    const lead = LEADS.find((l) => l.id === nurtureM[1]);
    if (!lead) return { status: 404, json: { error: "lead not found" } };
    if (lead.status !== "in_review") return { status: 409, json: { error: `cannot nurture a lead in status '${lead.status}' — expected 'in_review'` } };
    lead.status = "nurturing"; lead.triagedBy = userId; lead.triagedByName = userId;
    lead.triagedAt = new Date().toISOString(); lead.updatedAt = lead.triagedAt;
    return ok({ id: lead.id, status: lead.status });
  }

  const convertM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads/([^/]+)/convert$`));
  if (convertM && m === "POST") {
    const lead = LEADS.find((l) => l.id === convertM[1]);
    if (!lead) return { status: 404, json: { error: "lead not found" } };
    if (lead.status === "converted") {
      return {
        status: 409,
        json: {
          error: "lead already converted (or no longer open for conversion)",
          existing: { clientId: lead.convertedClientId, projectId: lead.convertedProjectId, runId: lead.pipelineRunId },
        },
      };
    }
    if (!["submitted", "in_review", "nurturing"].includes(lead.status)) {
      return { status: 409, json: { error: `cannot convert a lead in status '${lead.status}'` } };
    }
    const b = JSON.parse(body || "{}") as { delegations?: { role?: string; assigneeId: string }[] };
    const clientId = nid("cl"); const projectId = nid("p"); const runId = "run-demo-2"; // reuse demoPipeline's fixture so the deep link resolves
    lead.status = "converted"; lead.convertedClientId = clientId; lead.convertedProjectId = projectId; lead.pipelineRunId = runId;
    lead.triagedBy = userId; lead.triagedByName = userId; lead.triagedAt = new Date().toISOString(); lead.updatedAt = lead.triagedAt;

    const overrides = new Map((b.delegations ?? []).filter((d) => d.role).map((d) => [d.role as string, d.assigneeId]));
    const canonical = [
      { role: "discovery_review", title: "Review discovery answers & flag contradictions", auto: true },
      { role: "sitemap", title: "Produce sitemap from stated pages", auto: false },
      { role: "integrations", title: "Confirm integrations & API access", auto: false },
      { role: "content_owners", title: "Chase missing content owners", auto: false },
      { role: "dns", title: "Confirm domain/DNS control", auto: false },
    ];
    const delegations = canonical.map(({ role, title, auto }) => {
      const overrideId = overrides.get(role);
      if (overrideId) return { role, title, assigneeId: overrideId, taskId: nid("task"), source: "caller" as const };
      if (auto) return { role, title, assigneeId: lead.ownerId, taskId: lead.ownerId ? nid("task") : undefined, source: "owner" as const };
      // Demo has no seat/position directory — mirror the real backend's honest "unresolved" outcome
      // for the position-resolution roles when nobody overrides them, rather than inventing a holder.
      return { role, title, assigneeId: null, source: "unresolved" as const, reason: "no tenant seat holder in this demo, and this role has no owner fallback" };
    });
    return ok({ id: lead.id, status: "converted", clientId, projectId, runId, delegations });
  }

  const submissionsM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads/([^/]+)/submissions$`));
  if (submissionsM && m === "GET") {
    const lead = LEADS.find((l) => l.id === submissionsM[1]);
    if (!lead) return { status: 404, json: { error: "lead not found" } };
    return ok(lead.submissions);
  }

  const detailM = p.match(new RegExp(`^/api/${REQUIRED_TENANT_RE}/agency/leads/([^/]+)$`));
  if (detailM && m === "GET") {
    const lead = LEADS.find((l) => l.id === detailM[1]);
    if (!lead) return { status: 404, json: { error: "lead not found" } };
    return ok(toDetail(lead));
  }

  return null;
}
