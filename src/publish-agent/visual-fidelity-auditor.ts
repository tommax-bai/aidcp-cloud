import type { VisionChatMessage, VisionContentPart, VisionLlmClient } from '../llm/vision.js';
import type {
  VisualAuditAttempt,
  VisualAuditMode,
  VisualAuditRisks,
  VisualAuditScores,
} from '../kernel/visual-reference-types.js';
import {
  buildVisualFidelityAuditPrompt,
  type VisualAuditInput,
} from '../kernel/visual-fidelity-audit-prompt.js';

// 审核输入模型与纯文本指令构建已抬入 kernel（src/kernel/visual-fidelity-audit-prompt.ts，
// change decouple-behavior-class-ports）；此处等值再导出，既有导入方无感、行为逐字不变。
export { buildVisualFidelityAuditPrompt, type VisualAuditInput };

export const VISUAL_FIDELITY_AUDITOR_ROLE = 'publish:VisualFidelityAuditor';
export const DEFAULT_VISUAL_AUDIT_PROVIDER = 'dashscope';
export const DEFAULT_VISUAL_AUDIT_MODEL = 'qwen3.7-plus';

export function resolveVisualAuditProvider(): string {
  return process.env.AIDCP_VISUAL_AUDIT_PROVIDER?.trim() || DEFAULT_VISUAL_AUDIT_PROVIDER;
}

export function resolveVisualAuditModel(): string {
  return process.env.AIDCP_VISUAL_AUDIT_MODEL?.trim() || DEFAULT_VISUAL_AUDIT_MODEL;
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

function parse(
  raw: string,
  requireContentAlignment: boolean,
  mode: Exclude<VisualAuditMode, 'skipped'>,
): { scores: VisualAuditScores; risks: VisualAuditRisks; reason: string; retryGuidance?: string } | null {
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
  const rawCopyCheck = riskRaw.copyCheck;
  const copyCheck = rawCopyCheck === 'evaluated' || rawCopyCheck === 'not_applicable'
    ? rawCopyCheck
    : mode === 'reference_fidelity' ? 'evaluated' : null;
  const expectedCopyCheck = mode === 'reference_fidelity' ? 'evaluated' : 'not_applicable';
  if (!copyCheck || copyCheck !== expectedCopyCheck || (mode === 'content_alignment' && riskRaw.copiedText !== false)) return null;
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
      copyCheck,
      originalityRisk: riskRaw.originalityRisk as VisualAuditRisks['originalityRisk'],
    },
    reason,
    ...(text(o.retryGuidance) ? { retryGuidance: text(o.retryGuidance)! } : {}),
  };
}

function buildMessages(input: VisualAuditInput): VisionChatMessage[] {
  const imageContent: VisionContentPart[] = [
    { type: 'text', text: buildVisualFidelityAuditPrompt(input) },
  ];
  if (input.referenceUrl) {
    imageContent.push(
      { type: 'text', text: '图1：主参考' },
      { type: 'image_url', image_url: { url: input.referenceUrl } },
      { type: 'text', text: '图2：生成结果' },
    );
  } else {
    imageContent.push({ type: 'text', text: '生成结果' });
  }
  imageContent.push({ type: 'image_url', image_url: { url: input.generatedUrl } });
  return [{
    role: 'user',
    content: imageContent,
  }];
}

export function createVisualFidelityAuditor(deps: VisualFidelityAuditorDeps): VisualFidelityAuditor {
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const minScore = deps.minScore ?? Number(process.env.AIDCP_VISUAL_FIDELITY_MIN_SCORE ?? 0.62);
  const threshold = Number.isFinite(minScore) ? Math.max(0, Math.min(1, minScore)) : 0.62;
  const clock = deps.clock ?? Date.now;
  return {
    async audit(input): Promise<VisualAuditAttempt> {
      const mode: Exclude<VisualAuditMode, 'skipped'> = input.referenceUrl ? 'reference_fidelity' : 'content_alignment';
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
      const parsed = parse(raw, !!input.contentVisualBrief, mode);
      if (!parsed) return { status: 'unverified', reason: 'unparseable visual audit output', auditedAt: clock() };
      const hardRisk =
        parsed.risks.recognizableRealPerson ||
        parsed.risks.garbledText ||
        parsed.risks.watermark ||
        (parsed.risks.copyCheck !== 'not_applicable' && parsed.risks.copiedText) ||
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
