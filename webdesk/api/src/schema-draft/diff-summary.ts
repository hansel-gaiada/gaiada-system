// WSK-32 — the human-readable diff a WS4 reviewer approves. Deliberately a NARROWER, purpose-built
// diff rather than a reuse of WSK-14's `classifyTenantContractChange` (payload/vocabulary/
// breaking-change.ts): that classifier cannot be imported here for the same commonjs/ESM-.ts
// boundary reason documented in ./vocabulary-vendor.ts's header, and vendoring its full ~150-line
// MAJOR/MINOR/PATCH machinery (three axes, vocabulary-change propagation, renderer diffs — none of
// which this ticket's AC asks for) would be scope creep. What this ticket's AC actually needs is
// narrower and is built directly: "state what would change in terms a reviewer can actually check,
// including anything destructive (a removed field is data loss)." That is exactly what this file
// computes — a flat, itemized diff with an explicit `destructive` flag — never a bare version bump.
import type { BlockType, CollectionComposition, FieldDef } from "./vocabulary-vendor";

export type DiffEntryKind =
  | "field-added"
  | "field-added-required"
  | "field-removed"
  | "field-type-changed"
  | "field-required-flipped-on"
  | "field-required-flipped-off"
  | "block-added"
  | "block-removed";

export interface DiffEntry {
  kind: DiffEntryKind;
  path: string;
  message: string;
  /** True when approving this entry can destroy tenant data or break existing composed content —
   *  the ticket's own example: "a removed field is data loss." A reviewer must be able to see this
   *  per-entry, not infer it from a version number. */
  destructive: boolean;
}

export interface DiffSummary {
  collectionKey: string;
  /** True iff the collection did not exist before (nothing to diff against) — the proposal is a
   *  pure addition by construction; still reported with `entries` covering every field/block as
   *  "added" so the reviewer sees the full shape, not just a boolean. */
  isNewCollection: boolean;
  entries: DiffEntry[];
  /** True iff ANY entry is destructive — the single flag a reviewer's "does this delete data?"
   *  question resolves to; never buried in prose. */
  destructive: boolean;
  addedFieldNames: string[];
  removedFieldNames: string[];
  addedBlocks: BlockType[];
  removedBlocks: BlockType[];
}

function fieldByName(fields: FieldDef[] | undefined): Map<string, FieldDef> {
  return new Map((fields ?? []).map((f) => [f.name, f]));
}

/** Pure. Computes the reviewer-facing diff between the collection's CURRENT composition (`null` if
 *  the collection does not exist yet) and the AI-drafted PROPOSED composition. Never mutates
 *  either argument; never touches the network or the database. */
export function buildDiffSummary(collectionKey: string, current: CollectionComposition | null, proposed: CollectionComposition): DiffSummary {
  const entries: DiffEntry[] = [];
  const currentFields = fieldByName(current?.fields);
  const proposedFields = fieldByName(proposed.fields);
  const currentBlocks = new Set(current?.blocks ?? []);
  const proposedBlocks = new Set(proposed.blocks ?? []);

  const addedFieldNames: string[] = [];
  const removedFieldNames: string[] = [];

  for (const [name] of currentFields) {
    if (!proposedFields.has(name)) {
      removedFieldNames.push(name);
      entries.push({
        kind: "field-removed",
        path: `${collectionKey}.fields.${name}`,
        message: `field "${name}" would be REMOVED — any content already stored in this field is lost on apply`,
        destructive: true,
      });
    }
  }

  for (const [name, field] of proposedFields) {
    if (!currentFields.has(name)) {
      addedFieldNames.push(name);
      entries.push(
        field.required
          ? {
              kind: "field-added-required",
              path: `${collectionKey}.fields.${name}`,
              message: `field "${name}" would be added as REQUIRED — existing content items that never supplied it will fail to satisfy the new requirement`,
              destructive: true,
            }
          : {
              kind: "field-added",
              path: `${collectionKey}.fields.${name}`,
              message: `field "${name}" would be added as optional (non-destructive)`,
              destructive: false,
            },
      );
    }
  }

  for (const [name, before] of currentFields) {
    const after = proposedFields.get(name);
    if (!after) continue;
    if (before.primitive !== after.primitive) {
      entries.push({
        kind: "field-type-changed",
        path: `${collectionKey}.fields.${name}.primitive`,
        message: `field "${name}" would change type from "${before.primitive}" to "${after.primitive}" — existing values may no longer be valid`,
        destructive: true,
      });
    }
    const wasRequired = !!before.required;
    const isRequired = !!after.required;
    if (!wasRequired && isRequired) {
      entries.push({
        kind: "field-required-flipped-on",
        path: `${collectionKey}.fields.${name}.required`,
        message: `field "${name}" would flip optional -> required — existing content missing it will fail`,
        destructive: true,
      });
    } else if (wasRequired && !isRequired) {
      entries.push({
        kind: "field-required-flipped-off",
        path: `${collectionKey}.fields.${name}.required`,
        message: `field "${name}" would relax required -> optional (non-destructive)`,
        destructive: false,
      });
    }
  }

  const addedBlocks: BlockType[] = [];
  const removedBlocks: BlockType[] = [];

  for (const b of currentBlocks) {
    if (!proposedBlocks.has(b)) {
      removedBlocks.push(b);
      entries.push({
        kind: "block-removed",
        path: `${collectionKey}.blocks.${b}`,
        message: `block type "${b}" would be removed from this collection's allowed set — existing content_items using it can no longer be re-saved as-is`,
        destructive: true,
      });
    }
  }
  for (const b of proposedBlocks) {
    if (!currentBlocks.has(b)) {
      addedBlocks.push(b);
      entries.push({
        kind: "block-added",
        path: `${collectionKey}.blocks.${b}`,
        message: `block type "${b}" would be added to this collection's allowed set (non-destructive)`,
        destructive: false,
      });
    }
  }

  return {
    collectionKey,
    isNewCollection: current === null,
    entries,
    destructive: entries.some((e) => e.destructive),
    addedFieldNames,
    removedFieldNames,
    addedBlocks,
    removedBlocks,
  };
}
