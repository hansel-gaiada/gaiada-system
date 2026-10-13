// PV5-04 — the company BILLING PROFILE API (design decisions 4 and 6; ruling PV-D26). Table: company_billing_profiles
// (202610130400). One row per company: the issuer's legal name and address, the invoice number prefix, default payment
// terms, the books' currency, the bank account clients pay into, and the two ledger account codes issuing and receipts
// post to. NPWP and PKP are NOT here (finance_company_settings owns tax identity, one source each).
// PV5-10 adds a third ledger code, `gatewayClearingAccountCode`: where an online (payment gateway) receipt is booked
// (DR clearing, CR AR) until the provider pays out. Online payment is not offered while it is unset or does not resolve
// to a live, postable, non-control account. It is a ledger code like the other two, so it is `update`, not
// set_bank_details: it redirects no money (the provider pays into the merchant account whatever it says).
//
// ── AUTHORIZATION ─────────────────────────────────────────────────────────────────────────────────────
//   GET  : `finance_config` read   (the accounting-vocabulary tier: finance_staff, finance_manager, company_admin).
//   PUT  : `finance_config` update (finance_manager, company_admin), AND, when the body carries a `bank` key at all,
//          `finance_config` set_bank_details: an owner or finance_manager GRANT on this company, or platform_admin, at
//          HIGH assurance for everyone; bots and automation never (resource_finance_config.yaml, PV5-02). Both checks
//          run before any validation. A bank change writes an activity row and notifies EVERY owner of the company
//          (PV-D26), so a redirected payee account cannot go unnoticed.
//
// NOT gated on ModuleEnabledGuard("finance") or ("invoice"): the profile is company configuration that issue readiness
// must be able to read (and report "finance module off" as its own reason), and a company sets it up BEFORE switching
// issuing on. The table uses the core tenant policy (no module wall), see 202610130400's header.
//
// ── THE REPO IS PUBLIC ────────────────────────────────────────────────────────────────────────────────
// No bank data lives in code or seeds beyond obviously fake placeholders; real values are entered here, on the server.
import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Put, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { DatabaseError } from "pg";
import { withGlobal, withTenants } from "../../db";
import { authorize, notify, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";

interface BankBlock { bankName?: string; accountName?: string; accountNo?: string }
interface ProfileBody {
  legalName?: string;
  address?: string;
  invoicePrefix?: string;
  defaultPaymentTermsDays?: number;
  currencyCode?: string;
  bankLedgerAccountCode?: string | null;
  defaultRevenueAccountCode?: string | null;
  gatewayClearingAccountCode?: string | null;
  signatureThreshold?: number | string | null;
  /** Present (an object, or null to clear) only when the caller means to change the bank block: needs set_bank_details. */
  bank?: BankBlock | null;
}

const SELECT_PROFILE = `
  SELECT legal_name AS "legalName", address, invoice_prefix AS "invoicePrefix",
         default_payment_terms_days AS "defaultPaymentTermsDays", currency_code AS "currencyCode",
         bank_name AS "bankName", bank_account_name AS "bankAccountName", bank_account_no AS "bankAccountNo",
         bank_ledger_account_code AS "bankLedgerAccountCode",
         default_revenue_account_code AS "defaultRevenueAccountCode",
         gateway_clearing_account_code AS "gatewayClearingAccountCode",
         signature_threshold::text AS "signatureThreshold", updated_by AS "updatedBy", updated_at AS "updatedAt"
    FROM company_billing_profiles WHERE tenant_id = $1`;

type ProfileRow = {
  legalName: string; address: string; invoicePrefix: string; defaultPaymentTermsDays: number; currencyCode: string;
  bankName: string | null; bankAccountName: string | null; bankAccountNo: string | null;
  bankLedgerAccountCode: string | null; defaultRevenueAccountCode: string | null; gatewayClearingAccountCode: string | null;
  signatureThreshold: string | null; updatedBy: string | null; updatedAt: string;
};

function shape(r: ProfileRow) {
  return {
    legalName: r.legalName,
    address: r.address,
    invoicePrefix: r.invoicePrefix,
    defaultPaymentTermsDays: Number(r.defaultPaymentTermsDays),
    currencyCode: r.currencyCode,
    // "Clients pay into this account": it is printed on every issued invoice, so it is not hidden from readers here.
    bank: r.bankName ? { bankName: r.bankName, accountName: r.bankAccountName, accountNo: r.bankAccountNo } : null,
    bankLedgerAccountCode: r.bankLedgerAccountCode,
    defaultRevenueAccountCode: r.defaultRevenueAccountCode,
    gatewayClearingAccountCode: r.gatewayClearingAccountCode,
    signatureThreshold: r.signatureThreshold,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  };
}

/** The last 4 characters, for the activity row and the owner notice (never the full number in a notification). */
const last4 = (s: string | null | undefined) => (s ? `…${s.slice(-4)}` : null);
const ACCOUNT_CODE = /^[A-Za-z0-9._-]{1,32}$/;

@Controller("api")
@UseGuards(AuthGuard)
export class BillingProfileController {
  @Get(":tenantId/billing-profile")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "read");
    const r = await withTenants([tenantId], (c) => c.query<ProfileRow>(SELECT_PROFILE, [tenantId]));
    if (!r.rows[0]) throw new NotFoundException("this company has no billing profile yet");
    return shape(r.rows[0]);
  }

  @Put(":tenantId/billing-profile")
  async put(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: ProfileBody) {
    // ── Authorization first, every action the body needs, before any validation ─────────────────────────
    // The bank block is its own action (set_bank_details) held by an owner or finance_manager grant; the rest of the
    // profile is `update`. A body that only changes the bank needs only set_bank_details, so an owner (who holds no
    // finance_config `update`: owner is permission-native and this kind has no permission arm) can still change it.
    const isObj = body != null && typeof body === "object";
    const touchesBank = isObj && Object.prototype.hasOwnProperty.call(body, "bank");
    const touchesRest = isObj && Object.keys(body).some((k) => k !== "bank");
    if (touchesRest || !touchesBank) {
      await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "update");
    }
    if (touchesBank) {
      await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "set_bank_details");
    }

    // ── Validation (mirrors the table's CHECKs so a refusal is a named 400, not a 500) ──────────────────
    const b = body ?? {};
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
    const legalName = str(b.legalName);
    const address = str(b.address);
    const prefix = str(b.invoicePrefix);
    if (legalName !== undefined && !legalName) throw new BadRequestException("legalName cannot be blank");
    if (address !== undefined && !address) throw new BadRequestException("address cannot be blank");
    if (prefix !== undefined && !/^[A-Z0-9-]{1,16}$/.test(prefix)) {
      throw new BadRequestException("invoicePrefix must be 1-16 characters of A-Z, 0-9 or '-' (it starts every invoice number: PREFIX/2026/10/CODE/0001)");
    }
    let terms: number | undefined;
    if (b.defaultPaymentTermsDays !== undefined) {
      terms = Number(b.defaultPaymentTermsDays);
      if (!Number.isInteger(terms) || terms < 0 || terms > 365) throw new BadRequestException("defaultPaymentTermsDays must be a whole number from 0 to 365");
    }
    const currency = str(b.currencyCode);
    if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new BadRequestException("currencyCode must be a 3-letter ISO code");
    for (const [k, v] of [
      ["bankLedgerAccountCode", b.bankLedgerAccountCode], ["defaultRevenueAccountCode", b.defaultRevenueAccountCode],
      ["gatewayClearingAccountCode", b.gatewayClearingAccountCode],
    ] as const) {
      if (v != null && (typeof v !== "string" || !ACCOUNT_CODE.test(v.trim()))) throw new BadRequestException(`${k} must be an account code`);
    }
    let threshold: string | null | undefined;
    if (b.signatureThreshold !== undefined) {
      if (b.signatureThreshold === null || b.signatureThreshold === "") threshold = null;
      else {
        threshold = String(b.signatureThreshold).trim();
        if (!/^\d+(\.\d+)?$/.test(threshold) || !(Number(threshold) > 0)) throw new BadRequestException("signatureThreshold must be a positive amount or null");
      }
    }
    let bank: { name: string; accountName: string; accountNo: string } | null | undefined;
    if (touchesBank) {
      if (b.bank === null) bank = null;
      else {
        const name = str(b.bank?.bankName);
        const accountName = str(b.bank?.accountName);
        const accountNo = str(b.bank?.accountNo);
        if (!name || !accountName || !accountNo) {
          throw new BadRequestException("bank needs bankName, accountName and accountNo (all three), or null to clear it");
        }
        if (!/^[0-9 -]{4,40}$/.test(accountNo)) throw new BadRequestException("bank.accountNo must be 4-40 digits (spaces and '-' allowed)");
        bank = { name: name.slice(0, 120), accountName: accountName.slice(0, 200), accountNo };
      }
    }

    const actor = req.principal.userId;
    const out = await withTenants([tenantId], async (c) => {
      if (currency !== undefined) {
        const cur = await c.query(`SELECT 1 FROM finance_currencies WHERE code = $1 AND status = 'active'`, [currency]);
        if (!cur.rows[0]) throw new BadRequestException(`currencyCode ${currency} is not a currency the ledger knows`);
      }
      const prev = await c.query<ProfileRow>(`${SELECT_PROFILE} FOR UPDATE`, [tenantId]);
      const before = prev.rows[0] ?? null;
      if (!before && (!legalName || !address || !prefix)) {
        throw new BadRequestException("a new billing profile needs legalName, address and invoicePrefix");
      }
      try {
        if (!before) {
          await c.query(
            `INSERT INTO company_billing_profiles
               (tenant_id, legal_name, address, invoice_prefix, default_payment_terms_days, currency_code,
                bank_name, bank_account_name, bank_account_no, bank_ledger_account_code, default_revenue_account_code,
                signature_threshold, updated_by, gateway_clearing_account_code)
             VALUES ($1, $2, $3, $4, COALESCE($5::int, 30), COALESCE($6, 'IDR'), $7, $8, $9, $10, $11, $12::numeric, $13, $14)`,
            [tenantId, legalName, address, prefix, terms ?? null, currency ?? null,
             bank?.name ?? null, bank?.accountName ?? null, bank?.accountNo ?? null,
             b.bankLedgerAccountCode?.trim() ?? null, b.defaultRevenueAccountCode?.trim() ?? null,
             threshold ?? null, actor, b.gatewayClearingAccountCode?.trim() ?? null],
          );
        } else {
          await c.query(
            `UPDATE company_billing_profiles SET
                legal_name = COALESCE($2, legal_name),
                address = COALESCE($3, address),
                invoice_prefix = COALESCE($4, invoice_prefix),
                default_payment_terms_days = COALESCE($5::int, default_payment_terms_days),
                currency_code = COALESCE($6, currency_code),
                bank_name = CASE WHEN $7::boolean THEN $8 ELSE bank_name END,
                bank_account_name = CASE WHEN $7::boolean THEN $9 ELSE bank_account_name END,
                bank_account_no = CASE WHEN $7::boolean THEN $10 ELSE bank_account_no END,
                bank_ledger_account_code = CASE WHEN $11::boolean THEN $12 ELSE bank_ledger_account_code END,
                default_revenue_account_code = CASE WHEN $13::boolean THEN $14 ELSE default_revenue_account_code END,
                signature_threshold = CASE WHEN $15::boolean THEN $16::numeric ELSE signature_threshold END,
                gateway_clearing_account_code = CASE WHEN $18::boolean THEN $19 ELSE gateway_clearing_account_code END,
                updated_by = $17, updated_at = now()
              WHERE tenant_id = $1`,
            [tenantId, legalName ?? null, address ?? null, prefix ?? null, terms ?? null, currency ?? null,
             touchesBank, bank?.name ?? null, bank?.accountName ?? null, bank?.accountNo ?? null,
             b.bankLedgerAccountCode !== undefined, b.bankLedgerAccountCode?.trim() ?? null,
             b.defaultRevenueAccountCode !== undefined, b.defaultRevenueAccountCode?.trim() ?? null,
             threshold !== undefined, threshold ?? null, actor,
             b.gatewayClearingAccountCode !== undefined, b.gatewayClearingAccountCode?.trim() ?? null],
          );
        }
      } catch (e) {
        // A CHECK the validation above did not foresee: a named 400, never a body-less 500.
        if (e instanceof DatabaseError && (e.code === "23514" || e.code === "23503")) {
          throw new BadRequestException(`the billing profile was refused by the database (${e.constraint ?? e.code})`);
        }
        throw e;
      }
      const after = (await c.query<ProfileRow>(SELECT_PROFILE, [tenantId])).rows[0];
      const bankChanged = touchesBank && (
        (before?.bankName ?? null) !== after.bankName
        || (before?.bankAccountName ?? null) !== after.bankAccountName
        || (before?.bankAccountNo ?? null) !== after.bankAccountNo
      );
      return { before, after, bankChanged };
    });

    await writeActivity(tenantId, actor, out.before ? "updated" : "created", "billing_profile", tenantId, {
      fields: Object.keys(b).filter((k) => k !== "bank"),
    });
    if (out.bankChanged) {
      // PV-D26: every change to the account clients pay into is recorded and announced to all owners.
      await writeActivity(tenantId, actor, "bank_details_changed", "billing_profile", tenantId, {
        from: out.before?.bankName ? { bankName: out.before.bankName, accountNo: last4(out.before.bankAccountNo) } : null,
        to: out.after.bankName ? { bankName: out.after.bankName, accountNo: last4(out.after.bankAccountNo) } : null,
      });
      const owners = await withGlobal((c) =>
        c.query<{ user_id: string }>(
          `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE r.name = 'owner' AND r.company_id IS NULL
              AND ur.scope_type = 'company' AND ur.scope_id = $1
              AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
          [tenantId],
        ),
      );
      for (const o of owners.rows) {
        try {
          // notify() skips the actor themselves: they made the change and are told by the response.
          await notify(tenantId, o.user_id, actor, "billing.bank_details_changed", {
            title: "The bank account clients pay into was changed",
            body: out.after.bankName
              ? `Now ${out.after.bankName} ${last4(out.after.bankAccountNo)}. If you did not expect this, check it before any client pays.`
              : "The bank details were removed from the billing profile.",
            href: "/finance",
            entityType: "billing_profile",
            entityId: tenantId,
            severity: "warning",
          });
        } catch (err) {
          console.error(`[billing-profile] owner notify failed (recipient=${o.user_id}):`, (err as Error)?.message ?? err);
        }
      }
    }
    return shape(out.after);
  }
}
