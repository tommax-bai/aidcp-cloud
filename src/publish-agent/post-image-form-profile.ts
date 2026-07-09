/**
 * 帖级形态档服务（change textcard-carousel-form-parity，阶段0 影子）。
 *
 * 取代「仅感知第一张封面」的单点判定：**封面先行（cover-gated）** + 内页**有界并发**判形 → 三档归类。
 * 纯服务、依赖全注入（senseAt/enabled/阈值/上限/并发），脱离网络与 PG 可单测。
 *
 * 判定顺序与红线（沿感知层诚实红线）：
 * - 封面**不是高置信文字卡** → `generative` 档、`generative_cover_not_card`、**零内页调用**（普通帖不多花）。
 * - 封面是高置信文字卡 → 对其余有效源图**并发有界**判形（上限 K，超上限降级 `card_cover`/`downgrade_over_cap`、不猜不多判）。
 *   - 每张有效源图都判为高置信文字卡 → `all_text_card`。
 *   - 有内页判为高置信非文字卡（照片/插画/其他）→ `card_cover`/`downgrade_inner_not_unanimous`。
 *   - 有内页 unknown/出错/低置信 → `card_cover`/`downgrade_unknown_or_error`。
 * - MUST NOT 把缺失/不确定猜成 `all_text_card`；任一不确定一律降级到既有安全档（`card_cover` = 现版行为）。
 * - 阶段0 只**记录**形态档（写审计），**不改渲染**；渲染翻转在阶段1（另一枚旗标）。
 */

import type {
  PerImageFormGuess,
  PostFormGateReason,
  PostFormProfile,
  PostFormProfileResult,
  SensedCoverForm,
} from './types.js';
import {
  usableImageUrl,
  type CoverFormSenseRef,
  type CoverFormSenseResult,
  type SenseImageAtFn,
} from './cover-form-sensor.js';

const DEFAULT_MIN_CONFIDENCE = 0.75;
/** 内页判定张数上限 K（默认 = 平台图集上界 9；超上限降级而非多判/瞎猜）。 */
const DEFAULT_CAP = 9;
/** 内页判定并发上限（防视觉厂商突发限流；每张仍各自超时）。 */
const DEFAULT_CONCURRENCY = 6;

export interface PostImageFormProfileDeps {
  /** 判定「指定下标一张」的函数（由具体 CoverFormSensor.senseAt 提供；解耦便于单测注入假实现）。 */
  senseAt: SenseImageAtFn;
  /** 帖级形态档旗标（AIDCP_POST_FORM_PROFILE）；关 → 消费端不调 compute。 */
  enabled: () => boolean;
  /** 文字卡置信阈值（缺省读 AIDCP_COVER_FORM_MIN_CONFIDENCE，再缺省 0.75）——与封面消费端同源。 */
  minConfidence?: number;
  /** 内页判定张数上限（缺省读 AIDCP_POST_FORM_PROFILE_MAX，再缺省 9）。 */
  cap?: number;
  /** 内页判定并发上限（缺省读 AIDCP_POST_FORM_PROFILE_CONCURRENCY，再缺省 6）。 */
  concurrency?: number;
  logger?: Pick<Console, 'warn'>;
}

export interface PostImageFormProfileInput {
  /** 参照来稿投影（images 下标须与素材行 reference_images 一致）。 */
  ref: CoverFormSenseRef;
  /** 封面（第一张有可用 URL）已被消费端判过的结果——复用、绝不重判封面。 */
  coverSense: CoverFormSenseResult;
}

export interface PostImageFormProfileService {
  enabled(): boolean;
  compute(input: PostImageFormProfileInput): Promise<PostFormProfileResult>;
}

/** env 正整数解析（非法/缺失 → undefined）。 */
function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** env 浮点解析（[0,1] 外或非法 → undefined）。 */
function envConfidence(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

function formOf(r: CoverFormSenseResult): SensedCoverForm {
  return r.status === 'detected' && r.guess ? r.guess.form : 'unknown';
}

function sourceOf(r: CoverFormSenseResult): 'cached' | 'vision' | 'none' {
  return r.status === 'detected' ? (r.cached ? 'cached' : 'vision') : 'none';
}

/** 高置信文字卡：detected + text_card + 置信 ≥ 阈值（缺失/低置信绝不算文字卡）。 */
function isConfidentTextCard(r: CoverFormSenseResult, min: number): boolean {
  return r.status === 'detected' && !!r.guess && r.guess.form === 'text_card' && r.guess.confidence >= min;
}

/** 高置信非文字卡：detected + 非 text_card + 置信 ≥ 阈值（据此区分「明确异形」与「不确定」）。 */
function isConfidentNonTextCard(r: CoverFormSenseResult, min: number): boolean {
  return r.status === 'detected' && !!r.guess && r.guess.form !== 'text_card' && r.guess.confidence >= min;
}

/** 有界并发 map，结果保序（每 fn 自吞异常、不抛，池不中断）。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, Math.max(1, items.length)));
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function createPostImageFormProfileService(deps: PostImageFormProfileDeps): PostImageFormProfileService {
  const minConfidence = deps.minConfidence ?? envConfidence('AIDCP_COVER_FORM_MIN_CONFIDENCE') ?? DEFAULT_MIN_CONFIDENCE;
  const cap = deps.cap ?? envPositiveInt('AIDCP_POST_FORM_PROFILE_MAX') ?? DEFAULT_CAP;
  const concurrency = deps.concurrency ?? envPositiveInt('AIDCP_POST_FORM_PROFILE_CONCURRENCY') ?? DEFAULT_CONCURRENCY;

  const result = (
    profile: PostFormProfile,
    gateReason: PostFormGateReason,
    perImageForms: PerImageFormGuess[],
    innerSensed: number,
  ): PostFormProfileResult => ({ profile, gateReason, perImageForms, innerSensed });

  return {
    enabled: deps.enabled,

    async compute(input: PostImageFormProfileInput): Promise<PostFormProfileResult> {
      const { ref, coverSense } = input;
      const images = ref.images ?? [];

      // 封面 = 第一张有可用 URL（与感知层 sense() 一致）。
      let coverIndex = -1;
      for (let i = 0; i < images.length; i++) {
        if (usableImageUrl(images[i])) {
          coverIndex = i;
          break;
        }
      }

      // 封面非高置信文字卡（含无可用图/unknown/低置信/异形）→ generative，零内页调用。
      if (coverIndex < 0 || !isConfidentTextCard(coverSense, minConfidence)) {
        const perImageForms =
          coverIndex >= 0 ? [{ index: coverIndex, form: formOf(coverSense), source: sourceOf(coverSense) }] : [];
        return result('generative', 'generative_cover_not_card', perImageForms, 0);
      }

      // 封面是高置信文字卡 → 枚举其余有效源图下标。
      const innerIdx: number[] = [];
      for (let i = 0; i < images.length; i++) {
        if (i !== coverIndex && usableImageUrl(images[i])) innerIdx.push(i);
      }
      const coverEntry: PerImageFormGuess = { index: coverIndex, form: formOf(coverSense), source: sourceOf(coverSense) };

      // 超上限 → 降级 card_cover，不多判不瞎猜（守成本 + 诚实红线）。
      if (1 + innerIdx.length > cap) {
        return result('card_cover', 'downgrade_over_cap', [coverEntry], 0);
      }

      // 内页有界并发判形（senseAt 承诺不抛；此处再兜底防御，绝不让判定波及发布）。
      const innerResults = await mapWithConcurrency(innerIdx, concurrency, async (idx) => {
        try {
          return { idx, r: await deps.senseAt(ref, idx) };
        } catch (err) {
          deps.logger?.warn?.(
            `[PostImageFormProfile] senseAt[${idx}] 异常（按 error 处理）: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { idx, r: { status: 'error', cached: false } as CoverFormSenseResult };
        }
      });

      const perImageForms: PerImageFormGuess[] = [
        coverEntry,
        ...innerResults.map(({ idx, r }) => ({ index: idx, form: formOf(r), source: sourceOf(r) })),
      ].sort((a, b) => a.index - b.index);

      // 每张（含空内页时的封面）都高置信文字卡 → all_text_card。
      const allTextCard = innerResults.every(({ r }) => isConfidentTextCard(r, minConfidence));
      if (allTextCard) {
        return result('all_text_card', 'all_text_card', perImageForms, innerIdx.length);
      }

      // 否则降级 card_cover：有明确异形 → not_unanimous；否则（unknown/低置信/出错）→ unknown_or_error。
      const anyConfidentNonCard = innerResults.some(({ r }) => isConfidentNonTextCard(r, minConfidence));
      return result(
        'card_cover',
        anyConfidentNonCard ? 'downgrade_inner_not_unanimous' : 'downgrade_unknown_or_error',
        perImageForms,
        innerIdx.length,
      );
    },
  };
}
