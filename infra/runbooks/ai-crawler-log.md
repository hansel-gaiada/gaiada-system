# AI-crawler log: the ERP pulls each site's access log (M5-P5b, M5-P5b2)

STATUS: PROTOTYPED. The code and the unit files are in the repository and tested against stubs. Nothing here has been
installed on any server, no key exists, no host key is pinned and no site is listed. Whoever installs it does so on a
host the owner names, one step at a time. It is not DEV-VERIFIED until a run has stored rows from a real log.

## What it does

The ERP keeps a daily count of requests from known AI crawlers (GPTBot, ClaudeBot, PerplexityBot, ...) per search
property: bot, URL path (no query string), HTTP status, and whether the request really came from the vendor's
addresses. The Website workspace shows it under Analytics, "AI visibility". It is built from the web server's own
access log, because AI crawlers do not run JavaScript and so never appear in Umami.

## Design: PULL over SSH (owner decision 2026-10-31)

Every 15 minutes a systemd timer on the ERP host runs `infra/scripts/ai-crawler-pull.sh` as root. For each site listed
in `sources.json` it makes one SSH call per log file, reads only the lines added since last time, and hands them to
`node dist/seed/ai-crawler-ingest.js` inside the platform container.

| Where | What runs |
|---|---|
| ERP host | the timer, `ai-crawler-pull.sh`, the job's private key, `sources.json`, the pinned `known_hosts`, the offsets |
| Web host | nothing of ours. A read-only SSH login for the job's key, and the site's access log |
| Platform container | `dist/seed/ai-crawler-ingest.js` (parses, stores, writes the `ai_crawler_ingest` activity with actor null) |

### Rejected: the push sketch

An earlier version of this runbook had a script on the web host posting chunks to the ERP's HTTP route. That is
rejected: the route needs a token, and the only non-personal credential the ERP accepts is the master service token,
which must never sit on a web host. The HTTP route and the MCP tool still exist for a person or an approved agent; the
job does not use them.

## What leaves the web host, and what is kept

An access log line holds a visitor IP and a browser string (`legal/website-visitor-addendum.md`). Those never leave the
web host except for an AI crawler's own line, and are never stored:

1. The SSH call runs `grep -aiE '<pattern>'` ON the web host, so only lines whose User-Agent names an AI crawler cross
   the network. The pattern is every UA token of `ai-crawler-bots.ts`, fetched once per run from the platform
   container (`node dist/seed/ai-crawler-ingest.js --grep-pattern`), so the filter and the parser cannot drift apart.
   A human's line never reaches the network.
2. The ERP parser (`platform-nest/src/modules/search/ai-crawler-log.ts`) drops anything not on its allow-list anyway.
3. Stored per row: UTC day, bot id, path without query string, status, verification flag, count. The raw line, the IP
   and the User-Agent string are never stored, returned or logged. The IP of an AI crawler is used in memory only, to
   check it against the vendor's published ranges, and only when verification is on (see below; it is off for now).
4. The ingest script prints one JSON line of counts (`chunks`, `new`, `duplicate`, `rows`, `stats`) and never a log
   line. The pull script logs one line per failed source: name, path, reason.

## Log formats understood

* nginx / Apache "combined": `$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent
  "$http_referer" "$http_user_agent"`. This is the nginx default and what `infra/nginx/api.erp.gaiada.com.conf`
  writes (`webdesk_redacted` has the same fields, with the token and query redacted).
* Caddy JSON access log (`log { output file ... format json }`): one object per line with `ts`, `status`,
  `request.remote_ip`, `request.method`, `request.uri`, `request.headers["User-Agent"]`.

Anything else counts as "malformed" in the ingest's stats and is skipped.

## sources.json

`/etc/gaiada/ai-crawler/sources.json` (override: `AI_CRAWLER_SOURCES`), a JSON array. Placeholder values:

```json
[
  {
    "name": "example-site-production",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "propertyId": "00000000-0000-0000-0000-000000000000",
    "host": "web1.example.test",
    "port": 22,
    "user": "crawler",
    "proxyJump": "jump@bastion.example.test",
    "logs": ["/var/log/nginx/access.log", "/var/log/nginx/example.access.log"],
    "enabled": true
  }
]
```

* `name`: letters, digits, `.`, `_`, `-`. It names the state directory, so use one name per site and environment
  (production and staging are separate entries, each with its own `propertyId`).
* `tenantId` and `propertyId`: the company and its search property (Website workspace, the property's id).
* `host`, `port`, `user`: the SSH target. `proxyJump` is optional (an ssh `-J` value). Values that are not plain names
  are refused before any ssh call.
* `logs`: absolute paths, one SSH call each. A file that is missing is reported and skipped, not a failure.
* `enabled`: only `true` is on. An empty array, or every entry `false`, makes the run exit 0 and do nothing.

## Pinning a host key

The job never accepts a host key on its own (`StrictHostKeyChecking=yes`, `BatchMode=yes`). An unpinned host fails its
source with "Host key verification failed" in the journal. To pin one, on the ERP host:

1. Get the fingerprint from the provider's panel (the host's SSH or console page), before touching the host.
2. `ssh-keyscan -t ed25519 -p <port> <host> > /tmp/hostkey.pub`, then `ssh-keygen -lf /tmp/hostkey.pub`, and compare
   the SHA256 fingerprint with the panel's, character by character. If they differ, stop: do not pin.
3. Only after they match: `cat /tmp/hostkey.pub >> /etc/gaiada/ai-crawler/known_hosts`, then remove the temp file.
   A host reached through a different port is pinned as `[host]:port`, which `ssh-keyscan -p` already writes.
4. With a `proxyJump`, pin the jump host the same way. [UNVERIFIED] Whether the jump hop honours the same
   known_hosts file and strict setting on the host's ssh version: test it by running once with the jump host unpinned
   and confirm that the source fails, before trusting it.

## Adding a source (the owner's step per host)

1. On the ERP host, the job's key exists once: `ssh-keygen -t ed25519 -N '' -C gaiada-erp-ai-crawler-pull -f
   /etc/gaiada/ai-crawler/id_ed25519`, directory mode 700, key mode 600, owner root. Print the public key
   (`cat /etc/gaiada/ai-crawler/id_ed25519.pub`).
2. **The owner, per web host:** add that public key, with the comment `gaiada-erp-ai-crawler-pull`, in the host's
   SSH-access panel at the provider. The login should be an unprivileged user that can read the access logs and
   nothing else (for example a member of the group that owns `/var/log/nginx`). Never a root login, never a shell with
   write access to the site.
3. Pin the host key (above).
4. Add the entry to `sources.json` with `"enabled": true`.
5. Run it once by hand and read the result (below). A first run reads each log from the start: expect a large first
   ingest, in chunks under 900000 characters; a re-run is harmless (an identical chunk is recognised and ignored).

## Install the timer

Not done by the repository. On the ERP host, as root, once the owner says go:

```bash
install -d -m 700 /etc/gaiada/ai-crawler /var/lib/gaiada/ai-crawler
install -m 755 infra/scripts/ai-crawler-pull.sh /usr/local/sbin/ai-crawler-pull.sh
install -m 644 infra/systemd/ai-crawler-pull.service infra/systemd/ai-crawler-pull.timer /etc/systemd/system/
# the key, sources.json and known_hosts as above; `jq` and `flock` must be installed
systemctl daemon-reload
systemctl start ai-crawler-pull.service        # one run by hand; read the journal before enabling the timer
systemctl enable --now ai-crawler-pull.timer
```

Settings come from the environment (`AI_CRAWLER_*`; the header of the script lists them). The platform container name
defaults to `gaiada-platform-1`; override with `AI_CRAWLER_CONTAINER` in a unit drop-in if it differs.

## Reading the result

* `journalctl -u ai-crawler-pull.service -n 50`. A clean run prints nothing and ends "Succeeded". A failed source is one
  line: `FAIL source=<name> log=<path> reason=<why>`; `SKIP` means the log file was missing. The service ends failed if
  any source failed; the other sources still ran.
* `systemctl list-timers ai-crawler-pull.timer` shows the next run.
* Per run with new data, an `ai_crawler_ingest` activity (actor null) on the property carries the summed counts.
* The panels: Website workspace, Analytics, AI visibility.
* The offsets are `/var/lib/gaiada/ai-crawler/<name>/<sha256 of the log path>.state`, one line `inode size`. A source
  that failed did not move its offset, so the next run retries the same lines. Deleting a state file re-reads that log
  from the start (safe: duplicates are ignored). If the log was rotated or truncated (a new inode, or a smaller size),
  the job reads the new file from the start.
* Known limit: the offset is the file size at the moment the host answered. A line being written at that instant can be
  split across two runs, and the half that arrives first is counted as malformed. At most one request per run is lost
  this way.

## Verifying the claims (optional)

A User-Agent can be forged. Where a vendor publishes the addresses its crawler uses, the ERP can mark a request that
claims the bot but comes from elsewhere as "unverified", and show it apart from the genuine ones. **Off for now** (owner
decision 2026-10-31): every row is "claimed". The ingest script already calls `verifierFromEnv()`, so it switches on
when the platform container has `AI_CRAWLER_RANGES_FILE` set, with no change to the job.

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
goes to the ingest's stderr; ingest still works and every row is "claimed".

## Maintaining the bot list

`platform-nest/src/modules/search/ai-crawler-bots.ts` is the allow-list. Add a bot with its documented token and the
vendor page, and add a sample line to `ai-crawler-log.test.ts`. The pull job's `grep` pattern is generated from that
file, so there is nothing else to edit. Google-Extended and Applebot-Extended are robots.txt tokens only: the fetch is
made by Googlebot and Applebot, so they can never be seen in a log, and the panels cannot tell Google's AI use from its
search crawling.

## Who may call the HTTP route

The route and the MCP tool `search.aiCrawlers.ingest` need `resource_search_property · update` on the property (Cerbos,
the existing kind), and the MCP tool is a MEDIUM-impact write: through the hub it asks for approval. The pull job does
not use them: it writes through the platform container, as the operator scripts do.

## Undo

```bash
systemctl disable --now ai-crawler-pull.timer
rm /etc/systemd/system/ai-crawler-pull.{service,timer} /usr/local/sbin/ai-crawler-pull.sh && systemctl daemon-reload
```

Then remove the job's public key (comment `gaiada-erp-ai-crawler-pull`) from each web host's SSH-access panel (the
owner), and delete `/etc/gaiada/ai-crawler/` and `/var/lib/gaiada/ai-crawler/`. To drop the data: `DROP TABLE
search_ai_crawler_chunks, search_ai_crawler_daily;` (an owner's migration decision, not a runbook step).
