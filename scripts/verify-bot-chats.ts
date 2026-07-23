import pg from 'pg';
import { BotChatStore } from '../src/cache/bot-chat-store.js';
import { resolveEnvPgConfig } from '../src/cache/index.js';
import { FeishuBotChatEventHandler } from '../src/feishu/index.js';

const { Pool } = pg;

async function main(): Promise<void> {
  const pool = new Pool(resolveEnvPgConfig());
  const store = new BotChatStore({ pool });
  const handler = new FeishuBotChatEventHandler(store);
  const chatId = `oc_test_bot_chat_step3_${Date.now()}`;

  try {
    await pool.query('DELETE FROM bot_chats WHERE chat_id = $1', [chatId]);

    await handler.handleBotAdded({
      chat_id: chatId,
      name: 'STEP3 Bot Chat Verify',
    });

    const afterAdd = await pool.query(
      `SELECT chat_id, chat_name, chat_type, status
       FROM bot_chats
       WHERE chat_id = $1`,
      [chatId],
    );

    await handler.handleBotDeleted({
      chat_id: chatId,
      name: 'STEP3 Bot Chat Verify',
    });

    const afterDelete = await pool.query(
      `SELECT chat_id, chat_name, chat_type, status
       FROM bot_chats
       WHERE chat_id = $1`,
      [chatId],
    );

    console.log(
      JSON.stringify(
        {
          chatId,
          afterAdd: afterAdd.rows[0] ?? null,
          afterDelete: afterDelete.rows[0] ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.query('DELETE FROM bot_chats WHERE chat_id = $1', [chatId]);
    await store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});