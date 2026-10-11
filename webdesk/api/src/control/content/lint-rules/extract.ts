// M5-W3 — turns an item's `{ blocks, seo }` into the view the content rules read. Pure. A body is a
// string value of a composition field typed `markdown` or `richtext` (nested groups included) or the
// `content` of a `richText` block. Field values of other primitives are never treated as body copy.
import type { FieldDef } from "../../../delivery/vocabulary/primitives";
import { parseMarkdown, type MdDoc } from "./markdown";
import type { ContentRulesConfig } from "./config";

export interface ContentLintInput {
  blocks: unknown;
  seo: unknown;
  /** The collection composition's relevant members. */
  composition: { fields?: FieldDef[]; localized?: boolean };
  locale: string;
  /** Locales of the other live items in this item's localization group; null = could not be determined. */
  groupLocales: string[] | null;
}

export interface Body { path: string; text: string; doc: MdDoc }

export interface ContentView {
  bodies: Body[];
  /** Bodies of at least `longFormMinWords` words. */
  longForm: Body[];
  seoTitle: string | null;
  seoDescription: string | null;
  h1Field: string | null;
  keyword: string | null;
  /** Alt texts from `altFields` the composition declares; null = no such field is declared. */
  altTexts: string[] | null;
  altFieldPath: string | null;
  locale: string;
  localized: boolean;
  groupLocales: string[] | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function localeFamily(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0];
}

function collectBodies(fields: FieldDef[] | undefined, props: unknown, base: string, out: Array<{ path: string; text: string }>): void {
  if (!Array.isArray(fields) || !isRecord(props)) return;
  for (const f of fields) {
    const v = props[f.name];
    const at = `${base}/${f.name}`;
    if (f.primitive === "markdown" || f.primitive === "richtext") {
      const items = Array.isArray(v) ? v : [v];
      items.forEach((x, i) => {
        if (typeof x === "string" && x.trim() !== "") out.push({ path: Array.isArray(v) ? `${at}/${i}` : at, text: x });
      });
    } else if (f.primitive === "group" && f.fields) {
      if (Array.isArray(v)) v.forEach((x, i) => collectBodies(f.fields, x, `${at}/${i}`, out));
      else collectBodies(f.fields, v, at, out);
    }
  }
}

export function buildView(input: ContentLintInput, cfg: ContentRulesConfig): ContentView {
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  const seo = isRecord(input.seo) ? input.seo : {};
  const raw: Array<{ path: string; text: string }> = [];
  let fieldProps: Record<string, unknown> = {};
  let fieldsIdx = 0;
  blocks.forEach((b, i) => {
    if (!isRecord(b) || !isRecord(b.props)) return;
    if (b.type === "fields") {
      fieldProps = b.props;
      fieldsIdx = i;
      collectBodies(input.composition.fields, b.props, `/blocks/${i}/props`, raw);
    } else if (b.type === "richText" && typeof b.props.content === "string" && b.props.content.trim() !== "") {
      raw.push({ path: `/blocks/${i}/props/content`, text: b.props.content });
    }
  });
  const bodies = raw.map((r) => ({ ...r, doc: parseMarkdown(r.text) }));

  const declared = new Set((input.composition.fields ?? []).map((f) => f.name));
  let altTexts: string[] | null = null;
  let altFieldPath: string | null = null;
  for (const name of cfg.altFields) {
    if (!declared.has(name)) continue;
    altTexts = altTexts ?? [];
    altFieldPath = altFieldPath ?? `/blocks/${fieldsIdx}/props/${name}`;
    const v = fieldProps[name];
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x.trim() !== "") altTexts.push(x.trim());
  }
  return {
    bodies,
    longForm: bodies.filter((b) => b.doc.words >= cfg.longFormMinWords),
    seoTitle: str(seo.title),
    seoDescription: str(seo.description),
    h1Field: str(fieldProps[cfg.h1Field]),
    keyword: str(fieldProps[cfg.primaryKeywordField]),
    altTexts,
    altFieldPath,
    locale: input.locale,
    localized: input.composition.localized !== false,
    groupLocales: input.groupLocales,
  };
}
