# WebDesk M6 · platform phases after the proof — plan, tickets and open decisions

**Started:** 2026-10-11 · **Board:** `TASKS.md` (outer folder), section *M6 · WebDesk platform phases after the
proof* · **Design:** `docs/blueprints/webdesk-design-v2.md` §04, §06–§09, §12 (P3–P6), §13 · **Rulings:** WSK-D28–D36,
WSK-D50 · **Branch:** `webdesk/m6-start`

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
delivery to shared hosting, but it was never ratified (its OQ-3.1–3.8 are open). Until the owner rules, P6 cannot be
planned.

### Stale text found on the way

- §07's ticket table still shows SM-74 and MON-01 as "designed".
- §10's counts are out of date: there are now 5 workflows with 19 jobs, none of them self-hosted.
- `infra/runbooks/self-hosted-ci-runner.md` is cited in two documents but is not on main.
- `webdesk/wordpress/README.md` says the scaffold's `wp` branch is "not wired".

## 2 · Owner decisions

Each carries the default this plan works to if it stays unanswered.

| # | Decision | Default | Blocks |
|---|---|---|---|
| O-1 | **P6's target.** Ratify the Hostinger shared replatform, or keep `delphi`/`helios`. If ratified, it takes the next free WSK-D id and amends D32 and §12 P6. | None. That plan asks for OQ-3.1 (decommission deadline) and OQ-3.6 (staging retention) before anything else | P6, and the deploy secrets in M6-P4g |
| O-2 | **Who creates the three template repos** in `gaiadabali` (`template-static-astro`, `template-fullstack-next-nest`, `template-wp`)? The ERP App can only create repos with org Administration write. | The owner creates three empty private repos marked as templates; sessions fill them by pull request | M6-P4d |
| O-3 | **The App's `organization_secrets: write` permission**, so the ERP can grant a new repo access to deploy secrets it never holds (D29). | Not granted, so the P4 gate stops short of deploy | M6-P4g |
| O-4 | **Where the P4 gate creates repos.** The gate is 3 kinds × 2 paths = 6 real repos. | A separate test org, so the gate can be rerun without clutter in `gaiadabali` | M6-P4 gate |
| O-5 | **OQ-2.1 ratified.** Repo creation stays manual except through the scoped, template-only, WS4-gated ERP path. | Adopt as written | Nothing; it only needs recording |

**Later the same day:** the owner reported the ERP GitHub App's organization-secrets permission granted (O-3; first proven by M6-P4g's first grant), delegated the template repos to this session, and asked for all remaining work to proceed. The M6 session created `gaiadabali/template-static-astro`, `template-fullstack-next-nest` and `template-wp` (private, marked as templates, a README each) with the org-admin account; M6-P4d fills them by pull request.

**Owner answers, 2026-10-12:** O-2, O-4 and O-5 accepted as their defaults and recorded as **WSK-D74** in `webdesk-design-v2.md` §14 (OQ-2.1 marked resolved in §13). O-1 is deferred (P6 waits). O-3 stays open. The owner also approved merging M6's verified work to main (after a full gate on the then-current main) and two agents at a time.

Restated, not new: **no second live tenant until M4's CPU decision** (OQ-2.7). Until then, P4's tenant creation and
P5's proof run against the WebDesk test stack on `sumopod`.

**Design call put to the owner with O-3: the deploy gate is the secret grant.** The ERP grants a repo access to the
org deploy secrets only when the repo has a `webdev_sites` row and a `CONTRACT.lock` on its default branch, read
through the App. A repo without both cannot deploy, because it holds nothing to deploy with. The template's deploy
workflow also refuses without `CONTRACT.lock`, so the refusal is visible in the run. A bypass means working around the
tooling on purpose, and the ERP records it as an exception with a reason. This meets §08's second gate with no new
runtime dependency between a site's CI and the ERP.

## 3 · Tickets

Seats follow the agent-army standard: one agent in flight at a time, and at most one Opus dispatch in a usage window.

| # | Ticket | Seat | Needs | State |
|---|---|---|---|---|
| **P3** | | | | |
| M6-P3a | **Measure the live side (read-only).** Registry and property counts by adoption, origin and verified; whether SM-74 carries data; MON-01's cron, target file and `client-properties` series on the boxes. Live DB reads are handed to the owner as a ready command; API and `sumopod` reads by the orchestrator | orchestrator | — | **DEV-VERIFIED** 2026-10-12, read through the live ERP API as the owner (counts only, no domains recorded): the registry holds **81 sites across 70 projects, all `tracked`** (30 production, 50 staging, 1 development), 62 without probe consent; `search_properties` for the agency tenant: **38, all active, 37 verified**; MON-01: 0 targets shipped. SM-74 topology fill is not observable here: the properties list API does not return those columns (a missing field, not missing data) | |
| M6-P3b | **Sentinel internal client** (= M5-G0, owned by M5), then backfill the internal `webdev_sites` rows' `client_id` to it. One-off script; the owner runs the live write | junior (Haiku) writes, owner runs | M5-G0 | PLANNED |
| M6-P3c | **A `webdev_site` Cerbos kind**, so the registry routes stop borrowing provisioned-site actions. Six artifacts, not one policy file; the four pinned count tests move | senior-be (Sonnet) | — | PLANNED |
| M6-P3d | **MON-01 made live** (M6-P3a found it probes nothing). The sync script as written cannot run: it calls `node` on a host that has none, and it needs a database login that can read `search_properties` across tenants (FORCE RLS). Shape: the generator in a pinned `node` container; a read-only role granted `SELECT` on the generator's columns only; an SSH key from `gda-aicenter` to `sumopod` whose forced command can only write that one file. Everything lands outside the `webdesk` project, so it needs the owner's OK (D43) | devops (Sonnet) + orchestrator on the boxes | owner OK | PLANNED |
| M6-P3e | **MON-04 "Client Properties" dashboard**: uptime, certificate days left, a per-property drill-down. Internal properties are excluded once the sentinel exists | devops (Sonnet) | M6-P3a | PLANNED |
| M6-P3f | **Stale text fixed**: §07's ticket table, §10's counts, the WordPress README, the three WSK-27 → WSK-70 comments | junior (Haiku) | — | PLANNED |
| M6-P3 gate | **About 63 properties tracked**, the probe target file a subset of verified rows (checked against the DB), no request to an unverified client host, and the console shows the registry with its staleness | qa (Sonnet) + orchestrator | P3a–e | PLANNED |
| **P4** | | | | |
| M6-P4a | **Snapshot by id (closes §06).** `GET contracts/:snapshotId` and `GET contracts/:snapshotId/artifacts/:artifact` (`openapi`, `sdkTs`, `sdkPhp`, `contractMd`; the file id comes only from the snapshot's own pointer; the bytes are re-hashed against the mirror-time sha256, a mismatch is 502 `artifact_hash_mismatch`, a null pointer 404 `artifact_absent`). Hub tools `webdev.contracts.get` and `webdev.contracts.artifact`, read-only, added to `wf:delivery` only. The scaffolder's adapter uses them | senior-integrator (Sonnet) | — | **DEV-VERIFIED** 2026-10-11 on `sumopod` (gate `m6p4a`, main `696d346` + the branch): platform-nest tsc clean, 561 files / 8053 tests passed (3 files skipped), the 8 new snapshot-by-id cases re-run verbosely against Postgres + Cerbos, all passed; mcp-hub 372 passed; ai-agents 354 passed. Not on main |
| M6-P4r | **Contract codegen runs live inside WebDesk.** The generator is compiled or bundled into the api image (the `./webdesk` build context of M6-P4b0, with `delivery/vocabulary/` admitted too, since `build-artifacts.mts` imports it) and runs on `tenant.provision` and `schema.apply`, so every tenant has a current `latest.json` without a manual step. It writes with the api's own least-privilege storage key, so no new credential appears anywhere. Touches the M3 session's `schema.apply` and the M4 session's image. **M3 agreed 2026-10-12 and hands M6 the hook**, with seven constraints: (1) codegen runs strictly AFTER the CommandEnvelope commit and fails soft, never changing the command's response or idempotency record, with a re-run path kept (CLI or control command); (2) the api container is read-only with cap_drop ALL since M4's hardening, so output goes to RustFS or a mounted volume, never the image filesystem; (3) WSK-15's codegen gate and the c1 determinism checks hold for the compiled generator, byte for byte; (4) the snapshot's MAJOR/MINOR classification agrees with `schema.apply`'s `409 contract-major-change`, and a MINOR apply yields a new snapshot id; (5) `contract.published` may be emitted, but the Zone B bridge into the ERP is not live until after release 359, so the ERP learns only via `contracts/refresh` until then; (6) serialize per tenant or compare-and-set on the snapshot id, because two applies can race the latest pointer; (7) first live check on M3's proof tenant `wsk49e-test`, which has no contract today. **M4 agreed the same day**, with five conditions: (a) codegen stays off the request path: the two commands enqueue a BullMQ job with a timeout and answer without waiting (the box is 2 vCPU shared with the ERP; the api is capped at 1 CPU / 768 MiB); (b) the api's RustFS key must be allowed to write `artifacts`, and any widening goes into storage-bootstrap's `webdesk-api` policy (idempotent, re-run every deploy), never by hand; (c) determinism is proven on the COMPILED generator (WSK-18 c1 in CI, `codegen:gate` in the gate's legacy suite); (d) `/tmp` is a 64 MiB tmpfs, so artifacts go straight to RustFS; (e) no manual step in deploy-webdesk; a backfill for existing tenants is an idempotent command or job the api runs. Every release now deploys WebDesk automatically, so P4r goes live with the release that carries it. Split: **P4r-a** the generator compiled into the image (the `./webdesk` context, a `.dockerignore` admitting `api/`, `blocks/`, `delivery/`, release.yml's matrix context, `webdesk/blocks/` in the `webdesk_api` CI group, the block-library tarball baked in with its sha256 in a LABEL) with determinism proven on the compiled form; **P4r-b** the queued trigger on both commands, per-tenant serialization, the storage policy check and the backfill job | senior-integrator (Sonnet; opus·medium if the trigger's transaction boundary resists) | M3 + M4 agreement | PLANNED: agreed with M3 and M4 |
| M6-P4b0 | **The block library becomes a fifth snapshot artifact.** Nothing stores a pinned `@gaiada/webdesk-blocks` tarball today (WSK-16 packed one by hand), so the scaffolder cannot vendor it. Design call (orchestrator, 2026-10-11), following OQ-6 ("installable as a tarball, no registry infra") and §06 ("the scaffolder reads snapshots only"): WebDesk stores the packed tarball per library version in its artifacts bucket, the contract read returns a presigned `blockLibraryUrl` beside `sdkPhpUrl`, the ERP mirror stores and hashes it as a fifth artifact (a `null` pointer for older snapshots, like `sdkPhp`), and `webdev.contracts.artifact` gains `blockLibrary`. The scaffolder then reads it through the same hash-checked tool. Two refinements found while briefing it: (1) the tarball's hash is recorded per artifact (`artifacts.hashes.blockLibrary`) but kept OUT of `contentHash`, because adding a key to the hashed manifest would make a re-fetch of an already-recorded contract version trip the determinism alarm; (2) the WebDesk api image builds from `webdesk/api` alone, so the tarball has to be produced by a change to that image's build context or to the release workflow, both in the M4 session's deploy lane. **Producer agreed with M4 (gaiada-system-0c) on 2026-10-11: the api image builds the tarball**, so the image's cosign signature and SLSA attestation cover it and `deploy-webdesk` stays a verify-and-swap; a deploy-time upload was rejected (unsigned, needs RustFS write credentials on a runner, exists only where it ran). M4's conditions: (1) build context `./webdesk` with `-f api/Dockerfile` and a `.dockerignore` admitting only `api/` and `blocks/` (no node_modules), via release.yml's matrix `context` for webdesk-api; (2) `scripts/ci/plan.mjs` (WSK-69) counts `webdesk/blocks/**` as a webdesk-api change path, or a blocks-only change ships a stale tarball; (3) the tarball's sha256 recorded in an image LABEL, and codegen refuses to upload different bytes under an existing `<ver>` key (idempotent only for identical bytes); (4) with GOVERNANCE object lock on the bucket, a different hash at the same key fails loudly, never overwrites; (5) kept out of `contentHash`; (6) land it after release 357's deploy (deploy-webdesk's first live apply) | senior-integrator (Sonnet) | M6-P4a, M6-P4r | PLANNED: a first attempt stopped at its investigate-first step and found item 9 |
| M6-P4b1 | **Wire `code.scaffold` v2, dry run.** Runner dispatch in ai-agents (`runner/service.ts`), the hub's `code.scaffold` stub replaced, a source for the block-library tarball. `dry_run` proven for all three kinds. Two facts from the M6-P4a review: (1) WebDesk serves `sdk.d.ts` and `sdk.php` as plain text, but the ERP mirror stores them as `sdk.ts.tgz`/`sdk.php.tgz` with type `application/gzip`, and the scaffolder vendors the `.d.ts` as `vendor/webdesk-sdk.tgz`; fix the labels and the vendoring together. (2) The scaffolder's hub calls pass `webdev_contract_snapshot` `read` only if its OBO identity has a verified link to a user holding a webdev role on the tenant; nothing in the repo seeds that link for `wf:delivery`, so check it on the box. (3) Found by M6-P4d: the scaffolder's `node` kind (`templates/node-site.ts`) emits an Astro SSR skeleton at the repo root, while §08 and the owner's stated stack make `fullstack` Next + Nest (`template-fullstack-next-nest`: `apps/web` Next, `apps/api` Nest, an npm workspace); it would overwrite the workspace root. The template is right; the `node` kind must write into `apps/web` (and leave `apps/api` alone) | senior-integrator (Sonnet) | M6-P4b0 | PLANNED |
| M6-P4b2 | **The scaffold reaches the repo through platform-nest.** `git-writer.ts` ends in a `git push`, but the agents' GitHub App and the hub are read-only by design, and only platform-nest holds the ERP App's write credential (D29). So ai-agents returns the file tree, and platform-nest commits it into the provisioned repo through the GitHub Data API (blobs, tree, commit, ref) as part of the approved provisioning, never a second credential in ai-agents | senior-be (opus·medium: a credential boundary) | M6-P4b1, M6-P4c | PLANNED |
| M6-P4c | **Provisioning finishes §08.** When the repo is created: the `webdev_sites` row (`origin = provisioned`, `adoption = mandated`, its kind) and the WebDesk tenant with a pinned contract snapshot, idempotent and crash-resumable like the repo step | senior-be (opus·high: crash-resume across two services) | M6-P4a | PLANNED |
| M6-P4d | **Template repos filled** per `site-provisioning-templates.md`. `template-wp` carries the M6-P5a theme. Each template's deploy workflow refuses without `CONTRACT.lock`. `ERP_REPO_TEMPLATE_*` set on the box and listed in compose | medior (Sonnet) + orchestrator on the box | O-2 | PLANNED |
| M6-P4e | **PRD → kind on the automation path.** `wd-provision.json` passes the signed PRD's stack hint instead of `vite`, re-imported with the n8n CLI | medior (Sonnet) | — | PLANNED |
| M6-P4f | **Console kind picker**: `static`/`wp`/`fullstack`, `wp` enabled, an "awaiting approval" state that links to the approval, the failure reason shown | medior (Sonnet), senior-fe review | — | **DEV-VERIFIED** 2026-10-12 on `sumopod` (gate `m6g3`, main `7fbe490` + the branch): platform-ui tsc clean, 286 files / 5525 tests passed, `next build` exit 0 with 0 compile failures. Not on main |
| M6-P4g | **Deploy gate and org secret grant**, in the shape in §2 | senior-be (opus·high: a security boundary) | O-1, O-3 | PLANNED |
| M6-P4 gate | **A staff click and a signed PRD each produce a correct repo for each kind** (6 runs), each with its registry row, tenant and `CONTRACT.lock`; a repo without them is refused deploy | qa (Sonnet) + orchestrator | P4a–g, O-4 | PLANNED |
| **P5** | | | | |
| M6-P5a | **Theme finished.** One canonical theme in `webdesk/wordpress/theme/gaiada-webdesk/` (entry files, a fixture `sdk.php`, `inc/router.php`, `inc/config.php`, a read-only settings page); the scaffolder emits it byte for byte (drift test), and the old `scaffold-template/wp-site.ts` is retired. Configuration only from `wp-config.php` or the environment. The review found the scaffolder's old copy had emitted no renderer (`inc/`) at all | medior (Sonnet) | — | **DEV-VERIFIED** 2026-10-11 on `sumopod` (gates `m6p5a-php`, `m6p5`): `php -l` 16/16, render probe 29/29, router probe 64/64, ai-agents 361 passed incl. the theme drift test. The WordPress runtime itself is the P5 gate. Not on main |
| M6-P5c | **Link and rich-text safety in both renderers.** Found in the M6-P5a review: neither the Astro blocks (`Cta.astro`, `Hero.astro`) nor the PHP templates filter a link's scheme, so a `javascript:` href passes, and both emit `richText` HTML raw; `webdesk/api`'s content write path has no HTML sanitizer. With client editors (D58–D60) that is a stored-XSS path on a delivered site. An allow-list of link schemes (`http`, `https`, `mailto`, `tel`, relative, `#`) in both renderers, and one decision on where rich text is sanitized (at write in WebDesk, or at render in each renderer), applied to both | senior-fe (Sonnet) + senior-be review | — | **DEV-VERIFIED** 2026-10-11 on `sumopod` (gate `m6p5`): blocks vendor check, unit 40/40, `astro check` 0 errors; PHP safety probe 47/47; and a real Astro build of a hostile fixture through the demo site: every hostile href became `#`, no `javascript:` and no event handler in the output, only the two JSON payload scripts with their `</script>` escaped, hostile image sources dropped. Write-side sanitising stays a proposal. Not on main |
| M6-P5e | **The PHP templates read the vocabulary's field names.** Found in the M6-P5c review: `richText` reads `value` (the vocabulary field is `content`) and `cta` reads `label`/`href` (`buttonLabel`/`buttonHref`), so both render empty in WordPress. Every PHP block template checked against `webdesk/blocks/src/vocabulary/blocks.ts`, with a probe that renders each block from the vocabulary's own field names | medior (Sonnet) | M6-P5c | **DEV-VERIFIED** 2026-10-11 on `sumopod` (gate `m6p5`): `vocabulary-fields-probe.php` 62/62 (31/62 fail against the old templates); the other three probes still pass. Not on main |
| M6-P5d | **The generated PHP SDK takes a timeout.** Its curl timeout is fixed at 10 s inside the generator (`webdesk/api/src/codegen/generator/sdk-php.mts`), longer than a page request should wait; an option with a lower default, regenerated through the determinism gate | junior (Haiku) | — | **DEV-VERIFIED** 2026-10-12 on `sumopod`: WebDesk gate `m6wd` (legacy 15/15 incl. `wsk15-codegen-gate` with the new generator, blocks 40/40, vocabulary 267/267) and, after the vendoring fix `25aebc4e`, `m6wd2` webdesk-api 1132 passed / 0 failed / 2 skipped. Not on main |
| M6-P5b | **PHP in CI**: `php -l`, the render-invariant probe, a drift check of the vendored vocabulary | devops (Sonnet) | M6-P5a | IN PROGRESS: merged on `webdesk/m6-start` (`63944177`). A `webdesk_wordpress` CI group (paths `webdesk/wordpress/`, `webdesk/delivery/vocabulary/`, `sdk-php.mts`) gates one new `webdesk-light` step: `php -l`, the five probes in digest-pinned `php:8.3-cli`, then the vendored block-list `--check`. Locally it passes, and it fails on each of three deliberate breakages; planner tests 18/18 (one assertion on main was already failing since WSK-49c and is corrected). Its first real run is the merge to main (CI runs on main, PRs or dispatch only) |
| M6-P5 gate | **A WordPress site renders entirely from `/v1`.** On `sumopod`: a throwaway WordPress and MySQL, the theme active, a test tenant on the WebDesk test stack with a `pages` collection (the WSK-18 fixture tenant has none, so its SDK 404s every default route), every page of the fixture site from `/v1`, unknown blocks reported and never thrown | qa (Sonnet) + orchestrator | M6-P5a, M6-P5b, M6-P5c, M6-P5e | PLANNED |
| **CDN** | | | | |
| WSK-70 | **CDN purge on publish.** Stays deferred (D50); its comment ids are fixed in M6-P3f | — | a CDN in front of `/v1` or a site | deferred |
| **P6** | | | | |
| M6-P6a | **P6 plan**, re-cut from the replatform's R0–R6 or from `delphi`/`helios`, per O-1 | orchestrator | O-1 | PLANNED |

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
   - P6 after O-1.

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
- **2026-10-12, full gate `m6g3`** (main `7fbe490` + the branch): platform-ui 5525 passed and `next build` clean; webdesk-api 1132/0 (`m6wd2`). platform-nest showed 2, then on a re-run 3, failures, none in M6 code: the auto-merged `CAPABILITY-INVENTORY.md` (regenerated since, `309b00e9`, 160 capabilities, 5/5 locally against the current tree), and three load-sensitive tests at load 20 to 26 (`mail24-timing-remeasure`, `pull-scheduler-qa-adversarial`, `report-export` 10k rows); the latter two passed when re-run alone at lower load, and the timing test passed on the re-run. The final pre-merge gate re-runs the full suite on the then-current main.
- **2026-10-11, vendored file:** M6-P3f's comment edit in `webdesk/api/src/delivery/vocabulary/cache-tags.ts` changed a VENDORED copy of `webdesk/delivery/vocabulary/cache-tags.ts`, and the WSK-48a drift spec failed on Linux. The source now carries the same comment. Vendored vocabulary files are edited only at the source, then re-vendored.
- **2026-10-11, line endings:** the shared repo config now sets `core.autocrlf=false`, so a worktree checked out earlier with CRLF commits CRLF. One commit (`f97acaab`) stored the design doc with CRLF; the merge with main re-applied its five changed lines onto main's LF text, and the worktree was re-checked-out as LF. Before committing, check that staged blobs carry no carriage returns.
