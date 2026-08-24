// Minting real IdP tokens for the "human" identity path, in-process.
//
// This is the authorization_code + PKCE flow `scripts/sso-login.sh` proved out, reimplemented with
// fetch because the harness runs in a container with no bash, curl or openssl. It is the same
// exchange a browser performs, which is the whole point: the "human" path in the corpus has to mean
// a credential a person could actually hold, not a service token wearing a name badge.
//
// DEGRADES, NEVER THROWS. The 19 seeded staff accounts carry a pending UPDATE_PASSWORD required
// action until `scripts/enable-staff-logins.sh` is run, and until then Keycloak answers the
// authorization request with an interstitial instead of a code. That is a configuration state, not
// an error, so `tokenFor()` returns null and the caller skips the human path with a recorded note.
// Throwing here would take the whole simulation down over something that is expected to be false
// for a while.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { logFinding } from "./log.js";

const REALM = config.publicUrl.replace(/\/$/, "") + "/idp/realms/gaiada";
const CLIENT_ID = "gaiada-ui";
const REDIRECT = config.publicUrl.replace(/\/$/, "") + "/auth/callback";

/** Tokens are reused until shortly before they expire. Re-running the full PKCE dance per request
 *  would add three round trips to every simulated click and would hammer Keycloak for no reason. */
const cache = new Map<string, { token: string; expiresAt: number }>();

let password: string | null | undefined;
function simPassword(): string | null {
  if (password !== undefined) return password;
  try {
    password = readFileSync(config.simPasswordFile, "utf8").trim() || null;
  } catch {
    password = null;
  }
  if (!password) {
    logFinding({
      key: "human-path-unavailable",
      severity: "info",
      title: "The human identity path is not available",
      detail:
        "No simulation password file was readable, so no real IdP token can be minted. Run scripts/enable-staff-logins.sh and mount /etc/gaiada/sim-staff.pw into the container. Until then every human-path scenario is skipped and the corpus covers only the service/agent paths — which means the agentic-native parity comparison has nothing to compare against.",
      evidence: { passwordFile: config.simPasswordFile },
    });
  }
  return password;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A minimal cookie jar. Keycloak's login form carries session state in cookies (KC_RESTART,
 *  AUTH_SESSION_ID), so the authorization request and the form POST must share them or the POST is
 *  rejected as a fresh, unknown session. */
function mergeCookies(jar: Map<string, string>, res: Response): void {
  // getSetCookie is the only way to see MULTIPLE Set-Cookie headers; res.headers.get() joins them
  // into one string and silently corrupts values containing a comma.
  const raw = typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : [];
  for (const line of raw) {
    const first = line.split(";")[0];
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function mint(email: string): Promise<string | null> {
  const pw = simPassword();
  if (!pw) return null;

  const verifier = randomBytes(48).toString("hex");
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(12).toString("hex");
  const jar = new Map<string, string>();

  const authUrl =
    `${REALM}/protocol/openid-connect/auth?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code` +
    `&scope=${encodeURIComponent("openid profile email")}&state=${state}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;

  const page = await fetch(authUrl, { redirect: "follow" });
  mergeCookies(jar, page);
  const html = await page.text();

  // The form action carries the session_code/execution/tab_id Keycloak needs; it cannot be
  // constructed, only read back.
  const action = /action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  if (!action) return null;

  const form = new URLSearchParams({ username: email, password: pw, credentialId: "" });
  // `redirect: "manual"` matters: the authorization code arrives in the Location header of a 302 to
  // the redirect_uri. Following it would hand the code to the UI's callback route, which consumes it,
  // and this flow would then exchange a code that has already been spent.
  const post = await fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
    body: form.toString(),
  });
  const location = post.headers.get("location") ?? "";
  const code = /[?&]code=([^&]+)/.exec(location)?.[1];
  if (!code) return null;

  const tokenRes = await fetch(`${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code: decodeURIComponent(code),
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) return null;
  const json = (await tokenRes.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;

  cache.set(email, {
    token: json.access_token,
    // 60s of headroom: a token that expires mid-scenario would produce 401s that look like an authz
    // defect rather than an expiry.
    expiresAt: Date.now() + Math.max(30, (json.expires_in ?? 300) - 60) * 1000,
  });
  return json.access_token;
}

export async function tokenFor(email: string): Promise<string | null> {
  const hit = cache.get(email);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  try {
    return await mint(email);
  } catch (err) {
    logFinding({
      key: "human-token-mint-failed",
      severity: "medium",
      title: "Minting a real IdP token failed",
      detail: "The PKCE exchange threw. The human identity path is unavailable for this actor.",
      evidence: { email, error: (err as Error).message },
    });
    return null;
  }
}

/** True once at least one token has been minted — lets the driver report honestly whether the
 *  corpus contains a human-path arm at all. */
export function humanPathLive(): boolean {
  return cache.size > 0;
}
