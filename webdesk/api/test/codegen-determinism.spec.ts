// WSK-15 — in-process determinism proof for `buildContractArtifacts` (pure, no DB/storage): the
// SAME composition input produces byte-identical `openapi.v1.json`/`sdk.d.ts`/`CONTENT-CONTRACT.md`
// and an identical `contentHash` across repeated calls, while a DIFFERENT input produces a
// different hash. This is the fast, no-container half of the determinism AC; the real
// "two separate processes against a real Postgres/MinIO stack" proof is
// `codegen-double-run-gate.spec.ts` + this ticket's report (verbatim transcript).
import { describe, expect, it } from "vitest";
import { buildContractArtifacts } from "../src/codegen/generator/build-artifacts.mts";
import type { TenantComposition } from "../../payload/vocabulary/composition.ts";

const composition: TenantComposition = {
  "case-study": { blocks: ["hero", "richText", "testimonial"] },
  redirect: { fields: [{ name: "toPath", primitive: "text", required: true }] },
};

describe("buildContractArtifacts — determinism", () => {
  it("byte-identical openapi/sdk/contractMd/hash-manifest across two calls with the same input", async () => {
    const input = { tenantSlug: "det-tenant", defaultLocale: "id-ID", locales: ["id-ID", "en-US"], composition, previous: null };
    const a = await buildContractArtifacts(input);
    const b = await buildContractArtifacts(input);

    expect(a.openapiJson).toBe(b.openapiJson);
    expect(a.sdkTs).toBe(b.sdkTs);
    expect(a.contractMd).toBe(b.contractMd);
    expect(a.hashManifestJson).toBe(b.hashManifestJson);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("no timestamp/wall-clock value leaks into any hashed artifact body", async () => {
    const input = { tenantSlug: "det-tenant", defaultLocale: "id-ID", locales: ["id-ID"], composition, previous: null };
    const a = await buildContractArtifacts(input);
    await new Promise((r) => setTimeout(r, 1100)); // cross at least one wall-clock second
    const b = await buildContractArtifacts(input);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.openapiJson).toBe(b.openapiJson);
  });

  it("a DIFFERENT composition produces a DIFFERENT contentHash", async () => {
    const inputA = { tenantSlug: "det-tenant", defaultLocale: "id-ID", locales: ["id-ID"], composition, previous: null };
    const inputB = {
      tenantSlug: "det-tenant",
      defaultLocale: "id-ID",
      locales: ["id-ID"],
      composition: { ...composition, article: { blocks: ["gallery"] } },
      previous: null,
    };
    const a = await buildContractArtifacts(inputA);
    const b = await buildContractArtifacts(inputB);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("a DIFFERENT tenant slug (same composition) produces a DIFFERENT openapi.v1.json (paths are tenant-baked)", async () => {
    const a = await buildContractArtifacts({ tenantSlug: "tenant-a", defaultLocale: "id-ID", locales: ["id-ID"], composition, previous: null });
    const b = await buildContractArtifacts({ tenantSlug: "tenant-b", defaultLocale: "id-ID", locales: ["id-ID"], composition, previous: null });
    expect(a.openapiJson).not.toBe(b.openapiJson);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("rejects a composition WSK-14's validator would reject (out-of-vocabulary block type)", async () => {
    const bad = { article: { blocks: ["not-a-real-block-type"] } } as unknown as TenantComposition;
    await expect(
      buildContractArtifacts({ tenantSlug: "det-tenant", defaultLocale: "id-ID", locales: ["id-ID"], composition: bad, previous: null }),
    ).rejects.toThrow(/WSK-14/);
  });
});
