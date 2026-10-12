# Runbook - WebDesk WS4 approval keys (M4 F1): install, switch, retire HMAC, rotate, revoke

**Status: LIVE on `gda-aicenter`, all three phases, 2026-10-12.** Kid `ws4-2026-10` (public thumbprint
`rCTA_OpUekLvOvmpMomkWj4VhHJLOmyCkOSSbnFGbl0`).

- **Phase 1** shipped with release 359.
- **Phase 2** ran at 02:34–02:39Z: W1 gave `404` with the kid, and W2 gave `404`.
- **Phase 3** ran at 02:40–02:44Z:
  - Both HMAC keys are gone.
  - The api logs `v1 (HMAC) retired`.
  - A live v1 assertion was refused with `403 ... WS4 v1 (HMAC) assertions are no longer accepted`.
  - `WS4_HMAC_RETIRED=1` probes passed 40/40.
- **Still owed:** the owner reads the audit row of the first real HIGH command. It must say `ws4_assertion_version = 2`.

The first live run found three defects in this runbook. All three are fixed below:

- The `rmdir` was run without root.
- The api restart did not recreate the container.
- The runbook named the wrong file for the WebDesk v1 key.

The evidence log is in the M4 plan's F1 section.

- **Design:** `docs/plans/2026-10-11-webdesk-m4-plan.md`, section "F1 · WS4 approval assertion made asymmetric".
- **Model:** `webdesk-editorial-keys.md` (WSK-40). This runbook follows it step for step, with its own key pair,
  its own files and its own variables.

## What the keys are

Every HIGH-impact WebDesk control command (`tenant.archive`, `release.promote`, `key.rotate`, `content.publish`, the
privacy commands, and the rest) carries `x-ws4-assertion`. This is the ERP's proof that a human approved exactly that
command with exactly those arguments, once. Two versions exist during F1:

| Version | Wire | Signed with | WebDesk holds |
|---|---|---|---|
| **v1** (being retired) | `<b64url(claims)>.<hmacHex>` | HMAC-SHA256, `WEBDESK_CONTROL_WS4_KEY` (ERP) = `WEBDESK_APPROVAL_ASSERTION_KEY` (WebDesk) | **the same secret**: a WebDesk compromise could mint approvals |
| **v2** | JWS compact: header `{"alg":"EdDSA","kid","typ":"ws4+jwt"}`, payload `{"approvalId","commandHash","exp","aud":"webdesk-control-plane"}` | Ed25519 private key, **ERP only** | the **public** key only |

WebDesk tells the versions apart by shape alone: two dot-separated parts is v1, three is v2. Single use (one approval
id, one command) is the same for both. `audit_entries.ws4_assertion_version` records which version was verified:
1, 2, or NULL when not recorded (migration 0018).

| Half | Where | Format | Who reads it |
|---|---|---|---|
| **Private signing key** (secret) | ERP host: `/etc/gaiada/webdesk-ws4/ws4-signing.<kid>.pk8.pem`. Dir `0700 root:root`, file `0400 root:root`. | PKCS8 PEM | `platform` container, read-only mount at `/run/webdesk-ws4/` (`infra/compose/docker-compose.vps.yml`) |
| **Public JWKS** (not secret, still not in git) | WebDesk host: `/etc/webdesk/ws4/ws4.jwks.json`. Same owner and mode class as `/etc/webdesk/editorial/editorial.jwks.json`. | `{"keys":[{kty:OKP,crv:Ed25519,kid,x,use:sig,alg:EdDSA}]}` with 1 key, or 2 during a rotation | webdesk `api`, read-only FILE mount (`webdesk/docker-compose.aicenter.yml`) |

**This is a NEW key pair. Never reuse the editorial key.** The two channels must not be able to replay each other's
tokens. WebDesk enforces that in three ways:

1. It **refuses to boot** if the WS4 JWKS and the editorial JWKS share a kid or a public key.
2. It looks a WS4 kid up **only** in the WS4 set.
3. It checks `typ` (`ws4+jwt` against `wd-editorial+jwt`) and `aud` (`webdesk-control-plane` against
   `urn:gaiada:webdesk:control`).

Both halves are on `gda-aicenter` today, because the ERP and WebDesk share that box. Keep them in their separate
directories anyway: the WebDesk side must never be able to read the private key.

| Variable | Side | Value |
|---|---|---|
| `WEBDESK_CONTROL_WS4_SIGNING_KID` | ERP `.env` | The active kid, e.g. `ws4-2026-10`. **Empty means the ERP mints v1.** Compose derives the key path from it, so switching is ONE value. |
| `WEBDESK_CONTROL_WS4_SIGNING_KEY_DIR` | ERP `.env` | Leave unset (`/etc/gaiada/webdesk-ws4`). |
| `WEBDESK_CONTROL_WS4_SIGNING_KEY_FILE` | ERP compose | Set by `docker-compose.vps.yml` to `/run/webdesk-ws4/ws4-signing.<kid>.pk8.pem`. Do not set it in `.env`. |
| `WEBDESK_CONTROL_WS4_KEY` | ERP `.env` | The v1 HMAC key. Kept through phase 2, removed in phase 3 (**removed 2026-10-12**). |
| `WEBDESK_WS4_JWKS_FILE` | WebDesk | Set by the aicenter overlay to `/etc/webdesk/ws4/ws4.jwks.json`. Do not put it in `/etc/webdesk/.env`. |
| `WEBDESK_APPROVAL_ASSERTION_KEY` | WebDesk `/etc/webdesk/.env` (**not** `.env.control`: `webdesk/docker-compose.yml` names it under `environment:`, which outranks `env_file:`, so only the interpolation file can supply it) | The v1 HMAC key, equal to the ERP's. Kept through phase 2, removed in phase 3 (**removed 2026-10-12**). In production, an unset value or a published placeholder means v1 is refused. |

**Kid convention:** `ws4-YYYY-MM`. On a second rotation within the same month, add a suffix (`ws4-2026-10b`). The
keygen refuses a `--channel ws4` kid that does not start with `ws4-`.

## What each failure looks like (read before touching anything)

| Situation | Effect | Where you see it |
|---|---|---|
| ERP kid **unset** | ERP mints **v1** (as before F1). | platform log: nothing new |
| ERP kid **set**, key file absent, unreadable, a directory, or not Ed25519 | ERP **boots**. Every WS4-bearing WebDesk call answers 503 `webdesk_control_not_configured` and is **never sent**. It **never** falls back to v1 silently. Reads and non-HIGH writes are unaffected. | platform log: `WS4 v2 signing key NOT usable (<reason>)` |
| WebDesk WS4 JWKS absent (or a directory: see the footgun) | api **boots**. v2 is refused with `ws4-v2-unavailable`. v1 still works while its key is set. | api log: `WS4 gate: ...; v2 (EdDSA) unavailable: ...` |
| WebDesk WS4 JWKS truncated, non-Ed25519, holding a private `d`, holding 0 or 3+ keys, or with a duplicate kid | api **refuses to boot** (crash loop). The message names the file and the reason, never its contents. | api log: `WS4 JWKS from WEBDESK_WS4_JWKS_FILE (...) refused: ...` |
| WebDesk WS4 JWKS shares a kid or a key with the editorial JWKS | api **refuses to boot**. | api log: `... is the SAME public key as editorial kid ...` or `... is also in the editorial JWKS` |
| ERP signs with a kid that is not in the WS4 JWKS | 403 `WS4 assertion rejected: WS4 v2 kid "<kid>" is not in the pinned WS4 JWKS`. The approval row goes `failed`. | decide() response, Approvals inbox |
| WebDesk has neither the v1 key nor the v2 JWKS (production) | api **boots**. Every HIGH command is refused, fail closed. | api log (ERROR): `NO WS4 assertion can verify: every HIGH-impact command will be refused` |
| Clock skew between the two hosts | `exp` is checked as `now < exp` with no extra skew (v1's rule). The ERP mints 60 s. | NTP is a WSK-63 acceptance criterion; one box today |

**Footgun: a missing JWKS file becomes a directory.** The overlay bind-mounts a FILE. If `/etc/webdesk/ws4/ws4.jwks.json`
does not exist when the api container is created, Docker creates an empty **directory** at that host path. The api
treats a directory as "v2 unavailable", which is safe. Phase 1 ships the mount before any key exists, so this
directory WILL be there. The install step below must `rmdir` it before it writes the real file. Always check with
`sudo stat -c %F`. **Test and remove it as root**, because `/etc/webdesk` is `0700 webdesk-svc`. A plain
`[ -d ... ]` run by the operator is simply false, so the `rmdir` is skipped. `install` then writes the key file
INSIDE the leftover directory, and the api still reports "not a regular file". That happened on the first live run.

**Footgun: the file mount pins an inode until restart.** Every step below restarts the api after changing the file.
The restart is also what loads the new key set: the api reads the JWKS once, at boot.

**"Restart api" in this runbook always means a recreate.** On the box, run
`sudo -n env DOCKER_HOST=unix:///run/user/940/docker.sock docker compose --env-file /etc/webdesk/.env -p webdesk -f docker-compose.yml -f docker-compose.aicenter.yml -f docker-compose.aicenter-release.yml up -d --no-deps --no-build --force-recreate api`
from `/home/Hansel/gaiada-webdesk/webdesk`. WebDesk runs on the rootless daemon since 2026-10-12, so `sudo` must be followed by `env DOCKER_HOST=...` (`sudo` resets the environment). The old `sudo docker compose ...` talks to the rootful daemon, which no longer runs WebDesk. Every other WebDesk `docker` command below takes the prefix `DOCKER_HOST=unix:///run/user/940/docker.sock`.

- Without `--force-recreate`, a changed file under an unchanged compose config gives `Container webdesk-api-1 Running`.
  Nothing restarts, and the old key set stays loaded.
- Before you run it, check that `config --images` shows the digest that is already running.

## Probes (none writes anything)

Run them inside the ERP platform container. Each prints one JSON line per probe, never a key or a token.

| Probe | What it sends | What a pass looks like | Why the answer proves it |
|---|---|---|---|
| **W1. Pairing (v2)** | `tenant.archive` for a tenant that does **not exist**, with a correct v2 assertion signed by the configured key | **`404` (tenant not found)** | Layer 4 verified the signature against the pinned WS4 JWKS with this kid, checked the hash and found the approval unused; only then did the service look the tenant up. A pairing failure answers `403 WS4 assertion rejected: ...` instead. |
| **W2. Overlap (v1)** | The same call minted as v1 from the HMAC key | **`404`** while both versions are accepted; **`403 ... WS4 v1 (HMAC) assertions are no longer accepted ...`** once WebDesk has retired v1 | — |

Neither probe writes an audit row, and neither consumes a real approval: the approval id is random and the command
fails before the envelope.

```bash
docker exec -i gaiada-platform-1 node - <<'JS'
const { randomUUID } = require("node:crypto");
const { createWebdeskControlClient } = require("/app/dist/modules/webdev/webdesk-control-client.js");
const { loadWs4SigningKey } = require("/app/dist/modules/webdev/webdesk-ws4-assertion.js");
(async () => {
  const slug = `ws4-probe-${randomUUID().slice(0, 8)}`; // never exists
  const archive = (c) => c.send({ command: "tenant.archive", method: "POST", path: "/control/v1/tenants/:tenantSlug/archive",
    params: { tenantSlug: slug }, idempotencyKey: `probe-${randomUUID()}`, ws4: { approvalId: randomUUID() } })
    .then((r) => ({ status: r.status, detail: (r.json && (r.json.message || r.json.detail)) || null }))
    .catch((e) => ({ error: e.code || e.name, detail: e.message }));
  const l = loadWs4SigningKey({ keyFile: process.env.WEBDESK_CONTROL_WS4_SIGNING_KEY_FILE || "", kid: process.env.WEBDESK_CONTROL_WS4_SIGNING_KID || "" });
  if (l.state === "configured") {
    const c = createWebdeskControlClient({ ws4Signing: l.signing, ws4SigningError: undefined });
    console.log(JSON.stringify({ probe: "W1", kid: l.signing.kid, ...(await archive(c)), want: "404 tenant not found" }));
    c.close();
  } else console.log(JSON.stringify({ probe: "W1", skipped: l.state, reason: l.reason }));
  if (process.env.WEBDESK_CONTROL_WS4_KEY) {
    const c = createWebdeskControlClient({ ws4Signing: undefined, ws4SigningError: undefined });
    console.log(JSON.stringify({ probe: "W2", ...(await archive(c)), want: "404 while v1 is accepted; 403 v1-retired after phase 3" }));
    c.close();
  } else console.log(JSON.stringify({ probe: "W2", skipped: "no WEBDESK_CONTROL_WS4_KEY on the ERP" }));
})();
JS
```

**Reading the output.** Once the kid is set, the platform log prints `WS4 assertions: v2 (EdDSA, kid ...)` before
**each** probe, W2 included. That line comes from loading the config, which both clients do. W2 still mints v1,
because its `ws4Signing: undefined` override is applied last, over the config.

**To prove that a specific RETIRED kid is refused:** run W1 with
`loadWs4SigningKey({ keyFile: "/run/webdesk-ws4/ws4-signing.<old>.pk8.pem", kid: "<old>" })`. It must answer
`403 WS4 assertion rejected: WS4 v2 kid "<old>" is not in the pinned WS4 JWKS`. This only works while the old key
file is still in the mount; delete the file afterwards.

**Phase 2 acceptance (one real write).** Use the normal ERP approval flow (an Approvals inbox decision) for one real
HIGH command. Then **the owner** reads its audit row. Live DB reads are the owner's, so hand over this ready command:

```bash
# <webdesk-postgres> = the webdesk project's postgres container (check with `DOCKER_HOST=unix:///run/user/940/docker.sock docker ps`; the name is not pinned here).
# WebDesk's containers live on the rootless daemon, so the prefix below is required.
# Platform-scope commands (tenant.archive, ...) need the platform GUC; a tenant-scope command needs
# SET webdesk.tenant_ctx = '<tenant uuid>' instead. FORCE RLS: without the right GUC you see ZERO rows,
# and zero rows is NOT a failure of the version.
DOCKER_HOST=unix:///run/user/940/docker.sock docker exec -i <webdesk-postgres> psql -U webdesk_owner -d webdesk -Atc \
  "SET webdesk.platform_ctx = 'true'; SELECT action, ws4_assertion_version FROM audit_entries WHERE ws4_approval_id = '<approvalId>'"
```

Pass: one row, `ws4_assertion_version = 2`.

## Generating a key pair (shared by install and rotation)

Generate on the box, in a root-only scratch dir, with the script from the deployed tree. Do not generate on a laptop
and copy. It is the editorial script with `--channel ws4`. It prints file paths, kids and public thumbprints only,
creates the private key `0400` with O_EXCL, and refuses to overwrite.

```bash
sudo install -d -m 0700 /root/ws4-keygen
# <deploy-tree> = the synced repo checkout on the box; the script needs only Node.
sudo docker run --rm -v /root/ws4-keygen:/out -v <deploy-tree>/platform-nest/scripts:/s:ro node:22-alpine \
  node /s/webdesk-editorial-keygen.mjs generate --channel ws4 --kid <kid> --out /out [--jwks /out/current.jwks.json]
```

The output is `ws4-signing.<kid>.pk8.pem` (the ERP's secret) and `ws4.jwks.json` (WebDesk's public file).
`--jwks` (rotation only) **appends** the new public key and refuses to hold more than two. `inspect` and `remove` work
on `ws4.jwks.json` as they do on the editorial file.

## Phase 1: WebDesk accepts both (ships with the release; no key needed)

The F1 release deploys the verifier, migration 0018 and the overlay's `/etc/webdesk/ws4/ws4.jwks.json` mount. With no
key installed:

- The mount becomes an empty directory (the footgun).
- v2 is unavailable.
- v1 keeps working exactly as before. Nothing changes for the ERP.

After the deploy:

1. **Check the api log.** Look for `WS4 gate: v1 (HMAC) accepted (WEBDESK_APPROVAL_ASSERTION_KEY set); v2 (EdDSA)
   unavailable: ... not a regular file ...`.
2. **Check the migration.** `0018_ws4_assertion_version.sql` must be in the WebDesk ledger.
3. **Run W2.** It must give `404`.

## Phase 2: the ERP signs v2

1. **Generate:** use the command above with `--channel ws4 --kid ws4-2026-10` and no `--jwks`.
2. **WebDesk public JWKS. Install it FIRST, so WebDesk can verify before the ERP signs.**
   1. Remove the directory the phase-1 mount left, **as root** (see the footgun):
      `sudo sh -c 'd=/etc/webdesk/ws4/ws4.jwks.json; if [ -d "$d" ]; then ls -la "$d"; rm -f "$d/ws4.jwks.json"; rmdir "$d"; fi'`.
      The `rm -f` cleans up after an earlier `install` that landed inside the directory.
   2. Run `sudo install -d -m 0750 --owner=$(sudo stat -c %U /etc/webdesk/certs) --group=$(sudo stat -c %G /etc/webdesk/certs) /etc/webdesk/ws4`.
      The `stat` needs `sudo` too, for the same reason.
   3. Run `sudo install -m 0444 /root/ws4-keygen/ws4.jwks.json /etc/webdesk/ws4/ws4.jwks.json`. It must be readable by
      "other": the api runs with `cap_drop: ALL`. Check that `sudo stat -c %F` says `regular file`.
   4. **Restart api.** Use the exact recreate command from "Restart api" above. A plain `up -d` leaves the old api
      running, because the compose config did not change.
   5. Expected log: `WS4 gate: v1 (HMAC) accepted ...; v2 (EdDSA) accepted, WS4 JWKS from WEBDESK_WS4_JWKS_FILE (...): kid(s) ws4-2026-10`.
      If the api crash-loops instead, read the `refused:` reason. A shared key with the editorial JWKS means the
      wrong file was installed.
3. **ERP private key.** Run
   `sudo install -d -m 0700 -o root -g root /etc/gaiada/webdesk-ws4 && sudo install -m 0400 -o root -g root /root/ws4-keygen/ws4-signing.ws4-2026-10.pk8.pem /etc/gaiada/webdesk-ws4/`.
4. **ERP switch.**
   1. Set `WEBDESK_CONTROL_WS4_SIGNING_KID=ws4-2026-10` in the ERP `.env`.
   2. Run `up -d platform` with the FULL server compose file set. `vps.yml` alone is not a valid project, and a
      stale image tag in `.env` rolls back silently, so check both.
   3. The platform deploy must carry this branch: the compose passthrough and the client change.
   4. Expected log, on the first WebDesk call: `WS4 assertions: v2 (EdDSA, kid ws4-2026-10)`.
5. **Probe.**
   1. Run W1 and W2. W1 must give `404` with kid `ws4-2026-10`, and W2 must give `404`: both versions are accepted.
   2. Then run the phase-2 acceptance write. Its row must say `ws4_assertion_version = 2`.
6. **Clean up:** `sudo sh -c 'shred -u /root/ws4-keygen/*.pem && rm -rf /root/ws4-keygen'`. The glob must expand
   **as root**. With a plain `sudo shred ... /root/ws4-keygen/*.pem` the operator's shell cannot list `/root`, so the
   private key stays behind (the editorial lesson).

## Phase 3: remove HMAC from both sides

Only after phase 2 has run long enough that **no v1 assertion is still arriving**. The owner checks that recent HIGH
rows are all version 2:

```sql
SELECT ws4_assertion_version, count(*) FROM audit_entries
 WHERE ws4_approval_id IS NOT NULL AND at > now() - interval '7 days' GROUP BY 1;
```

Run it under the platform GUC and under each tenant's GUC, or as the backup role. Expect only `2`, plus `NULL` for
any pre-0018 rows.

**When the query is not needed.** The assertion is minted at send time, not stored, and lives 60 s. If no container
holds a non-empty v1 key except the one platform you just switched, then no v1 assertion can be in flight once 60 s
have passed since its recreate. Check that with
`for h in '' unix:///run/user/940/docker.sock; do for c in $(DOCKER_HOST=$h docker ps --format '{{.Names}}'); do DOCKER_HOST=$h docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $c | grep -q '^WEBDESK_CONTROL_WS4_KEY=.' && echo "$c ($h)"; done; done`
(it walks both daemons: the ERP platform is on the rootful one, WebDesk on the rootless one; an empty `DOCKER_HOST` means the default rootful socket).
That is how phase 3 ran on 2026-10-12, by the owner's decision ("phase 3 right after if v2 is proven"), about 2
minutes after the switch.

1. **ERP first: stop minting v1 entirely.** Remove `WEBDESK_CONTROL_WS4_KEY` from the ERP `.env` (delete the line)
   and run `up -d platform`. The client now mints only v2. If the v2 key ever became unusable, WS4 calls would answer
   503 rather than fall back. Run W1: it must still give `404`.
2. **WebDesk: retire v1.**
   1. Back up `/etc/webdesk/.env` to a root-only directory. Then remove `WEBDESK_APPROVAL_ASSERTION_KEY` from it:
      `sudo sed -i '/^WEBDESK_APPROVAL_ASSERTION_KEY=/d' /etc/webdesk/.env`.
      It lives in `.env`, **not** in `.env.control` (see the variables table).
   2. Restart api (the recreate command above). Then check that
      `DOCKER_HOST=unix:///run/user/940/docker.sock docker exec webdesk-api-1 sh -c '[ -z "$WEBDESK_APPROVAL_ASSERTION_KEY" ] && echo absent'` prints `absent`.
   3. Expected log: `WS4 gate: v1 (HMAC) retired: WEBDESK_APPROVAL_ASSERTION_KEY is not set; v2 (EdDSA) accepted ...`.
3. **Prove v1 is refused.** There is no v1 key left on the ERP to mint with, and that is the point. Check two things
   instead:
   1. The boot line above.
   2. The verifier row in `webdesk/api/test/ws4-assertion-v2-matrix.spec.ts`, "v1 presented after the HMAC key is
      unset", which answers `WS4 v1 (HMAC) assertions are no longer accepted`.

   **Live proof (done 2026-10-12).** The retired key is still in the root-only `.env` backup from step 1. Feed it to
   the probe through **stdin**, so it is never in argv or printed. W2 then mints a real v1. Run this from the ERP
   compose dir:
   ```bash
   b=.env.bak-<the step-1 backup>; v=$(grep '^WEBDESK_CONTROL_WS4_KEY=' "$b" | cut -d= -f2-); v=${v#\"}; v=${v%\"}
   { printf "process.env.WEBDESK_CONTROL_WS4_KEY='%s';\n" "$v"; cat ws4-probe.js; } | docker exec -i gaiada-platform-1 node -; unset v
   ```
   `ws4-probe.js` is the JS body of the probe above. Pass:
   - W1 gives `404`.
   - W2 gives `403 WS4 assertion rejected: WS4 v1 (HMAC) assertions are no longer accepted: ...`.
4. **Containment probe.** From now on, run `WS4_HMAC_RETIRED=1 bash webdesk/ops/probes/containment-probe.sh`. Probe 6
   no longer lists `WEBDESK_CONTROL_WS4_KEY` as shared by design, so it FAILS if that value reappears anywhere in the
   WebDesk surface. It is not in the ERP env any more, so the sweep just has one fewer needle; the switch keeps the
   exemption from silently returning. Use a copy of the probe that has the OTLP bearer in its retired-mode list
   (main `28e2580a`, first released after 359). An older deployed tree fails with
   `ERP secret values present in the surface: WEBDESK_OTLP_BEARER_TOKEN`; that is a stale probe, not a leak.
5. **Secrets layout.** WebDesk now holds no control-channel signing secret at all, matching the editorial channel
   (WSK-D39). Record the phase-3 date in the M4 plan's F1 section. **Done: 2026-10-12.**
6. **Backups that still hold the dead key.** These copies still contain the v1 key:
   - the ERP's `.env.bak-m4f1*` files;
   - `/root/m4f1-backup/env.*` (the WebDesk `.env` taken before phase 3);
   - the older `/etc/webdesk/.env.bak-*` files.

   Nothing accepts the key any more. Keep the copies for 14 days as the phase-3 rollback, then shred them, after
   2026-10-26.

## Rotation (kid N to kid N+1), zero downtime

The order is the whole point. WebDesk learns the new key **before** the ERP uses it, and forgets the old one only
**after** no assertion signed with it can still be valid.

1. **Generate kid N+1, appended to the live JWKS.**
   1. Run `sudo cp /etc/webdesk/ws4/ws4.jwks.json /root/ws4-keygen/current.jwks.json`.
   2. Run the generate command with `--channel ws4 --kid <N+1> --jwks /out/current.jwks.json`.
   3. Check the result with `... webdesk-editorial-keygen.mjs inspect --jwks /out/ws4.jwks.json`. It must list both kids.
2. **WebDesk trusts both.**
   1. Run `sudo install -m 0444 /root/ws4-keygen/ws4.jwks.json /etc/webdesk/ws4/ws4.jwks.json`, then **restart api**.
   2. Expected log: `kid(s) <N>, <N+1>`.
   3. Run W1 again. It must still give `404` with kid N.
3. **ERP switches.**
   1. Install `ws4-signing.<N+1>.pk8.pem` into `/etc/gaiada/webdesk-ws4/` (phase 2, step 3).
   2. Set `WEBDESK_CONTROL_WS4_SIGNING_KID=<N+1>` and run `up -d platform`.
   3. Run W1. It must give `404` with kid N+1.
4. **Wait, then WebDesk forgets kid N.**
   1. Wait **at least 10 minutes**: twice the 300 s ceiling the ERP allows on a WS4 TTL. The default is 60 s, but
      WebDesk does not cap it.
   2. Run `... webdesk-editorial-keygen.mjs remove --jwks /out/ws4.jwks.json --kid <N> --out /out/after.jwks.json`.
   3. Install `after.jwks.json` as the JWKS and **restart api**. Expected log: `kid(s) <N+1>`.
   4. Run W1 with the old key. It must give `403 ... WS4 v2 kid "<N>" is not in the pinned WS4 JWKS`.
   5. Delete `ws4-signing.<N>.pk8.pem` from the ERP dir.
5. Shred the scratch dir (phase 2, step 6).

## Emergency revocation (kid N is compromised)

1. **Remove the kid on WebDesk.** Run `remove --kid <N>` on the live JWKS, install the result, and **restart api**.
   - If N is the only kid, `remove` refuses to leave an empty set. In that case, stop v2 outright: **move the JWKS
     file away** (`sudo mv … /root/`) and restart api. v2 then answers `ws4-v2-unavailable`.
   - After phase 3 that means every HIGH command is refused, fail closed, until a new key is installed. That is the
     intended failure mode: irreversible commands stop, and `/v1` delivery keeps serving.
   - Before phase 3, v1 still works while its key is set.
2. **Install a fresh kid.** Generate it and run phase-2 steps 2 to 5 with it.
3. **Review the exposure window.** Check WebDesk `audit_entries` rows with `ws4_assertion_version = 2` against the
   ERP's approval records. Every `ws4_approval_id` must match an approval the ERP actually decided.
