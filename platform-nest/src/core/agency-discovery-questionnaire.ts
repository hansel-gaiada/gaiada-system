// AD-3 — the versioned agency discovery question set.
//
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md §9.1, §3.3.
//
// `GET /intake/questionnaire` exists so the prospect FORM cannot drift from the platform's own
// stored `schema_version` — the "frontend-first drift" trap (CLAUDE.md) applied to an
// unauthenticated surface. This module is the ONE place the discovery questionnaire is defined.
//
// SOURCE OF TRUTH FOR IDS: C:\Users\Hansel\Downloads\gaia-onboarding-form\src\form.html's `SECTIONS`
// array, transcribed 2026-09-05. Field ids are reused VERBATIM from that file — design §9.1 calls
// them "the ERP contract": `agency_discovery_submissions.answers` is keyed by these exact ids, and
// design §9.2 requires the staff review UI to group by these exact sections. Every field in the
// source form is reproduced here — not a "representative subset" — so the server-computed
// `answered_count`/`required_total` (design §3.3: plain, app-written columns) are counted against
// the SAME question set an actual prospect answers against. (The design doc's own field count, 122,
// does not match this transcription's count, 127 fields across 13 sections — see this ticket's
// report; the discrepancy is flagged rather than silently reconciled by dropping or inventing
// fields.)
//
// Deliberately NOT column-per-question (migration header, design §3.3): a column-per-question
// schema turns every wording change into a migration. This module is the schema-version boundary
// instead — bump SCHEMA_VERSION whenever a field is added, removed, renamed, or reworded (never for
// a copy-only fix that doesn't change the id set).

export type QuestionnaireFieldType =
  | "text" | "textarea" | "date" | "radio" | "checkbox" | "scale" | "grid" | "group";

export interface QuestionnaireField {
  /** Absent only for `type: "group"` — a section subheading, not an answerable question, and never
   *  counted toward answered/required totals. */
  id?: string;
  type: QuestionnaireFieldType;
  label: string;
  help?: string | null;
  required: boolean;
  /** radio / checkbox */
  options?: string[];
  /** radio / checkbox: an "Other" write-in is offered alongside the fixed options. */
  other?: boolean;
  /** scale (a left↔right slider) */
  left?: string;
  right?: string;
  /** grid (a rows × cols matrix, e.g. "which assets exist, and in what state") */
  rows?: string[];
  cols?: string[];
}

export interface QuestionnaireSection {
  id: string;
  title: string;
  blurb: string;
  fields: QuestionnaireField[];
}

/** Bumped whenever a field is added, removed, renamed, or reworded. A stored submission's own
 *  `schema_version` records which shape of this module produced it (design §3.3) — readers must
 *  never assume the CURRENT shape of this file describes an older submission's `answers`. */
export const SCHEMA_VERSION = "agency-discovery.2026-09-05.v1";

// Local constructors mirroring the source form's T/P/D/R/C/S/G/H helpers 1:1, so this transcription
// stays checkable line-by-line against gaia-onboarding-form/src/form.html rather than inventing a
// new shape to translate through.
function T(id: string, label: string, help: string | null, req: number): QuestionnaireField {
  return { id, type: "text", label, help, required: !!req };
}
function P(id: string, label: string, help: string | null, req: number): QuestionnaireField {
  return { id, type: "textarea", label, help, required: !!req };
}
function D(id: string, label: string, help: string | null, req: number): QuestionnaireField {
  return { id, type: "date", label, help, required: !!req };
}
function R(id: string, label: string, help: string | null, opts: string[], req: number, other = 0): QuestionnaireField {
  return { id, type: "radio", label, help, options: opts, other: !!other, required: !!req };
}
function C(id: string, label: string, help: string | null, opts: string[], req: number, other = 0): QuestionnaireField {
  return { id, type: "checkbox", label, help, options: opts, other: !!other, required: !!req };
}
function S(id: string, label: string, left: string, right: string, help: string | null = null): QuestionnaireField {
  // The source form hardcodes every scale as required — there is no "correct" answer to skip, only
  // a preference to map, so leaving one blank tells a reviewer nothing usable.
  return { id, type: "scale", label, left, right, help, required: true };
}
function G(id: string, label: string, help: string | null, rows: string[], cols: string[], req: number): QuestionnaireField {
  return { id, type: "grid", label, help, rows, cols, required: !!req };
}
function H(title: string, help: string | null = null): QuestionnaireField {
  return { type: "group", label: title, help, required: false };
}

export const QUESTIONNAIRE_SECTIONS: QuestionnaireSection[] = [
  {
    id: "project", title: "Project Overview",
    blurb: "The basics. Who you are, what you are trying to achieve, and when.",
    fields: [
      T("project_name", "Project / brand name", "Official name, with the capitalisation you want us to use.", 1),
      T("org_name", "Business / organisation name", "Legal or public-facing entity name.", 1),
      T("current_url", "Current website URL", 'If you do not have one yet, write "none".', 1),
      H("Primary contact", "The person who owns this project and can make decisions about it."),
      T("contact_name", "Name", null, 1),
      T("contact_role", "Role", null, 1),
      T("contact_email", "Email", null, 1),
      T("contact_phone", "Phone / WhatsApp", null, 0),
      H("Objectives"),
      P("objective", "What must this website accomplish?", 'The single most important outcome. Not "a new website" — what changes for the business once it is live.', 1),
      C("success_metrics", "Primary success metric", "How we will know it worked. Pick what matters, then narrow it below.",
        ["Qualified leads", "Bookings / appointments", "Online sales", "Sign-ups / subscriptions", "Phone or WhatsApp enquiries", "Brand awareness / credibility", "Reduced support load", "Recruitment / applications"], 1, 1),
      T("primary_metric", "If you had to pick ONE success metric, which is it?", "Sites optimised for one thing outperform sites optimised for five.", 1),
      D("launch_date", "Target launch date", "If there is a hard deadline — an event, a campaign, a contract — say so below.", 1),
      P("deadlines", "Hard deadlines and dependencies", "Anything immovable, and what it depends on.", 0),
      R("budget_range", "Budget range", "This decides scope and implementation approach, not quality. An honest number gets you a realistic plan.",
        ["Under USD 3,000", "USD 3,000 – 7,000", "USD 7,000 – 15,000", "USD 15,000 – 30,000", "USD 30,000+", "Prefer to discuss on a call"], 0, 0),
    ],
  },
  {
    id: "business", title: "Your Business",
    blurb: "What you do, and what is not working today.",
    fields: [
      P("offering", "What do you sell or provide?", "Plain language. Imagine explaining it to someone outside your industry.", 1),
      P("differentiator", "What makes you different?", 'Your competitive advantage — and the proof behind it. "Quality service" is not a differentiator; "the only certified installer in East Java" is.', 1),
      P("priorities", "Your top 3 business priorities", "Ranked 1–3.", 1),
      T("market", "Geographic market", "Countries, cities or service areas you actually serve.", 1),
      C("business_model", "Business model", null,
        ["B2B", "B2C", "B2B2C", "Marketplace", "Subscription / recurring", "E-commerce", "Services / consulting", "Non-profit"], 1, 1),
      P("current_site_problems", "What is not working on your current website?", "Be blunt. If you have analytics showing where people drop off, share it.", 1),
    ],
  },
  {
    id: "competitors", title: "Competitors",
    blurb: "Both the companies you lose deals to and the brands you would like to be mentioned alongside. Aspirational references are as useful as direct rivals.",
    fields: [
      T("competitor_1_name", "Competitor 1 — name and URL", null, 1),
      P("competitor_1_assessment", "Competitor 1 — what they do well, and what they do badly", null, 1),
      T("competitor_2_name", "Competitor 2 — name and URL", null, 1),
      P("competitor_2_assessment", "Competitor 2 — what they do well, and what they do badly", null, 1),
      T("competitor_3_name", "Competitor 3 — name and URL", null, 0),
      P("competitor_3_assessment", "Competitor 3 — what they do well, and what they do badly", null, 0),
      P("competitors_other", "Any other competitors we should look at", "Names and URLs is enough.", 0),
      P("category_cliches_to_avoid", "What must we avoid doing that competitors do?", "The category clichés you want no part of.", 1),
    ],
  },
  {
    id: "audience", title: "Your Audience",
    blurb: "Everything on the site gets designed for a specific person. This defines them.",
    fields: [
      P("primary_audience", "Who is your most important visitor?", "Role, situation, what brought them here. If you serve several groups, the primary one is whoever most affects revenue.", 1),
      P("secondary_audiences", "Secondary audiences", "Other groups the site must still serve.", 0),
      P("audience_pain", "What problems or frustrations do they have?", "The pain that makes them start looking in the first place.", 1),
      P("audience_goals", "What are they trying to achieve?", "Their goal, in their words — not yours.", 1),
      C("decision_drivers", "What drives their decision?", "What actually tips them into choosing a supplier.",
        ["Price", "Trust / reputation", "Speed", "Quality", "Status / prestige", "Convenience", "Expertise", "Location / proximity", "Range of choice"], 1, 1),
      P("objections", "Why might they hesitate?", "The objections you hear on every sales call. The site should answer them before anyone has to ask.", 1),
      R("knowledge_level", "How much do they already know about what you offer?", "This sets how much the site explains versus how fast it gets to the point.",
        ["Beginner — needs the category explained", "Informed — understands the category, comparing options", "Expert — knows what they want, needs specifics", "Mixed — a genuine spread across all three"], 1, 0),
    ],
  },
  {
    id: "brand", title: "Brand & Voice",
    blurb: "How the brand should feel, sound, and behave.",
    fields: [
      H("Personality"),
      T("brand_adjectives", "Describe the brand in 3–7 adjectives", "e.g. premium, warm, technical, playful, understated, bold.", 1),
      T("brand_avoid_traits", "Which traits must the brand NEVER communicate?", "As important as the list above. e.g. cheap, corporate, aggressive, gimmicky.", 1),
      P("brand_as_person", "If the brand were a person, how would they behave?", "How they enter a room, how they talk, what they would never do.", 1),
      H("Positioning"),
      P("category_in", "What category should customers place you in?", null, 1),
      P("category_out", "What category should customers NOT place you in?", "The comparison you want to avoid.", 1),
      P("why_choose_you", "Why should someone choose you over the obvious alternative?", null, 1),
      P("proof", "What proof makes that claim credible?", "Numbers, awards, clients, certifications, years, case studies.", 1),
      H("Messaging"),
      P("brand_promise", "Your brand promise", "One clear sentence: the value you commit to delivering.", 1),
      T("brand_values", "Your core values", "3–7 of them.", 1),
      T("tagline", "Existing tagline or key message", "Only if it is already approved and in use.", 0),
      P("simplest_explanation", "The simplest possible explanation of what you do", "One sentence, no jargon. This often becomes the homepage headline.", 1),
      P("homepage_core_message", "The single most important message on the homepage", "If a visitor reads one thing and leaves, what should it have been?", 1),
      P("supporting_messages", "The 3–5 supporting messages", "What backs up the main message.", 1),
      H("Tone of voice"),
      C("tone", "How should the copy sound?", null,
        ["Formal", "Conversational", "Authoritative", "Playful", "Warm", "Direct / no-nonsense", "Editorial / considered", "Technical / precise"], 1, 1),
      S("voice_expert_approachable", "Expert ←→ Approachable", "Expert", "Approachable", "1 = speaks with authority to people who know the field. 5 = welcoming and jargon-free."),
      S("voice_concise_descriptive", "Concise ←→ Descriptive", "Concise", "Descriptive", "1 = short, punchy, minimal. 5 = rich, detailed, story-led."),
      T("words_use", "Words or phrases we SHOULD use", "Your preferred terminology.", 0),
      T("words_avoid", "Words or phrases we must AVOID", "Legal restrictions, cultural sensitivities, positioning traps.", 0),
      P("cultural_considerations", "Any cultural or language considerations?", "Local norms, religious sensitivities, regional differences we should know about.", 0),
      H("Emotional outcome"),
      P("feel_5_seconds", "What should someone feel within 5 seconds of landing on the site?", null, 1),
      P("feel_after_convert", "What should they feel right after they convert?", "Confident? Relieved? Excited? This shapes confirmation pages and follow-up.", 1),
    ],
  },
  {
    id: "visual", title: "Visual Direction",
    blurb: "Move each slider toward the end that feels right. There is no correct answer — we are mapping your taste so the first design lands closer to it. The middle is a valid answer, but a section full of 3s tells us nothing.",
    fields: [
      H("Overall style"),
      S("vis_minimal_expressive", "Minimal ←→ Expressive", "Minimal", "Expressive"),
      S("vis_corporate_editorial", "Corporate ←→ Editorial", "Corporate", "Editorial"),
      S("vis_luxury_accessible", "Luxury ←→ Accessible", "Luxury", "Accessible"),
      S("vis_technical_human", "Technical ←→ Human", "Technical", "Human"),
      S("vis_serious_playful", "Serious ←→ Playful", "Serious", "Playful"),
      H("Layout & typography"),
      S("vis_dense_spacious", "Dense ←→ Spacious", "Dense", "Spacious", "Dense = a lot visible at once. Spacious = generous white space, less per screen."),
      S("vis_grid_organic", "Structured grid ←→ Organic composition", "Structured grid", "Organic"),
      S("vis_neutral_distinctive", "Neutral type ←→ Distinctive type", "Neutral", "Distinctive", "Neutral = the typeface stays out of the way. Distinctive = it is part of the brand."),
      H("Photography & colour"),
      S("vis_product_people", "Product-focused ←→ People-focused", "Product", "People"),
      S("vis_studio_natural", "Studio ←→ Natural / editorial", "Studio", "Natural"),
      S("vis_mono_colourful", "Monochrome ←→ Colourful", "Monochrome", "Colourful"),
      S("vis_contrast", "High contrast ←→ Soft contrast", "High contrast", "Soft contrast"),
      H("Motion & components"),
      R("motion_level", "How much motion should the site have?", null,
        ["None — everything static", "Subtle — gentle fades and reveals", "Editorial — noticeable, considered transitions", "Cinematic — motion is a headline feature", "Highly interactive — the user drives the animation"], 1, 0),
      S("vis_standard_custom", "Standard components ←→ Highly custom", "Standard", "Highly custom", "Standard is faster to build and easier for you to maintain. Custom is more distinctive and costs more."),
      H("References", "The most useful part of this form. For each site, name the specific thing you like — typography, density, navigation, motion, imagery, hierarchy, colour, interaction. \"I like it\" is not usable; \"I like how the navigation collapses on scroll\" is."),
      P("reference_1", "Reference site 1 — URL and what specifically you like", null, 1),
      P("reference_2", "Reference site 2 — URL and what specifically you like", null, 1),
      P("reference_3", "Reference site 3 — URL and what specifically you like", null, 0),
      P("dislike_reference", "A site or style you dislike — and why", "As informative as what you like.", 1),
      P("visual_avoid", "Visual things to avoid", "Colours, layouts, effects, stock-photo clichés — anything off the table.", 1),
    ],
  },
  {
    id: "assets", title: "Existing Brand Assets",
    blurb: "What already exists. If assets are not ready, say so — it affects the timeline.",
    fields: [
      R("has_brand_guidelines", "Do you have existing brand guidelines?", null,
        ["Yes — a full documented brand book", "Partial — logo and colours, nothing formal", "No — brand direction needs defining as part of this project"], 1, 0),
      R("logo_files", "Logo files", "Vector (SVG / AI / EPS) with light and dark variants is what we need.",
        ["Yes — vector, with light and dark variants", "Yes — vector, single variant", "Only raster files (PNG / JPG)", "No usable logo files — needs recreating or designing"], 1, 0),
      P("brand_colours", "Brand colours", 'HEX, RGB, CMYK or Pantone — whatever you have. If none, write "to be defined".', 1),
      P("brand_fonts", "Brand fonts", "Primary and secondary typefaces, and whether you hold web licences for them.", 1),
      C("photography_direction", "Photography direction", null,
        ["Real / documentary", "Editorial", "Lifestyle", "Product", "Architectural", "Portrait", "Stock imagery is acceptable", "To be defined"], 1, 1),
      C("illustration_direction", "Illustration and icon direction", null,
        ["Outline icons", "Filled icons", "Geometric", "Hand-drawn", "Custom illustration", "No illustration", "To be defined"], 0, 1),
      T("asset_link", "Link to your brand assets", "Drive, Dropbox, WeTransfer or Figma link holding logos, guidelines, fonts and photography. A link keeps large files out of this form and lets you keep adding to it after you submit.", 1),
    ],
  },
  {
    id: "ux", title: "Journey & Conversion",
    blurb: "How someone gets from arriving to doing the thing you want them to do.",
    fields: [
      P("journey", "Describe the ideal path from landing to conversion", "Step by step. Where do they arrive, what do they read, what convinces them, what do they click?", 1),
      T("primary_cta", "The single most important action a visitor can take", 'One dominant call to action. e.g. "Request a quote", "Book a consultation".', 1),
      T("secondary_cta", "Supporting actions", "Secondary calls to action.", 0),
      R("conversion_type", "What counts as a conversion?", null,
        ["Form submission / lead", "Online purchase", "Booking or appointment", "Phone call", "WhatsApp message", "Email enquiry", "Newsletter sign-up", "Download / gated content"], 1, 1),
      P("conversion_friction", "What currently stops people from converting?", "Friction you already know about — a long form, unclear pricing, no trust signals.", 1),
      C("trust_signals", "What trust signals can we use?", null,
        ["Customer reviews / ratings", "Testimonials", "Case studies", "Client logos", "Certifications / accreditations", "Awards", "Press coverage", "Guarantees / warranties", "Team profiles", "Years in business", "Statistics / numbers"], 1, 1),
      P("lead_routing", "Where do leads go, and who follows up?", "Inbox, CRM, WhatsApp group — and the person responsible, with expected response time.", 0),
      H("Navigation & access"),
      R("nav_style", "Navigation style", null,
        ["Simple — 4–6 top-level items", "Standard — top level with dropdowns", "Mega menu — large multi-column panels", "Multi-level — deep hierarchy", "Not sure — recommend based on our content"], 1, 0),
      R("mobile_priority", "How important is mobile?", null,
        ["Mobile-first — most traffic is mobile", "High — roughly an even split", "Medium — desktop leads but mobile matters", "Low — almost all desktop"], 1, 0),
      R("accessibility_target", "Accessibility target", null,
        ["WCAG 2.2 AA — our standard, recommended", "WCAG 2.2 AAA — required by regulation or policy", "Basic good practice only", "Not sure — advise us"], 1, 0),
      P("accessibility_notes", "Specific accessibility requirements", "Contrast, keyboard access, screen readers, captions, or any legal obligation.", 0),
    ],
  },
  {
    id: "sitemap", title: "Pages & Features",
    blurb: "What the site is made of. A rough list is fine — we will structure it properly and come back with a sitemap for approval.",
    fields: [
      C("pages_required", "Which pages do you need?", null,
        ["Homepage", "About", "Services / Products", "Individual service or product pages", "Case studies / Portfolio", "Blog / Resources", "Team", "Careers", "Pricing", "FAQ", "Contact", "Locations", "Privacy policy / Terms"], 1, 1),
      P("pages_other", "Any other pages?", "List anything not covered above.", 0),
      T("priority_pages", "Which pages matter most?", "Name the 3 pages that carry the business. They get the design attention.", 1),
      C("features_required", "Which features do you need?", null,
        ["Contact form", "Multi-step form / quote builder", "Search", "Booking or appointment system", "E-commerce / checkout", "User accounts / login", "Members-only area", "Price calculator", "Interactive map", "Live chat", "WhatsApp click-to-chat", "Newsletter sign-up", "Event calendar", "Downloads / document library", "Multi-language switcher"], 1, 1),
      P("feature_detail", "Describe any feature that needs explaining", "Especially bookings, calculators, or anything with business rules behind it.", 0),
      P("cms_editable", "What must you be able to edit yourself?", 'Be realistic. Every editable region adds build cost — "everything" is expensive and usually unnecessary. Tell us what actually changes month to month.', 1),
    ],
  },
  {
    id: "content", title: "Content & SEO",
    blurb: "Content is the most common cause of a delayed launch. This section finds that out early rather than late.",
    fields: [
      R("copy_owner", "Who is writing the copy?", null,
        ["Client — we write all of it", "Agency — you write all of it", "Shared — we draft, you refine", "AI-assisted, agency-edited", "Not decided yet"], 1, 0),
      G("asset_inventory", "What assets already exist?", 'Answer honestly — "exists, needs work" is far more useful to us than an optimistic "ready".',
        ["Logo (vector)", "Brand guidelines", "Photography", "Video", "Written copy", "Product data", "Testimonials", "Case studies", "Legal / privacy text"],
        ["Ready to use", "Exists, needs work", "Does not exist", "Not sure"], 1),
      P("content_owner_dates", "Who owns getting the missing content ready, and by when?", 'Name a person and a date for anything marked "needs work" or "does not exist".', 1),
      P("existing_content", "Existing content we should look at", "Links to current pages, brochures, PDFs, product data, articles.", 0),
      R("migration_scope", "Does content need migrating from an existing site?", null,
        ["No", "Yes — under 20 pages", "Yes — 20–100 pages", "Yes — 100–500 pages", "Yes — over 500 pages", "Not sure"], 1, 0),
      C("languages", "Languages", null,
        ["English", "Bahasa Indonesia", "Mandarin", "Japanese", "Korean", "Russian", "French", "German", "Dutch"], 1, 1),
      P("seo_requirements", "SEO requirements", "Target keywords, target locations, rankings you must not lose, and any URLs needing redirects. If you are replacing an existing site, this matters a lot.", 1),
    ],
  },
  {
    id: "technical", title: "Technical & Integrations",
    blurb: "The systems the site has to work with, and the constraints it must respect.",
    fields: [
      R("platform", "Preferred platform", "If you have no preference, pick the last option.",
        ["WordPress", "Next.js / headless", "Webflow", "Shopify", "Keep our current platform", "No preference — recommend the right fit"], 0, 1),
      R("hosting", "Hosting", null,
        ["Use our existing hosting", "Agency-managed hosting", "Recommend something", "Not sure"], 0, 0),
      T("dns_owner", "Who controls the domain and DNS?", "Name the person or company with registrar access. This blocks launch more often than anything else on this form.", 1),
      C("integrations", "Which systems must the site integrate with?", null,
        ["CMS", "CRM", "ERP", "Payment gateway", "Email marketing", "WhatsApp Business", "Analytics", "Booking system", "Maps / location", "Authentication / SSO", "Custom API", "Accounting software", "None of these"], 1, 1),
      P("integration_providers", "For each system above, name the provider", 'e.g. "CRM: HubSpot. Payments: Midtrans. Email: Mailchimp." Include whether API access already exists and who holds the credentials.', 0),
      C("analytics", "Analytics and tracking", null,
        ["Google Analytics 4", "Google Tag Manager", "Meta Pixel", "LinkedIn Insight", "TikTok Pixel", "Hotjar / Clarity", "Google Search Console", "None yet — set it up for us"], 1, 1),
      P("compliance", "Security and compliance requirements", "Privacy law (GDPR, UU PDP), cookie consent, industry regulation, data residency.", 1),
      R("performance_target", "Performance expectations", null,
        ["Standard — fast, sensible defaults", "High — Core Web Vitals all green is a requirement", "Critical — performance is a competitive factor and will be measured"], 1, 0),
      P("browser_support", "Browser and device support", "Modern browsers on current devices is our default. Say so if you need anything older.", 0),
    ],
  },
  {
    id: "governance", title: "Decisions, Scope & Aftercare",
    blurb: "Who signs off, what is in, what is out, and what happens after launch.",
    fields: [
      P("decision_makers", "Who are the decision makers?", "Names and roles of everyone who can approve or block. Include anyone who tends to appear late and change their mind — we would rather plan for them.", 1),
      P("approval_process", "What is the approval process?", "Who reviews what, in what order, and how long each round typically takes.", 1),
      R("revision_rounds", "How many revision rounds do you expect per deliverable?", null,
        ["1", "2 — our standard", "3", "More than 3 — we have a large committee"], 1, 0),
      R("legal_review", "Is legal or regulatory review required?", null,
        ["No", "Yes — internal legal", "Yes — external counsel", "Yes — industry regulator"], 0, 0),
      P("signoff_criteria", 'What constitutes final sign-off?', 'The specific condition that means "done".', 1),
      H("Scope"),
      P("in_scope", "What is explicitly IN scope?", null, 1),
      P("out_scope", "What is explicitly OUT of scope?", "Naming exclusions now prevents an awkward conversation later.", 1),
      P("dependencies", "Dependencies outside our control", "Assets, API access, third-party vendors, internal approvals, content from other teams.", 1),
      H("After launch"),
      T("maintenance_owner", "Who maintains the site after launch?", "Content owner and technical owner.", 1),
      R("training", "Do you need training?", null,
        ["Yes — CMS training for the content team", "Yes — full admin and technical handover", "No — we are comfortable", "Not sure yet"], 0, 0),
      P("support_expectations", "Support expectations", "Ongoing maintenance, monitoring, response times, retainer.", 0),
    ],
  },
  {
    id: "close", title: "Anything Else",
    blurb: "The question that catches what the form missed.",
    fields: [
      P("anything_else", "Is there anything we have not asked that we should know?", "Internal politics, a failed previous attempt, a constraint you have not mentioned, a strong opinion someone holds. Anything that would change how we approach this.", 0),
      R("confidence", "How confident are you in the answers you have given?", null,
        ["Very — these are settled decisions", "Mostly — a few need internal confirmation", "Partly — several are best guesses and may change", "Low — we need help working most of this out"], 1, 0),
    ],
  },
];

export const ALL_QUESTIONNAIRE_FIELDS: QuestionnaireField[] = QUESTIONNAIRE_SECTIONS.flatMap((s) =>
  s.fields.filter((f) => f.type !== "group"),
);
export const REQUIRED_FIELD_IDS: string[] = ALL_QUESTIONNAIRE_FIELDS.filter((f) => f.required).map((f) => f.id as string);
export const QUESTIONNAIRE_REQUIRED_TOTAL: number = REQUIRED_FIELD_IDS.length;

/** Mirrors the source form's `filled()`: empty string/undefined/null and empty arrays don't count;
 *  a grid counts as answered only once every row has a non-empty entry. */
function isAnswered(field: QuestionnaireField, value: unknown): boolean {
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

export interface AnswerCounts {
  answeredCount: number;
  requiredAnswered: number;
  requiredTotal: number;
}

/** Server-derived completion counters (design §3.3: "plain columns ... written by the app, NOT
 *  generated"). NEVER accept a client-supplied count here — the whole point of storing these on the
 *  row is so a reviewer can trust the number without re-deriving it, which only holds if the number
 *  came from the server's own question set, not from whatever the prospect's browser claims. */
export function countAnswers(answers: Record<string, unknown>): AnswerCounts {
  let answeredCount = 0;
  let requiredAnswered = 0;
  for (const field of ALL_QUESTIONNAIRE_FIELDS) {
    const id = field.id as string;
    if (!isAnswered(field, answers[id])) continue;
    answeredCount += 1;
    if (field.required) requiredAnswered += 1;
  }
  return { answeredCount, requiredAnswered, requiredTotal: QUESTIONNAIRE_REQUIRED_TOTAL };
}
