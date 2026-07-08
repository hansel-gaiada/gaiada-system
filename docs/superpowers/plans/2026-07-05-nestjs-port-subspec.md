# NestJS Port — Sub-Spec (P5c fidelity migration)

> Discipline note: like the sync engine, the NestJS port is a **high-churn, zero-behaviour-
> change** migration, so it gets a sub-spec FIRST. The goal is a *mechanical, contract-parity*
> port — the HTTP surface `platform-ui` and mcp-hub speak must not change by a single byte.
> This document makes the port executable module-by-module with a green bar at every step.

## STATUS (2026-07-05): ✅ DONE — Fastify retired
The port is complete. `platform-nest/` is the platform: all 16 suites (92 tests) pass on
NestJS+Fastify-adapter against live PG+Cerbos; `platform/` (Fastify) is deleted; the compose
`platform` service, cerbos mounts, and `test-all.sh` point at `platform-nest`; it builds via
`tsc` → `node dist/main.js` (emits the decorator metadata DI needs) with a multi-stage
Dockerfile. Parity notes captured in code: `HttpErrorFilter` reproduces the `{error: msg}`
body; `@HttpCode(200)` on non-create POSTs; module routes → NestJS module + `ModuleEnabledGuard`;
vitest+unplugin-swc for decorator metadata in tests. The service name/URL/DB name are unchanged,
so `platform-ui` + bot + hub (HTTP clients) needed no change.

## DECISION (2026-07-05): execute NOW
The user chose to port **now, before more core work** — the platform core is feature-complete
for first-deploy (5c.2–5c.8), so nothing further is built on Fastify to re-port later. This is
the zero-redundancy path: NestJS is the spec backend (`ws1-architecture` §Backend), Fastify was
the v1-lite stand-in, and the port is a cutover (retire Fastify), never a parallel stack.
Companion decision: the **ai-gateway is rewritten in Go** (spec lists it under Go edge services);
blocked in this environment until the Go toolchain is installed — tracked separately.

## Why it was deferred (and the bar to un-defer)
The Fastify core is **behaviour-complete to spec** (RLS/D5, Cerbos, ModuleContract, D4/D11/
D12/D16/D17, the full agency vertical, teams). A port delivers **no first-deploy capability** —
it is a fidelity/maintainability move (NestJS DI + decorators + the spec-locked structure).
Un-defer when: (a) first deploy is stable, and (b) a dedicated block exists to port + re-verify
in one sweep (a half-port with two frameworks live is the failure mode to avoid).

## Invariants the port MUST preserve (parity gate)
1. **Identical HTTP contract** — every path, method, status code, request/response body.
   The existing suites (86 platform tests) are the parity oracle; they must pass **unchanged**
   against the NestJS app. Add a thin `buildServer()`-equivalent so the same `inject`-style
   tests run (Nest's `Test.createTestingModule` + `supertest`, or keep Fastify adapter).
2. **RLS discipline (D5)** — every query still runs inside `withTenants([...])` /`withGlobal`.
   The DB layer (`src/db`) ports **as-is** (it's framework-agnostic). No ORM that hides the
   `set_config('app.current_tenant_ids', …)` transaction wrapper.
3. **Cerbos gate (D11/D16)** — `authorize()` and `check()/planResources()` port unchanged;
   they become a Nest `Guard` + a `CerbosService`, but the wire calls are identical.
4. **ModuleContract (§1.3)** — modules still `import` core, core NEVER imports a module. The
   lint rule below enforces it mechanically.

## Construct mapping (Fastify → NestJS)
| Fastify (today) | NestJS (target) |
|---|---|
| `buildServer()` returns a `FastifyInstance` | `AppModule` + `NestFactory.create(AppModule, new FastifyAdapter())` — **keep the Fastify adapter** so perf + `inject` testing survive |
| `app.register(async (api)=>{…}, {prefix:"/api"})` | `@Module` with controllers under a global `/api` prefix (`app.setGlobalPrefix('api')`) |
| `authenticate` preHandler hook | `AuthGuard` (global `APP_GUARD`) that populates `req.principal` |
| `authorize(req, reply, resource, action)` | `CerbosService.authorize()` called in the controller, or a `@Authorize(kind, action)` method decorator + interceptor |
| per-route handlers (`api.get/post/...`) | `@Controller`/`@Get`/`@Post` methods; body/params via `@Body()`/`@Param()` DTOs |
| `registerClientWorkRoutes(api)` etc. (core route fns) | `ClientWorkController`, `CollabController`, `FilesController`, `TeamsController`, `CustomFieldsController`, `RollupsController`, `IdentityController`, `AdminController` |
| module `routes:(scope)=>{…}` + enable-gate hook | each module is a Nest `DynamicModule`; the per-tenant enable gate becomes a `ModuleEnabledGuard` on the module's controller (prefix `/:tenantId/modules/<key>`) |
| `registerCoreRollupProvider` / `allModules()` | a `ModuleRegistry` provider (DI singleton) — same registration, now injectable |
| `core/http.ts` `writeActivity`/`notify` | `ActivityService` / `NotificationService` (thin, same SQL) |
| `config` object | `ConfigModule` (or keep the plain object — it's fine) |

## Staged order (each stage ends green)
0. **Scaffold** `platform-nest/` as a SEPARATE project (do NOT edit `platform/`). Bring the
   framework-agnostic layers over by import/copy: `db/`, `rbac/` (principal, cerbos), `core/http`,
   `core/custom-fields` (validator), `core/scrub`, `core/storage`, `rollups/engine`, `modules/`
   (contract + registry + agency). These have **no Fastify dependency** and move verbatim.
1. **Auth + health** — `AppModule`, `AuthGuard`, `/health`, `/principal/resolve`. Port the
   auth test first; green.
2. **Core read paths** — companies, `/me`, activity, tasks/projects list + detail. Green vs the
   existing read tests.
3. **Core write paths** — projects/tasks CRUD, client-work, collab, files, teams, custom-fields.
   Reuse the existing suites file-by-file as the parity oracle.
4. **Rollups + modules** — rollup recompute/read; the agency module as a `DynamicModule`;
   enable-gate guard. Run `agency.test.ts` + `agency-first-deploy.e2e.test.ts` unchanged.
5. **Cutover** — point `platform-ui`'s `PLATFORM_URL` and the compose `platform` service at
   `platform-nest`; delete `platform/` only after a full green sweep + a soak.

## The dependency lint rule (core-not-imports-module)
Add an ESLint `no-restricted-imports` (or a tiny custom rule) forbidding any import from
`src/modules/<key>/…` inside `src/core/**`, `src/rbac/**`, `src/db/**`, `src/rollups/**`.
CI-fail on violation. This is the machine-checkable form of §1.3.

## Risk register
- **Hidden Fastify coupling** — `req.principal` augmentation, `reply.code().send()`. Mitigation:
  the AuthGuard sets `req.principal`; controllers return DTOs / throw `HttpException` (Nest maps
  status). Grep for `reply.` before declaring a controller done.
- **Two frameworks live** — highest risk. Mitigation: separate project + cutover only at stage 5.
- **Test harness** — Nest+Fastify adapter keeps `app.inject`; if switching to supertest, port the
  ~15 test files' request helper once (a shared `as(uid)` + `inject` shim), not per-test.
- **DTO validation drift** — keep the current hand-rolled 400s initially (don't introduce
  `class-validator` in the same PR) to hold behaviour identical; tighten later.

## Effort estimate
~1 focused block: stage 0–1 (½), stages 2–4 (1 each, gated by the existing suites), stage 5
cutover (½). No new tests needed — the 86 existing platform tests are the acceptance gate.
