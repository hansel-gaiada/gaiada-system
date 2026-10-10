// WSK-15 — derives `CONTENT-CONTRACT.md` from the SAME input `openapi-builder.mts` consumes
// (not by re-parsing the OpenAPI JSON it produces — that would be a second, lossy transform of
// the same source data for no benefit). Human-readable restatement of the contract a scaffolded
// site (WSK-20) or its author reads before writing a single fetch call.
//
// WSK-64 (vocabulary 1.1.0): a collection that declares `fields` carries them in the composition-
// typed `fields` block at blocks[0]; group sub-fields are listed nested, and `multiple`, `itemKey`
// and `localized: false` are stated per field. Editor-only `ui` hints are not part of the contract.
import type { ComposableBlockType } from "../../../../delivery/vocabulary/blocks.ts";
import { BLOCKS } from "../../../../delivery/vocabulary/blocks.ts";
import type { FieldDef } from "../../../../delivery/vocabulary/primitives.ts";
import type { TenantComposition } from "../../../../delivery/vocabulary/composition.ts";
import type { OpenApiBuilderInput } from "./openapi-builder.mts";

function fieldLine(f: FieldDef, depth = 0): string {
  const req = f.required ? "required" : "optional";
  const opts = f.options && f.options.length > 0 ? ` (one of: ${f.options.join(", ")})` : "";
  const list = f.multiple ? ", list" : "";
  const key = f.multiple && f.itemKey ? `, items keyed by \`${f.itemKey}\`` : "";
  const neutral = f.localized === false ? ", locale-neutral (the default-locale value is authoritative)" : "";
  const lines = [`${"  ".repeat(depth + 1)}- \`${f.name}\` — ${f.primitive}${list}, ${req}${opts}${key}${neutral}`];
  if (f.primitive === "group") for (const sub of f.fields ?? []) lines.push(fieldLine(sub, depth + 1));
  return lines.join("\n");
}

function blockSection(type: ComposableBlockType): string {
  const lines = [`- **${type}**`];
  for (const f of BLOCKS[type].fields) lines.push(fieldLine(f));
  return lines.join("\n");
}

export function renderContentContractMd(input: OpenApiBuilderInput): string {
  const collectionKeys = Object.keys(input.composition).sort();
  const lines: string[] = [];

  lines.push(`# WebDesk content contract — ${input.tenantSlug}`);
  lines.push("");
  lines.push(`- Contract version: \`${input.contractVersion}\``);
  lines.push(`- Vocabulary version: \`${input.vocabularyVersion}\``);
  lines.push(`- Default locale: \`${input.defaultLocale}\` · Declared locales: ${[...input.locales].sort().map((l) => `\`${l}\``).join(", ")}`);
  lines.push("");
  lines.push(
    "Derived from `openapi.v1.json` in the same generation run (WSK-D19: OpenAPI is the one " +
      "hand-authored source; this file and the TS SDK are both derived from it/its input, never " +
      "hand-maintained separately). Describes exactly what `webdesk/api/src/delivery/router.ts` " +
      "(design §06) serves under the frozen `/v1` envelope — see design §05 for the envelope's full shape.",
  );
  lines.push("");

  lines.push("## Authentication");
  lines.push("");
  lines.push("`Authorization: Bearer <api key>` on every request — a tenant/environment-scoped key minted via the control plane (design §03/§08). No cookies, no session state.");
  lines.push("");

  lines.push("## Collections");
  lines.push("");
  if (collectionKeys.length === 0) {
    lines.push("_This tenant has no collections composed yet._");
  }
  for (const key of collectionKeys) {
    const comp: TenantComposition[string] = input.composition[key];
    lines.push(`### \`${key}\``);
    lines.push("");
    lines.push(`- \`GET /v1/t/${input.tenantSlug}/${key}\` — cursor-paginated list`);
    lines.push(`- \`GET /v1/t/${input.tenantSlug}/${key}/{slug}\` — one item`);
    lines.push("");
    if (comp.fields !== undefined) {
      lines.push('**Fields** — carried in `blocks[0]` as `{ "type": "fields", "props": { ... } }` (vocabulary 1.1.0). Closed: no other keys.');
      for (const f of comp.fields) lines.push(fieldLine(f));
      if (comp.singleton) lines.push("- Singleton: at most one item per locale.");
      if (comp.localized === false) lines.push("- Not localized: items exist only in the default locale.");
      lines.push("");
    }
    if (comp.blocks === undefined) {
      lines.push(`**Blocks:** unrestricted — any of the vocabulary's generic block types may appear${comp.fields !== undefined ? " after the fields block" : ""} (composition declares no \`blocks\` allow-list).`);
    } else if (comp.blocks.length === 0) {
      lines.push(comp.fields !== undefined ? "**Blocks:** none besides the fields block." : "**Blocks:** none — this collection never carries page blocks.");
    } else {
      lines.push("**Blocks** (this collection's declared allow-list):");
      lines.push("");
      for (const type of comp.blocks) lines.push(blockSection(type));
    }
    lines.push("");
  }

  lines.push("## Other routes");
  lines.push("");
  lines.push(`- \`GET /v1/t/${input.tenantSlug}/search?q=...\` — full-text search across every collection (Postgres tsvector, per-locale config)`);
  lines.push(`- \`GET /v1/t/${input.tenantSlug}/sitemap.xml\` — generated sitemap for the resolved locale`);
  lines.push("");

  lines.push("## Pagination");
  lines.push("");
  lines.push("Cursor-based (`?cursor=`, `?limit=`, default/max 25/100), stable under concurrent publish — never offset-based. `page.hasMore` + `page.cursor` drive the next request; `page.cursor` is `null` on the last page.");
  lines.push("");

  lines.push("## Errors");
  lines.push("");
  lines.push("Every non-2xx response is RFC 9457 `application/problem+json` — one shape (`type`, `title`, `status`, `detail?`, `instance`, `requestId`) for every failure. See `openapi.v1.json`'s `ProblemDetails` schema.");
  lines.push("");

  return lines.join("\n");
}
