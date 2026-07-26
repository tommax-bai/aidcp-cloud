/**
 * Content-local Soul codec for PersonaGenerator output.
 *
 * The general Soul loader remains API-owned because it also reads the default
 * file and validates API-managed legacy/runtime fields. Persona generation only
 * emits identity, interests, writing_language and behavior_guidelines, so the
 * content owner validates and serializes exactly that closed subset instead of
 * reaching back into the API implementation.
 */
import { LIKE_AFFINITY_VALUES } from '../kernel/like-affinity.js';
import type { SoulCodec } from '../kernel/soul-codec.js';
import type {
  BehaviorGuidelines,
  LikeAffinity,
  Soul,
  SoulIdentity,
  SoulInterests,
  WritingLanguage,
} from '../kernel/soul-types.js';
import { parseYaml, type YamlValue } from '../kernel/yaml.js';

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

function parsePersonaSoul(value: YamlValue): Soul {
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

function quoteScalar(value: string): string {
  const escaped = value
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

function emitStringList(
  key: string,
  values: string[],
  keyIndent: string,
  itemIndent: string,
): string[] {
  if (values.length === 0) return [`${keyIndent}${key}: []`];
  return [
    `${keyIndent}${key}:`,
    ...values.map((value) => `${itemIndent}- ${quoteScalar(value)}`),
  ];
}

function serializePersonaSoul(soul: Soul): string {
  const lines = [
    'identity:',
    `  name: ${quoteScalar(soul.identity.name)}`,
    `  role: ${quoteScalar(soul.identity.role)}`,
    `  background: ${quoteScalar(soul.identity.background)}`,
    `  tone: ${quoteScalar(soul.identity.tone)}`,
  ];
  if (soul.writing_language) {
    lines.push(`writing_language: ${quoteScalar(soul.writing_language)}`);
  }
  lines.push(
    'interests:',
    ...emitStringList('primary', soul.interests.primary, '  ', '    '),
    ...emitStringList('secondary', soul.interests.secondary, '  ', '    '),
    ...emitStringList('seed_keywords', soul.interests.seed_keywords, '  ', '    '),
  );
  if (soul.behavior_guidelines) {
    const behavior = soul.behavior_guidelines;
    lines.push(
      'behavior_guidelines:',
      `  style: ${quoteScalar(behavior.style)}`,
      `  privacy: ${quoteScalar(behavior.privacy)}`,
      `  collection_principle: ${quoteScalar(behavior.collection_principle)}`,
      `  like_principle: ${quoteScalar(behavior.like_principle)}`,
    );
    if (behavior.like_affinity) {
      lines.push(`  like_affinity: ${quoteScalar(behavior.like_affinity)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export const PERSONA_SOUL_CODEC: SoulCodec = {
  parseValue: parsePersonaSoul,
  serialize: serializePersonaSoul,
  parseYaml: (text) => parsePersonaSoul(parseYaml(text)),
};
