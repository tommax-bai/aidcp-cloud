-- aidcp:kind=expand
-- aidcp:objects=column:bot_chats.bound_at,column:bot_chats.chat_id,column:bot_chats.chat_name,column:bot_chats.chat_type
-- aidcp:objects=column:bot_chats.created_at,column:bot_chats.is_default,column:bot_chats.status,column:bot_chats.updated_at
-- aidcp:objects=index:uq_bot_chats_default,table:bot_chats
CREATE TABLE IF NOT EXISTS bot_chats (
  chat_id TEXT PRIMARY KEY,
  chat_name TEXT,
  chat_type TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  bound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_chats_default
  ON bot_chats (is_default)
  WHERE is_default = true;