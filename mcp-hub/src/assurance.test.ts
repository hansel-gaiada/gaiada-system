// Assurance minting (design: docs/superpowers/plans/2026-08-06-assurance-minting-design.md).
//
// Before this landed, nothing in the codebase could mint `verified`, so every `minAssurance:"verified"`
// tool was statically unreachable — most consequentially D14-14's `approvals.resolveExecute`, which
// made the whole agent-write half of D14 inert. These tests pin the three conjuncts that gate the only
// path to that tier, and (the point of the file) the cases that must NOT reach it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "./config";
import { elevateAssurance, mintPrincipal, type Principal } from "./principal";
import { authorize } from "./policy";
import { registerTool, resetRegistry } from "./registry";
import {
  identityRevoked,
  platformVouchesFor,
  resolvePlatformIdentity,
  resetRevocationCache,
  type PlatformIdentity,
} from "./revocation";

const human = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });
const agentEnvelope = mintPrincipal({ provider: "telegram", externalId: "tg:555" });
const automation = mintPrincipal({ provider: "n8n", externalId: "wf:delivery" });
const anon = mintPrincipal({});

/** What the platform returns for a dual-proof-verified link on an active user. */
const VOUCHED: PlatformIdentity = { status: "resolved", revoked: false, userId: "u1", platformAssurance: "linked" };

function resolveStub(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body })) as unknown as typeof fetch;
}
function callCount(f: typeof fetch): number {
  return (f as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

describe("elevateAssurance — the only path from low to verified", () => {
  it("elevates a vouched envelope presented by an entitled caller", () => {
    const p = elevateAssurance(human, { callerEntitled: true, vouched: true });
    expect(p.assurance).toBe("verified");
    expect(p.provider).toBe("whatsapp"); // identity is untouched — only the tier changes
    expect(p.externalId).toBe("628110@c.us");
  });

  it("conjunct 1 — an unentitled caller stays low even for a fully vouched identity", () => {
    // This is the case that keeps principal.ts's founding rule literally true: a WhatsApp session
    // whose D4 link IS verified still mints `low`, because the BOT holds only the ordinary token.
    expect(elevateAssurance(human, { callerEntitled: false, vouched: true }).assurance).toBe("low");
  });

  it("conjunct 3 — an entitled caller cannot elevate an unvouched identity", () => {
    // The caller's token is authority to elevate, never a substitute for the platform's proof.
    expect(elevateAssurance(human, { callerEntitled: true, vouched: false }).assurance).toBe("low");
  });

  // ⚠ THE §A13 LINE. The architect ruling (seo-sem-design-addendum-providers.md §A13, 2026-07-30,
  // binding) makes the assurance gate THE control keeping automation away from money-spending
  // `search.*` tools, resting on "every n8n principal is minted assurance:'low' by construction".
  // Two controls hold it — no AUTOMATION_ALLOWLIST entry (SM-55) and low assurance. If this test ever
  // fails, the second control is GONE and a paid-spend path may have opened. Do not "fix" it by
  // relaxing the assertion.
  it("conjunct 2 — an n8n principal is NEVER elevated, even entitled AND vouched (§A13)", () => {
    expect(elevateAssurance(automation, { callerEntitled: true, vouched: true }).assurance).toBe("low");
  });

  it("an anonymous principal is never elevated (nothing to vouch for)", () => {
    expect(elevateAssurance(anon, { callerEntitled: true, vouched: true }).assurance).toBe("anonymous");
  });

  it("is idempotent and never downgrades an already-verified principal", () => {
    const verified: Principal = { ...human, assurance: "verified" };
    expect(elevateAssurance(verified, { callerEntitled: false, vouched: false }).assurance).toBe("verified");
  });
});

describe("platformVouchesFor — conjunct 3 is fail-closed on every shape", () => {
  it("vouches for a verified link on an active user (platform `linked`)", () => {
    expect(platformVouchesFor(VOUCHED)).toBe(true);
  });

  it("accepts platform `high` (an MFA'd IdP session is strictly stronger than `linked`)", () => {
    expect(platformVouchesFor({ ...VOUCHED, platformAssurance: "high" })).toBe(true);
  });

  // The distinction the whole tier rests on: /principal/resolve returns {...ANONYMOUS, userId} —
  // assurance "low" WITH a userId — for an UNVERIFIED link. A userId alone must never vouch.
  it("refuses an UNVERIFIED link, even though it carries a userId", () => {
    expect(platformVouchesFor({ status: "resolved", revoked: false, userId: "u1", platformAssurance: "low" })).toBe(false);
  });

  it("refuses a revoked identity (D11) whose link is verified", () => {
    expect(platformVouchesFor({ ...VOUCHED, revoked: true })).toBe(false);
  });

  it("refuses an unknown identity (no userId)", () => {
    expect(platformVouchesFor({ status: "resolved", revoked: false, userId: null, platformAssurance: "low" })).toBe(false);
  });

  // Opposite failure directions from ONE cached answer: `unavailable` must fail OPEN for revocation
  // and CLOSED for elevation. A single boolean cache could not express both.
  it("refuses when the platform never answered — while revocation fails OPEN on the same value", () => {
    const unavailable: PlatformIdentity = { status: "unavailable" };
    expect(platformVouchesFor(unavailable)).toBe(false); // elevation: fail-closed
    expect(identityRevoked(unavailable)).toBe(false); // revocation: fail-open
  });

  it("refuses a missing assurance field (an older platform build, or a truncated body)", () => {
    expect(platformVouchesFor({ status: "resolved", revoked: false, userId: "u1", platformAssurance: null })).toBe(false);
  });
});

describe("resolvePlatformIdentity — one lookup serving both concerns", () => {
  beforeEach(() => {
    resetRevocationCache();
    config.revocationCheck = true;
    config.platformUrl = "http://platform.test";
    config.revocationTtlMs = 60_000;
  });
  afterEach(() => {
    config.revocationCheck = true;
  });

  it("keeps the whole answer, not just `revoked`", async () => {
    const f = resolveStub({ userId: "u1", assurance: "linked", companies: [], roles: [] });
    const id = await resolvePlatformIdentity(human, f, 1000);
    expect(id).toEqual({ status: "resolved", revoked: false, userId: "u1", platformAssurance: "linked" });
    expect(platformVouchesFor(id)).toBe(true);
    expect(identityRevoked(id)).toBe(false);
  });

  it("serves BOTH concerns from ONE round-trip per principal per window", async () => {
    const f = resolveStub({ userId: "u1", assurance: "linked" });
    const id = await resolvePlatformIdentity(human, f, 1000);
    identityRevoked(id);
    platformVouchesFor(id);
    await resolvePlatformIdentity(human, f, 1000 + 30_000); // same window
    expect(callCount(f)).toBe(1);
  });

  it("never caches `unavailable` — one blip must not mask a revocation for a whole TTL", async () => {
    const bad = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await resolvePlatformIdentity(human, bad, 1000)).toEqual({ status: "unavailable" });
    const ok = resolveStub({ revoked: true, userId: "u1" });
    expect(identityRevoked(await resolvePlatformIdentity(human, ok, 1000))).toBe(true);
  });

  it("treats a non-OK response as `unavailable`, not as a resolved negative", async () => {
    expect(await resolvePlatformIdentity(human, resolveStub({}, false), 1000)).toEqual({ status: "unavailable" });
  });

  it("never asks about an anonymous envelope", async () => {
    const f = resolveStub({ userId: "u1", assurance: "linked" });
    expect(await resolvePlatformIdentity(anon, f, 1000)).toEqual({ status: "unavailable" });
    expect(callCount(f)).toBe(0);
  });

  // Documented consequence, pinned so it cannot become a mystery: HUB_REVOCATION_CHECK=false also
  // caps assurance at `low`, because the platform vouching rides on this same lookup.
  it("switching the revocation check off also disables elevation (fail-closed both ways)", async () => {
    config.revocationCheck = false;
    const f = resolveStub({ userId: "u1", assurance: "linked" });
    const id = await resolvePlatformIdentity(human, f, 1000);
    expect(platformVouchesFor(id)).toBe(false);
    expect(callCount(f)).toBe(0);
  });
});

// ─────────────────── what it actually unblocks, end to end through the policy ────────────────────
describe("the D14 agent-write surface this exists to unblock", () => {
  beforeEach(() => {
    resetRegistry();
    // Same shape as the real registration in platform-write-tools.ts (D14-14).
    registerTool({
      name: "approvals.resolveExecute",
      description: "test double of the D14-14 re-run transport",
      minAssurance: "verified",
      write: true,
      impact: "high",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "ok",
    });
  });

  it("was unreachable before: a low principal is denied at the assurance gate", () => {
    const d = authorize(human, "approvals.resolveExecute");
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toContain("requires verified assurance");
  });

  it("is reachable now: the elevated re-drive principal passes", () => {
    // Exactly what happens on the live path — approval-execute.ts's resolveRedrivePrincipal hands the
    // hub the requester's OWN link (selected `WHERE verified_at IS NOT NULL`), and platform-nest holds
    // the elevated token, so both conjuncts 1 and 3 are satisfied by construction.
    const elevated = elevateAssurance(agentEnvelope, { callerEntitled: true, vouched: platformVouchesFor(VOUCHED) });
    expect(authorize(elevated, "approvals.resolveExecute").allow).toBe(true);
  });

  it("and stays unreachable for automation, which never needed it (§A13 + workflow scope)", () => {
    // Belt AND braces, deliberately: the n8n refusal in elevateAssurance keeps it `low`, and the tool
    // is in no AUTOMATION_ALLOWLIST so the workflow-scope check would deny it anyway.
    const elevated = elevateAssurance(automation, { callerEntitled: true, vouched: true });
    expect(elevated.assurance).toBe("low");
    expect(authorize(elevated, "approvals.resolveExecute").allow).toBe(false);
  });
});
