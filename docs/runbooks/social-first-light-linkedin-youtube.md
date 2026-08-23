# Runbook — social first light on LinkedIn + YouTube (dev tier, own brand)

**Goal:** take the `social-media` module from "structurally undrivable" to a real post on a real
network, using **only** assets we administer, with **no app review and no Meta Business Verification**.

**Why this is the shortest path.** D-23 is recorded in the tracker as gated on "Meta's Business
Verification", but Meta gates Instagram/Facebook — networks the `direct` driver does not publish to.
The driver covers **LinkedIn and YouTube only**, and D-23's gap for it reads *"no live LinkedIn/YouTube
credential exists"*. Those are two different blockers, and only the second is on this path.

**What this does NOT achieve:** publishing on behalf of *client* organisations. Dev-tier credentials act
only on assets the developer administers, which is exactly OQ-3 ("own brand first") and exactly what
`SOCIAL_OWN_BRAND_CLIENT_IDS` already enforces in code. Client publishing still needs app review.

> ⚠ **Two provider-policy points I could not verify from here** — check them at the console as you go,
> and stop if either is wrong rather than working around it:
> 1. LinkedIn's `w_organization_social` sits under the Community Management API, which normally
>    requires review. Development-tier apps are expected to be able to act on an organization the
>    developer is an **admin** of. If the console refuses, that expectation is wrong and this path
>    needs review after all — say so rather than requesting broader scopes.
> 2. Google's OAuth consent screen in **Testing** mode issues refresh tokens that **expire in 7 days**.
>    First light will work; the connection will then need re-consent weekly until the app is verified.
>    Plan for that rather than being surprised by a dead token next week.

---

## 1 · LinkedIn

1. **LinkedIn Developers → Create app.** Associate it with the **Gaiada company page** (the app must be
   linked to a page you administer; that association is what makes the org scopes usable).
2. **Products:** request *Community Management API*. Verify the app via the page-admin flow it prompts for.
3. **Auth → OAuth 2.0 scopes** — these two, and nothing more. The code requests exactly these
   (`publisher/linkedin-oauth.ts#LINKEDIN_SCOPES`); a broader grant is a larger blast radius for no gain:
   ```
   w_organization_social
   r_organization_social_feed
   ```
4. **Authorized redirect URL** — must match **byte for byte**. Note it is deliberately
   tenant-agnostic (the tenant travels signed inside the `state`, never in the URL):
   ```
   https://erp.gaiada.online/api/social/linkedin/oauth/callback
   ```
5. **Copy out:** Client ID, Client Secret, and the **organization URN** of the page
   (`urn:li:organization:<numeric id>`, from the page's admin URL).

## 2 · YouTube

1. **Google Cloud console → new project** (or reuse the SEO one — but a separate project keeps social's
   quota and consent screen independent of Search Console's, which is worth the extra minute).
2. **Enable the *YouTube Data API v3*.**
3. **OAuth consent screen:** External, **publishing status: Testing**. Add the Google account that owns
   the Gaiada channel as a **Test user** — without this the consent screen refuses it.
4. **Scopes** — exactly these two (`publisher/youtube-oauth.ts#YOUTUBE_SCOPES`). Deliberately no
   analytics and no DM scope:
   ```
   https://www.googleapis.com/auth/youtube.upload
   https://www.googleapis.com/auth/youtube.force-ssl
   ```
5. **Credentials → OAuth client ID → Web application → Authorized redirect URI:**
   ```
   https://erp.gaiada.online/api/social/youtube/oauth/callback
   ```
6. **Copy out:** Client ID and Client Secret. The code already sends `access_type=offline` and
   `prompt=consent`, so a refresh token is issued without further config.

## 3 · Wiring — `.env` on the VPS

```bash
# --- LinkedIn ---
SOCIAL_LINKEDIN_CLIENT_ID=...
SOCIAL_LINKEDIN_CLIENT_SECRET=...
SOCIAL_LINKEDIN_REDIRECT_URI=https://erp.gaiada.online/api/social/linkedin/oauth/callback
SOCIAL_LINKEDIN_ORGANIZATION_URN=urn:li:organization:XXXXXXX

# --- YouTube ---
SOCIAL_YOUTUBE_CLIENT_ID=...
SOCIAL_YOUTUBE_CLIENT_SECRET=...
SOCIAL_YOUTUBE_REDIRECT_URI=https://erp.gaiada.online/api/social/youtube/oauth/callback

# --- the four gates that ALSO have to move, or the above does nothing ---
SOCIAL_PUBLISHER_DRIVER=direct          # default is "postiz"; without this the direct driver is never selected
SOCIAL_NETWORKS_ENABLED=linkedin,youtube # default is "instagram,facebook,linkedin" — youtube is NOT in it
SOCIAL_OWN_BRAND_CLIENT_IDS=<clients.id of the Gaiada own-brand client row>
SOCIAL_CONNECT_REDIRECT_URL=https://erp.gaiada.online/departments/social-media/settings
```

> ✅ **The compose passthrough is ALREADY DONE** — you only need to set the values in `.env`.
> Nine of these eleven were missing from `platform`'s `environment:` block; they are now declared
> (empty) in `infra/compose/docker-compose.vps.yml`. `SOCIAL_PUBLISHER_DRIVER` and
> `SOCIAL_NETWORKS_ENABLED` were already passed through, so for those two only the `.env` value changes.
>
> This mattered enough to do rather than document: **a var in `.env` does nothing unless the service's
> compose `environment:` block lists it**, and that exact gap cost this program a real incident —
> `INTEGRATION_TOKEN_KEY` sat in `.env` with a 43-char value while the container read `""`, and three
> shipped features could never have worked. Declared-but-empty is the honest resting state: the
> readiness checks refuse with a NAMED reason rather than half-working. Confirm from inside anyway:
> ```bash
> docker inspect gaiada-platform-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ^SOCIAL_
> ```
> ⚠ **Re-check `GAIADA_TAG` in `.env` immediately before any `up -d`.** A stale value silently rolls the
> release back as a side effect of a config change.

## 4 · Verification — let the code tell you what is missing

The readiness endpoints refuse with **named reasons**, so use them as the probe rather than guessing.
`checkLinkedInConnectReadiness` refuses in this order: network not enabled → client not own-brand →
no redirect URI → no app credentials (`platform_app_not_registered`). Walk it until it stops refusing:

```bash
# 1. readiness (expect a named refusal, then clean, as you fill each gate in)
curl -s -H "$AUTH" "https://erp.gaiada.online/api/$TENANT/modules/social/publisher-orgs/$CLIENT/linkedin/connect"
curl -s -H "$AUTH" "https://erp.gaiada.online/api/$TENANT/modules/social/publisher-orgs/$CLIENT/youtube/connect"
```

Use `scripts/sso-login.sh` for `$AUTH` — it drives the real auth-code + PKCE flow against the live API.
Only ~7 platform users have Keycloak accounts; a `users` row is not a login.

2. **Open the returned authorize URL in a browser**, consent as the page/channel admin. The callback
   consumes a single-use, principal-bound state (`social_oauth_states`) — if you replay the URL it
   refuses, which is correct.
3. **Confirm the account is connected** and its token stored, then drive the real chain:
   draft a variant → `POST variants/:variantId/approve` (mints the D14 grant) → decide the approval →
   dispatch. `social.publishPost` refuses without a one-shot approval id by design (D-6).
4. **Then, and only then**, the claim "DEV-VERIFIED" is available for the publish loop — and it means
   *you watched a post appear on the network*, not that a suite went green.

## 5 · What stays blocked after this

- **Client-org publishing** — needs LinkedIn app review; dev tier covers own assets only.
- **Instagram / Facebook** — needs Meta Business Verification. Unblocked independently of this runbook.
- **X** — disabled at deployment level by OQ-2 ($0 path). Its metering path exists and is barred.
- **YouTube token longevity** — 7-day refresh tokens until the app leaves Testing (see the caveat above).
