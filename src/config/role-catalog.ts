/**
 * 角色目录（change console-role-model-config）。
 *
 * 把浏览侧（事件驱动角色，snake_case RoleName）与发布侧（管线角色，CamelCase RoleConfig.name）
 * 两套命名合并为统一形状，供管理后台「角色配置页」按角色配模型/温度。
 *
 * 白名单制：只列**现役且真正调用大模型**的角色——纯规则角色与 v1 遗留路径角色 MUST NOT 出现，
 * 从源头防止运营误把不调模型 / 遗留路径的角色当现役配。
 *
 * roleId 带 `browse:` / `publish:` 前缀作为统一键（与运行时解析器、role_config 表主键、面板路由参数一致）。
 * 温度仅对生成 / 改写类开放（判定类强依赖确定性结构化输出，温度高会让下游 JSON 解析变脆）。
 */

export type RoleGroup = 'browse' | 'publish' | 'interaction';
// 'vision'（change textcard-cover-form）：多模态视觉角色。v1 仅展示——模型经 env 两层解析
// （AIDCP_COVER_FORM_MODEL → 代码默认），不开面板写入（isModelConfigurable 仍只放行 text）。
export type LlmKind = 'text' | 'image' | 'vision' | 'none';

/**
 * 思考模式（change role-thinking-mode-config）。
 * 存储/解析层用 `'off' | 'on'` 表达显式覆盖；`null` = default（不干预、跟模型走，请求体零回归）。
 * 面板对外用三态字符串 `'default' | 'off' | 'on'`（`normalizeThinkingMode` 把 'default'/空/脏串归一为 null）。
 */
export type ThinkingMode = 'off' | 'on';

/** 面板对外三态（default 显式表达"不干预"）。 */
export type ThinkingModeApi = 'default' | ThinkingMode;

/** 归一：仅接受 'off' / 'on'（去空白、大小写不敏感）；其余（含 'default' / 空 / 脏串 / null）→ null（= default）。 */
export function normalizeThinkingMode(raw: string | null | undefined): ThinkingMode | null {
  const t = raw?.trim().toLowerCase();
  return t === 'off' || t === 'on' ? t : null;
}

/**
 * 面板写入校验：允许 undefined（不动）/ null / ''（清除）/ 'default' / 'off' / 'on'（大小写不敏感）；其余非法。
 * 与 `normalizeThinkingMode` 的区别：后者把脏串静默归 null，本函数用于**写路径先拒非法值**（绝不当作清除）。
 */
export function isValidThinkingModePatch(v: string | null | undefined): boolean {
  if (v === undefined || v === null) return true;
  const t = v.trim().toLowerCase();
  return t === '' || t === 'default' || t === 'off' || t === 'on';
}

/**
 * 角色分类（change role-model-category-config，item 5/6）。
 * 扁平一层，仅服务后台查看/编辑/分类级模型默认解析；不进运行时注册表（铁律）。
 */
export type RoleCategory =
  | 'browse_judge' // 浏览·判定类（确定性结构化输出，不调温度）
  | 'browse_compose' // 浏览·撰写改写类（生成/改写，可调温度）
  | 'interaction_judge' // 入站客服·意图/风险判定（专用角色，不复用主动浏览评论角色）
  | 'interaction_compose' // 入站客服·模板语义内润色
  | 'publish_create' // 发布·创作类（选题/正文/标题/配图规划）
  | 'publish_gate' // 发布·裁决类（评分/审批）
  | 'image'; // 图像类（imageModel 全局，不参与文本分类默认）

export interface RoleCatalogItem {
  /** 统一角色键（含 browse:/publish: 前缀），用于配置存储与面板路由。 */
  roleId: string;
  /** 功能性显示名（中文，给运营看；非代码标识符）。 */
  displayName: string;
  group: RoleGroup;
  /** 所属分类（稳定 key，与 category_config.category_id 一致）。 */
  category: RoleCategory;
  /** 调用的模型类型：text=文本（可配模型/温度）、image=图像（本期不开放 per-role 覆盖）、none=不调模型。 */
  llmKind: LlmKind;
  /** 是否开放温度调节（仅生成/改写类）。 */
  tunableTemperature: boolean;
}

/** 分类目录项（key + 中文显示名 + 排序）。 */
export interface CategoryCatalogItem {
  categoryId: RoleCategory;
  displayName: string;
  order: number;
}

/** 分类清单（后台分组 + 分类默认模型页用）。 */
export const CATEGORY_CATALOG: CategoryCatalogItem[] = [
  { categoryId: 'browse_judge', displayName: '浏览 · 判定类', order: 1 },
  { categoryId: 'browse_compose', displayName: '浏览 · 撰写改写类', order: 2 },
  { categoryId: 'interaction_judge', displayName: '收件箱 · 判定审核类', order: 3 },
  { categoryId: 'interaction_compose', displayName: '收件箱 · 润色类', order: 4 },
  { categoryId: 'publish_create', displayName: '发布 · 生成规划类', order: 5 },
  { categoryId: 'publish_gate', displayName: '发布 · 分析评审类', order: 6 },
  { categoryId: 'image', displayName: '图像类', order: 7 },
];

/**
 * 现役且真调大模型的角色白名单。
 * 浏览侧文本角色经 BaseRole.decide() 调用；发布侧文本角色经各自 llmClient.chat() 调用；
 * 发布配图执行为图像模型（imageModel 全局配置，本期不在此 per-role 覆盖，仅列出以区分类型）。
 */
export const ROLE_CATALOG: RoleCatalogItem[] = [
  // 冻结 interaction v1 的三个专用角色 ID。这里保持原名，不套 browse/publish 前缀，
  // 使 role_config、用量归账与 Session 00 contract 使用同一个稳定标识。
  { roleId: 'reply_intent_classifier', displayName: '收件箱 · 意图分类', group: 'interaction', category: 'interaction_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'reply_polisher', displayName: '收件箱 · 模板润色', group: 'interaction', category: 'interaction_compose', llmKind: 'text', tunableTemperature: true },
  { roleId: 'reply_risk_reviewer', displayName: '收件箱 · 回复风险复核', group: 'interaction', category: 'interaction_judge', llmKind: 'text', tunableTemperature: false },
  // 数组序 = 用户访问小红书的先后（浏览闭环真实触发链路：见 role-dispatcher + 各 agent 订阅的事件）。
  // 后台「角色配置页」按此数组序渲染（API 原样透出、前端不再重排）。分类（category）仅作行内标签、
  // 不再是排序键——「判定类」贯穿整个浏览流程、与访问顺序天然冲突，故取访问顺序、分类降级为标签。
  // 发布段按 PipelineContext 的 watch/output 依赖链排（非线性硬编码序列）。
  //
  // —— 浏览闭环（文本，经 BaseRole.decide → llm.complete）——
  // A. 进信息流 / 列表页
  { roleId: 'browse:content_evaluator', displayName: '列表页卡片择选', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:search_evaluator', displayName: '搜索关键词决策', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  // B. 点开笔记·读正文（三者同订阅 note.detail.arrived：content_curator 为主闸，另两为 fire-and-forget 旁路）
  { roleId: 'browse:content_curator', displayName: '详情页内容粗筛', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:concept_extractor', displayName: '笔记关键词抽取', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false }, // 仅概念池可用时注册
  { roleId: 'browse:curated_note_evaluator', displayName: '精选准入·正文评估', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false }, // 仅精选库可用时注册
  { roleId: 'browse:text_card_transcriber', displayName: '精选准入·文字卡转写（模型经 env 配置）', group: 'browse', category: 'browse_judge', llmKind: 'vision', tunableTemperature: false },
  // C. 翻评论区（看别人评论）
  { roleId: 'browse:comment_reviewer', displayName: '是否翻评论区判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:curated_comment_evaluator', displayName: '精选准入·评论评估', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false }, // 仅评论点赞+精选库时注册
  { roleId: 'browse:comment_like_appraiser', displayName: '评论点赞择选', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:facebook_group_join_judge', displayName: 'Facebook 加群门槛判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  // D. 点赞 / 收藏
  { roleId: 'browse:interaction_appraiser', displayName: '点赞收藏判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  // D2. 阅读后写作旁路（不阻塞互动/返回信息流；仅发布链路可用时注册）
  // E. 自己发评论（点赞收藏后才进入的支线）
  { roleId: 'browse:comment_appraiser', displayName: '是否值得评论判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:comment_composer', displayName: '评论文案撰写', group: 'browse', category: 'browse_compose', llmKind: 'text', tunableTemperature: true },
  { roleId: 'browse:comment_de_ai_flavor', displayName: '评论去 AI 味改写', group: 'browse', category: 'browse_compose', llmKind: 'text', tunableTemperature: true },
  // Facebook 定向评论的既有运行时 roleId 没有 browse: 前缀；保持稳定键，避免用量归账与模型覆盖静默换键。
  { roleId: 'facebook_comment_composer', displayName: 'Facebook 定向评论撰写', group: 'browse', category: 'browse_compose', llmKind: 'text', tunableTemperature: true },
  // F. 逛作者主页
  { roleId: 'browse:author_evaluator', displayName: '是否进主页评估', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:follow_agent', displayName: '关注博主判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  // G. 独立命令式评论任务（change comment-search-command，飞书 /comment）：不在日常浏览闭环内，命令式调用、单列于末。
  { roleId: 'browse:comment_search_term_generator', displayName: '评论·搜索词生成', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:comment_target_picker', displayName: '评论·搜索笔记甄选', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  // H. 建号自助人设生成（change edge-persona-keyword-generation）：客户端 onboarding 关键词驱动，命令式、单列；创作类可调温度以增人设区分度。
  { roleId: 'browse:persona_generator', displayName: '建号·人设生成', group: 'browse', category: 'browse_compose', llmKind: 'text', tunableTemperature: true },
  // —— 发布管线（文本，经 llmClient.chat；顺序 = PipelineContext watch/output 依赖链）——
  { roleId: 'publish:ContentScout', displayName: '发布选题侦察', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: false },
  { roleId: 'publish:ContentCreator', displayName: '笔记正文创作', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:ReferenceAnalyzer', displayName: '保真洗稿·原稿分析', group: 'publish', category: 'publish_gate', llmKind: 'text', tunableTemperature: false },
  { roleId: 'publish:FaithfulRewritePlanner', displayName: '保真洗稿·改写规划', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: false },
  { roleId: 'publish:FaithfulDraftWriter', displayName: '保真洗稿·正文改写', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:FidelityAuditor', displayName: '保真洗稿·忠实度审核', group: 'publish', category: 'publish_gate', llmKind: 'text', tunableTemperature: false },
  // 配图分支（createdContent 后分叉）：选题 → 指令 → 生成
  { roleId: 'publish:CategoryClassifier', displayName: '配图品类判定', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: false },
  // change textcard-cover-form：封面形态感知（vision，模型经 env 配置、面板只读展示）+ 文字卡文案（text，可配模型）。
  { roleId: 'publish:CoverFormSensor', displayName: '封面形态感知（模型经 env 配置）', group: 'publish', category: 'publish_create', llmKind: 'vision', tunableTemperature: false },
  { roleId: 'publish:VisualReferenceAnalyzer', displayName: '整组视觉反推（模型经 env 配置）', group: 'publish', category: 'publish_create', llmKind: 'vision', tunableTemperature: false },
  { roleId: 'publish:VisualFidelityAuditor', displayName: '配图视觉保真审核（模型经 env 配置）', group: 'publish', category: 'publish_gate', llmKind: 'vision', tunableTemperature: false },
  { roleId: 'publish:CoverCardWriter', displayName: '封面文字卡文案', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:ImageSetPlanner', displayName: '配图选题（张数+主题）', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:ImagePromptComposer', displayName: '配图指令（主题→万相prompt）', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  // 质量分支（与配图分支并行，数据先就绪）：先去 AI 味清洗（ContentCleaner 经注入 PostProcessor）→ 再质量评分
  { roleId: 'publish:ContentCleaner', displayName: '正文去 AI 味改写', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:QualityScorer', displayName: '内容质量评分', group: 'publish', category: 'publish_gate', llmKind: 'text', tunableTemperature: false },
  // 发布配图执行（图像，imageModel 全局配置；本期不开放 per-role 覆盖，列出仅为区分类型）
  { roleId: 'publish:ImageGenerator', displayName: '配图生成执行', group: 'publish', category: 'image', llmKind: 'image', tunableTemperature: false },
  // 汇合后出稿 / 审批（TitleCreator 与 ApprovalGatekeeper 同 watch assembledContent，为发布执行前最后两步）
  { roleId: 'publish:TitleCreator', displayName: '笔记标题创作', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  // change split-topic-roles：话题生成（依定稿正文召回候选）+ 话题评判（相关性/质量精排、只筛不加）。
  { roleId: 'publish:TopicGenerator', displayName: '话题生成（依定稿）', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:TopicEvaluator', displayName: '话题相关性评判', group: 'publish', category: 'publish_gate', llmKind: 'text', tunableTemperature: false },
  { roleId: 'publish:ApprovalGatekeeper', displayName: '发布审批裁决', group: 'publish', category: 'publish_gate', llmKind: 'text', tunableTemperature: false },
];

const BY_ID = new Map(ROLE_CATALOG.map((r) => [r.roleId, r]));
const CATEGORY_BY_ID = new Map(CATEGORY_CATALOG.map((c) => [c.categoryId, c]));

/** 是否在白名单内（面板写校验用）。 */
export function isKnownRole(roleId: string): boolean {
  return BY_ID.has(roleId);
}

/** 取目录项（含可调温度标记）。 */
export function getCatalogItem(roleId: string): RoleCatalogItem | undefined {
  return BY_ID.get(roleId);
}

/** 该角色是否可按角色覆盖模型（文本类可，图像/none 不可）。 */
export function isModelConfigurable(roleId: string): boolean {
  const item = BY_ID.get(roleId);
  return !!item && item.llmKind === 'text';
}

// ── 分类（change role-model-category-config）────────────────────────────────────

/** 取角色所属分类（未知角色返回 undefined）。 */
export function categoryOf(roleId: string): RoleCategory | undefined {
  return BY_ID.get(roleId)?.category;
}

/** 该分类下的角色（保持 ROLE_CATALOG 原序）。 */
export function rolesInCategory(categoryId: string): RoleCatalogItem[] {
  return ROLE_CATALOG.filter((r) => r.category === categoryId);
}

/** 是否已知分类（面板写校验用；白名单制，类比 isKnownRole）。 */
export function isKnownCategory(categoryId: string): boolean {
  return CATEGORY_BY_ID.has(categoryId as RoleCategory);
}

/**
 * 该分类是否可设文本模型默认（含 ≥1 个文本角色才可）。
 * 纯图像分类（image）不参与文本分类默认 —— 图像走全局 imageModel。
 */
export function isCategoryModelConfigurable(categoryId: string): boolean {
  return isKnownCategory(categoryId) && rolesInCategory(categoryId).some((r) => r.llmKind === 'text');
}
