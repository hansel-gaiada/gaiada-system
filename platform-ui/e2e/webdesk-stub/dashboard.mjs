// M5-W8 — the stubbed writer dashboard BFF (`GET …/writers/dashboard`, FRONTEND-BFF-CONTRACT §27 "Writers' room dashboard"), a pure fixture
// for e2e/webdesk-dashboard.spec.ts. TEST FIXTURE ONLY: nothing under `src/` imports it. Transcribed from the contract, boring and literal.
//
// The REAL authority is Cerbos in the BFF: this decides only what the contract says a caller sees per x-user-id role (publisher: every row;
// viewer: the rows they wrote, scope "scoped"; anyone else is the BFF's 403, handled before this runs).
//
// Scenario control (POST /__stub/config): `dashboardMode`:
//   "ok"          (default) three articles: full figures + a decay finding; an Umami-less one (views unavailable, in words); one in a
//                 collection with no public page address
//   "umamiDown"   every Umami figure is unavailable with its reason, and the source banner says so
//   "empty"       no published articles
//   "drift"       a metric with a null value AND a null reason (the BFF breaking its contract: the page must say so, not draw a card)
//   "smallCell"   views come as a raw 3 (breaking the small-cell rule): contract drift too

const R = (status, json) => ({ status, json });
const W = (from, to) => ({ from, to });
const reason = (code, text) => ({ code, text });
const ok = (value) => ({ value, reason: null });
const na = (code, text) => ({ value: null, reason: reason(code, text) });

const UMAMI_DOWN = reason("umami_unreachable", "Website analytics could not be reached. Try again in a moment.");
const NO_PATTERN = reason("no_route_pattern", "This collection has no public page address on record, so no page figures can be matched to its items.");

function articles(mode) {
  const down = mode === "umamiDown";
  const views = (f) => (down ? { value: null, reason: UMAMI_DOWN } : ok(f));
  return [
    {
      itemId: "itm-service-local-seo-en", collectionKey: "service", locale: "en", slug: "service.local-seo", title: "Local SEO for hotels", publishedVersion: 2, mine: true,
      pagePath: "/services/local-seo/", pagePathReason: null,
      metrics: {
        views: views({ current: mode === "smallCell" ? 3 : 120, previous: 60, trend: mode === "smallCell" ? null : "up" }),
        avgSeconds: down ? { value: null, reason: UMAMI_DOWN } : ok({ seconds: 210 }),
        clicks: ok({ current: 113, previous: 56, trend: "up" }),
        impressions: ok({ current: 4500, previous: 5200, trend: "down" }),
        topQueries: ok([{ query: "local seo bali", clicks: 40, impressions: 900 }, { query: "hotel seo", clicks: 22, impressions: 700 }, { query: "seo agency ubud", clicks: 3, impressions: 120 }]),
        leads: ok({ current: 3, previous: 3, trend: "flat" }),
      },
      decay: ok({ findingId: "fnd-1", status: "open", reason: "Search clicks fell by 40 % against the 28 days before.", detectedAt: "2026-10-10T00:00:00.000Z", briefId: null }),
    },
    {
      itemId: "itm-service-web-design-en", collectionKey: "service", locale: "en", slug: "service.web-design", title: "Web design", publishedVersion: 1, mine: false,
      pagePath: "/services/web-design/", pagePathReason: null,
      metrics: {
        views: views({ current: "<5", previous: 40, trend: null }),
        avgSeconds: down ? { value: null, reason: UMAMI_DOWN } : na("small_cell", "Fewer than 5 visits, so no average is shown."),
        clicks: ok({ current: 0, previous: 0, trend: "flat" }),
        impressions: ok({ current: 12, previous: 10, trend: "flat" }),
        topQueries: ok([]),
        leads: ok({ current: 0, previous: 1, trend: "down" }),
      },
      decay: ok("none"),
    },
    {
      itemId: "itm-banner-en", collectionKey: "banner", locale: "en", slug: "banner.home", title: "Home banner", publishedVersion: 1, mine: false,
      pagePath: null, pagePathReason: NO_PATTERN,
      metrics: {
        views: na("no_route_pattern", NO_PATTERN.text), avgSeconds: na("no_route_pattern", NO_PATTERN.text), clicks: na("no_route_pattern", NO_PATTERN.text),
        impressions: na("no_route_pattern", NO_PATTERN.text), topQueries: na("no_route_pattern", NO_PATTERN.text), leads: na("no_route_pattern", NO_PATTERN.text),
      },
      decay: na("no_route_pattern", NO_PATTERN.text),
    },
  ];
}

/** Dispatch for the dashboard route under `…/sites/:t/:s`. `rest` is what follows the site. Returns null for a path that is not the dashboard. */
export function handleDashboard(S, { method, rest, query, role }) {
  if (rest !== "/writers/dashboard" || method !== "GET") return null;
  const mode = S.cfg.dashboardMode ?? "ok";
  let items = mode === "empty" ? [] : articles(mode);
  if (role !== "publisher") items = items.filter((i) => i.mine);
  else if (query.get("mine") === "true") items = items.filter((i) => i.mine);
  const collection = query.get("collection");
  if (collection) items = items.filter((i) => i.collectionKey === collection);
  const locale = query.get("locale");
  if (locale) items = items.filter((i) => i.locale === locale);
  if (mode === "drift" && items[0]) items[0].metrics.clicks = { value: null, reason: null };
  const period = ["7d", "28d", "90d"].includes(query.get("period") ?? "") ? query.get("period") : "28d";
  const days = Number(period.slice(0, -1));
  const umami = mode === "umamiDown" ? { state: "unavailable", reason: UMAMI_DOWN } : { state: "ok" };
  return R(200, {
    tenantSlug: "gaiada", siteId: "site-gaiada-com", period: { key: period, days },
    windows: { traffic: { current: W("2026-09-15", "2026-10-12"), previous: W("2026-08-18", "2026-09-14") }, search: { current: W("2026-09-12", "2026-10-09"), previous: W("2026-08-15", "2026-09-11") } },
    scope: role === "publisher" ? "all_site" : "scoped",
    sources: { umami, search: { state: "ok" }, leads: { state: "ok" }, decay: { state: "ok" } },
    items, page: { cursor: null, hasMore: false, limit: 25 },
  });
}
