// WSK-20 — a MINIMAL, LOCAL mirror of webdesk-design.md §05 Layer 1 (vocabulary v1: fixed, the
// shared code). This ticket's hard constraints forbid editing/depending on `webdesk/**`, and
// `webdesk/blocks` (WSK-16) vendors this same vocabulary into ITS OWN package rather than publishing
// a shared library either — there is no installable `@gaiada/webdesk-vocabulary` package to import
// here even if the scope allowed it. These two literal-union lists are the one piece of the frozen
// vocabulary this ticket's own code needs to know (to tell a real block/collection reference apart
// from a vocabulary gap) — kept intentionally tiny and cross-checked by this file's own test against
// the design doc's own §05 prose, so a future vocabulary MINOR (a 10th block type) is a one-line diff
// here, never a silent drift.
export const PRIMITIVE_NAMES = [
  "text",
  "richtext",
  "media",
  "relation",
  "number",
  "date",
  "select",
  "geo",
] as const;
export type PrimitiveName = (typeof PRIMITIVE_NAMES)[number];

export const BLOCK_TYPE_NAMES = [
  "hero",
  "richText",
  "gallery",
  "cta",
  "featureGrid",
  "form",
  "testimonial",
  "faq",
  "logoCloud",
] as const;
export type BlockType = (typeof BLOCK_TYPE_NAMES)[number];

export function isBlockType(v: string): v is BlockType {
  return (BLOCK_TYPE_NAMES as readonly string[]).includes(v);
}
