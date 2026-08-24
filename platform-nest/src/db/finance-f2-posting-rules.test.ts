// Finance F2 — POSTING RULES: the seam other departments post through.
//
// Covers migration 202608241027 over F1's ledger.
//
// Business modules emit events in THEIR vocabulary; finance owns the mapping to accounts. The two
// properties that make that safe:
//
//   1. The same business event can never post twice, however many times it is emitted.
//   2. A failed event stays VISIBLE with its reason — it never vanishes. Unposted revenue is the
//      thing nobody notices: the books simply look smaller and everything still reconciles.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withFinance<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'finance', true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("Finance F2 — posting rules (202608241027)", () => {
  let CO: string;
  let actor: string;
  let ruleId: string;

  const emit = async (
    sourceId: string,
    type: string,
    date: string,
    payload: Record<string, unknown>,
    description?: string,
  ) => {
    const id = newId();
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_ledger_events
           (id, tenant_id, event_type, source_event_id, source_module, event_date, payload, description)
         VALUES ($1,$2,$3,$4,'sales',$5::date,$6::jsonb,$7)`,
        [id, CO, type, sourceId, date, JSON.stringify(payload), description ?? null],
      ),
    );
    return id;
  };
  const eventRow = (id: string) =>
    withFinance([CO], async (c) =>
      (
        await c.query<{ status: string; error_code: string | null; error_detail: string | null; attempts: string; journal_entry_id: string | null }>(
          "SELECT status, error_code, error_detail, attempts, journal_entry_id FROM finance_ledger_events WHERE id=$1",
          [id],
        )
      ).rows[0],
    );

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("Rules Co", ["finance"]);
    actor = await createUser("controller@f2.test");
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency)
         VALUES ($1,'IDR','IDR')`,
        [CO],
      ),
    );
    await withFinance([CO], (c) => c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [CO]));
    const fy = newId();
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date)
         VALUES ($1,$2,'FY2026','2026-01-01','2027-01-01')`,
        [fy, CO],
      ),
    );
    await withFinance([CO], (c) => c.query("SELECT finance_generate_periods($1,'monthly')", [fy]));

    // A rule Sales can emit against: cash sale with VAT.
    //   DR bank      gross
    //   CR revenue   net
    //   CR PPN out   tax
    ruleId = newId();
    await withFinance([CO], async (c) => {
      await c.query(
        `INSERT INTO finance_posting_rules
           (id, tenant_id, event_type, name, description, status, activated_at, activated_by, effective_from)
         VALUES ($1,$2,'sales.cash_sale.completed','Cash sale',
                 'Sales emits gross/net/tax; finance decides the accounts.','active',now(),$3,'2026-01-01')`,
        [ruleId, CO, actor],
      );
      await c.query(
        `INSERT INTO finance_posting_rule_lines
           (tenant_id, rule_id, line_no, account_code, side, amount_path, memo_template)
         VALUES
           ($1,$2,1,'1120','debit','gross','Cash sale received'),
           ($1,$2,2,'4100','credit','net','Cash sale revenue'),
           ($1,$2,3,'2140','credit','tax','Output VAT on cash sale')`,
        [CO, ruleId],
      );
    });
  });
  afterAll(teardownTestDb);

  // ── The happy path ─────────────────────────────────────────────────────────────────────────────
  describe("processing an event", () => {
    let ev: string;

    it("maps a business event to the right accounts", async () => {
      ev = await emit("SO-1001", "sales.cash_sale.completed", "2026-02-10",
        { gross: 111000, net: 100000, tax: 11000 }, "Cash sale SO-1001");
      await withFinance([CO], (c) => c.query("SELECT finance_process_event($1,$2)", [ev, actor]));

      const lines = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string; side: string; amount: string }>(
            `SELECT a.code, l.side, l.amount
               FROM finance_ledger_events e
               JOIN finance_journal_lines l ON l.entry_id = e.journal_entry_id
               JOIN finance_accounts a ON a.id = l.account_id
              WHERE e.id = $1 ORDER BY l.line_no`,
            [ev],
          )
        ).rows,
      );
      expect(lines).toEqual([
        { code: "1120", side: "debit", amount: "111000.0000" },
        { code: "4100", side: "credit", amount: "100000.0000" },
        { code: "2140", side: "credit", amount: "11000.0000" },
      ]);
      expect((await eventRow(ev)).status).toBe("posted");
    });

    // The emitting module never learns an account code — that is the whole point of the seam.
    it("the event payload contains no accounting vocabulary at all", async () => {
      const payload = await withFinance([CO], async (c) =>
        (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM finance_ledger_events WHERE id=$1", [ev]))
          .rows[0].payload,
      );
      expect(Object.keys(payload).sort()).toEqual(["gross", "net", "tax"]);
      expect(JSON.stringify(payload)).not.toMatch(/1120|4100|2140|account/i);
    });

    it("is idempotent: reprocessing returns the same journal and posts nothing new", async () => {
      const before = await withFinance([CO], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_journal_entries WHERE tenant_id=$1", [CO])).rows[0].n),
      );
      await withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [ev]));
      const after = await withFinance([CO], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_journal_entries WHERE tenant_id=$1", [CO])).rows[0].n),
      );
      expect(after).toBe(before);
    });

    // Two emissions of the same business event are one event, arbitrated by the unique index.
    it("REFUSES a duplicate source_event_id", async () => {
      await expect(
        emit("SO-1001", "sales.cash_sale.completed", "2026-02-10", { gross: 111000, net: 100000, tax: 11000 }),
      ).rejects.toThrow(/ux_finance_ledger_events_source/);
    });

    // A rule that maps an optional component must stay usable when the event has none.
    it("skips zero lines rather than failing — one rule serves both shapes", async () => {
      const noVat = await emit("SO-1002", "sales.cash_sale.completed", "2026-02-11",
        { gross: 50000, net: 50000, tax: 0 });
      await withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [noVat]));
      const codes = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string }>(
            `SELECT a.code FROM finance_ledger_events e
               JOIN finance_journal_lines l ON l.entry_id = e.journal_entry_id
               JOIN finance_accounts a ON a.id = l.account_id
              WHERE e.id = $1 ORDER BY l.line_no`,
            [noVat],
          )
        ).rows.map((r) => r.code),
      );
      expect(codes).toEqual(["1120", "4100"]); // no VAT line at all
    });
  });

  // ── Failures stay visible ──────────────────────────────────────────────────────────────────────
  describe("failure handling", () => {
    it("records NO_ACTIVE_RULE and keeps the event queued", async () => {
      const orphan = await emit("EV-ORPHAN", "warehouse.stock.counted", "2026-02-12", { qty: 5 });
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [orphan])),
      ).rejects.toThrow(/FINANCE_NO_ACTIVE_RULE/);

      // The raise rolled back the status write, so the sweeper is what makes it durable.
      await withFinance([CO], (c) => c.query("SELECT * FROM finance_process_pending_events($1)", [CO]));
      const row = await eventRow(orphan);
      expect(row.status).toBe("failed");
      expect(row.error_detail).toBeTruthy();
      expect(Number(row.attempts)).toBeGreaterThan(0);
    });

    it("records PAYLOAD_MISSING_PATH when the emitter omits a mapped key", async () => {
      const bad = await emit("SO-BAD-1", "sales.cash_sale.completed", "2026-02-13", { gross: 1000, net: 1000 });
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [bad])),
      ).rejects.toThrow(/FINANCE_PAYLOAD_MISSING_PATH/);
    });

    it("records PAYLOAD_NOT_NUMERIC when a mapped key is not a number", async () => {
      const bad = await emit("SO-BAD-2", "sales.cash_sale.completed", "2026-02-14",
        { gross: "eleven thousand", net: 1000, tax: 0 });
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [bad])),
      ).rejects.toThrow(/FINANCE_PAYLOAD_NOT_NUMERIC/);
    });

    // ★ The property that matters most: a failure is never silently dropped.
    it("★ one bad event does NOT roll back the batch, and its reason SURVIVES", async () => {
      await emit("SO-1003", "sales.cash_sale.completed", "2026-02-15", { gross: 22000, net: 20000, tax: 2000 });
      await emit("SO-BAD-3", "sales.cash_sale.completed", "2026-02-15", { gross: 1000 }); // missing net/tax
      await emit("SO-1004", "sales.cash_sale.completed", "2026-02-16", { gross: 33000, net: 30000, tax: 3000 });

      const res = await withFinance([CO], async (c) =>
        (
          await c.query<{ processed: string; failed: string }>(
            "SELECT * FROM finance_process_pending_events($1,100,$2)",
            [CO, actor],
          )
        ).rows[0],
      );
      expect(Number(res.processed)).toBe(2); // the two good ones posted
      expect(Number(res.failed)).toBeGreaterThanOrEqual(1);

      const bad = await withFinance([CO], async (c) =>
        (
          await c.query<{ status: string; error_detail: string }>(
            "SELECT status, error_detail FROM finance_ledger_events WHERE source_event_id='SO-BAD-3'",
          )
        ).rows[0],
      );
      expect(bad.status).toBe("failed");
      expect(bad.error_detail).toBeTruthy();
    });

    it("surfaces the backlog so a stuck event is findable", async () => {
      const backlog = await withFinance([CO], async (c) =>
        (
          await c.query<{ status: string; event_type: string; count: string }>(
            "SELECT status, event_type, count FROM finance_event_backlog($1)",
            [CO],
          )
        ).rows,
      );
      expect(backlog.length).toBeGreaterThan(0);
      expect(backlog.every((b) => ["pending", "failed"].includes(b.status))).toBe(true);
    });

    it("a fixed event can be reprocessed and posts normally", async () => {
      const bad = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_ledger_events WHERE source_event_id='SO-BAD-3'"))
          .rows[0].id,
      );
      await withFinance([CO], (c) =>
        c.query(
          `UPDATE finance_ledger_events
              SET payload = '{"gross":1000,"net":900,"tax":100}'::jsonb, status='pending'
            WHERE id=$1`,
          [bad],
        ),
      );
      await withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [bad]));
      expect((await eventRow(bad)).status).toBe("posted");
    });
  });

  // ── Rules are accounting policy ────────────────────────────────────────────────────────────────
  describe("rule integrity", () => {
    // Two active rules for one event type would post the same event two ways depending on row order.
    it("REFUSES a second active rule for the same event type", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query(
            `INSERT INTO finance_posting_rules (tenant_id, event_type, name, status, activated_at)
             VALUES ($1,'sales.cash_sale.completed','Duplicate','active',now())`,
            [CO],
          ),
        ),
      ).rejects.toThrow(/ux_finance_posting_rules_active/);
    });

    it("an active rule must record when it was activated", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query(
            `INSERT INTO finance_posting_rules (tenant_id, event_type, name, status)
             VALUES ($1,'sales.other.thing','No timestamp','active')`,
            [CO],
          ),
        ),
      ).rejects.toThrow(/ck_finance_posting_rules_activated/);
    });

    // A stored account id would keep posting silently after a re-code; a code breaks loudly.
    it("fails LOUDLY when a rule names an account the chart no longer has", async () => {
      const r = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_posting_rules (id, tenant_id, event_type, name, status, activated_at, effective_from)
           VALUES ($1,$2,'sales.ghost.completed','Ghost account rule','active',now(),'2026-01-01')`,
          [r, CO],
        );
        await c.query(
          `INSERT INTO finance_posting_rule_lines (tenant_id, rule_id, line_no, account_code, side, amount_path)
           VALUES ($1,$2,1,'9999','debit','amt'), ($1,$2,2,'4100','credit','amt')`,
          [CO, r],
        );
      });
      const ev = await emit("SO-GHOST", "sales.ghost.completed", "2026-02-17", { amt: 500 });
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [ev])),
      ).rejects.toThrow(/FINANCE_UNKNOWN_ACCOUNT/);
    });

    // Every posting still goes through F1's one way in, so F1's guards all still apply.
    it("inherits F1's guards — an unbalanced rule is refused by the ledger", async () => {
      const r = newId();
      await withFinance([CO], async (c) => {
        await c.query(
          `INSERT INTO finance_posting_rules (id, tenant_id, event_type, name, status, activated_at, effective_from)
           VALUES ($1,$2,'sales.lopsided.completed','Lopsided','active',now(),'2026-01-01')`,
          [r, CO],
        );
        await c.query(
          `INSERT INTO finance_posting_rule_lines (tenant_id, rule_id, line_no, account_code, side, amount_path, multiplier)
           VALUES ($1,$2,1,'1120','debit','amt',1), ($1,$2,2,'4100','credit','amt',0.5)`,
          [CO, r],
        );
      });
      const ev = await emit("SO-LOPSIDED", "sales.lopsided.completed", "2026-02-18", { amt: 1000 });
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [ev])),
      ).rejects.toThrow(/FINANCE_UNBALANCED/);
    });

    it("inherits F1's period guard", async () => {
      await withFinance([CO], (c) =>
        c.query("UPDATE finance_fiscal_periods SET state='SOFT_LOCK' WHERE tenant_id=$1 AND period_no=5", [CO]),
      );
      const ev = await emit("SO-LOCKED", "sales.cash_sale.completed", "2026-05-10",
        { gross: 1100, net: 1000, tax: 100 });
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_process_event($1)", [ev])),
      ).rejects.toThrow(/FINANCE_PERIOD_CLOSED/);
    });
  });
});
