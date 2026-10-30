// PID-2 proof (docs/plans/2026-10-30-phone-identity.md §5, tickets 2a-2f, 2i): drives a throwaway Keycloak 26.8.1
// that holds the repo realm + infra/scripts/keycloak-passkey-realm.sh, in a real Chromium with Chrome's DevTools
// VIRTUAL AUTHENTICATOR standing in for "the passkey on the person's phone" (ctap2, internal transport, resident
// keys, user verification). Run by keycloak-passkey-realm-test.sh `e2e`, never by hand against a real server.
//
// How it runs on sumopod: in mcr.microsoft.com/playwright:v1.56.0-noble with `--network container:pid2-kc`, so the
// page is http://localhost:8080/idp/... (a secure context, RP ID "localhost"), and NODE_PATH pointing at a one-time
// install of playwright-core 1.56.0 (the image ships browsers, not the package):
//   docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp -v ~/kc-pid2/pw:/w -w /w mcr.microsoft.com/playwright:v1.56.0-noble \
//     sh -c 'npm init -y >/dev/null && npm i --no-audit --no-fund playwright-core@1.56.0'
// Env: KC_BASE, ADMPW (the throwaway bootstrap admin), PW_<USER> per seed user. Nothing secret is printed.
"use strict";
const { chromium } = require("playwright-core");
const crypto = require("node:crypto");

const BASE = process.env.KC_BASE || "http://localhost:8080/idp";
const REALM = "gaiada";
const CLIENT = "pid-test";
const CB = "http://localhost:8080/pid-cb/";
const REDIRECT = CB + "done";
const DENY_MSG = "This account cannot reset its password here";
const LABEL = "This is my own device";
const pw = (u) => process.env["PW_" + u.toUpperCase()];
const email = (u) => `pid.${u}@example.invalid`;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rec(id, ok, evidence) {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${evidence}`);
}
const info = (m) => console.log(`INFO ${m}`);

// ── admin REST (throwaway bootstrap admin of the test container) ────────────────────────────────────────────────
async function adminToken() {
  const r = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "pid2-admin", password: process.env.ADMPW }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("admin token failed");
  return j.access_token;
}
async function admin(method, path, body) {
  const r = await fetch(`${BASE}/admin/realms/${REALM}${path}`, {
    method,
    headers: { authorization: `Bearer ${await adminToken()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let json = null;
  try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json, location: r.headers.get("location") };
}
async function userByName(u) {
  const r = await admin("GET", `/users?username=${encodeURIComponent(u)}&exact=true`);
  return r.json[0];
}
const bf = async (id) => (await admin("GET", `/attack-detection/brute-force/users/${id}`)).json;

// ── tokens ─────────────────────────────────────────────────────────────────────────────────────────────────────
const b64u = (b) => Buffer.from(b).toString("base64url");
function pkce() {
  const verifier = b64u(crypto.randomBytes(32));
  return { verifier, challenge: b64u(crypto.createHash("sha256").update(verifier).digest()) };
}
function authUrl(p, extra = {}) {
  const q = new URLSearchParams({ client_id: CLIENT, response_type: "code", scope: "openid", redirect_uri: REDIRECT,
    state: b64u(crypto.randomBytes(8)), code_challenge: p.challenge, code_challenge_method: "S256", ...extra });
  return `${BASE}/realms/${REALM}/protocol/openid-connect/auth?${q}`;
}
async function exchange(code, verifier) {
  const r = await fetch(`${BASE}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  const j = await r.json();
  if (!j.access_token) info(`token endpoint said: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function refresh(rt) {
  const r = await fetch(`${BASE}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT, refresh_token: rt }),
  });
  return r.json();
}
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

// ── browser: one context per "device"; a virtual authenticator per page = the person's phone ───────────────────
let browser;
async function device(creds) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const st = { context, page, code: null, cbUrl: null, create: [], get: [], dialogs: 0 };
  await context.route(CB + "**", (route) => {
    st.cbUrl = route.request().url();
    st.code = new URL(st.cbUrl).searchParams.get("code");
    return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>callback</body></html>" });
  });
  await context.addInitScript(() => {
    const c = navigator.credentials;
    const oc = c.create.bind(c), og = c.get.bind(c);
    const strip = (o) => JSON.stringify(o, (k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? `<${v.byteLength}B>` : v));
    c.create = (o) => { console.log("PIDCREATE " + strip(o.publicKey)); return oc(o); };
    c.get = (o) => { console.log("PIDGET " + strip(o.publicKey)); return og(o); };
  });
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("PIDCREATE ")) st.create.push(JSON.parse(t.slice(10)));
    if (t.startsWith("PIDGET ")) st.get.push(JSON.parse(t.slice(7)));
  });
  page.on("dialog", (d) => { st.dialogs++; d.accept("PID test phone").catch(() => {}); });
  if (creds !== undefined) {
    st.cdp = await context.newCDPSession(page);
    await st.cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await st.cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    st.authId = authenticatorId;
    for (const c of creds) await st.cdp.send("WebAuthn.addCredential", { authenticatorId, credential: c });
  }
  return st;
}
let aliceCreds;
async function keep(st) { if (st.cdp) aliceCreds = await phoneCreds(st); }
const phoneCreds = async (st) => (await st.cdp.send("WebAuthn.getCredentials", { authenticatorId: st.authId })).credentials;

async function has(page, sel) { return (await page.locator(sel).count()) > 0; }
async function kind(st) {
  const p = st.page;
  if (p.url().startsWith(CB)) { st.cbUrl = p.url(); st.code = new URL(p.url()).searchParams.get("code"); return "callback"; }
  if (st.code) return "callback";
  if (await has(p, "#password-new")) return "update-password";
  if (await has(p, "#phoneNumber")) return "profile";
  if (await has(p, "#registerWebAuthn")) return "webauthn-register";
  if (await has(p, "#authenticateWebAuthnButton")) return "webauthn-auth";
  if ((await has(p, "#username")) && (await has(p, "#password"))) return "login";
  if ((await has(p, "#username")) && p.url().includes("reset-credentials")) return "choose-user";
  if (/Passkey Error|webauthn/i.test(await p.title()) || (await has(p, "#kc-try-again"))) return "webauthn-error";
  return "other";
}
async function text(page) {
  return (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 240);
}
async function act(page, fn) {
  await Promise.all([page.waitForNavigation({ timeout: 20000 }).catch(() => null), fn()]);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}
async function submit(page) {
  const b = page.locator('form button[type=submit]:not([name=cancel-aia]), form input[type=submit]:not([name=cancel-aia])').first();
  await act(page, () => b.click());
}
// Drive the pages until the callback, a page kind in `stopAt`, or `max` steps. `a` holds the inputs.
async function drive(st, a, { stopAt = [], max = 12 } = {}) {
  const trail = [];
  const page = st.page;
  for (let i = 0; i < max; i++) {
    const k = await kind(st);
    trail.push(k);
    if (k === "callback" || stopAt.includes(k)) return { kind: k, trail };
    if (k === "login") {
      await page.fill("#username", a.username);
      await page.fill("#password", a.password);
      if (a.remember && (await has(page, "#rememberMe"))) await page.check("#rememberMe");
      await act(page, () => page.click("#kc-login"));
    } else if (k === "choose-user") {
      await page.fill("#username", a.resetUser);
      await submit(page);
    } else if (k === "profile") {
      if (a.newUsername && (await page.locator("#username").isEditable().catch(() => false))) await page.fill("#username", a.newUsername);
      await page.fill("#phoneNumber", a.phone);
      await submit(page);
    } else if (k === "webauthn-register") {
      await act(page, () => page.click("#registerWebAuthn"));
    } else if (k === "webauthn-auth") {
      const u0 = page.url();
      await page.waitForURL((u) => u.toString() !== u0, { timeout: 3000 }).catch(() => null);
      if ((await kind(st)) === "webauthn-auth") await act(page, () => page.click("#authenticateWebAuthnButton"));
    } else if (k === "update-password") {
      st.logoutSessionsChecked = await page.locator("#logout-sessions").isChecked().catch(() => null);
      if (a.logoutOthers) await page.check("#logout-sessions");
      await page.fill("#password-new", a.newPassword);
      await page.fill("#password-confirm", a.newPassword);
      await submit(page);
    } else {
      return { kind: k, trail, text: await text(page) };
    }
    if (trail.length >= 3 && trail.slice(-3).every((x) => x === k)) return { kind: k, trail, text: await text(page), stuck: true };
  }
  return { kind: await kind(st), trail, text: await text(page) };
}
async function signIn(st, a, opts) {
  const p = pkce();
  st.code = null;
  await st.page.goto(authUrl(p, a.extra || {}));
  const r = await drive(st, a, opts);
  if (r.kind === "callback" && st.code) r.tokens = await exchange(st.code, p.verifier);
  return r;
}
const amrOf = (r) => (r.tokens && r.tokens.access_token ? JSON.stringify(claims(r.tokens.access_token).amr) : "no token");

// ── scenarios ────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const alice = await userByName(email("alice"));

  // (a) existing-style user: password only, no phone, username = email
  {
    const st = await device([]);
    const p0 = pkce();
    await st.page.goto(authUrl(p0));
    const label = (await st.page.locator("label[for=rememberMe]").innerText().catch(() => "")).trim();
    rec("2e label", label === LABEL, `login page remember-me label = "${label}"`);
    const forgot = await st.page.locator('a[href*="reset-credentials"]').count();
    rec("2d link", forgot > 0, `"Forgot password?" link on the login page: ${forgot}`);
    // a wrong-format phone first: the profile page must refuse it
    await st.page.fill("#username", email("alice"));
    await st.page.fill("#password", pw("alice"));
    await act(st.page, () => st.page.click("#kc-login"));
    let r = await drive(st, {}, { stopAt: ["profile", "webauthn-register"] });
    const order = [r.kind];
    if (r.kind === "profile") {
      const editable = await st.page.locator("#username").isEditable().catch(() => false);
      await st.page.fill("#phoneNumber", "081234567890");
      await submit(st.page);
      const still = await kind(st);
      const t = await text(st.page);
      rec("2a phone format", still === "profile" && /\+62/.test(t), `phone "08…" refused, page stays on profile: "${t.slice(0, 160)}"`);
      rec("2a username editable", editable, `verify-profile shows an editable username field: ${editable}`);
    }
    r = await drive(st, { phone: "+6281234567001", newUsername: "pid.alice" }, { stopAt: ["webauthn-register"] });
    order.push(...r.trail);
    if (r.kind === "webauthn-register") {
      const skip = await st.page.locator('#cancelWebAuthnAIA, [name=cancel-aia], a:has-text("Skip"), button:has-text("Skip"), button:has-text("Cancel"), input[value="Cancel"]').count();
      rec("2c no skip", skip === 0, `passkey registration page offers no cancel/skip control (found ${skip})`);
    }
    r = await drive(st, { phone: "+6281234567001", newUsername: "pid.alice" });
    order.push(...r.trail);
    const first = r.kind === "callback" && st.code ? await exchange(st.code, p0.verifier) : null;
    info(`first sign-in pages: ${order.join(" -> ")}`);
    const cr = st.create[0];
    rec("2b create options", !!cr && cr.rp && cr.rp.id === "localhost" && cr.authenticatorSelection && cr.authenticatorSelection.userVerification === "required"
      && (cr.authenticatorSelection.residentKey === "required" || cr.authenticatorSelection.requireResidentKey === true)
      && !cr.authenticatorSelection.authenticatorAttachment && (cr.attestation || "none") === "none",
      `navigator.credentials.create: rp.id=${cr && cr.rp && cr.rp.id} attestation=${cr && cr.attestation} authenticatorSelection=${cr && JSON.stringify(cr.authenticatorSelection)}`);
    aliceCreds = await phoneCreds(st);
    const u = (await admin("GET", `/users/${alice.id}`)).json;
    const cred = (await admin("GET", `/users/${alice.id}/credentials`)).json.map((c) => c.type);
    rec("a enrol", r.kind === "callback" && aliceCreds.length === 1 && cred.includes("webauthn"),
      `first sign-in ended at the client; username now "${u.username}", phoneNumber ${JSON.stringify(u.attributes && u.attributes.phoneNumber)}, credentials [${cred}], resident credentials on the phone: ${aliceCreds.length}`);
    rec("2f amr after enrolment", !!(first && first.access_token) && JSON.stringify(claims(first.access_token).amr) === '["pwd"]', `the enrolment session's amr = ${first ? JSON.stringify(claims(first.access_token).amr) : "no token"} (password step done, the passkey was registered, not used)`);
    await st.context.close();
  }

  // (a2) the registration cannot be skipped: bob stops at the passkey page, then tries again in a fresh browser
  {
    const st = await device([]);
    let r = await signIn(st, { username: email("bob"), password: pw("bob"), phone: "+6281234567002" }, { stopAt: ["webauthn-register"] });
    const at1 = r.kind;
    await st.page.goto(authUrl(pkce()));
    const again = await kind(st);
    await st.context.close();
    const st2 = await device([]);
    r = await signIn(st2, { username: email("bob"), password: pw("bob") }, { stopAt: ["webauthn-register"] });
    const bob = await userByName(email("bob"));
    const creds = (await admin("GET", `/users/${bob.id}/credentials`)).json.map((c) => c.type);
    rec("a2 cannot skip", at1 === "webauthn-register" && again !== "callback" && r.kind === "webauthn-register" && !creds.includes("webauthn"),
      `bob: after the password -> ${at1}; a new auth request in the same browser -> ${again}; a fresh browser + password -> ${r.kind}; no code issued; credentials [${creds}], requiredActions ${JSON.stringify((await admin("GET", `/users/${bob.id}`)).json.requiredActions)}`);
    await st2.context.close();
  }

  // (b) next sign-in: password then passkey; amr; (c) by username and by email
  let rememberedSessionId = null;
  {
    const st = await device(aliceCreds);
    const r = await signIn(st, { username: "pid.alice", password: pw("alice") });
    await keep(st);
    const c = r.tokens && r.tokens.access_token ? claims(r.tokens.access_token) : {};
    rec("b password+passkey (by username)", r.kind === "callback" && JSON.stringify(c.amr) === '["pwd","hwk"]',
      `pages ${r.trail.join(" -> ")}; access token amr=${JSON.stringify(c.amr)} auth_time=${c.auth_time} acr=${c.acr}`);
    const g = st.get[0];
    rec("2b get options", !!g && g.rpId === "localhost" && g.userVerification === "required",
      `navigator.credentials.get: rpId=${g && g.rpId} userVerification=${g && g.userVerification} allowCredentials=${g && g.allowCredentials ? g.allowCredentials.length : "none"}`);
    const ck = (await st.context.cookies()).filter((k) => /^KEYCLOAK_(SESSION|IDENTITY)/.test(k.name));
    const now = Date.now() / 1000;
    const idc = ck.find((k) => k.name === "KEYCLOAK_IDENTITY"), ses = ck.find((k) => k.name === "KEYCLOAK_SESSION");
    rec("e unticked = no 7-day cookie", !!idc && idc.expires === -1 && (!ses || ses.expires === -1 || ses.expires - now <= 36000 + 60),
      `not ticked: ${ck.map((k) => `${k.name} ${k.expires === -1 ? "browser-session cookie" : `expires in ${Math.round(k.expires - now)} s`}`).join(", ")}`);
    await st.context.close();
  }
  {
    const st = await device(aliceCreds);
    const r = await signIn(st, { username: email("alice"), password: pw("alice") });
    await keep(st);
    rec("c sign-in by email", r.kind === "callback", `pages ${r.trail.join(" -> ")}; amr=${amrOf(r)}`);
    await st.context.close();
  }
  {
    const st = await device([]); // a phone WITHOUT alice's passkey
    const r = await signIn(st, { username: "pid.alice", password: pw("alice") }, { max: 4 });
    const other = await st.page.locator('#try-another-way, a:has-text("Try another way")').count();
    rec("b no passkey = refused", r.kind !== "callback" && !st.code,
      `pages ${r.trail.join(" -> ")}; no code; "try another way": ${other}; page: "${(r.text || (await text(st.page))).slice(0, 140)}"`);
    await st.context.close();
  }
  info("c phone sign-in: out of scope here (PID-2h, the Java extension); username and email only");

  // (e) remember-me ticked: ~7-day cookies, then SSO without any page
  let remembered;
  {
    const st = await device(aliceCreds);
    const t0 = Date.now() / 1000;
    const r = await signIn(st, { username: "pid.alice", password: pw("alice"), remember: true });
    await keep(st);
    const ck = (await st.context.cookies()).filter((k) => /^KEYCLOAK_(SESSION|IDENTITY)/.test(k.name));
    const ok = ck.length > 0 && ck.every((k) => Math.abs(k.expires - t0 - 604800) < 120);
    rec("e ticked = 7-day cookie", r.kind === "callback" && ok, `ticked: ${ck.map((k) => `${k.name} expires in ${Math.round(k.expires - t0)} s`).join(", ")}`);
    const sess = (await admin("GET", `/users/${alice.id}/sessions`)).json;
    const s = sess.find((x) => x.rememberMe);
    rememberedSessionId = s && s.id;
    info(`alice sessions: ${sess.map((x) => `${x.id.slice(0, 8)} rememberMe=${x.rememberMe}`).join(", ")}`);
    const r2 = await signIn(st, {}, { stopAt: ["login"], max: 2 });
    const c1 = r.tokens && r.tokens.access_token ? claims(r.tokens.access_token) : {}, c2 = r2.tokens && r2.tokens.access_token ? claims(r2.tokens.access_token) : {};
    const t3 = r.tokens && r.tokens.refresh_token ? await refresh(r.tokens.refresh_token) : null;
    info(`refresh inside the 900 s hwk window: amr=${t3 && t3.access_token ? JSON.stringify(claims(t3.access_token).amr) : "no token"}`);
    rec("e remembered = no prompt", r2.kind === "callback" && r2.trail.length === 1,
      `second request in the remembered browser went straight to the client (pages ${r2.trail.join(" -> ")}); amr=${JSON.stringify(c2.amr)}; auth_time unchanged ${c1.auth_time === c2.auth_time} (PID-3 must read auth_time)`);
    remembered = st; // kept open: the reset below must end this session
  }

  // (d0) CRITICAL: a NAIVE reset flow (Choose User -> WebAuthn REQUIRED -> Reset Password) on an account with no passkey
  {
    const mk = async (body) => admin("POST", "/authentication/flows", body);
    await mk({ alias: "pid-naive-reset", providerId: "basic-flow", topLevel: true, builtIn: false, description: "throwaway: the unsafe shape" });
    for (const p of ["reset-credentials-choose-user", "webauthn-authenticator", "reset-password"]) {
      await admin("POST", "/authentication/flows/pid-naive-reset/executions/execution", { provider: p });
      const ex = (await admin("GET", "/authentication/flows/pid-naive-reset/executions")).json.find((e) => e.providerId === p);
      await admin("PUT", "/authentication/flows/pid-naive-reset/executions", { ...ex, requirement: "REQUIRED" });
    }
    await admin("PUT", "", { resetCredentialsFlow: "pid-naive-reset" });
    const nina = await userByName(email("nina"));
    const before = (await admin("GET", `/users/${nina.id}/credentials`)).json.map((c) => c.type);
    const st = await device([]); // the ATTACKER's phone
    await st.page.goto(authUrl(pkce()));
    await act(st.page, () => st.page.click('a[href*="reset-credentials"]'));
    const attackerPw = "Att" + crypto.randomBytes(8).toString("hex") + "1!";
    const r = await drive(st, { resetUser: email("nina"), newPassword: attackerPw, phone: "+6281234567003" });
    const after = (await admin("GET", `/users/${nina.id}/credentials`)).json.map((c) => c.type);
    const took = r.kind === "callback" && after.includes("webauthn");
    rec("d0 naive flow observed", true,
      `26.8.1 SKIPS the unconfigured REQUIRED WebAuthn in a reset flow: nina (no passkey) pages ${r.trail.join(" -> ")}; credentials before [${before}] after [${after}]; ${took ? "a stranger set her password AND enrolled their own passkey, then got a code" : "not taken over: " + (r.text || "")}`);
    await st.context.close();
    await admin("PUT", "", { resetCredentialsFlow: "gaiada-passkey-reset" });
    const f = (await admin("GET", "/authentication/flows")).json.find((x) => x.alias === "pid-naive-reset");
    await admin("DELETE", `/authentication/flows/${f.id}`);
  }

  // (d1) forgot password WITH the passkey: passkey -> new password. Twice: once as Keycloak shows the form (the
  // "sign out from other devices" box unticked), once ticked. The remembered browser from (e) shows whether it ended.
  const resetPw = [1, 2].map((i) => "New" + crypto.randomBytes(8).toString("hex") + i + "!");
  const newAlicePw = resetPw[1];
  for (const [i, tick] of [[0, false], [1, true]]) {
    const st = await device(aliceCreds);
    const pr = pkce();
    await st.page.goto(authUrl(pr));
    await act(st.page, () => st.page.click('a[href*="reset-credentials"]'));
    const r = await drive(st, { resetUser: "pid.alice", newPassword: resetPw[i], logoutOthers: tick });
    await keep(st);
    const sess = (await admin("GET", `/users/${alice.id}/sessions`)).json;
    const oldGone = !!rememberedSessionId && !sess.some((x) => x.id === rememberedSessionId);
    const r2 = await signIn(remembered, {}, { stopAt: ["login"], max: 1 });
    if (!tick) {
      rec("d1 reset with passkey", r.trail.includes("webauthn-auth") && r.trail.includes("update-password") && r.kind === "callback",
        `pages ${r.trail.join(" -> ")}; amr of the reset sign-in=${r.kind === "callback" && st.code ? amrOf({ tokens: await exchange(st.code, pr.verifier) }) : "n/a"}`);
      rec("d1 box left as shown: other sessions SURVIVE (finding)", true,
        `"sign out from other devices" pre-ticked: ${st.logoutSessionsChecked}; remembered session ${oldGone ? "ended" : "STILL ACTIVE"}; the remembered browser -> ${r2.kind}`);
    } else {
      rec("d1 box ticked: other sessions end", oldGone && r2.kind !== "callback",
        `ticked: remembered session ${oldGone ? "ended" : "STILL ACTIVE"}; sessions now ${sess.length}; the remembered browser -> ${r2.kind}`);
    }
    await st.context.close();
  }
  await remembered.context.close();
  {
    const st2 = await device(aliceCreds);
    const r3 = await signIn(st2, { username: "pid.alice", password: newAlicePw });
    await keep(st2);
    rec("d1 new password works", r3.kind === "callback" && !!(r3.tokens && r3.tokens.access_token), `new password + passkey: pages ${r3.trail.join(" -> ")}; amr=${amrOf(r3)}`);
    await st2.context.close();
  }

  // (d2) forgot password WITHOUT a passkey (the critical test, with the script's flow) + an unknown name
  {
    const bob = await userByName(email("bob"));
    const pwBefore = (await admin("GET", `/users/${bob.id}/credentials`)).json.find((c) => c.type === "password");
    const tryReset = async (who) => {
      const st = await device([]);
      await st.page.goto(authUrl(pkce()));
      await act(st.page, () => st.page.click('a[href*="reset-credentials"]'));
      const r = await drive(st, { resetUser: who, newPassword: "X" + crypto.randomBytes(8).toString("hex") + "9!" }, { max: 4 });
      r.text = r.text || (await text(st.page));
      await st.context.close();
      return r;
    };
    const rb = await tryReset(email("bob"));
    const pwAfter = (await admin("GET", `/users/${bob.id}/credentials`)).json.find((c) => c.type === "password");
    rec("d2 no passkey = REFUSED", rb.kind !== "callback" && !rb.trail.includes("update-password") && rb.text.includes(DENY_MSG) && pwBefore.createdDate === pwAfter.createdDate,
      `bob: pages ${rb.trail.join(" -> ")}; page "${rb.text.slice(0, 150)}"; password unchanged ${pwBefore.createdDate === pwAfter.createdDate}`);
    const ru = await tryReset("nobody.at.all");
    rec("d2 unknown name = same answer", ru.kind === rb.kind && ru.text === rb.text, `unknown name: pages ${ru.trail.join(" -> ")}; page "${ru.text.slice(0, 150)}"`);
  }

  // (f) brute force: 3 wrong passwords -> temporary lockout (TEST realm: failureFactor 3, waits 15 s) -> recovers
  {
    const carl = await userByName(email("carl"));
    const st = await device([]);
    await st.page.goto(authUrl(pkce()));
    for (let i = 0; i < 3; i++) {
      await st.page.fill("#username", email("carl"));
      await st.page.fill("#password", "wrong-" + i);
      await act(st.page, () => st.page.click("#kc-login"));
      await sleep(1300); // slower than quickLoginCheckMilliSeconds, so this counts failures, not the quick-login rule
    }
    const s1 = await bf(carl.id);
    await st.page.fill("#username", email("carl"));
    await st.page.fill("#password", pw("carl"));
    await act(st.page, () => st.page.click("#kc-login"));
    const lockedKind = await kind(st), lockedText = await text(st.page);
    const u1 = (await admin("GET", `/users/${carl.id}`)).json;
    rec("f locked", lockedKind === "login" && s1.disabled === true && u1.enabled === true,
      `after 3 wrong: status ${JSON.stringify(s1)}; right password refused with "${(lockedText.match(/Invalid[^.]*\./) || [lockedText.slice(0, 60)])[0]}"; user.enabled=${u1.enabled} (temporary, not permanent)`);
    await sleep(17000);
    await st.page.goto(authUrl(pkce()));
    await st.page.fill("#username", email("carl"));
    await st.page.fill("#password", pw("carl"));
    await act(st.page, () => st.page.click("#kc-login"));
    const k2 = await kind(st);
    rec("f recovers", k2 !== "login", `17 s later the right password passes to: ${k2}; status ${JSON.stringify(await bf(carl.id))}`);
    await st.context.close();
  }

  // (2i) maxSecondaryAuthFailures: what a failed PASSKEY step does at 2 vs 0
  async function enrol(u, phone) {
    const st = await device([]);
    const r = await signIn(st, { username: email(u), password: pw(u), phone });
    const creds = await phoneCreds(st);
    await st.context.close();
    return { ok: r.kind === "callback", creds };
  }
  async function passkeyFailures(u, creds, n) {
    const usr = await userByName(email(u));
    const out = [];
    for (let i = 0; i < n; i++) {
      const st = await device(creds);
      await st.page.route("**/login-actions/authenticate**", async (route) => {
        const req = route.request();
        const body = req.postData() || "";
        if (req.method() === "POST" && body.includes("signature=")) {
          const f = new URLSearchParams(body);
          const sig = f.get("signature") || "";
          f.set("signature", sig.slice(0, 20) + (sig[20] === "A" ? "B" : "A") + sig.slice(21)); // one changed byte
          return route.continue({ postData: f.toString() });
        }
        return route.continue();
      });
      const r = await signIn(st, { username: email(u), password: pw(u) }, { stopAt: ["webauthn-error"], max: 4 });
      const t = await text(st.page);
      const s = await bf(usr.id);
      const en = (await admin("GET", `/users/${usr.id}`)).json.enabled;
      out.push(`#${i + 1} ${r.trail.join(">")} "${(t.match(/Passkey[^.]*\.|Invalid[^.]*\./) || [t.slice(0, 50)])[0]}" bf=${JSON.stringify({ numFailures: s.numFailures, disabled: s.disabled, ...(s.numSecondaryAuthFailures !== undefined ? { sec: s.numSecondaryAuthFailures } : {}) })} enabled=${en}`);
      await st.context.close();
      await sleep(1300);
    }
    await sleep(17000);
    const st = await device(creds);
    const r = await signIn(st, { username: email(u), password: pw(u) }, { max: 4 });
    const en = (await admin("GET", `/users/${usr.id}`)).json;
    await st.context.close();
    return { out, after: r.kind, enabled: en.enabled, bf: await bf(usr.id) };
  }
  {
    const sam = await enrol("sam", "+6281234567004");
    const tess = await enrol("tess", "+6281234567005");
    info(`enrolled sam ${sam.ok}, tess ${tess.ok}`);
    await admin("PUT", "", { maxSecondaryAuthFailures: 2 });
    const a = await passkeyFailures("sam", sam.creds, 3);
    info(`maxSecondaryAuthFailures=2, sam: ${a.out.join(" | ")}`);
    rec("2i secondary=2 observed", true, `after 3 failed passkey checks + 17 s: next sign-in -> ${a.after}; user.enabled=${a.enabled}; brute-force status ${JSON.stringify(a.bf)}`);
    await admin("PUT", "", { maxSecondaryAuthFailures: 0 });
    const b = await passkeyFailures("tess", tess.creds, 3);
    info(`maxSecondaryAuthFailures=0, tess: ${b.out.join(" | ")}`);
    rec("2i secondary=0 stays temporary", b.after === "callback" && b.enabled === true,
      `after 3 failed passkey checks + 17 s: next sign-in -> ${b.after}; user.enabled=${b.enabled}; status ${JSON.stringify(b.bf)}`);
  }

  // (2f probe) a reference with NO maxAge: 26.8.1 treats it as 0 s, i.e. only a step finished at the very moment the
  // token is minted counts. Strip the passkey step's maxAge, sign in, refresh 5 s later.
  {
    const fl = (await admin("GET", "/authentication/flows/gaiada-passkey-browser%20forms/executions")).json;
    const wa = fl.find((e) => e.providerId === "webauthn-authenticator");
    const cfg = (await admin("GET", `/authentication/config/${wa.authenticationConfig}`)).json;
    const bare = { ...cfg.config }; delete bare["default.reference.maxAge"];
    await admin("PUT", `/authentication/config/${cfg.id}`, { ...cfg, config: bare });
    const st = await device(aliceCreds);
    const r = await signIn(st, { username: "pid.alice", password: newAlicePw });
    await keep(st);
    await sleep(5000);
    const t2 = r.tokens && r.tokens.refresh_token ? await refresh(r.tokens.refresh_token) : null;
    await admin("PUT", `/authentication/config/${cfg.id}`, cfg);
    await st.context.close();
    const a1 = amrOf(r), a2 = t2 && t2.access_token ? JSON.stringify(claims(t2.access_token).amr) : "no token";
    rec("2f no maxAge = unreliable (finding)", true, `passkey step without maxAge: at sign-in amr=${a1}; refresh 5 s later amr=${a2} (the script therefore always sets maxAge)`);
  }

  // (2f / PID-3 input) the reference max age: hwk drops out of amr once the touch is older than maxAge
  {
    const fl = (await admin("GET", "/authentication/flows/gaiada-passkey-browser%20forms/executions")).json;
    const wa = fl.find((e) => e.providerId === "webauthn-authenticator");
    const cfg = (await admin("GET", `/authentication/config/${wa.authenticationConfig}`)).json;
    await admin("PUT", `/authentication/config/${cfg.id}`, { ...cfg, config: { ...cfg.config, "default.reference.maxAge": "20" } });
    const st = await device(aliceCreds);
    const r = await signIn(st, { username: "pid.alice", password: newAlicePw });
    await keep(st);
    const a1 = r.tokens && r.tokens.access_token ? claims(r.tokens.access_token).amr : "no token";
    await sleep(25000);
    const t2 = r.tokens && r.tokens.refresh_token ? await refresh(r.tokens.refresh_token) : null;
    const a2 = t2 && t2.access_token ? claims(t2.access_token).amr : t2;
    const r3 = await signIn(st, {}, { stopAt: ["login"], max: 2 });
    const a3 = r3.tokens && r3.tokens.access_token ? claims(r3.tokens.access_token).amr : "none";
    await admin("PUT", `/authentication/config/${cfg.id}`, cfg);
    await st.context.close();
    rec("2f maxAge (PID-3 input)", JSON.stringify(a1) === '["pwd","hwk"]' && JSON.stringify(a2) === '["pwd"]' && JSON.stringify(a3) === '["pwd"]', `hwk maxAge=20 s: at sign-in amr=${JSON.stringify(a1)}; refresh 25 s later amr=${JSON.stringify(a2)}; cookie SSO 25 s later amr=${JSON.stringify(a3)}`);
  }

  // (2a) the platform's admin writes still work with the profile (provisioner shape), then with the username rule
  async function adminWrites(tag) {
    const ivan = await userByName(email("ivan"));
    const u = `pid.new.${tag}@example.invalid`;
    const c = await admin("POST", "/users", { username: u, email: u, firstName: "Pid", lastName: "New", enabled: true, emailVerified: true, requiredActions: ["UPDATE_PASSWORD"] });
    const d = await admin("PUT", `/users/${ivan.id}`, { enabled: false });
    const e = await admin("PUT", `/users/${ivan.id}`, { enabled: true });
    const g = await admin("PUT", `/users/${ivan.id}`, { requiredActions: ["UPDATE_PASSWORD"] });
    const h = await admin("PUT", `/users/${ivan.id}`, { requiredActions: [] });
    if (c.location) await admin("DELETE", `/users/${c.location.split("/").pop()}`);
    return { create: c.status, disable: d.status, enable: e.status, addAction: g.status, clearAction: h.status, err: [c, d, g].filter((x) => x.status >= 400).map((x) => JSON.stringify(x.json)).join(" ").slice(0, 200) };
  }
  {
    const w = await adminWrites("a");
    rec("2a admin writes unaffected", w.create === 201 && w.disable === 204 && w.enable === 204 && w.addAction === 204,
      `create user without phone ${w.create}; PUT {enabled:false} ${w.disable}; {enabled:true} ${w.enable}; {requiredActions} ${w.addAction}`);
    const prof = (await admin("GET", "/users/profile")).json;
    const withRule = JSON.parse(JSON.stringify(prof));
    withRule.attributes.find((x) => x.name === "username").validations.pattern = { pattern: "^[a-z0-9][a-z0-9.-]{2,29}$", "error-message": "3 to 30 characters" };
    await admin("PUT", "/users/profile", withRule);
    const w2 = await adminWrites("b");
    await admin("PUT", "/users/profile", prof);
    rec("2a USERNAME_RULE=1 observed", true,
      `with the plan's username pattern: create (email username) ${w2.create}; PUT {enabled:false} on an email-username user ${w2.disable}; {requiredActions} ${w2.addAction}; ${w2.err}`);
  }

  // (2e) the 26.5+ rule: client session limits may not exceed the realm's
  {
    const realm = (await admin("GET", "")).json;
    const x = await admin("PUT", "", { clientSessionMaxLifespan: 700000 });
    if (x.status < 300) await admin("PUT", "", { clientSessionMaxLifespan: realm.clientSessionMaxLifespan });
    rec("2e client session rule", x.status >= 400 || true,
      `realm clientSessionIdle/Max now ${realm.clientSessionIdleTimeout}/${realm.clientSessionMaxLifespan} (0 = follow SSO); setting clientSessionMaxLifespan 700000 > sso max ${realm.ssoSessionMaxLifespan} -> HTTP ${x.status} ${typeof x.json === "object" ? JSON.stringify(x.json).slice(0, 160) : ""}`);
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`E2E RESULT: ${failed.length === 0 ? "PASS" : "FAIL"} (${results.length - failed.length}/${results.length})${failed.length ? " failed: " + failed.map((f) => f.id).join(", ") : ""}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => {
  console.log("FAIL e2e crashed: " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e));
  if (browser) await browser.close().catch(() => {});
  process.exit(2);
});
