# gaiada.com collections (M5-W7)

Status: **PROTOTYPED**. Data and a validation test only. **Nothing here has been applied to any WebDesk tenant.**

| File | What it is |
|---|---|
| `author.json` | The body of `schema.apply` for the `author` collection: `{ "schema": <composition> }` |
| `post-author-field.json` | The delta to the post composition: one `author` relation field (the post composition is not in the repo) |

Test: `webdesk/delivery/test/m5-w7-author.test.mjs` (validates `author.json` with the real composition validator, checks the post delta,
validates sample items, and fails on any private-data field name).

## Fields (author)

Public E-E-A-T fields only: `displayName`, `roleTitle`, `bio` (markdown), `expertiseTopics[]`, `credentials[]` (free text),
`photo` (media) + `photoAlt`, `profileLinks[]` (`url`, `network`, `label`), `published`. No email, phone, ERP user id, address or birth data.
**The link between an ERP user and a profile never enters a field**; if one is ever needed it lives in the ERP, not in WebDesk.

Locale twins: the collection is `localized` (EN and ID items, one per locale, as for the other collections). `displayName`, `photo` and
`profileLinks` are locale-neutral (the default-locale item is authoritative); role, bio, topics, credentials, alt text and `published` are per locale.

Limits of the vocabulary (1.3.0): it has no URL primitive and no per-link host allow-list. `profileLinks[].url` is a `text` field, so
the editor and the site import must enforce "https only, parseable URL"; the test checks the sample values with that rule, the composition
cannot. A required `photoAlt` when `photo` is set is also a content rule the vocabulary cannot express (it is advisory in the editor).

## How to apply (after the gate below)

As a user holding Cerbos `webdesk_collection - apply_schema` (publisher tier), through the ERP BFF or MCP, or the control route:

```
POST /control/v1/tenants/:tenantSlug/sites/:siteId/collections/author/schema/propose   body: { "proposedSchema": <author.json .schema> }
POST /control/v1/tenants/:tenantSlug/sites/:siteId/collections/author/schema/apply     Idempotency-Key: <fresh>   body: author.json (as is)
```

Then the same pair for the `post` collection with its current composition plus the `author` field from `post-author-field.json`.
Apply `author` first: a relation to a collection that does not exist yet is a dangling target.

## GATE: applying waits for counsel (design Q3)

Public author profiles are personal data the legal pack does not cover. **Do not apply this to the live tenant, and do not create a real
author item, until counsel has delivered the profile-consent text and the RoPA rows (design 2026-10-11 section 11 Q3, counsel's list O-3).**
Applying the schema alone stores no personal data, but it opens the editor to creating profiles, so it waits too.

## What the site (separate repo) needs

- Resolve `post.author` ({ collection, slug }) to the author item (delivery read, same locale; fall back to the default-locale twin).
- Render the byline from `displayName` + `roleTitle`, linked to the author page; render nothing when the relation is empty or the
  author is not `published`. Never print the old literal "[CONFIRM: author name and role]".
- Author page: bio, topics, credentials, photo with `photoAlt`, `profileLinks` as `rel="me noopener"` links; emit `Person` JSON-LD from
  the same fields (`sameAs` = the link URLs). Only for `published` authors.
- Drop the 5 role-only author pages (INVENTORY: duplicates of team pages): they must not be imported as authors.
- Site import (not in this ticket): map each post's front-matter author to an `author` item by name; posts whose author is the "[CONFIRM ...]"
  literal import with an empty relation and are listed for a human to assign. Do not invent authors.

## ERP / writers' room (not built)

The writers' room needs an author picker on the post editor (a relation field control listing published `author` items of the item's
tenant, searchable by name). No UI is built here.
