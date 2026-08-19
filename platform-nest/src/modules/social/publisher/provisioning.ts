// SMM-05 — org provisioning, connector-registry sync, and the dispatch choke-point's FK-chain
// validation. This is the file where "a mapping bug publishes client A's content to client B's
// account" is prevented, so it is written defensively and tested adversarially.
//
// SMM-07 adds section (2.5): the guided, resumable account-connect flow. Read that section's own
// header for why it is a NEW small vocabulary rather than a reuse of publish-precondition.ts's
// PUBLISH_REFUSAL, and for why "no platform app is registered" is answered honestly instead of
// dead-ending in a Postiz error page.
//
// ── EVERY QUERY HERE PASSES `{ modules: ["social"] }` ───────────────────────────────────────────
// 0105 composes its RLS predicate as `tenant_id = ANY(app_current_tenants()) AND
// app_module_allowed('social')`. Omit the third argument and every statement below reads or writes
// ZERO rows, silently and with no error. That is fail-closed by construction and it is also the
// single most common way a handler in this codebase "mysteriously returns nothing".
//
// ── WHAT NEVER ENTERS THESE TABLES ──────────────────────────────────────────────────────────────
// A token. Not once, not "temporarily", not in `last_error`. D-5's custody split (c) keeps network
// tokens inside the licence-zone process, created and refreshed by its own OAuth machinery, and our
// registry mirrors STATE ABOUT a connection: status, quota counters, resolved capabilities, health
// timestamps, the last error. The org API key is likewise never persisted — `api_key_ref` is an
// alias and `publisher/keys.ts` resolves it from env at call time. `no-token-columns` in
// publisher.test.ts pins the written column list so a future field cannot quietly widen it.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../../db";
import { config } from "../../../config";
import { writeActivity } from "../../../core/http";
import { emitEvent } from "../../../events/outbox.service";
import { isNetwork, type Network } from "../media-rules";
import { resolveAccountCapabilities, deriveAccountStatus, KNOWN_NETWORKS, type AccountCapabilities } from "./capabilities";
import { describeKeyRef, resolveOrgApiKey, DEFAULT_KEY_REF } from "./keys";
import { invokePublisher, resolvePublisher } from "./registry";
import {
  OrgHandle, SocialPublisherError, type IntegrationState, type PublisherRefusalCode, type SocialPublisher,
} from "./types";

/** The third wall, named once. Every `withTenants` call in this file passes it — see the header. */
const MODULES: { modules: string[] } = { modules: ["social"] };

// ── (1) Org provisioning ────────────────────────────────────────────────────────────────────────

export interface PublisherOrgRow {
  id: string;
  clientId: string;
  driver: string;
  postizOrgId: string;
  apiKeyRef: string;
  status: string;
}

export interface ProvisionResult {
  org: PublisherOrgRow;
  /** false ⇒ this call was a no-op repeat (idempotency, agentic-bar criterion 3). */
  created: boolean;
  /** The live probe's outcome. `ok:false` with a reason is an HONEST answer, not a failure of the
   *  provisioning call — see the note on `verify` below. */
  verification: { ok: boolean; integrationCount?: number; reason?: string };
}

/** Provision the (tenant, client) → publisher-org mapping. IDEMPOTENT.
 *
 *  ── WHY THE ORG ID IS AN INPUT AND NOT SOMETHING WE MINT ────────────────────────────────────────
 *  Design §05 sketched `createOrg()`. Postiz has no such route: an org is minted by the runbook's
 *  one-shot registration ceremony on the licence-zone host, by a human, with the registration door
 *  opened and closed around it (deploy-vps.md, "Bootstrap, in order", step 6). Giving the ERP an
 *  HTTP path to that would mean either forking the engine or leaving its signup open — the second
 *  being a containment invariant. So provisioning ADOPTS an operator-created org and records the
 *  mapping, which is the half that was always ours (D-2: tenancy lives in OUR schema and is never
 *  forked into Postiz).
 *
 *  ── HOW 0105's TWO UNIQUES ARE HONOURED RATHER THAN RE-IMPLEMENTED ──────────────────────────────
 *  `UNIQUE (tenant_id, client_id)` and `UNIQUE (postiz_org_id)` are the guarantees, and the second
 *  is GLOBAL — it constrains rows this transaction's RLS scope cannot even see, so no amount of
 *  SELECT-first checking can substitute for it. The code therefore lets the constraint decide and
 *  translates its violation into a typed refusal:
 *    - repeat of the SAME (client, org id) → returns the existing row, `created:false`
 *    - same client, DIFFERENT org id       → `org_conflict` (re-pointing a client at another org is
 *      not an idempotent retry; it is the wrong-account-publish setup, and it must be a deliberate
 *      archive-then-provision, never a silent UPDATE)
 *    - org id already mapped elsewhere     → `org_conflict`, including when "elsewhere" is a tenant
 *      this caller cannot see
 *
 *  ── WHY AN UNREACHABLE PUBLISHER DOES NOT BLOCK THE WRITE ───────────────────────────────────────
 *  The mapping is OUR data. Refusing to record it because a remote box is down would make our own
 *  schema hostage to the licence zone's uptime, which is the opposite of containment. The row is
 *  written and the probe's failure is REPORTED (`verification.ok:false`), never swallowed and never
 *  dressed up as success. Nothing can be published through an unverified org anyway: the dispatch
 *  choke-point below re-validates the whole chain, and `social_accounts` stays empty until a sync
 *  actually reaches the engine. */
export async function provisionPublisherOrg(
  tenantId: string,
  input: { clientId: string; postizOrgId: string; apiKeyRef?: string; driver?: string; actorId: string | null },
): Promise<ProvisionResult> {
  const driver = (input.driver ?? config.social.publisher.driver ?? "postiz").trim();
  const apiKeyRef = (input.apiKeyRef ?? DEFAULT_KEY_REF).trim();

  const existing = await loadOrgByClient(tenantId, input.clientId);
  if (existing) {
    if (existing.postizOrgId !== input.postizOrgId) {
      throw new SocialPublisherError(
        "org_conflict",
        `client is already mapped to publisher org '${existing.postizOrgId}'. Re-pointing a client at a `
        + "different org is not a retry — archive the existing mapping deliberately first.",
      );
    }
    return { org: existing, created: false, verification: await verify(existing) };
  }

  const id = newId();
  try {
    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO social_publisher_orgs
             (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
          [id, tenantId, input.clientId, driver, input.postizOrgId, apiKeyRef, config.originSite],
        );
        // Transactional outbox: the event and the row commit together or not at all.
        await emitEvent(c, tenantId, "social_publisher_org", id, "social.publisher_org.provisioned", {
          clientId: input.clientId,
          driver,
          // The alias, never the key.
          apiKeyRef: describeKeyRef(apiKeyRef),
        });
      },
      MODULES,
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    // A unique violation. Two possible causes, and they mean different things:
    //   (a) a concurrent identical provision won the race → idempotent, return the winner
    //   (b) the org id belongs to another client (possibly in a tenant we cannot see) → refuse
    const now = await loadOrgByClient(tenantId, input.clientId);
    if (now && now.postizOrgId === input.postizOrgId) {
      return { org: now, created: false, verification: await verify(now) };
    }
    throw new SocialPublisherError(
      "org_conflict",
      `publisher org '${input.postizOrgId}' is already mapped to another client — 0105's UNIQUE(postiz_org_id) `
      + "is the wrong-account-publish defence at the schema level and one org can never serve two clients",
    );
  }

  const row = await loadOrgByClient(tenantId, input.clientId);
  /* istanbul ignore next — the row was just committed under this tenant's scope */
  if (!row) throw new SocialPublisherError("org_not_provisioned", "publisher org vanished immediately after provisioning");
  await writeActivity(tenantId, input.actorId, "created", "social_publisher_org", row.id, {
    clientId: input.clientId, driver, apiKeyRef: describeKeyRef(apiKeyRef),
  });
  return { org: row, created: true, verification: await verify(row) };
}

/** Probe the (org, key) pair. Every failure mode is REPORTED, never thrown out of provisioning:
 *  an unconfigured deployment, an unresolvable alias and a downed tunnel are three different
 *  answers, and each names itself. */
async function verify(org: PublisherOrgRow): Promise<ProvisionResult["verification"]> {
  try {
    const { driver, handle } = openOrg(org);
    if (!driver.capabilities.has("org_verify")) return { ok: false, reason: "capability_unsupported" };
    const res = await invokePublisher({ op: "verifyOrg", org: handle }, () => driver.verifyOrg(handle));
    return { ok: res.ok, integrationCount: res.integrationCount };
  } catch (err) {
    return { ok: false, reason: err instanceof SocialPublisherError ? err.code : "publisher_unreachable" };
  }
}

/** Resolve a mapping row into a live driver + handle. The key is read from env HERE, at call time,
 *  and lives only as long as the handle. */
export function openOrg(org: PublisherOrgRow): { driver: SocialPublisher; handle: OrgHandle } {
  const driver = resolvePublisher(org.driver);
  const handle = new OrgHandle(org.id, org.postizOrgId, resolveOrgApiKey(org.apiKeyRef));
  return { driver, handle };
}

export async function loadOrgByClient(tenantId: string, clientId: string): Promise<PublisherOrgRow | null> {
  const { rows } = await withTenants(
    [tenantId],
    (c) => c.query<PublisherOrgRow>(
      `SELECT id, client_id AS "clientId", driver, postiz_org_id AS "postizOrgId",
              api_key_ref AS "apiKeyRef", status
         FROM social_publisher_orgs
        WHERE client_id = $1 AND deleted_at IS NULL`,
      [clientId],
    ),
    MODULES,
  );
  return rows[0] ?? null;
}

// ── (2) Connector-registry sync ─────────────────────────────────────────────────────────────────

export interface SyncedAccount {
  accountId: string;
  network: string;
  handle: string;
  status: string;
  capabilities: AccountCapabilities;
  quotaSource: "live" | "probe_unavailable";
  created: boolean;
}

export interface SyncResult {
  orgId: string;
  accounts: SyncedAccount[];
  /** Rows the engine reported that we did NOT mirror, each with a reason. Named rather than
   *  silently dropped — a network we cannot model is information, not noise. */
  skipped: Array<{ network: string; reason: string }>;
  /** Registry rows the engine no longer reports; marked `disconnected`. */
  disconnected: string[];
}

/** Mirror the engine's integrations into `social_accounts` (the connector registry, modeled on the
 *  IT device registry).
 *
 *  ── WHAT THIS WRITES, AND THE ONE THING IT NEVER WRITES ─────────────────────────────────────────
 *  status · quota · capabilities · health_checked_at · last_error · handle/display name · the
 *  opaque integration id. NOT a token, not a refresh token, not an OAuth code, not a scope grant.
 *  See this file's header.
 *
 *  ── QUOTA IS LIVE OR IT IS UNKNOWN ──────────────────────────────────────────────────────────────
 *  `quota` comes from `SocialPublisher.getQuota`, which for Instagram is
 *  `GET /<IG_ID>/content_publishing_limit` (addendum §A4f). When the driver cannot carry the probe
 *  the column is written `{}` and `quotaSource` reports `probe_unavailable` — `media-rules.ts`
 *  already degrades an absent counter to a `quota_unknown` WARNING rather than reading it as "zero
 *  used", which is the shipped behaviour §A4f vindicated twice. A constant is never written: the
 *  old "25 posts/24h" is obsolete, Meta's own doc contradicts itself (100 vs 50), and a synthesized
 *  cap is wrong in a way nothing downstream could detect.
 *
 *  ── WHAT IT DOES WHEN THE PUBLISHER IS UNREACHABLE ──────────────────────────────────────────────
 *  It refuses (`publisher_unreachable` / `publisher_not_configured`) and touches NOT ONE ROW. That
 *  is the important half: a tunnel outage must never be mistaken for "every client account is
 *  disconnected". Writing that would put a false, alarming state in front of an operator and — worse
 *  — would hide the real accounts behind a wrong one. The registry keeps its last known good state,
 *  `health_checked_at` is not advanced (nothing was checked), and the refusal surfaces as a 503 with
 *  a typed code. Reads of the registry are unaffected, which is the whole "degrade visibly, keep
 *  serving reads" property this ticket owes. */
export async function syncConnectorRegistry(
  tenantId: string,
  clientId: string,
  actorId: string | null,
): Promise<SyncResult> {
  const org = await loadOrgByClient(tenantId, clientId);
  if (!org) {
    throw new SocialPublisherError(
      "org_not_provisioned",
      "this client has no publisher org mapping — provision one before syncing its connector registry",
    );
  }
  const { driver, handle } = openOrg(org);
  if (!driver.capabilities.has("integrations")) {
    throw new SocialPublisherError("capability_unsupported", `driver '${driver.key}' cannot list integrations`);
  }

  // The network call happens FIRST and OUTSIDE any transaction. If it throws, nothing has been
  // written and nothing needs rolling back — see the header note above.
  const integrations = await invokePublisher(
    { op: "listIntegrations", org: handle },
    () => driver.listIntegrations(handle),
  );

  const skipped: SyncResult["skipped"] = [];
  const usable: IntegrationState[] = [];
  for (const it of integrations) {
    if (!KNOWN_NETWORKS.includes(it.network)) {
      // 0105's CHECK constraint would reject it anyway; refusing here means a NAMED skip instead of
      // a constraint error, and — the real point — a coerced network would mis-route a publish.
      skipped.push({ network: it.network, reason: "unmodelled_network" });
      continue;
    }
    usable.push(it);
  }

  // Quota probes, one per account, before the write transaction. Each is independently allowed to
  // come back "unknown"; one account's missing probe never blocks another account's mirror.
  const quotas = new Map<string, { snapshot: Record<string, unknown>; source: SyncedAccount["quotaSource"] }>();
  for (const it of usable) {
    let snapshot: Record<string, unknown> | undefined;
    if (driver.capabilities.has("quota_probe")) {
      snapshot = (await invokePublisher(
        { op: "getQuota", org: handle, network: it.network },
        () => driver.getQuota(handle, it),
      )) as Record<string, unknown> | undefined;
    }
    quotas.set(it.id, snapshot ? { snapshot, source: "live" } : { snapshot: {}, source: "probe_unavailable" });
  }

  const result = await withTenants(
    [tenantId],
    async (c) => {
      const accounts: SyncedAccount[] = [];
      for (const it of usable) {
        const capabilities = resolveAccountCapabilities(it.network, driver.capabilities);
        const status = deriveAccountStatus(it);
        const quota = quotas.get(it.id) ?? { snapshot: {}, source: "probe_unavailable" as const };
        const upserted = await upsertAccount(c, {
          tenantId, clientId, publisherOrgId: org.id, integration: it, status, capabilities, quota: quota.snapshot,
        });
        accounts.push({
          accountId: upserted.id, network: it.network, handle: it.handle, status,
          capabilities, quotaSource: quota.source, created: upserted.created,
        });
      }

      // Rows the engine no longer reports. `pending` rows (created by SMM-07's connect flow before
      // OAuth completes, and therefore carrying no integration id) are deliberately untouched —
      // "not yet connected" and "no longer connected" are different states and the console shows
      // them differently.
      const seen = usable.map((i) => i.id);
      const { rows: gone } = await c.query<{ id: string }>(
        `UPDATE social_accounts
            SET status = 'disconnected', health_checked_at = now(), updated_at = now()
          WHERE client_id = $1
            AND deleted_at IS NULL
            AND postiz_integration_id IS NOT NULL
            AND NOT (postiz_integration_id = ANY($2::text[]))
            AND status <> 'disconnected'
          RETURNING id`,
        [clientId, seen],
      );

      await emitEvent(c, tenantId, "social_account", org.id, "social.connector_registry.synced", {
        clientId, mirrored: accounts.length, skipped: skipped.length, disconnected: gone.length,
      });
      return { accounts, disconnected: gone.map((g) => g.id) };
    },
    MODULES,
  );

  await writeActivity(tenantId, actorId, "synced", "social_publisher_org", org.id, {
    clientId, mirrored: result.accounts.length, skipped: skipped.length, disconnected: result.disconnected.length,
  });
  return { orgId: org.id, accounts: result.accounts, skipped, disconnected: result.disconnected };
}

/** Match on the opaque integration id FIRST, then on 0105's `UNIQUE (tenant_id, client_id, network,
 *  handle)`. The order matters: a client who renames their account upstream keeps ONE registry row
 *  (with its history, its notes and its FK from every variant that targets it) instead of growing a
 *  second one that silently competes with the first for future publishes. */
async function upsertAccount(
  c: PoolClient,
  args: {
    tenantId: string; clientId: string; publisherOrgId: string; integration: IntegrationState;
    status: string; capabilities: AccountCapabilities; quota: Record<string, unknown>;
  },
): Promise<{ id: string; created: boolean }> {
  const { integration: it } = args;
  const byIntegration = await c.query<{ id: string }>(
    `UPDATE social_accounts
        SET handle = $1, display_name = $2, status = $3, quota = $4::jsonb, capabilities = $5::jsonb,
            last_error = $6, health_checked_at = now(),
            connected_at = COALESCE(connected_at, CASE WHEN $3 = 'connected' THEN now() END),
            updated_at = now()
      WHERE client_id = $7 AND postiz_integration_id = $8 AND deleted_at IS NULL
      RETURNING id`,
    [it.handle, it.displayName ?? null, args.status, JSON.stringify(args.quota),
      JSON.stringify(args.capabilities), it.error ?? null, args.clientId, it.id],
  );
  if (byIntegration.rows[0]) return { id: byIntegration.rows[0].id, created: false };

  const id = newId();
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO social_accounts
       (id, tenant_id, client_id, publisher_org_id, network, handle, display_name,
        postiz_integration_id, status, quota, capabilities, last_error, health_checked_at,
        connected_at, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12, now(),
             CASE WHEN $9 = 'connected' THEN now() END, $13)
     ON CONFLICT (tenant_id, client_id, network, handle) DO UPDATE
        SET postiz_integration_id = EXCLUDED.postiz_integration_id,
            publisher_org_id = EXCLUDED.publisher_org_id,
            display_name = EXCLUDED.display_name,
            status = EXCLUDED.status,
            quota = EXCLUDED.quota,
            capabilities = EXCLUDED.capabilities,
            last_error = EXCLUDED.last_error,
            health_checked_at = now(),
            connected_at = COALESCE(social_accounts.connected_at, EXCLUDED.connected_at),
            -- Resurrect a soft-deleted row rather than leaving it to squat on the unique slot.
            -- 0105's UNIQUE (tenant_id, client_id, network, handle) has no partial WHERE, so a
            -- soft-deleted row still OCCUPIES the key: leaving deleted_at set would make every
            -- future sync of that handle write into a row no "deleted_at IS NULL" query can see —
            -- a silent black hole where the console shows the account permanently missing while the
            -- engine keeps reporting it connected. Reconnecting an account someone disconnected is
            -- a visible, auditable event (the sync's work_activity row and outbox event both fire);
            -- an invisible one is not.
            deleted_at = NULL,
            updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [id, args.tenantId, args.clientId, args.publisherOrgId, it.network, it.handle, it.displayName ?? null,
      it.id, args.status, JSON.stringify(args.quota), JSON.stringify(args.capabilities),
      it.error ?? null, config.originSite],
  );
  const row = inserted.rows[0] as { id: string; inserted?: boolean };
  return { id: row.id, created: row.inserted === true };
}

// ── (2.5) Account connect flow (SMM-07) ─────────────────────────────────────────────────────────
//
// THE CONSTRAINT THIS SECTION IS BUILT AROUND: verified on the live engine 2026-08-19,
// FACEBOOK_APP_ID/SECRET, LINKEDIN_CLIENT_ID/SECRET, TIKTOK_CLIENT_ID and YOUTUBE_CLIENT_ID are all
// length 0. No platform app exists on ANY network today, so no OAuth round trip can begin — not for
// a client, not for our own brand. A connect button that dead-ends in a Postiz error page is worse
// than one that says so up front, so `checkConnectReadiness` is the SAME precondition both
// `initiateAccountConnect` (POST, has side effects) and the console's readiness read (GET, none)
// run — one rule, never two copies that could drift.
//
// ── A NEW, SMALL VOCABULARY, AND WHY IT IS NOT `PUBLISH_REFUSAL` ────────────────────────────────
// publish-precondition.ts's `PUBLISH_REFUSAL` answers "may this VARIANT publish right now" at
// execution time, for the D14 executor. This section answers a different question at a different
// time for a different caller: "may this (client, network) START a connect attempt", asked by the
// console's connect button. Two of the three tokens below are new (`platform_app_not_registered`,
// `client_connect_requires_signoff`) — see types.ts for why they could not be an existing code
// wearing a new label. The third (`connect_redirect_not_configured`) joins `SocialPublisherError`'s
// existing 503 family rather than inventing a fourth status class.
//
// ── OWN-BRAND-FIRST (OQ-3), STATED SO IT IS NOT MISSED ──────────────────────────────────────────
// `config.social.publisher.ownBrandClientIds` is the ONLY thing that lets a connect attempt past
// `client_connect_requires_signoff`. It is empty by default — so with no configuration at all, EVERY
// client (including a would-be "own brand" one nobody has listed yet) refuses, which is the correct
// fail-closed default for a legal gate nobody has cleared yet.
//
// ── RESUMABILITY, STATED SO A FUTURE EDIT DOES NOT "SIMPLIFY" IT AWAY ───────────────────────────
// The addendum is explicit: "every network requires the client's own owner to authenticate
// personally... onboarding is a scheduled human ceremony per client per network" and SMM-07 "must be
// built as a guided, resumable flow" — not a one-shot round trip that dies if the human closes the
// tab, loses connectivity, or comes back tomorrow. The mechanism is the SAME upsert idiom
// `upsertAccount` above already uses to survive an upstream rename: the pending row's key is
// `(tenant_id, client_id, network, handle)`, the SAME unique 0105 already enforces, so:
//   - Calling `initiateAccountConnect` again for the same triple returns the SAME account id
//     (`resumed:true`) with a freshly re-requested `connectUrl` — never a second, competing row.
//   - Whenever the human actually finishes the OAuth dance and `syncConnectorRegistry` next runs,
//     its own `upsertAccount` ON CONFLICT on that identical key is what promotes this exact row from
//     `pending` to `connected` — convergence through the SAME code path that already handles a
//     rename, not a second one built for this ticket.
//   - The pending row is written (and its outbox event committed) BEFORE the engine is ever called,
//     so a `connectUrl` failure (tunnel down, no capability, no app) leaves the attempt VISIBLE and
//     retryable rather than losing it — the same "the mapping is OUR data" reasoning
//     `provisionPublisherOrg` above already applies to `verify()`.

/** Every fact `initiateAccountConnect` must be honest about before it EVER calls the engine.
 *  Non-throwing by design: the console's read-only readiness check and the connect POST both run
 *  this, and a read must never throw for an ordinary "not yet" answer. */
export interface ConnectReadiness {
  ok: boolean;
  reason?: PublisherRefusalCode;
  detail?: string;
}

/** Query `social_platform_apps` (0105: GLOBAL, no tenant_id, deliberately NO RLS — design D-4) for a
 *  network with a live credential alias. Exported so the platform-app admin surface (not yet built;
 *  OQ-1's own tracking, D-4's "reachable only through admin endpoints gated by
 *  social.platform_app.admin") has a single place this fact is read from, the moment it exists. */
export async function hasRegisteredPlatformApp(network: string): Promise<boolean> {
  const { rows } = await withGlobal((c) =>
    c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM social_platform_apps
        WHERE network = $1 AND deleted_at IS NULL AND review_status <> 'rejected'
          AND credential_ref IS NOT NULL AND credential_ref <> ''`,
      [network],
    ),
  );
  return rows[0].n > 0;
}

/** THE precondition, run by both the read-only readiness check and the connect POST. Order:
 *  cheapest and most structural first (mirrors publish-precondition.ts's own stated doctrine) —
 *  config dials before database reads, database reads before a driver resolution that may itself
 *  throw `publisher_not_configured`. */
export async function checkConnectReadiness(
  tenantId: string,
  clientId: string,
  network: string,
): Promise<ConnectReadiness> {
  if (!isNetwork(network)) {
    return { ok: false, reason: "network_disabled", detail: `'${network}' is not a network this platform models` };
  }
  if (!config.social.publisher.enabledNetworks.includes(network)) {
    return {
      ok: false, reason: "network_disabled",
      detail: `'${network}' is disabled in this deployment (SOCIAL_NETWORKS_ENABLED)`,
    };
  }
  // OQ-3, checked before anything that costs a round trip: own-brand proceeds, client connects wait.
  if (!config.social.publisher.ownBrandClientIds.includes(clientId)) {
    return {
      ok: false, reason: "client_connect_requires_signoff",
      detail: "client account connects wait for AGPL counsel sign-off (design addendum OQ-3); "
        + "own-brand accounts proceed",
    };
  }
  if (!config.social.publisher.connectRedirectUrl) {
    return {
      ok: false, reason: "connect_redirect_not_configured",
      detail: "SOCIAL_CONNECT_REDIRECT_URL is unset",
    };
  }
  // OQ-1, THE headline check this ticket exists for: is there even an app to start OAuth against.
  if (!(await hasRegisteredPlatformApp(network))) {
    return {
      ok: false, reason: "platform_app_not_registered",
      detail: `no platform app is registered for '${network}' yet (design addendum OQ-1 — the `
        + "review is weeks-long and non-code; nothing here can shortcut it)",
    };
  }
  const org = await loadOrgByClient(tenantId, clientId);
  if (!org) {
    return {
      ok: false, reason: "org_not_provisioned",
      detail: "provision a publisher org for this client before connecting an account",
    };
  }
  try {
    const driver = resolvePublisher(org.driver);
    if (!driver.capabilities.has("connect_url")) {
      return {
        ok: false, reason: "capability_unsupported",
        detail: `driver '${driver.key}' cannot start a connect flow`,
      };
    }
  } catch (err) {
    if (err instanceof SocialPublisherError) return { ok: false, reason: err.code, detail: err.message };
    throw err;
  }
  return { ok: true };
}

export interface ConnectResult {
  accountId: string;
  /** Always `pending` on return: this call starts the human ceremony, it never completes it.
   *  `syncConnectorRegistry` is what later observes `connected`/`expiring`/etc. */
  status: "pending";
  connectUrl: string;
  /** false the first time this (client, network, handle) triple is attempted; true on every
   *  subsequent call while it is still pending — the resumability signal a console renders as
   *  "resuming an earlier attempt" instead of "starting a new one". */
  resumed: boolean;
}

/** Start (or resume) the guided connect ceremony for one (client, network, handle). `handle` is the
 *  handle the AGENCY already knows for this account (e.g. the client told us `@acmebrand`) — it is
 *  never discovered from Postiz, because at this instant Postiz has not yet been told about this
 *  account at all. Supplying it up front is what makes the eventual convergence in
 *  `syncConnectorRegistry`'s `upsertAccount` possible: that function's `ON CONFLICT (tenant_id,
 *  client_id, network, handle)` is the SAME key this function upserts on, so the row this call
 *  creates is the SAME row a later sync promotes to `connected` — one row, one history, from attempt
 *  to live connection. */
export async function initiateAccountConnect(
  tenantId: string,
  input: { clientId: string; network: string; handle: string; actorId: string | null },
): Promise<ConnectResult> {
  const readiness = await checkConnectReadiness(tenantId, input.clientId, input.network);
  if (!readiness.ok) {
    throw new SocialPublisherError(
      readiness.reason!,
      readiness.detail ?? `connect refused for '${input.network}': ${readiness.reason}`,
    );
  }
  const network = input.network as Network;
  const handle = input.handle.trim();

  const org = await loadOrgByClient(tenantId, input.clientId);
  /* istanbul ignore next — checkConnectReadiness just proved this row exists */
  if (!org) throw new SocialPublisherError("org_not_provisioned", "publisher org vanished after the readiness check");
  const { driver, handle: orgHandle } = openOrg(org);

  // The pending row + its outbox event commit FIRST, before the engine is ever called — see the
  // section header's "resumability" note for why. `resumed` is read off `xmax = 0`, the SAME idiom
  // `upsertAccount` above uses to distinguish an insert from a conflict-update.
  const { accountId, resumed } = await withTenants(
    [tenantId],
    async (c) => {
      const id = newId();
      const { rows } = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
         ON CONFLICT (tenant_id, client_id, network, handle) DO UPDATE
            SET publisher_org_id = EXCLUDED.publisher_org_id,
                -- Resurrect a soft-deleted or previously-abandoned attempt rather than squatting the
                -- unique slot forever (same reasoning as upsertAccount's own resurrection branch).
                deleted_at = NULL,
                -- Never regress an ALREADY-connected account back to pending: a resumed attempt on a
                -- triple that converged since the caller last looked must not un-convert it.
                status = CASE WHEN social_accounts.postiz_integration_id IS NULL THEN 'pending'
                              ELSE social_accounts.status END,
                updated_at = now()
           RETURNING id, (xmax = 0) AS inserted`,
        [id, tenantId, input.clientId, org.id, network, handle, config.originSite],
      );
      const row = rows[0] as { id: string; inserted?: boolean };
      const wasInserted = row.inserted === true;
      await emitEvent(
        c, tenantId, "social_account", row.id,
        wasInserted ? "social.account.connect_initiated" : "social.account.connect_resumed",
        { clientId: input.clientId, network, handle },
      );
      return { accountId: row.id, resumed: !wasInserted };
    },
    MODULES,
  );

  await writeActivity(tenantId, input.actorId, resumed ? "resumed" : "initiated", "social_account", accountId, {
    clientId: input.clientId, network, handle,
  });

  // The network call happens LAST, and its failure is allowed to propagate: the row above already
  // committed, so a `publisher_unreachable`/`capability_unsupported` here leaves a retryable pending
  // attempt behind rather than losing it — never a partial, invisible state.
  const connectUrl = await invokePublisher(
    { op: "connectUrl", org: orgHandle, network },
    () => driver.connectUrl(orgHandle, network, config.social.publisher.connectRedirectUrl),
  );

  return { accountId, status: "pending", connectUrl, resumed };
}

// ── (3) The dispatch choke-point's FK-chain validation ──────────────────────────────────────────

export interface DispatchChain {
  variantId: string;
  accountId: string;
  engagementId: string;
  clientId: string;
  network: string;
  integrationId: string;
  org: PublisherOrgRow;
  toolScope: Record<string, Record<string, unknown>>;
}

/** THE WRONG-ACCOUNT-PUBLISH DEFENCE (design §11), at the choke-point.
 *
 *  0105 already enforces SAME-TENANT along every edge of this chain with composite FKs
 *  (`fk_social_post_variants_account_tenant`, `fk_social_accounts_org_tenant`, …), and an FK check
 *  runs as the table owner OUTSIDE RLS, so those are genuinely load-bearing rather than decorative.
 *  What no constraint can express is the CLIENT-level rule, because `social_post_variants` has no
 *  `client_id` of its own — the client is reached through `post → engagement`. So:
 *
 *      variant → post → engagement → client_id          (who the content is FOR)
 *      variant → account → client_id                    (whose account it would land on)
 *      account → publisher_org → client_id              (whose engine org would carry it)
 *
 *  All three must name the same client. A mismatch anywhere REFUSES fail-closed with an audit line
 *  — never a warning, never a "best effort" publish to the account that was asked for. Within one
 *  agency tenant, two clients' accounts are both perfectly visible to the same operator and the same
 *  automation, so this is not an exotic scenario: it is a mis-set `accountId` in a composer payload
 *  or a tool call, and the consequence is a client's content on another client's public feed.
 *
 *  Takes an EXISTING transaction client so SMM-09 can run it inside the same transaction that
 *  consumes the one-shot approval and stamps `provider_post_id` — a TOCTOU gap between "validated"
 *  and "dispatched" would defeat the point. `assertDispatchChainForTenant` is the standalone
 *  wrapper for callers that have no transaction of their own.
 *
 *  This function does NOT publish and does not decide whether the caller may publish; SMM-09 owns
 *  the approval gate, the tool-scope check and the metered stop-loss. It answers exactly one
 *  question: is this account the right account for this variant? */
export async function assertDispatchChain(c: PoolClient, variantId: string): Promise<DispatchChain> {
  const { rows } = await c.query<{
    variantId: string; accountId: string; accountClientId: string; accountStatus: string;
    network: string; integrationId: string | null; engagementId: string; engagementClientId: string;
    orgId: string; orgClientId: string; driver: string; postizOrgId: string; apiKeyRef: string;
    orgStatus: string; toolScope: Record<string, Record<string, unknown>>;
  }>(
    `SELECT v.id                AS "variantId",
            a.id                AS "accountId",
            a.client_id         AS "accountClientId",
            a.status            AS "accountStatus",
            a.network           AS "network",
            a.postiz_integration_id AS "integrationId",
            e.id                AS "engagementId",
            e.client_id         AS "engagementClientId",
            e.tool_scope        AS "toolScope",
            o.id                AS "orgId",
            o.client_id         AS "orgClientId",
            o.driver            AS "driver",
            o.postiz_org_id     AS "postizOrgId",
            o.api_key_ref       AS "apiKeyRef",
            o.status            AS "orgStatus"
       FROM social_post_variants v
       JOIN social_posts p          ON p.id = v.post_id           AND p.tenant_id = v.tenant_id
       JOIN social_engagements e    ON e.id = p.engagement_id     AND e.tenant_id = v.tenant_id
       JOIN social_accounts a       ON a.id = v.account_id        AND a.tenant_id = v.tenant_id
       JOIN social_publisher_orgs o ON o.id = a.publisher_org_id  AND o.tenant_id = v.tenant_id
      WHERE v.id = $1 AND v.deleted_at IS NULL`,
    [variantId],
  );
  const row = rows[0];
  if (!row) {
    // Also the answer when the chain itself is broken (a soft-deleted post, an account in another
    // tenant that the composite FKs and RLS both hide). "Not found" is the correct, non-leaking
    // response either way — it never confirms that some other tenant's row exists.
    throw new SocialPublisherError("cross_client_account", `variant ${variantId} has no valid publish chain in this tenant`);
  }

  if (row.accountClientId !== row.engagementClientId) {
    throw new SocialPublisherError(
      "cross_client_account",
      "refused: the target account belongs to a different client than this post's engagement "
      + "(design §11, the wrong-account-publish defence)",
    );
  }
  if (row.orgClientId !== row.engagementClientId) {
    // Belt and braces on the same edge: 0105's UNIQUE(postiz_org_id) makes one org serving two
    // clients impossible, so reaching here means the account row itself was mis-linked.
    throw new SocialPublisherError(
      "cross_client_account",
      "refused: the account's publisher org belongs to a different client than this post's engagement",
    );
  }
  if (row.orgStatus !== "active") {
    throw new SocialPublisherError("account_not_connected", `publisher org is '${row.orgStatus}', not active`);
  }
  if (row.accountStatus !== "connected" || !row.integrationId) {
    throw new SocialPublisherError(
      "account_not_connected",
      `target account is '${row.accountStatus}'${row.integrationId ? "" : " and carries no engine integration id"}`,
    );
  }
  // The DEPLOYMENT-level network flag, which outranks any per-engagement tool_scope: three of the
  // five researched networks cannot publish publicly at all until an audit passes (§A4g/§A4h), and
  // X is metered. SMM-09 still owes the tool_scope check — this is the outer gate, not a substitute.
  if (!config.social.publisher.enabledNetworks.includes(row.network)) {
    throw new SocialPublisherError(
      "network_disabled",
      `network '${row.network}' is disabled in this deployment (SOCIAL_NETWORKS_ENABLED)`,
    );
  }

  return {
    variantId: row.variantId,
    accountId: row.accountId,
    engagementId: row.engagementId,
    clientId: row.engagementClientId,
    network: row.network,
    integrationId: row.integrationId,
    org: {
      id: row.orgId, clientId: row.orgClientId, driver: row.driver,
      postizOrgId: row.postizOrgId, apiKeyRef: row.apiKeyRef, status: row.orgStatus,
    },
    toolScope: row.toolScope ?? {},
  };
}

/** Standalone wrapper: opens its own tenant transaction, and on a CROSS-CLIENT refusal writes the
 *  audit line design §11 requires ("a cross-client mismatch anywhere refuses fail-closed with an
 *  audit line"). The activity row is written AFTER the read transaction, deliberately — a refusal
 *  must be recorded even though the transaction it was detected in contributed nothing. */
export async function assertDispatchChainForTenant(
  tenantId: string,
  variantId: string,
  actorId: string | null,
): Promise<DispatchChain> {
  try {
    return await withTenants([tenantId], (c) => assertDispatchChain(c, variantId), MODULES);
  } catch (err) {
    if (err instanceof SocialPublisherError && err.code === "cross_client_account") {
      await writeActivity(tenantId, actorId, "refused", "social_post_variant", variantId, {
        reason: err.code,
        // The refusal, not the mismatched ids: an audit line naming which OTHER client's account was
        // reached would put one client's identity into a record about another's content.
        control: "dispatch_fk_chain",
      });
    }
    throw err;
  }
}
