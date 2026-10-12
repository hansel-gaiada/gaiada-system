// M6-P4b2 — the commit offer's own rules: the opt-in is parsed strictly, the files travel by value with honest hashes,
// the size check mirrors platform-nest's caps, and every refusal comes back as data (never a throw).
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { Envelope } from "../agent";
import {
  COMMIT_SCAFFOLD_TOOL, SCAFFOLD_COMMIT_LIMITS, commitFiles, commitThroughPlatform, parseCommitTarget, sizeRefusal,
} from "./commit-request";

const OBO: Envelope = { provider: "n8n", externalId: "wf:delivery" };
const SITE = "dddddddd-0000-4000-8000-000000000004";
const RUN = "eeeeeeee-0000-4000-8000-000000000005";

describe("parseCommitTarget", () => {
  it("absent or null is a pure dry run; a uuid is the target; anything else throws", () => {
    expect(parseCommitTarget(JSON.stringify({ runId: "r" }))).toBeNull();
    expect(parseCommitTarget(JSON.stringify({ commit: null }))).toBeNull();
    expect(parseCommitTarget("not json")).toBeNull();
    expect(parseCommitTarget(JSON.stringify({ commit: { provisionedSiteId: SITE.toUpperCase() } }))).toEqual({ provisionedSiteId: SITE });
    expect(() => parseCommitTarget(JSON.stringify({ commit: { provisionedSiteId: "x" } }))).toThrow(/provisionedSiteId/);
    expect(() => parseCommitTarget(JSON.stringify({ commit: true }))).toThrow(/provisionedSiteId/);
    expect(() => parseCommitTarget(JSON.stringify({ commit: { remoteUrl: "https://x" } }))).toThrow();
  });
});

describe("commitFiles / sizeRefusal", () => {
  it("each entry carries its exact bytes, size and sha256, sorted by path", () => {
    const bin = Buffer.from([0, 255, 10]);
    const out = commitFiles([{ path: "b.txt", content: "héllo" }, { path: "a.bin", content: bin }]);
    expect(out.map((f) => f.path)).toEqual(["a.bin", "b.txt"]);
    expect(out[0]).toEqual({ path: "a.bin", base64: bin.toString("base64"), bytes: 3, sha256: createHash("sha256").update(bin).digest("hex") });
    expect(out[1].bytes).toBe(Buffer.byteLength("héllo", "utf8"));
  });

  it("mirrors platform-nest's caps (300 files, 512 KiB per file, 600 KiB total)", () => {
    expect(SCAFFOLD_COMMIT_LIMITS).toEqual({ maxFiles: 300, maxFileBytes: 524288, maxTotalBytes: 614400 });
    expect(sizeRefusal(commitFiles([{ path: "a", content: "x" }]))).toBeNull();
    expect(sizeRefusal(commitFiles([{ path: "a", content: Buffer.alloc(524289) }]))).toMatch(/^scaffold_too_large: a/);
    expect(sizeRefusal(commitFiles([{ path: "a", content: Buffer.alloc(400_000) }, { path: "b", content: Buffer.alloc(400_000) }]))).toMatch(/in total/);
    expect(sizeRefusal(commitFiles(Array.from({ length: 301 }, (_, i) => ({ path: `f${i}`, content: "x" }))))).toMatch(/301 files/);
  });
});

describe("commitThroughPlatform", () => {
  const base = { envelope: OBO, tenantId: "t1", target: { provisionedSiteId: SITE }, runId: RUN, goalId: "g1", contractSnapshotId: "s1", files: [{ path: "CONTRACT.lock", content: "{}\n" }] };

  it("one hub call to the commit tool with the OBO envelope; the reply is returned with the site id", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown>; envelope: Envelope }> = [];
    const r = await commitThroughPlatform({
      ...base,
      callTool: async (name, args, envelope) => {
        calls.push({ name, args, envelope });
        return JSON.stringify({ outcome: "already_committed", repo: "o/r", branch: "main", baseSha: "b", treeSha: "t", commitSha: "c", snapshotId: "s1", manifestSha256: "m", fileCount: 1, totalBytes: 3 });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: COMMIT_SCAFFOLD_TOOL, envelope: OBO, args: { tenantId: "t1", siteId: SITE, runId: RUN, goalId: "g1", contractSnapshotId: "s1" } });
    expect(r).toMatchObject({ provisionedSiteId: SITE, outcome: "already_committed", commitSha: "c" });
  });

  it("refusals are data: a hub error keeps the platform's token, an unreadable reply is named, an oversized tree is never sent", async () => {
    const refused = await commitThroughPlatform({ ...base, callTool: async () => { throw new Error("tool failed: scaffold_lock_snapshot_mismatch"); } });
    expect(refused).toEqual({ provisionedSiteId: SITE, outcome: "refused", error: "scaffold_lock_snapshot_mismatch" });
    const odd = await commitThroughPlatform({ ...base, callTool: async () => JSON.stringify({ ok: true }) });
    expect(odd).toMatchObject({ outcome: "refused", error: "commit_reply_unreadable" });
    let called = false;
    const big = await commitThroughPlatform({ ...base, files: [{ path: "x.bin", content: Buffer.alloc(700_000) }], callTool: async () => { called = true; return "{}"; } });
    expect(big).toMatchObject({ outcome: "refused" });
    expect(called).toBe(false);
  });
});
