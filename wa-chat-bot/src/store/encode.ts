// Shared encrypt-on-write / decrypt-on-read for sender identity (crypto-shred).
// The entity axis is the chat (trial tenant stand-in). Async since 5a.10 (KMS over HTTP).
import { encryptField, decryptField, pseudonym, type Ciphertext } from "../crypto/envelope";
import type { StoredMessage } from "./types";

export async function encodeSender(m: StoredMessage): Promise<{ enc: Ciphertext; pseudo: string }> {
  const subject = m.senderId || "unknown";
  return {
    enc: await encryptField(subject, m.chatId, JSON.stringify({ senderId: m.senderId, senderName: m.senderName })),
    pseudo: await pseudonym(subject, subject),
  };
}

export async function decodeSender(enc: Ciphertext | null): Promise<{ senderId: string; senderName: string }> {
  if (!enc) return { senderId: "[unknown]", senderName: "[unknown]" };
  try {
    return JSON.parse(await decryptField(enc)) as { senderId: string; senderName: string };
  } catch {
    return { senderId: "[erased]", senderName: "[erased]" };
  }
}

/** Generic encrypt-on-write for the durable inbound-intake log (Agent A). Same two-axis
 *  envelope as encodeSender — `subjectId` is the person the event is about, `entityId` is the
 *  chat — so a right-to-erasure/divestiture key destruction shreds intake rows exactly like it
 *  shreds messages. `payload` is any JSON-serializable value (a normalized InboundEvent). */
export async function encodePayload(subjectId: string, entityId: string, payload: unknown): Promise<Ciphertext> {
  return encryptField(subjectId || "unknown", entityId || "unknown", JSON.stringify(payload));
}

/** Decrypt-on-read counterpart. Returns null if the key was destroyed (crypto-shred) or the
 *  ciphertext is otherwise unrecoverable — callers must treat that as "gone", not retry it. */
export async function decodePayload<T = unknown>(enc: Ciphertext): Promise<T | null> {
  try {
    return JSON.parse(await decryptField(enc)) as T;
  } catch {
    return null;
  }
}
