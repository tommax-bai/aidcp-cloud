/**
 * 人设文本 → Soul 的**唯一**纯解析（change deploy-derived-services-to-dev）。
 *
 * 为什么必须只有一份：`account_persona` 同步读流把每个账号的人设解析结果随游标一起发给
 * 自动化进程，而消费方按「同游标必同载荷」判定 —— 两个进程各用一份解析器时，
 * 同一份人设文本解出两种结构、摘要不同，消费方按设计整条拒收。
 * 这不是解析器谁对谁错的问题：**只要有第二份实现，行为测试原理上看不见它们何时分叉**。
 *
 * 本文件承载的是「人设闭子集」那一段：identity / interests / writing_language /
 * behavior_guidelines。它刻意**不覆盖**通用装载器那些 api 段自管的字段
 * （engagement_rules / mandatory_interactions / browse_patterns）—— 那半住在
 * `src/soul/loader.ts`，持模块级可变容器且引 api 段的写作语言判定，进 kernel 即反向边。
 *
 * 三处消费方按引用共用本文件：内容段的人设编解码器、单体组装根、派生接口服务组装根。
 */
import { LIKE_AFFINITY_VALUES } from './like-affinity.js';
import type {
  BehaviorGuidelines,
  LikeAffinity,
  Soul,
  SoulIdentity,
  SoulInterests,
  WritingLanguage,
} from './soul-types.js';
import type { SyncReadJson } from './sync-read-snapshot.js';
import { parseYaml, type YamlValue } from './yaml.js';

const WRITING_LANGUAGES: readonly WritingLanguage[] = ['zh-CN', 'en', 'vi'];

function isRecord(value: YamlValue): value is Record<string, YamlValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(
  value: YamlValue,
  path: string,
): Record<string, YamlValue> {
  if (!isRecord(value)) throw new Error(`${path} 必须是对象`);
  return value;
}

function requireString(
  object: Record<string, YamlValue>,
  key: string,
  path: string,
): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path}.${key} 必须是非空字符串`);
  }
  return value;
}

function requireStringArray(
  object: Record<string, YamlValue>,
  key: string,
  path: string,
): string[] {
  const value = object[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${path}.${key} 必须是字符串数组`);
  }
  return value as string[];
}

function parseIdentity(value: YamlValue): SoulIdentity {
  const identity = requireRecord(value, 'soul.identity');
  return {
    name: requireString(identity, 'name', 'soul.identity'),
    role: requireString(identity, 'role', 'soul.identity'),
    background: requireString(identity, 'background', 'soul.identity'),
    tone: requireString(identity, 'tone', 'soul.identity'),
  };
}

function parseInterests(value: YamlValue): SoulInterests {
  const interests = requireRecord(value, 'soul.interests');
  return {
    primary: requireStringArray(interests, 'primary', 'soul.interests'),
    secondary: requireStringArray(interests, 'secondary', 'soul.interests'),
    seed_keywords: requireStringArray(interests, 'seed_keywords', 'soul.interests'),
  };
}

function parseBehaviorGuidelines(value: YamlValue): BehaviorGuidelines {
  const behavior = requireRecord(value, 'soul.behavior_guidelines');
  const rawAffinity = behavior.like_affinity;
  let likeAffinity: LikeAffinity | undefined;
  if (rawAffinity !== undefined) {
    if (
      typeof rawAffinity !== 'string'
      || !LIKE_AFFINITY_VALUES.includes(rawAffinity as LikeAffinity)
    ) {
      throw new Error(`soul.behavior_guidelines.like_affinity 非法: ${String(rawAffinity)}`);
    }
    likeAffinity = rawAffinity as LikeAffinity;
  }
  return {
    style: requireString(behavior, 'style', 'soul.behavior_guidelines'),
    privacy: requireString(behavior, 'privacy', 'soul.behavior_guidelines'),
    collection_principle: requireString(
      behavior,
      'collection_principle',
      'soul.behavior_guidelines',
    ),
    like_principle: requireString(
      behavior,
      'like_principle',
      'soul.behavior_guidelines',
    ),
    ...(likeAffinity ? { like_affinity: likeAffinity } : {}),
  };
}

/** 在已解析的值上做人设闭子集的结构校验，非法即抛。 */
export function parsePersonaSoulValue(value: YamlValue): Soul {
  const root = requireRecord(value, 'soul');
  const writingLanguage = root.writing_language;
  if (
    writingLanguage !== undefined
    && (
      typeof writingLanguage !== 'string'
      || !WRITING_LANGUAGES.includes(writingLanguage as WritingLanguage)
    )
  ) {
    throw new Error('soul.writing_language 只允许 zh-CN/en/vi');
  }
  return {
    identity: parseIdentity(root.identity),
    interests: parseInterests(root.interests),
    ...(writingLanguage
      ? { writing_language: writingLanguage as WritingLanguage }
      : {}),
    ...(root.behavior_guidelines
      ? { behavior_guidelines: parseBehaviorGuidelines(root.behavior_guidelines) }
      : {}),
  };
}

/** 从人设 YAML 文本解析，非法即抛（序列化后的 round-trip 自校验用这条）。 */
export function parsePersonaSoulYaml(text: string): Soul {
  return parsePersonaSoulValue(parseYaml(text));
}

/**
 * 同步读 `account_persona` 流那一条的**取值口**：解析 + 结构归一 + 失败回 null。
 *
 * 三件事必须一起住在这里，缺一条都会让第二份实现从缝里长回来：
 * ① 解析用哪一份、② 结果怎么归一成可摘要的纯 JSON、③ 解不出来时算什么。
 * 尤其是第 ③ 条：一侧回 null、另一侧抛出去，表现是「一个账号少了人设」与
 * 「整条快照发不出去」的差别，而两者都不会说自己跟对面不一样。
 */
export function parseSyncReadPersonaSoul(personaText: string): SyncReadJson | null {
  try {
    return JSON.parse(
      JSON.stringify(parsePersonaSoulYaml(personaText)),
    ) as SyncReadJson;
  } catch {
    return null;
  }
}
