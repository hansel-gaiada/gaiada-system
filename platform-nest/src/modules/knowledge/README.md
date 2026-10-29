# Knowledge (D9 RAG) — two-tier corpus

The vector store itself is owned by WS8 (`ai-agents/src/knowledge/`), not by this module. This
directory holds the **ingestion** side: the jobs that fill that store, plus the module contract and
the admin endpoints that drive it.

## The two tiers (D9.4)

| | `public` | `internal` |
|---|---|---|
| Content | gaiada.com (our own marketing site) | ERP records |
| Who can retrieve it | **anyone**, including a caller with no resolved identity | members of the owning company only |
| Tenant pre-filter | none — this tier *is* the published corpus | `tenant_id ∈ authorized-tenant-set` (D9.1, unchanged) |
| ACL scope | ignored | applied (`acl = '{}'` = whole tenant) |
| Set by | `audience: "public"` on ingest | the default |

`audience` **fails closed**: the column defaults to `internal`, and both `store.ingest()` and the
service's `/ingest` route coerce anything that is not the literal string `"public"` to `internal`. A
malformed or hostile ingest can only ever under-share.

Before this tier existed, `store.search()` returned `[]` for any caller whose tenant set was empty,
so no one without an ERP identity could receive knowledge of any kind. That early return is gone;
what replaces it is a two-branch SQL predicate where the internal branch self-disables on an empty
tenant set. Both branches stay in the `WHERE`, so an unauthorized chunk is never a ranking candidate.

## What gets ingested

**Public** — `ingest/web-source.ts`. Sitemap-first discovery (handles Yoast-style sitemap indexes),
BFS fallback, dependency-free HTML→text, then frequency-based boilerplate removal.

That last step matters more than it sounds: real themes build their menus out of plain `<div>`s with
no `<nav>` element, so tag-stripping alone leaves the whole site menu in the **first chunk of every
page** — the chunk most likely to be retrieved. `stripBoilerplate` drops short lines that appear on
most pages, which is theme-independent in a way a CSS selector never is.

**Internal** — `ingest/erp-source.ts`, one document per record:

| Family | Tables | `source_ref` |
|---|---|---|
| Client work | `clients`, `projects`, `tasks` **and `pm_tasks`**, `deliverables` | `erp:client:<id>`, `erp:pmtask:<id>` etc. |
| Long-form | `meeting_recordings.transcript`, `pm_docs` | `erp:meeting:<id>`, `erp:pmdoc:<id>` |
| Reports | `report_documents` (latest revision only) | `erp:report:<grain>:<scope>` |
| Org & people | `company_org_structure`, `org_units`, `company_memberships` | `erp:org:<tenant>` etc. |
| Files | `files` (+ extracted text) | `erp:file:<id>` |

Tasks come from **two** tables. `pm_tasks` is the PM console's own richer row and is where
day-to-day work actually lives — on the live box the core `tasks` table held 0 rows while
`pm_tasks` held the real backlog, so indexing only the core table produced a silently task-free
corpus. Both are indexed; they are different records and a tenant may populate either.

Records are rendered as **labelled prose**, not raw values — an embedding of `"blocked"` is
meaningless; `"Task: Migrate DNS / Status: blocked / Project: Acme Rebuild"` is answerable.

Only the **latest revision** of a report document is indexed. Indexing superseded revisions makes the
RAG argue with itself.

## Department column and ranking boost (AIP-11, AIP-12)

`knowledge_chunks.department_id` (text, NULL) holds the **org node id** of the department that owns the record, the same shape
as `projects.department_id` (`d-seo`). The store's own `init()` adds it in place with `ADD COLUMN IF NOT EXISTS`, plus an index
on `(tenant_id, department_id)`, exactly as it added `audience`. `/ingest` takes `departmentId` and is fail-soft about it: a
wrong type, a blank or a value over 100 characters becomes `null`, never a 400.

The ERP source sets it per record:

| Record | `departmentId` |
|---|---|
| project | its own `department_id` |
| `tasks`, `pm_tasks`, `deliverables`, `pm_docs` | its project's |
| meeting | its own `department_id`, else its project's |
| file | the parent project's, or the project of the parent task (core or PM) or deliverable; any other target none |
| clients, reports, org, people | none |

**The chunk text does not carry it.** The store keeps a stored chunk's vector when its text is byte-identical, so a
"Department:" line in the rendered text would re-embed the whole corpus (about 2 hours on the live 2-vCPU box). The department
travels beside the chunks, and the store's reuse path rewrites it on the rows it keeps: **the next sweep is the backfill**
(about 3 minutes, zero embedding calls). A record that leaves its department is cleared the same way.

**It ranks; it never gates (plan section 3.3).** `/search` takes an optional `department: { tenantId, nodeId }` (a uuid and a
non-empty string of at most 100 characters; anything else is ignored, no boost, no error). The authorization pre-filter is
unchanged and never mentions the department. After it, a chunk that is `internal`, of that tenant and of that node has its score
multiplied by `KNOWLEDGE_DEPARTMENT_BOOST` (default `1.25`, NaN or missing gives the default, clamped to `[1, 2]`); results are
ordered by the boosted score and the boosted score is the one returned. The `score > 0` cut stays on the base score. So the boost
cannot add a row, cannot rescue a chunk with no similarity, does not touch the public tier, and does not cross companies (node
ids repeat across companies, which is why the tenant is part of the match). Hits carry `departmentId`. With no department the
results and their order are exactly what they were. Per-record read checks (`filterReadableHits`) still run in platform-nest on
whatever comes back.

## Freshness

`ingest/scheduler.ts` runs a full sweep on an interval (`KNOWLEDGE_INGEST_INTERVAL_MS`, default 6h),
started from `main.ts`. `POST /api/:t/knowledge/ingest/run` (elevated-only) forces one;
`GET /api/:t/knowledge/ingest/status` reports the last outcome.

Re-ingest is idempotent because `source_ref` is derived from permanent identity and D9.2 makes an
ingest **replace** that source's chunks.

**Retirement is gated on a clean run.** After ingesting, the sweep diffs the store's source list
against what it just wrote and deletes the difference — otherwise a deleted project stays answerable
forever. That diff runs *only* if the build succeeded, every document ingested, and the run was
non-empty. Without that gate, a transient DB error producing zero documents would be
indistinguishable from "everything was deleted upstream", and one bad run would wipe the corpus.
Losing freshness for a cycle is recoverable; deleting the index is not.

The sweep also refuses to overlap itself: a tick that finds one in flight returns rather than
queueing, because two concurrent sweeps would race each other's retire step.

## Known limits — read before extending

**ACL sub-scoping is not safe yet.** Internal documents are written with an empty `acl`, meaning
"every member of this tenant". That is the requested rule, and it is also the only rule currently
safe to express: `scope` is supplied by the **caller** (the bot passes its chat id), so a narrower
acl like `["dept:finance"]` would be asserted by the very party it restricts. Department- or
role-level gating needs server-resolved scopes — derived from the principal during
`/principal/resolve` — before it means anything.

**PDF and DOCX bodies are not indexed.** Those files are still ingested by *metadata* (name, type,
what they are attached to), so they remain findable; only their text is missing. Parsing them means
running binary document parsers against arbitrary user-uploaded bytes inside the service that holds
every company's data. `wa-chat-bot` accepts that trade on an isolated, crypto-shredded surface; the
ERP core is not the same risk position. `ingest/file-text.ts`'s `extractFileText` is the seam — the
change is additive if that trade is accepted.

**The web fetcher is first-party only.** Its host allowlist is not the search module's IP-level
egress guard (`search-crawl-go/internal/egress`). Pointing `KNOWLEDGE_PUBLIC_SITES` at a host we do
not own requires moving it behind that guard first — and would also invalidate the reason robots.txt
is not consulted.
