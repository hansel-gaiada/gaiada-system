# Gmail client seam (MAIL-16D)

**Status: DEV-VERIFIED — the seam only; extended by DW-8j (2026-10-15) with `sendMessage`, a simulated mailbox and a live adapter (see the DW-8j section at the foot).** See `docs/superpowers/specs/2026-08-04-zone-a-mail-design.md`
§8C and decision A14 (binding), and the MAIL-16D row of
`docs/superpowers/plans/2026-08-04-mail-subsystem-tickets.md`, for the scope this directory is
allowed to cover and why it stops here.

## What this is

- `types.ts` — the `GmailClient` interface (`listThreads`, `getThread`, `getMessage`,
  `listLabels`) and the decoded, provider-agnostic domain shapes it returns.
- `errors.ts` — the error taxonomy: `GmailUnauthorizedError` (401), `GmailRevokedError` (403),
  `GmailRateLimitedError` (429, carries `retryAfterSeconds`), `GmailNotFoundError` (404).
- `fixture-client.ts` + `fixtures/*.json` — a fixture-backed `GmailClient` implementation over a
  committed, static thread/message/label corpus.
- `contract.ts` — the **provider-agnostic contract-test suite**. It asserts only against the
  `GmailClient` interface's own shapes and this seam's error classes — never against fixture-only
  data. `fixture-client.contract.test.ts` is where the fixture's specific ids are supplied to it.
- `gmail.zero-persistence.test.ts` — executable proof that nothing in this directory writes
  anything to disk, a database, or a cache (M14: "render on demand, cache nothing").

## Honesty note — read this before trusting anything above (design §15 R7)

**Thread, label, and pagination semantics here are UNVERIFIED against the real Gmail API.**
Everything green in this directory proves that a fixture-backed implementation satisfies the
interface this seam defines — it proves nothing about whether that interface is a faithful model
of Gmail. In particular, all of the following are invented for dev and have never been checked
against a real Google response:

- **Pagination.** This fixture's `nextPageToken` is an opaque string of this implementation's own
  invention (`fixture:v1:<offset>`). Google's real token opacity, page-size negotiation, and
  page-boundary stability under concurrent mailbox changes are unknown.
- **Thread/message shape.** Google's real `payload.parts` MIME tree (multipart/alternative,
  multipart/mixed with attachments, nested multipart/related for inline images) is collapsed here
  into a flat `parts: GmailMessagePart[]` + `attachments: GmailAttachmentMeta[]`. Whether that
  flattening loses information a real reading pane needs is unverified.
- **Label semantics.** System vs. user label behaviour, and whether Google returns labels a caller
  did not expect (e.g. `CATEGORY_*`), is unverified.
- **The three error states.** `GmailUnauthorizedError`/`GmailRevokedError`/`GmailRateLimitedError`
  are simulated by alternate client instances that always throw (see `fixture-client.ts`'s
  "Error-state factories" section) — no real Google 401/403/429 has ever been observed by this
  code. Real quota/rate-limit mechanics are explicitly **VERIFY-AT-BUILD-TIME** per design §8C.
- **Auth entirely.** There is no OAuth link flow in this seam at all (MAIL-16, staging). A live
  adapter's access to a real per-user token, and Google's consent-screen/refresh/revocation
  behaviour, are untouched by anything in this directory.

## What "the live adapter must pass this suite unmodified" means

At staging (MAIL-16), a live `GmailClient` implementation gets its own
`<adapter-name>.contract.test.ts` sitting next to `fixture-client.contract.test.ts`, importing the
same `runGmailClientContractTests` from `contract.ts` and supplying a harness built from a real
Google account instead of the fixture corpus. `contract.ts` itself must not need to change for that
to work — if it does, that is a signal this seam's interface was wrong, not that the suite needs a
fixture-specific carve-out.

## Explicitly NOT in this directory (see MAIL-16/MAIL-17)

No OAuth link/consent/revoke flow, no live Google adapter, no reading-pane UI, no persistence of
message content anywhere, no database migration (the `integration_connections` provider-CHECK
widening for `google_gmail` ships with MAIL-16 at staging, not here).

## DW-8j (DW-D24, 2026-10-15) — what changed in this directory

`docs/FRONTEND-BFF-CONTRACT.md` §48 builds "email from the ERP through each employee's OWN Gmail" on this seam. The MAIL-16D rules above still hold
(render on demand, cache nothing); the list under "Explicitly NOT in this directory" is superseded as follows:

- `GmailClient` gains `sendMessage` and an optional `{label: "INBOX" | "SENT"}` on `listThreads`; `GmailMessage.headers` gains optional `cc`,
  `inReplyTo`, `references`; the error family gains `GmailInvalidMessageError` and `GmailUnavailableError`. All additive: MAIL-16D's cases are unchanged.
- `send-validation.ts` is the one definition of a valid outgoing message (shared by the HTTP service and every client).
- `fixture-client.ts` now also backs the SIMULATED mailbox (`simulated-mailboxes.ts`): a per-person in-process Sent, memory only, nothing sent anywhere.
  `gmail.simulated-isolation.test.ts` is the executable proof that the simulated files cannot reach a network, mail, process, filesystem or database
  primitive, or the live adapter.
- `api-client.ts` is the LIVE adapter (the Gmail REST API with one person's access token). It is exercised only at a stubbed `fetch`
  (`api-client.test.ts`); it must pass `contract.ts`, send cases included, UNMODIFIED against a staging account at DW-11, through a sibling
  `api-client.contract.test.ts` that supplies `sendRecipient` and a harness built from that account. Its MIME handling and fan-out are UNVERIFIED
  against real Google (the honesty note above applies to it in full).
- Still not here: attachments, HTML compose, scheduled send, any persistence of message content.
