import type { Soul } from '../soul/types.js';
import type { CuratedReferenceImageFormGuess } from '../cache/curated-content-store.js';
import type { ContentScheduleApprovalMode } from '../config/content-schedule-store.js';
import type { PlatformId } from '../platform/index.js';

// ─── 从 publish/types.ts 迁移的类型 ────────────────────────────────────────────

/** 一个已积累的领域/话题概念（concepts 表的投影）。 */
export interface Concept {
  /** 概念关键词 */
  keyword: string;
  /** 来源笔记标题（可空） */
  sourceNote?: string;
  /** 发现时间（毫秒时间戳，可空） */
  discoveredAt?: number;
}

/** 一条点赞过的笔记摘要（供生成内容时引用真实细节）。 */
export interface LikedNote {
  /** 点赞记录 id（用于回填 source_liked_ids） */
  id: number;
  /** 笔记标题 */
  title: string;
  /** 正文摘要 */
  summary: string;
  /** 作者（可空） */
  author?: string;
}

/** 去 AI 味后处理结果。 */
export interface PostProcessResult {
  /** 处理后的正文（可能被重写） */
  content: string;
  /** 0-1，AI 味浓度评分（命中禁用词越多越高） */
  aiScore: number;
  /** 是否触发了重写 */
  rewritten: boolean;
  /** 命中的禁用词/句式 */
  flaggedPhrases: string[];
}

/**
 * 发布记录状态。
 * `pending_approval`（change decouple-publish-generation-from-dispatch）：终稿已生成、落库待人审、尚未下发。
 * 生成候审段产出即此态；人审授权 → 下发段（→ published/failed），运营显式否决 → needs_review（终态、不下发）。
 * 取消审批超时后此态可无限期停留，绝不超时自毁/改判/自动发布（AC-PUB）。
 */
export type PublishStatus = 'draft' | 'pending_approval' | 'published' | 'failed' | 'needs_review';

/** 单条参照洗稿来稿快照（publish-reference-source-panel）：供发布历史审计与后台查看，触发时冻结。 */
export interface PublishSourceReference {
  kind: 'curated_reference';
  curatedContentId: number | null;
  accountId: string;
  sourceId: string;
  title: string | null;
  body: string | null;
  author: string | null;
  topics: string[];
  sourceUrl: string | null;
  capturedAt: number;
}

/** 一条发布记录（publish_log 表的投影）。 */
export interface ReferenceImageSnapshot {
  index: number;
  sourceUrl: string;
  ossUrl?: string;
  width?: number;
  height?: number;
  alt?: string;
  captureStatus?: 'stored' | 'url_only' | 'fetch_failed' | 'unsupported';
  capturedAt?: number;
  /** 封面形态感知注解（change textcard-cover-form）：detectedFor === capturedAt 才算缓存命中（零 TTL 锚）。 */
  formGuess?: CuratedReferenceImageFormGuess;
}

export interface PublishRecord {
  id?: number;
  title: string | null;
  content: string;
  /** 引用的概念关键词 */
  sourceConcepts: string[];
  /** 引用的点赞内容 id */
  sourceLikedIds: number[];
  status: PublishStatus;
  /** 发布成功后回填的平台帖子 id */
  platformPostId?: string | null;
  /** 生成的配图封面 URL（审计用 = imageUrls[0]；是否真附着以 imagesAttachedCount 为准）。 */
  imageUrl?: string | null;
  /** 多图：全部成功配图 URL（迁移 0017 复活 publish_log.images 列）。 */
  imageUrls?: string[];
  /** 配图是否真实附着到帖子。降级纯文字时为 false——「该帖是否真有图」的权威信号（= imagesAttachedCount>0 派生）。 */
  imagesAttached?: boolean;
  /** 真实附着张数（边缘成功上传条数 K；落 publish_log.images_attached_count）。 */
  imagesAttachedCount?: number;
  /**
   * 发布账号（change publish-history-account-and-detail）。来自触发上下文（TriggerInput.accountId）；
   * 缺省回落 'default'（单账号向后兼容）。让发布历史可真正按账号区分，不再恒为 DEFAULT。
   */
  accountId?: string;
  /** Runtime platform for this publish record. Old rows/default callers are xiaohongshu. */
  platform?: PlatformId;
  /**
   * 小红书详情页分享 URL（带 xsec_token 的完整链接），发布成功后由边缘抓取回报。
   * 抓不到则为 null（诚实置空，绝不用裸 id 拼打不开的假链接）。
   */
  postUrl?: string | null;
  /** 参照洗稿来稿快照；普通发布为空，绝不编造来源。 */
  sourceReference?: PublishSourceReference | null;
}

// ─── 管道角色类型 ──────────────────────────────────────────────────────────────

/** 触发器输入度量 */
export interface TriggerInput {
  /** 排期审批模式；缺省 review，手动触发保持原有人审语义。 */
  approvalMode?: ContentScheduleApprovalMode;
  metrics: {
    hoursSinceLastPublish: number;
    newConceptCount: number;
    likedSinceLastPublish: number;
  };
  generateInput: {
    concepts: Array<{ keyword: string; sourceNote?: string; discoveredAt?: number }>;
    likedContents: Array<{ id: number; title: string; summary: string; author: string }>;
    /**
     * 精选灵感语料（change curated-inspiration-corpus）：发帖创作的正向素材来源。
     * 过门槛的高价值笔记（全文 + 赞藏数 + 机器人自有点赞/收藏标记）。缺省/空则创作回落旧点赞素材路径。
     */
    materials?: Array<{
      sourceId: string;
      title: string;
      body: string;
      author?: string;
      topics: string[];
      likeCount: number | null;
      collectCount: number | null;
      botLiked: boolean;
      botCollected: boolean;
    }>;
    /**
     * 读者角度线索（change curated-inspiration-corpus Phase 2）：精选评论 —— 高赞/优质评论反哺写帖选题。
     * 次级素材；仅供体会读者在意的角度，严禁照抄。缺省/空则不注入。
     */
    commentHints?: Array<{ text: string; author?: string; sourceNoteTitle?: string }>;
    /**
     * 保真洗稿参照笔记：管理后台从精选页人工指定的单条笔记。
     * 有参照时走 ReferenceAnalyzer -> FaithfulRewritePlanner -> FaithfulDraftWriter -> FidelityAuditor，
     * 审核通过后才写入 createdContent；不得借题扩写、解读二创或新增原稿没有的事实。
     */
    referenceNote?: {
      sourceId: string;
      title: string;
      body: string;
      topics: string[];
      author?: string;
      /** 精选行 id；非精选/阅读旁路来源可为空。 */
      curatedContentId?: number | null;
      /** 触发账号；缺省由 TriggerInput.accountId 补齐。 */
      accountId?: string;
      /** 原来源链接；可空，不用裸 sourceId 伪造链接。 */
      sourceUrl?: string | null;
      /** 触发时刻；缺省由调度器补齐。 */
      capturedAt?: number;
      /** 展示/审计用完整快照；prompt 可截断 body，但此快照保持触发时正文。 */
      sourceReference?: PublishSourceReference;
      /** Original note images as generation guidance only; never publish/reuse originals directly. */
      images?: ReferenceImageSnapshot[];
    };
    soul: Soul;
    recentPosts: string[];
  };
  recentPublished: string[];
  /** 手动 /publish 强制发布：运营明确要发（下游人审仍把闸），ContentScout 不得以「无新素材」否决。 */
  forced?: boolean;
  /**
   * 目标发布账号（change publish-history-account-and-detail）。触发时携带（飞书 /publish [accountId]），
   * 缺省 'default'。贯穿到人设解析（getSoul(accountId)）、记录落库（publish_log.account_id）、
   * 与发布命令定向下发（路由到绑定该账号的在线边缘节点）。
   */
  accountId?: string;
  /** Runtime platform of accountId. Defaults to xiaohongshu for legacy callers. */
  platform?: PlatformId;
  /**
   * Manual Feishu command source conversation for publish approval routing.
   * When present, PublishExecutor sends the approval card here before considering the default approval group.
   */
  manualApprovalChatId?: string;
}

/** ContentScout 输出 */
export interface ScoutDecision {
  shouldPublish: boolean;
  publishDirection: string;
  keyPoints: string[];
  confidence: number;
  reason: string;
  scoutedAt: number;
}

/** ContentCreator 输出 */
export interface CreatedContent {
  title: string;
  content: string;
  tags: string[];
  tone: 'professional' | 'casual' | 'technical' | 'narrative';
  style: Record<string, string>;
  createdAt: number;
}

export interface ReferenceAnalysis {
  sourceId: string;
  title: string;
  thesis: string;
  structure: string[];
  keyFacts: string[];
  keyClaims: string[];
  entities: string[];
  timeline: string[];
  mustPreserve: string[];
  forbiddenAdditions: string[];
  perspective: string;
  analyzedAt: number;
}

export interface FaithfulRewritePlan {
  titleDirection: string;
  paragraphs: Array<{ source: string; rewriteGoal: string; mustKeep: string[] }>;
  styleNotes: string[];
  forbiddenAdditions: string[];
  plannedAt: number;
}

export interface FaithfulDraft {
  title: string;
  content: string;
  tone: CreatedContent['tone'];
  style: Record<string, string>;
  draftedAt: number;
}

export interface FidelityAuditReport {
  pass: boolean;
  score: number;
  reason: string;
  issues: string[];
  unsupportedClaims: string[];
  missingKeyPoints: string[];
  auditedAt: number;
}

/** ImageGenerator 输出（多图：imageUrls 为生成成功的真实 URL 数组）。 */
export interface ImageDirective {
  imagePrompt: string | null;
  /** 生成成功的真实 URL（按规划顺序，[0]=封面位）；失败那张不入数组。绝不含伪造/占位/复用 URL（红线）。 */
  imageUrls: string[];
  /** @deprecated 单数派生兼容（= imageUrls[0] ?? null）；过渡后删。 */
  imageUrl: string | null;
  imageStyle: 'photography' | 'illustration' | 'dataviz' | 'isometric' | null;
  fallbackStrategy: 'skip' | 'color_placeholder';
  referenceImages?: ReferenceImageSnapshot[];
  referenceImageStatus?: 'none' | 'used' | 'unsupported' | 'unavailable' | 'skipped';
  /** 封面形态审计（change textcard-cover-form）：决策来源 + 门禁原因 + 渲染结局；旧路径缺省。 */
  coverFormAudit?: CoverFormAudit;
  /** Facebook 发帖 MVP：来自账号素材池的保留记录，不经过图片模型生成。 */
  facebookMediaReservation?: {
    setId: number;
    reservationId: string;
    imageIds: number[];
  };
  directedAt: number;
}

export type ReferenceImageUsageStatus = 'none' | 'used' | 'unsupported' | 'unavailable' | 'skipped';

// ─── 封面形态链路（change textcard-cover-form）：感知 → 决策/文案 → 渲染分支 ───

/** 封面产出形态决策（二值；执行结局另由 renderStatus 承载，二维正交不压一维）。 */
export type CoverForm = 'generative' | 'text_card';

/** 管线层感知结果（持久层为四值枚举；unknown 表「未感知/失败/低置信」，缺失绝不猜形态）。 */
export type SensedCoverForm = 'text_card' | 'photo' | 'illustration' | 'other' | 'unknown';

// ─── 帖级形态档（change textcard-carousel-form-parity，阶段0 影子）：封面先行 + 内页有界并发判形 → 三档 ───

/** 帖级形态档三档：generative 普通帖 / card_cover 卡封面+生图内页（现版行为）/ all_text_card 整帖文字卡。 */
export type PostFormProfile = 'generative' | 'card_cover' | 'all_text_card';

/** 帖级形态档门禁原因（穷举；每帖可回放「为什么归这档」）。 */
export type PostFormGateReason =
  | 'all_text_card'
  | 'card_cover'
  | 'generative_cover_not_card'
  | 'downgrade_inner_not_unanimous'
  | 'downgrade_unknown_or_error'
  | 'downgrade_over_cap'
  | 'carousel_copy_failed'
  | 'renderer_unavailable';

/** 单张源图形态判定（审计用；index 与参照图数组下标一致，source 记缓存命中/视觉/未判）。 */
export interface PerImageFormGuess {
  index: number;
  form: SensedCoverForm;
  source: 'cached' | 'vision' | 'none';
}

/** 帖级形态档结果（纯服务 computePostImageFormProfile 产；阶段0 只记录不改渲染）。 */
export interface PostFormProfileResult {
  profile: PostFormProfile;
  gateReason: PostFormGateReason;
  /** 逐张形态（含封面 index）；未判定/未启用为空。 */
  perImageForms: PerImageFormGuess[];
  /** 本次对内页发起的判定次数（含缓存命中）——审计成本用。 */
  innerSensed: number;
}

/** 文字卡卡面文案（只来自洗稿产物；badge 按 YAGNI 裁剪、模板侧留槽不接 LLM）。 */
export interface CoverCardCopy {
  title: string;
  /** 要点 0-5 条。 */
  bullets: string[];
  /** 标签 ≤3（不含 # 前缀）。 */
  tags: string[];
}

/** 封面形态门禁原因（每跳可回放「为什么这帖没出文字卡」）。 */
export type CoverCardGateReason =
  | 'ok'
  | 'flag_off'
  | 'no_reference_images'
  | 'form_unknown'
  | 'low_confidence'
  | 'form_not_text_card'
  | 'renderer_unavailable'
  | 'copy_llm_failed';

/** CoverCardWriter 输出（恒写键：任何失败/门禁不过都写生成式兜底，下游三键合流绝不挂死）。 */
export interface CoverCardPlan {
  coverForm: CoverForm;
  /** 仅 coverForm==='text_card' 时非 null。 */
  card: CoverCardCopy | null;
  sensedForm: SensedCoverForm;
  sensedSource: 'cached' | 'vision' | 'none';
  gateReason: CoverCardGateReason;
  decidedAt: number;
  /**
   * 帖级形态档（change textcard-carousel-form-parity，阶段0 影子）：仅 AIDCP_POST_FORM_PROFILE 开时非空。
   * 只记录不改渲染（阶段0），故与既有 coverForm/card 决策正交并列；旗标关时 undefined，保逐字节零回归。
   */
  formProfile?: PostFormProfile;
  formProfileGate?: PostFormGateReason;
  perImageForms?: PerImageFormGuess[];
  /** 阶段1 预留：整帖多卡文案（阶段0 恒不写）。 */
  cardSet?: (CoverCardCopy | null)[];
}

/** 封面渲染执行结局（诚实审计：降级用了生成图绝不标 text_card）。 */
export type CoverRenderStatus = 'not_attempted' | 'rendered' | 'render_failed_generative' | 'render_failed_none';

/** 封面形态审计（沿 referenceImageAudit 先例并列落 ImageDirective 与 publishMetadata，面板 null-safe）。 */
export interface CoverFormAudit {
  coverForm: CoverForm;
  sensedForm: SensedCoverForm;
  sensedSource: 'cached' | 'vision' | 'none';
  gateReason: CoverCardGateReason;
  renderStatus: CoverRenderStatus;
  renderMeta?: { themeKey: string; truncated: boolean; sanitized: boolean; reductions: string[] };
  /**
   * 帖级形态档影子审计（change textcard-carousel-form-parity，阶段0）：仅 AIDCP_POST_FORM_PROFILE 开时非空。
   * 面板 null-safe 解析（旧行/旗标关为 undefined）；运营据此核纯卡源稿频率与内页判定准确率。
   */
  formProfile?: PostFormProfile;
  formProfileGate?: PostFormGateReason;
  perImageForms?: PerImageFormGuess[];
  /** 轮播每槽渲染结局（change textcard-carousel-form-parity 阶段1）：仅整帖渲卡时非空；[0] 与 renderStatus 一致。 */
  cardRenderStatuses?: CoverRenderStatus[];
}

export interface ImageReferenceAudit {
  /** 原始触发输入里请求作为视觉参考的图片数。 */
  requestedCount: number;
  /** 实际有 ossUrl/sourceUrl、可传给 provider 的参考图数。 */
  usableCount: number;
  /** provider / 生成链路对参考图使用情况的真实汇总。 */
  status: ReferenceImageUsageStatus;
  /** 只有 provider 明确返回 used 时为 true；传过 URL 但 provider 不支持必须为 false。 */
  providerClaimedUsed: boolean;
  /** 本次实际生成成功的配图数量。 */
  generatedCount: number;
}

/** ContentAssembler 输出（稳定边界：阶段2 细拆后逐字不改） */
export interface AssembledContent {
  finalContent: string;
  finalTags: string[];
  /** 多图：上传全集（= coverSelection.imageUrls；[0]=封面）。供 PublishExecutor 下发 N 张上传。 */
  imageUrls: string[];
  /** @deprecated 封面单数派生（= imageUrls[0] ?? null）；审计/向后兼容，过渡后删。 */
  imageUrl: string | null;
  aiScore: number;
  qualityScore: number;
  rewritten: boolean;
  flaggedPhrases: string[];
  assembledAt: number;
}

/**
 * TitleCreator 输出（change dedicated-title-creator-role）。
 * 定稿正文之后单独生成的标题；长度已在云端收口 ≤18、字形安全（绝不切碎汉字/emoji）。
 * source 诚实标注来源：'llm'=TitleCreator 真生成；'derived'=字段意外缺失时由正文派生兜底。
 * 不带 candidates/score（YAGNI；如需 A/B 后续加字段，下游零改动）。
 */
export interface TitleSelection {
  title: string;
  source: 'llm' | 'derived';
  decidedAt: number;
}

// ─── 阶段2 生产段细拆新增中间键（A 重构 publish-content-media-roles） ──────────

/** ContentTypeSelector 输出：内容类型（现恒图文，kind 联合预留 video/text）。 */
export interface ContentType {
  kind: 'image_text' | 'video' | 'text';
  selectedAt: number;
}

/** 一张配图的主题（业务语言，由 ImageSetPlanner 产；prompt 工程据此生成万相 prompt）。 */
export interface ImageTheme {
  /** 主题（如「架构示意」「前后对比」「使用场景」）。 */
  subject: string;
  /** 意图/要点（可选，给 prompt 工程更多上下文）。 */
  intent?: string;
}

/**
 * ImageSetPlanner 输出：图集选题（读正文决定张数 + 每张主题 + 风格倾向）。
 * 纯内容决策——不产万相 prompt、不调图源（决策/执行解耦红线）。
 */
export interface ImageSetPlan {
  wantImage: boolean;
  /** 目标张数（已 clamp 到 [1, 上限≤9]；wantImage:false 时为 0）。 */
  imageCount: number;
  /** 每张主题（长度 = imageCount；[0] 为钩子图/封面位）。 */
  themes: ImageTheme[];
  /** 整体风格倾向（业务语言，供 prompt 工程参考；非最终 imageStyle 枚举）。 */
  styleHint: string | null;
  plannedAt: number;
}

/** ImagePromptComposer 输出：配图指令（每主题一条万相 prompt + 风格枚举 + 张数）。 */
export interface ImagePlan {
  wantImage: boolean;
  /** 每张的万相 prompt（各异、共享固定风格基底；[0]=封面位）。去重后恒非空（wantImage:true）。 */
  imagePrompts: string[];
  imageStyle: ImageDirective['imageStyle'];
  imageCount: number;
  fallbackStrategy: ImageDirective['fallbackStrategy'];
  referenceImages?: ReferenceImageSnapshot[];
  /**
   * 封面形态盖章透传（change textcard-cover-form）：composer 把 coverCardPlan 原样盖进计划，
   * 使配图计划仍是「唯一完整指令」——执行器只读 plan、绝不二次读环境旗标（防决策/执行裂脑）。
   * 缺省（旗标关/旧路径）= 生成式，行为与现版逐字一致。
   */
  coverForm?: CoverForm;
  coverCard?: CoverCardCopy | null;
  coverGate?: Pick<CoverCardPlan, 'sensedForm' | 'sensedSource' | 'gateReason'>;
  /**
   * 帖级形态档盖章透传（change textcard-carousel-form-parity，阶段0 影子）：composer 把 coverCardPlan 的形态档
   * 原样透传，供 ImageGenerator 并列写进 coverFormAudit。旗标关时 undefined，保配图计划逐字节零回归。
   */
  formProfile?: PostFormProfile;
  formProfileGate?: PostFormGateReason;
  perImageForms?: PerImageFormGuess[];
  /**
   * 轮播整帖多卡（change textcard-carousel-form-parity，阶段1）：仅 all_text_card + 轮播旗标开时非空。
   * cardSet[i] 非空 = 第 i 槽由文字卡渲染（cardSet[0] 兼作封面）；缺/undefined = 该槽走生成式（旗标关时恒 undefined，零回归）。
   */
  cardSet?: (CoverCardCopy | null)[];
  plannedAt: number;
}

// ─── 配图品类（change category-adaptive-images-and-judgment）：CategoryClassifier 判、配图风格档 + 质量评审消费 ───

/** 配图内容品类枚举（含安全兜底档 general）。风格档 STYLE_PROFILES 按此键控；分类器只能产出其一。 */
export const IMAGE_CATEGORIES = [
  'knowledge', // 干货/知识
  'beauty',    // 美妆/护肤
  'food',      // 美食/探店
  'fashion',   // 穿搭/OOTD
  'travel',    // 旅行
  'home',      // 家居/好物
  'emotion',   // 情感/治愈/读书
  'career',    // 职场/成长
  'tech',      // 技术/示意图
  'general',   // 兜底：通用生活方式（写实摄影）
] as const;
export type ImageCategory = (typeof IMAGE_CATEGORIES)[number];

/** 一档配图风格基底（模板常量派生，MUST NOT 由 LLM 产）：内页与封面两份，逐字复用于本帖以守帧内一致。 */
export interface StyleProfile {
  /** 图 1..N 内页风格基底。 */
  styleBase: string;
  /** 图 0 封面风格基底（同风格族 + 顶部留白供后期叠标题）。 */
  coverStyleBase: string;
}

/** CategoryClassifier 输出：本帖内容品类（一帖判一次；配图选题与质量评审复用同一值）。 */
export interface PostCategory {
  category: ImageCategory;
  classifiedAt: number;
}

/** ContentCleaner 输出：去 AI 味后处理结果（PostProcessResult + cleanedAt）。 */
export interface CleanedContent {
  content: string;
  rewritten: boolean;
  flaggedPhrases: string[];
  aiScore: number;
  cleanedAt: number;
}

/** AiFlavorScorer 输出：AI 味分（对 cleanedContent.aiScore 的显式投影）。 */
export interface AiFlavorScore {
  aiScore: number;
  scoredAt: number;
}

/** QualityScorer 输出：质量评分（LLM 评审；失败按 aiScore 公式降级）。 */
export interface QualityReport {
  qualityScore: number;
  reviewedAt: number;
}

/** CoverSelector 输出：封面选择（透传图集；封面恒取首张；无图诚实空 + hasCover:false）。 */
export interface CoverSelection {
  /** 全部成功配图（透传 imageDirective.imageUrls；[0]=封面）。 */
  imageUrls: string[];
  hasCover: boolean;
  selectedAt: number;
}

// ─── 阶段3 元数据 + 合规决策键（A 重构 publish-metadata-compliance-roles） ──────
// 纯决策（cloud）：产出但本阶段不应用到边缘（edge 应用 + 落库 + 防篡改持久化 → stage-4）。
// assembledContent 八字段逐字不动；元数据走并行 publishMetadata 键。

export type Visibility = 'public' | 'friends_only' | 'self_only';
export type PublishMode = 'immediate' | 'draft' | 'scheduled';
export type PermissionLevel = 'allow' | 'restrict' | 'disable';

/** TopicGenerator 输出：话题候选（change split-topic-roles：依定稿正文 LLM 生成，strip #/trim/去重；宁缺毋滥不编造）。 */
export interface TopicCandidates {
  candidates: string[];
  generatedAt: number;
}
/** TopicEvaluator 输出：从候选按相关性/质量/合规筛选（change split-topic-roles：只筛不加、去重、≤30，不编造凑数）。 */
export interface TopicSelection {
  selectedTopics: string[];
  selectedAt: number;
}
/** MentionStrategist 输出：@提及（去重、剔自身、≤10，无人选回 []）。 */
export interface MentionSelection {
  selectedMentions: string[];
  selectedAt: number;
}
/** LocationStrategist 输出：地点（可空，无则 null，不编造）。 */
export interface LocationSelection {
  selectedLocation: string | null;
  selectedAt: number;
}
/** CollectionStrategist 输出：合集（可空，无则 null，不编造）。 */
export interface CollectionSelection {
  selectedCollection: string | null;
  selectedAt: number;
}
/** VisibilityDecider 输出：可见范围（云端必选非 null；失败保守降 self_only，绝不隐式 public）。 */
export interface VisibilityDecision {
  visibility: Visibility;
  reason: string;
  decidedAt: number;
}
/** PermissionDecider 输出：评论/保存权限（失败保守关闭）。 */
export interface PermissionDecision {
  comment: PermissionLevel;
  save: 'allow' | 'disable';
  decidedAt: number;
}
/** PublishModeDecider 输出：发布方式（定时须未来且 ≤7 天；非定时 publishTime=null）。 */
export interface PublishModeDecision {
  mode: PublishMode;
  publishTime: number | null;
  decidedAt: number;
}
/** 合规声明（2026 硬规：含 AI 生成则强制 ai=true；aiEnforced 置位后不可降）。 */
export interface Compliance {
  ai?: boolean;
  ad?: boolean;
  origin?: boolean;
  /** AI 声明被红线强制置位（aiScore 超阈或命中关键词）；一经置位禁止降级。 */
  aiEnforced?: boolean;
}
/** ComplianceDecider 输出。 */
export interface ComplianceDecision {
  compliance: Compliance;
  decidedAt: number;
}

/** MetadataAggregator 汇合产出：发帖元数据（并行于 assembledContent，本阶段不应用到边缘）。 */
export interface PublishMetadata {
  platform?: PlatformId;
  topics: string[];
  mentions: string[];
  location: string | null;
  collection: string | null;
  /** 云端必选非 null。 */
  visibility: Visibility;
  permissions: { comment: PermissionLevel; save: 'allow' | 'disable' };
  mode: PublishMode;
  publishTime: number | null;
  compliance: Compliance;
  /** 元数据完整度 0-1（如实，缺失项计 0、不虚高）。 */
  metadataScore: number;
  /** 参照洗稿参考图是否真实被图片 provider 使用的审计；普通发布/历史行可为空。 */
  referenceImageAudit?: ImageReferenceAudit;
  /** 封面形态审计（change textcard-cover-form）；普通发布/历史行可为空。 */
  coverFormAudit?: CoverFormAudit;
  /** Facebook 发帖素材池保留信息，供下发结果回写素材状态。 */
  facebookMedia?: {
    setId: number;
    reservationId: string;
    imageIds: number[];
  };
  decidedAt: number;
}

/** 元数据保守默认（不凑数/不伪造/最保守，单一来源；各角色降级与聚合兜底共用）。 */
export const METADATA_DEFAULT_VALUES: Omit<PublishMetadata, 'decidedAt'> = {
  topics: [],
  mentions: [],
  location: null,
  collection: null,
  visibility: 'self_only',
  permissions: { comment: 'disable', save: 'disable' },
  mode: 'draft',
  publishTime: null,
  compliance: {},
  metadataScore: 0,
};

/** ApprovalGatekeeper 输出 */
export interface GateDecision {
  needsApproval: boolean;
  recommendedAction: 'auto_publish' | 'manual_review' | 'retry' | 'abort';
  reason: string;
  decidedAt: number;
}

/**
 * PublishExecutor 输出。
 * `pending_approval`（change decouple-publish-generation-from-dispatch）：生成候审段正常出口——
 * 终稿已落库并尝试发审批卡，编排到此收敛返回；真正下发由审批信号触发的下发段完成（不在本结果里）。
 */
export interface PublishResult {
  recordId: number | null;
  status: 'draft' | 'pending_approval' | 'published' | 'needs_review' | 'failed' | 'skipped';
  dispatched: boolean;
  envelope: unknown | null;
  completedAt: number;
  /**
   * 非成功收敛的可读原因（失败的异常信息 / 中止角色+理由 / 超时；跳过的诚实说明）。
   * 仅在 failed / timeout / skipped 等非正常出口填充，供上层（飞书回执）surface「为什么」，不再只给一个干瘪状态。
   */
  reason?: string;
  /** Approval card delivery attempt for pending drafts; omitted when no card should be sent. */
  approvalCard?: {
    sent: boolean;
    targetChatId?: string;
    targetSource: 'manual_source' | 'default_chat' | 'none';
    error?: string;
  };
}

/**
 * 中止信号（change dedicated-title-creator-role）。
 * 任一 `fallback:'abort'` 角色失败时由 BasePublishRole 写入；编排器据此**即时**判 failed，
 * 不再干等 pipelineTimeoutMs（修「abort 后 waitAll 上游永不写键 → 流水线挂死 18 分钟」）。
 */
export interface PipelineAbort {
  role: string;
  reason: string;
  abortedAt: number;
}

/** 管道上下文字段映射（Blackboard 的 schema） */
export interface PipelineFields {
  trigger: TriggerInput;
  scoutDecision: ScoutDecision;
  referenceAnalysis: ReferenceAnalysis;
  faithfulRewritePlan: FaithfulRewritePlan;
  faithfulDraft: FaithfulDraft;
  fidelityAuditReport: FidelityAuditReport;
  createdContent: CreatedContent;
  // 阶段2 生产段细拆中间键
  contentType: ContentType;
  // 配图品类（change category-adaptive-images-and-judgment）：CategoryClassifier 读正文判一次，配图选题 + 质量评审复用。
  postCategory: PostCategory;
  // 配图链路三角色（change publish-multi-image）：选题 → 指令 → 生成。
  imageSetPlan: ImageSetPlan;
  // 封面形态决策（change textcard-cover-form）：CoverCardWriter 恒写；composer waitAll 三键合流。
  coverCardPlan: CoverCardPlan;
  imagePlan: ImagePlan;
  cleanedContent: CleanedContent;
  aiFlavorScore: AiFlavorScore;
  qualityReport: QualityReport;
  coverSelection: CoverSelection;
  imageDirective: ImageDirective;
  assembledContent: AssembledContent;
  // 标题链路（change dedicated-title-creator-role）：定稿后由 TitleCreator 单独生成、长度收口云端。
  titleSelection: TitleSelection;
  // 话题链路（change split-topic-roles）：定稿后 TopicGenerator 生成候选 → TopicEvaluator 评判为 topicSelection。
  topicCandidates: TopicCandidates;
  // 阶段3 元数据 + 合规决策键（并行于发布链，本阶段不应用到边缘）
  topicSelection: TopicSelection;
  mentionSelection: MentionSelection;
  locationSelection: LocationSelection;
  collectionSelection: CollectionSelection;
  visibilityDecision: VisibilityDecision;
  permissionDecision: PermissionDecision;
  publishModeDecision: PublishModeDecision;
  complianceDecision: ComplianceDecision;
  publishMetadata: PublishMetadata;
  gateDecision: GateDecision;
  publishResult: PublishResult;
  /** 特殊信号：质量不达标时的重试请求 */
  retrySignal: { reason: string; attempt: number };
  /** 特殊信号：任一 abort 角色失败 → 编排器即时收敛为 failed（不再干等超时）。 */
  pipelineAbort: PipelineAbort;
}

/** 管道运行状态 */
export type PipelineStatus = 'idle' | 'running' | 'completed' | 'failed' | 'timeout';

/** 角色调用选项 */
export interface RoleInvokeOptions {
  timeoutMs?: number;
  fallbackBehavior?: 'skip' | 'abort' | 'default';
}

/**
 * PublishOrchestrator 依赖。
 * change decouple-publish-generation-from-dispatch：编排器只跑「生成候审段」（生成终稿 + 落库待审 + 发审批卡），
 * **不再让位浏览**——让位/续场（onPublishStart/onPublishEnd）已下放到下发段（PublishDispatcher）。
 * 故此处不再有让位回调；pipelineTimeoutMs 只覆盖生成本身（不再为容纳内联人审而放大）。
 */
export interface OrchestratorDeps {
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  clock?: () => number;
  idGen?: () => string;
  pipelineTimeoutMs?: number;
  /** 角色执行日志写入口（change publish-pipeline-observability）；缺省则不落库、行为不变。 */
  pipelineLogSink?: import('./publish-pipeline-log-store.js').PipelineLogSink;
}
