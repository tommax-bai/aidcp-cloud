/**
 * 启动期 schema 契约（change cloud-schema-migration-executor 任务 6.1/6.2/6.4，design.md D5）。
 *
 * 本文件是纯判定层：不连库、不读文件系统，只把「账本里有哪些版本」翻译成三分支结论。
 * 判定结论与 warn / enforce 模式无关 —— 两种模式 MUST 输出完全一致的结论与版本清单，
 * 模式只决定「拒绝启动」还是「继续启动」。
 *
 * 这一层要堵的是回滚场景的静默假成功：库比代码新时，旧代码的存储会在启动期
 * 「发现表不在 → 建一张空表 → 开始往里写」，全程零告警。契约门把它变成一次显式的启动失败。
 */

import { compareVersions } from './migration-plan.js';

/**
 * 本构建正常工作所需的最低迁移版本 id。
 *
 * 第 5 节把 33 个存储的自建表全部改成了探测，于是本构建的硬依赖不再只是「账本存在」，
 * 而是「补齐迁移全部到位」——最后一条补齐迁移是 `0070_baseline_self_heal_columns`。
 * 不抬到这里，契约门会放过一个「迁移没跑但存储也不再自建」的必然启动失败。
 *
 * 注：`0069`（两条 `SET NOT NULL`，kind=contract）不是任何存储正常读写的前置，
 * 但它在复合序上低于 `0070`，被本要求顺带覆盖；这只是序的结果，不是对收缩的依赖。
 *
 * 今后每加一条存储真正依赖的迁移，本常量 MUST 一起抬。
 */
export const REQUIRED_SCHEMA_VERSION = '0070_baseline_self_heal_columns';

/**
 * 本构建认识的最高迁移版本 id，等于本构建 `migrations/` 目录里的最大版本。
 * 由 test/schema/schema-contract.test.ts 断言与目录一致（构建产物里不一定带 migrations/，故不在运行时读目录）。
 */
export const KNOWN_MAX_SCHEMA_VERSION = '0070_baseline_self_heal_columns';

export type SchemaGateMode = 'warn' | 'enforce';

export type SchemaGateStatus = 'ok' | 'behind' | 'ahead' | 'unreadable';

export type SchemaGateCode = 'schema_behind_code' | 'schema_ahead_of_code' | 'schema_ledger_unreadable';

export interface SchemaGateInput {
  /** 账本里的全部版本 id；账本不可读时给空数组并设 ledgerError */
  ledgerVersions: string[];
  /** 账本读取本身失败（表不存在 / 连不上库）时的原因；设了它就一定是 unreadable 分支 */
  ledgerError?: string;
  /** 本构建知道的全部版本 id（用于列出「缺哪几条」） */
  knownVersions: string[];
  required?: string;
  knownMax?: string;
  /** env AIDCP_ALLOW_SCHEMA_AHEAD 的原始值 */
  allowAheadRaw?: string;
}

export interface SchemaGateDecision {
  status: SchemaGateStatus;
  code?: SchemaGateCode;
  /** 账本最高版本（复合序） */
  ledgerMax?: string;
  required: string;
  knownMax: string;
  /** behind 分支：本构建知道、账本里却没有、且版本序不高于 required 的版本 */
  missing: string[];
  /** ahead 分支：账本里高于 knownMax 的版本 */
  ahead: string[];
  /** 生效的放行版本 id（未放行为 undefined） */
  waivedUpTo?: string;
  /** 本次是否被显式放行（只对 ahead 分支有意义） */
  waived: boolean;
  /** true = 允许继续启动（enforce 下也放行） */
  pass: boolean;
  message: string;
}

const BOOLEAN_LIKE = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', '*', 'all', 'any']);

/**
 * 放行通道解析（任务 6.4）：必须是具体版本 id。
 * 布尔值、空串、通配值一律视为未放行 —— 布尔旁路一旦打开就永久生效，下一次真正危险的超前也会被同一个开关放过。
 */
export function parseAllowSchemaAhead(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (BOOLEAN_LIKE.has(value.toLowerCase())) return undefined;
  if (!/^\d+_[\w.-]+$/.test(value)) return undefined;
  return value;
}

export function parseSchemaGateMode(raw: string | undefined): SchemaGateMode {
  return raw?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'warn';
}

function maxVersion(versions: string[]): string | undefined {
  let max: string | undefined;
  for (const v of versions) {
    if (max === undefined || compareVersions(v, max) > 0) max = v;
  }
  return max;
}

export function evaluateSchemaGate(input: SchemaGateInput): SchemaGateDecision {
  const required = input.required ?? REQUIRED_SCHEMA_VERSION;
  const knownMax = input.knownMax ?? KNOWN_MAX_SCHEMA_VERSION;
  const waivedUpTo = parseAllowSchemaAhead(input.allowAheadRaw);

  if (input.ledgerError) {
    return {
      status: 'unreadable',
      code: 'schema_ledger_unreadable',
      required,
      knownMax,
      missing: [],
      ahead: [],
      waivedUpTo,
      waived: false,
      pass: false,
      message: `无法证明 schema 正确：读取迁移账本失败（${input.ledgerError}）。所需最低版本 ${required}。`,
    };
  }

  const ledgerMax = maxVersion(input.ledgerVersions);
  const ledgerSet = new Set(input.ledgerVersions);

  if (ledgerMax === undefined || compareVersions(ledgerMax, required) < 0) {
    const missing = input.knownVersions
      .filter((v) => !ledgerSet.has(v) && compareVersions(v, required) <= 0)
      .sort(compareVersions);
    return {
      status: 'behind',
      code: 'schema_behind_code',
      ledgerMax,
      required,
      knownMax,
      missing,
      ahead: [],
      waivedUpTo,
      waived: false,
      pass: false,
      message: `账本最高版本 ${ledgerMax ?? '(空)'} 低于本构建所需最低版本 ${required}；缺失 ${missing.length} 条，处置是补跑迁移。`,
    };
  }

  if (compareVersions(ledgerMax, knownMax) > 0) {
    const ahead = input.ledgerVersions.filter((v) => compareVersions(v, knownMax) > 0).sort(compareVersions);
    const waived = waivedUpTo !== undefined && compareVersions(ledgerMax, waivedUpTo) <= 0;
    return {
      status: 'ahead',
      code: 'schema_ahead_of_code',
      ledgerMax,
      required,
      knownMax,
      missing: [],
      ahead,
      waivedUpTo,
      waived,
      pass: waived,
      message: waived
        ? `账本最高版本 ${ledgerMax} 高于本构建认识的最高版本 ${knownMax}，已按放行版本 ${waivedUpTo} 逐次放行（超前 ${ahead.length} 条）。`
        : `账本最高版本 ${ledgerMax} 高于本构建认识的最高版本 ${knownMax}（超前 ${ahead.length} 条）；这是回滚场景，继续启动会让旧代码静默重建空表。`,
    };
  }

  return {
    status: 'ok',
    ledgerMax,
    required,
    knownMax,
    missing: [],
    ahead: [],
    waivedUpTo,
    waived: false,
    pass: true,
    message: `schema 契约门通过：账本最高版本 ${ledgerMax}（所需 ${required}，本构建认识到 ${knownMax}）。`,
  };
}

/** warn 与 enforce 共用的结论文本；两种模式 MUST 逐字一致，只有前缀不同。 */
export function formatGateConclusion(decision: SchemaGateDecision): string {
  const parts = [decision.message];
  if (decision.missing.length > 0) parts.push(`缺失版本：${decision.missing.join(', ')}`);
  if (decision.ahead.length > 0) parts.push(`超前版本：${decision.ahead.join(', ')}`);
  if (decision.waived && decision.waivedUpTo) parts.push(`放行区间：(${decision.knownMax}, ${decision.waivedUpTo}]`);
  return parts.join('；');
}
