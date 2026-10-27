"use server";
// M5-W1f: the staff side of freelance contributors. Publisher tier (Cerbos `manage_editorial`), decided by the BFF: a 403 comes back as
// `forbidden` and the page says so, never an empty list.
//
//   GET  /api/:t/modules/webdev/editorial/contributors                    -> {contributors: [...]}
//   POST /api/:t/modules/webdev/editorial/contributors/invite             {email, name?, validUntil} -> 201 {contributor, invite:{token, expiresAt, acceptPath}, account}
//   POST /api/:t/modules/webdev/editorial/contributors/:userId/end        -> 200 {userId, changed, revokedGrantIds, idpDisabled, keptLoginForOtherEngagements, ...}
//
// THE LINK IS SHOWN ONCE. The raw token comes back from the invite only; the action turns `acceptPath` into an absolute URL and returns it to the
// form, which holds it in state and never stores it (a lost link means a new invite). Same as the client invite.
import { getSessionUserId } from "./session-server";
import { getMe } from "./platform";
import { getActiveTenant } from "./tenant";
import { wdCall, wire, WireDrift } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import { validEmail, validUntilFromDay, type ContributorEnded, type ContributorInvited, type ContributorRow } from "./contributorsAdminModel";

const { str, bool, nullable, arr, obj, key, opt } = wire;
const strN = nullable(str);

type Ctx = { userId: string; company: string };
async function ctx(): Promise<Ctx | WdResult<never>> {
  const userId = await getSessionUserId();
  if (!userId) return { kind: "unavailable", code: "upstream_error", reason: "session_expired" };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { kind: "unavailable", code: "upstream_error", reason: "no_active_company" };
  return { userId, company };
}
const isCtx = (c: Ctx | WdResult<never>): c is Ctx => "userId" in c;
const base = (c: Ctx) => `/api/${encodeURIComponent(c.company)}/modules/webdev/editorial/contributors`;
const bad = (message: string): WdResult<never> => ({ kind: "invalid", issues: [], message });

function parseRow(v: unknown, path: string): ContributorRow {
  const o = obj(v, path);
  const status = key(o, "status", str, path);
  if (status !== "invited" && status !== "active" && status !== "ended") throw new WireDrift(`${path}.status`, "invited|active|ended", status);
  return {
    contributorId: key(o, "contributorId", str, path), userId: key(o, "userId", str, path),
    name: key(o, "name", strN, path), email: key(o, "email", strN, path),
    status, live: key(o, "live", bool, path), validUntil: key(o, "validUntil", str, path),
    sponsorUserId: key(o, "sponsorUserId", strN, path), invitedAt: key(o, "invitedAt", str, path),
    activatedAt: key(o, "activatedAt", strN, path), endedAt: key(o, "endedAt", strN, path), hasAccount: key(o, "hasAccount", bool, path),
  };
}

export async function listContributorsAction(): Promise<WdResult<ContributorRow[]>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  return wdCall(base(c), c.userId, (v) => key(obj(v, "contributors"), "contributors", arr(parseRow), "contributors"));
}

/** Without a public origin the link stays a path (the same rule as the client invite). */
function absolute(path: string): string {
  const origin = process.env.PUBLIC_APP_ORIGIN ?? process.env.OIDC_REDIRECT_URI?.replace(/\/auth\/callback.*$/, "") ?? "";
  return origin ? `${origin}${path}` : path;
}

export async function inviteContributorAction(input: { email: string; name: string; validUntilDay: string }): Promise<WdResult<ContributorInvited>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  const email = String(input?.email ?? "").trim();
  const name = String(input?.name ?? "").trim();
  if (!validEmail(email)) return bad("Enter a valid email address.");
  if (name.length > 200) return bad("The name is too long.");
  const until = validUntilFromDay(String(input?.validUntilDay ?? ""));
  if (!until.ok) return bad(until.message);
  return wdCall(`${base(c)}/invite`, c.userId, (v): ContributorInvited => {
    const o = obj(v, "invite");
    const inv = obj(key(o, "invite", obj, "invite"), "invite.invite");
    return {
      contributor: key(o, "contributor", parseRow, "invite"),
      acceptUrl: absolute(key(inv, "acceptPath", str, "invite.invite")),
      expiresAt: key(inv, "expiresAt", str, "invite.invite"),
      account: opt(o, "account", str, "invite") ?? "created",
    };
  }, { method: "POST", body: JSON.stringify({ email, ...(name ? { name } : {}), validUntil: until.iso }) });
}

export async function endContributorAction(userId: string): Promise<WdResult<ContributorEnded>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  const id = String(userId ?? "").trim();
  if (!id) return bad("Choose a person.");
  return wdCall(`${base(c)}/${encodeURIComponent(id)}/end`, c.userId, (v): ContributorEnded => {
    const o = obj(v, "end");
    return {
      userId: key(o, "userId", str, "end"),
      changed: key(o, "changed", bool, "end"),
      idpDisabled: opt(o, "idpDisabled", bool, "end") === true,
      keptLoginForOtherEngagements: opt(o, "keptLoginForOtherEngagements", bool, "end") === true,
      revokedGrantCount: Array.isArray(o.revokedGrantIds) ? o.revokedGrantIds.length : 0,
    };
  }, { method: "POST" });
}
