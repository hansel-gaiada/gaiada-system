// SMM-05 — custody split (b): resolving a Postiz ORG API KEY from its ALIAS, server-side, at call
// time (design §11 / D-5, addendum §A4l §5).
//
// `social_publisher_orgs.api_key_ref` holds an ALIAS — never the key. 0105's column comment says so
// and this file is what makes that true in practice. The three properties that matter:
//
//   1. The key is read from process env at CALL TIME, not at boot and not into a module-level
//      constant. A rotation is then a container recreate, not a code change, and a long-lived
//      in-memory copy never outlives the request that needed it.
//   2. Resolution is BY ALIAS, so a per-client key is a deploy-time fact and never a database row.
//      A key in a tenant row would put a live publishing credential inside the blast radius of any
//      read of that table — including a support export, a backup, and every future `SELECT *`.
//   3. An unresolvable alias REFUSES (`org_key_unresolved`). It never falls back to the default
//      key. Falling back is precisely how client A's org would end up called with client B's
//      credential, which is the wrong-account-publish nightmare arriving through the side door.
//
// ⚠ NOTHING in this file may log, return, or embed a key in an error message. `describeKeyRef`
// exists so the console and the audit trail can say WHICH alias failed without ever naming what it
// would have resolved to.
import { config } from "../../../config";
import { SocialPublisherError } from "./types";

/** The alias that means "this deployment's single default org key" (`SOCIAL_POSTIZ_ORG_API_KEY`).
 *  One org per (tenant, client) is the model, but a single-tenant dev/dogfood deployment legitimately
 *  runs one org, and making it name an alias anyway keeps the column's meaning uniform. */
export const DEFAULT_KEY_REF = "default";

/** Env var backing a non-default alias. `acme-brand` → `SOCIAL_POSTIZ_ORG_API_KEY__ACME_BRAND`.
 *  Deliberately a pure, exported function: the .env.example block and the operator-facing error
 *  message both name the variable a human must actually set, and they must agree. */
export function envVarForKeyRef(ref: string): string {
  return `SOCIAL_POSTIZ_ORG_API_KEY__${ref.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** A safe rendering of an alias for logs, spans and audit lines: the alias itself, never the key. */
export function describeKeyRef(ref: string | null | undefined): string {
  const trimmed = (ref ?? "").trim();
  return trimmed.length ? trimmed : "(unset)";
}

/** Resolve `api_key_ref` → the live key, or refuse.
 *
 *  `env: { ... }` is a test seam ONLY (the suite must not mutate process.env, which leaks across
 *  vitest files sharing a worker). Production always reads the real environment. */
export function resolveOrgApiKey(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const alias = (ref ?? "").trim();
  if (!alias) {
    throw new SocialPublisherError(
      "org_key_unresolved",
      "publisher org has no api_key_ref — the mapping row names no credential alias",
    );
  }
  const value = alias === DEFAULT_KEY_REF
    // config reads process.env at import time; the explicit env lookup is what makes the test seam
    // work AND what makes a rotation visible without a config reload in a long-lived process.
    ? (env.SOCIAL_POSTIZ_ORG_API_KEY ?? config.social.publisher.defaultOrgApiKey ?? "")
    : (env[envVarForKeyRef(alias)] ?? "");
  if (!value) {
    throw new SocialPublisherError(
      "org_key_unresolved",
      `no publisher API key is configured for alias '${alias}' — set ${
        alias === DEFAULT_KEY_REF ? "SOCIAL_POSTIZ_ORG_API_KEY" : envVarForKeyRef(alias)
      } on this host`,
    );
  }
  return value;
}
