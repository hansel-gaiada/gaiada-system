// WSK-48a (tests port) — the differential gate's SECOND half, ported from
// webdesk/payload/test/v1-differential-extra.test.mjs: every request class the envelope-contract
// suite does not make (it only asks for happy paths plus three auth failures). Seeds its own
// fixtures (two differently-composed tenants, a third that is archived), then sends each request to
// the OLD router and the NEW api route through `comparePair`.
//
// Covers: unknown tenant, archived (non-active) tenant, missing key, bad key, revoked key,
// cross-tenant key use, auth-header spelling variants, every non-GET method (with and without a
// body), 404 item, scheduled / expired / unpublished visibility on production vs staging keys,
// locale fallback (requested locale with and without a translation, an undeclared locale, an empty
// locale), bad / garbage / SQL-erroring cursors, limit edge values, expand=blocks, search
// (operators, collection filter, locale, empty, cursor walk), sitemap.xml (with and without a
// domain, per locale), redirect collection, unicode and percent-encoded slugs, path anomalies (/v1,
// /v1/t, trailing and double slashes, case, extra segments, /v2), and a full cursor walk including
// rows that share one created_at (id tie-break).
//
// The request list is the original's, in the original order. Only the redirect seeding moved to
// v1-fixtures.ts#createRedirect (the original used the old router's own write helper).
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import type { ComparePair, PairOptions } from "./differential";
import {
  createFixtureCollection,
  createFixtureTenant,
  createRedirect,
  migratorUrl,
  mintFixtureApiKey,
  seedContentItem,
  setEnvironmentDomain,
  type V1Tenant,
} from "./v1-fixtures";

async function asMigrator(tenant: V1Tenant, sql: string, params: unknown[] = []): Promise<void> {
  const c = new Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
}

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

/** Runs the whole corpus. Returns the harness self-check failures (must be empty). */
export async function runExtraCorpus(comparePair: ComparePair): Promise<string[]> {
  const harnessFailures: string[] = [];
  const must = (cond: unknown, msg: string) => {
    if (!cond) harnessFailures.push(msg);
  };

  // ---------------------------------------------------------------------------------- fixtures
  const A = await createFixtureTenant({ label: "xa", defaultLocale: "id-ID", locales: ["id-ID", "en-US", "fr-FR"] });
  const B = await createFixtureTenant({ label: "xb", defaultLocale: "en-US", locales: ["en-US"] });
  const S = await createFixtureTenant({ label: "xs", defaultLocale: "en-US", locales: ["en-US"] });
  const cs = await createFixtureCollection(A, "case-study");
  const post = await createFixtureCollection(A, "post");
  await createFixtureCollection(A, "empty");
  const article = await createFixtureCollection(B, "article");
  const sCol = await createFixtureCollection(S, "article");

  const prodA = await mintFixtureApiKey(A, "production", "read");
  const stgA = await mintFixtureApiKey(A, "staging", "read");
  const writeA = await mintFixtureApiKey(A, "production", "write");
  const revokedA = await mintFixtureApiKey(A, "production", "read");
  await asMigrator(
    A,
    `UPDATE api_keys SET revoked_at = now() WHERE env_id = $1 AND scope = 'read' AND key_hash = encode(sha256(convert_to($2 || $3, 'UTF8')), 'hex')`,
    [A.productionEnvId, revokedA, process.env.API_KEY_PEPPER],
  );
  const prodB = await mintFixtureApiKey(B, "production", "read");
  const stgB = await mintFixtureApiKey(B, "staging", "read");
  const prodS = await mintFixtureApiKey(S, "production", "read");
  await asMigrator(
    S,
    `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, blocks, publish_state) VALUES ($1,$2,$3,'en-US','s1','[]'::jsonb,'published')`,
    [S.tenantId, S.siteId, sCol],
  );
  {
    // non-active tenant ('archived' is the only non-active status the schema allows): tenants rows are visible only under platform ctx
    const c = new Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL webdesk.platform_ctx = 'true'");
      const r = await c.query(`UPDATE tenants SET status = 'archived' WHERE id = $1`, [S.tenantId]);
      must(r.rowCount === 1, "suspend tenant S");
      await c.query("COMMIT");
    } finally {
      await c.end();
    }
  }

  const group = randomUUID();
  await seedContentItem(A, {
    collectionId: cs,
    locale: "id-ID",
    slug: "acme-rebrand",
    localizationGroupId: group,
    seo: { title: "Acme Rebrand", description: "desc", ogImage: "/x.png" },
    blocks: [
      { type: "hero", props: { heading: "Halo" } },
      { type: "richText", props: { content: "body" } },
      { type: "zzz-unknown-block", props: { a: 1 } },
    ],
  });
  await seedContentItem(A, { collectionId: cs, locale: "en-US", slug: "acme-rebrand-en", localizationGroupId: group, seo: { title: "Acme Rebrand EN" } });
  await seedContentItem(A, { collectionId: cs, locale: "fr-FR", slug: "acme-rebrand-fr", localizationGroupId: group, publishState: "scheduled", publishAt: iso(3_600_000) });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "draft-only", publishState: "draft" });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "scheduled-now-live", publishState: "scheduled", publishAt: iso(-60_000) });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "scheduled-future", publishState: "scheduled", publishAt: iso(3_600_000) });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "expired", publishState: "published", unpublishAt: iso(-60_000) });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "expiring-soon", publishState: "published", unpublishAt: iso(3_600_000) });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "unpublished", publishState: "unpublished" });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "café-menu", blocks: [{ type: "richText", props: { content: "unicode ✓ 日本語" } }] });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "with space" });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "UPPER-case" });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "slug.with.dots" });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "a%b" });
  await seedContentItem(A, { collectionId: cs, locale: "id-ID", slug: "search-zephyrhoof", seo: { title: "Zephyrhoof Widgetronic", description: "a very unique search term" } });
  await seedContentItem(A, { collectionId: cs, locale: "en-US", slug: "running-en", seo: { title: "Running runners run", description: "stemming probe" } });
  // 7 posts, three of them sharing ONE created_at (the cursor's id tie-break)
  const shared = iso(-5_000);
  for (let i = 0; i < 7; i++) {
    await seedContentItem(A, { collectionId: post, locale: "id-ID", slug: `post-${i}`, createdAt: i >= 2 && i <= 4 ? shared : undefined });
    await new Promise((r) => setTimeout(r, 4));
  }
  await seedContentItem(B, { collectionId: article, locale: "en-US", slug: "hello-world", seo: { title: "Hello World" } });
  await seedContentItem(B, { collectionId: article, locale: "en-US", slug: "second", seo: { title: "Second Hello" } });

  await createRedirect(A, { fromPath: "/old-page", toPath: "/new-page", status: 301, active: true });
  await createRedirect(A, { fromPath: "/inactive-page", toPath: "/somewhere", status: 302, active: false });
  await setEnvironmentDomain(A, "production", "acme.example.invalid"); // A has a domain, B does not

  // ---------------------------------------------------------------------------------- requests
  const get = (path: string, headers: Record<string, string> = {}, opts?: PairOptions) =>
    comparePair({ method: "GET", pathAndQuery: path, headers }, opts);
  const a = `/v1/t/${A.slug}`;
  const b = `/v1/t/${B.slug}`;

  // 1. auth failures ------------------------------------------------------------------------
  await get(`${a}/case-study`); // missing key
  await get(`${a}/case-study`, { authorization: "" });
  await get(`${a}/case-study`, { authorization: "Bearer" });
  await get(`${a}/case-study`, { authorization: "Bearer " });
  await get(`${a}/case-study`, { authorization: "Basic dGVzdDp0ZXN0" });
  await get(`${a}/case-study`, bearer("wdsk_not_a_real_key"));
  await get(`${a}/case-study`, bearer(revokedA)); // revoked key
  await get(`${a}/case-study`, bearer(prodB)); // tenant B's key on A
  await get(`${b}/article`, bearer(prodA)); // tenant A's key on B
  await get(`/v1/t/does-not-exist-wsk48a/case-study`, bearer(prodA)); // unknown tenant, with key
  await get(`/v1/t/does-not-exist-wsk48a/case-study`); // unknown tenant, no key
  await get(`/v1/t/${S.slug}/article`, bearer(prodS)); // archived (non-active) tenant with a valid key
  await get(`/v1/t/${S.slug}/article`); // archived tenant, no key
  for (const h of [
    { authorization: `bearer ${prodA}` },
    { authorization: `BEARER ${prodA}` },
    { authorization: `Bearer   ${prodA}` },
    { authorization: `  Bearer ${prodA}  ` },
    { authorization: `Bearer ${prodA} extra` }, // key with trailing garbage -> not a known hash
    { authorization: `Token ${prodA}` },
    { authorization: prodA },
  ]) await get(`${a}/case-study`, h);
  // no x-request-id at all: requestId is a random UUID per side -> the ONE normalised probe class
  await get(`${a}/case-study`, {}, { normalizeRequestId: true, note: "normalizeRequestId" });
  await get(`/v1/t/does-not-exist-wsk48a/x`, bearer(prodA), { normalizeRequestId: true, note: "normalizeRequestId" });
  await get(`${a}/case-study/nope`, { ...bearer(prodA), "x-request-id": "client-supplied-id" });

  // 2. methods ------------------------------------------------------------------------------
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    for (const [path, h] of [
      [`${a}/case-study`, bearer(prodA)],
      [`${a}/case-study/acme-rebrand`, bearer(prodA)],
      [`${a}/case-study`, {}],
      [`/v1/t/does-not-exist-wsk48a/x`, {}],
      [`/v1/nonsense`, {}],
    ] as [string, Record<string, string>][]) {
      await comparePair({ method, pathAndQuery: path, headers: h });
    }
  }
  for (const [method, ct, body] of [
    ["POST", "application/json", '{"a":1}'],
    ["POST", "application/json", "{bad json"],
    ["POST", "text/plain", "hello"],
    ["PUT", "application/x-www-form-urlencoded", "a=1"],
    ["POST", "application/x-wsk48a-unsupported", "xyz"],
  ]) {
    await comparePair({ method, pathAndQuery: `${a}/case-study`, headers: { ...bearer(writeA), "content-type": ct }, body });
  }

  // 3. lists, per key (production vs staging vs write), locales, expand, limits --------------
  for (const [label, key] of [
    ["prod", prodA],
    ["staging", stgA],
    ["write", writeA],
  ]) {
    for (const q of ["", "?locale=en-US", "?locale=id-ID", "?locale=fr-FR", "?locale=xx-YY", "?locale=", "?locale=%20", "?expand=blocks", "?expand=nope", "?expand=blocks&locale=en-US"]) {
      await get(`${a}/case-study${q}`, bearer(key), { note: label });
    }
    for (const col of ["post", "redirect", "empty", "nonexistent-collection"]) await get(`${a}/${col}`, bearer(key), { note: label });
    for (const lim of ["0", "-5", "1", "2", "3", "25", "100", "101", "1000", "abc", "2.5", "", "1e1", "%20"]) await get(`${a}/post?limit=${lim}`, bearer(key), { note: label });
  }
  await get(`${b}/article`, bearer(prodB));
  await get(`${b}/article`, bearer(stgB));
  await get(`${b}/article?locale=fr-FR`, bearer(prodB));
  await get(`${b}/article?expand=blocks`, bearer(prodB));

  // 4. items ---------------------------------------------------------------------------------
  const slugs = ["acme-rebrand", "acme-rebrand-en", "acme-rebrand-fr", "draft-only", "scheduled-now-live", "scheduled-future", "expired", "expiring-soon", "unpublished", "café-menu", "caf%C3%A9-menu", "with%20space", "with space", "UPPER-case", "upper-case", "slug.with.dots", "a%25b", "a%b", "nope", "post-0"];
  for (const [label, key] of [
    ["prod", prodA],
    ["staging", stgA],
  ]) {
    for (const slug of slugs) {
      for (const loc of ["", "?locale=en-US", "?locale=id-ID", "?locale=fr-FR", "?locale=xx-YY"]) await get(`${a}/case-study/${slug}${loc}`, bearer(key), { note: label });
    }
  }
  await get(`${b}/article/hello-world`, bearer(prodB));
  await get(`${b}/article/hello-world?locale=id-ID`, bearer(prodB));
  await get(`${b}/article/nope`, bearer(prodB));
  await get(`${a}/redirect/%2Fold-page`, bearer(prodA));
  await get(`${a}/redirect//old-page`, bearer(prodA));

  // 5. cursors -------------------------------------------------------------------------------
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  for (const cursor of [
    "garbage",
    "!!!",
    b64("nopipe"),
    b64("|"),
    b64("2020-01-01 00:00:00+00|"),
    b64(`2020-01-01 00:00:00+00|${randomUUID()}`),
    b64(`notadate|${randomUUID()}`),
    b64("2020-01-01|not-a-uuid"),
    b64(`2999-01-01 00:00:00+00|${randomUUID()}`),
    "",
  ]) {
    await get(`${a}/post?limit=2&cursor=${encodeURIComponent(cursor)}`, bearer(prodA), { note: `cursor=${cursor.slice(0, 12)}` });
    await get(`${a}/search?q=post&limit=2&cursor=${encodeURIComponent(cursor)}`, bearer(prodA), { note: `search cursor=${cursor.slice(0, 12)}` });
  }
  // full walks, the cursor taken from the OLD side's page and replayed to both
  async function walk(base: string, key: string, limit: number, extra = "") {
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const { old } = await get(`${base}?limit=${limit}${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, bearer(key), { note: `walk limit=${limit}` });
      const page = JSON.parse(old.body.toString("utf8"));
      if (!page.page?.hasMore) return;
      cursor = page.page.cursor;
    }
    must(false, `walk ${base} limit=${limit} did not terminate`);
  }
  for (const lim of [1, 2, 3, 4, 7, 10]) await walk(`${a}/post`, prodA, lim);
  await walk(`${a}/case-study`, stgA, 3);
  await walk(`${a}/case-study`, stgA, 2, "&expand=blocks");
  await walk(`${a}/search`, prodA, 2, "&q=post");

  // 6. search --------------------------------------------------------------------------------
  const qs = ["Zephyrhoof", "zephyrhoof", "widgetronic", "unique search", '"unique search"', "unique -zephyrhoof", "unique OR rebrand", "NoSuchTermAnywhere", "", "a", "run", "running", "runner", "post", "acme", "Acme Rebrand", "it's", "<script>", "%", "日本語", "café", "x".repeat(300)];
  for (const [label, key] of [
    ["prod", prodA],
    ["staging", stgA],
  ]) {
    for (const q of qs) {
      for (const loc of ["", "&locale=en-US", "&locale=id-ID", "&locale=xx-YY"]) await get(`${a}/search?q=${encodeURIComponent(q)}${loc}`, bearer(key), { note: label });
    }
    for (const col of ["case-study", "post", "nope"]) await get(`${a}/search?q=post&collection=${col}`, bearer(key), { note: label });
    await get(`${a}/search`, bearer(key), { note: "no q" });
    await get(`${a}/search?q=Zephyrhoof&limit=1`, bearer(key), { note: label });
    await get(`${a}/search?q=Zephyrhoof&expand=blocks`, bearer(key), { note: label });
  }
  await get(`${b}/search?q=hello`, bearer(prodB));
  await get(`${b}/search?q=hello&collection=article&limit=1`, bearer(prodB));

  // 7. sitemap -------------------------------------------------------------------------------
  for (const [label, key] of [
    ["prod", prodA],
    ["staging", stgA],
  ]) {
    for (const loc of ["", "?locale=en-US", "?locale=id-ID", "?locale=fr-FR", "?locale=xx-YY", "?locale="]) await get(`${a}/sitemap.xml${loc}`, bearer(key), { note: label });
  }
  await get(`${b}/sitemap.xml`, bearer(prodB)); // no domain set -> root-relative <loc>
  await get(`${b}/sitemap.xml?locale=id-ID`, bearer(prodB));
  await get(`${a}/sitemap.xml`); // no key
  await get(`${a}/sitemap.xml/extra`, bearer(prodA));
  await get(`${a}/Sitemap.xml`, bearer(prodA)); // case-sensitive: this is a collection key

  // 8. path anomalies ------------------------------------------------------------------------
  for (const p of [
    "/v1",
    "/v1/",
    "/v1/t",
    "/v1/t/",
    "/v1//t/" + A.slug + "/post",
    "/v1/t/" + A.slug,
    "/v1/t/" + A.slug + "/",
    "/v1/T/" + A.slug + "/post",
    "/V1/t/" + A.slug + "/post",
    "/v2/t/" + A.slug + "/post",
    "/v1/x/" + A.slug + "/post",
    "/v1/t/" + A.slug + "/post/",
    "/v1/t/" + A.slug + "//post",
    "/v1/t/" + A.slug + "/post/post-0/extra",
    "/v1/t/" + A.slug + "/a/b/c/d",
    "/v1/t/" + A.slug + "/search/extra",
    "/v1/t/" + A.slug + "/post?",
    "/v1/t/" + A.slug + "/post?limit=2&limit=3",
    "/v1/t/" + A.slug + "/post?%",
    "/v1/t/" + A.slug + "/po%73t",
    "/v1/t/" + A.slug + "/post%2Fpost-0",
    "/v1/t/%E0%A4%A/post",
    "/v1/t/" + A.slug + "/%E0%A4%A",
    "/v1/t/" + A.slug + "/post/%00",
    "/v1/t/..%2f" + A.slug + "/post",
    "/v1/t/" + A.slug + "/..;/post",
    "/v1/t/" + A.slug + "/post;x=1",
    "/v1/t/" + A.slug + "/post#frag",
  ]) {
    await get(p, bearer(prodA), { note: "path anomaly" });
    await get(p, {}, { note: "path anomaly, no key" });
  }
  // a handful of other prefixes that must NOT be answered by the delivery route in either world
  // (old: gateway 404s them before the router; new: Nest's own 404) are intentionally NOT compared —
  // they are different servers by design.

  return harnessFailures;
}
