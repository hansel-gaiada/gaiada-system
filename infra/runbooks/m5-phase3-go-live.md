# M5 phase 3 go-live: gaiada.com's forms → WebDesk → ERP leads

**Status:** PLANNED. Nothing here has been run.
**Plan:** [`docs/plans/2026-10-11-webdesk-m5-plan.md`](../../docs/plans/2026-10-11-webdesk-m5-plan.md) (L1, L1d, L1s, L4, L5, L6, G2, G6).
**Rulings:**
- WSK-D67: each phase goes live only after counsel.
- WSK-D68: `/onboard` first; AD-1 comes after the first call.
- WSK-D75: no Web3Forms, not even as an interim.

This runbook turns on the website → lead path in one sitting, staging first. Every switch in it is OFF today, and every
step names who runs it.
- **owner:** decisions, keys, and live writes the session cannot make.
- **orchestrator:** server work by the Claude session that owns M5.
- **site:** the gaiada-web-revamp build.

Each step says how to check it before moving on.

## 0. Preconditions (all must hold; stop if one does not)

| # | Precondition | Where to check |
|---|---|---|
| P1 | **G2:** counsel has reviewed `legal/website-visitor-addendum.md`. Retention and the controller entity are confirmed. The notice text is final (EN, and ID if counsel requires it) | the addendum header + `TASKS.md` M5-G2 ticked |
| P2 | **O-6:** a Cloudflare Turnstile widget for the staging AND production domains. Its **site key** (public) and **secret** (never in git or chat) are with the owner | the Cloudflare dashboard |
| P3 | **G3:** `/privacy-policy/` is live on the site (the forms' notice links to it) | the site |
| P4 | The site switch (`m5/l1s-forms` in gaiada-web-revamp, branched from the local `astro-site`) is merged into the line that is deployed. The owner decides how the unpushed `astro-site` work gets published | the site repo |
| P5 | A release containing the WebDesk `TURNSTILE_MODE` / `TURNSTILE_SECRET_KEY` compose passthrough is live (`webdesk/docker-compose.yml`, added with this runbook) | `/health` version + the deploy log |
| P6 | M3's Zone B bridge is live: WebDesk → n8n → ERP events. Proven 2026-10-12 05:53:19Z | `TASKS.md` M3 |

## 1. WebDesk: live Turnstile (orchestrator, gda-aicenter)

WebDesk runs on the **rootless** daemon (uid 940). Hand-typed commands need `DOCKER_HOST` (memory: webdesk-egress-guard).
The egress guard allows the public internet, so the verifier reaches `challenges.cloudflare.com`.

1. Back up `/etc/webdesk/.env`, then set `TURNSTILE_MODE=live` and `TURNSTILE_SECRET_KEY=<secret>`. The owner pastes the secret on
   the box; it never goes through the session.
2. Recreate the API only, with the deploy script's file set:
   `sudo -n env DOCKER_HOST=unix:///run/user/940/docker.sock docker compose --env-file /etc/webdesk/.env -p webdesk -f docker-compose.yml -f docker-compose.aicenter.yml -f docker-compose.aicenter-release.yml up -d --no-build api`
   (run in the webdesk checkout on the box).
3. **Check:** a submit with no token, and one with a garbage token, both answer 403. `docker logs` shows no
   `TURNSTILE_MODE=live but TURNSTILE_SECRET_KEY is unset`.

## 2. WebDesk: the site's domains are environments (owner or orchestrator, via the ERP)

The forms and the consent log accept only an `Origin` that is an `environments.domain` of the tenant's site.
On 2026-10-12, `OPTIONS /v1/t/gaiada/consent` from `https://gaiada.com` answered **403** for exactly this reason.

4. Make sure the `gaiada` tenant's site has environments for the staging domain and for `gaiada.com` (and `www.gaiada.com` if
   it is served). Use `environment.provision` (medium), through the ERP's WebDesk console/tools.
5. **Check:** the same OPTIONS request from each domain answers 204 with `Access-Control-Allow-Origin` echoing it.

## 3. WebDesk: apply the three form definitions (owner, a publisher-tier login)

6. For each of `webdesk/sites/gaiada-com/forms/{contact,audit,onboard}.json`, call
   `PUT /api/:tenantId/modules/webdev/content/sites/gaiada/:siteId/forms/:formKey` with an `Idempotency-Key` (MCP:
   `webdesk.forms.define`) as `webdev_manager` / `company_admin`.
   - If counsel changed the notice text, bump `consentNoticeVersion` in the JSON first. The command refuses a changed
     text under the same version (409 `consent-version-unchanged`).
7. **Record the three `form.formId` values** from the responses (or `GET …/forms`). The site build needs them.

## 4. ERP: switch on web leads (orchestrator, gda-aicenter `platform`)

Use the full compose file set. `vps.yml` alone is an invalid project (memory: server-compose-file-set). Check that `GAIADA_TAG` in `.env`
is the live tag before `up -d`; a stale tag silently rolls back.

8. Back up `~/gaiada/infra/compose/.env`, then set:
   - `AGENCY_WEB_LEADS_ENABLED=1`
   - `AGENCY_WEB_LEAD_ALERT_USER_IDS=<comma-separated staff user ids>` (the bell)
   - optionally `AGENCY_WEB_LEAD_ALERT_CHAT=1`, with the bot's `WEB_LEAD_ALERT_CHAT_ID` (a DM or a Telegram private chat,
     never an ingested group; Telegram first, since it needs no WAHA pairing)
   - Leave `AGENCY_LEAD_RETENTION_PURGE_ENABLED` unset until counsel confirms 24 months. Compose does not pass it yet.
9. Recreate only `platform` (and `bot` if chat is on): `docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml up -d --no-build platform`.
10. **Check:** `platform` is healthy on the same tag, and the logs show no config errors.

## 5. Site: build with the WebDesk forms (site/owner)

11. Build env (all public):
    - `PUBLIC_WEBDESK_API=https://api.erp.gaiada.com`
    - `PUBLIC_WEBDESK_TENANT=gaiada`
    - `PUBLIC_WEBDESK_FORM_CONTACT` / `_AUDIT` / `_ONBOARD`: the ids from step 7
    - `PUBLIC_TURNSTILE_SITE_KEY`
    - No `PUBLIC_WEB3FORMS_*` (WSK-D75).
12. Host CSP:
    - `connect-src https://api.erp.gaiada.com https://challenges.cloudflare.com`
    - `script-src https://challenges.cloudflare.com`
    - `frame-src https://challenges.cloudflare.com`
13. Deploy **staging** first.

## 6. Smoke test (staging, then production)

14. **Banner:** accept, then change, then reject. Each decision posts to `/v1/t/gaiada/consent`, and the record is findable by the stored
    `consentId` (WebDesk `privacy.find`).
15. **Form:** submit the contact form with a test identity (a team mailbox, not a real prospect). Expect, in order:
    - a 2xx and the thank-you page;
    - the WebDesk submission (with attribution + visitor consent);
    - Zone B `form.received`;
    - an `agency_leads` row with `source = web`, at stage `enquiry`;
    - the bell alert to the configured staff (and the chat line, if on);
    - the lead in the Website workspace's **Leads** tab.
16. Repeat for audit and onboard. On onboard, the lead's org/contact come from `org_name` / `contact_*`.
17. **Clean up:** erase the test lead with the ERP privacy tools (G5: find → export → erase, two-person) and the WebDesk
    submission with `privacy.erase`. Check the suppression list now holds the test hashes.
18. Then production: repeat steps 13–17 on `gaiada.com`.

## 7. Rollback (any time)

| To stop | Do | Effect |
|---|---|---|
| leads into the ERP | unset `AGENCY_WEB_LEADS_ENABLED`, recreate `platform` | submissions are still stored in WebDesk; no new leads |
| the forms | unset the site's `PUBLIC_WEBDESK_FORM_*` and redeploy | each form says it is not connected; nothing is sent |
| alerts | unset `AGENCY_WEB_LEAD_ALERT_USER_IDS` / `_CHAT` | leads arrive silently |

Never fall back to Web3Forms (WSK-D75).
