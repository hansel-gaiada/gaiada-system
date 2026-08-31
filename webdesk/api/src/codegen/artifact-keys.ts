// WSK-15 — the MinIO object-key naming convention for generated contract artifacts (design §06:
// "stores the bundle in MinIO under the tenant prefix"). Deliberately zero-dependency (no
// `.ts`-extension imports, no vocabulary import) so this ONE file can be imported unmodified by
// both sides of the module-system split this ticket straddles — see
// `contract-manifest.types.ts`'s header for the full reasoning — without either side needing its
// own independently-maintained copy of the naming rule.
// WSK-34 — added "sdkPhp" alongside the existing three (additive; every existing ArtifactName
// value and filename is unchanged).
export type ArtifactName = "openapiJson" | "sdkTs" | "sdkPhp" | "contractMd";

const ARTIFACT_FILENAMES: Record<ArtifactName, string> = {
  openapiJson: "openapi.v1.json",
  sdkTs: "sdk.d.ts",
  sdkPhp: "sdk.php",
  contractMd: "CONTENT-CONTRACT.md",
};

/** Everything for one tenant lives under this prefix in the `artifacts` bucket (§07/§11a:
 *  "per-tenant prefixes"). */
export function contractPrefix(tenantSlug: string): string {
  return `contracts/${tenantSlug}`;
}

/** The one mutable pointer object — see `contract-manifest.types.ts`'s `LatestContractPointer`. */
export function latestPointerKey(tenantSlug: string): string {
  return `${contractPrefix(tenantSlug)}/latest.json`;
}

/** Every generated artifact is stored under its own immutable `<contractVersion>/` prefix — a
 *  re-fetch of an existing version therefore always returns the exact bytes that version was
 *  minted with, matching design §06's "an existing row with a different hash — determinism
 *  breach" refusal rule on the Zone A mirror side (WSK-19, not this ticket, but this key shape is
 *  what makes that guarantee possible on the Zone B storage side). */
export function artifactKey(tenantSlug: string, contractVersion: string, artifact: ArtifactName): string {
  return `${contractPrefix(tenantSlug)}/${contractVersion}/${ARTIFACT_FILENAMES[artifact]}`;
}
