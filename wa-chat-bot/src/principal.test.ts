import { describe, it, expect } from "vitest";
import { resolvePrincipal, isAllowed, denialMessage } from "./principal";

describe("principal (D4: bot never asserts identity; low-assurance ceiling)", () => {
  const p = resolvePrincipal("whatsapp", "628110000000@c.us");

  it("mints only a low-assurance principal from (provider, external_id) — no role field", () => {
    expect(p.assurance).toBe("low");
    expect(p.provider).toBe("whatsapp");
    expect("role" in p).toBe(false); // the bot cannot assert a role, ever
  });

  it("allows general Q&A", () => {
    expect(isAllowed(p, { kind: "general-qa" })).toBe(true);
  });

  it("allows Q&A only over the group the message came from", () => {
    expect(isAllowed(p, { kind: "group-qa", sourceChatId: "a@g.us", targetChatId: "a@g.us" })).toBe(true);
    expect(isAllowed(p, { kind: "group-qa", sourceChatId: "a@g.us", targetChatId: "b@g.us" })).toBe(false);
  });

  it("denies all company-data access at low assurance (step-up required)", () => {
    expect(isAllowed(p, { kind: "company-data", resource: "hr-records" })).toBe(false);
    expect(denialMessage({ kind: "company-data", resource: "hr-records" })).toContain("verified");
  });
});
