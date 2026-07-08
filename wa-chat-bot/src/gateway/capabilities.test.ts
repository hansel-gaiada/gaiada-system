import { describe, it, expect } from "vitest";
import { supports, surfaceOf } from "./capabilities";

describe("capability matrix", () => {
  it("both surfaces support core rich verbs", () => {
    for (const s of ["whatsapp", "telegram"] as const) {
      expect(supports(s, "reply")).toBe(true);
      expect(supports(s, "sendMedia")).toBe(true);
      expect(supports(s, "react")).toBe(true);
      expect(supports(s, "sendButtons")).toBe(true);
      expect(supports(s, "typing")).toBe(true);
    }
  });

  it("encodes known surface limits", () => {
    expect(supports("telegram", "addMember")).toBe(false); // bots can't add users
    expect(supports("whatsapp", "pin")).toBe(false); // inconsistent WAHA support
    expect(supports("telegram", "pin")).toBe(true);
    expect(supports("whatsapp", "addMember")).toBe(true);
  });

  it("surfaceOf reads the chat id prefix", () => {
    expect(surfaceOf("tg:-100123")).toBe("telegram");
    expect(surfaceOf("123@g.us")).toBe("whatsapp");
    expect(surfaceOf("62811@c.us")).toBe("whatsapp");
  });
});
