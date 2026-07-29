/**
 * 文字卡转写结果的边界归一 + 纯读取 helper（kernel）。存储 / SQL / 视觉调用留 content。
 *
 * 本文件是这一族**运行时纯函数**的家：JSONB 归一、成功卡取用、正文合并、转写能力状态结算。
 * 它们的共同点是零 IO、零依赖注入，且**两侧属主都要用**（content 的转写器与封面卡角色、
 * automation 的精选准入评估角色）。对应的类型 / 调用口分别在 `curated-content-types.ts`
 * 与 `text-card-transcriber-port.ts`。
 */
import type {
  TextCardTranscription,
  TextCardTranscriptionCard,
  TextCardTranscriptionCardStatus,
  TextCardTranscriptionStatus,
} from './curated-content-types.js';
import type {
  TextCardTranscriber,
  TextCardTranscriberCapability,
  TextCardTranscriptionMode,
} from './text-card-transcriber-port.js';

export const CURATED_REFERENCE_IMAGE_HARD_MAX = 18;

export function cleanOptionalString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}


export function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}


/** 严格正整数（形态注解时间戳专用：0/负数/小数/非数一律不合法——区别于 positiveInt 的 ≥0 取整语义）。 */
export function strictPositiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}


export function isTextCardTranscriptionStatus(v: unknown): v is TextCardTranscriptionStatus {
  return v === 'complete' || v === 'partial' || v === 'failed';
}

export function isTextCardTranscriptionCardStatus(v: unknown): v is TextCardTranscriptionCardStatus {
  return v === 'transcribed' || v === 'empty' || v === 'failed';
}

/**
 * JSONB / task payload boundary normalizer. Invalid envelopes are discarded as a whole; invalid card rows are not
 * silently guessed because a shifted sourceArrayIndex would bind text to the wrong source image.
 */
export function normalizeTextCardTranscription(v: unknown): TextCardTranscription | undefined {
  if (typeof v === 'string' && v.trim()) {
    try {
      return normalizeTextCardTranscription(JSON.parse(v));
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !isTextCardTranscriptionStatus(o.status)) return undefined;
  const anchor = cleanOptionalString(o.anchor);
  const provider = cleanOptionalString(o.provider);
  const model = cleanOptionalString(o.model);
  const transcribedAt = strictPositiveInt(o.transcribedAt);
  if (!anchor || !/^sha256:[a-f0-9]{64}$/.test(anchor) || !provider || !model || !transcribedAt) return undefined;
  if (!Array.isArray(o.cards) || o.cards.length === 0 || o.cards.length > CURATED_REFERENCE_IMAGE_HARD_MAX) {
    return undefined;
  }
  const seen = new Set<number>();
  const cards: TextCardTranscriptionCard[] = [];
  for (const raw of o.cards) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const card = raw as Record<string, unknown>;
    const sourceArrayIndex = positiveInt(card.sourceArrayIndex);
    const sourceIndex = positiveInt(card.sourceIndex);
    const capturedAt = strictPositiveInt(card.capturedAt);
    if (
      sourceArrayIndex === undefined ||
      sourceIndex === undefined ||
      capturedAt === undefined ||
      !isTextCardTranscriptionCardStatus(card.status) ||
      seen.has(sourceArrayIndex)
    ) return undefined;
    seen.add(sourceArrayIndex);
    const text = cleanOptionalString(card.text);
    if (card.status === 'transcribed' && (!text || text.length > 8_000)) return undefined;
    const reason = cleanOptionalString(card.reason);
    cards.push({
      sourceArrayIndex,
      sourceIndex,
      capturedAt,
      status: card.status,
      ...(card.status === 'transcribed' && text ? { text } : {}),
      ...(reason ? { reason: reason.slice(0, 300) } : {}),
    });
  }
  cards.sort((a, b) => a.sourceArrayIndex - b.sourceArrayIndex);
  const succeeded = cards.filter((card) => card.status === 'transcribed').length;
  const derivedStatus: TextCardTranscriptionStatus =
    succeeded === cards.length ? 'complete' : succeeded > 0 ? 'partial' : 'failed';
  if (o.status !== derivedStatus) return undefined;
  return { version: 1, status: o.status, anchor, provider, model, transcribedAt, cards };
}

/** Successful per-card text in authoritative source-image order. */
export function orderedTextCardTexts(transcription: TextCardTranscription | undefined): TextCardTranscriptionCard[] {
  return transcription?.cards.filter((card) => card.status === 'transcribed' && !!card.text) ?? [];
}

/** Successful OCR text in source-card order, appended once to the current DOM body. */
export function mergeBodyWithTextCardTranscription(body: string, transcription: TextCardTranscription | undefined): string {
  const domBody = body.trim();
  const normalizedDom = domBody.replace(/\s+/g, '');
  const additions = orderedTextCardTexts(transcription)
    .map((card) => card.text!.trim())
    .filter((text) => text && !normalizedDom.includes(text.replace(/\s+/g, '')));
  return [domBody, additions.join('\n\n')].filter(Boolean).join('\n\n');
}

/**
 * 构造期结算转写能力的二态。
 *
 * 入参两种合法形态：转写器实现本身（＝已接线），或组合根显式给出的 {@link TextCardTranscriberCapability}。
 * **缺席（undefined）不被压成「关掉了」**，而是结算成带 reason 的 `unavailable`，由调用方留痕后跳过。
 * 形状不认识时同样判 `unavailable`（reason=`invalid_capability`），绝不当作可用实现去调。
 */
export function resolveTextCardTranscriberCapability(
  input: TextCardTranscriber | TextCardTranscriberCapability | undefined,
): TextCardTranscriberCapability {
  if (!input) return { state: 'unavailable', reason: 'not_injected' };
  if ('state' in input) return input;
  if (typeof input.enabled === 'function' && typeof input.transcribe === 'function') {
    return { state: 'wired', transcriber: input };
  }
  return { state: 'unavailable', reason: 'invalid_capability' };
}

/**
 * 结算调用点当前该走哪一态。
 *
 * `enabled()` 只在能力已接线时才问——依赖缺席时它根本不存在，今天那句 `transcriber?.enabled()` 正是
 * 在这里把缺席吞成了假。
 *
 * 旗标读取本身若抛出，本函数**不接管、不兜底**：吞成 `flag_off` 就是又一次静默假成功。但要如实说明
 * 它冒泡到哪为止——现役调用点（精选准入评估角色）的两个入口都是 fire-and-forget（`void evaluate(...)`
 * / `void refreshImages(...)`），所以这个抛出落进一个**无人 await 的 promise**：浏览主路径不会被打断
 * （这正是要的），代价是它只以进程级 unhandled rejection 现形，**不会**变成调用方能就地识别的失败。
 * 也就是说这里保住的是「不撒谎」，不是「一定看得见」；真要可观测，得由调用点自己接住并留痕。
 */
export function textCardTranscriptionMode(capability: TextCardTranscriberCapability): TextCardTranscriptionMode {
  if (capability.state === 'unavailable') return 'unavailable';
  return capability.transcriber.enabled() ? 'active' : 'flag_off';
}

