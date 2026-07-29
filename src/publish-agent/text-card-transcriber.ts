import { createHash } from 'node:crypto';

import { normalizeCuratedReferenceImages } from '../cache/curated-content-store.js';
// 数据模型与调用口的定义处都在 kernel；经 `cache/curated-content-store.ts` 的再导出壳取用会让那条边
// 在扫描器眼里继续存在（它认的是 import 说明符，不是最终定义处）。直取 kernel。
import type {
  CuratedReferenceImage,
  TextCardTranscription,
  TextCardTranscriptionCard,
} from '../kernel/curated-content-types.js';
// 三个口的定义已下沉 kernel（两侧都要认识），**转写器本体留在本文件（content）**：
// 它要视觉客户端 + 形态感知器 + OSS 图址，进不了零副作用层。owner 把口 import 回来，不留第二份定义。
import type {
  TextCardTranscriber,
  TextCardTranscriberInput,
  TextCardTranscriberOutcome,
} from '../kernel/text-card-transcriber-port.js';
import type { VisionChatMessage, VisionContentPart, VisionLlmClient } from '../llm/vision.js';
import type { CoverFormSensor } from './cover-form-sensor.js';

// 既有消费方（组合根 / 测试装配）从本模块取这三个口的导入面保持逐字不变。
export type { TextCardTranscriber, TextCardTranscriberInput, TextCardTranscriberOutcome };

export const TEXT_CARD_TRANSCRIBER_ROLE = 'browse:text_card_transcriber';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 8_192;
const DEFAULT_MIN_CONFIDENCE = 0.75;
const FORM_CONCURRENCY = 4;
const MAX_CARD_TEXT_LENGTH = 8_000;

export interface TextCardTranscriberDeps {
  vision: VisionLlmClient;
  formSensor: CoverFormSensor;
  enabled: () => boolean;
  getModel: () => string;
  getProvider: () => string;
  minConfidence?: number;
  timeoutMs?: number;
  maxTokens?: number;
  clock?: () => number;
  logger?: Pick<Console, 'warn'>;
}

function usableUrl(image: CuratedReferenceImage): string | undefined {
  return image.ossUrl?.trim() || image.sourceUrl?.trim() || undefined;
}

export function textCardTranscriptionAnchor(images: CuratedReferenceImage[]): string {
  const identities = images.map((image, sourceArrayIndex) => ({
    sourceArrayIndex,
    sourceIndex: image.index,
    usableUrl: usableUrl(image) ?? '',
  }));
  return `sha256:${createHash('sha256').update(JSON.stringify(identities)).digest('hex')}`;
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function envConfidence(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown_error';
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, () => worker()));
  return results;
}

export function buildTextCardTranscriptionPrompt(sourceArrayIndices: number[]): string {
  return [
    '你是文字卡转写器。请逐张读取随后提供的小红书文字卡，只抄录图片中真实可见的文字。',
    '要求：',
    '- 忠实保留原意与阅读顺序；同一张卡内用换行分隔标题、段落和要点。',
    '- 不补充、不改写、不总结、不评价；看不清就返回空字符串。',
    '- sourceArrayIndex 必须使用图片前标注的数字，不能自行编号。',
    `- 只允许返回这些下标：${sourceArrayIndices.join('、')}。`,
    '- 严格只输出 JSON，不要代码块或解释：',
    '{"cards":[{"sourceArrayIndex":0,"text":"图片中真实文字"}]}',
  ].join('\n');
}

function buildMessages(images: Array<{ sourceArrayIndex: number; url: string }>): VisionChatMessage[] {
  const content: VisionContentPart[] = [
    { type: 'text', text: buildTextCardTranscriptionPrompt(images.map((image) => image.sourceArrayIndex)) },
  ];
  for (const image of images) {
    content.push(
      { type: 'text', text: `sourceArrayIndex=${image.sourceArrayIndex}` },
      { type: 'image_url', image_url: { url: image.url } },
    );
  }
  return [{ role: 'user', content }];
}

function parseOutput(raw: string, selected: number[]): Map<number, string> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const cards = (parsed as { cards?: unknown }).cards;
  if (!Array.isArray(cards)) return null;
  const allowed = new Set(selected);
  const result = new Map<number, string>();
  for (const rawCard of cards) {
    if (!rawCard || typeof rawCard !== 'object' || Array.isArray(rawCard)) return null;
    const card = rawCard as Record<string, unknown>;
    if (!Number.isInteger(card.sourceArrayIndex) || !allowed.has(card.sourceArrayIndex as number)) return null;
    const sourceArrayIndex = card.sourceArrayIndex as number;
    if (result.has(sourceArrayIndex) || typeof card.text !== 'string') return null;
    const text = card.text.trim();
    if (text.length > MAX_CARD_TEXT_LENGTH) return null;
    result.set(sourceArrayIndex, text);
  }
  return result;
}

function transcriptionStatus(cards: TextCardTranscriptionCard[]): TextCardTranscription['status'] {
  const successes = cards.filter((card) => card.status === 'transcribed').length;
  return successes === cards.length ? 'complete' : successes > 0 ? 'partial' : 'failed';
}

function failedCards(images: CuratedReferenceImage[], selected: number[], reason: string): TextCardTranscriptionCard[] {
  return selected.map((sourceArrayIndex) => ({
    sourceArrayIndex,
    sourceIndex: images[sourceArrayIndex].index,
    capturedAt: images[sourceArrayIndex].capturedAt,
    status: 'failed',
    reason,
  }));
}

// mergeBodyWithTextCardTranscription 已抬进 kernel（`kernel/text-card-transcription.ts`）：纯字符串运算、
// 零依赖，且消费方在 automation 侧（精选准入评估角色）。同样不留再导出壳，消费方直取 kernel。

export function createTextCardTranscriber(deps: TextCardTranscriberDeps): TextCardTranscriber {
  const timeoutMs = deps.timeoutMs ?? envPositiveInt('AIDCP_TEXTCARD_OCR_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = deps.maxTokens ?? envPositiveInt('AIDCP_TEXTCARD_OCR_MAX_TOKENS') ?? DEFAULT_MAX_TOKENS;
  const minConfidence = deps.minConfidence ?? envConfidence('AIDCP_COVER_FORM_MIN_CONFIDENCE') ?? DEFAULT_MIN_CONFIDENCE;
  const clock = deps.clock ?? Date.now;
  const inFlight = new Map<string, Promise<TextCardTranscriberOutcome>>();

  async function run(input: TextCardTranscriberInput, normalized: CuratedReferenceImage[], anchor: string): Promise<TextCardTranscriberOutcome> {
    const images = normalized.map((image) => ({ ...image }));
    const ref = { curatedContentId: null, accountId: input.accountId, sourceId: input.sourceId, images };
    const indices = images.map((_, sourceArrayIndex) => sourceArrayIndex).filter((index) => !!usableUrl(images[index]));
    const senses = await mapWithConcurrency(indices, FORM_CONCURRENCY, async (sourceArrayIndex) => ({
      sourceArrayIndex,
      result: deps.formSensor.senseAt
        ? await deps.formSensor.senseAt(ref, sourceArrayIndex)
        : { status: 'error' as const, cached: false, detail: 'senseAt unavailable' },
    }));
    const selected: number[] = [];
    for (const { sourceArrayIndex, result } of senses) {
      if (result.status !== 'detected' || !result.guess) continue;
      images[sourceArrayIndex] = { ...images[sourceArrayIndex], formGuess: result.guess };
      if (result.guess.form === 'text_card' && result.guess.confidence >= minConfidence) selected.push(sourceArrayIndex);
    }
    selected.sort((a, b) => a - b);
    if (selected.length === 0) return { images, cacheHit: false };

    let cards: TextCardTranscriptionCard[];
    try {
      const raw = await deps.vision.chatVision(
        buildMessages(selected.map((sourceArrayIndex) => ({ sourceArrayIndex, url: usableUrl(images[sourceArrayIndex])! }))),
        { role: TEXT_CARD_TRANSCRIBER_ROLE, accountId: input.accountId, timeoutMs, maxTokens },
      );
      const parsed = parseOutput(raw, selected);
      if (!parsed) {
        cards = failedCards(images, selected, 'unparseable_vision_output');
      } else {
        cards = selected.map((sourceArrayIndex) => {
          const text = parsed.get(sourceArrayIndex);
          return {
            sourceArrayIndex,
            sourceIndex: images[sourceArrayIndex].index,
            capturedAt: images[sourceArrayIndex].capturedAt,
            ...(text
              ? { status: 'transcribed' as const, text }
              : parsed.has(sourceArrayIndex)
                ? { status: 'empty' as const, reason: 'empty_text' }
                : { status: 'failed' as const, reason: 'missing_card_result' }),
          };
        });
      }
    } catch (error) {
      const reason = compactError(error);
      deps.logger?.warn?.(`[TextCardTranscriber] transcription failed source=${input.sourceId}: ${reason}`);
      cards = failedCards(images, selected, reason);
    }
    const transcription: TextCardTranscription = {
      version: 1,
      status: transcriptionStatus(cards),
      anchor,
      provider: deps.getProvider(),
      model: deps.getModel(),
      transcribedAt: clock(),
      cards,
    };
    return { images, transcription, cacheHit: false };
  }

  return {
    enabled: deps.enabled,

    async transcribe(input: TextCardTranscriberInput): Promise<TextCardTranscriberOutcome> {
      const normalized = normalizeCuratedReferenceImages(input.images, { now: input.snapshotAt });
      if (!deps.enabled() || normalized.length === 0) return { images: normalized, cacheHit: false };
      const anchor = textCardTranscriptionAnchor(normalized);
      const cached = input.cached?.transcription;
      if (cached && cached.anchor === anchor && cached.status !== 'failed') {
        return {
          images: input.cached?.referenceImages.length ? input.cached.referenceImages : normalized,
          transcription: cached,
          cacheHit: true,
        };
      }
      const key = `${input.accountId}\u0000${input.sourceId}\u0000${anchor}`;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const pending = run(input, normalized, anchor).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}

export function resolveTextCardTranscriptionProvider(resolveCoverProvider: () => string): string {
  return process.env.AIDCP_TEXTCARD_OCR_PROVIDER?.trim() || resolveCoverProvider();
}

export function resolveTextCardTranscriptionModel(resolveCoverModel: () => string): string {
  return process.env.AIDCP_TEXTCARD_OCR_MODEL?.trim() || resolveCoverModel();
}
