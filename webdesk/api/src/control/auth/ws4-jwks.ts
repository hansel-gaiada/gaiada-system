// M4 F1 — the pinned WS4 key set: the PUBLIC half of the ERP's WS4 v2 signing key
// (docs/plans/2026-10-11-webdesk-m4-plan.md, "F1 · WS4 approval assertion made asymmetric").
//
// Same discipline as the editorial JWKS (./editorial-jwks.ts), through the same parser
// (./pinned-jwks.ts), but a SEPARATE channel in every respect:
//   - its own file   WEBDESK_WS4_JWKS_FILE, mounted read-only at /etc/webdesk/ws4/ws4.jwks.json
//                    (docker-compose.aicenter.yml; infra/runbooks/webdesk-ws4-keys.md);
//   - its own map    the WS4 verifier looks a kid up ONLY here, the editorial verifier ONLY in its own;
//   - its own key    a new Ed25519 key pair, kid `ws4-<yyyy-mm>`, never the editorial key.
// `assertWs4KeysDisjointFromEditorial` refuses boot if the two files share a kid or a public key, so an
// operator who installs the same key in both cannot make one channel's tokens verify on the other.
// (typ and aud differ too, and are checked: wd-editorial+jwt / urn:gaiada:webdesk:control against
// ws4+jwt / webdesk-control-plane.)
//
// Absent (unset, missing, or a directory left by a bind mount of a missing host file) → v2 is simply
// unavailable: the api boots, and the WS4 gate still accepts v1 while WEBDESK_APPROVAL_ASSERTION_KEY is
// set. Present and wrong → boot refused, naming the file and the reason, never its contents.
import { ed25519PublicX, loadPinnedEd25519Jwks, parsePinnedEd25519Jwks, type PinnedKeySet } from "./pinned-jwks";

export const WS4_JWKS_FILE_ENV = "WEBDESK_WS4_JWKS_FILE";

declare const ws4KeySetBrand: unique symbol;
/** kid → public KeyObject (Ed25519). Immutable after load. Branded: only parseWs4Jwks makes one, so
 *  the compiler refuses an editorial key set wherever the WS4 verifier wants this. */
export type Ws4KeySet = PinnedKeySet & { readonly [ws4KeySetBrand]: true };

export class Ws4JwksError extends Error {
  constructor(source: string, reason: string) {
    super(`[webdesk:api] WS4 JWKS from ${source} refused: ${reason} — refusing to boot the WS4 approval assertion verifier.`);
    this.name = "Ws4JwksError";
  }
}

const ws4Fail = (source: string, reason: string): Error => new Ws4JwksError(source, reason);

/** Parses and shape-validates a WS4 JWKS document (1..2 public Ed25519 keys). Throws Ws4JwksError. */
export function parseWs4Jwks(text: string, source: string): Ws4KeySet {
  return parsePinnedEd25519Jwks(text, source, ws4Fail) as Ws4KeySet;
}

export type Ws4JwksLoad =
  | { state: "configured"; keys: Ws4KeySet; source: string }
  | { state: "not-configured"; reason: string };

/** Reads `WEBDESK_WS4_JWKS_FILE` (or `filePath`). Absent → not-configured. Present and wrong → throws. */
export function loadWs4Jwks(filePath: string | undefined = process.env[WS4_JWKS_FILE_ENV]): Ws4JwksLoad {
  const loaded = loadPinnedEd25519Jwks(WS4_JWKS_FILE_ENV, filePath, ws4Fail);
  return loaded.state === "configured" ? { ...loaded, keys: loaded.keys as Ws4KeySet } : loaded;
}

/**
 * Boot check: the WS4 and editorial key sets share neither a kid nor a public key. Throws Ws4JwksError
 * (boot refused) on overlap. Message names kids only, never key bytes.
 */
export function assertWs4KeysDisjointFromEditorial(ws4: Ws4KeySet, ws4Source: string, editorial: PinnedKeySet): void {
  const editorialX = new Map<string, string>();
  for (const [kid, key] of editorial) editorialX.set(ed25519PublicX(key), kid);
  for (const [kid, key] of ws4) {
    if (editorial.has(kid)) {
      throw new Ws4JwksError(ws4Source, `kid "${kid}" is also in the editorial JWKS; the two channels must use different keys`);
    }
    const clash = editorialX.get(ed25519PublicX(key));
    if (clash !== undefined) {
      throw new Ws4JwksError(
        ws4Source,
        `kid "${kid}" is the SAME public key as editorial kid "${clash}"; WS4 needs its own key pair, never the editorial one`,
      );
    }
  }
}
