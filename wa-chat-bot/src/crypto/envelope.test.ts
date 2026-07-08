import { describe, it, expect } from "vitest";
import { encryptField, decryptField, pseudonym, eraseSubject, eraseEntity } from "./envelope";

describe("crypto-shred envelope (v2: double-wrapped DEK)", () => {
  it("round-trips plaintext", async () => {
    const ct = await encryptField("subjA", "entX", "Budi Santoso");
    expect(await decryptField(ct)).toBe("Budi Santoso");
  });

  it("never stores the plaintext or a raw DEK in the ciphertext object", async () => {
    const ct = await encryptField("subjA", "entX", "Budi Santoso");
    const raw = JSON.stringify(ct);
    expect(raw).not.toContain("Budi");
    expect(ct.wdek.startsWith("local:v1:") || ct.wdek.startsWith("vault:")).toBe(true);
  });

  it("is unrecoverable after the SUBJECT key is destroyed (right-to-erasure)", async () => {
    const ct = await encryptField("subjEraseMe", "entX", "secret");
    expect(await decryptField(ct)).toBe("secret");
    await eraseSubject("subjEraseMe");
    await expect(decryptField(ct)).rejects.toThrow(/crypto-shred/);
  });

  it("is unrecoverable after the ENTITY key is destroyed (divestiture)", async () => {
    const ct = await encryptField("subjB", "entSellMe", "secret");
    expect(await decryptField(ct)).toBe("secret");
    await eraseEntity("entSellMe");
    await expect(decryptField(ct)).rejects.toThrow(/crypto-shred/);
  });

  it("pseudonym is stable for equality lookup", async () => {
    expect(await pseudonym("subjC", "+628110")).toBe(await pseudonym("subjC", "+628110"));
    expect(await pseudonym("subjC", "+628110")).not.toBe(await pseudonym("subjC", "+628999"));
  });
});
