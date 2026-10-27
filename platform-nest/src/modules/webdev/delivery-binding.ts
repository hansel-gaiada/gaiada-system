// M6-P6g — the delivery binding: WHICH host a site row is delivered to and HOW we reach it, as four facts on the
// `webdev_sites` registry row, and the one console word that says whether that binding is complete.
// Plan: docs/plans/2026-10-11-webdesk-m6-plan.md §6.0 and the M6-P6g row (WSK-D79: the target is per site).
//
// Pure: no database, no clock. `site-registry.service.ts` binds the rules to Postgres; this file is what the unit suite drives.
//
// ═══ WHAT A BINDING IS, AND WHAT IT NEVER HOLDS ══════════════════════════════════════════════════════
//   host_kind  where the site is delivered: `shared-hosting` (an account on shared hosting) or `our-box` (`delphi`/`helios`).
//   host_ref   an OPAQUE LABEL for the account or box, such as `hostinger-1` or `delphi`. Never a host name, user or path.
//   access     the transport: `ssh` (SFTP over the account's SSH) or `ftp` (FTPS, explicit TLS; plain FTP is never used).
//   vault_ref  the id of a VLT-1 `integration_connections` record of the SAME tenant that holds the credential.
// The registry has no column a host, a user, a path or a secret could be written to (WSK-D30), and `parseBindingBody` is a
// CLOSED body, so a `host`, `username`, `path` or `password` key is refused rather than ignored.
//
// ═══ THE DEPLOY GRANT IS A DIFFERENT FACT (M6-P4g) ═══════════════════════════════════════════════════
// `deployGrant` (deploy-grant.ts) is GitHub-side: the repo may read the org's deploy secrets. The binding is host-side: where
// the build goes and which vault record holds the key to that door. A site needs both, they move independently, and nothing
// here reads or implies the other; the console shows them side by side and never as one "ready".

/** Hosts a binding may name. `our-box` is `delphi`/`helios` (WSK-D79 keeps them as per-site targets); the registry's other
 *  host kinds (`client-cpanel`, `external`, `unknown`) describe machines we do not deliver to by CI. */
export const BINDABLE_HOST_KINDS: readonly string[] = ["shared-hosting", "our-box"];

/** Transports a binding may name, from what `webdev_sites.access` already allows (`none | ftp | cpanel | ssh | full`).
 *  `cpanel` and `full` describe reach, not a deploy transport. No new `access` value is needed: `ssh` is SFTP and `ftp` is
 *  FTPS in the delivery path (M6 plan §6.3: never plain FTP). */
export const BINDABLE_ACCESS: readonly string[] = ["ssh", "ftp"];

/** The VLT-1 provider a vault record must carry for each access value. A record for another transport (or a `github` one)
 *  can never be the key to this door. */
export const VAULT_PROVIDER_FOR_ACCESS: Readonly<Record<string, string>> = { ssh: "ssh", ftp: "ftp" };

/** The only fields a binding body may carry. */
export const BINDING_FIELDS: readonly string[] = ["hostKind", "hostRef", "access", "vaultRef"];

/** An opaque label: lowercase letters, digits, `_` and `-`, 1 to 63 characters, starting with a letter or digit. No dot (so
 *  no host name or address), no `@` (no user), no slash or space (no path), no colon (no port). */
export const HOST_REF_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────

/** Every typed reason a binding or a production-from-staging command can refuse, with the HTTP status the route answers. */
export const DELIVERY_REFUSALS = {
  // the body (400)
  binding_body_invalid: 400,
  host_kind_not_bindable: 400,
  host_ref_invalid: 400,
  access_not_bindable: 400,
  vault_ref_invalid: 400,
  production_body_invalid: 400,
  production_domain_invalid: 400,
  // the site (404, 409)
  not_found: 404,
  site_environment_not_deliverable: 409,
  not_a_provisioned_staging_row: 409,
  production_row_exists: 409,
  domain_taken: 409,
  /** M6-P6i: the domain already has a `search_properties` row that belongs to another client (one domain, one owner). */
  property_domain_conflict: 409,
  // the vault record (422): a record of another tenant is indistinguishable from one that does not exist, on purpose
  vault_ref_unknown: 422,
  vault_ref_wrong_provider: 422,
  vault_ref_not_linked: 422,
  vault_ref_wrong_owner: 422,
} as const;

export type DeliveryRefusalCode = keyof typeof DELIVERY_REFUSALS;

export class DeliveryRefusal extends Error {
  readonly status: number;
  constructor(readonly code: DeliveryRefusalCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DeliveryRefusal";
    this.status = DELIVERY_REFUSALS[code];
  }
}

// ── the body ────────────────────────────────────────────────────────────────────────────────────────

export interface BindingInput {
  hostKind: string;
  hostRef: string;
  access: string;
  /** Lowercased, so the registry's text pointer and the vault record's uuid compare equal everywhere. */
  vaultRef: string;
}

/** Validate a binding body. Closed: every key must be one of BINDING_FIELDS and all four are required. Shape only; whether
 *  the vault record exists, is the right provider and belongs to this tenant is decided against the database. */
export function parseBindingBody(body: unknown): BindingInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DeliveryRefusal("binding_body_invalid", `the body must be {hostKind, hostRef, access, vaultRef}`);
  }
  const rec = body as Record<string, unknown>;
  const extra = Object.keys(rec).filter((k) => !BINDING_FIELDS.includes(k));
  if (extra.length > 0) {
    throw new DeliveryRefusal(
      "binding_body_invalid",
      `this command accepts exactly {hostKind, hostRef, access, vaultRef}; refused field(s): ${extra.join(",")}. ` +
        "No host name, user, path or secret is ever stored; the credential lives in the vault.",
    );
  }
  const missing = BINDING_FIELDS.filter((k) => typeof rec[k] !== "string");
  if (missing.length > 0) {
    throw new DeliveryRefusal("binding_body_invalid", `required string field(s) missing: ${missing.join(",")}`);
  }
  const hostKind = (rec.hostKind as string).trim();
  const hostRef = (rec.hostRef as string).trim();
  const access = (rec.access as string).trim();
  const vaultRef = (rec.vaultRef as string).trim().toLowerCase();
  if (!BINDABLE_HOST_KINDS.includes(hostKind)) {
    throw new DeliveryRefusal("host_kind_not_bindable", `hostKind must be one of ${BINDABLE_HOST_KINDS.join(",")}`);
  }
  if (!HOST_REF_RE.test(hostRef)) {
    throw new DeliveryRefusal(
      "host_ref_invalid",
      "hostRef is an opaque label (a-z, 0-9, _ and -; 1 to 63 characters; no dots, @, slashes, colons or spaces): " +
        "never a host name, a user or a path",
    );
  }
  if (!BINDABLE_ACCESS.includes(access)) {
    throw new DeliveryRefusal("access_not_bindable", `access must be one of ${BINDABLE_ACCESS.join(",")} (ssh is SFTP, ftp is FTPS)`);
  }
  if (!UUID_RE.test(vaultRef)) {
    throw new DeliveryRefusal("vault_ref_invalid", "vaultRef must be the id (uuid) of a vault record of this tenant");
  }
  return { hostKind, hostRef, access, vaultRef };
}

// ── the vault record ────────────────────────────────────────────────────────────────────────────────

/** The facts of a VLT-1 `integration_connections` row that decide whether it can be this site's deploy credential. */
export interface VaultRecordFacts {
  provider: string;
  status: string;
  ownerKind: string;
  ownerId: string;
}

/** The registry row a binding is for: its id (one site in one environment) and its client, when it serves one. */
export interface BindingSiteFacts {
  id: string;
  clientId: string | null;
}

/** The refusal for a vault record that cannot back this binding, or null when it can. The record has ALREADY been read under
 *  the request tenant's RLS with `tenant_id = $tenant`, so a record of another tenant never reaches this function: it
 *  surfaces upstream as `vault_ref_unknown`, the same answer as an id that does not exist.
 *
 *  Owner, one of three:
 *    `webdev_site`  the record of THIS row (owner_id = the row's id; M6-P6o2, migration 202610271200). The per-site record:
 *                   one site in one environment, so another site's record, and this site's OTHER environment's record,
 *                   are both refused. This is the shape WSK-D79 wants (one docroot-locked principal per site and environment).
 *    `company`      the company itself (kept: records made before per-site records existed).
 *    `client`       THIS site's own client (kept). A different client's record is another client's key and is refused (so
 *                   is any client record for an internal site with no client).
 *  A user-owned record is a person's login, never a site's deploy credential; a `github_app` record is an App's key. */
export function vaultRecordRefusal(
  rec: VaultRecordFacts,
  access: string,
  site: BindingSiteFacts,
): { code: DeliveryRefusalCode; detail: string } | null {
  const want = VAULT_PROVIDER_FOR_ACCESS[access];
  if (rec.provider !== want) {
    return { code: "vault_ref_wrong_provider", detail: `access ${access} needs a vault record of provider ${want}, this one is ${rec.provider}` };
  }
  if (rec.status !== "linked") {
    return { code: "vault_ref_not_linked", detail: `the vault record holds no usable credential (status ${rec.status}); store the credential first` };
  }
  const ownedByThisRow = rec.ownerKind === "webdev_site" && site.id !== "" && rec.ownerId.toLowerCase() === site.id.toLowerCase();
  const ownedByCompany = rec.ownerKind === "company";
  const ownedBySiteClient = rec.ownerKind === "client" && site.clientId !== null && rec.ownerId === site.clientId;
  if (!ownedByThisRow && !ownedByCompany && !ownedBySiteClient) {
    return {
      code: "vault_ref_wrong_owner",
      detail: rec.ownerKind === "webdev_site"
        ? "the vault record is another site's or another environment's own record (a per-site record binds to its own row only)"
        : "the vault record belongs to another owner than this site row, its company or its client",
    };
  }
  return null;
}

// ── the console word ────────────────────────────────────────────────────────────────────────────────

/** `awaiting_deploy_credential`: the site is provisioned and the host-side binding is not complete.
 *  `ready`: it is complete. This says NOTHING about the GitHub-side deploy grant (`deployGrant.state`). */
export type DeliveryState = "awaiting_deploy_credential" | "ready";

export interface DeliveryFacts {
  origin: string;
  hostKind: string;
  hostRef: string | null;
  access: string;
  vaultRef: string | null;
  /** The vault record `vaultRef` resolves to in the site's own tenant (provider and status), or null when it resolves to
   *  nothing: no pointer, a deleted record, or a pointer that never named a record of this tenant. */
  vaultRecord: { provider: string; status: string } | null;
}

/** The delivery state of a registry row, or null when the row is not a provisioned site (a tracked estate row has no
 *  delivery to wait for, and the console must not tell the owner a legacy site is "awaiting" anything).
 *
 *  `ready` needs the WHOLE binding: a bindable host kind, an opaque host_ref, a deploy transport, and a vault record that
 *  still resolves, is linked and is the provider that transport needs. Anything less is `awaiting_deploy_credential`,
 *  including a binding whose record was revoked or deleted afterwards: the credential is what is missing. */
export function deliveryStateOf(f: DeliveryFacts): DeliveryState | null {
  if (f.origin !== "provisioned") return null;
  const bound =
    BINDABLE_HOST_KINDS.includes(f.hostKind) &&
    f.hostRef !== null && f.hostRef !== "" &&
    BINDABLE_ACCESS.includes(f.access) &&
    f.vaultRef !== null && f.vaultRef !== "" &&
    f.vaultRecord !== null &&
    f.vaultRecord.status === "linked" &&
    f.vaultRecord.provider === VAULT_PROVIDER_FOR_ACCESS[f.access];
  return bound ? "ready" : "awaiting_deploy_credential";
}
