/**
 * Content-local Soul codec for PersonaGenerator output.
 *
 * The general Soul loader remains API-owned because it also reads the default
 * file and validates API-managed legacy/runtime fields. Persona generation only
 * emits identity, interests, writing_language and behavior_guidelines, so the
 * content owner validates and serializes exactly that closed subset instead of
 * reaching back into the API implementation.
 *
 * 解析那一半**不在本文件实现**：它被同步读的 `account_persona` 流共用，
 * 而那条流的消费方按「同游标必同载荷」判定 —— 两个进程各留一份解析实现时，
 * 同一份人设文本会解出两种结构、摘要不同、整条快照被拒收。故解析收口在
 * `src/kernel/persona-soul-parse.ts`，本文件按引用取用，只保留内容段自己的序列化。
 */
import {
  parsePersonaSoulValue,
  parsePersonaSoulYaml,
} from '../kernel/persona-soul-parse.js';
import type { SoulCodec } from '../kernel/soul-codec.js';
import type { Soul } from '../kernel/soul-types.js';

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
  parseValue: parsePersonaSoulValue,
  serialize: serializePersonaSoul,
  parseYaml: parsePersonaSoulYaml,
};
