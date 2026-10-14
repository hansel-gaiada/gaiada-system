# Runbook: switch on Google Drive and Figma (DW-11 items 6 and 7)

**Status: both are built and on main, PROTOTYPED against stubs.** Nothing here has met real Google or real Figma yet.
These are the owner steps that let DW-6i (Google Drive) and DW-6k (Figma) be proven live. Contracts:
`docs/FRONTEND-BFF-CONTRACT.md` §42 (Drive) and §36 (Figma). Code: `platform-nest/src/core/google-drive/` and
`platform-nest/src/core/figma/`.

Until a step is done, the ERP says so in plain words and calls nobody. Drive shows "Google Drive isn't set up for this ERP
yet". Figma shows "Figma isn't connected for this company".

**Never paste a key, secret or token into a chat, a ticket or the repo** (the repo is public). The steps below say where
each value goes.

## 1. Google Drive (DW-11 item 6)

Each person connects their OWN Drive, with the `drive.file` scope. With that scope the ERP only ever sees the files a person
picks in Google's Picker. Google lists `drive.file` as non-sensitive, so the app needs no Google security review for it.

### 1.1 Decide one thing first: who may connect

On the OAuth consent screen you choose a user type. It decides who can connect and how long a connection lasts.

- **Internal** (only accounts in the gaiada.com Google Workspace). No Google review, and connections do not expire. Choose
  this if everyone who will attach Drive files signs in to Google with a gaiada.com account.
- **External** (any Google account). You MUST then set the publishing status to **In production**. While an External app is in
  **Testing**, Google expires every refresh token after 7 days, so every person would have to reconnect each week.
  - With only `drive.file`, `openid` and `email` there is no security (data-access) review.
  - Google still asks for a short **brand verification** (typically 2 to 3 business days) before the app's name and logo show
    on the consent screen. Until then, an unverified app is capped in how many accounts can connect.

### 1.2 In the Google Cloud console

Use a project of its own (for example "Gaiada ERP Drive"). Its consent screen is then not tied to the search app's pending
verification (DW-11 item 1). The OAuth client, the API key and the app id must all come from this ONE project, because the
Picker requires it.

1. **Enable two APIs** (APIs & Services > Library): **Google Drive API** and **Google Picker API**.
2. **OAuth consent screen** (Google Auth Platform):
   - user type as decided in 1.1;
   - app name "Gaiada ERP" and a support email;
   - scopes `.../auth/drive.file`, `openid` and `.../auth/userinfo.email`;
   - if External, press **Publish app** so the status reads "In production".
3. **OAuth client** (Credentials > Create credentials > OAuth client ID): type **Web application**.
   - Authorized JavaScript origin: `https://erp.gaiada.com`
   - Authorized redirect URI, exactly: `https://erp.gaiada.com/api/google-drive/callback`
   - Keep the **Client ID** and **Client secret**.
4. **API key** (Credentials > Create credentials > API key), for the Picker in the browser. Edit it and restrict it:
   - Application restrictions: **Websites**, `https://erp.gaiada.com/*`
   - API restrictions: **Google Picker API** and **Google Drive API**
5. **App id** = the project **number** (IAM & Admin > Settings > Project number). It is a number, not the project id.

### 1.3 Hand the five values over (not in chat)

Write them into a file on this laptop, `C:\Users\Hansel\.claude\secrets\google-drive-oauth.env`:

```
GOOGLE_DRIVE_CLIENT_ID=<the OAuth client id>
GOOGLE_DRIVE_CLIENT_SECRET=<the OAuth client secret>
GOOGLE_DRIVE_REDIRECT_URI=https://erp.gaiada.com/api/google-drive/callback
GOOGLE_PICKER_API_KEY=<the API key>
GOOGLE_PICKER_APP_ID=<the project number>
```

Then tell Claude the file is there. Claude then:
- backs up the ERP host's `~/gaiada/infra/compose/.env` (gda-aicenter);
- appends the five lines;
- recreates the `platform` service (or lets the next release deploy pick them up).

All five are needed; with any one missing, Drive stays "not set up". The compose file already passes them through
(`infra/compose/docker-compose.vps.yml`).

### 1.4 The live proof (ticks DW-6i)

In the new layout, open Web Dev > Tools & connections.
1. The Drive block now reads "not connected", with **Connect Google Drive**. Connect with one real account.
2. You come back to the same page, with "Google Drive is connected." and the account's email.
3. Open a PM task. Under Attachments, press **Attach from Google Drive**, pick a file, and check that it appears as a link
   with the Drive mark and opens in Drive.
4. Disconnect, and check that the attachment stays.

If the return shows "Google Drive couldn't be connected", the most likely cause is a redirect URI that does not match
character for character (see 1.2 step 3).

## 2. Figma (DW-11 item 7)

Figma is connected once per company, by a manager, with a token. The ERP reads files, frames, comments and image exports; it
never writes to Figma.

### 2.1 Create a personal access token

Use a Figma account that can open every file the team will link. A shared "Gaiada ERP" account is better than a person's
own, because the links stop working when that person's access goes.

In Figma: Settings > Security > Personal access tokens > Generate new token.
- **Scopes:** File content, read (`file_content:read`), and Comments, read (`file_comments:read`). Nothing else is needed.
- **Expiry:** Figma no longer issues tokens that never expire; the longest is 90 days. Put a reminder in the calendar a week
  before it expires.

Use a personal access token rather than "OAuth" as the token type. An OAuth token needs a Figma OAuth app registered first.
It also expires (after 90 days by default), and the ERP has no Figma refresh flow, so it gains nothing over a personal access
token.

### 2.2 Seal it in the ERP

In the new layout, open Web Dev (or Creatives) > Tools & connections > Figma. As a manager:
1. Paste the token into **Figma token**, keep **Token type: Personal access token**, and press Connect.
2. The block shows "connected" and the token type. The token is sealed on the server and never shown again.

To rotate it, paste the new token in the same place. Panels that say "Figma refused the company's token" mean it expired or
was revoked.

### 2.3 The live proof (ticks DW-6k)

On a PM task, paste the URL of a real Figma frame into Designs. Then check:
- the thumbnail and "changed <time>" appear;
- the open-comment count appears;
- an export (PNG) lands as a new version in the Asset Library.

## Sources (read 2026-10-14)

- Drive scopes and their classification: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Picker setup (both APIs, the API key, the app id = project number, one project): https://developers.google.com/workspace/drive/picker/guides/web-picker
- Refresh tokens of an External app in Testing expire after 7 days: https://developers.google.com/identity/protocols/oauth2
- Brand verification for an External app's name and logo: https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- Figma OAuth tokens (90 days by default, one per app per user): https://developers.figma.com/docs/rest-api/oauth-apps/
- Figma scopes: https://developers.figma.com/docs/rest-api/scopes/ and personal access tokens (90-day maximum): https://developers.figma.com/docs/rest-api/personal-access-tokens/
