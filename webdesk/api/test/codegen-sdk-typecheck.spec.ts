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
      composition: {
        "case-study": { blocks: ["hero", "richText"] },
        // WSK-64: a fields collection that allows no other block (every gaiada.com collection) ...
        service: {
          blocks: [],
          fields: [
            { name: "url", primitive: "text", required: true },
            { name: "publish_ready", primitive: "boolean", required: true },
            { name: "schema", primitive: "text", multiple: true },
            { name: "plan", primitive: "group", fields: [{ name: "action", primitive: "select", options: ["SHOW", "HOLD"], required: true }, { name: "why", primitive: "text" }] },
            { name: "body", primitive: "markdown", required: true },
          ],
        },
        // ... and one whose generic blocks may follow the fields block (the documented union fallback).
        faq: {
          blocks: ["richText"],
          fields: [{ name: "faq", primitive: "group", multiple: true, itemKey: "q", fields: [{ name: "q", primitive: "text", required: true }, { name: "a", primitive: "markdown", required: true }] }],
        },
      },
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
          "// WSK-64: a page item whose blocks[0] is the fields block, typed by the composition (exact tuple).",
          'type ServiceItem = paths["/v1/t/p1-tenant/service/{slug}"]["get"]["responses"]["200"]["content"]["application/json"];',
          "const _service: ServiceItem = {",
          '  collection: "service", slug: "service.seo", locale: "en", localizations: [{ locale: "id", slug: "service.seo" }],',
          '  seo: { title: "SEO Agency Bali" }, meta: { publishedAt: null, updatedAt: new Date().toISOString(), draft: false, x: {} },',
          '  blocks: [{ type: "fields", props: { url: "/services/seo/", publish_ready: false, schema: ["Service"], plan: { action: "SHOW" }, body: "# SEO" } }],',
          "};",
          "const _body: string = _service.blocks[0].props.body;",
          "const _ready: boolean = _service.blocks[0].props.publish_ready;",
          "",
          "// The union fallback still accepts the fields block followed by a generic block.",
          'type FaqItem = paths["/v1/t/p1-tenant/faq/{slug}"]["get"]["responses"]["200"]["content"]["application/json"];',
          "const _faq: FaqItem = {",
          '  collection: "faq", slug: "faq.general", locale: "en", localizations: [],',
          "  seo: {}, meta: { publishedAt: null, updatedAt: new Date().toISOString(), draft: false, x: {} },",
          '  blocks: [{ type: "fields", props: { faq: [{ q: "Why?", a: "**Because.**" }] } }, { type: "richText", props: { content: "x" } }],',
          "};",
          "",
          "// A list response of a fields collection still type-checks with blocks: [] (router.ts strips blocks).",
          'type ServiceList = paths["/v1/t/p1-tenant/service"]["get"]["responses"]["200"]["content"]["application/json"];',
          'const _serviceList: ServiceList = { collection: "service", locale: "en", page: { cursor: null, hasMore: false, limit: 25 }, items: [',
          '  { collection: "service", slug: "service.seo", locale: "en", localizations: [], seo: {}, meta: { publishedAt: null, updatedAt: "x", draft: false, x: {} }, blocks: [] },',
          "] };",
          "",
          "// The ProblemDetails error schema is a real component.",
          'type Problem = components["schemas"]["ProblemDetails"];',
          'const _err: Problem = { type: "https://x", title: "x", status: 404, instance: "/x", requestId: "x" };',
          "",
          "void _list; void _item; void _err; void _service; void _body; void _ready; void _faq; void _serviceList;",
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
