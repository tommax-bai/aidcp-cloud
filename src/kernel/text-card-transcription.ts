/**
 * 文字卡转写结果的边界归一（kernel）。存储 / SQL 留 content。
 */
import type {
  TextCardTranscription,
  TextCardTranscriptionCard,
  TextCardTranscriptionCardStatus,
  TextCardTranscriptionStatus,
} from './curated-content-types.js';

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

