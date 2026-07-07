/**
 * 人设片段的共享格式化（change humanize-interaction-prompts）。
 * 多个判定 / 撰写角色都要把人设兴趣拼进 prompt——集中一处，避免各角色各写一遍漂移。
 */

/**
 * 兴趣主 / 次分层表述：「主要关注 …；也会看 …」。
 * 比把 primary+secondary 平铺成一串顿号更像真人偏好（有轻重之分）。
 * 任一层为空时优雅降级；两层都空返回占位。
 */
export function tieredInterests(interests: { primary: string[]; secondary: string[] }): string {
  const primary = interests.primary.join('、');
  const secondary = interests.secondary.join('、');
  if (primary && secondary) return `主要关注 ${primary}；也会看 ${secondary}`;
  return primary || secondary || '（未特别设定）';
}
