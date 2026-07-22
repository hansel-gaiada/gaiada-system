#!/usr/bin/env node
// One-time: mint a Google Drive refresh token for a FREE personal account (installed-app OAuth,
// loopback redirect). Run: DRIVE_CLIENT_ID=.. DRIVE_CLIENT_SECRET=.. node scripts/get-drive-token.mjs
// Then paste the printed DRIVE_REFRESH_TOKEN into .env. Scope = drive.file (only files this app creates).
import { createServer } from "node:http";

const clientId = process.env.DRIVE_CLIENT_ID;
const clientSecret = process.env.DRIVE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set DRIVE_CLIENT_ID and DRIVE_CLIENT_SECRET (from Google Cloud → APIs & Services → Credentials → OAuth client, type 'Desktop app').");
  process.exit(1);
}

const PORT = 53682;
const redirectUri = `http://127.0.0.1:${PORT}`;
const scope = "https://www.googleapis.com/auth/drive.file";
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent", // force a refresh_token every time
  }).toString();

console.log("\n1) Open this URL in your browser and approve:\n\n" + authUrl + "\n");
console.log(`2) Waiting for the redirect on ${redirectUri} …\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get("code");
  if (!code) { res.writeHead(400); return res.end("no code"); }
  try {
    const tok = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const j = await tok.json();
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h2>Done — you can close this tab and return to the terminal.</h2>");
    if (j.refresh_token) {
      console.log("\n✅ Success. Add this to your .env:\n");
      console.log("DRIVE_REFRESH_TOKEN=" + j.refresh_token + "\n");
    } else {
      console.error("\n⚠️ No refresh_token returned. Revoke the app's access at https://myaccount.google.com/permissions and retry (prompt=consent).\n", j);
    }
  } catch (e) {
    console.error("token exchange failed:", e);
  } finally {
    setTimeout(() => { server.close(); process.exit(0); }, 500);
  }
});
server.listen(PORT, "127.0.0.1");
