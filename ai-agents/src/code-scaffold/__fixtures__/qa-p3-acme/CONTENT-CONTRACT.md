# WebDesk content contract — qa-p3-acme

- Contract version: `1.0.0`
- Vocabulary version: `1.3.0`
- Default locale: `en` · Declared locales: `en`, `es`

Derived from `openapi.v1.json` in the same generation run (WSK-D19: OpenAPI is the one hand-authored source; this file and the TS SDK are both derived from it/its input, never hand-maintained separately). Describes exactly what `webdesk/api/src/delivery/router.ts` (design §06) serves under the frozen `/v1` envelope — see design §05 for the envelope's full shape.

## Authentication

`Authorization: Bearer <api key>` on every request — a tenant/environment-scoped key minted via the control plane (design §03/§08). No cookies, no session state.

## Collections

### `article`

- `GET /v1/t/qa-p3-acme/article` — cursor-paginated list
- `GET /v1/t/qa-p3-acme/article/{slug}` — one item

**Blocks** (this collection's declared allow-list):

- **hero**
  - `heading` — text, required
  - `subheading` — text, optional
  - `media` — media, optional
  - `ctaLabel` — text, optional
  - `ctaHref` — text, optional
- **richText**
  - `content` — richtext, required
- **cta**
  - `heading` — text, required
  - `body` — text, optional
  - `buttonLabel` — text, required
  - `buttonHref` — text, required

### `caseStudy`

- `GET /v1/t/qa-p3-acme/caseStudy` — cursor-paginated list
- `GET /v1/t/qa-p3-acme/caseStudy/{slug}` — one item

**Fields** — carried in `blocks[0]` as `{ "type": "fields", "props": { ... } }` (vocabulary 1.1.0). Closed: no other keys.
  - `client` — text, required
  - `industry` — select, optional (one of: retail, finance, health)

**Blocks** (this collection's declared allow-list):

- **hero**
  - `heading` — text, required
  - `subheading` — text, optional
  - `media` — media, optional
  - `ctaLabel` — text, optional
  - `ctaHref` — text, optional
- **testimonial**
  - `quote` — richtext, required
  - `author` — text, required
  - `role` — text, optional
  - `avatar` — media, optional
- **gallery**
  - `items` — media, list, required
  - `caption` — text, optional

### `redirect`

- `GET /v1/t/qa-p3-acme/redirect` — cursor-paginated list
- `GET /v1/t/qa-p3-acme/redirect/{slug}` — one item

**Fields** — carried in `blocks[0]` as `{ "type": "fields", "props": { ... } }` (vocabulary 1.1.0). Closed: no other keys.
  - `target` — text, required

**Blocks:** none besides the fields block.

## Other routes

- `GET /v1/t/qa-p3-acme/search?q=...` — full-text search across every collection (Postgres tsvector, per-locale config)
- `GET /v1/t/qa-p3-acme/sitemap.xml` — generated sitemap for the resolved locale

## Pagination

Cursor-based (`?cursor=`, `?limit=`, default/max 25/100), stable under concurrent publish — never offset-based. `page.hasMore` + `page.cursor` drive the next request; `page.cursor` is `null` on the last page.

## Errors

Every non-2xx response is RFC 9457 `application/problem+json` — one shape (`type`, `title`, `status`, `detail?`, `instance`, `requestId`) for every failure. See `openapi.v1.json`'s `ProblemDetails` schema.
