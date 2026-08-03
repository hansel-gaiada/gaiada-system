// Software information — types + pure parsing for the app version.
//
// NOT "server-only" (same reason as lib/reports.ts): the version chip is rendered in places that
// may become client components, and everything here is pure string work with no I/O. The reader
// lives in about-data.ts.
//
// The format is defined by docs/modules/VERSIONING.md and is NOT invented here:
//
//   Alpha 01.004.0005a
//    │     │   │   │ │
//    │     │   │   │ └─ revision letter   (same module set, cut again)
//    │     │   │   └─── module-reference counter (cumulative module bumps)
//    │     │   └─────── app release counter
//    │     └─────────── milestone
//    └───────────────── stage
//
// The single source is /VERSION at the repo root; deploy.yml reads it, checks the git tag matches,
// and passes it to services as APP_VERSION. Nothing in the UI computes a version — it only shows
// what the running process reports, so a stale container is visible rather than papered over.

export interface AboutService {
  key: string;
  reachable: boolean;
  version: string | null;
  note: string | null;
}

export interface AboutInfo {
  app: { version: string; originSite: string; node: string; modules: string[] };
  services: AboutService[];
}

export interface ParsedVersion {
  stage: string;
  milestone: string;
  release: string;
  moduleRef: string;
  revision: string;
}

const VERSION_RE = /^([A-Za-z]+)\s+(\d+)\.(\d+)\.(\d+)([a-z])$/;

/** Split an app version into its five documented parts, or null when it doesn't match the format
 *  (including the "unknown" a version-less build reports — which must stay unknown, not be
 *  coerced into a shape it doesn't have). */
export function parseAppVersion(version: string): ParsedVersion | null {
  const m = VERSION_RE.exec(version.trim());
  if (!m) return null;
  return { stage: m[1], milestone: m[2], release: m[3], moduleRef: m[4], revision: m[5] };
}

/** The git tag that a given app version must carry: lowercased, spaces to hyphens (VERSIONING.md
 *  rule 4). Returns null for an unparseable version so callers show nothing rather than a
 *  fabricated tag. */
export function tagForVersion(version: string): string | null {
  if (!parseAppVersion(version)) return null;
  return version.trim().toLowerCase().replace(/\s+/g, "-");
}

/** True when a build cannot state its version. Rendered as a warning, per VERSIONING.md: an unset
 *  APP_VERSION "should say so loudly instead of lying quietly". */
export function isUnknownVersion(version: string): boolean {
  return version.trim() === "" || version.trim().toLowerCase() === "unknown";
}

/** Services whose self-reported version disagrees with the platform's. This is the whole point of
 *  listing them: rule 5 says a disagreement means the deploy is suspect. Services that report no
 *  version at all are NOT mismatches — they simply have nothing to compare. */
export function mismatchedServices(info: AboutInfo): AboutService[] {
  if (isUnknownVersion(info.app.version)) return [];
  return info.services.filter((s) => s.version !== null && s.version !== info.app.version);
}
