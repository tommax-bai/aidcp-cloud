import type { LikeAffinity, Soul } from './soul-types.js';

export const DEFAULT_LIKE_AFFINITY: LikeAffinity = 'normal';

export const LIKE_AFFINITY_VALUES = ['normal', 'like_more', 'like_most'] as const satisfies readonly LikeAffinity[];

const LABELS: Record<LikeAffinity, string> = {
  normal: '正常',
  like_more: '喜欢',
  like_most: '更喜欢',
};

const NOTE_GUIDANCE: Record<LikeAffinity, string> = {
  normal: '保持选择性：只在真有共鸣、学到具体东西或观点让你眼前一亮时点赞；多数普通内容仍然跳过',
  like_more: '适度偏向点赞：内容与兴趣明确相关并带来真实正向感受时，可以比正常档更愿意点赞；低质、泛泛或无关内容仍然跳过',
  like_most: '明显偏向点赞：对兴趣相关、安全且非低质的内容，只要产生真实好感就更愿意点赞；仍保留跳过，绝不为凑数编造价值',
};

const COMMENT_LIKE_PROBABILITIES: Record<LikeAffinity, number> = {
  normal: 0.6,
  like_more: 0.75,
  like_most: 0.9,
};

export function resolveLikeAffinity(soul: Pick<Soul, 'behavior_guidelines'>): LikeAffinity {
  return soul.behavior_guidelines?.like_affinity ?? DEFAULT_LIKE_AFFINITY;
}

export function likeAffinityLabel(affinity: LikeAffinity): string {
  return LABELS[affinity];
}

export function noteLikeAffinityGuidance(affinity: LikeAffinity): string {
  return NOTE_GUIDANCE[affinity];
}

export function commentLikeProbability(soul: Pick<Soul, 'behavior_guidelines'>): number {
  return COMMENT_LIKE_PROBABILITIES[resolveLikeAffinity(soul)];
}

export function generatedLikePrinciple(affinity: LikeAffinity, primaryInterests: string[]): string {
  const focus = primaryInterests.filter(Boolean).slice(0, 3).join('、');
  const scope = focus ? `尤其关注${focus}相关内容；` : '';
  return `${scope}${NOTE_GUIDANCE[affinity]}。点赞只是普通互动倾向，不是每篇必点。`;
}
