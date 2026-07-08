# Action Agent — Phase A: Safety Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four safety primitives every mutating action will depend on — idempotency, retrying outbound delivery, append-only audit, and rate-limit + kill-switch — before any action exists.

**Architecture:** New `src/safety/` module holds four focused, independently-tested units. Each has an in-memory default so dev/tests need no Redis, and a Redis-backed path (mirroring `media-queue.ts`) that activates when `REDIS_URL` is set. Inbound dedup wires into the existing `handleInbound`; the retrying send wraps the existing gateway `sendText` calls in `bot.ts` and `server.ts`.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Fastify, BullMQ (already a dependency), vitest. No new runtime dependencies.

## Global Constraints

- Language/module: TypeScript ESM; `.js`-less relative imports as in the existing codebase (e.g. `from "./config"`). Semicolons, 2-space indent, double quotes — match existing files.
- Test runner: `vitest run`; test files are `src/<name>.test.ts` colocated with source.
- No new npm dependencies (BullMQ, pg, fastify already present).
- Bot holds no provider/model keys and never asserts identity — unchanged by this phase.
- Audit records must be PII-safe: run any free text through the existing `scrub()` before persisting, and never store raw sender ids — store a stable hash.
- Redis is optional: every unit MUST work with `REDIS_URL` unset (in-memory fallback), matching `media-queue.ts` (`queueEnabled()` gate).
- All new config goes in `src/config.ts` with `process.env.X ?? default` defaults.

---

### Task 1: Kill-switch

**Files:**
- Create: `wa-chat-bot/src/safety/kill-switch.ts`
- Create: `wa-chat-bot/src/safety/kill-switch.test.ts`
- Modify: `wa-chat-bot/src/config.ts` (add `actionsEnabled` default)

**Interfaces:**
- Produces: `actionsEnabled(): boolean`, `setActionsEnabled(on: boolean): void`, `killSwitchMessage(): string`. Runtime toggle overrides the env default; when off, `actionsEnabled()` returns `false`.

- [ ] **Step 1: Add config default**

In `wa-chat-bot/src/config.ts`, add inside the `config` object (after the `tenantId` line):

```ts
  // Action kill-switch: master enable for all mutating actions. A runtime toggle
  // (setActionsEnabled) overrides this without a redeploy; env sets the boot default.
  actionsEnabledDefault: (process.env.ACTIONS_ENABLED ?? "true").toLowerCase() !== "false",
```

- [ ] **Step 2: Write the failing test**

`wa-chat-bot/src/safety/kill-switch.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { actionsEnabled, setActionsEnabled, killSwitchMessage } from "./kill-switch";

describe("kill-switch", () => {
  beforeEach(() => setActionsEnabled(true));

  it("defaults to enabled", () => {
    expect(actionsEnabled()).toBe(true);
  });

  it("runtime toggle disables all actions", () => {
    setActionsEnabled(false);
    expect(actionsEnabled()).toBe(false);
  });

  it("re-enabling restores actions", () => {
    setActionsEnabled(false);
    setActionsEnabled(true);
    expect(actionsEnabled()).toBe(true);
  });

  it("provides a user-facing message when off", () => {
    expect(killSwitchMessage()).toMatch(/temporarily disabled/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd wa-chat-bot && npx vitest run src/safety/kill-switch.test.ts`
Expected: FAIL — cannot find module `./kill-switch`.

- [ ] **Step 4: Write minimal implementation**

`wa-chat-bot/src/safety/kill-switch.ts`:

```ts
// Global action kill-switch. `actionsEnabled()` is checked before every mutating
// action executes; flipping the runtime toggle fail-closes all writes with no redeploy.
import { config } from "../config";

let enabled = config.actionsEnabledDefault;

export function actionsEnabled(): boolean {
  return enabled;
}

export function setActionsEnabled(on: boolean): void {
  enabled = on;
}

export function killSwitchMessage(): string {
  return "Actions are temporarily disabled. Reading and Q&A still work — please try again later.";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd wa-chat-bot && npx vitest run src/safety/kill-switch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add wa-chat-bot/src/safety/kill-switch.ts wa-chat-bot/src/safety/kill-switch.test.ts wa-chat-bot/src/config.ts
git commit -m "feat(bot): action kill-switch (env default + runtime toggle)"
```

---

### Task 2: Rate limiter (token bucket)

**Files:**
- Create: `wa-chat-bot/src/safety/rate-limit.ts`
- Create: `wa-chat-bot/src/safety/rate-limit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `checkRate(key: string, opts: { capacity: number; refillPerSec: number; now?: number }): { allowed: boolean; retryAfterMs: number }`. In-memory bucket keyed by `key`; `now` (ms) is injectable for deterministic tests. `resetRateLimiter(): void` clears all buckets (test hook).

- [ ] **Step 1: Write the failing test**

`wa-chat-bot/src/safety/rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { checkRate, resetRateLimiter } from "./rate-limit";

describe("rate-limit (token bucket)", () => {
  beforeEach(() => resetRateLimiter());

  it("allows up to capacity, then blocks", () => {
    const opts = { capacity: 2, refillPerSec: 0, now: 1000 };
    expect(checkRate("u1", opts).allowed).toBe(true);
    expect(checkRate("u1", opts).allowed).toBe(true);
    const third = checkRate("u1", opts);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const base = { capacity: 1, refillPerSec: 1 };
    expect(checkRate("u2", { ...base, now: 0 }).allowed).toBe(true);
    expect(checkRate("u2", { ...base, now: 0 }).allowed).toBe(false);
    // 1s later one token has refilled
    expect(checkRate("u2", { ...base, now: 1000 }).allowed).toBe(true);
  });

  it("keys are independent", () => {
    const opts = { capacity: 1, refillPerSec: 0, now: 5 };
    expect(checkRate("a", opts).allowed).toBe(true);
    expect(checkRate("b", opts).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd wa-chat-bot && npx vitest run src/safety/rate-limit.test.ts`
Expected: FAIL — cannot find module `./rate-limit`.

- [ ] **Step 3: Write minimal implementation**

`wa-chat-bot/src/safety/rate-limit.ts`:

```ts
// Per-key token-bucket rate limiter. In-memory (per process) — sufficient for a
// single bot instance; a Redis-backed variant can replace the map when horizontal
// scaling arrives. `now` is injectable so tests are deterministic.
interface Bucket {
  tokens: number;
  lastMs: number;
}

const buckets = new Map<string, Bucket>();

export function resetRateLimiter(): void {
  buckets.clear();
}

export function checkRate(
  key: string,
  opts: { capacity: number; refillPerSec: number; now?: number },
): { allowed: boolean; retryAfterMs: number } {
  const now = opts.now ?? Date.now();
  const b = buckets.get(key) ?? { tokens: opts.capacity, lastMs: now };
  const elapsedSec = Math.max(0, (now - b.lastMs) / 1000);
  b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec);
  b.lastMs = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return { allowed: true, retryAfterMs: 0 };
  }
  buckets.set(key, b);
  const deficit = 1 - b.tokens;
  const retryAfterMs = opts.refillPerSec > 0 ? Math.ceil((deficit / opts.refillPerSec) * 1000) : 60000;
  return { allowed: false, retryAfterMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd wa-chat-bot && npx vitest run src/safety/rate-limit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add wa-chat-bot/src/safety/rate-limit.ts wa-chat-bot/src/safety/rate-limit.test.ts
git commit -m "feat(bot): per-key token-bucket rate limiter"
```

---

### Task 3: Inbound idempotency (dedup) + wire into handleInbound

**Files:**
- Create: `wa-chat-bot/src/safety/dedup.ts`
- Create: `wa-chat-bot/src/safety/dedup.test.ts`
- Modify: `wa-chat-bot/src/bot.ts` (guard at top of `handleInbound`)

**Interfaces:**
- Consumes: nothing.
- Produces: `seenBefore(key: string, now?: number): boolean` — returns `true` if `key` was seen within the TTL window (and records unseen keys as now-seen). `dedupKey(surface: string, eventId: string): string`. `resetDedup(): void` (test hook). TTL default 24h; `now` injectable.

- [ ] **Step 1: Write the failing test**

`wa-chat-bot/src/safety/dedup.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { seenBefore, dedupKey, resetDedup } from "./dedup";

describe("inbound dedup", () => {
  beforeEach(() => resetDedup());

  it("first sighting is unseen, second is seen", () => {
    const k = dedupKey("whatsapp", "MSG1");
    expect(seenBefore(k)).toBe(false);
    expect(seenBefore(k)).toBe(true);
  });

  it("distinct keys are independent", () => {
    expect(seenBefore(dedupKey("whatsapp", "A"))).toBe(false);
    expect(seenBefore(dedupKey("telegram", "A"))).toBe(false);
  });

  it("entries expire after the TTL window", () => {
    const k = dedupKey("whatsapp", "OLD");
    expect(seenBefore(k, 0)).toBe(false);
    // 25h later the key has expired and reads as unseen again
    expect(seenBefore(k, 25 * 60 * 60 * 1000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd wa-chat-bot && npx vitest run src/safety/dedup.test.ts`
Expected: FAIL — cannot find module `./dedup`.

- [ ] **Step 3: Write minimal implementation**

`wa-chat-bot/src/safety/dedup.ts`:

```ts
// Inbound idempotency: a webhook redelivery must never be processed twice. In-memory
// TTL set (per process); with Redis this becomes SET NX EX. Keyed by (surface,eventId).
const TTL_MS = 24 * 60 * 60 * 1000;
const seen = new Map<string, number>(); // key -> expiry ms

export function resetDedup(): void {
  seen.clear();
}

export function dedupKey(surface: string, eventId: string): string {
  return `${surface}:${eventId}`;
}

/** Returns true if this key was already seen within the TTL; records unseen keys. */
export function seenBefore(key: string, now: number = Date.now()): boolean {
  // opportunistic sweep so the map can't grow unbounded
  if (seen.size > 10000) {
    for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
  }
  const exp = seen.get(key);
  if (exp !== undefined && exp > now) return true;
  seen.set(key, now + TTL_MS);
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd wa-chat-bot && npx vitest run src/safety/dedup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire dedup into handleInbound**

In `wa-chat-bot/src/bot.ts`, add the import near the other imports:

```ts
import { seenBefore, dedupKey } from "./safety/dedup";
```

Then in `handleInbound`, immediately after the `if (inbound.fromMe) return;` line, add:

```ts
  // Idempotency: drop webhook redeliveries so nothing is stored or answered twice.
  const surface = inbound.chatId.startsWith("tg:") ? "telegram" : "whatsapp";
  if (inbound.waMessageId && seenBefore(dedupKey(surface, inbound.waMessageId))) return;
```

- [ ] **Step 6: Add a dedup integration test to bot.test.ts**

Append to `wa-chat-bot/src/bot.test.ts` a test proving a duplicate inbound is dropped. First inspect the top of `bot.test.ts` to reuse its existing fake gateway + message helpers; then add, inside the existing top-level `describe`:

```ts
  it("drops a redelivered message (idempotent): stores + replies once", async () => {
    const sent: string[] = [];
    const gw = { sendText: async (_c: string, t: string) => { sent.push(t); } };
    const msg = {
      chatId: "dm@c.us", senderId: "u@c.us", senderName: "U", waMessageId: "DUP1",
      ts: Date.now(), text: "/ping", isGroup: false, fromMe: false, replyToBot: false, media: null,
    };
    await handleInbound(gw, msg);
    await handleInbound(gw, msg); // redelivery
    expect(sent).toEqual(["pong"]); // replied exactly once
  });
```

If `bot.test.ts` already imports `handleInbound` and a gateway helper, reuse those instead of redefining. Run `cd wa-chat-bot && npx vitest run src/bot.test.ts` — Expected: PASS including the new test. (If a prior test in the file reuses `waMessageId: "DUP1"`, pick a unique id.)

- [ ] **Step 7: Commit**

```bash
git add wa-chat-bot/src/safety/dedup.ts wa-chat-bot/src/safety/dedup.test.ts wa-chat-bot/src/bot.ts wa-chat-bot/src/bot.test.ts
git commit -m "feat(bot): inbound idempotency (dedup webhook redeliveries)"
```

---

### Task 4: Action audit sink (PII-safe, append-only)

**Files:**
- Create: `wa-chat-bot/src/safety/audit.ts`
- Create: `wa-chat-bot/src/safety/audit.test.ts`
- Modify: `wa-chat-bot/src/config.ts` (add `actionAuditFile` default)

**Interfaces:**
- Consumes: `scrub` from `../scrub`.
- Produces:
  - `actorHash(surface: string, externalId: string): string` — stable non-reversible hash (never store raw ids).
  - `recordActionAudit(entry: ActionAuditEntry): Promise<void>` — appends one JSON line; scrubs `argsSummary`.
  - `readActionAudit(limit?: number): Promise<ActionAuditEntry[]>` — reads back (tests + incident review).
  - `type ActionAuditEntry = { ts: number; surface: string; chatId: string; actor: string; action: string; argsSummary: string; decision: "allow" | "deny" | "stepup"; outcome: "done" | "failed" | "blocked"; error?: string }`.

Note: this is the **bot-side** append-only record (JSONL, like `discovery.ts`). The authoritative, RLS-scoped `action_audit` table is added in Phase D alongside the platform write endpoints.

- [ ] **Step 1: Add config default**

In `wa-chat-bot/src/config.ts`, add after the `discoveryFile` line:

```ts
  // Action audit sink (Phase A): append-only JSONL of every mutating-action attempt.
  actionAuditFile: process.env.ACTION_AUDIT_FILE ?? "data/action-audit.jsonl",
```

- [ ] **Step 2: Write the failing test**

`wa-chat-bot/src/safety/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { actorHash, recordActionAudit, readActionAudit } from "./audit";
import { config } from "../config";

describe("action audit", () => {
  beforeEach(() => {
    config.actionAuditFile = "data/action-audit.test.jsonl";
    try { rmSync(config.actionAuditFile); } catch { /* ignore */ }
  });

  it("hashes actors stably and non-reversibly", () => {
    const h = actorHash("whatsapp", "123@c.us");
    expect(h).toEqual(actorHash("whatsapp", "123@c.us"));
    expect(h).not.toContain("123");
    expect(actorHash("telegram", "123@c.us")).not.toEqual(h);
  });

  it("appends and reads back entries", async () => {
    await recordActionAudit({
      ts: 1, surface: "whatsapp", chatId: "g@g.us", actor: actorHash("whatsapp", "u"),
      action: "task.create", argsSummary: "title=x", decision: "allow", outcome: "done",
    });
    const rows = await readActionAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("task.create");
    expect(rows[0].decision).toBe("allow");
  });

  it("scrubs PII from argsSummary before persisting", async () => {
    await recordActionAudit({
      ts: 2, surface: "whatsapp", chatId: "g@g.us", actor: "h",
      action: "note.add", argsSummary: "card 4111 1111 1111 1111", decision: "allow", outcome: "done",
    });
    const rows = await readActionAudit();
    expect(rows[0].argsSummary).not.toContain("4111 1111 1111 1111");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd wa-chat-bot && npx vitest run src/safety/audit.test.ts`
Expected: FAIL — cannot find module `./audit`.

- [ ] **Step 4: Write minimal implementation**

`wa-chat-bot/src/safety/audit.ts`:

```ts
// Append-only, PII-safe audit of every mutating-action attempt. One JSON line per
// entry (like discovery.ts). Actor ids are hashed, never stored raw; free text is scrubbed.
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config";
import { scrub } from "../scrub";

export interface ActionAuditEntry {
  ts: number;
  surface: string;
  chatId: string;
  actor: string;
  action: string;
  argsSummary: string;
  decision: "allow" | "deny" | "stepup";
  outcome: "done" | "failed" | "blocked";
  error?: string;
}

export function actorHash(surface: string, externalId: string): string {
  return createHash("sha256").update(`${surface}|${externalId}`).digest("hex").slice(0, 16);
}

export async function recordActionAudit(entry: ActionAuditEntry): Promise<void> {
  const safe = { ...entry, argsSummary: scrub(entry.argsSummary).clean };
  await mkdir(dirname(config.actionAuditFile), { recursive: true });
  await appendFile(config.actionAuditFile, JSON.stringify(safe) + "\n", "utf8");
}

export async function readActionAudit(limit = 1000): Promise<ActionAuditEntry[]> {
  let raw = "";
  try {
    raw = await readFile(config.actionAuditFile, "utf8");
  } catch {
    return [];
  }
  const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ActionAuditEntry);
  return rows.slice(-limit);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd wa-chat-bot && npx vitest run src/safety/audit.test.ts`
Expected: PASS (3 tests). Confirm `scrub(x).clean` is the correct shape by checking `src/scrub.ts` — if the return field differs, use the actual field name.

- [ ] **Step 6: Commit**

```bash
git add wa-chat-bot/src/safety/audit.ts wa-chat-bot/src/safety/audit.test.ts wa-chat-bot/src/config.ts
git commit -m "feat(bot): append-only PII-safe action audit sink"
```

---

### Task 5: Retrying outbound delivery

**Files:**
- Create: `wa-chat-bot/src/safety/outbound.ts`
- Create: `wa-chat-bot/src/safety/outbound.test.ts`
- Modify: `wa-chat-bot/src/bot.ts` (route the reply send through it)

**Interfaces:**
- Consumes: `WhatsAppGateway` from `../waha`.
- Produces: `sendWithRetry(gw: WhatsAppGateway, chatId: string, text: string, opts?: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<{ ok: boolean; attempts: number; error?: string }>`. Retries transient failures with exponential backoff; `sleep` is injectable so tests don't wait. Never throws — returns a result the caller can audit.

- [ ] **Step 1: Write the failing test**

`wa-chat-bot/src/safety/outbound.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sendWithRetry } from "./outbound";

const noSleep = async () => {};

describe("sendWithRetry", () => {
  it("succeeds on the first try", async () => {
    let calls = 0;
    const gw = { sendText: async () => { calls++; } };
    const r = await sendWithRetry(gw, "c", "hi", { sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries then succeeds", async () => {
    let calls = 0;
    const gw = { sendText: async () => { calls++; if (calls < 3) throw new Error("flaky"); } };
    const r = await sendWithRetry(gw, "c", "hi", { attempts: 3, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it("gives up after all attempts and reports the error (never throws)", async () => {
    const gw = { sendText: async () => { throw new Error("down"); } };
    const r = await sendWithRetry(gw, "c", "hi", { attempts: 2, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.error).toMatch(/down/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd wa-chat-bot && npx vitest run src/safety/outbound.test.ts`
Expected: FAIL — cannot find module `./outbound`.

- [ ] **Step 3: Write minimal implementation**

`wa-chat-bot/src/safety/outbound.ts`:

```ts
// Retrying outbound send. Today's sends are fire-and-forget .catch(log) — a transient
// WAHA/Telegram blip silently drops the reply. This wraps a send with bounded
// exponential backoff and returns an auditable result instead of throwing.
import type { WhatsAppGateway } from "../waha";

export async function sendWithRetry(
  gw: WhatsAppGateway,
  chatId: string,
  text: string,
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      await gw.sendText(chatId, text);
      return { ok: true, attempts: i };
    } catch (err) {
      lastErr = (err as Error).message;
      if (i < attempts) await sleep(baseDelayMs * 2 ** (i - 1));
    }
  }
  return { ok: false, attempts, error: lastErr };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd wa-chat-bot && npx vitest run src/safety/outbound.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Route the bot reply through sendWithRetry**

In `wa-chat-bot/src/bot.ts`, add the import:

```ts
import { sendWithRetry } from "./safety/outbound";
```

Replace the existing reply send line in `handleInbound`:

```ts
  await gw.sendText(inbound.chatId, reply);
```

with:

```ts
  const delivery = await sendWithRetry(gw, inbound.chatId, reply);
  if (!delivery.ok) console.warn(`[bot] reply delivery failed after ${delivery.attempts} attempts: ${delivery.error}`);
```

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `cd wa-chat-bot && npx vitest run`
Expected: all previously-passing tests still pass, plus the new safety tests. (The pre-existing ffmpeg `extract.test.ts` timeout is environment-dependent and unrelated to this phase — note it if it appears, don't fix it here.)

- [ ] **Step 7: Commit**

```bash
git add wa-chat-bot/src/safety/outbound.ts wa-chat-bot/src/safety/outbound.test.ts wa-chat-bot/src/bot.ts
git commit -m "feat(bot): retrying outbound delivery (no more silently-dropped replies)"
```

---

### Task 6: Typecheck gate + phase wrap-up

**Files:**
- Modify: `wa-chat-bot/.env.example` (document new env vars)

- [ ] **Step 1: Document new env vars**

Append to `wa-chat-bot/.env.example`:

```bash
# --- Action safety (Phase A) ---
# Master kill-switch for all mutating actions (runtime toggle overrides this at run time).
ACTIONS_ENABLED=true
# Append-only PII-safe audit of every action attempt.
ACTION_AUDIT_FILE=data/action-audit.jsonl
```

- [ ] **Step 2: Run typecheck**

Run: `cd wa-chat-bot && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 3: Run the full test suite**

Run: `cd wa-chat-bot && npx vitest run`
Expected: all safety tests pass; no new failures vs baseline.

- [ ] **Step 4: Commit**

```bash
git add wa-chat-bot/.env.example
git commit -m "docs(bot): document Phase A action-safety env vars"
```

---

## Self-Review

**Spec coverage (§7.7 Safety layer + §8 Data model):**
- Inbound idempotency → Task 3 ✅
- Outbound delivery (retry) → Task 5 ✅ (Redis-backed BullMQ outbound queue is a scale-path noted for Phase G; in-process retry ships the guarantee now)
- Action audit (append-only, PII-safe) → Task 4 ✅ (authoritative RLS table deferred to Phase D per spec §8)
- Rate limits → Task 2 ✅
- Kill-switch (env + runtime) → Task 1 ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `actionsEnabled`/`setActionsEnabled` (Task 1), `checkRate`/`resetRateLimiter` (Task 2), `seenBefore`/`dedupKey`/`resetDedup` (Task 3), `actorHash`/`recordActionAudit`/`readActionAudit`/`ActionAuditEntry` (Task 4), `sendWithRetry` (Task 5) — names used consistently where referenced.

**Note for executor:** the safety units are wired into the *existing* pipeline where they add immediate value (dedup + retrying send). Rate-limit, kill-switch, and the audit sink are consumed by the **action executor** built in Phase C — they are unit-complete here so Phase C only wires them.
