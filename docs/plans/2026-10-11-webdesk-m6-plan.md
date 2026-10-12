# WebDesk M6 · platform phases after the proof — plan, tickets and open decisions

**Started:** 2026-10-11 · **Board:** `TASKS.md` (outer folder), section *M6 · WebDesk platform phases after the
proof* · **Design:** `docs/blueprints/webdesk-design-v2.md` §04, §06–§09, §12 (P3–P6), §13 · **Rulings:** WSK-D28–D36,
WSK-D50 · **Branches:** `webdesk/m6-start` (first batch, on main `f6e39a83`, LIVE in v1.0.0-alpha.362), `webdesk/m6-batch2`, `webdesk/m6-batch3` (merged to main with this plan's batch-3 state)

Status words are the estate's: PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED (driven on a Linux server, result
observed). Ticket ids (`M6-P3a` and so on) are local to this plan.

**This repository is public.** Client domains, host addresses and registry rows go in gitignored `*.local.md` files on
the operator laptop. This file carries counts and results only.

## 1 · Where each phase stands

Read from `origin/main` at `f53a5fa7` on 2026-10-11. Nothing in this section was driven live; §3's first ticket
measures the live side.

### P3 · Portfolio — mostly in code; the live side is unmeasured

| Item | In code | Gap |
|---|---|---|
| SM-70 Nexus importer | `platform-nest/src/seed/nexus-import.ts`, run by hand (`npm run import:nexus`) | Never sets `verified_at`, so imported rows are never probed (by design: an import is a lead, not consent) |
| SM-74 hosting topology | `202608300818_sm74_property_hosting_topology.sql` (provider, control panel, stack, plugin surface) | Unknown whether any row carries data |
| `webdev_sites` registry | `modules/webdev/site-registry.service.ts`, `portfolio-reads.service.ts`; console at `departments/[deptId]/sites/portfolio` | No `webdev_site` Cerbos kind: the registry routes borrow `webdev_provisioned_site`'s `provision`/`operate` actions |
| WSK-D35 domain key | `202609040149_search_properties_domain_key.sql` | — |
| WSK-D36 sentinel internal client | — | Not in code. M5 already owns it as **M5-G0**; M6 depends on it and does not duplicate it |
| MON-01 probes | `infra/observability/scripts/gen-client-property-targets.mjs` (verified rows only, private ranges refused), `infra/scripts/sync-client-property-targets.sh`, the `client-properties` job in `prometheus.remote.yml` | **Measured 2026-10-11: probes nothing.** The `client-properties` job is configured on `sumopod`, but its target file has been `[]` since 2026-09-01 and there are zero series. `gda-aicenter` has no sync cron or timer |
| MON-04 dashboard | — | No "Client Properties" dashboard in `infra/observability/grafana/dashboards/` |
| Credential vault (D33) | VLT-1 hosting providers, VLT-6 lifecycle, reveal approvals | — |

Two monitoring paths run side by side and nothing links them: the in-app `monitoring` module (its own `monitors`
rows; 18 sites we host, live since 2026-09-01) and MON-01's blackbox job (generated from `search_properties`). M6
keeps both: blackbox for the client estate, the in-app module for sites we host. MON-04 shows MON-01.

### P4 · Repo control — the repo shell works; everything inside and after it does not

In code:
- **The four refusals are lifted (WSK-D28):**
  - the CHECK (`202609011230_webdev_provisioned_sites_framework_widen.sql`);
  - the tool's `framework` enum;
  - `STACK_TO_FRAMEWORK`, which makes the stack hint a selector;
  - `code.scaffold`, which accepts `astro`, `node` and `wp`.
- **The repo shell.** `ErpRepoControlProvider` files a GH-12 D14 approval. The `generate` call runs once, on approval
  (`core/github/repo-creation.ts`).
- **Carried from `provision`:** idempotency and crash-resume, and the `prd_sign` asymmetry
  (`evaluateProvisionPrecondition`).
- **`github.createRepo` stays fail-closed for good.**
- **`code.scaffold` v2** exists as a library (`ai-agents/src/code-scaffold/`) and emits `CONTRACT.lock`.
- **Artifact bytes** for pipeline stages come from `pipeline.artifacts.get`.

Not in code:
1. **No snapshot by id (§06's blocker, half open).** `HubContractSnapshotProvider` calls `webdev.contracts.get` and
   `webdev.artifacts.download`, and neither is registered. platform-nest has only `GET contracts` and
   `POST contracts/refresh`.
2. **`code.scaffold` v2 has no caller.** The hub's `code.scaffold` tool is still the old stub, and
   `blockLibraryTarball` has no source.
3. **Provisioning stops at the repo shell.** It creates no `webdev_sites` row, no WebDesk tenant and no pinned
   contract. §08 says it yields all three.
4. **No template repos.** The three repos in `site-provisioning-templates.md` do not exist, and `ERP_REPO_TEMPLATE_*`
   has no defaults, so a missing kind returns 422.
5. **The automation path cannot choose a kind.** `automation/workflows/wd-provision.json` hardcodes
   `framework: "vite"`.
6. **The console form is stale.**
   - `platform-ui/src/lib/webdevProvisionedSites.ts:57` disables `wp` with outdated text.
   - It offers frameworks, not the D28 kinds.
   - Its `pending` does not say "awaiting approval".
7. **No org-level secret grants (WSK-D29).** Granting a new repo access to org Actions secrets is not coded.
8. **No deploy gate.**
9. **No live contract codegen** (found 2026-10-12 while briefing M6-P4b0, verified by hand). The generator under `webdesk/api/src/codegen/generator/` is `.mts`, run only through `tsx` (a devDependency); `tsconfig.json` compiles `src/**/*.ts` alone, so none of it is in the image, and nothing in the deployed code calls it (`run-codegen.mts`: "a currently-unwired trigger, by design"). A tenant's `contracts/<slug>/latest.json`, which the ERP's contract mirror reads, exists only if someone ran `codegen:run` from a checkout. The whole §06 rail therefore cannot run end to end live.

### P5 · Headless WordPress — a prototype

- **In code:**
  - the PHP block renderer and vendored vocabulary (`webdesk/wordpress/theme/gaiada-webdesk/inc/`);
  - the PHP SDK generator (`webdesk/api/src/codegen/generator/sdk-php.mts`, in the double-run gate);
  - a render-invariant probe, run by hand;
  - the scaffold's `wp` branch.
- **Not in code:**
  - the theme's entry files (`functions.php`, `page.php`, `style.css`, the vendored `sdk.php`) are not committed;
  - the rewrite rules and the settings page are not built;
  - the theme has never run in a WordPress install;
  - CI runs no PHP.

### CDN · WSK-70 — deferred by WSK-D50

Cache tags (`webdesk/api/src/delivery/vocabulary/cache-tags.ts`) and the `content.cache_invalidate` log line
(`content-transitions.ts`) are in place, so a purge adapter has its input the day a CDN arrives. Three code comments
still call the ticket WSK-27.

### P6 · Client delivery — no current target

§12 still names `delphi`/`helios`. The 2026-09-04 plan `2026-09-04-hostinger-shared-replatform.md` moves client
delivery to shared hosting, but it was never ratified (its OQ-3.1–3.8 are open). Until the owner rules, nothing is
built; §6 is the proposal (M6-P6a).

### Stale text found on the way

- §07's ticket table still shows SM-74 and MON-01 as "designed".
- §10's counts are out of date: there are now 5 workflows with 19 jobs, none of them self-hosted.
- `infra/runbooks/self-hosted-ci-runner.md` is cited in two documents but is not on main.
- `webdesk/wordpress/README.md` says the scaffold's `wp` branch is "not wired".

## 2 · Owner decisions

Each carries the default this plan works to if it stays unanswered.

| # | Decision | Default | Blocks |
|---|---|---|---|
| O-1 | **P6's target.** Ratify the Hostinger shared replatform, or keep `delphi`/`helios`. If ratified, it takes the next free WSK-D id and amends D32 and §12 P6. | None. That plan asks for OQ-3.1 (decommission deadline) and OQ-3.6 (staging retention) before anything else. **§6.1 recommends ratifying it for new client sites, and §6.5 shows P6 needs neither answer** | P6, and the deploy secrets in M6-P4g  **ANSWERED 2026-10-12 (WSK-D79):** per site, Hostinger shared or `delphi`/`helios`; fullstack = static web + API on a Node host (§6.0) |
| O-2 | **Who creates the three template repos** in `gaiadabali` (`template-static-astro`, `template-fullstack-next-nest`, `template-wp`)? The ERP App can only create repos with org Administration write. | The owner creates three empty private repos marked as templates; sessions fill them by pull request | M6-P4d |
| O-3 | **The App's `organization_secrets: write` permission**, so the ERP can grant a new repo access to deploy secrets it never holds (D29). | Not granted, so the P4 gate stops short of deploy | M6-P4g |
| O-4 | **Where the P4 gate creates repos.** The gate is 3 kinds × 2 paths = 6 real repos. | A separate test org, so the gate can be rerun without clutter in `gaiadabali` | M6-P4 gate |
| O-5 | **OQ-2.1 ratified.** Repo creation stays manual except through the scoped, template-only, WS4-gated ERP path. | Adopt as written | Nothing; it only needs recording |

**Later the same day:** the owner reported the ERP GitHub App's organization-secrets permission granted (O-3; first proven by M6-P4g's first grant), delegated the template repos to this session, and asked for all remaining work to proceed. The M6 session created `gaiadabali/template-static-astro`, `template-fullstack-next-nest` and `template-wp` (private, marked as templates, a README each) with the org-admin account; M6-P4d fills them by pull request.

**Measured 2026-10-12 (M6-P4b2 review):** O-3 is NOT in effect. `GET /orgs/gaiadabali/installations` shows the `gaiada-erp` installation (updated 11:34 +08 that day) with `secrets: write`, the REPOSITORY secrets permission, and no `organization_secrets`. M6-P4g's grant needs the organization one (Organization permissions → Secrets: read and write), and the org owner must then accept the updated permissions on the installation. O-3 is re-opened on the board.

**Owner answers, 2026-10-12:** O-2, O-4 and O-5 accepted as their defaults and recorded as **WSK-D74** in `webdesk-design-v2.md` §14 (OQ-2.1 marked resolved in §13). O-1 is deferred (P6 waits). O-3 stays open. The owner also approved merging M6's verified work to main (after a full gate on the then-current main) and two agents at a time.

Restated, not new: **no second live tenant until M4's CPU decision** (OQ-2.7). Until then, P4's tenant creation and
P5's proof run against the WebDesk test stack on `sumopod`.

**Design call put to the owner with O-3: the deploy gate is the secret grant.** The ERP grants a repo access to the
org deploy secrets only when the repo has a `webdev_sites` row and a `CONTRACT.lock` on its default branch, read
through the App. A repo without both cannot deploy, because it holds nothing to deploy with. The template's deploy
workflow also refuses without `CONTRACT.lock`, so the refusal is visible in the run. A bypass means working around the
tooling on purpose, and the ERP records it as an exception with a reason. This meets §08's second gate with no new
runtime dependency between a site's CI and the ERP.

**P6's further questions, O-6 to O-12, each with its default, are in §6.5.**

## 3 · Tickets

Seats follow the agent-army standard: one agent in flight at a time, and at most one Opus dispatch in a usage window.

| # | Ticket | Seat | Needs | State |
|---|---|---|---|---|
| **P3** | | | | |
| M6-P3a | **Measure the live side (read-only).** Registry and property counts by adoption, origin and verified; whether SM-74 carries data; MON-01's cron, target file and `client-properties` series on the boxes. Live DB reads are handed to the owner as a ready command; API and `sumopod` reads by the orchestrator | orchestrator | — | **DEV-VERIFIED** 2026-10-12, read through the live ERP API as the owner (counts only, no domains recorded): the registry holds **81 sites across 70 projects, all `tracked`** (30 production, 50 staging, 1 development), 62 without probe consent; `search_properties` for the agency tenant: **38, all active, 37 verified**; MON-01: 0 targets shipped. SM-74 topology fill is not observable here: the properties list API does not return those columns (a missing field, not missing data) | |
| M6-P3b | **Sentinel internal client** (= M5-G0, owned by M5), then backfill the internal `webdev_sites` rows' `client_id` to it. One-off script; the owner runs the live write | junior (Haiku) writes, owner runs | M5-G0 | IN PROGRESS: the script is built and DEV-VERIFIED 2026-10-12 on `sumopod` (gate `m6b4b`: platform-nest 619 files / 9231 passed / 0 failed, incl. its DB cases), on `webdesk/m6-batch4` (`092b3ea0`): `internal-sites-backfill` (dry run by default; the domains list is a gitignored `*.local.*` file; refuses to overwrite a real client; one transaction under the `webdev` RLS scope). Waits for M5-G0's sentinel to exist live; then the owner runs it |
| M6-P3c | **A `webdev_site` Cerbos kind**, so the registry routes stop borrowing provisioned-site actions. Six artifacts, not one policy file; the four pinned count tests move | senior-be (Sonnet) | — | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6b2`): platform-nest 8847/0 incl. the new matrix and the migration. LIVE in v1.0.0-alpha.362: `applied: 202610111808…`, and the live Cerbos probe passes (ALLOW for a company admin in the tenant; DENY with no grant and at low assurance; matched `resource.webdev_site.vdefault`) |
| M6-P3d | **MON-01 made live** (M6-P3a found it probes nothing). The sync script as written cannot run: it calls `node` on a host that has none, and it needs a database login that can read `search_properties` across tenants (FORCE RLS). Shape: the generator in a pinned `node` container; a read-only role granted `SELECT` on the generator's columns only; an SSH key from `gda-aicenter` to `sumopod` whose forced command can only write that one file. Everything lands outside the `webdesk` project, so it needs the owner's OK (D43) | devops (Sonnet) + orchestrator on the boxes | owner OK | **LIVE** in v1.0.0-alpha.365 (2026-10-12): 37 targets rendered (= the 37 verified properties), pulled by sumopod every 5 min, Prometheus `client-properties` 37 active, 35 `probe_success == 1`. Code DEV-VERIFIED on `sumopod` (gate `m6b7c`: platform-nest 9345/0 incl. `client-targets.db.test.ts`; the generator parity test), on `webdesk/m6-batch7` (`41ef428f`), owner OK 2026-10-12. platform-nest renders the file (`CLIENT_PROPERTY_TARGETS_PATH`, one tenant per transaction under the `search` scope, atomic, never empty-over-non-empty on a read error); sumopod pulls it with `pull-client-property-targets.sh` over a key whose forced command on `gda-aicenter` prints that one file. Box, done before the release: the host dir, the env var, the key, the `restrict,command=…,from="10.88.0.2"` line (an arbitrary command is refused). After the release: the cron line on sumopod (installed) and the live check (passed) |
| M6-P3e | **MON-04 "Client Properties" dashboard**: uptime, certificate days left, a per-property drill-down. Internal properties are excluded once the sentinel exists | devops (Sonnet) | M6-P3a | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6b3c`), merged to main with batch 3 (`1ae98c05`): `client-properties.json` dashboard; MON-01 targets carry `internal`; the two existing probe alerts exclude internal sites; selftest 12/12; promtool `check rules` SUCCESS on every rules file. MON-01 itself still ships no targets (M6-P3d) |
| M6-P3f | **Stale text fixed**: §07's ticket table, §10's counts, the WordPress README, the three WSK-27 → WSK-70 comments | junior (Haiku) | — | PLANNED |
| M6-P3 gate | **About 63 properties tracked**, the probe target file a subset of verified rows (checked against the DB), no request to an unverified client host, and the console shows the registry with its staleness | qa (Sonnet) + orchestrator | P3a–e | PLANNED |
| **P4** | | | | |
| M6-P4a | **Snapshot by id (closes §06).** `GET contracts/:snapshotId` and `GET contracts/:snapshotId/artifacts/:artifact` (`openapi`, `sdkTs`, `sdkPhp`, `contractMd`; the file id comes only from the snapshot's own pointer; the bytes are re-hashed against the mirror-time sha256, a mismatch is 502 `artifact_hash_mismatch`, a null pointer 404 `artifact_absent`). Hub tools `webdev.contracts.get` and `webdev.contracts.artifact`, read-only, added to `wf:delivery` only. The scaffolder's adapter uses them | senior-integrator (Sonnet) | — | **DEV-VERIFIED** 2026-10-11 on `sumopod` (gate `m6p4a`, main `696d346` + the branch): platform-nest tsc clean, 561 files / 8053 tests passed (3 files skipped), the 8 new snapshot-by-id cases re-run verbosely against Postgres + Cerbos, all passed; mcp-hub 372 passed; ai-agents 354 passed. LIVE in v1.0.0-alpha.362 |
| M6-P4r | **Contract codegen runs live inside WebDesk.** The generator is compiled or bundled into the api image (the `./webdesk` build context of M6-P4b0, with `delivery/vocabulary/` admitted too, since `build-artifacts.mts` imports it) and runs on `tenant.provision` and `schema.apply`, so every tenant has a current `latest.json` without a manual step. It writes with the api's own least-privilege storage key, so no new credential appears anywhere. Touches the M3 session's `schema.apply` and the M4 session's image. **M3 agreed 2026-10-12 and hands M6 the hook**, with seven constraints: (1) codegen runs strictly AFTER the CommandEnvelope commit and fails soft, never changing the command's response or idempotency record, with a re-run path kept (CLI or control command); (2) the api container is read-only with cap_drop ALL since M4's hardening, so output goes to RustFS or a mounted volume, never the image filesystem; (3) WSK-15's codegen gate and the c1 determinism checks hold for the compiled generator, byte for byte; (4) the snapshot's MAJOR/MINOR classification agrees with `schema.apply`'s `409 contract-major-change`, and a MINOR apply yields a new snapshot id; (5) `contract.published` may be emitted, but the Zone B bridge into the ERP is not live until after release 359, so the ERP learns only via `contracts/refresh` until then; (6) serialize per tenant or compare-and-set on the snapshot id, because two applies can race the latest pointer; (7) first live check on M3's proof tenant `wsk49e-test`, which has no contract today. **M4 agreed the same day**, with five conditions: (a) codegen stays off the request path: the two commands enqueue a BullMQ job with a timeout and answer without waiting (the box is 2 vCPU shared with the ERP; the api is capped at 1 CPU / 768 MiB); (b) the api's RustFS key must be allowed to write `artifacts`, and any widening goes into storage-bootstrap's `webdesk-api` policy (idempotent, re-run every deploy), never by hand; (c) determinism is proven on the COMPILED generator (WSK-18 c1 in CI, `codegen:gate` in the gate's legacy suite); (d) `/tmp` is a 64 MiB tmpfs, so artifacts go straight to RustFS; (e) no manual step in deploy-webdesk; a backfill for existing tenants is an idempotent command or job the api runs. Every release now deploys WebDesk automatically, so P4r goes live with the release that carries it. Split: **P4r-a** the generator compiled into the image (the `./webdesk` context, a `.dockerignore` admitting `api/`, `blocks/`, `delivery/`, release.yml's matrix context, `webdesk/blocks/` in the `webdesk_api` CI group, the block-library tarball baked in with its sha256 in a LABEL) with determinism proven on the compiled form; **P4r-b** the queued trigger on both commands, per-tenant serialization, the storage policy check and the backfill job | senior-integrator (Sonnet; opus·medium if the trigger's transaction boundary resists) | M3 + M4 agreement | **DEV-VERIFIED** 2026-10-12 on `sumopod`, both halves. P4r-a: a reproducible tarball across two no-cache builds, a wrong-hash build refused, the bundle loads read-only, webdesk-api 1248/0, legacy 16/16 incl. the compiled-codegen gate; M4 reviewed it. P4r-b: webdesk-api 1652/0 incl. 13 live tests running the real compiled generator against Postgres, Redis and RustFS. LIVE in v1.0.0-alpha.362 (M4's post-deploy checks green: codegen worker registered). Existing tenants get a contract when the `contract.regenerate` backfill runs |
| M6-P4b0 | **The block library becomes a fifth snapshot artifact.** Nothing stores a pinned `@gaiada/webdesk-blocks` tarball today (WSK-16 packed one by hand), so the scaffolder cannot vendor it. Design call (orchestrator, 2026-10-11), following OQ-6 ("installable as a tarball, no registry infra") and §06 ("the scaffolder reads snapshots only"): WebDesk stores the packed tarball per library version in its artifacts bucket, the contract read returns a presigned `blockLibraryUrl` beside `sdkPhpUrl`, the ERP mirror stores and hashes it as a fifth artifact (a `null` pointer for older snapshots, like `sdkPhp`), and `webdev.contracts.artifact` gains `blockLibrary`. The scaffolder then reads it through the same hash-checked tool. Two refinements found while briefing it: (1) the tarball's hash is recorded per artifact (`artifacts.hashes.blockLibrary`) but kept OUT of `contentHash`, because adding a key to the hashed manifest would make a re-fetch of an already-recorded contract version trip the determinism alarm; (2) the WebDesk api image builds from `webdesk/api` alone, so the tarball has to be produced by a change to that image's build context or to the release workflow, both in the M4 session's deploy lane. **Producer agreed with M4 (gaiada-system-0c) on 2026-10-11: the api image builds the tarball**, so the image's cosign signature and SLSA attestation cover it and `deploy-webdesk` stays a verify-and-swap; a deploy-time upload was rejected (unsigned, needs RustFS write credentials on a runner, exists only where it ran). M4's conditions: (1) build context `./webdesk` with `-f api/Dockerfile` and a `.dockerignore` admitting only `api/` and `blocks/` (no node_modules), via release.yml's matrix `context` for webdesk-api; (2) `scripts/ci/plan.mjs` (WSK-69) counts `webdesk/blocks/**` as a webdesk-api change path, or a blocks-only change ships a stale tarball; (3) the tarball's sha256 recorded in an image LABEL, and codegen refuses to upload different bytes under an existing `<ver>` key (idempotent only for identical bytes); (4) with GOVERNANCE object lock on the bucket, a different hash at the same key fails loudly, never overwrites; (5) kept out of `contentHash`; (6) land it after release 357's deploy (deploy-webdesk's first live apply) | senior-integrator (Sonnet) | M6-P4a, M6-P4r | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6b3c`: platform-nest 9150/0, webdesk-api 1786/0, legacy 16/16), merged to main with batch 3 (`2a80ee5f`; review fixes: content-addressed key `4d0656f3`, mirror-test version `2e944164`). Unit 40/40; nest webdev-contracts 46/46 on Linux |
| M6-P4b1 | **Wire `code.scaffold` v2, dry run.** Runner dispatch in ai-agents (`runner/service.ts`), the hub's `code.scaffold` stub replaced, a source for the block-library tarball. `dry_run` proven for all three kinds. Two facts from the M6-P4a review: (1) WebDesk serves `sdk.d.ts` and `sdk.php` as plain text, but the ERP mirror stores them as `sdk.ts.tgz`/`sdk.php.tgz` with type `application/gzip`, and the scaffolder vendors the `.d.ts` as `vendor/webdesk-sdk.tgz`; fix the labels and the vendoring together. (2) The scaffolder's hub calls pass `webdev_contract_snapshot` `read` only if its OBO identity has a verified link to a user holding a webdev role on the tenant; nothing in the repo seeds that link for `wf:delivery`, so check it on the box. (3) Found by M6-P4d: the scaffolder's `node` kind (`templates/node-site.ts`) emits an Astro SSR skeleton at the repo root, while §08 and the owner's stated stack make `fullstack` Next + Nest (`template-fullstack-next-nest`: `apps/web` Next, `apps/api` Nest, an npm workspace); it would overwrite the workspace root. The template is right; the `node` kind must write into `apps/web` (and leave `apps/api` alone) | senior-integrator (Sonnet) | M6-P4b0 | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6b3c`: ai-agents 409, mcp-hub 390), merged to main with batch 3 together with M6-P4e (`bc30c4a0`): runner dispatch (`runner-job.ts`), the hub tool starts a dry-run goal and returns its id, `node` fills `apps/web` with a React renderer (the block library is Astro-only), a real `tsc`/`vitest`/`next build` of a scaffolded node site passed. It ships together with M6-P4e, which makes the delivery flow send `contractSnapshotId`, `siteKind` and resolvable artifacts |
| M6-P4b2 | **The scaffold reaches the repo through platform-nest.** `git-writer.ts` ends in a `git push`, but the agents' GitHub App and the hub are read-only by design, and only platform-nest holds the ERP App's write credential (D29). So ai-agents returns the file tree, and platform-nest commits it into the provisioned repo through the GitHub Data API (blobs, tree, commit, ref) as part of the approved provisioning, never a second credential in ai-agents | senior-be (opus·medium: a credential boundary) | M6-P4b1, M6-P4c | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gates `m6b6`: mcp-hub 393, ai-agents 452, blocks 40/40, PHP clean; `m6b6f`, after two test fixes: platform-nest 623 files / 9291 passed / 0 failed), on `webdesk/m6-batch6`. Design `docs/plans/2026-10-12-webdesk-m6-p4b2-scaffold-commit.md`: the scaffold job hands its tree, by value, to the hub tool `webdev.provisionedSites.commitScaffold` (low-impact write, `wf:delivery` only); platform-nest re-hashes every file, requires `CONTRACT.lock` to name the pinned snapshot, refuses escaping paths, `.git`, symlinks, `.github/` changes and oversized trees, and writes with the ERP App only (blobs, tree, commit, `force: false` fast-forward), first fill only (`scaffold_repo_not_pristine`), crash-resumable (migration `202610122130`). Gates: `webdev_provisioned_site · provision` then `github_repo · push` on the org tenant; no Cerbos change. The ERP App is installed on ALL `gaiadabali` repos with `contents: write` (checked live), so a generated repo is covered. The first runs failed on two test bugs, both fixed in the tests: slugs built from the uuidv7 timestamp prefix collided (9 DB cases), and an expression-bodied `beforeEach(() => mock.mockReset())` returned the mock, which vitest then ran as a cleanup hook with no arguments (3 HTTP cases). Follow-ups: the Web Dev review gate still opens at queue time, not at commit; sha columns are SHA-1 only |
| M6-P4c | **Provisioning finishes §08.** When the repo is created: the `webdev_sites` row (`origin = provisioned`, `adoption = mandated`, its kind) and the WebDesk tenant with a pinned contract snapshot, idempotent and crash-resumable like the repo step | senior-be (opus·high: crash-resume across two services) | M6-P4a | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6b3c`: platform-nest 9150/0 incl. the DB suites), merged to main with batch 3 (`495f5159`): `completion_state` NULL → registered → tenant_ready → complete (migration `202610120425`), idempotent and crash-resumable; `webdesk.contract.regenerate` (MEDIUM: an attended human runs it, automation suspends into D14). Design calls ratified by the orchestrator: (1) the company admin's repo approval covers registry row + tenant (WebDesk classes `tenant.provision` MEDIUM; §08 counts the three as one provisioning); (2) a placeholder domain `<slug>.provisioned.invalid` until M6-P4c2. Unit 38/38 |
| M6-P4c2 | **A provisioned site gets its real domain.** M6-P4c registers `<slug>.provisioned.invalid` (domain is NOT NULL, and a new site has none); a registry route or command replaces it, keeping the D35 domain key unique | senior-be (Sonnet) | M6-P4c | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gates `m6b4`: platform-nest 9210/0 incl. 16 new registry cases; `m6b4b` 9231/0), on `webdesk/m6-batch4` (`4b4eba56`): `POST sites/:id/domain` `{domain}` under `webdev_site:update` (no new Cerbos action; authorization before body validation); only a provisioned row still on its placeholder is claimable, once (409 `domain_already_set`); `.invalid` refused; row lock + conditional UPDATE; outbox `webdev.site.domain_claimed`. Found while building it: the placeholder never reached WebDesk (`tenant.provision` carries no domain; WebDesk keeps domains per environment, set by `environment.provision`, and `webdesk.site.setDomain` is still a 501 stub), and MON-01 reads only `search_properties`, so a claim propagates nowhere. Giving the WebDesk environment its domain is a separate HIGH-impact act |
| M6-P4b0b | **The ERP verifies the block-library bytes at mirror time.** WebDesk's contract read sends no hash for the tarball, so the mirror only records its own; add `blockLibrarySha256` to the read response and check it in `refreshContractSnapshot` | senior-integrator (Sonnet) | M6-P4b0 | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gates `m6b4`: platform-nest 9210/0; `m6b4w`: webdesk-api 1796/0; `m6b4b` 9231/0), on `webdesk/m6-batch4` (`02feea70`): the contract read adds `artifacts.blockLibrarySha256` (the pointer value or `null`, never fabricated); the mirror refuses a mismatching tarball, or a claimed hash with no tarball, before any write (`block_library_hash_mismatch`, 502 on the refresh route; P4c parks with that reason). A tarball with no claimed hash (an older WebDesk) is still accepted |
| M6-P4d | **Template repos filled** per `site-provisioning-templates.md`. `template-wp` carries the M6-P5a theme. Each template's deploy workflow refuses without `CONTRACT.lock`. `ERP_REPO_TEMPLATE_*` set on the box and listed in compose | medior (Sonnet) + orchestrator on the box | O-2 | **DEV-VERIFIED** 2026-10-12: `gaiadabali/template-static-astro`, `template-fullstack-next-nest` and `template-wp` filled by PR #1 each, their workflows green on GitHub on the template path; sources in `webdesk/templates/` with a wp-theme drift check (green on Linux); `ERP_REPO_TEMPLATE_*` set in the box `.env` and passed by compose (LIVE in v1.0.0-alpha.362) |
| M6-P4d2 | **The templates and the scaffolder leave versions with critical advisories.** Found 2026-10-12 through Dependabot on the published template repos: fullstack `next ^14.2.15` (two critical, unauthenticated RCE, fixed only in 15.5.24, so Next 15 + React 19) and static `vitest ^2.1.5` (critical; 3.x still pulls a critical `tinypool`, so vitest 4). Templates and `code.scaffold` move together; site CI moves to Node 24, because npm 10 crashes installing vitest 4 beside the `file:` vendor tarballs | medior (Sonnet) + orchestrator | M6-P4d | **DEV-VERIFIED** 2026-10-12 on `sumopod`: `webdesk/templates/qa/build-templates.sh` 10/10 PASS on `node:24-bookworm` (both templates, and a scaffolded fullstack site through install, typecheck, `next build`, vitest), `npm audit` 0 in the static template and the scaffolded site; ai-agents 389/0. The npm 10 crash was isolated by hand (vitest 2 vs 4, npm 10 vs 11). Both template repos re-published by pull request: `template-static-astro` #2 (`70ab5ae3`), `template-fullstack-next-nest` #3 (`a8c62de6`), checks green |
| M6-P4d3 | **The fullstack template's remaining high advisories**, each a major bump: Nest 10 → 11 (`@nestjs/*`, transitive multer/body-parser; `apps/api` is three files) and Tailwind 3 → 4 (a config migration, also in `node-site.ts`); Next's last moderate needs 16.4 | medior (Sonnet) | M6-P4d2 | **DEV-VERIFIED** 2026-10-12 on `sumopod` (`build-templates.sh` 12/12 PASS on `node:24-bookworm`, incl. the new check that the built CSS carries Tailwind 4 utilities for the template and a scaffolded site), LIVE in v1.0.0-alpha.365 (`62f6b8b9`): Nest `^11.2.7`, Tailwind `^4.3.3` (CSS-first, `@tailwindcss/postcss`, no autoprefixer), the scaffolder matching; `npm audit` 16 (8 high) → 2 (1 high, 1 moderate), both through Next and cleared only by Next 16.4 (out of scope) |
| M6-P4e | **PRD → kind on the automation path.** `wd-provision.json` passes the signed PRD's stack hint instead of `vite`, re-imported with the n8n CLI | medior (Sonnet) | — | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6b3d` on the final batch-3 head: platform-nest 9179/0 incl. `automation-prd-kind.test.ts`, mcp-hub 390, ai-agents 409, blocks 40/40, PHP lint and four probes clean), merged to main with batch 3 (`3ebcfcd3`, review fix `91bae52e`). `wd-provision.json` sends the signed PRD's `Stack:` line as `stack` and refuses a missing or unknown one (`prd_stack_missing`, `unsupported_stack`); the PRD extraction now writes that line. The delivery code stage reads the run's provisioned site, parks until P4c's completion is `complete` with a pinned snapshot, and passes `contractSnapshotId`, `siteKind` and `stage:<id>` refs, which `pipeline.artifacts.get` now resolves; `webdev.provisionedSites.list`/`.get` for `wf:delivery`. The shipped workflow nodes are executed by `automation-prd-kind.test.ts` (no hand-copied expectation). The flow itself is driven live after the release re-imports both workflows. Follow-ups: a parked code stage does not re-trigger itself, and `gen-delivery.mjs` is stale |
| M6-P4e2 | **A parked code stage resumes by itself.** Today the delivery code stage parks (retryable, notified) until P4c completes and never re-runs on its own. P4c already emits `webdev.site.contract_pinned` (entity `webdev_provisioned_site`) when completion reaches `complete`: a `pipeline-delivery.json` webhook on `ev/webdev.site.contract_pinned` re-enters the code-stage path for that site's run, idempotent under the bridge's at-least-once delivery, and the box adds the event and entity type to `N8N_BRIDGE_EVENTS` / `N8N_BRIDGE_ENTITY_TYPES` | medior (Sonnet) + orchestrator on the box | M6-P4b2 (both edit `pipeline-delivery.json`) | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gates `m6b7`/`m6b7c`: platform-nest 9318/0 and 9345/0 incl. `automation-prd-kind.test.ts` 47/47, which walks the shipped graph against a stateful fake platform), LIVE in v1.0.0-alpha.365 (`a51bee0a`): `Trigger: site.contract_pinned` re-enters the existing code-stage path only when the run is waiting there (derived from `release_code`; parking writes nothing), every other state a `noop` with a reason, a guard so this trigger can only release the code stage. Box: two bridge allow-list entries and a CLI re-import after the release |
| M6-P4e3 | **At most one `code.scaffold` goal per provisioned site and pinned snapshot.** Found by the M6-P4e2 review: two near-simultaneous deliveries could each queue a goal between `getRun` and the single-shot `claude_code` stage | senior-integrator (Sonnet) | M6-P4e2 | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6b7b` with Postgres: ai-agents 52 files / 468 passed incl. 12 concurrent creates → 1 row; mcp-hub 396), LIVE in v1.0.0-alpha.365 (`da701a62`): a dedupe key derived in the runner, a partial unique index on `agent_goals (tenant_id, dedupe_key)` while queued/running/ok and `INSERT … ON CONFLICT DO NOTHING`, so the losers get the owner's goal (`deduped: true`); a failed, cancelled or interrupted goal frees the key |
| M6-P4f | **Console kind picker**: `static`/`wp`/`fullstack`, `wp` enabled, an "awaiting approval" state that links to the approval, the failure reason shown | medior (Sonnet), senior-fe review | — | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6g3`, main `7fbe490` + the branch): platform-ui tsc clean, 286 files / 5525 tests passed, `next build` exit 0 with 0 compile failures. LIVE in v1.0.0-alpha.362 |
| M6-P4g | **Deploy gate and org secret grant**, in the shape in §2 | senior-be (opus·high: a security boundary) | O-1, O-3 | PLANNED |
| M6-P4j | **Contract pin over the real control channel (WSK-D81).** Found live 2026-10-13: provision completion could never pin a contract snapshot, so no provisioned site got a `CONTRACT.lock` and `code.scaffold` could not run. Two causes. (1) `pinContractSnapshot`, the console reads and the snapshots controller built their provider from the WSK-19 bearer stub (`WEBDEV_CONTROL_BASE_URL`, unset in production, and a plain bearer cannot pass `ControlAuthGuard` anyway), so completion answered `contract_channel_not_configured` forever; the configured four-layer client (`WebdeskControlClient`) was never used for it. (2) The artifact URLs in the contract body are presigned against WebDesk's internal RustFS (`http://rustfs:9000/...`), unreachable from the ERP across the airlock (`ENOTFOUND rustfs`). Fix: WebDesk serves the bytes at `GET /control/v1/tenants/:slug/contract/:version/artifacts/:artifact` under the existing `contract.read` command; the ERP's new `WebdeskChannelContractProvider` fetches every artifact through the control client (`bodyBytes`, 25 MiB cap on that call), and one selector (`resolveContractControlProvider`) prefers the real channel and keeps the stub only as the dev fallback; hashes are still verified over the fetched bytes | senior-integrator (Sonnet) | none | BUILT (branch `m6/p4j-contract-channel`) |
| M6-P4k | **The delivery flow's repo check passes `tenantId`.** Found by the P4 gate (2026-10-13): GH-12 made `github.repoStatus` require `tenantId`, but `pipeline-delivery.json` still sent `{ repo }`, so the hub refused, `Repo ready?` read the refusal as "repo does not exist yet", and every run's `pm_approval` ended in a "repo needed" notice instead of `code.scaffold`. Fixed in the node; `mcp-hub/src/workflow-tool-args.test.ts` now checks every workflow's MCP call against the registered tools' `required` arguments (it fails on the old file, naming this call) | orchestrator | none | BUILT (branch `m6/p4k-delivery-repostatus`) |
| M6-P4m | **A redelivered event cannot open a second beat.** Found by the P4 gate (2026-10-13): the n8n bridge is at-least-once, and the design release (an AI call of ~130 s on GLM 5.3 Flash) outlived its 120 s timeout, so `scope.signed` was redelivered and a second execution opened a second `pm_review` on the same design stage. WD-29 dedupes the stage, not the gate. `pipeline.openGate` should, under WD-29's per-run lock, return the existing gate for the same run, stage and kind instead of inserting another (every delivery-flow beat is one per stage; a revision is a new stage). The trigger is removed live (`N8N_BRIDGE_TIMEOUT_MS=300000`) | orchestrator | none | BUILT (branch `m6/p4m-gate-redelivery`): a stage-scoped twin decided `approved`/`signed` dedupes like a pending one; run-level gates and re-requests after `changes_requested` unchanged |
| M6-P4n | **An empty generation is a failure, and reasoning has a budget.** Found by the P4 gate (2026-10-13): the live gateway's only working LLM is OpenRouter `z-ai/glm-5.3-flash`, a reasoning model whose thinking tokens count against `max_tokens`. `design.prototype` returned HTTP 200 with EMPTY content twice (run 3: `OPENAI_MAX_TOKENS=4096`, 59.8 s; run 6: 16000, 110 s), `openai.go` returned `""` as success, and the hub stored it as the design artifact, so the PM's `pm_review` opened on a blank design. Three parts. (A) ai-gateway-go: empty content with `finish_reason=length` is an error; a new optional `OPENAI_REASONING_MAX_TOKENS` (default 0 = not sent) adds OpenRouter's `"reasoning": {"max_tokens": N}`. A direct probe: no cap 99.5 s and 5938 reasoning tokens, cap 3000 30.5 s and about 25x cheaper. (B) mcp-hub: `gatewayComplete` (design.prototype, llm.extract, llm.summarize) refuses an empty or echo-fallback answer, so the tool fails, n8n errors, the webhook answers 5xx and the at-least-once bridge redelivers. (C) `pipeline-delivery.json` `Load + decide`: a design's `pm_review` `changes_requested` had no branch and dead-ended the run in noop; it now revises (`revise_design`, or `escalate_revise` at the cap) like the client's feedback | senior-integrator | none | BUILT (branch m6/p4n-ai-empty) |
| M6-P4o | **The contract mirror hashes exactly as WebDesk does.** Found live right after 368 (M6-P4j) made the pin reach WebDesk: every pin was refused `contract_hash_mismatch`. The ERP hashed compact JSON keyed `openapi`; WebDesk hashes `stableStringify` (sorted, 2-space indent, trailing newline) keyed `openapiJson`. Proved on live bytes (`m6-gate-static-prd`: WebDesk form = the claimed `sha256:a0e75f24…`). `contentHashFromDigests()` + golden parity tests on BOTH sides (the live digests and hash) | orchestrator | M6-P4j | BUILT (branch `m6/p4o-content-hash`) |
| M6-P4 gate | **A staff click and a signed PRD each produce a correct repo for each kind** (6 runs), each with its registry row, tenant and `CONTRACT.lock`; a repo without them is refused deploy | qa (Sonnet) + orchestrator | P4a–g, O-4 | PLANNED |
| **P5** | | | | |
| M6-P5a | **Theme finished.** One canonical theme in `webdesk/wordpress/theme/gaiada-webdesk/` (entry files, a fixture `sdk.php`, `inc/router.php`, `inc/config.php`, a read-only settings page); the scaffolder emits it byte for byte (drift test), and the old `scaffold-template/wp-site.ts` is retired. Configuration only from `wp-config.php` or the environment. The review found the scaffolder's old copy had emitted no renderer (`inc/`) at all | medior (Sonnet) | — | **DEV-VERIFIED** 2026-10-11 on `sumopod` (gates `m6p5a-php`, `m6p5`): `php -l` 16/16, render probe 29/29, router probe 64/64, ai-agents 361 passed incl. the theme drift test. The WordPress runtime itself is the P5 gate. LIVE in v1.0.0-alpha.362 |
| M6-P5c | **Link and rich-text safety in both renderers.** Found in the M6-P5a review: neither the Astro blocks (`Cta.astro`, `Hero.astro`) nor the PHP templates filter a link's scheme, so a `javascript:` href passes, and both emit `richText` HTML raw; `webdesk/api`'s content write path has no HTML sanitizer. With client editors (D58–D60) that is a stored-XSS path on a delivered site. An allow-list of link schemes (`http`, `https`, `mailto`, `tel`, relative, `#`) in both renderers, and one decision on where rich text is sanitized (at write in WebDesk, or at render in each renderer), applied to both | senior-fe (Sonnet) + senior-be review | — | **DEV-VERIFIED** 2026-10-11 on `sumopod` (gate `m6p5`): blocks vendor check, unit 40/40, `astro check` 0 errors; PHP safety probe 47/47; and a real Astro build of a hostile fixture through the demo site: every hostile href became `#`, no `javascript:` and no event handler in the output, only the two JSON payload scripts with their `</script>` escaped, hostile image sources dropped. Write-side sanitising stays a proposal. LIVE in v1.0.0-alpha.362 |
| M6-P5e | **The PHP templates read the vocabulary's field names.** Found in the M6-P5c review: `richText` reads `value` (the vocabulary field is `content`) and `cta` reads `label`/`href` (`buttonLabel`/`buttonHref`), so both render empty in WordPress. Every PHP block template checked against `webdesk/blocks/src/vocabulary/blocks.ts`, with a probe that renders each block from the vocabulary's own field names | medior (Sonnet) | M6-P5c | **DEV-VERIFIED** 2026-10-11 on `sumopod` (gate `m6p5`): `vocabulary-fields-probe.php` 62/62 (31/62 fail against the old templates); the other three probes still pass. LIVE in v1.0.0-alpha.362 |
| M6-P5d | **The generated PHP SDK takes a timeout.** Its curl timeout is fixed at 10 s inside the generator (`webdesk/api/src/codegen/generator/sdk-php.mts`), longer than a page request should wait; an option with a lower default, regenerated through the determinism gate | junior (Haiku) | — | **DEV-VERIFIED** 2026-10-12 on `sumopod`: WebDesk gate `m6wd` (legacy 15/15 incl. `wsk15-codegen-gate` with the new generator, blocks 40/40, vocabulary 267/267) and, after the vendoring fix `25aebc4e`, `m6wd2` webdesk-api 1132 passed / 0 failed / 2 skipped. LIVE in v1.0.0-alpha.362 |
| M6-P5b | **PHP in CI**: `php -l`, the render-invariant probe, a drift check of the vendored vocabulary | devops (Sonnet) | M6-P5a | **DEV-VERIFIED** 2026-10-12: green in main's CI run 38202528571 on `f6e39a83`, its first real run; LIVE in v1.0.0-alpha.362. Merged on `webdesk/m6-start` (`63944177`). A `webdesk_wordpress` CI group (paths `webdesk/wordpress/`, `webdesk/delivery/vocabulary/`, `sdk-php.mts`) gates one new `webdesk-light` step: `php -l`, the five probes in digest-pinned `php:8.3-cli`, then the vendored block-list `--check`. Locally it passes, and it fails on each of three deliberate breakages; planner tests 18/18 (one assertion on main was already failing since WSK-49c and is corrected). Its first real run is the merge to main (CI runs on main, PRs or dispatch only) |
| M6-P5 gate | **A WordPress site renders entirely from `/v1`.** On `sumopod`: a throwaway WordPress and MySQL, the theme active, a test tenant on the WebDesk test stack with a `pages` collection (the WSK-18 fixture tenant has none, so its SDK 404s every default route), every page of the fixture site from `/v1`, unknown blocks reported and never thrown | qa (Sonnet) + orchestrator | M6-P5a, M6-P5b, M6-P5c, M6-P5e | **DEV-VERIFIED** 2026-10-12 on `sumopod` (`webdesk/qa/p5-wp-gate.sh`, run `p5g1`): a real `wordpress:php8.3-apache` + MySQL with the canonical theme and a tenant SDK generated live by the compiled generator against the WebDesk api built from the tree; 65/65 checks (every page from `/v1`, `en`/`id` locales, theme 404s, unknown block reported, `javascript:` CTA → `#`, WordPress posts never served, a 502 page with the api stopped, recovery after restart) |
| **CDN** | | | | |
| WSK-70 | **CDN purge on publish.** Stays deferred (D50); its comment ids are fixed in M6-P3f | — | a CDN in front of `/v1` or a site | deferred |
| **P6** | | | | |
| M6-P6a | **P6 plan, a proposal for O-1** (§6): the decision restated, the fullstack problem, the tickets re-cut from the replatform's R0–R6 and HSR list, the owner questions | orchestrator | O-1 | **IN PROGRESS:** drafted 2026-10-12 as §6 (a proposal, not a ruling); it closes when the owner rules on O-1 |
| M6-P6b | **Account facts: R1, HSR-1 and the delivery half of R0, read-only.** For each account that exists, answer §6.6's assumed list from the panel or a live test (documentation does not count). From a **GitHub-hosted runner** in a throwaway repo (the O-4 test org once it exists), log in with a candidate principal over the candidate transport, upload a test tree to a throwaway document root and read it back over HTTPS; show the principal is refused on a second root; deploy and tear down one static and one PHP throwaway site, slot count equal before and after. Output: a gitignored `*.local.md` plus a counts-only note in §6.6. Marks K1 to K3 (§6.1) tripped or clear; a tripped K1 goes to the owner before anything else starts | orchestrator, with the owner at the panel | O-8; hPanel access, entered by the owner and never pasted into chat or the repo | PLANNED |
| M6-P6c | **Record the ruling (HSR-11).** WSK-D79 in §14 with the owner's ratification date; D32 marked amended (as D31 was by D35); §00a, §07's "re-point" sentence and §12's P6 row carry the §6.1 text; the replatform plan's header names the id it took | junior (Haiku) | O-1 | **DONE 2026-10-12 (docs):** WSK-D79 recorded in design v2 §14, amending D32's delivery list and §12 P6 |
| M6-P6d | **Per-site deploy secrets in M6-P4g.** In the P4 gate's test org: a repo with a `webdev_sites` row and a `CONTRACT.lock` on its default branch is granted its own per-site secret and the gate flag, and a second repo reads the first's secret as empty; a repo missing either is granted nothing and its deploy job fails naming what is missing; a per-site secret that does not exist yet leaves the grant `pending` in the console, and creating it then re-running completes it once; no code path creates or changes a secret's value, only its repository list; the principal's vault record exists and its reveal needs an approval (VLT-3, in code). If P4g has not merged, this is an amendment to its brief, not a follow-up | senior-be (opus·high: the credential boundary and the same seat as P4g; starting cheaper would waste a re-run) | O-7, M6-P4g, M6-P6b (K2) | PLANNED |
| M6-P6e | **The transport:** a deploy script the template runs, SFTP or FTPS as M6-P6b decides (§6.3). On `sumopod`, against a real sshd and a real FTPS daemon in containers (no local Docker): a docroot-locked principal uploads to a new release directory, verifies against the manifest, activates, and the stamp read over HTTPS shows the new build; a kill after N files leaves the previous release serving, byte-identical; a flipped byte refuses activation; principal A is refused on root B by the daemon, not by the script; a mismatched certificate, an unpinned host key and plain FTP are each refused; a canary credential never reaches a log; two simultaneous deploys leave one complete release; the last three releases are kept and one rollback is run | senior-integrator (Sonnet) | M6-P6b | PLANNED |
| M6-P6f | **The templates' deploy jobs, per kind:** one job that answers a push (staging) and the ERP's `workflow_dispatch` (inputs `approval_id`, `kind`, `published_at`), with the build in a job that never sees the deploy credential and writes the WSK-60 build stamp (`webdesk-build.json`: at the site root for static, inside the theme directory for wp), so every deploy can be read back. **static:** build, upload, stamp read back; a push to another branch deploys nothing. **wp:** writes only `wp-content/themes/<theme>/`; checksums of `wp-config.php`, `uploads` and other plugins unchanged; an artifact path outside the theme is refused. **fullstack:** verify runs, the deploy job refuses with the named reason (O-6) and uploads nothing. All three: `actionlint` clean, a concurrency group per site and environment with no cancel-in-progress on deploy, `build-templates.sh` and the drift checks green, the three template repos updated by pull request | medior (Sonnet) + orchestrator on the template repos | M6-P6d, M6-P6e | PLANNED |
| M6-P6g | **Delivery binding in the registry.** An additive migration adds `hpanel` to `control_panel`'s CHECK (HSR-4: rebuilt from the live definition, with the standing test that every earlier value still passes); a command binds a site row to `host_kind = shared-hosting`, a `host_ref`, an `access` and a `vault_ref`, refuses another tenant's `vault_ref` and stores no host, user or path; a provisioned site's production row can be created from its staging row (the registry's unique domain index holds); the console tells "awaiting deploy credential" from "ready" | senior-db (Sonnet) for the migration, senior-be (Sonnet) for the command | M6-P6b | PLANNED |
| M6-P6h | **Rebuild and promote read the registry, not env JSON.** `WEBDESK_REBUILD_TARGETS` is no longer required (repo, workflow, ref, staging URL and the per-kind stamp path come from the registry; only `static` rebuilds on a publish, a `wp` theme reads `/v1` live and only promotes) and the proof site's entry keeps working across the switch (WSK-60's dispatch and stamp suites still pass). A production promote needs a HIGH approval from a decider holding `github_repo · deploy`, writes one ledger row per approval (`kind = promote`, an additive CHECK widening on `webdev_site_builds`) and is `live` only through a stamp read from the production URL; re-presenting a decided approval gets 404 and no second run; a promote with no granted production secret fails with a named reason and dispatches nothing | senior-be (opus·medium: a production dispatch is an authorisation decision on a shared chokepoint, and the live WSK-60 path must not regress) | M6-P6f, M6-P6g | PLANNED |
| M6-P6i | **Domain and DNS.** After a P4c2 claim, `webdesk.site.setDomain` (HIGH, always WS4) sets the WebDesk environment's domain on approval: CORS answers for it and refuses a lookalike, and the 501 is gone. The claim creates or links the `search_properties` row, unverified for a client (an internal site is verified only once the D36 sentinel exists, M5-G0), so MON-01 probes nothing it has no consent for. The console shows the records to create (type, name, target) and a read-only DNS check reports `pending` or `pointing`; HTTP and TLS checks wait for the property's `verified_at` (the design v2 §07 consent gate); no DNS API is called and no DNS credential is stored. The rollback is run once on a test domain | senior-integrator (Sonnet; opus·medium only if the WS4 pairing for `setDomain` resists) | M6-P6g, M6-P4c2, O-12 | PLANNED |
| M6-P6j | **Retire the control-plane deploy seams (HSR-5, 6, 7, 12, 13).** No tool description, README, fixture or persona text names `delphi`/`helios` as a delivery target for new sites; `webdesk/deploy` is marked retired and its `deploy()` removed or failing closed; the hub's reachability tool says it is retired and answers accurately; the release-transport error text no longer tells an operator to configure a retired host; the capability inventory is regenerated | medior (Sonnet) | M6-P6f | PLANNED |
| M6-P6l | **The fullstack API on a Node host (WSK-D79, O-6 option A).** The template's `apps/api` (Nest) deploys from the site's own CI to `delphi`/`helios` by default: a per-site principal, a process manager unit, a reverse-proxy vhost, health checked after deploy; the static `apps/web` export takes the static path. Stateless until the template's database question is ruled | senior-integrator (Sonnet) + orchestrator on the hosts | M6-P6b, M6-P6e | PLANNED |
| M6-P6k | **The operator runbook** `infra/runbooks/webdesk-site-delivery.md`: mint the principal, vault record, org secret and grant, bind, content key, staging deploy, DNS, promote, rotate, roll back. Done only when someone who has not read this plan runs it end to end from the page alone (the gate's first run): a runbook nobody has run is not DEV-VERIFIED | medior (Sonnet) | M6-P6d to P6i | PLANNED |
| M6-P6 gate | **One delivered site per kind, end to end, on the real accounts** (staging always; production once O-8 says it exists), on test sites under domains we own. **static:** staff click, and separately a signed PRD → repo, row, tenant, lock → principal and org secret per the runbook → push → staging live, stamp read back → a two-person publish → the rebuild reaches live → an approved promote → production live under a test domain the owner points from the console checklist, TLS valid. **wp:** the same through the theme, with WordPress pre-installed by the operator, the three `GAIADA_WEBDESK_*` constants set, and the home page, an inner page and a 404 rendered from `/v1`. **fullstack:** provisioned, deploy refused with the named reason, nothing uploaded. **Each negative control run and seen to fail:** a repo without the grant; a wrong credential (the previous release unchanged); site A's credential on site B's root; an unapproved promote; a kill mid-upload. **Teardown:** slots, principals, secrets and registry rows back to the starting count. A green suite does not count: the legs are driven on the real hosts | qa (Sonnet) + orchestrator; the owner at the panel and at DNS | M6-P6b to P6k, M6-P4g, the P4 gate's test org (O-4; not yet created, §5 release 365), O-8, O-9 | PLANNED |

## 4 · Order

1. **First, with no owner input:**
   - M6-P3a measures the live side;
   - M6-P4a closes §06, the first build item §12 names;
   - M6-P3f fixes the stale text, small enough to run inline.
2. **Then, one agent at a time:**
   - P3: M6-P3c, then M6-P3e;
   - P4: M6-P4r, then M6-P4b0, then M6-P4b1, then M6-P4c, then M6-P4b2, then M6-P4e and M6-P4f;
   - P5: M6-P5a, then M6-P5c, M6-P5e, M6-P5d and M6-P5b, then the P5 gate. P5 runs independently of P4, apart from M6-P4d using its theme.
3. **Once the owner answers:**
   - M6-P4d after O-2;
   - M6-P4g after O-1 and O-3;
   - the P4 gate after O-4;
   - P6 after O-1 (§6.4 has the order; M6-P6b only reads, so it may start earlier).

## 6 · P6 · Client delivery (O-1 ruled 2026-10-12: WSK-D79, targets per site)

### 6.0 The ruling, and what it changes in this section

**The owner answered O-1 on 2026-10-12:** "some would be on shared Hostinger, some would be on `delphi` or `helios`. It depends." Recorded as **WSK-D79** in design v2 §14. **O-6 (fullstack) was answered the same time: option A**, a static-export web half plus the API on a Node host (`delphi`/`helios` by default). §6.1 to §6.6 below are the proposal as drafted; where they say "Hostinger only" or "retire `delphi`/`helios`", this block wins:

- **Targets are per site.** The registry row carries the target (M6-P6g binds `host_kind`/`host_ref` per site). P6b surveys BOTH the Hostinger accounts AND `delphi`/`helios` (their CloudPanel sites, SSH/SFTP reachability from a GitHub-hosted runner, and Node for the fullstack API). Note `delphi` SSH is mesh-only today (CI reaches it through the tunnel-only `wdjump` on `sumopod`).
- **One transport, two kinds of root.** M6-P6e's site-CI script deploys into a Hostinger document root (SFTP/FTPS) or into a `delphi`/`helios` site directory (SFTP/rsync over SSH); the per-site credential is still docroot-locked and granted by M6-P4g.
- **M6-P6j keeps `delphi`/`helios` as targets.** It still retires the control-plane executor (`webdesk/deploy`, D29); it no longer removes the two hosts from tool and README text.
- **New M6-P6l: the fullstack API leg.** The Nest API deploys to a Node host per WSK-D79 (process manager, reverse proxy, its own per-site principal). The template still has no database layer (an open owner decision), so the API ships stateless until that is ruled; the static web half is the static path.
- **The legacy-estate migration** (R5/R6) stops being a blanket move; each existing site keeps or changes its host by the same per-site rule. It remains a separate track that P6 does not block on.


*Placed above the log so the log stays the last section; nothing was renumbered.*

**A proposal, not a ruling** (M6-P6a, drafted 2026-10-12 on main `a7818a6b`). Nothing here is built, and nothing was run
against any host, account or DNS. It needs the owner's answer to O-1 (§2). This repository is public, so the section carries
decisions and counts only: no client, domain, host address, account or credential.

### 6.1 The decision, and the recommendation

**O-1, restated.** WSK-D32 still names `delphi` (staging) and `helios` (production) as the client-delivery hosts. On
2026-09-04 the owner directed that client delivery move to Hostinger shared hosting (production on an Agency Startup account,
staging on the existing WordPress shared account) and that `delphi`/`helios` stop carrying client sites
(`docs/plans/2026-09-04-hostinger-shared-replatform.md`). The decision log never recorded it. O-1 asks the owner to **ratify
that direction (a)** or **keep `delphi`/`helios` (b)**. Ratifying takes the next free id, **WSK-D79** (D78 was taken on 2026-10-12 by the `site.archive` ruling;
re-check when it lands, since D74 to D79 were all dated 2026-10-12), and amends D32, §00a, §07 and §12 P6.

**Recommendation: (a), for new client sites.**

- *It is the owner's own direction.* O-1 records a choice already made; (b) would reverse it.
- *(b) builds on hosts the owner has directed away from.* Every site P6 delivered there would be migration debt on day
  one. The only platform-driven deploy that has run live (WSK-60) needed a tunnel-only jump user, a forced command and a
  root-owned config for a single site, because `delphi` admits SSH only from the mesh.
- *Shared hosting fits two of the three kinds.* `static` is a folder of files. `wp` is PHP and MySQL, WordPress stays on
  Hostinger permanently (§00a, §12 P5), and the headless theme keeps no content in WordPress's database.
- *It does not fit the third*, `fullstack` (§6.2). That is the price, and it is named here, not hidden.

**Three tripwires in M6-P6b**, which measures what the 2026-09-04 plan only assumed. **K1:** no transport the site's own CI
can use from a GitHub-hosted runner (the first WSK-60 run built and then timed out reaching `delphi`; the same trap may wait
here). K1 alone reopens O-1: the owner would choose between a runner or jump we operate, another static host, and (b).
**K2:** no way to mint a deploy principal locked to one document root on the account that also carries live client
WordPress. Delivered sites then need a dedicated account, which departs from the 2026-09-04 direction. **K3:** no free slot
on staging for the gate's three sites and no retention rule (O-9, O-10); the gate waits and nothing is deleted.

**Proposed text, not a ruling:**

> **WSK-D79 (PROPOSED) — Client delivery is Hostinger shared hosting; `delphi` and `helios` stop being delivery hosts for new
> client sites (owner direction 2026-09-04). Amends WSK-D32.** The role zoning stands: control plane `gda-aicenter`, client
> delivery, observation `sumopod`. Two Hostinger shared accounts fill the delivery role, production on an Agency Startup plan
> and staging on the existing WordPress shared account [the split is subject to M6-P6b]. Consequences: delivery hosts have no
> root, no Docker, no daemons and no arbitrary runtime, so a kind that needs one (`fullstack` with a Node API) is provisionable
> but delivered only where its runtime has been ruled; the deploy channel is file transfer into a document root, **run by the
> site's own CI** (WSK-D29, WSK-D48) and never by the control plane; each deploy credential is a per-site principal locked to
> one document root (WSK-D33 option (c)) [subject to M6-P6b]; every row the platform delivers is `host_kind = shared-hosting`.
> It covers client delivery only, not the company's own products, and it moves no existing site: the legacy estate migrates in
> a separate program with its own deadline (OQ-3.1). WordPress stays on Hostinger, WebDesk stays on `gda-aicenter`, and the
> observe-only ruling on client-owned hosts is unchanged.

The §12 P6 row would read: **P6 · Client delivery.** *Shared-hosting delivery (WSK-D79): the site's own CI deploys into a
per-site document root, deploy credentials are per-site principals granted by the ERP (WSK-D29), plus domains and DNS.
Migrating the legacy estate is a separate program.* Gate: *one delivered site per kind on the real accounts, end to end, with
every refusal proven; `fullstack` refused until its runtime is ruled.*

### 6.2 The fullstack problem

**A shared host cannot run a Node server, and a Nest API has no path to its data either.** The 2026-09-04 plan already
assumed `next start` does not run on shared hosting (its §3) and found two Node apps on `helios` that cannot move (its §10.2);
whether Agency Startup's "web app" feature changes that is UNVERIFIED (its §11). One thing is new since that plan: the
`fullstack` template's Nest API is meant to persist to the unified WebDesk Postgres (Tension A in
`docs/blueprints/site-provisioning-templates.md`, still an open owner decision; the template ships no database layer). That
database has no published port, sits on its own network, and the project's egress is default-deny (design v2 §03 ACs 2, 4 and
6, WSK-D63), so no outside host can be given a login to it without breaking the containment statement. The API therefore
cannot run on shared hosting (no runtime), nor on any other outside host that needs the data (no path to it), nor beside the
data, because D32 keeps client deliverables off the control plane.

| Option | What ships | Trade-off |
|---|---|---|
| A. Static export of `apps/web` only; the API runs elsewhere | The web half rides the `static` pipeline (`output: "export"`: no SSR, ISR or API routes) | The API still needs a Node host, and the template needs an export mode. A stateless API (today's template) could live on any Node host; one that needs the unified database could not |
| B. A Node host: client-owned (D32 already lists client-owned servers) or one of ours | Both halves, deployed by the same CI over SSH | One of ours re-creates the kind of box the owner is retiring (capacity, patching, backups, monitoring). Client-owned means per-client variance and per-client credentials |
| C. Defer: `fullstack` stays provisionable (repo, row, tenant and lock all work from P4) and its deploy job refuses with a named reason | Nothing is delivered | No fullstack client site goes live through the platform until the owner chooses. The gap shows in the gate instead of being papered over |

**Recommendation: C for P6.** The gate's fullstack leg is a verified refusal: the site deploys nothing and says why. The
trade-off is one kind left undelivered, accepted because no fullstack site has been provisioned through the platform yet (the
P4 gate is PLANNED; the legacy Node and Next sites are the migration track's, OQ-3.4 and OQ-3.10), the template's API is a
health endpoint, and A and B each need a host and a data decision the owner has not made. After M6-P6b answers the
replatform plan's six questions (its §11.4) the owner picks between A and a client-owned B; a Node host of ours is not
recommended. If Agency Startup turns out
to give a long-lived process with a port, this changes for the stateless case. The same gap blocks WSK-D52's instant preview,
which needs a one-route Node render service on the staging host; the static template has none today, so P6 loses nothing it
has.

### 6.3 The deploy path P6 builds

**The executor is the site's own CI, which changes the replatform plan's HSR-5.** WSK-D29 and WSK-D48 already put each deploy
in the repo's own Actions workflow, and WSK-60 proved that live (dispatch, build, deploy, build stamp read back, 2026-10-11).
HSR-5 would instead replace `webdesk/deploy`'s ssh+rsync with an SFTP/FTPS driver in the control plane. That driver has never
run for real and has no caller, and a control-plane executor is what D29 refuses (the ERP holds no SSH key and deploys
nothing). So the transport is **a script the template's deploy job runs**, and `webdesk/deploy`, the hub's reachability tool
and the release-transport seam's text are retired (M6-P6j), not ported.

**Transport.** SFTP over the account's SSH if the plan has it, otherwise FTPS (explicit TLS, certificate verified, never
plain FTP). M6-P6b decides, because the choice is also the isolation choice: an FTP account can usually be locked to one
directory, while one SSH user usually owns the whole account (both unverified). CI pins the host key or verifies the
certificate and never trusts a host on first use (the WSK-60 rule). The build runs in a job that never sees the deploy
credential (it holds only the content read key) and hands a manifest-checked artifact to a deploy job that holds the
credential and runs no package manager. That job uploads to a new release directory beside the document root, verifies it
against the manifest, renames it into place, keeps the last three, and reads the site's build stamp back over HTTPS.

**What the host used to enforce moves into the pipeline.** On `delphi` a root-owned forced command validated the tree and
swapped one docroot. Shared hosting enforces nothing of the kind, so the manifest, a minimum page count and the stamp
read-back are the controls. That is weaker, and it is said here so nobody assumes otherwise.

**One deploy job, two triggers.** A push to the default branch deploys staging. The ERP's dispatch (WSK-60's chokepoint:
`github_repo · deploy`, which refuses without an approval id) rebuilds staging after a publish and, only on an approved
promote, deploys production. Today the template has the first trigger, and one hand-built site has the second, wired by one
line of env JSON (`WEBDESK_REBUILD_TARGETS`); M6-P6f and M6-P6h make both come from the template and the registry. Each site
has two environments and no ephemeral previews (OQ-3.3's default), because a preview would take a plan slot.

**Credentials: four classes, and only the first is the deploy credential.**

| Credential | Minted by | Lives in | Reaches the site's CI as |
|---|---|---|---|
| Deploy principal, one per site and environment, locked to one document root (WSK-D33 option (c)) | An operator, on the host | The ERP vault as a record (`integration_connections`, provider `ftp` or `ssh`, VLT-1; `webdev_sites.vault_ref` points at it) for custody, reveal and rotation | An org Actions secret per site and environment, created by hand by an org owner, visible to exactly one repo, granted by M6-P4g |
| The gate flag `WEBDESK_DEPLOY_GRANT` | The org owner, once | An org secret | Granted by M6-P4g, as the templates already expect |
| Content read key, production environment (WSK-66 `key.mint`) | WebDesk, on approval; the plaintext shows once | A repo secret (static, fullstack web) or `wp-config.php` (wp) | Pasted once by the operator, as in WSK-60 |
| The ERP's own GitHub App credential | GitHub | platform-nest | Never |

Never held: a client's master panel login, the account owner's hPanel login, or Hostinger's API token (account-wide, with no
scoping: `docs/plans/2026-08-21-multi-server-observability.md` §13(b)).

**Why one principal per site.** An org secret is readable by every workflow in every repo granted to it, and anyone who can
push a workflow to such a repo can print it. One account-wide credential would let every site repo write to every document
root on the account, and the staging account also carries live client WordPress. D29's org-secret design was written for a
fleet key on boxes we run; with per-site principals a leaked secret costs one site, which is what makes the design safe on
shared hosting. The cost: every site and environment needs a hand step on the host (no panel API is known) and an org secret,
a few minutes each, and the credential then has **two copies** (vault and org secret) that a rotation must change together
(VLT-5 gains a step). The alternative, the ERP writing the org secret from the vault, gives one entry point and no drift, but
the ERP would then hold the value, which D29 says it never does. Not recommended (O-7).

**M6-P4g must change before it ships.** As specified (§2) it grants a repo a fixed set of org secrets. P6 needs it to grant the
per-site secret too (its name derived from the site key) and to treat "that secret does not exist yet" as a `pending` state the
console shows and a re-run completes, not an error. P4g is being built now, so M6-P6d hands its builder this note instead of
reopening the work after it merges.

### 6.4 Order, and what P6 does not do

The tickets are the P6 rows of §3, each with its done-when. In order:

1. **M6-P6b and M6-P6c first, in parallel.** P6b only reads, so it may start before the owner rules if the owner wants the
   evidence first. This plan recommends ratifying and starting it together: D79 marks its two R1-dependent clauses, so P6b can
   reverse those, and only K1 reverses the direction. P6c records the ruling, because no ruling exists outside the log.
2. **M6-P6d and M6-P6e, in parallel** (the owner allows two agents at a time): the credential model into P4g, and the
   transport with its container harness on `sumopod`. Then M6-P6g.
3. **M6-P6f** (needs d and e), then **M6-P6h and M6-P6i**, then **M6-P6j and M6-P6k**, then the **gate**. At most one Opus
   dispatch per usage window: P6d (opus·high) and P6h (opus·medium) sit far apart.

**How the replatform plan was re-cut:**

| Replatform item | In P6 |
|---|---|
| R0, the accounts half; R1; HSR-1 | M6-P6b |
| R0, the boxes half (a vhost survey of `delphi`, `helios` and `gda-ce01`); HSR-2, HSR-9; OQ-3.5, 3.7, 3.9, 3.10, 3.11 | Not P6: the migration track |
| R2 staging cleanup | Only if O-9 needs it |
| R3 prove the path | Replaced by the P6 gate, which proves new-site delivery rather than a migrated site |
| R4: HSR-4 (`hpanel`), HSR-8 for new rows | M6-P6g |
| R4: HSR-5, 6, 7, 12, 13 (the deploy seams and the text that names the retired hosts) | M6-P6e builds the replacement (a CI script, §6.3); M6-P6j retires the seams |
| HSR-10 vault entries | M6-P6d (VLT-1 is already in code; no new migration) |
| HSR-11 the ruling | M6-P6c |
| R5 client waves, R6 decommission, HSR-8 (legacy rows), HSR-14 | Not P6: the migration track |
| No ancestor in the replatform plan | M6-P6h (WSK-60 reads env JSON and has no promote), M6-P6i (P4c2 left the domain at the ERP), M6-P6k (the runbook) |

**The legacy estate is a separate track, and P6 does not block on it.** M6's P6 is "new client sites can be delivered".
Moving the legacy estate (81 registry rows at the 2026-10-12 read: 30 production, 50 staging, 1 development) is the replatform
program's job, at its own pace (OQ-3.1): R0's boxes half, R2, R5, R6 and the HSR rows above. P6 does none of it and waits for
none of it. The dependency runs the other way: the migration's first wave can reuse P6's rails (transport, credential model,
domain checklist) once they exist, and the proof site's rebuild, the one live consumer of `delphi`'s forced command (WSK-D56),
moves on that track onto P6's transport.

**P6 does not** move or delete any site, call a DNS or hosting API, buy an account, run a Node runtime, build previews, change
where WebDesk runs, or hold a client's panel login.

### 6.5 Owner questions

O-1 is in §2; O-6 to O-12 are new. Each has the default P6 works to if it stays unanswered.

| # | Question | Default if unanswered | Why P6 needs it |
|---|---|---|---|
| O-1 | Ratify the 2026-09-04 direction as WSK-D79 for new client sites, or keep `delphi`/`helios` (§6.1) | P6 waits and nothing is built. **Recommended: ratify** | Everything  **ANSWERED:** per-site targets (WSK-D79) |
| O-6 | The `fullstack` runtime: A (static-export web, API on a Node host), B (client-owned Node host) or C (defer) (§6.2) | **C**: provisionable, deploy refuses with a named reason | The gate's fullstack leg; M6-P6f  **ANSWERED:** A, the API on a Node host (`delphi`/`helios` by default) |
| O-7 | The deploy-credential model: per-site, docroot-locked principals, one org secret per site and environment, created by hand by an org owner, the ERP only granting (recommended); or the ERP writing the secret from the vault; or one account-wide secret per target (D29 as written) (§6.3) | Per-site, by hand | M6-P6d, because P4g is being built now |
| O-8 | Does the production (Agency Startup) account exist, and if not, when will it? (OQ-3.2, narrowed) | Treated as not existing: M6-P6b surveys staging first and the gate's production leg waits | M6-P6b and the gate |
| O-9 | Does the staging account have room for the gate's 3 sites and the first delivered ones? | If M6-P6b finds 3 free, nothing. If fewer, the gate waits and the owner is told; nothing is deleted without O-10's written rule. The expected remedy is the replatform plan's §7 sweep of blank auto-scaffolds (the "Ours" bucket: no files changed, no DNS, no registry row), archived first | The gate (K3) |
| O-10 | OQ-3.6, the staging retention rule | Nothing is deleted (the replatform plan's own default). P6 needs it only through O-9 | Only through O-9 |
| O-11 | OQ-3.1, when `delphi`/`helios` stop being paid for | No deadline; the boxes stay up. P6 does not need it: it sets R6's pace, which P6 does not touch | Nothing in P6 |
| O-12 | DNS (OQ-3.8, narrowed): who changes the records for a delivered domain | The owner for our domains and the client for theirs, from a checklist the console shows; no DNS credential is stored and no DNS API token is requested (WSK-D43 and D61 went this way) | M6-P6i |

### 6.6 What is already true, and what is assumed

Read from main `a7818a6b` on 2026-10-12 unless a row says otherwise. Nothing was run against a host.

| Claim | Source |
|---|---|
| **True.** The 2026-09-04 direction exists and is unratified; its draft id, D37, was taken by the Payload ruling, and D78 by the `site.archive` ruling, so it takes D79 | Replatform plan header; design v2 §14 numbering note |
| **True.** The three templates' deploy jobs are placeholders gated by the org secret `WEBDESK_DEPLOY_GRANT` and refuse without `CONTRACT.lock`. P4g is not on main, and the App's org-secrets permission is not in effect (the installation holds the repository `secrets: write` only, measured 2026-10-12) | `webdesk/templates/*/.github/workflows/site.yml`; this plan's §2 and §3 |
| **True.** The scaffold commit refuses `.github/`, so a deploy fix reaches an already-generated repo by pull request only | `docs/plans/2026-10-12-webdesk-m6-p4b2-scaffold-commit.md`, check 6 |
| **True.** `webdesk/deploy` has never run, has no caller, exposes only `/probe` and hardcodes `delphi`/`helios`. The only platform-driven deploy that has run live is WSK-60's, to the proof site on `delphi`, with repo-level secrets set by hand, through a tunnel-only jump | `webdesk/deploy/src/config.ts`, `server.ts`; `infra/runbooks/webdesk-staging-rebuild.md`; `docs/plans/2026-10-10-webdesk-gaiada-proof.md` |
| **True.** A provisioned row has no host binding (`host_kind` `unknown`, `access` `none`) and a `.invalid` domain. P4c2's claim is DEV-VERIFIED, `webdesk.site.setDomain` is a 501 stub, MON-01 reads only `search_properties`, and WebDesk answers CORS only for an environment's own domain | `provision-completion.service.ts`; this plan's M6-P4c and M6-P4c2; `docs/plans/2026-10-11-gaiada-site-briefs-preview-and-media.md` |
| **True.** The registry and vault already model the target: `shared-hosting`, `access` `ftp` and `ssh`, vault providers `ftp`, `ssh`, `cpanel` and `wp_admin`, `vault_ref`, reveal approvals and lifecycle columns are in code. VLT-4's import and VLT-5's runbook were never run, and HSR-4 (`hpanel`) is not done | Migrations `202608300747`, `202609040401`, `03`, `05`; `docs/plans/2026-09-04-client-hosting-credential-vault.md` |
| **True.** The `fullstack` template is Next + Nest with no database layer and no static export | Template README, `next.config.mjs` |
| **Counts, a month old.** `helios` carried 9 client sites (7 portable, 2 Node), `delphi` 24 vhosts (17 previews), `gda-ce01` 8 production rows, the staging account 49 registry rows. The registry today holds 81 | Replatform plan §10, §11; this plan's M6-P3a |
| **Assumed, M6-P6b settles.** A GitHub-hosted runner can log in over SFTP or FTPS to a shared account; a principal can be locked to one document root, and what it can see outside it; which transport each plan offers; whether the docroot can be renamed or swapped; free TLS once DNS points; PHP versions against the theme; outbound HTTPS to the WebDesk host; whether any panel API can create principals (none is known) | The same trap hit `delphi` (runbook step D2) |
| **Assumed, M6-P6b and O-8.** The production account exists; the staging account's cap and free slots; a stable staging hostname (33 of 49 staging URLs failed at the CDN edge from outside on 2026-09-05, an account state rather than 33 dead sites) | Replatform plan §10.6 |
| **Assumed, M6-P6b.** A CDN fronts delivered sites and may cache HTML or the stamp. If so, D50's trigger for WSK-70 ("a CDN fronts a delivered site") is met and it leaves deferral | Replatform plan §10.6 (the auto-URLs resolve to a Hostinger CDN) |
| **Unverified.** A Node "web app" runtime, its process model and limits; whether the org's GitHub plan allows org secrets on private repos (P4g's first grant proves it) | Replatform plan §11; this plan's §2 |

**Stale or contradictory, found while reading.**

- The replatform plan's §10 counts are a month old and were taken for another purpose; its §11 (the same day) already
  retracted §10.3's "effectively all of `delphi`". **The re-survey must be re-run, as R0,** before any migration decision. P6
  needs only its accounts half (M6-P6b).
- `webdesk/deploy`'s README calls `delphi`/`helios` live cPanel/WHM boxes; the replatform plan's §10 found CloudPanel hosts.
- Design v2 §10 lever 2 says content edits stop being builds on adopted sites; D41, D48 and D53 make an adopted static site
  rebuild on every publish.
- Design v2 §07 says adoption on `delphi`/`helios` is "a re-point, not a rebuild"; HSR-9 says that holds for static sites only.
- `site-provisioning-templates.md` still plans Payload, MinIO and a Cloudflare Pages target with a `deploy.yml`, and says the
  templates do not exist; they exist and use none of those.
- This plan's §2 O-1 row says the replatform needs OQ-3.1 and OQ-3.6 "before anything else"; the replatform plan holds only
  R2 onward for them, and P6 needs neither (O-10, O-11).

## 5 · Log

- **2026-10-11:** plan written from a read of `origin/main`. Three read-only surveys, one per phase; the claims this
  plan rests on were then rechecked by hand. The shared checkout was 465 commits behind main, so nothing was read
  from it.
- **2026-10-11, M6-P3f:** stale text fixed (`26573f95`).
- **2026-10-11, M6-P3a (part):** MON-01 measured on the boxes: the `client-properties` job exists on `sumopod`, its
  target file has been an empty list since 2026-09-01 and Prometheus holds zero series for it, and `gda-aicenter` has
  no cron or timer for the sync. The registry and property counts wait on a read-only query the owner runs.
- **2026-10-11, M6-P4a:** dispatched to a Sonnet senior-integrator on branch `webdesk/m6-p4a-snapshot-by-id`; reviewed, merged, and DEV-VERIFIED on `sumopod` (gate `m6p4a`). The gate's mcp-hub run first showed 1 failure: `server.test.ts` expects the in-code policy engine and the gate script had set `CERBOS_URL`. Re-run without it: 28/28 files green.
- **2026-10-11, M6-P5a, P5c, P5e:** reviewed and merged. Review changes made by the orchestrator: P5c's link allow-list widened to bare relative paths (backslash still refused). Two defects found in review became tickets (P5c from P5a, P5e from P5c).
- **2026-10-12, M6-P4r-a DEV-VERIFIED on `sumopod`:** two no-cache image builds give the same block-library tarball (`f00fb6b7…`, also equal to a Windows pack, so the mode normalisation works); LABELs set from the pre-pack; a wrong `BLOCKS_SHA256` fails the build with the expected message; the compiled generator loads read-only and lists its 11 exports; the api boots read-only; image 353 to 366 MB; planner tests 19/19; WebDesk gate `p4ra`: webdesk-api 1248/0, legacy 16/16 incl. the new `m6-p4ra-codegen-gate-dist`. M4 reviewed the image, `.dockerignore`, release.yml and compose changes: OK; watch the first release's `deploy-webdesk` job.
- **2026-10-12, M6-P4r-a and local Docker:** the P4r-a brief told the subagent to build the api image on the laptop. Its first build sent the whole `webdesk/api` directory (with node_modules) as context and wedged Docker Desktop, around the time the owner ordered no local Docker at all (laptop out of memory and disk; relayed by the M3 session). The brief was changed mid-run, the image proofs moved to `sumopod`, and the local CLI now hangs, so one image the subagent built (`wdapi-before`) may still be on the laptop. From here every brief says no local Docker. P4r-a itself is on branch `webdesk/m6-p4ra-compiled-codegen` (`17bc742f`, review fix `7b6bc518`): esbuild bundle `dist/codegen/generator.mjs`, `generateTenantContract()`, `codegen:gate:dist` (compiled vs compiled vs tsx, 5/5 byte-identical for two fixture tenants, with a negative control), the `./webdesk` context and `.dockerignore`, the blocks stage with sha256 and version checks and LABELs, release.yml's pre-pack step, and `deps` in the release planner.
- **2026-10-12, release 362 (cut by the M6 session, owner-approved):** the first M6 batch (`f6e39a83`) plus M5-L1d/W2d. Release run 38204480203 green; `applied: 202610111808…`; `Recorded v1.0.0-alpha.362`; `deploy-webdesk` green (M4's post-deploy checks green: api 57 MiB idle, codegen worker registered, containment 40/40). Live Cerbos probe for `resource_webdev_site`: ALLOW (company_admin, in tenant) and DENY (no grant; low assurance) pass, matched `resource.webdev_site.vdefault`.
- **2026-10-12, full gate `m6g3`** (main `7fbe490` + the branch): platform-ui 5525 passed and `next build` clean; webdesk-api 1132/0 (`m6wd2`). platform-nest showed 2, then on a re-run 3, failures, none in M6 code: the auto-merged `CAPABILITY-INVENTORY.md` (regenerated since, `309b00e9`, 160 capabilities, 5/5 locally against the current tree), and three load-sensitive tests at load 20 to 26 (`mail24-timing-remeasure`, `pull-scheduler-qa-adversarial`, `report-export` 10k rows); the latter two passed when re-run alone at lower load, and the timing test passed on the re-run. The final pre-merge gate re-runs the full suite on the then-current main.
- **2026-10-11, vendored file:** M6-P3f's comment edit in `webdesk/api/src/delivery/vocabulary/cache-tags.ts` changed a VENDORED copy of `webdesk/delivery/vocabulary/cache-tags.ts`, and the WSK-48a drift spec failed on Linux. The source now carries the same comment. Vendored vocabulary files are edited only at the source, then re-vendored.
- **2026-10-11, line endings:** the shared repo config now sets `core.autocrlf=false`, so a worktree checked out earlier with CRLF commits CRLF. One commit (`f97acaab`) stored the design doc with CRLF; the merge with main re-applied its five changed lines onto main's LF text, and the worktree was re-checked-out as LF. Before committing, check that staged blobs carry no carriage returns.
- **2026-10-12, batch 3** (`webdesk/m6-batch3`: M6-P4b0, P4b1, P4c, P3e, P4e and the P5 harness): gate `m6b3c` (platform-nest 9150/0, mcp-hub 390, ai-agents 409, webdesk-api 1786/0, legacy 16/16, promtool SUCCESS; codegen peak RSS 166–167 MiB, sent to M4), then `m6b3d` on the final head with P4e (platform-nest 618 files / 9179 passed / 0 failed, mcp-hub 390, ai-agents 409, blocks 40/40 and `astro check` clean, `php -l` 17/17 and the four PHP probes 29 + 64 + 47 + 62); P5 gate `p5g1` 65/65. Review fixes made by the orchestrator: the block library moved to a content-addressed key (a version-only key would have collided under GOVERNANCE lock), the mirror test stopped reusing contract version 4.0.0, and the PRD extraction now writes the `Stack:` line `wd-provision` reads (without it every automated provisioning would be refused). Merged to main and released with migration `202610120425`; after the deploy, both n8n workflows are re-imported with the CLI (`wswdprovision0001`, then `ws11delivery0001`), and the `contract.regenerate` backfill is a MEDIUM decision for the owner, announced to M4 first.
- **2026-10-12, release 363 (cut by the M6 session):** batch 3 merged as `f49ec96c`, VERSION `dcef20a1`, CI run 38209735615 green, release run 38210338459 green (both deploys). Deploy log: `applied: 202610120425…`, Cerbos restarted (`resource_mcp_tool` changed), "all services healthy", `Recorded v1.0.0-alpha.363`; M4's WebDesk checks green (api 56 MiB idle, codegen worker registered, probes 40/40). n8n on `gda-aicenter`: the deploy does not ship `automation/workflows/`, so both workflows were re-imported with the CLI after a backup export of the live delivery flow. `wswdprovision0001` had never been imported live, so the delivery flow's provisioning call had been a dead reference until now. The import deactivated the delivery flow, which was re-activated (`update:workflow`) and n8n restarted; every active workflow came back. The `contract.regenerate` backfill still waits for the owner's go-ahead.
- **2026-10-12, batch 4** (`webdesk/m6-batch4`: M6-P4b0b, P4c2, P3b): gates `m6b4` (platform-nest 9210/0) and `m6b4w` (webdesk-api 1796/0), then `m6b4b` with P3b and the then-current main (platform-nest 619 files / 9231 passed / 0 failed). Found by P4c2: the placeholder domain never reached WebDesk, and `webdesk.site.setDomain` is still a 501 stub, so giving a delivered site's WebDesk environment its domain is open work outside M6-P4c2. New ticket M6-P4e2 (a parked code stage resumes on `webdev.site.contract_pinned`), sequenced after M6-P4b2 because both edit `pipeline-delivery.json`.
- **2026-10-12, M6-P4d2 and M6-P4b2:** P4d2 merged as `b65e8c50` (templates and `code.scaffold` on Next 15.5 + React 19 and vitest 4, site CI on Node 24; template repos re-published). Its first Linux run found npm 10 crashing on vitest 4 beside the `file:` vendor tarballs; a local run on Node 24 had hidden it. P4b2 reviewed: the write path, the integrity checks, the path rules and the two Cerbos gates; Opus seat, about 100 minutes. Its gate `m6b6` caught a uuidv7-prefix slug collision in its own DB tests. The review also measured the ERP App installation and found O-3 not in effect (see §2).
- **2026-10-12, batch 7** (`webdesk/m6-batch7`: M6-P4e2, P4e3, P4d3, P3d): gates `m6b7` (platform-nest 9318/0), `m6b7t` (`build-templates.sh` 12/12), `m6b7a`/`m6b7b` (ai-agents 398 then 468 with Postgres, mcp-hub 396), `m6b7c` (platform-nest 9345/0). The owner approved P3d's box work and the `contract.regenerate` backfill the same afternoon; the M6 session's owner-account login failed and was not retried, so the backfill is the owner's own run. Versions renumbered at merge above M5's G5d (platform-nest 0.85.0, ai-agents 0.14.0). Release 365 also carries M4's `deploy-webdesk` force-recreate fix, the first real-image apply on the rootless daemon.
- **2026-10-12, release 365 (cut by the M6 session):** batch 7 merged as `4aa61ed3`, VERSION `865df7c9`, release run 38231902482 green. It was deploy-webdesk's first real-image apply on M4's rootless daemon, carried by M4's force-recreate fix. Before the tag: the MON-01 host dir, `CLIENT_PROPERTY_TARGETS_PATH` and the two `N8N_BRIDGE_*` additions went into the box `.env` (with backups), and the sumopod key and its `restrict,command=…,from=` line went into `authorized_keys`. After the deploy: `ws11delivery0001` re-imported and active; the sumopod pull run by hand, then its cron installed. MON-01 probes 37 properties, the first time since 2026-09-01, 35 of them successfully. Still open: the `contract.regenerate` backfill is the owner's own run (the session's owner-account login failed and was not retried); O-3 is not in effect (the App has repository `secrets: write` only); the P4 gate needs a GitHub test org; P6 waits for O-1. Small follow-up: `webdesk/templates/publish.mjs` copies but never deletes, so a file removed from a template (P4d3's `tailwind.config.ts`) had to be removed from the published repo by hand.
- **2026-10-12, M6-P6a:** the P6 proposal drafted as §6 on `webdesk/m6-p6a` (main `a7818a6b`), from a read of the replatform plan, design v2 §03, §07, §08 and §12 to §14, the ledger and vault plans, the templates' `site.yml`, `webdesk/deploy`, the WSK-60 runbook and the P4b2 design. Four findings changed the shape of P6. (1) The replatform plan's HSR-5 puts the deploy executor in the control plane; D29, D48 and the live WSK-60 path already moved it into the site's own CI, so the transport is a template script and `webdesk/deploy` is retired. (2) D29's org-secret design is only safe on a shared account if each secret is per site, because the staging account also carries live client WordPress. (3) M6-P4g, being built now, grants a fixed set of org secrets and must also grant a per-site one (M6-P6d). (4) The `fullstack` kind has no home on shared hosting and no path to its data (§6.2). Nothing was run against any host, account or DNS.
- **2026-10-12, M6-P4g and the P6 id:** P4g merged as `9757fd38` (gate `m6p4g3`: platform-nest 9665/0). The first gate run caught a CHECK that passed on NULL; the same defect was live in P4b2's `wps_scaffold_links`, re-declared NULL-safe by `202610130110` (no live row affected). The P6 proposal's id moved from WSK-D78 to **WSK-D79**: D78 was taken the same day by the `site.archive` ruling. That ruling builds `webdesk.site.archive` on the WebDesk side and does not touch the registry or the provisioned repo, so P4g's `revokeDeployForSite()` is not called when a WebDesk site is archived. Whether it should is open (M6-P4g2).
- **2026-10-12, O-1 answered (WSK-D79) and P3b done live:** the owner chose per-site delivery targets (Hostinger shared or `delphi`/`helios`) and option A for fullstack; recorded as WSK-D79, §6.0 added, P6c done, P6l added. The owner also asked the M6 session to run the internal-client setup: M5-G0 applied (sentinel "Gaiada (internal)" and gaiada.com's search property, verified, bound to its Umami site), then M6-P3b linked the 4 internal `webdev_sites` rows to it (a re-run reports `already=4`). The P4 gate will run in `gaiadabali` with throwaway `m6-gate-*` repos (owner, superseding O-4's test org).
- **2026-10-13, P4 gate run 1 (static, PRD path), four live findings.**
  - **The PRD fell back to echo.** The gateway's per-provider timeout (60 s) cut off GLM 5.3 Flash on the PRD prompt, and the chain answered with the echo provider (audit: `provider=echo latencyMs=60002`). It is now 180 s, set through the gateway's runtime override (`PUT /admin/config providerTimeoutMs`, persisted in `gateway-data`).
  - **The bridge redelivered.** `N8N_BRIDGE_TIMEOUT_MS` (120 s) was shorter than the design release (~130 s). The bridge redelivered `scope.signed` (n8n executions 2692 and 2693, 120 s apart), and a second `pm_review` opened on the same design. The box's `.env` now has 300000, platform recreated on 367. The code fix is M6-P4m.
  - **The contract pin never worked live.** Completion and the console read the WSK-19 stub (`WEBDEV_CONTROL_BASE_URL`, unset). The bundle's artifact URLs name WebDesk's internal `rustfs:9000` (`ENOTFOUND` from the ERP). The real four-layer channel answered `contract.read` for `m6-gate-static-prd` with 200. The fix is M6-P4j (WSK-D81).
  - **The repo check missed `tenantId`.** The fix is M6-P4k.
  - **How far run 1 got:** repo `gaiadabali/m6-gate-static-prd` from `template-static-astro`, registry row `live` and linked to the run, scope signed by both parties, all three beats approved. It now waits on the pin and the repo check.
