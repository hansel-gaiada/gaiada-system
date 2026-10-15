// Chart of accounts WRITES (DW-7g-2, FRONTEND-BFF-CONTRACT §49): add, rename, archive, restore.
//
// The read (`GET :tenantId/finance/accounts`) lives in finance.controller.ts. This file adds routes over rules that
// already exist in the database (202608241011): codes unique among live rows, the freeze trigger on a posted account,
// and `finance_post_journal` refusing an account whose status is not `active`. No migration, no new Cerbos kind.
//
// ── AUTHORIZATION FIRST ─────────────────────────────────────────────────────────────────────────
// Every handler calls `authorize` on `finance_config` (`create` for an add, `update` for the rest) BEFORE it reads the
// body, so a refused caller learns nothing about the validation shape (a 400 would tell them which fields exist).
//
// ── withFinance() IS THE ONLY DATABASE PATH ─────────────────────────────────────────────────────
// Same reason as finance.controller.ts: finance_* tables are module walled, and a plain withTenants() reads and writes
// zero rows without an error. The activity row goes through `writeActivity` (the `activities` table is core, not walled).
import {
  BadRequestException, Body, ConflictException, Controller, HttpCode, NotFoundException, Param, Patch, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { DatabaseError } from "pg";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";

/** The ONLY way this file reaches the database. See the header. */
function withFinance<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["finance"] });
}

const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];
const CODE_PATTERN = /^[A-Za-z0-9.-]{1,20}$/;
const EDITABLE = ["name", "description", "newCode", "parentCode"];
const NOT_EDITABLE = ["accountType", "normalBalance", "isControl", "controlSubledger", "allowManualPosting", "isPostable", "currencyCode", "status", "code"];

const defaultNormalBalance = (t: AccountType): "debit" | "credit" => (t === "asset" || t === "expense" ? "debit" : "credit");

interface AccountRow {
  id: string; code: string; name: string; parent_id: string | null; account_type: AccountType; normal_balance: string;
  is_postable: boolean; is_control: boolean; status: string; first_posted_at: string | null;
}
interface ParentRow { id: string; code: string; account_type: AccountType; is_postable: boolean; status: string }

function bad(message: string, field: string): BadRequestException {
  return new BadRequestException({ message, field });
}

/** A body that is not an object is a 400, never a TypeError at the first property read. */
function bodyObject(b: unknown): Record<string, unknown> {
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw new BadRequestException("send a JSON object");
  return b as Record<string, unknown>;
}

function codeField(v: unknown, field: string): string {
  const code = typeof v === "string" ? v.trim() : "";
  if (!CODE_PATTERN.test(code)) throw bad(`${field} must be 1-20 characters: letters, digits, '.' or '-'`, field);
  return code;
}

function nameField(v: unknown): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (!name || name.length > 120) throw bad("name is required (1-120 characters)", "name");
  return name;
}

/** `undefined` = not sent; `null` = clear it. */
function descriptionField(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw bad("description must be text", "description");
  const d = v.trim();
  if (d.length > 500) throw bad("description is at most 500 characters", "description");
  return d || null;
}

/** `undefined` = not sent; `null` = no parent (a top-level account). */
function parentField(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && v.trim() === "")) return null;
  return codeField(v, "parentCode");
}

/** The database's own refusal of a re-code or re-type of a posted account, as 409 `account_frozen` with its hint. */
function frozenFrom(e: unknown): ConflictException | null {
  if (!(e instanceof DatabaseError)) return null;
  const m = /^FINANCE_ACCOUNT_FROZEN:\s*(.*)$/s.exec(e.message ?? "");
  if (!m) return null;
  const hint = typeof e.hint === "string" && e.hint ? e.hint : "Archive this account and create a new one; re-coding rewrites history.";
  return new ConflictException({
    message: `${m[1].trim()}. ${hint}`,
    reason: "account_frozen",
    hint,
  });
}

/** Another request took the code between our check and the insert (the partial unique index decides). */
function codeTakenFrom(e: unknown, code: string): ConflictException | null {
  if (!(e instanceof DatabaseError) || e.code !== "23505") return null;
  if (!/ux_finance_accounts_code_live/.test(e.constraint ?? e.message ?? "")) return null;
  return codeTaken(code);
}
function codeTaken(code: string): ConflictException {
  return new ConflictException({ message: `account code ${code} is already used by a live account in this company`, reason: "code_taken" });
}

/** Serialises chart writes per company, so two clicks at once cannot both pass a uniqueness or cycle check. */
async function lockChart(c: PoolClient, tenantId: string): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('finance_accounts:' || $1::text))`, [tenantId]);
}

async function liveAccount(c: PoolClient, tenantId: string, code: string): Promise<AccountRow> {
  const r = await c.query<AccountRow>(
    `SELECT id, code, name, parent_id, account_type, normal_balance, is_postable, is_control, status,
            first_posted_at::text AS first_posted_at
       FROM finance_accounts
      WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [tenantId, code],
  );
  if (!r.rows[0]) throw new NotFoundException(`no live account ${code} in this company's chart`);
  return r.rows[0];
}

/** §49.2: a live, active HEADER of the same type; anything else is a 400 on `parentCode`. */
async function resolveParent(c: PoolClient, tenantId: string, parentCode: string, type: AccountType): Promise<ParentRow> {
  const r = await c.query<ParentRow>(
    `SELECT id, code, account_type, is_postable, status
       FROM finance_accounts WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL`,
    [tenantId, parentCode],
  );
  const p = r.rows[0];
  if (!p) throw bad(`parentCode ${parentCode} is not a live account in this company's chart`, "parentCode");
  if (p.account_type !== type) {
    throw bad(`parentCode ${parentCode} is a ${p.account_type} account; the parent of a ${type} account must also be ${type}`, "parentCode");
  }
  if (p.is_postable) throw bad(`parentCode ${parentCode} is a postable account; only a header account (not postable) can have children`, "parentCode");
  if (p.status !== "active") throw bad(`parentCode ${parentCode} is archived; restore it first`, "parentCode");
  return p;
}

/**
 * "One of the company's currencies in use": a currency that exists and is active in the reference table AND that the
 * company already uses: its functional or presentation currency, or either side of one of its exchange rates, or the
 * pin of one of its other accounts.
 */
async function requireCurrencyInUse(c: PoolClient, tenantId: string, currency: string): Promise<void> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM finance_currencies WHERE code = $2 AND status = 'active')
        AND (
          EXISTS (SELECT 1 FROM finance_company_settings s
                   WHERE s.tenant_id = $1 AND $2 IN (s.functional_currency, s.presentation_currency))
          OR EXISTS (SELECT 1 FROM finance_exchange_rates x
                      WHERE x.tenant_id = $1 AND $2 IN (x.from_currency, x.to_currency))
          OR EXISTS (SELECT 1 FROM finance_accounts a
                      WHERE a.tenant_id = $1 AND a.deleted_at IS NULL AND a.currency_code = $2)
        ) AS ok`,
    [tenantId, currency],
  );
  if (!r.rows[0]?.ok) {
    throw bad(`currencyCode ${currency} is not one of this company's currencies in use (its functional or presentation currency, or one it has a rate for)`, "currencyCode");
  }
}

/**
 * What still points at an account for NEW postings (BFF §49.4). Found from every column of the finance migrations that
 * names a chart account, FK or by code. Only LIVE, ACTIVE referrers count: a retired rule, a tax code that has ended,
 * a deleted or settled instrument, an inactive class cannot post to it any more.
 *
 * Deliberately NOT counted, because they are history or documents and not a way to post again: journal lines (the
 * balance check covers them), AR and AP documents and their lines, bank statements, opening balances, consolidation
 * entries, and accounting-dimension rules (they describe the account, they do not post to it).
 */
async function referrers(c: PoolClient, tenantId: string, accountId: string, code: string): Promise<Array<{ table: string; count: number }>> {
  const r = await c.query<{ tbl: string; n: string }>(
    `SELECT 'finance_posting_rules' AS tbl, count(DISTINCT r.id)::text AS n
       FROM finance_posting_rule_lines l
       JOIN finance_posting_rules r ON r.id = l.rule_id AND r.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND l.account_code = $3 AND r.status = 'active'
        AND (r.effective_to IS NULL OR r.effective_to >= current_date)
     UNION ALL
     SELECT 'finance_tax_codes', count(*)::text
       FROM finance_tax_codes t
      WHERE t.tenant_id = $1 AND t.account_id = $2
        AND (t.effective_to IS NULL OR t.effective_to >= current_date)
     UNION ALL
     SELECT 'finance_asset_classes', count(*)::text
       FROM finance_asset_classes k
      WHERE k.tenant_id = $1 AND k.deleted_at IS NULL AND k.is_active
        AND $3 IN (k.asset_account_code, k.accum_account_code, k.expense_account_code)
     UNION ALL
     SELECT 'finance_instruments', count(*)::text
       FROM finance_instruments i
      WHERE i.tenant_id = $1 AND i.deleted_at IS NULL AND i.status IN ('draft', 'active')
        AND $3 IN (i.liability_account_code, i.interest_account_code, i.accrual_account_code)
     UNION ALL
     SELECT 'company_billing_profiles', count(*)::text
       FROM company_billing_profiles b
      WHERE b.tenant_id = $1 AND $3 IN (b.bank_ledger_account_code, b.default_revenue_account_code)`,
    [tenantId, accountId, code],
  );
  return r.rows.filter((x) => Number(x.n) > 0).map((x) => ({ table: x.tbl, count: Number(x.n) }));
}

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("finance"))
export class FinanceAccountsController {
  // ── §49.2 Add ─────────────────────────────────────────────────────────────────────────────────
  @Post(":tenantId/finance/accounts")
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "create");
    const b = bodyObject(body);

    const code = codeField(b.code, "code");
    const name = nameField(b.name);
    const description = descriptionField(b.description) ?? null;
    if (typeof b.accountType !== "string" || !(ACCOUNT_TYPES as readonly string[]).includes(b.accountType)) {
      throw bad(`accountType must be one of ${ACCOUNT_TYPES.join(", ")}`, "accountType");
    }
    const accountType = b.accountType as AccountType;
    let normalBalance = defaultNormalBalance(accountType);
    if (b.normalBalance !== undefined && b.normalBalance !== null) {
      if (b.normalBalance !== "debit" && b.normalBalance !== "credit") throw bad("normalBalance must be debit or credit", "normalBalance");
      normalBalance = b.normalBalance;
    }
    const parentCode = parentField(b.parentCode) ?? null;
    if (b.isPostable !== undefined && b.isPostable !== null && typeof b.isPostable !== "boolean") throw bad("isPostable must be true or false", "isPostable");
    const isPostable = typeof b.isPostable === "boolean" ? b.isPostable : true;
    let currency: string | null = null;
    if (b.currencyCode !== undefined && b.currencyCode !== null && b.currencyCode !== "") {
      if (typeof b.currencyCode !== "string" || !/^[A-Za-z]{3}$/.test(b.currencyCode.trim())) throw bad("currencyCode must be three letters", "currencyCode");
      currency = b.currencyCode.trim().toUpperCase();
    }

    let id: string;
    try {
      id = await withFinance(tenantId, async (c) => {
        await lockChart(c, tenantId);
        const parent = parentCode ? await resolveParent(c, tenantId, parentCode, accountType) : null;
        if (currency) await requireCurrencyInUse(c, tenantId, currency);
        const dup = await c.query(`SELECT 1 FROM finance_accounts WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL`, [tenantId, code]);
        if (dup.rows[0]) throw codeTaken(code);
        // is_control stays false and allow_manual_posting true: control accounts come from the template and their subledgers.
        const r = await c.query<{ id: string }>(
          `INSERT INTO finance_accounts
             (tenant_id, code, name, parent_id, account_type, normal_balance, is_postable, is_control, allow_manual_posting,
              currency_code, status, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, true, $8, 'active', $9)
           RETURNING id`,
          [tenantId, code, name, parent?.id ?? null, accountType, normalBalance, isPostable, currency, description],
        );
        return r.rows[0].id;
      });
    } catch (e) {
      throw codeTakenFrom(e, code) ?? e;
    }
    await writeActivity(tenantId, req.principal.userId, "created", "finance_account", id, {
      code, name, accountType, normalBalance, isPostable, parentCode,
    });
    return { code };
  }

  // ── §49.3 Rename and edit ─────────────────────────────────────────────────────────────────────
  @Patch(":tenantId/finance/accounts/:code")
  async edit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("code") codeParam: string, @Body() body: unknown) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "update");
    const b = bodyObject(body);
    for (const k of NOT_EDITABLE) {
      if (b[k] !== undefined) {
        throw bad(
          k === "code" ? "send newCode to change the code" : `${k} cannot be edited here (type, normal balance and the control flags are fixed once the account exists)`,
          k,
        );
      }
    }
    const extra = Object.keys(b).filter((k) => !EDITABLE.includes(k));
    if (extra.length > 0) throw bad(`unknown field ${extra[0]}`, extra[0]);

    const name = b.name === undefined ? undefined : nameField(b.name);
    const description = descriptionField(b.description);
    const newCode = b.newCode === undefined ? undefined : codeField(b.newCode, "newCode");
    const parentCode = parentField(b.parentCode);
    if (name === undefined && description === undefined && newCode === undefined && parentCode === undefined) {
      throw new BadRequestException("nothing to change: send name, description, newCode or parentCode");
    }

    let out: { id: string; code: string; changed: string[]; from: Record<string, unknown> };
    try {
      out = await withFinance(tenantId, async (c) => {
        await lockChart(c, tenantId);
        const cur = await liveAccount(c, tenantId, codeParam.trim());
        const sets: string[] = [];
        const vals: unknown[] = [tenantId, cur.id];
        const changed: string[] = [];
        const from: Record<string, unknown> = {};
        const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

        if (name !== undefined && name !== cur.name) { set("name", name); changed.push("name"); from.name = cur.name; }
        if (description !== undefined) { set("description", description); changed.push("description"); }
        if (newCode !== undefined && newCode !== cur.code) {
          const dup = await c.query(`SELECT 1 FROM finance_accounts WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL AND id <> $3`, [tenantId, newCode, cur.id]);
          if (dup.rows[0]) throw codeTaken(newCode);
          // With postings the freeze trigger raises FINANCE_ACCOUNT_FROZEN on this UPDATE; the catch below maps it.
          set("code", newCode); changed.push("code"); from.code = cur.code;
        }
        if (parentCode !== undefined) {
          let parentId: string | null = null;
          if (parentCode !== null) {
            const parent = await resolveParent(c, tenantId, parentCode, cur.account_type);
            if (parent.id === cur.id) throw bad("an account cannot be its own parent", "parentCode");
            const cyc = await c.query<{ found: boolean }>(
              `WITH RECURSIVE up AS (
                 SELECT id, parent_id FROM finance_accounts WHERE id = $1 AND tenant_id = $3
                 UNION
                 SELECT a.id, a.parent_id FROM finance_accounts a JOIN up ON a.id = up.parent_id AND a.tenant_id = $3)
               SELECT EXISTS (SELECT 1 FROM up WHERE id = $2) AS found`,
              [parent.id, cur.id, tenantId],
            );
            if (cyc.rows[0]?.found) throw bad(`${parentCode} sits under ${cur.code}; that would make a loop`, "parentCode");
            parentId = parent.id;
          }
          if (parentId !== cur.parent_id) { set("parent_id", parentId); changed.push("parentCode"); }
        }
        if (sets.length > 0) await c.query(`UPDATE finance_accounts SET ${sets.join(", ")} WHERE id = $2 AND tenant_id = $1`, vals);
        return { id: cur.id, code: newCode ?? cur.code, changed, from };
      });
    } catch (e) {
      throw frozenFrom(e) ?? (newCode ? codeTakenFrom(e, newCode) : null) ?? e;
    }
    if (out.changed.length > 0) {
      await writeActivity(tenantId, req.principal.userId, "updated", "finance_account", out.id, {
        code: out.code, changed: out.changed, from: out.from,
      });
    }
    return { code: out.code };
  }

  // ── §49.4 Archive ─────────────────────────────────────────────────────────────────────────────
  @Post(":tenantId/finance/accounts/:code/archive")
  @HttpCode(200)
  async archive(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("code") codeParam: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "update");
    const out = await withFinance(tenantId, async (c) => {
      // The ledger lock too: a journal being posted right now waits here, then sees the account archived (and the balance
      // read below cannot go stale between the check and the status change).
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('finance_ledger:' || $1::text))`, [tenantId]);
      await lockChart(c, tenantId);
      const acct = await liveAccount(c, tenantId, codeParam.trim());
      const label = `${acct.code} (${acct.name})`;
      if (acct.status === "archived") {
        throw new ConflictException({ message: `${label} is already archived`, reason: "already_archived" });
      }

      // Net of ALL posted lines, every date. Both the transaction amount (what the statements sum) and the functional
      // amount are tested, so a foreign-currency balance that nets to zero in one and not the other still counts.
      const bal = await c.query<{ net: string; base: string }>(
        `SELECT coalesce(sum(CASE side WHEN 'debit' THEN amount ELSE -amount END), 0)::text AS net,
                coalesce(sum(CASE side WHEN 'debit' THEN base_amount ELSE -base_amount END), 0)::text AS base
           FROM finance_journal_lines WHERE tenant_id = $1 AND account_id = $2`,
        [tenantId, acct.id],
      );
      const net = Number(bal.rows[0].net);
      const base = Number(bal.rows[0].base);
      if (net !== 0 || base !== 0) {
        const shown = net !== 0 ? net : base;
        throw new ConflictException({
          message: `${label} still holds a balance (net ${Math.abs(shown)} ${shown > 0 ? "debit" : "credit"}); archiving it would hide the money from every statement. Move the balance with a journal first`,
          reason: "account_has_balance",
        });
      }

      const kids = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM finance_accounts
          WHERE tenant_id = $1 AND parent_id = $2 AND deleted_at IS NULL AND status = 'active'`,
        [tenantId, acct.id],
      );
      if (Number(kids.rows[0].n) > 0) {
        throw new ConflictException({
          message: `${label} has ${kids.rows[0].n} active child account(s); archive or move them first`,
          reason: "account_has_children",
        });
      }

      if (acct.is_control) {
        throw new ConflictException({
          message: `${label} is a control account, reconciled against its subledger; it cannot be archived`,
          reason: "account_is_control",
        });
      }

      const usedBy = await referrers(c, tenantId, acct.id, acct.code);
      if (usedBy.length > 0) {
        throw new ConflictException({
          message: `${label} is still used for new postings by ${usedBy.map((u) => `${u.table} (${u.count})`).join(", ")}; point those at another account first`,
          reason: "account_in_use",
          usedBy,
        });
      }

      await c.query(`UPDATE finance_accounts SET status = 'archived' WHERE id = $1 AND tenant_id = $2`, [acct.id, tenantId]);
      return { id: acct.id, code: acct.code };
    });
    await writeActivity(tenantId, req.principal.userId, "archived", "finance_account", out.id, { code: out.code });
    return { code: out.code, status: "archived" };
  }

  // ── §49.4 Restore ─────────────────────────────────────────────────────────────────────────────
  @Post(":tenantId/finance/accounts/:code/restore")
  @HttpCode(200)
  async restore(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("code") codeParam: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "update");
    const out = await withFinance(tenantId, async (c) => {
      await lockChart(c, tenantId);
      const acct = await liveAccount(c, tenantId, codeParam.trim());
      const label = `${acct.code} (${acct.name})`;
      if (acct.status !== "archived") {
        throw new ConflictException({ message: `${label} is not archived`, reason: "not_archived" });
      }
      if (acct.parent_id) {
        const p = await c.query<{ code: string; name: string; status: string; deleted: boolean }>(
          `SELECT code, name, status, (deleted_at IS NOT NULL) AS deleted FROM finance_accounts WHERE id = $1 AND tenant_id = $2`,
          [acct.parent_id, tenantId],
        );
        const parent = p.rows[0];
        if (parent && (parent.status === "archived" || parent.deleted)) {
          throw new ConflictException({
            message: `${label} sits under ${parent.code} (${parent.name}), which is archived; restore the parent first`,
            reason: "parent_archived",
          });
        }
      }
      await c.query(`UPDATE finance_accounts SET status = 'active' WHERE id = $1 AND tenant_id = $2`, [acct.id, tenantId]);
      return { id: acct.id, code: acct.code };
    });
    await writeActivity(tenantId, req.principal.userId, "restored", "finance_account", out.id, { code: out.code });
    return { code: out.code, status: "active" };
  }
}
