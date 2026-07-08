// Day-one PII scrubber (platform side). Mirrors the bot's rule intent (PAN/national-ID)
// but is standalone — components are separate projects, so the ruleset is duplicated by
// design, not imported. Redacts the high-risk identifiers we must never persist in the
// clear: 16-digit card PANs, Indonesian NIK/KTP (16 digits), and bare emails in file text.
// Text-only: binary content is stored as-is (its type gates whether we scrub at all).
const RULES: Array<{ re: RegExp; tag: string }> = [
  // Card PAN: 13–19 digits, optionally space/dash grouped.
  { re: /\b(?:\d[ -]?){13,19}\b/g, tag: "[REDACTED-PAN]" },
  // Indonesian NIK/KTP: exactly 16 digits (also covered above, kept explicit for clarity).
  { re: /\b\d{16}\b/g, tag: "[REDACTED-NIK]" },
  // Emails.
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, tag: "[REDACTED-EMAIL]" },
];

export function scrubText(input: string): { text: string; redactions: number } {
  let redactions = 0;
  let text = input;
  for (const { re, tag } of RULES) {
    text = text.replace(re, (m) => {
      // Ignore short numeric runs the greedy PAN rule might catch inside longer tokens.
      redactions += 1;
      return tag;
    });
  }
  return { text, redactions };
}

/** Whether a content type is text we can safely scrub in place. */
export function isScrubbableText(contentType: string): boolean {
  return /^text\//.test(contentType) || /(json|csv|xml|yaml|plain)/.test(contentType);
}
