/**
 * 封面形态感知服务（change textcard-cover-form，design D1-D4）。
 *
 * 发布时按需（read-through）：洗稿发布管线在封面形态决策消费前调用 sense()，
 * 对参照图中**第一张有可用 URL** 的图（ossUrl 优先、缺则 sourceUrl）判定封面形态
 * （排版文字卡 / 照片 / 插画 / 其他）。
 *
 * 判定顺序与红线：
 * - 旗标关（enabled() false）→ 'disabled'，零视觉调用零注解写入（影子模式下感知只由本旗标门控）。
 * - 缓存命中（item.formGuess.detectedFor === item.capturedAt，零 TTL 锚）→ 直接消费缓存，零调用。
 * - miss → **单次**视觉调用，严格 JSON 解析（form ∈ 枚举 + confidence ∈[0,1]，
 *   缺失/类型不符 → error，MUST NOT 默认成功）；输出刻意无颜色/坐标/OCR 字段（防搬运结构隔离）。
 * - error/超时 → 'error' 且**绝不持久化**（无负缓存）、绝不猜形态、绝不抛错、绝不阻断发布。
 * - 成功 → best-effort 回写素材行（annotate 单条守卫 UPDATE，锚不符弃写；失败只记日志）。
 * - 低置信**不在此过滤**：阈值（AIDCP_COVER_FORM_MIN_CONFIDENCE）在消费端施加，
 *   判定原样返回并持久化（存观测不存策略）。
 */

import {
  isCuratedCoverForm,
  type CuratedCoverForm,
  type CuratedReferenceImageFormGuess,
} from '../cache/curated-content-store.js';
import type { VisionLlmClient, VisionChatMessage } from '../llm/vision.js';
import type { ReferenceImageSnapshot } from './types.js';

/** 感知结局四态：detected（含缓存命中）/ error（调用或解析失败）/ no_image（无可用参照图）/ disabled（旗标关）。 */
export type CoverFormSenseStatus = 'detected' | 'error' | 'no_image' | 'disabled';

export interface CoverFormSenseResult {
  status: CoverFormSenseStatus;
  /** 仅 status='detected' 时给出（低置信也原样带出，阈值在消费端）。 */
  guess?: CuratedReferenceImageFormGuess;
  /** 是否命中素材行缓存（审计 sensedSource='cached'|'vision' 的依据）。 */
  cached: boolean;
  /** error/no_image 的诚实归因（人可读，供审计与日志）。 */
  detail?: string;
}

/** 感知输入：发布管线的参照来稿投影（images 数组下标须与素材行 reference_images JSONB 下标一致）。 */
export interface CoverFormSenseRef {
  /** 素材行 id；null = 无落库素材行（回写自然跳过）。 */
  curatedContentId: number | null;
  accountId: string;
  sourceId: string;
  images: ReferenceImageSnapshot[];
}

export interface CoverFormSensor {
  sense(ref: CoverFormSenseRef): Promise<CoverFormSenseResult>;
  /**
   * 判定参照图数组中**指定下标**那张的形态（change textcard-carousel-form-parity）。
   * 与 sense() 共用同一核心（缓存→视觉→严格解析→回写），红线一致（无负缓存/绝不猜/绝不抛）。
   * 该下标无可用 URL → status='no_image'。可选：旧 stub 只实现 sense() 仍合法。
   */
  senseAt?(ref: CoverFormSenseRef, arrayIndex: number): Promise<CoverFormSenseResult>;
}

/** 判定「指定下标一张」的函数型（帖级形态档服务据此判内页；与具体 sensor 解耦，便于单测注入假实现）。 */
export type SenseImageAtFn = (ref: CoverFormSenseRef, arrayIndex: number) => Promise<CoverFormSenseResult>;

export interface CoverFormSensorDeps {
  /** 多模态客户端（model/provider 已在装配处解析注入，见 vision.ts 不变量）。 */
  vision: VisionLlmClient;
  /** 感知旗标（AIDCP_COVER_FORM_SENSING 在装配处读取）；false → 零调用零写入。 */
  enabled: () => boolean;
  /** 注解回写（CuratedContentStore.annotateReferenceImageFormGuess）；缺省 = 不回写（只管线内消费）。 */
  annotate?: (rowId: number, index: number, guess: CuratedReferenceImageFormGuess) => Promise<boolean>;
  /** 判定用模型名访问器（盖进 guess.model，供审计与「detectedFor 锚 + 模型」回放）。 */
  getModel: () => string;
  /** 判定用厂商 id 访问器（盖进 guess.provider）。 */
  getProvider: () => string;
  /** 内层超时闸（毫秒）；缺省读 env AIDCP_COVER_FORM_TIMEOUT_MS，再缺省 30s。 */
  timeoutMs?: number;
  /** 时钟注入（测试用），默认 Date.now。 */
  clock?: () => number;
  logger?: Pick<Console, 'warn'>;
}

/** onCall 记账归属角色标识（role-catalog 登记为展示项属批 C；此处仅作记账/日志归属字符串）。 */
export const COVER_FORM_SENSOR_ROLE = 'publish:CoverFormSensor';

/** env 正整数解析（非法/缺失 → undefined，绝不 NaN 外泄）。 */
function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 可用图 URL：ossUrl 优先（转存稳定、不受平台防盗链），缺则 sourceUrl；两者皆空 → undefined。 */
export function usableImageUrl(img: ReferenceImageSnapshot): string | undefined {
  const oss = typeof img.ossUrl === 'string' && img.ossUrl.trim() ? img.ossUrl.trim() : undefined;
  if (oss) return oss;
  return typeof img.sourceUrl === 'string' && img.sourceUrl.trim() ? img.sourceUrl.trim() : undefined;
}

/** 视觉判定提示词（中文；输出收窄为 form+confidence+reason，刻意不要求颜色/坐标/OCR 全文——防搬运结构隔离）。 */
function buildSensePrompt(): string {
  return `请判断这张小红书笔记封面图的形态，四选一：
- text_card：排版文字知识卡/海报——画面主体是排版好的文字内容（大标题、要点列表、金句等），文字本身是信息主体
- photo：真实拍摄的照片（人物、风景、食物、产品、生活场景等实拍）
- illustration：插画/手绘/漫画/卡通风格的图
- other：以上都不是（如界面截图、纯图表、拼图等）

只输出 JSON（不要其他内容，不要输出图中的具体文字）：
{"form":"text_card|photo|illustration|other","confidence":0.0到1.0之间的数字,"reason":"简短中文理由"}`;
}

/** 组装单条多模态消息（文本指令 + 待判图）。 */
function buildSenseMessages(imageUrl: string): VisionChatMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: buildSensePrompt() },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ];
}

/**
 * 严格解析模型输出（沿精选评估角色 curated-note-evaluator 的范式）：
 * 取首个 '{' 到末个 '}' 的 JSON；form 必须 ∈ 枚举、confidence 必须有限数 ∈[0,1]；
 * 任一缺失/类型不符 → null（按 error 处理，MUST NOT 默认成功）。reason 只用于日志，不入结果。
 */
function parseSenseOutput(raw: string): { form: CuratedCoverForm; confidence: number } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (!isCuratedCoverForm(o.form)) return null;
  const confidence = o.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  return { form: o.form, confidence };
}

/** 错误信息压平（单行、限长，供 detail/日志）。 */
function compactError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const t = msg.replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 300)}...` : t;
}

/** 构造感知服务（依赖全注入，脱离网络/PG 可单测）。 */
export function createCoverFormSensor(deps: CoverFormSensorDeps): CoverFormSensor {
  const timeoutMs = deps.timeoutMs ?? envPositiveInt('AIDCP_COVER_FORM_TIMEOUT_MS') ?? 30_000;
  const clock = deps.clock ?? Date.now;

  // 判定「指定一张」核心：缓存 → 单次视觉 → 严格解析 → 回写（change textcard-carousel-form-parity 从 sense 抽出）。
  // sense() 与 senseAt() 共用；行为逐字节等价旧 sense（封面单张路径），红线一致（无负缓存/绝不猜/绝不抛）。
  async function senseImageAt(
    ref: CoverFormSenseRef,
    item: ReferenceImageSnapshot,
    url: string,
    arrayIndex: number,
  ): Promise<CoverFormSenseResult> {
    // ③ 缓存命中：detectedFor 锚 === item 当前 capturedAt（重抓必变、零 TTL）→ 零视觉调用。
    if (item.formGuess && typeof item.capturedAt === 'number' && item.formGuess.detectedFor === item.capturedAt) {
      return { status: 'detected', guess: item.formGuess, cached: true };
    }

    // ④ miss → 单次视觉调用（内层超时闸随 opts 下发）；调用失败/超时 → error，绝不持久化、绝不抛。
    let raw: string;
    try {
      raw = await deps.vision.chatVision(buildSenseMessages(url), {
        role: COVER_FORM_SENSOR_ROLE,
        accountId: ref.accountId,
        timeoutMs,
      });
    } catch (err) {
      return { status: 'error', cached: false, detail: compactError(err) };
    }

    // ⑤ 严格解析：脏 JSON / 缺核心字段 / 越界 → error，MUST NOT 默认成功、绝不猜形态。
    const parsed = parseSenseOutput(raw);
    if (!parsed) {
      return { status: 'error', cached: false, detail: 'unparseable vision output (missing/invalid form or confidence)' };
    }

    // ⑥ 盖章判定：detectedFor = item.capturedAt（存量缺失则用归一化 now——annotate 同条语句会把它落盘作锚）。
    const now = clock();
    const detectedFor =
      typeof item.capturedAt === 'number' && Number.isInteger(item.capturedAt) && item.capturedAt > 0
        ? item.capturedAt
        : now;
    const guess: CuratedReferenceImageFormGuess = {
      form: parsed.form,
      confidence: parsed.confidence,
      detectedAt: now,
      detectedFor,
      model: deps.getModel(),
      provider: deps.getProvider(),
    };

    // ⑦ best-effort 回写素材行：仅有落库行时；锚不符弃写 / PG 失败只记日志，绝不影响本次发布。
    if (deps.annotate && ref.curatedContentId !== null) {
      try {
        const written = await deps.annotate(ref.curatedContentId, arrayIndex, guess);
        if (!written) {
          deps.logger?.warn?.(
            `[CoverFormSensor] annotation skipped (anchor mismatch or row missing) rowId=${ref.curatedContentId} index=${arrayIndex} source=${ref.sourceId}`,
          );
        }
      } catch (err) {
        deps.logger?.warn?.(
          `[CoverFormSensor] annotation write failed rowId=${ref.curatedContentId} index=${arrayIndex}: ${compactError(err)}`,
        );
      }
    }

    // 低置信不过滤：原样返回，阈值在消费端（存观测不存策略）。
    return { status: 'detected', guess, cached: false };
  }

  return {
    async sense(ref: CoverFormSenseRef): Promise<CoverFormSenseResult> {
      // ① 旗标闸：关即零调用零写入（感知只由本旗标门控，先于且独立于渲染旗标——design D4 修正）。
      if (!deps.enabled()) return { status: 'disabled', cached: false };

      // ② 选第一张有可用 URL 的参照图；全不可用 → 诚实 no_image（封面走生成式，绝不阻断发布）。
      for (let i = 0; i < (ref.images?.length ?? 0); i++) {
        const url = usableImageUrl(ref.images[i]);
        if (url) return senseImageAt(ref, ref.images[i], url, i);
      }
      return { status: 'no_image', cached: false, detail: 'no usable reference image url' };
    },

    // 判定指定下标那张（帖级形态档服务判内页用）。旗标关 → disabled；该下标无可用 URL → no_image。
    async senseAt(ref: CoverFormSenseRef, arrayIndex: number): Promise<CoverFormSenseResult> {
      if (!deps.enabled()) return { status: 'disabled', cached: false };
      const item = ref.images?.[arrayIndex];
      const url = item ? usableImageUrl(item) : undefined;
      if (!item || !url) {
        return { status: 'no_image', cached: false, detail: `reference image[${arrayIndex}] has no usable url` };
      }
      return senseImageAt(ref, item, url, arrayIndex);
    },
  };
}

// ── v1 模型解析链（design D5 评审修正）：env → 代码默认，两层收敛 ────────────────
// 绝不进按角色文本解析/全局文本模型回落层（文本模型收到 image_url 必错——正确性问题）。
// 面板 role-catalog 登记仅作展示（同用本解析）；换名恢复路径 = 改 env + 重启。

/** 代码默认视觉厂商（dashscope compatible-mode 端点接受 OpenAI 形状多模态消息）。 */
export const DEFAULT_COVER_FORM_PROVIDER = 'dashscope';
/** 代码默认视觉模型（长期稳定名；现役 flash 档以 env AIDCP_COVER_FORM_MODEL 覆盖，下架潮免部署换名）。 */
export const DEFAULT_COVER_FORM_MODEL = 'qwen-vl-plus';

export function resolveCoverFormProvider(): string {
  return process.env.AIDCP_COVER_FORM_PROVIDER?.trim() || DEFAULT_COVER_FORM_PROVIDER;
}

export function resolveCoverFormModel(): string {
  return process.env.AIDCP_COVER_FORM_MODEL?.trim() || DEFAULT_COVER_FORM_MODEL;
}
