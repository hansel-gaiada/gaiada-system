// WSK-11 — minimal, safe {{var}} substitution. Deliberately NOT a general templating engine:
// form submission data (untrusted, public-origin input per the forms service, WSK-10) flows into
// `variables`, so this renderer supports flat top-level key lookup ONLY — no property access, no
// expressions, no partials/includes, nothing an attacker-controlled variable VALUE could turn
// into a cross-variable lookup or code execution. The html body escapes every substitution; the
// text body substitutes raw (plain text has no injection surface here).
const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderTemplate(
  source: string,
  variables: Record<string, string>,
  opts: { escapeHtml: boolean },
): string {
  return source.replace(TOKEN, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) return ""; // an unknown variable disappears — never survives as a
    // literal "{{token}}" into a sent email.
    return opts.escapeHtml ? escapeHtml(value) : value;
  });
}

/** Fallback text body when a template defines no explicit body_text (mail_templates.body_text is
 * nullable). A crude but safe strip — this only ever runs on OUR OWN template HTML (mail_templates
 * rows, tenant-authored), never on submitted form data, so fidelity matters more than hardening
 * here. */
export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}
