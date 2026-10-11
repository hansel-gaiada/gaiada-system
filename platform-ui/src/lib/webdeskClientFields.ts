// WSK-49d — what a CLIENT save sends as `fields` (§16j `PUT …/items/:itemId` body `{ baseVersion, fields?, blocks?, note? }`).
//
// The BFF refuses ANY change to a non-client-editable path (`422 field-not-client-editable`) and refills what the
// request omits from the head. `fields` itself is a whole replacement, so this builds it as: the BASELINE the editor
// loaded (so everything the client cannot edit goes back byte-for-byte as it was read) with the client-editable leaves
// taken from the draft. The form already renders non-editable fields read-only, so in practice draft == baseline there;
// building it this way means a normalisation of an untouched protected value (an empty string, a number's formatting)
// can never turn into a `422` about a field the client never touched.
//
// PURE. `editable` is the BFF's `clientEditable.fields` map, exactly as sent (dotted path -> bool; a missing entry is
// NOT editable). `seo` and generic blocks are never part of this: the editor does not send them in client mode.
import type { FieldDef } from "./webdeskContentModel";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asRec = (v: unknown): Record<string, unknown> => (isRec(v) ? v : {});

function mergeFields(
  defs: FieldDef[], editable: Record<string, boolean>, baseline: Record<string, unknown>, draft: Record<string, unknown>, prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...baseline };
  for (const def of defs) {
    const key = prefix ? `${prefix}.${def.name}` : def.name;
    const inDraft = Object.prototype.hasOwnProperty.call(draft, def.name) && draft[def.name] !== undefined;
    const inBase = Object.prototype.hasOwnProperty.call(baseline, def.name) && baseline[def.name] !== undefined;

    if (def.primitive === "group" && !def.multiple) {
      // A group's members each carry their own verdict (a member can be editable inside a group that is not).
      if (!inDraft && !inBase) continue;
      const nested = mergeFields(def.fields ?? [], editable, asRec(baseline[def.name]), asRec(draft[def.name]), key);
      // A group the stored content never had, and nothing in it set: leave it ABSENT. An empty `{}` would be a leaf the BFF reads as
      // a change to the group itself (a create must leave every non-editable part absent).
      if (!inBase && Object.keys(nested).length === 0) continue;
      out[def.name] = nested;
      continue;
    }

    if (def.primitive === "group" && def.multiple) {
      const b = Array.isArray(baseline[def.name]) ? (baseline[def.name] as unknown[]) : [];
      const d = Array.isArray(draft[def.name]) ? (draft[def.name] as unknown[]) : [];
      const beneath = Object.entries(editable).filter(([k]) => k.startsWith(`${key}.`));
      const allMembersEditable = beneath.length > 0 && beneath.every(([, v]) => v === true);
      if (b.length === d.length) {
        // Same rows: merge row by row, so only editable members move. (No rows and none stored: leave the list absent.)
        if (inBase || d.length > 0) out[def.name] = d.map((row, i) => mergeFields(def.fields ?? [], editable, asRec(b[i]), asRec(row), key));
      } else if (allMembersEditable && editable[key] !== false) {
        // Rows added/removed: only when every member is the client's. (The form fixes the rows otherwise.)
        out[def.name] = d;
      }
      // else: the client cannot restructure a list that holds Gaiada's members: keep the baseline.
      continue;
    }

    // A scalar, or a multiple scalar (a list of strings/media): the field's own verdict.
    if (editable[key] === true) {
      if (inDraft) out[def.name] = draft[def.name];
      else delete out[def.name];
    }
  }
  return out;
}

/** The `fields` object a client save sends. See the header. */
export function clientFieldsToSend(
  defs: FieldDef[], editable: Record<string, boolean>, baseline: Record<string, unknown>, draft: Record<string, unknown>,
): Record<string, unknown> {
  return mergeFields(defs, editable, baseline, draft, "");
}
