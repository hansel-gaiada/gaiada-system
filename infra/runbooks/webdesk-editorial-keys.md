# Runbook - WebDesk editorial assertion keys (WSK-40): install, rotate, revoke

**Status: PROTOTYPED.** The code and this procedure are proved on the sumopod gate (see "As executed on the dev stack" at the
end). **No live key exists yet, and nothing here has been run on `gda-aicenter`.** The orchestrator runs every live step.
Design: `docs/plans/2026-10-10-webdesk-write-plane-design.md` section 5 (Decision D). Ruling: `docs/blueprints/webdesk-design-v2.md`
section 14, WSK-D39 ("the delivery surface verifies but never mints").

## What the keys are

Every WebDesk content write (`content.create|update|restoreVersion|publish|schedule|unpublish|delete`) carries
`x-webdesk-editorial-assertion`. This is a compact Ed25519 JWS that the ERP signs for exactly that command, its arguments, and the
person Cerbos authorised. WebDesk verifies it against a pinned public key set and consumes its `jti` once.

| Half | Where | Format | Who reads it |
|---|---|---|---|
| **Private signing key** (secret) | ERP host: `/etc/gaiada/webdesk-editorial/editorial-signing.<kid>.pk8.pem`, dir `0700 root:root`, file `0400 root:root` | PKCS8 PEM | `platform` container, read-only mount at `/run/webdesk-editorial/` (`infra/compose/docker-compose.vps.yml`) |
| **Public JWKS** (not secret, still not in git) | WebDesk host: `/etc/webdesk/editorial/editorial.jwks.json`, same owner and mode class as `/etc/webdesk/certs/ca-cert.pem` | `{"keys":[{kty:OKP,crv:Ed25519,kid,x,use:sig,alg:EdDSA}]}`, with 1 key, or 2 during a rotation | webdesk `api`, read-only FILE mount (`webdesk/docker-compose.aicenter.yml`) |

Both halves are on `gda-aicenter` today, because the ERP and WebDesk share that box. Keep them in their separate directories anyway:
the WebDesk side must never be able to read the private key.

| Variable | Side | Value |
|---|---|---|
| `WEBDESK_EDITORIAL_SIGNING_KID` | ERP `.env` | the active kid, e.g. `wde-2026-10`. The compose file derives the key path from it, so switching keys means changing this ONE value. |
| `WEBDESK_EDITORIAL_TTL_SEC` | ERP `.env` | leave unset (60 s). The signer refuses to configure above 120, because WebDesk refuses any lifetime over 120 s. |
| `WEBDESK_EDITORIAL_KEY_DIR` | ERP `.env` | leave unset (`/etc/gaiada/webdesk-editorial`) |
| `WEBDESK_EDITORIAL_JWKS_FILE` | WebDesk | set by the aicenter overlay to `/etc/webdesk/editorial/editorial.jwks.json`. Do not put it in `/etc/webdesk/.env`. |

**Kid convention:** `wde-YYYY-MM`. On a second rotation within the same month, add a suffix (`wde-2026-10b`). The kid allows 1 to 64 characters from `[A-Za-z0-9._-]`.

## What each failure looks like (read before touching anything)

| Situation | Effect | Where you see it |
|---|---|---|
| ERP key file absent, unreadable, or not Ed25519; kid unset | ERP **boots**. Every WebDesk content command answers 503 `webdesk_editorial_signer_not_configured` and is never sent. | platform log: `editorial assertion signer NOT configured (<reason>)` |
| WebDesk JWKS absent (or a directory: see the footgun below) | api **boots**, so `/v1` delivery stays up. Every content write answers 503 `editorial-keys-not-configured`. | api log: `editorial keys not configured (...)` |
| WebDesk JWKS present but truncated, non-Ed25519, holding a private `d`, holding 0 or 3+ keys, or with a duplicate kid | api **refuses to boot** (crash loop), with the reason and the file named, never its contents | api log: `editorial JWKS from WEBDESK_EDITORIAL_JWKS_FILE (...) refused: ...` |
| ERP signs with a kid that is not in the JWKS | 401 `editorial-assertion-unknown-key`; the approval row goes `failed` with `webdesk_refused: 401 editorial-assertion-unknown-key` | decide() response, Approvals inbox |
| WebDesk Redis (queue store) down | 503 `editorial-assertion-store-unavailable` (fail closed). Nothing is written. | api log: `refusing a content write: editorial jti replay store unavailable` |
| Clock skew of more than 10 s between the two hosts | 401 `editorial-assertion-expired` | NTP is a WSK-63 acceptance criterion; one box today |

**Footgun: a missing JWKS file becomes a directory.** The overlay bind-mounts a FILE. If
`/etc/webdesk/editorial/editorial.jwks.json` does not exist when the api container is created, Docker creates an empty
**directory** at that host path. The api treats a directory as "not configured" (503), which is safe. But the install step below
must `rmdir` it before it writes the real file. Always check with `stat -c %F`.

**Footgun: the file mount pins an inode until restart.** Every step below restarts the api after changing the file. That restart is
also what loads the new key set, because the api reads the JWKS once, at boot.

## Probes (no content is written by either)

**P1. WebDesk side configured?** Run this in the ERP platform container. It sends a content.create with NO editorial assertion, for a
tenant that does not exist. `401 editorial-assertion-missing` means the real verifier is bound and has keys.
`503 editorial-keys-not-configured` means it has none. L1 to L3 must pass to reach this layer, so the probe also proves the channel.

**P2. The pairing.** The ERP signs a content.create with the live key, and the `cmh` is deliberately computed over a different body.
`403 editorial-assertion-command-mismatch` proves that the signature verified against the pinned JWKS with this kid. The cmh check
runs after the signature check, so the probe gets that far without writing anything. The tenant does not need to exist.

```bash
# Inside the platform container. Prints one JSON line per probe; never a key or a token.
docker exec -i gaiada-platform-1 node - <<'JS'
const { randomUUID } = require("node:crypto");
const { getWebdeskControlClient } = require("/app/dist/modules/webdev/webdesk-control-client.js");
const { loadWebdeskEditorialSigner } = require("/app/dist/modules/webdev/webdesk-editorial-signer.js");
const { computeCommandHash, commandArgsAsZoneBSeesThem } = require("/app/dist/modules/webdev/webdesk-ws4-assertion.js");
(async () => {
  const client = getWebdeskControlClient();
  const params = { tenantSlug: "wsk40-probe", siteId: randomUUID() };
  const body = { collectionKey: "page", locale: "en", slug: "page.probe", fields: {} };
  const send = (editorialAssertion) => client.send({ command: "content.create", method: "POST",
    path: "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items", params, body,
    idempotencyKey: `probe-${randomUUID()}`, ...(editorialAssertion ? { editorialAssertion } : {}) });
  const slug = (r) => (r.json && r.json.type ? r.json.type.split("/").pop() : null);
  const p1 = await send(undefined);
  console.log(JSON.stringify({ probe: "P1", status: p1.status, slug: slug(p1), want: "401 editorial-assertion-missing" }));
  const l = loadWebdeskEditorialSigner();
  if (l.state !== "configured") { console.log(JSON.stringify({ probe: "P2", error: l.reason })); process.exit(1); }
  const wrongBody = { ...body, slug: "page.not-what-is-sent" };
  const jws = await l.signer.sign({ sub: "probe-operator", pk: "human", ten: params.tenantSlug, site: params.siteId,
    cmd: "content.create", cmh: computeCommandHash("content.create", commandArgsAsZoneBSeesThem(params, wrongBody)) });
  const p2 = await send(jws);
  console.log(JSON.stringify({ probe: "P2", kid: l.signer.kid, status: p2.status, slug: slug(p2), want: "403 editorial-assertion-command-mismatch" }));
  client.close();
})();
JS
```

To prove that a specific RETIRED kid is refused, also run P2 with that kid's key:
`loadWebdeskEditorialSigner({ keyFile: "/run/webdesk-editorial/editorial-signing.<old>.pk8.pem", kid: "<old>" })`
must answer `401 editorial-assertion-unknown-key`. This only works while the old key file is still in the mount; delete it after.

## Generating a key pair (shared by install and rotation)

Generate on the box, in a root-only scratch dir, with the script from the deployed tree. Do not generate on a laptop and copy. The
script prints file paths, kids and public thumbprints only. It creates the private key `0400` with O_EXCL, and refuses to overwrite.

```bash
sudo install -d -m 0700 /root/wde-keygen
# <deploy-tree> = the synced repo checkout on the box; the script needs only Node.
sudo docker run --rm -v /root/wde-keygen:/out -v <deploy-tree>/platform-nest/scripts:/s:ro node:22-alpine \
  node /s/webdesk-editorial-keygen.mjs generate --kid <kid> --out /out [--jwks /out/current.jwks.json]
```

`--jwks` (rotation only) **appends** the new public key to the given JWKS. It refuses if the result would hold more than two keys.

## First install (no key exists yet)

1. **Generate:** use the command above with `--kid wde-2026-10` and no `--jwks`.
2. **ERP private key:**
   `sudo install -d -m 0700 -o root -g root /etc/gaiada/webdesk-editorial && sudo install -m 0400 -o root -g root /root/wde-keygen/editorial-signing.wde-2026-10.pk8.pem /etc/gaiada/webdesk-editorial/`
3. **WebDesk public JWKS:**
   1. If a directory already sits at the path (the footgun), remove it: `[ -d /etc/webdesk/editorial/editorial.jwks.json ] && sudo rmdir /etc/webdesk/editorial/editorial.jwks.json`.
   2. Run `sudo install -d -m 0750 --owner=$(stat -c %U /etc/webdesk/certs) --group=$(stat -c %G /etc/webdesk/certs) /etc/webdesk/editorial`.
   3. Run `sudo install -m 0444 /root/wde-keygen/editorial.jwks.json /etc/webdesk/editorial/editorial.jwks.json`.
4. **WebDesk api:** deploy the image that carries WSK-40 with the overlay that carries the mount, using the box's usual compose file
   set, `--env-file /etc/webdesk/.env` and `up -d --no-deps --no-build api` (see `webdesk-control-channel.md`, corrections 1 and 3).
   Expected log line: `editorial JWKS loaded from WEBDESK_EDITORIAL_JWKS_FILE (...): kid(s) wde-2026-10`.
5. **ERP:** set `WEBDESK_EDITORIAL_SIGNING_KID=wde-2026-10` in the ERP `.env`. Then run `up -d platform` with the FULL server compose
   file set. `vps.yml` alone is not a valid project, and a stale image tag in `.env` rolls back silently, so check both. Expected log line:
   `editorial assertion signer configured (kid wde-2026-10)`.
6. **Probe:** P1 must give `401 editorial-assertion-missing`, and P2 must give `403 editorial-assertion-command-mismatch`.
7. **Clean up:** `sudo shred -u /root/wde-keygen/*.pem && sudo rm -rf /root/wde-keygen`.

## Rotation (kid N → kid N+1), zero downtime

The order is the whole point: WebDesk learns the new key **before** the ERP uses it, and forgets the old one only **after** no
assertion signed with it can still be valid.

1. **Generate kid N+1, appended to the live JWKS:**
   `sudo cp /etc/webdesk/editorial/editorial.jwks.json /root/wde-keygen/current.jwks.json`, then run the generate command with
   `--kid <N+1> --jwks /out/current.jwks.json`.
   Check the result with `... webdesk-editorial-keygen.mjs inspect --jwks /out/editorial.jwks.json`; it must list both kids.
2. **WebDesk trusts both:** run `sudo install -m 0444 /root/wde-keygen/editorial.jwks.json /etc/webdesk/editorial/editorial.jwks.json`,
   then **restart api**. Expected log: `kid(s) <N>, <N+1>`. Re-run P2; it must still give 403 command-mismatch with kid N.
3. **ERP switches:** install `editorial-signing.<N+1>.pk8.pem` into `/etc/gaiada/webdesk-editorial/` (step 2 of the first install).
   Set `WEBDESK_EDITORIAL_SIGNING_KID=<N+1>` and run `up -d platform`. Expected log: `signer configured (kid <N+1>)`. Run P2; it must give 403 command-mismatch with kid N+1.
4. **Wait at least 4 minutes** (2 × the 120 s maximum lifetime), then **WebDesk forgets kid N:**
   run `... webdesk-editorial-keygen.mjs remove --jwks /out/editorial.jwks.json --kid <N> --out /out/after.jwks.json`,
   then install `after.jwks.json` as the JWKS and **restart api**. Expected log: `kid(s) <N+1>`.
   Run P2 with the old key; it must give `401 editorial-assertion-unknown-key`. Then delete `editorial-signing.<N>.pk8.pem` from the ERP dir.
5. Shred the scratch dir.

## Emergency revocation (kid N is compromised)

1. Run `remove --kid <N>` on the live JWKS, install the result, and **restart api**. If N is the only kid, `remove` refuses to leave an
   empty set. In that case, stop writes outright by **moving the JWKS file away** (`sudo mv … /root/`) and restarting api. Content
   writes then answer 503 `editorial-keys-not-configured`. That is the intended failure mode: writes stop, and `/v1` delivery keeps serving.
2. Generate a fresh kid and run first-install steps 2–6 with it. Writes resume when both sides have it.
3. Review WebDesk `audit_entries` and `content_versions.attribution` for writes attributed to unexpected `sub` values during the exposure window.

## As executed on the dev stack (sumopod gate `gate-wsk40`, 2026-10-10)

Stack: the WSK-40 commit on a sumopod Docker network with no host ports. The WebDesk api was built from this tree and run as
`node dist/src/main.js` with `NODE_ENV=development`, so every real layer was bound: L1 mTLS with the pinned CA, L2 an offline-JWKS token,
L3/L4, and L2e (this ticket). The JWKS was bind-mounted read-only as a FILE at `/etc/webdesk/editorial/editorial.jwks.json`,
exactly as the aicenter overlay mounts it. An nginx-equivalent edge verified the client cert and forwarded `$ssl_client_escaped_cert`.
The ERP side was the real platform-nest egress client and signer, driven from
`platform-nest/src/modules/webdev/webdesk-editorial-signer.e2e.test.ts`. The keys were throwaway and were destroyed at teardown.

| Step | Action (the script, run in `node:22`) | Observed |
|---|---|---|
| First install | `generate --kid wde-gate-1`; private key `0400 root:root`; JWKS mounted; api started | api log `editorial JWKS loaded … kid(s) wde-gate-1`; the end-to-end pairing (5 tests) passed with this key |
| 1 + 2 | `generate --kid wde-gate-2 --jwks <live>`; `inspect` lists both kids; JWKS replaced in place; `docker restart` api | api log `kid(s) wde-gate-1, wde-gate-2` |
| Overlap probe | content.create signed by wde-gate-1, then by wde-gate-2, through the real channel | **both 201** |
| 3 | ERP switched to wde-gate-2 (the probe signs with the new key from here on) | — |
| 4 | `remove --kid wde-gate-1`; `inspect` lists `wde-gate-2` only; restart api | api log `kid(s) wde-gate-2` |
| Removed probe | wde-gate-1 signature → **401 `editorial-assertion-unknown-key`**; wde-gate-2 → **201** | as required |

The 4-minute wait before step 4 was skipped on the gate, because no assertion was in flight. Do not skip it live.
