import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, GateDecision, AssembledContent, PublishResult, TriggerInput, PublishMetadata } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import type { CommandSequencer } from '../command-sequencer.js';

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
    /** stage-4 来源血缘（缺省时由适配器回退 tags / []）。 */
    sourceConcepts?: string[];
    sourceLikedIds?: number[];
  }): Promise<number>;
  /** 发布结果回写（指令驱动路径用；可选以兼容仅 insert 的旧桩）。 */
  updateStatus?(id: number, status: string): Promise<void>;
  updatePostId?(id: number, postId: string): Promise<void>;
  /** stage-4 元数据落库 + 防篡改审计（可选）。 */
  recordMetadata?(id: number, metadata: unknown, aiEnforced: boolean): Promise<void>;
  /**
   * 配图收口：标记该帖配图是否真实附着。请求了配图但降级纯文字时置 false——
   * 保留 image_url 供审计，但 images_attached 才是「该帖是否真有图」的权威信号（杜绝纯文字帖被读成带图）。
   */
  markImagesAttached?(id: number, attached: boolean): Promise<void>;
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
  /** A 阶段1 指令驱动：注入则 auto_publish 走「逐条指令 + AC-PUB 闸 + 回写」新路；不注入走旧整页 publish.request。 */
  sequencer?: CommandSequencer;
  /** AC-PUB 第1道：按 requestId 读审批信号判定是否已人审通过（缺省视为未授权）。 */
  isApproved?: (requestId: string) => Promise<boolean>;
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
  private sequencer?: CommandSequencer;
  private isApproved?: (requestId: string) => Promise<boolean>;
  private idGen: () => string;

  constructor(deps: PublishExecutorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.store = deps.store;
    this.pusher = deps.pusher;
    this.messenger = deps.messenger;
    this.botChatStore = deps.botChatStore;
    this.sequencer = deps.sequencer;
    this.isApproved = deps.isApproved;
    this.idGen = deps.idGen ?? (() => Math.random().toString(36).slice(2));
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ExecutorInput {
    return {
      gateDecision: snapshot.gateDecision!,
      assembledContent: snapshot.assembledContent!,
    };
  }

  protected async execute(input: ExecutorInput, context: PipelineContext<PipelineFields>): Promise<PublishResult> {
    const { gateDecision, assembledContent } = input;

    switch (gateDecision.recommendedAction) {
      case 'auto_publish':
        return this.handleAutoPublish(assembledContent, context);
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

  /** stage-4 来源血缘：从 trigger 取真概念/真点赞 id（无则空，不编造）。 */
  private lineageFrom(context: PipelineContext<PipelineFields>): { sourceConcepts: string[]; sourceLikedIds: number[] } {
    const trigger = context.get('trigger') as TriggerInput | undefined;
    const gi = trigger?.generateInput;
    return {
      sourceConcepts: gi?.concepts?.map((c) => c.keyword) ?? [],
      sourceLikedIds: gi?.likedContents?.map((l) => l.id) ?? [],
    };
  }

  private async handleAutoPublish(assembled: AssembledContent, context: PipelineContext<PipelineFields>): Promise<PublishResult> {
    const lineage = this.lineageFrom(context);
    const recordId = await this.store.insert({
      title: this.deriveTitle(assembled),
      content: assembled.finalContent,
      tags: assembled.finalTags,
      imageUrl: assembled.imageUrl,
      status: 'draft',
      qualityScore: assembled.qualityScore,
      aiScore: assembled.aiScore,
      sourceConcepts: lineage.sourceConcepts,
      sourceLikedIds: lineage.sourceLikedIds,
    });

    // A 阶段1 新路：注入了 sequencer → 指令驱动 + AC-PUB 闸 + 结果回写。
    if (this.sequencer) {
      return this.handleAutoPublishViaSequencer(recordId, assembled, context);
    }

    // 旧整页路径（无 sequencer，地基阶段并行保留）。
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

  /** 指令驱动发布：AC-PUB 第1道（读审批信号）→ 未授权发卡 needs_review；已授权驱动序列 + 回写状态。 */
  private async handleAutoPublishViaSequencer(
    recordId: number,
    assembled: AssembledContent,
    context: PipelineContext<PipelineFields>,
  ): Promise<PublishResult> {
    // stage-4：读 stage-3 决策的元数据；落库（血缘/可观测）+ 防篡改审计（aiEnforced && !ai 视为已回正态，如实记）。
    const metadata = context.get('publishMetadata') as PublishMetadata | undefined;
    if (metadata && this.store.recordMetadata) {
      const aiEnforced = metadata.compliance.aiEnforced === true;
      await this.store.recordMetadata(recordId, metadata, aiEnforced).catch(() => {});
    }

    const requestId = `publish-${recordId}`;
    const approved = this.isApproved ? await this.isApproved(requestId).catch(() => false) : false;

    if (!approved) {
      // AC-PUB 第1道：未授权 → 发审批卡 + needs_review，绝不下发任何指令（红线：未授权不发布）。
      await this.trySendApprovalCard(recordId, assembled, requestId);
      if (this.store.updateStatus) await this.store.updateStatus(recordId, 'needs_review').catch(() => {});
      this.logger.log(`[PublishExecutor] cmd-path 未授权 → needs_review recordId=${recordId} requestId=${requestId}`);
      return { recordId, status: 'needs_review', dispatched: false, envelope: null, completedAt: this.clock() };
    }

    const hadImage = !!assembled.imageUrl;
    const result = await this.sequencer!.executePublishSequence({
      recordId,
      title: this.deriveTitle(assembled),
      content: assembled.finalContent,
      tags: assembled.finalTags,
      images: assembled.imageUrl ? [assembled.imageUrl] : undefined,
      // 单图：封面即该图本身（全图成功才会真实下发 set_cover）。
      cover: assembled.imageUrl ?? undefined,
      metadata,
      approvedByUser: true,
    });

    // 配图收口：请求了配图时如实标记是否附着——降级（imagesOk=false）即纯文字真相，杜绝「有图」假信号。
    if (hadImage && this.store.markImagesAttached) {
      await this.store.markImagesAttached(recordId, result.imagesOk).catch(() => {});
    }

    if (result.ok && result.postId) {
      if (this.store.updatePostId) await this.store.updatePostId(recordId, result.postId).catch(() => {});
      this.logger.log(`[PublishExecutor] cmd-path published recordId=${recordId} postId=${result.postId}`);
      return { recordId, status: 'published', dispatched: true, envelope: null, completedAt: this.clock() };
    }

    // 红线：序列失败/未抓到 postId → 如实 failed，绝不伪造发布成功。
    if (this.store.updateStatus) await this.store.updateStatus(recordId, 'failed').catch(() => {});
    this.logger.warn(`[PublishExecutor] cmd-path failed recordId=${recordId} failedAt=${JSON.stringify(result.failedAt)}`);
    return { recordId, status: 'failed', dispatched: true, envelope: null, completedAt: this.clock() };
  }

  /** AssembledContent 不带独立 title（属 stage2 内容链路），本阶段从正文首行/截断派生。 */
  private deriveTitle(assembled: AssembledContent): string {
    const firstLine = assembled.finalContent.split('\n')[0]?.trim() ?? '';
    return (firstLine || assembled.finalContent).slice(0, 30);
  }

  private async trySendApprovalCard(
    recordId: number,
    assembled: AssembledContent,
    requestId: string,
  ): Promise<void> {
    if (!this.messenger || !this.botChatStore) return;
    try {
      const chat = await this.botChatStore.getDefaultChat();
      if (chat) {
        await this.messenger.sendApprovalCard(chat.chatId, {
          recordId,
          requestId,
          contentPreview: assembled.finalContent.slice(0, 100),
          qualityScore: assembled.qualityScore,
          aiScore: assembled.aiScore,
        });
        this.logger.log(`[PublishExecutor] 审批卡已发 chat=${chat.chatId} requestId=${requestId}`);
      }
    } catch (err) {
      this.logger.warn(`[PublishExecutor] 发审批卡失败: ${err instanceof Error ? err.message : String(err)}`);
    }
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
