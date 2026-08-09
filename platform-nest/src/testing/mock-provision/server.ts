// PRV-00 — Mock provision service for CI testing. A test-harness fixture (never deployed).
// Implements the exact contract specified in `docs/blueprints/provision-erp-seam-design.md` §04.
//
// This server lives OUTSIDE the webdev module (like vendor-sandbox) so the module's egress guard
// (if one is added) keeps holding. It listens on 127.0.0.1 at an ephemeral port (:0), started
// in beforeAll and torn down in afterAll. State is per-instance (closure), not module-scoped.
//
// Endpoints implemented:
// - POST /api/users/login {email,password} → {token}
// - POST /api/provision {devName,name,framework} → 202 {id} | 400 | 401 | 409
// - GET  /api/projects/:id → {status,repoUrl,stagingUrl,...}
// - GET  /api/projects?where[name][equals]=<slug> → find-by-name
//
// Scriptable behaviours:
// - successful provision (202 → status progression: pending → provisioned → live)
// - 409 conflict where existing project IS ours (adopt)
// - 409 conflict where existing project is NOT ours (refuse)
// - stuck-pending (never transitions, for timeout testing)
// - auth failures
//
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { successProvisionResponse } from "./fixtures/success-provision";
import { projectStatusResponse } from "./fixtures/project-status";

export interface ProvisionMockConfig {
  /** Expected login email (e.g., "erp-service@gaiada.com") */
  serviceEmail: string;
  /** Expected login password */
  servicePassword: string;
}

export interface ProvisionMockProject {
  id: string;
  name: string;
  repoUrl: string;
  stagingUrl: string;
  /** Current status. Scriptable per test via progressStatus(). */
  status: "pending" | "provisioned" | "live" | "failed";
  /** True if this project was created by our mock (us); false if it belongs to another client.
   *  Used for the 409 adopt-only-if-ours test. */
  isOurs: boolean;
}

export interface ProvisionMock {
  origin: string;

  /** Get the total HTTP requests received since start or resetHitCounts(). */
  totalHits(): number;

  /** Get requests received for one logical route, e.g. "login" or "provision" or "projects:by-id". */
  hitCount(route: string): number;

  /** Clear hit counts. */
  resetHitCounts(): void;

  /**
   * Pre-seed a project that will exist in the provision database (for conflict testing).
   * E.g., seedProject({ id: 'proj-1', name: 'my-site', isOurs: true, status: 'live' })
   * will make GET /api/projects?where[name][equals]=my-site return that project.
   */
  seedProject(project: ProvisionMockProject): void;

  /**
   * Advance a project's status for the next poll. Calls to GET /api/projects/:id will return
   * the current status. E.g., after provision creates a project as "pending", a test can call
   * progressStatus(projectId) before polling to simulate the status moving to "provisioned".
   */
  progressStatus(projectId: string, toStatus: "pending" | "provisioned" | "live" | "failed"): void;

  /**
   * Mark a project to never change status (for poll_timeout testing). Subsequent GETs will always
   * return the current status, even if progressStatus is called.
   */
  setStuck(projectId: string, stuck: boolean): void;

  /** Tear down the server. */
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseBearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Deterministic (djb2) UUID-like string for a project ID, derived from the slug. */
function projectIdFor(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (h * 33) ^ name.charCodeAt(i);
  return `proj-${(h >>> 0).toString(16)}`;
}

/** Derive repo URL from project name (matches provision's GitHub org). */
function repoUrlFor(name: string): string {
  return `https://github.com/Gaia-Digital-Agency/${name}`;
}

/** Derive staging URL from project name. */
function stagingUrlFor(name: string): string {
  return `https://${name}.gaiada.online`;
}

export async function startMockProvision(config: ProvisionMockConfig): Promise<ProvisionMock> {
  // Mutable state, per-instance (closed over by request handlers).
  const projects = new Map<string, ProvisionMockProject>();
  const stuckProjects = new Set<string>();
  const hits = new Map<string, number>();
  const jwtToken = `mock-jwt-${Date.now()}`;

  function bump(route: string): void {
    hits.set(route, (hits.get(route) ?? 0) + 1);
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    bump("login");
    const body = parseJsonBody(await readBody(req));
    const email = (body as Record<string, unknown>)?.email;
    const password = (body as Record<string, unknown>)?.password;

    if (email !== config.serviceEmail || password !== config.servicePassword) {
      sendJson(res, 401, { errors: [{ message: "Invalid email or password" }] });
      return;
    }

    sendJson(res, 200, { token: jwtToken });
  }

  async function handleProvision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    bump("provision");

    // Auth check: Bearer token must match the one we issued.
    const token = parseBearer(req.headers.authorization);
    if (!token || token !== jwtToken) {
      sendJson(res, 401, { errors: [{ message: "Unauthorized" }] });
      return;
    }

    const body = parseJsonBody(await readBody(req));
    const name = (body as Record<string, unknown>)?.name as string | undefined;
    const framework = (body as Record<string, unknown>)?.framework as string | undefined;
    const devName = (body as Record<string, unknown>)?.devName as string | undefined;

    // Validate required fields.
    if (!name || typeof name !== "string" || name.length === 0) {
      sendJson(res, 400, { errors: [{ message: "Invalid Field: 'name' is required." }] });
      return;
    }

    if (!framework || !["vite", "nextjs"].includes(framework)) {
      sendJson(res, 400, { errors: [{ message: "Invalid Field: 'framework' must be 'vite' or 'nextjs'." }] });
      return;
    }

    // Check if a project with this name already exists.
    const existing = Array.from(projects.values()).find((p) => p.name === name);
    if (existing) {
      // Provision's contract: return 409 and rely on the caller to check if it's ours.
      sendJson(res, 409, {
        errors: [{ message: "Project with this name already exists" }],
        doc: {
          id: existing.id,
          name: existing.name,
          status: existing.status,
          repoUrl: existing.repoUrl,
          stagingUrl: existing.stagingUrl,
          isOurs: existing.isOurs,
        },
      });
      return;
    }

    // Create the project.
    const projectId = projectIdFor(name);
    const project: ProvisionMockProject = {
      id: projectId,
      name,
      repoUrl: repoUrlFor(name),
      stagingUrl: stagingUrlFor(name),
      status: "pending",
      isOurs: true,
    };
    projects.set(projectId, project);

    // Return 202 with the created project.
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify(successProvisionResponse({ projectId, name, repoUrl: project.repoUrl, stagingUrl: project.stagingUrl })));
  }

  async function handleGetProject(req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> {
    bump("projects:by-id");

    // Auth check.
    const token = parseBearer(req.headers.authorization);
    if (!token || token !== jwtToken) {
      sendJson(res, 401, { errors: [{ message: "Unauthorized" }] });
      return;
    }

    const project = projects.get(projectId);
    if (!project) {
      sendJson(res, 404, { errors: [{ message: "Not Found" }] });
      return;
    }

    // Return the project's current status.
    sendJson(res, 200, projectStatusResponse({
      projectId: project.id,
      name: project.name,
      status: project.status,
      repoUrl: project.repoUrl,
      stagingUrl: project.stagingUrl,
    }));
  }

  async function handleFindProjectByName(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    bump("projects:by-name");

    // Auth check.
    const token = parseBearer(req.headers.authorization);
    if (!token || token !== jwtToken) {
      sendJson(res, 401, { errors: [{ message: "Unauthorized" }] });
      return;
    }

    const project = Array.from(projects.values()).find((p) => p.name === name);
    if (!project) {
      sendJson(res, 200, { docs: [] });
      return;
    }

    sendJson(res, 200, { docs: [projectStatusResponse({
      projectId: project.id,
      name: project.name,
      status: project.status,
      repoUrl: project.repoUrl,
      stagingUrl: project.stagingUrl,
    })] });
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock-provision.invalid");
    const method = req.method ?? "GET";

    bump("__all__");

    // Route dispatch.
    if (method === "POST" && url.pathname === "/api/users/login") {
      handleLogin(req, res).catch((err: Error) => {
        sendJson(res, 500, { error: `Mock provision internal error: ${err.message}` });
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/provision") {
      handleProvision(req, res).catch((err: Error) => {
        sendJson(res, 500, { error: `Mock provision internal error: ${err.message}` });
      });
      return;
    }

    const getProjectMatch = /^\/api\/projects\/(.+)$/.exec(url.pathname);
    if (method === "GET" && getProjectMatch) {
      const projectId = decodeURIComponent(getProjectMatch[1]);
      handleGetProject(req, res, projectId).catch((err: Error) => {
        sendJson(res, 500, { error: `Mock provision internal error: ${err.message}` });
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/projects") {
      const nameParam = url.searchParams.get("where[name][equals]");
      if (nameParam) {
        handleFindProjectByName(req, res, nameParam).catch((err: Error) => {
          sendJson(res, 500, { error: `Mock provision internal error: ${err.message}` });
        });
        return;
      }
      sendJson(res, 200, { docs: [] });
      return;
    }

    // Unknown path.
    bump("unknown_path");
    sendJson(res, 404, { error: "Not Found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    totalHits: () => hits.get("__all__") ?? 0,
    hitCount: (route: string) => hits.get(route) ?? 0,
    resetHitCounts: () => hits.clear(),
    seedProject: (project: ProvisionMockProject) => projects.set(project.id, project),
    progressStatus: (projectId: string, toStatus: "pending" | "provisioned" | "live" | "failed") => {
      const proj = projects.get(projectId);
      if (proj && !stuckProjects.has(projectId)) {
        proj.status = toStatus;
      }
    },
    setStuck: (projectId: string, stuck: boolean) => {
      if (stuck) {
        stuckProjects.add(projectId);
      } else {
        stuckProjects.delete(projectId);
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
