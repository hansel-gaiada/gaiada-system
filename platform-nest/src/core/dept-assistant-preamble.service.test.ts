// AIP-13b (FRONTEND-BFF-CONTRACT §65) — the pure half of the department assistant preamble: the PUT body's validator, and the answer's shape.
// No database and no Nest (the routes, with the real table and Cerbos, are dept-assistant-preamble.test.ts on the Linux gate).
import { describe, it, expect } from "vitest";
import { DEFAULT_DEPT_PREAMBLES, PREAMBLE_MAX_CHARS, contextLine } from "../modules/assistant/department-context";
import { PreambleRuleError, parsePutBody, toPreambleView, type PreambleDbRow } from "./dept-assistant-preamble.service";

const refused = (body: unknown): PreambleRuleError => {
  try {
    parsePutBody(body);
  } catch (e) {
    expect(e).toBeInstanceOf(PreambleRuleError);
    return e as PreambleRuleError;
  }
  throw new Error(`expected a refusal for ${JSON.stringify(body)}`);
};

describe("parsePutBody", () => {
  it("trims the text", () => {
    expect(parsePutBody({ body: "  Use short lists.  \n" })).toEqual({ text: "Use short lists." });
  });

  it("1 and exactly 1,000 characters are texts to store", () => {
    expect(parsePutBody({ body: "a" })).toEqual({ text: "a" });
    expect(parsePutBody({ body: "a".repeat(PREAMBLE_MAX_CHARS) }).text).toHaveLength(PREAMBLE_MAX_CHARS);
  });

  it("1,001 characters is a 400 naming `body`; the length is counted after the trim", () => {
    const e = refused({ body: "a".repeat(PREAMBLE_MAX_CHARS + 1) });
    expect(e.httpStatus).toBe(400);
    expect(e.field).toBe("body");
    expect(parsePutBody({ body: `  ${"a".repeat(PREAMBLE_MAX_CHARS)}  ` }).text).toHaveLength(PREAMBLE_MAX_CHARS);
  });

  it("the length is in CODE POINTS, as Postgres counts it: 1,000 astral characters are accepted, 1,001 are not", () => {
    expect(Array.from(parsePutBody({ body: "\u{1F600}".repeat(PREAMBLE_MAX_CHARS) }).text as string)).toHaveLength(PREAMBLE_MAX_CHARS);
    expect(refused({ body: "\u{1F600}".repeat(PREAMBLE_MAX_CHARS + 1) }).field).toBe("body");
  });

  it("an empty or whitespace-only text means RESET (null), not an error", () => {
    expect(parsePutBody({ body: "" })).toEqual({ text: null });
    expect(parsePutBody({ body: "   \n\t " })).toEqual({ text: null });
    expect(parsePutBody({ body: "\u0000" })).toEqual({ text: null }); // a NUL is dropped, and nothing is left
  });

  it("anything else is a 400: no body, a non-string, an array, an extra key, a non-object", () => {
    for (const bad of [undefined, null, "text", 5, [], ["a"], {}, { body: 5 }, { body: null }, { body: ["a"] }, { text: "a" }, { body: "a", extra: 1 }]) {
      const e = refused(bad);
      expect(e.httpStatus, JSON.stringify(bad)).toBe(400);
    }
    expect(refused({ body: "a", extra: 1 }).field).toBe("extra");
  });

  it("CRLF becomes LF and a NUL is removed (a NUL would be a 500 in a Postgres text column)", () => {
    expect(parsePutBody({ body: "a\r\nb\rc\u0000d" }).text).toBe("a\nb\ncd");
  });

  it("an e-mail address or a card number is scrubbed before it is stored, as in a notice", () => {
    expect(parsePutBody({ body: "Ask ann@example.com about 4111 1111 1111 1111." }).text).toBe("Ask [REDACTED-EMAIL] about [REDACTED-PAN].");
  });
});

describe("toPreambleView", () => {
  const seo = { nodeId: "d-seo", name: "SEO", key: "seo" };
  const row = (body: string, by: string | null = "u-1"): PreambleDbRow => ({ body, updated_at: new Date("2026-10-29T10:00:00.000Z"), updated_by: by, updated_by_name: by ? "Sia Head" : null });

  it("no row: the default is the effective text, and nothing says who or when", () => {
    const v = toPreambleView("d-seo", seo, null);
    expect(v).toEqual({
      unitNodeId: "d-seo",
      department: { name: "SEO", key: "seo" },
      custom: null,
      defaultText: DEFAULT_DEPT_PREAMBLES.seo,
      effective: DEFAULT_DEPT_PREAMBLES.seo,
      updatedAt: null,
      updatedBy: null,
      preview: `${contextLine(seo, null)}\n\nDepartment guidance:\n${DEFAULT_DEPT_PREAMBLES.seo}`,
    });
  });

  it("a row: the custom text is effective, the default stays visible, and the editor and time are named", () => {
    const v = toPreambleView("d-seo", seo, row("Quote the audit id."));
    expect(v.custom).toBe("Quote the audit id.");
    expect(v.defaultText).toBe(DEFAULT_DEPT_PREAMBLES.seo);
    expect(v.effective).toBe("Quote the audit id.");
    expect(v.updatedAt).toBe("2026-10-29T10:00:00.000Z");
    expect(v.updatedBy).toEqual({ id: "u-1", name: "Sia Head" });
    expect(v.preview).toBe(`You are helping someone in the SEO department.\n\nDepartment guidance:\nQuote the audit id.`);
  });

  it("an erased editor (updated_by NULL) keeps the text and names nobody", () => {
    const v = toPreambleView("d-seo", seo, row("Quote the audit id.", null));
    expect(v.custom).toBe("Quote the audit id.");
    expect(v.updatedBy).toBeNull();
    expect(v.updatedAt).toBe("2026-10-29T10:00:00.000Z");
  });

  it("a department with no registry default and no row: effective null, and the preview is the context line alone", () => {
    const ops = { nodeId: "d-ops", name: "Operations", key: "operations" };
    const v = toPreambleView("d-ops", ops, null);
    expect(v.defaultText).toBeNull();
    expect(v.effective).toBeNull();
    expect(v.preview).toBe("You are helping someone in the Operations department.");
  });

  it("a whitespace-only stored row counts as no custom text", () => {
    const v = toPreambleView("d-seo", seo, row("  "));
    expect(v.custom).toBeNull();
    expect(v.effective).toBe(DEFAULT_DEPT_PREAMBLES.seo);
    expect(v.updatedAt).toBeNull();
  });
});
