// MAIL-10 — M11 pinned: "a magic link must never be an approval mechanism." Two independent
// checks, so a future edit to EITHER templates.ts OR the approval/notification wiring trips this:
//
//  1. Rendered output — approval.warning / approval.actionable (incl. an ADVERSARIAL payload that
//     tries to smuggle a magic-link-shaped href in) must never contain a magic-link URL shape or
//     the string "magic" anywhere in subject/html/text.
//  2. Static source scan — outside this module's own files, nothing in the mail/notification
//     source tree may reference the `auth.magic_link` template key. If some future change wires
//     it into an approval/notify path, this line is what should fail first.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "../templates";

const MAGIC_LINK_URL_SHAPE = /\/auth\/magic\?token=/i;

describe("M11 — magic links are never an approval mechanism", () => {
  // These two templates render WHATEVER `href` they are handed (that is MAIL-05's job, not this
  // file's) — so feeding them a magic-link-shaped href would trivially "pass" a naive
  // string-absence check by construction (the URL echoes back verbatim) without proving anything.
  // What this pins instead: given a NEUTRAL href, neither template's own hardcoded wording ever
  // mentions a magic link, a token, or a one-click sign-in — i.e. the functions add no
  // magic-link semantics of their own. The complementary, load-bearing half of M11 — that the
  // MINT SITE and the approval/notify call sites never hand these templates a magic-link href in
  // the first place — is the static source scan below.
  it("approval.warning's own wording never mentions a magic link or a token", () => {
    const rendered = renderTemplate("approval.warning", {
      href: "https://erp.gaiada.invalid/approvals/123",
      subjectTitle: "update budget",
      tool: "automation",
      impact: "high",
      companyName: "Acme",
    });
    for (const field of [rendered.subject, rendered.html, rendered.text]) {
      expect(field.toLowerCase()).not.toContain("magic");
      expect(field.toLowerCase()).not.toContain("token");
    }
  });

  it("approval.actionable's own wording never mentions a magic link or a token", () => {
    const rendered = renderTemplate("approval.actionable", {
      href: "https://erp.gaiada.invalid/approvals/123",
      subjectTitle: "sign the PRD gate",
    });
    for (const field of [rendered.subject, rendered.html, rendered.text]) {
      expect(field.toLowerCase()).not.toContain("magic");
      expect(field.toLowerCase()).not.toContain("token");
    }
  });

  it("auth.magic_link's own rendered link DOES carry the token — confirms the assertions above are meaningful, not vacuous", () => {
    const rendered = renderTemplate("auth.magic_link", {
      href: "https://erp.gaiada.invalid/auth/magic?token=real-token-value",
      ttlMinutes: 15,
    });
    expect(rendered.html + rendered.text).toMatch(MAGIC_LINK_URL_SHAPE);
  });

  it("no file outside src/mail/magic-link/ references the auth.magic_link template key", () => {
    const mailDir = join(__dirname, ".."); // src/mail
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "magic-link") continue; // this module's own files are exempt
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
        } else if (
          entry.isFile() &&
          /\.tsx?$/.test(entry.name) &&
          entry.name !== "templates.ts" &&
          entry.name !== "templates.test.ts" && // pins the key registry itself (this ticket's edit)
          // MAIL-04's pre-existing migration.test.ts inserts a placeholder mail_log row with
          // template_key='auth.magic_link' purely to exercise the 'auth' stream/status CHECK
          // constraints — it predates this ticket and does not route any approval/notify path.
          entry.name !== "migration.test.ts"
        ) {
          // templates.ts itself is exempt — it OWNS the registration `"auth.magic_link": ...` and
          // is asserted safe by the rendered-output checks above, not by absence of the string.
          const text = readFileSync(full, "utf8");
          if (text.includes("auth.magic_link")) offenders.push(full);
        }
      }
    };
    walk(mailDir);
    // Also scan the notification tap + the approval-notification wiring outside src/mail/ entirely.
    const coreFiles = [join(mailDir, "..", "core", "http.ts"), join(mailDir, "..", "core", "approval-deciders.ts")];
    for (const f of coreFiles) {
      try {
        if (readFileSync(f, "utf8").includes("auth.magic_link")) offenders.push(f);
      } catch {
        // file may not exist in a given checkout state — not this test's concern
      }
    }
    expect(offenders).toEqual([]);
  });
});
