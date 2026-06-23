import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, GateDecision, AssembledContent, PublishResult, TriggerInput, PublishMetadata, TitleSelection } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import type { CommandSequencer } from '../command-sequencer.js';
import { buildPublishApprovalCard } from '../../feishu/cards.js';
import { clampTitle, firstSentence } from '../title-clamp.js';

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
  /** 未预授权时，发卡后在此窗口内轮询审批信号等待人审（毫秒，默认 240s）。期满未授权 → needs_review。 */
  approvalWaitMs?: number;
  /** 审批轮询间隔（毫秒，默认 3s）。 */
  approvalPollMs?: number;
  /** 角色执行超时（毫秒，默认 360s）；须 ≥ approvalWaitMs + 指令序列耗时，否则审批等待会被角色超时打断。 */
  roleTimeoutMs?: number;
  /** sleep 注入（测试用）。 */
  sleep?: (ms: number) => Promise<void>;
  idGen?: () => string;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface ExecutorInput {
  gateDecision: GateDecision;
  assembledContent: AssembledContent;
  titleSelection: TitleSelection;
}

export class PublishExecutorRole extends BasePublishRole<ExecutorInput, PublishResult> {
  readonly config: RoleConfig;
  protected readonly outputKey = 'publishResult' as const;
  private store: PublishLogStore;
  private pusher: EdgePusher;
  private messenger?: ApprovalMessenger;
  private botChatStore?: BotChatStore;
  private sequencer?: CommandSequencer;
  private isApproved?: (requestId: string) => Promise<boolean>;
  private approvalWaitMs: number;
  private approvalPollMs: number;
  private sleep: (ms: number) => Promise<void>;
  private idGen: () => string;

  constructor(deps: PublishExecutorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.store = deps.store;
    this.pusher = deps.pusher;
    this.messenger = deps.messenger;
    this.botChatStore = deps.botChatStore;
    this.sequencer = deps.sequencer;
    this.isApproved = deps.isApproved;
    this.approvalWaitMs = deps.approvalWaitMs ?? 240_000;
    this.approvalPollMs = deps.approvalPollMs ?? 3_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.idGen = deps.idGen ?? (() => Math.random().toString(36).slice(2));
    // 角色超时须容纳审批等待 + 指令序列；默认 360s（> approvalWaitMs 240s + 序列）。
    // 发布门 = waitAll(['gateDecision','titleSelection'])：标题没就绪不发布；标题 abort 不发布（黑板天然保证）。
    // 审批卡由本角色激活后才发，故卡片必带真实标题。
    this.config = {
      name: 'PublishExecutor',
      watchKeys: ['gateDecision', 'titleSelection'],
      waitAll: true,
      timeoutMs: deps.roleTimeoutMs ?? 360_000,
      fallback: 'skip',
    };
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ExecutorInput {
    return {
      gateDecision: snapshot.gateDecision!,
      assembledContent: snapshot.assembledContent!,
      titleSelection: snapshot.titleSelection!,
    };
  }

  protected async execute(input: ExecutorInput, context: PipelineContext<PipelineFields>): Promise<PublishResult> {
    const { gateDecision, assembledContent } = input;
    // 标题收口：正常路径由 TitleCreator 产出（已 ≤18、字形安全）；意外缺失才字形安全派生。
    const title = this.resolveTitle(input.titleSelection, assembledContent);

    switch (gateDecision.recommendedAction) {
      case 'auto_publish':
        return this.handleAutoPublish(assembledContent, title, context);
      // manual_review 在指令驱动路径（sequencer 已注入）下与 auto_publish 同路：AC-PUB 本就要求人审，两者最终都是
      // 「发审批卡 → 人审通过 → 驱动指令序列」，差别仅是 gatekeeper 的风险标注、由人在卡片上定夺；真正"不问就毙"的是 abort。
      // 无 sequencer（旧路）才退回 handleManualReview。
      case 'manual_review':
        return this.sequencer
          ? this.handleAutoPublish(assembledContent, title, context)
          : this.handleManualReview(assembledContent, title);
      case 'abort':
        return this.handleAbort(assembledContent, title);
      case 'retry':
        return this.handleRetry();
      default:
        return this.handleAbort(assembledContent, title);
    }
  }

  /**
   * 标题出口收口：优先用 TitleCreator 的 titleSelection.title（已 ≤18、字形安全）。
   * waitAll 已保证 titleSelection 必就绪；此处的兜底仅防字段意外缺失——字形安全派生，绝不盲切。
   */
  private resolveTitle(selection: TitleSelection | undefined, assembled: AssembledContent): string {
    if (selection && typeof selection.title === 'string') return selection.title;
    this.logger.warn('[PublishExecutor] titleSelection 缺失，降级派生标题（字形安全 clamp）');
    return this.deriveTitle(assembled);
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

  private async handleAutoPublish(assembled: AssembledContent, title: string, context: PipelineContext<PipelineFields>): Promise<PublishResult> {
    const lineage = this.lineageFrom(context);
    // 配图收口红线（change publish-image-required-or-fail）：图文帖必须有图。配图失败/降级（imageUrl 为空）时，
    // 小红书图文编辑器「先传图门控」下标题/正文框根本不渲染，强行驱动只会在 fill_field no_target 才暴露。
    // 此处**提前诚实判 failed**——不发审批卡、不下发指令、images_attached=false（红线：不静默走必然失败的纯文字路径）。
    if (!assembled.imageUrl) {
      const failedId = await this.store.insert({
        title,
        content: assembled.finalContent,
        tags: assembled.finalTags,
        imageUrl: null,
        status: 'failed',
        qualityScore: assembled.qualityScore,
        aiScore: assembled.aiScore,
        sourceConcepts: lineage.sourceConcepts,
        sourceLikedIds: lineage.sourceLikedIds,
      });
      if (this.store.markImagesAttached) await this.store.markImagesAttached(failedId, false).catch(() => {});
      this.logger.warn(`[PublishExecutor] 无配图（生图失败/降级）→ 图文帖无有效内容，诚实 failed recordId=${failedId}（不发卡、不下发）`);
      return { recordId: failedId, status: 'failed', dispatched: false, envelope: null, completedAt: this.clock() };
    }
    const recordId = await this.store.insert({
      title,
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
      return this.handleAutoPublishViaSequencer(recordId, assembled, title, context);
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
    title: string,
    context: PipelineContext<PipelineFields>,
  ): Promise<PublishResult> {
    // stage-4：读 stage-3 决策的元数据；落库（血缘/可观测）+ 防篡改审计（aiEnforced && !ai 视为已回正态，如实记）。
    const metadata = context.get('publishMetadata') as PublishMetadata | undefined;
    if (metadata && this.store.recordMetadata) {
      const aiEnforced = metadata.compliance.aiEnforced === true;
      await this.store.recordMetadata(recordId, metadata, aiEnforced).catch(() => {});
    }

    const requestId = `publish-${recordId}`;
    let approved = this.isApproved ? await this.isApproved(requestId).catch(() => false) : false;

    if (!approved) {
      // AC-PUB 第1道：未预授权 → 发审批卡，然后在窗口内轮询审批信号等待人审。
      // 人审通过即继续发布「卡片上所审的这份内容」（不重新生成）；期满未授权 → needs_review。绝不未授权下发指令（红线）。
      await this.trySendApprovalCard(assembled, title, requestId);
      approved = await this.waitForApproval(requestId);
    }

    if (!approved) {
      if (this.store.updateStatus) await this.store.updateStatus(recordId, 'needs_review').catch(() => {});
      this.logger.log(`[PublishExecutor] cmd-path 未授权（超窗）→ needs_review recordId=${recordId} requestId=${requestId}`);
      return { recordId, status: 'needs_review', dispatched: false, envelope: null, completedAt: this.clock() };
    }

    const hadImage = !!assembled.imageUrl;
    const result = await this.sequencer!.executePublishSequence({
      recordId,
      title,
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

    // 提交成功即已发布（capture_postId 为尽力而为，抓不到 postId 也不可误判为 failed——那是「静默假失败」）。
    if (result.ok) {
      if (result.postId && this.store.updatePostId) {
        await this.store.updatePostId(recordId, result.postId).catch(() => {});
      } else if (this.store.updateStatus) {
        await this.store.updateStatus(recordId, 'published').catch(() => {});
      }
      this.logger.log(`[PublishExecutor] cmd-path published recordId=${recordId} postId=${result.postId ?? '(未抓到)'}`);
      return { recordId, status: 'published', dispatched: true, envelope: null, completedAt: this.clock() };
    }

    // 红线：真失败（提交前某步失败）→ 如实 failed，绝不伪造发布成功。
    if (this.store.updateStatus) await this.store.updateStatus(recordId, 'failed').catch(() => {});
    this.logger.warn(`[PublishExecutor] cmd-path failed recordId=${recordId} failedAt=${JSON.stringify(result.failedAt)}`);
    return { recordId, status: 'failed', dispatched: true, envelope: null, completedAt: this.clock() };
  }

  /** 发卡后在 approvalWaitMs 窗口内轮询审批信号；人审通过即返回 true，期满未授权返回 false。 */
  private async waitForApproval(requestId: string): Promise<boolean> {
    if (!this.isApproved) return false;
    const deadline = this.clock() + this.approvalWaitMs;
    while (this.clock() < deadline) {
      await this.sleep(this.approvalPollMs);
      if (await this.isApproved(requestId).catch(() => false)) {
        this.logger.log(`[PublishExecutor] cmd-path 人审通过 requestId=${requestId}，继续发布`);
        return true;
      }
    }
    return false;
  }

  /**
   * 兜底派生标题（仅当 titleSelection 意外缺失时）：取正文首句、字形安全 clamp 到 18。
   * 红线：绝不再用旧的 `slice(0, 30)` 盲切（会切碎汉字/emoji，且与真发的 ≤18 标题失真）。
   */
  private deriveTitle(assembled: AssembledContent): string {
    return clampTitle(firstSentence(assembled.finalContent), 18);
  }

  private async trySendApprovalCard(
    assembled: AssembledContent,
    title: string,
    requestId: string,
  ): Promise<void> {
    if (!this.messenger || !this.botChatStore) return;
    try {
      const chat = await this.botChatStore.getDefaultChat();
      if (chat) {
        // 必须发"已构建的交互式卡片"（含通过/取消按钮 + requestId 回调）；直接发原始数据对象飞书会 400。
        // 卡片标题 = 真实发布标题（本角色已激活、titleSelection 必就绪）→ 审批人看到的即将发布的标题。
        const card = buildPublishApprovalCard({
          requestId,
          title,
          content: assembled.finalContent,
          tags: assembled.finalTags,
        });
        await this.messenger.sendApprovalCard(chat.chatId, card);
        this.logger.log(`[PublishExecutor] 审批卡已发 chat=${chat.chatId} requestId=${requestId}`);
      }
    } catch (err) {
      this.logger.warn(`[PublishExecutor] 发审批卡失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleManualReview(assembled: AssembledContent, title: string): Promise<PublishResult> {
    const recordId = await this.store.insert({
      title,
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

  private async handleAbort(assembled: AssembledContent, title: string): Promise<PublishResult> {
    const recordId = await this.store.insert({
      title,
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
