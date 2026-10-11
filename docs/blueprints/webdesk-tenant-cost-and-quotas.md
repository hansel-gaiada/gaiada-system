# WebDesk — per-tenant cost and quotas (A-10 / OQ-2.7)

**Written 2026-10-11 (M4, T7)** from measurements on `gda-aicenter`, with one tenant live (`gaiada`, the gaiada.com
proof). The quotas in §3 are proposals. The ones marked **owner** need a ruling before a second tenant is
provisioned. Until then, design §13 OQ-2.7's interim rule stands: the box's capacity is the ceiling.

## 1 · What one tenant costs today (measured)

| Resource | Measured | How |
|---|---|---|
| Box | `e2-highmem-2`: **2 vCPU** (1 core, 2 threads), 16 GiB RAM, 99 GB disk with 41 GB free; load 1.0–1.6 | `lscpu`, `free`, `df`. Design §03 still records the 4 vCPU of 2026-08-31 |
| WebDesk at rest, all five containers | **~214 MiB RAM** (api 69, postgres 58, rustfs 55, proxy 21, redis 11) and about **0.1 vCPU** (postgres 5%, rustfs 4.7%, the rest < 1%) | `docker stats`, 2026-10-11 12:28Z |
| WebDesk ceilings (limits, not reservations) | cpus 1.0 + 1.0 + 0.5 + 0.5 + 0.25 = **3.25 vCPU**, mem **2.75 GiB**, pids 128–256 each | containment probe 4 |
| Database | **32 MB** for 17 collections, 326 items, 330 versions. `content_items` 19 MB with its indexes (about **58 KB per item**); `content_versions` 2.5 MB (about **8 KB per version**); the rest < 1 MB | `pg_database_size`, `pg_total_relation_size` |
| Postgres volume | 90 MB (data + WAL) | `du` |
| Object storage | 0 objects: the media library (WSK-43) is not in use yet | `du` per bucket |
| Requests | 589 to `api.erp.gaiada.com` on 2026-10-11: 147 to `/v1`, 143 × 200, **428 × 404** (scanners against the locked-down surface) | the redacted nginx access log |
| One full site build | **34 `/v1` requests** (17 collections × 2 locales), 326 items, done in seconds | WSK-57 |
| One rebuild on GitHub | an 82 s job, billed 2 min, about **$0.016** (private site repo) | WSK-60 |

**Per-tenant marginal cost:**
- about 60 KB of database per item;
- 8 KB per saved version;
- media at face value;
- 34 reads per build;
- one GitHub run per approved publish.

At rest a tenant costs nothing measurable beyond the shared ~214 MiB.

## 2 · What is enforced today, and where the files disagree

| Limit | Live | Code default | Compose default | Note |
|---|---|---|---|---|
| `/v1` reads per tenant per minute | **300** | 300 | — | **`/etc/webdesk/.env` says 3000, but no compose file passes `WEBDESK_READ_QUOTA_PER_MIN` (or `_WINDOW_MS`) to the api** (the compose env-passthrough trap), so the code default runs. The WSK-57 note "live 3000" was wrong. 300 still fits a build (34) about 9× over |
| Storage per tenant | **5 GiB** | 5 GiB | 10 GiB | Set in `/etc/webdesk/.env`. The base compose default disagrees |
| One upload | 25 MiB | 8 MiB | 25 MiB | |
| Presigned URL lifetime | 900 s | 300 s | 900 s | |
| Forms | 20 / IP / 10 min; 120 / form / 10 min; 5 attachments × 10 MiB; fields 64 KiB, 5,000 chars each | same | — | |
| Tenant webhooks | 5 attempts, 3 redirects, 256 KiB payload | same | same | No cap on the number of hooks per tenant |
| api DB pool | 10 | 10 | — | own Postgres, `max_connections` 100 |

## 3 · Proposed quotas per tenant

| Quota | Proposal | Why |
|---|---|---|
| `/v1` reads | **300 / min**, passed through compose so the file and the process agree | Measured to be enough: one build is 34. A lower ceiling protects a 2-vCPU box shared with the ERP. Raise per tenant only on evidence |
| Storage | **5 GiB**; align the compose default to it | 41 GB free on the box: at most **4 tenants at full quota** before media must move to the D23/D42 exit (R2/NAS behind the same S3 abstraction) |
| Items | soft **5,000** items (about 300 MB of database), warn at 80% | 15× today's site; keeps one tenant's database under 1% of the disk |
| Versions | keep all (8 KB each); revisit at 100k per tenant | cheap; history is a product feature |
| Webhooks | **10** per tenant | today unlimited; every hook multiplies delivery work |
| Uploads, forms | as live | measured nowhere near a limit |
| Rebuilds | one per approved publish (already: exactly one per approval, WSK-61) | GitHub minutes are per site repo, not on the box |

## 4 · Capacity: the decision this forces (owner)

WebDesk's CPU ceilings (3.25 vCPU) now exceed the box (2 vCPU). No single service can take the box (each is capped
at ≤ 1.0), but the api and Postgres together can saturate it under a burst, and the ERP shares those cores. Two ways
out:

1. **Lower the ceilings to a 1.0 vCPU project budget** (api 0.4, postgres 0.3, rustfs 0.1, proxy 0.1, redis 0.1),
   after measuring the CPU of a full build against those numbers. This needs no new money.
2. **Resize the box back to 4 vCPU** (e.g. `e2-standard-4` / `e2-highmem-4`), which design §03's numbers assumed.
   That is a recurring cost.

Until one is chosen, a second tenant should not be provisioned on this box. A build's CPU has not been measured yet
(it needs the build key, which lives only in the site repo's secrets), so (1)'s split is an estimate.

## 5 · Follow-ups

- Pass `WEBDESK_READ_QUOTA_PER_MIN` and `WEBDESK_READ_QUOTA_WINDOW_MS` through `docker-compose.yml`'s `api`
  environment, and set the live value to the ruled one. Ships with the next WebDesk release.
- Align `WEBDESK_TENANT_STORAGE_QUOTA_BYTES`'s compose default (10 GiB) with the code default and live value (5 GiB).
- Add a per-tenant webhook cap.
- Measure CPU during a full build, then set the ceilings (§4).
