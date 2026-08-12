# IAM-SEC-08 — Recon: is the `inviteUser` escalation exploitable on LIVE right now?

**Status: DEV-VERIFIED read-only recon.** No writes, no DDL, no restarts, no policy edits were
performed. All evidence below is either a `SELECT`, a file read, or a Cerbos decision-log read on
`gda-aicenter`.

## VERDICT: **(a) LIVE NOW.**

The escalation described in `2026-08-12-iam-04c-ruling.md` §6 (a `company_admin` minting
`platform_admin@company:X` or `group_executive@company:X` via `POST /:tenantId/users`, which then
traverses the wired `perm_user_*` mirror on `resource_user.yaml`) is exploitable against
`erp.gaiada.online` **today**, with the currently-deployed code and the currently-loaded Cerbos
policy. This is not a "becomes live at next deploy" finding — the vulnerable pieces (unguarded
`inviteUser` write path + wired `perm_user_*` mirror) are both already on the box. The three
pending commits (`1214eb3`, `20a67ae`, `9f14cc8`) are **not** on the box yet and do not touch this
path; when they do ship they widen the blast radius (more kinds get mirrors) but do not create the
exposure — it already exists without them.

Treat the `inviteUser` scope-guard fix as a **hotfix**, independent of and not blocked by the
pending IAM-04 rollout commits.

---

## 1. Live image/tag and Cerbos policy provenance

```
$ ssh gda-aicenter docker ps --format '{{.Names}}\t{{.Image}}'
gaiada-platform-1   ghcr.io/hansel-gaiada/gaiada-platform-nest:alpha-01.038.0089a
gaiada-cerbos-1      ghcr.io/cerbos/cerbos:0.54.0
```

`gaiada-platform-1`: created + started `2026-08-12T09:04:05Z` / `09:04:10Z` — i.e. this morning's
restart, running tag `alpha-01.038.0089a`.

Cerbos storage is **not baked into the Cerbos image** — it's a read-only bind mount from the host
checkout:

```
Source: /home/Hansel/gaiada/platform-nest/cerbos/policies  ->  Destination: /policies (ro)
```

`cerbos.yaml` on the host: `storage.driver: disk`, `watchForChanges: true`. So "what policy Cerbos
has loaded" = "what's on disk in that directory right now" *unless* the last watch-triggered
recompile failed. I did not trust that inference — I checked the actual server-side files and the
compile outcome:

- `grep -n 'perm_' resource_user.yaml` on the **host checkout** (not the local repo) returns lines
  32/36/40/44 — `perm_user_read/create/update/delete` are wired on the `read`/`create`/`update`/
  `delete` actions, condition `variables.inTenant && variables.notLow`. This is the exact mirror
  the ruling's §6 describes as "already wired."
- `derived_roles.yaml` on the host defines `perm_user_create` (and the sibling three) as
  `g.key == "core.user.create" && (g.scopeType == "global" || g.scopeType == "company" &&
  g.scopeId == <tenant>)` — the global-or-company-at-tenant condition the mechanism requires.
- **Compile outcome, not assumed:** `docker logs gaiada-cerbos-1 --since 2026-08-12T09:04:00` has
  **zero** error/panic/"not defined" lines after the 09:04 restart — the disk policy set,
  including the wired `resource_user.yaml`, compiled cleanly and Cerbos has been `healthy` (health
  probe `SERVING`) continuously since.
- **Health ≠ current, checked, not assumed:** the same container's full log history shows exactly
  the failure mode the program's own doctrine warns about — a `panic: runtime error: invalid
  memory address or nil pointer dereference` at `2026-08-11T11:38:19Z` from a compile error
  (`resource_team.yaml:24:22: Derived role "team_lead" is not defined in any imports`), i.e. a real
  past incident where a bad policy edit broke compilation. That crash is **not** the current state:
  `RestartCount: 0`, current `Health: healthy` with `SERVING` samples every 10s since, and no
  compile errors logged after the most recent (09:04:30 today) start. I'm reporting this because it
  is exactly the "healthy-but-stale/broken" failure shape CLAUDE.md warns about, and I checked it
  rather than taking the green healthcheck at face value — the current instance is clean.
- **Real traffic, not a hypothetical:** `docker logs gaiada-cerbos-1` decision-audit lines from
  `2026-08-12T09:54:36Z` (well after the last restart) show live `checkResources` calls with
  `principal.attr.perms` populated as `[{key, scopeType, scopeId}, …]` — confirming
  `cerbos.ts`'s `attr.perms` payload is genuinely being sent and evaluated on this box right now,
  not just present in source.

## 2. Are `perm_*` mirrors wired on `resource_user.yaml` on the server — yes, already

Confirmed above. This is the load-bearing fact for "LIVE NOW" vs "next deploy": the mirror the
ruling worried about for the global-only direction is not a future state, it's the current one.

## 3. Pending commits — confirmed NOT deployed, and confirmed irrelevant to this path

```
$ git diff-tree --no-commit-id --name-only -r 1214eb3
platform-nest/cerbos/policies/resource_automation_approval.yaml
platform-nest/cerbos/policies/resource_pipeline_gate.yaml
platform-nest/cerbos/policies/resource_pipeline_run.yaml
platform-nest/cerbos/policies/resource_pipeline_stage.yaml
platform-nest/cerbos/policies/resource_scope_signoff.yaml
platform-nest/src/rbac/iam-trap4-group-executive-split.test.ts
docs/superpowers/plans/2026-08-12-iam-trap4-report.md

$ git diff-tree --no-commit-id --name-only -r 20a67ae
platform-nest/cerbos/policies/derived_roles.yaml
platform-nest/cerbos/policies/resource_{automation_approval,pipeline_gate,pipeline_run,pipeline_stage,scope_signoff}.yaml
docs/...

$ git diff-tree --no-commit-id --name-only -r 9f14cc8
platform-nest/cerbos/policies/derived_roles.yaml
platform-nest/cerbos/policies/resource_{appraisal,integration_connection,project,report_document,time_entry}.yaml
docs/...
```

None touch `resource_user.yaml` or `admin-identity.controller.ts`. Verified server does **not**
have them yet by diffing the two most legible tells:

- `resource_pipeline_gate.yaml` on server still folds `group_executive` into the same
  `inTenant && notLow` rule as `company_admin`/`manager` (the bug `1214eb3` fixes) — the post-fix
  split rule is absent.
- `resource_pipeline_gate.yaml` / `resource_project.yaml` / `resource_time_entry.yaml` on server
  have **zero** `perm_*` occurrences (`grep -c 'perm_' … => 0` for all three) — `20a67ae`/`9f14cc8`'s
  additions are absent.

**Effect when they do ship:** they add `perm_*` mirrors to `automation_approval`, `pipeline_gate`,
`pipeline_run`, `pipeline_stage`, `scope_signoff`, `project` (read), `time_entry` (read/create) —
i.e. the same `inviteUser`-minted `platform_admin@company:X` grant would *also* traverse those six
more kinds once deployed. They do **not** touch `appraisal`/`report_document` (deliberately
deferred per the ruling) and do **not** fix `inviteUser`. **Conclusion: deploying them widens the
existing live exposure; it does not create it, and does not require it as a precondition.**

## 4. Live `user_roles` — scope-anomaly query, verbatim

```sql
SELECT r.name AS role, ur.scope_type, count(*) AS n
FROM user_roles ur JOIN roles r ON r.id = ur.role_id
GROUP BY r.name, ur.scope_type ORDER BY r.name, ur.scope_type;
```
```
      role       | scope_type | n
-----------------+------------+----
 agency_approver | company    |  1
 client          | company    |  9
 company_admin   | company    | 11
 group_executive | global     |  1
 it_admin        | company    |  1
 manager         | company    | 11
 member          | company    | 18
 platform_admin  | global     |  1
```

Targeted check for the three scope-narrow/global-only roles at a wrong scope:

```sql
SELECT r.name AS role, ur.scope_type, ur.scope_id, ur.user_id, u.email
FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
WHERE r.name IN ('platform_admin','group_executive','org_unit_lead')
  AND ur.scope_type <> 'global'
ORDER BY r.name;
```
```
 role | scope_type | scope_id | user_id | email
------+------------+----------+---------+-------
(0 rows)
```

**Confirms independently: zero `org_unit_lead` rows at any scope; zero `platform_admin` or
`group_executive` rows at a non-global scope.** The DB is clean right now — matches the ruling's
§3. This is a point-in-time fact, not a mitigation: `inviteUser` can create the bad row on demand,
with no guard, this minute.

## 5. Who could actually exercise it

Roles that hold `user:create` on `resource_user.yaml` (the only ones that can call
`POST /:tenantId/users` with a `roleId`): `platform_admin` (wildcard `*`) and `company_admin`
(`create`/`update`/`delete`, gated `inTenant && notLow`). `manager` only holds `read`;
`group_executive` is not named on `create` at all (it's the escalation *target*, not a path to it).

```sql
SELECT r.name AS role, u.email, ur.scope_type, ur.scope_id
FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
WHERE r.name IN ('company_admin','platform_admin','group_executive','manager')
ORDER BY r.name, u.email;
```

11 `company_admin` rows: **7 are `automation+*@gaiada.system` bot principals**, minted
`assurance: "low"` by construction (`platform-nest/CLAUDE.md`). The `create` rule (and every
`perm_*` mirror on this kind) is gated `variables.notLow` = `attr.assurance != "low"`, so these
7 are **Cerbos-blocked from exercising `create`** on `user` regardless of role name — confirmed
from `_variables.yaml`'s definition, not assumed.

The remaining 4 `company_admin` rows are 2 **distinct human principals**, each holding it at both
companies:

- `hansel@gaiada.com` — company_admin @ both tenants, plus `platform_admin@global` (the owner).
- `owner@gaiada-creative.test` ("Ayu") — company_admin @ both tenants.

Both are cross-checked against `CREDENTIALS.local.md` §4a: **both are VERIFIED live Keycloak/SSO
logins** (driven through the real SSO flow, landed on the staff shell, 2026-08-04). This is a real,
exercisable human-actor set of 2 — not a seed/bot artifact, and not merely a `users` row. (The
~7-of-47 "who can log in live" figure in memory is the platform-wide count; these 2 are inside
that set.)

`group_executive`: 1 row, `exec@gaiada.test`, global — also a VERIFIED live login per the same
credentials doc, but this role does not hold `user:create`, so it is an escalation *target*, not an
*actor*, for this specific path.

**Net: 2 real human logins today (`hansel@gaiada.com`, `owner@gaiada-creative.test`) can call
`inviteUser` with an arbitrary `roleId` and mint `platform_admin@company:X` or
`group_executive@company:X` on any target (including a plain member, or themselves) — and that
grant's resolved perms already traverse a wired mirror (`resource_user.yaml`) on this box, right
now.**

## 6. What I did not do (by design, per the read-only mandate)

- Did not call `POST /:tenantId/users` against live, with or without a real `roleId` — no invite,
  no grant, no session bump was created.
- Did not probe live Cerbos with a synthetic principal via `/api/check/resources` — the ticket
  permits this only against a local/test container, which I did not stand up (not required to
  reach a verdict; the decision-log evidence in §1 plus the static condition match in §2 already
  establish the mechanism fires as designed, without needing a hypothetical check against
  production).
- Did not inspect `.env`/secrets beyond what `CREDENTIALS.local.md` already documents.

## 7. Recommendation (recon scope, not a fix)

Ship the `inviteUser` scope-guard fix (§8, option A/the `ROLE_SCOPE_CONSTRAINTS` check, or routing
through `assignRole`'s existing guard) as a **hotfix**, ahead of and independent from
`1214eb3`/`20a67ae`/`9f14cc8`. Those three are safe to deploy on their own schedule for kinds other
than `user`, but they enlarge the same live hole by six kinds the moment they ship, so the hotfix
should land first regardless of that rollout's own timeline.
