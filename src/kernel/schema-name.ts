/**
 * 运行时 schema 名的唯一解析点（change cloud-schema-migration-executor，design.md D8 第 4 条）。
 *
 * 仓内原有 8 处硬编码 `'public.'` 的形状探测（`to_regclass('public.xxx')` 一类），
 * 它们在「把表搬进新 schema」时会静默指错地方 —— 改 search_path 也救不了，因为 schema 名是写死在字面量里的。
 * 本文件把这个字面量收口到一个读取点，行为不变（默认仍是 `public`），只是给后续搬 schema 留一条缝。
 */

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/** 运行时对象所在 schema。默认 `public`；改这里等于改全仓的形状探测目标。 */
export function runtimeSchemaName(): string {
  return readEnvString('AIDCP_PG_SCHEMA') ?? 'public';
}

/** `to_regclass()` / 报错文案用的 schema 限定名。 */
export function qualifiedObjectName(objectName: string): string {
  return `${runtimeSchemaName()}.${objectName}`;
}
