// WSK-40 — the pinned editorial JWKS (write-plane design §5, Decision D; ruling WSK-D39).
//
// WebDesk VERIFIES editorial assertions and never mints them: the only key material on this side is
// a PUBLIC Ed25519 key set, read from a FILE that the operator mounts read-only
// (`WEBDESK_EDITORIAL_JWKS_FILE`, docker-compose.aicenter.yml). There is no JWKS URL and no key push
// over the control channel: no new channel, no new egress. Same channel class as the pinned mTLS CA.
//
// File shape (what platform-nest/scripts/webdesk-editorial-keygen.mjs writes):
//   { "keys": [ { "kty": "OKP", "crv": "Ed25519", "kid": "wde-2026-10", "x": "<43 base64url chars>",
//                 "use": "sig", "alg": "EdDSA" } ] }
// One key normally, two during a rotation overlap (infra/runbooks/webdesk-editorial-keys.md).
//
// THE CA-LOADER DISCIPLINE (real-control-channel-authenticator.ts loadPinnedCaPem): a file that is
// present but wrong (truncated JSON, an RSA/EC/X25519/Ed448 key, private material, a short `x`, a
// duplicate kid, 0 or 3+ keys) REFUSES BOOT with a message naming the file and the reason, never the
// contents. A truncated key set must never look like a working one.
//
// ABSENT is different, on purpose (WSK-40 brief): when the variable is unset, or names a path that
// does not exist or is a directory (what a compose short-syntax bind mount of a missing host file
// creates), the instance boots and every content write answers 503 editorial-keys-not-configured.
// Refusing boot there would take the /v1 delivery surface down with the write plane, for a key that
// the operator simply has not installed yet. Writes fail closed either way.
//
// M4 F1: the parsing and file rules moved, unchanged, into ./pinned-jwks.ts, which the WS4 v2 key set
// (./ws4-jwks.ts) uses too. This file keeps the editorial channel's own env variable, error class and
// wording, and its own key map: an editorial key set is never a WS4 key set, nor the reverse.
import {
  loadPinnedEd25519Jwks,
  parsePinnedEd25519Jwks,
  type PinnedKeySet,
} from "./pinned-jwks";

export const EDITORIAL_JWKS_FILE_ENV = "WEBDESK_EDITORIAL_JWKS_FILE";

/** kid → public KeyObject (Ed25519). Immutable after load. */
export type EditorialKeySet = PinnedKeySet;

export class EditorialJwksError extends Error {
  constructor(source: string, reason: string) {
    super(`[webdesk:api] editorial JWKS from ${source} refused: ${reason} — refusing to boot the editorial assertion verifier.`);
    this.name = "EditorialJwksError";
  }
}

const editorialFail = (source: string, reason: string): Error => new EditorialJwksError(source, reason);

/**
 * Parses and shape-validates a JWKS document. Throws EditorialJwksError on anything but 1..2
 * well-formed public Ed25519 keys with distinct kids. `source` names the file in the error.
 */
export function parseEditorialJwks(text: string, source: string): EditorialKeySet {
  return parsePinnedEd25519Jwks(text, source, editorialFail);
}

export type EditorialJwksLoad =
  | { state: "configured"; keys: EditorialKeySet; source: string }
  | { state: "not-configured"; reason: string };

/**
 * Reads `WEBDESK_EDITORIAL_JWKS_FILE` (or `filePath` when given). Absent → not-configured (the
 * caller answers 503 on every write). Present and wrong → throws (boot refused).
 */
export function loadEditorialJwks(filePath: string | undefined = process.env[EDITORIAL_JWKS_FILE_ENV]): EditorialJwksLoad {
  return loadPinnedEd25519Jwks(EDITORIAL_JWKS_FILE_ENV, filePath, editorialFail);
}
