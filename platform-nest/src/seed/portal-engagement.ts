// CP-21 — the THIRD half of the portal demo seed: the two client-facing surfaces nothing seeds.
//
// `portal-clients.ts` seeds identity + delivery (clients, contacts, logins, projects, runs, gates) and
// `portal-workspace.ts` seeds the dashboard (milestones, deliverables, invoices, payments, agreements).
// Between them, eight of the ten portal tabs have something to show. TWO DO NOT, and both shipped
// after the portal seed was written, so nobody noticed:
//
//   /portal/social-reviews   `social_post_client_reviews` — ZERO rows on the live box, so the tab that
//                            SMM-31/32 added renders "No posts have been sent for your review yet" for
//                            every client. The whole chain above it is empty too (0 accounts, 0 posts,
//                            0 variants), which is why this seed builds five tables to produce one row.
//   /portal/requests         `webdev_change_requests` — ONE row estate-wide, on one client, in one
//                            status. Four of the five statuses were unreachable by a reviewer.
//
// Verified empty by querying the live database on 2026-08-23 at `alpha-01.068.0144a`, not inferred
// from the absence of a seed.
//
// ── WHY A THIRD FILE RATHER THAN MORE OF portal-workspace.ts ──────────────────────────────────────
// Everything here crosses a MODULE boundary that file does not: `social_*` carries 0105's third wall
// (`app_module_allowed('social')`), so every social transaction needs `{ modules: ["social"] }` on top
// of the tenant context. Folding that into portal-workspace would mean one file where some
// `withTenants` calls carry a module scope and some must not — the exact shape that produces a
// silently-zero-row read the next time someone copies a nearby query. Split by wall, not by surface.
//
// ── WHY THE STATES ARE DELIBERATELY UNEVEN ────────────────────────────────────────────────────────
// Same principle as the other two halves — a fixture that only reaches the happy path has not been
// reviewed. Across the five clients this produces: pending, approved, changes-requested (with the
// client's comment) and withdrawn reviews; and new, triaged, in-progress, done and declined (with a
// reason) change requests.
//
// ⚠ ONE THING THIS SEED DOES *NOT* DEMONSTRATE, and the first draft of this file claimed it did.
// Ubud Yoga's only contact is a `viewer`, so its pending review looks like the case proving a
// view-only contact is refused. **It is not.** `approve_post` is deliberately available to EVERY
// active contact regardless of `capability` — a ratified owner decision (SMM-31, addendum D-16,
// 2026-08-12) on the reasoning that "yes, that post reads right" is weaker than recording a payment or
// signing a scope, and that a client OK is a precondition of staff submitting the variant rather than
// a publish in itself. See the `approve_post` block in `cerbos/policies/resource_portal.yaml`.
// Verified live while seeding: `maya@ubudyoga.test`, a viewer, approved this exact row (200 — then
// reset to pending). A viewer IS refused on gates, scope sign-offs and contract signatures
// (`requireSigner` in `portal-scope.ts`), and Ubud's SENT AGREEMENT from the portal-workspace half is
// the row that demonstrates that. Do not "fix" the review path to match — that reverts a decision.
//
// Idempotent like every seed here: create-or-skip keyed on natural names, so re-running enriches
// rather than duplicating. Direct DB writes — no running platform needed.
//
// Run (after seed:agency, the portal-clients half and the portal-workspace half):
//   DATABASE_URL=... node dist/seed/portal-engagement.js
import { newId, withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";

const site = () => config.originSite;

/** The social third wall. EVERY social_* transaction below passes this. Omitting it does not fail the
 *  same way on both halves — an INSERT raises "new row violates row-level security policy", but a
 *  SELECT silently matches zero rows and reports itself as ordinary empty data. See the long note in
 *  `own-brand-social.ts:ensureOwnBrandEngagement`, which is where that lesson was paid for. */
const SOCIAL_MODULE = { modules: ["social"] };

/** Day offset -> timestamp, in UTC so a seeded date means the same thing wherever this runs. */
function ago(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

type ReviewStatus = "pending" | "approved" | "changes_requested" | "withdrawn";

interface ReviewSpec {
  /** instagram | linkedin | tiktok — must be in social_accounts_network_check. */
  network: string;
  postTitle: string;
  body: string;
  status: ReviewStatus;
  /** The client's own words, on `changes_requested` — the field the staff side has to act on. */
  comment?: string;
  /** Days ago the review was asked for. Ordering on the page is `requested_at DESC`. */
  askedDaysAgo: number;
  /** Days ago it was decided. Required for anything not `pending` (spcr_decision_is_complete). */
  decidedDaysAgo?: number;
  /** Attachment count. The detail page renders a COUNT, not the media itself, so placeholder
   *  descriptors are honest here — there is no image to serve and none is claimed. */
  mediaCount: number;
  scheduledInDays?: number;
}

type CrStatus = "new" | "triaged" | "in_progress" | "done" | "declined";

interface ChangeRequestSpec {
  kind: "content" | "design" | "feature" | "bug";
  title: string;
  body: string;
  status: CrStatus;
  /** `wcr_route_matches_status`: route IS NULL exactly when status is `new` or `declined`. This is
   *  asserted in code below rather than left to the constraint, because the constraint failure names
   *  the check and not the row. */
  route: "control_plane" | "mini_run" | "pm_task" | null;
  declinedReason?: string;
  daysAgo: number;
}

interface Plan {
  client: string;
  reviews: ReviewSpec[];
  changeRequests: ChangeRequestSpec[];
}

// Keyed by client NAME, like portal-workspace.ts, so the three seed halves stay independent: adding a
// client to one without the others degrades to "that tab is empty for this client" rather than a crash.
const PLANS: Plan[] = [
  {
    client: "Nusa Coffee Co",
    // Mid-flight: two things waiting, one already settled. This is the client a reviewer opens first.
    reviews: [
      {
        network: "instagram",
        postTitle: "Single-origin launch — carousel",
        body: "New season, new single origin. Our Kintamani lot lands in the roastery this week — notes of red apple, brown sugar and a long, clean finish.\n\nPre-orders open Friday.",
        status: "pending",
        askedDaysAgo: 2,
        mediaCount: 3,
        scheduledInDays: 5,
      },
      {
        network: "linkedin",
        postTitle: "Behind the roast — sourcing story",
        body: "Every bag we ship starts with a two-day drive and a long conversation. Here is how we choose the farms we buy from, and why we pay above the regional average.",
        status: "pending",
        askedDaysAgo: 1,
        mediaCount: 1,
      },
      {
        network: "instagram",
        postTitle: "Weekend opening hours",
        body: "We are open 7am–4pm all weekend. Come say hello.",
        status: "approved",
        askedDaysAgo: 12,
        decidedDaysAgo: 11,
        mediaCount: 1,
      },
    ],
    changeRequests: [
      {
        kind: "content",
        title: "Update the wholesale page copy",
        body: "The minimum order on the wholesale page is out of date — it should read 5kg, not 10kg.",
        status: "new",
        route: null,
        daysAgo: 1,
      },
      {
        kind: "design",
        title: "Menu photos look washed out on mobile",
        body: "On my phone the menu images look much paler than they do on desktop.",
        status: "in_progress",
        route: "mini_run",
        daysAgo: 8,
      },
      {
        kind: "bug",
        title: "Contact form sent no confirmation",
        body: "A customer filled in the contact form and never got the confirmation email.",
        status: "done",
        route: "pm_task",
        daysAgo: 21,
      },
    ],
  },
  {
    client: "Kintamani Roasters",
    // Early: the client has pushed back on a draft. `changes_requested` + a comment is the state the
    // staff side has to be able to see and act on.
    reviews: [
      {
        network: "instagram",
        postTitle: "Harvest teaser — reel",
        body: "Harvest starts next week. Three weeks of very early mornings ahead.",
        status: "changes_requested",
        comment: "Please don't name the estate — we haven't signed with them yet. Happy with everything else.",
        askedDaysAgo: 4,
        decidedDaysAgo: 3,
        mediaCount: 1,
      },
    ],
    changeRequests: [
      {
        kind: "bug",
        title: "Checkout rejects Indonesian phone numbers",
        body: "Numbers starting +62 are refused as invalid at checkout.",
        status: "triaged",
        route: "pm_task",
        daysAgo: 3,
      },
    ],
  },
  {
    client: "Ubud Yoga Collective",
    // VIEW-ONLY on the SIGNING axis only. `maya@ubudyoga.test` is a `viewer`, so she cannot sign the
    // agreement the portal-workspace half sent her — but she CAN decide this post review, by ratified
    // design (see the header). Both halves of that asymmetry are worth having on screen: it is the
    // clearest demonstration that `capability` gates signatures, not participation.
    reviews: [
      {
        network: "instagram",
        postTitle: "Sunrise class — schedule change",
        body: "From Monday, sunrise flow moves to 6:30am. Same teacher, same river, half an hour more sleep.",
        status: "pending",
        askedDaysAgo: 3,
        mediaCount: 2,
        scheduledInDays: 4,
      },
    ],
    changeRequests: [
      {
        kind: "feature",
        title: "Add a waitlist to the booking page",
        body: "When a class is full we would like people to be able to join a waitlist.",
        status: "declined",
        route: null,
        declinedReason: "Out of scope for the current build — captured as a Phase 2 candidate and quoted separately.",
        daysAgo: 14,
      },
    ],
  },
  {
    client: "Bali Wedding Planners",
    // Nearly done: nothing outstanding anywhere. The "you're all caught up" state.
    reviews: [
      {
        network: "instagram",
        postTitle: "Cliffside ceremony — gallery",
        body: "Sarah & Tom, on the cliffs at Uluwatu. Fourteen guests, one very calm celebrant, and the best light we have had all season.",
        status: "approved",
        askedDaysAgo: 9,
        decidedDaysAgo: 8,
        mediaCount: 5,
      },
    ],
    changeRequests: [
      {
        kind: "content",
        title: "Swap the hero image for the new gallery shot",
        body: "The cliffside photo from last week would work better than the current hero.",
        status: "done",
        route: "pm_task",
        daysAgo: 11,
      },
    ],
  },
  {
    client: "Sanur Dive Center",
    // Closed/settled — the archive state. A withdrawn review too: staff pulled a draft back before the
    // client acted, which must read as "no longer needs you" and not as a decision the client made.
    reviews: [
      {
        network: "instagram",
        postTitle: "Dry season visibility report",
        body: "30m visibility on the Sanur reef this morning. Conditions like this hold for about six more weeks.",
        status: "approved",
        askedDaysAgo: 40,
        decidedDaysAgo: 39,
        mediaCount: 2,
      },
      {
        network: "tiktok",
        postTitle: "Night dive promo — draft",
        body: "Night dives, every Thursday.",
        status: "withdrawn",
        askedDaysAgo: 35,
        decidedDaysAgo: 34,
        mediaCount: 1,
      },
    ],
    changeRequests: [
      {
        kind: "feature",
        title: "Show live tank availability per trip",
        body: "Could the booking page show how many spaces are left on each trip?",
        status: "in_progress",
        route: "control_plane",
        daysAgo: 6,
      },
    ],
  },
];

// ── lookups ───────────────────────────────────────────────────────────────────────────────────────

/** Every company. `companies` and `users` are the only two tables here without row security, which is
 *  what makes `withGlobal` legitimate for them and illegitimate for everything else. */
async function allCompanyIds(): Promise<string[]> {
  const r = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC`),
  );
  return r.rows.map((x) => x.id);
}

/** Locate a client by name, tenant by tenant.
 *
 *  ⚠ NOT `withGlobal`. `clients` has FORCE ROW LEVEL SECURITY and this seed runs as a role without
 *  `bypassrls`, so with no `app.current_tenant_ids` GUC the policy matches NOTHING — the read returns
 *  zero rows and the seed reports "run the portal-clients seed first", misdiagnosing its own bug.
 *  That exact wrong turn is documented in portal-workspace.ts:findClient; do not re-take it. */
async function findClient(name: string): Promise<{ tenantId: string; clientId: string } | null> {
  for (const tenantId of await allCompanyIds()) {
    const r = await withTenants([tenantId], (c) =>
      c.query<{ id: string }>(`SELECT id FROM clients WHERE name = $1 AND deleted_at IS NULL LIMIT 1`, [name]),
    );
    if (r.rows[0]) return { tenantId, clientId: r.rows[0].id };
  }
  return null;
}

/** The client's primary project — the one carrying a pipeline run, matching portal-workspace.ts's
 *  definition so change requests land on the SAME project as the milestones and approvals. A change
 *  request filed against a different project of the same client is legal but reads as a husk. */
async function primaryProject(tenantId: string, clientId: string): Promise<string | null> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT p.id
         FROM projects p
        WHERE p.client_id = $1 AND p.deleted_at IS NULL
        ORDER BY EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.project_id = p.id AND r.deleted_at IS NULL) DESC,
                 p.created_at ASC
        LIMIT 1`,
      [clientId],
    ),
  );
  return r.rows[0]?.id ?? null;
}

/** A contact on this client who has an actual account, preferring a signer.
 *
 *  Load-bearing twice over. `webdev_change_requests` has a CHECK (`wcr_portal_has_requester`) that a
 *  `portal`-source row carries both a client and a requester, so a client whose contacts are all
 *  un-provisioned cannot have portal-filed requests seeded at all — which is correct, not a gap.
 *  And a decided review needs a `decided_by` that is a real user, or the row is a decision nobody
 *  made. Preferring the signer means the seeded history attributes decisions to whoever could
 *  legitimately have made them. */
async function contactUser(tenantId: string, clientId: string): Promise<string | null> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ user_id: string }>(
      `SELECT cc.user_id
         FROM client_contacts cc
        WHERE cc.client_id = $1 AND cc.user_id IS NOT NULL AND cc.deleted_at IS NULL
        ORDER BY (cc.capability = 'signer') DESC, cc.created_at ASC
        LIMIT 1`,
      [clientId],
    ),
  );
  return r.rows[0]?.user_id ?? null;
}

/** A staff member of this company, for `triaged_by` and `created_by`. A triaged request with no
 *  triager reads as "the system did it", which is exactly the attribution the ERP exists to avoid.
 *
 *  Two things this query does NOT do, both learned the hard way:
 *   - it does not filter on a `company_id` column, because there isn't one. The tenant column is
 *     `tenant_id`, and since RLS already pins the transaction to that tenant, the right predicate here
 *     is no tenant predicate at all.
 *   - it does not exclude client contacts by a NOT EXISTS against `client_contacts`. `kind` already
 *     distinguishes them (`employee` / `service`), which is both cheaper and the column that means it. */
async function anyStaffUser(tenantId: string): Promise<string | null> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ user_id: string }>(
      `SELECT m.user_id
         FROM company_memberships m
        WHERE m.kind = 'employee' AND m.status = 'active' AND m.deleted_at IS NULL
        ORDER BY m.created_at ASC
        LIMIT 1`,
    ),
  );
  return r.rows[0]?.user_id ?? null;
}

// ── the social chain ──────────────────────────────────────────────────────────────────────────────
//
// Five tables stand between "this client exists" and "this client has a post to review":
//   social_publisher_orgs -> social_accounts -> (social_engagements -> social_posts) -> variants -> review
// All five carry the module wall. All five are create-or-skip.

/** The publisher org an account hangs off.
 *
 *  `api_key_ref` is a REFERENCE, not a key — the column holds a pointer the publish path dereferences
 *  at send time. A seed row therefore names a ref that resolves to nothing, which is the honest state:
 *  these demo accounts can be reviewed against but not published from. Putting a real key here would
 *  make a demo seed a credential holder. */
async function ensurePublisherOrg(tenantId: string, clientId: string): Promise<string> {
  return withTenants([tenantId], async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM social_publisher_orgs WHERE client_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [clientId],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = newId();
    await c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1, $2, $3, 'postiz', $4, 'seed:portal-demo-no-key', 'active', $5)`,
      // The WHOLE client id, not a prefix. `postiz_org_id` is GLOBALLY unique (not per-tenant), and
      // `seed-${clientId.slice(0, 8)}` collided on the third client: these ids are uuid v7, which is
      // time-ordered, so rows created close together share a long leading run. Same trap that broke a
      // test fixture in 0075 — a truncated v7 is not a short unique id, it is a timestamp.
      [id, tenantId, clientId, `seed-${clientId}`, site()],
    );
    return id;
  }, SOCIAL_MODULE);
}

/** The engagement posts hang off. Named per client so it is obvious in the staff UI that this is the
 *  portal demo engagement and not a real retainer. */
async function ensureEngagement(tenantId: string, clientId: string, clientName: string, owner: string | null): Promise<string> {
  return withTenants([tenantId], async (c) => {
    const name = `${clientName} — social retainer`;
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM social_engagements WHERE client_id = $1 AND name = $2 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [clientId, name],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = newId();
    await c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, owner_id, origin_site)
       VALUES ($1, $2, $3, $4, 'active', '{}', $5, $6, $7)`,
      [id, tenantId, clientId, name, config.social.defaultUsageBudgetUsd, owner, site()],
    );
    return id;
  }, SOCIAL_MODULE);
}

/** One connected account per network this client's plan mentions. `status = 'connected'` so the staff
 *  side does not read these as broken connections needing attention. */
async function ensureAccount(
  tenantId: string, clientId: string, publisherOrgId: string, network: string, handle: string,
): Promise<string> {
  return withTenants([tenantId], async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM social_accounts
        WHERE client_id = $1 AND network = $2 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [clientId, network],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = newId();
    await c.query(
      `INSERT INTO social_accounts
         (id, tenant_id, client_id, publisher_org_id, network, handle, display_name, status, connected_at, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'connected', now(), $8)`,
      [id, tenantId, clientId, publisherOrgId, network, handle, handle, site()],
    );
    return id;
  }, SOCIAL_MODULE);
}

/** The post + its single variant + the client review, as one unit.
 *
 *  Keyed on the POST TITLE within the engagement: a variant is meaningless without its post, and
 *  `social_post_client_reviews` has a UNIQUE constraint on `variant_id`, so re-running must not create
 *  a second variant for a title that already has one. Returns whether it inserted. */
async function ensureReview(
  tenantId: string, clientId: string, engagementId: string, accountId: string,
  spec: ReviewSpec, staff: string | null, decider: string | null,
): Promise<boolean> {
  // A decided review needs a decider. Rather than invent one — or write a decision attributed to
  // nobody, which the CHECK would allow for `withdrawn` but not for the other two — downgrade the row
  // to `pending`, and say so. A seed that quietly drops a state is worse than one that visibly
  // substitutes a reachable one.
  let status = spec.status;
  if (status !== "pending" && status !== "withdrawn" && !decider) {
    console.warn(`  ! no contact account to attribute "${spec.postTitle}" to — seeding it as pending instead`);
    status = "pending";
  }

  return withTenants([tenantId], async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM social_posts WHERE engagement_id = $1 AND title = $2 AND deleted_at IS NULL LIMIT 1`,
      [engagementId, spec.postTitle],
    );
    if (existing.rows[0]) return false;

    const postStatus = status === "approved" ? "approved" : status === "pending" ? "in_review" : "draft";
    const variantStatus = status === "approved" ? "approved" : status === "pending" ? "in_review" : "draft";
    const scheduledAt = spec.scheduledInDays === undefined ? null : ago(-spec.scheduledInDays);

    const postId = newId();
    await c.query(
      `INSERT INTO social_posts
         (id, tenant_id, engagement_id, title, brief, source, status, scheduled_at, created_by, origin_site, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'human', $6, $7, $8, $9, $10, $10)`,
      [postId, tenantId, engagementId, spec.postTitle, "Seeded for the client portal demo.",
       postStatus, scheduledAt, staff, site(), ago(spec.askedDaysAgo + 1)],
    );

    // `media` is a descriptor array, not a payload — the portal detail page renders a COUNT of it. A
    // placeholder descriptor with no resolvable URL is the honest shape for a seed: there is no file
    // behind it and none is claimed.
    const media = Array.from({ length: spec.mediaCount }, (_, i) => ({
      kind: "image", ref: `seed:placeholder-${i + 1}`, alt: `Placeholder asset ${i + 1}`,
    }));
    const variantId = newId();
    await c.query(
      `INSERT INTO social_post_variants
         (id, tenant_id, post_id, account_id, body, media, settings, status, scheduled_at, origin_site, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}', $7, $8, $9, $10, $10)`,
      [variantId, tenantId, postId, accountId, spec.body, JSON.stringify(media),
       variantStatus, scheduledAt, site(), ago(spec.askedDaysAgo)],
    );

    // `spcr_decision_is_complete`: pending ⇒ both decision columns NULL; anything else ⇒ decided_at
    // NOT NULL. `withdrawn` keeps `decided_by` NULL on purpose — staff pulled the draft back, so
    // attributing it to the client contact would be a lie about who acted.
    const decidedAt = status === "pending" ? null : ago(spec.decidedDaysAgo ?? Math.max(spec.askedDaysAgo - 1, 0));
    const decidedBy = status === "pending" || status === "withdrawn" ? null : decider;
    await c.query(
      `INSERT INTO social_post_client_reviews
         (id, tenant_id, variant_id, client_id, status, comment, requested_at, decided_by, decided_at, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newId(), tenantId, variantId, clientId, status, spec.comment ?? null,
       ago(spec.askedDaysAgo), decidedBy, decidedAt, site()],
    );
    return true;
  }, SOCIAL_MODULE);
}

// ── change requests ───────────────────────────────────────────────────────────────────────────────

/** One portal-filed change request. No module wall on this table — `webdev_change_requests` is
 *  tenant-isolated only. */
async function ensureChangeRequest(
  tenantId: string, clientId: string, projectId: string | null,
  spec: ChangeRequestSpec, requester: string, staff: string | null,
): Promise<boolean> {
  // Assert the constraint in code so a mistake in PLANS names the row rather than the check.
  const routeExpected = !(spec.status === "new" || spec.status === "declined");
  if (routeExpected !== (spec.route !== null)) {
    throw new Error(`change request "${spec.title}": status ${spec.status} ${routeExpected ? "requires" : "forbids"} a route`);
  }
  return withTenants([tenantId], async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM webdev_change_requests
        WHERE client_id = $1 AND title = $2 AND deleted_at IS NULL LIMIT 1`,
      [clientId, spec.title],
    );
    if (existing.rows[0]) return false;
    const at = ago(spec.daysAgo);
    await c.query(
      `INSERT INTO webdev_change_requests
         (id, tenant_id, client_id, project_id, source, kind, title, body, status, route,
          declined_reason, triaged_by, triaged_at, requested_by, origin_site, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'portal', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
      [newId(), tenantId, clientId, projectId, spec.kind, spec.title, spec.body, spec.status, spec.route,
       spec.declinedReason ?? null,
       // A triaged/in-progress/done/declined row was acted on by SOMEONE; only `new` has not been.
       spec.status === "new" ? null : staff,
       spec.status === "new" ? null : ago(Math.max(spec.daysAgo - 1, 0)),
       requester, site(), at],
    );
    return true;
  });
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let reviews = 0;
  let requests = 0;
  const skipped: string[] = [];

  for (const plan of PLANS) {
    const found = await findClient(plan.client);
    if (!found) {
      skipped.push(`${plan.client} (no clients row — run seed:portal-clients first)`);
      continue;
    }
    const { tenantId, clientId } = found;
    const projectId = await primaryProject(tenantId, clientId);
    const staff = await anyStaffUser(tenantId);
    const contact = await contactUser(tenantId, clientId);
    console.log(`\n${plan.client}`);

    // — social reviews —
    const publisherOrgId = await ensurePublisherOrg(tenantId, clientId);
    const engagementId = await ensureEngagement(tenantId, clientId, plan.client, staff);
    const handleBase = plan.client.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const accounts = new Map<string, string>();
    for (const spec of plan.reviews) {
      let accountId = accounts.get(spec.network);
      if (!accountId) {
        accountId = await ensureAccount(tenantId, clientId, publisherOrgId, spec.network, `@${handleBase}`);
        accounts.set(spec.network, accountId);
      }
      const made = await ensureReview(tenantId, clientId, engagementId, accountId, spec, staff, contact);
      if (made) reviews++;
      console.log(`  ${made ? "+" : "="} review ${spec.status.padEnd(17)} ${spec.network.padEnd(10)} ${spec.postTitle}`);
    }

    // — change requests —
    if (!contact) {
      // `wcr_portal_has_requester` makes this structurally impossible, not merely untidy: a
      // portal-source row must name the contact who filed it.
      skipped.push(`${plan.client} change requests (no contact with an account to file them as)`);
    } else {
      for (const spec of plan.changeRequests) {
        const made = await ensureChangeRequest(tenantId, clientId, projectId, spec, contact, staff);
        if (made) requests++;
        console.log(`  ${made ? "+" : "="} request ${spec.status.padEnd(16)} ${spec.kind.padEnd(10)} ${spec.title}`);
      }
    }
  }

  console.log(`\nSeeded ${reviews} post review(s) and ${requests} change request(s).`);
  if (skipped.length) {
    console.log("\nSkipped:");
    for (const s of skipped) console.log(`  - ${s}`);
  }
  console.log("\nSee it: sign in as a seeded client contact (CREDENTIALS.local.md §4b) and open");
  console.log("  /portal/social-reviews  and  /portal/requests");
  console.log("Start with ayu@nusacoffee.test — two pending reviews and one new request.");
  console.log("maya@ubudyoga.test is a viewer: she CAN decide her post review (ratified, D-16) but");
  console.log("CANNOT sign her agreement — the capability boundary, both sides of it.");
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
