import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  isNodeAllowedPath,
  nodePackageJson,
  nodeEnvExample,
  nodeVendoredSdk,
  blockTypesModule,
  reactBlocksModule,
  NODE_WEB_ROOT,
} from "./node-site";

// The Next + Nest template (WSK-D74) is a sibling project: webdesk/templates/fullstack-next-nest/.
const TEMPLATE = path.resolve(__dirname, "../../../../webdesk/templates/fullstack-next-nest");

describe("node siteKind (fullstack: Next + Nest) fills apps/web only", () => {
  it("allows apps/web, docs and CONTRACT.lock, and nothing of the workspace root or apps/api", () => {
    for (const ok of ["apps/web/src/app/page.tsx", "apps/web/package.json", "docs/PRD.md", "CONTRACT.lock"]) expect(isNodeAllowedPath(ok)).toBe(true);
    for (const no of ["package.json", "README.md", ".gitignore", ".env.example", "docker-compose.yml", "apps/api/src/main.ts", "apps/webx/a.ts", "src/pages/index.astro", "vendor/x"]) {
      expect(isNodeAllowedPath(no)).toBe(false);
    }
  });

  it("every file it composes is inside the allowed areas", () => {
    const files = [
      nodePackageJson(),
      nodeEnvExample(),
      ...nodeVendoredSdk({ sdkTsSource: "export interface paths {}\n", contractVersion: "1.0.0" }),
      blockTypesModule(),
      reactBlocksModule(),
    ];
    expect(files.filter((f) => !isNodeAllowedPath(f.path)).map((f) => f.path)).toEqual([]);
  });

  it("apps/web/package.json keeps the template's own dependencies and scripts (drift gate) and adds the vendored SDK", () => {
    const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATE, "apps/web/package.json"), "utf8")) as Record<string, Record<string, string>>;
    const gen = JSON.parse(String(nodePackageJson().content)) as Record<string, Record<string, string>>;
    expect(nodePackageJson().path).toBe(`${NODE_WEB_ROOT}/package.json`);
    for (const section of ["dependencies", "devDependencies", "scripts"] as const) {
      for (const [k, v] of Object.entries(tpl[section])) expect(gen[section][k], `${section}.${k}`).toBe(v);
    }
    expect((gen as unknown as { name: string }).name).toBe((tpl as unknown as { name: string }).name);
    expect(gen.dependencies["@gaiada/webdesk-sdk"]).toBe("file:./vendor/webdesk-sdk");
    // the Astro library is a dependency the Next app could never use
    expect(gen.dependencies["@gaiada/webdesk-blocks"]).toBeUndefined();
    expect(gen.dependencies.astro).toBeUndefined();
  });

  it(".env.example names keys and never carries a value", () => {
    const text = String(nodeEnvExample().content);
    expect(text).toContain("WEBDESK_HOST=\n");
    expect(text).toContain("WEBDESK_API_KEY=\n");
    expect(text.split("\n").filter((l) => /^[A-Z_]+=./.test(l))).toEqual([]);
  });

  it("the vendored SDK is a types-only local package", () => {
    const [dts, pkg] = nodeVendoredSdk({ sdkTsSource: "export interface paths {}\n", contractVersion: "1.4.0" });
    expect(dts.path).toBe("apps/web/vendor/webdesk-sdk/index.d.ts");
    expect(JSON.parse(String(pkg.content))).toEqual({ name: "@gaiada/webdesk-sdk", version: "1.4.0", private: true, types: "./index.d.ts" });
  });
});

describe("the React block renderer (generated text)", () => {
  const blocks = String(reactBlocksModule().content);
  const types = String(blockTypesModule().content);

  it("never injects raw HTML and never executes anything", () => {
    expect(blocks).not.toContain("dangerouslySetInnerHTML");
    expect(blocks).not.toMatch(/\beval\(|new Function\(|\brequire\(|\bimport\(/);
  });

  it("keeps the output-safety allow-lists and the renderer invariant", () => {
    expect(blocks).toContain("safeHref");
    expect(blocks).toContain("safeImgSrc");
    expect(blocks).toContain("rendered nothing"); // an unknown block renders nothing and is reported
    expect(blocks).toContain("DraftBanner");
    expect(blocks).toContain("LocaleFallbackNotice");
  });

  it("carries its own regexes intact (String.raw, not an escaped copy)", () => {
    expect(blocks).toContain("/[" + String.fromCharCode(92) + "x00-" + String.fromCharCode(92) + "x20" + String.fromCharCode(92) + "x7f]+/g");
    expect(blocks).toContain("/^[^\\\\:/?#]+(?:[/?#][^\\\\]*)?$/");
  });

  it("knows all ten vocabulary block types, in a JSX-free module", () => {
    for (const t of ["hero", "richText", "gallery", "cta", "featureGrid", "form", "testimonial", "faq", "logoCloud", "fields"]) {
      expect(types).toContain(`"${t}"`);
    }
    expect(types).not.toContain("<");
  });

  it("contains no backtick (so it can never carry an interpolation) ", () => {
    expect(blocks).not.toContain("`");
    expect(types).not.toContain("`");
  });
});
