/**
 * 封面文字卡文案的**纯 prompt 构建段**（change decouple-behavior-class-ports 析出）。
 *
 * 从 src/publish-agent/prompts.ts（content）抬出：`buildCoverCardCopyPrompt` 纯构建函数与其依赖的
 * `buildContentVisualExcerpt`（有界正文摘录，纯字符串函数）。零 import / 零 SQL / 零 LLM / 零进程内活状态。
 * prompts.ts 其余多角色构建（依赖 content 兄弟模块 types / content-visual-brief）留原文件（content），
 * 并从 kernel 等值再导出这两个纯物、行为逐字不变。供 api 侧静态 prompt 预览跨边界共导，消 1 条 api->content 边。
 * 满足 §4.7 kernel 准入。
 */

const CONTENT_VISUAL_EXCERPT_MAX = 2400;

/**
 * 为视觉导演构造有界正文摘录。短正文完整保留；长正文等量采首/中/尾，避免只截开头丢失情绪转折。
 */
export function buildContentVisualExcerpt(content: string, maxChars = CONTENT_VISUAL_EXCERPT_MAX): string {
  const normalized = content.trim();
  const limit = Math.max(300, Math.floor(maxChars));
  if (normalized.length <= limit) return normalized;
  const labels = '\n【中段】\n\n【结尾】\n';
  const segmentSize = Math.max(80, Math.floor((limit - labels.length - 6) / 3));
  const middleStart = Math.max(segmentSize, Math.floor((normalized.length - segmentSize) / 2));
  return [
    `【开头】${normalized.slice(0, segmentSize)}`,
    `【中段】${normalized.slice(middleStart, middleStart + segmentSize)}`,
    `【结尾】${normalized.slice(-segmentSize)}`,
  ].join('\n').slice(0, limit);
}

export function buildCoverCardCopyPrompt(
  title: string,
  body: string,
  tags: string[],
  tighten = false,
): string {
  const preview = buildContentVisualExcerpt(body, 1200);
  const lines = [
    '你是小红书封面文字卡的文案编辑。基于下面这篇笔记（标题+正文），提炼一张封面文字卡的文案。',
    '',
    '【笔记标题】',
    title,
    '',
    '【正文语义摘录（短文完整；长文首/中/尾）】',
    preview,
    '',
  ];
  if (tags.length > 0) {
    lines.push(`【候选标签】${tags.join('、')}`, '');
  }
  lines.push(
    '【要求】',
    '- cardTitle：封面主标题，8~16 个字，钩子感强、口语化，不照抄笔记标题（换个说法）。',
    '- bullets：0~5 条要点，每条 6~14 个字，短句、并列结构；正文没有清晰要点就给空数组，绝不硬凑。',
    '- 先确定核心结论和信息层级，再按“标题→核心结论→支撑要点”组织阅读顺序；重点词来自正文主张。',
    '- 信息密度必须匹配正文：正文有多个有效要点时不得只给一个大标题和无意义大面积留白。',
    '- tags：0~3 个标签词（不带 # 号），只能从候选标签挑或用正文里的核心词。',
    '- 全部文案必须来自这篇笔记本身的内容，绝不新增笔记里没有的事实。',
    '- 不出现任何联系方式/价格/促销用语/平台名/作者名；不用 emoji。',
  );
  if (tighten) {
    lines.push('- 【加严】上一版与原文重叠过多或含违规词：这次必须完全换表达方式重写，逐字重复超过 8 字即不合格。');
  }
  lines.push(
    '',
    '【输出要求】严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏：',
    '{"cardTitle": "…", "bullets": ["…"], "tags": ["…"]}',
  );
  return lines.join('\n');
}
