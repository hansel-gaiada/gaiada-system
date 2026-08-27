// WSK-29 — the package's own tiny HTTP front, so mcp-hub can reach it the way it reaches every
// other service in this estate (an HTTP call with a shared bearer token — see
// mcp-hub/src/config.ts's platformUrl/agentRunnerUrl/knowledgeUrl for the identical shape), never
// as an imported package. Root CLAUDE.md's non-negotiable: "Components stay separate projects. No
// monorepo, no shared package layer." — so mcp-hub/src/webdesk-deploy-tools.ts talks to this
// process over HTTP, exactly like it talks to the platform or the agent runner.
//
// DELIBERATELY EXPOSES ONLY /probe, NEVER /deploy. `deploy()` is real (ssh-rsync-driver.ts) but a
// mutating, irreversible-ish action belongs behind Cerbos + the WS4 always-suspend gate
// (resource_mcp_tool.yaml's ALWAYS_WS4_TOOLS set) — the SAME authority every other webdesk write
// tool answers to (see WSK-31's own header on webdesk-control.controller.ts). This process has no
// Cerbos client and no principal model, so it must not be the thing a network caller can invoke to
// actually change a live host. `/probe` is safe to expose broadly: read-only, no PII, and its
// worst failure mode is a wrong "unreachable" — never a wrong "deployed".
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getDriver } from "./index";
import type { DeployTarget, FrontendDeployDriver } from "./types";

const PORT = Number(process.env.WEBDESK_DEPLOY_PORT ?? 3210);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authorized(req: http.IncomingMessage, serviceToken: string): boolean {
  if (!serviceToken) return false; // fail-closed: an unset token means NOBODY is authorized, not "anyone is"
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(presented, serviceToken);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handle(
  driver: FrontendDeployDriver,
  serviceToken: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, serviceTokenConfigured: serviceToken !== "" }));
    return;
  }
  if (req.method === "POST" && req.url === "/probe") {
    if (!authorized(req, serviceToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let target: unknown;
    try {
      target = (JSON.parse((await readBody(req)) || "{}") as { target?: unknown }).target;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
    if (target !== "staging" && target !== "production") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'target must be "staging" or "production"' }));
      return;
    }
    const result = await driver.probe(target as DeployTarget);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

/** Factory, not a module-scope singleton — tests inject a fake FrontendDeployDriver so the HTTP
 *  layer's own logic (auth, method/path routing, body validation, status codes) is provable
 *  without ever spawning `ssh`. The process entrypoint at the bottom of this file wires the real
 *  one via getDriver(). */
export function createServer(driver: FrontendDeployDriver, serviceToken = process.env.WEBDESK_DEPLOY_SERVICE_TOKEN ?? ""): http.Server {
  return http.createServer((req, res) => {
    handle(driver, serviceToken, req, res).catch((err: unknown) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error", message: String(err) }));
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer(getDriver());
  server.listen(PORT, () => {
    console.log(`[webdesk-deploy] listening on :${PORT} (POST /probe, GET /healthz)`);
  });
}
