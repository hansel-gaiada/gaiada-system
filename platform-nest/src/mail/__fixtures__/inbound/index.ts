// MAIL-13 / design A13 — the loader for the committed adversarial inbound corpus.
//
// A13, verbatim, is why this directory is a DELIVERABLE and not scaffolding: "A live provider will
// never conveniently send forged senders, replayed message-ids, oversized bodies, or hostile HTML on
// demand — the committed corpus is a higher-fidelity adversarial test than a live provider and stays
// in CI forever; staging APPENDS real-captured samples (incl. real signatures) rather than replacing
// anything." So: never delete a case, and when real Brevo samples arrive at staging (§15 R3) they are
// added alongside these with the same shape.
//
// FIXTURE FORMAT = a real Brevo inbound-parse body (`{"items":[...]}`) plus exactly two authoring
// conveniences, both documented here because a fixture format nobody can read is a corpus nobody
// maintains:
//
//   `_meta`            — title + which §7.6 corpus bullet the case covers. STRIPPED before the payload
//                        is handed to anything, so what the endpoint sees is a pure provider shape.
//   `{{PLACEHOLDER}}`  — textual substitution, because reply tokens are minted per outbound mail and
//                        cannot be committed. `{{TOKEN}}` / `{{TOKEN_B}}` are two live tokens the
//                        caller supplies, `{{REPLY_DOMAIN}}` the configured VERP host, `{{RUN}}` a
//                        per-run nonce that keeps `MessageId` unique across replays.
//   `"Content": "@eicar"` — the one value-level directive: substituted with base64 EICAR at load time
//                        so the literal EICAR signature is NOT committed to this repository (a
//                        repo-wide virus scan flagging our own test corpus would be a real CI
//                        breakage, and it is the kind of failure that looks like a compromise).
//
// The per-attachment `Content` field is itself an extension: real Brevo inbound payloads carry a
// `DownloadToken`, not bytes (see ../../inbound/brevo-payload.ts's honest-gap note). Fixtures inline
// bytes so the quarantine + scan path is exercised end to end in dev, which the real provider shape
// cannot do without an account.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eicarBytes } from "../../inbound/scanner";

export interface FixtureMeta {
  title: string;
  /** The design §7.6 corpus bullet this case covers. */
  covers: string;
  /** What the pinned test must assert. Kept in the fixture so a case can never drift away from its
   *  reason for existing. */
  expect: string;
}

export interface LoadedFixture {
  name: string;
  meta: FixtureMeta;
  /** The provider-shaped body, ready to POST. */
  payload: unknown;
}

export interface FixtureVars {
  token?: string;
  tokenB?: string;
  replyDomain?: string;
  run?: string;
}

const DIR = __dirname;

export function fixtureNames(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/** Reads + substitutes one fixture. Substitution is textual and happens BEFORE `JSON.parse`, so a
 *  placeholder may appear anywhere including inside a string that also carries JSON escapes. */
export function loadFixture(file: string, vars: FixtureVars = {}): LoadedFixture {
  const raw = readFileSync(join(DIR, file), "utf8");
  const substituted = raw
    .replace(/\{\{TOKEN\}\}/g, vars.token ?? "MISSING-TOKEN-PLACEHOLDER")
    .replace(/\{\{TOKEN_B\}\}/g, vars.tokenB ?? "MISSING-TOKEN-B-PLACEHOLDER")
    .replace(/\{\{REPLY_DOMAIN\}\}/g, vars.replyDomain ?? "notify.gaiada.invalid")
    .replace(/\{\{RUN\}\}/g, vars.run ?? "static");

  const parsed = JSON.parse(substituted) as { _meta?: FixtureMeta; items?: unknown[] };
  const meta = parsed._meta ?? { title: file, covers: "unlabelled", expect: "unlabelled" };
  delete parsed._meta;

  for (const item of (parsed.items ?? []) as Array<{ Attachments?: Array<{ Content?: unknown }> }>) {
    for (const att of item.Attachments ?? []) {
      if (att.Content === "@eicar") att.Content = eicarBytes().toString("base64");
    }
  }
  return { name: file.replace(/\.json$/, ""), meta, payload: parsed };
}

export function loadCorpus(vars: FixtureVars = {}): LoadedFixture[] {
  return fixtureNames().map((f) => loadFixture(f, vars));
}
