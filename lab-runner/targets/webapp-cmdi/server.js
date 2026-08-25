// A DELIBERATELY VULNERABLE target for the Cyber lab (LMS L6).
//
// ⚠ THIS IS THE ONE FILE IN THE ESTATE THAT IS WRONG ON PURPOSE. It exists to be broken, in a
//   container with no capabilities, no writable rootfs and NO ROUTE OUT — reachable only from the
//   learner's attacker container on a per-run internal bridge, and destroyed with it.
//
//   It must never be published, never be reused as a starting point for anything, and never be
//   deployed anywhere but a lab network. `buildTargetArgs()` in sandbox.ts is what enforces that;
//   this comment is what stops somebody copying the file.
//
// The flaw is CLASSIC COMMAND INJECTION, chosen because it is the exact shape the Cyber course
// teaches — "any time untrusted text becomes part of an instruction, ask what the parser will do
// with it" — and because it recurs beyond shells, in SQL, LDAP, templates and now prompts.
const http = require("node:http");
const { execSync } = require("node:child_process");
const fs = require("node:fs");

const FLAG_PATH = "/opt/flag.txt";

const page = `<!doctype html><title>NetTools</title>
<h1>NetTools</h1>
<p>Diagnostics for the ops team.</p>
<form action="/ping"><input name="host" value="127.0.0.1"><button>Ping</button></form>
<p><small>v1.4.2 — internal use only</small></p>`;

http.createServer((req, res) => {
  const url = new URL(req.url, "http://target");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page);
  }
  if (url.pathname === "/ping") {
    const host = url.searchParams.get("host") || "127.0.0.1";
    let out;
    try {
      // ── THE VULNERABILITY ──
      // User input concatenated into a shell command. Parameterisation would be
      // execFileSync("ping", ["-c", "1", host]) — the value never reaches a parser that can be
      // steered. This is the line the exercise is about.
      out = execSync(`ping -c 1 ${host} 2>&1`, { timeout: 4000 }).toString();
    } catch (e) {
      out = String((e && e.stdout) || (e && e.message) || e);
    }
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(out);
  }
  // The flag is NOT served. It is on disk, readable only by making the box do something it was
  // not asked to do.
  if (url.pathname === "/flag" || url.pathname === "/flag.txt") {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("nice try\n");
  }
  res.writeHead(404).end("not found\n");
}).listen(8080, "0.0.0.0", () => console.log("nettools listening on 8080"));

if (!fs.existsSync(FLAG_PATH)) console.error("warning: no flag file present");
