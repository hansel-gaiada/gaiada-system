// WSK-41 — the pure half of the write plane (write-plane design §2.6, §2.7, §3.3): how an authoring
// request becomes the `{blocks, seo}` a version stores and the projection serves, how that content is
// validated against the collection's composition, and how it is hashed.
//
// Storage model (ruling WSK-D45): content_versions is the working copy; content_items is the live
// projection the frozen /v1 read path serves. Everything here is about ONE item's content and is
// side-effect free; the state machine (which version is projected when) lives in
// content-commands.service.ts.
//
// The `redirect` system collection is the one documented exception (§2.7): its typed values are
// stored under `seo.redirect` (string-typed `status`/`active`) with `blocks: []`, because
// listRedirects and the /v1 port read them there. It never goes through validateItemContent; its
// values are checked with validateFieldValues against the collection's declared fields (or the fixed
// redirect field set when the collection declares none).
import { createHash } from "node:crypto";
import { canonicalize } from "../auth/ws4-assertion";
import { validateItemContent, validateFieldValues, type ItemIssue } from "../../delivery/vocabulary/item-fields";
import type { CollectionComposition } from "../../delivery/vocabulary/composition";
import type { FieldDef } from "../../delivery/vocabulary/primitives";
import { REDIRECT_COLLECTION_KEY } from "../../delivery/redirects";

export { REDIRECT_COLLECTION_KEY };

/** Item slug grammar (design §2.5 rule 6). The `redirect` collection is exempt (its slug is a path). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 200;
/** A redirect's slug is its from-path. */
export const REDIRECT_SLUG_PATTERN = /^\/[^\s]*$/;
export const MAX_REDIRECT_SLUG_LENGTH = 2048;

/** Size caps (design §3.3). */
export const MAX_ITEM_CONTENT_BYTES = 512 * 1024;
export const MAX_MARKDOWN_BYTES = 256 * 1024;

/** The fixed redirect field set — identical to payload/collections/redirects.ts ensureRedirectCollection. */
export const REDIRECT_FIELDS: FieldDef[] = [
  { name: "toPath", primitive: "text", required: true },
  { name: "status", primitive: "select", options: ["301", "302", "307", "308"] },
  { name: "active", primitive: "select", options: ["true", "false"] },
];

/** Where a collection's typed field values live (design §2.7). */
export function fieldsCarrierFor(collectionKey: string): "block" | "seo.redirect" {
  return collectionKey === REDIRECT_COLLECTION_KEY ? "seo.redirect" : "block";
}

/** sha256 hex of the canonical `{blocks, seo}` (ws4-assertion.ts's canonicalize: sorted keys). */
export function contentHash(blocks: unknown, seo: unknown): string {
  return createHash("sha256").update(canonicalize({ blocks, seo })).digest("hex");
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** What an authoring request supplies for an item's content. */
export interface ContentInput {
  fields?: Record<string, unknown>;
  blocks?: unknown[];
  seo?: Record<string, unknown>;
}

function seoIssues(seo: unknown, carrier: "block" | "seo.redirect"): ItemIssue[] {
  if (!isPlainObject(seo)) return [{ path: "/seo", message: "seo must be an object", expected: "{ title?, description?, ... }" }];
  const issues: ItemIssue[] = [];
  for (const k of ["title", "description"] as const) {
    if (seo[k] !== undefined && typeof seo[k] !== "string") {
      issues.push({ path: `/seo/${k}`, message: `seo.${k} must be a string when present`, expected: "string" });
    }
  }
  if (carrier === "block" && seo.redirect !== undefined) {
    issues.push({ path: "/seo/redirect", message: "seo.redirect is reserved for the redirect system collection" });
  }
  return issues;
}

function redirectFieldDefs(composition: CollectionComposition): FieldDef[] {
  return Array.isArray(composition.fields) && composition.fields.length > 0 ? composition.fields : REDIRECT_FIELDS;
}

/**
 * Validates STORED content (`{blocks, seo}` as a version holds it) against the collection's current
 * composition. Used on create/update (after assembly), and again on restore and publish: a version
 * that was valid when written can be invalid under a composition changed since.
 */
export function validateStoredContent(
  collectionKey: string,
  composition: CollectionComposition,
  blocks: unknown,
  seo: unknown,
): ItemIssue[] {
  const carrier = fieldsCarrierFor(collectionKey);
  const issues = seoIssues(seo, carrier);
  if (carrier === "seo.redirect") {
    if (!Array.isArray(blocks) || blocks.length !== 0) {
      issues.push({ path: "/blocks", message: "the redirect collection carries no blocks: its values live under seo.redirect", expected: "[]" });
    }
    const value = isPlainObject(seo) ? seo.redirect : undefined;
    issues.push(...validateFieldValues(redirectFieldDefs(composition), value, "/seo/redirect"));
    return issues;
  }
  issues.push(...validateItemContent(composition, blocks).issues);
  return issues;
}

/**
 * Turns an authoring request's `{fields, blocks, seo}` into the stored `{blocks, seo}`:
 *   - a fields collection gets `blocks[0] = { type: 'fields', props: fields }`, then the request's blocks;
 *   - a collection that declares no fields must not be sent `fields`;
 *   - the redirect collection stores `fields` under `seo.redirect`, with `blocks: []`.
 * Then validates the result (validateStoredContent). Never modifies a value.
 */
export function assembleItemContent(
  collectionKey: string,
  composition: CollectionComposition,
  input: ContentInput,
): { blocks: unknown[]; seo: Record<string, unknown>; issues: ItemIssue[] } {
  const issues: ItemIssue[] = [];
  const seoIn = input.seo ?? {};
  if (fieldsCarrierFor(collectionKey) === "seo.redirect") {
    if (isPlainObject(seoIn) && seoIn.redirect !== undefined) {
      issues.push({ path: "/seo/redirect", message: "send the redirect values as `fields`; seo.redirect is derived from them" });
    }
    if (input.blocks !== undefined && (!Array.isArray(input.blocks) || input.blocks.length > 0)) {
      issues.push({ path: "/blocks", message: "the redirect collection carries no blocks", expected: "[] or absent" });
    }
    const seo = { ...(isPlainObject(seoIn) ? seoIn : {}), redirect: input.fields ?? {} };
    issues.push(...validateStoredContent(collectionKey, composition, [], seo));
    return { blocks: [], seo, issues };
  }

  const declaresFields = Array.isArray(composition.fields);
  if (!declaresFields && input.fields !== undefined) {
    issues.push({ path: "/fields", message: "this collection's composition declares no fields, so `fields` must be absent" });
  }
  const tail = input.blocks ?? [];
  const blocks = declaresFields ? [{ type: "fields", props: input.fields ?? {} }, ...tail] : [...tail];
  const seo = isPlainObject(seoIn) ? seoIn : {};
  issues.push(...validateStoredContent(collectionKey, composition, blocks, seoIn));
  return { blocks, seo, issues };
}

function markdownOverCap(fields: FieldDef[], value: unknown, path: string, out: string[]): void {
  if (!isPlainObject(value)) return;
  for (const f of fields) {
    const v = value[f.name];
    if (v === undefined || v === null) continue;
    const at = `${path}/${f.name}`;
    const values = f.multiple && Array.isArray(v) ? v : [v];
    values.forEach((one, i) => {
      const p = f.multiple ? `${at}/${i}` : at;
      if (f.primitive === "markdown" && typeof one === "string" && Buffer.byteLength(one, "utf8") > MAX_MARKDOWN_BYTES) {
        out.push(p);
      } else if (f.primitive === "group" && Array.isArray(f.fields)) {
        markdownOverCap(f.fields, one, p, out);
      }
    });
  }
}

/** The 413 check (design §3.3): content <= 512 KiB per item, each markdown value <= 256 KiB. Null when within. */
export function sizeViolation(composition: CollectionComposition, blocks: unknown, seo: unknown): string | null {
  const bytes = Buffer.byteLength(JSON.stringify({ blocks, seo }), "utf8");
  if (bytes > MAX_ITEM_CONTENT_BYTES) {
    return `item content is ${bytes} bytes; the limit is ${MAX_ITEM_CONTENT_BYTES} bytes per item`;
  }
  if (Array.isArray(composition.fields) && Array.isArray(blocks) && isPlainObject(blocks[0]) && blocks[0].type === "fields") {
    const over: string[] = [];
    markdownOverCap(composition.fields, (blocks[0] as Record<string, unknown>).props, "/blocks/0/props", over);
    if (over.length > 0) {
      return `markdown value(s) over ${MAX_MARKDOWN_BYTES} bytes at ${over.join(", ")}`;
    }
  }
  return null;
}

/** Slug grammar (design §2.5 rule 6), or the redirect from-path rule. Null when valid. */
export function slugIssue(collectionKey: string, slug: string): ItemIssue | null {
  if (fieldsCarrierFor(collectionKey) === "seo.redirect") {
    return slug.length <= MAX_REDIRECT_SLUG_LENGTH && REDIRECT_SLUG_PATTERN.test(slug)
      ? null
      : { path: "/slug", message: "a redirect's slug is its from-path: it starts with '/' and has no whitespace", expected: "/from/path" };
  }
  return slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug)
    ? null
    : { path: "/slug", message: "the slug does not match the item slug grammar", expected: `${SLUG_PATTERN.source} (<= ${MAX_SLUG_LENGTH} chars)` };
}
