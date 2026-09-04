# Client-assignment worklist — `webdev_sites` rows with no client

Status: PLANNED (proposals only — nothing in this document has been applied to production)
Date: 2026-09-04
Source: live `gaiada-platform-1` DB on `gda-aicenter`, read read-only under RLS as `platform_app`
(`SET LOCAL app.current_tenant_ids='019fb652-c68b-728f-b779-04465fcec5ae'; SET LOCAL app.scopes='webdev,search';`),
inside `BEGIN; ... ROLLBACK;`. No write of any kind was issued against production for this exercise.

## Why this document exists

This is the top blocker on the site-consolidation programme: a site with an unknown client cannot be
bucketed, cannot get a consent decision, and cannot be assigned a target adoption rung. There are
**81 non-deleted rows in `webdev_sites`**; **23 already carry a `client_id`**; **58 do not**. This
document proposes a client for each of those 58, grouped by `host_ref` (the order the owner will
actually work through them), with the evidence behind each proposal and a confidence marker. Every
proposal here is **a lead for a human to confirm or correct — not a decision.**

## Summary counts (of the 58 NULL-client rows)

| Bucket | Count |
|---|---|
| **High confidence** (strong direct evidence — resolve now) | 8 |
| **Medium confidence** (a plausible domain/cluster/repo match, no direct client link) | 39 |
| **Low confidence** (little to go on beyond the domain name itself) | 10 |
| **No usable evidence at all** | 1 (`interlacenetwork.com` — see flagged cases below) |
| **NEW CLIENT NEEDED** (no existing `clients` row fits; a record must be created) | 52, of which 3 are the BIMC rows (see flagged cases) |
| **Matches an EXISTING client** (confident) | 1 — `darkturquoise-wallaby-245566.hostingersite.com` → **Free Tax Returns** |
| **Possible match to an EXISTING client, flagged for owner review, not asserted** | 1 — `cascadessuites-com-204280.hostingersite.com` → maybe **CasCades Restaurant** |
| **OURS (internal) — recommend excluding from the client-assignment exercise entirely** | 4 |

High + medium confidence together = **47 of 58** rows the owner can move through quickly. The
remaining 11 (10 low + 1 none) need either a direct look at the live site or the owner's own
knowledge of the deal history — no amount of registry-mining will resolve them further.

**Important negative finding:** the task brief expected some Hostinger rows to be "blank
colour-animal auto-scaffolds" (unallocated placeholders, no client work). None of the three
colour-animal-named rows actually found in this pull are blank — all three
(`darkturquoise-wallaby-245566`, `lightyellow-scorpion-606733`, `sienna-crab-240452`) carry a
`notes` value naming a real backing repo (`free-tax-return-preview`, `natya-hotel-preview`,
`bimc-bali` respectively), i.e. real project evidence hiding behind an auto-generated name. Do not
assume a colour-animal name means "ignore this row" — check `notes`/`repo_url` first, every time.
No genuinely blank/placeholder row was found among the 58; the "internal/unallocated" bucket above
(4 rows) is populated by literal internal domains (`gaiada.com`, its staging mirror, `testmodule.gaiada.com`)
and one cryptic internal box name (`bsc.gaiada0.online`), not by blank scaffolds.

## Two known live cases the owner already asked about

- **`cosmedic.bimcbali.com`** (host `hstgr-vps-srv599617`) and **`interlacenetwork.com`** (same host)
  were both imported with `client_id NULL` pending owner assignment.
- The domain `bimcbali.com` implies the client is **BIMC**. Two *other* rows in this same pull turned
  out to be BIMC-related on independent evidence: `bimc-cosmedic-01.gaiada.com` (host
  `hstgr-shared-gda-staging`, name says "bimc-cosmedic" outright) and
  `sienna-crab-240452.hostingersite.com` (colour-animal name, but `notes` names the backing repo
  `web-gaiada/bimc-bali`). So there are **three BIMC candidate rows in this document**, not one —
  worth resolving together. **BIMC does not exist in the `clients` table today**, so all three are
  proposed as **NEW CLIENT NEEDED: BIMC**, high confidence.
- `interlacenetwork.com` has no notes, no repo, no project link, and no domain-name evidence pointing
  anywhere. It is the one row in this document with **no usable evidence** — confidence **none**.
  Resolving it requires the owner's own knowledge of the deal, not more registry mining.

## Rows where two plausible clients competed (look at these first)

1. **`cascadessuites-com-204280.hostingersite.com`** → decoded target `cascadessuites.com`. The
   existing client **CasCades Restaurant** owns `cascadesbali.com` / `www.cascadesbali.com` per
   `search_properties` — a *different* domain, same brand root ("Cascades"). This could be the same
   business's suites/hotel property, or an unrelated business that happens to share a common English
   word. Proposed **CasCades Restaurant (to verify)**, confidence medium, flagged rather than asserted.
2. **`goldenmonkeybali-com-303701.hostingersite.com`** → its own `notes` say "likely target:
   goldenmonkeybali.com", but its `repo_url` points to `web-gaiada/goldenmonkeyubud` — a *different*
   domain in the same three-site cluster (`goldenmonkeybali` / `goldenmonkeysanur` /
   `goldenmonkeyubud`). The notes and the repo disagree with each other. Almost certainly all three
   Golden Monkey domains belong to one client with three locations, but which repo backs which
   domain needs a human to check, not this document.
3. Thematic-only overlaps that are **not** proposed as matches (listed only so the owner doesn't
   have to re-derive them): `motagarage.com` / `sepedamotor.com` (both motorcycle/garage themed) vs.
   existing client **Hunter Motorcycles** (`huntermotorcycles.co.id`) — no domain, repo, or project
   evidence ties them together, so both stay NEW CLIENT NEEDED, not proposed as Hunter Motorcycles.

## Worklist, grouped by `host_ref`

Columns: domain · environment · kind · access · origin · **proposed client** · evidence · confidence.

### `host_ref = gda-ce01` (our-box)

| Domain | Env | Kind | Access | Origin | Proposed client | Evidence | Confidence |
|---|---|---|---|---|---|---|---|
| `bsc.gaiada0.online` | production | (blank) | none | probe | OURS (internal) | Internal box (`gda-ce01`), no notes/repo/project, cryptic internal-style subdomain of our own `gaiada0.online` | low |
| `schoolcatering.gaiada.online` | production | (blank) | none | probe | NEW CLIENT NEEDED | Repo `gaiadabali/schoolcatering` exists but no client/project link; could equally be an internal prototype | low |

### `host_ref = hostinger` (external)

| Domain | Env | Kind | Access | Origin | Proposed client | Evidence | Confidence |
|---|---|---|---|---|---|---|---|
| `ayrwater.com` | production | (blank) | none | probe | NEW CLIENT NEEDED | No notes, repo, project, or client/property match of any kind | low |
| `clim-pacaservices.fr` | production | (blank) | none | probe | NEW CLIENT NEEDED | Real-domain twin of the staging row `clim-pacaservices-fr-733870.hostingersite.com` below — confirms this is a live target, not who owns it | medium |
| `enzocafeubud.com` | production | (blank) | none | probe | NEW CLIENT NEEDED — "Enzo" cluster | Part of a 4-domain Enzo-branded cluster (see Enzo rows below); no existing client named Enzo | medium |
| `gaiada.com` | production | wp | none | probe | **OURS (internal)** | `project_id` = `c4cd317c-3950-4485-bbab-2b7051b6593d`, project name "gaiada.com — our own site"; `last_http_status=200` | high |

### `host_ref = hostyourservices-syd5`

| Domain | Env | Kind | Access | Origin | Proposed client | Evidence | Confidence |
|---|---|---|---|---|---|---|---|
| `claisebrookbar.com` | production | wp | none | manual | NEW CLIENT NEEDED | No notes/repo/project/property match; distinct from existing client "Pinstripe Bar" despite both being bar businesses | low |

### `host_ref = hstgr-shared-gda-staging` (the big shared staging bucket)

All rows below are `environment=staging`, `access=none`, `origin=probe`, `host_kind=shared-hosting`
unless noted. For the `*.hostingersite.com` rows the domain shown after the arrow is the **decoded**
target — trailing `-tld` only decoded to a dot, internal dashes in the business name left alone
(so `clim-pacaservices-fr-733870` → `clim-pacaservices.fr`, not `clim.pacaservices.fr`).

| Domain (as stored → decoded target) | Kind | Proposed client | Evidence | Confidence |
|---|---|---|---|---|
| `7originfilm-com-790897.hostingersite.com` → `7originfilm.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: 7originfilm.com; WP 6.8.8" | medium |
| `amertaspa-com-663643.hostingersite.com` → `amertaspa.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: amertaspa.com" | medium |
| `aquatir-id-332180.hostingersite.com` → `aquatir.id` | wp | NEW CLIENT NEEDED | `notes`: "likely target: aquatir.id" | medium |
| `balihideawayvillas.com` (real domain, no decode needed) | wp | NEW CLIENT NEEDED | `notes`: "real domain attached; WP 6.9.7" | medium |
| `balijetcatering-com-504209.hostingersite.com` → `balijetcatering.com` | (blank) | NEW CLIENT NEEDED | `notes`: "likely target: balijetcatering.com"; distinct business from existing client "Bali Catering" (`balicatering.com`) despite the name similarity — do not merge these | medium |
| `balipropertybargains-com-au-241321.hostingersite.com` → `balipropertybargains.com.au` | wp | NEW CLIENT NEEDED | `notes`: "likely target: balipropertybargains.com.au" | medium |
| `balirca-id-894040.hostingersite.com` → `balirca.id` | wp | NEW CLIENT NEEDED | `notes` gives the target domain only; business identity behind "BALIRCA" unclear | low |
| `balirestaurantguide-com-198813.hostingersite.com` → `balirestaurantguide.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: balirestaurantguide.com"; naming pattern echoes existing client "Bali Spa Guide" but is a different niche/domain — not proposed as the same client | medium |
| `baliyachtcatering-com-910729.hostingersite.com` → `baliyachtcatering.com` | (blank) | NEW CLIENT NEEDED — "Bali Yacht" cluster | `notes` gives target; paired with `baliyachtprovisioning.com` below, likely one client | medium |
| `baliyachtprovisioning-com-738762.hostingersite.com` → `baliyachtprovisioning.com` | (blank) | NEW CLIENT NEEDED — same cluster | `notes` gives target; see above | medium |
| `beanexchange.net` (real domain) | wp | NEW CLIENT NEEDED | `notes`: "real domain attached; WP 7.1"; business unclear from name alone | low |
| `bimc-cosmedic-01.gaiada.com` (real domain, staging) | wp | **NEW CLIENT NEEDED: BIMC** | Domain literally names "bimc-cosmedic"; matches production row `cosmedic.bimcbali.com` below and the sentinel `bimc-bali` repo on `sienna-crab-240452` — three independent BIMC signals | high |
| `bruinsma-ac-com-349075.hostingersite.com` → `bruinsma-ac.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: bruinsma-ac.com"; "-ac" suggests an air-conditioning business | medium |
| `cascadessuites-com-204280.hostingersite.com` → `cascadessuites.com` | wp | **CasCades Restaurant? (verify)** | Shares "Cascades" brand root with existing client CasCades Restaurant (`cascadesbali.com`), but is a different domain — flagged competing match, see above | medium |
| `caviar-id-304338.hostingersite.com` → `caviar.id` | wp | NEW CLIENT NEEDED — "caviar" cluster | `notes` gives target; part of a 3-domain caviar cluster (`dacaviar.com`, `russiancaviarhouse.id`) suggesting one caviar-import client | medium |
| `clim-pacaservices-fr-733870.hostingersite.com` → `clim-pacaservices.fr` | (blank) | NEW CLIENT NEEDED | `notes` gives target; twin of the production row above | medium |
| `cloudkitchenbali-com-262671.hostingersite.com` → `cloudkitchenbali.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: cloudkitchenbali.com" | medium |
| `dacaviar-com-737838.hostingersite.com` → `dacaviar.com` | wp | NEW CLIENT NEEDED — caviar cluster | See caviar cluster above | medium |
| `dapurraja.com` (real domain) | wp | NEW CLIENT NEEDED | `notes`: "real domain attached; WP 7.1"; "Dapur Raja" = catering/restaurant business (Indonesian, "king's kitchen") | medium |
| `darkturquoise-wallaby-245566.hostingersite.com` | (blank) | **EXISTING CLIENT: Free Tax Returns** | `notes`: "project by repo: free-tax-return-preview"; `repo_url` = `github.com/web-gaiada/free-tax-return-preview`; matches existing client **Free Tax Returns** (`fb5a9255-4629-40db-846e-65bc8c4da7c9`) and its project "Free Tax Returns — web, SEO & social" | **high** |
| `dreamcatchervillas.com` (real domain) | wp | NEW CLIENT NEEDED | `notes`: "real domain attached; WP 7.0.4" | medium |
| `enzocafeubud-com-257108.hostingersite.com` → `enzocafeubud.com` | (blank) | NEW CLIENT NEEDED — Enzo cluster | `notes`: "likely target: enzocafeubud.com"; staging twin of the production row above | medium |
| `enzogelatobali.com` (real domain) | wp | NEW CLIENT NEEDED — Enzo cluster | `notes`: "real domain attached; WP 7.1" | medium |
| `enzosushitrain-com-195256.hostingersite.com` → `enzosushitrain.com` | wp | NEW CLIENT NEEDED — Enzo cluster | `notes`: "likely target: enzosushitrain.com"; third Enzo-branded domain (café / gelato / sushi train) — strongly suggests one multi-outlet client, name unconfirmed | medium |
| `gaiada-com-851708.hostingersite.com` → `gaiada.com` | wp | **OURS (internal)** | `notes`: "likely target: gaiada.com" — staging mirror of our own production site, project `c4cd317c...` | high |
| `goldenmonkeybali-com-303701.hostingersite.com` → `goldenmonkeybali.com` | wp | NEW CLIENT NEEDED — "Golden Monkey" cluster | `notes` says target is `goldenmonkeybali.com` but `repo_url` = `web-gaiada/goldenmonkeyubud` — **notes and repo disagree**, see flagged case above | medium |
| `goldenmonkeysanur-com-805985.hostingersite.com` → `goldenmonkeysanur.com` | wp | NEW CLIENT NEEDED — same cluster | `notes`: "likely target: goldenmonkeysanur.com" | medium |
| `goldenmonkeyubud-com-370886.hostingersite.com` → `goldenmonkeyubud.com` | wp | NEW CLIENT NEEDED — same cluster | `notes` target matches its own decoded domain **and** matches the repo attached to the `goldenmonkeybali` row above — the cleanest evidence in the cluster | high |
| `hairsalonubud.com` (real domain) | wp | NEW CLIENT NEEDED — "Ubud beauty" cluster | `notes`: "real domain attached; WP 7.1"; one of four Ubud beauty/salon domains (see cluster note below) | medium |
| `horizonviewsproperties-com-505551.hostingersite.com` → `horizonviewsproperties.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: horizonviewsproperties.com" | medium |
| `institutescoffier-com-501946.hostingersite.com` → `institutescoffier.com` | wp | NEW CLIENT NEEDED | `notes` gives target; `repo_url` = `git@git.dirox.net:DIROX/icde.git` — backed by a **third-party agency (DIROX)**, not a GDA-org repo; verify GDA actually has the client relationship before treating this as ours | medium |
| `kalugaqueen-id-606981.hostingersite.com` → `kalugaqueen.id` | wp | NEW CLIENT NEEDED | `notes` gives target only; business unclear | low |
| `lastminuteroomsbali-com-156738.hostingersite.com` → `lastminuteroomsbali.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: lastminuteroomsbali.com" | medium |
| `lightyellow-scorpion-606733.hostingersite.com` | (blank) | NEW CLIENT NEEDED: "Natya Hotel" | `notes`: "project by repo: natya-hotel-preview"; colour-animal auto-name but **not** a blank scaffold — real preview build for a named prospect not in `clients` | medium |
| `motagarage-com-674745.hostingersite.com` → `motagarage.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: motagarage.com"; thematically near existing client Hunter Motorcycles but no direct link — not proposed as a match | medium |
| `nailsalonubud.com` (real domain) | wp | NEW CLIENT NEEDED — Ubud beauty cluster | `notes`: "real domain attached; WP 7.1" | medium |
| `nusapenida.org` (real domain) | wp | NEW CLIENT NEEDED | `notes`: "real domain attached; WP 7.1" | medium |
| `orison.io` (real domain) | wp | NEW CLIENT NEEDED | `notes`: "real domain attached; WP 6.8.8"; tech-sounding name/TLD, business unclear | low |
| `pegasus.com.au` (real domain) | (blank) | NEW CLIENT NEEDED | `notes`: "real domain attached"; generic name, business unclear | low |
| `reflexologyubud.com` (real domain) | wp | NEW CLIENT NEEDED — Ubud beauty cluster | `notes`: "real domain attached; WP 7.1"; fourth Ubud beauty/salon-themed domain (with `hairsalonubud.com`, `nailsalonubud.com`, `ubudbeautycentre.com`) — strong cluster, likely one client operating several micro-sites, name unconfirmed | medium |
| `russiancaviarhouse-id-696213.hostingersite.com` → `russiancaviarhouse.id` | wp | NEW CLIENT NEEDED — caviar cluster | `notes`: "likely target: russiancaviarhouse.id" | medium |
| `scamcheck-global-com-397841.hostingersite.com` → `scamcheck-global.com` | wp | NEW CLIENT NEEDED | `notes` gives target; unusual business name — worth a direct look before assuming legitimacy | low |
| `sepedamotor-com-935409.hostingersite.com` → `sepedamotor.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: sepedamotor.com" ("sepeda motor" = motorcycle); thematically near Hunter Motorcycles, no direct link | medium |
| `sienna-crab-240452.hostingersite.com` | (blank) | **NEW CLIENT NEEDED: BIMC** | `notes`: "project by repo: bimc-bali"; `repo_url` = `github.com/web-gaiada/bimc-bali` — third independent BIMC signal, colour-animal name again hides real evidence | high |
| `suriresidence-com-490510.hostingersite.com` → `suriresidence.com` | wp | NEW CLIENT NEEDED | `notes` gives target; `repo_url` = `github.com/RevaARizky/suri-residence-theme` — a personal, non-GDA-org repo; verify the client relationship, same caveat as `institutescoffier` above | medium |
| `tacconsultancy-com-927436.hostingersite.com` → `tacconsultancy.com` | wp | NEW CLIENT NEEDED | `notes`: "likely target: tacconsultancy.com" | medium |
| `testmodule.gaiada.com` (real domain) | wp | **OURS (internal)** | `notes`: "real domain attached; WP 6.9.7"; the domain itself ("testmodule") identifies this as an internal QA install, not client work | high |
| `ubudbeautycentre-com-594402.hostingersite.com` → `ubudbeautycentre.com` | wp | NEW CLIENT NEEDED — Ubud beauty cluster | `notes`: "likely target: ubudbeautycentre.com"; ties together the 4-domain Ubud beauty cluster above | medium |
| `uniqueweightloss-com-au-613303.hostingersite.com` → `uniqueweightloss.com.au` | wp | NEW CLIENT NEEDED | `notes`: "likely target: uniqueweightloss.com.au" | medium |

### `host_ref = hstgr-vps-srv599617`

| Domain | Env | Kind | Proposed client | Evidence | Confidence |
|---|---|---|---|---|---|
| `cosmedic.bimcbali.com` | production | fullstack | **NEW CLIENT NEEDED: BIMC** | Domain contains `bimcbali.com`; owner-flagged known live case; corroborated by `bimc-cosmedic-01.gaiada.com` and `sienna-crab-240452.hostingersite.com` above; `repo_url` = `github.com/RevaARizky/cosmedic-remake` | high |
| `interlacenetwork.com` | production | wp | NEW CLIENT NEEDED | Owner-flagged known live case, imported with `client_id NULL` pending assignment; no notes/repo/project/property evidence at all in this pull | **none** |

## How to apply this

**`webdev_sites` has no HTTP write path today** (verified this session — the only inserts that
exist anywhere in the codebase are in test SQL fixtures). Applying any of the proposals above means
a human running hand-written SQL directly against production, **one statement per row**, after
reviewing that specific row's evidence — never a batch script generated from this document.

Template (illustrative only — fill in one real domain and one real, verified `client_id` at a time):

```sql
-- Run interactively, one row at a time, by a human who has reviewed the proposal for THIS domain.
-- Never loop this over the table; never generate 58 of these from this document.
BEGIN;
SET LOCAL app.current_tenant_ids = '019fb652-c68b-728f-b779-04465fcec5ae';
SET LOCAL app.scopes = 'webdev,search';

UPDATE webdev_sites
SET client_id = '<verified-existing-client-uuid>'   -- from `clients`, never invented
WHERE domain = '<exact-domain-from-this-worklist>'
  AND deleted_at IS NULL
  AND client_id IS NULL;                              -- guards against clobbering a value someone else just set

-- Inspect the single affected row before committing.
COMMIT;   -- or ROLLBACK if the affected-row check looks wrong
```

A wrong `client_id` is **worse** than a NULL one: NULL is visibly unknown and will keep surfacing in
this kind of report; a wrong client silently mis-routes a consent decision to the wrong business.
When in doubt, leave the row NULL and move on.

## Do not do this

Do **not** backfill `webdev_sites.client_id` to a sentinel/internal client value just to make the
column non-null. A NULL client on an internal site is a legitimate delivery fact under ruling
WSK-D35 — it says "this site is ours, not a client's," and that is meaningfully different from "we
haven't checked yet." Ruling WSK-D36's sentinel-client convention lives in `search_properties`
only and does not apply to `webdev_sites`.

## Honesty caveat

An imported registry row is a lead to verify, never a measurement. A large share of these 58 rows
came from a 2025 harvest and carry importer-written provenance in `notes` (e.g. "likely target:
X", "GDA-Staging shared") rather than anything a human confirmed. Every proposal in this document —
including the "high confidence" ones — is evidence for a human decision, not the decision itself.
Treat the confidence markers as "how strong is the evidence," not "how sure are we this is right."
