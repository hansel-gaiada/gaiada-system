import { describe, it, expect } from "vitest";
import { renderTemplate, UnknownMailTemplateError, knownTemplateKeys } from "./templates";

// M12 wording gate (design §7.4): the automation/agent warning template must NEVER imply that
// deciding executes anything. Pinned here per MAIL-04's ticket AC; MAIL-18 re-asserts against a
// rendered live send.
const FORBIDDEN_WORDS = ["approve", "approved", "approves", "reject", "rejected", "rejects", "decide", "deciding"];

describe("mail/templates", () => {
  it("renders approval.warning with neither approve/reject/decide language nor an action affordance, and states nothing has run", () => {
    const rendered = renderTemplate("approval.warning", {
      href: "https://erp.gaiada.invalid/approvals/123",
      companyName: "Acme",
      subjectTitle: "raise ad budget by 40%",
      tool: "budget-optimizer",
      impact: "high",
    });
    const haystack = `${rendered.subject} ${rendered.text} ${rendered.html}`.toLowerCase();
    for (const word of FORBIDDEN_WORDS) {
      expect(haystack).not.toContain(word);
    }
    expect(rendered.text).toContain("suspended");
    expect(rendered.text).toContain("nothing has run");
    expect(rendered.text).toContain("https://erp.gaiada.invalid/approvals/123");
    // No action affordance beyond the plain link (M11): no query string, no token param.
    expect(rendered.html).not.toMatch(/href="https:\/\/erp\.gaiada\.invalid\/approvals\/123\?/);
  });

  it("renders approval.actionable with the decision-needed wording (pipeline/hr/agency origins)", () => {
    const rendered = renderTemplate("approval.actionable", {
      href: "https://erp.gaiada.invalid/pipeline/456",
      subjectTitle: "sign the PRD gate",
    });
    expect(rendered.text).toContain("Your decision is needed");
    expect(rendered.text).toContain("https://erp.gaiada.invalid/pipeline/456");
  });

  it("renders the auth shell with a plain body + optional link, no approval semantics", () => {
    const rendered = renderTemplate("auth.shell", { body: "Sign in to continue.", href: "https://erp.gaiada.invalid/auth/x" });
    expect(rendered.text).toContain("Sign in to continue.");
    expect(rendered.text).toContain("https://erp.gaiada.invalid/auth/x");
    expect(rendered.subject.toLowerCase()).not.toMatch(/approve|reject/);
  });

  it("throws UnknownMailTemplateError for an unregistered template_key instead of silently rendering blank content", () => {
    expect(() => renderTemplate("no.such.template", {})).toThrow(UnknownMailTemplateError);
  });

  it("escapes HTML in payload strings (defensive XSS hygiene even for staff-authored payloads)", () => {
    const rendered = renderTemplate("approval.actionable", {
      href: "https://erp.gaiada.invalid/x",
      subjectTitle: '<script>alert(1)</script>',
    });
    expect(rendered.html).not.toContain("<script>alert(1)</script>");
    expect(rendered.html).toContain("&lt;script&gt;");
  });

  it("exposes the known template keys used by this ticket", () => {
    // MAIL-10 added "auth.magic_link" (design §9) and SMM-13 added "social.post_failed" — code
    // templates, registered the same way as the rest (see this file's own header: templates are code,
    // not DB rows). This list is a deliberate pin: a template appearing or vanishing must show up in a
    // diff, because `enqueue()` throws UnknownMailTemplateError for anything unregistered and a
    // silently-added key is a mail path nobody reviewed. SMM-13 shipped its key without updating the
    // pin, so this assertion was red on main for a while — that is the pin doing its job late, not a
    // reason to loosen it.
    expect(knownTemplateKeys().sort()).toEqual([
      "approval.actionable",
      "approval.warning",
      "auth.magic_link",
      "auth.shell",
      "social.post_failed",
    ]);
  });

  // MAIL-18 gate follow-up (2026-08-08) — escaping is not scheme-safety.
  // A `javascript:` URL contains no <, >, " or ', so escapeHtml() passed it through untouched and it
  // landed inside href="..." as a working script URL. Not exploitable when found (every writer of
  // payload.href prefixes the trusted MAIL_LINK_BASE_URL), but MAIL-38 now renders these templates
  // into an elevated-only admin page, so the renderer must hold on its own rather than inherit
  // safety from every present and future caller.
  it("refuses a non-http(s) scheme in href instead of emitting it as a live link", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "javascript:alert(1)",
    ]) {
      const out = renderTemplate("approval.actionable", { href: hostile, subjectTitle: "t" });
      expect(out.html).not.toContain(`href="${hostile}"`);
      expect(out.html.toLowerCase()).not.toContain('href="javascript');
      expect(out.html.toLowerCase()).not.toContain('href="data:');
      expect(out.html.toLowerCase()).not.toContain('href="vbscript');
      // The link is DEAD, not merely re-escaped.
      expect(out.html).toContain('href=""');
    }
  });

  it("still renders a legitimate https link untouched", () => {
    const url = "https://erp.example.invalid/approvals/019fd246-9618-77ad-8dc3-cbeb3842f8f1";
    const out = renderTemplate("approval.actionable", { href: url, subjectTitle: "t" });
    expect(out.html).toContain(`href="${url}"`);
  });

  it("keeps a refused URL visible as text, so it reads as a dead link rather than vanishing", () => {
    const out = renderTemplate("approval.actionable", { href: "javascript:alert(1)", subjectTitle: "t" });
    expect(out.html).toContain('href=""');      // dead
    expect(out.html).toContain("javascript:alert(1)"); // but still shown to the reviewer
  });
});
