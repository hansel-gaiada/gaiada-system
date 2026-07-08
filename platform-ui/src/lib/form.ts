import type { FieldDef } from "./entities";

export function coerceField(def: FieldDef, raw: FormDataEntryValue | null): unknown {
  if (def.data_type === "boolean") return raw != null && raw !== "" && raw !== "false";
  const s = typeof raw === "string" ? raw : "";
  if (def.data_type === "number") return s === "" ? undefined : Number(s);
  return s === "" ? undefined : s;
}

export function parseCustomFields(formData: FormData, defs: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const v = coerceField(def, formData.get(`cf_${def.key}`));
    if (v === undefined) {
      if (def.data_type === "boolean") out[def.key] = false;
      continue;
    }
    out[def.key] = v;
  }
  return out;
}
