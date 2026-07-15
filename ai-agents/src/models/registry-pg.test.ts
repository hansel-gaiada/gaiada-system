// WS8 Step C — the DURABLE model registry enforces the same D13 gates as the in-memory one, in
// Postgres, and survives a fresh instance on the same DB. DB-backed; skips without a reachable DB.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { PgModelRegistry } from "./registry-pg";
import { ProvenanceError, type ModelEntry } from "./registry";
import { TEST_DB_URL as url, testDbReachable } from "../knowledge/testdb";

const dbUp = await testDbReachable();
const safetensors = (over: Partial<ModelEntry> = {}): Omit<ModelEntry, "status" | "provenanceVerified"> => ({
  id: "llama-3.2-3b", name: "Llama 3.2 3B", version: "1", backend: "vllm",
  provenance: { weightFormat: "safetensors", sha256: "abc123", sourceMirror: "huggingface.co" },
  ...over,
});
const passingEval = { suite: "task-triager", provider: "local", passed: true, score: 0.9 };

describe.skipIf(!dbUp)("PgModelRegistry (durable, D13)", () => {
  let pool: Pool;
  let reg: PgModelRegistry;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS model_registry");
    reg = new PgModelRegistry(pool);
    await reg.init();
  });
  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS model_registry");
    await pool.end();
  });

  it("registers a candidate; rejects bad provenance", async () => {
    const e = await reg.register(safetensors());
    expect(e.status).toBe("candidate");
    expect(e.provenanceVerified).toBe(false);
    await expect(reg.register(safetensors({ id: "bad", provenance: { weightFormat: "safetensors", sha256: "x", sourceMirror: "sketchy.ru" } }))).rejects.toThrow(ProvenanceError);
  });

  it("digest verify + eval gate + routable, all persisted", async () => {
    await expect(reg.approveForServing("llama-3.2-3b")).rejects.toThrow(/provenance not verified/);
    await expect(reg.verifyWeightDigest("llama-3.2-3b", "WRONG")).rejects.toThrow(ProvenanceError);
    await reg.verifyWeightDigest("llama-3.2-3b", "abc123");
    await expect(reg.approveForServing("llama-3.2-3b")).rejects.toThrow(/no passing eval/);
    await reg.attachEval("llama-3.2-3b", passingEval);
    expect(await reg.isRoutable("llama-3.2-3b")).toBe(false);
    await reg.approveForServing("llama-3.2-3b");
    expect(await reg.isRoutable("llama-3.2-3b")).toBe(true);
  });

  it("survives a fresh instance on the same DB (durability)", async () => {
    const reg2 = new PgModelRegistry(pool);
    expect(await reg2.isRoutable("llama-3.2-3b")).toBe(true);
    expect((await reg2.get("llama-3.2-3b")).status).toBe("approved");
  });

  it("a cloud model is provenance-verified on registration", async () => {
    const e = await reg.register({ id: "claude", name: "Claude", version: "4.8", backend: "cloud", provenance: { weightFormat: "none" } });
    expect(e.provenanceVerified).toBe(true);
  });
});
