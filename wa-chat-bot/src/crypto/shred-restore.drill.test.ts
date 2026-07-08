// Day-one gate drill (Task 0.10, re-verified after 5a.10): prove crypto-shred survives a
// backup/restore. A backup taken BEFORE erasure, restored AFTER key destruction, must be
// unrecoverable — backups contain only ciphertext + wrapped DEKs, never wrapping keys.
// Runs against whichever KeyWrapper is configured (LocalKms in CI; re-run manually with
// BAO_URL/BAO_TOKEN set to drill the OpenBao transit path — same assertions hold).
import { describe, it, expect } from "vitest";
import { encryptField, decryptField, eraseSubject, eraseEntity, type Ciphertext } from "./envelope";
import { encodeSender, decodeSender } from "../store/encode";

const SUBJECT = "drill-subject-1";
const ENTITY = "drill-entity-1";

describe("day-one gate drill: shred survives restore", () => {
  it("subject erasure: a pre-erasure backup restored after key destruction is unrecoverable", async () => {
    const ct = await encryptField(SUBJECT, ENTITY, "Budi Santoso <budi@example.com>");
    expect(await decryptField(ct)).toBe("Budi Santoso <budi@example.com>");

    // Backup of the DATA only (simulates pg_dump) — no plaintext, no unwrapped DEK.
    const backup = JSON.stringify([{ id: "row-1", sender_enc: ct }]);
    expect(backup).not.toContain("Budi");

    await eraseSubject(SUBJECT);

    const restored = (JSON.parse(backup) as Array<{ sender_enc: Ciphertext }>)[0].sender_enc;
    await expect(decryptField(restored)).rejects.toThrow(/crypto-shred/);
  });

  it("re-onboarding the same subject does NOT resurrect pre-erasure data", async () => {
    const subject = "drill-subject-reonboard";
    const old = await encryptField(subject, ENTITY, "old secret");
    const backup = JSON.stringify(old);
    await eraseSubject(subject);

    const fresh = await encryptField(subject, ENTITY, "new data"); // mints a NEW key
    expect(await decryptField(fresh)).toBe("new data");

    const restored = JSON.parse(backup) as Ciphertext;
    await expect(decryptField(restored)).rejects.toThrow(/crypto-shred/);
  });

  it("entity divestiture: restored backup is unrecoverable after the entity key is destroyed", async () => {
    const entity = "drill-entity-divest";
    const ct = await encryptField("drill-subject-2", entity, "company-confidential");
    const backup = JSON.stringify(ct);
    await eraseEntity(entity);
    const restored = JSON.parse(backup) as Ciphertext;
    await expect(decryptField(restored)).rejects.toThrow(/crypto-shred/);
  });

  it("store layer: a restored message row reads as [erased], never plaintext", async () => {
    const subject = "drill-store-subject";
    const { enc } = await encodeSender({
      chatId: "drill-chat@g.us",
      senderId: subject,
      senderName: "Siti Rahma",
      waMessageId: "wamid-drill",
      ts: 1,
      text: "hello",
      fromBot: false,
    });
    const backup = JSON.stringify(enc);
    expect(backup).not.toContain("Siti Rahma"); // encrypted at rest even before erasure

    await eraseSubject(subject);
    const restored = await decodeSender(JSON.parse(backup) as Ciphertext);
    expect(restored.senderName).toBe("[erased]");
    expect(restored.senderId).toBe("[erased]");
  });
});
