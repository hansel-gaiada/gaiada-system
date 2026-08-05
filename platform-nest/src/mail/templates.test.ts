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
    // MAIL-10 added "auth.magic_link" (design §9) — a fourth code template, registered the same
    // way as the other three (see this file's own header: templates are code, not DB rows).
    expect(knownTemplateKeys().sort()).toEqual([
      "approval.actionable",
      "approval.warning",
      "auth.magic_link",
      "auth.shell",
    ]);
  });
});
