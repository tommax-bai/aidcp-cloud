-- aidcp:kind=contract
-- aidcp:objects=
-- 身份域两条非空约束（change cloud-schema-migration-executor 任务 3.1/3.2 的收缩尾巴）。
--
-- 为什么单独一个文件：这两条来自 src/client-auth/client-user-store.ts 的自愈序列
-- 「加可空列 → 回填 → 设默认值 → 设非空」。前三步是 expand，最后一步 SET NOT NULL 按 D6 的
-- 机械判定属 contract。把它留在 0065 会让一个纯基线补齐文件被整体标成 contract，
-- 既误导读者，也让 expand-only 用例扫不到 0065。
--
-- 现网库上这两条早已生效（存储启动期已跑过），本文件在 dev/ol 只会被 baseline 记账、不会真执行。
-- 在全新空库上按序执行时需要 `npm run migrate up --allow-contract`
-- —— 历史迁移里本来就有多条 contract（0036 / 0041 / 0045 / 0046 / 0052），空库拉起本就要带这个授权。


ALTER TABLE client_environments ALTER COLUMN lifecycle_state SET NOT NULL;
ALTER TABLE client_environments ALTER COLUMN slow_start_initialized SET NOT NULL;
