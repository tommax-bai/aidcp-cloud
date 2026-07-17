import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type {
  PipelineFields,
  GateDecision,
  AssembledContent,
  PublishResult,
  TriggerInput,
  PublishMetadata,
  PublishSourceReference,
  TitleSelection,
  ImageReferenceAudit,
} from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildCommandResultCard, buildPublishApprovalCard } from '../../feishu/cards.js';
import type { PublishApprovalPayload } from '../../feishu/types.js';
import type { ApprovalWriteResult } from '../../feishu/ws-receiver.js';
import { clampTitle, firstSentence } from '../title-clamp.js';
import { publishProfileForPlatform } from '../platform-profile.js';

/**
 * PublishExecutor —— 生成候审段的出口角色（change decouple-publish-generation-from-dispatch）。
 *
 * 职责收敛为「落库待审草稿 + 发飞书审批卡」即返回，**不再**内联等待人审、**不再**驱动边缘指令序列、
 * **不再**解析边缘节点。真正的下发由审批信号触发的下发段（PublishDispatcher）完成。
 *
 * 红线：
 * - 仍保留「图文帖必须有图」：无配图（imageUrl 空）即提前诚实 failed、不发卡（小红书图文编辑器先传图门控，无图必败）。
 * - 元数据落库 + 防篡改审计（aiEnforced）保留：草稿落库时持久化 publishMetadata，使下发段可无重生成地重建发布输入。
 * - 不在生成候审段让位浏览（让位推迟到下发段）；本角色不碰边缘、不阻塞、不超时等审。
 */

/** PublishLogStore 接口（生成候审段所需子集）。 */
export interface PublishLogStore {
  insert(record: {
    title: string;
    content: string;
    tags: string[];
    imageUrl: string | null;
    /** 多图：全部成功配图 URL（下发段读回逐张上传；[0]=封面）。缺省回落 imageUrl 单图。 */
    images?: string[];
    status: string;
    qualityScore: number;
    aiScore: number;
    sourceConcepts?: string[];
    sourceLikedIds?: number[];
    /** 发布账号（来自触发上下文，缺省 'default'）。落 publish_log.account_id。 */
    accountId?: string;
    /** 参照洗稿来稿快照；普通发布为空，绝不编造来源。 */
    sourceReference?: PublishSourceReference | null;
    platform?: TriggerInput['platform'];
  }): Promise<number>;
  updateStatus?(id: number, status: string): Promise<void>;
  /** 发帖元数据落库 + 防篡改审计（供下发段重建发布输入 + 审计）。 */
  recordMetadata?(id: number, metadata: unknown, aiEnforced: boolean): Promise<void>;
  /** 配图收口：标记该帖真实附着张数 K（生成段尚未上传时为 0）。 */
  markImagesAttached?(id: number, count: number): Promise<void>;
}

/** 飞书消息接口 */
export interface ApprovalMessenger {
  sendApprovalCard(chatId: string, card: unknown): Promise<void>;
  sendCard?(chatId: string, card: unknown): Promise<void>;
  uploadImageFromUrl?(url: string): Promise<string>;
}

/** Bot 聊天存储接口 */
export interface BotChatStore {
  getDefaultChat(): Promise<{ chatId: string } | null>;
}

// 与 publish-agent/types.ts 的 PublishResult['approvalCard'].targetSource **逐字一致**（漂移 typecheck 抓不到）。
// 标的是哪条解析路径产出了目标、不是落点（落点看 targetChatId）。
type ApprovalCardTargetSource = 'manual_source' | 'account_scope' | 'default_chat' | 'none';

interface ApprovalCardSendResult {
  sent: boolean;
  targetChatId?: string;
  targetSource: ApprovalCardTargetSource;
  error?: string;
}

export interface PublishExecutorDeps {
  store: PublishLogStore;
  messenger?: ApprovalMessenger;
  botChatStore?: BotChatStore;
  /**
   * 审批卡目标统一解析（change unify-card-routing-origin-then-team）：来源会话 → 账号团队群 → 默认群。
   * 注入后**取代** botChatStore.getDefaultChat 兜底——自动 / 排期发帖的审批卡由此进入账号团队群，
   * 而非一律落默认群。未注入（旧构造 / 桩）→ 退回 getDefaultChat，行为逐字不变。
   */
  resolveCardChatId?: (originChatId: string | undefined, accountId: string | undefined) => Promise<string>;
  /**
   * 陪伴界面通知（change edge-companion-ui 8.1，可选）：草稿落库候审 + 审批卡已发后，
   * 把 pending 状态推给该账号的在线边缘（发布卡自动展开）。绝不阻塞/影响发布主链路。
   */
  notifyPublishPending?: (accountId: string, recordId: number, title: string) => void;
  /** 账号展示名/昵称读取口；缺省时审批卡回落 accountId。 */
  getAccountName?: (accountId: string) => string | undefined;
  /** 写发布授权信号；免审排期复用人审同一个 first-writer-wins 出口。 */
  writeApprovalSignal?: (
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
  ) => Promise<ApprovalWriteResult>;
  /** 授权信号写入后触发既有下发段；免审不直接发布。 */
  triggerApprovedDispatch?: (requestId: string) => void;
  /** 角色执行超时（毫秒，默认 30s）。只覆盖落库 + 发卡，无内联人审等待，故无需放大。 */
  roleTimeoutMs?: number;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface ExecutorInput {
  gateDecision: GateDecision;
  assembledContent: AssembledContent;
  titleSelection: TitleSelection;
  publishMetadata: PublishMetadata;
}

export class PublishExecutorRole extends BasePublishRole<ExecutorInput, PublishResult> {
  readonly config: RoleConfig;
  protected readonly outputKey = 'publishResult' as const;
  private store: PublishLogStore;
  private messenger?: ApprovalMessenger;
  private botChatStore?: BotChatStore;
  private resolveCardChatId?: (originChatId: string | undefined, accountId: string | undefined) => Promise<string>;
  private notifyPublishPending?: (accountId: string, recordId: number, title: string) => void;
  private getAccountName?: (accountId: string) => string | undefined;
  private writeApprovalSignal?: (
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
  ) => Promise<ApprovalWriteResult>;
  private triggerApprovedDispatch?: (requestId: string) => void;

  constructor(deps: PublishExecutorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.store = deps.store;
    this.messenger = deps.messenger;
    this.botChatStore = deps.botChatStore;
    this.resolveCardChatId = deps.resolveCardChatId;
    this.notifyPublishPending = deps.notifyPublishPending;
    this.getAccountName = deps.getAccountName;
    this.writeApprovalSignal = deps.writeApprovalSignal;
    this.triggerApprovedDispatch = deps.triggerApprovedDispatch;
    // 发布门 = waitAll(['gateDecision','titleSelection','publishMetadata'])：标题没就绪不发布；标题 abort 不发布（黑板天然保证）。
    // change split-topic-roles：加 publishMetadata 为等待键——话题唯一真源为 publishMetadata.topics（finalTags 已恒空），
    //   卡/落库/下发三处话题一致，并消除原先 context.get('publishMetadata') 的取值竞态。
    // 审批卡由本角色激活后才发，故卡片必带真实标题。落库+发卡为快操作，超时回落 30s（不再为内联人审放大到分钟级）。
    this.config = {
      name: 'PublishExecutor',
      watchKeys: ['gateDecision', 'titleSelection', 'publishMetadata'],
      waitAll: true,
      timeoutMs: deps.roleTimeoutMs ?? 30_000,
      fallback: 'skip',
    };
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ExecutorInput {
    return {
      gateDecision: snapshot.gateDecision!,
      assembledContent: snapshot.assembledContent!,
      titleSelection: snapshot.titleSelection!,
      publishMetadata: snapshot.publishMetadata!,
    };
  }

  protected async execute(input: ExecutorInput, context: PipelineContext<PipelineFields>): Promise<PublishResult> {
    // 僵尸轮拦截（change parallel-rewrite-drafts）：管线超时不取消在途角色链，超时判 failed 后角色仍会
    // 接力至此。本轮已对外收敛 → 绝不落库、绝不发卡（第二结局=静默假成功变体，且僵尸落库会穿透
    // 调度器单飞键与容量帽）。已发生的模型/生图消耗为沉没成本、已如实记账。
    if (context.isAborted()) {
      this.logger.warn('[PublishExecutor] 本轮已收敛/中止（超时僵尸轮）→ 不落库、不发审批卡');
      return {
        recordId: null,
        status: 'skipped',
        dispatched: false,
        envelope: null,
        completedAt: this.clock(),
        reason: 'run_aborted（超时僵尸轮拦截：本轮已对外报终态，不产生第二结局）',
      };
    }
    const { gateDecision, assembledContent, publishMetadata } = input;
    const title = this.resolveTitle(input.titleSelection, assembledContent);
    const accountId = this.accountIdFrom(context);
    const platform = (context.get('trigger') as TriggerInput | undefined)?.platform ?? 'xiaohongshu';
    // change split-topic-roles：话题唯一真源 = publishMetadata.topics（finalTags 已恒空）；卡/落库/下发一律读它。
    const topics = publishMetadata?.topics ?? [];

    switch (gateDecision.recommendedAction) {
      // auto_publish 与 manual_review 同路：AC-PUB 本就要求人审，两者都是「落库待审草稿 + 发审批卡」，
      // 差别仅是 gatekeeper 的风险标注、由人在卡片上定夺；真正"不问就毙"的是 abort。
      case 'auto_publish':
      case 'manual_review':
        return this.stageDraftForApproval(assembledContent, title, context, accountId, platform, topics, publishMetadata);
      case 'abort':
        return this.handleAbort(assembledContent, title, context, accountId, topics, gateDecision.reason);
      case 'retry':
        return this.handleRetry();
      default:
        return this.handleAbort(assembledContent, title, context, accountId, topics, gateDecision.reason);
    }
  }

  /** 发布账号：从触发上下文取真实账号；无则回落 'default'（单账号向后兼容）。基类已有同名通用实现，此处保留 get('trigger') 取法并显式 override。 */
  protected override accountIdFrom(context: PipelineContext<PipelineFields>): string {
    const trigger = context.get('trigger') as TriggerInput | undefined;
    return trigger?.accountId ?? 'default';
  }

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

  private sourceReferenceFrom(context: PipelineContext<PipelineFields>, accountId: string): PublishSourceReference | null {
    const trigger = context.get('trigger') as TriggerInput | undefined;
    const referenceNote = trigger?.generateInput.referenceNote;
    if (!referenceNote) return null;
    if (referenceNote.sourceReference) return referenceNote.sourceReference;
    return {
      kind: 'curated_reference',
      curatedContentId: referenceNote.curatedContentId ?? null,
      accountId: referenceNote.accountId ?? accountId,
      sourceId: referenceNote.sourceId,
      title: referenceNote.title || null,
      body: referenceNote.body || null,
      author: referenceNote.author ?? null,
      topics: referenceNote.topics ?? [],
      sourceUrl: referenceNote.sourceUrl ?? null,
      capturedAt: referenceNote.capturedAt ?? this.clock(),
    };
  }

  /**
   * 生成候审段出口：落库待审草稿（status='pending_approval'）+ 元数据落库 + 发飞书审批卡，随即返回。
   * MUST NOT 让位浏览、MUST NOT 内联等待人审、MUST NOT 下发边缘指令——这些都属下发段（PublishDispatcher）。
   * 红线保留：无配图（图文帖无有效内容）→ 提前诚实 failed、不落待审、不发卡。
   */
  private async stageDraftForApproval(
    assembled: AssembledContent,
    title: string,
    context: PipelineContext<PipelineFields>,
    accountId: string,
    platform: TriggerInput['platform'],
    topics: string[],
    publishMetadata: PublishMetadata | undefined,
  ): Promise<PublishResult> {
    const lineage = this.lineageFrom(context);
    const sourceReference = this.sourceReferenceFrom(context, accountId);

    // 配图收口红线（change publish-image-required-or-fail + publish-multi-image）：图文帖必须有图。
    // 全部生图失败（imageUrls 空）→ 提前诚实 failed，不落待审、不发审批卡、附着数=0（绝不静默走必然失败的纯文字路径）。
    if (assembled.imageUrls.length === 0) {
      const failedId = await this.store.insert({
        title,
        content: assembled.finalContent,
        tags: topics,
        imageUrl: null,
        images: [],
        status: 'failed',
        qualityScore: assembled.qualityScore,
        aiScore: assembled.aiScore,
        sourceConcepts: lineage.sourceConcepts,
        sourceLikedIds: lineage.sourceLikedIds,
        accountId,
        platform,
        sourceReference,
      });
      if (this.store.markImagesAttached) await this.store.markImagesAttached(failedId, 0).catch(() => {});
      this.logger.warn(`[PublishExecutor] 无配图（M=0 全失败/降级）→ 图文帖无有效内容，诚实 failed recordId=${failedId}（不落待审、不发卡）`);
      return { recordId: failedId, status: 'failed', dispatched: false, envelope: null, completedAt: this.clock(), reason: '无配图（M=0 全部生图失败/降级）：图文帖无有效内容，已诚实失败、未发审批卡' };
    }

    // 落库待审草稿。change split-topic-roles：tags 取 publishMetadata.topics（唯一真源，与卡/下发一致），
    // 完整元数据仍由 recordMetadata 落 publishMetadata。images 存全部成功配图（下发段读回逐张上传）。
    const recordId = await this.store.insert({
      title,
      content: assembled.finalContent,
      tags: topics,
      imageUrl: assembled.imageUrl,
      images: assembled.imageUrls,
      status: 'pending_approval',
      qualityScore: assembled.qualityScore,
      aiScore: assembled.aiScore,
      sourceConcepts: lineage.sourceConcepts,
      sourceLikedIds: lineage.sourceLikedIds,
      accountId,
      platform,
      sourceReference,
    });

    // 元数据落库 + 防篡改审计（aiEnforced && !ai 由 MetadataAggregator 已回正；此处如实记审计位）。
    // change split-topic-roles：publishMetadata 已是等待键，直接用入参（消除原 context.get 取值竞态）。
    if (publishMetadata && this.store.recordMetadata) {
      const metadataWithAudit = this.withFacebookMediaReservation(
        this.withVisualReferenceAudit(
          this.withCoverFormAudit(
            this.withReferenceImageAudit({ ...publishMetadata, platform }, context, assembled.imageUrls.length),
            context,
          ),
          context,
        ),
        context,
      );
      const aiEnforced = metadataWithAudit.compliance.aiEnforced === true;
      await this.store.recordMetadata(recordId, metadataWithAudit, aiEnforced).catch(() => {});
    }

    // 发飞书审批卡（review）或免审写授权信号 + 发通知卡（auto_approve）。二者都只产出待审草稿，
    // 真正发布仍由审批信号触发的下发段完成。
    const requestId = `publish-${recordId}`;
    const approvalMode = (context.get('trigger') as TriggerInput | undefined)?.approvalMode ?? 'review';
    let approvalCard: ApprovalCardSendResult;
    let approvalLog = '候审不让位、无超时';
    if (approvalMode === 'draft_only') {
      approvalCard = { sent: false, targetSource: 'none' };
      approvalLog = '仅生成候选、暂不发布（未发审批卡、未写授权信号）';
    } else if (approvalMode === 'auto_approve') {
      const autoApproval = await this.tryAutoApprovePublish(assembled, title, requestId, topics, context, accountId, recordId);
      if (autoApproval.authorized) {
        approvalCard = autoApproval.notification;
        approvalLog = '免审授权信号已写入，已触发下发段；通知不影响下发';
      } else {
        this.logger.warn(
          `[PublishExecutor] 免审授权失败 recordId=${recordId} requestId=${requestId} error=${autoApproval.notification.error ?? '-'}，回退发送人审卡`,
        );
        approvalCard = await this.trySendApprovalCard(assembled, title, requestId, topics, context, accountId);
      }
    } else {
      approvalCard = await this.trySendApprovalCard(assembled, title, requestId, topics, context, accountId);
    }

    // 陪伴界面（edge-companion-ui 8.1）：候审状态推给在线边缘（发布卡自动展开到「等你确认」）。
    // 失败自吞（通知层 best-effort），绝不影响候审主链路。
    try {
      this.notifyPublishPending?.(accountId, recordId, title);
    } catch {
      /* best-effort */
    }

    const cardStatus = approvalCard.sent
      ? `审批卡已发 source=${approvalCard.targetSource} chat=${approvalCard.targetChatId}`
      : `审批卡未送达 source=${approvalCard.targetSource}${approvalCard.error ? ` error=${approvalCard.error}` : ''}`;
    this.logger.log(`[PublishExecutor] 草稿待审 recordId=${recordId} account=${accountId} requestId=${requestId} mode=${approvalMode}（${cardStatus}；${approvalLog}）`);
    return { recordId, status: 'pending_approval', dispatched: false, envelope: null, completedAt: this.clock(), approvalCard };
  }

  private async tryAutoApprovePublish(
    assembled: AssembledContent,
    title: string,
    requestId: string,
    topics: string[],
    context: PipelineContext<PipelineFields>,
    accountId: string,
    recordId: number,
  ): Promise<{ authorized: boolean; notification: ApprovalCardSendResult }> {
    if (!this.writeApprovalSignal) {
      return { authorized: false, notification: { sent: false, targetSource: 'none', error: 'approval_signal_writer_not_configured' } };
    }
    const payload: PublishApprovalPayload = {
      title,
      content: assembled.finalContent,
      tags: topics,
      contentVersion: 0,
    };
    try {
      const result = await this.writeApprovalSignal(requestId, true, payload);
      const authorized = result.written || result.alreadyDecided === true;
      if (authorized) {
        this.triggerApprovedDispatch?.(requestId);
      }
      const notification = await this.trySendAutoApproveNotification(title, requestId, context, accountId, recordId, authorized);
      if (!authorized) {
        return {
          authorized: false,
          notification: {
            ...notification,
            error: notification.error ?? `approval_signal_already_decided(${String(result.alreadyDecided)})`,
          },
        };
      }
      return { authorized: true, notification };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[PublishExecutor] 免审授权信号写入失败 requestId=${requestId}: ${message}`);
      return { authorized: false, notification: { sent: false, targetSource: 'none', error: message } };
    }
  }

  private async trySendAutoApproveNotification(
    title: string,
    requestId: string,
    context: PipelineContext<PipelineFields>,
    accountId: string,
    recordId: number,
    authorized: boolean,
  ): Promise<ApprovalCardSendResult> {
    if (!this.messenger) {
      return { sent: false, targetSource: 'none', error: 'messenger_not_configured' };
    }
    const target = await this.resolveApprovalCardTarget(context);
    if (!target.chatId) {
      return { sent: false, targetSource: target.source, error: 'approval_chat_not_configured' };
    }
    const message = authorized
      ? `后台排期已开启免审，草稿已自动授权并交由发布派发器继续执行。\n**草稿**：${recordId}\n**标题**：${title}`
      : `后台排期尝试免审授权，但授权信号未生效。\n**草稿**：${recordId}\n**标题**：${title}`;
    const card = buildCommandResultCard({
      command: '排期发帖（免审）',
      ok: authorized,
      level: authorized ? 'success' : 'warning',
      title: authorized ? '排期发帖已免审提交' : '排期发帖免审未生效',
      message,
      accountId,
      accountName: this.getAccountName?.(accountId),
      platformName: this.platformNameFrom(context),
    });
    try {
      const send = this.messenger.sendCard ?? this.messenger.sendApprovalCard;
      await send.call(this.messenger, target.chatId, card);
      this.logger.log(`[PublishExecutor] 免审通知已发 source=${target.source} chat=${target.chatId} requestId=${requestId}`);
      return { sent: true, targetChatId: target.chatId, targetSource: target.source };
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[PublishExecutor] 发免审通知失败 source=${target.source} chat=${target.chatId}: ${messageText}`);
      return { sent: false, targetChatId: target.chatId, targetSource: target.source, error: messageText };
    }
  }

  private withReferenceImageAudit(
    metadata: PublishMetadata,
    context: PipelineContext<PipelineFields>,
    generatedCount: number,
  ): PublishMetadata {
    const audit = this.buildReferenceImageAudit(context, generatedCount);
    if (!audit) return metadata;
    return { ...metadata, referenceImageAudit: audit };
  }

  private withFacebookMediaReservation(
    metadata: PublishMetadata,
    context: PipelineContext<PipelineFields>,
  ): PublishMetadata {
    const reservation = context.get('imageDirective')?.facebookMediaReservation;
    if (!reservation) return metadata;
    return { ...metadata, facebookMedia: reservation };
  }

  /** 封面形态审计并列落库（change textcard-cover-form）：直取执行角色产出，缺省不编造。 */
  private withCoverFormAudit(metadata: PublishMetadata, context: PipelineContext<PipelineFields>): PublishMetadata {
    const audit = context.get('imageDirective')?.coverFormAudit;
    if (!audit) return metadata;
    return { ...metadata, coverFormAudit: audit };
  }

  /** 逐槽参考绑定与视觉核验原样并列落库；缺省不编造。 */
  private withVisualReferenceAudit(metadata: PublishMetadata, context: PipelineContext<PipelineFields>): PublishMetadata {
    const audit = context.get('imageDirective')?.visualReferenceAudit;
    if (!audit) return metadata;
    return { ...metadata, visualReferenceAudit: audit };
  }

  private buildReferenceImageAudit(
    context: PipelineContext<PipelineFields>,
    generatedCount: number,
  ): ImageReferenceAudit | null {
    const trigger = context.get('trigger') as TriggerInput | undefined;
    const referenceImages = trigger?.generateInput.referenceNote?.images ?? [];
    const requestedCount = referenceImages.length;
    if (requestedCount === 0) return null;

    const usableCount = referenceImages
      .map((img) => (img.ossUrl ?? img.sourceUrl ?? '').trim())
      .filter(Boolean)
      .length;
    const imageDirective = context.get('imageDirective');
    const rawStatus = imageDirective?.referenceImageStatus ?? (usableCount > 0 ? 'skipped' : 'unavailable');
    const status: ImageReferenceAudit['status'] =
      usableCount === 0 && rawStatus === 'none' ? 'unavailable' : rawStatus;

    return {
      requestedCount,
      usableCount,
      status,
      providerClaimedUsed: status === 'used',
      generatedCount,
    };
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
    topics: string[],
    context: PipelineContext<PipelineFields>,
    accountId: string,
  ): Promise<ApprovalCardSendResult> {
    if (!this.messenger) {
      return { sent: false, targetSource: 'none', error: 'messenger_not_configured' };
    }
    const target = await this.resolveApprovalCardTarget(context);
    if (!target.chatId) {
      return { sent: false, targetSource: target.source, error: 'approval_chat_not_configured' };
    }
    try {
      // 必须发"已构建的交互式卡片"（含通过/取消按钮 + requestId 回调）；直接发原始数据对象飞书会 400。
      const card = buildPublishApprovalCard({
        requestId,
        title,
        content: assembled.finalContent,
        tags: topics,
        accountId,
        accountName: this.getAccountName?.(accountId),
        platformName: this.platformNameFrom(context),
        mediaCount: this.mediaCountFrom(context),
        mediaImageKeys: await this.mediaImageKeysFrom(assembled, context),
      });
      await this.messenger.sendApprovalCard(target.chatId, card);
      this.logger.log(`[PublishExecutor] 审批卡已发 source=${target.source} chat=${target.chatId} requestId=${requestId}`);
      return { sent: true, targetChatId: target.chatId, targetSource: target.source };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[PublishExecutor] 发审批卡失败 source=${target.source} chat=${target.chatId}: ${message}`);
      return { sent: false, targetChatId: target.chatId, targetSource: target.source, error: message };
    }
  }

  private async resolveApprovalCardTarget(context: PipelineContext<PipelineFields>): Promise<{
    chatId?: string;
    source: ApprovalCardTargetSource;
  }> {
    const trigger = context.get('trigger') as TriggerInput | undefined;
    const manualChatId = trigger?.manualApprovalChatId?.trim();
    if (manualChatId) return { chatId: manualChatId, source: 'manual_source' };

    // change unify-card-routing-origin-then-team：无来源会话（自动 / 排期 / 面板 / 边缘）不再直落默认群，
    // 先按账号团队路由。解析器内部已把「未绑团队 / 未命中 / 读失败」补集回落到默认群链——故 account_scope
    // 只声称「走了账号作用域这条解析路径」，落点是团队群还是默认群由 targetChatId 如实呈现，绝不冒称。
    if (this.resolveCardChatId) {
      const chatId = await this.resolveCardChatId(undefined, trigger?.accountId);
      if (chatId) return { chatId, source: 'account_scope' };
      return { source: 'none' };
    }

    const chat = await this.botChatStore?.getDefaultChat();
    if (chat?.chatId) return { chatId: chat.chatId, source: 'default_chat' };
    return { source: 'none' };
  }

  private async handleAbort(
    assembled: AssembledContent,
    title: string,
    context: PipelineContext<PipelineFields>,
    accountId: string,
    topics: string[],
    gateReason?: string,
  ): Promise<PublishResult> {
    const recordId = await this.store.insert({
      title,
      content: assembled.finalContent,
      tags: topics,
      imageUrl: assembled.imageUrl,
      images: assembled.imageUrls,
      status: 'failed',
      qualityScore: assembled.qualityScore,
      aiScore: assembled.aiScore,
      accountId,
      platform: (context.get('trigger') as TriggerInput | undefined)?.platform ?? 'xiaohongshu',
      sourceReference: this.sourceReferenceFrom(context, accountId),
    });

    this.logger.log(`[PublishExecutor] aborted: recordId=${recordId} reason=${gateReason ?? '-'}`);

    return {
      recordId,
      status: 'failed',
      dispatched: false,
      envelope: null,
      completedAt: this.clock(),
      reason: gateReason ? `合规/质量闸否决：${gateReason}` : '合规/质量闸否决',
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
      reason: '内容质量不达标、重试已用尽',
    };
  }

  private platformNameFrom(context: PipelineContext<PipelineFields>): string {
    const platform = (context.get('trigger') as TriggerInput | undefined)?.platform ?? 'xiaohongshu';
    return publishProfileForPlatform(platform).displayName;
  }

  private mediaCountFrom(context: PipelineContext<PipelineFields>): number | undefined {
    const trigger = context.get('trigger') as TriggerInput | undefined;
    if (trigger?.platform !== 'facebook') return undefined;
    return context.get('imageDirective')?.imageUrls.length ?? 0;
  }

  private async mediaImageKeysFrom(
    assembled: AssembledContent,
    context: PipelineContext<PipelineFields>,
  ): Promise<string[]> {
    const trigger = context.get('trigger') as TriggerInput | undefined;
    if (trigger?.platform !== 'facebook' || !this.messenger?.uploadImageFromUrl) return [];
    const keys: string[] = [];
    for (const url of assembled.imageUrls.slice(0, 3).filter(Boolean)) {
      try {
        const key = await this.messenger.uploadImageFromUrl(url);
        if (key) keys.push(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[PublishExecutor] Facebook 素材缩略图上传飞书失败：${message}`);
      }
    }
    return keys;
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
