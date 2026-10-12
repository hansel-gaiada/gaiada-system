import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// PV4-09 / design decision 7: message bodies are plain text. A body is client-authored, so rendering one as HTML is
// a client-to-staff XSS path. This pins it at the source: nothing in the conversation or minutes components may use
// dangerouslySetInnerHTML or write innerHTML. (The behavioural twin is the "img onerror renders literally" test in
// ThreadView.test.tsx.)
const FILES = [
  ...readdirSync(__dirname).filter((f) => /\.(tsx|ts)$/.test(f) && !/\.test\./.test(f)).map((f) => ({ f, path: join(__dirname, f) })),
  { f: "MinutesPanel.tsx", path: join(__dirname, "..", "..", "meetings", "MinutesPanel.tsx") },
];

describe("conversation components render plain text only", () => {
  it("scans the conversation and minutes components", () => {
    expect(FILES.some(({ f }) => f === "MessageBody.tsx")).toBe(true);
    expect(FILES.some(({ f }) => f === "MinutesPanel.tsx")).toBe(true);
  });
  for (const { f, path } of FILES) {
    it(`${f} never writes HTML`, () => {
      const src = readFileSync(path, "utf8");
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src).not.toMatch(/\.innerHTML\s*=/);
    });
  }
});
