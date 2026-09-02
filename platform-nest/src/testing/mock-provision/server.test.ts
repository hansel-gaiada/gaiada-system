// PRV-00 — Mock provision service tests. Each test exercises a behaviour the ERP provisioning
// service (PRV-02) must handle over a real socket:
// - successful provision (202 → status progression: pending → provisioned → live)
// - 409 conflict where existing project IS ours (adopt, find-by-name + id linkage)
// - 409 conflict where existing project is NOT ours (refuse with slug_conflict_foreign)
// - stuck-pending (never changes, for poll_timeout testing)
// - auth failures and request validation
//
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startMockProvision } from "./server";

const SERVICE_EMAIL = "erp-service@gaiada.com";
const SERVICE_PASSWORD = "MockServicePassword123";

describe("PRV-00 — Mock provision service", () => {
  let mock: Awaited<ReturnType<typeof startMockProvision>>;

  beforeAll(async () => {
    mock = await startMockProvision({ serviceEmail: SERVICE_EMAIL, servicePassword: SERVICE_PASSWORD });
  });

  afterAll(async () => {
    await mock.close();
  });

  describe("authentication", () => {
    it("POST /api/users/login returns JWT token on valid credentials", async () => {
      const res = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.token).toBeDefined();
      expect(typeof data.token).toBe("string");
    });

    it("POST /api/users/login returns 401 on invalid email", async () => {
      const res = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "wrong@gaiada.com", password: SERVICE_PASSWORD }),
      });

      expect(res.status).toBe(401);
    });

    it("POST /api/users/login returns 401 on invalid password", async () => {
      const res = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: "wrongpassword" }),
      });

      expect(res.status).toBe(401);
    });

    it("POST /api/provision returns 401 without Bearer token", async () => {
      const res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-site", framework: "vite", devName: "Test User" }),
      });

      expect(res.status).toBe(401);
    });

    it("POST /api/provision returns 401 with invalid Bearer token", async () => {
      const res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer invalid-token",
        },
        body: JSON.stringify({ name: "test-site", framework: "vite", devName: "Test User" }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("successful provision flow", () => {
    it("POST /api/provision returns 202 with project id and details", async () => {
      // First, log in to get a token.
      const loginRes = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });
      const { token } = await loginRes.json();

      // Provision a site.
      const provisionRes = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "my-site", framework: "vite", devName: "Test User" }),
      });

      expect(provisionRes.status).toBe(202);
      const project = await provisionRes.json();
      expect(project.id).toBeDefined();
      expect(project.name).toBe("my-site");
      expect(project.status).toBe("pending");
      expect(project.repoUrl).toContain("gaiadabali");
      expect(project.repoUrl).toContain("my-site");
      expect(project.stagingUrl).toBe("https://my-site.gaiada.online");
    });

    it("GET /api/projects/:id returns current status", async () => {
      // Log in.
      const loginRes = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });
      const { token } = await loginRes.json();

      // Provision a site.
      const provisionRes = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "status-test-site", framework: "nextjs", devName: "Test User" }),
      });

      const { id: projectId } = await provisionRes.json();

      // Poll the status and watch it progress.
      const statusRes = await fetch(`${mock.origin}/api/projects/${projectId}`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(statusRes.status).toBe(200);
      const status = await statusRes.json();
      expect(status.status).toBe("pending");
      expect(status.id).toBe(projectId);
      expect(status.repoUrl).toBeDefined();
      expect(status.stagingUrl).toBeDefined();
    });

    it("status progresses from pending → provisioned → live", async () => {
      // Log in.
      const loginRes = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });
      const { token } = await loginRes.json();

      // Provision a site.
      const provisionRes = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "progress-test", framework: "vite", devName: "Test User" }),
      });

      const { id: projectId } = await provisionRes.json();

      // Initial status: pending.
      let res = await fetch(`${mock.origin}/api/projects/${projectId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      let status = await res.json();
      expect(status.status).toBe("pending");

      // Progress to provisioned.
      mock.progressStatus(projectId, "provisioned");
      res = await fetch(`${mock.origin}/api/projects/${projectId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      status = await res.json();
      expect(status.status).toBe("provisioned");

      // Progress to live.
      mock.progressStatus(projectId, "live");
      res = await fetch(`${mock.origin}/api/projects/${projectId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      status = await res.json();
      expect(status.status).toBe("live");
    });
  });

  describe("request validation", () => {
    let token: string;

    beforeAll(async () => {
      const res = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });
      const data = await res.json();
      token = data.token;
    });

    it("POST /api/provision returns 400 when 'name' is missing", async () => {
      const res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ framework: "vite", devName: "Test User" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.errors?.[0]?.message).toContain("name");
    });

    it("POST /api/provision returns 400 when 'framework' is invalid", async () => {
      const res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "test-site", framework: "gatsby", devName: "Test User" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.errors?.[0]?.message).toContain("framework");
    });

    it("POST /api/provision returns 400 when 'framework' is missing", async () => {
      const res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "test-site", devName: "Test User" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.errors?.[0]?.message).toContain("framework");
    });
  });

  describe("conflict handling (409)", () => {
    let token: string;

    beforeAll(async () => {
      const res = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });
      const data = await res.json();
      token = data.token;
    });

    it("409 conflict when project name already exists", async () => {
      // Create the first project.
      let res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "collision-test", framework: "vite", devName: "Test User" }),
      });
      expect(res.status).toBe(202);
      const first = await res.json();

      // Try to create a second project with the same name.
      res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "collision-test", framework: "nextjs", devName: "Test User" }),
      });

      expect(res.status).toBe(409);
      const conflict = await res.json();
      expect(conflict.errors?.[0]?.message).toContain("already exists");
      expect(conflict.doc).toBeDefined();
      expect(conflict.doc.id).toBe(first.id);
      expect(conflict.doc.name).toBe("collision-test");
    });

    it("409 response includes isOurs flag for adoption check", async () => {
      // Seed a foreign project (isOurs = false).
      const foreignProjectId = "proj-foreign-12345";
      mock.seedProject({
        id: foreignProjectId,
        name: "foreign-site",
        repoUrl: "https://github.com/gaiadabali/foreign-site",
        stagingUrl: "https://foreign-site.gaiada.online",
        status: "live",
        isOurs: false,
      });

      // Try to provision with that name.
      const res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "foreign-site", framework: "vite", devName: "Test User" }),
      });

      expect(res.status).toBe(409);
      const conflict = await res.json();
      expect(conflict.doc.isOurs).toBe(false);
    });

    it("409 response on our own project has isOurs = true", async () => {
      // Create a project.
      let res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "our-site", framework: "vite", devName: "Test User" }),
      });
      expect(res.status).toBe(202);
      const first = await res.json();

      // Immediately try again with the same name.
      res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "our-site", framework: "vite", devName: "Test User" }),
      });

      expect(res.status).toBe(409);
      const conflict = await res.json();
      expect(conflict.doc.isOurs).toBe(true);
    });

    it("find-by-name endpoint finds seeded projects", async () => {
      // Seed a project.
      const seedId = "proj-seed-98765";
      mock.seedProject({
        id: seedId,
        name: "seeded-site",
        repoUrl: "https://github.com/gaiadabali/seeded-site",
        stagingUrl: "https://seeded-site.gaiada.online",
        status: "live",
        isOurs: true,
      });

      // Find it by name.
      const res = await fetch(
        `${mock.origin}/api/projects?where[name][equals]=seeded-site`,
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.docs)).toBe(true);
      expect(data.docs.length).toBeGreaterThan(0);
      const found = data.docs.find((d: { name: string }) => d.name === "seeded-site");
      expect(found).toBeDefined();
      expect(found.id).toBe(seedId);
      expect(found.status).toBe("live");
    });
  });

  describe("stuck/timeout scenario", () => {
    let token: string;

    beforeAll(async () => {
      const res = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });
      const data = await res.json();
      token = data.token;
    });

    it("setStuck prevents status from changing", async () => {
      // Create a project.
      let res = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "stuck-test", framework: "vite", devName: "Test User" }),
      });
      expect(res.status).toBe(202);
      const { id: projectId } = await res.json();

      // Mark it as stuck.
      mock.setStuck(projectId, true);

      // Try to progress the status.
      mock.progressStatus(projectId, "provisioned");

      // Status should still be pending.
      res = await fetch(`${mock.origin}/api/projects/${projectId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const status = await res.json();
      expect(status.status).toBe("pending");
    });
  });

  describe("hit counting", () => {
    it("hit counts track request routes", async () => {
      mock.resetHitCounts();

      const loginRes = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });
      const { token } = await loginRes.json();

      // Make a few requests and check hit counts.
      expect(mock.hitCount("login")).toBeGreaterThan(0);

      const provisionRes = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "hit-test", framework: "vite", devName: "Test User" }),
      });
      expect(provisionRes.status).toBe(202);
      expect(mock.hitCount("provision")).toBeGreaterThan(0);

      const { id: projectId } = await provisionRes.json();

      await fetch(`${mock.origin}/api/projects/${projectId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(mock.hitCount("projects:by-id")).toBeGreaterThan(0);
    });
  });

  describe("complete flow (smoke test)", () => {
    it("end-to-end: login → provision → poll status → find by name", async () => {
      // 1. Log in.
      const loginRes = await fetch(`${mock.origin}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
      });
      expect(loginRes.status).toBe(200);
      const { token } = await loginRes.json();

      // 2. Provision a site.
      const provisionRes = await fetch(`${mock.origin}/api/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "complete-flow", framework: "vite", devName: "Test Requestor" }),
      });
      expect(provisionRes.status).toBe(202);
      const project = await provisionRes.json();
      expect(project.id).toBeDefined();
      expect(project.name).toBe("complete-flow");
      expect(project.status).toBe("pending");

      // 3. Poll the status a few times.
      for (const targetStatus of ["pending", "provisioned", "live"]) {
        if (targetStatus !== "pending") {
          mock.progressStatus(project.id, targetStatus as any);
        }

        const statusRes = await fetch(`${mock.origin}/api/projects/${project.id}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(statusRes.status).toBe(200);
        const currentStatus = await statusRes.json();
        expect(currentStatus.status).toBe(targetStatus);
      }

      // 4. Find the project by name.
      const findRes = await fetch(
        `${mock.origin}/api/projects?where[name][equals]=complete-flow`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(findRes.status).toBe(200);
      const found = await findRes.json();
      expect(found.docs.length).toBeGreaterThan(0);
      expect(found.docs[0].name).toBe("complete-flow");
      expect(found.docs[0].status).toBe("live");
      expect(found.docs[0].repoUrl).toContain("gaiadabali/complete-flow");
      expect(found.docs[0].stagingUrl).toBe("https://complete-flow.gaiada.online");
    });
  });
});
