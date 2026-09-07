// AD-6b — proves the delegation resolver against REAL Postgres: a seeded `positions` +
// `position_assignments` seat is actually what `convertAgencyLead` assigns `sitemap`/`integrations`/
// `dns` tasks to, a vacant/missing seat actually falls back to the lead owner (flagged as such), and
// a role with neither a seat holder nor an owner actually shows up in the response as `unresolved`
// rather than a silently missing task. `agency-lead-convert.test.ts` covers the pure decision logic
// with fabricated position data; this file is the one place that proves the REAL `positions` table
// round-trips through `loadPositionCandidates` correctly and that the whole spawn transaction still
// commits atomically around it.
//
// A FRESH COMPANY PER TEST, deliberately: `positions`/`agency_leads` resolution is TENANT-WIDE (no
// per-project scoping — see agency-delegation-resolver.ts's own header on that real schema limit), so
// sharing one company across `it` blocks would let an earlier test's seeded seat silently answer a
// later test's assertion (e.g. a "vacant PM seat" test would resolve to a DIFFERENT test's already-
// filled "PM" seat instead). One company per test removes that cross-test coupling entirely.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";
import { convertAgencyLead } from "./agency-lead-convert.service";

describe.skipIf(!TEST_URL)("AD-6b — agency lead convert resolves real position seats, DB-verified", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 60000);

  afterAll(async () => {
    await teardownTestDb();
  });

  let seq = 0;
  async function newTenant(): Promise<{ co: string; actor: string; owner: string }> {
    seq += 1;
    const co = await createCompany(`Gaiada Delegation Test ${seq}`);
    const actor = await createUser(`actor-${seq}@delegation-resolver.test`);
    const owner = await createUser(`owner-${seq}@delegation-resolver.test`);
    await addMembership(co, actor);
    await addMembership(co, owner);
    return { co, actor, owner };
  }

  async function newLead(co: string, ownerId: string | null): Promise<{ id: string; orgName: string }> {
    const orgName = `Delegation Org ${++seq}`;
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, owner_id, origin_site)
         VALUES ($1, $2, $3, 'Prospect Contact', $4, '+62-811-000-000', 'invite', 'submitted', $5, 'test')`,
        [id, co, orgName, `${id}@prospect.test`, ownerId],
      ),
    );
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO agency_discovery_submissions
           (id, tenant_id, lead_id, schema_version, answers, meta, answered_count, required_answered, required_total, origin_site)
         VALUES ($1, $2, $3, 'v1', $4, '{}'::jsonb, 3, 3, 3, 'test')`,
        [newId(), co, id, JSON.stringify({ pages_required: ["Home", "About"], integrations: ["Stripe"], dns_owner: "Registrar X" })],
      ),
    );
    return { id, orgName };
  }

  async function createPosition(co: string, unitNodeId: string, title: string, isLead: boolean): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO positions (id, tenant_id, unit_node_id, title, is_lead, status, origin_site) VALUES ($1,$2,$3,$4,$5,'active','test')`,
        [id, co, unitNodeId, title, isLead],
      ),
    );
    return id;
  }

  async function assignPosition(co: string, positionId: string, userId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, origin_site) VALUES ($1,$2,$3,$4,'test')`,
        [newId(), co, positionId, userId],
      ),
    );
  }

  async function tasksTitled(co: string, projectId: string, titlePrefix: string): Promise<{ title: string; description: string; assignee: { refId: string } }[]> {
    const { rows } = await withTenants([co], (c) =>
      c.query<{ title: string; description: string; assignee: { refId: string } }>(
        `SELECT title, description, assignee FROM pm_tasks WHERE tenant_id = $1 AND project_id = $2 AND title ILIKE $3`,
        [co, projectId, `${titlePrefix}%`],
      ),
    );
    return rows;
  }

  it("assigns 'sitemap' to the current PM seat holder and 'integrations'/'dns' to the current Tech Lead seat holder — real positions, real position_assignments, one real transaction", async () => {
    const { co, actor, owner } = await newTenant();
    const pmUser = await createUser(`pm-holder-${seq}@delegation-resolver.test`);
    const techLeadUser = await createUser(`tech-lead-holder-${seq}@delegation-resolver.test`);
    await addMembership(co, pmUser);
    await addMembership(co, techLeadUser);
    const pmPosition = await createPosition(co, "d-webdev", "Project Manager", false);
    await assignPosition(co, pmPosition, pmUser);
    const techLeadPosition = await createPosition(co, "d-webdev", "Tech Lead · Head of Web Dev", true);
    await assignPosition(co, techLeadPosition, techLeadUser);

    const lead = await newLead(co, owner);
    const result = await convertAgencyLead({ tenantId: co, leadId: lead.id, actorUserId: actor, delegations: [] });
    if (result.outcome !== "converted") throw new Error(`expected converted, got ${result.outcome}`);

    const sitemap = result.delegations.find((d) => d.role === "sitemap");
    expect(sitemap).toMatchObject({ assigneeId: pmUser, source: "position", positionTitle: "Project Manager" });

    const integrations = result.delegations.find((d) => d.role === "integrations");
    expect(integrations).toMatchObject({ assigneeId: techLeadUser, source: "position" });

    const dns = result.delegations.find((d) => d.role === "dns");
    expect(dns).toMatchObject({ assigneeId: techLeadUser, source: "position" });

    // The AM-default roles are untouched by any of this — still the lead's owner, source "owner".
    const review = result.delegations.find((d) => d.role === "discovery_review");
    expect(review).toMatchObject({ assigneeId: owner, source: "owner" });

    // And the pm_tasks rows really were created with that assignee — not just reported as if they were.
    const rows = await tasksTitled(co, result.projectId, "Produce sitemap");
    expect(rows[0]?.assignee?.refId).toBe(pmUser);
  });

  it("falls back to the lead owner (flagged 'owner_fallback', never plain 'owner') when the matching seat is VACANT — and the seeded task's own description says so", async () => {
    const { co, actor, owner } = await newTenant();
    // A "Project Manager" seat exists in this tenant but nobody holds it (0109 §3.3's vacancy shape).
    await createPosition(co, "d-webdev-2", "Project Manager", false);

    const lead = await newLead(co, owner);
    const result = await convertAgencyLead({ tenantId: co, leadId: lead.id, actorUserId: actor, delegations: [] });
    if (result.outcome !== "converted") throw new Error(`expected converted, got ${result.outcome}`);

    const sitemap = result.delegations.find((d) => d.role === "sitemap");
    expect(sitemap).toMatchObject({ assigneeId: owner, source: "owner_fallback" });

    const rows = await tasksTitled(co, result.projectId, "Produce sitemap");
    expect(rows[0]?.description).toContain("FALLBACK");
  });

  it("resolves nothing for a role whose title pattern matches NOTHING in this tenant's org chart at all (no position row of any kind) — also an owner_fallback, same as vacant", async () => {
    const { co, actor, owner } = await newTenant();
    // No positions table rows at all for this tenant.
    const lead = await newLead(co, owner);
    const result = await convertAgencyLead({ tenantId: co, leadId: lead.id, actorUserId: actor, delegations: [] });
    if (result.outcome !== "converted") throw new Error(`expected converted, got ${result.outcome}`);

    const dns = result.delegations.find((d) => d.role === "dns");
    expect(dns).toMatchObject({ assigneeId: owner, source: "owner_fallback" });
  });

  it("reports a role as 'unresolved' — no task created, assigneeId null, a reason given — when the lead has no owner and no seat holder resolves", async () => {
    const { co, actor } = await newTenant();
    const lead = await newLead(co, null); // no owner_id at all, and no positions seeded for this tenant
    const result = await convertAgencyLead({ tenantId: co, leadId: lead.id, actorUserId: actor, delegations: [] });
    if (result.outcome !== "converted") throw new Error(`expected converted, got ${result.outcome}`);

    for (const role of ["discovery_review", "sitemap", "integrations", "dns"]) {
      const entry = result.delegations.find((d) => d.role === role);
      expect(entry, role).toMatchObject({ assigneeId: null, source: "unresolved" });
      expect(entry?.reason, role).toBeTruthy();
    }

    const rows = await tasksTitled(co, result.projectId, "Review discovery");
    expect(rows.length).toBe(0); // no task exists for an unresolved role
  });

  it("a STALE position holder (no longer active staff) is skipped past, not fatal — the convert still succeeds and falls back to the owner", async () => {
    const { co, actor, owner } = await newTenant();
    const departedUser = await createUser(`departed-pm-${seq}@delegation-resolver.test`);
    // Deliberately NOT added as a company_membership — this user holds the seat but is not (or is no
    // longer) staff in this tenant, exactly the "stale seat holder" case the resolver must survive
    // (the ticket's security backstop: a resolver returning a non-staff user must never be USED).
    const stalePmPosition = await createPosition(co, "d-webdev", "Project Manager", false);
    await assignPosition(co, stalePmPosition, departedUser);

    const lead = await newLead(co, owner);
    const result = await convertAgencyLead({ tenantId: co, leadId: lead.id, actorUserId: actor, delegations: [] });
    if (result.outcome !== "converted") throw new Error(`expected converted, got ${result.outcome}`);

    const sitemap = result.delegations.find((d) => d.role === "sitemap");
    expect(sitemap?.assigneeId).not.toBe(departedUser);
    expect(sitemap).toMatchObject({ assigneeId: owner, source: "owner_fallback" });
  });

  it("a caller-supplied assigneeId that is not active staff is a fatal 400 for the WHOLE convert — never silently skipped, never a fallback", async () => {
    const { co, actor, owner } = await newTenant();
    const lead = await newLead(co, owner);
    await expect(
      convertAgencyLead({
        tenantId: co,
        leadId: lead.id,
        actorUserId: actor,
        delegations: [{ role: "sitemap", assigneeId: newId() }], // a uuid that is nobody
      }),
    ).rejects.toThrow(/must be an active staff member/);

    // And the lead was NOT converted — the whole transaction rolled back.
    const { rows } = await withTenants([co], (c) =>
      c.query<{ status: string }>(`SELECT status FROM agency_leads WHERE id = $1`, [lead.id]),
    );
    expect(rows[0]?.status).toBe("submitted");
  });
});
