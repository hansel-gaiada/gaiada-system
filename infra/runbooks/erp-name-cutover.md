# Runbook: move the ERP from `erp.gaiada.online` to `erp.gaiada.com` (ERP names, Phase B2 + B3)

Plan: `docs/plans/2026-10-11-erp-names-on-gaiada-com.md` §3. Owner decision 2026-10-11: done in one session,
scripted end to end, no owner step. Everyone signs in once more afterwards.

## Before (each is checked by the preflight; the cut-over refuses to start otherwise)

| Prerequisite | How it got there |
|---|---|
| B0 is live: `__Host-` cookies, the Origin allow-list (`ALLOWED_ORIGINS` in platform-ui's compose environment), platform and WebDesk take an issuer LIST | the release that carries Phase B0 (`MIN_TAG`), plus the WebDesk api swap from that release (`webdesk-live-swap.md`) |
| One certificate covers both names | `certbot certonly --nginx --cert-name erp.gaiada.com -d erp.gaiada.com -d erp.gaiada.online` |
| Keycloak clients `gaiada-platform` and `gaiada-ui` list `https://erp.gaiada.com/*` next to the old URIs | kcadm, B1 (2026-10-11) |
| `erp.gaiada.com` resolves to gda-aicenter | Hostinger DNS (owner, 2026-10-11) |
| The staged vhost passes `nginx -t`, redirect off and on | checked in a temporary copy of `/etc/nginx` |

## Run

From the repo root of a checkout of the release:

```bash
MIN_TAG=v1.0.0-alpha.NNN bash scripts/phaseb/run-erp-name-cutover.sh --preflight-only   # read-only
MIN_TAG=v1.0.0-alpha.NNN ERP_USER=<staff email> ERP_PASS=<password> bash scripts/phaseb/run-erp-name-cutover.sh
```

The runner ships `infra/nginx/erp.gaiada.online.conf`, the two `erp-legacy-redirect.*.conf` snippets,
`scripts/phaseb/erp-name-cutover.sh` and `github-app-hook.cjs` to `/home/Hansel/gaiada/phaseb/` and drives:

| Stage | Changes | Proof (a failure rolls EVERYTHING back) |
|---|---|---|
| backup | copies `.env` (gaiada, automation), `/etc/webdesk/.env`, `/etc/webdesk/.env.control`, the vhost, the snippet, the image ids to `~/backups/erp-name-cutover-<UTC>/` | — |
| nginx | the vhost serves BOTH names (legacy redirect OFF), certificate `erp.gaiada.com` | `/login` 200 on both names; the GitHub webhook path still answers on the old name |
| identity | `.env`: `KC_HOSTNAME`, `OIDC_ISSUER=new,old`, `OIDC_AUTH_URL`, `OIDC_REDIRECT_URI`, `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS=new,old`, `AUTOMATION_PUBLIC_URL`, `MAIL_LINK_BASE_URL`; WebDesk `WEBDESK_CONTROL_OIDC_ISSUER=new,old` (JWKS from the first), `WEBDESK_UPLOAD_CORS_ORIGINS=new,old`; recreates keycloak, platform, platform-ui (deploy's exact compose invocation and the deployed tag) and the WebDesk api | Keycloak and public discovery say the new issuer; `/auth/login` sends the browser to Keycloak on the new name |
| login proof (runner) | — | a real authorization_code + PKCE login on `https://erp.gaiada.com`, `/api/me` with that token, and one ERP → WebDesk control-channel read (200) |
| redirect | legacy redirect ON | `GET erp.gaiada.online/login?x=1` → 301 `https://erp.gaiada.com/login?x=1`; webhook POST, `/idp`, `/n8n` still served on the old name |
| n8n | `N8N_HOST`, `N8N_WEBHOOK_URL`, `N8N_EDITOR_BASE_URL` | healthz 200, the container reads the new editor URL, `/n8n/signin` answers on the new name |
| github-hook | the `gaiada-erp` App's webhook URL via `PATCH /app/hook/config` (App JWT from the sealed credential) | read back equals `https://erp.gaiada.com/api/webhooks/github` |
| monitoring | sumopod `blackbox-estate.json`: the ERP probe to `https://erp.gaiada.com/login` | file_sd reloads on its own |

The last two are not rolled back on failure: the legacy name keeps serving their paths, so a re-run is safe.

## What stays on the legacy name, on purpose

`/api/webhooks/`, `/api/mail/`, `/n8n…`, `/idp/` and ACME are served on `erp.gaiada.online` too (the vhost maps
`$erp_legacy_keep`), and a POST is never redirected. Every other browser GET/HEAD gets a 301. Removing these
exceptions is Phase B4, after two quiet weeks (M4).

## Rollback by hand

`ssh gda-aicenter 'cd /home/Hansel/gaiada/phaseb && bash erp-name-cutover.sh rollback ~/backups/erp-name-cutover-<UTC>'`
restores every file, reloads nginx and recreates keycloak, platform, platform-ui, the WebDesk api and n8n with the
deployed tag, then waits for the old issuer and `https://erp.gaiada.online/login` 200. The Keycloak clients keep both
URIs and the certificate keeps both names; neither hurts the old name.

## As executed

(filled in by the run)
