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

export type RoleGroup = 'browse' | 'publish';
export type LlmKind = 'text' | 'image' | 'none';

/**
 * 角色分类（change role-model-category-config，item 5/6）。
 * 扁平一层，仅服务后台查看/编辑/分类级模型默认解析；不进运行时注册表（铁律）。
 */
export type RoleCategory =
  | 'browse_judge' // 浏览·判定类（确定性结构化输出，不调温度）
  | 'browse_compose' // 浏览·撰写改写类（生成/改写，可调温度）
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
  { categoryId: 'publish_create', displayName: '发布 · 创作类', order: 3 },
  { categoryId: 'publish_gate', displayName: '发布 · 裁决类', order: 4 },
  { categoryId: 'image', displayName: '图像类', order: 5 },
];

/**
 * 现役且真调大模型的角色白名单。
 * 浏览侧文本角色经 BaseRole.decide() 调用；发布侧文本角色经各自 llmClient.chat() 调用；
 * 发布配图执行为图像模型（imageModel 全局配置，本期不在此 per-role 覆盖，仅列出以区分类型）。
 */
export const ROLE_CATALOG: RoleCatalogItem[] = [
  // —— 浏览闭环（文本，经 BaseRole.decide → llm.complete）——
  { roleId: 'browse:content_curator', displayName: '详情页内容粗筛', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:content_evaluator', displayName: '列表页卡片择选', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:search_evaluator', displayName: '搜索关键词决策', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:interaction_appraiser', displayName: '点赞收藏判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:follow_agent', displayName: '关注博主判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:author_evaluator', displayName: '是否进主页评估', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:comment_appraiser', displayName: '是否值得评论判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:comment_composer', displayName: '评论文案撰写', group: 'browse', category: 'browse_compose', llmKind: 'text', tunableTemperature: true },
  { roleId: 'browse:comment_reviewer', displayName: '是否翻评论区判定', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  { roleId: 'browse:comment_de_ai_flavor', displayName: '评论去 AI 味改写', group: 'browse', category: 'browse_compose', llmKind: 'text', tunableTemperature: true },
  { roleId: 'browse:concept_extractor', displayName: '技术概念关键词抽取', group: 'browse', category: 'browse_judge', llmKind: 'text', tunableTemperature: false },
  // —— 发布管线（文本，经 llmClient.chat）——
  { roleId: 'publish:ContentScout', displayName: '发布选题侦察', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: false },
  { roleId: 'publish:ContentCreator', displayName: '技术帖文案创作', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:TitleCreator', displayName: '技术帖标题创作', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:ImagePlanner', displayName: '配图策略规划', group: 'publish', category: 'publish_create', llmKind: 'text', tunableTemperature: true },
  { roleId: 'publish:QualityScorer', displayName: '内容质量评分', group: 'publish', category: 'publish_gate', llmKind: 'text', tunableTemperature: false },
  { roleId: 'publish:ApprovalGatekeeper', displayName: '发布审批裁决', group: 'publish', category: 'publish_gate', llmKind: 'text', tunableTemperature: false },
  // —— 发布配图执行（图像，imageModel 全局配置；本期不开放 per-role 覆盖，列出仅为区分类型）——
  { roleId: 'publish:ImageGenerator', displayName: '配图生成执行', group: 'publish', category: 'image', llmKind: 'image', tunableTemperature: false },
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
