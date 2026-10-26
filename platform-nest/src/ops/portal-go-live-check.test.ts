// PGL-01 — unit tests for the portal go-live readiness check: every check's rules, the positive controls, the exit codes, the
// output and the "never print a secret" rule. No database (the DB-backed teeth are in portal-go-live-check.db.test.ts).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config";
import {
  billingMockReasons, checkBillingMock, checkDataSimulated, checkMailClient, checkMailSender, checkMfaReal, checkMfaSimulation,
  checkPaymentsKeys, checkPaymentsSimulation, checkPlaceholders, checkSealMock, checkSignaturesSimulation, controlFor, evaluate,
  exitCodeFor, fromDomain, manualChecks, parseArgs, renderText, snapshotFromConfig,
  type BillingFacts, type CheckResult, type ContactFacts, type EnvSnapshot, type ReadinessReport, type TenantFacts,
} from "./portal-go-live-check";

const MERCHANT = randomUUID();

const cleanEnv = (over: { payments?: Partial<EnvSnapshot["payments"]>; mail?: Partial<EnvSnapshot["mail"]> } & Partial<Pick<EnvSnapshot, "mfaSimulationEnabled" | "signatureSimulationEnabled">> = {}): EnvSnapshot => ({
  mfaSimulationEnabled: over.mfaSimulationEnabled ?? false,
  signatureSimulationEnabled: over.signatureSimulationEnabled ?? false,
  payments: {
    simulationEnabled: false, environment: "production", serverKeySet: true, serverKeyClass: "other", tenantId: MERCHANT,
    ...over.payments,
  },
  mail: {
    enabled: true, transport: "relay", host: "smtp.mailer-fake.net", from: "Studio <hello@studio-fake.net>",
    clientMailEnabled: true, conversationClientMailEnabled: false, ...over.mail,
  },
});

const goodBilling = (over: Partial<BillingFacts> = {}): BillingFacts => ({
  legalName: "Studio Fake Ltd", invoicePrefix: "SFL", bankName: "Fake Bank", bankAccountNo: "1234567890",
  address: "1 Fake Street", gatewayClearingAccountCode: "1130", ...over,
});

const tf = (name: string, over: Partial<TenantFacts> = {}): TenantFacts => ({
  tenantId: randomUUID(), name, contextOk: true, contextProblem: null, clients: 2, contactsTotal: 3, billing: goodBilling(),
  sealCerts: [{ subject: "Studio Fake Ltd" }], contacts: [],
  simulated: { checkouts: 0, checkoutsPaid: 0, signatures: 0, mfaSessions: [] }, ...over,
});

/** A merchant company (the id MIDTRANS_TENANT_ID names) plus an ordinary one, both clean. */
const cleanFacts = (): TenantFacts[] => [tf("Merchant Co", { tenantId: MERCHANT }), tf("Other Co")];

const contact = (over: Partial<ContactFacts> = {}): ContactFacts => ({
  capability: "viewer", clientName: "Client One", email: "someone@client-fake.com", kind: "client", ...over,
});

const byId = (rs: CheckResult[], id: string): CheckResult => {
  const r = rs.find((x) => x.id === id);
  if (!r) throw new Error(`no check ${id}`);
  return r;
};

describe("PGL-01 · exit codes", () => {
  const r = (...s: CheckResult["status"][]): CheckResult[] => s.map((status, i) => ({ id: `c${i}`, status, evidence: "" }));
  it("0 when nothing is BLOCK or ERROR (PASS, WARN, INFO and MANUAL do not block)", () => {
    expect(exitCodeFor(r("PASS", "WARN", "INFO", "MANUAL"))).toBe(0);
    expect(exitCodeFor([])).toBe(0);
  });
  it("1 when any check is BLOCK", () => expect(exitCodeFor(r("PASS", "BLOCK", "MANUAL"))).toBe(1));
  it("2 when a check could not run, and 2 outranks 1: an error is never a PASS", () => {
    expect(exitCodeFor(r("PASS", "ERROR"))).toBe(2);
    expect(exitCodeFor(r("BLOCK", "ERROR"))).toBe(2);
  });
});

describe("PGL-01 · positive controls (the RLS zero-row trap, plan finding 8)", () => {
  it("passes when every company's tenant setting is confirmed and rows are visible", () => {
    const c = controlFor(cleanFacts(), ["ctx", "clients", "profiles", "contacts"]);
    expect(c.ok).toBe(true);
    expect(c.text).toContain("tenant setting confirmed for 2 companies");
  });
  it("fails when no company is readable at all", () => {
    const c = controlFor([], ["ctx"]);
    expect(c.ok).toBe(false);
    expect(c.text).toMatch(/no company is readable/);
  });
  it("fails when one company's tenant setting was not in effect, naming the company and the cause", () => {
    const facts = [tf("Good Co"), tf("Broken Co", { contextOk: false, contextProblem: "the tenant setting is unset" })];
    const c = controlFor(facts, ["ctx"]);
    expect(c.ok).toBe(false);
    expect(c.text).toContain("1 of 2 companies");
    expect(c.text).toContain("Broken Co: the tenant setting is unset");
  });
  it.each([
    ["clients", { clients: 0 }, "0 clients visible"],
    ["profiles", { billing: null }, "0 billing profiles visible"],
    ["contacts", { contactsTotal: 0 }, "0 client contacts visible"],
  ] as const)("fails when the %s control reads zero estate-wide", (need, over, text) => {
    const c = controlFor([tf("A", over), tf("B", over)], ["ctx", need]);
    expect(c.ok).toBe(false);
    expect(c.text).toContain(text);
  });
  it("is estate-wide: one company with no clients (a holding company) does not fail the control", () => {
    expect(controlFor([tf("Holding", { clients: 0 }), tf("Agency", { clients: 4 })], ["ctx", "clients"]).ok).toBe(true);
  });
});

describe("PGL-01 · mfa.simulation and mfa.real", () => {
  it("BLOCKs when the simulated second factor is on, PASSes when off", () => {
    expect(checkMfaSimulation(cleanEnv({ mfaSimulationEnabled: true })).status).toBe("BLOCK");
    expect(checkMfaSimulation(cleanEnv()).status).toBe("PASS");
  });
  it("mfa.real is MANUAL, never PASS, and names why: no source records a real step-up", () => {
    const r = checkMfaReal();
    expect(r.status).toBe("MANUAL");
    expect(r.evidence).toContain("auth/oidc.ts");
    expect(r.evidence).toContain("auth.step_up_simulated");
    expect(r.evidence).toContain("enable-mfa.md");
  });
});

describe("PGL-01 · payments.simulation", () => {
  it("BLOCKs when the flag is on", () => {
    const r = checkPaymentsSimulation(cleanEnv({ payments: { simulationEnabled: true, environment: "simulated" } }));
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("PAYMENTS_SIMULATION_ENABLED");
  });
  it.each(["sandbox", "simulated", ""])("BLOCKs when MIDTRANS_ENVIRONMENT is %j (not production)", (environment) => {
    const r = checkPaymentsSimulation(cleanEnv({ payments: { environment } }));
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("MIDTRANS_ENVIRONMENT");
  });
  it("PASSes with the flag off and production", () => {
    expect(checkPaymentsSimulation(cleanEnv()).status).toBe("PASS");
    expect(checkPaymentsSimulation(cleanEnv({ payments: { environment: "Production" } })).status).toBe("PASS");
  });
});

describe("PGL-01 · payments.keys", () => {
  it("PASSes with a real-class key, the merchant company and its clearing account", () => {
    expect(checkPaymentsKeys(cleanEnv(), cleanFacts()).status).toBe("PASS");
  });
  it("BLOCKs when the key is unset", () => {
    const r = checkPaymentsKeys(cleanEnv({ payments: { serverKeySet: false, serverKeyClass: null } }), cleanFacts());
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("MIDTRANS_SERVER_KEY is not set");
  });
  it("BLOCKs a simulated key (prefix class SIM-)", () => {
    const r = checkPaymentsKeys(cleanEnv({ payments: { serverKeyClass: "SIM-" } }), cleanFacts());
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("SIM-");
  });
  it("BLOCKs when MIDTRANS_TENANT_ID is unset or not a company id", () => {
    expect(checkPaymentsKeys(cleanEnv({ payments: { tenantId: "" } }), cleanFacts()).evidence).toContain("MIDTRANS_TENANT_ID is not set");
    expect(checkPaymentsKeys(cleanEnv({ payments: { tenantId: "nope" } }), cleanFacts()).evidence).toContain("not a company id");
  });
  it("BLOCKs when MIDTRANS_TENANT_ID is not a live company", () => {
    const r = checkPaymentsKeys(cleanEnv({ payments: { tenantId: randomUUID() } }), cleanFacts());
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("not a live company");
  });
  it("BLOCKs when the merchant company has no billing profile, or its profile has no clearing account", () => {
    const noProfile = [tf("Merchant Co", { tenantId: MERCHANT, billing: null }), tf("Other Co")];
    expect(checkPaymentsKeys(cleanEnv(), noProfile).evidence).toContain("no billing profile");
    for (const code of [null, "", "  "]) {
      const noClearing = [tf("Merchant Co", { tenantId: MERCHANT, billing: goodBilling({ gatewayClearingAccountCode: code }) }), tf("Other Co")];
      const r = checkPaymentsKeys(cleanEnv(), noClearing);
      expect(r.status).toBe("BLOCK");
      expect(r.evidence).toContain("no clearing account");
    }
  });
  it("WARNs (not PASS) when the key looks like a sandbox key but the environment is production", () => {
    expect(checkPaymentsKeys(cleanEnv({ payments: { serverKeyClass: "SB-" } }), cleanFacts()).status).toBe("WARN");
  });
  it("is ERROR when a control fails and the environment alone gives no BLOCK", () => {
    const facts = [tf("Merchant Co", { tenantId: MERCHANT, contextOk: false, contextProblem: "the tenant setting is unset" })];
    const r = checkPaymentsKeys(cleanEnv(), facts);
    expect(r.status).toBe("ERROR");
    expect(r.evidence).toContain("positive control FAILED");
  });
  it("still BLOCKs on the environment when a control fails, and says the profile was not checked", () => {
    const facts = [tf("Merchant Co", { tenantId: MERCHANT, contextOk: false, contextProblem: "x" })];
    const r = checkPaymentsKeys(cleanEnv({ payments: { serverKeySet: false, serverKeyClass: null } }), facts);
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("billing profile was not checked");
  });
});

describe("PGL-01 · signatures.simulation", () => {
  it("BLOCKs when on, PASSes when off", () => {
    expect(checkSignaturesSimulation(cleanEnv({ signatureSimulationEnabled: true })).status).toBe("BLOCK");
    expect(checkSignaturesSimulation(cleanEnv()).status).toBe("PASS");
  });
});

describe("PGL-01 · billing.mock", () => {
  it.each([
    ["legal name", { legalName: "Studio (DEV MOCK)" }, "DEV MOCK"],
    ["legal name, lower case", { legalName: "studio dev mock" }, "DEV MOCK"],
    ["bank", { bankName: "MOCK BANK" }, "MOCK BANK"],
    ["account", { bankAccountNo: "0000000000" }, "all zeros"],
    ["prefix", { invoicePrefix: "GDA-DEV" }, "-DEV"],
    ["seed address", { address: "Example address (seed data, not a real address)" }, "seed data"],
    ["seed bank", { bankName: "Example Bank (seed data)" }, "seed data"],
  ] as const)("flags a mock %s", (_n, over, text) => {
    const reasons = billingMockReasons(goodBilling(over));
    expect(reasons.join(" ")).toContain(text);
  });
  it("flags nothing on a real-looking profile (a null bank block included)", () => {
    expect(billingMockReasons(goodBilling())).toEqual([]);
    expect(billingMockReasons(goodBilling({ bankName: null, bankAccountNo: null }))).toEqual([]);
  });
  it("BLOCKs and names every mock company, PASSes when none is", () => {
    const facts = [tf("Merchant Co", { tenantId: MERCHANT, billing: goodBilling({ invoicePrefix: "SFL-DEV" }) }), tf("Other Co")];
    const r = checkBillingMock(facts);
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("1 of 2 billing profiles");
    expect(r.evidence).toContain("Merchant Co");
    expect(checkBillingMock(cleanFacts()).status).toBe("PASS");
  });
  it("never prints the account number", () => {
    const r = checkBillingMock([tf("Mock Co", { billing: goodBilling({ bankAccountNo: "0000000000", legalName: "X DEV MOCK" }) })]);
    expect(r.evidence).not.toContain("0000000000");
  });
  it("is ERROR when no billing profile is visible at all (a control, not a PASS)", () => {
    const r = checkBillingMock([tf("A", { billing: null }), tf("B", { billing: null })]);
    expect(r.status).toBe("ERROR");
  });
});

describe("PGL-01 · seal.mock", () => {
  it("PASSes when each active certificate names its company's billing legal name (case and spacing aside)", () => {
    const facts = [tf("A", { sealCerts: [{ subject: "  studio fake ltd " }] }), tf("B", { sealCerts: [] })];
    expect(checkSealMock(facts).status).toBe("PASS");
  });
  it("BLOCKs a DEV MOCK subject", () => {
    const facts = [tf("A", { billing: goodBilling({ legalName: "Studio (DEV MOCK)" }), sealCerts: [{ subject: "Studio (DEV MOCK)" }] })];
    const r = checkSealMock(facts);
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("DEV MOCK");
  });
  it("BLOCKs a subject that does not match the billing legal name", () => {
    const r = checkSealMock([tf("A", { sealCerts: [{ subject: "Some Other Name" }] })]);
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("does not match");
  });
  it("BLOCKs a certificate on a company with no billing profile", () => {
    const r = checkSealMock([tf("A", { billing: null, sealCerts: [{ subject: "X" }] }), tf("B")]);
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("no billing profile");
  });
  it("BLOCKs when there is no active certificate anywhere (nothing to verify is not a PASS)", () => {
    const r = checkSealMock([tf("A", { sealCerts: [] }), tf("B", { sealCerts: [] })]);
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("no active seal certificate");
  });
  it("is ERROR when a control fails", () => {
    expect(checkSealMock([tf("A", { contextOk: false, contextProblem: "x" })]).status).toBe("ERROR");
  });
});

describe("PGL-01 · placeholders.p03 and p04", () => {
  it("PASSes both on a clean estate", () => {
    const [p03, p04] = checkPlaceholders(cleanFacts());
    expect(p03.status).toBe("PASS");
    expect(p04.status).toBe("PASS");
  });
  it("p03 BLOCKs on an active portal@*.test contact and lists the clients (once each)", () => {
    const facts = [tf("A", { contacts: [
      contact({ email: "portal@alpha-fake.test", clientName: "Alpha Surf" }),
      contact({ email: "portal@alpha-fake.test", clientName: "Alpha Surf", capability: "signer" }),
      contact({ email: "portal@beta-fake.test", clientName: "Beta Cafe" }),
    ] })];
    const [p03, p04] = checkPlaceholders(facts);
    expect(p03.status).toBe("BLOCK");
    expect(p03.evidence).toContain("3 active portal@*.test");
    expect(p03.evidence).toContain("2 client(s): Alpha Surf, Beta Cafe");
    expect(p04.status).toBe("PASS"); // those users are kind client
  });
  it("p03 matches the address case-insensitively and only the portal@ local part on a .test domain", () => {
    const hit = checkPlaceholders([tf("A", { contacts: [contact({ email: "Portal@X-Fake.TEST" })] })])[0];
    expect(hit.status).toBe("BLOCK");
    const miss = checkPlaceholders([tf("A", { contacts: [contact({ email: "portal@x-fake.com" }), contact({ email: "other@x-fake.test" })] })])[0];
    expect(miss.status).toBe("PASS");
  });
  it("p04 BLOCKs when a non-client user holds an ACTIVE signer contact, naming the user and the count", () => {
    const facts = [tf("A", { contacts: [
      contact({ capability: "signer", email: "owner@staff-fake.com", kind: "employee", clientName: "Client One" }),
      contact({ capability: "signer", email: "owner@staff-fake.com", kind: "employee", clientName: "Client Two" }),
    ] })];
    const [, p04] = checkPlaceholders(facts);
    expect(p04.status).toBe("BLOCK");
    expect(p04.evidence).toContain("owner@staff-fake.com");
    expect(p04.evidence).toContain("2 contact row(s) across 2 client(s)");
  });
  it("p04 treats an ADMIN contact like a signer (portal-scope.ts: admin signs too)", () => {
    const [, p04] = checkPlaceholders([tf("A", { contacts: [contact({ capability: "admin", email: "boss@staff-fake.com", kind: "employee" })] })]);
    expect(p04.status).toBe("BLOCK");
    expect(p04.evidence).toContain("boss@staff-fake.com");
  });
  it("p04 is WARN for a staff VIEWER contact only", () => {
    const [, p04] = checkPlaceholders([tf("A", { contacts: [contact({ email: "staff@staff-fake.com", kind: "employee" })] })]);
    expect(p04.status).toBe("WARN");
  });
  it("p04 BLOCKs on a signer and still mentions a staff viewer", () => {
    const facts = [tf("A", { contacts: [
      contact({ capability: "signer", email: "a@staff-fake.com", kind: "employee" }),
      contact({ capability: "viewer", email: "b@staff-fake.com", kind: "bot" }),
    ] })];
    const [, p04] = checkPlaceholders(facts);
    expect(p04.status).toBe("BLOCK");
    expect(p04.evidence).toContain("also staff viewer");
  });
  it("both are ERROR (exit 2) when a control reads zero, never PASS", () => {
    const facts = [tf("A", { contactsTotal: 0 }), tf("B", { contactsTotal: 0 })];
    const rs = checkPlaceholders(facts);
    expect(rs.map((r) => r.status)).toEqual(["ERROR", "ERROR"]);
    const unset = checkPlaceholders([tf("A", { contextOk: false, contextProblem: "the tenant setting is unset" })]);
    expect(unset.map((r) => r.status)).toEqual(["ERROR", "ERROR"]);
  });
});

describe("PGL-01 · mail.sender and mail.client", () => {
  it.each([
    ["a bare address", "hello@studio-fake.net", "studio-fake.net"],
    ["a display name", "Studio <hello@studio-fake.net>", "studio-fake.net"],
    ["upper case", "Studio <Hello@Studio-Fake.NET>", "studio-fake.net"],
    ["no domain", "nonsense", ""],
  ])("fromDomain reads %s", (_n, from, domain) => expect(fromDomain(from)).toBe(domain));

  it("PASSes with mail on, a real relay host and a real From domain", () => {
    expect(checkMailSender(cleanEnv()).status).toBe("PASS");
  });
  it("BLOCKs when mail is off", () => {
    const r = checkMailSender(cleanEnv({ mail: { enabled: false } }));
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("MAIL_ENABLED");
  });
  it("BLOCKs a mailpit relay and an empty host", () => {
    expect(checkMailSender(cleanEnv({ mail: { host: "mailpit" } })).evidence).toContain("mailpit");
    expect(checkMailSender(cleanEnv({ mail: { host: "Mailpit.internal" } })).status).toBe("BLOCK");
    expect(checkMailSender(cleanEnv({ mail: { host: "" } })).evidence).toContain("no relay host");
  });
  it.each(["no-reply@notify.gaiada.invalid", "Dev <dev@studio-fake.test>", "x@host.example", "x@mail.localhost"])("BLOCKs the reserved From domain in %s", (from) => {
    const r = checkMailSender(cleanEnv({ mail: { from } }));
    expect(r.status).toBe("BLOCK");
    expect(r.evidence).toContain("reserved domain");
  });
  it("names the brevo host when that transport is selected", () => {
    const r = checkMailSender(cleanEnv({ mail: { transport: "brevo", host: "" } }));
    expect(r.evidence).toContain("no brevo host");
  });
  it("mail.client PASSes on CLIENT_MAIL_ENABLED or on the alias, BLOCKs when neither is 1", () => {
    expect(checkMailClient(cleanEnv()).evidence).toContain("CLIENT_MAIL_ENABLED is 1");
    const alias = checkMailClient(cleanEnv({ mail: { clientMailEnabled: false, conversationClientMailEnabled: true } }));
    expect(alias.status).toBe("PASS");
    expect(alias.evidence).toContain("CONVERSATION_CLIENT_MAIL_ENABLED");
    expect(checkMailClient(cleanEnv({ mail: { clientMailEnabled: false } })).status).toBe("BLOCK");
  });
});

describe("PGL-01 · data.simulated and the manual lines", () => {
  it("is INFO, sums payments and signatures, and counts DISTINCT simulated MFA sessions across companies", () => {
    const facts = [
      tf("A", { simulated: { checkouts: 3, checkoutsPaid: 2, signatures: 1, mfaSessions: ["s1", "s2"] } }),
      tf("B", { simulated: { checkouts: 1, checkoutsPaid: 0, signatures: 4, mfaSessions: ["s2", "s3"] } }),
    ];
    const r = checkDataSimulated(facts);
    expect(r.status).toBe("INFO");
    expect(r.evidence).toContain("4 payment checkout(s) (2 paid)");
    expect(r.evidence).toContain("5 contract signature(s)");
    expect(r.evidence).toContain("3 simulated MFA step-up(s)");
    expect(r.evidence).toContain("PGL-Q1");
  });
  it("is ERROR when the tenant context was not proven", () => {
    expect(checkDataSimulated([tf("A", { contextOk: false, contextProblem: "x" })]).status).toBe("ERROR");
  });
  it("legal.gate1, mail.deliverability and contrast.manual are MANUAL with a clearing step", () => {
    const m = manualChecks();
    expect(m.map((x) => x.id)).toEqual(["legal.gate1", "mail.deliverability", "contrast.manual"]);
    for (const x of m) {
      expect(x.status).toBe("MANUAL");
      expect(x.evidence).toContain("runbook");
    }
  });
});

describe("PGL-01 · the whole run", () => {
  const PLAN_IDS = [
    "mfa.simulation", "mfa.real", "payments.simulation", "payments.keys", "signatures.simulation", "billing.mock", "seal.mock",
    "placeholders.p03", "placeholders.p04", "mail.sender", "mail.client", "data.simulated", "legal.gate1", "mail.deliverability",
    "contrast.manual",
  ];
  it("emits every plan id exactly once, in the plan's order", () => {
    expect(evaluate(cleanEnv(), cleanFacts()).map((c) => c.id)).toEqual(PLAN_IDS);
  });
  it("a clean snapshot exits 0 (the MANUAL lines remain)", () => {
    const rs = evaluate(cleanEnv(), cleanFacts());
    expect(rs.filter((c) => c.status === "BLOCK" || c.status === "ERROR")).toEqual([]);
    expect(exitCodeFor(rs)).toBe(0);
  });
  it("with every tenant setting unset EVERY database-backed line is ERROR and the exit code is 2", () => {
    const facts = [tf("A", { contextOk: false, contextProblem: "the tenant setting is unset", clients: 0, contactsTotal: 0, billing: null })];
    const rs = evaluate(cleanEnv(), facts);
    for (const id of ["billing.mock", "seal.mock", "placeholders.p03", "placeholders.p04", "data.simulated"]) {
      expect(byId(rs, id).status, id).toBe("ERROR");
    }
    expect(rs.some((c) => c.status === "PASS" && ["billing.mock", "seal.mock", "placeholders.p03", "placeholders.p04"].includes(c.id))).toBe(false);
    expect(exitCodeFor(rs)).toBe(2);
  });
  it("the review-stage environment BLOCKs every environment check", () => {
    const env = cleanEnv({
      mfaSimulationEnabled: true, signatureSimulationEnabled: true,
      payments: { simulationEnabled: true, environment: "simulated", serverKeyClass: "SIM-" },
      mail: { enabled: false, host: "mailpit", from: "x@notify.gaiada.invalid", clientMailEnabled: false },
    });
    const rs = evaluate(env, cleanFacts());
    for (const id of ["mfa.simulation", "payments.simulation", "payments.keys", "signatures.simulation", "mail.sender", "mail.client"]) {
      expect(byId(rs, id).status, id).toBe("BLOCK");
    }
    expect(exitCodeFor(rs)).toBe(1);
  });
});

describe("PGL-01 · output and arguments", () => {
  const report = (checks: CheckResult[]): ReadinessReport => {
    const counts = { PASS: 0, BLOCK: 0, WARN: 0, INFO: 0, MANUAL: 0, ERROR: 0 };
    for (const c of checks) counts[c.status]++;
    const exitCode = exitCodeFor(checks);
    return {
      generatedAt: "2026-10-26T00:00:00.000Z", readOnly: true, companies: 2, exitCode, counts, checks,
      verdict: exitCode === 2 ? "INCOMPLETE" : exitCode === 1 ? "BLOCKED" : "NO AUTOMATED BLOCKERS",
    };
  };
  it("prints one line per check with its status and id, then a result line", () => {
    const rs = evaluate(cleanEnv({ mfaSimulationEnabled: true }), cleanFacts());
    const text = renderText(report(rs));
    const lines = text.split("\n");
    expect(lines).toHaveLength(rs.length + 2); // header, one per check, result (the MANUAL note appears at exit 0 only)
    expect(lines.filter((l) => /^(PASS|BLOCK|WARN|INFO|MANUAL|ERROR)\s+\S+\.\S+\s/.test(l))).toHaveLength(rs.length);
    expect(text).toMatch(/^BLOCK\s+mfa\.simulation\s/m);
    expect(text).toContain("result: BLOCKED");
    expect(text).toContain("exit 1");
  });
  it("the JSON form carries the same checks and exit code", () => {
    const rs = evaluate(cleanEnv(), cleanFacts());
    const rep = report(rs);
    const parsed = JSON.parse(JSON.stringify(rep));
    expect(parsed.checks).toEqual(rs);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.readOnly).toBe(true);
  });
  it("parses --json and --help and refuses anything else (exit 2 in main)", () => {
    expect(parseArgs([])).toEqual({ json: false, help: false });
    expect(parseArgs(["--json"])).toEqual({ json: true, help: false });
    expect(parseArgs(["--help"])).toEqual({ json: false, help: true });
    expect(() => parseArgs(["--apply"])).toThrow(/unknown argument --apply/);
  });
});

describe("PGL-01 · the snapshot reads the code's own names and never keeps a secret", () => {
  const saved = {
    mfa: config.mfaSimulationEnabled, sig: config.signatureSimulationEnabled,
    pay: { ...config.payments.midtrans }, paySim: config.payments.simulationEnabled,
    mail: config.mail.enabled, conv: config.mail.conversationClientMailEnabled,
    transport: config.mail.streams.notify.transport, from: config.mail.streams.notify.from,
    relay: { ...config.mail.streams.notify.relay }, brevo: { ...config.mail.streams.notify.brevo },
  };
  afterEach(() => {
    config.mfaSimulationEnabled = saved.mfa;
    config.signatureSimulationEnabled = saved.sig;
    Object.assign(config.payments.midtrans, saved.pay);
    config.payments.simulationEnabled = saved.paySim;
    config.mail.enabled = saved.mail;
    config.mail.conversationClientMailEnabled = saved.conv;
    config.mail.streams.notify.transport = saved.transport;
    config.mail.streams.notify.from = saved.from;
    Object.assign(config.mail.streams.notify.relay, saved.relay);
    Object.assign(config.mail.streams.notify.brevo, saved.brevo);
  });

  it("reads the flags and the key's prefix class from config, and keeps no key value anywhere in the snapshot", () => {
    const secret = "SIM-top-secret-value-123";
    config.mfaSimulationEnabled = true;
    config.signatureSimulationEnabled = true;
    config.payments.simulationEnabled = true;
    config.payments.midtrans.serverKey = secret;
    config.payments.midtrans.environment = " simulated ";
    config.payments.midtrans.tenantId = ` ${MERCHANT} `;
    const snap = snapshotFromConfig({});
    expect(snap.mfaSimulationEnabled).toBe(true);
    expect(snap.signatureSimulationEnabled).toBe(true);
    expect(snap.payments).toMatchObject({ simulationEnabled: true, environment: "simulated", serverKeySet: true, serverKeyClass: "SIM-", tenantId: MERCHANT });
    expect(JSON.stringify(snap)).not.toContain("top-secret");
    // and nothing downstream can print it either
    const out = renderText({
      generatedAt: "x", readOnly: true, companies: 1, exitCode: 1, verdict: "BLOCKED", counts: { PASS: 0, BLOCK: 1, WARN: 0, INFO: 0, MANUAL: 0, ERROR: 0 },
      checks: [checkPaymentsKeys(snap, cleanFacts())],
    });
    expect(out).not.toContain("top-secret");
    expect(out).toContain("SIM-");
  });
  it("classes keys: unset, SB-, other", () => {
    for (const [key, cls] of [["", null], ["SB-abc", "SB-"], ["Mid-server-xyz", "other"]] as const) {
      config.payments.midtrans.serverKey = key;
      const snap = snapshotFromConfig({});
      expect(snap.payments.serverKeyClass).toBe(cls);
      expect(snap.payments.serverKeySet).toBe(key.length > 0);
    }
  });
  it("reads the notify stream's host for the selected transport, and CLIENT_MAIL_ENABLED only when it is exactly 1", () => {
    config.mail.enabled = true;
    config.mail.streams.notify.transport = "relay";
    config.mail.streams.notify.relay.host = " relay.mailer-fake.net ";
    config.mail.streams.notify.brevo.host = "brevo.mailer-fake.net";
    config.mail.streams.notify.from = "Studio <hello@studio-fake.net>";
    expect(snapshotFromConfig({}).mail).toMatchObject({ enabled: true, transport: "relay", host: "relay.mailer-fake.net", clientMailEnabled: false });
    config.mail.streams.notify.transport = "brevo";
    expect(snapshotFromConfig({ CLIENT_MAIL_ENABLED: "1" }).mail).toMatchObject({ transport: "brevo", host: "brevo.mailer-fake.net", clientMailEnabled: true });
    expect(snapshotFromConfig({ CLIENT_MAIL_ENABLED: "true" }).mail.clientMailEnabled).toBe(false);
    expect(snapshotFromConfig({ CLIENT_MAIL_ENABLED: "" }).mail.clientMailEnabled).toBe(false);
  });
});
