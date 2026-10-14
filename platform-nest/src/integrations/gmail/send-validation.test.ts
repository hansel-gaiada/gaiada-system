// DW-8j (§48.4) — the one definition of a valid outgoing message.
import { describe, expect, it } from "vitest";
import { GmailInvalidMessageError } from "./errors";
import { BODY_MAX, MAX_RECIPIENTS, SUBJECT_MAX, isValidEmailAddress, recipientCount, validateSendRequest } from "./send-validation";

const ok = { to: ["a@example.test"], subject: "Hello", body: "Body" };
const fieldOf = (input: unknown): string | null => {
  try {
    validateSendRequest(input);
    return null;
  } catch (e) {
    if (e instanceof GmailInvalidMessageError) return e.field;
    throw e;
  }
};

describe("isValidEmailAddress", () => {
  it.each(["a@example.test", "first.last+tag@sub.example.co.uk", "x_y@a-b.example.org", "o'brien@example.test"])("accepts %s", (a) => {
    expect(isValidEmailAddress(a)).toBe(true);
  });
  it.each([
    "", "plain", "@example.test", "a@", "a@b", "a b@example.test", "a@example..test", ".a@example.test", "a.@example.test",
    "A <a@example.test>", "a@example.test,b@example.test", "a@example.test\r\nBcc: x@example.test", "a@exa mple.test", "a@example.test\u0000",
    "a@-example.test", `${"x".repeat(65)}@example.test`, `a@${"x".repeat(250)}.test`,
  ])("refuses %j", (a) => {
    expect(isValidEmailAddress(a)).toBe(false);
  });
  it("refuses a non-string", () => {
    expect(isValidEmailAddress(undefined)).toBe(false);
    expect(isValidEmailAddress(7)).toBe(false);
    expect(isValidEmailAddress(["a@example.test"])).toBe(false);
  });
});

describe("validateSendRequest", () => {
  it("accepts a minimal request and returns it normalised", () => {
    expect(validateSendRequest({ to: [" a@example.test "], subject: "Hi", body: "B" })).toEqual({ to: ["a@example.test"], subject: "Hi", body: "B" });
  });

  it("requires at least one recipient, as a list of valid addresses (field `to`)", () => {
    expect(fieldOf({ ...ok, to: undefined })).toBe("to");
    expect(fieldOf({ ...ok, to: [] })).toBe("to");
    expect(fieldOf({ ...ok, to: "a@example.test" })).toBe("to");
    expect(fieldOf({ ...ok, to: ["nope"] })).toBe("to");
    expect(fieldOf({ ...ok, to: [42] })).toBe("to");
  });

  it("validates cc (field `cc`) and caps the total at 20 addresses, counted as written", () => {
    expect(fieldOf({ ...ok, cc: ["nope"] })).toBe("cc");
    expect(fieldOf({ ...ok, cc: "x@example.test" })).toBe("cc");
    const twenty = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `p${i}@example.test`);
    expect(fieldOf({ ...ok, to: twenty })).toBeNull();
    expect(fieldOf({ ...ok, to: twenty, cc: ["extra@example.test"] })).toBe("cc");
    expect(fieldOf({ ...ok, to: [...twenty, "extra@example.test"] })).toBe("to");
    // as written: 21 entries that are all the same address are still 21
    expect(fieldOf({ ...ok, to: Array.from({ length: MAX_RECIPIENTS + 1 }, () => "same@example.test") })).toBe("to");
  });

  it("drops a duplicate address, and an address already in `to` from `cc`; the count is of what remains", () => {
    const v = validateSendRequest({ ...ok, to: ["a@example.test", "A@Example.test"], cc: ["a@example.test", "b@example.test", "B@example.test"] });
    expect(v.to).toEqual(["a@example.test"]);
    expect(v.cc).toEqual(["b@example.test"]);
    expect(recipientCount(v)).toBe(2);
  });

  it("subject: 1 to 300 characters, a single line", () => {
    expect(fieldOf({ ...ok, subject: "" })).toBe("subject");
    expect(fieldOf({ ...ok, subject: "   " })).toBe("subject");
    expect(fieldOf({ ...ok, subject: undefined })).toBe("subject");
    expect(fieldOf({ ...ok, subject: "x".repeat(SUBJECT_MAX) })).toBeNull();
    expect(fieldOf({ ...ok, subject: "x".repeat(SUBJECT_MAX + 1) })).toBe("subject");
    expect(fieldOf({ ...ok, subject: "Hi\r\nBcc: victim@example.test" })).toBe("subject");
    expect(fieldOf({ ...ok, subject: "Hi\nthere" })).toBe("subject");
  });

  it("body: 1 to 50,000 characters of plain text", () => {
    expect(fieldOf({ ...ok, body: "" })).toBe("body");
    expect(fieldOf({ ...ok, body: "  \n " })).toBe("body");
    expect(fieldOf({ ...ok, body: undefined })).toBe("body");
    expect(fieldOf({ ...ok, body: "x".repeat(BODY_MAX) })).toBeNull();
    expect(fieldOf({ ...ok, body: "x".repeat(BODY_MAX + 1) })).toBe("body");
    expect(fieldOf({ ...ok, body: "line one\nline two\r\nline three" })).toBeNull(); // multi-line is the point
    expect(fieldOf({ ...ok, body: "a\u0000b" })).toBe("body");
  });

  it("inReplyTo: both ids, shaped like ids", () => {
    expect(validateSendRequest({ ...ok, inReplyTo: { threadId: "t5", messageId: "m5c" } }).inReplyTo).toEqual({ threadId: "t5", messageId: "m5c" });
    expect(fieldOf({ ...ok, inReplyTo: { threadId: "t5" } })).toBe("inReplyTo");
    expect(fieldOf({ ...ok, inReplyTo: { threadId: "", messageId: "m" } })).toBe("inReplyTo");
    expect(fieldOf({ ...ok, inReplyTo: { threadId: "t 5", messageId: "m" } })).toBe("inReplyTo");
    expect(fieldOf({ ...ok, inReplyTo: { threadId: "t5", messageId: "m\r\nBcc: x" } })).toBe("inReplyTo");
    expect(fieldOf({ ...ok, inReplyTo: "t5" })).toBe("inReplyTo");
    expect(fieldOf({ ...ok, inReplyTo: ["t5", "m"] })).toBe("inReplyTo");
    expect(fieldOf({ ...ok, inReplyTo: null })).toBeNull(); // null is "not a reply"
  });

  it("the first failing field wins, in the order to, cc, subject, body, inReplyTo (so the answer is deterministic)", () => {
    expect(fieldOf({ to: ["bad"], subject: "", body: "" })).toBe("to");
    expect(fieldOf({ to: ["a@example.test"], subject: "", body: "" })).toBe("subject");
    expect(fieldOf({ to: ["a@example.test"], subject: "s", body: "" })).toBe("body");
  });

  it("anything that is not an object is refused (field `to`, the first thing checked)", () => {
    expect(fieldOf(null)).toBe("to");
    expect(fieldOf("x")).toBe("to");
    expect(fieldOf(undefined)).toBe("to");
  });
});
