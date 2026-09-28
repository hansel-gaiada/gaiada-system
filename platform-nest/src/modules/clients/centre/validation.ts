// Client Centre — shared PATCH validation + merge (CC piece 2). See
// docs/plans/2026-09-29-client-centre.md ("API contract" -> "Validation") for the ratified rules.
// Pure, DB-free, unit-tested hard (validation.test.ts): both the staff and portal PATCH routes call
// `applyCentrePatch()` so the two surfaces can never validate differently. Registry-driven: every
// accepted key/value is checked against `registry.json` (CC-D6 — taken from CMC unchanged), never
// against a hand-copied list that could drift from it.
import registry from "./registry.json";

export interface ConnectionEntry {
  tool?: string;
  account?: string;
  url?: string;
  owner?: string;
  creds?: string;
  method?: string;
  status?: string;
  notes?: string;
}

export interface CustomConnectionRef {
  id: string;
  name: string;
}

/** The persisted shape (mirrors `client_centre_profiles`' jsonb columns + business_type). */
export interface ProfileState {
  businessType: string;
  profile: Record<string, string>;
  connections: Record<string, ConnectionEntry>;
  departments: Record<string, boolean>;
  customConnections: Record<string, CustomConnectionRef[]>;
}

/** The wire PATCH shape (FRONTEND-BFF-CONTRACT §23 `CentrePatch`). */
export interface CentrePatch {
  businessType?: string;
  profile?: Record<string, string | null>;
  connections?: Record<string, Partial<ConnectionEntry> | null>;
  departments?: Record<string, boolean | null>;
  customConnections?: Record<string, CustomConnectionRef[]>;
}

export interface PatchChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface ApplyResult {
  state: ProfileState;
  changes: PatchChange[];
}

export const MAX_STRING_LEN = 5000;
export const MAX_BODY_BYTES = 256 * 1024;

const CONNECTION_ENTRY_KEYS = ["tool", "account", "url", "owner", "creds", "method", "status", "notes"] as const;
const CUSTOM_CONNECTION_ID_RE = /^x[a-z0-9]{4,40}$/;

const TOP_LEVEL_DEPARTMENT_IDS = new Set<string>((registry.departments as Array<{ id: string }>).map((d) => d.id));
const VALID_DEPARTMENT_IDS = new Set<string>([...TOP_LEVEL_DEPARTMENT_IDS, "ix"]);
const VALID_BUSINESS_TYPES = new Set<string>((registry.businessTypes as Array<{ id: string }>).map((b) => b.id));
const VALID_FIELD_KEYS = new Set<string>(Object.keys(registry.fields as Record<string, unknown>));
const VALID_REGISTRY_CONNECTION_KEYS = new Set<string>(Object.keys(registry.connections as Record<string, unknown>));
const VALID_CONNECTION_METHODS = new Set<string>(registry.connectionMethods as string[]);
const VALID_CONNECTION_STATUSES = new Set<string>(registry.connectionStatuses as string[]);
const VALID_SECTION_IDS = new Set<string>(Object.keys(registry.sectionSettings as Record<string, unknown>));

// ── Credential-value scanner (CMC-SEC-1 follow-up 3) ────────────────────────────────────────────
// Applied to EVERY string value the patch carries, including inside `creds`/`notes` — `creds` is
// documented as "where a credential lives", never the credential itself, but a caller pasting the
// real secret there anyway is exactly the mistake this guards against, so the scan does not trust
// the field's own name.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/, // PEM private-key block
  /\bAKIA[0-9A-Z]{12,}\b/, // AWS access key id
  /\bsk-[A-Za-z0-9]{10,}\b/, // OpenAI-style secret key
  /\b(ghp_|github_pat_)[A-Za-z0-9_]{10,}\b/, // GitHub token
  /\bxox[abp]-[A-Za-z0-9-]+\b/, // Slack token
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT (header.payload.sig)
  /\b(password|pwd)\s*[:=]\s*\S+/i, // password=/pwd: pairs
];

export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(value));
}

/** Approximate wire size of a PATCH body — same measure the controller takes off the raw request,
 *  exposed here too so the validator's own tests can drive the 256KB cap without a live HTTP call. */
export function bodyByteLength(patch: unknown): number {
  return Buffer.byteLength(JSON.stringify(patch ?? {}), "utf8");
}

class PatchError extends Error {}

function checkString(field: string, value: unknown): string {
  if (typeof value !== "string") throw new PatchError(`${field} must be a string`);
  if (value.length > MAX_STRING_LEN) throw new PatchError(`${field} exceeds ${MAX_STRING_LEN} characters`);
  if (looksLikeCredential(value)) throw new PatchError(`${field} looks like it contains a credential — store where it lives, not the secret itself`);
  return value;
}

/** Every custom id currently listed anywhere in `customConnections`, for validating a `connections`
 *  key against "an existing custom id" (CentrePatch's own contract line). Deliberately NOT allowing
 *  an arbitrary caller-invented `x...` id through `connections` alone — a custom connection is
 *  created by first appearing in a `customConnections` section list; `connections` only ever edits
 *  the data of one that already exists there. */
function existingCustomIds(state: ProfileState): Set<string> {
  const ids = new Set<string>();
  for (const list of Object.values(state.customConnections)) {
    for (const item of list) ids.add(item.id);
  }
  return ids;
}

function recordChange(changes: PatchChange[], path: string, before: unknown, after: unknown): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return; // no-op: not a change
  const trunc = (v: unknown): unknown => (typeof v === "string" ? v.slice(0, 200) : v);
  changes.push({ path, before: trunc(before), after: trunc(after) });
}

/** Validate + merge a `CentrePatch` onto the current `ProfileState`. Returns `{error}` (400 body,
 *  names the offending field) on the FIRST validation failure — nothing is applied partially, the
 *  whole patch is checked before anything is merged. On success, `changes` lists only the keys that
 *  actually moved (a same-value write records no change — CC's own "PATCH that changes nothing
 *  still returns 200 but writes no activity" rule lives one level up, in the controller, keyed off
 *  `changes.length === 0`). */
export function applyCentrePatch(current: ProfileState, patch: unknown): { error: string } | ApplyResult {
  if (bodyByteLength(patch) > MAX_BODY_BYTES) {
    return { error: `request body exceeds ${MAX_BODY_BYTES} bytes` };
  }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return { error: "body must be an object" };
  }
  const p = patch as CentrePatch;
  const KNOWN_TOP_KEYS = new Set(["businessType", "profile", "connections", "departments", "customConnections"]);
  for (const key of Object.keys(p)) {
    if (!KNOWN_TOP_KEYS.has(key)) return { error: `unknown field: ${key}` };
  }

  const state: ProfileState = {
    businessType: current.businessType,
    profile: { ...current.profile },
    connections: Object.fromEntries(Object.entries(current.connections).map(([k, v]) => [k, { ...v }])),
    departments: { ...current.departments },
    customConnections: Object.fromEntries(Object.entries(current.customConnections).map(([k, v]) => [k, [...v]])),
  };
  const changes: PatchChange[] = [];

  try {
    if (p.businessType !== undefined) {
      if (!VALID_BUSINESS_TYPES.has(p.businessType)) throw new PatchError(`businessType must be a registry business type: ${p.businessType}`);
      recordChange(changes, "businessType", state.businessType, p.businessType);
      state.businessType = p.businessType;
    }

    if (p.profile) {
      for (const [key, rawValue] of Object.entries(p.profile)) {
        if (!VALID_FIELD_KEYS.has(key)) throw new PatchError(`unknown profile field: ${key}`);
        const before = state.profile[key] ?? null;
        if (rawValue === null || rawValue === "") {
          if (key in state.profile) {
            delete state.profile[key];
            recordChange(changes, `profile.${key}`, before, null);
          }
          continue;
        }
        const value = checkString(`profile.${key}`, rawValue);
        state.profile[key] = value;
        recordChange(changes, `profile.${key}`, before, value);
      }
    }

    if (p.connections) {
      const validCustomIds = existingCustomIds(state);
      for (const [key, entryPatch] of Object.entries(p.connections)) {
        if (!VALID_REGISTRY_CONNECTION_KEYS.has(key) && !validCustomIds.has(key)) {
          throw new PatchError(`unknown connection: ${key}`);
        }
        const before = state.connections[key] ? { ...state.connections[key] } : null;
        if (entryPatch === null) {
          if (key in state.connections) {
            delete state.connections[key];
            recordChange(changes, `connections.${key}`, before, null);
          }
          continue;
        }
        if (typeof entryPatch !== "object" || Array.isArray(entryPatch)) {
          throw new PatchError(`connections.${key} must be an object`);
        }
        const entry: ConnectionEntry = { ...(state.connections[key] ?? {}) };
        for (const [subKey, subValueRaw] of Object.entries(entryPatch)) {
          if (!(CONNECTION_ENTRY_KEYS as readonly string[]).includes(subKey)) {
            throw new PatchError(`unknown connection field: ${key}.${subKey}`);
          }
          const field = subKey as keyof ConnectionEntry;
          if (subValueRaw === null || subValueRaw === "") {
            delete entry[field];
            continue;
          }
          const subValue = checkString(`connections.${key}.${subKey}`, subValueRaw);
          if (field === "method" && !VALID_CONNECTION_METHODS.has(subValue)) {
            throw new PatchError(`connections.${key}.method must be one of the registry methods: ${subValue}`);
          }
          if (field === "status" && !VALID_CONNECTION_STATUSES.has(subValue)) {
            throw new PatchError(`connections.${key}.status must be one of the registry statuses: ${subValue}`);
          }
          entry[field] = subValue;
        }
        // An entry with every sub-key deleted is pruned rather than persisted as `{}` — an empty
        // connection object carries no information a missing key doesn't already carry, and pruning
        // keeps "does this key exist" a meaningful question for the next read.
        if (Object.keys(entry).length === 0) {
          if (key in state.connections) {
            delete state.connections[key];
            recordChange(changes, `connections.${key}`, before, null);
          }
        } else {
          state.connections[key] = entry;
          recordChange(changes, `connections.${key}`, before, entry);
        }
      }
    }

    if (p.departments) {
      for (const [key, rawValue] of Object.entries(p.departments)) {
        if (!VALID_DEPARTMENT_IDS.has(key)) throw new PatchError(`unknown department: ${key}`);
        const before = key in state.departments ? state.departments[key] : null;
        if (rawValue === null) {
          if (key in state.departments) {
            delete state.departments[key];
            recordChange(changes, `departments.${key}`, before, null);
          }
          continue;
        }
        if (typeof rawValue !== "boolean") throw new PatchError(`departments.${key} must be a boolean or null`);
        state.departments[key] = rawValue;
        recordChange(changes, `departments.${key}`, before, rawValue);
      }
    }

    if (p.customConnections) {
      for (const [sectionId, list] of Object.entries(p.customConnections)) {
        if (!VALID_SECTION_IDS.has(sectionId)) throw new PatchError(`unknown section: ${sectionId}`);
        if (!Array.isArray(list)) throw new PatchError(`customConnections.${sectionId} must be an array`);
        const seen = new Set<string>();
        const next: CustomConnectionRef[] = list.map((item, i) => {
          if (typeof item !== "object" || item === null) {
            throw new PatchError(`customConnections.${sectionId}[${i}] must be an object`);
          }
          const id = (item as CustomConnectionRef).id;
          const name = (item as CustomConnectionRef).name;
          if (typeof id !== "string" || !CUSTOM_CONNECTION_ID_RE.test(id)) {
            throw new PatchError(`customConnections.${sectionId}[${i}].id is invalid: ${String(id)}`);
          }
          if (seen.has(id)) throw new PatchError(`customConnections.${sectionId} has a duplicate id: ${id}`);
          seen.add(id);
          const checkedName = checkString(`customConnections.${sectionId}[${i}].name`, name);
          if (checkedName.length < 1 || checkedName.length > 120) {
            throw new PatchError(`customConnections.${sectionId}[${i}].name must be 1..120 characters`);
          }
          return { id, name: checkedName };
        });
        const before = state.customConnections[sectionId] ?? [];
        state.customConnections[sectionId] = next;
        recordChange(changes, `customConnections.${sectionId}`, before, next);
      }
    }
  } catch (err) {
    if (err instanceof PatchError) return { error: err.message };
    throw err;
  }

  return { state, changes };
}

export const _registryForTests = registry;
