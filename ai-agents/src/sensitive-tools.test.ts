// M5-G5c — the sensitive-tool policy registry, the agency_privacy.* policy and the literal scrubber (unit, no
// services). The run-level proof (a real runner goal, the whole store) is sensitive-run.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  AGENCY_PRIVACY_TOOL_NAMES, MINIMISED_MARKER, SUBJECT_HASH_DOMAIN, SensitiveScope, emailHint, getSensitiveToolPolicy,
  holdsSensitiveTool, intentArgsFor, listSensitiveToolNames, normalizeEmail, normalizePhone, phoneHint, registerSensitiveToolPolicy,
  subjectHash, unregisterSensitiveToolPolicy, type SensitiveToolPolicy,
} from "./sensitive-tools";

const LEAD = "11111111-1111-4111-8111-111111111111";
const LEAD2 = "22222222-2222-4222-8222-222222222222";

describe("subjectHash: byte-for-byte the ERP's (platform-nest core/agency-privacy.subject.ts)", () => {
  // These vectors were COMPUTED BY THE ERP IMPLEMENTATION (`npx tsx` importing platform-nest's
  // agency-privacy.subject.ts and calling its subjectHash/normalizeEmail/normalizePhone), not by this module.
  // If either side's normalisation or domain changes, this fails here and the two ledgers stop correlating.
  const ERP = {
    email: "d2525f84f97f4bb9b3a5f56f2cf67509b10946f73b1f39cbbe70f0d202ad4441", // normalizeEmail("Jane.Doe@Example.com")
    phoneIntl: "da965e2c4c8051018d9ee0d3b82d5cd8a2ddcf4d6ebc25282f65a17cc4f8f14e", // normalizePhone("+62 812-3456-7890")
    phoneNational: "d19f221dccce7d0e008ac26e92b70092a60b085f30667a2c7fd2fb91c7a87611", // normalizePhone("0812 3456 789")
    ayu: "b681c35c2b58f4efabfa74e18c1a93b15498ef24aae415d24c662c79b1b150bb", // subjectHash("ayu@example.com") (the ERP unit test's own value)
  };

  it("domain, normalisation and digest match the ERP vectors", () => {
    expect(SUBJECT_HASH_DOMAIN).toBe("webdesk:privacy:subject:");
    expect(subjectHash(normalizeEmail("Jane.Doe@Example.com")!)).toBe(ERP.email);
    expect(subjectHash(normalizePhone("+62 812-3456-7890")!)).toBe(ERP.phoneIntl);
    expect(subjectHash(normalizePhone("0062 81234567890")!)).toBe(ERP.phoneIntl);
    expect(subjectHash(normalizePhone("0812 3456 789")!)).toBe(ERP.phoneNational);
    expect(subjectHash("ayu@example.com")).toBe(ERP.ayu);
    expect(ERP.ayu).toBe(createHash("sha256").update("webdesk:privacy:subject:ayu@example.com").digest("hex"));
  });

  it("normalisation edge cases mirror the ERP's", () => {
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("12345")).toBeNull(); // < 7 digits
    expect(normalizePhone("1234567890123456")).toBeNull(); // > 15 digits
    expect(normalizePhone("0812 3456 789")).toBe("081234567" + "89"); // a national leading 0 is NOT rewritten
  });

  it("hints are the ERP's: ***@domain and ***NN", () => {
    expect(emailHint("jane.doe@example.com")).toBe("***@example.com");
    expect(phoneHint("6281234567890")).toBe("***90");
  });
});

describe("agency_privacy.* policy: args", () => {
  const names = [...AGENCY_PRIVACY_TOOL_NAMES];
  it("covers exactly the three hub tool names", () => {
    expect(names).toEqual(["agency_privacy.find", "agency_privacy.export", "agency_privacy.erase"]);
    for (const n of names) expect(getSensitiveToolPolicy(n)).toBeDefined();
  });

  it("keeps ONLY {minimised, hashes, hints}; the identifier and every other key is dropped", () => {
    const p = getSensitiveToolPolicy("agency_privacy.erase")!;
    const out = p.minimiseArgs({
      tenantId: "t1", email: "  Jane.Doe@Example.com ", phone: "+62 812-3456-7890",
      approvalId: "33333333-3333-4333-8333-333333333333", query: "jane.doe@example.com", Email: "x@y.z", reason: "because",
    });
    expect(Object.keys(out).sort()).toEqual(["hashes", "hints", "minimised"]);
    expect(out).toEqual({
      minimised: "agency-privacy.v1",
      hashes: {
        emailHash: subjectHash("jane.doe@example.com"),
        phoneHash: subjectHash("6281234567890"),
      },
      hints: { emailHint: "***@example.com", phoneHint: "***90" },
    });
    expect(MINIMISED_MARKER).toBe("agency-privacy.v1");
    const text = JSON.stringify(out);
    for (const leak of ["jane", "Jane", "812", "t1", "because", "x@y.z"]) expect(text).not.toContain(leak);
  });

  it("an email alone, a phone alone, and nothing/garbage all yield a well-formed minimised shape", () => {
    const p = getSensitiveToolPolicy("agency_privacy.find")!;
    expect(p.minimiseArgs({ email: "a@b.co" })).toEqual({
      minimised: MINIMISED_MARKER, hashes: { emailHash: subjectHash("a@b.co") }, hints: { emailHint: "***@b.co" },
    });
    expect(p.minimiseArgs({ phone: "081234567" })).toEqual({
      minimised: MINIMISED_MARKER, hashes: { phoneHash: subjectHash("081234567") }, hints: { phoneHint: "***67" },
    });
    // a malformed value is NOT stored un-hashed: it simply yields no hash and no hint
    expect(p.minimiseArgs({ email: "not an email", phone: "call me" })).toEqual({ minimised: MINIMISED_MARKER, hashes: {}, hints: {} });
    expect(p.minimiseArgs({ email: 42, phone: null })).toEqual({ minimised: MINIMISED_MARKER, hashes: {}, hints: {} });
    expect(p.minimiseArgs(null as unknown as Record<string, unknown>)).toEqual({ minimised: MINIMISED_MARKER, hashes: {}, hints: {} });
  });

  it("is idempotent on its own output (a minimised shape carries no email/phone key to re-read)", () => {
    const p = getSensitiveToolPolicy("agency_privacy.export")!;
    const once = p.minimiseArgs({ email: "jane.doe@example.com" });
    expect(p.minimiseArgs(once)).toEqual({ minimised: MINIMISED_MARKER, hashes: {}, hints: {} }); // never re-hashes a hash
  });
});

describe("agency_privacy.* policy: results keep counts, ids and status only", () => {
  const p = getSensitiveToolPolicy("agency_privacy.export")!;

  it("an export (the person's data itself) reduces to ids, statuses and counts", () => {
    const raw = JSON.stringify({
      kind: "export",
      leads: [{
        leadId: LEAD, status: "new", stage: "intake", orgName: "Acme Spa", contactName: "Jane Doe",
        contactEmail: "jane.doe@example.com", contactPhone: "+62 812-3456-7890", declinedReason: "too expensive, call Jane",
        submissions: [{ submissionId: LEAD2, answers: { person: "Jane Doe", note: "free text" } }],
      }],
      outOfScope: [{ leadId: LEAD2, convertedClientId: "c-1", reason: "client_record_retention" }],
      counts: { leadCount: 1, submissionCount: 3, tokenCount: 2, outOfScopeCount: 1, suppressionCount: 0, extra: 9 },
    });
    const out = JSON.parse(p.minimiseResult(raw));
    expect(out).toEqual({
      minimised: MINIMISED_MARKER, kind: "export",
      counts: { leadCount: 1, submissionCount: 3, tokenCount: 2, outOfScopeCount: 1, suppressionCount: 0 },
      leads: [{ leadId: LEAD, status: "new" }],
      outOfScopeLeadIds: [LEAD2],
    });
    const text = p.minimiseResult(raw);
    for (const leak of ["Jane", "jane.doe", "812", "Acme", "expensive", "free text"]) expect(text).not.toContain(leak);
  });

  it("the route's own 202 and erase responses: outcome, ids, flat counts, replayed", () => {
    const suspended = JSON.parse(p.minimiseResult(JSON.stringify({
      outcome: "suspended", requestId: LEAD, approvalId: LEAD2, message: "call again for jane.doe@example.com",
    })));
    expect(suspended).toEqual({ minimised: MINIMISED_MARKER, outcome: "suspended", requestId: LEAD, approvalId: LEAD2 });
    const erased = JSON.parse(p.minimiseResult(JSON.stringify({
      kind: "erase", erasedAt: "2026-10-12T10:00:00.000Z", replayed: true, approvalId: LEAD2,
      leadCount: 2, submissionCount: 1, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 2,
    })));
    expect(erased).toEqual({
      minimised: MINIMISED_MARKER, kind: "erase", erasedAt: "2026-10-12T10:00:00.000Z", replayed: true, approvalId: LEAD2,
      counts: { leadCount: 2, submissionCount: 1, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 2 },
    });
  });

  it("a hostile value in an allow-listed slot is dropped, not stored", () => {
    const out = JSON.parse(p.minimiseResult(JSON.stringify({
      outcome: "jane.doe@example.com", kind: "jane", approvalId: "jane.doe@example.com", requestId: "x",
      erasedAt: "jane", counts: { leadCount: "jane.doe@example.com", submissionCount: -1, tokenCount: 1.5 },
      leads: [{ leadId: "jane.doe@example.com", status: "Jane Doe" }, { leadId: LEAD, status: "Jane Doe" }],
      outOfScope: [{ leadId: "jane.doe@example.com" }],
    })));
    expect(out).toEqual({ minimised: MINIMISED_MARKER, leads: [{ leadId: LEAD }], outOfScopeLeadIds: [] });
  });

  it("anything that is not JSON (an error text, a stringified page) is reduced to its size", () => {
    const out = JSON.parse(p.minimiseResult("Jane Doe <jane.doe@example.com> was not found"));
    expect(out).toEqual({ minimised: MINIMISED_MARKER, unparsed: true, bytes: 45 });
    expect(JSON.parse(p.minimiseResult("[1,2]"))).toEqual({ minimised: MINIMISED_MARKER, unparsed: true, bytes: 5 });
  });
});

describe("SensitiveScope: scrubbing the literals a policy tool call revealed", () => {
  it("inactive: the identity function (every non-sensitive run stays byte-identical)", () => {
    const s = new SensitiveScope();
    expect(s.active).toBe(false);
    const text = "mail jane.doe@example.com or +62 812-3456-7890";
    expect(s.scrub(text)).toBe(text);
    const blackboard = [{ task: text }];
    expect(s.scrubDeep(blackboard)).toBe(blackboard); // same object, not a copy
  });

  it("observeCall registers a policy tool's real values and ignores a tool with no policy", () => {
    const s = new SensitiveScope();
    expect(s.observeCall("contacts.lookup", { email: "jane.doe@example.com" })).toBe(false);
    expect(s.active).toBe(false);
    expect(s.observeCall("agency_privacy.erase", { email: "Jane.Doe@Example.com", phone: "+62 812-3456-7890" })).toBe(true);
    expect(s.active).toBe(true);
  });

  it("email: raw, lower-cased, upper-cased and embedded forms all become the hint", () => {
    const s = new SensitiveScope();
    s.observeCall("agency_privacy.find", { email: "Jane.Doe@Example.com" });
    expect(s.scrub("a Jane.Doe@Example.com b jane.doe@example.com c JANE.DOE@EXAMPLE.COM d")).toBe(
      "a ***@example.com b ***@example.com c ***@example.com d",
    );
  });

  it("phone: every punctuation of the same number, with or without the + / 00, becomes the hint", () => {
    const s = new SensitiveScope();
    s.observeCall("agency_privacy.find", { phone: "+62 812-3456-7890" });
    for (const form of ["+62 812-3456-7890", "6281234567890", "+6281234567890", "0062 812 3456 7890", "62 (812) 3456-7890"]) {
      expect(s.scrub(`call ${form} now`)).toBe("call ***90 now");
    }
    // a longer digit run that merely CONTAINS the digits is a different number, not this one
    expect(s.scrub("id 16281234567890")).toBe("id 16281234567890");
    // the surrounding space is not eaten
    expect(s.scrub("x 6281234567890")).toBe("x ***90");
  });

  it("a malformed value somebody typed is still scrubbed (as [redacted]), never stored", () => {
    const s = new SensitiveScope();
    s.observeCall("agency_privacy.erase", { email: "jane at example dot com" });
    expect(s.scrub("erase jane at example dot com please")).toBe("erase [redacted] please");
  });

  it("seedFromText finds the emails and phone numbers in a goal, but not an ISO date", () => {
    const s = new SensitiveScope();
    s.seedFromText("Erase jane.doe@example.com, phone +62 812 3456 7890, requested 2026-10-12 under ticket 12345");
    expect(s.scrub("Erase jane.doe@example.com, phone +62 812 3456 7890, requested 2026-10-12 under ticket 12345")).toBe(
      "Erase ***@example.com, phone ***90, requested 2026-10-12 under ticket 12345",
    );
  });

  it("scrubDeep walks nested JSON and leaves non-strings alone", () => {
    const s = new SensitiveScope();
    s.observeCall("agency_privacy.find", { email: "jane.doe@example.com" });
    const out = s.scrubDeep([{ specialist: "x", task: "find jane.doe@example.com", n: 3, ok: true, nested: { a: ["jane.doe@example.com"] } }]);
    expect(out).toEqual([{ specialist: "x", task: "find ***@example.com", n: 3, ok: true, nested: { a: ["***@example.com"] } }]);
  });

  it("recordableArgs / recordableResult: the policy's copy for a policy tool, the value itself otherwise", () => {
    const s = new SensitiveScope();
    const args = { email: "jane.doe@example.com", other: 1 };
    expect(s.recordableArgs("crm.lookup", args)).toBe(args);
    expect(s.recordableResult("crm.lookup", "raw text jane.doe@example.com")).toBe("raw text jane.doe@example.com");
    expect(s.recordableArgs("agency_privacy.find", args)).toMatchObject({ minimised: MINIMISED_MARKER });
  });
});

describe("M5-G5d: intentArgsFor, the shape a SUSPENDED call is handed over in", () => {
  const APPROVAL = "33333333-3333-4333-8333-333333333333";

  it("a policy tool gets the ERP's already-minimised shape: kind from the tool name, hashes and hints, safe ids", () => {
    const out = intentArgsFor("agency_privacy.erase", {
      tenantId: "t1", email: "  Jane.Doe@Example.com ", phone: "+62 812-3456-7890", approvalId: APPROVAL, query: "jane.doe@example.com", reason: "because",
    });
    expect(out).toEqual({
      minimised: MINIMISED_MARKER, kind: "erase", identifiers: ["email", "phone"], tenantId: "t1", approvalId: APPROVAL,
      subject: {
        emailHash: subjectHash("jane.doe@example.com"), emailHint: "***@example.com",
        phoneHash: subjectHash("6281234567890"), phoneHint: "***90",
      },
    });
    const text = JSON.stringify(out).toLowerCase();
    for (const f of ["jane.doe", "6281234567890", "812-3456", "because"]) expect(text).not.toContain(f);
    expect(intentArgsFor("agency_privacy.find", { phone: "0812 3456 789" })).toMatchObject({ kind: "find", identifiers: ["phone"] });
    expect(intentArgsFor("agency_privacy.export", { email: "a@b.co" })).toMatchObject({ kind: "export", identifiers: ["email"] });
  });

  it("is idempotent in effect: an approvalId-only call keeps just the id and no subject", () => {
    expect(intentArgsFor("agency_privacy.erase", { approvalId: APPROVAL })).toEqual({
      minimised: MINIMISED_MARKER, kind: "erase", identifiers: [], approvalId: APPROVAL,
    });
  });

  it("a present-but-malformed identifier empties the whole shape (no silent narrowing); an unsafe id is dropped", () => {
    expect(intentArgsFor("agency_privacy.erase", { email: "jane@example.com", phone: "nope", approvalId: APPROVAL })).toEqual({
      minimised: MINIMISED_MARKER, kind: "erase", identifiers: [],
    });
    expect(intentArgsFor("agency_privacy.erase", { email: "not an email" })).toEqual({ minimised: MINIMISED_MARKER, kind: "erase", identifiers: [] });
    expect(intentArgsFor("agency_privacy.erase", { email: "a@b.co", tenantId: "x y; drop" })).not.toHaveProperty("tenantId");
    // never throws on junk
    for (const junk of [{}, { email: 5 }, { email: ["a@b.co"] }, { phone: {} }] as Record<string, unknown>[]) expect(() => intentArgsFor("agency_privacy.erase", junk)).not.toThrow();
  });

  it("a tool with no policy gets the SAME args object back (regression)", () => {
    const args = { email: "jane.doe@example.com", other: 1 };
    expect(intentArgsFor("crm.lookup", args)).toBe(args);
  });
});

describe("the registry is generic: another tool can opt in; a tool with no policy is untouched", () => {
  const fixture: SensitiveToolPolicy = {
    toolName: "crm.lookupPerson",
    minimiseArgs: (a) => ({ minimised: "fixture.v1", nameLen: typeof a.name === "string" ? a.name.length : 0 }),
    minimiseIntentArgs: () => ({ minimised: "fixture.v1" }),
    minimiseResult: (r) => JSON.stringify({ minimised: "fixture.v1", bytes: r.length }),
    secretsOf: (a) => (typeof a.name === "string" ? [{ kind: "text", value: a.name }] : []),
  };
  afterEach(() => unregisterSensitiveToolPolicy("crm.lookupPerson"));

  it("register, use, unregister; a duplicate or an attempt to remove a built-in throws", () => {
    expect(getSensitiveToolPolicy("crm.lookupPerson")).toBeUndefined();
    registerSensitiveToolPolicy(fixture);
    expect(listSensitiveToolNames()).toContain("crm.lookupPerson");
    expect(() => registerSensitiveToolPolicy(fixture)).toThrow(/already registered/);
    expect(() => registerSensitiveToolPolicy({ ...fixture, toolName: "agency_privacy.erase" })).toThrow(/already registered/);
    expect(() => unregisterSensitiveToolPolicy("agency_privacy.erase")).toThrow(/built-in/);

    const s = new SensitiveScope();
    expect(s.observeCall("crm.lookupPerson", { name: "Ayu Sari" })).toBe(true);
    expect(s.scrub("found Ayu Sari (ayu sari)")).toBe("found [redacted] ([redacted])");
    expect(s.recordableArgs("crm.lookupPerson", { name: "Ayu Sari" })).toEqual({ minimised: "fixture.v1", nameLen: 8 });
  });

  it("holdsSensitiveTool reads an agent's allow-list", () => {
    expect(holdsSensitiveTool({ tools: { "x.read": "read" } })).toBe(false);
    expect(holdsSensitiveTool({ tools: { "x.read": "read", "agency_privacy.find": "high_write" } })).toBe(true);
    registerSensitiveToolPolicy(fixture);
    expect(holdsSensitiveTool({ tools: { "crm.lookupPerson": "read" } })).toBe(true);
  });
});
