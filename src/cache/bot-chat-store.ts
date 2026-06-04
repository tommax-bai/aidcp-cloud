import pg from 'pg';
import { resolveEnvPgConfig } from './pg-config.js';

const { Pool } = pg;

export interface BotChatRecord {
  chatId: string;
  chatName: string | null;
  chatType: string | null;
}

export interface BotChatStoreOptions {
  pool?: pg.Pool;
}

export class BotChatStore {
  private readonly pool: pg.Pool;

  constructor(options: BotChatStoreOptions = {}) {
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
  }

  async upsertActive(record: BotChatRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_chats (chat_id, chat_name, chat_type, status, updated_at)
       VALUES ($1, $2, $3, 'active', now())
       ON CONFLICT (chat_id) DO UPDATE
       SET chat_name = EXCLUDED.chat_name,
           chat_type = EXCLUDED.chat_type,
           status = 'active',
           updated_at = now()`,
      [record.chatId, record.chatName, record.chatType],
    );
  }

  async markInactive(chatId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bot_chats
       SET status = 'inactive',
           updated_at = now()
       WHERE chat_id = $1`,
      [chatId],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}