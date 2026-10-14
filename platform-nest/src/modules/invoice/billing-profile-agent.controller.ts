// PV5-12 — the AGENT view of the company billing profile (tool `billingProfile.read`).
//
// A separate route from `GET :tenantId/billing-profile` on purpose: that one answers the full bank account number to a
// reader (it is printed on every issued invoice, and the settings screen shows it). An agent's tool result lands in a
// model's context and its logs, so the tool gets a route that CANNOT return the full number, not a route that is
// trusted to be called with a flag. The mask is applied here, at the only place the number is read for this surface,
// even for an owner. Nothing in this file selects the full number into the response.
//
// Authorization is the existing profile read: `finance_config` read, before anything else, same as the full GET.
// A 403 is a refusal, never an empty profile; a company with no profile yet is a 404.
import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../db";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";

/**
 * Mask a bank account number to its last 4 characters. A number of 4 or fewer characters is masked entirely (showing
 * "the last 4" of a 4-character number would be the whole number). Empty or missing answers null.
 */
export function maskAccountNo(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (s.length <= 4) return "••••";
  return `••••${s.slice(-4)}`;
}

interface AgentProfileRow {
  legalName: string; address: string; invoicePrefix: string; defaultPaymentTermsDays: number; currencyCode: string;
  bankName: string | null; bankAccountName: string | null; bankAccountNo: string | null;
  bankLedgerAccountCode: string | null; defaultRevenueAccountCode: string | null; gatewayClearingAccountCode: string | null;
  signatureThreshold: string | null; updatedAt: string;
}

@Controller("api")
@UseGuards(AuthGuard)
export class BillingProfileAgentController {
  @Get(":tenantId/billing-profile/masked")
  async masked(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "read");
    const r = await withTenants([tenantId], (c) =>
      c.query<AgentProfileRow>(
        `SELECT legal_name AS "legalName", address, invoice_prefix AS "invoicePrefix",
                default_payment_terms_days AS "defaultPaymentTermsDays", currency_code AS "currencyCode",
                bank_name AS "bankName", bank_account_name AS "bankAccountName", bank_account_no AS "bankAccountNo",
                bank_ledger_account_code AS "bankLedgerAccountCode",
                default_revenue_account_code AS "defaultRevenueAccountCode",
                gateway_clearing_account_code AS "gatewayClearingAccountCode",
                signature_threshold::text AS "signatureThreshold", updated_at AS "updatedAt"
           FROM company_billing_profiles WHERE tenant_id = $1`,
        [tenantId],
      ),
    );
    const p = r.rows[0];
    if (!p) throw new NotFoundException("this company has no billing profile yet");
    return {
      legalName: p.legalName,
      address: p.address,
      invoicePrefix: p.invoicePrefix,
      defaultPaymentTermsDays: Number(p.defaultPaymentTermsDays),
      currencyCode: p.currencyCode,
      // The full number is never returned: `accountNoMasked` is "••••" plus the last 4 characters.
      bank: p.bankName
        ? { bankName: p.bankName, accountName: p.bankAccountName, accountNoMasked: maskAccountNo(p.bankAccountNo) }
        : null,
      bankLedgerAccountCode: p.bankLedgerAccountCode,
      defaultRevenueAccountCode: p.defaultRevenueAccountCode,
      // PV5-F4: the gateway clearing account's CODE (PV5-10: where an online receipt is booked). A ledger account code is
      // not a secret, unlike the bank account number, which stays masked above.
      gatewayClearingAccountCode: p.gatewayClearingAccountCode,
      signatureThreshold: p.signatureThreshold,
      updatedAt: p.updatedAt,
    };
  }
}
