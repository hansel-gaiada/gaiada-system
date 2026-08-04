// Portal demo seed — clients across SEVERAL COMPANIES, attached to projects, each with a working
// login and something actually waiting for them in the portal.
//
// Why this exists: the client portal could be authorized end to end but there was nothing to look at.
// One client, on one company, with runs that carried no client_id (WD-30). This seeds the shape the
// real thing has — a holding whose member companies each serve their own clients — so the portal can
// be exercised as several different people and the tenant boundary can be SEEN rather than asserted.
//
// What one run of this produces, per client:
//   clients row (on that client's own company)  ->  project (client_id set)
//   client_contacts: one `signer`, one `viewer` (the viewer proves capability actually restricts)
//   a Keycloak account per contact, password set, emailVerified -> they can log in immediately
//   the global `client` role granted at that company, or the portal denies everything
//   a pipeline_run per project WITH client_id + project_id  ->  stages with real artifacts
//   a PENDING client gate on some runs, so "N things need you" is a real state, not a mock
//
// THIS IS HALF THE PORTAL SEED. It seeds IDENTITY + DELIVERY (clients, contacts, logins, projects,
// runs, gates) — which was the whole portal when the portal was the runs page. The CP-2..CP-5 client
// dashboard added six more surfaces, and `seed/portal-workspace.ts` seeds those (milestones,
// deliverables, invoices, payments, agreements) on top of THESE five clients. Run this one FIRST;
// the other resolves the clients by the same names it finds here.
//
// Idempotent, following seed/agency.ts: every step is create-or-skip, so re-running enriches rather
// than duplicating. Direct DB writes plus the Keycloak Admin API — no running platform needed.
//
// Run (on a host that can reach Postgres AND Keycloak):
//   DATABASE_URL=... npm run seed:portal-clients
//
// Keycloak is OPTIONAL and fail-soft: without KEYCLOAK_ADMIN_CLIENT_SECRET the rows are still seeded
// and each contact is left `invited` with a printed invite path, which is exactly the real flow. It
// does not pretend to have provisioned an account it could not create.
import { newId, withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { createUser as kcCreateUser, findUserByEmail as kcFindUser, setPassword as kcSetPassword, keycloakAdminConfigured } from "../core/keycloak-admin";
import { createInvite } from "../core/client-invites";

const site = () => config.originSite;

// One shared password for every seeded contact, so trying five clients does not mean tracking five
// secrets. Overridable, and PRINTED at the end rather than assumed — a seed that quietly sets a
// credential you cannot discover is useless for the thing this seed is for.
const PASSWORD = process.env.SEED_PORTAL_PASSWORD || "PortalDemo!2026";

interface Spec {
  /** Company that SERVES this client. Must already exist (seed:agency creates them). */
  company: string;
  client: string;
  clientEmail: string;
  project: string;
  /** Contacts: [email, name, capability]. A viewer alongside a signer on purpose — see below. */
  contacts: [string, string, "signer" | "viewer"][];
  run: { title: string; status: string; pendingGate: "prd_sign" | "scope_signoff" | "customer_feedback" | null };
}

// Deliberately spread across companies AND deliberately uneven: one client with two contacts, one
// whose only contact is a viewer (so "nobody here can sign" is a state you can see), one with nothing
// pending (so "Nothing needed from you right now" is exercised too). Even fixtures should not be
// uniformly happy — a portal that only ever shows one state has not been reviewed.
const SPECS: Spec[] = [
  {
    company: "Gaia Digital Agency",
    client: "Nusa Coffee Co",
    clientEmail: "hello@nusacoffee.test",
    project: "Nusa Coffee — brand site",
    contacts: [
      ["ayu@nusacoffee.test", "Ayu Pratama", "signer"],
      ["budi@nusacoffee.test", "Budi Santoso", "viewer"],
    ],
    run: { title: "Nusa Coffee — brand site kickoff", status: "scope_pending", pendingGate: "scope_signoff" },
  },
  {
    company: "Gaia Digital Agency",
    client: "Kintamani Roasters",
    clientEmail: "hello@kintamani.test",
    project: "Kintamani — e-commerce build",
    contacts: [["sari@kintamani.test", "Sari Dewi", "signer"]],
    run: { title: "Kintamani — e-commerce discovery", status: "delivery_active", pendingGate: "prd_sign" },
  },
  {
    company: "Gaia Digital Agency",
    client: "Ubud Yoga Collective",
    clientEmail: "hello@ubudyoga.test",
    project: "Ubud Yoga — booking platform",
    // Only a viewer: this client CANNOT sign anything. The portal should say so rather than offer a
    // button that 403s, and the staff side should warn that no contact can complete a sign-off.
    contacts: [["maya@ubudyoga.test", "Maya Wijaya", "viewer"]],
    run: { title: "Ubud Yoga — booking platform", status: "delivery_active", pendingGate: null },
  },
  {
    company: "Sanur Resort",
    client: "Bali Wedding Planners",
    clientEmail: "hello@baliweddings.test",
    project: "Wedding microsite + booking flow",
    contacts: [["putu@baliweddings.test", "Putu Ariani", "signer"]],
    run: { title: "Wedding microsite — scope", status: "scope_pending", pendingGate: "scope_signoff" },
  },
  {
    company: "Sanur Resort",
    client: "Sanur Dive Center",
    clientEmail: "hello@sanurdive.test",
    project: "Dive Center — booking integration",
    contacts: [
      ["komang@sanurdive.test", "Komang Suardika", "signer"],
      ["wayan@sanurdive.test", "Wayan Adi", "viewer"],
    ],
    run: { title: "Dive Center — booking integration", status: "complete", pendingGate: null },
  },
];

const PRD = `# PRD — {{title}}

## Goal
Ship a fast, accessible site that turns visitors into bookings.

## In scope
- Responsive marketing pages
- Booking/enquiry flow with email confirmation
- Basic analytics + consent banner

## Out of scope
- Native mobile apps
- Multi-language content (phase 2)

## Acceptance
- Largest Contentful Paint under 2.5s on 4G
- All forms keyboard-navigable and screen-reader labelled`;

const SCOPE = `# Scope Agreement — {{title}}

**Deliverables:** design system, {{pages}} pages, booking flow, analytics wiring.
**Timeline:** 6 weeks from signature.
**Change control:** anything outside the deliverables above is quoted separately before work starts.

Both parties sign below.`;

async function companyId(name: string): Promise<string | null> {
  const r = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [name]),
  );
  return r.rows[0]?.id ?? null;
}

async function ensureClient(tenantId: string, name: string, email: string): Promise<string> {
  const f = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(`SELECT id FROM clients WHERE tenant_id=$1 AND name=$2 AND deleted_at IS NULL`, [tenantId, name]),
  );
  if (f.rows[0]) return f.rows[0].id;
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, contact, origin_site) VALUES ($1,$2,$3,$4,$5)`,
      [id, tenantId, name, JSON.stringify({ email }), site()]),
  );
  return id;
}

async function ensureProject(tenantId: string, name: string, clientId: string): Promise<string> {
  const f = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(`SELECT id FROM projects WHERE tenant_id=$1 AND name=$2 AND deleted_at IS NULL`, [tenantId, name]),
  );
  if (f.rows[0]) {
    // Re-assert the client link: an existing project seeded before this ran may have none, and the
    // whole point is that the portal can resolve project -> client.
    await withTenants([tenantId], (c) =>
      c.query(`UPDATE projects SET client_id = COALESCE(client_id, $2) WHERE id = $1`, [f.rows[0].id, clientId]));
    return f.rows[0].id;
  }
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO projects (id, tenant_id, name, client_id, status, origin_site) VALUES ($1,$2,$3,$4,'active',$5)`,
      [id, tenantId, name, clientId, site()]),
  );
  return id;
}

async function ensureUser(email: string, name: string): Promise<string> {
  const f = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [email]));
  if (f.rows[0]) return f.rows[0].id;
  const id = newId();
  await withGlobal((c) =>
    c.query(`INSERT INTO users (id, email, name, title, origin_site) VALUES ($1,$2,$3,$4,$5)`,
      [id, email, name, "Client contact", site()]),
  );
  return id;
}

/** Grant the global `client` role at this company. Without it the contact has a tenant but no role,
 *  and every portal action is denied — the same trap the accept route documents. */
async function grantClientRole(userId: string, tenantId: string): Promise<boolean> {
  return withGlobal(async (c) => {
    const role = await c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name = 'client'`);
    if (!role.rows[0]) return false; // seeded by migration 0072; absent means migrations are behind
    await c.query(
      `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id)
       VALUES ($1,$2,$3,'company',$4) ON CONFLICT DO NOTHING`,
      [newId(), userId, role.rows[0].id, tenantId],
    );
    return true;
  });
}

async function ensureContact(
  tenantId: string,
  clientId: string,
  userId: string,
  capability: "signer" | "viewer",
  active: boolean,
): Promise<string> {
  const f = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM client_contacts WHERE tenant_id=$1 AND client_id=$2 AND user_id=$3 AND deleted_at IS NULL`,
      [tenantId, clientId, userId],
    ),
  );
  const status = active ? "active" : "invited";
  if (f.rows[0]) {
    await withTenants([tenantId], (c) =>
      c.query(`UPDATE client_contacts SET capability=$2, status=$3, activated_at=CASE WHEN $3='active' THEN COALESCE(activated_at, now()) ELSE activated_at END, updated_at=now() WHERE id=$1`,
        [f.rows[0].id, capability, status]));
    return f.rows[0].id;
  }
  const id = newId();
  // project_id NULL = client-wide (D-1). Client-wide on purpose: these contacts should see every run
  // for their client, which is what makes the tenant/client boundary visible when comparing logins.
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, invited_at, activated_at, origin_site)
       VALUES ($1,$2,$3,$4,NULL,$5,$6, now(), CASE WHEN $6='active' THEN now() ELSE NULL END, $7)`,
      [id, tenantId, clientId, userId, capability, status, site()],
    ),
  );
  return id;
}

/** Create (or find) the Keycloak account and set the shared password. Returns whether it worked. */
async function provisionKeycloak(email: string): Promise<boolean> {
  try {
    const existing = await kcFindUser(email);
    const kcId = existing ? existing.id : await kcCreateUser({ email, password: PASSWORD });
    // createUser already sets the password; setting it again is what makes an EXISTING account
    // (from a previous run, or a real earlier invite) usable with the documented seed password.
    if (existing) await kcSetPassword(kcId, PASSWORD);
    return true;
  } catch (e) {
    console.warn(`  ! Keycloak provisioning failed for ${email}: ${(e as Error).message}`);
    return false;
  }
}

async function ensureRun(tenantId: string, spec: Spec, clientId: string, projectId: string): Promise<string> {
  const f = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(`SELECT id FROM pipeline_runs WHERE tenant_id=$1 AND title=$2 AND deleted_at IS NULL`, [tenantId, spec.run.title]),
  );
  if (f.rows[0]) {
    // Re-assert the links WD-30 is about — an existing run from an earlier seed may predate them.
    await withTenants([tenantId], (c) =>
      c.query(`UPDATE pipeline_runs SET client_id=COALESCE(client_id,$2), project_id=COALESCE(project_id,$3), updated_at=now() WHERE id=$1`,
        [f.rows[0].id, clientId, projectId]));
    return f.rows[0].id;
  }
  const runId = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [runId, tenantId, spec.run.title, spec.run.status, clientId, projectId, site()],
    ),
  );
  const prd = PRD.replace(/\{\{title\}\}/g, spec.project);
  const scope = SCOPE.replace(/\{\{title\}\}/g, spec.project).replace(/\{\{pages\}\}/g, "8");
  const stages: [string, string, string, string | null][] = [
    ["delivery", "prd_extract", "done", prd],
    ["scope", "scope_extract", "done", scope],
    // The report track is internal-only and must NEVER reach the portal. Seeded precisely so that
    // "the client cannot see this" is testable rather than assumed.
    ["report", "report_extract", "done", "# Internal report\n\nMargin + effort notes. NOT client-visible."],
  ];
  for (const [track, name, status, artifact] of stages) {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, artifact_ref, confidence, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId(), tenantId, runId, track, name, status, artifact, 0.9, site()],
      ),
    );
  }
  if (spec.run.pendingGate) {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, origin_site)
         VALUES ($1,$2,$3,$4,'client','pending',$5)`,
        [newId(), tenantId, runId, spec.run.pendingGate, site()],
      ),
    );
  }
  // A provider-side scope signature already in place on the scope runs, so the client's own signature
  // is the LAST one needed and "complete: true" is reachable from the portal in one click.
  if (spec.run.pendingGate === "scope_signoff") {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO scope_signoffs (id, tenant_id, run_id, party, signer_name, signed_at, origin_site)
         VALUES ($1,$2,$3,'provider','Gaiada Delivery', now(), $4) ON CONFLICT DO NOTHING`,
        [newId(), tenantId, runId, site()],
      ),
    );
  }
  return runId;
}

export async function seedPortalClients(): Promise<void> {
  const kc = keycloakAdminConfigured();
  console.log(`Keycloak admin ${kc ? "CONFIGURED — accounts will be provisioned" : "NOT configured — contacts stay `invited`, invite links printed"}`);

  const logins: string[] = [];
  const pending: string[] = [];
  const missingCompanies: string[] = [];

  for (const spec of SPECS) {
    const tenantId = await companyId(spec.company);
    if (!tenantId) {
      // Reported, not invented: creating a company here would produce a member company with no org
      // structure, people or modules, which looks like corrupt data rather than a missing seed step.
      missingCompanies.push(spec.company);
      continue;
    }
    const clientId = await ensureClient(tenantId, spec.client, spec.clientEmail);
    const projectId = await ensureProject(tenantId, spec.project, clientId);
    const runId = await ensureRun(tenantId, spec, clientId, projectId);
    console.log(`\n${spec.company} / ${spec.client}`);
    console.log(`  project ${projectId}  run ${runId}${spec.run.pendingGate ? `  (pending ${spec.run.pendingGate})` : ""}`);

    for (const [email, name, capability] of spec.contacts) {
      const userId = await ensureUser(email, name);
      const provisioned = kc ? await provisionKeycloak(email) : false;
      const contactId = await ensureContact(tenantId, clientId, userId, capability, provisioned);
      const roleOk = await grantClientRole(userId, tenantId);
      if (!roleOk) console.warn("  ! global `client` role missing — run migrations (0072 seeds it)");

      if (provisioned) {
        console.log(`  ✓ ${email.padEnd(30)} ${capability.padEnd(6)} — can log in now`);
        logins.push(`${email}  (${capability}, ${spec.client} @ ${spec.company})`);
      } else {
        // No Keycloak: fall back to the REAL flow rather than a fake active contact. The invite is
        // single-use and the link is the only place the raw token ever exists.
        const inv = await createInvite({ tenantId, clientContactId: contactId, email, invitedBy: null }).catch((e) => {
          // Most likely INTEGRATION_TOKEN_KEY is unset — it signs the token. Reported, not swallowed:
          // a seed that prints no link and no reason leaves you with a contact you cannot activate.
          console.warn(`  ! invite could not be minted for ${email}: ${(e as Error).message}`);
          return null;
        });
        if (inv) pending.push(`${email} -> /invite/${inv.token}`);
      }
    }
  }

  if (missingCompanies.length) {
    console.log(`\n! Skipped, company not found (run seed:agency first): ${[...new Set(missingCompanies)].join(", ")}`);
  }
  if (logins.length) {
    console.log(`\n=== Portal logins (password: ${PASSWORD}) ===`);
    for (const l of logins) console.log(`  ${l}`);
    console.log(`\nSign in at /login -> "Sign in with SSO", then open /portal.`);
    console.log(`Each contact is client-wide, so they see every run for THEIR client and nothing else.`);
  }
  if (pending.length) {
    console.log(`\n=== Invites awaiting acceptance (single-use, 72h) ===`);
    for (const p of pending) console.log(`  ${p}`);
  }
}

if (require.main === module) {
  seedPortalClients()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (e) => {
      console.error(e);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
