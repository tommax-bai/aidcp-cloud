/**
 * Publish Agent 多角色链 Prompt 构建函数。
 *
 * 为 ContentScout / ContentCreator / ImageDirector / ContentAssembler / ApprovalGatekeeper
 * 五个角色分别构建 prompt，每个 prompt 严格要求 JSON 输出格式。
 *
 * 人设规则、禁用词和鼓励风格均内联定义于本文件。
 */

import type { TriggerInput, ScoutDecision, CreatedContent, AssembledContent, ImageCategory, StyleProfile } from './types.js';
import { IMAGE_CATEGORIES } from './types.js';
import type { Soul } from '../soul/types.js';

/**
 * 禁用词/句式列表（negative list）。
 * 后处理与 prompt 共用同一份，保证生成约束与检测口径一致。
 */
export const BANNED_PHRASES: string[] = [
  '首先',
  '其次',
  '最后',
  '总结来说',
  '值得一提的是',
  // 「不得不说」已移出（change category-adaptive-images-and-judgment）：真人极常见口语开头，
  // 计入后处理硬检测/扣分属校准偏差；保留真正的 AI 结构套话（首先/其次/综上所述/众所周知…）。
  '众所周知',
  '让我们一起来看看',
  '让我们一起',
  '接下来我将',
  '接下来我会',
  '总的来说',
  '综上所述',
  '各有优劣',
  '各有千秋',
];

/** 鼓励的写作风格（写进 prompt，正向引导）。 */
export const ENCOURAGED_STYLE: string[] = [
  '口语化、允许不完整句子',
  '穿插个人经历（"昨天调 bug 发现..."、"试了三种方案..."）',
  '工程师视角的吐槽/自嘲',
  '直接抛观点，不要铺垫',
  '有明确立场，不要"各有优劣"的和稀泥',
  '偶尔用 "..." 省略号表达思考',
];

/** 模拟的真人高赞笔记范文（few-shot，体现人味；示例话题偏技术，仅作"语气/真实感"参考，勿照搬领域）。 */
export const FEW_SHOT_EXAMPLES: string[] = [
  `RAG 不是万能药，别再无脑上向量库了
折腾了俩礼拜，公司知识库问答终于上线。一开始我也是跟风 embedding + 向量检索一把梭，结果召回一坨，用户问"报销流程"它给我返回个"差旅政策第三版废止通知"...
后来发现问题根本不在模型，是文档切块切得太碎，一段话被劈成三块，语义全断了。改成按标题分块 + 重叠窗口，召回立马正常。
所以说工具链谁都会搭，真正吃功夫的是数据预处理这种脏活。别迷信花活。`,
  `vLLM 部署踩坑记录，省得你们再熬夜
显存 24G 想跑 14B 模型，OOM 到怀疑人生。试了量化、试了 tensor parallel，最后发现是 max_model_len 默认拉满到 32k 把 KV cache 撑爆了。
调到 8k 直接起来了，吞吐还涨了。
文档里这条藏得贼深...建议官方写大点。反正我是踩完了，你们直接抄作业。`,
  `聊聊我为什么不爱用 LangChain
不是说它不好，封装是真全。但调试是真痛苦，报错栈套八层，定位个问题像考古。
小项目我现在直接裸写 prompt + 自己管上下文，可控多了。框架这东西，团队大、要标准化的时候上才划算，个人玩具反而是负担。
当然你要快速出 demo 那确实香，看场景吧。`,
  `今天被一个 prompt 细节坑惨了
同样的指令，加一句"请一步步思考"准确率从 60 飙到 85。我之前一直觉得这是玄学，今天 A/B 测完是真信了。
模型这玩意有时候不是能力问题，是你没给它台阶下。`,
];

/** 典型 AI 输出反例（negative examples，明确标注"不要这样写"）。 */
export const NEGATIVE_EXAMPLES: string[] = [
  `众所周知，RAG（检索增强生成）是当前大模型领域的重要技术。首先，它能够有效缓解幻觉问题；其次，它可以引入外部知识；最后，它降低了微调成本。总的来说，RAG 是一项值得关注的技术！`,
  `值得一提的是，vLLM 是一个高性能推理框架。让我们一起来看看它的优势：第一，它支持 PagedAttention；第二，它吞吐量高；第三，它易于部署。综上所述，vLLM 各有优劣，建议大家根据需求选择。`,
];

// ─── ContentScout ────────────────────────────────────────────────────────────

/**
 * ContentScout prompt — 判断是否发布 + 确定方向
 * 输出 JSON: { shouldPublish, publishDirection, keyPoints, confidence, reason }
 */
export function buildScoutPrompt(trigger: TriggerInput): string {
  const { metrics, generateInput, recentPublished } = trigger;

  const metricsBlock = [
    `- 距上次发布: ${metrics.hoursSinceLastPublish === Infinity ? '从未发布' : `${metrics.hoursSinceLastPublish.toFixed(1)} 小时`}`,
    `- 新积累概念数: ${metrics.newConceptCount}`,
    `- 上次发布后点赞数: ${metrics.likedSinceLastPublish}`,
  ].join('\n');

  const conceptsBlock =
    generateInput.concepts.length > 0
      ? generateInput.concepts.map((c) => `- ${c.keyword}${c.sourceNote ? `（来源: ${c.sourceNote}）` : ''}`).join('\n')
      : '（暂无新概念）';

  // 素材块：优先精选灵感语料（materials），回落旧点赞素材（likedContents）。
  const materials = generateInput.materials ?? [];
  const likedBlock =
    materials.length > 0
      ? materials
          .slice(0, 10)
          .map((m) => {
            const tag = m.botCollected ? '已收藏' : m.botLiked ? '已点赞' : '浏览过';
            return `- 「${m.title}」(赞${m.likeCount ?? '?'} 藏${m.collectCount ?? '?'}，${tag})`;
          })
          .join('\n')
      : generateInput.likedContents.length > 0
        ? generateInput.likedContents
            .slice(0, 10)
            .map((n) => `- ${n.title}${n.author ? `（@${n.author}）` : ''}: ${n.summary.slice(0, 80)}`)
            .join('\n')
        : '（暂无素材）';

  const recentBlock =
    recentPublished.length > 0
      ? recentPublished.map((p, i) => `${i + 1}. ${p}`).join('\n')
      : '（暂无已发布帖子）';

  const soul = generateInput.soul;
  const forcedBlock = trigger.forced
    ? [
        '',
        '【⚠️ 运营手动强制发布——本次必须发布】',
        '运营已通过 /publish 明确要求现在发布一条（发布前仍有人工审核兜底）。因此 shouldPublish 必须为 true，',
        '上述决策标准中"概念/点赞少则不发布"的判断本次不适用。即使素材不足，也要基于账号人设与兴趣领域',
        '确定一个当下具体、可写、有价值的方向（优先结合已有概念/点赞），并给出 3 个要点。',
        `账号人设：${soul?.identity?.role ?? ''}｜${soul?.identity?.background ?? ''}（语气：${soul?.identity?.tone ?? ''}）`,
        `兴趣领域：${[...(soul?.interests?.primary ?? []), ...(soul?.interests?.seed_keywords ?? [])].slice(0, 12).join('、') || '（未配置，请发一篇该账号领域内的通用优质内容）'}`,
      ].join('\n')
    : '';

  // 洗稿参照（change curated-note-actions）：运营指定参照笔记时，发布方向钉在参照选题上。
  const referenceNote = generateInput.referenceNote;
  const referenceBlock = referenceNote
    ? [
        '',
        '【参照笔记——本次为洗稿参照创作】',
        `运营指定了一篇参照笔记：「${referenceNote.title}」${referenceNote.author ? `（@${referenceNote.author}）` : ''}${referenceNote.topics.length > 0 ? `，话题：${referenceNote.topics.slice(0, 6).join('、')}` : ''}。`,
        'publishDirection 必须钉在这篇参照笔记的选题上，keyPoints 从其核心要点提炼（后续创作会以人设口吻重写，不会照抄）。',
      ].join('\n')
    : '';

  return [
    '你是一个内容发布策略分析师。你的任务是根据当前积累的素材和度量数据，判断现在是否适合发布一篇小红书笔记，并确定发布方向。',
    '',
    '【当前度量数据】',
    metricsBlock,
    '',
    '【已积累的新概念】',
    conceptsBlock,
    '',
    '【最近点赞的内容（可参考的素材来源）】',
    likedBlock,
    '',
    '【最近已发布的帖子（避免重复话题）】',
    recentBlock,
    '',
    '【决策标准】',
    '- 如果新概念 >= 3 且点赞 >= 5，素材充足，适合发布',
    '- 如果距上次发布 > 48 小时且有 >= 1 个新概念，也应发布（避免沉默太久）',
    '- 如果概念和点赞都很少，建议不发布',
    '- 确定发布方向时，从概念和点赞内容中找到最有深度/话题性的主题',
    '- 发布方向要避免与最近已发布的帖子重复',
    forcedBlock,
    referenceBlock,
    '',
    '【输出要求】',
    '严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏。格式如下：',
    '{"shouldPublish": true/false, "publishDirection": "主题方向描述", "keyPoints": ["要点1","要点2","要点3"], "confidence": 0.0-1.0, "reason": "判断理由"}',
    '',
    '示例输出：',
    '{"shouldPublish": true, "publishDirection": "RAG 检索优化的工程实践", "keyPoints": ["向量切块策略", "重叠窗口效果", "召回率提升数据"], "confidence": 0.85, "reason": "积累了3个RAG相关概念，且有2篇点赞内容涉及检索优化实战，素材充足"}',
  ].join('\n');
}

// ─── ContentCreator ──────────────────────────────────────────────────────────

/**
 * ContentCreator prompt — 文案创作
 * 复用现有 prompts.ts 的人设和禁用词规则
 * 输出 JSON: { title, content, tags, tone, style }
 */
export function buildCreatorPrompt(scoutDecision: ScoutDecision, trigger: TriggerInput): string {
  const { generateInput, recentPublished } = trigger;
  const { identity } = generateInput.soul;
  const soulInterests = [...generateInput.soul.interests.primary, ...generateInput.soul.interests.secondary].join('、');

  const banned = BANNED_PHRASES.map((p) => `「${p}」`).join('、');
  const encouraged = ENCOURAGED_STYLE.map((s) => `- ${s}`).join('\n');
  const fewShot = FEW_SHOT_EXAMPLES.map((e, i) => `【范文${i + 1}】\n${e}`).join('\n\n');
  const negative = NEGATIVE_EXAMPLES.map((e, i) => `【反例${i + 1}·不要这样写】\n${e}`).join('\n\n');

  const conceptsDetail =
    generateInput.concepts.length > 0
      ? generateInput.concepts.map((c) => `- ${c.keyword}${c.sourceNote ? `（来源: ${c.sourceNote}）` : ''}`).join('\n')
      : '（无）';

  // 素材块：优先精选灵感语料（materials，蒸馏正文要点），回落旧点赞素材（likedContents）。
  const materials = generateInput.materials ?? [];
  const likedDetail =
    materials.length > 0
      ? materials
          .slice(0, 8)
          .map((m) => {
            const tag = m.botCollected ? '我已收藏' : m.botLiked ? '我已点赞' : '我浏览过';
            const excerpt = m.body.replace(/\s+/g, ' ').slice(0, 200);
            return `- 「${m.title}」(赞${m.likeCount ?? '?'} 藏${m.collectCount ?? '?'}，${tag})：${excerpt}`;
          })
          .join('\n')
      : generateInput.likedContents.length > 0
        ? generateInput.likedContents
            .slice(0, 8)
            .map((n) => `- ${n.title}${n.author ? `（@${n.author}）` : ''}: ${n.summary}`)
            .join('\n')
        : '（无）';

  // 读者角度线索（change curated-inspiration-corpus Phase 2）：精选评论 —— 反哺写帖选题角度（次级、可空）。
  const commentHintBlock = (generateInput.commentHints ?? [])
    .slice(0, 3)
    .map(
      (h) =>
        `- ${h.author ? `@${h.author}：` : ''}${h.text.replace(/\s+/g, ' ').slice(0, 100)}${h.sourceNoteTitle ? `（评论于《${h.sourceNoteTitle}》）` : ''}`,
    )
    .join('\n');

  const recentBlock =
    recentPublished.length > 0
      ? recentPublished.map((p, i) => `${i + 1}. ${p}`).join('\n')
      : '（无）';

  // 洗稿参照块（change curated-note-actions）：独立于素材块——素材「仅作灵感严禁照抄」，参照「借题重写禁逐句照抄」，两套规则并存不混。
  const referenceNote = generateInput.referenceNote;
  const referenceBlock = referenceNote
    ? [
        '',
        '【参照笔记——洗稿参照（独立于上方素材规则）】',
        `标题：「${referenceNote.title}」${referenceNote.author ? `（@${referenceNote.author}）` : ''}${referenceNote.topics.length > 0 ? `｜话题：${referenceNote.topics.slice(0, 6).join('、')}` : ''}`,
        `正文节选：${referenceNote.body.replace(/\s+/g, ' ').slice(0, 800)}`,
        '【参照使用规则】本次创作以这篇笔记为参照：借它的选题、结构与核心要点，以你的人设视角与口吻重新创作成一篇属于你的笔记。',
        '禁止逐句照抄、禁止只做同义替换；成稿必须与参照有可辨识的表达差异（不同的开头、不同的细节与例子组织），并补充你自己的经验与判断。',
      ]
    : [];

  return [
    `你是「${identity.name}」，${identity.role}，${identity.background}。说话${identity.tone}。你关注的领域：${soulInterests}。`,
    '你在写一篇要发到小红书的笔记，目标是真实、有个人观点、像一个真人随手记录。',
    '',
    '【硬性禁止】下列词/句式绝对不能出现：' + banned + '。',
    '禁止任何排比句式（"第一…第二…第三…"、"既…又…还…"）。感叹号按你的语气克制使用：偏专业/克制的整篇≤1，偏活泼/生活/情感的可适度使用但不堆砌。',
    '',
    '【鼓励的风格】',
    encouraged,
    '',
    '【内容结构】',
    '- 全文 200-500 字（小红书最佳阅读区间）。',
    '- 不要总分总，允许散漫叙述。',
    '- 开头直接抛观点或问题，不要铺垫。',
    '- 必须包含具体细节（从下面给的概念/点赞内容里提取真实信息）。',
    '- 要有明确的个人立场和判断，不要和稀泥。',
    '',
    '【高赞真人范文（只学这种"真人语气/真实感"，不要照搬其话题领域——你的话题由你的人设与下方写作方向决定）】',
    fewShot,
    '',
    '【AI 味反例（坚决不要这样写）】',
    negative,
    '',
    '【本次写作方向（由 Scout 确定）】',
    `方向: ${scoutDecision.publishDirection}`,
    `关键点: ${scoutDecision.keyPoints.join('、')}`,
    `理由: ${scoutDecision.reason}`,
    '',
    '【可用素材——新概念】',
    conceptsDetail,
    '',
    '【可用素材——精选灵感（仅作灵感，严禁照抄）】',
    likedDetail,
    '【素材使用红线】以上素材只供你体会角度、话题与真实细节；严禁照抄或改写其句子，必须用你自己的话重新表达。',
    ...referenceBlock,
    ...(commentHintBlock
      ? ['', '【读者角度线索——来自高赞评论（只供体会读者在意什么、可借选题角度；严禁照抄）】', commentHintBlock]
      : []),
    '',
    '【最近发过的帖子（避免重复话题/角度）】',
    recentBlock,
    '',
    '【输出要求】',
    '严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏。格式如下：',
    '{"title": "小红书标题18字内可带1个emoji", "content": "正文200-500字", "tone": "professional|casual|technical|narrative", "style": {"type": "踩坑记录|对比分析|趋势观察|读后感"}}',
    '⚠️ 标题硬上限 18 字（含标点/空格/英文字母各算 1 字，emoji 算 1 字），超过 20 字小红书会拒绝发布——务必精炼、不要写省略号、不要堆砌。',
    '⚠️ 不要输出 tags/话题字段——话题由独立角色依定稿正文另行生成（change split-topic-roles）。',
    '',
    '示例输出：',
    '{"title": "vLLM 部署把我坑惨了", "content": "显存24G想跑14B...", "tone": "casual", "style": {"type": "踩坑记录"}}',
  ].join('\n');
}

// ─── TitleCreator ────────────────────────────────────────────────────────────

/**
 * TitleCreator prompt（change dedicated-title-creator-role）— 依据**定稿正文**单独拟标题。
 * 短提示：只讲标题规则，不复述长正文的写作规则块（注意力收束在标题这一件事上）。
 * 输出 JSON: { title }
 */
export function buildTitlePrompt(body: string, persona: string, styleType: string, seedTitle?: string): string {
  const banned = BANNED_PHRASES.map((p) => `「${p}」`).join('、');
  const lines: string[] = [
    `你是${persona}，正在为一篇**已定稿**的小红书笔记拟一个标题。`,
    '只依据下面的定稿正文来写标题，不要复述正文、不要编造正文里没有的信息。',
    '',
    '【定稿正文】',
    body,
    '',
  ];
  if (styleType) lines.push(`【文风类型】${styleType}`, '');
  if (seedTitle) lines.push(`【草稿期标题（仅参考，可弃用）】${seedTitle}`, '');
  lines.push(
    '【标题硬规则】',
    '- 最多 18 个可见字符（汉字 / 标点 / 空格 / 英文字母各算 1，emoji 算 1）。超过小红书会拒绝发布。',
    '- 是一个让人想点开的钩子，但绝不标题党、不夸大、不用"震惊体"。',
    '- 至多 1 个 emoji；也可以不用。',
    '- 不要省略号（… 或 ...）。结尾不带标点。',
    `- 禁止出现这些 AI 味词/句式：${banned}。`,
    '',
    '【好例子】',
    '- vLLM 部署把我坑惨了',
    '- RAG 别再无脑上向量库',
    '【坏例子（不要这样写）】',
    '- 震惊！这个技巧让效率翻 10 倍…（标题党 + 省略号）',
    '- 关于 vLLM 部署的一些经验总结与思考（冗长、AI 味）',
    '',
    '【输出要求】严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏：',
    '{"title": "你的标题"}',
  );
  return lines.join('\n');
}

// ─── 话题链路（change split-topic-roles）：生成 TopicGenerator → 评判 TopicEvaluator ───

/**
 * TopicGenerator prompt — 依据**定稿正文**提炼一批贴合的话题候选（不带 #）。
 * 红线：宁缺毋滥、绝不硬凑/编造无关热词。输出 JSON: { topics: string[] }
 */
export function buildTopicGenerationPrompt(body: string, persona: string): string {
  return [
    `你是${persona}，正在为一篇**已定稿**的小红书笔记挑选话题（发布时的 #话题）。`,
    '【任务：话题生成】只依据下面的定稿正文，提炼一批真正贴合正文的话题词。',
    '',
    '【定稿正文】',
    body,
    '',
    '【规则】',
    '- 每个话题是一个简短的词或短语，不带 # 号、不带空格、不加书名号。',
    '- 粗细搭配：既有精准技术点（如 vLLM、RAG），也有更宽的领域词（如 大模型部署、AI工具）。',
    '- 必须真正来自正文、贴合内容；宁缺毋滥——正文撑不起就少给几个，绝不硬凑、绝不编造无关热词。',
    '- 最多给 15 个。',
    '',
    '【输出要求】严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏：',
    '{"topics": ["话题1","话题2","话题3"]}',
  ].join('\n');
}

/**
 * TopicEvaluator prompt — 从候选里**只筛不加**地挑最终话题（相关性/质量/合规）。
 * 红线：保留项必须是候选子集、绝不新增或改写、绝不硬凑数量。输出 JSON: { kept: string[] }
 */
export function buildTopicEvaluationPrompt(candidates: string[], title: string, body: string): string {
  return [
    '你是小红书内容运营，正在为一篇笔记**筛选**最终要带的话题（#话题）。',
    '【任务：话题评判】从给定候选里挑出与正文最相关、质量最好、合规安全的一批。',
    '',
    `【标题】${title}`,
    '【定稿正文】',
    body,
    '',
    `【候选话题】${candidates.join('、')}`,
    '',
    '【规则】',
    '- 只能从候选里挑，绝不新增候选之外的话题、绝不改写候选词。',
    '- 按「与正文相关性 + 话题质量 + 合规安全」权衡，去掉不相关 / 低质 / 敏感的。',
    '- 保留项按重要性排序输出；宁缺毋滥——没有合适的就少留几个，绝不硬凑数量。',
    '',
    '【输出要求】严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏：',
    '{"kept": ["话题1","话题2"]}',
  ].join('\n');
}

// ─── 配图链路（change publish-multi-image）：选题 ImageSetPlanner → 指令 ImagePromptComposer ───

/**
 * 品类风格档（change category-adaptive-images-and-judgment）。
 * 取代旧全局常量 IMAGE_STYLE_BASE：不再对所有帖施加同一段风格，而是按内容品类选一档、
 * 帖内逐字复用（守帧内一致）、帖间因品类而异。MUST NOT 由 LLM 产（模板常量）。
 * 红线延续：内页无文字、封面留白后期叠字、无写实真人正脸、无水印。
 */
const COVER_SUFFIX =
  'large clean negative space at the top for a title overlay, no on-image text (title added in post)';
const buildProfile = (styleBase: string): StyleProfile => ({
  styleBase,
  coverStyleBase: `${styleBase}, ${COVER_SUFFIX}`,
});

export const STYLE_PROFILES: Record<ImageCategory, StyleProfile> = {
  knowledge: buildProfile(
    'clean editorial flat-lay, overhead top-down, soft diffused window light, warm oat and terracotta palette, generous negative space, subtle paper grain, minimal styling, vertical 3:4, no text, no watermark, no logo',
  ),
  beauty: buildProfile(
    'beauty editorial photography, extreme close-up, soft diffused window light, shallow depth of field, dewy glossy texture, warm rosy peach palette, high-key clean background, faceless product or hands only, no realistic human face, vertical 3:4, no text, no watermark',
  ),
  food: buildProfile(
    'appetizing food photography, 45-degree angle, warm natural window light, shallow depth of field, glossy fresh texture, warm amber and red palette, cozy dining ambiance, subtle film grain, faceless, vertical 3:4, no text, no watermark',
  ),
  fashion: buildProfile(
    'full-body street-style fashion photography, natural daylight, 35mm film aesthetic, muted low-saturation film grade, higher contrast, candid mid-stride, faceless cropped below the eyes, no realistic recognizable face, vertical 3:4, no text, no watermark',
  ),
  travel: buildProfile(
    'cinematic travel landscape photography, wide establishing shot, golden hour backlight, single dominant hue, natural haze, atmospheric depth, subtle film grade, tiny faceless figure for scale, vertical 3:4, no text, no watermark',
  ),
  home: buildProfile(
    'home lifestyle photography, soft natural window light, minimal high-end styling, cozy lived-in scene, shallow depth of field, warm beige and muted morandi palette, subtle wood and linen texture, no people, vertical 3:4, no text, no watermark, no logo',
  ),
  emotion: buildProfile(
    'warm healing atmospheric photography, soft window backlight, airy negative space, dreamy soft focus, muted blush and beige pastel palette, natural film grain, no people, vertical 3:4, no text, no watermark',
  ),
  career: buildProfile(
    'clean modern editorial workspace flat-lay, overhead top-down, soft daylight, muted slate and oat professional palette, generous negative space, subtle paper texture, faceless hands only, vertical 3:4, no text, no watermark',
  ),
  tech: buildProfile(
    'clean isometric diagram, minimalist flat vector illustration, tech blue and slate palette, clean geometric shapes, soft gradient background, labeled nodes and flow arrows, crisp lines, no people, vertical 3:4, no watermark',
  ),
  general: buildProfile(
    'authentic lifestyle photography, natural soft daylight, shallow depth of field, warm neutral palette, candid real-life scene, subtle film grain, no realistic recognizable face, vertical 3:4, no text, no watermark',
  ),
};

/** 按品类取风格档；未知/缺失回落安全兜底档 general（绝不 brick）。 */
export function resolveStyleProfile(category: string | null | undefined): StyleProfile {
  const key =
    category && (IMAGE_CATEGORIES as readonly string[]).includes(category)
      ? (category as ImageCategory)
      : 'general';
  return STYLE_PROFILES[key];
}

/**
 * 品类判定 prompt（发布侧独立分类角色用）。读标题 + 正文，从固定品类枚举选一个 category。
 * 单一职责（不干别的）→ 分类更准；flash 模型即可。输出 JSON {category}。
 */
export function buildCategoryClassifierPrompt(title: string, body: string): string {
  const preview = body.slice(0, 500);
  return [
    '你是小红书内容品类分类器。读下面的标题与正文，判断它最贴合哪一个内容品类，只输出该品类的英文 key。',
    '',
    '【可选品类（只能选其一，输出 key）】',
    '- knowledge：干货/知识/教程/科普/清单',
    '- beauty：美妆/护肤/试色/妆容',
    '- food：美食/探店/食谱/饮品',
    '- fashion：穿搭/OOTD/单品/时尚',
    '- travel：旅行/攻略/风景/目的地',
    '- home：家居/好物/收纳/家装',
    '- emotion：情感/治愈/读书/成长感悟/心情',
    '- career：职场/工作/效率/成长干货',
    '- tech：技术/编程/AI/数据/示意图类',
    '- general：都不明显贴合时的兜底（通用生活方式）',
    '',
    '【标题】',
    title,
    '',
    '【正文前 500 字】',
    preview,
    '',
    '【输出要求】',
    '严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏。格式：',
    '{"category": "food"}',
  ].join('\n');
}

/** 配图张数上限（硬夹 ≤9，小红书图文帖硬约束；env AIDCP_PUBLISH_MAX_IMAGES 只在角色侧再夹一次）。 */
export const IMAGE_COUNT_HARD_MAX = 9;

/**
 * ImageSetPlanner prompt — 图集选题（读正文决定张数 + 每张主题 + 风格倾向）。
 * 纯内容决策：只产「要不要图 / 几张 / 每张画什么主体（业务语言）」，不产万相 prompt、不碰图源。
 * 输出 JSON: { wantImage, imageCount, themes:[{subject,intent}], styleHint }
 */
export function buildImageSetPlanPrompt(createdContent: CreatedContent, maxImages: number): string {
  const contentPreview = createdContent.content.slice(0, 400);
  const cap = Math.max(1, Math.min(maxImages, IMAGE_COUNT_HARD_MAX));

  return [
    '你是一个小红书图文帖的配图选题师。读文章标题与正文，决定这篇帖子配几张图、每张图分别画什么主体，让图文形成叙事递进。',
    '',
    '【文章标题】',
    createdContent.title,
    '',
    '【正文前 400 字】',
    contentPreview,
    '',
    '【文风类型】',
    `tone: ${createdContent.tone}`,
    '',
    '【选题要求】',
    `- imageCount: 建议 ${Math.min(3, cap)} 张左右，范围 1~${cap}（不得为 0；内容确实单薄可只 1 张）。`,
    '- themes: 与 imageCount 等长的数组，每项一个主体（如「整体架构示意」「踩坑前后对比」「实际使用场景」），第 0 张是最抓眼的钩子图/封面。',
    '- subject 用中文业务语言描述画面主体（不要写英文 prompt、不要写风格词——风格由系统统一注入）。',
    '- intent（可选）：这张图想传达的要点，给后续生成更多上下文。',
    '- styleHint（可选）：整体风格倾向的中文描述（如「科技扁平」「手绘温暖」），供参考，可省。',
    '- 主体之间应有区分、共同服务于文章叙事；不要重复同一画面。',
    '',
    '【输出要求】',
    '严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏。格式如下：',
    '{"wantImage": true, "imageCount": 3, "themes": [{"subject": "整体架构示意", "intent": "让读者先看到全貌"}, {"subject": "踩坑前后对比"}, {"subject": "实际部署场景"}], "styleHint": "科技扁平"}',
  ].join('\n');
}

/**
 * ImagePromptComposer prompt — 把「一张图的主题」翻成一条万相文生图 prompt（英文主体描述）。
 * 只产主体描述；风格基底由系统在 composer 角色侧拼接（IMAGE_STYLE_BASE），不让 LLM 产风格/负向词。
 * 输出 JSON: { imagePrompt, imageStyle }
 */
export function buildImagePromptComposerPrompt(theme: { subject: string; intent?: string }, styleHint: string | null): string {
  return [
    '你是文生图 prompt 工程师。把下面这张配图的中文主题，写成一句【中文】画面主体描述——只描述"画什么"（主体 + 一个正在发生的动作/使用场景 + 环境），不要写风格、不要写画质词、不要写 no text 之类负向约束（这些系统会按内容品类统一补）。保留中文、不要翻成英文（图像模型原生支持中文、更贴中文语境）。',
    '',
    '【这张图的主题】',
    `主体：${theme.subject}`,
    ...(theme.intent ? [`要点：${theme.intent}`] : []),
    ...(styleHint ? [`整体风格倾向（参考，可忽略）：${styleHint}`] : []),
    '',
    '【要求】',
    '- imagePrompt: 一句中文，描述画面主体、动作/场景与构图，与主题强相关；不含任何文字/水印/真人正脸。',
    '',
    '【输出要求】',
    '严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏。格式如下：',
    '{"imagePrompt": "一碗热气腾腾的番茄牛腩面摆在原木餐桌上，斜上方45度俯拍，撒着葱花"}',
  ].join('\n');
}

// ─── ContentAssembler ────────────────────────────────────────────────────────

/**
 * 「内容价值」维度按品类切子标准（change category-adaptive-images-and-judgment）：
 * 不再单一「有无硬信息」，否则系统性压低情感/审美/生活/图片流类正当内容。
 */
const QUALITY_VALUE_HINTS: Record<ImageCategory, string> = {
  knowledge: '信息量、实用性、可操作性（是否学到具体、能照着做）',
  career: '信息量、实用性、可操作性（对成长/工作是否真有用）',
  tech: '信息量、准确性、实用性',
  emotion: '共鸣、真实体验、情绪真挚度（不苛求硬信息/数据）',
  beauty: '种草力、真实使用体验、质感呈现（不苛求硬信息）',
  fashion: '搭配灵感、种草力、画面感（不苛求硬信息）',
  food: '食欲感、真实探店/试做体验、画面感（不苛求硬信息）',
  travel: '氛围感、目的地吸引力、真实体验（不苛求硬信息）',
  home: '生活美感、种草力、真实体验（不苛求硬信息）',
  general: '综合内容价值：视内容取信息量 或 共鸣/画面感/真实体验',
};

/**
 * ContentAssembler prompt — 质量评审（change category-adaptive-images-and-judgment：接人设 + 品类自适应维度）。
 * 输出 JSON: { qualityScore, issues, suggestions }。
 * 红线：只改「打分口味」——不改 gatekeeper 放行阈值、不改 QualityScorer 降级公式（AC-PUB，在角色侧）。
 */
export function buildAssemblerPrompt(
  content: CreatedContent,
  postProcessResult: { aiScore: number; flaggedPhrases: string[]; rewritten: boolean },
  soul: Soul | null,
  category: ImageCategory,
): string {
  const banned = BANNED_PHRASES.map((p) => `「${p}」`).join('、');
  const valueHint = QUALITY_VALUE_HINTS[category] ?? QUALITY_VALUE_HINTS.general;
  const personaBlock = soul
    ? [
        '【账号人设（评审须贴合其声音与领域，勿以「不像技术/干货」压分）】',
        `角色定位: ${soul.identity.role}`,
        `语气: ${soul.identity.tone}`,
        `兴趣领域: ${soul.interests.primary.length ? soul.interests.primary.join('、') : '（未填）'}`,
        '',
      ]
    : [];

  return [
    '你是一个内容质量评审员。你的任务是评估一篇小红书笔记的整体质量，综合内容本身和后处理检测结果给出评分。评分须贴合该账号人设与本帖品类，MUST NOT 用单一「干货/信息密度」口味评判所有内容。',
    '',
    ...personaBlock,
    `【本帖品类】${category}`,
    '',
    '【待评审内容】',
    `标题: ${content.title}`,
    `正文: ${content.content}`,
    `标签: ${content.tags.join(', ')}`,
    `文风: ${content.tone}`,
    '',
    '【后处理检测结果】',
    `- AI 味浓度评分: ${postProcessResult.aiScore.toFixed(2)}（0=无AI味, 1=很浓）`,
    `- 命中禁用词: ${postProcessResult.flaggedPhrases.length > 0 ? postProcessResult.flaggedPhrases.map((p) => `「${p}」`).join('、') : '无'}`,
    `- 是否经过重写: ${postProcessResult.rewritten ? '是' : '否'}`,
    '',
    '【禁用词完整列表（参考）】',
    banned,
    '',
    '【评分维度】',
    '- 真实感（是否贴合该账号人设声音、像这个人真写的，而非通用 AI 腔）: 0-25分',
    `- 内容价值（按本帖品类看：${valueHint}）: 0-25分`,
    '- 可读性（结构、语言流畅度）: 0-25分',
    '- 话题性（是否有吸引力、能引发讨论/共鸣）: 0-25分',
    '- 如果 aiScore > 0.5 或命中禁用词 > 2 个，总分上限 60',
    '',
    '【输出要求】',
    '严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏。格式如下：',
    '{"qualityScore": 0-100, "issues": ["问题1","问题2"], "suggestions": ["建议1","建议2"]}',
    '',
    '示例输出：',
    '{"qualityScore": 78, "issues": ["开头稍显平淡","个人体验可以再具体一点"], "suggestions": ["开头改为直接抛出场景或痛点","补充一处你自己的真实细节/感受"]}',
  ].join('\n');
}

// ─── ApprovalGatekeeper ──────────────────────────────────────────────────────

/**
 * ApprovalGatekeeper prompt — 审批决策
 * 输出 JSON: { needsApproval, recommendedAction, reason }
 */
export function buildGatekeeperPrompt(assembled: AssembledContent): string {
  return [
    '你是一个发布审批决策者。根据内容的 AI 味评分、质量评分和禁用词命中情况，决定这篇帖子是否可以自动发布、需要人工审批、还是应该拒绝。',
    '',
    '【内容概要】',
    `正文前 100 字: ${assembled.finalContent.slice(0, 100)}...`,
    `标签: ${assembled.finalTags.join(', ')}`,
    '',
    '【质量指标】',
    `- AI 味评分: ${assembled.aiScore.toFixed(2)}（0=无AI味, 1=很浓）`,
    `- 质量评分: ${assembled.qualityScore}/100`,
    `- 命中禁用词: ${assembled.flaggedPhrases.length > 0 ? assembled.flaggedPhrases.map((p) => `「${p}」`).join('、') : '无'}`,
    `- 是否经过重写: ${assembled.rewritten ? '是' : '否'}`,
    '',
    '【决策规则】',
    '- auto_publish: aiScore < 0.2 且 qualityScore >= 75 且无禁用词命中 → 自动发布',
    '- manual_review: qualityScore >= 60 但 aiScore 偏高或有少量禁用词 → 需人工审批确认',
    '- retry: qualityScore < 60 且 aiScore <= 0.6 → 建议重新生成',
    '- abort: aiScore > 0.6 且禁用词 >= 3 → 直接放弃本次发布',
    '',
    '【输出要求】',
    '严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏。格式如下：',
    '{"needsApproval": true/false, "recommendedAction": "auto_publish|manual_review|retry|abort", "reason": "决策理由"}',
    '',
    '示例输出：',
    '{"needsApproval": false, "recommendedAction": "auto_publish", "reason": "AI味极低(0.08)，质量评分82，无禁用词命中，可自动发布"}',
  ].join('\n');
}

// ─── ContentCleaner（去 AI 味重写） ──────────────────────────────────────────────

/**
 * 去 AI 味重写 prompt（change publish-prompt-preview 抽出同源；change llm-role-review-remediation 修订）。
 * 线上真用的 prompt 与后台只读预览**同一份来源**（防漂移）。
 * 输出约束是红线：重写产物会**逐字**成为发布正文，后续无任何环节能剥离前言/解释，
 * 故 MUST 显式要求只输出正文本身（模型带一句「好的，以下是重写后的内容：」就会原样发出去）。
 */
export function buildDeAiRewritePrompt(content: string, flagged: string[]): string {
  return `请重写以下内容，去除AI味过重的表达（${flagged.join('、')}），保持原意和自然口吻。\n只输出重写后的正文本身——不要任何前言、解释、标题或格式包裹，输出的第一个字就是正文的第一个字。\n\n${content}`;
}
