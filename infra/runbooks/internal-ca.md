# Runbook — the estate internal CA (custody, issuance, rotation)

**Status: the CA DOES NOT EXIST YET.** Verified on `gda-aicenter` 2026-08-29:
`GATEWAY_TLS_MODE=off`, `HUB_TLS_MODE=off`, and **no cert material in any `gaiada_*` volume** —
`gaiada_gateway-data` holds only `egress-audit.jsonl`. `ai-gateway-go` writes the CA only when TLS
is enabled, and it never has been.

That matters beyond one ticket: several designs already lean on this CA as if it were there.
WebDesk's §03 A→B control channel specifies "mTLS from the synccert internal CA"; `mcp-hub`'s own
compose comment says "enroll with synccert, then set `HUB_TLS_MODE: enforced`"; `sync-central`
carries a one-time cert-provisioning comment. **None of that can happen until this file's §1 runs.**

Owner ruled 2026-08-29: **generate the estate CA properly**, rather than a throwaway per-channel CA.

---

## 0. Custody decisions — settle these BEFORE §1, not after

Creating a root of trust is cheap; owning one is not. A CA generated without these answers becomes
an unrotatable dependency that nobody can safely replace later.

| Decision | Position taken here | Change it only deliberately |
|---|---|---|
| **Where the private key lives** | `gaiada_gateway-data:/app/data/ca-key.pem`, mode `600`, on `gda-aicenter` only. This is the path `synccert`'s own help text and `ai-gateway-go` both already assume. | Moving it means updating both. |
| **Who may issue** | Anyone with root on `gda-aicenter`. There is no finer control today — **state that honestly rather than implying one exists.** | An HSM or a signing service is the upgrade path if issuance ever needs an audit trail. |
| **Does the key ever leave the box** | **No.** Consumers receive `ca-cert.pem` (public) and their own issued cert+key. A CA key copied to a second host is a second thing to lose. | Never. |
| **Backup** | ⚠ **OPEN — the one item §1 cannot supply.** Losing the key means re-issuing every cert in the estate. It must be backed up **encrypted, off-box**, and the estate has no chosen target for that yet (WSK-D23 sequences Workspace-then-NAS for data backups; this is smaller and more sensitive). | Decide before the CA has real dependents. |
| **Validity / rotation** | 10 years on the CA, matching `certs.GenerateCA()`. Leaf certs are short-lived and re-issued freely. | A 10-year CA with no rotation drill is a 10-year assumption. Run §4 once, on purpose, before you need it. |

---

## 1. Generate the CA (once, ever)

Run **on `gda-aicenter`**. The parameters below match `sync-engine-go/internal/certs/certs.go`
`GenerateCA()` exactly — ECDSA P-256, SEC1 `EC PRIVATE KEY` PEM, `CN=gaiada-internal-ca`, 10 years,
`CA:TRUE` + `keyCertSign` — so `synccert`'s `LoadCA()` accepts it and every later cert chains the
same way it would have if the gateway had written it.

    docker run --rm --entrypoint sh -v gaiada_gateway-data:/d alpine/openssl:latest -c '
    set -e
    [ -f /d/ca-cert.pem ] && { echo "REFUSING - a CA already exists"; exit 1; }
    openssl ecparam -name prime256v1 -genkey -noout -out /d/ca-key.pem
    openssl req -x509 -new -key /d/ca-key.pem -sha256 -days 3650 \
      -subj /CN=gaiada-internal-ca \
      -addext basicConstraints=critical,CA:TRUE \
      -addext keyUsage=critical,keyCertSign,digitalSignature \
      -out /d/ca-cert.pem
    chmod 600 /d/ca-key.pem; chmod 644 /d/ca-cert.pem
    openssl x509 -in /d/ca-cert.pem -noout -subject -dates'

The `REFUSING` guard makes this safe to re-run. **Never regenerate over an existing CA** — every
issued cert stops verifying the moment you do, silently, at the next handshake.

Why openssl and not `synccert -init`: the sync-engine image is not present on that box and
`ghcr.io/hansel-gaiada/gaiada-sync-engine-go` returns `denied` from there. Once the image is
available, `synccert -init` is equivalent and preferable.

## 2. Issue a client certificate

    docker run --rm --entrypoint sh -v gaiada_gateway-data:/d alpine/openssl:latest -c '
    set -e
    CN=platform-nest-webdesk          # the ACL keys on this - see WEBDESK_CONTROL_MTLS_ALLOWED_CN
    openssl ecparam -name prime256v1 -genkey -noout -out /d/$CN.key
    openssl req -new -key /d/$CN.key -subj /CN=$CN -out /tmp/$CN.csr
    openssl x509 -req -in /tmp/$CN.csr -CA /d/ca-cert.pem -CAkey /d/ca-key.pem \
      -CAcreateserial -days 825 -sha256 \
      -extfile /dev/stdin -out /d/$CN.crt <<EXT
    keyUsage=critical,digitalSignature
    extendedKeyUsage=clientAuth
    EXT
    chmod 600 /d/$CN.key
    openssl x509 -in /d/$CN.crt -noout -subject -issuer -dates'

`extendedKeyUsage=clientAuth` is not decoration — a cert without it is not a client cert, and the
failure appears at handshake time as an opaque TLS error.

## 3. Distribute — what goes where, and what must never move

| Recipient | Gets | Never gets |
|---|---|---|
| **Zone B (WebDesk)** | `ca-cert.pem` **only**, as `WEBDESK_CONTROL_MTLS_CA_PEM` in `webdesk/.env.control` (0600, gitignored) | the CA key; any client key |
| **platform-nest (Zone A)** | its own `platform-nest-webdesk.crt` + `.key` | the CA key |
| **git, chat, logs, this repo** | nothing | everything above |

Zone B currently pins a **placeholder CA whose private key was generated and destroyed at creation**
— no certificate can ever be issued against it, so the channel is fail-closed by construction.
Swapping that one PEM for the real `ca-cert.pem` is the entire cutover; nothing else changes.

After swapping, restart only the api service and confirm it boots:

    cd /home/ubuntu/webdesk
    docker compose -f docker-compose.yml -f docker-compose.sumopod.yml up -d api
    docker logs webdesk-api-1 --tail 3      # expect "listening on :3000"

## 4. Rotation drill — run it once before you need it

Leaf rotation is routine: re-run §2 with the same CN and restart the consumer. CA rotation is not,
and is the reason §0's backup row is marked OPEN. The sequence, when it comes:

1. Generate CA v2 alongside v1 (different filenames — do **not** overwrite).
2. Distribute a **bundle** of both certs to every verifier, so either chain validates.
3. Re-issue every leaf from v2.
4. Only then remove v1 from the bundles.

Skipping step 2 is what turns a rotation into an outage: every consumer rejects every peer at the
same instant.

## 5. What is still not true after §1–§3

Generating the CA does **not** enable mTLS anywhere by itself. `GATEWAY_TLS_MODE` and
`HUB_TLS_MODE` are both `off` and stay off until each service is separately enrolled and flipped.
This runbook makes those flips *possible*; it does not make them *done*.
