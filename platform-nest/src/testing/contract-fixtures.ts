// PV5-06 — fixtures that put a contract straight into a sent/signed state, the way a real send leaves it.
//
// Since PV5-06 a sent contract carries the SHA-256 of what it says, the stamp of when that was fixed, and its
// signature tier, and the database refuses a sent row without them (`contracts_content_fixed_when_sent`). A fixture
// that inserts `status = 'sent'` directly therefore has to carry the REAL hash of the REAL body, computed here with
// the same function the send route uses. It never sets `pre_pv5_legacy` (only the migration may) and never weakens
// the CHECK. Prefer driving `POST /contracts/:id/send` where the test is not about the table.
import type { PoolClient } from "pg";
import { sha256Hex } from "../core/content-hash";
import { newId, withTenants } from "../db";
import { config } from "../config";

/** The terms every direct fixture contract carries. */
export const FIXTURE_TERMS = "Terms.";

/** The hash a fixture contract with `FIXTURE_TERMS` was fixed to (and what a portal sign call must echo). */
export const FIXTURE_TERMS_SHA256 = sha256Hex(FIXTURE_TERMS);

/** Columns that make a contract row "sent, content fixed". Spread into an `insert()` row object. */
export function fixedContentCols(bodyMd: string = FIXTURE_TERMS, tier: "attested" | "certified" = "attested") {
  return { body_md: bodyMd, content_sha256: sha256Hex(bodyMd), content_fixed_at: new Date(), signature_tier: tier };
}

// ── DW-10f-1 (BFF §61.2): payment schedules ────────────────────────────────────────────────────────────────────────
// Since DW-10f a contract with a value above zero moves draft -> sent only when its `contract_instalments` add up to the
// value and the UPDATE stores `schedule_sha256 = contract_schedule_sha256(id, currency, value)` (PD612). A schedule is
// written only while the contract is a draft (PD610). These helpers write it the way the schedule route will.

/** One instalment row for `scheduleContract`. `due` is "on_signing" or a YYYY-MM-DD date; amounts are decimal strings. */
export interface FixtureInstalment {
  label: string;
  amount: string;
  due: "on_signing" | string;
}

/** Write `rows` as a DRAFT contract's schedule (positions 1 to N), in the caller's transaction and tenant context. */
export async function scheduleContract(
  c: PoolClient,
  tenantId: string,
  contractId: string,
  rows: FixtureInstalment[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, r] of rows.entries()) {
    const id = newId();
    await c.query(
      `INSERT INTO contract_instalments (id, tenant_id, contract_id, position, label, amount, due_kind, due_on)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8::date)`,
      [id, tenantId, contractId, i + 1, r.label, r.amount,
       r.due === "on_signing" ? "on_signing" : "date", r.due === "on_signing" ? null : r.due],
    );
    ids.push(id);
  }
  return ids;
}

/** The suites' one-row schedule: a draft contract's whole value, "Payment on signing" (the "all on signing" preset).
 *  A contract with no value, or a zero value, gets none (it carries no schedule). Returns the row ids. */
export async function addOneRowSchedule(tenantId: string, contractId: string): Promise<string[]> {
  return withTenants([tenantId], async (c) => {
    const k = await c.query<{ value: string | null }>(`SELECT value::text AS value FROM contracts WHERE id = $1`, [contractId]);
    const value = k.rows[0]?.value ?? null;
    if (value === null || !(Number(value) > 0)) return [];
    return scheduleContract(c, tenantId, contractId, [{ label: "Payment on signing", amount: value, due: "on_signing" }]);
  });
}

/** A contract put straight into `sent` the way a real send leaves it: inserted as a draft, its schedule written, then
 *  moved to `sent` with the content columns AND the schedule hash, so the send trigger checks it exactly as it checks the
 *  route. `cols` adds or overrides contract columns (e.g. `project_id`, `kind`, `amends_id`, `reference`). */
export async function insertSentContractWithSchedule(
  c: PoolClient,
  o: {
    tenantId: string;
    clientId: string;
    value: string | null;
    currency?: string;
    instalments: FixtureInstalment[];
    bodyMd?: string;
    cols?: Record<string, unknown>;
  },
): Promise<{ contractId: string; instalmentIds: string[] }> {
  const id = newId();
  const bodyMd = o.bodyMd ?? FIXTURE_TERMS;
  const row: Record<string, unknown> = {
    id, tenant_id: o.tenantId, client_id: o.clientId, title: "Fixture agreement", status: "draft", body_md: bodyMd,
    value: o.value, currency: o.currency ?? "IDR", origin_site: config.originSite, ...(o.cols ?? {}),
  };
  const names = Object.keys(row);
  await c.query(
    `INSERT INTO contracts (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    names.map((n) => row[n]),
  );
  const instalmentIds = await scheduleContract(c, o.tenantId, id, o.instalments);
  await c.query(
    `UPDATE contracts
        SET status = 'sent', sent_at = now(), content_sha256 = $2, content_fixed_at = now(), signature_tier = 'attested',
            schedule_sha256 = contract_schedule_sha256(id, currency, value), updated_at = now()
      WHERE id = $1`,
    [id, sha256Hex(bodyMd)],
  );
  return { contractId: id, instalmentIds };
}
