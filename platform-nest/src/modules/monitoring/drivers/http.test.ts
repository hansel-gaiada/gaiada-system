// MON-11c — http/keyword driver tests. Uses a real loopback server for behaviour, and a source-level
// pin for the structural invariant.
//
// The server binds 127.0.0.1, which the egress guard DENIES by design — so the probe tests pass the
// literal loopback host in the allowlist AND rely on the fact that an IP literal target skips DNS.
// That is deliberate: it exercises the real request path without weakening the guard, and the
// "guard actually refuses" cases are asserted separately below.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import io from "node:fs";
import path from "node:path";
import {
  httpDriver,
  keywordDriver,
  validateHttpConfig,
  validateKeywordConfig,
} from "./http";
import type { ProbeCtx } from "./registry";
import { isDeniedAddress as realIsDenied } from "./egress";

let server: http.Server;
let base = "";
const audits: { host: string; allowed: boolean; reason: string }[] = [];

function ctx(allow: string[]): ProbeCtx {
  return {
    allowlistHosts: allow,
    timeoutMs: 3000,
    audit: (d) => audits.push({ host: d.host, allowed: d.allowed, reason: d.reason }),
    // TEST SEAM: the behaviour tests bind a real server, which lives on loopback, which the real
    // classifier correctly denies. This permits ONLY loopback and defers to the real classifier for
    // everything else -- so the metadata-redirect and private-IP cases below are still judged by
    // production logic, not by a blanket allow.
    isDeniedOverride: (ip) => (ip === "127.0.0.1" || ip === "::1" ? false : realIsDenied(ip)),
  };
}

/** A ctx with NO seam: production behaviour, used to prove the IP-literal bypass is closed. */
function strictCtx(allow: string[]): ProbeCtx {
  return {
    allowlistHosts: allow,
    timeoutMs: 3000,
    audit: (d) => audits.push({ host: d.host, allowed: d.allowed, reason: d.reason }),
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(200); res.end("<html>Book a table today</html>"); return; }
    if (req.url === "/spam") { res.writeHead(200); res.end("<html>cheap pharma pills</html>"); return; }
    if (req.url === "/blank") { res.writeHead(200); res.end(""); return; }
    // Bigger than MAX_BODY_BYTES (256 KB) and otherwise perfectly healthy - an ordinary WordPress
    // homepage is 300-400 KB. The keyword this serves sits in the FIRST chunk so a content check can
    // still be satisfied from the truncated read.
    if (req.url === "/huge") {
      res.writeHead(200);
      res.write("<html>Book a table today");
      res.end("x".repeat(600 * 1024) + "</html>");
      return;
    }
    if (req.url === "/teapot") { res.writeHead(418); res.end("nope"); return; }
    if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); return; }
    if (req.url === "/away") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); return; }
    res.writeHead(404); res.end("nf");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("config validation refuses what cannot be checked", () => {
  it("rejects non-http schemes — classic SSRF pivots no client site needs", () => {
    expect(() => validateHttpConfig({ url: "file:///etc/passwd" })).toThrow(/http or https/);
    expect(() => validateHttpConfig({ url: "gopher://x/" })).toThrow(/http or https/);
  });

  it("rejects a content check with no assertion", () => {
    // Otherwise it is a status check wearing a costume: reports "up" while the operator believes
    // their page content is being verified.
    expect(() => validateKeywordConfig({ url: "http://a.test/" })).toThrow(/asserts nothing/);
  });

  it("forces GET for a content check, since HEAD has no body to assert on", () => {
    const c = validateKeywordConfig({ url: "http://a.test/", expect: "hi", method: "HEAD" });
    expect(c.method).toBe("GET");
  });

  it("defaults expectStatus to 200 and rejects nonsense", () => {
    expect(validateHttpConfig({ url: "http://a.test/" }).expectStatus).toBe(200);
    expect(() => validateHttpConfig({ url: "http://a.test/", expectStatus: 99 })).toThrow();
  });
});

describe("http driver against a real server", () => {
  it("reports up on the expected status", async () => {
    const r = await httpDriver.probe(validateHttpConfig({ url: `${base}/ok` }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("up");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports DOWN, not unknown, on a wrong status", async () => {
    // `unknown` is reserved for "we did not check". Conflating them would let a real outage render as
    // an un-run check, which is the failure this whole module exists to prevent.
    const r = await httpDriver.probe(validateHttpConfig({ url: `${base}/teapot` }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/expected HTTP 200, got 418/);
  });

  it("refuses a host that is not allowlisted", async () => {
    const r = await httpDriver.probe(validateHttpConfig({ url: "http://not-allowed.test/" }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/not allowlisted/);
  });
});

describe("redirects are re-validated — the hole that fetch() would have left open", () => {
  it("refuses a redirect to the cloud metadata endpoint", async () => {
    // An allowlisted public URL 302-ing to 169.254.169.254 is the whole reason redirects are walked
    // manually instead of letting the HTTP client follow them.
    const r = await httpDriver.probe(validateHttpConfig({ url: `${base}/away` }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/not allowlisted|refused/);
  });

  it("stops a redirect loop instead of spinning", async () => {
    const r = await httpDriver.probe(validateHttpConfig({ url: `${base}/loop` }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/too many redirects/);
  });
});

describe("keyword driver distinguishes the failure modes a status check cannot see", () => {
  it("up when the expected text is present", async () => {
    const r = await keywordDriver.probe(
      validateKeywordConfig({ url: `${base}/ok`, expect: "Book a table" }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("up");
  });

  it("DEGRADED when the page answers 200 but lost its content", async () => {
    // Reachable and answering correctly, but not serving what it should. A human reading the board
    // should see that as different from "the site is down".
    const r = await keywordDriver.probe(
      validateKeywordConfig({ url: `${base}/blank`, expect: "Book a table" }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("degraded");
    expect(r.detail).toMatch(/does not contain/);
  });

  it("DOWN when forbidden content appears — the defacement signal", async () => {
    const r = await keywordDriver.probe(
      validateKeywordConfig({ url: `${base}/spam`, forbid: "pharma" }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/forbidden/);
  });

  it("a 200 with spam would have passed a plain status check", async () => {
    // The point of the kind, stated as a test: same URL, same 200, opposite verdicts.
    const asStatus = await httpDriver.probe(validateHttpConfig({ url: `${base}/spam` }), ctx(["127.0.0.1"]));
    const asContent = await keywordDriver.probe(
      validateKeywordConfig({ url: `${base}/spam`, forbid: "pharma" }), ctx(["127.0.0.1"]));
    expect(asStatus.status).toBe("up");
    expect(asContent.status).toBe("down");
  });
});

describe("a page larger than the body cap is UP, not a hung probe", () => {
  // THE REGRESSION. The cap path used to call `res.destroy()` without settling the promise, and
  // `destroy()` emits `close` - not `end`, not `error`. So the probe hung forever, the socket
  // timeout could not fire (the socket was gone), and the only thing that ended it was the runner's
  // wall-clock deadline, recorded as `down: probe exceeded 20000ms hard deadline`. Every site with a
  // page over 256 KB read as DOWN on the board and in the Web Dev portfolio while serving 200 in
  // under a second. These tests fail by TIMING OUT if that returns, so give them room to prove it.
  it("reports up on an oversized body instead of hanging", async () => {
    const started = Date.now();
    const r = await httpDriver.probe(validateHttpConfig({ url: `${base}/huge` }), ctx(["127.0.0.1"]));
    expect(r.status).toBe("up");
    // Well inside the 3s ctx timeout, let alone the runner's timeout+5s deadline.
    expect(Date.now() - started).toBeLessThan(3000);
  }, 10_000);

  it("still evaluates a content assertion over the truncated body", async () => {
    const r = await keywordDriver.probe(
      validateKeywordConfig({ url: `${base}/huge`, expect: "Book a table" }),
      ctx(["127.0.0.1"]),
    );
    expect(r.status).toBe("up");
  }, 10_000);

  it("says the body was truncated when the expected text was not in the part it read", async () => {
    // Honest degraded, not a silent one: the operator has to be able to tell "the page lost its
    // content" from "the phrase is past the byte we stop reading at".
    const r = await keywordDriver.probe(
      validateKeywordConfig({ url: `${base}/huge`, expect: "phrase past the cap" }),
      ctx(["127.0.0.1"]),
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toMatch(/first \d+ bytes/);
  }, 10_000);
});

describe("IP-literal targets are classified — the bypass found by probing Node", () => {
  it("refuses an allowlisted metadata IP even though Node skips DNS for literals", async () => {
    // Empirically verified: Node does NOT call the agent's `lookup` for an IP-literal host, so the
    // classifier in the guard never ran. That made protection conditional on DNS happening at all.
    // Here the host IS allowlisted, so ONLY the literal classification can refuse it.
    const r = await httpDriver.probe(
      validateHttpConfig({ url: "http://169.254.169.254/latest/meta-data/" }),
      strictCtx(["169.254.169.254"]),
    );
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/non-public address/);
  });

  it("refuses allowlisted loopback and RFC1918 literals under production settings", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1"]) {
      const r = await httpDriver.probe(validateHttpConfig({ url: `http://${ip}/` }), strictCtx([ip]));
      expect(r.status, ip).toBe("down");
      expect(r.detail, ip).toMatch(/non-public address/);
    }
  });
});

describe("structural pin: no driver may build an unguarded agent", () => {
  it("every Agent construction in this module installs the guarded lookup", () => {
    // Source-level on purpose. The guard is worthless if any driver constructs its own agent, and
    // that failure is invisible at runtime — the probe simply works, against anything. Counting
    // constructions is the only check that catches a future driver added without the lookup.
    const src = io.readFileSync(path.join(__dirname, "http.ts"), "utf8");
    const agents = src.match(/new\s+AgentCtor\(|new\s+https?\.Agent\(/g) ?? [];
    expect(agents.length).toBe(1);
    const lookups = src.match(/createGuardedLookup\(/g) ?? [];
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    // And it must not reach for fetch/undici, which follows redirects with no hook to re-validate.
    expect(src).not.toMatch(/\bfetch\(/);
  });
});
