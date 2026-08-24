// PK-01 follow-up · a Hermes principal must be classified by its identity LINK, not by its email.
//
// ⚠ WHY THIS TEST EXISTS AT ALL. The migration it exercises has already run everywhere it matters,
// so this is not testing "does the data change". It pins the KEY. `zedano@gaiada.com` was first
// fixed by matching its email address, which is the anti-pattern PK-01's own backfill warns about
// one branch above the one that failed ("the email is a seed convention while the link is the
// mechanism"). An email-keyed rule solves exactly one of the fifteen Hermes principals and lets the
// other fourteen arrive silently as staff.
//
// So the assertion that carries the weight is the SECOND one: an account with a `hermes` link and a
// completely unrelated email must still be reclassified. A regression to email matching passes the
// first assertion and fails that one.
//
// ⚠ Runs the migration SQL through `adminPool()`, not the app role — the app role is NOBYPASSRLS and
// has no business running DDL or maintenance UPDATEs. Same reasoning as `resort-rename.db.test.ts`.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createUser } from "../testing/fixtures";

const RECLASSIFY_SQL = readFileSync(
  join(__dirname, "../../migrations/202608241610_hermes_principals_kind_bot.sql"),
  "utf8",
);

/** An agent principal shaped the way the live one is: kind left at the 'employee' default, with a
 *  `hermes` identity link as the only evidence of what it actually is. */
async function seedHermesPrincipal(email: string, name: string): Promise<string> {
  const id = await createUser(email, name, "AI Agent");
  await adminPool().query(`UPDATE users SET kind = 'employee' WHERE id = $1`, [id]);
  await adminPool().query(
    `INSERT INTO identity_links (id, user_id, provider, external_id)
     VALUES (gen_random_uuid(), $1, 'hermes', $2)`,
    [id, email],
  );
  return id;
}

async function kindOf(id: string): Promise<string> {
  const r = await adminPool().query<{ kind: string }>(`SELECT kind FROM users WHERE id = $1`, [id]);
  return r.rows[0].kind;
}

describe.skipIf(!TEST_URL)("PK-01 · Hermes principals are classified by their identity link", () => {
  let orchestrator: string;
  let personaOffPattern: string;
  let realPerson: string;

  beforeAll(async () => {
    await initTestDb();
    orchestrator = await seedHermesPrincipal("zedano@gaiada.com", "Zedano (Hermes agent)");
    // The one that catches an email-keyed regression: a Hermes principal whose address looks
    // nothing like the orchestrator's.
    personaOffPattern = await seedHermesPrincipal("router@hermes.internal", "Router persona");
    // A human with no hermes link, to pin the other direction.
    realPerson = await createUser("edward@gaiada.com", "Edward", "General Manager");
  }, 240_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("reclassifies the orchestrator to bot", async () => {
    expect(await kindOf(orchestrator)).toBe("employee");
    await adminPool().query(RECLASSIFY_SQL);
    expect(await kindOf(orchestrator)).toBe("bot");
  });

  it("🔴 reclassifies a hermes principal whose email matches no pattern", async () => {
    // THE ASSERTION THAT MATTERS. If someone rewrites this rule to key on an email — matching
    // 'zedano@%', '%@gaiada.com', a title of 'AI Agent', anything but the link — this fails while
    // the test above still passes.
    expect(await kindOf(personaOffPattern)).toBe("bot");
  });

  it("🔴 does NOT touch a real employee", async () => {
    // The far worse direction: a rule loose enough to catch people removes them from headcount, and
    // a person missing from a headcount is a bug nobody reports.
    expect(await kindOf(realPerson)).toBe("employee");
  });

  it("is idempotent — a second run changes nothing", async () => {
    await adminPool().query(RECLASSIFY_SQL);
    expect(await kindOf(orchestrator)).toBe("bot");
    expect(await kindOf(personaOffPattern)).toBe("bot");
    expect(await kindOf(realPerson)).toBe("employee");
  });

  it("leaves `automation` principals alone — n8n is a different audit class", async () => {
    // PK-01 splits bot from automation on purpose: a pinned n8n workflow is enumerable in advance, a
    // model-driven agent is not. Collapsing them would undo that, and mcp-hub's impact gate keys on
    // the distinction (PERMISSION-CONTRACT §15).
    const wf = await createUser("wf:reports-weekly-seal@gaiada.com", "wf reports weekly seal");
    await adminPool().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [wf]);
    await adminPool().query(
      `INSERT INTO identity_links (id, user_id, provider, external_id)
       VALUES (gen_random_uuid(), $1, 'n8n', 'wf-reports-weekly-seal')`,
      [wf],
    );
    await adminPool().query(RECLASSIFY_SQL);
    expect(await kindOf(wf)).toBe("automation");
  });
});
