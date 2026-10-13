# Runbook - a delivered site's domain and DNS (M6-P6i)

**Status: PROTOTYPED.** The ERP side (the claim's search property, `webdesk.site.setDomain`, the DNS checklist) and the WebDesk
side (the `site.setDomain` control command) are written and unit-tested. The DB/Cerbos/WebDesk suites need the Linux gate. **Nothing
here has been run against a real resolver, a real host or the live WebDesk, and the rollback has been run only in those suites, on
test domains and a stub Zone B.** `infra/runbooks/webdesk-site-delivery.md` (M6-P6k) is the end-to-end runbook; this page is its
domain and DNS section, kept separate until that one exists.

Plan: `docs/plans/2026-10-11-webdesk-m6-plan.md` (M6-P6i, and O-12 in section 6.5). Rulings: WSK-D35 (the domain is the key),
WSK-D36 (the internal sentinel), WSK-D43 and WSK-D61 (no DNS credential, no DNS API).

## Who changes what

| Act | Who | How |
|---|---|---|
| Edit the DNS records of a domain | **The owner** for our own domains, **the client** for theirs (O-12) | By hand, in their DNS panel, from the checklist the console shows. **No DNS credential is stored and no DNS API token is requested, anywhere.** |
| Claim the real domain on the registry row (P4c2) | A `webdev_site` `update` holder | `POST sites/:id/domain` `{domain}` |
| Give the WebDesk environment that domain | A `company_admin` files it, a DIFFERENT `company_admin` approves it | `POST control/sites/:siteId/domain` then the Approvals inbox |
| Grant consent to probe a client's domain | The search module's authority (the existing probe-consent request) | `POST console/probe-consent-requests`, decided in the inbox |
| Document where a host account points | The operator | `WEBDEV_DNS_TARGETS` in the server's `.env` (below) |

## The order, for one delivered site

1. **Claim the domain.** `POST /api/:t/modules/webdev/sites/:id/domain {"domain":"shop.example.com"}`. The answer carries `property`:
   - a client's site: `created`, `verified: false`. **MON-01 probes nothing yet.** Ask for consent through the existing
     probe-consent request; until `verified_at` is set no HTTP or TLS check runs against the domain;
   - an internal site: `created`, `verified: true`, under the sentinel, only if exactly one internal sentinel client exists
     (`clients.is_internal`, M5-G0). With none the answer is `skipped` / `no_internal_sentinel`: run `internal-sentinel` first;
   - `409 property_domain_conflict`: the domain already has a search property that belongs to another client. Nothing was claimed.
     Resolve who owns the domain before retrying.
2. **Bind the delivery target** (M6-P6g) if not done: `POST sites/:id/delivery-binding`.
3. **Read the checklist:** `GET sites/:id/dns`. `checklist.state`:
   - `not_claimed`: do step 1. `needs_binding`: do step 2.
   - `target_unknown`: the console says to ask the operator for the DNS target of the host account (`hostRef`). Set it (below), then read again.
   - `ready`: `records` lists type, name and target. Hand them to whoever owns the domain (`recordsOwner`: `owner` or `client`).
4. **Create the records** in the DNS panel. Then read the checklist again: `check.state` is `pending` until every observed address is
   the documented target, then `pointing`. `check.reason` says why not: `no_records` (not created or not propagated), `points_elsewhere`,
   `mixed_with_other_hosts` (part of the traffic still goes to the old host: leave it, or remove the old record), `lookup_failed`
   (the resolver failed; read again). `pointing` is a DNS fact only: it is not consent to probe and says nothing about TLS.
5. **Give WebDesk's environment the domain** (so the site's browser calls to WebDesk are answered):
   `POST control/sites/:siteId/domain {"tenantSlug":"...","envId":"<the env uuid from content/sites>","domain":"shop.example.com"}`.
   It files ONE approval (HIGH, WS4). A DIFFERENT `company_admin` approves it in the Approvals inbox, and the answer reports
   `executed`, `domain` and `previousDomain`. Nothing changes before that. The domain must be the one claimed in step 1, on the
   matching environment (`staging` registry row for the staging environment, `production` for production).

## `WEBDEV_DNS_TARGETS`

One line of JSON in the platform's `.env`, keyed by the registry's opaque `host_ref` label. The repository carries no address.

```
WEBDEV_DNS_TARGETS={"<host_ref>":[{"type":"A","value":"<ipv4>"}],"<other_host_ref>":[{"type":"CNAME","value":"<name>"}]}
```

A host lists A and AAAA records, or exactly ONE CNAME and nothing else. A malformed entry is dropped and logged (a typo can only remove a
target, so the console says `target_unknown` rather than guess). The variable is wired through `infra/compose/docker-compose.vps.yml`;
**a value in `.env` does nothing unless that compose line passes it**, and a change needs the platform container recreated.

## Rollback (what to run, and what to expect)

`site.setDomain` is reversible, and the rollback is the same command:

1. Read the executed approval's result: `webdesk.previousDomain` is the value before.
2. File `POST control/sites/:siteId/domain` again with that `domain` (or `null` to CLEAR the environment's domain), same `tenantSlug` and
   `envId`. A different `company_admin` approves it.
3. Expect: the browser calls from the newer domain stop being answered the moment the old value is stored (WebDesk compares the Origin to
   the column as a whole string, with no suffix match and no wildcard). A clear answers no browser origin at all.
4. If the rolled-back-to domain is not on the registry any more (a domain that was never claimed here), restoring it is refused
   `domain-not-claimed`: clear instead, or claim it first. A clear never needs a claim.

**The drill, run once on a test domain (the suites do this on every run, `webdesk-site-set-domain.test.ts` and WebDesk's
`site-set-domain.spec.ts`):** set A, set B, set A back from `previousDomain`, then clear; after each step the CORS answer is the current
domain's and no other. Do it by hand on the first real test domain before the first client domain, and record the date here.

## When something is off

| Symptom | Meaning |
|---|---|
| `409 domain-not-claimed` on filing | The domain is not on this company's registry (step 1), or it is another company's. |
| `409 domain-environment-mismatch` | The registry holds the domain on the other environment's row. |
| `409 domain-site-mismatch` | The registry row is a provisioned site linked to a different WebDesk tenant. |
| `409 domain-request-pending` | Another domain change for this environment is waiting for approval: decide or withdraw it first. |
| `409 domain-unchanged` | It already is the environment's domain (the wall caches for 60 s, so a just-approved change can read stale for a minute). |
| decide answers `failed`, `webdesk_ambiguous` | The answer was lost. The executor READ the environment's domain: if it says "does NOT have the requested domain", re-file; if it says "could not be read", check the environment's `domain` in WebDesk first. The command is never resent. |
| `check.reason: lookup_failed` | The resolver failed from the platform's host; read again. Not evidence the records are wrong. |
| `property.state: none` on a claimed domain | The claim predates M6-P6i, or no sentinel existed (`skipped`). Create the property through the search module (see Known gaps). |

## Known gaps

- `environment.provision` still takes a free-form `domain` (it predates the canonical rule), and a domain held by ANOTHER WebDesk tenant is
  invisible to `site.setDomain` (RLS). A global unique index on `lower(domain)` closes the second; it needs a duplicate-domain
  diagnostic on the live WebDesk database first (the D35 sequence: diagnostic, migration, ledger).
- There is no UI for the checklist yet: the BFF route exists (`docs/FRONTEND-BFF-CONTRACT.md`, "Site domain" and the `GET sites/:id/dns` row).
- A claim is once-only, so a site claimed BEFORE this change keeps no search property and cannot be re-claimed to get one. Create its property
  through the search module (the M5-G0 `internal-sentinel` script for an internal domain, the property routes for a client's), one at a time.
