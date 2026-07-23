import pg from 'pg';
import { resolveEnvPgConfig } from '../kernel/pg-config.js';

const { Pool } = pg;

export interface BotChatRecord {
  chatId: string;
  chatName: string | null;
  chatType: string | null;
}

export interface DefaultBotChatRecord extends BotChatRecord {}

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

  async setDefault(record: BotChatRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE bot_chats
         SET is_default = false,
             updated_at = now()
         WHERE is_default = true`,
      );
      await client.query(
        `INSERT INTO bot_chats (chat_id, chat_name, chat_type, is_default, status, bound_at, updated_at)
         VALUES ($1, $2, $3, true, 'active', now(), now())
         ON CONFLICT (chat_id) DO UPDATE
         SET chat_name = EXCLUDED.chat_name,
             chat_type = EXCLUDED.chat_type,
             is_default = true,
             status = 'active',
             bound_at = now(),
             updated_at = now()`,
        [record.chatId, record.chatName, record.chatType],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getDefaultChat(): Promise<DefaultBotChatRecord | null> {
    const result = await this.pool.query<{
      chat_id: string;
      chat_name: string | null;
      chat_type: string | null;
    }>(
      `SELECT chat_id, chat_name, chat_type
       FROM bot_chats
       WHERE is_default = true
         AND status = 'active'
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      chatId: row.chat_id,
      chatName: row.chat_name,
      chatType: row.chat_type,
    };
  }

  /**
   * 列机器人当前活跃所在群（change feishu-per-team-notification-routing）：只读、无 DDL。
   * 供面板路由配置从「机器人实际所在群」下拉选目标，杜绝手贴 raw chat_id 贴错群（→ 跨客户 PII 泄漏）。
   * 默认群置顶，其余按 updated_at 倒序。缺表回落空。
   */
  async listActive(): Promise<Array<BotChatRecord & { isDefault: boolean }>> {
    try {
      const result = await this.pool.query<{
        chat_id: string;
        chat_name: string | null;
        chat_type: string | null;
        is_default: boolean;
      }>(
        `SELECT chat_id, chat_name, chat_type, is_default
         FROM bot_chats
         WHERE status = 'active'
         ORDER BY is_default DESC, updated_at DESC`,
      );
      return result.rows.map((row) => ({
        chatId: row.chat_id,
        chatName: row.chat_name,
        chatType: row.chat_type,
        isDefault: row.is_default === true,
      }));
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return [];
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}