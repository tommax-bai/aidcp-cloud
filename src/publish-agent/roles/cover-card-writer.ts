import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineContext } from '../pipeline-context.js';
import type {
  PipelineFields,
  CoverCardPlan,
  CoverCardCopy,
  CoverCardGateReason,
  SensedCoverForm,
  ReferenceImageSnapshot,
} from '../types.js';
import { buildCoverCardCopyPrompt } from '../prompts.js';
import { detectBannedPhrases } from '../post-processor.js';
import type { ChatLlmClient } from '../../llm/qwen.js';
import type { CoverFormSensor, CoverFormSenseResult } from '../cover-form-sensor.js';

/**
 * CoverCardWriter — 封面形态决策 + 卡面文案（change textcard-cover-form）。
 * waitAll [createdContent, postCategory]，与图集选题并行；恒写 coverCardPlan
 * （下游 ImagePromptComposer 对三键 waitAll，这一键缺失会挂死流水线——沿 CategoryClassifier 恒写先例）。
 *
 * 内部门禁序（design D6，含评审修正）：
 *   参照图存在 → 感知（**仅由感知旗标门控、独立于渲染旗标**——影子模式在此完成注解落库）
 *   → 渲染旗标 → 形态与置信 → 渲染出口/OSS 可用 → 全过才调一次文案 LLM。
 * 红线：
 * - 任一门禁不过 = 零文案 LLM 调用、写生成式兜底并如实记 gateReason；缺失/失败绝不猜 text_card。
 * - 文案 prompt 只喂洗稿产物（原文只在产后校验做重叠比对、不进生成上下文——防搬运）。
 * - 违规重试一次且只花角色闸剩余预算（评审修正：不做第二次全额调用，防顶爆流水线总闸）。
 */

// 角色闸 ≈ 感知 30s + 一次文案 ≤180s + 余量（评审修正：预算显式化，重试只花剩余）。
const COVERCARD_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_COVERCARD_TIMEOUT_MS ?? 240_000);
const COPY_CALL_TIMEOUT_MS = Number(process.env.AIDCP_COVERCARD_COPY_TIMEOUT_MS ?? 180_000);
const DEFAULT_MIN_CONFIDENCE = 0.75;
/** 重试至少要有这么多剩余预算才发起（低于此直接回落，不赌尾部）。 */
const RETRY_MIN_BUDGET_MS = 20_000;
/** 与原文逐字重叠的违规窗口（连续字符数）。 */
const OVERLAP_WINDOW = 12;

/** 引流/促销/平台词闸（叠加在既有 BANNED_PHRASES 之上；命中即违规重试）。 */
const CARD_EXTRA_BANNED = [
  '微信',
  'vx',
  'VX',
  'weixin',
  'QQ',
  'qq群',
  '加群',
  '私信我',
  '加我',
  '扫码',
  '二维码',
  '优惠',
  '促销',
  '折扣',
  '低价',
  '¥',
  '￥',
  '小红书',
  '抖音',
  '快手',
  '微博',
];

export interface CoverCardWriterDeps {
  llmClient: ChatLlmClient;
  /** 形态感知服务；未装配（如感知代码路径整体关闭）= 感知不可用，按 unknown 处理。 */
  sensor?: CoverFormSensor | null;
  /** 渲染旗标（AIDCP_PUBLISH_TEXTCARD_COVER）；只门控决策+文案，不门控感知（影子模式）。 */
  renderEnabled?: () => boolean;
  /** 渲染出口就绪探针（工厂加载成功且字体校验过）。 */
  rendererAvailable?: () => boolean;
  /** OSS 上传器就绪（渲染字节无 provider 临时 URL 可用，缺 OSS 在门禁即关）。 */
  ossAvailable?: () => boolean;
  /** text_card 置信阈值（消费端施加；判定原样持久化在感知层）。 */
  minConfidence?: number;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface WriterInput {
  title: string;
  content: string;
  /** 洗稿产物标签（防搬运：候选标签只来自洗稿产物，绝不喂原笔记话题）。 */
  tags: string[];
}

export class CoverCardWriterRole extends BasePublishRole<WriterInput, CoverCardPlan> {
  readonly config: RoleConfig = {
    name: 'CoverCardWriter',
    watchKeys: ['createdContent', 'postCategory'],
    waitAll: true,
    timeoutMs: COVERCARD_TIMEOUT_MS,
    fallback: 'skip',
  };
  protected readonly outputKey = 'coverCardPlan' as const;
  private llmClient: ChatLlmClient;
  private sensor: CoverFormSensor | null;
  private renderEnabled: () => boolean;
  private rendererAvailable: () => boolean;
  private ossAvailable: () => boolean;
  private minConfidence: number;

  constructor(deps: CoverCardWriterDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
    this.sensor = deps.sensor ?? null;
    this.renderEnabled = deps.renderEnabled ?? (() => process.env.AIDCP_PUBLISH_TEXTCARD_COVER === 'true');
    this.rendererAvailable = deps.rendererAvailable ?? (() => false);
    this.ossAvailable = deps.ossAvailable ?? (() => false);
    this.minConfidence = deps.minConfidence ?? Number(process.env.AIDCP_COVER_FORM_MIN_CONFIDENCE ?? DEFAULT_MIN_CONFIDENCE);
  }

  protected extractInput(snapshot: Partial<PipelineFields>): WriterInput {
    const created = snapshot.createdContent!;
    return { title: created.title, content: created.content, tags: created.tags ?? [] };
  }

  protected async execute(input: WriterInput, context: PipelineContext<PipelineFields>): Promise<CoverCardPlan> {
    const startedAt = this.clock();
    const snapshot = context.snapshot();
    const referenceNote = snapshot.trigger?.generateInput?.referenceNote;
    const images: ReferenceImageSnapshot[] = referenceNote?.images ?? [];

    // 门禁 1：参照图存在（普通发布/历史空行在此诚实短路，无需第二开关）。
    if (!referenceNote || images.length === 0) {
      return this.generativePlan('no_reference_images', 'unknown', 'none');
    }

    // 门禁 2：感知——仅由感知旗标门控（sensor 内部判 disabled），独立于渲染旗标先执行。
    // 影子模式（感知开+渲染关）在这里完成注解回写与审计素材，然后才被渲染旗标闸住。
    let sensed: CoverFormSenseResult | null = null;
    if (this.sensor) {
      try {
        sensed = await this.sensor.sense({
          curatedContentId: referenceNote.curatedContentId ?? null,
          accountId: referenceNote.accountId ?? snapshot.trigger?.accountId ?? 'default',
          sourceId: referenceNote.sourceId,
          images,
        });
      } catch (err) {
        // 感知服务自身承诺不抛；此处兜底防御，绝不让感知波及发布。
        this.logger.warn(`[CoverCardWriter] 感知异常（按 unknown 处理）: ${err instanceof Error ? err.message : String(err)}`);
        sensed = null;
      }
    }
    const sensedForm: SensedCoverForm = sensed?.status === 'detected' ? sensed.guess!.form : 'unknown';
    const sensedSource: CoverCardPlan['sensedSource'] =
      sensed?.status === 'detected' ? (sensed.cached ? 'cached' : 'vision') : 'none';

    // 门禁 3：渲染旗标（只门控决策+文案；关 = 影子模式收口在此）。
    if (!this.renderEnabled()) {
      return this.generativePlan('flag_off', sensedForm, sensedSource);
    }

    // 门禁 4：形态与置信（unknown/低置信/非文字卡分别如实落原因，绝不猜）。
    if (sensed?.status !== 'detected') {
      const reason: CoverCardGateReason = sensed?.status === 'no_image' ? 'no_reference_images' : 'form_unknown';
      return this.generativePlan(reason, sensedForm, sensedSource);
    }
    if (sensed.guess!.form !== 'text_card') {
      return this.generativePlan('form_not_text_card', sensedForm, sensedSource);
    }
    if (sensed.guess!.confidence < this.minConfidence) {
      return this.generativePlan('low_confidence', sensedForm, sensedSource);
    }

    // 门禁 5：渲染出口与 OSS 上传器可用（渲染字节没有 provider 临时 URL，缺 OSS 在门禁即关）。
    if (!this.rendererAvailable() || !this.ossAvailable()) {
      return this.generativePlan('renderer_unavailable', sensedForm, sensedSource);
    }

    // 全过：一次文案 LLM；违规带紧约束重试一次（只花角色闸剩余预算）。
    // 候选标签取洗稿产物（input.tags）——原笔记话题绝不入生成上下文（防搬运）。
    const originalTitle = referenceNote.title ?? '';
    const originalBody = referenceNote.body ?? '';
    try {
      const first = await this.composeCopy(input, input.tags, false, COPY_CALL_TIMEOUT_MS);
      let violation = first ? this.findViolation(first, originalTitle, originalBody, referenceNote.author) : 'llm 输出不可解析';
      if (first && !violation) {
        return this.textCardPlan(first, sensedForm, sensedSource);
      }
      const remaining = COVERCARD_TIMEOUT_MS - (this.clock() - startedAt) - 10_000;
      if (remaining >= RETRY_MIN_BUDGET_MS) {
        this.logger.warn(`[CoverCardWriter] 卡面文案违规（${violation}），带紧约束重试一次（剩余预算 ${Math.round(remaining / 1000)}s）`);
        const second = await this.composeCopy(input, input.tags, true, Math.min(COPY_CALL_TIMEOUT_MS, remaining));
        violation = second ? this.findViolation(second, originalTitle, originalBody, referenceNote.author) : 'llm 输出不可解析';
        if (second && !violation) {
          return this.textCardPlan(second, sensedForm, sensedSource);
        }
      } else {
        this.logger.warn(`[CoverCardWriter] 剩余预算不足（<${RETRY_MIN_BUDGET_MS}ms），跳过重试直接回落生成式`);
      }
      this.logger.warn(`[CoverCardWriter] 卡面文案仍违规（${violation}），回落生成式封面`);
      return this.generativePlan('copy_llm_failed', sensedForm, sensedSource);
    } catch (err) {
      this.logger.warn(`[CoverCardWriter] 文案 LLM 失败，回落生成式: ${err instanceof Error ? err.message : String(err)}`);
      return this.generativePlan('copy_llm_failed', sensedForm, sensedSource);
    }
  }

  /** 恒写兜底（fallback 'skip' 走此；含角色闸超时/未知异常）——生成式、unknown、none，绝不猜形态。 */
  protected override getDefaultOutput(): CoverCardPlan {
    return this.generativePlan('copy_llm_failed', 'unknown', 'none');
  }

  private generativePlan(
    gateReason: CoverCardGateReason,
    sensedForm: SensedCoverForm,
    sensedSource: CoverCardPlan['sensedSource'],
  ): CoverCardPlan {
    return { coverForm: 'generative', card: null, sensedForm, sensedSource, gateReason, decidedAt: this.clock() };
  }

  private textCardPlan(
    card: CoverCardCopy,
    sensedForm: SensedCoverForm,
    sensedSource: CoverCardPlan['sensedSource'],
  ): CoverCardPlan {
    return { coverForm: 'text_card', card, sensedForm, sensedSource, gateReason: 'ok', decidedAt: this.clock() };
  }

  /** 单次文案调用 + 严格解析（核心字段缺失/类型不符 → null，绝不默认成功）。 */
  private async composeCopy(
    input: WriterInput,
    tags: string[],
    tighten: boolean,
    timeoutMs: number,
  ): Promise<CoverCardCopy | null> {
    const raw = await this.llmClient.chat(
      [
        { role: 'system', content: '你是小红书封面文案编辑。严格返回JSON。' },
        { role: 'user', content: buildCoverCardCopyPrompt(input.title, input.content, tags, tighten) },
      ],
      { timeoutMs },
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let obj: { cardTitle?: unknown; bullets?: unknown; tags?: unknown };
    try {
      obj = JSON.parse(match[0]) as typeof obj;
    } catch {
      return null;
    }
    const title = String(obj.cardTitle ?? '').trim();
    if (!title) return null;
    const bullets = (Array.isArray(obj.bullets) ? obj.bullets : [])
      .map((b) => String(b).trim())
      .filter(Boolean)
      .slice(0, 5);
    const cardTags = (Array.isArray(obj.tags) ? obj.tags : [])
      .map((t) => String(t).trim().replace(/^#/, ''))
      .filter(Boolean)
      .slice(0, 3);
    return { title, bullets, tags: cardTags };
  }

  /**
   * 产后校验（防搬运 R2）：原文可读、不入生成 prompt。
   * 返回违规描述；null = 通过。
   */
  private findViolation(card: CoverCardCopy, originalTitle: string, originalBody: string, author?: string): string | null {
    // ① 卡面标题 ≠ 原标题（去空白标点归一化后）。
    if (normalizeForCompare(card.title) === normalizeForCompare(originalTitle) && normalizeForCompare(originalTitle) !== '') {
      return '卡面标题与原标题归一化后相同';
    }
    // ② 任一文本行与原标题/正文无 ≥12 连续字符逐字重叠。
    const originalText = `${originalTitle}\n${originalBody}`;
    for (const line of [card.title, ...card.bullets]) {
      if (hasVerbatimOverlap(line, originalText, OVERLAP_WINDOW)) {
        return `与原文存在 ≥${OVERLAP_WINDOW} 连续字符逐字重叠：「${line}」`;
      }
    }
    // ③ 原作者名不得出现。
    const allText = [card.title, ...card.bullets, ...card.tags].join('\n');
    if (author && author.trim().length >= 2 && allText.includes(author.trim())) {
      return `卡面含原作者名「${author.trim()}」`;
    }
    // ④ 引流/促销/平台词 + 既有违禁词闸（感叹号阈值放宽——卡面短句允许少量）。
    const hits = detectBannedPhrases(allText, 3, CARD_EXTRA_BANNED);
    if (hits.length > 0) {
      return `命中违禁词闸：${hits.join('、')}`;
    }
    return null;
  }
}

/** 去空白与标点归一化（比对用）。 */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** line 与 original 是否存在 ≥window 连续字符逐字重叠（原文空白归一后比对）。 */
function hasVerbatimOverlap(line: string, original: string, window: number): boolean {
  const cleanLine = line.replace(/\s+/g, '');
  const cleanOriginal = original.replace(/\s+/g, '');
  if (cleanLine.length < window) return false;
  for (let i = 0; i + window <= cleanLine.length; i++) {
    if (cleanOriginal.includes(cleanLine.slice(i, i + window))) return true;
  }
  return false;
}
