// M6-P6o (WSK-D88) — the per-site deploy credential's SHAPE, checked in the ERP before it is sealed into the vault and again
// before it is written into GitHub. Pure: no database, no network, no logging.
//
// The shape is the one the site's own deploy job reads (webdesk/templates/_deploy/README.md, "The per-site deploy secret";
// enforced there by deploy-from-secret.sh). These rules mirror that script's jq check field for field, so a credential the
// ERP accepts is one the deploy job accepts: an unknown field, a missing or mistyped one, plain FTP, both or neither of
// password/privateKey, a privateKey on ftps, sftp without a pinned host key, ftps without a pinned certificate, a siteUrl that
// is not https. Every problem names the FIELD, never a value, so a refusal can be shown, logged or stored safely.
//
// The value stored in the vault, and later sealed into the org secret, is the CANONICAL form: the parsed object re-serialised
// as one minified line in the documented field order (GitHub warns that a multi-line structured secret may fail to mask line by
// line). Sealing the canonical form, never the caller's bytes, means a stray whitespace or key order can never make the vault
// and GitHub disagree about what was written.

/** The documented fields, in the order the canonical form writes them. */
export const DEPLOY_CREDENTIAL_FIELDS = [
  "version", "environment", "transport", "host", "port", "user", "password", "privateKey", "knownHosts", "certSha256", "caPem",
  "checkHostname", "remoteBase", "docroot", "siteUrl",
] as const;

const STRING_FIELDS = [
  "environment", "transport", "host", "user", "password", "privateKey", "knownHosts", "certSha256", "caPem", "remoteBase", "docroot", "siteUrl",
] as const;

/** GitHub's limit for one secret is 48 KB; a credential anywhere near it is not a credential. */
export const DEPLOY_CREDENTIAL_MAX_BYTES = 48 * 1024;

const SITE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

export type DeployEnvironment = "staging" | "production" | "development";
export type DeployTransport = "sftp" | "ftps";

export interface DeployCredential {
  version: 1;
  environment: DeployEnvironment;
  transport: DeployTransport;
  host: string;
  port?: number;
  user: string;
  password?: string;
  privateKey?: string;
  knownHosts?: string;
  certSha256?: string;
  caPem?: string;
  checkHostname?: boolean;
  remoteBase: string;
  docroot?: string;
  siteUrl: string;
}

export type ParsedDeployCredential =
  | { ok: true; credential: DeployCredential; canonical: string }
  | { ok: false; problems: string[] };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Check an object against the documented shape. Problems name fields only. */
export function parseDeployCredential(raw: unknown): ParsedDeployCredential {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problems: ["the credential is not a JSON object"] };
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  const allowed = new Set<string>(DEPLOY_CREDENTIAL_FIELDS);
  // An unknown key is named only when it looks like a field name (letters only, at most 24): a value pasted as a key is
  // never echoed back.
  for (const k of Object.keys(o)) if (!allowed.has(k)) problems.push(/^[A-Za-z]{1,24}$/.test(k) ? `unknown field: ${k}` : "an unknown field (its name is not shown)");
  for (const f of STRING_FIELDS) if (o[f] != null && typeof o[f] !== "string") problems.push(`${f} must be a string`);
  if (o.version !== 1) problems.push("version must be 1");
  if (o.environment !== "staging" && o.environment !== "production" && o.environment !== "development") {
    problems.push("environment must be staging, production or development");
  }
  if (o.transport !== "sftp" && o.transport !== "ftps") problems.push("transport must be sftp or ftps (plain ftp is never accepted)");
  if (!nonEmpty(o.host)) problems.push("host is required");
  if (o.port != null && !(typeof o.port === "number" && Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535)) {
    problems.push("port must be an integer from 1 to 65535");
  }
  if (!nonEmpty(o.user)) problems.push("user is required");
  if (!nonEmpty(o.password) && !nonEmpty(o.privateKey)) problems.push("password or privateKey is required");
  if (nonEmpty(o.password) && nonEmpty(o.privateKey)) problems.push("give password or privateKey, not both");
  if (nonEmpty(o.privateKey) && o.transport !== "sftp") problems.push("privateKey is for sftp only");
  if (o.transport === "sftp" && !nonEmpty(o.knownHosts)) problems.push("knownHosts is required for sftp (the pinned host key line)");
  if (o.transport === "ftps" && !nonEmpty(o.certSha256) && !nonEmpty(o.caPem)) {
    problems.push("certSha256 or caPem is required for ftps (the pinned certificate)");
  }
  if (o.checkHostname != null && typeof o.checkHostname !== "boolean") problems.push("checkHostname must be true or false");
  if (!nonEmpty(o.remoteBase)) problems.push("remoteBase is required");
  if (!(nonEmpty(o.siteUrl) && SITE_URL_RE.test(o.siteUrl))) problems.push("siteUrl must be an https:// URL with no query or fragment");
  if (problems.length > 0) return { ok: false, problems };

  // Canonical: the documented order, absent and null fields left out (the deploy job reads a missing field and a null alike).
  const canonicalObject: Record<string, unknown> = {};
  for (const f of DEPLOY_CREDENTIAL_FIELDS) if (o[f] != null) canonicalObject[f] = o[f];
  const canonical = JSON.stringify(canonicalObject);
  if (Buffer.byteLength(canonical, "utf8") > DEPLOY_CREDENTIAL_MAX_BYTES) return { ok: false, problems: ["the credential is larger than 48 KB"] };
  return { ok: true, credential: canonicalObject as unknown as DeployCredential, canonical };
}

/** The vault holds the canonical text; parse it back. A value that is not JSON is reported without quoting it. */
export function parseDeployCredentialText(text: string): ParsedDeployCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["the stored credential is not JSON"] };
  }
  return parseDeployCredential(raw);
}

/** The vault record's provider each transport needs (delivery-binding.ts's `VAULT_PROVIDER_FOR_ACCESS`, read from the value side). */
export const VAULT_PROVIDER_FOR_TRANSPORT: Record<DeployTransport, "ssh" | "ftp"> = { sftp: "ssh", ftps: "ftp" };

/**
 * A redactor for error text that may have passed near the value: every string field (whole, each of its lines, and its
 * JSON-escaped form), the canonical text and its base64, and any `extra` strings (the sealed box) become `[redacted]`.
 * Short values (under 4 characters) are left alone: replacing "22" or "sftp" everywhere would destroy the message and
 * protect nothing. The pattern of PGL-10's `sender.ts`: an adapter's error message is scrubbed before it is stored.
 */
export function redactorFor(credential: DeployCredential, canonical: string, extra: readonly string[] = []): (s: string) => string {
  const needles = new Set<string>();
  const add = (v: string): void => {
    if (v.length >= 4) needles.add(v);
  };
  for (const f of STRING_FIELDS) {
    const v = credential[f];
    if (typeof v !== "string") continue;
    add(v);
    add(JSON.stringify(v).slice(1, -1));
    for (const line of v.split(/\r?\n/)) add(line.trim());
  }
  add(canonical);
  add(Buffer.from(canonical, "utf8").toString("base64"));
  for (const e of extra) add(e);
  // Longest first, so a value that contains another is replaced whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return (s: string): string => {
    let out = s;
    for (const n of ordered) out = out.split(n).join("[redacted]");
    return out;
  };
}

/**
 * Scrub an error in place before anything records it (the GH-04 ledger writes `err.message` into its failed row): its
 * message and stack go through `redact`. Its class and `detail` (GitHub's status and operation, which the classifier reads)
 * are kept. A thrown non-Error becomes an Error with the redacted text.
 */
export function scrubError(err: unknown, redact: (s: string) => string): unknown {
  if (err instanceof Error) {
    err.message = redact(err.message);
    if (err.stack) err.stack = redact(err.stack);
    return err;
  }
  return new Error(redact(String(err)));
}
