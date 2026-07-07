/**
 * 把 ('like'|'collect')[] 动作数组翻成中文口语（change humanize-interaction-prompts）。
 * 供评论评估 / 撰写角色注入「你刚才对这篇做了什么」的语境，让判断 / 措辞贴合刚发生的真实互动。
 */
export function interactionLabel(actions: ('like' | 'collect')[]): string {
  const like = actions.includes('like');
  const collect = actions.includes('collect');
  if (like && collect) return '点赞并收藏了';
  if (collect) return '收藏了';
  if (like) return '点赞了';
  return '看完了';
}
