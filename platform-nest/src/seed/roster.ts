// The agency's people roster + department/division shape — the ONE definition both seeds read.
//
// It lives in its own file (rather than in agency.ts, where it started) because two seeds need it:
// agency.ts builds the org tree from it, and departments.ts seeds each department's project
// portfolio, per-person tasks and HR files from it. Importing it from agency.ts would have made the
// department seed drag in the whole holding seed — including its `require.main` entry point and its
// migrate() import — which is wrong for a seed that must be runnable on its own against an existing
// database.
//
// ── THESE ARE REAL PEOPLE NOW (owner-supplied, 2026-08-23) ────────────────────────────────────────
// Until this change the roster was nine invented Balinese names on `@gaia.test`. They are replaced by
// the actual Gaia Digital Agency staff on `@gaiada.com` (Google Workspace, company-managed), because
// the roster is what `provision-roster.mjs` reads to create real Keycloak logins — an invented name
// there is an account nobody can use, and a real person missing from here cannot log in at all.
//
// ⚠ THE FIVE `@gaiada-creative.test` ACCOUNTS ARE NOT PEOPLE AND MUST STAY. They are seed ACTORS:
// `departments.ts` fails hard with "seed actor (owner@gaiada-creative.test) not found" without the
// first, `agency.ts` attributes seeded tasks to the designer/copywriter, and
// `google-oauth-keycloak.test.ts` uses one as its default test user. Deleting them to tidy the list
// would break three things that have nothing to do with the roster.

/** Seniority as the owner stated it. Carried as data because the TITLE is what people read, but the
 *  LEVEL is what a future appraisal or pay-band feature has to group by, and parsing it back out of
 *  "Medior Web Developer" is the kind of string-sniffing that breaks on the first retitle. */
export type StaffLevel = "gm" | "head" | "manager" | "senior" | "medior" | "junior" | "fixture";

export interface StaffMember {
  email: string;
  name: string;
  title: string;
  /** Org-tree node: a division `v-*`, or the department `d-*` for the no-division teams. */
  target: string;
  level: StaffLevel;
  /** True for the person who leads `target`'s unit. Drives `positions.is_lead`, which is display +
   *  backfill only — actual lead authority comes from the org_unit_lead role set (0109 §2). */
  lead?: boolean;
}

export const STAFF: StaffMember[] = [
  // ── GM ──────────────────────────────────────────────────────────────────────────────────────────
  { email: "edward@gaiada.com", name: "Edward", title: "General Manager", target: "d-gm", level: "gm", lead: true },

  // ── Web Dev ─────────────────────────────────────────────────────────────────────────────────────
  // Azlan is "Tech Lead" AND "Head of Web Dev Department". Those are one seat, not two: the title
  // records what he is called, `lead: true` on the department records the authority.
  { email: "azlan@gaiada.com", name: "Azlan", title: "Tech Lead · Head of Web Dev", target: "d-webdev", level: "head", lead: true },
  { email: "hansel@gaiada.com", name: "Clement Hansel", title: "AI Manager", target: "v-aimgr", level: "manager", lead: true },
  { email: "reva@gaiada.com", name: "Reva", title: "Medior Web Developer", target: "v-webdev", level: "medior" },
  { email: "fadhil@gaiada.com", name: "Fadhil", title: "Junior Web Developer", target: "v-webdev", level: "junior" },
  // ⚠ GUESSED EMAIL LOCAL-PART. The owner gave "kadek arie" and the rule "name@gaiada.com"; every
  // other name is one word so this is the only ambiguous one. Dotted to match the convention the old
  // roster used for two-word names. If Workspace has `kadekarie@` or `arie@`, this row is the fix.
  { email: "kadek.arie@gaiada.com", name: "Kadek Arie", title: "Junior Web Developer", target: "v-webdev", level: "junior" },
  { email: "gusde@gaiada.com", name: "Gusde", title: "Senior Web Developer", target: "v-webmaint", level: "senior" },
  { email: "tini@gaiada.com", name: "Tini", title: "Junior Web Maintenance", target: "v-webmaint", level: "junior" },
  { email: "ruli@gaiada.com", name: "Ruli", title: "Medior UI/UX Designer", target: "v-uiux", level: "medior", lead: true },

  // ── SEO ─────────────────────────────────────────────────────────────────────────────────────────
  { email: "rai@gaiada.com", name: "Rai", title: "SEO Manager", target: "d-seo", level: "manager", lead: true },
  // ⚠ The owner described a FLAT team under Rai and named no specialisms, but `d-seo` already carries
  // four divisions (v-seo/v-sem/v-copy/v-backlink) that agency.ts seeds tasks against. Placing all
  // five in `v-seo` is the smallest guess available: they are SEO people in the SEO division. It is a
  // guess about DIVISION, never about identity — their manager can move them in the UI.
  { email: "fajri@gaiada.com", name: "Fajri", title: "SEO Specialist", target: "v-seo", level: "medior" },
  { email: "welly@gaiada.com", name: "Welly", title: "SEO Specialist", target: "v-seo", level: "medior" },
  { email: "ika@gaiada.com", name: "Ika", title: "SEO Specialist", target: "v-seo", level: "junior" },
  { email: "maya@gaiada.com", name: "Maya", title: "SEO Specialist", target: "v-seo", level: "junior" },
  { email: "sophi@gaiada.com", name: "Sophi", title: "SEO Specialist", target: "v-seo", level: "junior" },

  // ── Creative ────────────────────────────────────────────────────────────────────────────────────
  { email: "monic@gaiada.com", name: "Monic", title: "Creative Manager", target: "d-creatives", level: "manager", lead: true },
  // Placed at the DEPARTMENT, not in v-design or v-video: the owner named the people but not their
  // craft, and guessing "Andre is a video editor" invents a job description, which is worse than a
  // person sitting one level up until their manager says otherwise.
  { email: "andre@gaiada.com", name: "Andre", title: "Creative", target: "d-creatives", level: "medior" },
  { email: "rifat@gaiada.com", name: "Rifat", title: "Creative", target: "d-creatives", level: "medior" },
  { email: "elmer@gaiada.com", name: "Elmer", title: "Creative", target: "d-creatives", level: "medior" },

  // ── Social Media ────────────────────────────────────────────────────────────────────────────────
  { email: "radit@gaiada.com", name: "Radit", title: "Social Media Manager", target: "d-social", level: "manager", lead: true },

  // ── seed ACTORS, not staff (see the warning at the top of this file) ─────────────────────────────
  { email: "owner@gaiada-creative.test", name: "Ayu (Owner)", title: "Managing Director", target: "d-gm", level: "fixture" },
  { email: "pm@gaiada-creative.test", name: "Budi (PM)", title: "Project Manager", target: "d-gm", level: "fixture" },
  { email: "design@gaiada-creative.test", name: "Citra (Design)", title: "Senior Designer", target: "v-design", level: "fixture" },
  { email: "copy@gaiada-creative.test", name: "Dewi (Copy)", title: "Copywriter", target: "v-copy", level: "fixture" },
  { email: "approver@gaiada-creative.test", name: "Eka (Client Lead)", title: "Client Lead", target: "d-gm", level: "fixture" },
  // Held by D-7 (IAM-15 deletes `group_executive`). Left in place so the role has a holder until the
  // sweep that removes it, rather than orphaning the estate's only exec principal early.
  { email: "exec@gaiada.test", name: "Gaiada Exec", title: "Group Executive", target: "d-gm", level: "fixture" },
];

/** Seats the owner described but did NOT name — "Project Manager (still no name, just position now)",
 *  "3 others" under Creative, "6 person under him" under Social Media.
 *
 *  ⚠ THESE ARE POSITIONS, NEVER PEOPLE. Inventing ten names to fill the chart would put ten fake
 *  employees in HR, ten fake logins in Keycloak and ten fake headcounts in every report — and each
 *  one would look exactly as real as Edward. A vacant `positions` row with a headcount is what the
 *  Phase-2 machinery is FOR (0109: `headcount` is "a soft target, display only"), and it is what lets
 *  a manager fill the seat from the UI, which is precisely what the owner asked for. */
export interface Vacancy {
  target: string;
  title: string;
  count: number;
}

export const VACANCIES: Vacancy[] = [
  // Sits under Azlan alongside Hansel — the delivery half of that layer.
  { target: "d-webdev", title: "Project Manager", count: 1 },
  { target: "d-creatives", title: "Creative", count: 3 },
  { target: "d-social", title: "Social Media Specialist", count: 6 },
];

/** Legacy tuple view, kept so agency.ts and departments.ts read the roster unchanged.
 *  [email, name, title, target] — the shape both consumers destructure. */
export const EMPLOYEES: [string, string, string, string][] = STAFF.map(
  (s) => [s.email, s.name, s.title, s.target] as [string, string, string, string],
);

export const AGENCY_DEPTS: { id: string; name: string; divisions: [string, string][] }[] = [
  { id: "d-webdev", name: "Web Dev", divisions: [["v-webdev", "Web Dev"], ["v-webmaint", "Web Maintenance"], ["v-aimgr", "AI Manager"], ["v-uiux", "UI/UX"]] },
  { id: "d-creatives", name: "Creatives", divisions: [["v-design", "Design Graphics"], ["v-video", "Video Editor"]] },
  { id: "d-seo", name: "SEO", divisions: [["v-seo", "SEO"], ["v-sem", "SEM"], ["v-copy", "Copywriter"], ["v-backlink", "Backlink"]] },
  { id: "d-social", name: "Social Media", divisions: [] },
  { id: "d-gm", name: "GM", divisions: [] },
];

/** The reporting chain the owner stated, as an ordered spine of org-tree nodes:
 *  Edward (GM) → Azlan (Head of Web Dev) → the AI Manager + Project Manager layer → the divisions.
 *
 *  Only the DEPARTMENT spine is recorded. Individual reporting lines are deliberately NOT duplicated
 *  per person: 0109 states the default reporting line IS the org chart ("nearest ancestor unit's lead
 *  position holder", design §2.1) and `employees.manager_user_id` is an OVERRIDE only. Writing a
 *  manager onto every row would create a second source of truth that silently diverges the first time
 *  someone is promoted in the UI. */
export const DEPT_PARENT: Record<string, string | null> = {
  "d-gm": null,
  "d-webdev": "d-gm",
  "d-seo": "d-gm",
  "d-creatives": "d-gm",
  "d-social": "d-gm",
};
