# PRV-00 — Mock Provision Service

A test-harness fixture implementing the exact contract specified in `docs/blueprints/provision-erp-seam-design.md` §04.

## Purpose

The mock provision service allows PRV-02 (webdev provisioning service) and subsequent tickets to be built and CI-tested without touching the live `provision` service on gda-s01. It speaks exactly the shapes the design specifies:

- `POST /api/users/login {email,password}` → `{token}`
- `POST /api/provision {devName,name,framework}` → `202 {id} | 400 | 401 | 409`
- `GET /api/projects/:id` → `{status,repoUrl,stagingUrl,...}`
- `GET /api/projects?where[name][equals]=<slug>` → find-by-name (for 409 reconcile)

## Design Notes

### Not Deployed

This server is a **test fixture only**. It:
- Listens on `127.0.0.1` at an ephemeral port (`:0`)
- Starts in `beforeAll`, stops in `afterAll`
- Lives outside `src/modules/` (like `vendor-sandbox/`) so module egress guards apply
- Maintains per-instance mutable state in closure, never module-scoped singletons

### Fixture Files Marked

Every fixture response is authored from `provision-erp-seam-design.md` (not vendor-captured). Each fixture file carries the marker:

```
UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-08-08; superseded by PRV-02 live recordings
```

See `fixtures.test.ts` for the test that enforces this (all fixture files must carry the marker).

## Usage

### Starting the Mock

```typescript
import { startMockProvision } from "src/testing/mock-provision";

let mock: ProvisionMock;

beforeAll(async () => {
  mock = await startMockProvision({
    serviceEmail: "erp-service@gaiada.com",
    servicePassword: "MockServicePassword123",
  });
});

afterAll(async () => {
  await mock.close();
});
```

### Login and Provision

```typescript
// Log in to get a token
const loginRes = await fetch(`${mock.origin}/api/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "erp-service@gaiada.com",
    password: "MockServicePassword123",
  }),
});
const { token } = await loginRes.json();

// Provision a site
const provisionRes = await fetch(`${mock.origin}/api/provision`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    name: "my-site",
    framework: "vite", // or "nextjs"
    devName: "Requestor Name",
  }),
});

expect(provisionRes.status).toBe(202);
const { id, status, repoUrl, stagingUrl } = await provisionRes.json();
expect(status).toBe("pending");
```

### Test Scenario: Status Progression

```typescript
// Poll the status and watch it progress: pending → provisioned → live
let statusRes = await fetch(`${mock.origin}/api/projects/${projectId}`, {
  headers: { authorization: `Bearer ${token}` },
});
let project = await statusRes.json();
expect(project.status).toBe("pending");

// Advance the status for the next poll
mock.progressStatus(projectId, "provisioned");
statusRes = await fetch(`${mock.origin}/api/projects/${projectId}`, {
  headers: { authorization: `Bearer ${token}` },
});
project = await statusRes.json();
expect(project.status).toBe("provisioned");
```

### Test Scenario: 409 Conflict (Project IS Ours)

```typescript
// Create a project
const res1 = await fetch(`${mock.origin}/api/provision`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ name: "my-site", framework: "vite", devName: "Test" }),
});
expect(res1.status).toBe(202);
const { id: firstId } = await res1.json();

// Try to create with the same name again
const res2 = await fetch(`${mock.origin}/api/provision`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ name: "my-site", framework: "vite", devName: "Test" }),
});

expect(res2.status).toBe(409);
const conflict = await res2.json();
expect(conflict.doc.id).toBe(firstId); // Same project we created
expect(conflict.doc.isOurs).toBe(true);  // It's ours → adopt only
```

### Test Scenario: 409 Conflict (Project is NOT Ours)

```typescript
// Seed a foreign project (isOurs = false)
mock.seedProject({
  id: "proj-foreign-123",
  name: "foreign-site",
  repoUrl: "https://github.com/gaiadabali/foreign-site",
  stagingUrl: "https://foreign-site.gaiada.online",
  status: "live",
  isOurs: false,
});

// Try to provision with that name
const res = await fetch(`${mock.origin}/api/provision`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ name: "foreign-site", framework: "vite", devName: "Test" }),
});

expect(res.status).toBe(409);
const conflict = await res.json();
expect(conflict.doc.isOurs).toBe(false); // Foreign → refuse
```

### Test Scenario: Stuck / Poll Timeout

```typescript
// Create a project
const res = await fetch(`${mock.origin}/api/provision`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ name: "stuck-site", framework: "vite", devName: "Test" }),
});
const { id: projectId } = await res.json();

// Mark it as stuck (never changes status)
mock.setStuck(projectId, true);

// Try to progress (no-op)
mock.progressStatus(projectId, "provisioned");

// Status is still pending
const statusRes = await fetch(`${mock.origin}/api/projects/${projectId}`, {
  headers: { authorization: `Bearer ${token}` },
});
const status = await statusRes.json();
expect(status.status).toBe("pending"); // Stuck, unchanged
```

### Observability: Hit Counts

```typescript
mock.resetHitCounts();

// ... make some requests ...

expect(mock.hitCount("login")).toBeGreaterThan(0);
expect(mock.hitCount("provision")).toBeGreaterThan(0);
expect(mock.hitCount("projects:by-id")).toBeGreaterThan(0);
expect(mock.hitCount("projects:by-name")).toBeGreaterThan(0);
expect(mock.totalHits()).toBeGreaterThan(0);
```

## API Reference

### `startMockProvision(config: ProvisionMockConfig): Promise<ProvisionMock>`

Start the mock server. Returns a promise that resolves to the mock object.

**Parameters:**
- `config.serviceEmail`: Expected login email (e.g., `"erp-service@gaiada.com"`)
- `config.servicePassword`: Expected login password

**Returns:** `ProvisionMock` object

### `ProvisionMock` Interface

```typescript
interface ProvisionMock {
  /** The origin URL: http://127.0.0.1:<port> */
  origin: string;

  /** Get total requests received since start or resetHitCounts() */
  totalHits(): number;

  /** Get requests for one route (e.g., "login", "provision", "projects:by-id", "projects:by-name") */
  hitCount(route: string): number;

  /** Clear all hit counts */
  resetHitCounts(): void;

  /**
   * Pre-seed a project in the database (for conflict/find-by-name testing).
   * E.g., seedProject({ id: 'proj-123', name: 'foreign-site', isOurs: false, ... })
   */
  seedProject(project: ProvisionMockProject): void;

  /**
   * Advance a project's status for the next poll.
   * toStatus: "pending" | "provisioned" | "live" | "failed"
   */
  progressStatus(projectId: string, toStatus: "pending" | "provisioned" | "live" | "failed"): void;

  /**
   * Mark a project to never change status (for poll timeout testing).
   * stuck=true prevents progressStatus() from taking effect.
   */
  setStuck(projectId: string, stuck: boolean): void;

  /** Tear down the server */
  close(): Promise<void>;
}
```

## Test Coverage

21 tests proving each behaviour over a real socket:

- **Authentication:** login success/failure, Bearer token required/invalid
- **Successful provision:** 202 response, status starts "pending", can progress to "provisioned"/"live"
- **Request validation:** missing name/framework, invalid framework value
- **409 conflicts:** conflict when name exists, isOurs flag for adoption logic, find-by-name
- **Stuck projects:** setStuck() prevents status progression (poll timeout scenario)
- **Observability:** hit counting per route
- **End-to-end smoke test:** login → provision → poll → find-by-name → verify fields

All tests use real HTTP over a socket (not mocked fetch), proving the contract works on the wire.

## Traps & Gotchas

1. **Field names matter:** The fixture function expects `projectId`, not `id`. The server handler must map `project.id → projectId` when calling the fixture.
2. **Auth is per-request:** Every endpoint requires a valid Bearer token (from login). The 202 response uses the same token that login minted.
3. **Status progression is optional:** A test can provision without ever calling `progressStatus()`. Default status stays "pending".
4. **Seeding skips creation:** `seedProject()` pre-populates the database without a provision call. Useful for 409 foreign-conflict tests.
5. **isOurs flag is caller-decided:** When you seed a project, you decide isOurs. The mock doesn't track who created what — PRV-02 does that.

## Related Docs

- `docs/blueprints/provision-erp-seam-design.md` — the contract this mock implements (§04)
- `PRV-02` ticket — the webdev provisioning service that uses this mock in CI
- `platform-nest/src/testing/vendor-sandbox/` — the precedent pattern (search vendors mock)
