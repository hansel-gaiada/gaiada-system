// M4 F1 — shared helpers for test/ws4-assertion-v2-*.spec.ts (not a spec: vitest collects *.spec.ts only).
//
// The v2 MINTER lives here, in test/, not in src/: like the editorial assertion (ruling WSK-D39), WebDesk
// verifies v2 and never mints it, so the shipped api carries no v2 signing code. It is written against
// node:crypto directly (through the editorial kit's mintRaw), independently of the ERP's signer in
// platform-nest/src/modules/webdev/webdesk-ws4-assertion.ts, so the shared vectors compare two
// implementations of the wire format, not one implementation with itself.
//
// The vector keys are DERIVED from a public label (sha256(label) as the Ed25519 seed), so both repos pin
// byte-identical tokens without a private key ever being written into either repository.
import { parseWs4Jwks, type Ws4KeySet } from "../src/control/auth/ws4-jwks";
import { WS4_V2_AUD, WS4_V2_TYP, type Ws4Claims } from "../src/control/auth/ws4-assertion";
import { jwksJson, mintRaw, type TestKey } from "./editorial-assertion-kit";

export { freshKey, vectorKey, jwksJson, mintRaw, mintHs256, type TestKey } from "./editorial-assertion-kit";

/** A WS4 key set exactly as the production loader builds it from a file. */
export function ws4KeySetOf(...keys: Array<Pick<TestKey, "kid" | "x">>): Ws4KeySet {
  return parseWs4Jwks(jwksJson(keys), "test");
}

/** The pinned v2 header for `kid`, in wire order. */
export function ws4V2Header(kid: string): Record<string, unknown> {
  return { alg: "EdDSA", kid, typ: WS4_V2_TYP };
}

/** The pinned v2 payload, in wire order: {approvalId, commandHash, exp, aud}. */
export function ws4V2Payload(claims: Ws4Claims): Record<string, unknown> {
  return { approvalId: claims.approvalId, commandHash: claims.commandHash, exp: claims.exp, aud: WS4_V2_AUD };
}

/** TEST-ONLY v2 minter: what the ERP's signer must produce, byte for byte. */
export function mintWs4V2(claims: Ws4Claims, key: Pick<TestKey, "kid" | "privateKey">): string {
  return mintRaw(ws4V2Header(key.kid), ws4V2Payload(claims), key.privateKey);
}
