// WSK-15 — proves the WSK-15 ticket AC "generated SDK compiles against the P1 tenant": generates
// real `sdk.d.ts` for a fixture composition, writes it plus a small consumer file to a temp dir,
// and runs the REAL TypeScript compiler (`npx tsc --noEmit`, this project's own pinned `typescript`
// devDependency) against just those two files — not this project's own tsconfig.json (which would
// pull in unrelated commonjs sources and is not the point; the point is "does the generated .d.ts
// type-check on its own"). No DB/storage — pure generation, then a real `tsc` subprocess.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenApiDocument } from "../src/codegen/generator/openapi-builder.mts";
import { generateTsSdk } from "../src/codegen/generator/sdk-ts.mts";

describe("sdk-ts — the generated SDK compiles standalone", () => {
  it("tsc --noEmit accepts sdk.d.ts plus a consumer file that references a real tenant path/schema", async () => {
    const doc = buildOpenApiDocument({
      tenantSlug: "p1-tenant",
      contractVersion: "1.0.0",
      vocabularyVersion: "1.0.0",
      defaultLocale: "id-ID",
      locales: ["id-ID"],
      composition: { "case-study": { blocks: ["hero", "richText"] } },
    });
    const sdkTs = await generateTsSdk(doc);
    expect(sdkTs.length).toBeGreaterThan(0);
    expect(sdkTs).toContain('"/v1/t/p1-tenant/case-study"');

    const dir = mkdtempSync(join(tmpdir(), "wsk15-sdk-typecheck-"));
    try {
      writeFileSync(join(dir, "sdk.d.ts"), sdkTs);
      writeFileSync(
        join(dir, "consumer.ts"),
        [
          'import type { paths, components } from "./sdk.d.ts";',
          "",
          "// A real tenant path resolves and its 200 response is the ListEnvelope-shaped schema.",
          'type ListResponse = paths["/v1/t/p1-tenant/case-study"]["get"]["responses"]["200"]["content"]["application/json"];',
          'const _list: ListResponse = { collection: "case-study", locale: "id-ID", items: [], page: { cursor: null, hasMore: false, limit: 25 } };',
          "",
          "// The item-by-slug path takes a slug path param and returns the item schema.",
          'type ItemResponse = paths["/v1/t/p1-tenant/case-study/{slug}"]["get"]["responses"]["200"]["content"]["application/json"];',
          "const _item: ItemResponse = {",
          '  collection: "case-study", slug: "x", locale: "id-ID", localizations: [],',
          "  seo: {}, meta: { publishedAt: null, updatedAt: new Date().toISOString(), draft: false, x: {} },",
          "  blocks: [],",
          "};",
          "",
          "// The ProblemDetails error schema is a real component.",
          'type Problem = components["schemas"]["ProblemDetails"];',
          'const _err: Problem = { type: "https://x", title: "x", status: 404, instance: "/x", requestId: "x" };',
          "",
          "void _list; void _item; void _err;",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "ES2022", module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true },
          include: ["*.ts"],
        }),
      );

      // Uses THIS project's own pinned `typescript` (devDependencies), invoked as
      // `node .../tsc.js` rather than the `.bin/tsc(.cmd)` shim — the shim is a shell script /
      // Windows `.cmd` wrapper, and `execFileSync` refuses to spawn a `.cmd` directly on Windows
      // (EINVAL) without `shell: true`; going straight at the JS entrypoint is portable either way.
      const tscEntry = join(process.cwd(), "node_modules", "typescript", "lib", "tsc.js");
      const output = execFileSync(process.execPath, [tscEntry, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
      expect(output.trim()).toBe(""); // tsc prints nothing on a clean pass
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
