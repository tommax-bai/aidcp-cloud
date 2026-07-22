-- aidcp:kind=expand
-- aidcp:objects=column:category_config.thinking_mode,column:role_config.thinking_mode
-- 0026_role_thinking_mode.sql
-- change role-thinking-mode-config：按角色 / 按分类可配「思考模式」(thinking) 三态。
-- 存储 'off' / 'on'（显式覆盖）；NULL / 空 / 脏串 = default（不干预、跟模型走、请求体零回归）。
-- 与 role/category-config-store.ts 的自愈加列同源；幂等可重跑。
-- 无需回填：新列缺省 NULL = default = 本 change 前的行为（零回归）。

ALTER TABLE role_config     ADD COLUMN IF NOT EXISTS thinking_mode TEXT;
ALTER TABLE category_config ADD COLUMN IF NOT EXISTS thinking_mode TEXT;
