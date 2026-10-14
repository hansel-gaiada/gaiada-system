// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36.2, §36.7) — the Figma URL parser. Pure: no database, no Cerbos, no network.
import { describe, it, expect } from "vitest";
import { FigmaUrlError, nodeIdToApi, nodeIdToUrl, parseFigmaUrl } from "./url";

const KEY = "AbC123xyz9QwErTy4567Zz";

describe("parseFigmaUrl: accepted links (§36.2)", () => {
  it.each(["design", "file", "proto"])("/%s/<key>/<slug> on www.figma.com names the file, no frame", (kind) => {
    const p = parseFigmaUrl(`https://www.figma.com/${kind}/${KEY}/Brand-Kit`);
    expect(p).toEqual({ kind, fileKey: KEY, nodeId: null, url: `https://www.figma.com/${kind}/${KEY}` });
  });

  it("figma.com without www is accepted and stored as www.figma.com", () => {
    const p = parseFigmaUrl(`https://figma.com/design/${KEY}/Brand-Kit`);
    expect(p.url).toBe(`https://www.figma.com/design/${KEY}`);
    expect(p.fileKey).toBe(KEY);
  });

  it("node-id: the URL's `-` becomes the API's `:` (1-2 is 1:2) and the stored link keeps the URL form", () => {
    const p = parseFigmaUrl(`https://www.figma.com/design/${KEY}/Brand-Kit?node-id=1-2&t=abc123-1`);
    expect(p.nodeId).toBe("1:2");
    expect(p.url).toBe(`https://www.figma.com/design/${KEY}?node-id=1-2`);
  });

  it("node-id with several digits and an already-encoded colon both give the API form", () => {
    expect(parseFigmaUrl(`https://www.figma.com/file/${KEY}/x?node-id=1234-56789`).nodeId).toBe("1234:56789");
    expect(parseFigmaUrl(`https://www.figma.com/file/${KEY}/x?node-id=12%3A34`).nodeId).toBe("12:34");
    expect(parseFigmaUrl(`https://www.figma.com/file/${KEY}/x?node-id=12:34`).nodeId).toBe("12:34");
  });

  it("a nested-instance node id keeps its structure", () => {
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/x?node-id=I1-2;3-4`).nodeId).toBe("I1:2;3:4");
  });

  it("the file key may be the last path segment, with a trailing slash, and the host is case-insensitive", () => {
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}`).fileKey).toBe(KEY);
    expect(parseFigmaUrl(`https://www.figma.com/design/${KEY}/`).fileKey).toBe(KEY);
    expect(parseFigmaUrl(`https://WWW.Figma.COM/design/${KEY}/x`).fileKey).toBe(KEY);
  });

  it("surrounding whitespace is trimmed, and http is accepted but stored as https", () => {
    expect(parseFigmaUrl(`  http://www.figma.com/design/${KEY}/x  `).url).toBe(`https://www.figma.com/design/${KEY}`);
  });

  it("other query parameters and the fragment are dropped from the stored link", () => {
    const p = parseFigmaUrl(`https://www.figma.com/proto/${KEY}/x?page-id=0%3A1&node-id=5-6&scaling=contain#frag`);
    expect(p.url).toBe(`https://www.figma.com/proto/${KEY}?node-id=5-6`);
  });
});

describe("parseFigmaUrl: refusals are bad_figma_url with field url", () => {
  const refused: Array<[string, unknown]> = [
    ["not a string", 42],
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
    ["not a link", "figma design please"],
    ["a relative path", `/design/${KEY}/x`],
    ["a scheme-less host", `www.figma.com/design/${KEY}/x`],
    ["another host", `https://www.example.com/design/${KEY}/x`],
    ["a look-alike suffix", `https://figma.com.evil.test/design/${KEY}/x`],
    ["a look-alike prefix", `https://notfigma.com/design/${KEY}/x`],
    ["a subdomain", `https://api.figma.com/design/${KEY}/x`],
    ["the credentials trick", `https://www.figma.com@evil.test/design/${KEY}/x`],
    ["credentials", `https://user:pw@www.figma.com/design/${KEY}/x`],
    ["a port", `https://www.figma.com:8443/design/${KEY}/x`],
    ["another scheme", `ftp://www.figma.com/design/${KEY}/x`],
    ["javascript:", "javascript:alert(1)"],
    ["no path", "https://www.figma.com/"],
    ["an unknown path kind", `https://www.figma.com/board/${KEY}/x`],
    ["the community path", `https://www.figma.com/community/file/${KEY}`],
    ["no key", "https://www.figma.com/design/"],
    ["a key with a dot", "https://www.figma.com/design/abc.def/x"],
    ["a key with a percent escape", "https://www.figma.com/design/ab%2Fcd/x"],
    ["a key that is too long", `https://www.figma.com/design/${"a".repeat(65)}/x`],
    ["a node-id that is not a frame id", `https://www.figma.com/design/${KEY}/x?node-id=abc`],
    ["an empty node-id", `https://www.figma.com/design/${KEY}/x?node-id=`],
    ["a node-id with an injection", `https://www.figma.com/design/${KEY}/x?node-id=1-2%26ids%3D9-9`],
    ["a node-id with one number", `https://www.figma.com/design/${KEY}/x?node-id=12`],
    ["a link longer than 2048 characters", `https://www.figma.com/design/${KEY}/${"a".repeat(2100)}`],
  ];
  it.each(refused)("%s", (_label, input) => {
    let err: unknown;
    try {
      parseFigmaUrl(input);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FigmaUrlError);
    const e = err as FigmaUrlError;
    expect(e.field).toBe("url");
    expect(e.token).toBe("bad_figma_url");
    expect(e.message.startsWith("bad_figma_url:")).toBe(true);
  });
});

describe("node id forms", () => {
  it("converts both ways", () => {
    expect(nodeIdToApi("1-2")).toBe("1:2");
    expect(nodeIdToUrl("1:2")).toBe("1-2");
    expect(nodeIdToUrl(nodeIdToApi("123-456"))).toBe("123-456");
  });
});
