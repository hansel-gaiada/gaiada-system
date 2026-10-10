// WSK-60 done-when 3 (pure half) — what a build stamp proves, and nothing else.
// `stampProves` is the only function that can say "live", so its truth table is pinned here, including
// the boundary (maxUpdatedAt exactly equal to publishedAt) and every way a stamp can fail to prove.
// `readStagingStamp` runs against a real stub HTTP server: a stamp that cannot be read (down, 404, not
// JSON, a redirect, an oversize body) must come back as a typed refusal, never as a proof.
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStamp, readStagingStamp, stampProves, type BuildStamp } from "./site-build-stamp";
import { parseRebuildTargets } from "./site-builds.service";

const T0 = new Date("2026-10-10T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const stamp = (over: Partial<BuildStamp> = {}): BuildStamp => ({
  source: "webdesk",
  pulledAt: at(60_000),
  maxUpdatedAt: at(0),
  itemCount: 330,
  ...over,
});

describe("stampProves — publish with a known publishedAt: maxUpdatedAt >= publishedAt", () => {
  const build = { kind: "publish" as const, publishedAt: at(0), dispatchedAt: at(1_000) };

  it("equal is proof (the boundary)", () => {
    expect(stampProves(stamp({ maxUpdatedAt: at(0) }), build)).toEqual({ proved: true, by: "maxUpdatedAt" });
  });
  it("newer is proof (a later publish folded into the same build)", () => {
    expect(stampProves(stamp({ maxUpdatedAt: at(5_000) }), build)).toEqual({ proved: true, by: "maxUpdatedAt" });
  });
  it("one millisecond older is NOT proof (negative control: the unchanged stamp)", () => {
    const r = stampProves(stamp({ maxUpdatedAt: at(-1) }), build);
    expect(r.proved).toBe(false);
  });
  it("a stamp pulled after the dispatch does not rescue an old maxUpdatedAt (the publish rule is maxUpdatedAt)", () => {
    expect(stampProves(stamp({ maxUpdatedAt: at(-3_600_000), pulledAt: at(600_000) }), build).proved).toBe(false);
  });
  it("no maxUpdatedAt proves nothing", () => {
    expect(stampProves(stamp({ maxUpdatedAt: null }), build).proved).toBe(false);
  });
  it("the git build's stamp ({source:'git'}) proves nothing, whatever dates it carries", () => {
    expect(stampProves(stamp({ source: "git", maxUpdatedAt: at(9e9) }), build).proved).toBe(false);
  });
});

describe("stampProves — a rebuild, or a publish whose publishedAt is unknown: pulledAt >= dispatchedAt", () => {
  const rebuild = { kind: "rebuild" as const, publishedAt: null, dispatchedAt: at(1_000) };
  it("pulled after the dispatch is proof; equal is proof", () => {
    expect(stampProves(stamp({ pulledAt: at(2_000) }), rebuild)).toEqual({ proved: true, by: "pulledAt" });
    expect(stampProves(stamp({ pulledAt: at(1_000) }), rebuild)).toEqual({ proved: true, by: "pulledAt" });
  });
  it("pulled before the dispatch is NOT proof (that pull is not the build this dispatch started)", () => {
    expect(stampProves(stamp({ pulledAt: at(999) }), rebuild).proved).toBe(false);
  });
  it("no pulledAt, or a git stamp, proves nothing", () => {
    expect(stampProves(stamp({ pulledAt: null }), rebuild).proved).toBe(false);
    expect(stampProves(stamp({ source: "git", pulledAt: at(9e9) }), rebuild).proved).toBe(false);
  });
  it("a publish with publishedAt = null (reconciled) falls back to pulledAt, not to maxUpdatedAt", () => {
    const b = { kind: "publish" as const, publishedAt: null, dispatchedAt: at(1_000) };
    expect(stampProves(stamp({ pulledAt: at(2_000), maxUpdatedAt: at(-1e6) }), b).proved).toBe(true);
    expect(stampProves(stamp({ pulledAt: at(500), maxUpdatedAt: at(1e6) }), b).proved).toBe(false);
  });
});

describe("parseStamp", () => {
  it("reads the WSK-55 stamp", () => {
    const r = parseStamp({ source: "webdesk", pulledAt: "2026-10-10T10:00:00.000Z", maxUpdatedAt: "2026-10-10T09:00:00.000Z", itemCount: 330, sourceSha256: "x" });
    expect(r).toMatchObject({ ok: true, stamp: { source: "webdesk", itemCount: 330 } });
    expect(r.ok && r.stamp.pulledAt?.toISOString()).toBe("2026-10-10T10:00:00.000Z");
  });
  it("the committed git stamp parses as source 'git' with no dates", () => {
    expect(parseStamp({ source: "git" })).toMatchObject({ ok: true, stamp: { source: "git", pulledAt: null, maxUpdatedAt: null } });
  });
  it("refuses a non-object, an array, and a body with no source", () => {
    for (const b of [null, 7, "x", [], {}, { source: "" }, { pulledAt: "2026-10-10T10:00:00Z" }]) {
      expect(parseStamp(b), JSON.stringify(b)).toEqual({ ok: false, reason: "malformed" });
    }
  });
  it("an unparseable date is null, never an Invalid Date that compares as false in a surprising way", () => {
    const r = parseStamp({ source: "webdesk", pulledAt: "not a date", maxUpdatedAt: 5 });
    expect(r).toMatchObject({ ok: true, stamp: { pulledAt: null, maxUpdatedAt: null } });
  });
});

describe("readStagingStamp against a real stub server", () => {
  let server: http.Server;
  let base = "";
  let mode: "ok" | "404" | "html" | "redirect" | "huge" | "hang" = "ok";
  const seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      if (mode === "hang") return; // never answers
      if (mode === "404") { res.writeHead(404); res.end("nope"); return; }
      if (mode === "redirect") { res.writeHead(302, { location: "https://elsewhere.invalid/webdesk-build.json" }); res.end(); return; }
      if (mode === "html") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>maintenance</html>"); return; }
      if (mode === "huge") { res.writeHead(200); res.end("x".repeat(20_000)); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ source: "webdesk", pulledAt: "2026-10-10T10:00:00.000Z", maxUpdatedAt: "2026-10-10T09:00:00.000Z", itemCount: 3 }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reads the stamp at /webdesk-build.json and sends a cache-buster", async () => {
    mode = "ok";
    const r = await readStagingStamp(`${base}/`, { nonce: "n1" });
    expect(r).toMatchObject({ ok: true, stamp: { source: "webdesk", itemCount: 3 } });
    expect(seen.at(-1)).toBe("/webdesk-build.json?t=n1");
  });
  it("404, HTML, a redirect, an oversize body and a hang each come back as a typed refusal", async () => {
    mode = "404";
    expect(await readStagingStamp(base)).toEqual({ ok: false, reason: "http_status" });
    mode = "html";
    expect(await readStagingStamp(base)).toEqual({ ok: false, reason: "not_json" });
    mode = "redirect";
    expect(await readStagingStamp(base)).toEqual({ ok: false, reason: "unreachable" });
    mode = "huge";
    expect(await readStagingStamp(base)).toEqual({ ok: false, reason: "malformed" });
    mode = "hang";
    expect(await readStagingStamp(base, { timeoutMs: 150 })).toEqual({ ok: false, reason: "unreachable" });
  });
  it("a closed port is 'unreachable'", async () => {
    expect(await readStagingStamp("http://127.0.0.1:9", { timeoutMs: 500 })).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("parseRebuildTargets (config)", () => {
  const ok = {
    tenantSlug: "gaiada", siteId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4", repo: "gaiadabali/gaiada-web-revamp",
    workflow: "webdesk-rebuild.yml", ref: "astro-site", stagingUrl: "https://24-pyevq.gaiada.com/",
  };
  const quiet = () => undefined;
  it("accepts a good entry and normalises the staging URL to its origin", () => {
    expect(parseRebuildTargets(JSON.stringify([ok]), quiet)).toEqual([{ ...ok, stagingUrl: "https://24-pyevq.gaiada.com" }]);
  });
  it("empty, malformed JSON and a non-array all configure NOTHING (fail closed)", () => {
    for (const j of ["", "  ", "{not json", "{}", "7"]) expect(parseRebuildTargets(j, quiet)).toEqual([]);
  });
  it("drops an entry with a bad repo, workflow, ref, site id, slug or a plain-http staging URL, and keeps the good one", () => {
    const warnings: string[] = [];
    const bad = [
      { ...ok, repo: "no-slash" }, { ...ok, workflow: "../evil.yml" }, { ...ok, ref: "" }, { ...ok, siteId: "x" },
      { ...ok, tenantSlug: "Bad Slug" }, { ...ok, stagingUrl: "http://24-pyevq.gaiada.com" }, { ...ok, stagingUrl: "javascript:alert(1)" },
    ];
    const r = parseRebuildTargets(JSON.stringify([...bad, ok]), (m) => warnings.push(m));
    expect(r).toHaveLength(1);
    expect(warnings).toHaveLength(bad.length);
  });
  it("allows plain http only for a loopback host (the test stubs)", () => {
    expect(parseRebuildTargets(JSON.stringify([{ ...ok, stagingUrl: "http://127.0.0.1:8080" }]), quiet)).toHaveLength(1);
  });
});
