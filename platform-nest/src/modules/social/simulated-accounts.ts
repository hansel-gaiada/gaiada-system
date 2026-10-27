// SCP-Sb — the SEED of the social simulator's accounts: one simulated Instagram, Facebook and TikTok account per mock client
// (plan §5 "Simulated accounts"; BFF §63.1 file 8, §63.16). The routes are `simulated-accounts.controller.ts`; this file is
// the rule and the rows. SCP-Sa built the containment (publisher/simulation.ts, its six fences); this file is the ONE writer
// of a `simulated = true` account, and it owes Sa's fence 4 before it writes (`assertSimulatedWriteAllowed`, called by the
// controller before anything is read, and again here by `seedSimulatedAccounts` so no second caller can forget it).
//
// ── WHAT A SEEDED ACCOUNT IS (what Sa says the pipeline needs) ─────────────────────────────────────────────────────────
//   simulated = true · status = 'connected' · postiz_integration_id = 'simulated:<network>' (a non-null, self-describing id:
//   `assertDispatchChain` refuses an account with none) · under an ACTIVE `social_publisher_orgs` row of the same client.
//   The org's `driver` column stays 'postiz' (0105's CHECK admits only postiz|mixpost): it does not route anything. A variant
//   reaches the simulator ONLY because its ACCOUNT is simulated (`provisioning.ts#resolveDispatchOrgHandle`); the org is the
//   mapping row the chain's FKs need, no more. An org this seed creates carries `postiz_org_id = 'simulated-<clientId>'` (the
//   whole client id: `postiz_org_id` is GLOBALLY unique, and a truncated uuid v7 is a timestamp, not a short unique id) and
//   `api_key_ref = 'simulated:no-key'`, an alias that resolves to nothing: nothing real can be called through it, and
//   `resolveOrgApiKey` is never reached for a simulated account.
//
// ── ONE ACCOUNT PER PLACED NETWORK (the pipeline's two account guards) ─────────────────────────────────────────────────
// `final_approve` and `reschedule` count a client's accounts per network the way `pipeline-data.ts#loadClientAccounts` does:
// not deleted, status <> 'disconnected', simulated or not. They need EXACTLY one per placed network (`no_account_for_network`
// when none, `ambiguous_account` when two). So this seed:
//   * writes at most one account per network and client (a re-run finds it and says `created: false`);
//   * refuses (409 `account_exists_not_simulated`, nothing written) when the client already has a LIVE account on a requested
//     network that is not simulated, or a non-simulated row (deleted or disconnected too) holding the very handle it would
//     take (0105's UNIQUE (tenant, client, network, handle) counts soft-deleted rows). A second account beside a real one
//     would make the pipeline `ambiguous_account`, and a real account beside the simulator is what boot refuses anyway.
//
// ── SOFT-DELETED SIMULATED ROWS ARE REVIVED, NOT DUPLICATED ────────────────────────────────────────────────────────────
// The social module never hard-deletes (the UNIQUE above has no partial WHERE). `removeSimulatedAccounts` soft-deletes, and a
// later seed revives the same row (`created: true`: the pipeline did not have it a moment ago). This is the SIMULATED half of
// Sa's note that soft-deleted rows count at boot: boot counts only `simulated = false` rows, so a soft-deleted SIMULATED row
// is harmless, and a soft-deleted REAL row is not (the prepare script lists those).
//
// ── NETWORKS ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// `SOCIAL_NETWORKS_ENABLED` defaults to instagram,facebook,linkedin: TikTok is OFF at the deployment level. The pipeline's
// account guards do not read that flag, so a seeded TikTok account satisfies `final_approve`, but `assertDispatchChain` then
// refuses its variant at publish time (`network_disabled`). The seed does NOT widen or bypass that gate (it is not ours to
// weaken); it reports `networkEnabled` per account so the caller can say it, and the runbook names the env var to extend.
import type { PoolClient } from "pg";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { newId } from "../../db";
import { config } from "../../config";
import { invalidField } from "./pipeline/brand-book";
import { resolveAccountCapabilities } from "./publisher/capabilities";
import { SIMULATED_CAPABILITIES } from "./publisher/simulated-driver";
import { assertSimulatedWriteAllowed } from "./publisher/simulation";

/** The three networks the simulator seeds (plan §5). Order is the answer's order. */
export const SIMULATED_ACCOUNT_NETWORKS = ["instagram", "facebook", "tiktok"] as const;
export type SimulatedAccountNetwork = (typeof SIMULATED_ACCOUNT_NETWORKS)[number];

/** `social_publisher_orgs.api_key_ref` of an org this seed creates: an alias that resolves to nothing, never a key. */
export const SIMULATED_ORG_KEY_REF = "simulated:no-key";

/** `social_accounts.postiz_integration_id` of a seeded account: non-null (the dispatch chain demands one) and self-describing. */
export const simulatedIntegrationId = (network: string): string => `simulated:${network}`;

/** PURE. `@mock-<slug of the client name>`. The slug is the name lowercased, every run of non-alphanumerics one `-`, trimmed,
 *  at most 40 characters; a name with no ASCII letters or digits falls back to the first 8 characters of the client id (never
 *  an empty `@mock-`). */
export function simulatedHandleFor(clientName: string, clientId: string): string {
  const slug = clientName.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return `@mock-${slug || clientId.replace(/-/g, "").slice(0, 8)}`;
}

const isNetworkName = (v: unknown): v is SimulatedAccountNetwork =>
  typeof v === "string" && (SIMULATED_ACCOUNT_NETWORKS as readonly string[]).includes(v);

/** PURE. The `networks` of a request: a non-empty list of distinct members of `SIMULATED_ACCOUNT_NETWORKS`, answered in the
 *  seed's own order. Absent = all three. */
function pickNetworks(v: unknown, field: string): SimulatedAccountNetwork[] {
  if (v === undefined) return [...SIMULATED_ACCOUNT_NETWORKS];
  if (!Array.isArray(v) || v.length === 0 || v.length > SIMULATED_ACCOUNT_NETWORKS.length) return invalidField(field);
  const seen = new Set<string>();
  for (const x of v) {
    if (!isNetworkName(x)) return invalidField(field);
    seen.add(x);
  }
  return SIMULATED_ACCOUNT_NETWORKS.filter((n) => seen.has(n));
}

/** PURE. The POST body: nothing, `{}` or `{networks?: string[]}`. An unknown key is 400 `unknown_field`; a bad value 400
 *  `invalid_field` with `field`. */
export function parseSeedBody(body: unknown): SimulatedAccountNetwork[] {
  if (body === undefined || body === null) return [...SIMULATED_ACCOUNT_NETWORKS];
  if (typeof body !== "object" || Array.isArray(body)) return invalidField("body");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (k !== "networks") throw new BadRequestException({ message: "unknown_field", field: k });
  }
  return pickNetworks(b.networks, "networks");
}

/** PURE. The DELETE query: `networks` is a comma-separated list, absent = every simulated account of the client. */
export function parseTeardownNetworks(q: unknown): SimulatedAccountNetwork[] {
  if (q === undefined || q === "") return [...SIMULATED_ACCOUNT_NETWORKS];
  if (typeof q !== "string") return invalidField("networks");
  return pickNetworks(q.split(",").map((s) => s.trim().toLowerCase()), "networks");
}

export interface SeededAccount {
  id: string;
  network: SimulatedAccountNetwork;
  handle: string;
  simulated: true;
  /** True when this call put the account into the pipeline (inserted, or revived from soft-delete); false when it was already there. */
  created: boolean;
  /** `SOCIAL_NETWORKS_ENABLED` names the network: when false, the account satisfies the pipeline but a publish refuses `network_disabled`. */
  networkEnabled: boolean;
}

export interface RemovedAccount { id: string; network: string; handle: string }

interface AccountRow {
  id: string; network: string; handle: string; simulated: boolean; status: string; deleted_at: Date | string | null;
  integration_id: string | null; publisher_org_id: string;
}

const isLive = (r: Pick<AccountRow, "deleted_at" | "status">): boolean => r.deleted_at === null && r.status !== "disconnected";

/** The org the accounts hang from: the client's existing org (any row: `UNIQUE (tenant_id, client_id)` counts soft-deleted
 *  ones), else a new one. An existing org that is not active, or is deleted, is a 409 `publisher_org_not_active`: this seed
 *  does not reactivate somebody's suspended mapping. */
async function ensureOrg(c: PoolClient, tenantId: string, clientId: string): Promise<string> {
  const find = () => c.query<{ id: string; status: string; deleted_at: Date | null }>(
    `SELECT id, status, deleted_at FROM social_publisher_orgs WHERE tenant_id = $1 AND client_id = $2`, [tenantId, clientId],
  );
  let found = (await find()).rows[0];
  if (!found) {
    await c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1, $2, $3, 'postiz', $4, $5, 'active', $6)
       ON CONFLICT (tenant_id, client_id) DO NOTHING`,
      [newId(), tenantId, clientId, `simulated-${clientId}`, SIMULATED_ORG_KEY_REF, config.originSite],
    );
    found = (await find()).rows[0];
  }
  if (!found || found.deleted_at !== null || found.status !== "active") {
    throw new ConflictException({ message: "publisher_org_not_active" });
  }
  return found.id;
}

/** Seeds, idempotently, one simulated account per requested network for `clientId`, in the caller's transaction (the caller
 *  has locked the engagement row and declared the social module scope). All-or-nothing: every conflict is found BEFORE the
 *  first write. */
export async function seedSimulatedAccounts(
  c: PoolClient, tenantId: string, clientId: string, clientName: string, networks: readonly SimulatedAccountNetwork[],
): Promise<SeededAccount[]> {
  // Fence 4 of simulation.ts's header, owed by this writer: nothing writes a simulated account while the switch is off.
  assertSimulatedWriteAllowed("simulated-account seed");
  const handle = simulatedHandleFor(clientName, clientId);
  const { rows } = await c.query<AccountRow>(
    `SELECT id, network, handle, simulated, status, deleted_at, postiz_integration_id AS integration_id, publisher_org_id
       FROM social_accounts
      WHERE tenant_id = $1 AND client_id = $2 AND network = ANY($3::text[])
      ORDER BY created_at, id
        FOR UPDATE`,
    [tenantId, clientId, [...networks]],
  );
  // Refuse before writing: a live REAL account on the network, or a real row (deleted or not) on the very handle.
  const clash = networks.filter((n) => rows.some((r) => r.network === n && !r.simulated && (isLive(r) || r.handle === handle)));
  if (clash.length > 0) throw new ConflictException({ message: "account_exists_not_simulated", detail: { networks: clash } });

  const orgId = await ensureOrg(c, tenantId, clientId);
  const out: SeededAccount[] = [];
  for (const network of networks) {
    const mine = rows.filter((r) => r.network === network && r.simulated);
    // Oldest live simulated account on the network wins (a hand-made second one is not this seed's to remove); else the row
    // squatting on the seed's own handle (soft-deleted or disconnected); else a new one.
    const live = mine.find((r) => isLive(r));
    const squatter = live ?? mine.find((r) => r.handle === handle);
    const enabled = config.social.publisher.enabledNetworks.includes(network);
    if (live && live.status === "connected" && live.integration_id && live.publisher_org_id === orgId) {
      out.push({ id: live.id, network, handle: live.handle, simulated: true, created: false, networkEnabled: enabled });
      continue;
    }
    const caps = JSON.stringify(resolveAccountCapabilities(network, new Set(SIMULATED_CAPABILITIES)));
    if (squatter) {
      // Repair or revive in place. `created` says whether the pipeline gained an account: a revival does, a repair does not.
      await c.query(
        `UPDATE social_accounts
            SET simulated = true, status = 'connected', postiz_integration_id = $3, publisher_org_id = $4, capabilities = $5::jsonb,
                last_error = NULL, health_checked_at = now(), connected_at = COALESCE(connected_at, now()),
                deleted_at = NULL, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND simulated = true`,
        [tenantId, squatter.id, simulatedIntegrationId(network), orgId, caps],
      );
      out.push({ id: squatter.id, network, handle: squatter.handle, simulated: true, created: !isLive(squatter), networkEnabled: enabled });
      continue;
    }
    const id = newId();
    await c.query(
      `INSERT INTO social_accounts
         (id, tenant_id, client_id, publisher_org_id, network, handle, display_name, postiz_integration_id, status, quota,
          capabilities, health_checked_at, connected_at, origin_site, simulated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'connected', '{}'::jsonb, $9::jsonb, now(), now(), $10, true)`,
      [id, tenantId, clientId, orgId, network, handle, `${clientName} (simulated ${network})`, simulatedIntegrationId(network), caps, config.originSite],
    );
    out.push({ id, network, handle, simulated: true, created: true, networkEnabled: enabled });
  }
  return out;
}

/** Soft-deletes the client's SIMULATED accounts on `networks`, in the caller's transaction. Only `simulated = true` rows are
 *  ever read or touched (a real account is not found by this statement at all). If ANY of them is referenced by a variant
 *  (any state: the FK holds a soft-deleted one too) nothing is removed and the answer is 409 `simulated_account_in_use` with
 *  the account ids: unschedule or remove those posts' variants first, or use the later purge script. Allowed while the
 *  switch is OFF (that is when teardown happens), so this does not call `assertSimulatedWriteAllowed`. */
export async function removeSimulatedAccounts(
  c: PoolClient, tenantId: string, clientId: string, networks: readonly SimulatedAccountNetwork[],
): Promise<RemovedAccount[]> {
  const { rows } = await c.query<{ id: string; network: string; handle: string; in_use: boolean }>(
    `SELECT a.id, a.network, a.handle,
            EXISTS (SELECT 1 FROM social_post_variants v WHERE v.tenant_id = a.tenant_id AND v.account_id = a.id) AS in_use
       FROM social_accounts a
      WHERE a.tenant_id = $1 AND a.client_id = $2 AND a.simulated = true AND a.deleted_at IS NULL AND a.network = ANY($3::text[])
      ORDER BY a.network, a.id
        FOR UPDATE OF a`,
    [tenantId, clientId, [...networks]],
  );
  const used = rows.filter((r) => r.in_use);
  if (used.length > 0) throw new ConflictException({ message: "simulated_account_in_use", detail: { accountIds: used.map((r) => r.id) } });
  if (rows.length > 0) {
    await c.query(
      `UPDATE social_accounts SET deleted_at = now(), updated_at = now() WHERE tenant_id = $1 AND simulated = true AND id = ANY($2::uuid[])`,
      [tenantId, rows.map((r) => r.id)],
    );
  }
  return rows.map((r) => ({ id: r.id, network: r.network, handle: r.handle }));
}
