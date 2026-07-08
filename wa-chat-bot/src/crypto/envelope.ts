// Two-axis envelope encryption, v2 (5a.10). A fresh random DEK encrypts the field;
// the DEK is wrapped TWICE — first under the subject's key, then under the entity's —
// so destroying EITHER key (erasure or divestiture) makes the DEK, and therefore the
// field, permanently unrecoverable. With OpenBao the wrapping keys never leave the
// transit engine; the app only ever sees the DEK for the duration of one operation.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { wrapper } from "./kms";

const subjectKeyId = (s: string) => `subject:${s}`;
const entityKeyId = (e: string) => `entity:${e}`;

export interface Ciphertext {
  v: 2;
  s: string; // subject id
  e: string; // entity id
  iv: string;
  tag: string;
  ct: string;
  wdek: string; // DEK wrapped under subject key, then entity key
}

export async function encryptField(subjectId: string, entityId: string, plaintext: string): Promise<Ciphertext> {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const inner = await wrapper.wrap(subjectKeyId(subjectId), dek);
  const wdek = await wrapper.wrap(entityKeyId(entityId), Buffer.from(inner, "utf8"));
  return {
    v: 2,
    s: subjectId,
    e: entityId,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
    wdek,
  };
}

export async function decryptField(c: Ciphertext): Promise<string> {
  let dek: Buffer;
  try {
    const inner = await wrapper.unwrap(entityKeyId(c.e), c.wdek);
    dek = await wrapper.unwrap(subjectKeyId(c.s), inner.toString("utf8"));
  } catch {
    throw new Error("crypto-shred: key destroyed — data unrecoverable");
  }
  const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(c.iv, "base64"));
  decipher.setAuthTag(Buffer.from(c.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(c.ct, "base64")), decipher.final()]).toString("utf8");
}

/** Deterministic keyed pseudonym for equality lookup without storing the plaintext. */
export function pseudonym(subjectId: string, value: string): Promise<string> {
  return wrapper.hmac(subjectKeyId(subjectId), value);
}

/** Right-to-erasure: destroy the subject's key -> all their fields become unrecoverable. */
export function eraseSubject(subjectId: string): Promise<void> {
  return wrapper.deleteKey(subjectKeyId(subjectId));
}

/** Divestiture: destroy the entity's key -> that company's data becomes unrecoverable. */
export function eraseEntity(entityId: string): Promise<void> {
  return wrapper.deleteKey(entityKeyId(entityId));
}
