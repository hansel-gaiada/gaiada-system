// D14-09 item (c) — adversarial grant-replay dimensions, independent of approval-grant.test.ts.
// New test file only (QA gate constraint: no production-code edits). Exercises verifyExecutionGrant
// directly against replay/cross-binding attempts the shipped suite does not already cover by name.
import { describe, it, expect, beforeEach } from "vitest";
import { config } from "./config";
import {
  computeArgsSha256,
  signGrantPayload,
  verifyExecutionGrant,
  resetGrantNonceCache,
} from "./approval-grant";

const SECRET = "replay-test-secret";
let nonceSeq = 0;

function mintGrant(opts: {
  toolName: string;
  args: Record<string, unknown>;
  tenantId?: string;
  approvalId?: string;
  iat?: number;
  exp?: number;
  nonce?: string;
}): { header: string; nonce: string } {
  const iat = opts.iat ?? Date.now();
  const nonce = opts.nonce ?? `nonce-${++nonceSeq}`;
  const header = signGrantPayload(
    {
      v: 1,
      approvalId: opts.approvalId ?? "apr-0001",
      tenantId: opts.tenantId ?? "tenant-1",
      toolName: opts.toolName,
      argsSha256: computeArgsSha256(opts.args),
      iat,
      exp: opts.exp ?? iat + 60_000,
      nonce,
    },
    SECRET,
  );
  return { header, nonce };
}

beforeEach(() => {
  config.approvalGrantSecret = SECRET;
  resetGrantNonceCache();
});

describe("D14-09(c) — grant replay across tenants/rows/tools", () => {
  it("same nonce, different tenantId in the call args ⇒ deny (tenant_mismatch, not silently allowed)", () => {
    const args = { tenantId: "tenant-A", op: "x" };
    const { header } = mintGrant({ toolName: "money.transfer", args, tenantId: "tenant-A" });
    // Present the SAME header for a call whose args claim a different tenant.
    const verdict = verifyExecutionGrant(header, {
      toolName: "money.transfer",
      args: { tenantId: "tenant-B", op: "x" },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("tenant_mismatch");
  });

  it("a grant cannot be reassigned to a different approval row: mutating approvalId invalidates the signature", () => {
    const args = { runId: "run-1" };
    const { header } = mintGrant({ toolName: "deploy.staging", args, approvalId: "apr-AAA" });
    const [payloadPart, sigPart] = header.split(".");
    const decoded = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    decoded.approvalId = "apr-BBB"; // attacker tries to relabel which row this grant belongs to
    const forgedPayloadPart = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    const forgedHeader = `${forgedPayloadPart}.${sigPart}`;
    const verdict = verifyExecutionGrant(forgedHeader, { toolName: "deploy.staging", args });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("bad_signature");
  });

  it("a grant minted for deploy.staging is denied for a call to deploy.production (tool_mismatch)", () => {
    const args = { runId: "run-1" };
    const { header } = mintGrant({ toolName: "deploy.staging", args });
    const verdict = verifyExecutionGrant(header, { toolName: "deploy.production", args });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("tool_mismatch");
  });

  it("a grant minted for one approvalId, args unchanged, cannot authorize a second row's identical-looking call without its own grant (approvalId is not independently checked, so this is a design note, not a bypass — the platform's single-use claim is what actually ties execution to ONE row)", () => {
    // Two DIFFERENT approval rows that happen to file the identical call get two independently valid
    // grants (different nonces, same toolName/args/tenant). Each grant is single-use via its own
    // nonce, so replaying grant #1's header a second time (as if it were authorizing row #2) is
    // exactly the ordinary same-nonce replay case, covered below.
    const args = { runId: "run-shared" };
    const g1 = mintGrant({ toolName: "deploy.staging", args, approvalId: "apr-row-1" });
    const v1 = verifyExecutionGrant(g1.header, { toolName: "deploy.staging", args });
    expect(v1.ok).toBe(true);
    // Replaying the SAME header again (same nonce) must deny regardless of which row it's claimed for.
    const v1replay = verifyExecutionGrant(g1.header, { toolName: "deploy.staging", args });
    expect(v1replay.ok).toBe(false);
    if (!v1replay.ok) expect(v1replay.reason).toBe("replayed_nonce");
  });

  it("ordinary same-nonce replay ⇒ deny on the second use", () => {
    const args = { runId: "run-2" };
    const { header } = mintGrant({ toolName: "deploy.production", args });
    const first = verifyExecutionGrant(header, { toolName: "deploy.production", args });
    expect(first.ok).toBe(true);
    const second = verifyExecutionGrant(header, { toolName: "deploy.production", args });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replayed_nonce");
  });

  it("an EXPIRED nonce cannot be replayed before GC sweeps it: the expiry check fires before nonce consumption is even attempted", () => {
    const args = { runId: "run-3" };
    const iat = 1_700_000_000_000;
    const exp = iat + 60_000;
    const { header, nonce } = mintGrant({ toolName: "deploy.staging", args, iat, exp });

    // "now" is already past expiry — verify BEFORE the grant is ever successfully consumed.
    const pastExpiry = exp + 1;
    const verdict = verifyExecutionGrant(header, { toolName: "deploy.staging", args }, pastExpiry);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("expired");

    // Because the expiry check short-circuits BEFORE consumeNonce() runs, the nonce was never
    // burned by the expired attempt. Confirm that presenting the SAME header again, still expired,
    // denies for the SAME reason (not "replayed_nonce") — i.e. an expired grant can never slip through
    // as a replay-cache miss, and it can never be "freed up" by GC into a live-looking reuse either.
    const verdict2 = verifyExecutionGrant(header, { toolName: "deploy.staging", args }, pastExpiry + 5_000);
    expect(verdict2.ok).toBe(false);
    if (!verdict2.ok) expect(verdict2.reason).toBe("expired");
  });

  it("a grant consumed just BEFORE its expiry cannot be replayed just AFTER (no post-expiry reuse window)", () => {
    const args = { runId: "run-4" };
    const iat = 1_700_000_000_000;
    const exp = iat + 10_000;
    const { header } = mintGrant({ toolName: "deploy.staging", args, iat, exp });

    const justBefore = exp - 1;
    const first = verifyExecutionGrant(header, { toolName: "deploy.staging", args }, justBefore);
    expect(first.ok).toBe(true);

    const justAfter = exp + 1;
    const second = verifyExecutionGrant(header, { toolName: "deploy.staging", args }, justAfter);
    expect(second.ok).toBe(false);
    // Whichever check wins (expired vs replayed_nonce), it must still be a deny.
    if (!second.ok) expect(["expired", "replayed_nonce"]).toContain(second.reason);
  });
});
