# WebDesk content contract — wsk17-proof

- Contract version: `1.0.0`
- Vocabulary version: `1.0.0`
- Default locale: `en-US` · Declared locales: `en-US`, `id-ID`

Derived from `openapi.v1.json` in the same generation run (WSK-D19: OpenAPI is the one hand-authored source; this file and the TS SDK are both derived from it/its input, never hand-maintained separately). Describes exactly what `webdesk/payload/collections/router.ts` (design §06) serves under the frozen `/v1` envelope — see design §05 for the envelope's full shape.

## Authentication

`Authorization: Bearer <api key>` on every request — a tenant/environment-scoped key minted via the control plane (design §03/§08). No cookies, no session state.

## Collections

### `case-study`

- `GET /v1/t/wsk17-proof/case-study` — cursor-paginated list
- `GET /v1/t/wsk17-proof/case-study/{slug}` — one item

**Blocks** (this collection's declared allow-list):

- **hero**
  - `heading` — text, required
  - `subheading` — text, optional
  - `media` — media, optional
  - `ctaLabel` — text, optional
  - `ctaHref` — text, optional
- **richText**
  - `content` — richtext, required
- **gallery**
  - `items` — media, required
  - `caption` — text, optional
- **cta**
  - `heading` — text, required
  - `body` — text, optional
  - `buttonLabel` — text, required
  - `buttonHref` — text, required
- **featureGrid**
  - `heading` — text, optional
  - `items` — relation, required
- **form**
  - `formKey` — relation, required
- **testimonial**
  - `quote` — richtext, required
  - `author` — text, required
  - `role` — text, optional
  - `avatar` — media, optional
- **faq**
  - `heading` — text, optional
  - `items` — relation, required
- **logoCloud**
  - `heading` — text, optional
  - `logos` — media, required

## Other routes

- `GET /v1/t/wsk17-proof/search?q=...` — full-text search across every collection (Postgres tsvector, per-locale config)
- `GET /v1/t/wsk17-proof/sitemap.xml` — generated sitemap for the resolved locale

## Pagination

Cursor-based (`?cursor=`, `?limit=`, default/max 25/100), stable under concurrent publish — never offset-based. `page.hasMore` + `page.cursor` drive the next request; `page.cursor` is `null` on the last page.

## Errors

Every non-2xx response is RFC 9457 `application/problem+json` — one shape (`type`, `title`, `status`, `detail?`, `instance`, `requestId`) for every failure. See `openapi.v1.json`'s `ProblemDetails` schema.
