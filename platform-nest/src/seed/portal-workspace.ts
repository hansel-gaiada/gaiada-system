// CP-20 — the other half of the portal demo seed: everything the CP-2..CP-5 surfaces read.
//
// `portal-clients.ts` seeds identity and delivery — clients, contacts (signer + viewer), Keycloak
// logins, projects, pipeline runs, gates. That was enough when the portal WAS the runs page. The
// dashboard added six more surfaces, and against the seed as it stood every one of them rendered its
// empty state: 0% progress, no milestones, no deliverables, no invoices, no agreements. A portal that
// only ever shows empty states has not been reviewed.
//
// ── WHY THE STATES ARE DELIBERATELY UNEVEN ────────────────────────────────────────────────────────
// Each client gets a different SHAPE, not more of the same rows, because the branches that break in
// production are the ones no fixture reaches:
//
//   Nusa Coffee      mid-flight · an OVERDUE milestone · a payment PENDING our verification ·
//                    an agreement countersigned by us and waiting on THEM (the sign flow's live case)
//   Kintamani        early · overdue milestone · one open invoice · an agreement nobody has signed
//   Ubud Yoga        VIEW-ONLY contact · a sent agreement they CANNOT sign (proves the refusal path
//                    renders as an explanation rather than a broken button)
//   Bali Weddings    nearly done · everything delivered · everything paid ("nothing outstanding")
//   Sanur Dive       closed · fully signed · settled (the archive state)
//
// Between them: overdue, awaiting-verification, partially paid, fully paid, void, awaiting-signature,
// signed-by-one-party, signed-by-both, view-only, delivered-with-no-file, and a project at 0%.
//
// Idempotent like every seed here: create-or-skip keyed on natural names, so re-running enriches
// rather than duplicating. Direct DB writes — no running platform needed.
//
// Run (after seed:agency and the portal-clients half):
//   DATABASE_URL=... node dist/seed/portal-workspace.js
import { newId, withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";

const site = () => config.originSite;
const IDR = "IDR";

/** Day offset -> YYYY-MM-DD, computed in UTC so a seeded date means the same thing wherever it runs. */
function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

type Shape = "midflight" | "early" | "viewonly" | "nearlydone" | "closed";

interface Plan {
  client: string;
  shape: Shape;
}

// Keyed by client name so this file and portal-clients.ts stay independent — neither imports the
// other's SPECS, and adding a client to one without the other degrades to "no workspace data" rather
// than a crash.
const PLANS: Plan[] = [
  { client: "Nusa Coffee Co", shape: "midflight" },
  { client: "Kintamani Roasters", shape: "early" },
  { client: "Ubud Yoga Collective", shape: "viewonly" },
  { client: "Bali Wedding Planners", shape: "nearlydone" },
  { client: "Sanur Dive Center", shape: "closed" },
];

// ── lookups ───────────────────────────────────────────────────────────────────────────────────────

/** Every company, so a client can be found without knowing which one serves it.
 *
 *  `companies` and `users` are the ONLY two tables here without row security, which is what makes
 *  `withGlobal` legitimate for them and illegitimate for everything else — see findClient. */
async function allCompanyIds(): Promise<string[]> {
  const r = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC`),
  );
  return r.rows.map((x) => x.id);
}

/** Locate a client by name across every company.
 *
 *  ⚠ THIS MUST SEARCH TENANT BY TENANT, and the first version did not. It read `clients` through
 *  `withGlobal`, reasoning that the seed does not know which member company serves the client. That is
 *  true and it is not a licence to skip the tenant context: `clients` has FORCE ROW LEVEL SECURITY and
 *  the seed runs as `platform_app` with `bypassrls = false`, so with no `app.current_tenant_ids` GUC set
 *  the policy matches NOTHING. The query returned zero rows for all five clients and the seed reported
 *  "run the portal-clients seed first" — a misdiagnosis of its own bug, pointing at a prerequisite that
 *  had in fact just run successfully.
 *
 *  Exactly the failure mode the backfill-RLS trap describes (unset GUC ⇒ affects zero rows ⇒ reports
 *  success). Only `companies` and `users` are RLS-free; `clients`, `client_contacts`,
 *  `company_memberships`, `projects`, `invoices` and `contracts` are all FORCE RLS. If a seed reads any
 *  of those, it goes through `withTenants`. */
async function findClient(name: string): Promise<{ tenantId: string; clientId: string } | null> {
  for (const tenantId of await allCompanyIds()) {
    const r = await withTenants([tenantId], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM clients WHERE name = $1 AND deleted_at IS NULL LIMIT 1`, [name],
      ),
    );
    if (r.rows[0]) return { tenantId, clientId: r.rows[0].id };
  }
  return null;
}

/** The client's projects, PRIMARY FIRST.
 *
 *  "Primary" = the one carrying a pipeline run, because that is the project `portal-clients.ts` created
 *  and attached the gates to. Taking the oldest project instead (the first version) put the milestones
 *  and deliverables on a DIFFERENT project from the approvals, and left the rest reading 0% with no
 *  milestones — verified by crawling the live portal as a seeded client: Nusa Coffee showed four
 *  projects, three of them empty, and the one detail page a reviewer would click first was blank.
 *
 *  The tail matters as much as the head: a client with four projects should not see three husks, so the
 *  caller gives the others a light task set (see `seedSecondaryProject`). */
async function findProjects(tenantId: string, clientId: string): Promise<string[]> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT p.id
         FROM projects p
        WHERE p.client_id = $1 AND p.deleted_at IS NULL
        ORDER BY EXISTS (
          SELECT 1 FROM pipeline_runs r WHERE r.project_id = p.id AND r.deleted_at IS NULL
        ) DESC, p.created_at ASC`,
      [clientId],
    ),
  );
  return r.rows.map((x) => x.id);
}

/** A secondary project gets tasks and one milestone only — enough that it reads as real work in
 *  progress rather than an empty shell, without inventing invoices or agreements against it. */
async function seedSecondaryProject(tenantId: string, projectId: string, staff: string | null): Promise<void> {
  // Guard on MILESTONES, not tasks. Keying on tasks skipped every project the agency seed had already
  // given tasks to — which is most of them — so those projects kept a progress bar and still showed
  // "No milestones set yet", the exact husk this function exists to prevent. Milestones are the thing
  // being added, so they are the thing to check for.
  const has = await withTenants([tenantId], (c) =>
    c.query(`SELECT 1 FROM pm_milestones WHERE project_id = $1 AND deleted_at IS NULL LIMIT 1`, [projectId]),
  );
  if (has.rows[0]) return;
  const ms = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site)
       VALUES ($1,$2,$3,'Current phase',$4::date,'open',$5)`,
      [ms, tenantId, projectId, day(21), site()],
    ),
  );
  for (const [title, status, progress] of [
    ["Scope confirmed", "done", 100],
    ["Production in progress", "in_progress", 45],
    ["Review & handover", "todo", 0],
  ] as Array<[string, string, number]>) {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, progress, milestone_id, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId(), tenantId, projectId, title, status, progress, ms, site()],
      ),
    );
  }
  if (staff) {
    await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE projects SET owner_id = COALESCE(owner_id, $2),
                start_date = COALESCE(start_date, $3::date), due_date = COALESCE(due_date, $4::date)
          WHERE id = $1`,
        [projectId, staff, day(-30), day(45)],
      ),
    );
  }
}

/** A staff member of this company, for `owner_id` / `created_by` / `confirmed_by`.
 *
 *  Load-bearing for more than tidiness: the portal's payment and contract notifications resolve their
 *  internal recipients from `projects.owner_id`, so a project with no owner means a client action
 *  notifies nobody — which looks exactly like the notification code being broken. */
async function anyStaffUser(tenantId: string): Promise<string | null> {
  // withTenants, not withGlobal: `company_memberships` AND `client_contacts` are both FORCE RLS (see
  // findClient's note). The first version used withGlobal and would have returned null for every
  // company — leaving every project unowned, which is the one thing this function exists to prevent.
  // The column is `tenant_id`, NOT `company_id` — the first version guessed and got a 42703
  // errorMissingColumn on the live box. `kind <> 'service'` matters too: automation and bot principals
  // are deliberately `users` rows with a `service` membership, and making a bot the owner of a client's
  // project would send every client notification to something that cannot read it.
  const r = await withTenants([tenantId], (c) =>
    c.query<{ user_id: string }>(
      `SELECT cm.user_id
         FROM company_memberships cm
        WHERE cm.tenant_id = $1 AND cm.deleted_at IS NULL AND cm.status = 'active'
          AND COALESCE(cm.kind, 'employee') <> 'service'
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = cm.user_id AND u.deleted_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM client_contacts cc WHERE cc.user_id = cm.user_id AND cc.deleted_at IS NULL
          )
        ORDER BY cm.created_at ASC LIMIT 1`,
      [tenantId],
    ),
  );
  return r.rows[0]?.user_id ?? null;
}

/** The client's signer contact, for a client-recorded payment. Falls back to any contact. */
async function signerContact(tenantId: string, clientId: string): Promise<string | null> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ user_id: string }>(
      `SELECT user_id FROM client_contacts
        WHERE client_id = $1 AND deleted_at IS NULL AND status = 'active'
        ORDER BY (capability = 'signer') DESC, created_at ASC LIMIT 1`,
      [clientId],
    ),
  );
  return r.rows[0]?.user_id ?? null;
}

// ── milestones + tasks (these drive the % on every card) ──────────────────────────────────────────

/** Milestone rows per shape. `dueOffset` negative + status open = an OVERDUE milestone, which is the
 *  state the "Was due" wording and the danger styling exist for and which nothing else produces. */
const MILESTONES: Record<Shape, Array<{ name: string; dueOffset: number; status: string }>> = {
  midflight: [
    { name: "Discovery complete", dueOffset: -40, status: "done" },
    { name: "Design approved", dueOffset: -12, status: "done" },
    { name: "Content sign-off", dueOffset: -3, status: "open" },   // OVERDUE on purpose
    { name: "Build & content load", dueOffset: 11, status: "open" },
    { name: "Go live", dueOffset: 32, status: "open" },
  ],
  early: [
    { name: "Kickoff & requirements", dueOffset: -2, status: "open" },  // OVERDUE
    { name: "Information architecture", dueOffset: 14, status: "open" },
    { name: "Catalogue import", dueOffset: 35, status: "open" },
  ],
  viewonly: [
    { name: "Booking flow spec", dueOffset: -25, status: "done" },
    { name: "Integration build", dueOffset: 9, status: "open" },
  ],
  nearlydone: [
    { name: "Microsite build", dueOffset: -30, status: "done" },
    { name: "Booking flow live", dueOffset: -8, status: "done" },
    { name: "Handover & training", dueOffset: 6, status: "open" },
  ],
  closed: [
    { name: "Integration delivered", dueOffset: -60, status: "done" },
    { name: "Post-launch review", dueOffset: -30, status: "done" },
  ],
};

/** Task substrate, only ever read in AGGREGATE by the portal (progress % and a workload count — never
 *  the titles, see the BFF header). Titles are still plausible rather than "task 1", because staff DO
 *  see these in the PM console and a seed that looks fake there is a seed nobody trusts here. */
const TASKS: Record<Shape, Array<[string, string, number]>> = {
  midflight: [
    ["Wireframe the menu pages", "done", 100], ["Design system + tokens", "done", 100],
    ["Homepage build", "done", 100], ["Menu + ordering build", "in_progress", 60],
    ["Copy pass on product pages", "in_progress", 30], ["Awaiting brand photography", "blocked", 10],
    ["Analytics + consent banner", "todo", 0], ["Accessibility audit", "todo", 0],
  ],
  early: [
    ["Stakeholder interviews", "done", 100], ["Competitive scan", "in_progress", 40],
    ["Catalogue data audit", "todo", 0], ["Payment provider shortlist", "todo", 0],
    ["Shipping rules workshop", "todo", 0],
  ],
  viewonly: [
    ["Booking API spec", "done", 100], ["Calendar sync", "done", 100],
    ["Class capacity rules", "in_progress", 75], ["Waitlist handling", "todo", 0],
  ],
  nearlydone: [
    ["Microsite pages", "done", 100], ["Booking flow", "done", 100],
    ["Payment gateway wiring", "done", 100], ["Training material", "in_progress", 80],
  ],
  closed: [
    ["Integration build", "done", 100], ["UAT fixes", "done", 100], ["Handover", "done", 100],
  ],
};

async function seedMilestonesAndTasks(tenantId: string, projectId: string, shape: Shape): Promise<void> {
  for (const m of MILESTONES[shape]) {
    const exists = await withTenants([tenantId], (c) =>
      c.query(`SELECT 1 FROM pm_milestones WHERE project_id=$1 AND name=$2 AND deleted_at IS NULL`, [projectId, m.name]),
    );
    if (exists.rows[0]) continue;
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7)`,
        [newId(), tenantId, projectId, m.name, day(m.dueOffset), m.status, site()],
      ),
    );
  }
  // Tasks are attached to the FIRST open milestone where there is one, so the project page's
  // per-milestone "x of y items complete" line has something to count rather than always reading 0.
  const openMs = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM pm_milestones WHERE project_id=$1 AND status <> 'done' AND deleted_at IS NULL
        ORDER BY due_date ASC NULLS LAST LIMIT 1`,
      [projectId],
    ),
  );
  const milestoneId = openMs.rows[0]?.id ?? null;

  for (const [title, status, progress] of TASKS[shape]) {
    const exists = await withTenants([tenantId], (c) =>
      c.query(`SELECT 1 FROM pm_tasks WHERE project_id=$1 AND title=$2 AND deleted_at IS NULL`, [projectId, title]),
    );
    if (exists.rows[0]) continue;
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, progress, milestone_id, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId(), tenantId, projectId, title, status, progress, milestoneId, site()],
      ),
    );
  }
}

// ── deliverables (+ their files) ───────────────────────────────────────────────────────────────────

/** `files` rows are REFERENCE attachments (a `url`, no `storage_key`) rather than stored blobs.
 *  Deliberate: a seed cannot write bytes into the storage volume from outside the container, and a
 *  metadata row pointing at a `storage_key` with nothing behind it produces a download that 404s —
 *  worse than an honest external link. The portal renders both shapes and labels the link case. */
const DELIVERABLES: Record<Shape, Array<{ name: string; status: string; dueOffset: number; files: string[] }>> = {
  midflight: [
    { name: "Brand direction deck", status: "approved", dueOffset: -35, files: ["brand-direction-v2.pdf"] },
    { name: "Homepage design", status: "delivered", dueOffset: -12, files: ["homepage-desktop.png", "homepage-mobile.png"] },
    { name: "Content plan", status: "delivered", dueOffset: -6, files: ["content-plan.xlsx"] },
    { name: "Menu & ordering pages", status: "in_progress", dueOffset: 11, files: [] },
    // Overdue and still pending — pairs with the overdue milestone.
    { name: "SEO migration map", status: "pending", dueOffset: -1, files: [] },
  ],
  early: [
    { name: "Discovery findings", status: "delivered", dueOffset: -4, files: ["discovery-notes.pdf"] },
    { name: "Information architecture", status: "pending", dueOffset: 14, files: [] },
  ],
  viewonly: [
    { name: "Booking flow spec", status: "approved", dueOffset: -22, files: ["booking-spec.pdf"] },
    // Delivered with NO file: a real case (a deployed integration) and the one that makes the
    // "Delivered — no file attached to this item" copy reachable.
    { name: "Calendar sync integration", status: "delivered", dueOffset: -5, files: [] },
    { name: "Class capacity rules", status: "in_progress", dueOffset: 9, files: [] },
  ],
  nearlydone: [
    { name: "Wedding microsite", status: "delivered", dueOffset: -28, files: ["microsite-handover.pdf"] },
    { name: "Booking + payment flow", status: "approved", dueOffset: -8, files: [] },
    { name: "Training session", status: "pending", dueOffset: 6, files: [] },
  ],
  closed: [
    { name: "Booking integration", status: "approved", dueOffset: -58, files: ["integration-handover.pdf"] },
    { name: "Post-launch report", status: "approved", dueOffset: -29, files: ["post-launch-report.pdf"] },
  ],
};

async function seedDeliverables(tenantId: string, projectId: string, clientId: string, shape: Shape, uploader: string | null): Promise<void> {
  for (const d of DELIVERABLES[shape]) {
    let id: string;
    const found = await withTenants([tenantId], (c) =>
      c.query<{ id: string }>(`SELECT id FROM deliverables WHERE project_id=$1 AND name=$2 AND deleted_at IS NULL`, [projectId, d.name]),
    );
    if (found.rows[0]) {
      id = found.rows[0].id;
    } else {
      id = newId();
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, due_date, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8)`,
          [id, tenantId, projectId, clientId, d.name, d.status, day(d.dueOffset), site()],
        ),
      );
    }
    for (const filename of d.files) {
      const has = await withTenants([tenantId], (c) =>
        c.query(
          `SELECT 1 FROM files WHERE target_entity_type='deliverable' AND target_entity_id=$1 AND filename=$2 AND deleted_at IS NULL`,
          [id, filename],
        ),
      );
      if (has.rows[0]) continue;
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename,
                              content_type, byte_size, storage_key, url, scrubbed, origin_site)
           VALUES ($1,$2,$3,'deliverable',$4,$5,$6,0,NULL,$7,false,$8)`,
          [
            newId(), tenantId, uploader, id, filename,
            filename.endsWith(".pdf") ? "application/pdf"
              : filename.endsWith(".png") ? "image/png"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            `https://files.gaiada.example/demo/${filename}`,
            site(),
          ],
        ),
      );
    }
  }
}

// ── invoices + the payment ledger ──────────────────────────────────────────────────────────────────

interface InvoicePlan {
  /** Identifies the row for idempotency: period_start is the natural key here. */
  startOffset: number;
  endOffset: number;
  status: "sent" | "paid" | "void";
  total: number;
  lines: Array<{ description: string; hours: number; rate: number; amount: number }>;
  /** confirmed = counts toward the balance · pending = "we're verifying" · rejected = "not accepted". */
  payments: Array<{ amount: number; onOffset: number; state: "confirmed" | "pending" | "rejected"; byClient: boolean; reason?: string }>;
}

const line = (description: string, hours: number, rate: number) => ({ description, hours, rate, amount: hours * rate });

const INVOICES: Record<Shape, InvoicePlan[]> = {
  midflight: [
    // Fully settled, months ago — the "Settled" section needs an inhabitant.
    { startOffset: -120, endOffset: -91, status: "paid", total: 33_000_000,
      lines: [line("Discovery & brand direction", 60, 550_000)],
      payments: [{ amount: 33_000_000, onOffset: -85, state: "confirmed", byClient: false }] },
    // OVERDUE and PARTIALLY paid: exercises the danger styling and a non-zero balance at once.
    { startOffset: -60, endOffset: -31, status: "sent", total: 48_400_000,
      lines: [line("Design — 6 templates", 56, 550_000), line("Front-end build", 60, 300_000)],
      payments: [{ amount: 20_000_000, onOffset: -20, state: "confirmed", byClient: false }] },
    // Current, with a payment the CLIENT recorded that finance has not confirmed. This is the state
    // the whole claim/confirm split exists for and it is unreachable without a fixture.
    { startOffset: -30, endOffset: -1, status: "sent", total: 22_500_000,
      lines: [line("Build & content load", 75, 300_000)],
      payments: [{ amount: 10_000_000, onOffset: -2, state: "pending", byClient: true }] },
  ],
  early: [
    { startOffset: -30, endOffset: -1, status: "sent", total: 18_000_000,
      lines: [line("Discovery & requirements", 45, 400_000)], payments: [] },
  ],
  viewonly: [
    { startOffset: -90, endOffset: -61, status: "paid", total: 27_000_000,
      lines: [line("Booking flow specification", 54, 500_000)],
      payments: [{ amount: 27_000_000, onOffset: -55, state: "confirmed", byClient: false }] },
    // A REJECTED payment claim, with a reason. Proves the client is told WHY rather than left guessing.
    { startOffset: -30, endOffset: -1, status: "sent", total: 15_000_000,
      lines: [line("Integration build", 50, 300_000)],
      payments: [{ amount: 15_000_000, onOffset: -6, state: "rejected", byClient: true,
                   reason: "No transfer matching this reference reached our account — please check the reference and re-send." }] },
  ],
  nearlydone: [
    { startOffset: -60, endOffset: -31, status: "paid", total: 36_000_000,
      lines: [line("Microsite design & build", 72, 500_000)],
      payments: [{ amount: 36_000_000, onOffset: -25, state: "confirmed", byClient: true }] },
    { startOffset: -30, endOffset: -1, status: "paid", total: 12_000_000,
      lines: [line("Booking + payment flow", 30, 400_000)],
      payments: [{ amount: 12_000_000, onOffset: -5, state: "confirmed", byClient: true }] },
  ],
  closed: [
    { startOffset: -150, endOffset: -121, status: "paid", total: 24_000_000,
      lines: [line("Booking integration", 60, 400_000)],
      payments: [{ amount: 24_000_000, onOffset: -115, state: "confirmed", byClient: false }] },
    // A VOIDED invoice: the portal must show it as cancelled and offer no payment form.
    { startOffset: -100, endOffset: -71, status: "void", total: 5_000_000,
      lines: [line("Cancelled change request", 10, 500_000)], payments: [] },
  ],
};

async function seedInvoices(
  tenantId: string, clientId: string, shape: Shape, staff: string | null, clientUser: string | null,
): Promise<void> {
  for (const inv of INVOICES[shape]) {
    let id: string;
    const found = await withTenants([tenantId], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM invoices WHERE client_id=$1 AND period_start=$2::date AND deleted_at IS NULL`,
        [clientId, day(inv.startOffset)],
      ),
    );
    if (found.rows[0]) {
      id = found.rows[0].id;
    } else {
      id = newId();
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
           VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10)`,
          [id, tenantId, clientId, day(inv.startOffset), day(inv.endOffset), inv.status, IDR,
           JSON.stringify(inv.lines), inv.total, site()],
        ),
      );
    }
    for (const p of inv.payments) {
      const has = await withTenants([tenantId], (c) =>
        c.query(`SELECT 1 FROM invoice_payments WHERE invoice_id=$1 AND paid_on=$2::date AND amount=$3 AND deleted_at IS NULL`,
          [id, day(p.onOffset), p.amount]),
      );
      if (has.rows[0]) continue;
      // `recorded_by` is the CLIENT for a client-recorded claim and staff otherwise — the two columns
      // exist precisely so "who claimed" and "who verified" cannot collapse into one actor.
      const recordedBy = p.byClient ? clientUser : staff;
      const confirmedBy = p.state === "confirmed" || p.state === "rejected" ? staff : null;
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO invoice_payments
             (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, method, reference,
              status, note, recorded_by, confirmed_by, confirmed_at, rejected_reason, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,'bank_transfer',$8,$9,NULL,$10,$11,$12,$13,$14)`,
          [
            newId(), tenantId, id, clientId, p.amount, IDR, day(p.onOffset),
            `TRX-${String(Math.abs(p.onOffset)).padStart(4, "0")}${p.amount.toString().slice(0, 4)}`,
            p.state, recordedBy, confirmedBy,
            p.state === "pending" ? null : new Date().toISOString(),
            p.reason ?? null, site(),
          ],
        ),
      );
    }
  }
}

// ── contracts + signatures ─────────────────────────────────────────────────────────────────────────

interface ContractPlan {
  title: string;
  reference: string;
  status: "sent" | "signed" | "void";
  value: number;
  startOffset: number;
  endOffset: number;
  /** Which parties have signed. `["provider"]` on a `sent` contract = waiting on the CLIENT, which is
   *  the state the sign form exists for. */
  signed: Array<"provider" | "client">;
  bodyMd: string | null;
  /** Scoped to the project, or null for a master agreement covering the whole relationship. */
  onProject: boolean;
}

const MSA_BODY = `## Master Services Agreement

This agreement governs all work Gaia Digital Agency performs for the Client.

### Engagement
Work is commissioned through individual Statements of Work, each referencing this agreement. Where a
Statement of Work conflicts with these terms, the Statement of Work prevails for that engagement only.

### Fees and invoicing
Fees are invoiced monthly against delivered milestones and payable within 14 days of invoice date.

### Intellectual property
On full payment, all deliverables created specifically for the Client transfer to the Client. Tools,
frameworks and pre-existing components remain the property of the Agency, licensed to the Client
perpetually for use within the delivered work.

### Confidentiality
Each party protects the other's confidential information for three years beyond termination.

### Termination
Either party may terminate on 30 days' written notice. Work delivered up to that date is payable.`;

const SOW_BODY = `## Statement of Work

### Scope
- Discovery workshop and information architecture
- Visual design for the agreed page templates
- Build, content load and SEO migration
- Two rounds of revisions per template

### Assumptions
Content and imagery are supplied by the Client. Delays in supply move the delivery dates by the same
number of working days.

### Change control
Anything outside the scope above is quoted separately and requires written approval before work begins.`;

const CONTRACTS: Record<Shape, ContractPlan[]> = {
  midflight: [
    { title: "Master Services Agreement", reference: "GDA-2026-004", status: "signed", value: 240_000_000,
      startOffset: -100, endOffset: 265, signed: ["provider", "client"], bodyMd: MSA_BODY, onProject: false },
    // THE actionable one: we have countersigned, the client has not. This is the state
    // `/portal/contracts/[id]` renders its sign form for.
    { title: "Statement of Work — brand site", reference: "GDA-2026-014", status: "sent", value: 62_400_000,
      startOffset: -3, endOffset: 120, signed: ["provider"], bodyMd: SOW_BODY, onProject: true },
  ],
  early: [
    // Sent with NO signatures at all — the client signs first here.
    { title: "Statement of Work — e-commerce build", reference: "GDA-2026-019", status: "sent", value: 45_000_000,
      startOffset: -1, endOffset: 180, signed: [], bodyMd: SOW_BODY, onProject: true },
  ],
  viewonly: [
    // Sent and awaiting signature, but this client's ONLY contact is a viewer. The portal must explain
    // that a colleague with signing rights is needed rather than offering a button that 403s.
    { title: "Statement of Work — booking platform", reference: "GDA-2026-021", status: "sent", value: 38_000_000,
      startOffset: -2, endOffset: 150, signed: ["provider"], bodyMd: SOW_BODY, onProject: true },
  ],
  nearlydone: [
    { title: "Master Services Agreement", reference: "SAN-2026-002", status: "signed", value: 90_000_000,
      startOffset: -80, endOffset: 285, signed: ["provider", "client"], bodyMd: MSA_BODY, onProject: false },
  ],
  closed: [
    { title: "Statement of Work — booking integration", reference: "SAN-2026-007", status: "signed", value: 24_000_000,
      startOffset: -160, endOffset: -30, signed: ["provider", "client"], bodyMd: SOW_BODY, onProject: true },
    // Voided: cancelled before it was signed.
    { title: "Change request — loyalty module", reference: "SAN-2026-009", status: "void", value: 12_000_000,
      startOffset: -90, endOffset: 90, signed: [], bodyMd: SOW_BODY, onProject: true },
  ],
};

async function seedContracts(
  tenantId: string, clientId: string, projectId: string, shape: Shape, staff: string | null, clientUser: string | null,
): Promise<void> {
  for (const k of CONTRACTS[shape]) {
    let id: string;
    const found = await withTenants([tenantId], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM contracts WHERE tenant_id=$1 AND reference=$2 AND deleted_at IS NULL`, [tenantId, k.reference]),
    );
    if (found.rows[0]) {
      id = found.rows[0].id;
    } else {
      id = newId();
      const signedAt = k.signed.length === 2 ? new Date().toISOString() : null;
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, reference, version, status,
                                  body_md, value, currency, starts_on, ends_on, sent_at, signed_at, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11::date,$12::date,now(),$13,$14,$15)`,
          [
            id, tenantId, clientId, k.onProject ? projectId : null, k.title, k.reference, k.status,
            k.bodyMd, k.value, IDR, day(k.startOffset), day(k.endOffset), signedAt, staff, site(),
          ],
        ),
      );
    }
    for (const party of k.signed) {
      const has = await withTenants([tenantId], (c) =>
        c.query(`SELECT 1 FROM contract_signatures WHERE contract_id=$1 AND party=$2`, [id, party]),
      );
      if (has.rows[0]) continue;
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer, signer_name, signer_title, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (contract_id, party) DO NOTHING`,
          [
            newId(), tenantId, id, party,
            party === "provider" ? staff : clientUser,
            party === "provider" ? "D. Syrowatka" : "Authorised signatory",
            party === "provider" ? "Director" : null,
            site(),
          ],
        ),
      );
    }
  }
}

// ── entrypoint ─────────────────────────────────────────────────────────────────────────────────────

export async function seedPortalWorkspace(): Promise<void> {
  const missing: string[] = [];
  for (const plan of PLANS) {
    const found = await findClient(plan.client);
    if (!found) {
      // Reported, never invented: creating the client here would make a row with no contacts, no
      // login and no company context, which reads as corrupt data rather than a missing seed step.
      missing.push(plan.client);
      continue;
    }
    const { tenantId, clientId } = found;
    const projects = await findProjects(tenantId, clientId);
    const projectId = projects[0];
    if (!projectId) {
      missing.push(`${plan.client} (no project — run the portal-clients seed first)`);
      continue;
    }
    const staff = await anyStaffUser(tenantId);
    const clientUser = await signerContact(tenantId, clientId);

    // Give the project an owner if it has none: the portal's notifications resolve internal recipients
    // from `projects.owner_id`, so without one a client's payment or signature notifies nobody.
    if (staff) {
      await withTenants([tenantId], (c) =>
        c.query(`UPDATE projects SET owner_id = COALESCE(owner_id, $2), start_date = COALESCE(start_date, $3::date),
                        due_date = COALESCE(due_date, $4::date) WHERE id = $1`,
          [projectId, staff, day(-45), day(30)]),
      );
    }

    await seedMilestonesAndTasks(tenantId, projectId, plan.shape);
    await seedDeliverables(tenantId, projectId, clientId, plan.shape, staff);
    await seedInvoices(tenantId, clientId, plan.shape, staff, clientUser);
    await seedContracts(tenantId, clientId, projectId, plan.shape, staff, clientUser);
    // Everything else the client owns gets a light shape, so a projects list of four does not show
    // three husks at 0% — which is exactly what the first live crawl found.
    for (const other of projects.slice(1)) await seedSecondaryProject(tenantId, other, staff);

    const counts = await withTenants([tenantId], (c) =>
      c.query<{ ms: string; tasks: string; dels: string; invs: string; ctrs: string }>(
        `SELECT (SELECT count(*) FROM pm_milestones WHERE project_id=$1 AND deleted_at IS NULL) AS ms,
                (SELECT count(*) FROM pm_tasks WHERE project_id=$1 AND deleted_at IS NULL) AS tasks,
                (SELECT count(*) FROM deliverables WHERE project_id=$1 AND deleted_at IS NULL) AS dels,
                (SELECT count(*) FROM invoices WHERE client_id=$2 AND deleted_at IS NULL) AS invs,
                (SELECT count(*) FROM contracts WHERE client_id=$2 AND deleted_at IS NULL) AS ctrs`,
        [projectId, clientId],
      ),
    );
    const c0 = counts.rows[0];
    console.log(
      `${plan.client.padEnd(24)} [${plan.shape.padEnd(10)}] ` +
      `milestones ${c0.ms}  tasks ${c0.tasks}  deliverables ${c0.dels}  invoices ${c0.invs}  agreements ${c0.ctrs}`,
    );
  }

  if (missing.length) {
    // Two causes, and the message names both — the first version blamed only the prerequisite and sent
    // the reader to re-run a seed that had already succeeded, when the real cause was this file querying
    // an RLS table with no tenant context (see findClient).
    console.log(`\n! Skipped: ${missing.length} of ${PLANS.length}\n  ${missing.join("\n  ")}`);
    console.log(`  Either the prerequisite seeds have not run, OR a lookup here hit a FORCE-RLS table`);
    console.log(`  without a tenant context (which returns zero rows and looks identical). If the`);
    console.log(`  portal-clients seed just printed those clients, it is the second one.`);
  }
  console.log(`\nStates now reachable in the portal: overdue milestone · overdue invoice · partial payment ·`);
  console.log(`payment awaiting verification · REJECTED payment with a reason · voided invoice · voided agreement ·`);
  console.log(`agreement awaiting the client · agreement nobody has signed · fully signed · view-only cannot sign ·`);
  console.log(`delivered-with-no-file · settled account.`);
}

if (require.main === module) {
  seedPortalWorkspace()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (e) => {
      console.error(e);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
