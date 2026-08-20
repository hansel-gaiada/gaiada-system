# Wave 1 security triage — client-site findings, out of the SEO queue

**Date:** 2026-08-20 · **Status:** PLANNED (triage only — nothing remediated, nothing built)
**Source:** `docs/plans/2026-08-13-gaia-nexus-harvest.md` §12 (the only place these findings are
recorded in this repo) · cross-referenced against `platform-nest/src/modules/{monitoring,webdev,it}`
and `docs/blueprints/monitoring-program.md`.
**Scope of this document:** triage and a remediation runbook. **No client site was contacted, scanned,
logged into, or probed to produce this document** — every claim below traces to the harvest doc or to
this repo's source, not to a live check against `erp.gaiada.online` or any client domain.

---

## 0. Headline

The single most important finding of this triage is not a severity ranking — it is that **the shared-
WordPress-auth-salt claim cannot be verified from anything in this repository.** The primary evidence
(the 126 Nexus audit/SEO documents) is not checked into `gaiada-system`; it exists only in the separate
`gaia-nexus` repo, and the box that ran the live audit tooling (`gda-s01`) was retired on 2026-08-13
(harvest doc §11). What follows is triage on a two-generations-removed claim, and §1.3 is the load-
bearing section: read it before acting on §2's ranking.

---

## 1. The real inventory

### 1.1 What the source document actually says

`docs/plans/2026-08-13-gaia-nexus-harvest.md` §12 lists four findings from Nexus's "Wave 1" (of a
4-wave programme: diagnose → technical → SEO → GBP/Ads) across the ~63-property portfolio, plus three
more the same table folds in as the same class of problem:

| Finding | Harvest doc §12 phrasing | Per-site detail available here |
|---|---|---|
| Missing HSTS | "HSTS missing portfolio-wide" | **None.** No list of which of the 63 sites, no header-value evidence. |
| Shared WP auth salts | "Shared WordPress auth keys/salts across installs" | **None.** No list of which sites share which salt, no comparison method stated. |
| Default `wp_` table prefix | "Default `wp_` table prefix" | **None.** No count of how many of 63 use `wp_` vs a custom prefix. |
| Exposed debug flags | "`WP_DEBUG` / debug flags exposed" | **None.** No list of which sites, no confirmation debug output is *reachable* (vs. merely configured) — the harvest doc itself later distinguishes "configured" from "reachable" as a check design note (§12: "debug output reachable"), which implies the underlying finding may only ever have been the former. |

Two more items in that same §12 table are **not** part of this triage per the user's scope (dual-plugin
cleanup, WP/PHP version currency) but sit in the same evidence gap — flagging for completeness, not
action.

### 1.2 Portfolio size and staleness

- **~63 properties** is itself a harvest-doc-reported figure (§0.4, §4 H4), sourced from Nexus's own
  `sites` table and the 63 technical + 63 SEO markdown documents in `docs/audits/`/`docs/seo/` of the
  Nexus repo. It has not been reconciled against `search_properties` in this platform — that table
  exists (`platform-nest/migrations/0034_module_search.sql:44`) but whether it holds 63, more, or fewer
  *verified* rows today is unchecked by this document.
- **The findings describe June 2026, at the latest.** The harvest doc is dated 2026-08-13 and was
  itself already describing historic audit output; today is 2026-08-20. That is a **minimum** two-and-
  a-half-month gap between "finding recorded" and "finding read for this triage," and the actual audit
  pass could be older still — nothing in the harvest doc timestamps the Wave 1 audits themselves.
- **A site may have been fixed, sold, migrated, or dropped since.** No re-check has occurred. Both
  "still vulnerable" and "already remediated by someone else" are live possibilities per site.
- **The underlying live data is very likely gone.** Harvest doc §11: `gda-s01` (the box hosting Nexus's
  Postgres) was retired 2026-08-13. The only surviving DB artifact is a 2026-06-11 backup with **20
  rows**, **zero security-relevant columns**, and *known-fabricated* metrics in the columns it does
  have (`traffic_7d`, `roas` — the harvest doc calls this out explicitly as invented seed data, not
  something to import as fact). That backup is a schema/rows example, not evidence for or against any
  Wave 1 finding.

### 1.3 Confidence level — stated plainly

| Question | Confidence | Why |
|---|---|---|
| "Does a Wave 1 audit programme exist and produce findings in these four classes?" | **High.** | Directly stated, twice, in a document already reviewed and owner-ratified (harvest doc §6, §12). |
| "Is HSTS actually missing on some subset of the 63 sites?" | **Medium.** | Plausible and common (HSTS is opt-in, frequently skipped on WordPress+shared-hosting stacks) but zero per-site evidence exists in this repo. |
| "Is `wp_` the default table prefix on some subset?" | **Medium-high.** | `wp_` is WordPress's out-of-the-box default; *not* changing it is the base rate, not the exception, for agency-built sites using standard installers. Highly plausible as a portfolio-wide pattern even with zero per-site data, precisely because it requires an installer to deviate from a default to *not* have this finding. |
| "Are debug flags exposed (reachable, not just configured)?" | **Low-medium.** | The harvest doc's own phrasing in §12 col. 3 ("debug output reachable") reads as a design note for a *future* check, not confirmation of a *past* finding — it is possible the original Wave 1 finding was "`WP_DEBUG` is set to `true`" (a config fact, cheap to detect) and no one ever confirmed the output was network-reachable (a materially different, worse fact). Cannot distinguish from documents alone. |
| **"Do multiple client sites genuinely share the same WordPress auth salts?"** | **Cannot determine.** | See §1.4. This is the one where "confident but wrong" would be the worst possible failure mode, because the consequence (§2) is categorically different from the other three. |

### 1.4 The shared-salt question — real finding or artifact of how the audit was written?

**Verdict: cannot determine from the documents available; leaning toward "artifact of provisioning
practice, plausible but unconfirmed" rather than "audit-tooling artifact," with the actual truth
gated entirely on documents this repo does not contain.**

Reasoning:

- **What would make it real:** WordPress generates unique `AUTH_KEY`/`SECURE_AUTH_KEY`/`LOGGED_IN_KEY`/
  `NONCE_KEY` (+ `_SALT` counterparts) per install, normally by calling the WordPress.org secret-key
  API at setup time. The only realistic way for *multiple, independently-hosted* installs to end up
  with **identical** values is if a provisioning process cloned a `wp-config.php` **template that
  already contained hardcoded salt values** and never re-ran the generator per site — e.g. a "golden
  image" / boilerplate theme-and-plugin starter kit reused by the same agency across client builds.
  This is a known, common real-world anti-pattern in agency WordPress shops, and the harvest doc's own
  §4 H5 records that GDA's properties map onto a small number of hosting stacks (`gda-ce01`,
  `hostinger-wp`, `gda-pn01`) — i.e., a small number of provisioning pipelines serving many sites is
  exactly the topology that produces this bug. **This is circumstantial support for "plausible," not
  confirmation.**
- **What would make it an artifact:** an audit tool that flags "uses the *example* salt values still
  present in the default `wp-config-sample.php` distributed with WordPress core" would produce a
  finding that reads as "shared across installs" purely because many sites independently failed to
  edit the sample file — that is **not** the same vulnerability as "these two specific live sites carry
  the identical secret today," even though a lazily-written audit summary could conflate the two. A
  cross-site *comparison* (hashing/diffing actual salt values pairwise across 63 sites) is a
  meaningfully more expensive check than a per-site *presence* check, and nothing in the harvest doc
  states the audit tooling actually did the pairwise comparison rather than a per-site default-value
  match.
- **What I could not check:** the only artifact that would resolve this — the actual Wave 1 technical
  audit markdown for the affected sites, or the raw salt values themselves — lives in `docs/audits/`
  of the `gaia-nexus` repo, which is **not present in `gaiada-system`** and was not fetched for this
  triage (out of scope: this task is analysis from documents in hand, and that repo was only ever a
  shallow clone on whatever machine produced the 2026-08-13 harvest doc). I did not attempt to reach
  any live site to test this, per the hard constraint on this task.

**Action implied, not taken:** before §4's owner decision is exercised, someone with access to the
`gaia-nexus` git history must pull the actual audit documents for the sites named in the shared-salt
finding and confirm (a) which specific sites, (b) whether the comparison was pairwise-actual-value or
default-value-match, and (c) whether any of those sites still resolve to the hosting/IP they had in
June. That is a **read-only documents-and-DNS check**, not a live probe of the client site's application
layer, and does not require owner authorization to perform — only authorization is needed for what
happens *after* it confirms real cross-site reuse (§4).

---

## 2. Severity ranking — by attacker capability, not generic CVSS

Ranked by **what an attacker can actually do**, conditioned on §1.4's unresolved status.

### 2.1 If the shared-salt finding is confirmed real (pairwise-identical values, live sites)

| Rank | Finding | Attacker capability | Why it outranks the rest |
|---|---|---|---|
| **1** | **Shared WP auth salts** | Forge a valid authentication/logged-in cookie for **Site B** using material obtained from (or a session captured on) **Site A** — no credential theft, no exploit chain, just cookie construction, because WordPress's auth cookie is `HMAC(user_login, expiration, salt)` and the salt is the only site-specific secret in that construction. | **This is the only finding in the set that crosses the client boundary.** The other three degrade a single site's security posture; this one turns a foothold on the *weakest* client's site into a session-forging primitive against *every other* client sharing the salt set. It converts "63 independent risk profiles" into "one shared blast radius," which is the opposite of what a multi-tenant hosting arrangement is supposed to guarantee each client. |
| 2 | Exposed debug flags (if output is actually reachable) | Information disclosure: file paths, DB errors, occasionally credentials or stack traces in a fatal-error page. Can be a stepping stone to RCE if a disclosed path/version enables a targeted exploit. | Single-site impact, but a genuine foothold-generator. Ranked second because it can be the thing that *gets* an attacker onto Site A in the first place — feeding rank 1. |
| 3 | Default `wp_` table prefix | Marginal — makes generic SQLi payloads and automated exploit kits slightly more effective (no need to enumerate the prefix), but table-prefix obscurity was never a real control; it fails the moment an attacker has any other foothold. | Single-site, and even then a minor multiplier on an already-required other vulnerability. |
| 4 | Missing HSTS | Enables SSL-stripping / downgrade attacks **only** for a user on a hostile network path (public wifi, malicious router, compromised upstream) during their *first* connection to that host, and only if the site is otherwise reachable over plain HTTP. | Real, but conditional on a specific network-position attacker and a narrow window; does not scale portfolio-wide the way rank 1 does, and most modern browsers' HSTS-preload-list and default HTTPS-upgrade behavior narrow the window further. |

### 2.2 If the shared-salt finding is an artifact (default-value match, not pairwise reuse)

The ranking compresses: debug-flag exposure becomes the top item (still single-site RCE-adjacent), the
"shared salts" finding becomes **equivalent in severity to any single site using the WordPress-shipped
example salts** (still worth fixing — an unedited sample salt is a known/guessable secret, which is bad,
just not *cross-client* bad) — rank it with wp_-prefix as a hardening item, not an incident.

### 2.3 The ranking that matters operationally

Because §1.4 could not be resolved, **treat the shared-salt finding as Rank 1 until the read-only
document check (§1.4 "Action implied") proves otherwise.** Downgrading it on the optimistic assumption
and being wrong is a cross-client breach; upgrading a merely-default-salt finding and being wrong costs
a few hours of unnecessary-but-harmless salt rotation. The asymmetry says treat it as real pending
disconfirmation.

---

## 3. Remediation runbook — per finding class

**Every action below is a WordPress-hosting-layer change on a third-party production site. None of it
is executed by this document; each is written so a person with access and owner authorization could
execute it without re-deriving the steps.**

### 3.1 Shared/default WordPress auth salts

- **Exact change:** for each affected site, replace the eight `define('AUTH_KEY', …)` /
  `SECURE_AUTH_KEY` / `LOGGED_IN_KEY` / `NONCE_KEY` / `*_SALT` lines in `wp-config.php` with freshly
  generated values from the WordPress.org secret-key API (`https://api.wordpress.org/secret-key/1.1/salt/`)
  or `wp config shuffle-salts` if WP-CLI is available on the host.
- **Blast radius:** **single site per edit** — salts are a per-`wp-config.php` secret; rotating Site
  A's salts has **zero effect** on Site B even if they previously shared a value. This is exactly why
  the fix is safe to sequence one site at a time rather than needing a synchronized cutover.
- **Logs everyone out:** **yes, always, on that site.** Every existing auth cookie and logged-in
  session on that site becomes invalid the instant the new salts are deployed — by design, this is the
  fix. All users (admins, editors, and if using a membership/e-commerce plugin, customers with
  persistent logins) will be forced to re-authenticate.
- **Maintenance window:** not strictly required (WordPress serves pages to anonymous visitors
  unaffected), but **should be scheduled and communicated to the client** because every logged-in
  editor loses their session mid-edit, and any "remember me" e-commerce customer sessions drop.
  Recommend low-traffic-hour execution per site, not a portfolio-wide simultaneous rotation (see order
  of operations below).
- **Rollback:** keep the pre-rotation `wp-config.php` (or just the eight salt lines) in the change
  record. Reverting reinstates the *old* salts, which un-invalidates any cookies forged against them —
  **rollback should only ever be used to fix a deploy mistake (e.g., syntax error breaking the site),
  never to "undo" the security fix**, because reverting re-opens the exact hole being closed.
- **Order of operations if cross-site sharing is confirmed:** rotate **all** affected sites within the
  same maintenance window/day, not staggered over weeks — a staggered rotation leaves the not-yet-
  rotated sites forgeable using material obtained from an already-rotated site's *pre-rotation* leak
  window, if that leak already happened. If a leak is suspected (not just a shared-secret finding), this
  becomes an incident-response timeline question, not a routine-maintenance one — see §4.

### 3.2 Default `wp_` table prefix

- **Exact change:** rename all `wp_*` tables to a site-specific prefix and update
  `$table_prefix` in `wp-config.php` to match — typically done via a plugin (e.g. a table-prefix-
  changer) or manually: `RENAME TABLE wp_options TO <newprefix>_options; …` for every table, then fix
  serialized references inside `wp_options` (`siteurl`, cron, etc.) and any hardcoded prefix in
  third-party plugin tables.
- **Blast radius:** single site. No cross-site effect.
- **Logs everyone out:** no — this does not touch auth cookies or sessions, only table names.
- **Maintenance window:** **required.** The site is non-functional between the rename and the
  `wp-config.php` update; do this as an atomic scripted operation (transaction where the DB engine
  allows, or a documented brief-downtime window), never as a manual multi-hour table-by-table edit on
  a live site.
- **Rollback:** full DB backup **before** the rename is mandatory; rollback = restore that backup. A
  partial rename (some tables renamed, `wp-config.php` not yet updated, or vice versa) is a broken
  site, not a security state — treat any partial-completion as an incident requiring immediate
  rollback, not a "finish it later."
- **Note:** this is the lowest-value fix in the set (§2.1) — worth doing during other maintenance
  windows on the same site, not worth a dedicated emergency window on its own.

### 3.3 Exposed debug flags (`WP_DEBUG` and friends)

- **Exact change:** set `define('WP_DEBUG', false);` (and `WP_DEBUG_DISPLAY`, `WP_DEBUG_LOG` as
  appropriate for the site's actual logging needs) in `wp-config.php`; verify no `.php` file elsewhere
  overrides it later in the include order.
- **Blast radius:** single site. If debug output was being logged to a *publicly readable* path (a
  known WordPress footgun — `wp-content/debug.log` is web-accessible by default on many stock configs),
  that file itself must be deleted or moved outside the web root, not just have future logging turned
  off — the historic log may already contain disclosed secrets/paths.
- **Logs everyone out:** no.
- **Maintenance window:** not required — near-zero risk of breaking the live site, though verify no
  plugin/theme code path actually *depends* on `WP_DEBUG` being true (rare, but check before flipping
  in bulk across 63 sites via a script).
- **Rollback:** trivial — re-enable the flag. No destructive step involved, so this is the safest of
  the four to fix first and fastest to fix at portfolio scale (a scripted find/replace across all
  `wp-config.php` files is low-risk if each site's file is backed up first).

### 3.4 Missing HSTS

- **Exact change:** add `Strict-Transport-Security: max-age=31536000; includeSubDomains` (omit
  `preload` until the site has been confirmed HTTPS-clean site-wide for a while) at the web-server
  layer — Nginx `add_header` in the site's server block, Apache `.htaccess`/vhost `Header always set`,
  or at a shared reverse proxy/CDN in front of the hosting layer if one exists (check the H5 topology
  — `hostinger-wp` sites likely need the header set per-site; anything behind a shared proxy could be
  set once upstream).
- **Blast radius:** single site (or the shared proxy, if applicable — check before batch-applying).
  A too-aggressive `max-age` combined with a site that later needs to serve plain HTTP (rare, but
  possible during a migration) will make browsers refuse the downgrade for the full `max-age` duration
  — this is the main real risk with HSTS, not deployment risk.
- **Logs everyone out:** no.
- **Maintenance window:** not required.
- **Rollback:** the header can be removed from new responses immediately, but **already-received**
  HSTS instructions are cached client-side for `max-age` — a botched rollback (e.g., site needs to
  serve HTTP again) cannot be undone for users who already saw the header until their browser's stored
  policy expires. Start with a short `max-age` (e.g., a week) portfolio-wide, confirm no breakage, then
  raise to a year — do not ship `max-age=31536000` as the first-ever value on an unverified site.

### 3.5 Suggested execution order across the portfolio

1. **Debug flags** (3.3) — safest, fastest, do first, no window needed, closes the most likely
   foothold-generator.
2. **Shared/default salts** (3.1) — pending §1.4 confirmation; if confirmed cross-site, this becomes
   the priority item and should not wait for 2–4 below.
3. **HSTS** (3.4) — cheap, low-risk, roll out with the conservative short-`max-age` approach.
4. **`wp_` prefix** (3.2) — lowest value, needs a real maintenance window; bundle into already-
   scheduled site maintenance rather than a dedicated pass.

---

## 4. What needs owner authorization before anything is touched

None of §3 should be executed against a live client site without an explicit go, because these are
**production changes to third-party customer property**, several with user-visible impact (forced
logout, brief downtime). Framed as decisions:

**Decision A — engagement scope.** Does the agency have standing authorization in its client contracts
to make hosting-layer security changes unprompted, or does each client need to be notified/asked?
- *Option 1:* Standing MSA/hosting-agreement language already covers "security hardening" — proceed
  under existing authority, notify after the fact.
- *Option 2:* Each client must be notified before their site is touched, even if no downtime is
  expected (debug-flag fix, HSTS).
- *Option 3:* Each client must explicitly opt in, given some fixes force their staff/editors to
  re-login.
- **Affected clients:** all ~63 properties, unresolved which fall in which contractual bucket without
  checking the actual client/engagement records — this triage cannot answer that from documents alone.

**Decision B — the shared-salt confirmation step.** Authorize (or assign) the read-only check described
in §1.4 (pull the real Nexus audit documents, confirm which sites, confirm comparison method) before
committing to §2's Rank-1 treatment operationally. This step itself needs no client contact, only
access to the `gaia-nexus` git history — but someone must be tasked with it, since it is not code work
and won't happen by itself.

**Decision C — if shared salts are confirmed real: incident-response framing or routine-maintenance
framing?** A confirmed cross-client session-replay path is arguably a security incident (was this
already exploited? is there log evidence?), not just a backlog item.
- *Option 1:* Treat as incident — pull whatever server/access logs still exist for the affected sites
  (if any survive; per §1.2 much of the historic Nexus-side data is already gone) for signs of prior
  exploitation, before or in parallel with rotating salts.
- *Option 2:* Treat as routine hardening — rotate salts per §3.1 without a forensic look-back, accepting
  the risk that prior exploitation (if any) goes uninvestigated.
- **Affected clients:** whichever sites the Decision-B check identifies as genuinely sharing salt
  values — cannot be named yet.

**Decision D — maintenance-window communication.** For findings that force logout (3.1) or require
downtime (3.2), who tells the client, how much notice, and does the agency eat any support cost from
confused users re-authenticating? This is a client-relationship decision, not a technical one, and the
answer likely differs per client per Decision A.

**Decision E — sequencing against the ERP cutover.** The harvest doc (§6.1) already ruled that Nexus is
decommissioned at ERP prod cutover with SM-70/71 and MON-01/02 as cutover-blocking. Does Wave 1
remediation also block cutover, run in parallel, or is it explicitly deferred past cutover (accepting
that the compliance-baseline module proposed in §5 below won't exist to catch regressions until after
it ships)?

---

## 5. Where this belongs in the ERP

**It is currently tracked as SEO work (a markdown backlog inside the Nexus/SEO harvest). That is the
wrong home**, and the harvest document itself already reaches this conclusion independently (§12: "Owner
is WebDev, consumer is SEO... do not build this inside `modules/search`").

### 5.1 What already exists that this should use, not duplicate

This repo already ships a `monitoring` module (`platform-nest/src/modules/monitoring/index.ts`) that is
explicitly **Plane B — property monitoring**: tenant-scoped (`tenant_id`/`client_id` on every table),
Cerbos-gated, with exactly the data model Wave 1 findings need:

- `monitor_incidents` (`platform-nest/migrations/0116_module_monitoring.sql:130`) — has `severity`
  (`page`/`ticket`/`info`), `opened_at`/`closed_at`/`acknowledged_at`/`acknowledged_by`, and a
  **one-open-incident-per-monitor** constraint that prevents alert-fatigue duplication. This is
  materially the same shape the harvest doc's §12 proposes building as a new "WD-xx Property compliance
  baseline" ticket — except it already exists.
- `monitor_assertions` — content/header assertions per monitor, which is exactly the mechanism for a
  scripted HSTS-header check or a debug-output-reachable check (the harvest doc's own MON-06 ticket
  already proposes `fail_if_body_matches_regexp`/`fail_if_body_not_matches_regexp` on the same
  blackbox-exporter substrate).
- `monitor_maintenance` and `monitor_channels`/`monitor_routes` — maintenance-window suppression and
  delivery routing, both directly reusable for "we're mid-remediation on Site X, mute alerts."

**Recommendation:** do not invent a new "security/compliance" surface. Model each Wave 1 finding class
as a `monitors.kind` (e.g. `hsts-header`, `wp-debug-exposure`, `wp-table-prefix`, `wp-salt-fingerprint`)
with a `monitor_assertion` per check, and let a confirmed failure open a `monitor_incidents` row with
`severity='ticket'` (or `'page'` for the shared-salt class specifically, given §2's ranking). This is
already the home the harvest doc's own §12 gestures at ("evaluation via the MON-01/02/06 probe results")
— it just hadn't been connected to the concrete table names because `docs/blueprints/monitoring-
program.md` (checked for this triage) does not yet mention Wave 1, salts, HSTS, or `wp_` anywhere in
its current text. That connection is the gap this document closes.

### 5.2 Where it does *not* belong

- **Not `modules/search` (SEO).** Confirmed by both this triage and the harvest doc: SEO is a
  *consumer* of findings (an insecure site is also a bad SEO signal, per Google's HTTPS ranking
  factor), not the owner of provisioning/hosting security.
- **Not `modules/it`.** Read `platform-nest/src/modules/it/it.controller.ts`: the IT module is scoped
  to **internal office devices** (CCTV, printers, servers, workstations on the 10.10.0.0/22 office
  network — memory: "Office network + IT discovery gap"). It has no concept of an external client
  website and extending it would conflate internal asset management with client-facing security, the
  same category error the harvest doc accuses Nexus of making between Plane A and Plane B.
- **Not a bespoke new module.** `webdev` currently has no WordPress-provisioning code path at all
  (`provisioning.service.ts`, 818 lines, contains no `wordpress`/`wp-config`/`salt` handling — its own
  comments state WordPress-stack support is presently *refused*, "the refusal is the demand signal for
  webdesk P6"). That means **prevention** (never issuing a shared-salt or `wp_`-prefix install through
  our own path) has no hook to attach to yet — it is a future webdesk-P6 concern, not something this
  triage can wire today. **Detection**, via the monitoring module, is what's available now.

### 5.3 Ownership split (mirrors harvest doc §12, made concrete)

- **WebDev owns** the sites and any future provisioning path (prevention, when webdesk P6 lands).
- **Monitoring module owns** the finding lifecycle (detection → incident → acknowledgement →
  resolution) as `monitors`/`monitor_incidents` rows, tenant-scoped per client.
- **SEO (`modules/search`) reads** monitoring's findings as one input to `search_audits` /
  `search_audit_findings` — consumer, not owner, exactly as the harvest doc concluded on 2026-08-13.

---

## 6. What I could not determine from the documents alone

Stated explicitly, per the instruction that an unverified claim presented confidently is worse than an
admitted gap:

1. **Whether the shared-salt finding is real** — the central question of this assignment. See §1.4.
   Not resolvable without the actual Nexus audit documents (in the separate `gaia-nexus` repo, not
   fetched for this task) or a document confirming the audit tool's comparison methodology.
2. **Which specific sites** carry any of the four findings — the harvest doc gives portfolio-wide
   framing ("portfolio-wide", "across installs") with no per-site breakdown available in this repo.
3. **How stale each finding actually is** beyond "at least since June 2026, possibly earlier" — no
   audit-run timestamp is recorded anywhere I could find.
4. **Whether any of the 63 properties have already changed hands, been decommissioned, or been fixed**
   by the client's own hosting provider since the audit — no reconciliation against current
   `search_properties` rows was performed as part of this triage (would require querying the live
   platform DB, which is a live-system read, not a document read, and was out of scope for a
   documents-only triage).
5. **Whether historic access/server logs survive** for the affected sites, which would matter
   materially to Decision C (§4) if the shared-salt finding is confirmed and prior exploitation needs
   investigating. `gda-s01`'s own data is confirmed mostly gone (harvest doc §11); the client sites'
   *own* hosting-side logs are a separate, unchecked question.
6. **Whether current client/engagement contract language already authorizes hosting-security changes**
   (Decision A, §4) — this triage did not review the `clients` module records or any actual MSA/SOW
   text.

---

## 7. Provenance

Every claim above traces to `docs/plans/2026-08-13-gaia-nexus-harvest.md`, to source read directly in
this working tree (`platform-nest/migrations/0034_module_search.sql`,
`platform-nest/migrations/0116_module_monitoring.sql`, `platform-nest/src/modules/monitoring/index.ts`,
`platform-nest/src/modules/webdev/provisioning.service.ts`, `platform-nest/src/modules/it/
it.controller.ts`, `docs/blueprints/monitoring-program.md`), or to general WordPress security mechanics
(auth-cookie/salt construction, HSTS semantics) stated as general technical fact, not as a claim about
any specific client site. No client domain was contacted, scanned, or logged into to produce this
document.
