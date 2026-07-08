// Postgres-backed store (used when DATABASE_URL is set). Keeps crypto-shred: sender
// identity encrypted in a jsonb column. RLS (D5): rows are filtered by the
// authorized-tenant-set in `app.current_tenant_ids`; no setting -> no rows (fail-closed).
// FORCE ROW LEVEL SECURITY applies the policy even to the table owner.
import { Pool, type PoolClient } from "pg";
import { config } from "../config";
import type { Ciphertext } from "../crypto/envelope";
import { encodeSender, decodeSender } from "./encode";
import type { Store, StoredMessage, MediaStatus } from "./types";

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
    await this.pool.query(`
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
    `);
  }

  async saveMessage(m: StoredMessage): Promise<void> {
    const { enc, pseudo } = await encodeSender(m);
    await withTenant(this.pool, [config.tenantId], async (c) => {
      await c.query(
        `INSERT INTO messages (tenant_id, chat_id, sender_enc, sender_pseudonym, wa_message_id, ts, text, from_bot,
                               media_mime, media_ref, media_status, media_text)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          config.tenantId, m.chatId, JSON.stringify(enc), pseudo, m.waMessageId, m.ts, m.text, m.fromBot,
          m.mediaMime ?? null, m.mediaRef ?? null, m.mediaStatus ?? null, m.mediaText ?? null,
        ],
      );
      const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
      await c.query(`DELETE FROM messages WHERE ts < $1`, [cutoff]);
    });
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

  async getGroupChatIds(): Promise<string[]> {
    const rows = await withTenant(this.pool, [config.tenantId], async (c) => {
      const res = await c.query<{ chat_id: string }>(
        `SELECT DISTINCT chat_id FROM messages WHERE chat_id LIKE '%@g.us'`,
      );
      return res.rows;
    });
    return rows.map((r) => r.chat_id);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
