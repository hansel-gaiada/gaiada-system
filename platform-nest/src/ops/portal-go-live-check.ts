// PGL-01 (docs/plans/2026-10-15-portal-go-live-tickets.md) — `portal-go-live-check`: the READ-ONLY readiness check for the day
// real clients first use the portal. It reports, one line per check, whether the review-stage simulations and placeholders are
// still in place. It never changes anything.
//
// It ships inside the platform image (dist/ops/portal-go-live-check.js), like seal-key and client-reports-backfill:
//
//   docker exec gaiada-platform-1 node dist/ops/portal-go-live-check.js          # one line per check
//   docker exec gaiada-platform-1 node dist/ops/portal-go-live-check.js --json   # the same data as JSON
//
// EXIT CODES (an error is never a PASS)
//   0  no check is BLOCK or ERROR (MANUAL lines still have to be cleared by a person)
//   1  at least one check is BLOCK
//   2  at least one check could not run (ERROR): a positive control read zero, a query failed, or the run itself failed.
//      2 outranks 1: the picture is incomplete, so nothing may be certified from it. The BLOCK lines are still printed.
//
// STRICTLY READ-ONLY. One `BEGIN READ ONLY` transaction; the run confirms `transaction_read_only = on` before it reads
// anything, and ends with ROLLBACK. There is no write path in this file.
//
// NEVER PRINTS A SECRET. A key is reported as set/unset and its prefix CLASS (`SIM-`, `SB-`, other) only. The snapshot the
// checks judge (EnvSnapshot) does not even hold a key value, so nothing below can print one.
//
// THE RLS TRAP (plan finding 8; platform-nest/CLAUDE.md, the three walls). A query without its tenant setting reads ZERO rows,
// so "no placeholder contacts" would report PASS on a database full of them. So every database check is judged only after
// POSITIVE CONTROLS, taken through the SAME connection and the SAME tenant context as the check's own reads:
//   ctx       the tenant setting really holds this company's id (read back with current_setting), for every company;
//   clients   at least one client is visible across the estate;
//   profiles  at least one billing profile is visible (billing, seal and payment-key checks);
//   contacts  at least one client contact row is visible (the placeholder checks).
// A control that reads zero turns the check into ERROR (exit 2), never PASS. The control is "estate-wide" for clients,
// profiles and contacts on purpose: a company that legitimately has no clients (a holding company) must not fail the run,
// while an unset or wrong tenant setting still reads zero everywhere and is caught by `ctx` first.
//
// Every table read here is a CORE tenant-policy table (company_billing_profiles, company_seal_certificates, clients,
// client_contacts, activities, payment_checkouts, contract_signatures), so no module scope (`app.scopes`) is declared. If a
// table ever moves behind a module wall, its control reads zero and the run says so instead of passing.
import type { PoolClient } from "pg";
import { closePool, getPool } from "../db";
import { config } from "../config";

// ── result model ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Status = "PASS" | "BLOCK" | "WARN" | "INFO" | "MANUAL" | "ERROR";

export interface CheckResult {
  /** Stable id: the runbook cites these. */
  id: string;
  status: Status;
  evidence: string;
}

export interface ReadinessReport {
  generatedAt: string;
  /** `SHOW transaction_read_only` as the run saw it: always true, or the run refuses to start. */
  readOnly: boolean;
  /** Live companies the run iterated. */
  companies: number;
  exitCode: 0 | 1 | 2;
  verdict: "BLOCKED" | "INCOMPLETE" | "NO AUTOMATED BLOCKERS";
  counts: Record<Status, number>;
  checks: CheckResult[];
}

const STATUSES: Status[] = ["PASS", "BLOCK", "WARN", "INFO", "MANUAL", "ERROR"];

export function exitCodeFor(checks: CheckResult[]): 0 | 1 | 2 {
  if (checks.some((c) => c.status === "ERROR")) return 2;
  if (checks.some((c) => c.status === "BLOCK")) return 1;
  return 0;
}

// ── what the process is configured with (a SNAPSHOT: it never holds a secret value) ─────────────────────────────────────────

export interface EnvSnapshot {
  /** MFA_SIMULATION_ENABLED, parsed as config.mfaSimulationEnabled parses it ("1" or "true"). */
  mfaSimulationEnabled: boolean;
  /** SIGNATURE_SIMULATION_ENABLED ("1" or "true"). */
  signatureSimulationEnabled: boolean;
  payments: {
    /** PAYMENTS_SIMULATION_ENABLED ("1" or "true"). */
    simulationEnabled: boolean;
    /** MIDTRANS_ENVIRONMENT, trimmed (blank = sandbox in the registry). */
    environment: string;
    /** MIDTRANS_SERVER_KEY is set (non-empty). The key itself is not kept. */
    serverKeySet: boolean;
    /** The key's prefix class: `SIM-` (simulated), `SB-` (a sandbox-style key), `other`; null when unset. */
    serverKeyClass: "SIM-" | "SB-" | "other" | null;
    /** MIDTRANS_TENANT_ID, trimmed: the company that owns the merchant account. */
    tenantId: string;
  };
  mail: {
    /** MAIL_ENABLED === "1" (the master gate). */
    enabled: boolean;
    /** The notify stream's transport and the host of THAT transport (what `resolveAdapter` would connect to). */
    transport: "relay" | "brevo";
    host: string;
    /** MAIL_STREAM_NOTIFY_FROM (an address is not a secret). */
    from: string;
    /** CLIENT_MAIL_ENABLED === "1" (the client-mail flag, PGL-09; the platform reads it through `readClientMailEnabled`). */
    clientMailEnabled: boolean;
    /** CONVERSATION_CLIENT_MAIL_ENABLED === "1" (its read-only alias for one release, PGL-09). */
    conversationClientMailEnabled: boolean;
  };
}

function keyClass(key: string): "SIM-" | "SB-" | "other" | null {
  if (!key) return null;
  if (key.startsWith("SIM-")) return "SIM-";
  if (key.startsWith("SB-")) return "SB-";
  return "other";
}

/** Reads the running process's configuration, through the SAME `config` object the platform reads (so a name or a parse rule
 *  can never drift from the code). The two client-mail names are read from the environment directly, each on its own, so the
 *  evidence can say which one is set; the platform treats either as on (`readClientMailEnabled`). */
export function snapshotFromConfig(env: NodeJS.ProcessEnv = process.env): EnvSnapshot {
  const notify = config.mail.streams.notify;
  const m = config.payments.midtrans;
  return {
    mfaSimulationEnabled: config.mfaSimulationEnabled,
    signatureSimulationEnabled: config.signatureSimulationEnabled,
    payments: {
      simulationEnabled: config.payments.simulationEnabled,
      environment: m.environment.trim(),
      serverKeySet: m.serverKey.length > 0,
      serverKeyClass: keyClass(m.serverKey),
      tenantId: m.tenantId.trim(),
    },
    mail: {
      enabled: config.mail.enabled,
      transport: notify.transport,
      host: (notify.transport === "brevo" ? notify.brevo.host : notify.relay.host).trim(),
      from: notify.from.trim(),
      clientMailEnabled: env.CLIENT_MAIL_ENABLED === "1",
      conversationClientMailEnabled: env.CONVERSATION_CLIENT_MAIL_ENABLED === "1",
    },
  };
}

// ── what the database says (collected per company, inside that company's tenant context) ───────────────────────────────────

export interface BillingFacts {
  legalName: string;
  invoicePrefix: string;
  bankName: string | null;
  bankAccountNo: string | null;
  address: string;
  gatewayClearingAccountCode: string | null;
}

export interface SealCertFacts {
  subject: string;
}

export interface ContactFacts {
  /** client_contacts.capability: `signer`, `admin` (portal-scope.ts treats both as able to sign) or `viewer`. */
  capability: string;
  clientName: string;
  email: string;
  kind: string;
}

export interface TenantFacts {
  tenantId: string;
  name: string;
  /** The tenant setting read back equals this company's id, and every query ran. False = the positive control failed. */
  contextOk: boolean;
  /** Why `contextOk` is false. */
  contextProblem: string | null;
  clients: number;
  /** client_contacts rows of any status (the contacts control). */
  contactsTotal: number;
  billing: BillingFacts | null;
  /** Seal certificates valid right now. */
  sealCerts: SealCertFacts[];
  /** ACTIVE contacts that are a `portal@*.test` login or are held by a user whose kind is not `client`. */
  contacts: ContactFacts[];
  simulated: { checkouts: number; checkoutsPaid: number; signatures: number; mfaSessions: string[] };
}

type Need = "ctx" | "clients" | "profiles" | "contacts";

interface Control {
  ok: boolean;
  /** What was proven (when ok) or what failed (when not). */
  text: string;
}

function sum(facts: TenantFacts[], pick: (f: TenantFacts) => number): number {
  return facts.reduce((n, f) => n + pick(f), 0);
}

/** The positive controls a check needs, judged over everything the run collected. */
export function controlFor(facts: TenantFacts[], needs: Need[]): Control {
  const proven: string[] = [];
  if (facts.length === 0) {
    return { ok: false, text: "positive control FAILED: no company is readable, so no tenant context can be proven; nothing can be certified" };
  }
  if (needs.includes("ctx")) {
    const bad = facts.filter((f) => !f.contextOk);
    if (bad.length) {
      const why = bad.slice(0, 3).map((f) => `${f.name}: ${f.contextProblem ?? "tenant context not in effect"}`).join("; ");
      return {
        ok: false,
        text: `positive control FAILED: the tenant setting was not in effect for ${bad.length} of ${facts.length} companies (${why}); a query without it reads zero rows, so nothing can be certified`,
      };
    }
    proven.push(`tenant setting confirmed for ${facts.length} companies`);
  }
  const rows: Array<[Need, string, number]> = [
    ["clients", "clients", sum(facts, (f) => f.clients)],
    ["profiles", "billing profiles", sum(facts, (f) => (f.billing ? 1 : 0))],
    ["contacts", "client contacts", sum(facts, (f) => f.contactsTotal)],
  ];
  for (const [need, label, n] of rows) {
    if (!needs.includes(need)) continue;
    if (n === 0) {
      return {
        ok: false,
        text: `positive control FAILED: 0 ${label} visible across ${facts.length} companies (an unset or wrong tenant setting reads zero rows, and so does an empty estate); nothing can be certified`,
      };
    }
    proven.push(`${n} ${label} visible`);
  }
  return { ok: true, text: proven.join(", ") };
}

const errorResult = (id: string, c: Control): CheckResult => ({ id, status: "ERROR", evidence: c.text });

// ── the checks (pure: facts and a snapshot in, a line out) ──────────────────────────────────────────────────────────────────

export function checkMfaSimulation(env: EnvSnapshot): CheckResult {
  return env.mfaSimulationEnabled
    ? { id: "mfa.simulation", status: "BLOCK", evidence: "MFA_SIMULATION_ENABLED is on (1 or true): staff can reach high assurance with the SIMULATED second factor (PV-D40)" }
    : { id: "mfa.simulation", status: "PASS", evidence: "MFA_SIMULATION_ENABLED is off" };
}

/** `mfa.real` cannot be measured from the platform, so it is MANUAL (never a fake PASS). The reason is in the evidence:
 *  the platform writes NO record of a real second factor. `assuranceFor()` (auth/oidc.ts) derives "high" per request from the
 *  token's `amr` claim and stores nothing; the only step-up record in the database is the SIMULATED one
 *  (`activities.verb = 'auth.step_up_simulated'`, written by auth/step-up.controller.ts), which is counted by data.simulated.
 *  `amrClaimMissingCount` (auth/oidc.ts) is an in-process counter that no other process can read. */
export function checkMfaReal(): CheckResult {
  return {
    id: "mfa.real",
    status: "MANUAL",
    evidence:
      "no source in the platform records a real second factor: auth/oidc.ts derives high assurance from the token's amr claim on each request and stores nothing, " +
      "and the only step-up rows are the simulated ones (activities verb auth.step_up_simulated, counted in data.simulated). " +
      "Clear it by hand: infra/runbooks/enable-mfa.md applied (Keycloak amr mapper), a staff account signs in with a real second factor, " +
      "GET /api/me then shows assurance high with NO assuranceSource, and the Keycloak sign-in events show that login",
  };
}

export function checkPaymentsSimulation(env: EnvSnapshot): CheckResult {
  const p = env.payments;
  const reasons: string[] = [];
  if (p.simulationEnabled) reasons.push("PAYMENTS_SIMULATION_ENABLED is on (1 or true): payments are SIMULATED, no real money moves (PV-D41)");
  if (p.environment.toLowerCase() !== "production") {
    reasons.push(`MIDTRANS_ENVIRONMENT is ${p.environment ? `"${p.environment}"` : "blank (sandbox)"}, not production`);
  }
  return reasons.length
    ? { id: "payments.simulation", status: "BLOCK", evidence: reasons.join("; ") }
    : { id: "payments.simulation", status: "PASS", evidence: "PAYMENTS_SIMULATION_ENABLED is off and MIDTRANS_ENVIRONMENT is production" };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkPaymentsKeys(env: EnvSnapshot, facts: TenantFacts[]): CheckResult {
  const p = env.payments;
  const reasons: string[] = [];
  if (!p.serverKeySet) reasons.push("MIDTRANS_SERVER_KEY is not set");
  else if (p.serverKeyClass === "SIM-") reasons.push("MIDTRANS_SERVER_KEY is set but is a simulated key (prefix class SIM-)");
  const tenantValid = UUID_RE.test(p.tenantId);
  if (!p.tenantId) reasons.push("MIDTRANS_TENANT_ID is not set");
  else if (!tenantValid) reasons.push("MIDTRANS_TENANT_ID is not a company id");

  // The part that needs the database: the merchant company's billing profile and its clearing account.
  const ctl = controlFor(facts, ["ctx", "profiles"]);
  let profileNote = "";
  if (tenantValid) {
    if (!ctl.ok) {
      profileNote = " (the billing profile was not checked: a positive control failed)";
    } else {
      const owner = facts.find((f) => f.tenantId.toLowerCase() === p.tenantId.toLowerCase());
      if (!owner) reasons.push("MIDTRANS_TENANT_ID is not a live company in this database");
      else if (!owner.billing) reasons.push(`the merchant company (${owner.name}) has no billing profile, so no clearing account`);
      else if (!(owner.billing.gatewayClearingAccountCode ?? "").trim()) reasons.push(`the merchant company (${owner.name}) has no clearing account on its billing profile`);
    }
  }
  if (reasons.length) return { id: "payments.keys", status: "BLOCK", evidence: reasons.join("; ") + profileNote };
  if (!ctl.ok) return errorResult("payments.keys", ctl);
  const classNote = p.serverKeyClass === "SB-" && p.environment.toLowerCase() === "production"
    ? "the key looks like a sandbox key (prefix class SB-) but MIDTRANS_ENVIRONMENT is production"
    : null;
  const base = `MIDTRANS_SERVER_KEY is set (prefix class ${p.serverKeyClass}), MIDTRANS_TENANT_ID names a live company, and its billing profile has a clearing account`;
  return classNote
    ? { id: "payments.keys", status: "WARN", evidence: `${base}; ${classNote}` }
    : { id: "payments.keys", status: "PASS", evidence: base };
}

export function checkSignaturesSimulation(env: EnvSnapshot): CheckResult {
  return env.signatureSimulationEnabled
    ? { id: "signatures.simulation", status: "BLOCK", evidence: "SIGNATURE_SIMULATION_ENABLED is on (1 or true): certified signing runs through the SIMULATED PSrE (PV-D43)" }
    : { id: "signatures.simulation", status: "PASS", evidence: "SIGNATURE_SIMULATION_ENABLED is off" };
}

/** Why a billing profile still looks like review-stage data (an empty list = it does not). */
export function billingMockReasons(b: BillingFacts): string[] {
  const out: string[] = [];
  if (/DEV MOCK/i.test(b.legalName)) out.push('legal name contains "DEV MOCK"');
  if (/MOCK BANK/i.test(b.bankName ?? "")) out.push('bank is "MOCK BANK"');
  if (/^0+$/.test((b.bankAccountNo ?? "").trim())) out.push("bank account is all zeros");
  if (/-DEV$/i.test(b.invoicePrefix)) out.push(`invoice prefix ends in -DEV`);
  if (/seed data/i.test(b.address) || /seed data/i.test(b.bankName ?? "")) out.push('address or bank says "seed data"');
  return out;
}

export function checkBillingMock(facts: TenantFacts[]): CheckResult {
  const ctl = controlFor(facts, ["ctx", "profiles"]);
  if (!ctl.ok) return errorResult("billing.mock", ctl);
  const profiles = facts.filter((f) => f.billing);
  const bad = profiles
    .map((f) => ({ name: f.name, reasons: billingMockReasons(f.billing as BillingFacts) }))
    .filter((x) => x.reasons.length);
  if (bad.length) {
    return {
      id: "billing.mock",
      status: "BLOCK",
      evidence: `${bad.length} of ${profiles.length} billing profiles are still mock: ${bad.map((x) => `${x.name} (${x.reasons.join("; ")})`).join("; ")}`,
    };
  }
  return { id: "billing.mock", status: "PASS", evidence: `${profiles.length} billing profiles checked, none is mock (${ctl.text})` };
}

export function checkSealMock(facts: TenantFacts[]): CheckResult {
  const ctl = controlFor(facts, ["ctx", "profiles"]);
  if (!ctl.ok) return errorResult("seal.mock", ctl);
  const reasons: string[] = [];
  let certs = 0;
  for (const f of facts) {
    for (const cert of f.sealCerts) {
      certs++;
      const why: string[] = [];
      if (/DEV MOCK/i.test(cert.subject)) why.push('subject contains "DEV MOCK"');
      if (!f.billing) why.push("the company has no billing profile to match");
      else if (cert.subject.trim().toLowerCase() !== f.billing.legalName.trim().toLowerCase()) why.push("subject does not match the billing legal name");
      if (why.length) reasons.push(`${f.name} (${why.join("; ")})`);
    }
  }
  if (certs === 0) {
    return { id: "seal.mock", status: "BLOCK", evidence: "no active seal certificate on any company: sealed documents cannot be produced, and there is nothing to verify" };
  }
  if (reasons.length) return { id: "seal.mock", status: "BLOCK", evidence: `${reasons.length} active seal certificate(s) are mock or do not match: ${reasons.join("; ")}` };
  return { id: "seal.mock", status: "PASS", evidence: `${certs} active seal certificate(s) checked, each names its company's billing legal name and none is mock` };
}

const P03_RE = /^portal@.+\.test$/i;

export function checkPlaceholders(facts: TenantFacts[]): CheckResult[] {
  const ctl = controlFor(facts, ["ctx", "clients", "contacts"]);
  if (!ctl.ok) return [errorResult("placeholders.p03", ctl), errorResult("placeholders.p04", ctl)];
  const all = facts.flatMap((f) => f.contacts);

  const p03 = all.filter((c) => P03_RE.test(c.email));
  const p03Clients = [...new Set(p03.map((c) => c.clientName))].sort();
  const r03: CheckResult = p03.length
    ? { id: "placeholders.p03", status: "BLOCK", evidence: `${p03.length} active portal@*.test contact(s) (logins that can never receive mail) on ${p03Clients.length} client(s): ${p03Clients.join(", ")}` }
    : { id: "placeholders.p03", status: "PASS", evidence: `no active portal@*.test contact (${ctl.text})` };

  const staff = all.filter((c) => c.kind !== "client");
  const describe = (rows: ContactFacts[]) => {
    const byUser = new Map<string, ContactFacts[]>();
    for (const r of rows) byUser.set(r.email, [...(byUser.get(r.email) ?? []), r]);
    return [...byUser.entries()]
      .map(([email, rs]) => `${email} (users.kind ${rs[0].kind}) on ${rs.length} contact row(s) across ${new Set(rs.map((x) => x.clientName)).size} client(s)`)
      .join("; ");
  };
  // `admin` signs exactly as `signer` does (core/portal-scope.ts: the client's signers are capability signer OR admin).
  const signers = staff.filter((c) => c.capability === "signer" || c.capability === "admin");
  const viewers = staff.filter((c) => c.capability !== "signer" && c.capability !== "admin");
  let r04: CheckResult;
  if (signers.length) {
    r04 = {
      id: "placeholders.p04",
      status: "BLOCK",
      evidence: `non-client user(s) hold ACTIVE signer (or admin) contacts, so what they sign is recorded as the client's signature: ${describe(signers)}${viewers.length ? `; also staff viewer contact(s): ${describe(viewers)}` : ""}`,
    };
  } else if (viewers.length) {
    r04 = { id: "placeholders.p04", status: "WARN", evidence: `no staff signer or admin contact; staff VIEWER contact(s) remain: ${describe(viewers)}` };
  } else {
    r04 = { id: "placeholders.p04", status: "PASS", evidence: `no active contact is held by a non-client user (${ctl.text})` };
  }
  return [r03, r04];
}

/** The host/address pieces the mail checks judge. `from` may be `Name <a@b>` or a bare address. */
export function fromDomain(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  const addr = (m ? m[1] : from).trim();
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1).trim().toLowerCase() : "";
}

const RESERVED_DOMAIN_RE = /(^|\.)(invalid|test|example|localhost)$/;

export function checkMailSender(env: EnvSnapshot): CheckResult {
  const m = env.mail;
  const domain = fromDomain(m.from);
  const reasons: string[] = [];
  if (!m.enabled) reasons.push("MAIL_ENABLED is not 1 (the mail module is dark: nothing is sent)");
  if (!m.host) reasons.push(`the notify stream has no ${m.transport} host (mail would go to the dev-log adapter, not out)`);
  else if (/mailpit/i.test(m.host)) reasons.push(`the notify relay host is ${m.host} (mailpit catches mail, it delivers none)`);
  if (!domain) reasons.push("the notify From address has no domain");
  else if (RESERVED_DOMAIN_RE.test(domain)) reasons.push(`the notify From address is on the reserved domain ${domain} (it can never be delivered from)`);
  const facts = `notify stream ${m.transport} host ${m.host || "(none)"}, From domain ${domain || "(none)"}`;
  return reasons.length
    ? { id: "mail.sender", status: "BLOCK", evidence: `${reasons.join("; ")} [${facts}]` }
    : { id: "mail.sender", status: "PASS", evidence: `MAIL_ENABLED is 1; ${facts}` };
}

export function checkMailClient(env: EnvSnapshot): CheckResult {
  const m = env.mail;
  if (m.clientMailEnabled) return { id: "mail.client", status: "PASS", evidence: "CLIENT_MAIL_ENABLED is 1" };
  if (m.conversationClientMailEnabled) {
    return { id: "mail.client", status: "PASS", evidence: "CONVERSATION_CLIENT_MAIL_ENABLED is 1 (the alias of CLIENT_MAIL_ENABLED for one release)" };
  }
  return { id: "mail.client", status: "BLOCK", evidence: "client mail is off: neither CLIENT_MAIL_ENABLED nor CONVERSATION_CLIENT_MAIL_ENABLED is 1, so clients receive no mail" };
}

export function checkDataSimulated(facts: TenantFacts[]): CheckResult {
  const ctl = controlFor(facts, ["ctx"]);
  if (!ctl.ok) return errorResult("data.simulated", ctl);
  const checkouts = sum(facts, (f) => f.simulated.checkouts);
  const paid = sum(facts, (f) => f.simulated.checkoutsPaid);
  const signatures = sum(facts, (f) => f.simulated.signatures);
  const sessions = new Set(facts.flatMap((f) => f.simulated.mfaSessions)).size;
  return {
    id: "data.simulated",
    status: "INFO",
    evidence:
      `simulated records still in the data: ${checkouts} payment checkout(s) (${paid} paid), ${signatures} contract signature(s) by the simulated PSrE, ` +
      `${sessions} simulated MFA step-up(s) (distinct sessions); what happens to them before real data is PGL-Q1`,
  };
}

export function manualChecks(): CheckResult[] {
  return [
    {
      id: "legal.gate1",
      status: "MANUAL",
      evidence: "cannot be measured: Legal Gate 1 for the portal needs counsel's sign-off on the client-portal addendum (PGL-03). Clear it at the runbook's legal step (PGL-04) and record it in the decision log",
    },
    {
      id: "mail.deliverability",
      status: "MANUAL",
      evidence: "cannot be measured from the platform: SPF, DKIM and DMARC for the sender domain, and a real client mail reaching an inbox (PGL-11). Clear it at the runbook's mail step (PGL-04)",
    },
    {
      id: "contrast.manual",
      status: "MANUAL",
      evidence: "cannot be measured here: portal colour contrast (PGL-02); an axe sweep leaves translucent-background text 'incomplete', so a green sweep is not proof. Clear it at the runbook's contrast step (PGL-04)",
    },
  ];
}

/** All checks, in the plan's order. */
export function evaluate(env: EnvSnapshot, facts: TenantFacts[]): CheckResult[] {
  const [p03, p04] = checkPlaceholders(facts);
  return [
    checkMfaSimulation(env),
    checkMfaReal(),
    checkPaymentsSimulation(env),
    checkPaymentsKeys(env, facts),
    checkSignaturesSimulation(env),
    checkBillingMock(facts),
    checkSealMock(facts),
    p03,
    p04,
    checkMailSender(env),
    checkMailClient(env),
    checkDataSimulated(facts),
    ...manualChecks(),
  ];
}

// ── reading the database (one READ ONLY transaction; per-company tenant context; a savepoint per company) ───────────────────

/** How a company's tenant context is set. The default is exactly what `withTenants` does (`SET LOCAL` semantics). The tests
 *  pass a no-op to prove an unset setting ends in exit 2. */
export type TenantContextSetter = (client: PoolClient, tenantId: string) => Promise<void>;

export const setTenantContext: TenantContextSetter = async (client, tenantId) => {
  await client.query("SELECT set_config('app.current_tenant_ids', $1, true)", [tenantId]);
};

/** Opens ONE read-only transaction, refuses to continue unless Postgres confirms it, and always ends with ROLLBACK. */
export async function withReadOnlyTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    try {
      const ro = await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
      if (ro.rows[0]?.transaction_read_only !== "on") throw new Error("the transaction is not read-only; refusing to run");
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

interface ContactRow { capability: string; client_name: string; email: string; kind: string }

async function collectTenant(client: PoolClient, tenant: { id: string; name: string }, setTenant: TenantContextSetter): Promise<TenantFacts> {
  const facts: TenantFacts = {
    tenantId: tenant.id, name: tenant.name, contextOk: false, contextProblem: null, clients: 0, contactsTotal: 0,
    billing: null, sealCerts: [], contacts: [], simulated: { checkouts: 0, checkoutsPaid: 0, signatures: 0, mfaSessions: [] },
  };
  await client.query("SAVEPOINT pgl_tenant");
  try {
    await setTenant(client, tenant.id);
    // CONTROL 1: read the tenant setting back, through this same connection. Unset, empty or another company's id fails it.
    const seen = await client.query<{ v: string | null }>("SELECT current_setting('app.current_tenant_ids', true) AS v");
    const v = seen.rows[0]?.v ?? "";
    if (v !== tenant.id) {
      facts.contextProblem = v ? "the tenant setting holds a different company id" : "the tenant setting is unset";
      await client.query("RELEASE SAVEPOINT pgl_tenant");
      return facts;
    }

    const n = async (sql: string): Promise<number> => Number((await client.query<{ n: string }>(sql, [tenant.id])).rows[0]?.n ?? 0);
    facts.clients = await n(`SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1 AND deleted_at IS NULL`);
    facts.contactsTotal = await n(`SELECT count(*)::int AS n FROM client_contacts WHERE tenant_id = $1`);

    const bp = await client.query<{
      legal_name: string; invoice_prefix: string; bank_name: string | null; bank_account_no: string | null; address: string;
      gateway_clearing_account_code: string | null;
    }>(
      `SELECT legal_name, invoice_prefix, bank_name, bank_account_no, address, gateway_clearing_account_code
         FROM company_billing_profiles WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (bp.rows[0]) {
      const r = bp.rows[0];
      facts.billing = {
        legalName: r.legal_name, invoicePrefix: r.invoice_prefix, bankName: r.bank_name, bankAccountNo: r.bank_account_no,
        address: r.address, gatewayClearingAccountCode: r.gateway_clearing_account_code,
      };
    }

    const certs = await client.query<{ subject: string }>(
      `SELECT subject FROM company_seal_certificates WHERE tenant_id = $1 AND valid_from <= now() AND valid_to >= now() ORDER BY valid_from`,
      [tenant.id],
    );
    facts.sealCerts = certs.rows.map((r) => ({ subject: r.subject }));

    const contacts = await client.query<ContactRow>(
      `SELECT cc.capability, cl.name AS client_name, u.email, u.kind
         FROM client_contacts cc
         JOIN users u ON u.id = cc.user_id
         JOIN clients cl ON cl.id = cc.client_id AND cl.tenant_id = cc.tenant_id
        WHERE cc.tenant_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
          AND (u.email ILIKE 'portal@%.test' OR u.kind <> 'client')
        ORDER BY cl.name, u.email`,
      [tenant.id],
    );
    facts.contacts = contacts.rows.map((r) => ({ capability: r.capability, clientName: r.client_name, email: r.email, kind: r.kind }));

    const co = await client.query<{ total: number; paid: number }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE status = 'paid'))::int AS paid
         FROM payment_checkouts WHERE tenant_id = $1 AND environment = 'simulated'`,
      [tenant.id],
    );
    facts.simulated.checkouts = Number(co.rows[0]?.total ?? 0);
    facts.simulated.checkoutsPaid = Number(co.rows[0]?.paid ?? 0);
    facts.simulated.signatures = await n(`SELECT count(*)::int AS n FROM contract_signatures WHERE tenant_id = $1 AND provider = 'simulated'`);
    // One simulated step-up writes one activity row per company the person is staff of: count DISTINCT sessions estate-wide.
    const mfa = await client.query<{ s: string }>(
      `SELECT DISTINCT coalesce(metadata->>'session', id::text) AS s FROM activities WHERE tenant_id = $1 AND verb = 'auth.step_up_simulated'`,
      [tenant.id],
    );
    facts.simulated.mfaSessions = mfa.rows.map((r) => r.s);

    facts.contextOk = true;
    await client.query("RELEASE SAVEPOINT pgl_tenant");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT pgl_tenant").catch(() => undefined);
    facts.contextOk = false;
    facts.contextProblem = `a query failed: ${(err as Error).message}`;
  }
  return facts;
}

export interface RunOptions {
  env?: EnvSnapshot;
  setTenant?: TenantContextSetter;
}

/** Runs every check. Never writes. Throws only when the run itself cannot start (no connection, not read-only). */
export async function runReadinessCheck(opts: RunOptions = {}): Promise<ReadinessReport> {
  const env = opts.env ?? snapshotFromConfig();
  const setTenant = opts.setTenant ?? setTenantContext;
  const { facts, companies } = await withReadOnlyTx(async (client) => {
    // Companies are listed with NO tenant context, exactly as the backfill tool does (`companies` carries no tenant policy).
    const co = await client.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name, id`);
    const out: TenantFacts[] = [];
    for (const c of co.rows) out.push(await collectTenant(client, c, setTenant));
    return { facts: out, companies: co.rows.length };
  });

  // No readable company: controlFor() fails every database-backed line (ERROR), it never reads as "nothing found".
  const checks = evaluate(env, facts);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, checks.filter((c) => c.status === s).length])) as Record<Status, number>;
  const exitCode = exitCodeFor(checks);
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    companies,
    exitCode,
    verdict: exitCode === 2 ? "INCOMPLETE" : exitCode === 1 ? "BLOCKED" : "NO AUTOMATED BLOCKERS",
    counts,
    checks,
  };
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function renderText(r: ReadinessReport): string {
  const lines = [`portal go-live readiness (READ-ONLY): ${r.companies} companies, ${r.generatedAt}`];
  for (const c of r.checks) lines.push(`${c.status.padEnd(6)} ${c.id.padEnd(22)} ${c.evidence}`);
  const tally = STATUSES.filter((s) => r.counts[s]).map((s) => `${r.counts[s]} ${s}`).join(", ");
  lines.push(`result: ${r.verdict} (${tally}); exit ${r.exitCode}`);
  if (r.exitCode === 0 && r.counts.MANUAL) lines.push(`${r.counts.MANUAL} MANUAL check(s) are still for a person to clear; this run cannot measure them`);
  return lines.join("\n");
}

export function parseArgs(argv: string[]): { json: boolean; help: boolean } {
  let json = false;
  let help = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else throw new Error(`unknown argument ${a} (usage: node dist/ops/portal-go-live-check.js [--json])`);
  }
  return { json, help };
}

async function main(): Promise<number> {
  const { json, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log("usage: node dist/ops/portal-go-live-check.js [--json]\nread-only; exit 0 no BLOCK, 1 a BLOCK, 2 a check could not run");
    return 0;
  }
  const report = await runReadinessCheck();
  console.log(json ? JSON.stringify(report, null, 2) : renderText(report));
  return report.exitCode;
}

if (require.main === module) {
  main()
    .then(async (code) => { await closePool(); process.exit(code); })
    .catch(async (e) => {
      console.error(`portal-go-live-check: ${(e as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(2);
    });
}
