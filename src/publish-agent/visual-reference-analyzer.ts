import crypto from 'node:crypto';
import type { VisionChatMessage, VisionLlmClient } from '../llm/vision.js';
import { referenceImagesForGeneration } from './reference-image-guidance.js';
import type { ReferenceImageSnapshot } from './types.js';
import {
  REFERENCE_VISUAL_KINDS,
  VISUAL_ANALYSIS_SCHEMA_VERSION,
  type ReferenceVisualAnalysis,
  type ReferenceVisualKind,
  type VisualFrameCommon,
  type VisualFrameDetails,
  type VisualFrameSpec,
  type VisualStyleBible,
  type VisualStyleCluster,
} from './visual-reference-types.js';

export const VISUAL_REFERENCE_ANALYZER_ROLE = 'publish:VisualReferenceAnalyzer';
export const DEFAULT_REFERENCE_VISUAL_PROVIDER = 'dashscope';
export const DEFAULT_REFERENCE_VISUAL_MODEL = 'qwen3.7-plus';

export function resolveReferenceVisualProvider(): string {
  return process.env.AIDCP_REFERENCE_VISUAL_PROVIDER?.trim() || DEFAULT_REFERENCE_VISUAL_PROVIDER;
}

export function resolveReferenceVisualModel(): string {
  return process.env.AIDCP_REFERENCE_VISUAL_MODEL?.trim() || DEFAULT_REFERENCE_VISUAL_MODEL;
}

export interface VisualAnalysisAnchor {
  sourceArrayIndex: number;
  sourceIndex: number;
  capturedAt: number;
  url: string;
}

export interface VisualReferenceAnalyzeInput {
  curatedContentId: number | null;
  accountId: string;
  sourceId: string;
  images: ReferenceImageSnapshot[];
  cached?: ReferenceVisualAnalysis;
}

export interface VisualReferenceAnalyzerDeps {
  vision: VisionLlmClient;
  enabled: () => boolean;
  getModel: () => string;
  getProvider: () => string;
  annotate?: (rowId: number, analysis: ReferenceVisualAnalysis, anchors: VisualAnalysisAnchor[]) => Promise<boolean>;
  timeoutMs?: number;
  specialistBatchSize?: number;
  clock?: () => number;
  logger?: Pick<Console, 'warn' | 'log'>;
}

export interface VisualReferenceAnalyzer {
  analyze(input: VisualReferenceAnalyzeInput): Promise<ReferenceVisualAnalysis>;
}

function compactError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function usableUrl(image: ReferenceImageSnapshot): string | undefined {
  const oss = image.ossUrl?.trim();
  if (oss) return oss;
  const source = image.sourceUrl?.trim();
  return source || undefined;
}

export function visualAnalysisAnchors(images: ReferenceImageSnapshot[]): VisualAnalysisAnchor[] {
  return referenceImagesForGeneration(images).flatMap((image, sourceArrayIndex) => {
    const url = usableUrl(image);
    if (!url) return [];
    return [{
      sourceArrayIndex,
      sourceIndex: Number.isInteger(image.index) ? image.index : sourceArrayIndex,
      capturedAt: Number.isInteger(image.capturedAt) && (image.capturedAt ?? 0) > 0 ? image.capturedAt! : 0,
      url,
    }];
  });
}

export function visualAnalysisCacheKey(
  images: ReferenceImageSnapshot[],
  provider: string,
  model: string,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ schemaVersion: VISUAL_ANALYSIS_SCHEMA_VERSION, provider, model, anchors: visualAnalysisAnchors(images) }))
    .digest('hex');
}

function isKind(value: unknown): value is ReferenceVisualKind {
  return (REFERENCE_VISUAL_KINDS as readonly unknown[]).includes(value);
}

function finiteUnit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, 800) : null;
}

function stringArray(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter((v): v is string => !!v).slice(0, max);
}

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function parseStyleBible(value: unknown): VisualStyleBible | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const summary = cleanString(o.summary);
  const whitespace = cleanString(o.whitespace);
  const hierarchy = cleanString(o.hierarchy);
  if (!summary || !whitespace || !hierarchy) return null;
  return {
    summary,
    palette: stringArray(o.palette, 8),
    colorTemperature: enumValue(o.colorTemperature, ['warm', 'cool', 'neutral', 'mixed'] as const, 'mixed'),
    contrast: enumValue(o.contrast, ['low', 'medium', 'high', 'mixed'] as const, 'mixed'),
    visualDensity: enumValue(o.visualDensity, ['sparse', 'balanced', 'dense', 'mixed'] as const, 'mixed'),
    whitespace,
    hierarchy,
    mood: stringArray(o.mood, 8),
    texture: stringArray(o.texture, 8),
    continuityRules: stringArray(o.continuityRules, 12),
    avoid: stringArray(o.avoid, 12),
  };
}

function parseCommon(value: unknown): VisualFrameCommon | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const fields = ['aspectRatio', 'subject', 'composition', 'focalHierarchy', 'lightingOrContrast', 'negativeSpace', 'texture', 'mood'] as const;
  const strings = Object.fromEntries(fields.map((key) => [key, cleanString(o[key])])) as Record<(typeof fields)[number], string | null>;
  if (fields.some((key) => !strings[key])) return null;
  return {
    aspectRatio: strings.aspectRatio!,
    subject: strings.subject!,
    composition: strings.composition!,
    focalHierarchy: strings.focalHierarchy!,
    palette: stringArray(o.palette, 8),
    lightingOrContrast: strings.lightingOrContrast!,
    negativeSpace: strings.negativeSpace!,
    texture: strings.texture!,
    mood: strings.mood!,
    avoid: stringArray(o.avoid, 10),
  };
}

function parseClusters(value: unknown, frameCount: number): VisualStyleCluster[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result: VisualStyleCluster[] = [];
  for (const raw of value.slice(0, frameCount)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const id = cleanString(o.id);
    const label = cleanString(o.label);
    const summary = cleanString(o.summary);
    const frameIndexes = Array.isArray(o.frameIndexes)
      ? o.frameIndexes.filter((v): v is number => Number.isInteger(v) && v >= 0 && v < frameCount)
      : [];
    if (!id || !label || !summary || frameIndexes.length === 0) return null;
    result.push({ id, label, summary, frameIndexes, palette: stringArray(o.palette, 8), traits: stringArray(o.traits, 10) });
  }
  return result;
}

interface CoarseFrame extends Omit<VisualFrameSpec, 'details'> {}

interface SetFrame extends Omit<CoarseFrame, 'common'> {}

function parseSetFrames(value: unknown, anchors: VisualAnalysisAnchor[]): SetFrame[] | null {
  if (!Array.isArray(value) || value.length !== anchors.length) return null;
  const byIndex = new Map<number, SetFrame>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const sourceArrayIndex = Number(o.sourceArrayIndex);
    const anchor = anchors[sourceArrayIndex];
    const confidence = finiteUnit(o.confidence);
    const clusterId = cleanString(o.clusterId);
    if (!anchor || !isKind(o.kind) || confidence === null || !clusterId || byIndex.has(sourceArrayIndex)) return null;
    byIndex.set(sourceArrayIndex, {
      sourceArrayIndex,
      sourceIndex: anchor.sourceIndex,
      kind: o.kind,
      confidence,
      clusterId,
      sequenceRole: enumValue(
        o.sequenceRole,
        ['cover', 'detail', 'step', 'comparison', 'summary', 'support'] as const,
        sourceArrayIndex === 0 ? 'cover' : 'support',
      ),
    });
  }
  return anchors.map((_, i) => byIndex.get(i)!).filter(Boolean);
}

function parseCoarseFrames(value: unknown, anchors: VisualAnalysisAnchor[], requireAll = true): CoarseFrame[] | null {
  if (
    !Array.isArray(value) ||
    (requireAll && value.length !== anchors.length) ||
    (!requireAll && (value.length === 0 || value.length > anchors.length))
  ) return null;
  const byIndex = new Map<number, CoarseFrame>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const sourceArrayIndex = Number(o.sourceArrayIndex);
    const anchor = anchors[sourceArrayIndex];
    const confidence = finiteUnit(o.confidence);
    const common = parseCommon(o.common);
    const clusterId = cleanString(o.clusterId);
    if (!anchor || !isKind(o.kind) || confidence === null || !common || !clusterId || byIndex.has(sourceArrayIndex)) return null;
    byIndex.set(sourceArrayIndex, {
      sourceArrayIndex,
      sourceIndex: anchor.sourceIndex,
      kind: o.kind,
      confidence,
      clusterId,
      sequenceRole: enumValue(o.sequenceRole, ['cover', 'detail', 'step', 'comparison', 'summary', 'support'] as const, sourceArrayIndex === 0 ? 'cover' : 'support'),
      common,
    });
  }
  if (requireAll) return anchors.map((_, i) => byIndex.get(i)!).filter(Boolean);
  return [...byIndex.values()].sort((a, b) => a.sourceArrayIndex - b.sourceArrayIndex);
}

function familyForKind(kind: ReferenceVisualKind): VisualFrameDetails['family'] {
  if (kind.endsWith('_photo')) return 'photo';
  if (kind === 'illustration_3d') return 'illustration';
  if (kind === 'text_layout') return 'text_layout';
  if (kind === 'ui_document') return 'ui_document';
  if (kind === 'infographic_chart') return 'infographic';
  return 'collage';
}

function requiredDetailFields(family: VisualFrameDetails['family']): string[] {
  switch (family) {
    case 'photo': return ['cameraAngle', 'focalLengthFeel', 'depthOfField', 'focus', 'light', 'colorGrade', 'grainSharpness'];
    case 'illustration': return ['medium', 'strokeOrRender', 'shapeLanguage', 'outline', 'materials', 'lightingModel', 'perspective', 'detailLevel'];
    case 'text_layout': return ['grid', 'textBlockRatio', 'hierarchy', 'alignment', 'weightContrast', 'colorBlocks', 'decorations'];
    case 'ui_document': return ['viewport', 'grid', 'componentDensity', 'bordersRadius', 'informationZones', 'depth', 'background'];
    case 'infographic': return ['chartType', 'axesLegend', 'annotationDensity', 'dataInkRatio', 'narrativeOrder'];
    case 'collage': return ['layering', 'overlap', 'unifyingTreatment'];
  }
}

function parseDetails(value: unknown, expectedFamily: VisualFrameDetails['family']): VisualFrameDetails | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (o.family !== expectedFamily) return null;
  const fields = requiredDetailFields(expectedFamily);
  const cleaned: Record<string, string> = {};
  for (const field of fields) {
    const text = cleanString(o[field]);
    if (!text) return null;
    cleaned[field] = text;
  }
  if (expectedFamily === 'infographic') {
    return { family: 'infographic', ...cleaned, encodings: stringArray(o.encodings, 10) } as unknown as VisualFrameDetails;
  }
  if (expectedFamily === 'collage') {
    const regions = Array.isArray(o.regions) ? o.regions.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const r = raw as Record<string, unknown>;
      const region = cleanString(r.region);
      const role = cleanString(r.role);
      return region && role && isKind(r.kind) ? [{ region, role, kind: r.kind }] : [];
    }).slice(0, 12) : [];
    return { family: 'collage', ...cleaned, regions } as unknown as VisualFrameDetails;
  }
  return { family: expectedFamily, ...cleaned } as unknown as VisualFrameDetails;
}

function setPrompt(): string {
  return `你是整组视觉参考分析师。分析按顺序给出的图片，严格只输出一个 JSON 对象。
目标：轻量判断整组视觉语言、风格簇、顺序角色和每张视觉类型。逐图构图细节由下一阶段专家补齐，本轮禁止输出 common/details，以降低大图集延迟。禁止 OCR，禁止抄写或概括图片中的具体文字/数值/账号/水印；禁止猜摄影师、相机型号或精确 EXIF。

视觉类型只能是：${REFERENCE_VISUAL_KINDS.join(' | ')}。
输出：
{"setStyleBible":{"summary":"","palette":[],"colorTemperature":"warm|cool|neutral|mixed","contrast":"low|medium|high|mixed","visualDensity":"sparse|balanced|dense|mixed","whitespace":"","hierarchy":"","mood":[],"texture":[],"continuityRules":[],"avoid":[]},"styleClusters":[{"id":"c1","label":"","frameIndexes":[0],"summary":"","palette":[],"traits":[]}],"frames":[{"sourceArrayIndex":0,"kind":"...","confidence":0.0,"clusterId":"c1","sequenceRole":"cover|detail|step|comparison|summary|support"}]}
frames 必须与输入图片等量且 sourceArrayIndex 覆盖 0..N-1。`;
}

function specialistPrompt(family: VisualFrameDetails['family'], indexes: number[]): string {
  const schemas: Record<VisualFrameDetails['family'], string> = {
    photo: '{"family":"photo","cameraAngle":"","focalLengthFeel":"只给观感/区间，不猜型号","depthOfField":"","focus":"","light":"自然光/硬光/柔光/逆光等","colorGrade":"","grainSharpness":""}',
    illustration: '{"family":"illustration","medium":"","strokeOrRender":"","shapeLanguage":"","outline":"","materials":"","lightingModel":"","perspective":"","detailLevel":""}',
    text_layout: '{"family":"text_layout","grid":"","textBlockRatio":"","hierarchy":"","alignment":"","weightContrast":"","colorBlocks":"","decorations":""}',
    ui_document: '{"family":"ui_document","viewport":"","grid":"","componentDensity":"","bordersRadius":"","informationZones":"","depth":"","background":""}',
    infographic: '{"family":"infographic","chartType":"","encodings":[],"axesLegend":"","annotationDensity":"","dataInkRatio":"","narrativeOrder":""}',
    collage: '{"family":"collage","regions":[{"region":"","kind":"视觉类型枚举","role":""}],"layering":"","overlap":"","unifyingTreatment":""}',
  };
  const common = '{"aspectRatio":"","subject":"只描述视觉主体，不引用图中文字","composition":"","focalHierarchy":"","palette":[],"lightingOrContrast":"","negativeSpace":"","texture":"","mood":"","avoid":[]}';
  return `你是 ${family} 视觉结构专家。只分析标签中的 sourceArrayIndex=${indexes.join(',')}，严格返回 JSON：{"frames":[{"sourceArrayIndex":0,"common":${common},"details":${schemas[family]}}]}。
禁止 OCR、禁止输出图片具体文字/数值/账号/水印。摄影只能描述可观察观感，不猜相机型号、摄影师或精确 EXIF。frames 必须与本组图片等量。`;
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function messagesForImages(prompt: string, anchors: VisualAnalysisAnchor[]): VisionChatMessage[] {
  const content: Extract<VisionChatMessage['content'], unknown[]> = [{ type: 'text', text: prompt }];
  for (const anchor of anchors) {
    content.push({ type: 'text', text: `sourceArrayIndex=${anchor.sourceArrayIndex}` });
    content.push({ type: 'image_url', image_url: { url: anchor.url } });
  }
  return [{ role: 'user', content }];
}

function emptyAnalysis(status: ReferenceVisualAnalysis['status'], sourceCount: number, extras: Partial<ReferenceVisualAnalysis> = {}): ReferenceVisualAnalysis {
  return {
    status,
    schemaVersion: VISUAL_ANALYSIS_SCHEMA_VERSION,
    cacheKey: null,
    provider: null,
    model: null,
    analyzedAt: null,
    sourceCount,
    ...extras,
  };
}

export function normalizeReferenceVisualAnalysis(value: unknown): ReferenceVisualAnalysis | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const status = o.status;
  if (!['disabled', 'none', 'analyzed', 'partial', 'unavailable'].includes(String(status))) return undefined;
  if (o.schemaVersion !== VISUAL_ANALYSIS_SCHEMA_VERSION) return undefined;
  const sourceCount = Number(o.sourceCount);
  if (!Number.isInteger(sourceCount) || sourceCount < 0 || sourceCount > 9) return undefined;
  const base: ReferenceVisualAnalysis = {
    status: status as ReferenceVisualAnalysis['status'],
    schemaVersion: VISUAL_ANALYSIS_SCHEMA_VERSION,
    cacheKey: cleanString(o.cacheKey),
    provider: cleanString(o.provider),
    model: cleanString(o.model),
    analyzedAt: Number.isInteger(o.analyzedAt) && Number(o.analyzedAt) > 0 ? Number(o.analyzedAt) : null,
    sourceCount,
    ...(cleanString(o.error) ? { error: cleanString(o.error)! } : {}),
  };
  if (base.status !== 'analyzed' && base.status !== 'partial') return base;
  const bible = parseStyleBible(o.setStyleBible);
  const anchors = Array.from({ length: sourceCount }, (_, sourceArrayIndex) => ({ sourceArrayIndex, sourceIndex: sourceArrayIndex, capturedAt: 0, url: '' }));
  const coarse = parseCoarseFrames(o.frameSpecs, anchors, base.status === 'analyzed');
  const clusters = parseClusters(o.styleClusters, sourceCount);
  if (!bible || !coarse || !clusters) return undefined;
  const frameSpecs: VisualFrameSpec[] = [];
  const rawFrames = o.frameSpecs as unknown[];
  const rawByIndex = new Map(rawFrames.map((raw) => [Number((raw as Record<string, unknown>).sourceArrayIndex), raw as Record<string, unknown>]));
  for (let i = 0; i < coarse.length; i++) {
    const raw = rawByIndex.get(coarse[i].sourceArrayIndex);
    if (!raw) return undefined;
    const details = parseDetails(raw.details, familyForKind(coarse[i].kind));
    const sourceIndex = Number(raw.sourceIndex);
    if (!details || !Number.isInteger(sourceIndex) || sourceIndex < 0) return undefined;
    frameSpecs.push({ ...coarse[i], sourceIndex, details });
  }
  return { ...base, setStyleBible: bible, styleClusters: clusters, frameSpecs };
}

export function createVisualReferenceAnalyzer(deps: VisualReferenceAnalyzerDeps): VisualReferenceAnalyzer {
  const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0
    ? Math.floor(deps.timeoutMs)
    : envPositiveInt('AIDCP_REFERENCE_VISUAL_TIMEOUT_MS') ?? 120_000;
  const configuredBatchSize = deps.specialistBatchSize && deps.specialistBatchSize > 0
    ? Math.floor(deps.specialistBatchSize)
    : envPositiveInt('AIDCP_REFERENCE_VISUAL_SPECIALIST_BATCH_SIZE') ?? 3;
  const specialistBatchSize = Math.min(
    9,
    configuredBatchSize,
  );
  const clock = deps.clock ?? Date.now;

  return {
    async analyze(input): Promise<ReferenceVisualAnalysis> {
      const images = referenceImagesForGeneration(input.images);
      const anchors = visualAnalysisAnchors(images);
      if (anchors.length === 0) return emptyAnalysis('none', 0);
      if (!deps.enabled()) return emptyAnalysis('disabled', anchors.length);

      const provider = deps.getProvider();
      const model = deps.getModel();
      const cacheKey = visualAnalysisCacheKey(images, provider, model);
      const cached = normalizeReferenceVisualAnalysis(input.cached);
      if (
        cached &&
        (cached.status === 'analyzed' || cached.status === 'partial') &&
        cached.cacheKey === cacheKey &&
        cached.sourceCount === anchors.length
      ) {
        return cached;
      }

      let setRaw: string;
      try {
        setRaw = await deps.vision.chatVision(messagesForImages(setPrompt(), anchors), {
          role: VISUAL_REFERENCE_ANALYZER_ROLE,
          accountId: input.accountId,
          timeoutMs,
        });
      } catch (err) {
        return emptyAnalysis('unavailable', anchors.length, { cacheKey, provider, model, error: compactError(err) });
      }
      const setObj = extractJson(setRaw);
      const bible = parseStyleBible(setObj?.setStyleBible);
      const clusters = parseClusters(setObj?.styleClusters, anchors.length);
      const setFrames = parseSetFrames(setObj?.frames, anchors);
      if (!bible || !clusters || !setFrames) {
        return emptyAnalysis('unavailable', anchors.length, {
          cacheKey,
          provider,
          model,
          error: 'unparseable set analysis (strict schema mismatch)',
        });
      }

      const grouped = new Map<VisualFrameDetails['family'], SetFrame[]>();
      for (const frame of setFrames) {
        const family = familyForKind(frame.kind);
        grouped.set(family, [...(grouped.get(family) ?? []), frame]);
      }
      const specialistJobs = [...grouped.entries()].flatMap(([family, frames]) =>
        chunks(frames, specialistBatchSize).map((batch) => ({ family, frames: batch })),
      );
      const detailResults = await Promise.all(specialistJobs.map(async ({ family, frames }) => {
        const groupAnchors = frames.map((frame) => anchors[frame.sourceArrayIndex]);
        try {
          const raw = await deps.vision.chatVision(messagesForImages(specialistPrompt(family, frames.map((f) => f.sourceArrayIndex)), groupAnchors), {
            role: VISUAL_REFERENCE_ANALYZER_ROLE,
            accountId: input.accountId,
            timeoutMs,
          });
          const obj = extractJson(raw);
          if (!Array.isArray(obj?.frames) || obj.frames.length !== frames.length) throw new Error('specialist frame count mismatch');
          const parsed = new Map<number, VisualFrameSpec>();
          for (const item of obj.frames) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('specialist item invalid');
            const record = item as Record<string, unknown>;
            const index = Number(record.sourceArrayIndex);
            const expected = frames.find((frame) => frame.sourceArrayIndex === index);
            const details = expected ? parseDetails(record.details, familyForKind(expected.kind)) : null;
            const common = parseCommon(record.common);
            if (!expected || !common || !details || parsed.has(index)) throw new Error('specialist details invalid');
            parsed.set(index, { ...expected, common, details });
          }
          return { parsed, error: null as string | null };
        } catch (err) {
          return { parsed: new Map<number, VisualFrameSpec>(), error: `${family}: ${compactError(err)}` };
        }
      }));

      const detailedFrames = new Map<number, VisualFrameSpec>();
      const errors: string[] = [];
      for (const result of detailResults) {
        result.parsed.forEach((value, key) => detailedFrames.set(key, value));
        if (result.error) errors.push(result.error);
      }
      const frameSpecs = setFrames.flatMap((frame) => {
        const detailed = detailedFrames.get(frame.sourceArrayIndex);
        return detailed ? [detailed] : [];
      });
      if (frameSpecs.length === 0) {
        return emptyAnalysis('unavailable', anchors.length, { cacheKey, provider, model, error: errors.join('; ') || 'all specialist analyses failed' });
      }

      const analysis: ReferenceVisualAnalysis = {
        status: frameSpecs.length === anchors.length ? 'analyzed' : 'partial',
        schemaVersion: VISUAL_ANALYSIS_SCHEMA_VERSION,
        cacheKey,
        provider,
        model,
        analyzedAt: clock(),
        sourceCount: anchors.length,
        setStyleBible: bible,
        styleClusters: clusters,
        frameSpecs,
        ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
      };

      if (deps.annotate && input.curatedContentId !== null) {
        try {
          const written = await deps.annotate(input.curatedContentId, analysis, anchors);
          if (!written) deps.logger?.warn?.(`[VisualReferenceAnalyzer] cache annotation skipped rowId=${input.curatedContentId} source=${input.sourceId}`);
        } catch (err) {
          deps.logger?.warn?.(`[VisualReferenceAnalyzer] cache annotation failed rowId=${input.curatedContentId}: ${compactError(err)}`);
        }
      }
      return analysis;
    },
  };
}
