// Client Centre registry v1 -> v2 (PV6-01, docs/plans/2026-10-13-pv6-business-areas-tickets.md).
// Usage: node scripts/cmc/registry-v2.mjs            (rewrites both copies in place)
//        node scripts/cmc/registry-v2.mjs --check    (exit 1 if either copy is not already v2)
//
// What changes (one deterministic, idempotent transform; v2 -> v2 is a no-op):
//   - `departments` becomes `areas`; each is {id, name, subAreas?: [{id, name}]}. Only Marketing has
//     sub-areas (its 19 sub-sections, ids unchanged). Every leaf page is dropped (278 "Coming soon" pages).
//   - `industryModules[bt]` keeps {id: "ix", name, settings} and drops `pages`.
//   - `defaultOffDepartments` becomes `defaultOffAreas`.
//   - `version` is 2. Field, connection and area ids are unchanged, so no stored profile changes.
// Both copies are written from the same object so the parity test (clientCentre.test.ts) stays byte-identical.
// From here on v2 is maintained by hand; scripts/cmc/extract-registry.cjs (v1, from the CMC snapshot) is superseded.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COPIES = [
  path.join(root, "platform-nest/src/modules/clients/centre/registry.json"),
  path.join(root, "platform-ui/src/lib/clientCentreRegistry.json"),
];

const COMMENT =
  "Client Centre registry v2 (PV6-01). Derived once from the CMC snapshot (v1, 2026-09-19 extract) by scripts/cmc/registry-v2.mjs and maintained by hand from here on. " +
  "Data only: every field, connection, business area, industry area and settings map. Pages inside an area are gone; an area has Setup (its fields), Connections and, from PV6-03, Services & results. " +
  "Bump `version` on any structural change.";

/** v1 (or v2) registry object -> v2. Pure; returns a new object with the key order of the input. */
export function toV2(reg) {
  const out = {};
  for (const [key, value] of Object.entries(reg)) {
    if (key === "_comment") out._comment = COMMENT;
    else if (key === "version") out.version = 2;
    else if (key === "departments" || key === "areas") {
      out.areas = value.map((d) => {
        const subs = (d.subAreas ?? (d.pages ?? []).filter((p) => Array.isArray(p.pages))).map((s) => ({ id: s.id, name: s.name }));
        return { id: d.id, name: d.name, ...(subs.length > 0 ? { subAreas: subs } : {}) };
      });
    } else if (key === "defaultOffDepartments" || key === "defaultOffAreas") out.defaultOffAreas = value;
    else if (key === "industryModules") {
      out.industryModules = Object.fromEntries(
        Object.entries(value).map(([bt, m]) => [bt, { id: m.id, name: m.name, settings: m.settings }]),
      );
    } else out[key] = value;
  }
  return out;
}

export const serialize = (reg) => JSON.stringify(reg, null, 2) + "\n";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const file of COPIES) {
    const before = fs.readFileSync(file, "utf8");
    const after = serialize(toV2(JSON.parse(before)));
    if (before === after) continue;
    stale = true;
    if (!check) fs.writeFileSync(file, after);
    console.log(`${check ? "needs v2" : "wrote v2"}: ${path.relative(root, file)}`);
  }
  if (!stale) console.log("both copies already v2");
  if (check && stale) process.exit(1);
}
