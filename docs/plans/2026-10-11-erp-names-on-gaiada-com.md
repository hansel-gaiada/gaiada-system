# Plan: the ERP and everything ERP-related moves to names under `erp.gaiada.com`

**Owner decision, 2026-10-11.** All ERP-related names live in the `gaiada.com` zone (Hostinger DNS, which the owner
controls). The ERP itself is `erp.gaiada.com`; everything else ERP-related is nested under it as
`<service>.erp.gaiada.com`. Every server that hosts ERP services gets its own A record, and services are CNAMEs to a
server, so moving a service between servers is one CNAME change. This supersedes the "api.gaiada.com" name in
WSK-D43 (never created) and completes the 2026-10-11 hosting decision (ERP + WebDesk stay on gda-aicenter, the
observation stack on sumopod).

Status: PLANNED. Nothing below is live yet.

## 1. The names

### Servers (A records; operators use them, users never see them)

| Name | Type | Value | Server |
|---|---|---|---|
| `aicenter.erp.gaiada.com` | A | `35.240.135.48` | gda-aicenter (GCE): ERP, Keycloak, n8n, WebDesk |
| `sumopod.erp.gaiada.com` | A | `150.109.15.108` | sumopod: observation (Grafana, Prometheus, Loki, Tempo, Alertmanager, ntfy), LMS lab runner, Postiz |

### Services (CNAME to a server)

| Name | Type | Value | Serves | When |
|---|---|---|---|---|
| `api.erp.gaiada.com` | CNAME | `aicenter.erp.gaiada.com` | WebDesk delivery: `/v1`, `/forms`, `/media` (public, read keys) | now: nothing uses this name yet |
| `erp.gaiada.com` | CNAME | `aicenter.erp.gaiada.com` | the ERP: UI, platform API, Keycloak at `/idp`, n8n at `/n8n/` | record now, SERVED only at the cut-over (§3) |

Reserved for later, created only if and when the service is exposed (today they are internal, reached over WireGuard):
`grafana.erp.gaiada.com`, `ntfy.erp.gaiada.com`, `lab.erp.gaiada.com` (all CNAME `sumopod.erp.gaiada.com`).
Keycloak stays at the `/idp` PATH of `erp.gaiada.com`; giving it its own host is a separate, larger change.

### Not ERP, so not under `erp.`

| Name | Why it stays outside |
|---|---|
| `cms-proof.gaiada.com` A `72.61.142.88` | the WebDesk proof site (a website build on delphi, WSK-D56), not an ERP service |
| `gaiada.com`, `24-pyevq.gaiada.com` | the website and its review staging |
| `*.gaiada.online` client sites, `forms.gaiada.online` | client delivery; `gaiada.online` stays alive for them |
| `aicenter.gaiada.online`, `rhproptest.gaiada.online` | static sites on gda-aicenter (`/var/www/aicenter`, `/var/www/rhproptest`); owner to say whether they are ERP-related |
| `control.webdesk.internal` | internal only (host nginx on `172.17.0.1:9443`, mTLS); never public, never in DNS |

**Identifiers are not hostnames.** WebDesk's problem-type URIs (`https://webdesk.gaiada.online/errors/<slug>`) are
identifiers inside the frozen `/v1` envelope; they do not need to resolve and do not change.

## 2. Phase A: WebDesk delivery on `api.erp.gaiada.com` (no ERP impact; do first)

1. Owner (or Claude with a Hostinger API token for this account): create the two server A records, the
   `api.erp.gaiada.com` CNAME, and `cms-proof.gaiada.com`.
2. gda-aicenter: rename the staged vhost `api.gaiada.com.conf` to `api.erp.gaiada.com.conf` (same file: token-URL
   redaction, public 404s for `/admin` and `/control`), enable it, `certbot --nginx -d api.erp.gaiada.com`.
3. Site repo variable `WEBDESK_API_URL=https://api.erp.gaiada.com`.
4. delphi: `clpctl lets-encrypt:install:certificate --domainName=cms-proof.gaiada.com`.
5. Proof: publish an edit in the ERP; the rebuild pulls from `api.erp.gaiada.com` and lands on `cms-proof.gaiada.com`.

## 3. Phase B: the ERP on `erp.gaiada.com` (its own cut-over)

### B0. Security first (blocking)

On `erp.gaiada.com` the ERP becomes SAME-SITE with every `*.gaiada.com` site, including review and client
staging sites. `SameSite=Lax` (today's session cookie) then no longer separates them, and a sibling subdomain can
toss cookies. Before any user logs in on the new name:
- session and auth cookies get the `__Host-` prefix (`Secure`, `Path=/`, no `Domain`);
- every state-changing request (server actions, API POSTs) is checked against an `Origin` allow-list;
- `frame-ancestors 'none'` (or the ERP origin) on the ERP's pages.
This is platform-ui and platform-nest work, with its own release and tests.

### B1. Prepare (no user impact)

- `erp.gaiada.com` CNAME (from §1) plus a TLS certificate issued ahead, in a vhost that is not yet the default.
- Keycloak clients (`gaiada-ui` and others): ADD the new redirect URIs and web origins next to the old ones.

### B2. Cut-over (one announced window; everyone signs in again)

Keycloak has ONE hostname, so the token issuer changes at once. Change together, then restart:
- Keycloak `KC_HOSTNAME=https://erp.gaiada.com/idp`;
- platform: `OIDC_ISSUER`, `OIDC_AUTH_URL`, `OIDC_REDIRECT_URI`, `PUBLIC_ORIGIN`, `AUTOMATION_PUBLIC_URL`;
- WebDesk: the control channel's expected token issuer, and `WEBDESK_UPLOAD_CORS_ORIGINS=https://erp.gaiada.com`;
- n8n: `N8N_EDITOR_BASE_URL` / `WEBHOOK_URL`;
- platform-ui public URL settings; the site repo's `PUBLIC_ERP_URL`.
`erp.gaiada.online` then answers `301` to `erp.gaiada.com` for GET, and keeps serving the webhook endpoints below
until their callers are moved.

### B3. External callers (each is a setting in someone else's console)

Brevo inbound mail webhook; WAHA (WhatsApp) webhooks; the `gaiada-erp` GitHub App's webhook and callback URLs;
Postiz callbacks; any OAuth provider redirect URIs; monitoring (blackbox targets, the synthetic prober, the 18
uptime monitors); links in email templates; the CREDENTIALS and runbook docs.

### B4. Retire

After the callers are moved and two quiet weeks: keep the `301` (it is free) and drop the old certificate's
special handling.

## 4. Repo sweep

About 60 files mention `gaiada.online` (webdesk 34, mostly problem-type identifiers that stay; platform-ui 8;
platform-nest 6; infra 4; scripts 3; automation 2; simulation 2; ai-agents 1). Each is classified as hostname
(changes in Phase A or B) or identifier (stays), and the hostname ones become configuration, not literals.

## 5. What the owner does

- Create the DNS records in §1 at Hostinger, or put a Hostinger API token for the account that owns `gaiada.com`
  in `C:\Users\Hansel\.claude\secrets\hostinger-api-gaiada.env` (`HOSTINGER_API_TOKEN=…`) and Claude creates them.
- Say whether `aicenter.gaiada.online` and `rhproptest.gaiada.online` are ERP-related.
- Pick the window for B2 (everyone signs in again).
