// ── ARGUMENT VALIDATION AT THE ONE DISPATCH SITE (2026-08-24) ────────────────────────────────────
//
// THE DEFECT THIS CLOSES. Every tool advertises an `inputSchema` over MCP — including `required` —
// and NOTHING enforced it. `hub.ts` handed `req.params.arguments` straight to
// `handler(args, principal)`, and every handler reads its arguments as `String(args.x ?? "")` or
// `String(args.x)`. So an omitted argument did not fail: it became the literal four-character
// string `"undefined"` and was interpolated into a platform URL — `GET /api/undefined/projects` —
// which reached Postgres as a uuid cast and came back a 500 with no usable reason. A real agent
// burned four retries on `projects.list` and gave up, because the error it was shown named neither
// the argument nor the schema.
//
// On the read tools that was a wasted round trip. On the WRITE tools it is a data-integrity risk:
// the same silent `"undefined"` reaches a mutating platform call.
//
// WHY HERE AND NOT IN EACH HANDLER. `hub.ts` holds the ONLY invocation of a tool handler in the
// hub (grep `.handler(`). Validating there makes enforcement structural: a tool added later —
// including one AGGREGATED FROM A MODULE at boot, which no hub-side code ever sees — is validated
// because it declared a schema, not because someone remembered to add a check. Per-handler guards
// would be opt-in, and the one that got forgotten would be the one that mattered.
//
// SCOPE: a deliberate JSON Schema SUBSET — exactly the keywords the tool surface actually uses
// (`type`, `properties`, `required`, `enum`, `items`, `default`). Unknown keywords are ignored and
// unknown properties are permitted, so this can only ever reject an input the advertised schema
// already declared invalid. It is a gate, not a second contract; it never invents a rule the
// schema did not state. A full validator (ajv) for six keywords would add a dependency and a
// compile step to the hot path for no reachable behaviour.
//
// COERCION IS LOSSLESS AND NARROW. LLM clients routinely send `"5"` for a `number` and `"true"`
// for a `boolean`; refusing those produces exactly the retry loop this file exists to stop. So a
// string is accepted for `number`/`integer` when it parses to a finite number, and for `boolean`
// when it is exactly `"true"`/`"false"`. Nothing else is coerced — notably `number → string` is
// NOT, because that direction hides a real type confusion instead of surfacing it. The coerced
// object is what the handler receives, so `Number(args.limit)` sees a number, not a numeric string.

export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] };

type JsonSchema = Record<string, unknown>;

const TYPE_NAMES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;
type TypeName = (typeof TYPE_NAMES)[number];

function typeOf(v: unknown): TypeName {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "number") return Number.isInteger(v as number) ? "integer" : "number";
  if (t === "string" || t === "boolean" || t === "object") return t as TypeName;
  return "object"; // function/symbol/bigint/undefined never survive JSON transport
}

/** Does an actual type satisfy a declared one? `integer` satisfies `number`; nothing else widens. */
function typeMatches(expected: TypeName, actual: TypeName): boolean {
  if (expected === actual) return true;
  return expected === "number" && actual === "integer";
}

/** The narrow, lossless coercions described in the header. Returns `undefined` when no coercion
 *  applies, so the caller can tell "not converted" from "converted to undefined". */
function coerce(expected: TypeName, value: unknown): { coerced: unknown } | undefined {
  if (typeof value !== "string") return undefined;
  if (expected === "number" || expected === "integer") {
    if (value.trim() === "") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    if (expected === "integer" && !Number.isInteger(n)) return undefined;
    return { coerced: n };
  }
  if (expected === "boolean") {
    if (value === "true") return { coerced: true };
    if (value === "false") return { coerced: false };
  }
  return undefined;
}

function declaredTypes(schema: JsonSchema): TypeName[] {
  const t = schema.type;
  const raw = Array.isArray(t) ? t : t === undefined ? [] : [t];
  return raw.filter((x): x is TypeName => TYPE_NAMES.includes(x as TypeName));
}

function describe(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((v) => JSON.stringify(v)).join(" | ")}`;
  const types = declaredTypes(schema);
  return types.length ? types.join("|") : "any";
}

/** Validate one value. Errors name the PATH, the expectation and what actually arrived — the three
 *  things the agent needed and did not get. Returns the (possibly coerced) value. */
function checkValue(path: string, schema: JsonSchema, value: unknown, errors: string[]): unknown {
  let v = value;
  const types = declaredTypes(schema);

  if (types.length && !types.some((t) => typeMatches(t, typeOf(v)))) {
    let converted: { coerced: unknown } | undefined;
    for (const t of types) {
      converted = coerce(t, v);
      if (converted) break;
    }
    if (!converted) {
      errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(v)}`);
      return v;
    }
    v = converted.coerced;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === v)) {
    errors.push(`${path}: expected ${describe(schema)}, got ${JSON.stringify(v)}`);
    return v;
  }

  // Arrays: validate each element against `items` when the schema declares one.
  if (Array.isArray(v) && schema.items && typeof schema.items === "object") {
    const items = schema.items as JsonSchema;
    return (v as unknown[]).map((el, i) => checkValue(`${path}[${i}]`, items, el, errors));
  }

  // Nested objects: recurse, so a `required` field one level down is enforced too.
  if (typeOf(v) === "object" && schema.properties && typeof schema.properties === "object") {
    return validateObject(schema, v as Record<string, unknown>, errors, `${path}.`);
  }

  return v;
}

function validateObject(
  schema: JsonSchema,
  input: Record<string, unknown>,
  errors: string[],
  prefix: string,
): Record<string, unknown> {
  const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  // Unknown properties are carried through untouched: the schema did not forbid them, and dropping
  // a field a handler reads would be a silent behaviour change wearing validation's clothes.
  const out: Record<string, unknown> = { ...input };

  // `default` first, so a defaulted property can satisfy `required` and is then type-checked like
  // any other supplied value.
  for (const [key, propSchema] of Object.entries(props)) {
    if (out[key] === undefined && propSchema && typeof propSchema === "object" && "default" in propSchema) {
      out[key] = propSchema.default;
    }
  }

  // `null` counts as absent for a required argument on purpose: `String(null)` is `"null"`, the
  // same class of garbage-in-the-URL as `"undefined"`, and no handler here means it.
  const missing = required.filter((key) => out[key] === undefined || out[key] === null);
  for (const key of missing) {
    const p = props[key];
    errors.push(`${prefix}${key}: required${p ? ` (${describe(p)})` : ""} — not provided`);
  }

  for (const [key, propSchema] of Object.entries(props)) {
    if (out[key] === undefined || missing.includes(key)) continue;
    if (!propSchema || typeof propSchema !== "object") continue;
    out[key] = checkValue(`${prefix}${key}`, propSchema, out[key], errors);
  }

  return out;
}

/**
 * Validate (and lightly coerce) a tool call's arguments against its advertised `inputSchema`.
 *
 * A schema that declares nothing (`{}`, no `properties`, no `required`) accepts everything —
 * `ping` and `whoami` must keep taking no arguments without ceremony.
 */
export function validateToolArgs(schema: unknown, args: Record<string, unknown>): ValidationResult {
  if (!schema || typeof schema !== "object") return { ok: true, args };
  const errors: string[] = [];
  const validated = validateObject(schema as JsonSchema, args, errors, "");
  return errors.length ? { ok: false, errors } : { ok: true, args: validated };
}

/**
 * The message the CALLER sees. It names the tool, EVERY problem at once (not just the first — an
 * agent that fixes one error per round trip is the retry loop again), and the argument names the
 * schema actually declares, so a client can correct the call without a second `tools/list`.
 */
export function invalidArgsMessage(tool: string, errors: string[], schema: unknown): string {
  const properties =
    schema && typeof schema === "object" ? (schema as JsonSchema).properties : undefined;
  const props = properties && typeof properties === "object" ? Object.keys(properties) : [];
  const known = props.length ? ` Accepted arguments: ${props.join(", ")}.` : "";
  return `invalid arguments for ${tool}: ${errors.join("; ")}.${known}`;
}
