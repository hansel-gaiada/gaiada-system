# AI-crawler log: shipping a site's access log to the ERP (M5-P5b)

STATUS: PROTOTYPED. This runbook describes a recipe. Nothing here has been installed on any server, and no job is
set up by the repository. Whoever installs it does so on a host the owner names, one step at a time.

## What it does

The ERP keeps a daily count of requests from known AI crawlers (GPTBot, ClaudeBot, PerplexityBot, ...) per search
property: bot, URL path (no query string), HTTP status, and whether the request really came from the vendor's
addresses. The Website workspace shows it under Analytics, "AI visibility". It is built from the web server's own
access log, because AI crawlers do not run JavaScript and so never appear in Umami.

## What leaves the host, and what is kept

An access log line holds a visitor IP and a browser string (`legal/website-visitor-addendum.md`). The recipe is built
so that those never leave the host and are never stored:

1. The shipping script filters on the host with `grep`, so only lines whose User-Agent names an AI crawler are sent.
   A human's line never reaches the network.
2. The ERP parser (`platform-nest/src/modules/search/ai-crawler-log.ts`) drops anything that is not on its allow-list
   anyway, so a script that forgot the filter still stores nothing about humans.
3. Stored per row: UTC day, bot id, path without query string, status, verification flag, count. The raw line, the IP
   and the User-Agent string are never stored, returned or logged. The IP of an AI crawler is used in memory only,
   to check it against the vendor's published ranges.

## Log formats understood

* nginx / Apache "combined": `$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent
  "$http_referer" "$http_user_agent"`. This is the nginx default and what `infra/nginx/api.erp.gaiada.com.conf`
  writes (`webdesk_redacted` has the same fields, with the token and query redacted).
* Caddy JSON access log (`log { output file ... format json }`): one object per line with `ts`, `status`,
  `request.remote_ip`, `request.method`, `request.uri`, `request.headers["User-Agent"]`.

Anything else counts as "malformed" in the response and is skipped.

## Shipping recipe (not installed)

Run on the web host, from cron every 15 minutes to an hour. It remembers how far it has read, filters locally, and
posts chunks under the 900000-character limit. Re-sending a chunk is harmless: the ERP recognises an identical chunk
(by its SHA-256, per property) and changes nothing, so a failed run can simply be run again.

```bash
#!/usr/bin/env bash
# ship-ai-crawler-log.sh — sketch. Needs: ERP_URL, ERP_TENANT, PROPERTY_ID, ERP_TOKEN (bot user's bearer), LOG.
set -euo pipefail
STATE=/var/lib/ai-crawler-log/offset
mkdir -p "$(dirname "$STATE")"
last=$(cat "$STATE" 2>/dev/null || echo 0)
size=$(stat -c %s "$LOG")
[ "$size" -lt "$last" ] && last=0            # the log was rotated: start from the top of the new file
tail -c +"$((last + 1))" "$LOG" | head -c $((size - last)) \
  | grep -aiE 'GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Claude-User|PerplexityBot|Perplexity-User|GoogleOther|Google-CloudVertexBot|Applebot|Bytespider|CCBot|Amazonbot|meta-externalagent|meta-webindexer|DuckAssistBot|MistralAI-User|cohere-ai|Diffbot|YouBot' \
  | split -C 800000 --filter='jq -Rs "{log: .}" | curl -fsS -X POST -H "authorization: Bearer $ERP_TOKEN" -H "content-type: application/json" --data-binary @- "$ERP_URL/api/$ERP_TENANT/modules/search/properties/$PROPERTY_ID/ai-crawlers/ingest" >/dev/null' - || true
echo "$size" > "$STATE"
```

Notes on the sketch: `split -C` keeps each chunk on line boundaries; a chunk that fails to post would lose its
offset advance in a stricter script (write the offset only after every post succeeded, and keep the failed chunk to
retry: the duplicate check makes the retry safe). Do not put the token in the script; read it from the host's secret
store.

An ERP-side caller can skip HTTP: `aggregateAiCrawlerLog(chunk, { verifier })` is a pure function (no database, no
network) that returns the aggregate rows and counts, and `ingestAiCrawlerChunk(...)` in `ai-crawler-store.ts` stores
them.

## Who may call it

The route and the MCP tool `search.aiCrawlers.ingest` need `resource_search_property · update` on the property
(Cerbos, the existing kind), and the MCP tool is a MEDIUM-impact write: through the hub it asks for approval. A
shipping job should run as its own bot user (bots are `users` rows) with only that access, never as a person.

## Verifying the claims (optional)

A User-Agent can be forged. Where a vendor publishes the addresses its crawler uses, the ERP can mark a request that
claims the bot but comes from elsewhere as "unverified", and show it apart from the genuine ones.

1. Download the vendor's list (OpenAI: `gptbot.json`, `searchbot.json`, `chatgpt-user.json`; Perplexity:
   `perplexitybot.json`, `perplexity-user.json`; Google: the "special crawlers" and "user-triggered fetchers" lists;
   Apple, Common Crawl, DuckDuckGo publish theirs). Take the URLs from the vendor pages named in
   `ai-crawler-bots.ts`; they were not re-fetched when that file was written.
2. Turn each into CIDR strings and write one file, bot id to list:
   `{ "GPTBot": ["20.171.206.0/24", "..."], "OAI-SearchBot": ["..."] }`. For the JSON lists that look like
   `{"prefixes":[{"ipv4Prefix":"..."}]}`, `jq '[.prefixes[] | .ipv4Prefix // .ipv6Prefix]'` produces the list.
3. Point the server at it: `AI_CRAWLER_RANGES_FILE=/path/to/ranges.json` in platform-nest's environment (compose
   `environment:` entry, per the compose passthrough rule) and restart. The file is read on each ingest, so refreshing
   it needs no restart; refresh it monthly, since vendors change ranges.

A bot with no entry in the file stays "claimed". If the file is missing or broken, verification is off and a warning
is logged; ingest still works and every row is "claimed".

## Maintaining the bot list

`platform-nest/src/modules/search/ai-crawler-bots.ts` is the allow-list. Add a bot with its documented token and the
vendor page, add a sample line to `ai-crawler-log.test.ts`, and add the token to the `grep` in the shipping script.
Google-Extended and Applebot-Extended are robots.txt tokens only: the fetch is made by Googlebot and Applebot, so they
can never be seen in a log, and the panels cannot tell Google's AI use from its search crawling.

## Undo

Delete the cron entry and the state file. To drop the data: `DROP TABLE search_ai_crawler_chunks,
search_ai_crawler_daily;` (an owner's migration decision, not a runbook step).
