/**
 * Publish Agent 多角色链 Prompt 构建函数。
 *
 * 为 ContentScout / ContentCreator / ImageDirector / ContentAssembler / ApprovalGatekeeper
 * 五个角色分别构建 prompt，每个 prompt 严格要求 JSON 输出格式。
 *
 * 人设规则、禁用词和鼓励风格均内联定义于本文件。
 */

import type {
  TriggerInput,
  ScoutDecision,
  CreatedContent,
  AssembledContent,
  ImageCategory,
  StyleProfile,
  ReferenceAnalysis,
  FaithfulRewritePlan,
  FaithfulDraft,
  ImageTheme,
} from './types.js';
import { IMAGE_CATEGORIES } from './types.js';
import { categorySafetyInstruction, formatContentVisualCategoryBrief } from './content-visual-brief.js';
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

type ReferenceNoteInput = NonNullable<TriggerInput['generateInput']['referenceNote']>;

function summarizeSoul(soul: Soul): string {
  const identity = soul.identity;
  const interests = [...(soul.interests?.primary ?? []), ...(soul.interests?.secondary ?? []), ...(soul.interests?.seed_keywords ?? [])]
    .slice(0, 12)
    .join('、');
  return [
    `账号名称：${identity?.name ?? ''}`,
    `角色定位：${identity?.role ?? ''}`,
    `背景：${identity?.background ?? ''}`,
    `语气：${identity?.tone ?? ''}`,
    `兴趣领域：${interests || '未配置'}`,
  ].join('\n');
}

function referenceNoteBlock(referenceNote: ReferenceNoteInput): string {
  return [
    `sourceId：${referenceNote.sourceId}`,
    `标题：${referenceNote.title}`,
    `作者：${referenceNote.author ?? ''}`,
    `话题：${referenceNote.topics.join('、') || '无'}`,
    '',
    '正文：',
    referenceNote.body,
  ].join('\n');
}

// ─── Faithful reference rewrite ───────────────────────────────────────────────

export function buildReferenceAnalysisPrompt(referenceNote: ReferenceNoteInput, soul: Soul): string {
  return [
    '你是“保真改写”的原稿分析员。任务是把运营指定的参照笔记拆成可核验的事实、观点与结构，供后续改写使用。',
    '',
    '红线：',
    '- 只分析原稿已经出现的信息，不补背景、不扩展行业知识、不推测作者身份。',
    '- 原稿里没有的实测数据、百分比、时间线、个人经历、项目身份，一律放入 forbiddenAdditions。',
    '- 不输出成稿，不润色，不评价是否吸引人。',
    '',
    '账号人设只用于识别后续语气边界，不得把账号经历当成原稿事实：',
    summarizeSoul(soul),
    '',
    '【参照笔记】',
    referenceNoteBlock(referenceNote),
    '',
    '严格只输出 JSON：',
    JSON.stringify(
      {
        title: '原标题',
        thesis: '原稿核心观点',
        structure: ['原稿段落结构/展开顺序'],
        keyFacts: ['原稿明确出现的事实/数据/事件'],
        keyClaims: ['原稿明确表达的判断/结论'],
        entities: ['项目/人物/机构/产品等实体'],
        timeline: ['原稿明确出现的时间点；没有则空数组'],
        mustPreserve: ['改写必须保留的关键信息'],
        forbiddenAdditions: ['不得新增的高风险信息类型'],
        perspective: '原稿叙述视角，例如项目成员/使用者/观察者/未知',
      },
      null,
      2,
    ),
  ].join('\n');
}

export function buildFaithfulRewritePlanPrompt(analysis: ReferenceAnalysis, referenceNote: ReferenceNoteInput, soul: Soul): string {
  return [
    '你是“保真改写”的结构规划员。任务是在不改变原意、不新增事实的前提下，规划一篇表达不同但信息保真的小红书笔记。',
    '',
    '必须遵守：',
    '- 只做保真改写，不做解读二创，不做借题重写。',
    '- 可以调整句式、段落顺序、开头切入和表达节奏，但不能新增原文没有的测评数据、案例、经历、身份。',
    '- 如果账号人设与原稿视角冲突，优先保留原稿事实，不把“我测了”“我参与了”“我们场景”写进计划，除非原稿已明确出现。',
    '- 规划必须覆盖 analysis.mustPreserve 的全部内容。',
    '',
    '账号人设：',
    summarizeSoul(soul),
    '',
    '【参照笔记】',
    referenceNoteBlock(referenceNote),
    '',
    '【原稿分析】',
    JSON.stringify(analysis, null, 2),
    '',
    '严格只输出 JSON：',
    JSON.stringify(
      {
        titleDirection: '标题改写方向',
        paragraphs: [
          {
            source: '对应原稿段落/信息块',
            rewriteGoal: '这一段怎样换表达但保留原意',
            mustKeep: ['本段必须保留的信息'],
          },
        ],
        styleNotes: ['口语化/节奏建议，不能引入新事实'],
        forbiddenAdditions: ['本次改写绝不能新增的信息'],
      },
      null,
      2,
    ),
  ].join('\n');
}

export function buildFaithfulDraftPrompt(
  analysis: ReferenceAnalysis,
  plan: FaithfulRewritePlan,
  referenceNote: ReferenceNoteInput,
  soul: Soul,
): string {
  return [
    '你是“保真改写”的正文写手。请按分析和计划改写参照笔记，输出一篇可发布的小红书笔记草稿。',
    '',
    '硬性边界：',
    '- 这是保真改写，不是解读二创，也不是借题重写。',
    '- 不得新增原文没有的实测结果、百分比、性能数据、公司/团队场景、个人经历、参与身份。',
    '- 不得把账号人设包装成亲历者；除非原稿明确是第一人称经历，否则用中性观察/转述口吻。',
    '- 标题和正文可以换说法，但核心观点、事实、时间线、因果关系必须与原稿一致。',
    '- 正文不要输出话题标签，话题由后续角色生成。',
    '',
    '账号人设（仅影响语气，不提供新事实）：',
    summarizeSoul(soul),
    '',
    '【参照笔记】',
    referenceNoteBlock(referenceNote),
    '',
    '【原稿分析】',
    JSON.stringify(analysis, null, 2),
    '',
    '【改写计划】',
    JSON.stringify(plan, null, 2),
    '',
    '严格只输出 JSON：',
    JSON.stringify(
      {
        title: '20字以内标题',
        content: '改写后的正文，不含话题标签',
        tone: 'casual',
        style: { rewriteMode: 'faithful' },
      },
      null,
      2,
    ),
  ].join('\n');
}

export function buildFidelityAuditPrompt(
  analysis: ReferenceAnalysis,
  plan: FaithfulRewritePlan,
  draft: FaithfulDraft,
  referenceNote: ReferenceNoteInput,
): string {
  return [
    '你是“保真改写”的忠实度审核员。请对照原稿、分析、计划和草稿，判断草稿能否进入后续发布链路。',
    '',
    '通过标准：',
    '- 草稿覆盖 analysis.mustPreserve 的关键信息。',
    '- 草稿没有新增原稿未出现的事实、数据、亲历经验、团队身份、因果判断。',
    '- 草稿与原稿表达不同，但主题、事实、观点和时间线一致。',
    '- 审核员不得放过任何原稿未出现的实测数据、亲历视角或身份包装。',
    '- 如果存在“我测了/我们场景/直接降了xx%”这类原稿没有的亲历或数据，必须不通过。',
    '',
    '【参照笔记】',
    referenceNoteBlock(referenceNote),
    '',
    '【原稿分析】',
    JSON.stringify(analysis, null, 2),
    '',
    '【改写计划】',
    JSON.stringify(plan, null, 2),
    '',
    '【草稿】',
    JSON.stringify(draft, null, 2),
    '',
    '严格只输出 JSON：',
    JSON.stringify(
      {
        pass: true,
        score: 0.92,
        reason: '通过/不通过的简短理由',
        issues: ['表达或结构问题'],
        unsupportedClaims: ['草稿新增但原稿没有的信息；没有则空数组'],
        missingKeyPoints: ['原稿关键点缺失；没有则空数组'],
      },
      null,
      2,
    ),
  ].join('\n');
}

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

  // 兼容旧调用：运行时 referenceNote 已由保真改写链处理，Scout 不再参与洗稿路径。
  const referenceNote = generateInput.referenceNote;
  const referenceBlock = referenceNote
    ? [
        '',
        '【参照笔记——保真洗稿路径】',
        `运营指定了一篇参照笔记：「${referenceNote.title}」${referenceNote.author ? `（@${referenceNote.author}）` : ''}${referenceNote.topics.length > 0 ? `，话题：${referenceNote.topics.slice(0, 6).join('、')}` : ''}。`,
        '如果本角色被旧调用路径触发，只能提炼原稿核心要点；不得引导解读二创、借题重写或新增原稿没有的事实。',
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

  // 兼容旧调用：运行时 referenceNote 已由保真改写链处理，ContentCreator 不再参与洗稿路径。
  const referenceNote = generateInput.referenceNote;
  const referenceBlock = referenceNote
    ? [
        '',
        '【参照笔记——保真洗稿（本块优先级高于上方风格建议）】',
        `标题：「${referenceNote.title}」${referenceNote.author ? `（@${referenceNote.author}）` : ''}${referenceNote.topics.length > 0 ? `｜话题：${referenceNote.topics.slice(0, 6).join('、')}` : ''}`,
        `正文节选：${referenceNote.body.replace(/\s+/g, ' ').slice(0, 1200)}`,
        '【参照使用规则】仅做保真改写：保留原稿主题、结构、事实、观点与因果关系，用不同表达重述。',
        '禁止解读二创、禁止借题扩写、禁止补充自己的经验与判断、禁止伪造亲历视角或新增原稿没有的数据。',
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

/**
 * ImageSetPlanner prompt — 图集选题（读正文决定张数 + 每张主题 + 风格倾向）。
 * 纯内容决策：只产「要不要图 / 几张 / 每张画什么主体（业务语言）」，不产万相 prompt、不碰图源。
 * 输出 JSON: { wantImage, imageCount, themes:[{subject,intent}], styleHint }
 */
export function buildImageSetPlanPrompt(createdContent: CreatedContent, maxImages: number, exactCount?: number): string {
  const contentPreview = buildContentVisualExcerpt(createdContent.content);
  const cap = Math.max(1, Math.min(maxImages, IMAGE_COUNT_HARD_MAX));
  // 洗稿场景钉死张数（对齐源稿图片数）：夹进 [1, cap]；非洗稿不传、维持内容驱动的建议区间。
  const fixed = exactCount !== undefined ? Math.max(1, Math.min(Math.floor(exactCount), cap)) : undefined;
  const countRequirement =
    fixed !== undefined
      ? `- imageCount: 本帖固定配 ${fixed} 张（对齐原稿图片数量），MUST 恰好等于 ${fixed}，不得多、不得少。`
      : `- imageCount: 建议 ${Math.min(3, cap)} 张左右，范围 1~${cap}（不得为 0；内容确实单薄可只 1 张）。`;
  const themesRequirement =
    fixed !== undefined
      ? `- themes: 必须给正好 ${fixed} 项，每项一个主体（如「整体架构示意」「踩坑前后对比」「实际使用场景」），第 0 张是最抓眼的钩子图/封面。`
      : '- themes: 与 imageCount 等长的数组，每项一个主体（如「整体架构示意」「踩坑前后对比」「实际使用场景」），第 0 张是最抓眼的钩子图/封面。';

  return [
    '你是一个小红书图文帖的配图选题师兼内容视觉导演。读文章标题与正文语义摘录，决定每张图画什么，并把正文情绪转译为可执行的画面表演，让图文形成叙事递进。',
    '',
    '【文章标题】',
    createdContent.title,
    '',
    '【正文语义摘录（短文完整；长文为首/中/尾）】',
    contentPreview,
    '',
    '【文风类型】',
    `tone: ${createdContent.tone}`,
    '',
    '【选题要求】',
    countRequirement,
    themesRequirement,
    '- subject 用中文业务语言描述画面主体（不要写英文 prompt、不要写风格词——风格由系统统一注入）。',
    '- intent（可选）：这张图想传达的要点，给后续生成更多上下文。',
    '- contentVisualBrief：每张必填公共字段。narrativeMoment 写正文叙事瞬间；emotion 写复合情绪；emotionIntensity 为 0~1；action/environment 写动作与环境；avoid 写必须避免的错位表达。',
    '- contentVisualBrief.categoryBrief：每张必须按目标画面类型填且只能选一个 kind。字段如下：',
    '  - portrait_photo：facialExpression, gazeDirection, headAngle, bodyLanguage, gesture, poseEnergy。',
    '  - text_layout：coreMessage, informationHierarchy[], emphasisTerms[], readingOrder, informationDensity, cardStructure。',
    '  - infographic_chart：claim, relationship, entities[], direction, steps[], dataPolicy；正文无可靠数字时必须明确无数值表达。',
    '  - scene_photo：timeAndWeather, location, humanPresence, eventTrace, spatialRelationship, motionLevel。',
    '  - still_life_photo：primaryObjects[], usageState, objectRelationship, lifeTrace, materialFocus, handInteraction。',
    '  - illustration_3d：coreMetaphor, characterRelationship, symbols[], motionDirection, exaggerationLevel, storyStage。',
    '  - ui_document：userTask, interfaceState, componentHierarchy[], interactionPath[], informationFocus, fidelityLabel；正文未证明的功能标为概念示意。',
    '  - collage_mixed：regions[{role,content,priority}], readingOrder, primarySecondaryRatio, continuityElements[]。',
    '- 分类字段写正文要表达的具体信息，禁止用“与正文一致”“自然”“好看”等空话代替；禁止编造正文没有的数据、产品能力、事件或物件状态。',
    '- 对情绪、访谈、成长、冲突类正文，主动避免证件照式正面端坐、标准商业微笑、僵硬直视等会抹平正文张力的姿态，除非正文明确需要。',
    '- styleHint（可选）：整体风格倾向的中文描述（如「科技扁平」「手绘温暖」），供参考，可省。',
    '- 主体之间应有区分、共同服务于文章叙事；不要重复同一画面。',
    '',
    '【输出要求】',
    '严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏。格式如下：',
    '{"wantImage":true,"imageCount":1,"themes":[{"subject":"访谈中的人物情绪瞬间","intent":"表现脆弱与行动力并存","contentVisualBrief":{"narrativeMoment":"情绪涌来后正在自我整理","emotion":"脆弱、敏感但没有崩溃","emotionIntensity":0.65,"action":"短暂停顿并缓慢呼吸","environment":"安静的深色访谈空间","categoryBrief":{"kind":"portrait_photo","facialExpression":"眉眼略有疲惫和游离，嘴角克制","gazeDirection":"轻微侧视","headAngle":"头部微侧并轻轻下沉","bodyLanguage":"肩颈放松，身体略向一侧倾斜","gesture":"手部自然放松","poseEnergy":"低唤醒但有内在行动张力"},"avoid":["证件照式正面端坐","标准商业微笑","僵硬直视镜头"]}}],"styleHint":"克制的人像摄影"}',
  ].join('\n');
}

/**
 * ImagePromptComposer prompt — 把「一张图的主题 + 正文视觉 brief」翻成一条万相中文文生图 prompt。
 * 只产主体描述；风格基底由系统在 composer 角色侧拼接（IMAGE_STYLE_BASE），不让 LLM 产风格/负向词。
 * 输出 JSON: { imagePrompt, imageStyle }
 */
export function buildImagePromptComposerPrompt(theme: ImageTheme, styleHint: string | null, referenceImageGuidance?: string | null): string {
  const brief = theme.contentVisualBrief;
  return [
    '你是文生图 prompt 工程师。把下面这张配图的中文主题和正文视觉导演 brief，写成一句【中文】画面主体描述。必须写清主体、正在发生的动作/场景；人物画面还必须落到可观察的眉眼/嘴角、视线、头部角度和肢体语言。不要写风格、画质词或通用 no-text 约束（系统另行补齐）。保留中文、不要翻成英文。',
    '',
    '【这张图的主题】',
    `主体：${theme.subject}`,
    ...(theme.intent ? [`要点：${theme.intent}`] : []),
    ...(brief ? [
      '',
      '【正文视觉导演 brief（语义与人物表演的最高优先级）】',
      `叙事瞬间：${brief.narrativeMoment}`,
      `情绪：${brief.emotion}；强度：${brief.emotionIntensity}`,
      `动作：${brief.action}`,
      `环境：${brief.environment}`,
      ...(brief.facialExpression ? [`表情：${brief.facialExpression}`] : []),
      ...(brief.gazeDirection ? [`视线：${brief.gazeDirection}`] : []),
      ...(brief.headAngle ? [`头部角度：${brief.headAngle}`] : []),
      ...(brief.bodyLanguage ? [`肢体语言：${brief.bodyLanguage}`] : []),
      ...(brief.categoryBrief ? [
        `分类语义：${formatContentVisualCategoryBrief(brief.categoryBrief)}`,
        `分类安全约束：${categorySafetyInstruction(brief.categoryBrief)}`,
      ] : []),
      ...(brief.avoid.length ? [`必须避免：${brief.avoid.join('；')}`] : []),
    ] : []),
    ...(styleHint ? [`整体风格倾向（参考，可忽略）：${styleHint}`] : []),
    ...(referenceImageGuidance ? ['', 'Reference image guidance:', referenceImageGuidance] : []),
    '',
    '【要求】',
    '- imagePrompt: 一句中文，完整落实公共 brief 与分类 brief。人物表演、文字层级、图表关系、场景事件、物件状态、插画隐喻、UI 任务或拼贴分区必须服从正文；参考图只提供形式与风格。',
    '- 若参考图的人物神态、视线、动作或姿态与正文视觉 brief 冲突，正文 brief 胜出；其他类型的文字结构、关系、事件、物件状态、隐喻、任务或分区冲突也同样以正文为准。',
    '- 人物必须是与参考人物无关的虚构主体，可以按正文需要清晰露脸，但不得对应来源真人/名人身份或保留其五官相似度，也不得保留品牌 logo 或平台标识。',
    '- 把 brief 的 avoid 转成明确的“避免……”约束写进 imagePrompt；不含画内文字或水印。',
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

// ─── 封面文字卡文案（change textcard-cover-form）：CoverCardWriter 专用 ────────────

/**
 * 卡面文案 prompt。防搬运红线：只喂洗稿后的标题/正文/标签，MUST NOT 注入原笔记任何文本
 * （原文只在产后校验器里做重叠比对、不进生成上下文）。
 * 产出会被确定性排版渲染成封面（标题+要点+标签），故约束长度与条数；违规由校验器拦、
 * 带紧约束重试一次（tighten=true），仍违规回落生成式封面。
 */
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

// ─── 轮播多卡文案（change textcard-carousel-form-parity，阶段1）：一次产 N 张卡 ─────

/**
 * 轮播文字卡文案 prompt。一次产 N 张卡：card[0]=封面钩子卡、card[1..N-1]=正文段落卡（各承一段/一个要点簇）。
 * 防搬运红线同封面卡：**只喂洗稿后的标题/正文/标签**，MUST NOT 注入原笔记任何文本
 * （原文只在产后校验做重叠比对、不进生成上下文）。每张会被确定性排版渲染成一图，故约束长度条数。
 * count = 目标卡数（对齐源稿有效图数）；LLM 自行把正文切成 N 张连贯的卡、顺序输出。
 */
export function buildCardSetPrompt(
  title: string,
  body: string,
  tags: string[],
  count: number,
  tighten = false,
): string {
  const n = Math.max(2, Math.floor(count));
  const preview = buildContentVisualExcerpt(body, 2000);
  const lines = [
    `你是小红书图文轮播的文案编辑。基于下面这篇笔记（标题+正文），产出一套 ${n} 张排版文字卡的文案，做成连贯的一篇图文轮播。`,
    '',
    '【笔记标题】',
    title,
    '',
    '【正文】',
    preview,
    '',
  ];
  if (tags.length > 0) {
    lines.push(`【候选标签】${tags.join('、')}`, '');
  }
  lines.push(
    '【要求】',
    `- 严格产出 ${n} 张卡，按封面→正文顺序输出，把正文主线切成连贯的 ${n - 1} 段承到第 2~${n} 张。`,
    '- 第 1 张=封面钩子卡：cardTitle 8~16 字、钩子感强、口语化、不照抄笔记标题；bullets 可 0~3 条点题。',
    '- 第 2 张起=正文段落卡：cardTitle 是这段的小标题（6~14 字）；bullets 1~5 条、每条 6~18 字，承载这一段的干货/步骤/要点，短句并列。',
    '- 整套卡要覆盖正文主线、各卡内容不重复、连起来读得通；只用这篇笔记本身的内容，绝不新增笔记里没有的事实。',
    '- 每张先确定本页核心结论、信息层级和重点词；整套阅读顺序必须覆盖正文开头、中段转折与结尾结论。',
    '- 信息密度匹配正文，不得用空泛大标题或装饰性留白代替正文要点。',
    '- 每张的 tags 0~3 个（不带 # 号），只能从候选标签挑或用正文核心词；某张没有清晰要点就给空数组，绝不硬凑。',
    '- 全程不出现任何联系方式/价格/促销用语/平台名/作者名；不用 emoji。',
  );
  if (tighten) {
    lines.push('- 【加严】上一版与原文重叠过多或含违规词：这次必须完全换表达方式重写，任一张逐字重复超过 8 字即不合格。');
  }
  lines.push(
    '',
    `【输出要求】严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏；cards 数组长度必须正好 ${n}：`,
    '{"cards": [{"cardTitle": "…", "bullets": ["…"], "tags": ["…"]}, …]}',
  );
  return lines.join('\n');
}
