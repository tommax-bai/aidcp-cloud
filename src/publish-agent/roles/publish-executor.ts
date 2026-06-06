import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, GateDecision, AssembledContent, PublishResult } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/** PublishLogStore 接口 */
export interface PublishLogStore {
  insert(record: {
    title: string;
    content: string;
    tags: string[];
    imageUrl: string | null;
    status: string;
    qualityScore: number;
    aiScore: number;
  }): Promise<number>;
}

/** 边缘推送接口 */
export interface EdgePusher {
  pushToEdges(envelope: unknown, edgeId?: string): number;
}

/** 飞书消息接口 */
export interface ApprovalMessenger {
  sendApprovalCard(chatId: string, card: unknown): Promise<void>;
}

/** Bot 聊天存储接口 */
export interface BotChatStore {
  getDefaultChat(): Promise<{ chatId: string } | null>;
}

export interface PublishExecutorDeps {
  store: PublishLogStore;
  pusher: EdgePusher;
  messenger?: ApprovalMessenger;
  botChatStore?: BotChatStore;
  idGen?: () => string;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface ExecutorInput {
  gateDecision: GateDecision;
  assembledContent: AssembledContent;
}

export class PublishExecutorRole extends BasePublishRole<ExecutorInput, PublishResult> {
  readonly config: RoleConfig = {
    name: 'PublishExecutor',
    watchKeys: ['gateDecision'],
    timeoutMs: 15000,
    fallback: 'skip',
  };
  protected readonly outputKey = 'publishResult' as const;
  private store: PublishLogStore;
  private pusher: EdgePusher;
  private messenger?: ApprovalMessenger;
  private botChatStore?: BotChatStore;
  private idGen: () => string;

  constructor(deps: PublishExecutorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.store = deps.store;
    this.pusher = deps.pusher;
    this.messenger = deps.messenger;
    this.botChatStore = deps.botChatStore;
    this.idGen = deps.idGen ?? (() => Math.random().toString(36).slice(2));
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ExecutorInput {
    return {
      gateDecision: snapshot.gateDecision!,
      assembledContent: snapshot.assembledContent!,
    };
  }

  protected async execute(input: ExecutorInput, _context: PipelineContext<PipelineFields>): Promise<PublishResult> {
    const { gateDecision, assembledContent } = input;

    switch (gateDecision.recommendedAction) {
      case 'auto_publish':
        return this.handleAutoPublish(assembledContent);
      case 'manual_review':
        return this.handleManualReview(assembledContent);
      case 'abort':
        return this.handleAbort(assembledContent);
      case 'retry':
        return this.handleRetry();
      default:
        return this.handleAbort(assembledContent);
    }
  }

  private async handleAutoPublish(assembled: AssembledContent): Promise<PublishResult> {
    const recordId = await this.store.insert({
      title: assembled.finalContent.slice(0, 50),
      content: assembled.finalContent,
      tags: assembled.finalTags,
      imageUrl: assembled.imageUrl,
      status: 'draft',
      qualityScore: assembled.qualityScore,
      aiScore: assembled.aiScore,
    });

    const envelope = {
      id: this.idGen(),
      type: 'publish.request',
      payload: {
        recordId,
        content: assembled.finalContent,
        tags: assembled.finalTags,
        imageUrl: assembled.imageUrl,
      },
      createdAt: this.clock(),
    };

    const dispatched = this.pusher.pushToEdges(envelope);

    this.logger.log(`[PublishExecutor] auto_publish: recordId=${recordId}, dispatched=${dispatched}`);

    return {
      recordId,
      status: 'draft',
      dispatched: dispatched > 0,
      envelope,
      completedAt: this.clock(),
    };
  }

  private async handleManualReview(assembled: AssembledContent): Promise<PublishResult> {
    const recordId = await this.store.insert({
      title: assembled.finalContent.slice(0, 50),
      content: assembled.finalContent,
      tags: assembled.finalTags,
      imageUrl: assembled.imageUrl,
      status: 'needs_review',
      qualityScore: assembled.qualityScore,
      aiScore: assembled.aiScore,
    });

    // 尝试发送飞书审批卡片
    if (this.messenger && this.botChatStore) {
      try {
        const chat = await this.botChatStore.getDefaultChat();
        if (chat) {
          await this.messenger.sendApprovalCard(chat.chatId, {
            recordId,
            contentPreview: assembled.finalContent.slice(0, 100),
            qualityScore: assembled.qualityScore,
            aiScore: assembled.aiScore,
          });
          this.logger.log(`[PublishExecutor] approval card sent to chat=${chat.chatId}`);
        }
      } catch (err) {
        this.logger.warn(`[PublishExecutor] failed to send approval card: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      recordId,
      status: 'needs_review',
      dispatched: false,
      envelope: null,
      completedAt: this.clock(),
    };
  }

  private async handleAbort(assembled: AssembledContent): Promise<PublishResult> {
    const recordId = await this.store.insert({
      title: assembled.finalContent.slice(0, 50),
      content: assembled.finalContent,
      tags: assembled.finalTags,
      imageUrl: assembled.imageUrl,
      status: 'failed',
      qualityScore: assembled.qualityScore,
      aiScore: assembled.aiScore,
    });

    this.logger.log(`[PublishExecutor] aborted: recordId=${recordId}`);

    return {
      recordId,
      status: 'failed',
      dispatched: false,
      envelope: null,
      completedAt: this.clock(),
    };
  }

  private async handleRetry(): Promise<PublishResult> {
    this.logger.log('[PublishExecutor] retry requested — writing failed result');

    return {
      recordId: null,
      status: 'failed',
      dispatched: false,
      envelope: null,
      completedAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): PublishResult {
    return {
      recordId: null,
      status: 'skipped',
      dispatched: false,
      envelope: null,
      completedAt: this.clock(),
    };
  }
}
