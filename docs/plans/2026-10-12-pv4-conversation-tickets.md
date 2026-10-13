# PV-4: Conversation between client and staff (tickets)

**Status: PLANNED.** Nothing here is built.

- **Parent plan:** `docs/plans/2026-10-10-three-perspectives.md` §2.4 (two client channels), §3.5 (new
  data), §9 (traps 1, 2, 4, 9, 11).
- **Rulings in force:**
  - PV-D5: Conversation is its own channel, and anything with a money or legal effect lands in
    Contracts & billing.
  - PV-D22: threads on each project, plus one client-wide thread per client.
  - PV-D23: agents draft, staff send.
  - PV-D24: every contact who can see a project takes part, signers and viewers alike.
  - Also PV-D4 (the five areas, every URL kept), PV-D10 (one client record per company) and PV-D13
    (no company names or ids in code).
- **Base:** `origin/main` at `0686274f` (`v1.0.0-alpha.365`), read 2026-10-12 from a clean detached
  worktree.
- **Paths:** `PN` = `platform-nest/`, `UI` = `platform-ui/src/`, `MH` = `mcp-hub/src/`.

## What people will notice

- **Clients** get a **Conversation** tab under Projects. They see a thread list per project, plus
  one general thread for their organisation. They can open a thread, reply and attach files. New
  messages appear live. The Projects tab shows how many threads are unread.
- **Staff** see the same threads in the client page's Projects area and on each project page. Threads
  waiting for our reply are counted on the client Overview. Every message carries the "Client sees
  this" marker, because every message does reach the client.
- **Agents can draft a reply but never send one.** A draft appears in the thread for staff only, with
  Send, Edit and Discard. Cerbos refuses a `bot` or `automation` principal that tries to post.
- **A change request that changes the price cannot start until an amendment is signed.** Triage asks
  "does this change the price?". A yes creates a draft amendment in Contracts & billing, and the
  request waits there until both sides have signed.
- **Meeting notes can be shared.** Staff (or an agent, as a draft) write the notes for a meeting with
  the client. A staff member shares them, and the client reads them on the project in the portal.
  The recording and transcript stay internal.

## Findings from reading the code (they shaped the tickets)

1. **The portal has no inbox.** It has no bell (`UI/components/portal/PortalShell.tsx:14`), and
   nothing in the portal reads `notifications`. Client `notify()` rows are written but never
   shown. Mail goes out for exactly two notification types (`PN/src/mail/intake.ts:23`). So a
   client learns about a new message from an unread count on the portal, and later from mail.
   → **PV4-06.**
2. **There is no project team.** No `project_members` table exists. Staff hear about client
   actions only through `projects.owner_id`, and when that is empty the notice goes to nobody
   (`PN/src/core/portal-commerce.controller.ts:560-575`). → PV4-06 defines the staff recipients
   (finding 2's rule), and an unanswered thread also shows on the hub, so nothing depends on one
   person being notified.
3. **`comments` is staff-only by policy, not by data.** It has no client column and no visibility
   flag, its RLS is tenant-wide, and `resource_comment.yaml` has no client rule. Plan trap 2 holds:
   Conversation gets its own tables. → **PV4-01.**
4. **The client derived role lives on exactly one kind, `portal`** (`resource_portal.yaml`;
   `derived_roles.yaml:120-126`). Every client action is a `portal` action (`request_change`,
   `approve_post`, and so on), and earlier kinds assert that as an invariant (`0072:32-36`). So PV-4
   adds a **staff** kind, `conversation`, and gives the client one new `portal` action, `converse`.
   The client role never appears outside `resource_portal.yaml`. → **PV4-02.**
5. **Cerbos can already refuse a class of principal.** `resource_webdesk_content_item.yaml:437-440`
   denies `publish` to `principal.attr.kind in ["automation","bot"]`. Delegation is covered:
   `authorize()` checks the caller and the `actFor` human, and either denial refuses. PV-D23 uses
   the same shape: an `EFFECT_DENY` on `conversation` `post` for agents and automation.
   → **PV4-02.**
6. **Portal live updates fan out by tenant and client only.** A frame carries `{topic, at}` and
   nothing else (`PN/src/core/portal-live.service.ts:127-147`).
   - A new topic needs four edits: `PortalTopic` (`:36-43`), the hand-copied union at
     `UI/lib/portal.ts:266`, `TOPIC_BY_EVENT`, and `TAILED_ENTITY_TYPES` (`:79-84`).
   - BFF §16d lists 6 topics; the code has 7.
   - The staff side has no live channel at all. → **PV4-03**: a `conversation` topic for the
     portal, and polling on staff screens.
7. **Contracts can be re-issued but have no amendment concept.** `version` and `supersedes_id`
   exist (`0075:101-108`) for re-issuing, and the replaced row is never voided. Nothing marks a
   contract as an amendment of another, and nothing links one to a change request.
   `webdev_change_requests` has no price, amount or contract field (`0088`). → **PV4-01** adds the
   columns, and **PV4-04** enforces the rule.
8. **Meetings have no minutes.** The only text is the raw `transcript`, and there is no share flag.
   `meeting` is in `NEVER_CLIENT_VISIBLE` (`PN/src/core/portal-visibility.ts:241`) for a good
   reason: the recording, the transcript and the participants must stay internal. So minutes become
   a new object with their own predicate, and `meeting` stays on the never-visible list.
   → **PV4-01, PV4-05.**
9. **Attachments need three allow-lists.**
   - The staff content route authorizes the file's `target_entity_type` as a Cerbos kind
     (`PN/src/core/files.controller.ts:131`).
   - The portal download route admits only `DOWNLOADABLE` kinds, through `ownsEntity`
     (`portal-commerce.controller.ts:56-61,494-530`).
   - The portal has no generic upload route. Payment proof uploads inline in its own route, 10 MB
     base64 (`:152-160,526-548`).
   - So message attachments upload inline with the message as `target_entity_type =
     'conversation'`, which needs no change to the staff route once the kind exists. They also need
     one `DOWNLOADABLE` entry. → **PV4-03.**
10. **`client_contacts.capability` is `signer | viewer | admin`.** The only capability gate is
    `requireSigner` (`portal-scope.ts:104-110`). Under PV-D24, conversation never calls it.
    `request_change` already set this precedent: it is open to viewers (`resource_portal.yaml`
    header).
11. **Impact tiers are `low | medium | high`.** D14 also has a bar list
    (`registerBarredExecutable`, `PN/src/core/approval-executables.ts:251`). No tool sends a message
    to a client today. The generic `notify` tool can reach a contact, but it has no author, no thread
    and no scope check, so it is not a substitute. → **PV4-07.**
12. **Pinned counts move with every new kind.** Today: 103 kinds, 434 pairs, 419 grantable, 15
    relationship. The four pinned tests are `iam-215-boundary-pin`,
    `permission-groups-catalog-parity`, `ui-grantable-catalog` and `cerbos-catalog-alignment`. The
    template is commit `2c5ab99e` (M6-P3c, the `webdev_site` kind) with migration
    `202610111808_iam_webdev_site_permissions.sql`. WebDesk sessions add kinds too, so these pins are
    a merge hotspot. → PV4-02 rebases on `origin/main` right before merge and recomputes.

## Design decisions made in these tickets (lead, within the rulings)

| # | Decision | Why |
|---|---|---|
| 1 | Staff kind `conversation` with actions `read`, `post`, `draft`, `manage`; the client gets `portal` `converse` | Keeps the client role on `portal` only (finding 4). `draft` is separate from `post`, so an agent can hold one without the other (PV-D23) |
| 2 | Staff reach mirrors `resource_client.yaml`: `read` for everyone who reads clients; `post`, `draft` and `manage` for `company_admin`, `manager` and `member`; perm mirrors for each | A conversation is part of the client record, so it should never be wider or narrower than the client it belongs to |
| 3 | Drafts live in their own table, `conversation_drafts`, which no portal route reads | A `status='draft'` flag on messages is the flag-someone-forgets leak that trap 2 warns about |
| 4 | Sending a draft creates a message whose author is the staff member who sent it, with `drafted_by` recording the agent | §2.4: the sender shown is a named person, and that person is accountable for the words |
| 5 | Staff recipients for a client message: the thread's staff participants, the project owner (project threads), and the client's account manager (`clients.owner_user_id`), deduplicated | No team table exists (finding 2). A thread nobody answers still shows on the hub, so a missed notice never hides it |
| 6 | Staff screens poll (20 s while a thread is open); the portal gets a `conversation` topic | A staff live channel is a new mechanism and is not needed for v1 (finding 6) |
| 7 | Message bodies are plain text, at most 10,000 characters, with links made clickable on render; no HTML or Markdown | Removes a client-to-staff XSS path. Markdown can come later |
| 8 | Minutes reference the meeting and read `client_id`/`project_id` through it, never copied | A copy drifts when a meeting is re-linked |
| 9 | Sharing minutes and sending a message are both refused to `bot` and `automation` principals | PV-D23: nothing an agent writes reaches a client until a staff member approves it |

## Waves

| Wave | Tickets | Why this order |
|---|---|---|
| 1 | PV4-01 (all PV-4 DDL), PV4-02 (Cerbos kind and portal action) | disjoint files; everything else needs both |
| 2 | PV4-03 (conversation API), PV4-04 (price changes land in Contracts & billing), PV4-05 (meeting minutes) | 03 needs 01 and 02; 04 and 05 need 01. 03 and 05 both append to `portal-visibility.ts`, so the second to merge rebases |
| 3 | PV4-06 (notifications), PV4-07 (agent tools), PV4-08 (portal screens), PV4-09 (staff screens) | 06 and 07 need 03 and 05; 08 and 09 need 03, 04 and 05 |
| 4 | PV4-10 (QA, release, live) | after the merged tree is green |

**Rules for every ticket:**

- Work in your own worktree from `origin/main`, never in the shared checkout.
- **No Docker on the laptop at all** (owner order, 2026-10-12). DB-, Cerbos- and Redis-backed tests
  run only on a Linux gate: GitHub Actions `ci.yml` on the pushed branch (`gh workflow run ci.yml
  --ref <branch>`), or sumopod's gate. Read the job counts, not just the colour. A local green does
  not count.
- No company names or ids in code (PV-D13).
- Every portal query takes its predicate from `portal-scope.ts` and `portal-visibility.ts` (trap 1).
  Rows outside the caller's scope answer 404, never 403.
- A "Client sees this" marker comes from the backend or it doesn't ship (trap 9).
- Authorization runs before validation, so denial tests test authorization.
- Update the matching `docs/FRONTEND-BFF-CONTRACT.md` section in the same change. Conversation gets
  a new **§29**, and §16 cross-references it.
- Prove each new test bites: break the code, watch the test fail, and say how in the hand-back.
- Status words: PLANNED → IN PROGRESS → PROTOTYPED → DEV-VERIFIED. Only PV4-10 can claim
  DEV-VERIFIED.
- The lead writes `MODULES.md` and `CHANGELOG.md`, regenerates MAP and the capability inventory from
  a clean tree, and reviews every diff before merge.

---

### PV4-01: the data model (threads, messages, drafts, read markers, amendments, minutes)

**Owner:** senior-db. **Wave 1.** Model: Sonnet·high.

**Owned paths:** new migrations under `PN/migrations/` (timestamp names); their DB tests.

**Change:**
- `conversation_threads`:
  - Columns: `id`, `tenant_id`, `client_id NOT NULL`, `project_id NULL` (NULL means the client-wide
    thread), `subject`, `status` (`open | closed`), `created_by`, `created_side`
    (`client | staff`), `last_message_at`, `origin_site`, the timestamps and `deleted_at`.
  - Composite tenant FKs to `clients` and `projects`.
  - A thread's project must belong to its client. Use a composite FK `(project_id, client_id,
    tenant_id)` to a new unique index on `projects (id, client_id, tenant_id)`, or a trigger. Say
    which, and what happens when a project's client is changed.
  - At most one live client-wide thread per client: a partial unique index on `(tenant_id,
    client_id) WHERE project_id IS NULL AND deleted_at IS NULL` (PV-D22). NULL defeats a plain
    UNIQUE.
- `conversation_messages`:
  - Columns: `id`, `tenant_id`, `thread_id`, `author_id NOT NULL`, `author_side`
    (`client | staff`, set by the server), `body` (1 to 10,000 characters, CHECK),
    `drafted_by NULL` (the agent user whose draft this was), `edited_at`, `retracted_at`,
    `origin_site`, `created_at`.
  - No visibility column. Every message is client-visible by definition (§2.4).
- `conversation_drafts`:
  - Columns: `id`, `tenant_id`, `thread_id`, `body`, `drafted_by`, `idempotency_key`, `status`
    (`pending | sent | discarded`), `decided_by`, `decided_at`, `sent_message_id`, `created_at`.
  - Unique `(tenant_id, idempotency_key)`.
  - Staff-only by table, and no portal route will ever read it.
- `conversation_reads`: `(tenant_id, thread_id, user_id, last_read_at)`, primary key `(thread_id,
  user_id)`.
- `contracts`:
  - `kind` (`agreement | amendment`, default `agreement`).
  - `amends_id` (a tenant-scoped self FK). Required when `kind = 'amendment'` (CHECK).
  - `change_request_id` (FK to `webdev_change_requests`).
- `webdev_change_requests`:
  - `price_impact` (`unassessed | none | changes_price`, default `unassessed`; existing rows stay
    `unassessed`).
  - `amendment_contract_id` (FK to `contracts`).
  - `source_message_id` (FK to `conversation_messages`, for a request raised from a message).
- `meeting_minutes`:
  - Columns: `id`, `tenant_id`, `meeting_recording_id` (unique; FK to `meeting_recordings`),
    `body_md`, `status` (`draft | shared`), `drafted_by`, `updated_by`, `shared_at`, `shared_by`,
    and the timestamps.
  - No `client_id` copy (design decision 8).
- Every new table: RLS `ENABLE` + `FORCE`, the `tenant_isolation` policy in the
  `202609281655_client_centre_profiles.sql` shape, grants for the runtime role, and indexes for the
  hot reads: threads by `(tenant_id, client_id, last_message_at DESC)`, messages by
  `(thread_id, created_at)`.
- A DO-block self-assertion in each migration: tables exist, RLS is forced, the CHECKs are present.

**Tests (on the Linux gate):**
- Under an unset tenant GUC, every new table returns zero rows: the RLS zero-row trap, asserted on
  purpose.
- A second client-wide thread for the same client fails. A project thread whose project belongs to
  another client fails.
- An amendment without `amends_id` fails.
- Teeth: drop the partial unique index and the duplicate test fails.

### PV4-02: the `conversation` kind and the portal `converse` action

**Owner:** senior-be. **Wave 1.** Model: Sonnet·high.

**Owned paths:**
- the IAM files: `PN/cerbos/policies/resource_conversation.yaml` (new), `resource_portal.yaml`,
  `derived_roles.yaml`, `permission-catalog.json`, `permission-groups.json`, and
  `role-permission-bundles.json` (regenerated from a clean worktree);
- the scripts and tests: `PN/scripts/generate-role-bundles.mjs`, `role-permission-parity.db.test.ts`,
  the four pinned tests and `iam-04-reg1-mirror-reach-invariant.test.ts`;
- a new `cerbos-conversation.test.ts`, a migration seeding `permissions` + `role_permissions`, and
  `docs/PERMISSION-CONTRACT.md`.

**Change:** copy commit `2c5ab99e` file by file. These are the six artifacts.
- `resource_conversation.yaml`, with actions `read`, `post`, `draft`, `manage` (design decisions 1
  and 2):
  - the role shape is copied from `resource_client.yaml`;
  - each action gets a perm mirror (`perm_conversation_*`) under `inTenant && notLow && inRoot`;
  - an **`EFFECT_DENY` on `post` and `manage` for `principal.attr.kind in ["automation","bot"]`**,
    copied from `resource_webdesk_content_item.yaml:437-440` with its delegation comment;
  - the client derived role appears nowhere in the file.
- `resource_portal.yaml` gets one action, `converse`, for the `client` derived role (open a thread,
  post, edit or retract one's own message). Add the comment explaining why it is NOT conditioned on
  capability (PV-D24; the `request_change` precedent). Add a `portal.converse` perm mirror like the
  other portal actions.
- Map `conversation` wherever `client` is mapped, in both `moduleStaffTargets` and
  `moduleManagerTargets` copies.
- Migration: seed the new keys, `owner` exactly mirroring `company_admin`, plus a DO-block that
  asserts the per-role counts and "no write without read".
- Recompute the four pins. Rebase on `origin/main` immediately before merge, because WebDesk adds
  kinds too (finding 12).
- `docs/PERMISSION-CONTRACT.md`: a dated note on the kind, the portal action and the agent DENY.

**Tests:**
- Cerbos matrix:
  - `member` may `post`;
  - `viewer` may only `read`;
  - a `kind=bot` principal holding `company_admin` is DENIED `post` but ALLOWED `draft`;
  - a client grant is ALLOWED `portal` `converse` and DENIED every `conversation` action;
  - a contact with the `viewer` capability may `converse` (the capability is not a Cerbos attribute,
    so assert it at the HTTP layer in PV4-03 and here assert only that no condition reads it).
- Teeth: remove the DENY and the bot case fails. Add `client` to the conversation policy and the
  invariant test fails.

**Deploy note:** Cerbos needs a restart, then a probe: a staff `member` ALLOW `post`, a `bot` DENY
`post`, and a client ALLOW `converse`.

### PV4-03: the conversation API (staff and portal)

**Owner:** senior-be. **Wave 2** (needs PV4-01 and PV4-02). Model: **Opus·medium**. This is the
client-isolation ticket, where a mistake leaks one client's messages to another.

**Owned paths:**
- `PN/src/core/conversation.controller.ts` (staff, new) and
  `PN/src/core/portal-conversation.controller.ts` (new);
- `PN/src/core/portal-visibility.ts` (append only), `PN/src/core/portal-live.service.ts`,
  `UI/lib/portal.ts` (the topic union only), `portal-commerce.controller.ts` (`DOWNLOADABLE` and
  `ownsEntity` only);
- `docs/FRONTEND-BFF-CONTRACT.md` §29 (new), §16a and §16d.

**Change:**
- Predicates in `portal-visibility.ts`:
  - `conversationThreadInPortalScope(alias, {clients, projects})`. A project thread is visible to
    contacts whose scope includes the project. The client-wide thread (`project_id IS NULL`) is
    visible **only to client-wide contacts** (PV4-Q1 default).
  - The matching `staffClientVisible` builder, so staff rows carry `clientVisible: true` for
    messages and threads, and `false` for drafts.
- Portal (`portal` `read` for GETs; `portal` `converse` for writes), with **no `requireSigner`
  anywhere** (PV-D24):
  - `GET portal/conversation` lists the caller's threads with unread counts, filterable by
    `projectId`.
  - `GET portal/conversation/:threadId` returns the messages and marks the thread read.
  - `POST portal/conversation` opens a thread on a project in scope with a first message. It cannot
    create a second client-wide thread: the first post to it creates it lazily.
  - `POST portal/conversation/:threadId/messages` posts a reply, with up to 5 attachments of 10 MB
    each, inline base64, copying `storeProof`.
  - `PATCH` and `DELETE portal/conversation/messages/:id` edit or retract one's own message within
    15 minutes (PV4-Q2 default). A retracted message shows as "Message removed" on both sides.
- Staff (kind `conversation`):
  - the same reads, filtered by `clientId` and `projectId`, with an `awaitingReply` filter for
    threads whose last message is from the client;
  - post, open, close and reopen (`manage`), and edit or retract one's own message (15 minutes);
  - drafts: `GET` drafts on a thread, `PATCH` a draft, and `POST drafts/:id/send` (`post`). Sending
    creates the message as the sender (design decision 4) and stamps the draft `sent`. Discard sets
    it `discarded`.
  - Creating drafts is PV4-07's tool, which calls a `POST .../drafts` route that this ticket
    provides (`draft`).
- `author_side` and `author_id` always come from the principal, never from the body. A body
  carrying `authorId`, `clientId` or `status` is ignored, the same as on the change-request route
  (`webdev-change-requests-portal.controller.ts:105-106`).
- Every write emits an outbox event with `clientId` in the payload: `conversation.thread.opened`,
  `conversation.message.posted`, `conversation.message.edited`, `conversation.thread.updated`.
  - A new `PortalTopic` `conversation`, wired in all four places (finding 6).
  - BFF §16d lists all 8 topics.
- Attachments: `files.target_entity_type = 'conversation'` with `target_entity_id` set to the
  message id. Add `conversation` to `DOWNLOADABLE`, and give `ownsEntity` a branch that resolves
  message → thread → the thread predicate. Staff downloads go through `/files/:id/content` as they
  are, which authorizes kind `conversation`.
- Read markers: viewing a thread upserts `conversation_reads`. Lists compute unread counts as
  messages newer than the caller's `last_read_at` and written by the other side.

**Tests (HTTP, on the Linux gate):**
- Isolation:
  - a contact of client A gets 404 on client B's thread, message and attachment;
  - a contact scoped to project P1 gets 404 on P2's thread and on the client-wide thread;
  - a revoked contact gets 403 from the scope kernel.
- A `viewer` contact can open a thread and post (PV-D24).
- No portal route returns a draft. Add a test that greps the portal controllers for
  `conversation_drafts`.
- Spoofing: a body with `authorId` or `author_side` is ignored.
- Edit after 15 minutes gets 409. Editing another person's message gets 403.
- Staff: a `viewer` cannot post. A `bot` principal's send of a draft is refused with a typed reason.
- An event with `clientId` reaches only that client's stream (`dispatchPortalFrame` unit).
- Teeth: drop the project predicate from the thread query and the P1/P2 test fails. Remove the
  `DOWNLOADABLE` branch's scope check and the attachment test fails.

### PV4-04: a price change lands in Contracts & billing (PV-D5's binding rule)

**Owner:** senior-be. **Wave 2** (needs PV4-01). Model: Sonnet·high.

**Owned paths:**
- `PN/src/core/webdev-change-requests.controller.ts` (triage and the routing transitions);
- `PN/src/core/contracts.controller.ts` (amendment fields on create and read; the `contract.signed`
  follow-up);
- `PN/src/core/portal-commerce.controller.ts` (contract detail fields only);
- `PN/src/core/webdev-change-requests-portal.controller.ts` (read fields only);
- BFF §16b, §16e and §16f.

Coordinate with the WebDesk sessions before you start, because they own the change-request intake.

**Change:**
- Triage must answer `priceImpact`: `none` or `changes_price`. Rows already past triage stay
  `unassessed` and are grandfathered.
- `changes_price`, in the same transaction:
  - creates a **draft amendment**: `kind = 'amendment'`, `amends_id` set to the contract it amends
    (the caller passes it; the default is the project's latest `signed` contract, else the client's
    latest signed master agreement), `change_request_id`, the client and the project, and the title
    "Amendment: <request title>";
  - when the client has no signed contract at all, creates a draft `agreement` linked the same way;
  - sets `amendment_contract_id`.
- **The rule:** while the linked contract is not `signed`, any transition that starts work is
  refused with `409 amendment_not_signed`. That covers `in_progress`, a `route` to `mini_run`,
  `control_plane` or `pm_task`, and a `pipeline_run_id` link. Once the amendment is `signed`, they
  are allowed. A `declined` or `void` amendment leaves the request blocked until staff re-triage.
- The `contract.signed` event handler notifies the request's triager that the request can start.
- Reads: staff and portal contract rows gain `kind`, `amendsId` (with the amended contract's
  reference) and `changeRequestId`. Change-request rows gain `priceImpact` and `amendmentContractId`.
- An amendment never voids or supersedes the contract it amends (`supersedes_id` keeps its re-issue
  meaning).
- Existing tools: `contracts.createDraft` accepts `kind`, `amendsId` and `changeRequestId`. If a
  webdev triage tool exists, it takes `priceImpact`.

**Tests:**
- Triage with `changes_price` creates exactly one draft amendment linked both ways.
- `in_progress` and each work route are refused with 409 until the amendment is signed, then
  allowed.
- `none` behaves as today.
- A grandfathered `unassessed` row is not blocked.
- Teeth: remove the guard on `route = 'mini_run'` and that case fails.

### PV4-05: meeting notes shared with the client

**Owner:** senior-be (a medior is fine if PV4-03 has merged first). **Wave 2** (needs PV4-01).
Model: Sonnet·medium.

**Owned paths:**
- `PN/src/core/meetings.controller.ts` (minutes routes);
- `PN/src/core/portal-workspace.controller.ts` (the minutes read);
- `PN/src/core/portal-visibility.ts` (append only);
- `resource_meeting_recording.yaml` (a new `share_minutes` action, with the agent DENY), the catalog
  pins (+1 pair), BFF §16a and §29.

**Change:**
- Staff:
  - `GET` and `PUT meetings/:id/minutes` (`meeting_recording` `update`). Saving stays `draft`.
  - `POST meetings/:id/minutes/share` (`share_minutes`) stamps `shared_at` and `shared_by`. It is
    allowed only when the meeting has a `client_id`. It notifies the client's contacts in scope and
    emits a `projects` portal event with `clientId`.
  - Unsharing is not offered in v1: once a client has read something, taking it back is a
    conversation, not a button.
- `share_minutes` gets the same `automation`/`bot` DENY as PV4-02 (design decision 9).
- Portal:
  - `GET portal/meetings` (optionally by `projectId`) and `GET portal/meetings/:minutesId` return
    the title, date and minutes body. They never return the transcript, the recording, the audio,
    the Drive link or the participants.
  - New predicate `meetingMinutesInPortalScope`: `status = 'shared'`, joined to `meeting_recordings`
    for the client and project, with the same client-wide rule as threads.
- `meeting` stays in `NEVER_CLIENT_VISIBLE`. Add `meeting_minutes` as its own visible kind with a
  `staffClientVisible` builder, and extend `client-visible-parity.db.test.ts`.

**Tests:**
- A draft minute gets 404 on the portal. A shared one returns 200 for an in-scope contact and 404 for
  another client's contact.
- The portal payload contains no transcript field (a snapshot of the keys).
- A `bot` cannot share.
- Teeth: drop `status = 'shared'` and the draft test fails.

### PV4-06: notifications, both ways

**Owner:** senior-be or medior. **Wave 3** (needs PV4-03 and PV4-05). Model: Sonnet·medium.

**Owned paths:** a new `PN/src/core/conversation-notify.ts`; `PN/src/mail/intake.ts` and its
template; the portal overview aggregate (unread counts); BFF §29.

**Change:**
- A client posts → in-app `notify()` to the staff recipients (design decision 5), type
  `conversation.message.client`, href `/clients/<clientId>/work/conversation/<threadId>`.
- Staff post or send a draft → in-app `notify()` to every contact in the thread's scope
  (`resolveClientRecipients` with `kind: "general"` and the project), type
  `conversation.message.staff`, href `/portal/conversation/<threadId>`. This adds a seventh portal
  path to the "paths used in notifications" list: extend the trap-11 test.
- An agent drafts → in-app notice to the same staff recipients: "A draft reply is waiting".
- Mail to clients: add `conversation.message.staff` to the mail allow-list with its own template.
  Send **at most one mail per contact per thread until that contact has read the thread**. The
  mail's only link is the plain deep link. It sends once the mail sender exists (see "Before real
  clients use the portal" on the board). Until then the tap writes nothing it cannot send; say how
  that was checked.
- The portal overview returns `conversationUnread`. The portal nav's Projects badge adds it to the
  open gates.
- The staff client overview's `needsUs` adds threads awaiting our reply.

**Tests:**
- Recipients, each case: a project thread with an owner, a client-wide thread with only an account
  manager, a thread with staff participants, and duplicates removed.
- The mail throttle: two staff messages produce one mail, and a third after the contact reads
  produces a second.
- The deep-link test covers the new path.

### PV4-07: agent tools (agentic-native bar, PV-D23)

**Owner:** senior-integrator. **Wave 3** (needs PV4-03 and PV4-05). Model: Sonnet·high.

**Owned paths:** `PN/src/core/core-tools.ts` (a `conversation.*` block and `meetings.*Minutes`
tools); `PN/src/core/approval-executables.ts`; `docs/modules/CAPABILITY-INVENTORY.md` (regenerated
by the lead).

**Change:**

| Tool | Impact | Notes |
|---|---|---|
| `conversation.listThreads` (`clientId`, `projectId`, `awaitingReply`), `conversation.getThread` | read | drafts included for staff principals |
| `conversation.draftReply` | low | idempotent by `idempotencyKey`; the agent's main write |
| `conversation.post` (reply, or open a thread), `conversation.sendDraft` | medium | **barred** with `registerBarredExecutable`, with the reason "PV-D23: agents draft, staff send". Cerbos also refuses agents. A human using an MCP client with their own principal can call them |
| `conversation.closeThread`, `conversation.reopenThread` | low | `manage` |
| `meetings.getMinutes`, `meetings.saveMinutes` | read, low | an agent may draft the minutes from the transcript |
| `meetings.shareMinutes` | medium | barred for the same reason |

- Criterion 5, explicit refusal: an agent calling `conversation.post` gets a typed refusal that
  names `conversation.draftReply`. It is never a bare 403.
- Criterion 6: every write records the actor, which may be non-human.
- Criterion 7: one golden case per tool.
- Nothing is added to `AUTOMATION_ALLOWLIST`. No n8n workflow writes to a conversation in v1.

**Tests:**
- Each tool drives its real endpoint.
- A `bot` principal's `conversation.post` and `meetings.shareMinutes` are refused with the typed
  reason. Its `conversation.draftReply` succeeds, and a retry with the same key returns the same
  draft.
- Teeth: un-bar `conversation.post` and the bar test fails.

### PV4-08: the portal screens

**Owner:** senior-fe. **Wave 3** (needs PV4-03, PV4-04 and PV4-05). Model: Sonnet·high. Invoke the
`frontend-design` skill only for the composer and thread layout.

**Owned paths:** `UI/app/(portal)/portal/conversation/**` (new); `UI/app/(portal)/portal/meetings/**`
(new); the conversation and meeting sections of `UI/app/(portal)/portal/projects/[projectId]/page.tsx`;
`UI/lib/portalNav.ts` and its test; the contract detail page (amendment banner only); `UI/lib/portal.ts`
types.

**Change:**
- Projects area sub-tab **Conversation** at `/portal/conversation`:
  - the threads grouped by project;
  - the client-wide thread pinned on top as "General" (or the client's name);
  - unread counts, and "Start a conversation" on a project.
- Thread page `/portal/conversation/[threadId]`:
  - messages oldest-first, each with the sender's name and side ("you", or the person's name at our
    company);
  - composer with attachments; edit and retract for 15 minutes; "Message removed";
  - live through `PortalLive` with the `conversation` topic.
- The project page gets "Conversation" (that project's threads) and "Meeting notes" (shared minutes,
  linking to `/portal/meetings/[minutesId]`).
- Composer hint, from plan §2.4: "Prices and terms change only through a signed contract or
  amendment."
- Contract detail: an amendment shows "Amendment to <reference>" and "From your request: <title>".
- The Projects badge includes `conversationUnread`.
- Accessibility:
  - the message list is NOT `role="log"` with live announcements for history, because that spams
    screen readers (memory `role-log-is-a-live-region`);
  - announce only new messages, politely;
  - axe in light and dark.

**Tests:** component tests for grouping, unread and the edit window. A Playwright portal flow on the
gate: open a thread, reply as a viewer contact, see the staff reply arrive.

### PV4-09: the staff screens

**Owner:** senior-fe. **Wave 3** (needs PV4-03, PV4-04 and PV4-05). Model: Sonnet·high.

**Owned paths:**
- `UI/app/(app)/clients/[clientId]/work/page.tsx` (a new Conversation section) and
  `UI/app/(app)/clients/[clientId]/work/conversation/[threadId]/page.tsx` (new);
- the Conversation panel inside `ProjectWorkspaceView`, shown only when the project has a client;
- the minutes editor and the "Share with client" control on the meeting page;
- the triage form's price question and the amendment link on the requests rows.

**Change:**
- The thread list shows "Awaiting our reply" first. Every message row carries the backend's "Client
  sees this" marker.
- Agent drafts appear in the thread as a distinct, Internal-styled card ("Drafted by <agent>. Not
  sent"), with Send, Edit and Discard. Send needs a confirm, because it goes to the client.
- "Turn into a change request" on a client message opens the request form prefilled, with
  `sourceMessageId` set.
- Polling every 20 s while a thread is open, plus on window focus.
- Triage: the required "Does this change the price?" question. A yes links to the draft amendment on
  `/clients/[id]/billing`.
- Meeting page: minutes editor (draft), "Share with client" with a confirm that names the client,
  and "Shared on <date> by <name>" once shared.
- Axe light and dark on the new hub section and thread page.

**Tests:** component tests for drafts, markers and the triage question. A hub Playwright flow on the
gate: send a draft, see it as a message with the sender's name.

### PV4-10: QA gate, release, live drive

**Owner:** qa, with the lead. **Wave 4.**

**Before release:**
- Merged-tree gate: both suites, `next build`, and the portal and hub e2e (PV4-08, PV4-09).
- The PV-2 and PV-3 portal suites still pass, because the portal's existing paths must be unchanged.
- MAP and the capability inventory regenerated from a clean tree.

**Release:**
- The slot is agreed with the WebDesk sessions. Cut it one verified step per command.
- After deploy:
  - the deploy log shows each PV-4 migration's `applied:` line;
  - restart Cerbos;
  - probe a `member` ALLOW `post`, a `bot` DENY `post` and a client ALLOW `converse`.

**Live:**
- Read-only as the owner-authorised login: the hub Conversation section renders, and
  `GET conversation?clientId=` returns 200.
- Owner step: post one message from the staff side to the WSK-49e test client, and read it in the
  portal as that client's test contact. The owner authorised that test client on live on
  2026-10-11. The owner says when it is done.

### PV4-11: conversation messages are permanent (PV-D34)

**Owner:** senior-be, with the UI changes. **Wave 5, after PV4-10's tree is on main.**

**The ruling (PV-D34, owner, 2026-10-13):** conversation messages can never be edited or retracted. A message
is permanent from the moment it is posted; a correction is a new message. It replaces the 15-minute window that
PV4-03, PV4-08 and PV4-09 built (the lead's default for PV4-Q2, now ruled).

**What changed:**
- **Routes gone.** `PATCH` and `DELETE` on a message are removed on both sides (staff
  `:t/conversation/messages/:id`, portal `:t/portal/conversation/messages/:id`). They answer **404** (no such
  route), not 403. `assertEditable`, `applyEdit`, `applyRetract`, the edit window and the
  `conversation.message.edited` event are removed. The `conversation` topic, `posted` and `opened` stay.
- **Payload.** `editableUntil`, `edited`, `editedAt` and `retracted` are removed from every message payload;
  `body` is always a string. Nothing else in the response moved.
- **Database guard (lead decision).** Migration `202610132100_pv4_conversation_messages_permanent.sql` adds
  two row triggers on `conversation_messages`: `BEFORE UPDATE` always raises, `BEFORE DELETE` raises unless the
  transaction ran `SET LOCAL app.conversation_purge = 'on'` (an operator hatch for erasure and test teardown; no
  application code may set it, and a static test fails the build if one does). SQLSTATE `PD034`, message
  `conversation messages are permanent (PV-D34)`. A final DO block asserts both triggers exist and are enabled.
  So "never" holds even if a future route forgets. `edited_at` and `retracted_at` stay as unused columns
  (commented as such); there is no column drop. Rows retracted under the old window stay hidden.
- **Policy comments only.** `resource_portal.yaml` (`converse`) and `resource_conversation.yaml` (`manage`) no
  longer say they cover edit or retract. No rule or action moved, so no catalog or pin moved.
- **UI, both sides.** No Edit or Remove control, no window logic, no "edited" mark, no "Message removed" row.
  Both composers add, beside the prices-and-terms hint: "Messages can't be edited or removed once sent. Post a
  correction instead." The demo fixtures and the Playwright specs that drove edit and remove were rewritten (the
  portal spec now sends a correction as a new message).
- **Contract.** `docs/FRONTEND-BFF-CONTRACT.md` §29 rule, §29a, §29b and §29f updated; the four rows are gone.

**Tests:** staff and portal PATCH and DELETE answer 404 and the message is unchanged; the payload has none of
the four fields; a DB test proves UPDATE raises, DELETE raises, and DELETE under the purge flag succeeds (and that
the flag is transaction-local, opens DELETE only and needs exactly `on`); component tests prove no edit or remove
control renders and the hint does. The existing posting, opening, draft and send-draft suites stay green.

**Not changed here (follow-up):** the permission descriptions in `permission-catalog.json` and
`permission-groups.json` (and the migration `202610130120_iam_conversation_permissions.sql` that seeded them)
still say "edit or retract". They are text only; changing them moves the catalog pins, so they wait for the next
change that touches the catalog anyway.

---

## Open for the owner (non-blocking)

| # | Question | Lead's default, used until ruled |
|---|---|---|
| PV4-Q1 | May a contact limited to some projects see the client-wide thread? | **No.** Only client-wide contacts see it, matching least privilege; a project-scoped contact may be someone outside the client's organisation |
| PV4-Q2 | How long can a message be edited or retracted? | **RULED by PV-D34 (2026-10-13): never.** A message is permanent from the moment it is posted; a correction is a new message. This replaces the lead's default (15 minutes, then permanent), which PV-4 had built. PV4-11 removes it |

## Not in PV-4 (and where each goes)

| Item | Why not now | Goes to |
|---|---|---|
| A staff live channel (SSE) | New mechanism; polling is enough for v1 | later, if polling proves too slow |
| A portal notifications inbox | The unread count on Conversation covers v1; a general inbox spans every portal object | PV-7 or a portal follow-up |
| A project team table (`project_members`) | Recipients work without it (design decision 5) | when "your team" grows past the lead |
| Mail to clients actually sending | Needs the mail sender | "Before real clients use the portal" |
| n8n workflows that write to a conversation | PV-D23; no workflow needs it | not planned |
| Change requests outside webdev | Only `webdev_change_requests` exists | when a second request type exists |
| Markdown in messages | XSS surface; plain text first | later |
| A system message in the thread when minutes are shared | Couples two objects for little gain | later |
