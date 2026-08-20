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

### 6 — Get the org's API key  ✅ SOLVED 2026-08-19 — NO BROWSER NEEDED

**Postiz mints the org API key during registration.** It already exists by the time step 3 returns;
there is nothing to generate. Read it straight out of the engine's database:

```sh
docker exec gaiada-social-social-postgres-1 psql -U postiz -d postiz -t -A -c 'SELECT "apiKey" FROM "Organization" WHERE name = '"'"'Gaiada'"'"';'
```

64 lowercase hex characters. `-t -A` gives one clean line with no padding.

🚨 **DO NOT TRY THE UI, AND DO NOT PASTE THE KEY ANYWHERE.** Two hard-won reasons:

1. **The UI cannot work from a laptop.** `NEXT_PUBLIC_BACKEND_URL` is baked into the frontend
   JavaScript as `http://10.88.0.2:4007/api` — the tunnel address. An `ssh -L 4007:...` forward maps
   *localhost*, so the browser loads the login page fine and then POSTs to an address your machine
   cannot route. The login spinner never resolves. Nothing is broken; it simply cannot work from
   outside the tunnel, and no amount of waiting changes that.
2. **Every `cat` of the key is a leak waiting to happen.** It happened three times in one sitting,
   because `cat` prints without a trailing newline and the value runs straight into the shell prompt.
   **Move the key host-to-host and never look at it:**

```sh
# from the operator's machine -- -3 routes the bytes through it without displaying them
scp -3 sumopod:~/postiz-org.key gda-aicenter:~/postiz-org.key
```

**Rotating** (if a key is ever exposed) is a single UPDATE plus a file, and the old key dies
immediately — verified: old key `401`, new key `200`.

```sh
NEW=$(openssl rand -hex 32)
echo "UPDATE \"Organization\" SET \"apiKey\" = '$NEW' WHERE name = 'Gaiada';" > /tmp/rot.sql
docker exec -i gaiada-social-social-postgres-1 psql -U postiz -d postiz -q < /tmp/rot.sql
umask 077; printf %s "$NEW" > ~/postiz-org.key; rm -f /tmp/rot.sql
```

### Reading the API to check your work

`GET /public/v1/posts` **requires ISO 8601 `startDate` and `endDate`** and returns `400` without
them. **A `400` here is NOT an auth failure** — it means your credential was accepted and the request
shape was wrong. The auth ladder, all verified:

| Request | Response |
|---|---|
| no key | `401` |
| valid key, no date range | `400 startDate must be a valid ISO 8601 date string` |
| valid key + ISO range | **`200`** |
| revoked key + ISO range | `401` |

```sh
curl -s -o /dev/null -w '%{http_code}
' -H "Authorization: $(cat ~/postiz-org.key)"   "http://10.88.0.2:4007/api/public/v1/posts?startDate=2026-08-01T00:00:00.000Z&endDate=2026-08-31T23:59:59.000Z"
```

### 7 — Give the key to the ERP: **BOTH** halves, or the module lies to you

Two variables, on `gda-aicenter` in `/home/Hansel/gaiada/infra/compose/.env`:

```
SOCIAL_POSTIZ_ORG_API_KEY=<the 64-hex key>
SOCIAL_POSTIZ_BASE_URL=http://10.88.0.2:4007
```

🚨 **THE KEY ALONE DOES NOTHING, AND FAILS SILENTLY.** This is the trap that caught us. With the key
set and the base URL absent, the module boots into its **supported keyless mode**: no driver is
registered, `/health` returns 200, the container reports `healthy`, every READ serves — and only the
publish path refuses `publisher_not_configured` (503). Nothing anywhere says "you configured half of
this". `SOCIAL_POSTIZ_BASE_URL` is not optional; it is what causes a driver to exist.

The base URL is the **WireGuard peer address** — not a hostname, not https. `main.ts`'s
`assertPublisherBaseUrlIsPrivate` **refuses to boot** on a public-looking value, so a mistake here is
loud. A booting container is itself evidence the address is private.

The `environment:` passthrough for all nine `SOCIAL_*` vars exists (SMM-06). **Verified on the live
box 2026-08-19:** the container receives all nine, defaults included.

🚨 **THE COMPOSE FILE SET ON THIS HOST IS THREE FILES, NOT ONE.**

```sh
docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml -f docker-compose.observability.yml up -d platform
```

A single `-f docker-compose.vps.yml` fails with `service "knowledge" depends on undefined service
"postgres": invalid compose project` — Postgres and Redis live on the *host* here, and
`docker-compose.hostdata.yml` is the overlay that accounts for them. Don't guess the set; **read it
off the running container**, which is authoritative:

```sh
docker inspect gaiada-platform-1 --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'
```

🚨 **CHECK THE TAG IMMEDIATELY BEFORE, NOT EARLIER.** `up -d` ships whatever `GAIADA_TAG` names.
During this very ceremony another session deployed and moved the running tag from `alpha-01.050.0102a`
to `alpha-01.051.0104a`. A tag read an hour ago would have rolled the API back as a side effect of a
config change. Guard it:

```sh
grep -E '^GAIADA_TAG=' .env | cut -d= -f2
docker inspect gaiada-platform-1 --format '{{.Config.Image}}' | sed 's/.*://'
```
Equal, or stop.

### The only proof that step 7 worked

Env vars being present is not proof. **Look for the driver registering:**

```sh
docker logs --tail 400 gaiada-platform-1 2>&1 | grep -i publisher
```

✅ **Verified 2026-08-19:**
```
[social] publisher driver 'postiz' registered (networks enabled: instagram, facebook, linkedin;
         live quota probe: off; inbox surface: none (engine has no inbound API))
```

`live quota probe: off` is expected — the probe needs a Postiz route behind the missing decorator and
is gated on the D-21 fork exception. `inbox surface: none` is the OQ-4 finding, not a fault.

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

## ✅ RUN AND COMPLETED — 2026-08-19

| | |
|---|---|
| Org | **one** — `Gaiada`, id `5b858881-82a0-4eb5-a38b-e9cbe48bcbd0`, alias `default` |
| Users | **one** — `social@gaiada.com` |
| Signup | closed; container env `true` AND valid-payload canary refused |
| API key | auto-minted at registration; rotated twice after transcript exposure; superseded keys return `401` |
| ERP | both vars set, all nine reaching the container, **driver registered** |
| Blast radius | VPS 44 containers before and after; ERP 33 before and after; nothing of the owner's touched |

**Still outstanding — SMM-07's, not the ceremony's:** the `social_publisher_orgs` mapping row
(`api_key_ref = 'default'`) and a `verifyOrg` call against the adopted org.

⚠ **OPEN QUESTION worth closing before any client account exists.** The login page offers **Google
SSO**. `DISABLE_REGISTRATION=true` is verified to block the *local* signup path. Whether it also
blocks a first-time Google sign-in is **UNVERIFIED** — and if it does not, a Google-authenticated
stranger could create a principal inside the engine, which would defeat containment invariant 5 and
the entire point of this ceremony. Do not test it by trying it on the live instance.

## What this unblocks

**SMM-07** (account connect, own-brand first) → **SMM-14** (P1 e2e) → P1 closes.

It does **not** unblock client accounts: those need the platform-app reviews (Meta first — its
Business Verification is the only serial prerequisite) and the AGPL counsel sign-off (OQ-3).

Note also that **media is not yet wired** (found during SMM-10): variant rows hold composer-side
`{fileId}` descriptors while the port expects uploaded engine refs, so a post *with an attachment*
fails loudly at the publisher today. **Text-only is the honest first e2e.**
