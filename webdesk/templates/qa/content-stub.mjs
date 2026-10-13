// M6-P6m - a tiny local HTTPS stub of the content delivery API, for qa/build-templates.sh (plain node, no dependency).
//
// The scaffolded site's SDK module (apps/web/src/lib/webdesk-sdk.ts, from ai-agents/src/code-scaffold/sdk-client-template.ts)
// calls `https://${WEBDESK_HOST}/v1/t/<tenant>/<collection>` (list, `?cursor=&limit=`) and `.../<collection>/<slug>` (get) with
// `Authorization: Bearer <WEBDESK_API_KEY>`. It always uses https, so the gate gives this server a throwaway self-signed cert
// and points NODE_EXTRA_CA_CERTS at it.
//
//   node content-stub.mjs <port> <cert.pem> <key.pem> <request-log>
//
// Fixture: caseStudy has two items (alpha, beta); article is EMPTY (the empty-collection case); any other collection or slug is a 404.
import { createServer } from "node:https";
import { readFileSync, appendFileSync } from "node:fs";

const [port, certPath, keyPath, logPath] = process.argv.slice(2);
const COLLECTIONS = {
  caseStudy: [
    { slug: "alpha", title: "Alpha case study" },
    { slug: "beta", title: "Beta case study" },
  ],
  article: [],
};
const item = (collection, it) => ({
  collection, slug: it.slug, locale: "en", seo: { title: it.title }, meta: { draft: false }, blocks: [],
});

const server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) => {
  const url = new URL(req.url, "https://localhost");
  appendFileSync(logPath, `${req.method} ${url.pathname}${url.search} auth=${req.headers.authorization ? "yes" : "no"}\n`);
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const m = /^\/v1\/t\/[^/]+\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
  if (req.method !== "GET" || !m || !(m[1] in COLLECTIONS)) return send(404, { error: "not found" });
  const [, collection, slug] = m;
  const items = COLLECTIONS[collection];
  if (slug === undefined) {
    return send(200, { collection, locale: "en", items: items.map((it) => item(collection, it)), page: { cursor: null, hasMore: false, limit: 100 } });
  }
  const found = items.find((it) => it.slug === slug);
  return found ? send(200, item(collection, found)) : send(404, { error: "not found" });
});
server.listen(Number(port), "127.0.0.1", () => console.log(`content-stub listening on ${port}`));
