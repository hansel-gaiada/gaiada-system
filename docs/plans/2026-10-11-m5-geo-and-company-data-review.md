# M5 review: Umami, IP-geo and IP-to-company data sources

> **Status:** PLANNED (research only, no code). **Date:** 2026-10-11. **Tickets:** M5-G4, M5-V1.
> **Feeds:** WSK-D66 (Umami, stock, on `sumopod`), WSK-D67 (consent-first tracking plan),
> `legal/website-visitor-addendum.md` (R-V14), `docs/blueprints/vendor-exit-register.md` (rows added).
>
> **Source rule.** Every claim carries a source and its access date (all 2026-10-11). **[UNCONFIRMED]** marks
> anything read second-hand, inferred from code, or not found. This is not legal advice; the legal points go to counsel.

## 1. Umami

| Topic | Finding | Source |
|---|---|---|
| Licence | MIT | [github.com/umami-software/umami](https://github.com/umami-software/umami), 2026-10-11 |
| Current version | Major 3. Latest release v3.4.0 (published 17 Sep; the year was not shown on the page, read as 2026). Earlier: 3.3.1 (20 Aug), 3.3.0 (12 Aug, added 2FA), 3.2.0, 3.1.0 (added Boards, Session Replay, Web Vitals) | [releases](https://github.com/umami-software/umami/releases) |
| Image tags | `ghcr.io/umami-software/umami`: `latest`, `3`, `3.4`, `3.4.0` and `postgresql-latest` all pointed at the same build; `3.3.1`, `3.3`, `3.2.x`, `3.1.x` also listed. Only `postgresql-latest` was visible as a DB-specific tag; a `postgresql-v3` tag may exist but was not shown. The repo README also names `docker.umami.is/umami-software/umami:latest`. **Pin by version tag and digest, never `latest`.** | [package page](https://github.com/umami-software/umami/pkgs/container/umami), [repo](https://github.com/umami-software/umami) |
| Base image | `node:22-alpine`; no `HEALTHCHECK` in the Dockerfile (we add one in compose); Next.js telemetry is disabled in the image | [Dockerfile](https://raw.githubusercontent.com/umami-software/umami/master/Dockerfile) |
| Geolocation, mechanism | Reads a **GeoLite2-City.mmdb** with the `maxmind` npm package. Path `geo/GeoLite2-City.mmdb` under the working dir, overridable with `GEOLITE_DB_PATH` (seen in code, **not on the env-var docs page**). If the proxy sends a country header, Umami uses that instead, in order: Cloudflare (`cf-ipcountry`, `cf-region-code`, `cf-ipcity`), Vercel, CloudFront, EdgeOne; `SKIP_LOCATION_HEADERS` turns that off. Country comes from `country.iso_code`, then region, then English city name. A missing file is not handled gracefully in the code read. | [detect.ts](https://raw.githubusercontent.com/umami-software/umami/master/src/lib/detect.ts) |
| Geolocation, where the file comes from | The build script `build-geo.js` downloads **GeoLite2-City**: from `GEO_DATABASE_URL` if set; else from MaxMind with `MAXMIND_LICENSE_KEY`; **else from the GitHub repo `GitSquared/node-geolite2-redist`** (a third-party redistribution of MaxMind data, no key needed). `SKIP_BUILD_GEO` skips it. Which route Umami's own CI used for the published GHCR image is **[UNCONFIRMED]**. The env docs describe `GEO_DATABASE_URL` as "a MaxMind-compatible GeoIP database in MMDB format". | [build-geo.js](https://raw.githubusercontent.com/umami-software/umami/master/scripts/build-geo.js), [env vars](https://docs.umami.is/docs/environment-variables), [node-geolite2-redist](https://github.com/GitSquared/node-geolite2-redist) |
| What that obliges us to | If the stock image carries GeoLite2, the **GeoLite2 EULA applies to us** as the user, not to Umami: use the latest release and destroy older versions within 30 days of a new release (EULA 6.3); attribute MaxMind (3); no third-party disclosure without consent (6.1); no use to identify a household or individual (5); data terms in a DPA (7). A pre-baked file in an image we pull stays frozen unless we rebuild or mount a fresh one, so **the 30-day refresh duty is not met by default.** See section 2. | [GeoLite2 EULA](https://www.maxmind.com/en/geolite2/eula) |
| IP handling | The session id is `uuid(websiteId, ip, userAgent, sessionSalt, distinctId)`. The visit id uses an hourly salt, and a visit lasts 30 minutes. The raw IP is used in the hash and for the IP blocklist (`IGNORE_IP`); the code read passes no `ip` field to the session/event writes, but the SQL functions were not read, so **"IP never stored" is [UNCONFIRMED]**; the legal draft carries the same assumption (mini-LIA A). | [send/route.ts](https://raw.githubusercontent.com/umami-software/umami/master/src/app/api/send/route.ts) |
| Salt rotation | `SALT_ROTATION` = `day`, `week` or `month`; **default `month`**. The salt is derived only from the period start date through SHA-512, with **no secret**. Consequence: the id is a hash of low-entropy inputs; anyone holding the DB plus a candidate IP and user agent could test a guess. Set `SALT_ROTATION=day` and treat the session table as personal-adjacent data. | [crypto.ts](https://raw.githubusercontent.com/umami-software/umami/master/src/lib/crypto.ts), [env vars](https://docs.umami.is/docs/environment-variables) |
| Retention | **No retention setting.** Self-hosted data is "retained indefinitely unless you manually delete it". We need our own scheduled delete (14 months per the addendum, F5). Method to be chosen at build: SQL job on the Umami Postgres, or a deletion API [UNCONFIRMED which endpoint]. | [FAQ](https://docs.umami.is/docs/faq) |
| Tracker script and endpoint | `TRACKER_SCRIPT_NAME` renames `script.js`; `COLLECT_API_ENDPOINT` replaces `/api/send`; `BASE_PATH` (build time) hosts under a subpath; `CLIENT_IP_HEADER` names the proxy header to trust for the client IP. | [env vars](https://docs.umami.is/docs/environment-variables) |
| Telemetry, update check | `DISABLE_TELEMETRY` opts out of "completely anonymous telemetry"; `DISABLE_UPDATES` disables the new-version check. **Set both**, and deny egress from the container. | [env vars](https://docs.umami.is/docs/environment-variables) |
| Other useful switches | `DISABLE_BOT_CHECK` (the bot filter is ON by default, via `isbot` on the user agent; bots get `{beep:boop}` and nothing is written), `DISABLE_LOGIN`, `PRIVATE_MODE`, `CORS_MAX_AGE`, `TWO_FACTOR_ENCRYPTION_KEY`, `MCP_ENABLED` | [env vars](https://docs.umami.is/docs/environment-variables) |
| Read access for the ERP | Self-hosted API at `<instance>/api`. Two auth routes: **API keys** (profile, Settings, API keys; shown once; non-expiring; revocable; sent as `Authorization: Bearer`), or `POST /api/auth/login` returning a token (2FA adds a partial-token step). **Only an `admin` role (and `isAdmin`) appears in the docs read; a view-only role is [UNCONFIRMED].** So a truly read-only API account may not exist. | [auth docs](https://docs.umami.is/docs/api/authentication) |
| Security advisories | **GHSA-3xx8-742v-m4mq, High, published 2026-06-30:** a cache token from the public tracking endpoint can be reused as a share token, giving unauthenticated read of a site's analytics (sessions, events, exports) to anyone who knows the public `data-website-id`; affected "current (>= 2.3.1, latest)", **patched: none, no CVE** as fetched. Older: GHSA-8www-cffh-4q98 (Critical, 2023; a share link could reset data; fixed in 2.3.1). Aggregators list CVE-2026-4317 (authenticated SQL injection, 8.8) with no official advisory found: **[UNCONFIRMED]**. Release notes mention IDOR fixes in 3.1.0 and 2FA hardening in 3.3.1 and 3.4.0. | [advisories page](https://github.com/umami-software/umami/security/advisories), [GHSA-3xx8](https://github.com/umami-software/umami/security/advisories/GHSA-3xx8-742v-m4mq), [OSV](https://osv.dev/vulnerability/GHSA-8www-cffh-4q98) |

### What this means for WSK-D66

1. **GHSA-3xx8 is the headline risk.** Its precondition is the public website id, which is in every page by design. The ruling's "collector-only public" posture is exactly the mitigation: the reverse proxy exposes only the tracker script and the collect endpoint, not `/api/*` reads, the dashboard or share routes. Re-check the advisory for a patched version before deploy; until then the ERP reader and any dashboard stay on the WireGuard mesh.
2. **Verify, do not assume**, before launch: the IP is not stored (inspect the session table after a test hit), and whether a read-only credential exists. If not, the surer read-only path is a read-only Postgres role on the Umami database, which fits WSK-D66's "ERP reads read-only".
3. **Retention is ours to build**, and salt rotation should be `day`.

## 2. IP-geo datasets

| | DB-IP Lite | MaxMind GeoLite2 |
|---|---|---|
| Editions | IP to Country Lite, IP to City Lite, IP to ASN Lite (all listed Oct 2026) | Country, City, ASN |
| Format | MMDB and CSV | MMDB and CSV |
| Licence | **CC BY 4.0**; use allowed with attribution | **GeoLite2 EULA** plus CC BY-SA 4.0 for copyrightable elements; "own internal business purposes" |
| Account / key | None | Free account plus licence key for official download |
| Update cadence | Monthly (commercial: daily) | Not stated on the pages read [UNCONFIRMED]; the EULA forces use of the latest within 30 days |
| Mandatory obligations | Attribution link only | Refresh within 30 days of each release and destroy old copies; written confirmation of destruction on request; attribution; no third-party disclosure without consent; security and incident reporting; 30 downloads per day |
| Attribution text | "Web applications must link back" on pages that display or use results; suggested `<a href='https://db-ip.com'>IP Geolocation by DB-IP</a>` | Attribution to MaxMind required; exact wording not retrieved [UNCONFIRMED] |
| Accuracy | Subset of the commercial data, "reduced coverage and accuracy" | City edition "considerably less accurate" than paid and "not recommended for commercial use cases"; accuracy radius a few km to 1,000 km |
| Commercial use | Allowed with attribution | Allowed for internal business purposes; MaxMind may stop offering the free data (EULA 9); GDPR terms point to a DPA we did not see |

Sources: [DB-IP Lite](https://db-ip.com/db/lite.php), [GeoLite2 EULA](https://www.maxmind.com/en/geolite2/eula), [MaxMind GeoLite2 docs](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/), all 2026-10-11. Record counts were not stated on either page.

**Practical difference.** DB-IP Lite has no account, no key, no destruction duty, and needs an attribution link only. GeoLite2 needs an account and key, an automated refresh job (`geoipupdate`) and a deletion routine to stay inside the EULA, and its "internal use" clause sits awkwardly with the SaaS-later rule (offering this to client sites). Both are free and both are weak at city level; neither identifies an individual, and both say so.

**Attribution for DB-IP.** The link is required "on pages that display or use results". Results go into Umami and the ERP admin, not to the public. Whether admin-only display needs a public link is a question for counsel; the safe form is a line on the public privacy notice ("IP geolocation by DB-IP") [UNCONFIRMED whether needed].

**Does Umami accept DB-IP?** It reads any MaxMind-format MMDB at `geo/GeoLite2-City.mmdb` (or `GEOLITE_DB_PATH`) and uses `country.iso_code`, the first subdivision and the English city name. DB-IP's MMDB is built to be MaxMind-compatible, so it should drop in, but this is **not tested**; check the City file's field names in the A3 build.

## 3. IP-to-company

An ASN organisation name says who owns the **network** (an ISP, a hosting company, a university), not who sits on it. Company identification works only for visitors on a corporate IP range, and hit rates are modest: one practitioner estimate is about 15% for mobile-heavy sites, one vendor guide says 35 to 50% for mid-market B2B ([abmatic.ai, vendor blog, 2026-10-11](https://abmatic.ai/blog/reverse-ip-lookup-guide-2026); both are from parties with a stake, treat as rough). Residential ISP, mobile carrier and VPN traffic resolve to the carrier, not an employer.

| Option | Form | Cost band | Residency, GDPR posture | Storing results | New processor? |
|---|---|---|---|---|---|
| **IPinfo IP-to-Company** | Custom database download (about 32M entries, 24-hour refresh) or an enterprise-only Custom API. Company data is not in the Lite, Core or Max self-serve plans. | Quote only; the pricing page lists database downloads "starting at $1,000/month" ([pricing](https://ipinfo.io/pricing), [product](https://ipinfo.io/products/ip-company-database), [company API](https://ipinfo.io/developers/company-api)) | As a local file there is no per-visit transfer; the vendor's DPA and licence terms **[UNCONFIRMED]** | Licence terms on caching or derived storage not read **[UNCONFIRMED]** | **No** if the file option is used (local dataset, but a data supplier under contract) |
| **Snitcher** | SaaS and REST API (included in all plans); the Custom tier adds IP-to-company lookups | From USD 49/mo, priced by unique companies identified (0-50 at $49 up to 4,001-5,000 at $529); 14-day trial; unlimited seats ([pricing](https://www.snitcher.com/pricing)) | Claims GDPR compliance on legitimate interest (Art. 6(1)(f)); **hosting region not stated** on the page; ISO 27001 "in progress" | Via CRM sync and API, so storing is the point; retention terms **[UNCONFIRMED]** | **Yes** (visitor IPs reach the vendor) |
| **Dealfront / Leadfeeder** | SaaS with its own tracker script | A competitor blog puts SMB plans at about $100-500/mo (unverified; their pricing page redirected to leadfeeder.com and was not read) | Not checked; EU hosting is plausible but **[UNCONFIRMED]** | Not checked | **Yes**, and it adds its own script (conflicts with the consent-first, cookieless F5 design) |
| **Clearbit (now HubSpot Breeze Intelligence)** | Clearbit's standalone free tools were discontinued on 30 Apr 2025 and the Logo API sunset on 1 Dec 2025 (official [changelog](https://clearbit.com/changelog/2025-02-13)); the successor lives inside HubSpot (secondary sources) | About $0.45 per credit plus a paid HubSpot seat (single secondary source) | Not checked | Not checked | **Yes**; not workable without HubSpot |
| Others (RB2B, 6sense, ZoomInfo, ipgeolocation.io company DB, Apify "IP to Company" actors) | Seen in search results only; **not evaluated** | n/a | n/a | n/a | API: yes; dataset: local |

**GDPR position (not legal advice).** The common view in the vendor literature is that company-level resolution is firmographic and not personal data, while individual-level identification needs a legitimate-interest assessment, notice and opt-out handling ([abmatic.ai, 2026-10-11](https://abmatic.ai/blog/reverse-ip-lookup-guide-2026); a vendor source, so counsel must decide). The project's own draft already says company identification shown against a profile needs consent (F7, R-V1), and a sole trader's or home-office IP can be a person, so a "company" result is never certain to be non-personal.

## 4. Recommendation per phase

**A3, now: use Umami's own geo, but fix the sourcing.**
- Use Umami's country/city lookup (no collector yet, nothing new to build). Because the stock image may carry a GeoLite2 copy we cannot refresh, either (a) mount a **DB-IP Lite City MMDB** at the geo path (preferred: no EULA clock), or (b) accept GeoLite2 and run `geoipupdate` with our own licence key under the 30-day rule. Pick (a) unless testing shows a field mismatch.
- If Umami sits behind Cloudflare, the `cf-ipcountry` family of headers is used first and no database is read for country. That adds a Cloudflare dependency on the collector path, so decide it deliberately.
- Set `DISABLE_TELEMETRY`, `DISABLE_UPDATES`, `SALT_ROTATION=day`, rename the script and endpoint, and give the ERP a read-only Postgres role.
- Trade-off: city data is coarse; country is reliable enough for counts. No company data in A3, and none is needed.

**V2, later (enrichment collector): one local dataset for geo and network, bot flag from user agent and ASN, company as a separate opt-in decision.**
- Geo and ASN: **DB-IP Lite** (Country, City and ASN editions), loaded as a local file in the collector, refreshed monthly by a job, attribution on the privacy notice. This keeps F6 a local lookup with no call out, as the legal draft assumes. Trade-off: monthly updates and Lite accuracy; the paid DB-IP tier is the named upgrade (no attribution, daily updates, same format).
- Bot flag: user-agent list plus ASN (hosting providers, known scrapers) from the same ASN file; no vendor needed.
- Company: **do not decide yet.** If the owner wants it, the least-bad shape is the **IPinfo IP-to-Company database as a local file** (no visitor IP leaves us, which suits R-V14), at a quote that starts around USD 1,000 a month (list figure for downloads; **[UNCONFIRMED]** for the company file specifically). The cheaper path, Snitcher from USD 49/mo, **creates a new processor that receives visitor IPs**, needs a DPA, a notice change and a DPIA line, and its hosting region is unknown. Either way: only for visitors with analytics consent, results stored as derived attributes (company name, domain), never the IP, and under the profile retention.
- A zero-cost fallback exists: show the **network name only** (ASN organisation from DB-IP ASN) and label it as the network, never as a company. Honest, and enough for filtering "this visit came from a university, ISP or hosting range".

## 5. Open questions for the owner / counsel

1. Does an admin-only display of DB-IP results need a public attribution link, or is a privacy-notice line enough?
2. Is a company-identification vendor wanted at all, at the quoted order of cost, given its modest hit rate?
3. May a vendor be a processor of visitor IPs (Snitcher-type), or is a local file the only acceptable form?
4. Confirm on the build: no raw IP in the Umami DB; the read-only access path; a patched version for GHSA-3xx8-742v-m4mq.

## 6. Not verified in this review

DB-IP and MaxMind record counts; MaxMind attribution wording and release cadence; Umami's CI geo source and the exact retention/delete endpoints; any Umami view-only role; IPinfo company-file terms on storage; Dealfront and RB2B pricing and residency; whether CVE-2026-4317 is real. None was needed to choose a direction; all are needed before a build.
