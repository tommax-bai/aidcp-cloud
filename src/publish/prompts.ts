/**
 * Publish Agent 的 Prompt 工程：system prompt（人设 + 风格规则 + few-shot + negative
 * examples + 输出格式）、user prompt（注入概念/点赞内容/最近帖子）、以及输出解析。
 *
 * 核心目标：去 AI 味、出人味。范文为模拟编写（非真实），关键在体现口语化、有立场、
 * 有具体细节、不完美但真实的工程师写作风格。
 */

import type { GenerateInput, GenerateOutput } from './types.js';

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
  '不得不说',
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

/** 模拟的真人高赞技术帖范文（few-shot，体现人味）。 */
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

/** 构造 system prompt（人设 + 规则 + few-shot + negative + 输出格式）。 */
export function buildSystemPrompt(): string {
  const banned = BANNED_PHRASES.map((p) => `「${p}」`).join('、');
  const encouraged = ENCOURAGED_STYLE.map((s) => `- ${s}`).join('\n');
  const fewShot = FEW_SHOT_EXAMPLES.map((e, i) => `【范文${i + 1}】\n${e}`).join('\n\n');
  const negative = NEGATIVE_EXAMPLES.map((e, i) => `【反例${i + 1}·不要这样写】\n${e}`).join('\n\n');

  return [
    '你是「小林」，一名 AI/技术方向的 R&D 工程师，3 年经验，大厂做 LLM 应用落地，关注开源和前沿论文。说话技术向、理性、偶尔幽默。',
    '你在写一篇要发到小红书的技术帖，目标是真实、有个人观点、像一个真人随手记录，而不是 AI 生成的科普文。',
    '',
    '【硬性禁止】下列词/句式绝对不能出现：' + banned + '。',
    '禁止任何排比句式（"第一…第二…第三…"、"既…又…还…"）。整篇最多出现 1 个感叹号。',
    '',
    '【鼓励的风格】',
    encouraged,
    '',
    '【内容结构】',
    '- 全文 200-500 字（小红书最佳阅读区间）。',
    '- 不要总分总，允许散漫叙述。',
    '- 开头直接抛观点或问题，不要铺垫。',
    '- 必须包含具体细节（从下面给的概念/点赞内容里提取真实信息，比如具体工具、数字、报错）。',
    '- 要有明确的个人立场和判断，不要和稀泥。',
    '',
    '【可选内容类型】读后感/评论、对比分析、踩坑记录、趋势观察——任选其一，自然展开即可。',
    '',
    '【高赞真人范文（学习这种语气）】',
    fewShot,
    '',
    '【AI 味反例（坚决不要这样写）】',
    negative,
    '',
    '【输出格式】严格只输出一个 JSON 对象，不要任何额外文字或代码块围栏：',
    '{"title": "小红书标题，20字内，可带1个emoji", "content": "正文200-500字", "tags": ["标签1","标签2","标签3"]}',
  ].join('\n');
}

/** 构造 user prompt：注入本次可用的概念、点赞内容与最近已发帖子。 */
export function buildUserPrompt(input: GenerateInput): string {
  const concepts =
    input.concepts.length > 0
      ? input.concepts.map((c) => `- ${c.keyword}${c.sourceNote ? `（来自：${c.sourceNote}）` : ''}`).join('\n')
      : '（暂无新概念）';

  const liked =
    input.likedContents.length > 0
      ? input.likedContents
          .map((n) => `- ${n.title}${n.author ? `（@${n.author}）` : ''}：${n.summary}`)
          .join('\n')
      : '（暂无点赞内容）';

  const recent =
    input.recentPosts.length > 0
      ? input.recentPosts.map((p, i) => `${i + 1}. ${p}`).join('\n')
      : '（暂无）';

  return [
    '这是你最近在小红书上积累的素材，请基于它们写一篇帖子：',
    '',
    '【最近积累的新概念】',
    concepts,
    '',
    '【最近点赞的内容（可引用其中真实细节）】',
    liked,
    '',
    '【你最近发过的帖子（避免重复话题/角度）】',
    recent,
    '',
    '现在请写这篇帖子，严格按要求的 JSON 格式输出。',
  ].join('\n');
}

/** 构造"重写"user prompt：明确告诉模型哪些禁用词命中、必须替换。 */
export function buildRewritePrompt(content: string, flaggedPhrases: string[]): string {
  const flagged = flaggedPhrases.map((p) => `「${p}」`).join('、');
  return [
    '下面这篇帖子 AI 味太重，命中了禁用词/句式：' + flagged + '。',
    '请重写，去掉这些表达，改得更口语、更像真人随手写，保留原本的观点和具体细节。',
    '正文仍控制在 200-500 字，最多 1 个感叹号，不要任何排比。',
    '',
    '【原文】',
    content,
    '',
    '严格只输出 JSON：{"title": "...", "content": "...", "tags": ["...","...","..."]}',
  ].join('\n');
}

/**
 * 解析模型输出为 GenerateOutput（容忍代码块围栏/前后多余文字）。
 * 解析失败抛错（由调用方决定降级策略）。
 */
export function parseGenerateOutput(raw: string): GenerateOutput {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('生成输出不含 JSON 对象');
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('生成输出 JSON 解析失败');
  }
  if (!obj || typeof obj !== 'object') throw new Error('生成输出不是对象');
  const o = obj as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const content = typeof o.content === 'string' ? o.content.trim() : '';
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    : [];
  if (content === '') throw new Error('生成输出缺少 content');
  return { title, content, tags };
}