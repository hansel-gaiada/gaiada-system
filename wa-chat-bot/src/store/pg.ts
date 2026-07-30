// Postgres-backed store (used when DATABASE_URL is set). Keeps crypto-shred: sender
// identity encrypted in a jsonb column. RLS (D5): rows are filtered by the
// authorized-tenant-set in `app.current_tenant_ids`; no setting -> no rows (fail-closed).
// FORCE ROW LEVEL SECURITY applies the policy even to the table owner.
import { Pool, type PoolClient } from "pg";
import { config } from "../config";
import type { Ciphertext } from "../crypto/envelope";
import { encodeSender, decodeSender, encodePayload, decodePayload } from "./encode";
import type { Store, StoredMessage, MediaStatus, ChatSummary, IntakeRecord, IntakeStatus } from "./types";

interface Row {
  chat_id: string;
  sender_enc: Ciphertext | null;
  wa_message_id: string;
  ts: string; // bigint comes back as string
  text: string;
  from_bot: boolean;
  media_mime: string | null;
  media_ref: string | null;
  media_status: MediaStatus | null;
  media_text: string | null;
}

const ROW_COLS = `chat_id, sender_enc, wa_message_id, ts, text, from_bot, media_mime, media_ref, media_status, media_text`;

/** Run `fn` in a transaction whose authorized-tenant-set is `tenantIds` (D5). */
export async function withTenant<T>(
  pool: Pool,
  tenantIds: string[],
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config(..., true) scopes the setting to this transaction only.
    await client.query("SELECT set_config('app.current_tenant_ids', $1, true)", [tenantIds.join(",")]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export class PgStore implements Store {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    // DDL runs as the OWNER (bot_owner) via MIGRATE_DATABASE_URL; the runtime pool stays on the
    // restricted bot_app. In dev (no migrate DSN) this falls back to the runtime pool, where
    // owner==runtime. A short-lived pool keeps ownership of new objects with bot_owner.
    const ddlUrl = config.migrateDatabaseUrl;
    const ddlPool = ddlUrl ? new Pool({ connectionString: ddlUrl }) : this.pool;
    try {
      await ddlPool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL DEFAULT 'trial',
        chat_id text NOT NULL,
        sender_enc jsonb,
        sender_pseudonym text,
        wa_message_id text,
        ts bigint NOT NULL,
        text text NOT NULL,
        from_bot boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, ts);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime text;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_ref text;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_status text;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_text text;
      CREATE INDEX IF NOT EXISTS idx_messages_media_pending ON messages (media_status) WHERE media_status = 'pending';
      ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
      ALTER TABLE messages FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS tenant_isolation ON messages;
      CREATE POLICY tenant_isolation ON messages
        FOR ALL
        USING (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')))
        WITH CHECK (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')));

      CREATE TABLE IF NOT EXISTS inbound_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL DEFAULT 'trial',
        surface text NOT NULL,
        kind text NOT NULL,
        payload_enc jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_events_pending ON inbound_events (created_at) WHERE status = 'pending';
      ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE inbound_events FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS tenant_isolation ON inbound_events;
      CREATE POLICY tenant_isolation ON inbound_events
        FOR ALL
        USING (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')))
        WITH CHECK (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')));
    `);

      // DB-enforced dedup (D-item 2): a redelivery after a restart must insert exactly one row,
      // not a duplicate — the in-memory dedup map (safety/dedup.ts) is wiped on every restart and
      // WAHA never redelivers a webhook it already got a 200 for, so nothing else catches this.
      // A live check (2026-07-29, 8,254 rows) found exactly ONE pre-existing duplicate pair (same
      // tenant_id+wa_message_id, different ts — a genuine past redelivery), so a bare
      // `CREATE UNIQUE INDEX` would fail on real data. Clean it up first: keep the earliest-
      // created row per (tenant_id, wa_message_id) and drop the rest — idempotent, a no-op once
      // clean. Scoped to THIS instance's tenant (not the RLS session GUC alone) so it can never
      // touch another tenant's rows even when the connection bypasses RLS (e.g. a superuser DSN
      // in tests) — this bot is single-tenant-per-instance today (config.tenantId), so that is
      // the entire blast radius that should ever be touched here.
      // Nullable-safe: wa_message_id IS legitimately empty for the bot's own outbound messages
      // (saveMessage below always writes waMessageId: "" for those) — excluded from the unique
      // index so they never collide with each other.
      // CRITICAL: this DELETE must run through withTenant on the RUNTIME pool, not on the owner
      // ddlPool. `messages` has FORCE ROW LEVEL SECURITY, which applies to the table OWNER too,
      // so on a connection with no `app.current_tenant_ids` set the policy matches NOTHING and the
      // DELETE silently affects 0 rows. That is exactly what happened on the live DB: the cleanup
      // reported success, the duplicate survived, CREATE UNIQUE INDEX then failed, init() threw,
      // and the bot crash-looped every ~4s with ingestion fully down. DML needs no owner rights
      // (bot_app holds DELETE); only the CREATE INDEX below needs the owner.
      const deduped = await withTenant(this.pool, [config.tenantId], async (c) => {
        const res = await c.query(
          `DELETE FROM messages m
           USING (
             SELECT id, row_number() OVER (
               PARTITION BY tenant_id, wa_message_id
               ORDER BY created_at ASC, id ASC
             ) AS rn
             FROM messages
             WHERE tenant_id = $1 AND wa_message_id IS NOT NULL AND wa_message_id <> ''
           ) ranked
           WHERE m.id = ranked.id AND ranked.rn > 1`,
          [config.tenantId],
        );
        return res.rowCount ?? 0;
      });
      if (deduped > 0) {
        console.warn(`[store] removed ${deduped} duplicate message row(s) before enforcing the wa_message_id index`);
      }
      // The index is GLOBAL (all tenants) while the cleanup above is scoped to this instance's
      // tenant. Fail with an actionable message rather than a raw 23505 stack trace looping
      // forever: saveMessage's ON CONFLICT targets this index, so we cannot just continue without
      // it (the INSERT would error on every message) — but the operator needs to know WHY.
      try {
        await ddlPool.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_tenant_wamsgid
           ON messages (tenant_id, wa_message_id)
           WHERE wa_message_id IS NOT NULL AND wa_message_id <> ''`,
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new Error(
            "cannot enforce message dedup: duplicate (tenant_id, wa_message_id) rows exist OUTSIDE " +
              `this instance's tenant ("${config.tenantId}"), so the scoped cleanup could not remove them. ` +
              "Inspect with: SELECT tenant_id, wa_message_id, count(*) FROM messages WHERE wa_message_id <> '' " +
              "GROUP BY 1,2 HAVING count(*) > 1;",
          );
        }
        throw err;
      }
    } finally {
      if (ddlPool !== this.pool) await ddlPool.end();
    }
  }

  async saveMessage(m: StoredMessage): Promise<void> {
    const { enc, pseudo } = await encodeSender(m);
    await withTenant(this.pool, [config.tenantId], async (c) => {
      // ON CONFLICT targets the partial unique index above: a redelivered wa_message_id (the
      // crash-recovery replay path in intake.ts, or a stray WAHA redelivery) is silently a
      // no-op, never a duplicate row. Rows with no/empty wa_message_id (bot's own replies)
      // aren't covered by that index, so they always insert — nothing to dedup there.
      await c.query(
        `INSERT INTO messages (tenant_id, chat_id, sender_enc, sender_pseudonym, wa_message_id, ts, text, from_bot,
                               media_mime, media_ref, media_status, media_text)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL AND wa_message_id <> ''
         DO NOTHING`,
        [
          config.tenantId, m.chatId, JSON.stringify(enc), pseudo, m.waMessageId, m.ts, m.text, m.fromBot,
          m.mediaMime ?? null, m.mediaRef ?? null, m.mediaStatus ?? null, m.mediaText ?? null,
        ],
      );
    });
    await this.purgeExpired();
  }

  /** Delete everything older than config.retentionDays — messages AND the inbound-intake log —
   *  across every chat regardless of recent activity. Called eagerly from saveMessage (as
   *  before) AND exported standalone so a cron (Agent C) can run it on a schedule independent of
   *  message traffic — a chat that goes silent must not keep its PII forever just because
   *  nothing else triggered a purge pass. Returns the total rows deleted (both tables). */
  async purgeExpired(): Promise<number> {
    const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    return withTenant(this.pool, [config.tenantId], async (c) => {
      const msgs = await c.query(`DELETE FROM messages WHERE ts < $1`, [cutoff]);
      const events = await c.query(`DELETE FROM inbound_events WHERE created_at < to_timestamp($1 / 1000.0)`, [cutoff]);
      return (msgs.rowCount ?? 0) + (events.rowCount ?? 0);
    });
  }

  async saveInboundEvent(rec: {
    surface: string;
    kind: string;
    subjectId: string;
    entityId: string;
    payload: unknown;
  }): Promise<string> {
    const enc = await encodePayload(rec.subjectId, rec.entityId, rec.payload);
    return withTenant(this.pool, [config.tenantId], async (c) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO inbound_events (tenant_id, surface, kind, payload_enc, status)
         VALUES ($1, $2, $3, $4::jsonb, 'pending')
         RETURNING id`,
        [config.tenantId, rec.surface, rec.kind, JSON.stringify(enc)],
      );
      return res.rows[0].id;
    });
  }

  async getPendingInboundEvents(minAgeMs = 0): Promise<IntakeRecord[]> {
    interface IntakeRow {
      id: string;
      surface: string;
      kind: string;
      payload_enc: Ciphertext;
      status: IntakeStatus;
      error: string | null;
      created_at: string;
    }
    const cutoff = new Date(Date.now() - minAgeMs);
    const rows = await withTenant(this.pool, [config.tenantId], async (c) => {
      const res = await c.query<IntakeRow>(
        `SELECT id, surface, kind, payload_enc, status, error, created_at
         FROM inbound_events WHERE status = 'pending' AND created_at <= $1 ORDER BY created_at ASC`,
        [cutoff],
      );
      return res.rows;
    });
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        surface: r.surface,
        kind: r.kind,
        payload: await decodePayload(r.payload_enc),
        status: r.status,
        error: r.error ?? undefined,
        createdAt: new Date(r.created_at).getTime(),
      })),
    );
  }

  async markInboundEventDone(id: string): Promise<void> {
    await withTenant(this.pool, [config.tenantId], (c) =>
      c.query(`UPDATE inbound_events SET status = 'done', processed_at = now() WHERE id = $1`, [id]),
    );
  }

  async markInboundEventFailed(id: string, error: string): Promise<void> {
    await withTenant(this.pool, [config.tenantId], (c) =>
      c.query(`UPDATE inbound_events SET status = 'failed', error = $2, processed_at = now() WHERE id = $1`, [id, error]),
    );
  }

  private async toStored(r: Row): Promise<StoredMessage> {
    const s = await decodeSender(r.sender_enc);
    return {
      chatId: r.chat_id,
      senderId: s.senderId,
      senderName: s.senderName,
      waMessageId: r.wa_message_id,
      ts: Number(r.ts),
      text: r.text,
      fromBot: r.from_bot,
      mediaMime: r.media_mime ?? undefined,
      mediaRef: r.media_ref ?? undefined,
      mediaStatus: r.media_status ?? undefined,
      mediaText: r.media_text ?? undefined,
    };
  }

  async getMessages(chatId: string, sinceTs = 0): Promise<StoredMessage[]> {
    const rows = await withTenant(this.pool, [config.tenantId], async (c) => {
      const res = await c.query<Row>(
        `SELECT ${ROW_COLS} FROM messages WHERE chat_id = $1 AND ts >= $2 ORDER BY ts ASC`,
        [chatId, sinceTs],
      );
      return res.rows;
    });
    return Promise.all(rows.map((r) => this.toStored(r)));
  }

  async getPendingMedia(limit = 10): Promise<StoredMessage[]> {
    const rows = await withTenant(this.pool, [config.tenantId], async (c) => {
      const res = await c.query<Row>(
        `SELECT ${ROW_COLS} FROM messages WHERE media_status = 'pending' ORDER BY ts ASC LIMIT $1`,
        [limit],
      );
      return res.rows;
    });
    return Promise.all(rows.map((r) => this.toStored(r)));
  }

  async updateMedia(waMessageId: string, patch: { status: string; text?: string }): Promise<void> {
    await withTenant(this.pool, [config.tenantId], async (c) => {
      await c.query(
        `UPDATE messages SET media_status = $2, media_text = COALESCE($3, media_text) WHERE wa_message_id = $1`,
        [waMessageId, patch.status, patch.text ?? null],
      );
    });
  }

  /** 1e: substring search over stored text, newest-first, across all chats. ILIKE inside the
   *  existing withTenant() wrapper so RLS still applies; the query text is always bound as a
   *  parameter ($1), never interpolated into the SQL string. `%`/`_`/`\` in the user's query
   *  are escaped so they aren't interpreted as ILIKE wildcards. */
  async searchMessages(query: string, limit = 20): Promise<StoredMessage[]> {
    const q = query.trim();
    if (!q) return [];
    const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    const rows = await withTenant(this.pool, [config.tenantId], async (c) => {
      const res = await c.query<Row>(
        `SELECT ${ROW_COLS} FROM messages WHERE text ILIKE $1 ESCAPE '\\' ORDER BY ts DESC LIMIT $2`,
        [`%${escaped}%`, limit],
      );
      return res.rows;
    });
    return Promise.all(rows.map((r) => this.toStored(r)));
  }

  /** 1e: backwards paging — the newest `opts.limit` messages strictly older than
   *  `opts.beforeTs` (or the newest overall when omitted), returned oldest -> newest. */
  async getMessagesPage(chatId: string, opts: { limit: number; beforeTs?: number }): Promise<StoredMessage[]> {
    const rows = await withTenant(this.pool, [config.tenantId], async (c) => {
      const res =
        opts.beforeTs !== undefined
          ? await c.query<Row>(
              `SELECT ${ROW_COLS} FROM messages WHERE chat_id = $1 AND ts < $2 ORDER BY ts DESC LIMIT $3`,
              [chatId, opts.beforeTs, opts.limit],
            )
          : await c.query<Row>(
              `SELECT ${ROW_COLS} FROM messages WHERE chat_id = $1 ORDER BY ts DESC LIMIT $2`,
              [chatId, opts.limit],
            );
      return res.rows;
    });
    const stored = await Promise.all(rows.map((r) => this.toStored(r)));
    return stored.reverse(); // ascending (oldest -> newest), same convention as getMessages()
  }

  async getGroupChatIds(): Promise<string[]> {
    const rows = await withTenant(this.pool, [config.tenantId], async (c) => {
      const res = await c.query<{ chat_id: string }>(
        `SELECT DISTINCT chat_id FROM messages WHERE chat_id LIKE '%@g.us'`,
      );
      return res.rows;
    });
    return rows.map((r) => r.chat_id);
  }

  /** One aggregate query (three CTEs over the existing (chat_id, ts) index) instead of
   *  N+1 per-chat lookups: distinct chats + counts, the last message per chat (any sender,
   *  for the preview), and the last NON-bot message per chat (for the display name). Sender
   *  decode only runs on the `limit` rows actually returned, never the whole table. */
  async listChats(limit = 100): Promise<ChatSummary[]> {
    interface Row {
      chat_id: string;
      message_count: string;
      last_ts: string;
      last_text: string | null;
      sender_enc: Ciphertext | null;
    }
    const rows = await withTenant(this.pool, [config.tenantId], async (c) => {
      const res = await c.query<Row>(
        `WITH agg AS (
           SELECT chat_id, COUNT(*)::bigint AS message_count, MAX(ts) AS last_ts
           FROM messages
           GROUP BY chat_id
         ),
         last_msg AS (
           SELECT DISTINCT ON (chat_id) chat_id, text AS last_text
           FROM messages
           ORDER BY chat_id, ts DESC
         ),
         last_sender AS (
           SELECT DISTINCT ON (chat_id) chat_id, sender_enc
           FROM messages
           WHERE from_bot = false
           ORDER BY chat_id, ts DESC
         )
         SELECT agg.chat_id, agg.message_count, agg.last_ts, last_msg.last_text, last_sender.sender_enc
         FROM agg
         LEFT JOIN last_msg ON last_msg.chat_id = agg.chat_id
         LEFT JOIN last_sender ON last_sender.chat_id = agg.chat_id
         ORDER BY agg.last_ts DESC
         LIMIT $1`,
        [limit],
      );
      return res.rows;
    });
    return Promise.all(
      rows.map(async (r) => {
        const sender = r.sender_enc !== null ? await decodeSender(r.sender_enc) : null;
        return {
          chatId: r.chat_id,
          messageCount: Number(r.message_count),
          lastActivityTs: Number(r.last_ts),
          lastPreview: r.last_text ?? "",
          lastSenderName: sender?.senderName ?? "",
        };
      }),
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
