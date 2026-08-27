# Runbook — WebDesk Zone B box hardening (WSK-28)

**Status: PLANNED — authored, unverifiable until the box exists.** A-12 (owner procurement of
the Zone B box) has not landed. Nothing below has been run against real hardware. This runbook is
the shape the first boot must follow; its own first execution is the still-outstanding evidence.
Follow the house style of `onboard-server.md` — never-touch list first, explicit abort conditions,
verification against the real target, rollback path.

Read first: `docs/blueprints/webdesk-design.md` §02 (topology), §03 (trust zones — the boundary
this hardening exists to hold), §03 Dev-topology honesty (D-2, **GDA-AI01 is explicitly ruled
out** as this box — do not co-tenant Zone B beside OpenClaw workloads, it destroys the
containment statement §03 depends on). `docs/plans/2026-08-26-webdesk-PROGRESS.md` row A-12.

---

## 0. Never-touch / scope

| Item | Rule |
|---|---|
| GDA-AI01 | **Not a candidate for this box, ever** (§03 D-2, restated 2026-08-26). If someone proposes "just co-tenant it there to save procurement," that is the exact mistake this section exists to block. |
| `gda-aicenter`, `delphi`, `helios` | Not this box. Zone B needs a **dedicated**, internet-facing box with no other estate workload on it (§03 containment table: "a neighbour on the same box is compromised" breaks the whole blast-radius argument). |
| Zone A credentials | Never placed on this box, at any hardening step, even temporarily "to test." The whole design (§03) rests on Zone B holding zero Zone A credentials. |
| This runbook itself | Cannot be executed before A-12. Do not hand-apply pieces of it to a stand-in box "to get ahead" — a hand-applied config on a box that isn't the real target has no continuity into the real one and creates a false sense of progress. |

---

## 1. Parameters

| Parameter | Meaning | Source |
|---|---|---|
| `ZONEB_HOST` | The box's public hostname/IP once procured | A-12 (owner) |
| `ZONEB_SSH_PORT` | Non-default SSH port (defense in depth, not a security boundary by itself) | chosen at provisioning |
| `ZONEB_DEPLOY_USER` | Non-root deploy user, sudo via explicit `NOPASSWD` allowlist only for the docker/compose commands the deploy pipeline needs — never blanket sudo | chosen at provisioning |
| `SYNCCERT_CN` | The client-cert common name the control channel pins (`platform-nest-webdesk`, per design §03 Layer 1) | fixed, see §5 |

---

## 2. Pre-flight — before touching the box at all

1. **Confirm this is a dedicated box.** Ask directly: does anything other than Zone B run here,
   now or planned? Any answer other than "no" is a stop — go back to §0.
2. **Confirm network placement.** The box must be reachable on `:443` only from the internet
   (client sites, Cloudflare) and on the control vhost from Zone A's egress IP(s) only — design
   §03's "the only public listener" invariant starts here, at the firewall, not at Caddy.
3. **Confirm the release tag this box will run** exists and is signed (SBOM+cosign+SLSA gate,
   per the estate's WS10 pipeline) — never hand-build an image on the box itself.
4. **Confirm out-of-band access** (provider console / KVM) exists before locking down SSH — a
   misconfigured firewall or a lost key must not mean physically losing the box.

---

## 3. OS hardening (first boot)

Run as the provider's initial root/admin access, then immediately stop using it.

1. **Non-root deploy user, key-only.**
   ```sh
   adduser --disabled-password "$ZONEB_DEPLOY_USER"
   mkdir -p /home/$ZONEB_DEPLOY_USER/.ssh
   # install the deploy pipeline's PUBLIC key only — the private key never touches this box
   cat deploy-pubkey.pub >> /home/$ZONEB_DEPLOY_USER/.ssh/authorized_keys
   chown -R $ZONEB_DEPLOY_USER:$ZONEB_DEPLOY_USER /home/$ZONEB_DEPLOY_USER/.ssh
   chmod 700 /home/$ZONEB_DEPLOY_USER/.ssh
   chmod 600 /home/$ZONEB_DEPLOY_USER/.ssh/authorized_keys
   ```
2. **Disable password auth and root SSH entirely** (`/etc/ssh/sshd_config`):
   ```
   PasswordAuthentication no
   PermitRootLogin no
   KbdInteractiveAuthentication no
   Port <ZONEB_SSH_PORT>
   ```
   Verify the new key-only session works **before** closing the provider console session that
   let you make this change — the same "abort condition" discipline as `onboard-server.md` §2.
3. **Firewall — default deny, explicit allow only.**
   ```sh
   ufw default deny incoming
   ufw default allow outgoing
   ufw allow "$ZONEB_SSH_PORT"/tcp
   ufw allow 443/tcp        # the ONE public listener (design §03)
   # NO :80 exception beyond ACME HTTP-01 if used — prefer DNS-01 so :80 need not open at all
   ufw enable
   ```
   The control vhost is still `:443` (a distinct Caddy site block behind mTLS, design §03 Layer
   1) — it does not need its own port, and must not get one; a separate port for the control
   channel would be a second public listener, which the design explicitly forbids.
4. **fail2ban** on sshd with a short ban escalation; jail scoped to sshd only at this stage (the
   proxy's own abuse controls — Turnstile, per-IP/per-form rate limits — are application-layer,
   WSK-10, not this box's OS-level job).
5. **Unattended security upgrades** (`unattended-upgrades` on Debian/Ubuntu-family, or the
   distro's equivalent) for the OS package set. Docker/Caddy/app images are pinned and updated
   through the deploy pipeline, never through the OS package manager — the two update paths must
   not collide.
6. **Docker daemon hardening.** No `-p 0.0.0.0:...` publishes beyond `:443` on the proxy service
   — mirrors the estate's `onboard-server.md` §2.6 "never publish on 0.0.0.0" rule, restated here
   because it is exactly as easy to get wrong on a fresh box as on a monitored one. Every other
   compose service (`payload`, `api`, `postgres`, `minio`, `redis`, `clamav`, `otel-collector`)
   stays on the compose-internal network only, same as the dev topology in
   `webdesk/docker-compose.yml` today — this hardening step changes nothing about that shape,
   it just makes the OS firewall agree with what compose already does.
7. **Time sync (chrony/systemd-timesyncd) enabled.** The control channel's WS4 assertion (§03
   Layer 4) carries an `exp` and the event webhook HMAC carries a `timestamp` both zones check —
   clock drift silently breaks both.

---

## 4. Filesystem / secrets layout

See `webdesk/ops/secrets-layout.md` (this ticket) for the full inventory. Summary applied here:

- `/etc/webdesk/.env` — root:root 0600, read by the deploy user's docker compose invocation via
  `sudo`-scoped access only, never world-readable, never in the release image, never in git.
- No secret is ever baked into an image layer — every credential arrives via the compose
  `environment:`/`.env` path at container start, consistent with the estate's existing pattern
  (`platform-nest`, `ai-gateway-go`).

---

## 5. synccert issuance (control-channel Layer 1)

Design §03 Layer 1: the A→B control channel requires a client cert issued by the **synccert
internal CA** (`sync-engine-go/cmd/synccert`, the same CA the gateway/sync-engine already use).
Zone B's role in this exchange is narrow and one-directional:

1. **Issuance happens in Zone A**, by whoever operates `sync-engine-go`, using the existing CA:
   ```sh
   # Run from sync-engine-go, NOT on the Zone B box — the CA private key never leaves Zone A.
   go run ./cmd/synccert \
     -ca-cert data/ca-cert.pem -ca-key data/ca-key.pem \
     -cn platform-nest-webdesk \
     -out-cert certs/platform-nest-webdesk.crt -out-key certs/platform-nest-webdesk.key
   ```
   `-cn platform-nest-webdesk` is the fixed CN this design pins (§03 Layer 1) — do not vary it
   per environment; the control-vhost's Caddy config keys off this exact CN.
2. **Zone B receives only:**
   - the **CA's public certificate** (`ca-cert.pem`) — so its Caddy control vhost can verify
     client certs signed by that CA, and
   - **its own server certificate + key** (issued the same way, `-cn <zoneb-hostname>`, still
     from the Zone A CA, since Caddy's client-cert verification and its own server TLS are
     independent).
   Zone B **never** receives `ca-key.pem` (the CA private key) or the client cert's private key
   (`platform-nest-webdesk.key` stays in Zone A, alongside the mTLS caller). This is the whole
   point of the layer: a stolen Zone B box yields a CA it can verify against but cannot mint new
   valid client certs from, and cannot present the Zone A client identity itself.
3. **Caddy control-vhost config (WSK-22 wires the app-side verification; this ticket wires the
   TLS-level requirement):**
   ```caddyfile
   control.<zoneb-host> {
     tls /etc/webdesk/certs/server.crt /etc/webdesk/certs/server.key {
       client_auth {
         mode require_and_verify
         trusted_ca_cert_file /etc/webdesk/certs/ca-cert.pem
       }
     }
     reverse_proxy api:3000
   }
   ```
   `require_and_verify` means a request with no client cert, or a client cert not signed by the
   pinned CA, is refused at the TLS handshake — before any application code (Cerbos, WS4
   verification) ever runs. This is Layer 1 only; Layers 2–4 (Keycloak token, Cerbos authz, WS4
   assertion) are WSK-21/22's application-level work, not this ticket's.
4. **Rotation** rides the existing deferred cert-rotation item noted in design §11 ("synccert CA
   ... rotation rides the existing deferred cert-rotation item (gateway parity)") — no new
   rotation mechanism is invented here.

**Verified how:** authored against the real `sync-engine-go/cmd/synccert` CLI (flags read
directly from `sync-engine-go/cmd/synccert/main.go`) and the design's own Layer-1 spec. The
`synccert` invocation itself was not run in this ticket (it needs a CA that only exists once
`sync-engine-go`'s data dir is initialized somewhere real) — **authored, unverifiable until the
box exists to issue a cert against.**

---

## 6. Verification (run once the box exists — do not skip any row)

| Check | Command | Pass |
|---|---|---|
| SSH is key-only | `ssh -o PasswordAuthentication=no $ZONEB_DEPLOY_USER@$ZONEB_HOST -p $ZONEB_SSH_PORT` from a machine with no key installed | Connection refused/prompt-free failure, not a password prompt |
| Only :443 (+ SSH port) reachable | `nmap -Pn -p- $ZONEB_HOST` from outside the box's network | Only the two ports open |
| No 0.0.0.0 Docker publishes beyond the proxy | `docker ps --format '{{.Names}}\t{{.Ports}}'` on the box | Only the proxy service shows a `0.0.0.0:443->...` mapping |
| Control vhost rejects a cert-less request | `curl -k https://control.$ZONEB_HOST/` (no client cert) | TLS handshake failure, not an HTTP response |
| Control vhost accepts the pinned CN | `curl --cert platform-nest-webdesk.crt --key platform-nest-webdesk.key --cacert ca-cert.pem https://control.$ZONEB_HOST/healthz` | 200 (once WSK-21/22's api exists to answer it) |
| fail2ban active | `fail2ban-client status sshd` | jail present, bans list empty on a clean box |
| Unattended upgrades active | `systemctl status unattended-upgrades` (or distro equivalent) | active/enabled |

None of these rows have been run. This table is the acceptance evidence WSK-30 (the P4 boundary
gate) re-drives on the real box — see design §03's own line: "No status above `PROTOTYPED` may be
claimed for any zone-boundary behavior before that gate."

---

## 7. Rollback

If hardening breaks access (locked out over SSH): use the provider's out-of-band console (§2.4)
to restore `sshd_config` from the pre-change backup taken in step 3, or to re-enable password auth
temporarily while the key issue is fixed. Never leave password auth re-enabled longer than the
single session needed to fix the key.

If the box is later found to be shared with another workload (violates §0): stop, do not proceed
with any further hardening or app deploy — escalate for a dedicated replacement box. Partial
hardening on a co-tenanted box is not a lesser version of this runbook; it does not satisfy §0 at
all.

---

## 8. Status vocabulary reminder

This entire runbook is **PLANNED**. No row in §6 has been observed. Do not describe any step
above as DEV-VERIFIED until it has actually been driven against `$ZONEB_HOST` and the result
recorded here with a date and an operator name, per the estate's status-language rule.
