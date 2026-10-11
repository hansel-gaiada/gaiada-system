# Runbook - WebDesk WS4 approval keys (M4 F1): install, switch, retire HMAC, rotate, revoke

**Status: CODE BUILT, NOT LIVE.** Phases 1 and 2 of the design exist as code on branch `webdesk/m4-f1-ws4-eddsa`.
The local unit matrix passes. The Linux and CI suites, the sumopod gate and every live step below are still to be
run. **No WS4 key pair exists yet, and nothing here has been run on `gda-aicenter`.** The orchestrator runs every
live step.

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
| `WEBDESK_CONTROL_WS4_KEY` | ERP `.env` | The v1 HMAC key. Kept through phase 2, removed in phase 3. |
| `WEBDESK_WS4_JWKS_FILE` | WebDesk | Set by the aicenter overlay to `/etc/webdesk/ws4/ws4.jwks.json`. Do not put it in `/etc/webdesk/.env`. |
| `WEBDESK_APPROVAL_ASSERTION_KEY` | WebDesk `/etc/webdesk/.env.control` | The v1 HMAC key, equal to the ERP's. Kept through phase 2, removed in phase 3. In production, an unset value or a published placeholder means v1 is refused. |

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
`stat -c %F`.

**Footgun: the file mount pins an inode until restart.** Every step below restarts the api after changing the file.
The restart is also what loads the new key set: the api reads the JWKS once, at boot.

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

**To prove that a specific RETIRED kid is refused:** run W1 with
`loadWs4SigningKey({ keyFile: "/run/webdesk-ws4/ws4-signing.<old>.pk8.pem", kid: "<old>" })`. It must answer
`403 WS4 assertion rejected: WS4 v2 kid "<old>" is not in the pinned WS4 JWKS`. This only works while the old key
file is still in the mount; delete the file afterwards.

**Phase 2 acceptance (one real write).** Use the normal ERP approval flow (an Approvals inbox decision) for one real
HIGH command. Then **the owner** reads its audit row. Live DB reads are the owner's, so hand over this ready command:

```bash
# <webdesk-postgres> = the webdesk project's postgres container (check with docker ps; the name is not pinned here).
# Platform-scope commands (tenant.archive, ...) need the platform GUC; a tenant-scope command needs
# SET webdesk.tenant_ctx = '<tenant uuid>' instead. FORCE RLS: without the right GUC you see ZERO rows,
# and zero rows is NOT a failure of the version.
docker exec -i <webdesk-postgres> psql -U webdesk_owner -d webdesk -Atc \
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
   1. Remove the directory the phase-1 mount left: `[ -d /etc/webdesk/ws4/ws4.jwks.json ] && sudo rmdir /etc/webdesk/ws4/ws4.jwks.json`.
   2. Run `sudo install -d -m 0750 --owner=$(stat -c %U /etc/webdesk/certs) --group=$(stat -c %G /etc/webdesk/certs) /etc/webdesk/ws4`.
   3. Run `sudo install -m 0444 /root/ws4-keygen/ws4.jwks.json /etc/webdesk/ws4/ws4.jwks.json`. It must be readable by
      "other": the api runs with `cap_drop: ALL`.
   4. **Restart api** with the box's usual compose file set, `--env-file /etc/webdesk/.env` and
      `up -d --no-deps --no-build api` (see `webdesk-control-channel.md`, corrections 1 and 3).
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

1. **ERP first: stop minting v1 entirely.** Remove `WEBDESK_CONTROL_WS4_KEY` from the ERP `.env` (delete the line)
   and run `up -d platform`. The client now mints only v2. If the v2 key ever became unusable, WS4 calls would answer
   503 rather than fall back. Run W1: it must still give `404`.
2. **WebDesk: retire v1.**
   1. Remove `WEBDESK_APPROVAL_ASSERTION_KEY` from `/etc/webdesk/.env.control`.
   2. Restart api.
   3. Expected log: `WS4 gate: v1 (HMAC) retired: WEBDESK_APPROVAL_ASSERTION_KEY is not set; v2 (EdDSA) accepted ...`.
3. **Prove v1 is refused.** There is no v1 key left on the ERP to mint with, and that is the point. Check two things
   instead:
   1. The boot line above.
   2. The verifier row in `webdesk/api/test/ws4-assertion-v2-matrix.spec.ts`, "v1 presented after the HMAC key is
      unset", which answers `WS4 v1 (HMAC) assertions are no longer accepted`.
4. **Containment probe.** From now on, run `WS4_HMAC_RETIRED=1 bash webdesk/ops/probes/containment-probe.sh`. Probe 6
   no longer lists `WEBDESK_CONTROL_WS4_KEY` as shared by design, so it FAILS if that value reappears anywhere in the
   WebDesk surface. It is not in the ERP env any more, so the sweep just has one fewer needle; the switch keeps the
   exemption from silently returning.
5. **Secrets layout.** WebDesk now holds no control-channel signing secret at all, matching the editorial channel
   (WSK-D39). Record the phase-3 date in the M4 plan's F1 section.

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
