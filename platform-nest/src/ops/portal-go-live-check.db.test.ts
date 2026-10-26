// PGL-01 — the portal go-live readiness check against real Postgres + RLS (skips silently without DATABASE_URL_TEST: check the
// skip count; runs on the Linux CI gate). The unit tests (portal-go-live-check.test.ts) judge each rule on constructed facts; this file
// proves the part they cannot: that the SQL reads what it claims, through the NOSUPERUSER app role and its tenant context.
//
// WHAT IS PROVEN
//   1. A clean estate (a merchant company with a real-looking billing profile, clearing account and matching seal certificate; a
//      holding company with no clients; client contacts of kind `client`) exits 0 with no BLOCK, WARN or ERROR.
//   2. TEETH: each bad state is seeded and seen as BLOCK (or WARN), and removing it returns the line to PASS:
//      placeholders.p03 (an active portal@*.test contact), placeholders.p04 (a staff signer; a staff viewer is WARN),
//      billing.mock (each of the five rules), seal.mock (DEV MOCK, a mismatched subject, only an expired certificate),
//      payments.keys (no clearing account; a company with no profile), plus the environment lines.
//   3. THE RLS TRAP: with the tenant setting deliberately unset (or set to another company) the app role reads ZERO rows of the
//      very data the check must find, and the run is exit 2 with every database line ERROR, never PASS. The same data is found
//      when the setting is right: the zero is the trap, not the data.
//   4. Strictly read-only: the run opens a READ ONLY transaction, a write inside it is refused by Postgres, and no row count
//      moves across a run.
//   5. data.simulated counts the simulated payments, signatures and distinct MFA sessions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createClient, createCompany, createUser } from "../testing/fixtures";
import { newId, withTenants } from "../db";
import { config } from "../config";
import {
  renderText, runReadinessCheck, withReadOnlyTx, type CheckResult, type EnvSnapshot, type ReadinessReport,
} from "./portal-go-live-check";

describe.skipIf(!TEST_URL)("PGL-01 · portal go-live readiness check (real Postgres + RLS)", () => {
  let merchant: string;   // owns the merchant account: billing profile, clearing account, seal certificate
  let holding: string;    // a company with no clients at all
  let clientA: string;
  let clientB: string;
  let realContactUser: string;
  let env: EnvSnapshot;

  const sql = async (text: string, params: unknown[] = []) => (await adminPool().query(text, params)).rows;
  const site = () => config.originSite;

  const cleanEnv = (tenantId: string): EnvSnapshot => ({
    mfaSimulationEnabled: false, signatureSimulationEnabled: false,
    payments: { simulationEnabled: false, environment: "production", serverKeySet: true, serverKeyClass: "other", tenantId },
    mail: { enabled: true, transport: "relay", host: "smtp.mailer-fake.net", from: "Studio <hello@studio-fake.net>", clientMailEnabled: true, conversationClientMailEnabled: false },
  });

  const run = (e: EnvSnapshot = env) => runReadinessCheck({ env: e });
  const line = (r: ReadinessReport, id: string): CheckResult => {
    const c = r.checks.find((x) => x.id === id);
    if (!c) throw new Error(`no check ${id}`);
    return c;
  };

  async function addUser(email: string, kind: "employee" | "client" | "automation" | "bot"): Promise<string> {
    const id = await createUser(email);
    await sql(`UPDATE users SET kind = $1 WHERE id = $2`, [kind, id]);
    return id;
  }
  async function addContact(tenant: string, client: string, user: string, capability: "signer" | "viewer" | "admin", status = "active"): Promise<string> {
    const id = newId();
    await sql(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, activated_at, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'active' THEN now() END, $7)`,
      [id, tenant, client, user, capability, status, site()],
    );
    return id;
  }
  async function addSeal(tenant: string, subject: string, fromOffset = "-1 day", toOffset = "1 year"): Promise<string> {
    const id = newId();
    await sql(
      `INSERT INTO company_seal_certificates (id, tenant_id, serial, subject, fingerprint_sha256, valid_from, valid_to, certificate_pem)
       VALUES ($1, $2, $3, $4, $5, now() + $6::interval, now() + $7::interval, $8)`,
      [id, tenant, randomUUID().replace(/-/g, "").slice(0, 16), subject, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
       fromOffset, toOffset, "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----"],
    );
    return id;
  }
  async function setBilling(tenant: string, set: string, params: unknown[] = []): Promise<void> {
    await sql(`UPDATE company_billing_profiles SET ${set} WHERE tenant_id = $1`, [tenant, ...params]);
  }

  beforeAll(async () => {
    await initTestDb();
    merchant = await createCompany("Merchant Studio");
    holding = await createCompany("Holding Group");
    clientA = await createClient(merchant, "Client Alpha");
    clientB = await createClient(merchant, "Client Beta");
    realContactUser = await addUser("contact@client-alpha-fake.com", "client");
    await addContact(merchant, clientA, realContactUser, "signer");
    await sql(
      `INSERT INTO company_billing_profiles (tenant_id, legal_name, address, invoice_prefix, bank_name, bank_account_name, bank_account_no, gateway_clearing_account_code)
       VALUES ($1, 'Merchant Studio Ltd', '1 Fake Street', 'MSL', 'Fake Bank', 'Merchant Studio Ltd', '1234567890', '1130')`,
      [merchant],
    );
    await addSeal(merchant, "Merchant Studio Ltd");
    env = cleanEnv(merchant);
  });
  afterAll(teardownTestDb);

  it("a clean estate exits 0: no BLOCK, WARN or ERROR; the MANUAL lines remain; the run says it was read-only", async () => {
    const r = await run();
    expect(r.checks.filter((c) => c.status === "BLOCK" || c.status === "ERROR" || c.status === "WARN"), JSON.stringify(r.checks)).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.readOnly).toBe(true);
    expect(r.companies).toBe(2);
    for (const id of ["billing.mock", "seal.mock", "placeholders.p03", "placeholders.p04", "payments.keys"]) expect(line(r, id).status, id).toBe("PASS");
    expect(line(r, "mfa.real").status).toBe("MANUAL");
    expect(line(r, "data.simulated").status).toBe("INFO");
    expect(r.counts.MANUAL).toBe(4); // mfa.real, legal.gate1, mail.deliverability, contrast.manual
    // the text form: one line per check
    expect(renderText(r).split("\n").filter((l) => /^(PASS|BLOCK|WARN|INFO|MANUAL|ERROR)\s/.test(l))).toHaveLength(r.checks.length);
  });

  describe("teeth: each bad state is seen as BLOCK, and clearing it returns the line to PASS", () => {
    it("placeholders.p03: an active portal@*.test contact BLOCKs and names the client; a revoked one does not", async () => {
      const u = await addUser("portal@alpha-fake.test", "client");
      const revoked = await addContact(merchant, clientB, u, "viewer", "revoked");
      expect(line(await run(), "placeholders.p03").status).toBe("PASS");
      const active = await addContact(merchant, clientA, u, "signer");
      const r = await run();
      const p03 = line(r, "placeholders.p03");
      expect(p03.status).toBe("BLOCK");
      expect(p03.evidence).toContain("Client Alpha");
      expect(r.exitCode).toBe(1);
      expect(line(r, "placeholders.p04").status).toBe("PASS"); // kind client
      await sql(`DELETE FROM client_contacts WHERE id = ANY($1::uuid[])`, [[active, revoked]]);
      expect(line(await run(), "placeholders.p03").status).toBe("PASS");
    });

    it("placeholders.p04: a staff signer contact BLOCKs, a staff viewer contact is WARN, a revoked one is nothing", async () => {
      const staff = await addUser("owner@staff-fake.com", "employee");
      const viewer = await addContact(merchant, clientA, staff, "viewer");
      let r = await run();
      expect(line(r, "placeholders.p04").status).toBe("WARN");
      expect(r.exitCode).toBe(0);
      const signer = await addContact(merchant, clientB, staff, "signer");
      r = await run();
      const p04 = line(r, "placeholders.p04");
      expect(p04.status).toBe("BLOCK");
      expect(p04.evidence).toContain("owner@staff-fake.com");
      expect(p04.evidence).toContain("users.kind employee");
      expect(r.exitCode).toBe(1);
      await sql(`UPDATE client_contacts SET status = 'revoked' WHERE id = ANY($1::uuid[])`, [[viewer, signer]]);
      expect(line(await run(), "placeholders.p04").status).toBe("PASS");
      await sql(`DELETE FROM client_contacts WHERE id = ANY($1::uuid[])`, [[viewer, signer]]);
    });

    it("placeholders.p04 also catches an automation or bot user holding a signer contact, and an admin contact (admin signs too)", async () => {
      const bot = await addUser("agent@bot-fake.com", "bot");
      const c = await addContact(merchant, clientA, bot, "signer");
      const p04 = line(await run(), "placeholders.p04");
      expect(p04.status).toBe("BLOCK");
      expect(p04.evidence).toContain("users.kind bot");
      await sql(`DELETE FROM client_contacts WHERE id = $1`, [c]);
      const auto = await addUser("flow@automation-fake.com", "automation");
      const a = await addContact(merchant, clientB, auto, "admin");
      const p04b = line(await run(), "placeholders.p04");
      expect(p04b.status).toBe("BLOCK");
      expect(p04b.evidence).toContain("users.kind automation");
      await sql(`DELETE FROM client_contacts WHERE id = $1`, [a]);
      expect(line(await run(), "placeholders.p04").status).toBe("PASS");
    });

    it.each([
      ["legal name", `legal_name = 'Merchant Studio (DEV MOCK)'`, "DEV MOCK"],
      ["bank", `bank_name = 'MOCK BANK'`, "MOCK BANK"],
      ["account", `bank_account_no = '0000000000'`, "all zeros"],
      ["prefix", `invoice_prefix = 'MSL-DEV'`, "-DEV"],
      ["seed data", `address = 'Example address (seed data, not a real address)'`, "seed data"],
    ])("billing.mock: a mock %s BLOCKs", async (_n, set, text) => {
      const before = (await sql(`SELECT legal_name, invoice_prefix, bank_name, bank_account_no, address FROM company_billing_profiles WHERE tenant_id = $1`, [merchant]))[0];
      await setBilling(merchant, set);
      try {
        const r = await run();
        const b = line(r, "billing.mock");
        expect(b.status).toBe("BLOCK");
        expect(b.evidence).toContain("Merchant Studio");
        expect(b.evidence).toContain(text);
        expect(b.evidence).not.toContain("0000000000");
        expect(r.exitCode).toBe(1);
      } finally {
        await setBilling(merchant, `legal_name = $2, invoice_prefix = $3, bank_name = $4, bank_account_no = $5, address = $6`,
          [before.legal_name, before.invoice_prefix, before.bank_name, before.bank_account_no, before.address]);
      }
      expect(line(await run(), "billing.mock").status).toBe("PASS");
    });

    it("seal.mock: a DEV MOCK subject BLOCKs; a subject that does not match the legal name BLOCKs", async () => {
      const mock = await addSeal(merchant, "Merchant Studio Ltd (DEV MOCK)");
      let s = line(await run(), "seal.mock");
      expect(s.status).toBe("BLOCK");
      expect(s.evidence).toContain("DEV MOCK");
      await sql(`DELETE FROM company_seal_certificates WHERE id = $1`, [mock]);
      const wrong = await addSeal(merchant, "Another Legal Entity");
      s = line(await run(), "seal.mock");
      expect(s.status).toBe("BLOCK");
      expect(s.evidence).toContain("does not match");
      await sql(`DELETE FROM company_seal_certificates WHERE id = $1`, [wrong]);
      expect(line(await run(), "seal.mock").status).toBe("PASS");
    });

    it("seal.mock: an EXPIRED mock certificate is not active and is ignored; no active certificate at all BLOCKs", async () => {
      const old = await addSeal(merchant, "Old Mock (DEV MOCK)", "-3 years", "-1 year");
      expect(line(await run(), "seal.mock").status).toBe("PASS");
      const real = (await sql(`SELECT id FROM company_seal_certificates WHERE tenant_id = $1 AND subject = 'Merchant Studio Ltd'`, [merchant]))[0].id;
      await sql(`UPDATE company_seal_certificates SET valid_to = now() - interval '1 hour', valid_from = now() - interval '2 years' WHERE id = $1`, [real]);
      const none = line(await run(), "seal.mock");
      expect(none.status).toBe("BLOCK");
      expect(none.evidence).toContain("no active seal certificate");
      await sql(`UPDATE company_seal_certificates SET valid_from = now() - interval '1 day', valid_to = now() + interval '1 year' WHERE id = $1`, [real]);
      await sql(`DELETE FROM company_seal_certificates WHERE id = $1`, [old]);
      expect(line(await run(), "seal.mock").status).toBe("PASS");
    });

    it("payments.keys: a missing clearing account BLOCKs; a merchant company with no billing profile BLOCKs", async () => {
      await setBilling(merchant, `gateway_clearing_account_code = NULL`);
      let k = line(await run(), "payments.keys");
      expect(k.status).toBe("BLOCK");
      expect(k.evidence).toContain("no clearing account");
      await setBilling(merchant, `gateway_clearing_account_code = '1130'`);
      expect(line(await run(), "payments.keys").status).toBe("PASS");
      k = line(await run(cleanEnv(holding)), "payments.keys"); // the holding company has no billing profile
      expect(k.status).toBe("BLOCK");
      expect(k.evidence).toContain("no billing profile");
      k = line(await run(cleanEnv(randomUUID())), "payments.keys");
      expect(k.status).toBe("BLOCK");
      expect(k.evidence).toContain("not a live company");
    });

    it("the environment lines BLOCK on the review-stage settings, with the database lines still PASS", async () => {
      const bad: EnvSnapshot = {
        ...cleanEnv(merchant), mfaSimulationEnabled: true, signatureSimulationEnabled: true,
        payments: { simulationEnabled: true, environment: "simulated", serverKeySet: true, serverKeyClass: "SIM-", tenantId: merchant },
        mail: { enabled: false, transport: "relay", host: "mailpit", from: "no-reply@notify.gaiada.invalid", clientMailEnabled: false, conversationClientMailEnabled: false },
      };
      const r = await run(bad);
      for (const id of ["mfa.simulation", "payments.simulation", "payments.keys", "signatures.simulation", "mail.sender", "mail.client"]) {
        expect(line(r, id).status, id).toBe("BLOCK");
      }
      expect(line(r, "billing.mock").status).toBe("PASS");
      expect(r.exitCode).toBe(1);
    });
  });

  describe("the RLS zero-row trap (plan finding 8)", () => {
    let trapContact: string;
    beforeAll(async () => {
      const u = await addUser("portal@trap-fake.test", "client");
      trapContact = await addContact(merchant, clientA, u, "signer");
    });
    afterAll(async () => { await sql(`DELETE FROM client_contacts WHERE id = $1`, [trapContact]); });

    it("with the tenant setting unset the app role reads ZERO rows of data that exists (so a naive check would PASS)", async () => {
      expect(Number((await sql(`SELECT count(*)::int AS n FROM client_contacts`))[0].n)).toBeGreaterThan(0); // superuser: the rows exist
      const seen = await withReadOnlyTx(async (c) => ({
        contacts: Number((await c.query(`SELECT count(*)::int AS n FROM client_contacts`)).rows[0].n),
        profiles: Number((await c.query(`SELECT count(*)::int AS n FROM company_billing_profiles`)).rows[0].n),
        certs: Number((await c.query(`SELECT count(*)::int AS n FROM company_seal_certificates`)).rows[0].n),
      }));
      expect(seen).toEqual({ contacts: 0, profiles: 0, certs: 0 });
    });

    it("the same data is FOUND when the setting is right: the placeholder is a BLOCK", async () => {
      expect(line(await run(), "placeholders.p03").status).toBe("BLOCK");
    });

    it("run with the tenant setting deliberately UNSET: every database line is ERROR, none is PASS, exit code 2", async () => {
      const r = await runReadinessCheck({ env, setTenant: async () => undefined });
      expect(r.exitCode).toBe(2);
      expect(r.verdict).toBe("INCOMPLETE");
      for (const id of ["billing.mock", "seal.mock", "placeholders.p03", "placeholders.p04", "data.simulated", "payments.keys"]) {
        const c = line(r, id);
        expect(c.status, `${id}: ${c.evidence}`).toBe("ERROR");
        expect(c.evidence).toContain("positive control FAILED");
        expect(c.evidence).toContain("tenant setting is unset");
      }
      expect(r.checks.filter((c) => c.status === "PASS").map((c) => c.id)).not.toContain("placeholders.p03");
      expect(renderText(r)).toContain("exit 2");
    });

    it("run with the tenant setting pointing at ANOTHER company is also exit 2 (the control reads the setting back)", async () => {
      const r = await runReadinessCheck({
        env,
        setTenant: async (c, id) => {
          const other = id === merchant ? holding : merchant;
          await c.query("SELECT set_config('app.current_tenant_ids', $1, true)", [other]);
        },
      });
      expect(r.exitCode).toBe(2);
      expect(line(r, "placeholders.p03").evidence).toContain("holds a different company id");
    });
  });

  describe("strictly read-only", () => {
    it("the run's transaction is READ ONLY and Postgres refuses a write inside it", async () => {
      await withReadOnlyTx(async (c) => {
        expect((await c.query(`SHOW transaction_read_only`)).rows[0].transaction_read_only).toBe("on");
        await c.query("SELECT set_config('app.current_tenant_ids', $1, true)", [merchant]);
        await expect(
          c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1, $2, 'Should Not Exist', $3)`, [newId(), merchant, site()]),
        ).rejects.toThrow(/read-only transaction/);
      });
      expect(Number((await sql(`SELECT count(*)::int AS n FROM clients WHERE name = 'Should Not Exist'`))[0].n)).toBe(0);
    });

    it("a full run changes no row count anywhere it reads, and leaves no open transaction behind", async () => {
      const counts = async () => (await sql(
        `SELECT (SELECT count(*) FROM activities) AS a, (SELECT count(*) FROM users) AS u, (SELECT count(*) FROM clients) AS c,
                (SELECT count(*) FROM client_contacts) AS cc, (SELECT count(*) FROM company_billing_profiles) AS bp,
                (SELECT count(*) FROM company_seal_certificates) AS sc, (SELECT count(*) FROM outbox_events) AS o`,
      ))[0];
      const before = await counts();
      await run();
      await runReadinessCheck({ env, setTenant: async () => undefined });
      expect(await counts()).toEqual(before);
      const idle = await sql(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`);
      expect(Number(idle[0].n)).toBe(0);
    });
  });

  describe("data.simulated", () => {
    it("counts simulated checkouts (and paid ones), simulated PSrE signatures and DISTINCT simulated MFA sessions", async () => {
      const invoice = randomUUID();
      const contract = randomUUID();
      const admin = await adminPool().connect();
      try {
        // Triggers and FKs are bypassed for this seeding connection only: a real simulated payment needs a whole invoice and
        // contract chain, and this suite is about what the check COUNTS, not how those rows are made.
        await admin.query("SET session_replication_role = replica");
        for (const [status, n] of [["paid", 2], ["open", 1]] as const) {
          for (let i = 0; i < n; i++) {
            await admin.query(
              `INSERT INTO payment_checkouts (id, tenant_id, invoice_id, client_id, amount, currency_code, provider, provider_checkout_id, checkout_url, status, expires_at, environment)
               VALUES ($1, $2, $3, $4, 100, 'IDR', 'midtrans', $5, 'https://sim.fake/x', $6, now() + interval '1 day', 'simulated')`,
              [newId(), merchant, status === "open" ? randomUUID() : invoice, clientA, randomUUID(), status],
            );
          }
        }
        // one REAL-environment checkout must NOT be counted
        await admin.query(
          `INSERT INTO payment_checkouts (id, tenant_id, invoice_id, client_id, amount, currency_code, provider, provider_checkout_id, checkout_url, status, expires_at, environment)
           VALUES ($1, $2, $3, $4, 100, 'IDR', 'midtrans', $5, 'https://pay.fake/x', 'paid', now() + interval '1 day', 'production')`,
          [newId(), merchant, randomUUID(), clientA, randomUUID()],
        );
        await admin.query(
          `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer_name, signed_at, origin_site, provider, provider_envelope_id)
           VALUES ($1, $2, $3, 'client', 'Fake Signer', now(), $4, 'simulated', 'env-1')`,
          [newId(), merchant, contract, site()],
        );
        await admin.query(
          `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer_name, signed_at, origin_site)
           VALUES ($1, $2, $3, 'provider', 'Typed Signer', now(), $4)`,
          [newId(), merchant, contract, site()],
        );
        // the same step-up is audited once per company the person is staff of: two rows, ONE session
        for (const t of [merchant, holding]) {
          await admin.query(
            `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
             VALUES ($1, $2, $3, 'auth.step_up_simulated', 'user', $3, '{"session":"abc123def456"}', $4)`,
            [newId(), t, realContactUser, site()],
          );
        }
        await admin.query(
          `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
           VALUES ($1, $2, $3, 'auth.step_up_simulated', 'user', $3, '{"session":"zzz999"}', $4)`,
          [newId(), merchant, realContactUser, site()],
        );
      } finally {
        await admin.query("RESET session_replication_role");
        admin.release();
      }
      const d = line(await run(), "data.simulated");
      expect(d.status).toBe("INFO");
      expect(d.evidence).toContain("3 payment checkout(s) (2 paid)");
      expect(d.evidence).toContain("1 contract signature(s)");
      expect(d.evidence).toContain("2 simulated MFA step-up(s)");
      // the withTenants helper reads the same rows through the app role: nothing here is invisible to it
      const viaApp = await withTenants([merchant], (c) => c.query(`SELECT count(*)::int AS n FROM activities WHERE verb = 'auth.step_up_simulated'`));
      expect(Number(viaApp.rows[0].n)).toBe(2);
    });
  });
});
