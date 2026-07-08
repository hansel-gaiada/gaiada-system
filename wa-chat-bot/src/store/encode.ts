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
