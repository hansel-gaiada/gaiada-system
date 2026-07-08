# Phase 0 — Foundations & Walking Skeleton — Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`. TDD throughout. Update `2026-07-05-CHECKLIST.md` after each task.

**Goal:** Stand up the Solo-Viable v1 foundation and prove one message end-to-end (receive → scrub → encrypt PII → persist → reply), with the **day-one gate** (crypto-shred + ingestion scrubber) built and verified — so Phase 1 can safely ingest real messages.

**Architecture:** Node.js + TypeScript monorepo. Managed Postgres + Redis. A lean **Gateway** service holds all AI-provider keys. **OpenBao** on an isolated VPS provides envelope-encryption keys. WAHA provides WhatsApp. No provider keys or identity assertions leave their owners.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Drizzle (migrations), `pg`, BullMQ, WAHA, OpenBao (Vault API), Anthropic + Google Gemini SDKs (Gateway only).

## Global Constraints (verbatim from specs)

- No provider keys outside the Gateway (D8). PII fields + media encrypted via `KDF(subject_KEK, entity_KEK)` (day-one). RLS keys on `app.current_tenant_ids` (uuid[]); no BYPASSRLS on app roles (D5). Ingestion scrubber redacts PAN/KTP before persist, on text and media-derived text (day-one). Bot never asserts identity (D4). Every drop/redaction is logged (no silent failure).

---

### Task 0.1 — Repo scaffold

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.github/workflows/ci.yml`, `packages/` (empty workspaces: `core`, `crypto`, `scrub`, `gateway`, `wa`, `app`), `.env.example`.

- [ ] Step 1: `pnpm init`; add workspaces `packages/*`; add `typescript`, `vitest`, `tsx`, `eslint`, `prettier` as dev deps.
- [ ] Step 2: `tsconfig.base.json` with `strict: true`, `moduleResolution: "bundler"`, `target: ES2022`.
- [ ] Step 3: `vitest.config.ts` (node env, coverage). Add root scripts: `test`, `lint`, `typecheck`, `build`.
- [ ] Step 4: CI workflow runs `pnpm install`, `typecheck`, `lint`, `test` on push.
- [ ] Step 5: Commit — `chore: repo scaffold (ts monorepo + vitest + ci)`.

---

### Task 0.2 — Managed Postgres + Redis + migration tooling

**Files:** Create `packages/core/src/db.ts`, `drizzle.config.ts`, `packages/core/migrations/`.

- [ ] Step 1: Provision a managed Postgres (Neon/Supabase) + Redis (Upstash/managed); put URLs in `.env` (and `.env.example` with placeholders). **Not committed.**
- [ ] Step 2: `packages/core/src/db.ts` exports a `pg` Pool + Drizzle client reading `DATABASE_URL`.
- [ ] Step 3: Add a health check: `pnpm --filter core exec tsx src/db.ts` prints `SELECT 1`.
- [ ] Step 4: Commit — `feat(core): db + redis connection + drizzle config`.

**Produces:** `db` (Drizzle client), `pool` (pg Pool).

---

### Task 0.3 — Base schema + RLS (authorized-tenant-set)

**Files:** Create `packages/core/migrations/0001_base.sql`, `packages/core/src/schema.ts`, `packages/core/test/rls.test.ts`.

**Interfaces — Produces:** tables `companies`, `groups`, `messages`, `schedule_state`; RLS helper `withTenant(client, tenantIds: string[], fn)`.

- [ ] Step 1: Write `rls.test.ts` — insert rows for two tenants; a session set to tenant A's id must not see tenant B's rows; a session set to `{A,B}` sees both.

```ts
it("RLS isolates by authorized-tenant-set", async () => {
  await seed({ tenantA, tenantB });
  const a = await withTenant(pool, [tenantA], c => c.query("select id from messages"));
  expect(a.rows.every(r => r.tenant_id === tenantA)).toBe(true);
  const both = await withTenant(pool, [tenantA, tenantB], c => c.query("select count(*) from messages"));
  expect(Number(both.rows[0].count)).toBe(2);
});
```

- [ ] Step 2: Run — `pnpm --filter core test rls` → FAIL (no tables/policy).
- [ ] Step 3: Migration `0001_base.sql`: tables with `id uuid pk`, `tenant_id uuid`, `origin_site text`, timestamps, `deleted_at`. Enable RLS; policy `USING (tenant_id = ANY(current_setting('app.current_tenant_ids', true)::uuid[]))`. App role has NO BYPASSRLS.
- [ ] Step 4: `withTenant` sets `SET LOCAL app.current_tenant_ids = '{...}'` inside a transaction, runs `fn`, commits.
- [ ] Step 5: Run test → PASS. Commit — `feat(core): base schema + authorized-tenant-set RLS`.

---

### Task 0.4 — Key custody (OpenBao on isolated VPS)

**Files:** Create `packages/crypto/src/kms.ts`, `docs/runbooks/key-custody.md`.

- [ ] Step 1: Provision an isolated VPS (no app/DB). Install OpenBao; enable the `transit` secrets engine. TLS + mTLS client cert for the app.
- [ ] Step 2: Configure Shamir unseal (e.g. 3-of-5); store shares + a raft snapshot **encrypted, off-box** (documented in `key-custody.md`); document M-of-N break-glass.
- [ ] Step 3: `kms.ts` exports a `Kms` client (OpenBao transit): `createKey(id)`, `deleteKey(id)` (the shred primitive), `deriveDataKey(subjectKeyId, entityKeyId)`, `hmac(keyId, value)`.
- [ ] Step 4: Smoke test: create a key, HMAC a value, delete the key. Commit — `feat(crypto): openbao transit kms client + custody runbook`.

**Produces:** `Kms` with `createKey/deleteKey/deriveDataKey/hmac`.

---

### Task 0.5 — Crypto-shred field encryption

**Files:** Create `packages/crypto/src/envelope.ts`, `packages/crypto/test/envelope.test.ts`.

**Interfaces — Produces:** `encryptField(subjectId, entityId, plaintext): Promise<Ciphertext>`, `decryptField(ct): Promise<string>`, `pseudonym(subjectId, value): Promise<string>` (HMAC), where `Ciphertext = { wrapped: string, subjectKeyId, entityKeyId, alg }`.

- [ ] Step 1: Write `envelope.test.ts`:

```ts
it("round-trips, and is unrecoverable after key destruction (crypto-shred)", async () => {
  const ct = await encryptField(subjectId, entityId, "secret@x.com");
  expect(await decryptField(ct)).toBe("secret@x.com");
  await kms.deleteKey(subjectKeyId(subjectId));         // shred the subject
  await expect(decryptField(ct)).rejects.toThrow();      // now permanently unreadable
});
it("pseudonym is stable for equality lookup", async () => {
  expect(await pseudonym(subjectId, "+62811")).toEqual(await pseudonym(subjectId, "+62811"));
});
```

- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement: DEK = `deriveDataKey(KDF(subject_KEK, entity_KEK))`; AES-256-GCM encrypt; store wrapped DEK + key ids. `decryptField` unwraps via KMS (throws if either KEK destroyed). `pseudonym` = KMS HMAC.
- [ ] Step 4: Run → PASS. Commit — `feat(crypto): two-axis envelope encryption + crypto-shred + hmac pseudonym`.

---

### Task 0.6 — Ingestion scrubber (PAN/KTP)

**Files:** Create `packages/scrub/src/scrub.ts`, `packages/scrub/src/patterns.ts`, `packages/scrub/test/scrub.test.ts`.

**Interfaces — Produces:** `scrub(text: string): { clean: string, redactions: Redaction[] }`, `Redaction = { type: 'PAN'|'KTP'|'PASSPORT', at: number }`. Pattern registry is pluggable.

- [ ] Step 1: Write `scrub.test.ts`:

```ts
it("redacts a Luhn-valid PAN, keeps invalid digit runs", () => {
  const r = scrub("pay to 4111 1111 1111 1111 today");
  expect(r.clean).toBe("pay to [REDACTED-CARD] today");
  expect(r.redactions[0].type).toBe("PAN");
  expect(scrub("order 1234567890123456").clean).toContain("1234567890123456"); // not Luhn-valid
});
it("redacts an Indonesian KTP (16-digit NIK)", () => {
  expect(scrub("NIK 3174012345678901").clean).toContain("[REDACTED-ID]");
});
```

- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement Luhn check + card regex → `[REDACTED-CARD]`; KTP/passport patterns → `[REDACTED-ID]`; return redactions (no raw values). Pluggable `patterns.ts`.
- [ ] Step 4: Run → PASS. Commit — `feat(scrub): luhn PAN + KTP/passport ingestion scrubber (redact-before-persist)`.

---

### Task 0.7 — Lean Gateway service

**Files:** Create `packages/gateway/src/index.ts` (HTTP service), `packages/gateway/src/providers.ts`, `packages/gateway/src/dlp.ts`, `packages/gateway/test/gateway.test.ts`.

**Interfaces — Produces:** HTTP `POST /chat` and `POST /summarize` (`{messages|text, opts}` → `{text}`); a client `gatewayChat(...)`, `gatewaySummarize(...)` in `packages/core`. Provider chain config-driven (`[claude, gemini]`). Keys read from env **in this service only**.

- [ ] Step 1: Write a contract test with a **fake provider** (no network): `/summarize` returns provider text; on provider error, fails over to the next; DLP redacts before the (fake) egress and blocks if the classifier throws (fail-closed).
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement Fastify service; `providers.ts` ordered chain with try/next + typed failure; `dlp.ts` runs `scrub` + a fail-closed hook before egress; keys only here. Add the `core` client wrappers.
- [ ] Step 4: Run → PASS. Commit — `feat(gateway): lean provider-routed gateway w/ fail-closed dlp + failover`.

---

### Task 0.8 — WhatsApp gateway (WAHA) connection

**Files:** Create `packages/wa/src/gateway.ts` (interface + WAHA adapter), `packages/app/src/webhook.ts`, `packages/wa/test/normalize.test.ts`.

**Interfaces — Produces:** `WhatsAppGateway { onMessage(cb), sendMessage(chatId, text), listGroups() }`; `normalize(wahaEvent): InboundMessage` where `InboundMessage = { chatId, senderId, senderName, waMessageId, ts, text, type, media? }`.

- [ ] Step 1: Run WAHA (Docker) with an **aged, warmed** number; scan QR; confirm session.
- [ ] Step 2: Write `normalize.test.ts` — a sample WAHA webhook payload maps to `InboundMessage` (fixture, no network).
- [ ] Step 3: Run → FAIL. Implement `normalize` + the WAHA adapter (REST + webhook). `webhook.ts` (Fastify) receives WAHA events → `onMessage`.
- [ ] Step 4: Run → PASS. Commit — `feat(wa): WhatsAppGateway interface + WAHA adapter + webhook receiver`.

---

### Task 0.9 — Walking skeleton (end-to-end)

**Files:** Create `packages/app/src/skeleton.ts`, `packages/app/test/skeleton.e2e.test.ts`.

**Interfaces — Consumes:** `normalize`, `scrub`, `encryptField`, `db`, `WhatsAppGateway`, `gatewayChat`.

- [ ] Step 1: Write `skeleton.e2e.test.ts` (fake WA gateway + fake Gateway): an inbound message with a PAN → the persisted `messages.text` is scrubbed; PII sender field is stored encrypted (not plaintext); a reply is sent via the WA gateway.

```ts
it("message → scrub → encrypt PII → persist → reply", async () => {
  await handleInbound(sample("card 4111111111111111"));
  const row = await db.query.messages.findFirst();
  expect(row.text).toContain("[REDACTED-CARD]");
  expect(row.sender_enc).not.toContain(sample().senderName); // encrypted
  expect(fakeWa.sent).toHaveLength(1);
});
```

- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement `handleInbound`: normalize → scrub text → encrypt PII fields (sender) + store pseudonym → persist → send an ack reply via `gatewayChat` (or a fixed reply). Wire `webhook.ts` → `handleInbound`.
- [ ] Step 4: Run → PASS. Manually send a real WhatsApp message; confirm a reply + a scrubbed, encrypted DB row.
- [ ] Step 5: Commit — `feat(app): walking skeleton — inbound → scrub → encrypt → persist → reply`.

---

### Task 0.10 — Day-one gate verification drill

**Files:** Create `docs/runbooks/erasure-divestiture.md`, `packages/crypto/test/shred-restore.drill.test.ts`.

- [ ] Step 1: Write the drill test: encrypt a record, take a DB snapshot/backup, destroy the subject KEK, restore the snapshot into a fresh schema, assert the restored ciphertext **cannot** be decrypted.
- [ ] Step 2: Run → PASS (proves crypto-shred survives restore).
- [ ] Step 3: Write `erasure-divestiture.md`: per-subject erasure = destroy `subject_KEK` + tombstone HMAC index + audit; per-entity divestiture = destroy `entity_KEK`.
- [ ] Step 4: Tick the day-one gate items in `2026-07-05-CHECKLIST.md`. Commit — `test(crypto): day-one shred-survives-restore drill + erasure runbook`.

---

## Self-review notes
- Covers day-one spec (crypto-shred + scrubber), D5 (RLS set), D8 (keys in Gateway), D4 (no identity assertion — enforced in Phase 1), walking-skeleton (D1). Compliance gate items G.1–G.3, G.6 are **process/legal**, tracked in the checklist, not code tasks.
- **Do not ingest real group messages until Phase 0.10 + checklist G-items are green.**
