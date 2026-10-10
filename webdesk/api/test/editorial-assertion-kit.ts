// WSK-40 — shared helpers for test/editorial-assertion-*.spec.ts (not a spec: vitest collects
// *.spec.ts only).
//
// A TEST-ONLY minter lives here, not in src/: WebDesk verifies and never mints (ruling WSK-D39), so the
// shipped api carries no signing code at all. This minter is written against node:crypto directly,
// independently of jose and of the ERP's signer, so the vectors compare two implementations of the
// wire format, not one implementation with itself.
//
// Keys are generated inside the tests. The vector keys are DERIVED from a public label
// (sha256(label) as the Ed25519 seed) so both repos can pin byte-identical signatures without a
// private key ever being written into either repository.
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { EDITORIAL_AUD, EDITORIAL_ISS, EDITORIAL_TYP } from "../src/control/auth/editorial-assertion";
import { parseEditorialJwks, type EditorialKeySet } from "../src/control/auth/editorial-jwks";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** base64url public key (JWK `x`). */
  x: string;
}

/** A fresh random Ed25519 key. */
export function freshKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, publicKey, x: publicKey.export({ format: "jwk" }).x as string };
}

/** The deterministic vector key for `label` (seed = sha256(label)). Test vectors only. */
export function vectorKey(kid: string, label: string): TestKey {
  const seed = createHash("sha256").update(label).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return { kid, privateKey, publicKey, x: publicKey.export({ format: "jwk" }).x as string };
}

export function jwksJson(keys: Array<Pick<TestKey, "kid" | "x">>): string {
  return JSON.stringify({ keys: keys.map((k) => ({ kty: "OKP", crv: "Ed25519", kid: k.kid, x: k.x, use: "sig", alg: "EdDSA" })) });
}

/** A key set exactly as the production loader builds it from a file. */
export function keySetOf(...keys: Array<Pick<TestKey, "kid" | "x">>): EditorialKeySet {
  return parseEditorialJwks(jwksJson(keys), "test");
}

const b64 = (v: unknown): string => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64url");

/** Signs arbitrary header + payload objects with Ed25519 (for the adversarial rows). */
export function mintRaw(header: Record<string, unknown>, payload: Record<string, unknown> | string, privateKey: KeyObject): string {
  const signingInput = `${b64(header)}.${b64(payload)}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

/** HS256 over the signing input with `secret` (the alg-confusion attack). */
export function mintHs256(header: Record<string, unknown>, payload: Record<string, unknown>, secret: Buffer | string): string {
  const signingInput = `${b64(header)}.${b64(payload)}`;
  return `${signingInput}.${createHmac("sha256", secret).update(signingInput).digest("base64url")}`;
}

export function unsigned(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${b64(header)}.${b64(payload)}.`;
}

export interface ClaimInput {
  sub: string;
  pk: "human" | "automation" | "agent";
  agt?: string;
  ten: string;
  site: string;
  cmd: string;
  cmh: string;
  req?: string;
  apr?: string;
  iat: number;
  exp: number;
  jti: string;
}

/** The payload in the pinned wire order (see platform-nest webdesk-editorial-signer.ts). */
export function wirePayload(c: ClaimInput): Record<string, unknown> {
  const p: Record<string, unknown> = { iss: EDITORIAL_ISS, aud: EDITORIAL_AUD, sub: c.sub, pk: c.pk };
  if (c.agt !== undefined) p.agt = c.agt;
  p.ten = c.ten;
  p.site = c.site;
  p.cmd = c.cmd;
  p.cmh = c.cmh;
  if (c.req !== undefined) p.req = c.req;
  if (c.apr !== undefined) p.apr = c.apr;
  p.iat = c.iat;
  p.exp = c.exp;
  p.jti = c.jti;
  return p;
}

export function wireHeader(kid: string): Record<string, unknown> {
  return { alg: "EdDSA", typ: EDITORIAL_TYP, kid };
}

/** A well-formed editorial assertion. */
export function mintEditorial(key: Pick<TestKey, "kid" | "privateKey">, c: ClaimInput): string {
  return mintRaw(wireHeader(key.kid), wirePayload(c), key.privateKey);
}
