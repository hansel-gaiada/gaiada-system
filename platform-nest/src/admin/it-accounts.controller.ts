// P2-13 — the IT accounts backend: the worklist that says who still needs a login, and the four
// actions that fix it.
//
// Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §5.4. `GET /api/:t/it/accounts` is a
// DERIVED worklist joining staff ↔ Keycloak ↔ `identity_links`; the actions are `provision`,
// `disable`, `enable`, `reset-password`, all through the existing `core/keycloak-admin.ts`, all
// idempotent, all audited, and NOT HR-module-gated.
//
// ── WHY THE WORKLIST IS DERIVED AND STORED NOWHERE ───────────────────────────────────────────────
// "Who lacks a login" is a JOIN across three systems that each change without telling us: a person is
// hired here, a login is created in Keycloak (possibly by hand), a link is verified when they first
// enrol. A cached worklist would be a fourth copy that is wrong in a way nobody notices — and the
// wrong direction is invisible: a leaver whose login stayed enabled reads as "nothing to do".
// So every read asks Keycloak, and the endpoint is honest about being slow rather than fast and stale.
//
// ── DEGRADATION IS A TYPED 503, NOT AN EMPTY LIST ────────────────────────────────────────────────
// `keycloakAdminConfigured()` is false in every environment that has no admin client (dev, CI, and any
// deployment where the provisioner credentials were not wired). The endpoint returns 503 with a typed
// code. It deliberately does NOT return `[]`: an empty worklist means "everyone has a login", which is
// the single most dangerous thing this surface could say while blind. Same reasoning as the D14
// fail-closed default — the absence of information is not the information that nothing is wrong.
//
// ── IDEMPOTENCE, AND WHY 409 IS A LINK RATHER THAN AN ERROR ──────────────────────────────────────
// `provision` looks the address up first, and Keycloak's own 409 (`KeycloakUserExistsError`) is
// treated as "it already exists, adopt it" rather than a failure. A double-provision therefore
// CONVERGES: the second call finds the account and links it, and nobody ends up with two logins for
// one address — which would be an authentication ambiguity, not a tidiness problem.
import {
  BadRequestException, Body, Controller, Get, HttpCode, HttpException, NotFoundException, Param,
  Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withGlobal, withTenants } from "../db";
import { authorize, writeActivity } from "../core/http";
import { AuthGuard } from "../auth/guards";
import {
  keycloakAdminConfigured,
  findUserByEmail,
  createUser as kcCreateUser,
  setPassword as kcSetPassword,
  disableUser as kcDisableUser,
  enableUser as kcEnableUser,
  generateInitialPassword,
  KeycloakUserExistsError,
  KeycloakNotConfiguredError,
  KeycloakAdminError,
  type KeycloakUser,
} from "../core/keycloak-admin";

/** The provider name for a Keycloak (OIDC) identity link. Matches the enrolment path's own spelling —
 *  a second spelling here would create links the login flow cannot see. */
const OIDC_PROVIDER = "platform";

/** Typed refusal codes. Read by the P2-14 console, so treat them as a contract: add a code rather
 *  than reword one. */
export const IT_ACCOUNT_ERROR = {
  /** No admin client configured — the worklist cannot be derived at all. */
  notConfigured: "keycloak_admin_not_configured",
  /** The upstream admin API failed. Distinct from `notConfigured`: one is our wiring, one is theirs. */
  upstreamFailed: "keycloak_admin_failed",
  /** The person is not a member of this company. */
  notAMember: "not_a_member",
  /** The action needs an existing Keycloak account and there is none. */
  noAccount: "no_keycloak_account",
} as const;

export type AccountState =
  /** Staff member, no Keycloak account at all — the joiner case. */
  | "missing"
  /** Account exists and is enabled. */
  | "enabled"
  /** Account exists and is disabled — normal for a leaver, a FINDING for anyone else. */
  | "disabled"
  /** Account exists and is enabled, but this person's employment is over — the leaver finding. */
  | "leaver_still_enabled"
  /** Account exists, an identity link exists, but it was never verified. */
  | "unverified_link";

export interface AccountRow {
  userId: string;
  email: string;
  name: string;
  employmentStatus: string | null;
  keycloakId: string | null;
  enabled: boolean | null;
  emailVerified: boolean | null;
  linked: boolean;
  linkVerified: boolean;
  state: AccountState;
  /** True when this row is something an IT admin should ACT on. The console filters on it; it is
   *  computed here so the console cannot disagree with the backend about what needs attention. */
  actionable: boolean;
}

@Controller("api")
@UseGuards(AuthGuard)
export class ItAccountsController {
  /**
   * The worklist. One row per staff member of this company, with their Keycloak reality attached.
   *
   * ⚠ NOT HR-module-gated (design §5.4), and that is a real decision rather than an omission: IT
   * provisioning is not an HR capability, and gating it on the `hr` module would make login
   * management vanish for a company that has HR switched off — while its people still need logins.
   * The employment status is read from `employees` where present, which DOES need the module scope, so
   * that ONE read is scoped and its absence degrades the row rather than the endpoint (see below).
   */
  @Get(":tenantId/it/accounts")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<{ accounts: AccountRow[] }> {
    await authorize(req.principal, { kind: "it_account", id: "worklist", tenantId }, "read");

    if (!keycloakAdminConfigured()) {
      // 503, never an empty list — see the file header.
      // ⚠ `message`, NOT `error`: http-error.filter.ts RENAMES `message` to `error` on the way out and
      // reads nothing called `error`. The filter's own header documents a ticket that lost every typed
      // token exactly this way ("the status codes were right and the shape was right, only the meaning
      // was missing"), so the token leads the string and the explanation follows it.
      throw new HttpException(
        {
          message:
            `${IT_ACCOUNT_ERROR.notConfigured}: the Keycloak admin client is not configured in this ` +
            `environment, so account state cannot be read. An empty worklist would mean "everyone has a ` +
            `login", which is not something this endpoint can honestly claim while blind.`,
        },
        503,
      );
    }

    // Staff of this company. `kind='employee'` excludes the service accounts, which hold real
    // memberships on purpose and must never appear on a human worklist (the same distinction P2-15's
    // backfill turns on).
    const staff = await withTenants([tenantId], (c) =>
      c.query<{ user_id: string; email: string; name: string }>(
        `SELECT cm.user_id, u.email, u.name
           FROM company_memberships cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.tenant_id = $1 AND cm.kind = 'employee' AND cm.status = 'active'
            AND cm.deleted_at IS NULL AND u.deleted_at IS NULL
          ORDER BY u.email`,
        [tenantId],
      ),
    );

    // Employment status comes from `employees`, which is behind the HR module wall. Scoped read, and a
    // company without the module simply yields no statuses — the worklist still works, it just cannot
    // distinguish a leaver from an active member. Degrading the ROW is acceptable; degrading the
    // endpoint (or silently treating "no status" as "active") is not, so `leaver_still_enabled` can
    // only ever be reported when the status is actually known.
    const statuses = new Map<string, string>();
    const employmentRows = await withTenants(
      [tenantId],
      (c) =>
        c.query<{ user_id: string; employment_status: string }>(
          `SELECT user_id, employment_status FROM employees
            WHERE tenant_id = $1 AND user_id IS NOT NULL AND deleted_at IS NULL`,
          [tenantId],
        ),
      { modules: ["hr"] },
    );
    for (const r of employmentRows.rows) statuses.set(r.user_id, r.employment_status);

    const links = await withGlobal((c) =>
      c.query<{ user_id: string; verified_at: Date | null }>(
        `SELECT user_id, verified_at FROM identity_links
          WHERE provider = $1 AND user_id = ANY($2::uuid[])`,
        [OIDC_PROVIDER, staff.rows.map((s) => s.user_id)],
      ),
    );
    const linkByUser = new Map(links.rows.map((l) => [l.user_id, l]));

    const accounts: AccountRow[] = [];
    for (const s of staff.rows) {
      let kc: KeycloakUser | null = null;
      try {
        kc = await findUserByEmail(s.email);
      } catch (err) {
        // One lookup failing must not blank the whole worklist. Surface it as an upstream failure for
        // that row: a row that says "unknown" is useful, and a silently absent row is a person who
        // quietly stops appearing on the list that exists to catch them.
        throw new HttpException(
          { message: `${IT_ACCOUNT_ERROR.upstreamFailed}: Keycloak lookup failed for ${s.email} — ${(err as Error).message}` },
          502,
        );
      }
      const link = linkByUser.get(s.user_id);
      const employmentStatus = statuses.get(s.user_id) ?? null;
      accounts.push(deriveRow(s, kc, link, employmentStatus));
    }
    return { accounts };
  }

  /**
   * Create (or adopt) a Keycloak account for a member, and link it. Returns the initial password
   * ONCE — it is generated here, never stored, and the response is the only place it exists.
   */
  @Post(":tenantId/it/accounts/:userId/provision")
  @HttpCode(201)
  async provision(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ): Promise<{ keycloakId: string; initialPassword: string | null; adopted: boolean }> {
    const member = await this.assertMember(req, tenantId, userId, "provision");
    this.assertConfigured();

    // Idempotence, step 1: look first. A pre-existing account (made by hand, or by a previous attempt
    // whose response was lost) is ADOPTED, not duplicated.
    let existing: KeycloakUser | null = null;
    try {
      existing = await findUserByEmail(member.email);
    } catch (err) {
      throw this.upstream(err);
    }

    if (existing) {
      await this.ensureLink(userId, existing.id);
      await writeActivity(tenantId, req.principal?.userId ?? null, "it.account.provision", "it_account", userId, {
        email: member.email, keycloakId: existing.id, adopted: true,
      });
      // No password: this account already existed and its credential is not ours to reveal or reset
      // silently. A human who needs one calls reset-password, which is a separate audited decision.
      return { keycloakId: existing.id, initialPassword: null, adopted: true };
    }

    const password = generateInitialPassword();
    let keycloakId: string;
    try {
      // `CreateUserInput` is (email, firstName?, lastName?, password?) — the platform keeps ONE `name`,
      // so it is split on the first space. Imperfect for multi-word given names, and deliberately not
      // "fixed" by guessing: the display name of record stays the platform's `users.name`.
      const [firstName, ...rest] = member.name.trim().split(/\s+/);
      keycloakId = await kcCreateUser({
        email: member.email,
        firstName: firstName || null,
        lastName: rest.join(" ") || null,
        password,
      });
    } catch (err) {
      // Idempotence, step 2: a 409 means someone created it between our lookup and our create. That is
      // the race, and its correct resolution is the same as step 1 — adopt.
      if (err instanceof KeycloakUserExistsError) {
        let raced: KeycloakUser | null = null;
        try {
          raced = await findUserByEmail(member.email);
        } catch (inner) {
          throw this.upstream(inner);
        }
        if (raced) {
          await this.ensureLink(userId, raced.id);
          await writeActivity(tenantId, req.principal?.userId ?? null, "it.account.provision", "it_account", userId, {
            email: member.email, keycloakId: raced.id, adopted: true, raced: true,
          });
          return { keycloakId: raced.id, initialPassword: null, adopted: true };
        }
      }
      throw this.upstream(err);
    }

    await this.ensureLink(userId, keycloakId);
    // The password is deliberately NOT in the audit payload. `writeActivity` rows are read by admins
    // and exported; a credential in one is a credential in every copy of that export.
    await writeActivity(tenantId, req.principal?.userId ?? null, "it.account.provision", "it_account", userId, {
      email: member.email, keycloakId, adopted: false,
    });
    return { keycloakId, initialPassword: password, adopted: false };
  }

  @Post(":tenantId/it/accounts/:userId/disable")
  @HttpCode(200)
  async disable(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ): Promise<{ ok: true; alreadyDisabled: boolean }> {
    const member = await this.assertMember(req, tenantId, userId, "disable");
    this.assertConfigured();
    const kc = await this.requireAccount(member.email);
    // Idempotent by construction: disabling a disabled account is a no-op upstream, and reporting
    // `alreadyDisabled` lets the console say "nothing to do" instead of implying it just acted.
    if (kc.enabled === false) {
      return { ok: true, alreadyDisabled: true };
    }
    try {
      await kcDisableUser(kc.id);
    } catch (err) {
      throw this.upstream(err);
    }
    await writeActivity(tenantId, req.principal?.userId ?? null, "it.account.disable", "it_account", userId, {
      email: member.email, keycloakId: kc.id,
    });
    return { ok: true, alreadyDisabled: false };
  }

  @Post(":tenantId/it/accounts/:userId/enable")
  @HttpCode(200)
  async enable(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ): Promise<{ ok: true; alreadyEnabled: boolean }> {
    const member = await this.assertMember(req, tenantId, userId, "enable");
    this.assertConfigured();
    const kc = await this.requireAccount(member.email);
    if (kc.enabled === true) return { ok: true, alreadyEnabled: true };
    try {
      await kcEnableUser(kc.id);
    } catch (err) {
      throw this.upstream(err);
    }
    await writeActivity(tenantId, req.principal?.userId ?? null, "it.account.enable", "it_account", userId, {
      email: member.email, keycloakId: kc.id,
    });
    return { ok: true, alreadyEnabled: false };
  }

  @Post(":tenantId/it/accounts/:userId/reset-password")
  @HttpCode(200)
  async resetPassword(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: { reason?: string },
  ): Promise<{ ok: true; initialPassword: string }> {
    const member = await this.assertMember(req, tenantId, userId, "reset_password");
    this.assertConfigured();
    const kc = await this.requireAccount(member.email);
    const password = generateInitialPassword();
    try {
      await kcSetPassword(kc.id, password);
    } catch (err) {
      throw this.upstream(err);
    }
    // Reason is recorded because a password reset on someone else's account is the action most likely
    // to be questioned later. Never the password itself.
    await writeActivity(tenantId, req.principal?.userId ?? null, "it.account.reset_password", "it_account", userId, {
      email: member.email, keycloakId: kc.id, reason: body?.reason ?? null,
    });
    return { ok: true, initialPassword: password };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────────

  /** Authorize, then confirm the target is a staff member of THIS company. Both, in that order: the
   *  authorization decides whether the caller may act here at all, and the membership check stops a
   *  correctly-authorized IT admin from provisioning a login for somebody else's employee. */
  private async assertMember(
    req: FastifyRequest,
    tenantId: string,
    userId: string,
    action: "provision" | "disable" | "enable" | "reset_password",
  ): Promise<{ email: string; name: string }> {
    await authorize(req.principal, { kind: "it_account", id: userId, tenantId, targetUserId: userId }, action);
    const { rows } = await withTenants([tenantId], (c) =>
      c.query<{ email: string; name: string }>(
        `SELECT u.email, u.name
           FROM company_memberships cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.tenant_id = $1 AND cm.user_id = $2 AND cm.kind = 'employee'
            AND cm.status = 'active' AND cm.deleted_at IS NULL AND u.deleted_at IS NULL`,
        [tenantId, userId],
      ),
    );
    if (!rows[0]) {
      throw new NotFoundException({
        message: `${IT_ACCOUNT_ERROR.notAMember}: this user is not an active staff member of this company`,
      });
    }
    return rows[0];
  }

  private assertConfigured(): void {
    if (keycloakAdminConfigured()) return;
    throw new HttpException(
      { message: `${IT_ACCOUNT_ERROR.notConfigured}: the Keycloak admin client is not configured in this environment` },
      503,
    );
  }

  private async requireAccount(email: string): Promise<KeycloakUser> {
    let kc: KeycloakUser | null;
    try {
      kc = await findUserByEmail(email);
    } catch (err) {
      throw this.upstream(err);
    }
    if (!kc) {
      throw new BadRequestException({
        message: `${IT_ACCOUNT_ERROR.noAccount}: no Keycloak account exists for ${email} — provision one first`,
      });
    }
    return kc;
  }

  private upstream(err: unknown): HttpException {
    if (err instanceof KeycloakNotConfiguredError) {
      return new HttpException({ message: `${IT_ACCOUNT_ERROR.notConfigured}: ${err.message}` }, 503);
    }
    const detail = err instanceof KeycloakAdminError ? err.message : (err as Error)?.message ?? "unknown";
    return new HttpException({ message: `${IT_ACCOUNT_ERROR.upstreamFailed}: ${detail}` }, 502);
  }

  /** Link the platform user to their Keycloak account, idempotently. UNVERIFIED on purpose: the link
   *  becomes verified when the PERSON logs in, and stamping `verified_at` here would assert that
   *  somebody proved control of an account when all that happened is an admin created it. */
  private async ensureLink(userId: string, keycloakId: string): Promise<void> {
    await withGlobal((c) =>
      c.query(
        `INSERT INTO identity_links (id, user_id, provider, external_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, external_id) DO NOTHING`,
        [newId(), userId, OIDC_PROVIDER, keycloakId],
      ),
    );
  }
}

/**
 * The worklist's whole judgement, as a pure function so it can be tested without Keycloak or a DB.
 *
 * `actionable` is computed here rather than in the console for one reason: two implementations of
 * "needs attention" drift, and the direction they drift in is a leaver whose login the UI stopped
 * flagging.
 */
export function deriveRow(
  member: { user_id: string; email: string; name: string },
  kc: KeycloakUser | null,
  link: { verified_at: Date | null } | undefined,
  employmentStatus: string | null,
): AccountRow {
  const linked = !!link;
  const linkVerified = !!link?.verified_at;
  const terminated = employmentStatus === "terminated";

  let state: AccountState;
  if (!kc) {
    state = "missing";
  } else if (kc.enabled === false) {
    state = "disabled";
  } else if (terminated) {
    // The finding this worklist exists for. Ordered ABOVE `unverified_link` deliberately: a leaver who
    // can still log in is a security finding, and an unverified link is paperwork.
    state = "leaver_still_enabled";
  } else if (linked && !linkVerified) {
    state = "unverified_link";
  } else {
    state = "enabled";
  }

  // A `disabled` account for an ACTIVE member is also actionable (someone cannot work), which is why
  // this is not simply "state !== enabled" with disabled excluded.
  const actionable =
    state === "missing" || state === "leaver_still_enabled" || state === "unverified_link" ||
    (state === "disabled" && !terminated);

  return {
    userId: member.user_id,
    email: member.email,
    name: member.name,
    employmentStatus,
    keycloakId: kc?.id ?? null,
    enabled: kc ? kc.enabled ?? null : null,
    emailVerified: kc ? kc.emailVerified ?? null : null,
    linked,
    linkVerified,
    state,
    actionable,
  };
}
