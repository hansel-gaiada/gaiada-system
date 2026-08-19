# Runbook — the Postiz org ceremony (SMM-07 prerequisite)

**Status:** written 2026-08-19. Steps 1–5 and 7–8 derive from verified facts (SMM-04's spike, the
compose file, the shipped `keys.ts`). **Step 6 — where Postiz surfaces the org API key — is
UNVERIFIED against the live instance.** It is the one step to expect to adapt. Correct this file in
place when you run it; do not leave the correction in a chat log.

`docker-compose.social.yml` refers to "the runbook" in four places and this is it. It did not exist
until now — SMM-24's debt, paid early because the ceremony blocks SMM-07 → SMM-14 → P1.

---

## Why this is a manual ceremony and not an API call

Postiz has **no org-creation route** in its 22-route public surface (addendum §A4n). Our
provisioning therefore **adopts** an operator-created org: `verifyOrg` proves the pair answers and
our `social_publisher_orgs` row is the mapping — which was always the half that was ours (D-2).

Giving the ERP an HTTP path to org creation would mean either forking the engine or leaving its
signup permanently open. The second breaks containment invariant 5. So signup opens **once**, for
**one** org, and closes again.

## What you are creating

**One** org, for our own brand. Not a client org. Client accounts additionally need the platform-app
reviews (OQ-1) and the AGPL counsel sign-off (OQ-3), neither of which is done.

---

## Before you start

| | |
|---|---|
| Licence-zone host | SumoPod VPS `150.109.15.108` — **runs someone else's production** |
| Compose project | `gaiada-social`, file `docker-compose.social.yml` |
| Working dir on the VPS | `/home/ubuntu/gaiada-social/infra/compose` (verified 2026-08-19) |
| Postiz listener | `10.88.0.2:4007` — the WireGuard tunnel address. **No public listener exists.** |
| ERP host | `gda-aicenter` (`35.240.135.48`), tunnel peer `10.88.0.1` |

**Three standing hazards on that box, none hypothetical:**

1. **Never set `SOCIAL_BIND_ADDR` to `0.0.0.0`.** Docker writes DNAT/FORWARD rules evaluated
   *before* `ufw`, and that host's `DOCKER-USER` chain is empty — a `0.0.0.0` bind is
   internet-reachable while `ufw status` reports success. That would expose an AGPL engine holding
   live client OAuth tokens.
2. **Never pass `--remove-orphans`.** It deletes off-profile containers, and the off-profile
   containers on that box are the owner's.
3. **Never `docker image prune -a`.** Their stopped production containers restart from tagged
   images. Build-cache pruning (`docker builder prune -af`) is the safe one, and is due — 136 GB was
   reclaimed once and it creeps back.

---

## The ceremony

### 1 — Confirm the engine is working, not merely "healthy"

Postiz's container healthcheck probes only the frontend. With the backend dead the container reports
**healthy** while every API call 502s. Prove it from the ERP host, over the tunnel:

```sh
# on gda-aicenter
curl -s -o /dev/null -w '%{http_code}\n' http://10.88.0.2:4007/api/public/v1/posts
```

**Expect `401`** — the backend is up and rejecting an unauthenticated call, which is the correct
answer. `502` means the backend is down and the healthcheck is lying. `000` means the tunnel is down
(`wg show`; `systemctl status wg-quick@wg0` on both hosts).

### 2 — Open signup, for one command's worth of time

```sh
# on the VPS, in the directory holding docker-compose.social.yml and its .env
grep -n SOCIAL_POSTIZ_DISABLE_REGISTRATION .env        # note the current value
sed -i 's/^SOCIAL_POSTIZ_DISABLE_REGISTRATION=.*/SOCIAL_POSTIZ_DISABLE_REGISTRATION=false/' .env
docker compose -f docker-compose.social.yml up -d postiz    # NO --remove-orphans
```

If the var is absent from `.env`, add it rather than relying on the compose default (`true`).
Wait for the backend, then re-run the step-1 curl and expect `401` again.

### 3 — Create exactly one org

```sh
curl -sS -X POST http://10.88.0.2:4007/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"<our-brand-mailbox>","password":"<generated>","company":"<our brand>","provider":"LOCAL"}'
```

**Generate the password on the host** (`openssl rand -base64 24`) — the discipline the stack's other
secrets were created under. Store it in the password manager, not in a shell history you keep. Use a
mailbox we control and will still control in two years: this is the only human principal that will
ever exist inside the engine.

**✅ VERIFIED 2026-08-19.** The payload above is correct exactly as written. A successful create
returns `{"register":true}` with **HTTP 200** — not a 201, and no user or org object in the body.

### 4 — Close the door again

```sh
sed -i 's/^SOCIAL_POSTIZ_DISABLE_REGISTRATION=.*/SOCIAL_POSTIZ_DISABLE_REGISTRATION=true/' .env
docker compose -f docker-compose.social.yml up -d postiz
```

### 5 — Prove it is shut. This is the step people skip

🚨 **THE CANARY PASSWORD MUST BE LONG ENOUGH TO PASS VALIDATION.** This bit us on 2026-08-19. A
short password (`"x"`) returns `400 {"message":["password must be longer than or equal to 3
characters"],"error":"Bad Request"}` — a **validation** rejection that never reaches the
registration-disabled check. You get a `400`, you tick the box, and you have proven **nothing**.

```sh
# one line on purpose: a pasted multi-line block half-executes in some shells
curl -s -X POST http://10.88.0.2:4007/api/auth/register -H 'Content-Type: application/json' -d '{"email":"canary-smm07@example.invalid","password":"AaBbCc123456xyz","company":"canary-smm07","provider":"LOCAL"}' -w 'HTTP %{http_code}'
```

**Expect `400` and the body `Registration is disabled` — that exact string.** If the body names a
field instead, the payload failed validation and the test is VOID. If you get `{"register":true}` you
have just created a second account on an open signup: delete it and restart from step 4.

**Belt and braces — read what the container actually received.** Immune to payload mistakes in a way
the HTTP probe is not:

```sh
docker exec gaiada-social-postiz-1 printenv DISABLE_REGISTRATION      # must print: true
```

**✅ Both VERIFIED 2026-08-19:** env `true`, canary body `Registration is disabled`, HTTP 400.

```sh
ss -ltn | grep 4007        # expect 10.88.0.2:4007 and NOTHING on 0.0.0.0
```

### 6 — Get the org's API key  ⚠ UNVERIFIED

Postiz surfaces a **public API key per org**. In current builds it lives in the app's settings under
a "Public API" section — which means a browser, and there is no public listener. Tunnel to it rather
than exposing anything:

```sh
# from your laptop
ssh -L 4007:10.88.0.2:4007 <user>@150.109.15.108
# then open http://localhost:4007 and log in as the account from step 3
```

The forward dies with the SSH session and publishes nothing. **Do not** change `SOCIAL_BIND_ADDR` to
reach the UI.

**Record here what you actually find** — the exact menu path, or the API route if one exists. This
step is why this file is marked partly unverified.

### 7 — Give the key to the ERP: both halves, or it does nothing

Two edits on `gda-aicenter`:

```sh
# infra/compose/.env
SOCIAL_POSTIZ_ORG_API_KEY=<the key>
```

The passthrough already exists — SMM-06 added the `SOCIAL_*` block to the `platform` service's
`environment:` — so for the **default** alias `.env` is now sufficient.

**Per-client aliases are not.** `keys.ts` resolves alias `acme-brand` from
`SOCIAL_POSTIZ_ORG_API_KEY__ACME_BRAND`, and that variable must be added **explicitly** to the
`platform` service's `environment:` block in `docker-compose.vps.yml` as each org is provisioned. An
unresolvable alias **refuses** (`org_key_unresolved`) and never falls back to the default key —
deliberately, because falling back is how client A publishes with client B's credential.

Recreate the API container so it reads the new env:

```sh
docker compose -f docker-compose.vps.yml up -d platform     # NO --remove-orphans
```

**Check `GAIADA_TAG` in that `.env` first.** `up -d` with a stale tag silently rolls the whole API
back to an older image.

### 8 — Record the mapping in the ERP

The **alias**, never the key, goes in `social_publisher_orgs.api_key_ref`. For a single-org
deployment that is the literal string `default`. `verifyOrg` then proves the pair answers.

---

## Done when

- [ ] `POST /api/auth/register` returns **400 "Registration is disabled"**
- [ ] `ss -ltn` shows `10.88.0.2:4007` and nothing on `0.0.0.0`
- [ ] The ERP resolves the key without `org_key_unresolved`
- [ ] `verifyOrg` succeeds against the adopted org
- [ ] Our five `gaiada-social-*` containers are all still up, and the total has not DROPPED
      (do not check for a fixed total — see the note below)
- [ ] Step 6 has been corrected to what you actually did

## Verified live, 2026-08-19 — pre-ceremony state

Read-only pass over both hosts. Everything the ceremony depends on is in place:

| Check | Result |
|---|---|
| Our five containers | all `Up 5 days (healthy)` |
| Listener | `10.88.0.2:4007` only — **nothing on `0.0.0.0`** |
| API probe, on-VPS | **401** — backend genuinely up, not merely "healthy" |
| API probe, from `gda-aicenter` over the tunnel | **401 in 43 ms** |
| `.env` | mode `600`, `SOCIAL_POSTIZ_DISABLE_REGISTRATION=true` |

⚠ **The container-count check in the earlier draft was wrong and has been corrected.** The handoff's
"baseline 20 → 25" is stale: the box now runs **44** containers. The owner's own estate has grown by
roughly nineteen since 2026-08-13. A fixed expected total is therefore not a safety check — it will
produce a false alarm on every future run. What matters is that **our five are up and nothing of
theirs disappears**, which is what the checklist now says.

## What this unblocks

**SMM-07** (account connect, own-brand first) → **SMM-14** (P1 e2e) → P1 closes.

It does **not** unblock client accounts: those need the platform-app reviews (Meta first — its
Business Verification is the only serial prerequisite) and the AGPL counsel sign-off (OQ-3).

Note also that **media is not yet wired** (found during SMM-10): variant rows hold composer-side
`{fileId}` descriptors while the port expects uploaded engine refs, so a post *with an attachment*
fails loudly at the publisher today. **Text-only is the honest first e2e.**
