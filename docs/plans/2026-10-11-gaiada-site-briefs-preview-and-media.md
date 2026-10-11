# gaiada-web-revamp: two small site changes WebDesk needs (briefs for the site owner)

**From:** WebDesk M3, 2026-10-11 · **For:** whoever owns `gaiadabali/gaiada-web-revamp` (the revamp, staged at
`24-pyevq.gaiada.com`) · **Rulings:** WSK-D52 (draft preview is a page on the site) and WSK-D53 (library images reach a
static site through its build), in `docs/blueprints/webdesk-design-v2.md` §14.

WebDesk and the ERP already implement their halves. Each brief below is self-contained. Neither changes the
published site's output for existing content, and both stay off the live domain until the revamp's cutover.

---

## Brief 1 · A `/preview/` page (WSK-46)

**What it does.** An editor clicks **Preview** in the ERP's Website editor. The ERP opens
`https://24-pyevq.gaiada.com/preview/#t=<token>`. The page reads the token, fetches the draft from WebDesk, and
renders it with the site's own components, exactly as the page would look if it were published.

**WebDesk's public host is `api.erp.gaiada.com`** (owner ruling WSK-D61; all ERP names nest under `erp.gaiada.com`). Treat it as
configuration in the site (one env value), never a literal, in case it moves again.

**Contract (built, on WebDesk main).**
- `GET https://api.erp.gaiada.com/v1/t/gaiada/preview/<token>` returns the frozen `/v1` item envelope (the same shape the
  build reads for an item), filled from the draft version the token pins.
  - No API key: the token is the credential. It expires (1 hour by default) and can be revoked.
  - Response headers: `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.
  - CORS answers only for the site's own domains, the staging and production `environments.domain`.
  - Every invalid token (unknown, expired, revoked, wrong tenant, deleted item) gets one identical **404**.

**What the page must do.**
1. **Read the token from the URL FRAGMENT** (`location.hash`, the part after `#t=`), never from a query string.
   Browsers never send a fragment to any server, nor in a Referer, so the token stays out of the site host's access
   logs. Do not copy it into the URL, `history`, analytics or error reports.
2. **Set `<meta name="referrer" content="no-referrer">`** on the page.
3. **Send the token to the preview render service in a POST body** (`/preview/render` on the same host), never in a URL. The service fetches `GET ${WEBDESK_PUBLIC_BASE}/v1/t/gaiada/preview/<token>` server-side, with `WEBDESK_PUBLIC_BASE = https://api.erp.gaiada.com`, and returns the rendered HTML, which the page swaps in. The service redacts the token from its own logs.
4. **Render with the site's real templates** (AMENDED 2026-10-11 by the owner, WSK-D52). The templates are build-time Astro components, which cannot run in a browser, so the render happens in a small preview render service: a second Astro config (`@astrojs/node`, one SSR route) built from the same templates and pipeline, run on the staging host behind nginx. The main static build and its determinism are untouched. A browser approximation and a build per preview were declined.
5. **States:**
   - token missing: "Open this page from the ERP's Preview button".
   - 404: "This preview link has expired or was withdrawn. Open a new preview from the editor".
   - network error: an honest retry.
6. **`noindex`**, and exclude `/preview/` from the sitemap and `llms.txt`.
7. **Prerequisite:** `api.erp.gaiada.com` resolves publicly. It is a CNAME to `aicenter.erp.gaiada.com` (D61), after which
   the WebDesk orchestrator enables the vhost.

**How the ERP knows the page exists.** Before minting a token, the ERP checks `HEAD https://24-pyevq.gaiada.com/preview/`.
- A 404 means the editor sees "This site doesn't have a preview page yet". The ERP caches that answer for 5 minutes.
- So the page only has to exist and return 200 to an empty `HEAD`.

**Done when:** an editor's Preview opens the draft rendered exactly as the published page would be, the token never
appears in any server log or Referer, and the page is unindexable.

---

## Brief 2 · Library images in the static build (WSK-43d)

**What it does.** Editors can now pick images from WebDesk's media library into content. A picked image is stored in
the content as a `media` value `{url, alt?, width?, height?, mime?}`. Its `url` is WebDesk's media route,
`/v1/t/gaiada/media/<assetId>` (or the absolute `https://api.erp.gaiada.com/…` form). The published static site must never
load images from WebDesk at runtime (D53). The build copies them in.

**What the build's pull step must do** (the `CONTENT_SOURCE=webdesk` path that reads `/v1` with the read key):
1. While pulling content, collect every `media.url` that points at WebDesk's media route.
2. Download each one once with the build's read key. Read WebDesk's `webdesk/api/README.md` "Media library (WSK-43a)"
   for the exact read and presign behaviour. Use the transform route if the site wants resized variants.
3. Write them into the static output under a stable, content-addressed path (e.g. `/_media/<assetId>-<sha8>.<ext>`)
   and rewrite each `media.url` in the pulled content to that path before Astro renders.
4. A download failure fails the build loudly. A page must never ship with a broken image.
5. Keep determinism: two builds of the same content give byte-identical `dist/`. The WSK-55 parity gate depends on it.

**Done when:** a library image placed in a gaiada.com page appears on the staging build from the site's own origin,
the built HTML contains no `api.erp.gaiada.com` image URL, and `dist/` stays deterministic.
