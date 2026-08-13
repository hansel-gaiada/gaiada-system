# Runbook — Enable MFA (wire the `amr` claim so `assurance:"high"` becomes reachable)

**Ticket:** IAM-MFA-01. **Status of this document: PLANNED — not applied.** Every command below is
a **live Keycloak change**; nothing in it has been executed against `gda-aicenter`. The owner reviews
and runs each step (or hands it to whoever holds `KEYCLOAK_ADMIN_PASSWORD`).

## 1. The problem this closes

`platform-nest/src/auth/oidc.ts`'s `assuranceFor()` maps a verified token to `"high"` assurance only
when its `amr` claim contains `mfa`/`otp`/`hwk`/`totp`. Read-only inspection of the live realm
confirms the platform's own finding:

- `protocol_mapper` table: the **only** mapper on either `gaiada-ui` or `gaiada-platform` is
  `oidc-audience-mapper` (`gaiada-platform-audience`). No AMR mapper exists anywhere.
- `realm_attribute`: **zero** rows naming `acr`/`loa` — no ACR-to-LoA map is configured either.
- `credential` table: **17 `password` rows, zero `otp` rows** — nobody has enrolled a second factor.
- The `browser` flow already has a **`Browser - Conditional OTP`** subflow
  (`conditional-user-configured` → `auth-otp-form`) — the machinery to challenge OTP exists and
  requires no flow restructuring, it has just never fired because nobody holds an OTP credential.
- `authentication/required-actions`: `CONFIGURE_TOTP` is registered and **enabled**, but
  `defaultAction: false` — enrollment is possible today (self-service), but nothing forces it.

So the claim the platform reads was never sent, for anyone, ever. This is independent of whether a
user turns on MFA — the wiring for the platform to ever *see* that fact doesn't exist yet.

## 2. Mechanism chosen: Keycloak's built-in AMR protocol mapper, not ACR/LoA step-up

Keycloak 26 genuinely supports both mechanisms out of the box (confirmed via the Keycloak
documentation source, not recalled from memory — see citations below), but they are not equally
good fits here:

| | **AMR protocol mapper** (chosen) | **ACR/LoA step-up** (rejected) |
|---|---|---|
| What it is | `oidc-amr-mapper` (`AmrProtocolMapper`), a built-in OIDC protocol mapper. Reads a "reference value" configured on whichever authentication **executions** the session actually completed, and sets the `amr` claim to that list. Doc: [`docs/.../authentication/flows.adoc`, "Adding an authenticator reference value"](https://github.com/keycloak/keycloak/blob/main/docs/documentation/server_admin/topics/authentication/flows.adoc) | Realm-level numeric **ACR→LoA** mapping (Realm settings → Login tab) consumed by a `Condition - Level of Authentication` **subflow** that the browser flow must be restructured to include. Doc: [`acr-to-loa-mapping.adoc`](https://github.com/keycloak/keycloak/blob/main/docs/documentation/server_admin/topics/login-settings/acr-to-loa-mapping.adoc) |
| Flow surgery required | **None.** The `Browser - Conditional OTP` subflow already exists and already does the right thing (`conditional-user-configured` → challenge OTP only for enrolled users). Only two additive changes: attach the mapper to a client, set a reference value on the existing OTP execution. | **Yes.** The realm's shared `browser` flow — the one path every login on the box goes through, including `hansel@gaiada.com`'s — has to be edited to insert a Level-of-Authentication conditional subflow. Editing the one flow every human login depends on is exactly the kind of change this ticket's lockout constraint exists to avoid. |
| Claim shape vs. existing contract | `amr` is a **string array** — literally what `VerifiedToken.amr`/`assuranceFor()` already expect (`["otp", ...]`). Zero contract change beyond the fail-closed fix in §3. | `acr` is a **single value** the client requests via `acr_values` and the token echoes back after realm LoA mapping. Consuming it would mean *replacing* `assuranceFor()`'s array-membership check with a numeric-threshold check against a *different* claim — a bigger, riskier diff for the same three-tier signal. |
| Known rough edges | None found for the mapper itself. | [keycloak/keycloak#15237](https://github.com/keycloak/keycloak/issues/15237) — Keycloak has an open issue where step-up authentication via `acr_values` doesn't reliably drive the conditional subflow. Confirms the mechanism has real, currently-open sharp edges in exactly the direction that matters here (a step-up condition silently not firing is the same failure shape as this whole ticket). |
| Version risk | `oidc-amr-mapper` is a long-standing built-in mapper, present in 26.0 (the pinned live tag). | The realm-level **"Minimum ACR value"** client option that makes ACR enforcement turnkey is a **26.1.0** feature ([release notes](https://www.keycloak.org/2025/01/keycloak-2610-released)) — **not present** on the pinned `quay.io/keycloak/keycloak:26.0`. Choosing ACR now would mean either living without that convenience or taking a Keycloak upgrade as a prerequisite, neither of which this ticket is scoped to do. |

**Recommendation: the AMR protocol mapper.** It reaches the owner's stated goal (enable MFA, keep the
three-tier contract, HR export stays gated) with an additive, no-flow-edit change, using a mechanism
that is a strictly better structural match for `assuranceFor()`'s existing array-membership check,
and it avoids the one thing that could genuinely lock `hansel@gaiada.com` out: touching the shared
`browser` flow.

## 3. Order of operations — designed so nothing can lock `hansel@gaiada.com` out

Every step through §3.4 is **purely additive or self-service** — no existing login's requirements
change. The realm-wide, requirement-changing step is isolated at the end (§3.6) and is explicitly an
owner decision, not something this runbook auto-applies.

Take a rollback point first, exactly like the precedent in `docs/runbooks/idp-keycloak.md`
(PR-00b/SEC-02's own convention):

```bash
ssh gda-aicenter
KEYCLOAK_ADMIN_PASSWORD=<from ~/gaiada/infra/compose/.env, never echo it>
docker exec -e KEYCLOAK_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" gaiada-keycloak-1 \
  /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 \
  --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"
docker exec gaiada-keycloak-1 /opt/keycloak/bin/kcadm.sh create realms/gaiada/partial-export \
  -q exportClients=true -q exportGroupsAndRoles=true \
  > ~/gaiada-realm-backups/gaiada-realm-export-$(date +%Y%m%d-%H%M%S).json
```

### 3.1 Add the AMR protocol mapper to `gaiada-ui` (and mirror to `gaiada-platform`)

`gaiada-ui` (public, PKCE — `sso-login.sh` and the real ERP UI both use it) is the client whose
tokens the platform verifies (its `oidc-audience-mapper` forces `aud=gaiada-platform` onto them).
Mirroring onto `gaiada-platform` too matches the existing symmetric pattern (both already carry an
identical audience mapper) and costs nothing.

```bash
GAIADA_UI_ID=117f73a9-751d-4ccc-8388-af2dae6d8a5b        # confirmed live, read-only, 2026-08-13
GAIADA_PLATFORM_ID=7940a599-8c68-4363-a921-4c24b0980bc4   # confirmed live, read-only, 2026-08-13

for CID in "$GAIADA_UI_ID" "$GAIADA_PLATFORM_ID"; do
  docker exec gaiada-keycloak-1 /opt/keycloak/bin/kcadm.sh create \
    "clients/$CID/protocol-mappers/models" -r gaiada -b '{
      "name": "amr",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-amr-mapper",
      "consentRequired": false,
      "config": { "id.token.claim": "false", "access.token.claim": "true", "userinfo.token.claim": "false" }
    }'
done
```

`access.token.claim: true` is the field that matters — `oidc.ts::verifyToken()` verifies the
**access** token (the Bearer header), not the ID token. Field names (`id.token.claim`,
`access.token.claim`) are taken verbatim from this realm's own committed
`infra/compose/keycloak/gaiada-realm.json`, where the existing `gaiada-platform-audience` mapper on
both clients already uses that exact shape — not guessed.

**Console alternative:** Clients → `gaiada-ui` → Client scopes → **Dedicated scope** →
Add mapper → By configuration → **Authentication Method Reference (AMR)**. Toggle "Add to access
token" on, "Add to ID token" off (matches the body above). Repeat for `gaiada-platform`.

**Effect right now: none observable.** No execution has a reference value yet (next step), so the
mapper emits `amr: []` for every login — exactly the "claim present, legitimately empty"
case `oidc.ts` now treats as a normal weak-auth login. Verify this immediately, before touching
anything else:

```bash
# any existing password-only login, e.g. via scripts/sso-login.sh with a seeded dev user or hansel's
# own password if already known — do NOT do this for hansel without his password on hand
TOKEN=$(./scripts/sso-login.sh someone@gaiada.test '<their password>')
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | python3 -m json.tool
# expect to see "amr": [] now present in the payload (it was ABSENT before this step)
```

**Rollback:** `docker exec gaiada-keycloak-1 /opt/keycloak/bin/kcadm.sh delete "clients/$CID/protocol-mappers/models/<mapper-id>" -r gaiada` (get `<mapper-id>` from `kcadm.sh get "clients/$CID/protocol-mappers/models" -r gaiada`).

### 3.2 Set a reference value on the OTP execution in the `browser` flow

Authentication → flows → the flow bound to **Browser** → find the `auth-otp-form` execution inside
the **`Browser - Conditional OTP`** subflow → its row's own settings expose a reference-value field
(Keycloak's docs title this control **"Adding an authenticator reference value"**, in the
`server_admin` "Configuring authentication" → "flows" chapter — the exact console label has moved
between releases, so treat §3.3's live probe as the source of truth, not the field's name). Set it
to a short token, e.g. `otp`.

This is still purely additive: the execution's `requirement` (`CONDITIONAL`, gated on
`conditional-user-configured`) is untouched, so it still only fires for a user who already holds an
OTP credential — which today is nobody. No existing login is affected by this step either.

**Rollback:** clear the reference-value field back to empty on the same row.

### 3.3 Enroll `hansel@gaiada.com`'s own OTP credential — self-service, no realm change

Do this **before** any realm-wide required-action flip, and confirm it worked, per the ticket's
lockout-safety requirement.

1. `hansel@gaiada.com` visits `https://erp.gaiada.online/idp/realms/gaiada/account`, signs in with
   his existing password (nothing about his login changed yet), goes to **Account security → Signing
   in → Two-factor authentication**, and adds an authenticator app (scans the QR / enters the secret,
   confirms one code). `CONFIGURE_TOTP` is already an enabled required action on this realm — this
   self-service path does not need it to be `defaultAction: true`.
2. Confirm, read-only:
   ```bash
   docker exec gaiada-keycloak-1 /opt/keycloak/bin/kcadm.sh get users -r gaiada -q email=hansel@gaiada.com --fields id
   docker exec gaiada-keycloak-1 /opt/keycloak/bin/kcadm.sh get "users/<id>/credentials" -r gaiada
   # expect one new row, type "otp"
   ```

### 3.4 Drive a REAL login for `hansel@gaiada.com` and verify the claim end-to-end

`scripts/sso-login.sh` cannot complete this check by itself once OTP is enrolled — it POSTs
username/password only and has no step for an OTP challenge (its own comment: "ERR: no authorization
code (bad credentials, or an interstitial such as OTP/consent)" — an OTP interstitial is exactly what
now appears). Use a real browser for this one login, the same way `docs/runbooks/idp-keycloak.md`'s
own SEC-01/PR-00b entries did for equivalent checks:

1. `hansel@gaiada.com` logs into `https://erp.gaiada.online/` (or the account console) normally,
   enters his TOTP code when challenged, and completes the login.
2. Grab the access token (browser devtools → Network → the `token` POST response body's
   `access_token`, or the `Authorization: Bearer …` header on any subsequent `/api/*` call).
3. **Decode it — Keycloak's side of the claim:**
   ```bash
   echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | python3 -m json.tool
   # expect: "amr": ["otp"]  (or whatever reference value §3.2 used)
   ```
4. **Call the platform — the platform's side of the claim (the actual gate this ticket closes):**
   ```bash
   curl -s https://erp.gaiada.online/api/me -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
   # expect: "assurance": "high"
   ```
5. **Confirm nothing else regressed:** repeat the plain password-only login for any other seeded
   dev/staff account that has NOT enrolled OTP and confirm `/api/me` still reads
   `"assurance": "linked"` — the conditional subflow must still skip OTP for everyone else.

Only once step 4 reads `"high"` for a real login is the tier proven reachable end-to-end — this is
the concrete "verify it actually works" gate the ticket asks for, and it happens entirely before
§3.6's realm-wide step.

### 3.5 Mirror the change into the committed realm JSON (fresh-boot parity)

`infra/compose/keycloak/gaiada-realm.json` is what a **fresh** Keycloak boot imports — the live
`kcadm` calls above do not touch it. `docs/runbooks/idp-keycloak.md` (PR-00b) flagged exactly this
gap for `UPDATE_PASSWORD` and deliberately left it for a follow-up rather than editing it out of
scope; the same applies here. Once §3.1–3.2 are verified live, add to both clients' `protocolMappers`
array in that file (same shape as the `kcadm` body in §3.1) and set the `auth-otp-form` execution's
reference value in the `authenticationFlows` block (same value as §3.2), so a disaster-recovery
re-import doesn't silently regress this fix. **Not done as part of this runbook** — it's a repo edit
outside this ticket's owned-files list; flagged here so it isn't lost.

### 3.6 (Owner decision — not part of the default rollout) Force enrollment realm-wide

Only after §3.4 is green: decide whether/when the other ~6 real logins should be forced to enroll.
This is a genuine UX/policy call (it changes what every other real login sees at next sign-in), not
a mechanical follow-on — do not flip it automatically right after hansel's own check.

```bash
docker exec gaiada-keycloak-1 /opt/keycloak/bin/kcadm.sh update authentication/required-actions/CONFIGURE_TOTP \
  -r gaiada -s defaultAction=true
```

**Rollback:** `-s defaultAction=false` (same command). This does not retroactively touch any session
already past the required-action check — same non-retroactive behavior PR-00b's own note documented
for `UPDATE_PASSWORD`'s registration.

## 4. Verifying the platform side is honest about a misconfiguration

`assuranceFor()` (`platform-nest/src/auth/oidc.ts`) now distinguishes "claim absent/malformed" from
"claim present but empty" (`VerifiedToken.amrClaimPresent`). If any step above is skipped, missed on
a fresh import, or a future client stops carrying the mapper, every affected login logs, per
occurrence:

```
[oidc:amr-claim-missing] verified token for sub=<sub> carries no usable "amr" claim — the IdP
client has no AMR protocol mapper wired (or it emitted a non-array value). Assurance is capped at
"linked"; the high-assurance tier is UNREACHABLE for this session and will stay that way for every
session until the mapper is fixed. See infra/runbooks/enable-mfa.md. (occurrences this process: N)
```

`getAmrClaimMissingCount()` (exported from `oidc.ts`) is available for a future boot/health/metrics
wire-up — not wired to an endpoint yet (that would touch files outside this ticket's remit; flagged
as a follow-up in the accompanying report).

## 5. Sources consulted for §2 (Keycloak 26 capability claims, not recalled from memory)

- [`docs/.../login-settings/acr-to-loa-mapping.adoc`](https://github.com/keycloak/keycloak/blob/main/docs/documentation/server_admin/topics/login-settings/acr-to-loa-mapping.adoc) — realm ACR→LoA mapping mechanism.
- [`docs/.../authentication/flows.adoc`](https://github.com/keycloak/keycloak/blob/main/docs/documentation/server_admin/topics/authentication/flows.adoc) — "Adding an authenticator reference value" / AMR mapper.
- [`AmrProtocolMapper.java`](https://raw.githubusercontent.com/keycloak/keycloak/main/services/src/main/java/org/keycloak/protocol/oidc/mappers/AmrProtocolMapper.java) / [`AmrUtils.java`](https://raw.githubusercontent.com/keycloak/keycloak/main/services/src/main/java/org/keycloak/protocol/oidc/utils/AmrUtils.java) — source-level confirmation that (a) `PROVIDER_ID = "oidc-amr-mapper"`, (b) the claim is **always** set once the mapper is attached (empty list, never omitted), and (c) a completed execution only contributes to `amr` if it has an explicit, non-empty reference value configured — the exact mechanism §3.2 relies on.
- [Keycloak 26.1.0 release notes](https://www.keycloak.org/2025/01/keycloak-2610-released) — "Minimum ACR value" client option is 26.1+, not present on the pinned `26.0`.
- [keycloak/keycloak#15237](https://github.com/keycloak/keycloak/issues/15237) — open bug, ACR/`acr_values` step-up not reliably driving the conditional subflow.
- Live `gaiada_keycloak` Postgres, read-only (`ssh gda-aicenter`, `sudo -u postgres psql -d gaiada_keycloak`), 2026-08-13: confirmed realm `gaiada` (`980a8a57-…`), client ids for `gaiada-ui`/`gaiada-platform`, zero `amr`/`acr`-mapping rows, 17 password / 0 otp credentials, the `Browser - Conditional OTP` subflow shape, and `CONFIGURE_TOTP` registered-but-not-default.
