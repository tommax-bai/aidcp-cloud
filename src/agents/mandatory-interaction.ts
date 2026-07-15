import type { MandatoryInteractionContext } from '../event-bus/types.js';
import type { MandatoryInteractionRule, Soul } from '../soul/types.js';

/** Prompt 中的人设强制规则块；缺规则时空串，确保普通账号模板逐位不变。 */
export function mandatoryInteractionPrompt(soul: Soul): string {
  const rules = soul.mandatory_interactions ?? [];
  if (rules.length === 0) return '';
  return rules.map((rule) => {
    const comment = rule.actions.includes('comment')
      ? `；评论指引：${rule.comment_guidance}；评论授权：${rule.comment_approval}`
      : '';
    return `- id=${rule.id}；命中条件：${rule.when}；强制动作：${rule.actions.join('+')}${comment}`;
  }).join('\n');
}

/** 只接受当前热加载 soul 中真实存在的 rule id；未知 id fail-closed。 */
export function mandatoryInteractionContext(soul: Soul, ruleId: string | undefined): MandatoryInteractionContext | null {
  if (!ruleId) return null;
  const rule = (soul.mandatory_interactions ?? []).find((candidate) => candidate.id === ruleId);
  return rule ? contextFromRule(rule) : null;
}

export function contextFromRule(rule: MandatoryInteractionRule): MandatoryInteractionContext {
  return {
    ruleId: rule.id,
    actions: [...rule.actions],
    ...(rule.comment_guidance ? { commentGuidance: rule.comment_guidance } : {}),
    ...(rule.comment_approval ? { commentApproval: rule.comment_approval } : {}),
  };
}
