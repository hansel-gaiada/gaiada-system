// Seed the agent workforce into `agent_registry` (P1).
//
// Roster + rationale: docs/superpowers/plans/2026-08-22-hermes-build-inventory.md §2.
// Schema: platform-nest/migrations/202608221745_agent_registry.sql
//
// Follows `seed/automation.ts` exactly, because a seat is the same KIND of thing as an n8n workflow
// account — a non-human principal that needs a real `users` row so authorization, audit and OBO work
// uniformly ([principal-kinds]). `kind: "service"` on the membership is load-bearing: without it these
// take the column default `employee` and every people-shaped surface in the ERP counts fourteen robots
// as colleagues.
//
// ── WHY EVERY SEAT IS SEEDED DISABLED ────────────────────────────────────────────────────────────
// The migration's CHECK refuses `enabled = true` without BOTH an eval suite and an identity. That is
// not an obstacle to work around here — it is the program's enablement gate, and this seed is
// deliberately on the wrong side of it. A seat is enabled by a HUMAN, per seat, after its eval suite
// exists and it has been through shadow mode. Seeding fourteen enabled agents in one command would
// skip every stage of the training ladder at once.
//
// So: this creates the identities and the rows, and turns on NOTHING. `agents.list` will return an
// empty set until someone enables a seat on purpose — which is the correct first state.
//
//   DATABASE_URL=... tsx src/seed/agent-seats.ts [companyName]
import { withGlobal, closePool } from "../db";
import { migrate } from "../db/migrate";
import { createUser, addMembership, linkIdentity } from "../testing/fixtures";

const AGENCY_NAME = "Gaia Digital Agency";

type Kind = "department" | "system" | "security" | "edge" | "external";
type Impact = "read" | "low_write" | "medium_write" | "high_write";

interface SeatSpec {
  name: string;
  kind: Kind;
  /** true = group-scoped (company_scope NULL): serves every company, belongs to none. */
  group?: boolean;
  capabilityTags: string[];
  toolNamespaces: string[];
  maxImpact: Impact;
  modelClass: "cheap-extract" | "general" | "code" | "reasoning" | "vision";
  notes: string;
}

// The roster. `model_class` is a CAPABILITY CLASS, never a model name — and no seat defaults to Opus;
// model choice is a budget decision, not a quality dial.
const SEATS: SeatSpec[] = [
  {
    name: "router", kind: "system", group: true,
    capabilityTags: ["routing", "triage", "synthesis"],
    // Roughly four tools, by design. This IS the demotion: everything else it reaches THROUGH a seat.
    toolNamespaces: ["agents"],
    maxImpact: "read", modelClass: "general",
    notes: "Zedano — the single front door. Routes and synthesises; never executes.",
  },
  {
    name: "dept-pm", kind: "department",
    capabilityTags: ["project", "tasks", "delivery", "status", "blockers"],
    toolNamespaces: ["pm", "tasks", "projects", "approvals", "deliverables"],
    maxImpact: "medium_write", modelClass: "general",
    notes: "Pilot seat — its specialists already exist in ai-agents.",
  },
  {
    name: "dept-webdev", kind: "department",
    capabilityTags: ["website", "deploy", "code", "scope"],
    toolNamespaces: ["webdev", "pipeline", "code", "github", "deploy"],
    maxImpact: "low_write", modelClass: "code",
    notes: "R0 on delphi (staging); production is R2/R3 via the risk ladder.",
  },
  {
    name: "dept-seo", kind: "department",
    capabilityTags: ["seo", "sem", "search", "rankings"],
    toolNamespaces: ["search", "reports"],
    maxImpact: "low_write", modelClass: "general", notes: "",
  },
  {
    name: "dept-smm", kind: "department",
    capabilityTags: ["social", "publishing", "content"],
    toolNamespaces: ["social", "media"],
    maxImpact: "low_write", modelClass: "cheap-extract",
    notes: "Publishing is customer-facing — R1 minimum regardless of ceiling.",
  },
  {
    name: "dept-creative", kind: "department",
    capabilityTags: ["design", "image", "brand"],
    toolNamespaces: ["image", "vision", "design", "media"],
    maxImpact: "low_write", modelClass: "vision", notes: "",
  },
  {
    name: "dept-hr", kind: "department",
    capabilityTags: ["people", "policy", "leave"],
    toolNamespaces: ["hr", "time"],
    // READ despite being one of the biggest wins. HR mistakes are the unrecoverable ones.
    maxImpact: "read", modelClass: "general",
    notes: "Read-only first. Personal data raises the tier by data class regardless.",
  },
  {
    name: "dept-finance", kind: "department",
    capabilityTags: ["money", "invoice", "budget"],
    toolNamespaces: ["money", "rollup"],
    maxImpact: "read", modelClass: "reasoning",
    notes: "Read-only. Money movement is R3 permanently — the human acts.",
  },
  {
    name: "dept-it", kind: "department",
    capabilityTags: ["support", "device", "access"],
    toolNamespaces: ["it", "runbook"],
    maxImpact: "low_write", modelClass: "general",
    notes: "Heaviest expected user of R3 escort mode.",
  },
  {
    name: "dept-legal", kind: "department",
    capabilityTags: ["contract", "compliance"],
    toolNamespaces: ["compliance", "notes"],
    maxImpact: "read", modelClass: "reasoning", notes: "",
  },
  {
    name: "dept-agency", kind: "department",
    capabilityTags: ["client", "account", "onboarding"],
    toolNamespaces: ["agency", "clients", "deliverables"],
    maxImpact: "low_write", modelClass: "general", notes: "",
  },
  {
    name: "sys-ops", kind: "system", group: true,
    capabilityTags: ["deploy", "health", "backup", "incident"],
    toolNamespaces: ["activity", "runbook"],
    maxImpact: "read", modelClass: "general",
    notes: "Read + propose. Every write is D14 by construction.",
  },
  {
    name: "sec-guard", kind: "security", group: true,
    capabilityTags: ["security", "audit", "anomaly"],
    toolNamespaces: ["authz", "activity"],
    // The migration REFUSES anything above read for this name. Belt and braces, on purpose:
    // highest blast radius in the estate, propose-only permanently.
    maxImpact: "read", modelClass: "reasoning",
    notes: "Propose-only, permanently. Its own audit trail is read-only to itself.",
  },
  {
    name: "edge-wa", kind: "edge", group: true,
    capabilityTags: ["whatsapp", "concierge"],
    toolNamespaces: ["knowledge"],
    maxImpact: "read", modelClass: "cheap-extract",
    notes: "Weakest identity floor in the estate (a phone number) — smallest view.",
  },
  {
    name: "pantheon", kind: "external", group: true,
    capabilityTags: [],
    // EMPTY, and the migration enforces it: an external seat holds NO tools. Pantheon proposes;
    // our seats execute. Tools here would be standing privilege on our estate.
    toolNamespaces: [],
    maxImpact: "read", modelClass: "reasoning",
    notes: "The boss's estate. Holds no tools; submits requests through the airlock.",
  },
];

async function findAgencyTenant(): Promise<string | null> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  return rows[0]?.id ?? null;
}

async function seatUserId(email: string): Promise<string | null> {
  const { rows } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]));
  return rows[0]?.id ?? null;
}

/**
 * Idempotent. Re-running re-applies the same seat data rather than duplicating: the two partial
 * unique indexes on (name, company_scope) make ON CONFLICT possible for both the company-scoped and
 * the group-scoped case, which is exactly why the migration created two rather than one.
 */
export async function seedAgentSeats(tenantId: string): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const s of SEATS) {
    const email = `${s.name}@agents.gaiada.local`;
    let userId = await seatUserId(email);
    if (!userId) {
      userId = await createUser(email, s.name, "Agent seat");
      created++;
    }
    // Same posture as an n8n service account — a seat is not staff.
    await addMembership(tenantId, userId, "service");
    // `hermes` is the OBO provider the hub already mints for agent-driven calls; the external id is
    // the seat name, which is what `seat-view.ts` resolves back to a registry row.
    await linkIdentity(userId, "hermes", s.name, true);

    const scope = s.group ? null : tenantId;
    // ⚠ TWO conflict targets, not one. The migration created TWO partial unique indexes precisely
    // because NULL never collides in a plain UNIQUE — and PostgreSQL requires the ON CONFLICT
    // predicate to MATCH the index it should use. A single `ON CONFLICT (name, company_scope)
    // WHERE company_scope IS NOT NULL` cannot match a group-scoped row, so re-running this seed
    // would raise a unique violation on the OTHER index instead of updating. Caught by re-running
    // it against the real schema rather than by reading it.
    const conflict = s.group
      ? "(name) WHERE company_scope IS NULL"
      : "(name, company_scope) WHERE company_scope IS NOT NULL";
    const res = await withGlobal((c) =>
      c.query(
        `INSERT INTO agent_registry
           (name, kind, company_scope, capability_tags, tool_namespaces, max_impact, model_class,
            identity_user_id, eval_suite, enabled, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,false,$9)
         ON CONFLICT ${conflict} DO UPDATE SET
           capability_tags = EXCLUDED.capability_tags,
           tool_namespaces = EXCLUDED.tool_namespaces,
           max_impact      = EXCLUDED.max_impact,
           model_class     = EXCLUDED.model_class,
           identity_user_id= EXCLUDED.identity_user_id,
           notes           = EXCLUDED.notes,
           updated_at      = now()`,
        [s.name, s.kind, scope, s.capabilityTags, s.toolNamespaces, s.maxImpact, s.modelClass, userId, s.notes],
      ),
    );
    if (res.rowCount) updated++;
  }
  return { created, updated };
}

if (require.main === module) {
  (async () => {
    await migrate();
    const tenantId = await findAgencyTenant();
    if (!tenantId) {
      console.error(`agency tenant "${AGENCY_NAME}" not found — run \`npm run seed:agency\` first`);
      process.exit(1);
    }
    const { created, updated } = await seedAgentSeats(tenantId);
    console.log(
      `agent seats: ${created} identities created, ${updated} registry rows written — ALL DISABLED.\n` +
        `Enable one only after its eval suite exists and it has cleared shadow mode:\n` +
        `  UPDATE agent_registry SET eval_suite='evals/<seat>.ts', enabled=true WHERE name='<seat>';`,
    );
    await closePool();
  })();
}
