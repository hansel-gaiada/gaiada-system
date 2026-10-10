// WSK-15 — tenant contract semver, computed via WSK-14's OWN classifier
// (webdesk/payload/vocabulary/breaking-change.ts's `classifyTenantContractChange`/`bumpVersion`).
// Per this ticket's brief ("use them, do not reimplement version logic"), this file contains NO
// version-bump rules of its own — it only adapts a `TenantComposition` (composition.ts's shape,
// what this ticket's DB query produces) into the `TenantContractSnapshot` shape
// `classifyTenantContractChange` expects, and calls straight through.
import type { TenantComposition } from "../../../../payload/vocabulary/composition.ts";
import {
  classifyTenantContractChange,
  bumpVersion,
  type TenantContractSnapshot,
} from "../../../../payload/vocabulary/breaking-change.ts";

/** `TenantComposition` (`{ fields?, blocks?, singleton?, localized?, ui?, lint? }`) ->
 *  `TenantContractSnapshot` (`{ fields: [], blocks?, singleton?, localized?, ui?, lint? }`)
 *  — breaking-change.ts's `CollectionFieldSet.fields` is non-optional (it diffs field ARRAYS
 *  directly), so a blocks-only collection with no declared `fields` maps to `fields: []`, which is
 *  the correct "nothing here to have removed/added" baseline for the diff.
 *
 *  WSK-41: the 1.1.0 collection keys are carried too. Before this, the snapshot held only
 *  `{fields, blocks}`, so the classifier's WSK-64 tenant-axis rules (a `singleton`/`localized` flip is
 *  MAJOR, a `ui`/`lint` edit is PATCH) never saw their inputs and a composition flip was rated
 *  "no structural change" (PATCH). A key is copied only when the composition declares it, so a
 *  collection that declares none of them snapshots exactly as before (byte-stable for the
 *  codegen determinism gate). */
export function toContractSnapshot(composition: TenantComposition): TenantContractSnapshot {
  const collections: TenantContractSnapshot["collections"] = {};
  for (const [key, comp] of Object.entries(composition)) {
    const entry: TenantContractSnapshot["collections"][string] = { fields: comp.fields ?? [], blocks: comp.blocks };
    if (comp.singleton !== undefined) entry.singleton = comp.singleton;
    if (comp.localized !== undefined) entry.localized = comp.localized;
    if (comp.ui !== undefined) entry.ui = comp.ui;
    if (comp.lint !== undefined) entry.lint = comp.lint;
    collections[key] = entry;
  }
  return { collections };
}

/** `previous === null` (no prior generation for this tenant, or the double-run gate's
 *  deliberately-history-free baseline mode — see `generate-single.mts`) always yields `1.0.0`,
 *  matching every other "first thing to exist" convention in this codebase (semver's own
 *  starting point). Otherwise: classify the diff, bump the previous version by whatever
 *  `classifyTenantContractChange` computed — never re-judged, per breaking-change.ts's own
 *  doctrine. */
export function computeNextContractVersion(
  previous: { version: string; snapshot: TenantContractSnapshot } | null,
  currentComposition: TenantComposition,
): { version: string; reasons: string[] } {
  const current = toContractSnapshot(currentComposition);
  if (!previous) return { version: "1.0.0", reasons: ["first generation for this tenant"] };

  const classification = classifyTenantContractChange(previous.snapshot, current);
  return { version: bumpVersion(previous.version, classification.bump), reasons: classification.reasons };
}
