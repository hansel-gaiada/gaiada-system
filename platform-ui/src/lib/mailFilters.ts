// MAIL-34 — pure, client-safe validation helpers for the admin mail surface's user-supplied
// filter/id values (design §8A). Deliberately NOT in `lib/mail.ts` (another session owns that
// file's `entityHref()` right now) and deliberately free of the `server-only` guard so both pages
// here and a plain vitest run can exercise it directly — no I/O, no fetch, nothing to mock.
//
// Two crash paths this closes, both hand-edited-URL-shaped (the filter fields are plain text
// inputs / a route segment, not constrained selects, so nothing stops a client from sending
// garbage the browser's own `<input type="date">` would never produce):
//
//   1. `/admin/mail?since=<garbage>` — the list page used to build the filter with
//      `new Date(since).toISOString()` directly. `.toISOString()` on an Invalid Date throws a
//      RangeError SYNCHRONOUSLY, before the request ever reaches the BFF — so the backend's own
//      (correct) 400 for an unparseable `since` was never even the thing that crashed; the page
//      crashed one step earlier. `parseSinceParam` normalizes without ever throwing.
//
//   2. `/admin/mail/<not-a-uuid>` — `admin-mail.controller.ts`'s `detail()` (`GET
//      /api/admin/mail/log/:id`) has no id-shape check, unlike its sibling `thread()` on the same
//      controller (`assertUuidFilter`/`UUID_RE.test`) — a malformed id reaches a raw `uuid` column
//      comparison and 500s via the platform's last-resort exception filter (`internal error`, not
//      a validation 400). Fixing that asymmetry is a platform-nest change, out of scope for this
//      ticket (platform-ui only). Checking the shape here, before the request is ever sent, closes
//      the crash regardless of what status code the backend would have returned.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShaped(value: string): boolean {
  return UUID_RE.test(value);
}

export interface SinceFilterResult {
  /** The normalized ISO instant to send as the `since` filter — absent when `raw` was empty. */
  iso?: string;
  /** `true` when `raw` was non-empty but not something `Date.parse` can read. Never throws. */
  invalid: boolean;
}

export function parseSinceParam(raw: string): SinceFilterResult {
  if (!raw) return { invalid: false };
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return { invalid: true };
  return { iso: new Date(t).toISOString(), invalid: false };
}
