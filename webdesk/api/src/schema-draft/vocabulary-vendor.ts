// WSK-32 — a VENDORED (not imported) copy of WSK-14's vocabulary constants + Layer-2 composition
// validator (webdesk/payload/vocabulary/{primitives,blocks,composition}.ts).
//
// Why vendored instead of imported: webdesk/api/src/codegen/contract-manifest.types.ts already
// documents the real constraint this file inherits verbatim —
//
//   "the NestJS control-plane side ... plain commonjs, compiled by `tsc -p tsconfig.json`, MUST
//   NOT transitively import anything from `webdesk/payload/vocabulary/**` (those files use ESM
//   `.ts`-extension relative imports among themselves — e.g. blocks.ts's `from './primitives.ts'`
//   — which `tsc` under this project's `"module": "commonjs"` setting cannot resolve without
//   `allowImportingTsExtensions`, a flag that itself forces `noEmit: true` and would break
//   `npm run build`)."
//
// webdesk/blocks (WSK-16, the block-renderer library) hit the exact same cross-project boundary
// and resolved it the same way this file does: vendor, with an explicit drift check rather than a
// silent copy (see webdesk/blocks/scripts/vendor-vocabulary.mjs + test/unit/vendor-drift.test.mjs
// for that ticket's version of this same pattern). This file's counterpart is
// ../../test/schema-draft/vendor-drift.spec.ts, which reads the REAL source files as TEXT (never
// imports them) and regex-asserts the constants below still match. If that test goes red, the
// vocabulary changed and this file needs to be re-vendored by hand — it will never drift silently.
//
// Scope: only what WSK-32's AI drafting flow needs to REJECT an out-of-vocabulary proposal at
// draft time — the same rule composition.ts enforces, transcribed rather than re-derived. This
// file does not vendor breaking-change.ts's semver classifier; ./diff-summary.ts builds its own
// reviewer-facing diff instead of reproducing that classifier's official bump (see that file's
// header for why a separate, narrower diff is the honest scope here).

// --- Layer 1 constants (payload/vocabulary/primitives.ts, blocks.ts, version.ts) --------------

export type PrimitiveName = "text" | "richtext" | "media" | "relation" | "number" | "date" | "select" | "geo";

export const PRIMITIVE_NAMES: readonly PrimitiveName[] = ["text", "richtext", "media", "relation", "number", "date", "select", "geo"];

export type BlockType = "hero" | "richText" | "gallery" | "cta" | "featureGrid" | "form" | "testimonial" | "faq" | "logoCloud";

export const BLOCK_TYPE_NAMES: readonly BlockType[] = [
  "hero",
  "richText",
  "gallery",
  "cta",
  "featureGrid",
  "form",
  "testimonial",
  "faq",
  "logoCloud",
];

export const VOCABULARY_VERSION = "1.0.0";

function isPrimitiveName(v: unknown): v is PrimitiveName {
  return typeof v === "string" && (PRIMITIVE_NAMES as readonly string[]).includes(v);
}

function isBlockType(v: unknown): v is BlockType {
  return typeof v === "string" && (BLOCK_TYPE_NAMES as readonly string[]).includes(v);
}

// --- Layer 2 shape (payload/vocabulary/composition.ts) -----------------------------------------

export interface FieldDef {
  name: string;
  primitive: PrimitiveName;
  required?: boolean;
  options?: string[];
  relationTo?: string;
  multiple?: boolean;
}

export interface CollectionComposition {
  fields?: FieldDef[];
  blocks?: BlockType[];
}

export interface CompositionIssue {
  /** JSON-pointer-ish path to the offending construct, e.g. `case-study.fields[2].primitive` —
   *  never a bare "invalid" (mirrors composition.ts's own AC). */
  path: string;
  message: string;
  expected?: string;
}

export interface CompositionValidationResult {
  valid: boolean;
  issues: CompositionIssue[];
}

const KNOWN_COLLECTION_KEYS = new Set(["fields", "blocks"]);
const KNOWN_FIELD_KEYS = new Set(["name", "primitive", "required", "options", "relationTo", "multiple"]);

function issue(path: string, message: string, expected?: string): CompositionIssue {
  return expected ? { path, message, expected } : { path, message };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateFieldDef(path: string, raw: unknown): CompositionIssue[] {
  if (!isPlainObject(raw)) {
    return [issue(path, "expected a field object", "{ name: string, primitive: <vocabulary primitive>, ... }")];
  }
  const issues: CompositionIssue[] = [];
  const f = raw;

  for (const k of Object.keys(f)) {
    if (!KNOWN_FIELD_KEYS.has(k)) {
      issues.push(issue(`${path}.${k}`, `unknown field key "${k}" — not part of the vocabulary's FieldDef shape`, [...KNOWN_FIELD_KEYS].sort().join(" | ")));
    }
  }

  if (typeof f.name !== "string" || f.name.trim().length === 0) {
    issues.push(issue(`${path}.name`, "field name must be a non-empty string", "string"));
  }

  if (typeof f.primitive !== "string") {
    issues.push(issue(`${path}.primitive`, "primitive must be a string", PRIMITIVE_NAMES.join(" | ")));
  } else if (!isPrimitiveName(f.primitive)) {
    issues.push(issue(`${path}.primitive`, `"${f.primitive}" is not one of the ${PRIMITIVE_NAMES.length} vocabulary primitives`, PRIMITIVE_NAMES.join(" | ")));
  } else {
    if (f.primitive === "select") {
      const opts = f.options;
      if (!Array.isArray(opts) || opts.length === 0 || !opts.every((o) => typeof o === "string")) {
        issues.push(issue(`${path}.options`, 'a "select" field requires a non-empty array of string options', "string[]"));
      }
    }
    if (f.primitive === "relation") {
      if (typeof f.relationTo !== "string" || f.relationTo.trim().length === 0) {
        issues.push(issue(`${path}.relationTo`, 'a "relation" field requires a non-empty relationTo', "string (a collection key)"));
      }
    }
  }

  if (f.required !== undefined && typeof f.required !== "boolean") {
    issues.push(issue(`${path}.required`, "required must be a boolean when present", "boolean"));
  }
  if (f.multiple !== undefined && typeof f.multiple !== "boolean") {
    issues.push(issue(`${path}.multiple`, "multiple must be a boolean when present", "boolean"));
  }

  return issues;
}

/** Validates ONE collection's composition proposal against the vendored vocabulary. Pure, sync — same rule set as WSK-14's `validateCollectionComposition` (payload/vocabulary/composition.ts). */
export function validateCollectionComposition(collectionKey: string, raw: unknown): CompositionValidationResult {
  if (!isPlainObject(raw)) {
    return {
      valid: false,
      issues: [issue(collectionKey, "expected a composition object", "{ fields?: FieldDef[], blocks?: BlockType[] }")],
    };
  }

  const issues: CompositionIssue[] = [];
  const c = raw;

  for (const k of Object.keys(c)) {
    if (!KNOWN_COLLECTION_KEYS.has(k)) {
      issues.push(issue(`${collectionKey}.${k}`, `unknown composition key "${k}" — not part of the Layer-2 composition shape`, [...KNOWN_COLLECTION_KEYS].sort().join(" | ")));
    }
  }

  if (c.fields !== undefined) {
    if (!Array.isArray(c.fields)) {
      issues.push(issue(`${collectionKey}.fields`, "fields must be an array", "FieldDef[]"));
    } else {
      const seen = new Set<string>();
      c.fields.forEach((f, i) => {
        const path = `${collectionKey}.fields[${i}]`;
        issues.push(...validateFieldDef(path, f));
        const name = isPlainObject(f) && typeof f.name === "string" ? f.name : null;
        if (name) {
          if (seen.has(name)) {
            issues.push(issue(`${path}.name`, `duplicate field name "${name}" within collection "${collectionKey}"`));
          }
          seen.add(name);
        }
      });
    }
  }

  if (c.blocks !== undefined) {
    if (!Array.isArray(c.blocks)) {
      issues.push(issue(`${collectionKey}.blocks`, "blocks must be an array", "BlockType[]"));
    } else {
      const seen = new Set<string>();
      c.blocks.forEach((b, i) => {
        const path = `${collectionKey}.blocks[${i}]`;
        if (typeof b !== "string") {
          issues.push(issue(path, "a block-type entry must be a string", BLOCK_TYPE_NAMES.join(" | ")));
        } else if (!isBlockType(b)) {
          issues.push(issue(path, `"${b}" is not one of the ${BLOCK_TYPE_NAMES.length} vocabulary block types`, BLOCK_TYPE_NAMES.join(" | ")));
        } else if (seen.has(b)) {
          issues.push(issue(path, `duplicate block type "${b}" declared for collection "${collectionKey}"`));
        } else {
          seen.add(b);
        }
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export function formatCompositionIssues(issues: CompositionIssue[]): string[] {
  return issues.map((i) => (i.expected ? `${i.path}: ${i.message} (expected: ${i.expected})` : `${i.path}: ${i.message}`));
}
