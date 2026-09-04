# Runbook — Credential Vault Rotation (VLT-5)

**Implements:** VLT-5, `docs/plans/2026-09-04-client-hosting-credential-vault.md` §3. Covers the
`integration_connections` vault (`platform-nest/migrations/0033_integration_connections.sql`) once
it carries client hosting credentials (VLT-1/VLT-4), not only OAuth tokens.

**Status:** PLANNED — this runbook has not yet been executed end-to-end against a real or realistic
site (VLT-5's own acceptance criterion: "a runbook nobody has executed is not DEV-VERIFIED"). Do not
report VLT-5 as DEV-VERIFIED until someone has run §1 against a real target and confirmed the OLD
credential stops authenticating afterward.

There are **two different things people will call "rotating a credential" here, and only one of
them is possible today.** Read §2 before touching `INTEGRATION_TOKEN_KEY` under any circumstance.

---

## 0 · The RLS trap — read this before running ANY query below

Every read or write against `integration_connections` (and every other CORE/module table in this
schema) needs **BOTH** of these set in the same transaction, or Postgres silently returns/affects
**ZERO ROWS with NO ERROR** — not a permission denial, not an empty-result warning, just nothing:

- the tenant GUC: `app.current_tenant_ids`
- the module-scope GUC: `app.scopes` (CORE tables like this one don't strictly require it, but get
  in the habit — module-owned tables compose `app_module_allowed()` into their policy and fail the
  same way)

`platform-nest`'s own service layer (`withTenants([tenantId], fn, { modules: [...] })`,
`src/db/index.ts`) sets both correctly for you. **The trap is anyone who reaches for a raw `psql`
session or a one-off script** — a manual `SELECT * FROM integration_connections WHERE ...` from a
bare superuser or `platform_owner` connection with neither GUC set will "confirm" a row is gone, or
that a rotation succeeded, when it actually just read nothing. `platform-nest/CLAUDE.md`'s own
history records this exact failure producing a false "the estate is clean" conclusion that was then
used to justify a real decision — treat every zero-row result from a manual query as "did I set both
GUCs" before "is the data actually gone."

If you must query directly, set both explicitly first:

```sql
SELECT set_config('app.current_tenant_ids', '<tenant-uuid>', true);
SELECT set_config('app.scopes', '', true);  -- CORE table: empty is fine, but set it
```

(`true` = `SET LOCAL`, scoped to the current transaction — `false`/omitted is a no-op outside an
explicit transaction block; open one with `BEGIN;` first if you are not already inside one.)

---

## 1 · Rotating a STORED credential (the per-site deploy principal) — possible TODAY

This is the common case: a per-site FTP/SSH user or WordPress application password that we
provisioned ourselves (the custody model this vault assumes — §1 of the parent plan, option (c)).
Rotating it needs **no client involvement**, because we minted it in the first place.

**Who may do this:** ops/staff with panel access to the target host, driving
`setConnectionTokens` through a Cerbos-authorized session (or the reveal path, VLT-3, if you need to
confirm the OLD value before revoking it — see §3). Never a client; this is a staff-side operation
end to end.

**What is audited:** every step below that touches the row emits an `integration_connection.*` event
through the existing outbox (`integrations.service.ts`'s `emitEvent` calls) — `linked` on the reseal,
`revoked` if you soft-revoke instead of replacing in place. If VLT-3 (the reveal path) ships before
you run this, a reveal used to confirm the old credential also writes exactly one audit row per use.
There is no separate "rotation" event type in this set — the ordinary connection lifecycle events are
the audit trail.

### Steps

0. *(First time a given credential moves off `CREDENTIALS.local.md` — VLT-4, not a rotation, but the
   same checklist applies before you ever touch that row again):*
   - [ ] Run `scripts/vault-import-hosting-credentials.local.mjs --batch <file>` in dry-run first,
     confirm the plan looks right (right tenant, right owner, right provider — never a secret value,
     the dry-run output never contains one), then re-run with `--apply`.
   - [ ] Confirm the imported row's `hasToken` reads `true` (the script's own post-write check
     already does this, but confirm again independently if this is a high-value credential).
   - [ ] **Delete the corresponding entry from `CREDENTIALS.local.md` now.** Not "later" — now, in
     the same sitting. The import is not complete until this line is gone; until then the laptop is
     still the system of record and the vault write is a second, unsynchronized copy, not a
     replacement.
1. **Identify the row.** `listConnections(tenantId, { provider, ownerId, ownerKind })` or a direct
   query (with both GUCs set, §0) to find the `integration_connections.id` for the site's deploy
   principal. Cross-reference `webdev_sites.vault_ref` if VLT-2 has landed — that column should
   already point here.
2. **Mint the NEW credential on the target host FIRST, before touching anything else.** Create (do
   not overwrite) a new scoped FTP/SSH user or WP application password, scoped to the same one
   document root as the credential it will replace. Creating the new one before revoking the old one
   means there is never a window where neither works.
3. **Confirm the new credential authenticates**, out of band (a manual FTP/SSH/WP-REST login attempt
   against the target host) — before it goes anywhere near the vault. A credential that doesn't
   authenticate is not safe to seal and forget.
4. **Reseal the row** via `setConnectionTokens(tenantId, id, { accessToken: <new credential>, ... })`
   (`platform-nest/src/core/integrations.service.ts:249`). This is the exact same tested vault-write
   path VLT-4's import uses — nothing new to build. It sets `status='linked'` and stamps
   `token_key_version` to the current `TOKEN_KEY_VERSION` automatically; you do not set that field
   yourself.
5. **Confirm a real deploy succeeds with the new credential** — drive the actual site deploy path (or
   the reveal path, VLT-3, followed by a manual out-of-band login) end to end. Do not skip this: a
   sealed value that fails to decrypt, or that was mistyped before sealing, looks identical to a
   healthy row from every list/read endpoint (`hasToken: true` either way).
6. **Revoke the OLD credential on the host** — delete the old FTP/SSH user, or deactivate the old WP
   application password. This is the step that actually closes the exposure; steps 1–5 alone leave
   the old credential live even though the vault no longer holds it.
7. **Confirm the OLD credential no longer authenticates** — attempt to use it (out of band) and
   confirm the host refuses it. This is VLT-5's own acceptance bar: a rotation nobody confirmed dead
   is not a rotation.

### If you'd rather not overwrite the row in place

`revokeConnection(tenantId, id)` (`integrations.service.ts:220`) soft-revokes — `status='revoked'`,
every token column NULLed, row kept — and a later `createConnection` upsert on the same
`(tenant_id, owner_kind, owner_id, provider)` re-links it. Use this if you want an explicit "this
credential is dead" state visible in the row's history rather than a silent overwrite; either path
ends at the same place.

---

## 2 · Rotating `INTEGRATION_TOKEN_KEY` itself — NOT POSSIBLE without data loss. Do not attempt it.

**State this plainly, because a runbook that implies a broken procedure works is worse than no
runbook:** there is currently no way to rotate `INTEGRATION_TOKEN_KEY` and keep the existing sealed
rows readable. If you swap the key, every row already sealed under the old key becomes permanently
undecryptable — full stop, no fallback.

### Why

`platform-nest/src/core/secret-box.ts`'s `decryptSecret()` (lines 87–107) calls `loadKey()`
unconditionally, which resolves the **single current** `INTEGRATION_TOKEN_KEY` from the environment.
`token_key_version` is written on every seal (`TOKEN_KEY_VERSION = "v1"`, `secret-box.ts:27`,
stamped by `integrations.service.ts:259,266`) but **nothing reads that column back** to select
between multiple keys. The column exists so a future key can be identified — it does not, today,
let one coexist with rows sealed under a previous key. Swap the key, and the very next decrypt
attempt on an old row fails its GCM auth-tag check (tamper-evident by design; it fails closed, it
does not return garbage plaintext) — there is no key B to fall back to.

This is a deliberate, recorded decision, not an oversight: **OQ-2.6.b, ruled 2026-09-04** ("use the
current key for now" — `docs/blueprints/webdesk-design-v2.md` §14, WSK-D33) accepted env-key custody
explicitly and named rotation's absence as the cost of that acceptance. `platform-nest/src/core/
token-key-tripwire.ts` exists precisely because this gap is real: it turns an accidental key change
into a boot-time refusal instead of a silent, delayed credential failure (see its own header for the
mechanism). **The tripwire firing is not a bug to work around by "just rotating past it" — it is
telling you the truth: this key does not match the one your existing rows need.**

### What would have to be built before this is possible

1. **Multi-key lookup in `secret-box.ts`**, keyed on `token_key_version` — `decryptSecret()` would
   need to accept (or look up) which key version sealed a given row and resolve the matching key,
   instead of always resolving "the current one."
2. **A re-encryption pass** — a job that reads every row still sealed under the retiring key version,
   decrypts under the old key, re-encrypts under the new one, and stamps the new
   `token_key_version` — run to completion (with retry/resume, since ~78 clients' hosting rows plus
   every OAuth token in the table is not a single-transaction job) before the old key is ever removed
   from the environment.
3. Only once both of those exist does "set a new `INTEGRATION_TOKEN_KEY`" become a safe operation
   instead of a data-loss event.

None of this is built. If a real incident (§4) forces the question — a suspected leak of
`INTEGRATION_TOKEN_KEY` itself, as opposed to one stored credential — the only currently-safe path is
**per-row rotation of every affected credential (§1), not a key swap.** A leaked vault key with no
rotation path is exactly the exposure OpenBao/KMS transit-key rotation is designed to close; that
work is out of scope here (§5 of the parent plan) and would need its own ticket.

**Do not "try it and see."** If you are tempted to change `INTEGRATION_TOKEN_KEY` on a box carrying
real sealed rows for any reason short of a full re-encryption pass already having run: don't. The
tripwire will refuse the next boot if you do, and that refusal is correct — restore the previous key
value and stop.

---

## 3 · Emergency revocation — suspected compromise or client offboarding

**Who may do this:** any staff member with Cerbos `integration_connection.delete`/`manage` on the
affected row, immediately — this is deliberately not gated behind an approval flow, because the
whole point is speed. Escalate to whoever owns the client relationship after the fact, not before.

**What is audited:** `revokeConnection`'s `integration_connection.revoked` event (§1 above), same as
an ordinary rotation. If a suspected compromise means you need to know what was exposed rather than
just shut it off, VLT-3's reveal-path audit rows (one per reveal, `who/when/which connection/which
grant`) are the record of who could have seen the plaintext before the revoke — check those, not the
connection's own event log, for that question.

### Steps — suspected compromise (e.g. a laptop with `CREDENTIALS.local.md` access is stolen, an
### assistant transcript pasted a credential, a host is reported breached)

1. **Revoke on the HOST first, then in the vault** — the reverse order of §1's rotation (there, the
   new credential must exist before the old one dies; here, the compromised credential must die
   before anything else, even if that means the site is briefly undeployable). Delete/deactivate the
   credential on the target host immediately.
2. `revokeConnection(tenantId, id)` — soft-revoke the row (§1's "if you'd rather not overwrite"
   path). Do not silently overwrite with a new credential in the same step; revoke first, mint and
   reseal as a separate, deliberate §1 rotation once you've confirmed the scope of the compromise.
3. Check every OTHER row sharing the same host/panel — a compromised cPanel/hPanel master login (the
   custody model this vault exists to avoid holding, per the parent plan's §1) can affect every
   scoped principal provisioned under it. If the panel itself was compromised, revoke and re-provision
   every deploy principal on that panel, not just the one row that triggered the investigation.
4. Confirm on the host that the revoked credential no longer authenticates (same discipline as §1
   step 7).

### Steps — client offboarding

1. `revokeConnection(tenantId, id)` for every hosting-credential row owned by that client
   (`owner_kind='client', owner_id=<clients.id>`).
2. Delete/deactivate every corresponding deploy principal on the host(s) — the row being revoked in
   our vault does not, by itself, do anything to the credential's standing on the client's actual
   panel.
3. If we do not also own the panel access that let us create scoped principals in the first place
   (the one-time setup step VLT-1/VLT-4's custody model requires — parent plan §1(c)), note in the
   offboarding ticket that our ability to revoke on the host ends when that access is handed back.

---

## 4 · Summary — who may do what, and what is audited

| Action | Who | Audit trail |
|---|---|---|
| Rotate a stored deploy credential (§1) | Staff with host panel access + `integration_connection` write/manage authz | `integration_connection.linked` (reseal) or `.revoked`+`.created` (soft-revoke + re-link) event per change |
| Rotate `INTEGRATION_TOKEN_KEY` (§2) | **Nobody, today** — not possible without a re-encryption pass that does not exist yet | N/A — do not attempt |
| Emergency revoke, suspected compromise (§3) | Any staff with delete/manage authz, immediately, no approval gate | `integration_connection.revoked` event; VLT-3 reveal audit rows (once shipped) for "who saw it before revoke" |
| Emergency revoke, client offboarding (§3) | Staff closing the client relationship | Same `.revoked` event, one per row |
| Reading a credential's plaintext to verify it (VLT-3, once shipped) | Cerbos-gated, WS4-approved, single-use, TTL'd grant — never self-approved | Exactly one audit row per successful reveal |

---

## Appendix — files this runbook is grounded in

- `platform-nest/migrations/0033_integration_connections.sql`
- `platform-nest/src/core/secret-box.ts`
- `platform-nest/src/core/integrations.service.ts` (`setConnectionTokens`, `createConnection`,
  `revokeConnection`)
- `platform-nest/src/core/token-key-tripwire.ts`
- `docs/plans/2026-09-04-client-hosting-credential-vault.md`
- `docs/blueprints/webdesk-design-v2.md` §14 (WSK-D33)
- `scripts/vault-import-hosting-credentials.local.mjs` (VLT-4 — the one-time import this vault's
  hosting-credential rows come from; its own header repeats the "delete the laptop copy after" step
  this runbook does not duplicate in full)
