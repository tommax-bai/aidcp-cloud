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