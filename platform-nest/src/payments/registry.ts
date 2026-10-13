// PV5-10 — which payment provider is switched on, for which company, and as which principal it writes.
//
// ── OFF UNLESS CONFIGURED ───────────────────────────────────────────────────────────────────────────────
// Online payment exists only while the provider's server key AND the owning company are configured (config.payments).
// Off, `configuredProvider()` answers null and every caller treats that as "not offered": the portal flag reads
// `{available: false, reason: "not_offered"}`, the checkout route and the webhook answer 404. Everything is read at CALL
// time, never cached at import, so a test (or a restart with new env) switches it without a second code path.
//
// ── ONE MERCHANT ACCOUNT, ONE COMPANY ───────────────────────────────────────────────────────────────────
// A Midtrans merchant account belongs to one legal entity and the money paid through it lands in that entity's balance.
// So the configured `tenantId` is both (a) the only company whose invoices are offered online and (b) the company a
// notice is filed under (provider_events.tenant_id, RLS-scoped, see the 202610130400 header). Offering company B's
// invoice through company A's merchant account would take B's client's money into A's books.
//
// ── THE AUTOMATION PRINCIPAL ────────────────────────────────────────────────────────────────────────────
// Each provider writes as its own `users.kind = 'automation'` row, created by migration
// 202610140830_pv5_online_payment_checkout.sql with the fixed id below. It holds no roles and no membership: the
// processing path is server-internal and checks no Cerbos rule (the GitHub receiver's shape), so the row exists only to
// make `recorded_by` / `confirmed_by` / the journal's actor say WHO wrote the money, truthfully.
import { config } from "../config";
import { MidtransSnapProvider, type FetchLike, type MidtransEnvironment } from "./midtrans";
import type { PaymentProvider } from "./provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** provider key -> its automation principal (users.id), created by the PV5-10 migration. */
export const PROVIDER_PRINCIPALS: Readonly<Record<string, string>> = {
  midtrans: "a7100000-0000-4000-8000-000000000001",
};

export interface ConfiguredProvider {
  provider: PaymentProvider;
  /** The company that owns the merchant account (lower-case uuid). */
  tenantId: string;
  /** The provider's automation principal. */
  principalId: string;
}

let fetchOverride: FetchLike | null = null;

/** Tests only: route every provider call to an in-process fake (no test may reach the internet). */
export function setPaymentFetchForTests(f: FetchLike | null): void {
  fetchOverride = f;
}

function midtransEnvironment(raw: string): MidtransEnvironment | null {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "sandbox") return "sandbox";
  if (v === "production") return "production";
  return null;
}

/** The provider behind `/api/webhooks/payments/:provider`, or null when it is unknown or switched off. */
export function configuredProvider(name: string): ConfiguredProvider | null {
  if (name !== "midtrans") return null;
  const m = config.payments.midtrans;
  if (!m.serverKey || !UUID.test(m.tenantId)) return null;
  const environment = midtransEnvironment(m.environment);
  if (!environment) return null;
  return {
    provider: new MidtransSnapProvider({ serverKey: m.serverKey, environment, fetchImpl: fetchOverride ?? undefined }),
    tenantId: m.tenantId.toLowerCase(),
    principalId: PROVIDER_PRINCIPALS.midtrans,
  };
}

/** Every provider currently switched on (for the retry sweep). */
export function configuredProviders(): ConfiguredProvider[] {
  return Object.keys(PROVIDER_PRINCIPALS)
    .map((k) => configuredProvider(k))
    .filter((p): p is ConfiguredProvider => p !== null);
}

/** The provider that collects this company's invoices online, or null when online payment is off for it. */
export function providerForTenant(tenantId: string): ConfiguredProvider | null {
  const p = configuredProvider("midtrans");
  return p && p.tenantId === tenantId.toLowerCase() ? p : null;
}

/**
 * Boot check. Answers the one line boot logs; THROWS on a half-configured money path, because a request-time failure
 * would come after a client has already been sent to pay (platform-nest/CLAUDE.md, "Boot-time refusals").
 *   - no server key            -> off (the line says so). A company id without a key is still off.
 *   - key + bad environment    -> refuse to boot.
 *   - key + no / bad company   -> refuse to boot (money with nowhere to be filed).
 * The key itself is never printed.
 */
export function describePaymentsConfig(): string {
  const m = config.payments.midtrans;
  if (!m.serverKey) {
    return "online payment is off: MIDTRANS_SERVER_KEY is not set (no Pay online, checkout and webhook answer 404)";
  }
  const environment = midtransEnvironment(m.environment);
  if (!environment) {
    throw new Error(`MIDTRANS_ENVIRONMENT="${m.environment}" must be sandbox or production (blank = sandbox)`);
  }
  if (!UUID.test(m.tenantId)) {
    throw new Error(
      "MIDTRANS_SERVER_KEY is set but MIDTRANS_TENANT_ID is not a company id: online payment needs the company that owns " +
        "the Midtrans merchant account (set it, or unset the key to keep online payment off)",
    );
  }
  // A sandbox key starts "SB-" [UNVERIFIED until the sandbox drive]; a mismatch is said, not refused.
  const sandboxKey = m.serverKey.startsWith("SB-");
  const mismatch = (environment === "production") === sandboxKey
    ? ` WARNING: the key looks like a ${sandboxKey ? "sandbox" : "production"} key but MIDTRANS_ENVIRONMENT is ${environment}`
    : "";
  return `online payment is on: midtrans ${environment}, merchant company ${m.tenantId.toLowerCase()}${mismatch}`;
}
