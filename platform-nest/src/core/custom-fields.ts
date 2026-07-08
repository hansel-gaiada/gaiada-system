// D17: custom fields validated on EVERY write against the tenant's registry (validator only;
// the registry-management endpoints are a controller in the write stage).
import type { PoolClient } from "pg";

interface FieldDef {
  key: string;
  data_type: "text" | "number" | "boolean" | "date" | "select";
  options: unknown[];
  required: boolean;
}

export async function validateCustomFields(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  values: Record<string, unknown>,
): Promise<string | null> {
  const { rows } = await client.query<FieldDef>(
    `SELECT key, data_type, options, required FROM custom_field_definitions
     WHERE tenant_id = $1 AND entity_type = $2 AND deleted_at IS NULL`,
    [tenantId, entityType],
  );
  const defs = new Map(rows.map((d) => [d.key, d]));
  for (const key of Object.keys(values)) {
    const def = defs.get(key);
    if (!def) return `unknown custom field: ${key}`;
    const v = values[key];
    switch (def.data_type) {
      case "text":
        if (typeof v !== "string") return `${key} must be text`;
        break;
      case "number":
        if (typeof v !== "number") return `${key} must be a number`;
        break;
      case "boolean":
        if (typeof v !== "boolean") return `${key} must be a boolean`;
        break;
      case "date":
        if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return `${key} must be a date`;
        break;
      case "select":
        if (!def.options.includes(v)) return `${key} must be one of the configured options`;
        break;
    }
  }
  for (const def of rows) {
    if (def.required && !(def.key in values)) return `missing required custom field: ${def.key}`;
  }
  return null;
}
