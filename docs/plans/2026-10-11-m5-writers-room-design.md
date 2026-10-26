# M5 writers' room: roles, review flow and hooks (design for M5-W1 and M5-W2)

**Status:** PLANNED (design only; no code) · **Date:** 2026-10-11 · **Tickets:** M5-W1, M5-W2 in [`2026-10-11-webdesk-m5-plan.md`](./2026-10-11-webdesk-m5-plan.md), plus the hooks W3–W8 need · **Builds on:** [`webdesk-design-v2.md`](../blueprints/webdesk-design-v2.md) §14 WSK-D39, D45, D46 (R3, R4), D52, D55, D58–D62 · **Inputs:** gaiada-web-revamp `docs/CMS_PLAN.md` "Writers' room" (read-only); [`2026-10-10-webdesk-write-plane-design.md`](./2026-10-10-webdesk-write-plane-design.md) §6–§7; [`PERMISSION-CONTRACT.md`](../PERMISSION-CONTRACT.md) §5, §11.1, §12, §25 · **Gated on:** owner question O-4, for the contributor half only (§3).

Every path below was read on `origin/main` @ 1eb33594. Line numbers are from that commit. Short names: `*.yaml` policies are in `platform-nest/cerbos/policies/`; `NNNN_*.sql` in `webdesk/migrations/`; timestamped `*.sql` in `platform-nest/migrations/`; ERP `*.ts` under `platform-nest/src/` (`rbac/`, `admin/`, `auth/`, `core/`, `modules/webdev/`); WebDesk `*.ts` under `webdesk/api/src/control/` and `webdesk/api/src/delivery/vocabulary/`.

## 0. Decisions at a glance

| # | Decision | Why, in one line |
|---|---|---|
| D1 | Four new roles: `webdesk_writer`, `webdesk_translator`, `webdesk_seo_reviewer`, `webdesk_editor`. They sit beside the unchanged tiers `webdev_staff` (editor tier) and `webdev_manager` (publisher). CMS_PLAN's "publisher" **is** the existing publisher tier | Narrow roles for people outside the Web Dev staff tier; nothing that exists moves |
| D2 | A grant is a `user_roles` row at `company` scope plus one or more **scope rows** (site; collections or all; locales or all) in a new table. Cerbos reads them from the grant | Collection keys are per-tenant data. The write-plane §7 sketch (`collectionKey in ["post","guide"]`) would hard-wire gaiada.com into platform policy, against PV-D13 (`2026-10-10-three-perspectives.md`) |
| D3 | The four roles have **no bundle and no `perm_*` mirror**, and are granted only through a dedicated path (the `client_website_editor` precedent, PERMISSION-CONTRACT §25) | A flat catalog key cannot say "this site, these collections": a bundle would overstate reach and a mirror would over-grant |
| D4 | The ERP content BFF moves to a **two-phase gate**: a site-level check first, then the action on the item with attributes read from WebDesk | Today's first check carries no attributes (`webdesk-content.service.ts:26-31`), so a scoped role fails it, and faking "any collection" would over-grant |
| D5 | Review state lives in WebDesk's control plane, **per item version**: a submit, a sign-off and an approval each name one immutable version (migration 0016, numbered at merge) | Versions are append-only (`0002_content.sql:134`), so "approved" cannot drift from the bytes that were approved |
| D6 | Review is **opt-in per (site, collection)**, default off. Where it is on, `content.publish` and `content.schedule` refuse any version that is not the approved one (409 `review-not-approved`), for every principal class, inside the publish transaction | The importer, deck sections and client sites keep working exactly as now |
| D7 | Editorial approval is maker ≠ checker against the **creator of the approved version**: a structural Cerbos DENY that beats the `platform_admin` wildcard. No automation, bot or contributor principal ever approves | The publish shape (`resource_webdesk_content_item.yaml:168-190`), applied to the exact bytes |
| D8 | WS4 publish (D46) is untouched. Approval is a second, earlier human decision, which keeps a publisher's R4 single-item self-publish safe: someone else already checked the content | Composes with the ruling instead of replacing it |
| D9 | Unpublish stays with the publisher tier (D46), although CMS_PLAN gives it to editors. SEO reviewers get no `request_publish`, although write-plane §7 sketched it | Respects the ruling; CMS_PLAN's own table gives SEO reviewers no publish role |
| D10 | If O-4 is yes: one external principal class, `users.kind = 'contributor'`. It has its own tenant anchor (never `company_memberships`), is fenced at the HTTP layer by an allow-list, holds only writer/translator/SEO roles, is time-boxed and MFA-only, and is marked in the editorial assertion (`xc`) so WebDesk holds it to a command allow-list | Each wall fails closed, and no single wall is enough (§3.2) |
| D11 | `/v1` never sees review state, comments, assignees, briefs, scores or suggestions. The frozen read SQL never joins the new tables; the WSK-48a byte gate and a static test prove it | D45's and D41's contract freeze |

These are proposals for §14. The orchestrator assigns WSK-D numbers when they land.

## 1. Facts this rests on

- `resource_webdesk_content_item.yaml`: `:60-61` `collectionKey`/`locale` are carried and read by no rule; `:52` `client` appears nowhere; `:53-55` no `perm_*` mirror; `:56-59` module rules pin `module == "webdev"`.
- `webdesk-content.service.ts:26-31`: item writes re-authorise with WebDesk's `collectionKey`/`locale`, but the FIRST check has none. Restore and preview are authorised as `update` (`webdesk-content.controller.ts:198-217`).
- `cerbos.ts:85-104, 159-206`: `Resource` and `resourcePayload()` are an allow-list; there is no `siteId`. `ownerId` exists, and `variables.owns` reads it (`_variables.yaml:32`).
- `derived_roles.yaml:128-163`: `client_website_editor` is a `client`-scoped grant behind an attribute gate, with no mirror; its tenant is attached at assembly, not stored on the grant.
- `grant-write.service.ts` is the one `user_roles` writer: `:363-384` refuses the client scope and role on generic origins; `:224-285` the ceiling is a bundle subset minus self-scoped pairs, with the baseline on the held side.
- `principal.ts:312-375`: `companies` = active memberships ∪ client contacts; `rootCompanies` falls back to client contacts only when no staff anchor exists.
- `202608201442_users_kind_discriminator.sql`: `users.kind IN ('employee','client','automation','bot')`, default `employee`. `oidc.ts:77-109` links a pre-created account on the first login with a verified email.
- Role-less ALLOW rules that any in-tenant principal reaches: `resource_assistant_thread.yaml:80-85`, `resource_assistant_memory.yaml:38-43`, `resource_agent_run.yaml:78-84` (own rows), `resource_automation_approval.yaml:42-51` (own rows, clients excluded).
- `resource_comment.yaml`: the ERP's generic comments are readable tenant-wide by `member`/`viewer`, so review notes cannot live there.
- WebDesk: `0002_content.sql:73-74` `publish_state` has no review state; `0009` adds head/published pointers; `0012` pending swaps; `0013` preview tokens per version. `command-types.ts`: `EDITORIAL_COMMANDS` and the client allow-list `CLIENT_EDITOR_COMMANDS`. `client-editor.ts`: the `ce` marker only restricts. `editorial-principal.ts:22-25`: `sub` and `pk` are attribution only (D39).
- `webdesk-approved-command.ts:33-48, 541-553`: decide() authorises the decider with `approvalId`, `creatorId`, `itemCount`; the generic `decide` gate is `company_admin`.
- Vocabulary is 1.2.0 (`version.ts:35`) and already has a `relation` primitive (`composition.ts:219`).
- platform-ui `lib/rbac.ts:892-910`: any role outside `CLIENT_SIDE_ROLES` makes a person "staff".

## 2. W1 · Roles as data-driven grants

### 2.1 Who may do what

Scope = the grant's site, collection and locale rows. "Own" = WebDesk's `editorial_items.author_sub` equals the caller.

| Action on `webdesk_content_item` | writer | translator | SEO reviewer | editor (scoped) | `webdev_staff` | `webdev_manager`, `company_admin` |
|---|---|---|---|---|---|---|
| `read` | collection in scope, any locale | same | same | same | ✓ | ✓ |
| `create` | in scope | in scope, and only a twin whose source has an approved or live version | — | in scope | ✓ | ✓ |
| `update` (also restore, preview) | own, state `draft` or `changes_requested` | own, same states | in scope, state `in_review` | in scope | ✓ | ✓ |
| `submit` (and withdraw) **new** | own | own | — | in scope | ✓ | ✓ |
| `comment` **new** | own items | own items | in scope | in scope | ✓ | ✓ |
| `request_changes` **new** | — | — | in scope | in scope | — | ✓ |
| `seo_signoff` **new** | — | — | in scope | — | — | ✓ |
| `approve` **new** | — | — | — | in scope, maker ≠ checker | — | ✓, maker ≠ checker |
| `assign` **new** | — | — | — | in scope | — | ✓ |
| `request_publish` | — | — | — | in scope | ✓ | ✓ |
| `publish`, `schedule`, `unpublish`, `delete` | — | — | — | — | — | ✓ (unchanged, D46) |

Anyone holding an editorial scope on a site also gets `webdesk_collection:read` and `webdesk_media_asset:read` there. A new action, `webdesk_collection:manage_editorial` (grant editorial roles, set the review policy), has the same holders as `apply_schema`.

### 2.2 How a grant carries its scope

```
user_roles  (role = webdesk_writer, scope_type = 'company', scope_id = the ERP company that owns the WebDesk tenant, expires_at)
  └─ user_role_editorial_scopes (user_role_id FK ON DELETE CASCADE, tenant_id, webdesk_tenant_slug, site_id,
                                 all_collections bool, collections text[], all_locales bool, locales text[])
```

- "All" is an explicit boolean, never an empty list. CHECK: `all_x` ⇔ `cardinality(x) = 0`, otherwise 1..100 entries.
- `assemblePrincipal()` attaches `editorialScopes: [{siteId, allCollections, collections, allLocales, locales}]` to each editorial grant (a conditional spread, the `scopeTenantId` shape). `principalPayload()` must list it, or it never reaches Cerbos.
- Six derived roles go into `derived_roles.yaml` after the WSK-49f block: `webdesk_editorial_site` (any editorial role on `resource.siteId`), `webdesk_editorial_reader` (site + collection, any locale), and one per role, `webdesk_writer` / `_translator` / `_seo_reviewer` / `_editor` (site + collection + locale). All match `scopeType == "company"` only. The writer, as an example:

```yaml
- name: webdesk_writer
  parentRoles: ["user"]
  condition:
    match:
      expr: >-
        request.resource.attr.siteId != "" &&
        request.principal.attr.grants.exists(g, g.role == "webdesk_writer" &&
          g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId && has(g.editorialScopes) &&
          g.editorialScopes.exists(s, s.siteId == request.resource.attr.siteId &&
            (s.allCollections || request.resource.attr.collectionKey in s.collections) &&
            (s.allLocales || request.resource.attr.locale in s.locales)))
```

- Resource rules add the instance conditions **inline**, never through `variables.local`. Writer `update` = `variables.inTenant && variables.notLow && variables.owns && request.resource.attr.reviewState in ["draft","changes_requested"]`. Translator `create` adds `(request.resource.attr.reviewState == "approved" || request.resource.attr.published == true)`, where for a twin `create` both attributes describe the SOURCE item. `approve` adds `request.resource.attr.reviewState == "in_review" && has(request.resource.attr.creatorId) && request.resource.attr.creatorId != "" && request.resource.attr.creatorId != request.principal.id`.
- Each editorial derived role sits in its OWN rules, never in one rule with a scope-only role (the `org_unit_lead` authoring rule, `derived_roles.yaml:73-80`).
- DENYs (`roles: ["user"]`, deny-overrides): `approve` when `creatorId == principal.id`, which beats `platform_admin`; `approve` and `seo_signoff` when `principal.attr.kind in ["automation","bot"]`; the contributor DENYs of §3.1.

### 2.3 Where every attribute comes from: the two-phase gate

| Attribute | Source | Never from |
|---|---|---|
| `tenantId` | route `:tenantId`, validated by `AuthGuard` | — |
| `siteId` (**new**) | route `:siteId`, after `resolveEditableSite()` proves the site is this company's | body, query |
| `collectionKey`, `locale` | WebDesk `item.get`. For `create`: the route key (proven by `collection.get`) and the body locale (WebDesk validates it) | any other caller input |
| `ownerId` (= the author) | WebDesk `editorial_items.author_sub` | body |
| `reviewState` (**new**), `published` (exists, from HR-FULL) | WebDesk `editorial_items.state`, `publishedVersion !== null`; for a twin `create`, the source item's | body |
| `creatorId` (approve) | WebDesk `created_by` of the version being approved | body |

**Phase 1**, the first statement of every content handler: `webdesk_collection:read` on `{tenantId, module, siteId}`. **Phase 2**, before any body validation: the real action, with the attributes above. `ContentGate` splits into `SiteGate` → `ItemGate`. A service method that writes needs an `ItemGate`, and only a WebDesk read can produce one (the compile-time pattern of `webdesk-content.service.ts:150-184`). `GET sites` asks Cerbos per site and returns the allowed ones. `item.get` returns `allowed: {…}` from one Cerbos call, so the UI never guesses from bundles (PERMISSION-CONTRACT §5). Until W1c sends `siteId` and `reviewState`, the new rules read `""` and deny. That is stated here so it is not discovered later (PERMISSION-CONTRACT §11.1's lesson).

### 2.4 Beside the existing tiers

| Principal | Change |
|---|---|
| `webdev_staff` (module_staff, the unscoped editor tier) | gains `submit` and `comment` |
| `webdev_manager`, `company_admin` (+ `owner`, which mirrors `company_admin`; `platform_admin` by wildcard) | gain all six new actions and `manage_editorial` |
| `client_website_editor` (D60, client scope) | no change. The editorial commands are not in `CLIENT_EDITOR_COMMANDS`, so a `ce` principal stays refused |
| the four new roles | §2.1, only through the dedicated grant path |

### 2.5 The IAM traps, and how each is avoided

| Trap | How |
|---|---|
| Role bundles overstate reach; parity is blind to conditions | The four roles have no bundle. They are exempted in `role-bundle-completeness` and `role-permission-parity` with the reason written next to them, like `client_website_editor`. The proof is a live probe matrix in both directions after a Cerbos restart (W1a), never a green parity run |
| A ceiling cannot subset a baseline bundle | Editorial grants never meet the bundle ceiling. Their ceiling is a live Cerbos question, `manage_editorial` on that site, and its holders reach every editorial action by construction. The module-role bundles that grow (+2 and +7 keys, none self-scoped) are held by `company_admin` and `owner`, so existing grants of `webdev_staff`/`webdev_manager` still pass; W1a re-runs the ceiling suite |
| Flat perm mirrors cannot express attribute gates | No `perm_*` arm for any new action (the kind's own invariant); attribute roles never share a rule with scope-only roles; `iam-04-reg1-mirror-reach-invariant` runs unscoped |
| A global grant has no root | The derived roles match `company` only, so `scope-constrained-roles.json` pins them there and `assemblePrincipal()` drops any other scope (IAM-SEC-06). The grant path and a DB guard refuse it at write time. Contributors are rooted by their own anchor row, never by a global grant or a borrowed membership |
| UI-editable roles unlock the permission arm | The legacy admin path, the `ui` origin and position role sets refuse the four roles by name (`editorial_role_dedicated_path`) |
| Local variables hide self-scope; validation pre-empts authz | Conditions are inline. Both phases run before body validation. Denial tests send valid bodies and keep a positive control |

### 2.6 The grant path

`grantEditorialRole` / `revokeEditorialRole` live in `grant-write.service.ts`, so the writer guard still finds every `user_roles` write in that one file. The caller must pass Cerbos `webdesk_collection:manage_editorial` on `{tenantId, siteId}`. Inside the transaction the path re-checks what Cerbos cannot see: the site is this company's (WebDesk `tenant.list`), the collections exist, the locales are the tenant's, no self-grant, and the contributor rules of §3.1. It writes the grant and its scope rows together, bumps the target's session, and audits identifiers only. The trigger `user_roles_editorial_guard` keeps the four roles at `company` scope and off positions, for any writer. BFF: `GET/POST/DELETE …/sites/:t/:site/editorial/grants`. MCP: `webdesk.editorial.grantRole` (**high**, D14 for an unattended caller, like `iam.grantRole`) and `webdesk.editorial.revokeRole` (**medium**: a de-escalation does not wait).

## 3. O-4 · Freelance writers as ERP logins

### 3.1 Designed for "yes": the contributor principal

1. **Kind.** `users.kind` gains `contributor`, through a self-verifying CHECK widening (the `202610110520` pattern: a DROP+ADD from memory has deleted values on live). People surfaces list `kind = 'employee'`; `users-kind-readers.db.test.ts` is the inventory to re-check.
2. **An anchor, not a membership.** `editorial_contributors (tenant_id, user_id, sponsor_user_id, status, valid_until NOT NULL, at most 180 days ahead, …)`, FORCE RLS, with the `principal_lookup` read shape that `client_contacts` uses (0072 §7b). `assemblePrincipal()` adds active, unexpired anchors to `companies`, and to `rootCompanies` only when no staff anchor exists. Never `company_memberships`: most of its readers do not filter `kind`, which is why clients were kept out of it (PERMISSION-CONTRACT §13.1).
3. **Invite.** A sibling of the client-contact invite (`core/client-contacts.controller.ts`, `client-invites.ts`, `keycloak-admin.ts`). It pre-creates the `users` row with `kind = 'contributor'` and issues a single-use hashed token; acceptance provisions the Keycloak account into a `contributors` group with OTP as a required action. It is never a widening of the client invite: a client link that could mint a staff-side principal crosses the boundary. An existing `users` row converts only if it holds no grant, no membership and no client contact.
4. **Roles.** Only `webdesk_writer`, `webdesk_translator`, `webdesk_seo_reviewer`; never `webdesk_editor`, because approval is a staff function. Every grant carries `expires_at`, no later than the anchor's `valid_until`. The grant path and the DB guard both enforce this, for any writer, seeds included.
5. **HTTP fence.** In `AuthGuard` (`src/auth/guards.ts`), right after the principal is assembled: a contributor reaches only routes marked `@ContributorRoute()` (the writers' room BFF, `/me`, logout), and only at `assurance == "high"`. Everything else answers 403 `contributor_route_forbidden`. An inventory test pins the marked set, so a new route is closed to contributors until someone opens it on purpose.
6. **Cerbos, the second wall.** DENY on `principal.attr.kind == "contributor"` for `assistant_thread`, `assistant_memory` and `agent_run` (the role-less ALLOWs of §1: the assistant's retrieval and tools were designed for staff), and for `approve`, `assign`, `request_publish`, `publish`, `schedule`, `unpublish`, `delete`, `manage_editorial`, `apply_schema` and every media write. *(Narrowed by WSK-D84: contributors may upload media into the Q2 quarantine, so W1d narrows this DENY to match.)*
7. **WebDesk, the third wall.** The editorial assertion gains an optional signed claim `xc: true`, which the ERP signer (`webdesk-editorial-signer.ts`) sets from `users.kind`, never from a parameter. With it, WebDesk allows only `CONTRIBUTOR_COMMANDS`: content create/update/restore, preview mint/revoke, and `editorial.submit`, `withdraw`, `comment`, `commentResolve`, `requestChanges`, `seoSignoff`. `xc` together with `ce` is 401 `-claims`. Like `ce` (WSK-49b), it only ever restricts.
8. **Interface.** `/me` exposes `kind`; `isStaff(me)` is false for contributors; a `(contributor)` route group with its own shell (my assignments, the editor in contributor mode, preview, comments), mirroring `(portal)`.
9. **Leaving.** Ending the anchor, or its expiry sweep, revokes every editorial grant through the choke point, bumps `session_version` (D11) and disables the Keycloak account. The `expires_at` filter (PERMISSION-CONTRACT §12.4) already cuts access at the next request.

### 3.2 Security implications

| Threat | Walls |
|---|---|
| A contributor reaches staff data or tools | role allow-list (grant path + DB guard) · `AuthGuard` fence · Cerbos contributor DENYs · separate shell |
| Drafts outside the engagement leak | collection/locale scope on every read; no media writes |
| A stolen contributor password | OTP in Keycloak and `assurance == "high"` in the ERP. This fails closed until the AMR mapper is proven live (W1g) |
| Access lingers after the engagement ends | anchor `valid_until`, grant `expires_at`, the sweep, the session bump, the Keycloak disable |
| Our domain hosts a contributor's files | media upload refused to contributors in v1 (Q2) |
| Hostile text in a draft | nothing goes live without a staff approval and a WS4 publish; AI assist treats content as data and calls no tools |
| Other SSO apps admit any realm user | realm `gaiada` is shared, which is already true for client contacts: W1g audits every OIDC client for a group requirement |
| Personal data | the contributor's account and any public author profile need a RoPA row (Q3) |

### 3.3 If the owner says "no"

W1d–W1g drop out, about a third of W1. The four roles, the scope rows, the two-phase gate and all of W2 stay, for staff only; freelance copy comes in through a staff writer. There is no new principal class, so §3.2 does not apply. Saying yes later costs only the dropped tickets, because contributors sit on top of the same roles. The cost of "no": CMS_PLAN's "freelancers get an ERP login" is not met, and freelancers work in an outside tool. That is not a D40 breach, since they hold no ERP identity.

## 4. W2 · The review flow

### 4.1 States

brief (ERP, W4) → `draft` → `in_review` ⇄ `changes_requested` → `approved` → schedule / publish (WS4 and the existing `publish_state`) → refresh (W8 and V4 raise a refresh brief).

| Transition | Command | Precondition (409 otherwise) | Effect |
|---|---|---|---|
| create | `content.create` | — | an `editorial_items` row, `draft`, `author_sub` = the creator |
| assign | `editorial.assign {authorSub, dueAt, plannedPublishAt, briefRef}` | the BFF asks Cerbos as the assignee whether they could `update` the item in `draft` (422 `assignee-cannot-edit`) | author and dates set |
| submit | `editorial.submit {version}` | state `draft`/`changes_requested`; version = head | `in_review`, `submitted_version` |
| withdraw | `editorial.withdraw` | `in_review` | `draft` |
| edit in review | `content.update` (SEO reviewer, editor, staff) | `in_review` | stays `in_review`; `submitted_version` follows the new head, and a sign-off of an older version no longer counts |
| request changes | `editorial.requestChanges {version, note}` | `in_review`; version = submitted | `changes_requested` |
| SEO/AEO sign-off | `editorial.seoSignoff {version}` | `in_review`; version = submitted | `seo_signed_version`, plus W3's lint report for that version, computed by the server |
| approve | `editorial.approve {version}` | `in_review`; version = submitted; signed if the policy requires it | `approved`, `approved_version` |
| edit after approval | `content.update` | `approved` | back to `draft`; `approved_version` stays publishable |

Problem slugs: `review-state-conflict` `{currentState}`, `review-version-mismatch`, `review-not-approved`, `seo-signoff-required`.

### 4.2 Where it lives: WebDesk migration 0016 (number at merge; 0015 is M5-L2's)

```sql
editorial_policies (tenant_id, site_id, collection_key, review_required bool DEFAULT false,
                    seo_signoff_required bool DEFAULT false, updated_by text, updated_at, PRIMARY KEY (site_id, collection_key))
editorial_items    (content_item_id PK FK, tenant_id, site_id, state CHECK (draft|in_review|changes_requested|approved),
                    author_sub, submitted_version, seo_signed_version, seo_signed_by, seo_snapshot jsonb,
                    approved_version, approved_by, approved_at, due_at, planned_publish_at, brief_ref, updated_at)
                    -- each *_version is a composite FK to content_versions (content_item_id, version), the 0013 shape
editorial_events   (id, tenant_id, content_item_id, version, kind, actor_sub, note ≤ 2000, created_at)   -- append-only
editorial_comments (id, tenant_id, content_item_id, version, anchor (JSON pointer ≤ 512), body 1..4000,
                    author_sub, created_at, resolved_at, resolved_by)
```

FORCE RLS `tenant_isolation`, fail-closed, exactly as `0012` and `0013`. The app role gets no UPDATE or DELETE on events and no DELETE anywhere. No backfill DML: a legacy item reads as `draft` with no author until first touch, so writers cannot edit it (fail closed). Indexes for the board: `(site_id, state)`, `(site_id, due_at)`. Every `*_sub` is an opaque ERP id (D39).

### 4.3 Commands and impact classes

| WebDesk command (`/control/v1/tenants/:t/sites/:site/…`) | Impact / scope | ERP route (§27) · MCP tool (impact) |
|---|---|---|
| `editorial.submit`, `.withdraw` | medium / operate | `POST …/items/:id/editorial/submit` and `/withdraw` · `webdesk.editorial.submit`, `.withdraw` (low) |
| `editorial.requestChanges` | medium / operate | `…/request-changes` · (low) |
| `editorial.seoSignoff` | medium / operate | `…/seo-signoff` · (medium; Cerbos refuses automation and bots) |
| `editorial.approve` | medium / operate | `…/approve` · (medium; Cerbos refuses automation, bots and contributors) |
| `editorial.assign` | medium / operate | `…/assign` · (low) |
| `editorial.comment`, `.commentResolve` | medium / operate | `…/comments`, `…/comments/:c/resolve` · (low) |
| `editorial.policySet` | medium / operate | `PUT …/collections/:key/editorial-policy` · `webdesk.editorial.setPolicy` (medium) |
| `editorial.board`, `editorial.history`; `item.get` and `item.list` gain an `editorial` member | read | `GET …/editorial/board`, `GET …/items/:id/editorial` · read tools |

Every write takes an `Idempotency-Key` and an editorial assertion, writes its audit row first (`control.editorial.<cmd>`), and joins `EDITORIAL_COMMANDS`, never `CLIENT_EDITOR_COMMANDS`. None is HIGH, because none changes what a production key sees. The ERP notifies after success: a submit goes to the editors in scope; changes requested and approvals go to the author.

### 4.4 Maker ≠ checker

The maker of an approval is the creator of the version being approved. So an editor who rewrites a draft during review cannot approve their own rewrite: a second editor or a publisher must. Cerbos is the only authority (the structural DENY plus the inline arm). WebDesk does not re-derive it (D39), the same posture as publish. SEO sign-off has no maker ≠ checker: it is a recorded check, and the approval after it is four-eyed. Automation, bot and contributor principals never approve.

### 4.5 With WS4 publish and client publishing

- **Order.** Approve (editorial state in WebDesk) → `request_publish` of the **approved version** (the existing route; the BFF refuses early with the same 409) → decide() by a publisher (D46: maker ≠ checker, R4 single-item self-publish) → `content.publish`, which checks inside its transaction, under the item lock: the WS4 claim, then D62's client paths (when `ce`), then the review gate, then the effect. A refusal rolls back the claim, and the approval row goes `failed` with `webdesk_refused: 409 review-not-approved`.
- **Schedule** is gated the same way at `content.schedule`. A pending swap (0012) is not re-gated, and the newest human decision still cancels it (WSK-61).
- **R4 stays safe.** On a review-required collection, someone other than the last author approved the content before a publisher could file it. A publisher who self-publishes one item is therefore the second person, not the first.
- **Client sites (D58, D59, D62).** The policy defaults off. If the agency turns review on for a client collection, a client's publish needs an approved version, and client editors cannot approve (no editorial command is on their allow-list). D62's path check runs independently. Client sign-off of agency copy is out of scope here; a later extension can follow `social_client_review`.
- `content.promote` moves already-published content and is not gated.

### 4.6 What `/v1` must never see

Review state, events, comments, assignees, author subs, due dates, briefs, policies, lint and AEO snapshots, and AI suggestions. The frozen read SQL never joins `editorial_*` (the WSK-48a byte gate re-runs on the 0016 tree); `webdesk/api/src/delivery/**` may not name those tables (a static test); the preview route (0013) serves only the version envelope; tenant webhooks gain no editorial event kinds.

## 5. Hooks for W3–W8

| Ticket | What W1/W2 leave for it | Its own boundary |
|---|---|---|
| W3 checks | `LintReport` (`content-lint.ts`) gains a `checks` member beside `placeholders` (one H1, meta lengths, alt text, sources, internal links, the ID twin, an AEO score). `seoSignoff` snapshots it on the server for the signed version | advisory, never fatal; per-collection rules in the composition's `lint` member (a vocabulary MINOR, rated by the classifier) |
| W4 briefs | `editorial_items.brief_ref` (opaque), set by `assign` or by "create from brief"; an assigned writer reads the brief | briefs are ERP records drawn from `search`: a new kind `webdesk_brief` (six artifacts), assignee via `variables.owns`; a V4 decay alert files a refresh brief |
| W5 calendar and board | `editorial.board`: state, author, due and planned dates, submitted/approved/published versions, `publish_at`, any pending swap | the ERP joins briefs and WS4 requests; rows are filtered by Cerbos in chunks of at most 50 (the batch limit); a failed read is a 503, never `[]` |
| W6 AI assist | `POST …/items/:id/assist {kind, version}`, authorised as `update`; only the ERP calls `ai-gateway-go` | returns suggestions and writes nothing; a human applies each one and saves through `content.update`; approval stays human-only; a budget per principal; no content in logs |
| W7 authors | nothing from W1/W2 | an `author` collection with the public E-E-A-T fields, and a `relation` field on posts (vocabulary 1.2.0 already has it). The link between an ERP user and a profile never enters a field |
| W8 dashboard | item ↔ page path, from the composition | Umami (A4), Search Console (SM-25b), leads (L4's attribution) and decay (V4), as counts only. A lead's identity needs `agency_lead:read`, which no editorial role and no contributor holds |

## 6. Migrations

| Component | File | Ticket |
|---|---|---|
| WebDesk | `0016_editorial_review.sql` (number at merge; 0015 is M5-L2's) | W2a |
| platform-nest | `<ts>_iam_writers_room_roles.sql`: 4 global roles, +7 permissions, `role_permissions` exactly as `gen:role-bundles` derives them, the owner ≡ company_admin DO-block self-assertion | W1a |
| platform-nest | `<ts>_iam_editorial_grant_scopes.sql`: the scope table (FORCE RLS + `principal_lookup`), `user_roles_editorial_guard`, the position-role clause | W1b |
| platform-nest | `<ts>_contributor_principal.sql` (only if O-4 is yes): the `users.kind` widening, `editorial_contributors`, contributor invites, the guard extension | W1d |

Timestamps are taken at merge. Every CHECK widening reads the live definition first.

## 7. Cerbos artifacts

W1 adds no new kind (W4's `webdesk_brief` will be one), but the same six artifacts move: (1) policies: `resource_webdesk_content_item.yaml`, `resource_webdesk_collection.yaml`, the `read` arm of `resource_webdesk_media_asset.yaml`, the contributor DENYs in `resource_assistant_thread.yaml`, `resource_assistant_memory.yaml` and `resource_agent_run.yaml`, and six derived roles; (2) `cerbos.ts`: `siteId` and `reviewState` on `Resource` and `resourcePayload()`, `editorialScopes` on the grant map; (3) the catalog, +7 keys (`webdev.webdesk_content_item.{submit,comment,request_changes,seo_signoff,approve,assign}`, `webdev.webdesk_collection.manage_editorial`; sensitive: `approve`, `seo_signoff`, `manage_editorial`); (4) groups: `submit` and `comment` join `webdesk_content_editing`, a new `webdesk_editorial_review`, `manage_editorial` advancedOnly; (5) the seed migration; (6) both bundle resolvers. Also: regenerate `scope-constrained-roles.json`, update the four pinned counts and a new PERMISSION-CONTRACT section, then restart and probe `gaiada-test-cerbos` and the live sidecar.

## 8. BFF, MCP and UI

- **BFF** (FRONTEND-BFF-CONTRACT §27, extended): the two-phase gate on every content route; `allowed` on `item.get`; the editorial routes of §4.3; grants (§2.6); contributors (`POST /api/:t/editorial/contributors/invite`, `…/:userId/end`, and the public `POST /api/editorial-invites/:token/accept`).
- **MCP** (`platform-nest/src/modules/webdev/index.ts`; hub test `mcp-hub/src/webdesk-content-tools.test.ts`): the tools of §4.3 and §2.6, plus `webdesk.editorial.inviteContributor` (**high**) and `.endContributor` (medium).
- **UI** (`platform-ui/src/app/(app)/departments/[deptId]/website/`): a **Writers' room** group: `writers` (board), `writers/calendar`, `writers/briefs`, `writers/authors`, `writers/dashboard`, `writers/people` (grants and contributors, publisher tier). The editor gains an editorial panel: state, submit/withdraw, review actions driven by `allowed`, comments anchored to field paths, checks, an assist drawer. Contributors get the `(contributor)` shell.

## 9. Tickets

| # | Scope | Seat · model | Depends | Accepted when (QA can execute) |
|---|---|---|---|---|
| W1a | Cerbos six artifacts + the seed migration (§7) | senior-be · **Opus·high** (attribute roles under deny-overrides; a slip is a silent over-grant) | this design | `cerbos compile` clean. After a restart, one `POST /api/check/resources` per principal: writer update on own, in-scope item ALLOW; other collection, locale, site or author, or state `in_review`, DENY; translator twin of an approved source ALLOW, of a draft DENY; SEO reviewer update in `in_review` ALLOW, in `draft` DENY; editor approve of another's version ALLOW, own DENY; `platform_admin` self-approve DENY; bot approve DENY; a `global` writer grant DENY; the existing webdev matrix unchanged; REG1 unscoped green; pinned counts updated |
| W1b | Scope rows, the guard trigger, `assemblePrincipal`/`principalPayload`, the dedicated grant path, the generic refusals, grant BFF + MCP | senior-db + senior-be · **Opus·medium** (a wrong `principal_lookup` policy leaks scopes or silently returns zero rows) | W1a | a grant writes role and scopes atomically; legacy admin, the `ui` origin and positions refuse with `editorial_role_dedicated_path` (valid bodies); a raw INSERT at `global` is rejected by the trigger; a principal sees only its own scopes (cross-tenant DB test); a scope-less grant probes DENY; revoke removes both and bumps the session |
| W2a | WebDesk 0016 | senior-db · Sonnet, Opus review | — | the runner applies it twice with no change; the RLS lint passes; an unset `tenant_ctx` reads 0 rows and refuses writes; `/v1` bytes identical before and after on the same fixtures; the static test forbids `editorial_` under `delivery/` |
| W2b | WebDesk commands, the state machine, reads, the `editorial` member | senior-be · Sonnet, Opus review | W2a | a table-driven test of every legal and illegal transition (409 slugs); version mismatch 409; a replay returns `replayed: true`; the registry spec pins impact, scope and set membership; a `ce` principal gets 403 `client-command-not-allowed`; `webdesk/qa/linux-gate.sh` green |
| W1c | The two-phase gate on every content route, attribute provenance, `allowed`, per-site `GET sites` | senior-be · Sonnet, Opus review | W1b, W2b | a writer's PUT on another author's item is 403 with a valid body, and WebDesk receives no write; body or query cannot set `siteId`, `collectionKey`, `locale`, `ownerId` or `reviewState`; `allowed` equals a direct Cerbos answer; staff routes unchanged (existing suites green) |
| W2c | The publish gate in WebDesk; the early refusal and the approver's view in the ERP | senior-be · **Opus·medium** (it composes WS4, R4, D58 and D62; a slip puts unreviewed copy live) | W2b | an unapproved version on a review-required collection: 409 `review-not-approved`, projection unchanged, WS4 claim rolled back, approval row `failed`; the approved version publishes; a mixed batch refuses whole; review-free collections unchanged; schedule gated the same; a `ce` publish still held to D62 |
| W2d | ERP BFF + MCP for §4.3, notifications, §27 rows | medior · Sonnet | W1c, W2b | every route answers 403 before validation for a denied caller; the MCP tools carry the stated impact; a bot's approve is 403; notification recipients asserted |
| W2e | Writers' room UI: editorial panel, comments, review actions, a review-state filter on the item list, `writers/people` grants page | medior · Sonnet, senior-uiux review | W2d | every state renders distinctly; buttons follow `allowed`; a Playwright drive on the Linux gate; `next build` green |
| W1d | Contributor principal: kind, anchor, invite, `AuthGuard` fence, Cerbos DENYs, leaving | senior-be · **Opus·high** (a new external principal class on the identity path) | W1b; O-4 yes | invite → `kind = contributor`, an anchor, the token shown once; accept (Keycloak test double) sets the group and OTP; any non-annotated route is 403 (inventory test over every route); creating an assistant thread is 403; `linked` assurance is 403; ending revokes grants, bumps the session and disables the login |
| W1e | WebDesk `xc` claim + `CONTRIBUTOR_COMMANDS`; the ERP signer sets it from `users.kind` | senior-be · Sonnet, Opus review | W1d, W2b | a non-boolean `xc` is 401; `xc` with `ce` is 401; refused commands are 403 with valid bodies; the signer has no code path that takes `xc` from input |
| W1f | Contributor shell, `kind` on `/me`, `isStaff`, the staff-side invite form, routing tests | medior · Sonnet, senior-uiux review | W1d, W2e | a contributor lands in the shell; staff and client routing unchanged (tests); `next build` green |
| W1g | Server: Keycloak `contributors` group + OTP, AMR mapper proven live, an audit of every OIDC client in realm `gaiada` | orchestrator (server work) | before the first invite | high assurance observed for a test contributor; every client listed with its access rule in a runbook |

**Order:** W1a ∥ W2a → W1b ∥ W2b → W1c, W2c → W2d → W2e. After O-4: W1d → W1e → W1f, and W1g before any invite. W3 and W7 need nothing from W1/W2 beyond the snapshot hook; W4 can start after W2b; W5 and W6 after W2d; W8 after A4 and L4. No ticket here is Haiku-grade: each one touches authorization, a contract or a migration.

## 10. Risks

1. **Rules ahead of their transport** (PERMISSION-CONTRACT §11.1). The new rules read `""` and deny until W1c ships. W1a's probes set the attributes by hand; W1c repeats them through the real routes.
2. **Approval friction.** With the owner as the only real staff login (D55), an owner-written version on a review-required collection has no second approver. Keep review off on gaiada.com until the first writer is onboarded; the owner then approves the writers' work.
3. **The scoped roles are invisible to parity.** Only probes prove them. A future "consistency" bundle for them would make the ceiling and `can.scopeOnly()` claim reach they do not have; the exemption entries carry that reason.
4. **Client sites.** Turning review on for a client collection takes D58's self-publish away for it. Do it only by agreement with the client.
5. **The shared realm.** Until W1g's audit, any OIDC client that admits every realm user admits contributors, as it already admits client contacts.
6. **The §7 sketch.** Write-plane design §7 says these roles need no further allow-list change. It predates site scoping and review state; this design adds `siteId` and `reviewState` and moves collection lists out of policy.

## 11. Open questions for the owner

| # | Question | Recommendation | Gates |
|---|---|---|---|
| O-4 | Do freelance writers get ERP logins (contributors, writers' room only)? | **Yes**, with the walls of §3.1 | W1d–W1g **ANSWERED 2026-10-13: yes (WSK-D84).** |
| Q2 | May contributors upload images? Uploads land in a public library on our domain | **Not in v1.** If yes, a quarantine (an asset is not served until a staff editor accepts it), designed as its own ticket | W1e's allow-list **ANSWERED 2026-10-13: yes, uploads are allowed (WSK-D84), so the quarantine is built with W1d.** |
| Q3 | Contributors' account data and public author profiles are personal data the legal pack does not cover. Add RoPA rows and a profile consent to counsel's list (O-3)? | **Yes**, before the first contributor or the first real author profile | W1d live, W7 live |
