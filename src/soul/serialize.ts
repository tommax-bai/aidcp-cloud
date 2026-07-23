/**
 * Soul → YAML 确定性序列化器。
 *
 * 背景（change edge-persona-keyword-generation）：soul 侧此前只有极简自写解析器（yaml.ts）、无序列化器。
 * 客户端自助建人设让大模型吐 JSON（对齐现有命令式生成器角色），云端把它确定性地序列化成 soul YAML 文本
 * 再走现有校验写入通道——因此需要这个序列化器。
 *
 * 产出严格限制在 yaml.ts 解析器支持的子集内，保证 round-trip：
 * - 2 空格缩进嵌套 map；
 * - 字符串一律双引号（保护 `#` / `:` / 前导空白不被解析器误判为注释/分隔/缩进）；
 * - 转义只用解析器认得的两种：`"` → `\"`、换行 → `\n`（与 parseScalar 的反解逐字对应，解析器不识别 `\\`，故不转义反斜杠）；
 * - 非空字符串数组用块状列表 `- "..."`；空数组用行内流式 `[]`（避免"键无子项"被解析成 null 触发 reqStringArray 报错）。
 *
 * 序列化生成器会产出的字段（identity / interests / 可选 behavior_guidelines），并保留调用方显式带入的
 * mandatory_interactions（站立授权不能在 round-trip 中静默丢失）。仍刻意不产 legacy engagement_rules / browse_patterns。
 * 调用方 MUST 对产出做 loadSoulFromYaml round-trip 自校验（防序列化漂移）。
 */

import type { Soul } from '../kernel/soul-types.js';

/** 把字符串编码成 yaml.ts 解析器可反解的双引号标量。 */
function quoteScalar(s: string): string {
  const escaped = s
    .replace(/"/g, '\\"') // 解析器 parseScalar 会把 \" 反解成 "
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n'); // 解析器会把 \n 反解成换行
  return `"${escaped}"`;
}

/**
 * 序列化 "key: 字符串数组" 字段：
 * 非空 → 块状列表；空 → 行内 `[]`（解析器 parseScalar 支持流式空数组，能被 reqStringArray 接住）。
 */
function emitStringListField(
  key: string,
  items: string[],
  keyIndent: string,
  itemIndent: string,
): string[] {
  if (items.length === 0) return [`${keyIndent}${key}: []`];
  const out = [`${keyIndent}${key}:`];
  for (const it of items) out.push(`${itemIndent}- ${quoteScalar(it)}`);
  return out;
}

/**
 * 把 Soul 序列化为 soul YAML 文本。
 * 产出保证能被 loadSoulFromYaml 原样解析（identity 4 字段 + interests 3 数组 + 可选 behavior_guidelines）。
 */
export function serializeSoul(soul: Soul): string {
  const lines: string[] = [];

  lines.push('identity:');
  lines.push(`  name: ${quoteScalar(soul.identity.name)}`);
  lines.push(`  role: ${quoteScalar(soul.identity.role)}`);
  lines.push(`  background: ${quoteScalar(soul.identity.background)}`);
  lines.push(`  tone: ${quoteScalar(soul.identity.tone)}`);

  if (soul.writing_language) lines.push(`writing_language: ${quoteScalar(soul.writing_language)}`);

  lines.push('interests:');
  lines.push(...emitStringListField('primary', soul.interests.primary, '  ', '    '));
  lines.push(...emitStringListField('secondary', soul.interests.secondary, '  ', '    '));
  lines.push(...emitStringListField('seed_keywords', soul.interests.seed_keywords, '  ', '    '));

  if (soul.mandatory_interactions) {
    if (soul.mandatory_interactions.length === 0) {
      lines.push('mandatory_interactions: []');
    } else {
      lines.push('mandatory_interactions:');
      for (const rule of soul.mandatory_interactions) {
        lines.push(`  - id: ${quoteScalar(rule.id)}`);
        lines.push(`    when: ${quoteScalar(rule.when)}`);
        lines.push(...emitStringListField('actions', rule.actions, '    ', '      '));
        if (rule.comment_guidance) lines.push(`    comment_guidance: ${quoteScalar(rule.comment_guidance)}`);
        if (rule.comment_approval) lines.push(`    comment_approval: ${quoteScalar(rule.comment_approval)}`);
      }
    }
  }

  if (soul.behavior_guidelines) {
    const bg = soul.behavior_guidelines;
    lines.push('behavior_guidelines:');
    lines.push(`  style: ${quoteScalar(bg.style)}`);
    lines.push(`  privacy: ${quoteScalar(bg.privacy)}`);
    lines.push(`  collection_principle: ${quoteScalar(bg.collection_principle)}`);
    lines.push(`  like_principle: ${quoteScalar(bg.like_principle)}`);
    if (bg.like_affinity) lines.push(`  like_affinity: ${quoteScalar(bg.like_affinity)}`);
  }

  return lines.join('\n') + '\n';
}
