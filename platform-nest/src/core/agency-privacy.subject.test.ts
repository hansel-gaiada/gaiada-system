// M5-G5 — the pure subject rules: normalisation (WebDesk parity), hashing (WebDesk-compatible), body parsing,
// matching, and the AD-1 scrub. No database, no services.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  AD1_PERSON_FIELDS, ERASED_MARKER, SUBJECT_HASH_DOMAIN, contactHashes, contactMatches, normalizeEmail, normalizePhone,
  parseSubject, scrubAnswers, subjectHash,
} from "./agency-privacy.subject";
import { QUESTIONNAIRE_SECTIONS } from "./agency-discovery-questionnaire";

describe("normalizePhone — byte-for-byte WebDesk parity (webdesk/api/src/forms/subject-refs.ts)", () => {
  // The same table WebDesk's own behaviour gives; a change here is a change to how two systems match one person.
  const table: [string, string | null][] = [
    ["+62 812-3456-7890", "6281234567890"],
    ["0062 812 3456 7890", "6281234567890"],
    ["(0812) 3456.7890", "081234567890"], // national 0 is NOT rewritten
    ["0812-3456-7890", "081234567890"],
    ["+44 20 7946 0958", "442079460958"],
    ["  +1 (555) 010-9999 ", "15550109999"],
    ["123456", null], // 6 digits: too short
    ["1234567", "1234567"], // 7: the floor
    ["1234567890123456", null], // 16: over E.164
    ["+62 812 x12", null], // letters (an extension) give no ref
    ["++62812345678", null], // a second +
    ["62+812345678", null], // + not leading
    ["", null],
  ];
  it.each(table)("%s -> %s", (raw, want) => {
    expect(normalizePhone(raw)).toBe(want);
  });
});

describe("normalizeEmail / subjectHash", () => {
  it("email is trim + lower-case; empty is null", () => {
    expect(normalizeEmail("  Ayu.Sari@Example.COM ")).toBe("ayu.sari@example.com");
    expect(normalizeEmail("   ")).toBeNull();
  });

  it("the hash is SHA-256 over WebDesk's own domain prefix (so the two DSR ledgers correlate)", () => {
    expect(SUBJECT_HASH_DOMAIN).toBe("webdesk:privacy:subject:");
    const want = createHash("sha256").update("webdesk:privacy:subject:ayu@example.com").digest("hex");
    expect(subjectHash("ayu@example.com")).toBe(want);
    expect(subjectHash("ayu@example.com")).toMatch(/^[0-9a-f]{64}$/);
    // A phone hashes on its digits, so every typed form of one number is one subject.
    expect(subjectHash(normalizePhone("+62 812-3456-7890")!)).toBe(subjectHash(normalizePhone("0062 81234567890")!));
  });
});

describe("parseSubject — a request body's { email?, phone? }", () => {
  it("accepts email, phone, or both, and hashes each", () => {
    const r = parseSubject({ email: " A@B.co ", phone: "+62 811 222 3333" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subject).toEqual({
      email: "a@b.co", phone: "628112223333", emailHash: subjectHash("a@b.co"), phoneHash: subjectHash("628112223333"),
    });
    const e = parseSubject({ email: "a@b.co" });
    expect(e.ok && e.subject.phone === null && e.subject.phoneHash === null).toBe(true);
  });

  it.each([
    [{}, "neither"],
    [null, "null body"],
    [{ email: "" }, "empty email"],
    [{ email: "not-an-email" }, "no @"],
    [{ email: 42 }, "non-string"],
    [{ email: `${"a".repeat(320)}@b.co` }, "over 320"],
    [{ phone: "12345" }, "short phone"],
    [{ phone: "call me" }, "letters"],
    // A malformed key next to a valid one refuses the whole request (never a half-ignored lookup).
    [{ email: "a@b.co", phone: "nope" }, "valid email + bad phone"],
  ] as [unknown, string][])("refuses %j (%s) with subject_invalid", (body) => {
    const r = parseSubject(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("subject_invalid");
  });

  it("an explicit null key is the same as an absent one", () => {
    expect(parseSubject({ email: "a@b.co", phone: null }).ok).toBe(true);
  });
});

describe("contactMatches / contactHashes", () => {
  const subject = { email: "ayu@example.com", phone: "6281234567890" };
  it("either key matching is enough, compared after normalisation", () => {
    expect(contactMatches(subject, { email: "AYU@example.com " })).toBe(true);
    expect(contactMatches(subject, { phone: "+62 812-3456-7890" })).toBe(true);
    expect(contactMatches(subject, { phone: "0812-3456-7890" })).toBe(false); // national form is another key
    expect(contactMatches(subject, { email: "other@example.com", phone: null })).toBe(false);
    expect(contactMatches({ email: null, phone: null }, { email: "ayu@example.com" })).toBe(false);
  });
  it("hashes only usable keys", () => {
    expect(contactHashes({ email: "Ayu@Example.com", phone: "abc" })).toEqual([{ kind: "email", hash: subjectHash("ayu@example.com") }]);
    expect(contactHashes({ email: null, phone: null })).toEqual([]);
  });
});

describe("AD1_PERSON_FIELDS — every name is a real question id", () => {
  it("each listed field exists in the current questionnaire (a renamed id would silently stop being scrubbed)", () => {
    const ids = new Set(QUESTIONNAIRE_SECTIONS.flatMap((s) => s.fields.map((f) => f.id)).filter(Boolean));
    for (const f of AD1_PERSON_FIELDS) expect(ids.has(f), f).toBe(true);
  });
});

describe("scrubAnswers", () => {
  const answers = {
    org_name: "Villa Sari",
    contact_name: "Ayu Sari",
    contact_role: "Owner",
    contact_email: "ayu@example.com",
    contact_phone: "+62 812-3456-7890",
    decision_makers: "Ayu (owner), Budi (finance)",
    offering: "Boutique villas in Ubud",
    anything_else: "Email AYU@example.com or WhatsApp +62 812-3456-7890; ask for Ayu Sari.",
    success_metrics: ["Bookings / appointments", "Other: call ayu@example.com"],
    asset_inventory: { Logo: "exists", note: "ask Ayu Sari" },
    budget_range: "USD 7,000 – 15,000",
  };

  it("replaces every present person field, keeps business answers, removes the subject's identifiers elsewhere", () => {
    const { answers: out, changed } = scrubAnswers(answers, {
      emails: ["ayu@example.com"], phones: ["+62 812-3456-7890"], names: ["Ayu Sari"],
    });
    for (const f of ["contact_name", "contact_role", "contact_email", "contact_phone", "decision_makers"]) {
      expect(out[f], f).toBe(ERASED_MARKER);
    }
    expect(out.org_name).toBe("Villa Sari");
    expect(out.offering).toBe("Boutique villas in Ubud");
    expect(out.budget_range).toBe("USD 7,000 – 15,000");
    expect(out.anything_else).toBe(`Email ${ERASED_MARKER} or WhatsApp ${ERASED_MARKER}; ask for ${ERASED_MARKER}.`);
    expect(out.success_metrics).toEqual(["Bookings / appointments", `Other: call ${ERASED_MARKER}`]);
    expect(out.asset_inventory).toEqual({ Logo: "exists", note: `ask ${ERASED_MARKER}` });
    const text = JSON.stringify(out);
    for (const pii of ["ayu@example.com", "AYU@example.com", "+62 812-3456-7890", "Ayu Sari"]) expect(text).not.toContain(pii);
    expect(changed).toBe(8);
  });

  it("an absent person field stays absent (the UI tells 'never answered' from an erased answer)", () => {
    const { answers: out } = scrubAnswers({ offering: "x" }, { emails: ["a@b.co"] });
    expect(out).toEqual({ offering: "x" });
    expect("contact_email" in out).toBe(false);
  });

  it("never mutates its input, tolerates a non-object, and ignores needles shorter than 3 characters", () => {
    const input = { contact_name: "Al", note: "Al was here" };
    const frozen = JSON.stringify(input);
    const { answers: out } = scrubAnswers(input, { names: ["Al"] });
    expect(JSON.stringify(input)).toBe(frozen);
    expect(out).toEqual({ contact_name: ERASED_MARKER, note: "Al was here" });
    expect(scrubAnswers(null, {}).answers).toEqual({});
    expect(scrubAnswers(["x"], {}).answers).toEqual({});
  });

  it("is idempotent: scrubbing an already-scrubbed object changes nothing", () => {
    const once = scrubAnswers(answers, { emails: ["ayu@example.com"], names: ["Ayu Sari"] }).answers;
    const twice = scrubAnswers(once, { emails: ["ayu@example.com"], names: ["Ayu Sari"] });
    expect(twice.answers).toEqual(once);
    expect(twice.changed).toBe(0);
  });

  it("a needle with regex metacharacters is matched literally", () => {
    const { answers: out } = scrubAnswers({ note: "mail a.b+c@x.co now; aXb+c@x.co stays" }, { emails: ["a.b+c@x.co"] });
    expect(out.note).toBe(`mail ${ERASED_MARKER} now; aXb+c@x.co stays`);
  });
});
