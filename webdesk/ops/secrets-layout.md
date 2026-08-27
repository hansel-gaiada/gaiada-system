# WebDesk Zone B — secrets layout (WSK-28)

**Status: PLANNED — describes WHERE secrets live and HOW they are issued. Contains no secret
values, per this ticket's hard rule.** Nothing below has a real credential in it; every example is
a placeholder or a variable name.

Custody doctrine restated from `docs/blueprints/webdesk-design.md` §11's secrets-custody table
(WSK-06, WSK-12, WSK-21/22, WSK-37 rows) — this file is that table's operational counterpart for
the *box*, not a new policy.

---

## 1. Layers, outermost to innermost

| Layer | What lives here | Custody | Rotation trigger |
|---|---|---|---|
| **Provider/host secrets** | SSH deploy key (public half only on the box, per `webdesk-zoneb-box-hardening.md` §3), synccert CA public cert, Zone B's own TLS server cert+key | Deploy pipeline holds the SSH private key; the synccert CA private key **never leaves Zone A** (§5 of the hardening runbook) | Cert expiry; a suspected box compromise (full box rebuild, not a rotation) |
| **Compose `.env`** | Every value currently in `webdesk/.env.example` with a real value substituted: DB role passwords, `MINIO_ROOT_*`, `API_KEY_PEPPER`, `PAYLOAD_SECRET`, `WEBDESK_EVENT_SECRET`, `IMGPROXY_KEY`/`SALT`, `TENANT_WEBHOOK_SECRET_PEPPER`, this ticket's new `OTEL_EXPORTER_OTLP_HEADERS` | File at `/etc/webdesk/.env` on the box, `root:root 0600` (hardening runbook §4); **never in git**, never in a built image layer, never logged | On suspected exposure; on offboarding anyone who had box access; API_KEY_PEPPER rotation is itself a break-glass operation (invalidates every issued key, per WSK-05) |
| **Per-tenant credentials** | API keys (WSK-05: sha256+pepper at rest, shown once), MinIO per-tenant prefixed credentials (WSK-07), tenant webhook signing secrets (WSK-37, AES-256-GCM encrypted at rest, not hashed — HMAC needs the bytes back) | Database, encrypted/hashed per WSK-05/37's own design — this ticket does not change that, only confirms the box-level custody (`.env`'s `API_KEY_PEPPER`/`TENANT_WEBHOOK_SECRET_PEPPER`) is what makes those DB rows meaningful at all | Per WSK-05/37's own rotate/revoke flows — unaffected by this ticket |
| **Control-channel materials** | Layers 1–4 of design §03: mTLS client cert CA (public half only, §5 of hardening runbook), Keycloak `webdesk-control` client secret (Zone A custody, **never present on Zone B at all** — Zone B verifies tokens offline against the public JWKS, no secret needed), `WEBDESK_APPROVAL_ASSERTION_KEY` (shared HMAC key, present on **both** platform-nest and Zone B — the one control-channel secret Zone B legitimately holds) | `.env` layer above for the assertion key; CA public cert is not secret at all (it's a certificate, meant to be shared) | Rides the deferred cert-rotation item (gateway parity, design §11); assertion key rotation needs coordinated redeploy of both sides |
| **Backup-target access** | **None.** By design (`webdesk-zoneb-backups.md` §1) — the one deliberate gap in this table. The `webdesk-backup-pull` user's `authorized_keys` entry is a *public* key (not secret) restricting an inbound connection; it is listed here only to say explicitly that it is not a credential and does not belong in a secrets manager | n/a | n/a |
| **Telemetry push** | `OTEL_EXPORTER_OTLP_HEADERS` bearer token, write-only (see `webdesk-zoneb-otel.md`) | `.env` layer | On suspected exposure; independent of every other rotation above |

---

## 2. Issuance flow — who mints what, and where it first exists

1. **DB role passwords, `MINIO_ROOT_*`, `PAYLOAD_SECRET`, `API_KEY_PEPPER`, `WEBDESK_EVENT_SECRET`,
   `IMGPROXY_KEY`/`SALT`, `TENANT_WEBHOOK_SECRET_PEPPER`, `OTEL_EXPORTER_OTLP_HEADERS`:** generated
   once, on the box (or by whoever provisions the box, then transferred over the same SSH channel
   used for deploy — never over an unencrypted channel, never pasted into a ticket/chat/log),
   written directly into `/etc/webdesk/.env`. Never generated centrally and distributed — each
   Zone B environment (staging box, live box, once both exist) gets its **own** independently
   generated set; there is no "one secret, many environments" pattern anywhere in this layout,
   which is also why a staging-box compromise cannot compromise the live box (design §03: "no
   standing cross-box credentials, D-13").
2. **synccert client cert (`platform-nest-webdesk`):** minted in Zone A only, per
   `webdesk-zoneb-box-hardening.md` §5. Zone B receives the CA public cert + its own server
   cert+key over the same box-provisioning channel as step 1 — never generated on Zone B.
3. **Keycloak `webdesk-control` client secret:** minted in Zone A's Keycloak by an owner action
   (per design §11, "owner action outstanding" — the client does not exist yet). Zone B never
   receives this value at all; it verifies tokens offline against the issuer's public JWKS.
4. **Per-tenant API keys / webhook secrets:** minted by the running `api` service at request time
   (WSK-05/37's own flows), shown once in the console response, never re-displayed, never logged.
   This ticket adds nothing here — it is the "why the pepper above matters" downstream consumer.
5. **`webdesk-backup-pull`'s keypair:** generated **on the pull target**, its public half copied
   into Zone B's `authorized_keys` at provisioning time (`webdesk-zoneb-backups.md` §1). The
   private half is never generated on, or transmitted to, Zone B.

---

## 3. What must never appear in this file, or any file like it

- No secret VALUE, ever — this file describes shape and custody only, and every example above is
  a variable name, never a filled-in string.
- No secret in `webdesk/.env.example` beyond a placeholder (`changeme_...` or empty) — already the
  project's existing convention (see that file's own header), unchanged by this ticket.
- No secret in `CREDENTIALS.local.md` gets pasted into a runbook, a ticket, a commit message, or
  an agent report — including this one. If a real value for any row above needs recording for
  operational reference, it goes in the gitignored `CREDENTIALS.local.md`, never here.

## 4. Status vocabulary reminder

This is a **PLANNED** layout — it describes intended custody, not an audited-live state (no box
exists to audit). Once A-12 lands, the honest next step is a walkthrough of this table against the
real box's actual file permissions and env contents, not an assumption that provisioning followed
it correctly.
