# Probe consent in Web Dev — owner rulings

**Date:** 2026-09-03 · **Decided by:** owner · **Recorded by:** Claude (session: webdev site-surface cleanup)
**Status:** RULING (binding) · the implementation it authorizes is **PLANNED** until a ticket lands
**Inputs:** the live estate as of alpha.333 (read-only probe, nothing mutated),
`platform-nest/src/modules/search/search.controller.ts` (`PATCH properties/:id`),
`platform-ui/src/lib/siteMonitoring.ts`, `docs/FRONTEND-BFF-CONTRACT.md` §24.

---

## 0. Why this needed a ruling at all

`search_properties.verified_at` is the switch that decides what the monitoring module is allowed to
probe. The sweep builds its SSRF allowlist from **verified** rows only, so setting that column is not
a configuration convenience — it is an assertion that we have permission to reach out and touch
somebody else's website. The endpoint to set it has existed for months
(`PATCH /api/:t/modules/search/properties/:id`, accepting `verifiedAt`, gated
`resource_search_property:update`), which is exactly why the UI for it was **deliberately not built**
during the 2026-09-03 site-surface work: a one-click grant would have made an engineer the author of
a compliance claim.

**The scale, measured on the live estate (alpha.333, 2026-09-03):** 81 sites, of which **18 are
consented and all 18 are monitored** — and **63 carry no consent at all**. There are currently ZERO
consented-but-unmonitored sites. So consent, not monitor creation, is the binding constraint on
monitoring coverage for roughly three quarters of the estate.

---

## 1. RULING — who may record consent

**Web Dev REQUESTS; a holder of `search.manage` (or `company.manage`) GRANTS.** Not self-service
from the portfolio.

Rejected: "anyone with `search.manage` grants it directly" (fastest, and it matches the backend gate
exactly, but it puts the assertion in the hands of whoever happens to be on the portfolio page rather
than whoever owns the client relationship) and "company admins only" (safest, and a bottleneck for 63
domains that pushes the decision to the person furthest from the client).

Consequences for the implementation:

- The request→approve shape is the program's existing D14 approvals machinery, where **approving
  EXECUTES** (registry-listed executables only). A consent grant is a natural fit: the approval IS
  the record of who asserted what, and execution performs the `PATCH`. It must NOT be a second,
  parallel approval mechanism.
- The Web Dev side offers "Request probe consent" only where it is meaningful: a site with no
  consent on record. A site that is already consented offers nothing, and a site we own (see §3)
  takes the same path with a different stated basis.
- The requester needs no `search.manage`. The approver does. The UI must not offer the request to
  someone whose request nobody could action, so the absence of any eligible approver is itself worth
  stating rather than producing a request that sits forever.

## 2. RULING — evidence is mandatory

**A reference note is REQUIRED to record consent** — contract clause, email date, ticket id, or
equivalent. A grant with no stated basis is refused.

Rejected: "audit trail only" (who + when is already captured by `writeActivity`, and it answers who
clicked but not *why they were entitled to*), and a dedicated queryable `consent_basis` column set
(better for reporting; more schema than this earns before the flow has been used once).

Consequences:

- The basis is captured at REQUEST time, by the person who has the contract in front of them, not at
  approval time. The approver reviews a stated basis; they do not invent one.
- It is stored on the approval record, which is durable and auditable, plus `writeActivity`. **No
  migration.** If reporting on consent basis is ever needed, promoting it to a column on
  `search_properties` is a later, additive step — deliberately deferred, and recorded here so the
  deferral is visible rather than forgotten.
- Mandatory means validated server-side, not merely a required input in the browser.

## 3. RULING — the attestation wording

The person requesting consent is confirming, verbatim:

> **I confirm monitoring this domain is covered by our service agreement with this client.**

Rejected: "the client has given written permission" (a stronger claim than our actual position, and
one we would not be able to evidence per-domain for 63 domains) and splitting the flow into
"our property" vs "client's property" as two separate grounds (more honest about the 19 sites on our
own boxes, and more UI than the first iteration earns — the service-agreement wording covers a client
site, and a domain we own needs no client permission at all, so it is a degenerate case of the same
sentence rather than a second one).

Consequences:

- This sentence is the compliance artefact. It is stored with the request, not merely displayed —
  a wording change later must not silently re-label consent that was granted under the old sentence.
  So the attestation TEXT travels with the record, versioned by its own content.
- The sentence appears at the point of assertion. It is not buried in a tooltip or a help page.

---

## 4. What is NOT ruled here, and must not be assumed

- **Revocation.** Whether withdrawing consent auto-suspends the monitors watching that domain, or
  merely flags them, is undecided. Until it is decided, nothing in this flow may implement an
  implicit revocation path. Note the portfolio already surfaces the inverse anomaly — a domain being
  probed with NO consent on record — as its own state and facet, so the detection half exists.
- **Bulk grant.** 63 domains is a lot of individual requests. Whether a batch path exists, and
  whether one attestation may cover many domains, is undecided; a per-domain request is the safe
  default and the only thing authorized here.
- **Who counts as an eligible approver when `search.manage` is unheld in a company.** The fallback to
  `company.manage` above is the ruling's intent, but the exact Cerbos expression is an
  implementation question for the ticket, and it must fail CLOSED (no eligible approver ⇒ no grant,
  not an implicit self-approval).

## 5. Implementation notes for whoever picks this up

- The write endpoint already exists and needs no change: `PATCH /modules/search/properties/:id` with
  `{ verifiedAt }`, authorized `resource_search_property:update`, module `search`.
- A domain with no `search_properties` row at all cannot be consented — there is nothing to set
  `verified_at` on. That is true of most of the 63, so the flow has to create the property row (it
  needs a `clientId`) or refuse with that reason stated. `monitorClientFor()` in
  `platform-ui/src/lib/siteMonitoring.ts` already documents where a client id can honestly come
  from, and where it cannot.
- Consent is a `search` module concern that Web Dev merely initiates. The cross-module seam stays
  where §24's own note puts it: the two modules meet on the DOMAIN, via `search_properties`, and
  nothing in `webdev_sites` gains a consent column.
