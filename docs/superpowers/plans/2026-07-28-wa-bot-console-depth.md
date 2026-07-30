# WA/TG Bot console depth — build contract (2026-07-28)

Frozen contract for a 4-agent parallel build. **Every agent MUST implement its side exactly as
written here** — the whole point is that four people can work at once without seeing each other's
code. If you believe the contract is wrong, say so in your final report; do NOT silently deviate.

## Why

The bot's backend is far richer than the ERP page. These capabilities exist in `wa-chat-bot` and are
unreachable from the ERP today: the actions kill switch, manual digest runs, the skills catalog, and
any view of digest output or media-queue health. The Groups tab is also all-or-nothing (adding one
group stops ingestion for every other group) and unusable at 14+ groups with no way to ignore spam
groups. The Chats tab is a fixed-limit list with no search and no paging.

## Non-negotiables (all agents)

- **Never widen the PII surface.** Everything already flows through `scrub()` at ingest; the admin
  reads expose only what the store already holds. No raw sender ids beyond what is already returned,
  no unscrubbed text, and never log message bodies.
- **Fail-soft everywhere.** An unreachable bot / missing file / older build degrades to an empty
  list or an honest error. Never throw a 500 into the console, never fabricate data.
- **Bot `/admin/*` routes stay `ADMIN_TOKEN`-gated** (`safeEqual(bearer(req), config.adminToken)`,
  503 when unset) — copy the existing route preamble exactly.
- **Nest routes stay `requireElevated(req)`** and go through the existing `botCall()` helper.
- **Persistence follows the existing pattern:** atomic write (tmp + `rename`), a path from `config`
  with an env override, defaulting under `data/` so it lands on the `bot-data` volume. Lazy/explicit
  load, bounded size, corrupt file = start empty.
- Match surrounding code style. Comments explain *why*, not *what*. No new dependencies.
- Tests are part of "done": bot suites via `npm test` in `wa-chat-bot`, nest via `npx vitest run`
  in `platform-nest`, UI via `npx vitest run src/components/systems/` in `platform-ui`. `tsc --noEmit`
  clean in whichever projects you touched.

## File ownership — do not edit outside your lane

| Agent | Owns (exclusive write access) |
|---|---|
| **1 — bot backend** | `wa-chat-bot/**` |
| **2 — nest proxy** | `platform-nest/**` |
| **3 — Controls tab** | `platform-ui/src/components/systems/ControlsTab.tsx` (new), `BotTabs.tsx`, `src/app/(app)/systems/bot/**`, `systems.css`, their tests |
| **4 — Groups + Chats** | `platform-ui/src/components/systems/GroupRegistry.tsx`, `ChatsTab.tsx`, `bot-extras.css` (new), their tests |

Agent 4: put ALL new CSS in a new `bot-extras.css` and import it from your components —
`systems.css` belongs to agent 3 this round. Agent 3 owns tab registration; agent 4 adds no tabs.

## Already exists — do NOT rebuild

- Bot: `POST /admin/actions/:state` (`state` = `on|off`, returns `{enabled}`),
  `GET /admin/actions/audit?limit=` → `{enabled, entries}`, `POST /run-digests/:slot`
  (`slot` = `noon|evening`, ADMIN_TOKEN-gated, returns the digest run result), `listSkills()` in
  `src/skills.ts`, `getPendingMedia(limit)` on the store.
- Nest: `botCall()`, `limitQs()`, `requireElevated()` in `admin/bot-admin.controller.ts`.
- UI: `Card`, `Button`, `Toast`, `StatusBadge`, `Eyebrow`, `EmptyNote`, `formatRelativeTime`.

---

## Agent 1 — `wa-chat-bot` backend

### 1a. Ignore-list for groups ("monitor everything except these")

The registry mode switch is coarse: empty registry = ingest every group; one entry = ingest ONLY
listed groups. Add a third, orthogonal control: an **ignore list** that drops a group in BOTH modes.

- `src/groups.ts`: persist ignored ids (reuse the `discovered-groups.json` pattern — either a new
  `ignoredGroupsFile` or an `ignored: boolean` on the discovery entry; your call, document it).
  New exports: `isIgnored(chatId)`, `setIgnored(chatId, ignored)`, `ignoredGroups()`.
- `src/bot.ts`: an ignored group is dropped **before** storage in every mode — after
  `noteDiscovered()` (still record it, so it stays visible/un-ignorable) and before the registry gate.
- `groupsSnapshot()` gains `ignored: DiscoveredGroup[]`, and `discovered` EXCLUDES ignored entries.
- Digests must skip ignored groups in trial mode (`schedule.ts` uses `getGroupChatIds()`).
- Routes: `PUT /admin/groups/ignored` body `{ids: string[]}` → full-replace, validates each id
  against the existing group-id regex, returns the new `groupsSnapshot()`. 400 `{error, field}` on
  a bad id, same shape as `writeGroups`.

### 1b. Digest history

- New `src/digest-history.ts`: append a record per digest run, keep the last 50, persisted atomically
  (`config.digestHistoryFile`, default `data/digest-history.json`).
  Record: `{ts, slot, trigger: "scheduled"|"manual", groupsCovered, delivered, failed, managementDelivered, error?}`.
  No message text and no digest body — counts and status only (keeps PII out of a long-lived file).
- `src/schedule.ts` `runDigests()` records one entry per run (both scheduled and manual paths).
- Route: `GET /admin/digests?limit=` → `{history: DigestRecord[], nextRun: {noon: number|null, evening: number|null}, timezone: string}`
  (newest-first; `nextRun` computed from the cron schedule + `config.scheduleTimezone`).

### 1c. Skills catalog

- Route: `GET /admin/skills` → `{commandPrefix: string, botMention: string, skills: [{name, description}]}`
  from `listSkills()`. Read-only, no new state.

### 1d. Media-queue health

- Route: `GET /admin/media/status` → `{queueEnabled: boolean, pending: number, oldestPendingTs: number|null}`
  using `getPendingMedia()` and `queueEnabled()`. Counts only — never media refs or text.

### 1e. Chat search + backwards paging

- Extend the `Store` interface (`src/store/types.ts`) and implement in **both** `FileStore` and
  `PgStore`:
  - `searchMessages(query: string, limit: number): Promise<StoredMessage[]>` — case-insensitive
    substring over the stored (already scrubbed) text, newest-first. `PgStore` uses `ILIKE` inside
    the existing `withTenant()` wrapper so RLS still applies. Empty/whitespace query → `[]`.
  - `getMessagesPage(chatId, opts: {limit: number; beforeTs?: number}): Promise<StoredMessage[]>` —
    the newest `limit` messages strictly older than `beforeTs` when given.
- `src/chat-admin.ts`:
  - `GET /admin/chats` gains `q` (filters the chat LIST by name or id, case-insensitive) and
    `kind` (`group|dm`) query params.
  - `GET /admin/chats/:chatId/messages` gains `beforeTs`, and the response gains
    `hasMore: boolean` so the UI can hide "load more" at the end of a thread.
  - New `GET /admin/search?q=&limit=` → `{results: [{chatId, chatName, kind, surface, ts, senderName, text}]}`
    via `searchMessages`, resolving names with the same `groupName()`/sender logic as `listChats`.
- Register every new route in `src/server.ts` with the standard ADMIN_TOKEN preamble.

**Deliverable:** all bot suites green (`npm test`, currently 296 passing — keep every one), new unit
tests for each item above, `npm run typecheck` clean. Report the exact response shapes you shipped.

---

## Agent 2 — `platform-nest` proxy layer

Add to `src/admin/bot-admin.controller.ts` (elevated-gated, `botCall`-based, no business logic —
these are pure proxies, exactly like the existing `session/*` routes):

| Nest route | → bot route |
|---|---|
| `POST /api/admin/bot/actions/:state` | `POST /admin/actions/:state` — validate `state ∈ {on,off}` → 400 otherwise |
| `POST /api/admin/bot/digests/run/:slot` | `POST /run-digests/:slot` — validate `slot ∈ {noon,evening}` → 400 otherwise. Use the longer `SESSION_TIMEOUT_MS`-style timeout: a digest calls the AI gateway and can take tens of seconds |
| `GET /api/admin/bot/digests` | `GET /admin/digests` (pass `limit`) |
| `GET /api/admin/bot/skills` | `GET /admin/skills` |
| `GET /api/admin/bot/media/status` | `GET /admin/media/status` |
| `PUT /api/admin/bot/groups/ignored` | `PUT /admin/groups/ignored` — require `Array.isArray(body.ids)` → 400 `{message,field:"ids"}` |
| `GET /api/admin/bot/search` | `GET /admin/search` (pass `q`, `limit`) |
| `GET /api/admin/bot/chats` | already exists — also forward `q` and `kind` |
| `GET /api/admin/bot/chats/:chatId/messages` | already exists — also forward `beforeTs` |

Extend `bot-admin.test.ts`'s stub for the new bot routes and cover: happy path for each, the two
`400` validators, elevated-gating (a non-elevated user gets 403), and that `q`/`kind`/`beforeTs`
reach the bot verbatim. Keep the existing 11 tests passing.

Also: `src/app.module.ts` or wherever needed if a new controller file is required — prefer extending
the existing controller. Full suite must stay green: `npx vitest run` (700 passing today; the suites
need the `.env` already present in the project — PG on 55433, Cerbos on 3592, test Redis on 56380).

---

## Agent 3 — UI: Controls tab (safety + operations)

New `ControlsTab.tsx` + a new **Controls** tab registered in `BotTabs.tsx` and the bot page
(`src/app/(app)/systems/bot/page.tsx`, plus its `?tab=` handling — follow how `logs`/`groups` do it).
Client component, `elevated`-gated like `LogsTab` (non-elevated → single EmptyNote, no fetches).

Cards, in this order:

1. **Actions kill switch** — reads `enabled` from `GET /api/admin/bot/actions/audit`; a clear
   on/off control calling `POST /api/admin/bot/actions/{on|off}`. Turning actions **off** is the safe
   direction (apply immediately); turning them **on** requires a confirm step, because it re-arms the
   bot's ability to mutate real WhatsApp groups. State must reflect the server response, never
   optimistic-only. Explain in one line what the switch does (mutating actions stop; reads and Q&A
   keep working).
2. **Digests** — `GET /api/admin/bot/digests`: next scheduled run per slot (with the timezone) and a
   newest-first table of recent runs (time, slot, trigger, groups covered, delivered/failed, error).
   Two "Run now" buttons (noon / evening) → `POST /api/admin/bot/digests/run/{slot}`, disabled while
   in flight, with a clear note that this posts real messages to WhatsApp. Refresh the history after.
3. **Media queue** — `GET /api/admin/bot/media/status`: queue on/off, pending count, oldest pending
   age. A pending backlog with an old timestamp is the signal that enrichment is stuck — make that
   readable at a glance.
4. **Bot capabilities** — `GET /api/admin/bot/skills`: the command list (prefix + name + description)
   and the mention trigger, so an operator can see what the bot answers without reading code.

Every panel: loading state, an explicit "couldn't be loaded" state when a fetch fails (do NOT leave
it on "Loading…" — that bug was just fixed elsewhere in this page, don't reintroduce it), and a
Refresh. Read paths go through this app's `/api/admin/bot/*` proxy routes with `cache: "no-store"`;
follow `LogsTab.tsx` for the fetch/error shape and `WhatsAppConnect.tsx` for mutation-with-confirm.
Add `route.ts` proxy handlers under `src/app/api/admin/bot/...` for any path that doesn't have one
yet (mirror the existing session/QR handler: server-side `platformFetch`, `no-store`).

Tests: `ControlsTab.test.tsx` covering the elevated gate, each panel's happy path, the failed-fetch
state, the on-confirm flow, and that "Run now" posts to the right slot. Keep `BotTabs.test.tsx` green.

---

## Agent 4 — UI: Groups ignore + Chats depth

**`GroupRegistry.tsx`** (careful — it changed today: it now has a JID fallback, an `optIn`
"Digest back" column, and a trial-mode warning; keep all of that):
- An **Ignore** button on each discovered row → stages the id; plus an **Ignored groups** section
  listing currently-ignored entries with **Un-ignore**. Commit via
  `PUT /api/admin/bot/groups/ignored` with the full id list (full-replace, same
  stage-then-Save feel as the monitored table). It needs its own action prop, wired in
  `src/app/(app)/systems/bot/group-actions.ts` — that file is shared with agent 3's page work, so
  ADD a new exported action and do not restructure the existing `updateBotGroups`.
- Explain the distinction in one line: monitored = read and summarised; ignored = never read, in
  trial mode too. `BotGroupsSnapshot` gains `ignored: BotDiscoveredGroup[]`.

**`ChatsTab.tsx`**:
- Search box over the chat list (debounced, → `?q=`) and a group/DM filter (`?kind=`).
- **Message search** across all chats via `GET /api/admin/bot/search?q=` — results show chat name,
  sender, time and the matching text; clicking a result opens that chat's thread. Make it obvious
  whether the user is searching chats or messages.
- **Load older** in the thread using `?beforeTs=` + the response's `hasMore`, prepending older
  messages without losing scroll position or clobbering the 6s poll.
- Keep the existing behaviour intact: 15s list poll, 6s thread poll, auto-select newest, inert
  text-only rendering (never `dangerouslySetInnerHTML`), and the failed-fetch states added today.

Tests: extend `GroupRegistry.test.tsx` and `ChatsTab.test.tsx` (23 tests across the two today — all
must stay green). Cover ignore/un-ignore staging + save payload, chat-list search and filter,
message search → open-thread, and load-older paging.

---

## Integration (orchestrator, after all four report)

Wire-up review across lanes, one full pass of all three suites, rebuild + redeploy `bot` and
`platform` with **both** compose files
(`-f docker-compose.vps.yml -f docker-compose.local.yml` — the VPS file alone unpublishes
`platform:3004`), then drive the real console. Docs: bump `wa-chat-bot`, `platform-nest`,
`platform-ui` in `docs/modules/MODULES.md` + `CHANGELOG.md`.
