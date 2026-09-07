// AD-2/AD-3 — no-DB coverage for the prospect surface: IntakeTokenGuard's typed-refusal branching,
// the controller's pre-transaction defensive checks, the free-text scrub/exemption split, and the
// questionnaire module's completion counters.
//
// NO DB: `findIntakeTokenByPlaintext` (the guard's only DB-touching call) is mocked throughout, and
// every controller path exercised here returns/throws BEFORE `submit()` reaches `withTenants`. The
// transactional half of submit() (§6.1's lock + re-read-under-lock + idempotent-200, the actual
// insert, the lead flip, the event emit) is NOT exercised by this suite — it needs a real Postgres,
// which DATABASE_URL_TEST does not provide here (16-container stack off by owner decision). See this
// ticket's report.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException, HttpException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";

// vi.mock's factory is hoisted above these imports; vi.hoisted() is the supported escape hatch for a
// value the hoisted factory needs to read PER-TEST (client-notifications.test.ts's own idiom).
const tokenLookup = vi.hoisted(() => ({
  impl: null as null | ((tenantId: string, plaintext: string) => Promise<unknown>),
  calls: [] as Array<{ tenantId: string; plaintext: string }>,
}));

vi.mock("./agency-intake-tokens.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agency-intake-tokens.service")>();
  return {
    ...actual,
    findIntakeTokenByPlaintext: vi.fn(async (tenantId: string, plaintext: string) => {
      tokenLookup.calls.push({ tenantId, plaintext });
      if (!tokenLookup.impl) throw new Error("test forgot to set tokenLookup.impl");
      return tokenLookup.impl(tenantId, plaintext);
    }),
  };
});

import { IntakeTokenGuard, type IntakeRequest } from "./agency-intake-token.guard";
import {
  AgencyIntakePortalController, scrubAnswers, CONTACT_IDENTITY_FIELDS_EXEMPT_FROM_SCRUB,
} from "./agency-intake-portal.controller";
import {
  QUESTIONNAIRE_SECTIONS, SCHEMA_VERSION, ALL_QUESTIONNAIRE_FIELDS, REQUIRED_FIELD_IDS, countAnswers,
} from "./agency-discovery-questionnaire";
import type { IntakeTokenRow } from "./agency-intake-tokens.service";

function fakeCtx(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }) } as unknown as ExecutionContext;
}

function baseReq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { headers: { "x-intake-token": "plaintext-token" }, params: { tenantId: "tenant-1" }, method: "GET", ...overrides };
}

function validRow(overrides: Partial<IntakeTokenRow> = {}): IntakeTokenRow {
  return {
    id: "tok-1", tenantId: "tenant-1", leadId: "lead-1", kind: "invite",
    expiresAt: new Date(Date.now() + 100_000).toISOString(), usedAt: null, revokedAt: null,
    ...overrides,
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
  try {
    await promise;
    throw new Error("expected the guard/controller to refuse, but it did not throw");
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const body = err.getResponse() as { reason?: unknown };
    return { status: err.getStatus(), reason: body?.reason };
  }
}

describe("IntakeTokenGuard", () => {
  const guard = new IntakeTokenGuard();

  beforeEach(() => {
    tokenLookup.impl = null;
    tokenLookup.calls = [];
  });

  it("refuses token_missing (401) when no X-Intake-Token header is present", async () => {
    const req = baseReq({ headers: {} });
    const { status, reason } = await refusalOf(guard.canActivate(fakeCtx(req)));
    expect(status).toBe(401);
    expect(reason).toBe("token_missing");
  });

  it("accepts the first value when X-Intake-Token arrives as an array (a proxy/framework artifact, not a caller choice)", async () => {
    tokenLookup.impl = async () => validRow();
    const req = baseReq({ headers: { "x-intake-token": ["plaintext-token", "second"] } });
    await expect(guard.canActivate(fakeCtx(req))).resolves.toBe(true);
    expect(tokenLookup.calls[0]).toEqual({ tenantId: "tenant-1", plaintext: "plaintext-token" });
  });

  it("refuses token_invalid (401) when the route carries no :tenantId — never calls the lookup with an empty scope", async () => {
    const req = baseReq({ params: {} });
    const { status, reason } = await refusalOf(guard.canActivate(fakeCtx(req)));
    expect(status).toBe(401);
    expect(reason).toBe("token_invalid");
    expect(tokenLookup.calls).toHaveLength(0);
  });

  it("refuses token_invalid (401) when no row hashes to the presented plaintext", async () => {
    tokenLookup.impl = async () => null;
    const { status, reason } = await refusalOf(guard.canActivate(fakeCtx(baseReq())));
    expect(status).toBe(401);
    expect(reason).toBe("token_invalid");
  });

  it("refuses open_intake_not_enabled (403, not 401) for kind='open' — a real capability, just not turned on (AD-9)", async () => {
    tokenLookup.impl = async () => validRow({ kind: "open", leadId: null });
    const { status, reason } = await refusalOf(guard.canActivate(fakeCtx(baseReq())));
    expect(status).toBe(403);
    expect(reason).toBe("open_intake_not_enabled");
  });

  it("refuses token_revoked (401)", async () => {
    tokenLookup.impl = async () => validRow({ revokedAt: new Date().toISOString() });
    const { status, reason } = await refusalOf(guard.canActivate(fakeCtx(baseReq())));
    expect(status).toBe(401);
    expect(reason).toBe("token_revoked");
  });

  it("refuses token_expired (401) once expiresAt has passed", async () => {
    tokenLookup.impl = async () => validRow({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const { status, reason } = await refusalOf(guard.canActivate(fakeCtx(baseReq())));
    expect(status).toBe(401);
    expect(reason).toBe("token_expired");
  });

  it("refuses token_used (401) for a non-POST request (the questionnaire GET) once the token has been spent", async () => {
    tokenLookup.impl = async () => validRow({ usedAt: new Date().toISOString() });
    const { status, reason } = await refusalOf(guard.canActivate(fakeCtx(baseReq({ method: "GET" }))));
    expect(status).toBe(401);
    expect(reason).toBe("token_used");
  });

  it("does NOT refuse an already-used token on POST — design §6.1's idempotent-retry contract owns that decision, not this guard", async () => {
    tokenLookup.impl = async () => validRow({ usedAt: new Date().toISOString() });
    const req = baseReq({ method: "POST" });
    await expect(guard.canActivate(fakeCtx(req))).resolves.toBe(true);
    expect((req as unknown as IntakeRequest).intakeToken.usedAt).not.toBeNull();
  });

  it("on success, attaches req.intakeToken with exactly the resolved row's tenantId/leadId — never the caller's own :tenantId text if it ever differed", async () => {
    tokenLookup.impl = async () => validRow({ tenantId: "tenant-1", leadId: "lead-42" });
    const req = baseReq();
    await guard.canActivate(fakeCtx(req));
    const attached = (req as unknown as IntakeRequest).intakeToken;
    expect(attached).toEqual({
      tokenId: "tok-1", tenantId: "tenant-1", leadId: "lead-42", kind: "invite",
      expiresAt: expect.any(String), revokedAt: null, usedAt: null,
    });
  });
});

describe("AgencyIntakePortalController", () => {
  const controller = new AgencyIntakePortalController();

  it("questionnaire() returns the current schema_version and the full, unmodified section set", () => {
    const req = { intakeToken: { tokenId: "t", tenantId: "x", leadId: "l", kind: "invite", expiresAt: null, revokedAt: null, usedAt: null } } as unknown as IntakeRequest;
    const result = controller.questionnaire(req);
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.sections).toBe(QUESTIONNAIRE_SECTIONS);
  });

  it("submit() refuses open_intake_not_enabled BEFORE touching the database when intake.kind is not 'invite'", async () => {
    const req = {
      intakeToken: { tokenId: "t", tenantId: "tenant-1", leadId: null, kind: "open", expiresAt: null, revokedAt: null, usedAt: null },
    } as unknown as IntakeRequest;
    const { status, reason } = await refusalOf(controller.submit(req, "tenant-1", { answers: {} }));
    expect(status).toBe(403);
    expect(reason).toBe("open_intake_not_enabled");
  });

  it("submit() refuses an oversized answers payload with a plain BadRequestException BEFORE touching the database", async () => {
    const req = {
      intakeToken: { tokenId: "t", tenantId: "tenant-1", leadId: "lead-1", kind: "invite", expiresAt: null, revokedAt: null, usedAt: null },
    } as unknown as IntakeRequest;
    const huge = { anything_else: "x".repeat(600_000) };
    await expect(controller.submit(req, "tenant-1", { answers: huge })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("scrubAnswers / CONTACT_IDENTITY_FIELDS_EXEMPT_FROM_SCRUB", () => {
  it("the exempt set is exactly the three contact-identity ids — no more, no less", () => {
    expect([...CONTACT_IDENTITY_FIELDS_EXEMPT_FROM_SCRUB].sort()).toEqual(["contact_email", "contact_name", "contact_phone"]);
  });

  it("never scrubs contact_name/contact_email/contact_phone — the agency must still be able to reply to the submission", () => {
    const { answers, redactions } = scrubAnswers({
      contact_name: "Jane Doe",
      contact_email: "jane@example.com",
      contact_phone: "6281234567890123", // 16 digits — WOULD match the NIK rule if this were scrubbed
      anything_else: "you can also reach me at jane@example.com",
    });
    expect(answers.contact_name).toBe("Jane Doe");
    expect(answers.contact_email).toBe("jane@example.com");
    expect(answers.contact_phone).toBe("6281234567890123");
    // The NON-exempt field with the same shape of content DOES get scrubbed — proves the split is
    // real, not merely that scrubbing is broken everywhere.
    expect(answers.anything_else).toContain("REDACTED-EMAIL");
    expect(redactions).toBe(1);
  });

  it("scrubs a PAN/NIK-shaped number pasted into an ordinary narrative field — the actual threat design §7 names", () => {
    const { answers, redactions } = scrubAnswers({ compliance: "our old system used id 1234567890123456 everywhere" });
    expect(answers.compliance).toContain("REDACTED");
    expect(redactions).toBeGreaterThan(0);
  });

  it("recurses into checkbox arrays and grid cells, not only top-level text fields", () => {
    const { answers } = scrubAnswers({
      languages: ["English", "email leak@example.com for the glossary"],
      asset_inventory: { "Logo (vector)": "chase mailto leak2@example.com for the file" },
    });
    expect((answers.languages as string[])[1]).toContain("REDACTED-EMAIL");
    expect((answers.asset_inventory as Record<string, string>)["Logo (vector)"]).toContain("REDACTED-EMAIL");
  });

  it("leaves numbers/booleans (scale answers) untouched and counts no redactions for them", () => {
    const { answers, redactions } = scrubAnswers({ vis_minimal_expressive: 3 });
    expect(answers.vis_minimal_expressive).toBe(3);
    expect(redactions).toBe(0);
  });
});

describe("agency-discovery-questionnaire", () => {
  it("has no duplicate field ids across all 13 sections — the JSONB `answers` object depends on this", () => {
    const ids = ALL_QUESTIONNAIRE_FIELDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pins the transcription's size so a future silent edit is visible in a diff", () => {
    expect(QUESTIONNAIRE_SECTIONS.length).toBe(13);
    expect(ALL_QUESTIONNAIRE_FIELDS.length).toBe(127);
    expect(REQUIRED_FIELD_IDS.length).toBe(100);
  });

  it("countAnswers: an empty answers object counts zero answered, but still reports the true requiredTotal", () => {
    const counts = countAnswers({});
    expect(counts.answeredCount).toBe(0);
    expect(counts.requiredAnswered).toBe(0);
    expect(counts.requiredTotal).toBe(100);
  });

  it("countAnswers: an empty string or empty array is never 'answered', even though the key is present", () => {
    const counts = countAnswers({ org_name: "", languages: [] });
    expect(counts.answeredCount).toBe(0);
  });

  it("countAnswers: a grid field counts as answered only once EVERY row has a non-empty entry", () => {
    const partial = countAnswers({ asset_inventory: { "Logo (vector)": "Ready to use" } });
    const full = countAnswers({
      asset_inventory: {
        "Logo (vector)": "Ready to use", "Brand guidelines": "Ready to use", "Photography": "Ready to use",
        "Video": "Ready to use", "Written copy": "Ready to use", "Product data": "Ready to use",
        "Testimonials": "Ready to use", "Case studies": "Ready to use", "Legal / privacy text": "Ready to use",
      },
    });
    expect(partial.answeredCount).toBe(0);
    expect(full.answeredCount).toBe(1);
  });

  it("countAnswers: a required field that IS answered increments both answeredCount and requiredAnswered", () => {
    const counts = countAnswers({ org_name: "Gaia Digital Agency" });
    expect(counts.answeredCount).toBe(1);
    expect(counts.requiredAnswered).toBe(1);
  });

  it("countAnswers: an OPTIONAL field that is answered increments answeredCount but not requiredAnswered", () => {
    const counts = countAnswers({ tagline: "Not your average agency" }); // tagline is req:0
    expect(counts.answeredCount).toBe(1);
    expect(counts.requiredAnswered).toBe(0);
  });
});
