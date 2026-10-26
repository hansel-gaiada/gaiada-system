// M5-W1d — freelance contributors: invite, accept, end, list (owner ruling WSK-D84; design
// docs/plans/2026-10-11-m5-writers-room-design.md §3.1 items 2, 3, 9; FRONTEND-BFF-CONTRACT §27 "Freelance contributors";
// PERMISSION-CONTRACT §27.6). The routes are `editorial-contributors.controller.ts`.
//
// WHAT A WORKING CONTRIBUTOR NEEDS, and where each part comes from:
//   1. a `users` row with kind `contributor`     created (or converted) HERE at invite time, in the invite's transaction
//   2. an anchor in `editorial_contributors`     created HERE at invite time (`invited`), made `active` on accept
//   3. a Keycloak account in group `contributors`, OTP required    provisioned HERE on accept (W1g sets up the realm)
//   4. writers' room grants                       NOT here: a publisher grants writer / translator / SEO reviewer through the
//                                                 ordinary grant route, and the choke point binds each grant to the anchor
//   5. a tenant in `principal.companies`          from the ACTIVE, unexpired anchor, via assemblePrincipal()
// Until (4) a contributor who signs in reaches `/me` and nothing else, which is the intended empty state.
//
// THE CONVERSION RULE (design §3.1 item 3). An address that already has a `users` row becomes a contributor only when that
// row is an ACTIVE `employee`-kind row that holds no role grant, never had a company membership, never was a client
// contact (deleted rows included, so ex-staff and ex-clients are never repurposed) and has no home company. Every other
// kind is refused (409 `contributor_conversion_refused`). The DB trigger `users_contributor_kind_guard` re-checks the same
// facts for any writer. This is also why a contributor invite can never create a client and a client invite can never
// create a contributor: the client invite refuses a contributor row, and this one refuses a client row.
//
// LEAVING (design §3.1 item 9). Ending revokes every writers' room grant in the company through the choke point, spends open
// invites, ends and expires the anchor (`valid_until` cut to now), bumps `session_version` (D11), and disables the Keycloak
// login when no other engagement is live. Even before any of that, the anchor's expiry alone cuts access at the next
// request: assemblePrincipal() keeps only live anchors and only grants inside them.
//
// Audit rows carry identifiers only (user id, anchor id, grant ids, the dates): never a name, an email or a token.
import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { currentApproval, currentVia } from "../../core/request-context";
import type { Principal } from "../../rbac/principal";
import { CONTRIBUTOR_KIND, CONTRIBUTOR_MAX_ENGAGEMENT_DAYS } from "../../rbac/contributor";
import { revokeContributorEditorialGrants } from "../../admin/grant-write.service";
import {
  ContributorInviteError, consumeContributorInvite, createContributorInvite, spendOpenContributorInvites,
} from "../../core/contributor-invites";
import {
  addRequiredAction as kcAddRequiredAction,
  addUserToGroup as kcAddUserToGroup,
  createUser as kcCreateUser,
  disableUser as kcDisableUser,
  enableUser as kcEnableUser,
  findUserByEmail as kcFindUserByEmail,
  generateInitialPassword,
  logoutUser as kcLogoutUser,
  KeycloakUserExistsError,
} from "../../core/keycloak-admin";
import { UUID_RE, invalidRequest, strictBody } from "./webdesk-content.service";

/** The realm group every contributor account joins (W1g creates it and audits which OIDC clients admit it). */
export const CONTRIBUTORS_GROUP = "contributors";
/** Keycloak's required action for enrolling an OTP authenticator (design §3.1 item 3: MFA-only). */
export const CONTRIBUTOR_OTP_ACTION = "CONFIGURE_TOTP";

export const CONTRIBUTOR_INVITE_BODY_KEYS = ["email", "name", "validUntil"] as const;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ContributorInviteRequest {
  email: string;
  name: string | null;
  validUntil: string;
}

/** Validate the invite body. PURE (unit-tested); runs AFTER authorization. `now` is injectable for tests. */
export function parseContributorInviteBody(raw: unknown, now: number = Date.now()): ContributorInviteRequest {
  const b = strictBody(raw, CONTRIBUTOR_INVITE_BODY_KEYS);
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw invalidRequest("email must be a valid address");
  let name: string | null = null;
  if (b.name !== undefined && b.name !== null) {
    if (typeof b.name !== "string" || b.name.trim().length < 1 || b.name.trim().length > 200) {
      throw invalidRequest("name must be 1 to 200 characters, or omitted");
    }
    name = b.name.trim();
  }
  const t = typeof b.validUntil === "string" ? Date.parse(b.validUntil) : Number.NaN;
  if (!Number.isFinite(t) || t <= now) throw invalidRequest("validUntil must be an ISO-8601 instant in the future");
  // One minute of slack for the clock between this check and the database's own CHECK (which measures from its now()).
  if (t > now + CONTRIBUTOR_MAX_ENGAGEMENT_DAYS * DAY_MS - 60_000) {
    throw invalidRequest(`validUntil may be at most ${CONTRIBUTOR_MAX_ENGAGEMENT_DAYS} days ahead`);
  }
  return { email, name, validUntil: new Date(t).toISOString() };
}

export interface ContributorView {
  contributorId: string;
  userId: string;
  name: string | null;
  email: string;
  status: "invited" | "active" | "ended";
  /** True when the engagement is ACTIVE and unexpired: what assemblePrincipal() will honour. */
  live: boolean;
  validUntil: string;
  sponsorUserId: string;
  invitedAt: string;
  activatedAt: string | null;
  endedAt: string | null;
  /** The person has signed in at least once (an IdP subject is linked). Never a credential detail. */
  hasAccount: boolean;
}

interface ContributorRow {
  contributor_id: string; user_id: string; name: string | null; email: string; status: ContributorView["status"];
  live: boolean; valid_until: Date | string; sponsor_user_id: string; invited_at: Date | string;
  activated_at: Date | string | null; ended_at: Date | string | null; has_account: boolean;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function view(r: ContributorRow): ContributorView {
  return {
    contributorId: r.contributor_id, userId: r.user_id, name: r.name, email: r.email, status: r.status, live: r.live,
    validUntil: iso(r.valid_until) as string, sponsorUserId: r.sponsor_user_id, invitedAt: iso(r.invited_at) as string,
    activatedAt: iso(r.activated_at), endedAt: iso(r.ended_at), hasAccount: r.has_account === true,
  };
}

const SELECT_CONTRIBUTOR = `
  SELECT ec.id AS contributor_id, ec.user_id, u.name, u.email, ec.status,
         (ec.status = 'active' AND ec.valid_until > now()) AS live,
         ec.valid_until, ec.sponsor_user_id, ec.invited_at, ec.activated_at, ec.ended_at,
         (u.idp_subject IS NOT NULL) AS has_account
    FROM editorial_contributors ec JOIN users u ON u.id = ec.user_id`;

/** The audit row, on the caller's connection (same transaction as the change). Same columns and ambient stamping as
 *  `writeActivity()` (core/http.ts), which cannot join an open transaction. */
async function auditTx(
  c: PoolClient, tenantId: string, actorId: string | null, verb: string, entityType: "user" | "user_role", entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const via = currentVia();
  const withVia = via && metadata.via === undefined ? { ...metadata, via } : metadata;
  const appr = currentApproval();
  await c.query(
    `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site,
                             approved_by, approval_channel, executed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [newId(), tenantId, actorId, verb, entityType, entityId, JSON.stringify(withVia), config.originSite,
     appr?.approvedBy ?? null, appr?.channel ?? null, appr?.executedBy ?? null],
  );
}

function conversionRefused(detail: string): ConflictException {
  return new ConflictException({
    message: `contributor_conversion_refused: ${detail}`,
    reason: "contributor_conversion_refused",
  });
}

/** Every engagement of this company, newest first. The caller has ALREADY passed Cerbos. No token, no credential. */
export async function listContributors(tenantId: string): Promise<{ contributors: ContributorView[] }> {
  const rows = await withTenants([tenantId], (c) =>
    c.query<ContributorRow>(`${SELECT_CONTRIBUTOR} WHERE ec.tenant_id = $1 ORDER BY ec.invited_at DESC, ec.id`, [tenantId]),
  );
  return { contributors: rows.rows.map(view) };
}

export interface ContributorInviteResponse {
  contributor: ContributorView;
  /** The RAW token, returned HERE AND NOWHERE ELSE (only its sha256 is stored). A lost link means a new invite. */
  invite: { delivery: "link"; token: string; expiresAt: string; acceptPath: string };
  /** `created` = a new users row; `converted` = an eligible existing row became a contributor; `existing` = already one. */
  account: "created" | "converted" | "existing";
}

/** Invite: the caller has ALREADY passed Cerbos `webdesk_collection:manage_editorial` (the controller's first statement). */
export async function inviteContributor(
  principal: Principal, tenantId: string, req: ContributorInviteRequest,
): Promise<ContributorInviteResponse> {
  const out = await withTenants([tenantId], async (c) => {
    const found = await c.query<{ id: string; kind: string; status: string; home_company_id: string | null }>(
      `SELECT id, kind, status, home_company_id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL FOR UPDATE`,
      [req.email],
    );
    let userId: string;
    let account: ContributorInviteResponse["account"];
    const u = found.rows[0];
    if (!u) {
      userId = newId();
      await c.query(
        `INSERT INTO users (id, email, name, kind, origin_site) VALUES ($1, $2, $3, 'contributor', $4)`,
        [userId, req.email, req.name ?? req.email.split("@")[0], config.originSite],
      );
      account = "created";
    } else {
      userId = u.id;
      if (userId === principal.userId) {
        throw new BadRequestException({ message: "self_invite_forbidden: you cannot invite yourself as a contributor", reason: "self_invite_forbidden" });
      }
      if (u.status !== "active") throw conversionRefused("the existing account is not active");
      if (u.kind === CONTRIBUTOR_KIND) {
        account = "existing";
      } else if (u.kind !== "employee") {
        throw conversionRefused(`the address belongs to a ${u.kind} account, which can never become a contributor`);
      } else {
        // The facts the conversion rule needs, under `principal_lookup` (memberships and client contacts are FORCE RLS:
        // without the GUC they read ZERO rows and every staff member would look convertible). Rows of ANY status count.
        await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
        const facts = await c.query<{ has_grant: boolean; was_member: boolean; was_contact: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id = $1) AS has_grant,
                  EXISTS (SELECT 1 FROM company_memberships WHERE user_id = $1) AS was_member,
                  EXISTS (SELECT 1 FROM client_contacts WHERE user_id = $1) AS was_contact`,
          [userId],
        );
        await c.query("SELECT set_config('app.principal_user_id', '', true)");
        const f = facts.rows[0];
        if (f.has_grant) throw conversionRefused("the existing account holds a role grant");
        if (f.was_member || u.home_company_id) throw conversionRefused("the existing account is, or was, staff of a company");
        if (f.was_contact) throw conversionRefused("the existing account is, or was, a client contact");
        await c.query(`UPDATE users SET kind = 'contributor', updated_at = now() WHERE id = $1 AND kind = 'employee'`, [userId]);
        account = "converted";
      }
    }

    // The anchor: one per (company, person). An ACTIVE, unexpired engagement is never reset by a second invite (that
    // would cut the person off until they accept again); renewing a lapsed or ended one re-opens it as `invited`.
    const existing = await c.query<{ id: string; status: string; live: boolean }>(
      `SELECT id, status, (status = 'active' AND valid_until > now()) AS live
         FROM editorial_contributors WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
      [tenantId, userId],
    );
    let contributorId: string;
    if (existing.rows[0]?.live) {
      throw new ConflictException({
        message: "contributor_already_active: this contributor already has a live engagement here; end it first to change it",
        reason: "contributor_already_active",
        existing: { contributorId: existing.rows[0].id },
      });
    }
    if (existing.rows[0]) {
      contributorId = existing.rows[0].id;
      await c.query(
        `UPDATE editorial_contributors
            SET status = 'invited', sponsor_user_id = $2, valid_until = $3, invited_at = now(),
                activated_at = NULL, ended_at = NULL, ended_by = NULL
          WHERE id = $1`,
        [contributorId, principal.userId, req.validUntil],
      );
    } else {
      contributorId = newId();
      await c.query(
        `INSERT INTO editorial_contributors (id, tenant_id, user_id, sponsor_user_id, status, valid_until, origin_site)
         VALUES ($1, $2, $3, $4, 'invited', $5, $6)`,
        [contributorId, tenantId, userId, principal.userId, req.validUntil, config.originSite],
      );
    }
    await spendOpenContributorInvites(c, contributorId);
    const invite = await createContributorInvite(c, { tenantId, contributorId, email: req.email, invitedBy: principal.userId });
    await auditTx(c, tenantId, principal.userId, "webdesk.editorial.contributor_invited", "user", userId, {
      contributorId, userId, validUntil: req.validUntil, account, inviteId: invite.inviteId, inviteExpiresAt: invite.expiresAt,
    });
    const row = await c.query<ContributorRow>(`${SELECT_CONTRIBUTOR} WHERE ec.id = $1`, [contributorId]);
    return { contributor: view(row.rows[0]), invite, account };
  });
  return {
    contributor: out.contributor,
    invite: {
      delivery: "link", token: out.invite.token, expiresAt: out.invite.expiresAt,
      acceptPath: `/contributor-invite/${out.invite.token}`,
    },
    account: out.account,
  };
}

export interface ContributorAcceptResponse {
  ok: true;
  email: string;
  status: "active";
  /** `created`: a new Keycloak account with the chosen password; `existing_reenabled`: an earlier account was put back
   *  into the group, given the OTP action and re-enabled (its password was NOT touched). */
  accountPath: "created" | "existing_reenabled";
  /** The second factor the person must enrol at the first sign-in (Keycloak required action). */
  secondFactor: "otp_required";
  existingAccount: boolean;
}

function inviteUnusable(): HttpException {
  return new BadRequestException({ message: "this invitation link is not usable — ask for a new one", reason: "contributor_invite_invalid" });
}

/** The PUBLIC accept. Its only authority is the token (see core/contributor-invites.ts). */
export async function acceptContributorInvite(raw: unknown): Promise<ContributorAcceptResponse> {
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { token?: unknown; password?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) throw new BadRequestException("token is required");
  let invite: Awaited<ReturnType<typeof consumeContributorInvite>>;
  try {
    // Consumes the token atomically FIRST: single use is enforced before any account work.
    invite = await consumeContributorInvite(token);
  } catch (e) {
    if (e instanceof ContributorInviteError) {
      throw new HttpException({ message: e.message, reason: e.code }, e.status);
    }
    throw e;
  }
  const password = typeof body.password === "string" && body.password.trim() ? body.password.trim() : generateInitialPassword();
  if (password.length < 10) throw new BadRequestException("password must be at least 10 characters");

  const anchor = await withTenants([invite.tenantId], (c) =>
    c.query<{ id: string; user_id: string; status: string; live_window: boolean; kind: string; email: string }>(
      `SELECT ec.id, ec.user_id, ec.status, (ec.valid_until > now()) AS live_window, u.kind, lower(u.email) AS email
         FROM editorial_contributors ec JOIN users u ON u.id = ec.user_id
        WHERE ec.id = $1 AND u.deleted_at IS NULL AND u.status = 'active'`,
      [invite.contributorId],
    ),
  );
  const a = anchor.rows[0];
  // Withdrawn (ended), already accepted, lapsed, or no longer a contributor: one coarse answer, no oracle.
  if (!a || a.status !== "invited" || !a.live_window || a.kind !== CONTRIBUTOR_KIND || a.email !== invite.email) {
    throw inviteUnusable();
  }

  // ---- Provision the IdP account: the `contributors` group and an OTP enrolment at the first sign-in ----
  // emailVerified:true (inside kcCreateUser) is load-bearing: oidc.ts links the first login to this pre-created row only for
  // a verified address, and consuming a token delivered to it is what makes the flag honest. For an account that ALREADY
  // exists (an earlier engagement whose login was disabled at its end) the body's password is IGNORED, never set: the token
  // proves control of an invitation, not of an account.
  let accountPath: ContributorAcceptResponse["accountPath"] = "created";
  try {
    await kcCreateUser({
      email: invite.email, password, groups: [CONTRIBUTORS_GROUP], requiredActions: [CONTRIBUTOR_OTP_ACTION],
    });
  } catch (e) {
    if (!(e instanceof KeycloakUserExistsError)) throw e;
    const existing = await kcFindUserByEmail(invite.email);
    if (!existing) throw e;
    await kcAddUserToGroup(existing.id, CONTRIBUTORS_GROUP);
    await kcAddRequiredAction(existing.id, CONTRIBUTOR_OTP_ACTION);
    await kcEnableUser(existing.id);
    accountPath = "existing_reenabled";
  }

  // ---- Activate on the platform side ----
  await withTenants([invite.tenantId], async (c) => {
    const r = await c.query(
      `UPDATE editorial_contributors SET status = 'active', activated_at = now() WHERE id = $1 AND status = 'invited'`,
      [a.id],
    );
    if (!r.rowCount) throw inviteUnusable(); // ended between the read and now: the end wins
    await auditTx(c, invite.tenantId, null, "webdesk.editorial.contributor_activated", "user", a.user_id, {
      contributorId: a.id, userId: a.user_id, accountPath, inviteId: invite.inviteId, actorExternal: "contributor-invite-accept",
    });
  });

  return {
    ok: true, email: invite.email, status: "active", accountPath, secondFactor: "otp_required",
    existingAccount: accountPath !== "created",
  };
}

export interface ContributorEndResponse {
  userId: string;
  contributorId: string;
  status: "ended";
  /** False: the engagement had already ended and held no grant (idempotent; no audit row). */
  changed: boolean;
  revokedGrantIds: string[];
  sessionBumped: boolean;
  idpDisabled: boolean;
  idpError: string | null;
  /** True: another company's engagement is still live, so the login was left enabled for it. */
  keptLoginForOtherEngagements: boolean;
}

/** End: the caller has ALREADY passed Cerbos. Local state first and authoritative; the IdP step is best effort, reported. */
export async function endContributor(principal: Principal, tenantId: string, userId: string): Promise<ContributorEndResponse> {
  if (!UUID_RE.test(userId)) throw invalidRequest("userId must be a uuid");
  const res = await withTenants([tenantId], async (c) => {
    const found = await c.query<{ id: string; status: string; email: string }>(
      `SELECT ec.id, ec.status, lower(u.email) AS email
         FROM editorial_contributors ec JOIN users u ON u.id = ec.user_id
        WHERE ec.tenant_id = $1 AND ec.user_id = $2 FOR UPDATE OF ec`,
      [tenantId, userId],
    );
    const anchor = found.rows[0];
    if (!anchor) throw new NotFoundException({ message: "contributor_not_found: no engagement of this person here", reason: "contributor_not_found" });
    const revoked = await revokeContributorEditorialGrants(c, tenantId, userId);
    const spent = await spendOpenContributorInvites(c, anchor.id);
    const wasEnded = anchor.status === "ended";
    if (!wasEnded) {
      await c.query(
        `UPDATE editorial_contributors
            SET status = 'ended', ended_at = now(), ended_by = $2, valid_until = LEAST(valid_until, now())
          WHERE id = $1`,
        [anchor.id, principal.userId],
      );
    }
    const changed = !wasEnded || revoked.length > 0 || spent > 0;
    for (const grantId of revoked) {
      await auditTx(c, tenantId, principal.userId, "webdesk.editorial.role_revoked", "user_role", grantId, {
        grantId, targetUserId: userId, reason: "contributor_ended", contributorId: anchor.id,
      });
    }
    if (changed) {
      await auditTx(c, tenantId, principal.userId, "webdesk.editorial.contributor_ended", "user", userId, {
        contributorId: anchor.id, userId, revokedGrantIds: revoked, spentInvites: spent,
      });
    }
    return { anchor, revoked, changed };
  });

  // D11: cut every live session now, not at token expiry (a no-op change still costs nothing).
  await withGlobal((c) =>
    c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
  );

  // Disable the login only if no other company's engagement is still open (read under principal_lookup: the anchor table is
  // FORCE RLS, and a bare withGlobal would see zero rows and always disable, the client-revoke trap of 2026-10-13).
  const elsewhere = await withGlobal(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
      const r = await c.query(
        `SELECT 1 FROM editorial_contributors WHERE user_id = $1 AND status <> 'ended' AND valid_until > now() LIMIT 1`,
        [userId],
      );
      await c.query("COMMIT");
      return !!r.rowCount;
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* the connection is gone; keep the original error */ }
      throw e;
    }
  });
  let idpDisabled = false;
  let idpError: string | null = null;
  if (!elsewhere) {
    try {
      const kc = await kcFindUserByEmail(res.anchor.email);
      if (kc) {
        await kcDisableUser(kc.id);
        idpDisabled = true;
        try {
          await kcLogoutUser(kc.id);
        } catch {
          /* disabling already refuses every new token; ending live IdP sessions is a courtesy on top */
        }
      }
    } catch (e) {
      idpError = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }
  return {
    userId, contributorId: res.anchor.id, status: "ended", changed: res.changed, revokedGrantIds: res.revoked,
    sessionBumped: true, idpDisabled, idpError, keptLoginForOtherEngagements: elsewhere,
  };
}
