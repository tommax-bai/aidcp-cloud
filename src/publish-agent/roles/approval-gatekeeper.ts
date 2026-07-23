import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, AssembledContent, GateDecision } from '../../kernel/publish-pipeline-types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildGatekeeperPrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

// change raise-model-call-timeouts-for-thinking-models：角色闸 ≥ 单次模型天花板（180s）且同传进 chat()，
// 使一次合法的 thinking 审批调用不被角色秒表提前掐断（旧 15s 峰值必误超时→退化默认放行、审批闸失效）。env 可调。
const GATE_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_GATE_TIMEOUT_MS ?? 180_000);

export interface ApprovalGatekeeperDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ApprovalGatekeeperRole extends BasePublishRole<AssembledContent, GateDecision> {
  readonly config: RoleConfig = {
    name: 'ApprovalGatekeeper',
    watchKeys: ['assembledContent'],
    timeoutMs: GATE_TIMEOUT_MS,
    fallback: 'default',
  };
  protected readonly outputKey = 'gateDecision' as const;
  private llmClient: ChatLlmClient;

  constructor(deps: ApprovalGatekeeperDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): AssembledContent {
    return snapshot.assembledContent!;
  }

  protected async execute(input: AssembledContent, context: PipelineContext<PipelineFields>): Promise<GateDecision> {
    const { result, usedFallback } = await executeWithFallback(
      async () => {
        const raw = await this.llmClient.chat([
          { role: 'system', content: '你是发布审批决策者。严格返回JSON。' },
          { role: 'user', content: buildGatekeeperPrompt(input) },
        ], { timeoutMs: GATE_TIMEOUT_MS, accountId: this.accountIdFrom(context) });
        return this.parseOutput(raw);
      },
      { default: this.getHardcodedDecision(input), reason: 'LLM gatekeeper failed' },
    );

    if (usedFallback) {
      this.logger.warn('[ApprovalGatekeeper] LLM failed, using hardcoded rules');
    }

    return { ...result, decidedAt: this.clock() };
  }

  private parseOutput(raw: string): Omit<GateDecision, 'decidedAt'> {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in Gatekeeper output');
    const obj = JSON.parse(match[0]);
    const validActions: GateDecision['recommendedAction'][] = ['auto_publish', 'manual_review', 'retry', 'abort'];
    const action = validActions.includes(obj.recommendedAction) ? obj.recommendedAction : 'manual_review';
    return {
      needsApproval: Boolean(obj.needsApproval),
      recommendedAction: action,
      reason: String(obj.reason || ''),
    };
  }

  private getHardcodedDecision(assembled: AssembledContent): Omit<GateDecision, 'decidedAt'> {
    if (assembled.aiScore > 0.6 && assembled.flaggedPhrases.length >= 3) {
      return { needsApproval: false, recommendedAction: 'abort', reason: 'AI味过重且禁用词过多（硬编码规则）' };
    }
    if (assembled.qualityScore < 60) {
      return { needsApproval: false, recommendedAction: 'retry', reason: '质量评分不达标（硬编码规则）' };
    }
    if (assembled.aiScore >= 0.5) {
      return { needsApproval: true, recommendedAction: 'manual_review', reason: 'AI味偏高需人工审核（硬编码规则）' };
    }
    return { needsApproval: false, recommendedAction: 'auto_publish', reason: '各项指标达标（硬编码规则）' };
  }
}
