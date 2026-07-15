import type { VisionChatMessage, VisionLlmClient } from '../llm/vision.js';
import type {
  ContentVisualBrief,
  VisualAuditAttempt,
  VisualAuditRisks,
  VisualAuditScores,
  VisualFrameSpec,
} from './visual-reference-types.js';
import { categorySafetyInstruction, formatContentVisualCategoryBrief } from './content-visual-brief.js';

export const VISUAL_FIDELITY_AUDITOR_ROLE = 'publish:VisualFidelityAuditor';
export const DEFAULT_VISUAL_AUDIT_PROVIDER = 'dashscope';
export const DEFAULT_VISUAL_AUDIT_MODEL = 'qwen3.7-plus';

export function resolveVisualAuditProvider(): string {
  return process.env.AIDCP_VISUAL_AUDIT_PROVIDER?.trim() || DEFAULT_VISUAL_AUDIT_PROVIDER;
}

export function resolveVisualAuditModel(): string {
  return process.env.AIDCP_VISUAL_AUDIT_MODEL?.trim() || DEFAULT_VISUAL_AUDIT_MODEL;
}

export interface VisualAuditInput {
  accountId: string;
  referenceUrl: string;
  generatedUrl: string;
  expectedFrame?: VisualFrameSpec;
  contentVisualBrief?: ContentVisualBrief;
}

export interface VisualFidelityAuditor {
  audit(input: VisualAuditInput): Promise<VisualAuditAttempt>;
}

export interface VisualFidelityAuditorDeps {
  vision: VisionLlmClient;
  timeoutMs?: number;
  minScore?: number;
  clock?: () => number;
}

function compactError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function unit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;
}

function parse(raw: string, requireContentAlignment: boolean): { scores: VisualAuditScores; risks: VisualAuditRisks; reason: string; retryGuidance?: string } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (!o.scores || typeof o.scores !== 'object' || Array.isArray(o.scores)) return null;
  if (!o.risks || typeof o.risks !== 'object' || Array.isArray(o.risks)) return null;
  const scoreRaw = o.scores as Record<string, unknown>;
  const riskRaw = o.risks as Record<string, unknown>;
  const scoreValues = ['form', 'subject', 'composition', 'color', 'style'].map((key) => unit(scoreRaw[key]));
  const contentAlignment = unit(scoreRaw.contentAlignment);
  const reason = text(o.reason);
  if (scoreValues.some((score) => score === null) || (requireContentAlignment && contentAlignment === null) || !reason) return null;
  const boolKeys = ['recognizableRealPerson', 'garbledText', 'watermark', 'copiedText'] as const;
  if (boolKeys.some((key) => typeof riskRaw[key] !== 'boolean')) return null;
  if (!['low', 'medium', 'high'].includes(String(riskRaw.originalityRisk))) return null;
  return {
    scores: {
      form: scoreValues[0]!,
      subject: scoreValues[1]!,
      composition: scoreValues[2]!,
      color: scoreValues[3]!,
      style: scoreValues[4]!,
      ...(contentAlignment !== null ? { contentAlignment } : {}),
    },
    risks: {
      recognizableRealPerson: riskRaw.recognizableRealPerson as boolean,
      garbledText: riskRaw.garbledText as boolean,
      watermark: riskRaw.watermark as boolean,
      copiedText: riskRaw.copiedText as boolean,
      originalityRisk: riskRaw.originalityRisk as VisualAuditRisks['originalityRisk'],
    },
    reason,
    ...(text(o.retryGuidance) ? { retryGuidance: text(o.retryGuidance)! } : {}),
  };
}

function buildMessages(input: VisualAuditInput): VisionChatMessage[] {
  const expectation = input.expectedFrame
    ? `期望类型=${input.expectedFrame.kind}；主体=${input.expectedFrame.common.subject}；构图=${input.expectedFrame.common.composition}；色彩=${input.expectedFrame.common.palette.join('、')}；氛围=${input.expectedFrame.common.mood}`
    : '无额外结构化期望，以主参考图为准。';
  const contentExpectation = input.contentVisualBrief
    ? `正文视觉 brief（具体内容语义最高优先级）：叙事瞬间=${input.contentVisualBrief.narrativeMoment}；情绪=${input.contentVisualBrief.emotion}；强度=${input.contentVisualBrief.emotionIntensity}；动作=${input.contentVisualBrief.action}；环境=${input.contentVisualBrief.environment}；分类语义=${input.contentVisualBrief.categoryBrief ? formatContentVisualCategoryBrief(input.contentVisualBrief.categoryBrief) : '历史记录未提供'}；分类安全约束=${input.contentVisualBrief.categoryBrief ? categorySafetyInstruction(input.contentVisualBrief.categoryBrief) : '无'}；必须避免=${input.contentVisualBrief.avoid.join('、') || '无'}。`
    : '无正文视觉 brief，不要求 contentAlignment 字段。';
  const scoreInstruction = input.contentVisualBrief
    ? '逐项给 0..1 分：form(画面类型)、subject(主体关系)、composition(参考构图层级)、color(参考色彩光影)、style(参考抽象风格)、contentAlignment(按 categoryBrief.kind 核验对应人物表演、文字结构、图表关系、场景事件、静物状态、插画隐喻、UI 任务或拼贴分区，并检查禁用项)。'
    : '逐项给 0..1 分：form(画面类型)、subject(主体关系)、composition(构图层级)、color(色彩光影)、style(抽象风格)。';
  const scoreShape = input.contentVisualBrief
    ? '"scores":{"form":0.0,"subject":0.0,"composition":0.0,"color":0.0,"style":0.0,"contentAlignment":0.0}'
    : '"scores":{"form":0.0,"subject":0.0,"composition":0.0,"color":0.0,"style":0.0}';
  return [{
    role: 'user',
    content: [
      {
        type: 'text',
        text: `你是生成配图的视觉保真与原创风险审核员。图1是主参考，图2是生成结果。比较抽象视觉关系，不要求像素复制。
${expectation}
${contentExpectation}
职责边界：参考图只约束视觉形式与抽象风格；正文分类 brief 的专用内容语义决定具体内容表达，其中人物表演与叙事语义最高优先级。两者冲突时按正文 brief 评价 contentAlignment，不因生成内容没有复制参考图的人物情绪、文字、数据或界面内容而扣分。
${scoreInstruction}
风险：recognizableRealPerson 只在生成脸能对应来源真人、名人或其他可识别真实身份时为 true；普通虚构人像即使清晰露脸也不是该风险。另核验乱码/无意义文字、画内水印/平台标识、明显逐字复制原图文字、原创风险 low|medium|high。
禁止在输出中复述图中文字、账号、数值或水印内容。严格只输出：
{${scoreShape},"risks":{"recognizableRealPerson":false,"garbledText":false,"watermark":false,"copiedText":false,"originalityRisk":"low|medium|high"},"reason":"简短理由，不引用图中文字","retryGuidance":"若失败，给可执行的视觉修正，不引用图中文字"}`,
      },
      { type: 'text', text: '图1：主参考' },
      { type: 'image_url', image_url: { url: input.referenceUrl } },
      { type: 'text', text: '图2：生成结果' },
      { type: 'image_url', image_url: { url: input.generatedUrl } },
    ],
  }];
}

export function createVisualFidelityAuditor(deps: VisualFidelityAuditorDeps): VisualFidelityAuditor {
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const minScore = deps.minScore ?? Number(process.env.AIDCP_VISUAL_FIDELITY_MIN_SCORE ?? 0.62);
  const threshold = Number.isFinite(minScore) ? Math.max(0, Math.min(1, minScore)) : 0.62;
  const clock = deps.clock ?? Date.now;
  return {
    async audit(input): Promise<VisualAuditAttempt> {
      let raw: string;
      try {
        raw = await deps.vision.chatVision(buildMessages(input), {
          role: VISUAL_FIDELITY_AUDITOR_ROLE,
          accountId: input.accountId,
          timeoutMs,
        });
      } catch (err) {
        return { status: 'unverified', reason: compactError(err), auditedAt: clock() };
      }
      const parsed = parse(raw, !!input.contentVisualBrief);
      if (!parsed) return { status: 'unverified', reason: 'unparseable visual audit output', auditedAt: clock() };
      const hardRisk =
        parsed.risks.recognizableRealPerson ||
        parsed.risks.garbledText ||
        parsed.risks.watermark ||
        parsed.risks.copiedText ||
        parsed.risks.originalityRisk === 'high';
      const scores = Object.values(parsed.scores);
      const pass = !hardRisk && scores.every((score) => score >= threshold);
      return {
        status: pass ? 'passed' : 'failed',
        scores: parsed.scores,
        risks: parsed.risks,
        reason: parsed.reason,
        ...(parsed.retryGuidance ? { retryGuidance: parsed.retryGuidance } : {}),
        auditedAt: clock(),
      };
    },
  };
}
