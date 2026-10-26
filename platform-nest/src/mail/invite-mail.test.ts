// PGL-10 (PV-D47) — the invitation mail without a database: the template, the stored-payload allow-list, the preview
// render and the leak scanner the DB suite relies on (with its own positive control). The end-to-end proof against real
// Postgres is src/core/client-invite-mail.db.test.ts.
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { config } from "../config";
import { renderTemplate, CLIENT_INVITE_LINK_PLACEHOLDER } from "./templates";
import { assertInvitePayloadHoldsNoCredential, renderInvitePreview, InviteMailPayloadError, CLIENT_INVITE_TEMPLATE } from "./invite-mail";
import { enqueueMail } from "./queue";
import { findInviteTokenLeaks } from "../testing/invite-token-leaks";

const TOKEN = "inv2.YWJj.ZGVm.MDEyMzQ1Njc4OWFiY2RlZg.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const HREF = `https://erp.example.invalid/invite/${TOKEN}`;
const stored = { inviteId: "11111111-1111-4111-8111-111111111111", companyName: "Kuta Creative Agency", clientName: "Hubble Bali", expiresAt: "2026-10-29T14:05:00.000Z" };

const URL_RE = /https?:\/\/[^\s"<]+/g;

describe("PGL-10 template client.invite", () => {
  it("names the inviting company and the client, states the expiry and single use, and carries exactly ONE link", () => {
    const r = renderTemplate(CLIENT_INVITE_TEMPLATE, { ...stored, href: HREF });
    expect(r.subject).toBe("Kuta Creative Agency invited you to your client portal");
    for (const part of [r.text, r.html]) {
      expect(part).toContain("Kuta Creative Agency");
      expect(part).toContain("Hubble Bali");
      expect(part).toContain("29 October 2026, 14:05 UTC");
      expect(part).toMatch(/can be used once/);
    }
    expect([...new Set(r.text.match(URL_RE))]).toEqual([HREF]);
    expect([...new Set(r.html.match(URL_RE))]).toEqual([HREF]);
    expect((r.html.match(/<a /g) ?? []).length).toBe(1);
  });

  it("the subject never carries the token (the dev-log adapter prints subjects)", () => {
    const r = renderTemplate(CLIENT_INVITE_TEMPLATE, { ...stored, href: HREF });
    expect(r.subject).not.toContain("inv2");
  });

  it("never names the platform operator: the brand is the inviting company's", () => {
    const r = renderTemplate(CLIENT_INVITE_TEMPLATE, { ...stored, href: HREF });
    expect(`${r.subject} ${r.text} ${r.html}`.toLowerCase()).not.toContain("gaiada");
  });

  it("rendered from the STORED payload (no href) it shows a placeholder and no anchor at all", () => {
    const r = renderTemplate(CLIENT_INVITE_TEMPLATE, stored);
    expect(r.text).toContain(CLIENT_INVITE_LINK_PLACEHOLDER);
    expect(r.html).not.toContain("<a ");
    expect(r.text).not.toMatch(URL_RE);
  });

  it("escapes hostile names, strips header injection from the subject and refuses a non-http link", () => {
    const r = renderTemplate(CLIENT_INVITE_TEMPLATE, { companyName: "Evil\r\nBcc: x@y.test <b>", clientName: "<script>x</script>", href: "javascript:alert(1)" });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("javascript:");
    expect(r.html).not.toContain("<a ");
  });

  it("a missing expiry still renders an honest sentence, never 'Invalid Date'", () => {
    const r = renderTemplate(CLIENT_INVITE_TEMPLATE, { companyName: "A", href: HREF });
    expect(r.text).toMatch(/expires soon and can be used once/);
    expect(r.text).not.toMatch(/Invalid|NaN/);
  });
});

describe("PGL-10 the stored payload is an allow-list with no credential in it", () => {
  it("the four reference fields pass", () => {
    expect(() => assertInvitePayloadHoldsNoCredential(stored)).not.toThrow();
  });
  it.each([["href", HREF], ["token", TOKEN], ["acceptPath", `/invite/${TOKEN}`], ["tokenHash", "ab"], ["note", "hello"]])(
    "a payload with %s is refused",
    (key, value) => {
      expect(() => assertInvitePayloadHoldsNoCredential({ ...stored, [key]: value })).toThrow(InviteMailPayloadError);
    },
  );
  it("a token smuggled into an allowed field is refused too", () => {
    expect(() => assertInvitePayloadHoldsNoCredential({ ...stored, clientName: `x ${TOKEN}` })).toThrow(InviteMailPayloadError);
  });
  it("a payload without an invite id is refused (the sender could not mint for it)", () => {
    const { inviteId: _drop, ...rest } = stored;
    expect(() => assertInvitePayloadHoldsNoCredential(rest)).toThrow(InviteMailPayloadError);
  });
  it("enqueueMail refuses a client.invite payload carrying an href BEFORE any database work", async () => {
    const saved = config.mail.enabled;
    config.mail.enabled = true; // past the master gate, so only the guard can stop it (there is no database here)
    try {
      await expect(
        enqueueMail({ stream: "notify", templateKey: CLIENT_INVITE_TEMPLATE, toEmail: "a@b.test", payload: { ...stored, href: HREF } }),
      ).rejects.toBeInstanceOf(InviteMailPayloadError);
    } finally {
      config.mail.enabled = saved;
    }
  });
});

describe("PGL-10 the admin preview of an invitation", () => {
  it("renders the stored payload only: an href is stripped even if one were ever stored", () => {
    const r = renderInvitePreview({ ...stored, href: HREF });
    expect(`${r.subject} ${r.text} ${r.html}`).not.toContain(TOKEN);
    expect(r.text).toContain(CLIENT_INVITE_LINK_PLACEHOLDER);
  });
});

describe("PGL-10 the leak scanner has teeth (its positive control)", () => {
  const storedHashes = new Set([createHash("sha256").update(TOKEN).digest("hex")]);
  it("finds a stored token inside JSON, inside a URL, with a suffix glued on", () => {
    expect(findInviteTokenLeaks([{ where: "payload", text: JSON.stringify({ x: HREF }) }], storedHashes)).toHaveLength(1);
    expect(findInviteTokenLeaks([{ where: "log", text: `token=${TOKEN}.extra trailing` }], storedHashes)).toHaveLength(1);
  });
  it("finds a raw token the test saw even when its hash is no longer stored", () => {
    expect(findInviteTokenLeaks([{ where: "log", text: `x ${TOKEN} y` }], new Set(), [TOKEN])).toHaveLength(1);
  });
  it("does not flag the hash itself, the placeholder or another token", () => {
    const hash = [...storedHashes][0];
    const other = "inv2.YWJj.ZGVm.MDEyMzQ1Njc4OWFiY2RlZg.b3RoZXI";
    expect(findInviteTokenLeaks([{ where: "row", text: `${hash} ${CLIENT_INVITE_LINK_PLACEHOLDER} ${other}` }], storedHashes, [TOKEN])).toEqual([]);
  });
});
