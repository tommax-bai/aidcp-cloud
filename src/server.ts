/**
 * aidcp-cloud 启动入口：装配 planner + Qwen + PG 缓存，起 WebSocket 服务端。
 *
 * 环境变量：
 * - AIDCP_PORT        WebSocket 监听端口（默认 8787）
 * - DASHSCOPE_API_KEY Qwen API Key
 * - FEISHU_APP_ID / FEISHU_APP_SECRET 飞书自建应用凭证
 * - FEISHU_CHAT_ID    默认推送群 chat_id
 * - PGHOST/PGPORT/... 可覆盖默认 PG 连接（默认 127.0.0.1:5432 aidcp/aidcp）
 *
 * 飞书事件接收走官方 SDK 长连接（WSClient），由本端主动连接飞书，无需公网 IP / 回调端口。
 *
 * 运行：npm start
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import {
  QwenClient,
  type ChatLlmClient,
  TEXT_PROVIDERS,
  type TextProviderId,
  normProvider,
  isKnownProvider,
  ProviderKeyMissingError,
  buildThinkingParams,
  resolveProviderBaseUrl,
  resolveProviderEnvKey,
} from './llm/index.js';
import { PLATFORM_CREDENTIALS, resolvePlatformCredentialEnvValue } from './config/platform-credentials.js';
import { randomUUID } from 'node:crypto';
import { TokenUsageStore } from './metrics/token-usage-store.js';
import { createBillingPriceRefresh } from './metrics/billing-price-refresh.js';
import { shanghaiDayStartMs } from './time/shanghai-day.js';
import { SimplePlanner } from './planner/index.js';
// automation 归属 store 仍取自 automation 桶；content / api 归属 store 按其真实归属直连具体文件
// （composition→任意层恒允许，不新增跨边界豁免；随 cache/index 按层拆桶同步调整，见该文件说明）。
import { PgAnchorCache, GroupRouteStore, LikedNoteStore, ValuableCommentStore, InteractionFeedStore, topicKeysFromTitle } from './cache/index.js';
import { ConceptStore } from './cache/concept-store.js';
import { NotificationContactStore } from './cache/notification-contact-store.js';
import { CuratedContentStore, CuratedContentUnavailableError } from './cache/curated-content-store.js';
import type { CuratedReferenceImage, CuratedReferenceImageInput, CuratedSourceAdmission } from './cache/curated-content-store.js';
import { FirstPostOnboardingStore } from './onboarding/first-post-onboarding-store.js';
import { FirstPostOnboardingCoordinator } from './onboarding/first-post-onboarding-coordinator.js';
import { triggerGatedAutoComment } from './comment-agent/gated-auto-comment.js';
import { resolveCuratedGateConfig } from './publish-agent/curated-gate.js';
import {
  EdgeCloudServer,
  DefaultMessageHandler,
  CaptchaCoordinator,
  CaptchaAssistService,
  edgeCommandToEnvelope,
  type Envelope,
  type EnvironmentRegistryPort,
  makeEnvelope,
} from './comm/index.js';


import {
  RiskController,
  RiskControllerRegistry,
  PgRiskStore,
  InteractionGuardRegistry,
  ActionCooldownGate,
  PacingSaturationAlerter,
  // change risk-state-cross-process-integrity：跨进程单写四件套
  AutomationWriterLock,
  resolveWriterLockConnection,
  PgRiskCounterOutboxStore,
  RiskAccounting,
  RiskCounterReconciler,
  type AccountOwnershipPort,
  type OwnershipMode,
  type RiskAction,
  type RiskWindow,
} from './risk/index.js';
import { EventBus } from './event-bus/index.js';
import type { NoteDetailData } from './kernel/note-detail.js';
import type { PersonaGeneratorPort } from './kernel/persona-ports.js';
import { RoleDispatcher } from './orchestrator/index.js';
import type {
  RoleFactoryRegistry,
  ConceptExtractorFactoryOptions,
  ValuableCommentArchivistFactoryOptions,
  CuratedNoteEvaluatorFactoryOptions,
  CuratedCommentEvaluatorFactoryOptions,
} from './orchestrator/index.js';
// content 层角色类：组合根（composition）负责实例化并经 roleFactories 注入 dispatcher，
// 使 automation 侧 role-dispatcher 不再静态 import 这些 content 类（拆进程 Track1 前置）。
import { ConceptExtractorRole } from './agents/concept-extractor-role.js';
import { CuratedNoteEvaluator, type CuratedNoteSink } from './agents/curated-note-evaluator.js';
import { CuratedCommentEvaluator, type CuratedCommentSink } from './agents/curated-comment-evaluator.js';
import { ValuableCommentArchivist } from './agents/valuable-comment-archivist.js';
import type { TextCardTranscriber } from './publish-agent/text-card-transcriber.js';
import { FACEBOOK_REEL_FOLLOW_EDGE_CAPABILITY } from './platform/facebook-presented-video.js';

/**
 * content 层角色工厂注册表（组合根装配）：每个工厂就地 `new` 对应 content 角色，
 * dispatcher 就地组装 options 并按 RoleName 取工厂调用。静态、无闭包捕获，故置模块级。
 *
 * **构造契约的类型检查落在此处（composition）**：每个工厂的入参 `o` 标注为 automation 侧就地组装的
 * 构造契约（`orchestrator` 导出的 `*FactoryOptions`），工厂体 `new X(o)` 遂强制「契约 → 角色真实构造签名」
 * 可赋值——某角色新增必填构造字段而契约漏补时在此编译失败。**MUST NOT** 把 `o` 标注回
 * `ConstructorParameters<typeof X>[0]`：那是同义反复，`new X(o)` 恒过、检查退化为零（2026-07-23 审计坐实的回归）。
 *
 * `curatedStore` / `textCardTranscriber` 是 content 侧 Sink，automation 结构上看不见其形状（跨边界不可 import），
 * 故契约里留 opaque 句柄、仅在这里（唯一掌握该 content 类型处）就地 narrow 到真实 Sink；其余字段全程静态核对。
 */
const CONTENT_ROLE_FACTORIES: RoleFactoryRegistry = {
  concept_extractor: (o: ConceptExtractorFactoryOptions) => new ConceptExtractorRole(o),
  valuable_comment_archivist: (o: ValuableCommentArchivistFactoryOptions) => new ValuableCommentArchivist(o),
  curated_note_evaluator: (o: CuratedNoteEvaluatorFactoryOptions) => {
    const { curatedStore, textCardTranscriber, ...rest } = o;
    return new CuratedNoteEvaluator({
      ...rest,
      curatedStore: curatedStore as CuratedNoteSink,
      ...(textCardTranscriber ? { textCardTranscriber: textCardTranscriber as TextCardTranscriber } : {}),
    });
  },
  curated_comment_evaluator: (o: CuratedCommentEvaluatorFactoryOptions) => {
    const { curatedStore, ...rest } = o;
    return new CuratedCommentEvaluator({ ...rest, curatedStore: curatedStore as CuratedCommentSink });
  },
};
import { ConnectionRuntimeRegistry, type DispatcherBuildContext } from './orchestrator/connection-runtime.js';
import type { CommentApprovalNoticeInput, CommentApprovalPort } from './agents/comment-approval-gate.js';
import type { BaseRole } from './agents/base-role.js';
import { CommentSearchTermGenerator, type RoleLlmLike } from './agents/comment-search-term-generator.js';
import { PersonaGenerator } from './agents/persona-generator.js';
import { PERSONA_SOUL_CODEC } from './agents/persona-soul-codec.js';
import { PersonaAutoFillService } from './agents/persona-auto-fill.js';
import { PersonaGeneratorCommandReceiver } from './llm/persona-generator-command-receiver.js';
import { EdgeResumeCommandReceiver } from './comm/edge-resume-command-receiver.js';
import { PublishUiUpdateCommandReceiver } from './comm/publish-ui-update-command-receiver.js';
import { FacebookScopeCommandReceiver } from './comment-agent/facebook-scope-command-receiver.js';
import { CommentTargetPicker } from './agents/comment-target-picker.js';
import type { MandatoryCommentOutcomeNoticeInput } from './orchestrator/role-dispatcher.js';
import { CommentScheduler } from './comment-agent/comment-scheduler.js';
import { buildFacebookCommentComposerPrompt } from './comment-agent/facebook-comment-composer-prompt.js';
import {
  checkWritingLanguage,
  loadSoul,
  type Soul,
} from './soul/index.js';


import type { PublishApprovalPayload } from './kernel/feishu-card-contract.js';
import type { CommandFace, CommandFaceDeps } from './feishu/command-face.js';
import type { ApiFeishuOwner } from './feishu/api-owner-composition.js';
import { CommandSequencer } from './publish-agent/command-sequencer.js';
import { ScheduledPublishReconciler } from './publish-agent/scheduled-publish-reconciler.js';
import { createPublishDraftImageRemoveHandler } from './publish-agent/draft-image-remove.js';
import { createClientPublishApprovalHandler } from './publish-agent/client-publish-approval.js';
import { createPublishUiUpdateProducer } from './publish-agent/publish-ui-update-producer.js';
import {
  PublishApprovalStore,
  ApprovalUnreadableError,
  type ApprovalVoidReason,
} from './publish-agent/publish-approval-store.js';
import {
  createPublishApprovalAuthorityService,
  createPublishApprovalClient,
  createPublishApprovalDecisionWriter,
  type PublishApprovalAuthorityPort,
} from './publish-agent/publish-approval-api.js';
import { createPublishDispatchTriggerReceiver } from './publish-agent/publish-dispatch-trigger.js';
import { PublishApprovalOutboxRelay } from './publish-agent/publish-approval-outbox-relay.js';
import type {
  PublishApprovalDecisionWriterPort,
  PublishDispatchTriggerKind,
  PublishDispatchTriggerPort,
} from './kernel/publish-approval-contract.js';
import {
  PublishApprovalAuthorityHttpClient,
  registerPublishApprovalAuthorityRoutes,
} from './transport/publish-approval-authority-http.js';
import {
  PublishApprovalDecisionWriterHttpClient,
  registerPublishApprovalDecisionWriterRoutes,
} from './transport/publish-approval-decision-http.js';
import {
  PublishDispatchTriggerHttpClient,
  registerPublishDispatchTriggerRoutes,
} from './transport/publish-dispatch-trigger-http.js';
import {
  createApprovalWriteOutlet,
  type ApprovalDecisionContext,
  type ApprovalWriteOutlet,
} from './publish-agent/publish-approval-outlet.js';
import { PendingDispatchWatchdog } from './publish-agent/pending-dispatch-watchdog.js';
import {
  clampFillBudgetToLease,
  DEFAULT_FILL_BUDGET,
  DEFAULT_PUBLISH_LEASE_MS,
  sanitizeFillBudget,
  warnIfFillBudgetUnusable,
} from './publish-agent/fill-budget.js';
import { EdgeTaskLeaseClient } from './comm/edge-task-lease-client.js';
import { UiSnapshotService } from './comm/ui-snapshot.js';
import { completeSessionUsageCounts, pickDailyUsageCounts, pickSessionUsageCounts } from './comm/daily-usage.js';
import { buildBrowserStandbyHint, resolveBrowserStandbyConfig } from './comm/browser-standby.js';
// 客户端指标键清单的**单一来源**（change platform-honest-usage-metrics）：联集由它派生。
// 别在本文件另写一份数组——那正是本 change 删掉的东西（加键时 typecheck 一声不吭）。
import {
  IDENTITY_READ_CURRENT_CAPABILITY,
  IDENTITY_READ_SELF_PROFILE_CAPABILITY,
  SEARCH_ACTIVITY_RECEIPT_CAPABILITY,
  UI_DAILY_USAGE_ACTIONS,
} from './comm/protocol.js';
import type {
  UiDailyUsageAction,
  UiDailyUsageCounts,
  UiDailyUsagePayload,
  UiBrowserStandbyPayload,
  UiDailyUsageWindowStatus,
} from './comm/protocol.js';
import { PublishOrchestrator, FacebookPublishMediaStore } from './publish-agent/index.js';
// 三分接缝（change decouple-publish-agent-buckets）：台账段 PublishScheduler / 下发段 PublishDispatcher
// 由组合根从各自段文件直接 import，不再经生成段桶 re-export。
import { PublishScheduler } from './publish-agent/publish-scheduler.js';
import type { SchedulerOrchestrator } from './publish-agent/publish-scheduler.js';
import { PublishDispatcher } from './publish-agent/publish-dispatcher.js';
import { WanxiangClient } from './publish-agent/wanxiang-client.js';
import { SeedreamClient } from './publish-agent/seedream-client.js';
import { relocateImageToStore, type ObjectStore } from './storage/object-store.js';
import {
  IMAGE_PROVIDERS,
  type ImageProviderId,
  normImageProvider,
  RoutingImageProvider,
} from './publish-agent/image-providers.js';
import { AccountStateManager } from './account-state.js';
import { PgAccountStore, type AccountStore } from './account-store.js';
// change textcard-cover-form：封面形态感知（vision 客户端 + 感知服务）与文字卡渲染出口。
import { OpenAiCompatVisionClient, type VisionCallInfo } from './llm/vision.js';
import {
  createCoverFormSensor,
  resolveCoverFormModel,
  resolveCoverFormProvider,
} from './publish-agent/cover-form-sensor.js';
import {
  createVisualReferenceAnalyzer,
  resolveReferenceVisualModel,
  resolveReferenceVisualProvider,
} from './publish-agent/visual-reference-analyzer.js';
import {
  createVisualFidelityAuditor,
  resolveVisualAuditModel,
  resolveVisualAuditProvider,
} from './publish-agent/visual-fidelity-auditor.js';
// change textcard-carousel-form-parity（阶段0 影子）：帖级形态档服务（封面先行 + 内页有界并发判形）。
import { createPostImageFormProfileService } from './publish-agent/post-image-form-profile.js';
import {
  createTextCardTranscriber,
  resolveTextCardTranscriptionModel,
  resolveTextCardTranscriptionProvider,
} from './publish-agent/text-card-transcriber.js';
import { createTextCardRenderer, type TextCardRenderer } from './render/text-card.js';
import {
  ContentScoutRole,
  ContentTypeSelectorRole,
  ContentCreatorRole,
  ReferenceAnalyzerRole,
  FaithfulRewritePlannerRole,
  FaithfulDraftWriterRole,
  FidelityAuditorRole,
  CategoryClassifierRole,
  VisualReferenceAnalyzerRole,
  CoverCardWriterRole,
  ImageSetPlannerRole,
  ImagePromptComposerRole,
  FacebookMediaSelectorRole,
  ImageGeneratorRole,
  CoverSelectorRole,
  ContentCleanerRole,
  CLEAN_TIMEOUT_MS,
  AiFlavorScorerRole,
  QualityScorerRole,
  ContentAssemblerRole,
  TitleCreatorRole,
  TopicGeneratorRole,
  TopicEvaluatorRole,
  MentionStrategistRole,
  LocationStrategistRole,
  CollectionStrategistRole,
  VisibilityDeciderRole,
  PermissionDeciderRole,
  PublishModeDeciderRole,
  ComplianceDeciderRole,
  MetadataAggregatorRole,
} from './publish-agent/roles/index.js';
// 跨段角色（change decouple-publish-agent-buckets）：审批段（api）与下发段（automation）角色从各自文件直接 import。
import { ApprovalGatekeeperRole } from './publish-agent/roles/approval-gatekeeper.js';
import { PublishExecutorRole } from './publish-agent/roles/publish-executor.js';
import { buildDeAiRewritePrompt } from './publish-agent/prompts.js';
import { PostProcessor } from './publish-agent/post-processor.js';
import { PublishLogStore, type PendingPublishPreview } from './publish-agent/publish-log-store.js';
import { DraftRefinementStore } from './publish-agent/draft-refinement.js';
import { DraftRefinementWorker } from './publish-agent/draft-refinement-worker.js';
import { hasUserRejectionEvidence } from './publish-agent/types.js';
import { PublishPipelineLogStore } from './publish-agent/publish-pipeline-log-store.js';
import { startPanelApi, parsePanelUsers, PgPanelStore } from './panel/index.js';
import { buildPublishLifecycle, type ApprovalDispatchProjection } from './panel/publish-stage-lifecycle.js';
import {
  PgDelegatedTaskStore,
  DelegatedTaskService,
  DelegatedTaskWorker,
  createDelegatedExecutorRouter,
  type DelegatedTask,
} from './delegated-task/index.js';
import { parseDeploymentTarget } from './deployment-target.js';
import { runSchemaContractGate, takePendingSchemaGateAlert } from './schema/schema-gate.js';
import { isSchemaCapabilityError } from './kernel/schema-capability-contract.js';
import { ensureCapabilitySchema, probeSchemaShape } from './schema/schema-capability.js';
import { DelegatedTaskNotificationGate, delegatedTaskFailureReceipt } from './delegated-task/notification.js';
import {
  omitUnsupportedUsageMetrics,
  platformRegistryEntry,
  SCHEDULED_AUTOMATION_CATALOG_READER,
} from './platform/index.js';
import { TokenRevocationStore } from './panel/revocation.js';
import {
  ClientUserStore,
  startClientAuthApi,
  LoginRateLimiter,
  projectClientPublishQueue,
} from './client-auth/index.js';
import { createEnvironmentHandshakeAuthority } from './client-auth/client-user-store.js';
import { PgOffboardAdmissionLedger } from './client-auth/offboard-admission-ledger.js';
// Block② 数据网关（决定①：api/panel 收口取数）。默认 local ⇒ getter 取到的就是原本地实例、零 HTTP、零行为变更。
// 组合根（本文件属 composition 层）可合法 import transport 的 http 客户端，仅在 mode='http'（拆进程 2d）时经 remote thunk 构造。
import { DataGateway, gatewayModeFromEnv } from './gateway/data-gateway.js';
// Block② 2d 第一步：多进程运行模式（一套代码、多入口）。纯选择器，零副作用，main() 据此分支。
import {
  serviceModeFromEnv,
  segmentsForMode,
  listenersForMode,
  ownsPublishApprovalAuthorityForMode,
  ownsApiFeishuForMode,
  panelEventTransportForMode,
  outboxRetentionForMode,
  DEFAULT_CONTENT_READ_API_PORT,
  type ServiceMode,
} from './gateway/service-mode.js';
import { InternalHttpClient, InternalHttpServer, INTERNAL_HTTP_TIMEOUT_CEILING_MS } from './transport/internal-http.js';
import { ApiSyncReadSnapshotSource } from './config/api-sync-read-source.js';
import { ApiSyncReadMirrors } from './config/api-sync-read-mirrors.js';
import { createApiSyncReadConsumerCheckpointStore } from './config/api-sync-read-checkpoint-store.js';
import { AutomationSyncReadMirrors } from './transport/automation-sync-read-mirrors.js';
import {
  AutomationSyncReadSnapshotSource,
  type AutomationRuntimeSyncReadStream,
} from './transport/automation-sync-read-source.js';
import { PgAutomationSyncReadGenerationStore } from './transport/automation-sync-read-generation-store.js';
import { SyncReadChangedOutbox } from './transport/sync-read-changed-outbox.js';
import { createAutomationSyncReadConsumerCheckpointStore } from './transport/automation-sync-read-checkpoint-store.js';
import { registerSyncReadSnapshotRoute } from './transport/sync-read-snapshot-http.js';
import type {
  SyncReadConsumerCheckpoint,
  SyncReadStream,
} from './kernel/sync-read-snapshot.js';
import type {
  AccountOwnershipAuthorityPort,
  AccountPersonaAuthorityPort,
  AccountRosterAuthorityPort,
  AccountRuntimeAuthorityPort,
  AutomationConfigCommandsPort,
  AutomationPublishLogPort,
  CommentApprovalPolicyPort,
  EdgePublishCommandPort,
  EdgeResumeCommandPort,
  EnvironmentHandshakePort,
  FacebookScopeCommandPort,
  FirstPostProgressPort,
  InteractionApiWritesPort,
  InteractionAuthAuthorityPort,
  NotificationContactsPort,
  OffboardAdmissionLedgerPort,
  PersonaGeneratorAuthorityPort,
  PublishUiUpdateCommandPort,
  ReplyConfigResolverPort,
  StructuredNotificationDeliveryPort,
} from './kernel/api-direct-port.js';
import {
  AccountOwnershipHttpClient,
  AccountPersonaHttpClient,
  AccountRosterHttpClient,
  AccountRuntimeHttpClient,
  AutomationConfigCommandsHttpClient,
  AutomationPublishLogHttpClient,
  CommentApprovalPolicyHttpClient,
  EdgePublishCommandHttpClient,
  EdgeResumeCommandHttpClient,
  EnvironmentHandshakeHttpClient,
  FacebookScopeCommandHttpClient,
  FirstPostProgressHttpClient,
  InteractionApiWritesHttpClient,
  InteractionAuthHttpClient,
  NotificationContactsHttpClient,
  OffboardAdmissionLedgerHttpClient,
  PersonaGeneratorCommandHttpClient,
  PublishUiUpdateCommandHttpClient,
  ReplyConfigResolverHttpClient,
  StructuredNotificationHttpClient,
  registerAccountOwnershipRoutes,
  registerAccountPersonaRoutes,
  registerAccountRosterRoutes,
  registerAccountRuntimeRoutes,
  registerAutomationConfigCommandsRoutes,
  registerAutomationPublishLogRoutes,
  registerCommentApprovalPolicyRoutes,
  registerEdgePublishCommandRoutes,
  registerEdgeResumeCommandRoutes,
  registerEnvironmentHandshakeRoutes,
  registerFacebookScopeCommandRoutes,
  registerFirstPostProgressRoutes,
  registerInteractionApiWritesRoutes,
  registerInteractionAuthRoutes,
  registerNotificationContactsRoutes,
  registerOffboardAdmissionLedgerRoutes,
  registerPersonaGeneratorCommandRoutes,
  registerPublishUiUpdateCommandRoutes,
  registerReplyConfigResolverRoutes,
  registerStructuredNotificationRoutes,
} from './transport/api-direct-http.js';
import { CuratedContentHttpClient, registerCuratedContentRoutes } from './transport/curated-content-http.js';
import { registerReviewCardDeliveryRoutes } from './transport/review-card-delivery-http.js';
import type { ReviewCardDeliveryDecision, ReviewCardDeliveryPort } from './kernel/review-card-delivery-port.js';
import { registerPublishLogRoutes } from './transport/publish-log-http.js';
import { registerPipelineLogRoutes } from './transport/pipeline-log-http.js';
import {
  PublishCardExitHttpClient,
  registerPublishCardExitRoutes,
} from './transport/publish-card-exit-http.js';
import { registerImageModelSelectionRoutes } from './transport/image-model-selection-http.js';
import { registerRoleModelSelectionRoutes } from './transport/role-model-selection-http.js';
import { registerProviderSecretRoutes } from './transport/provider-secret-http.js';
import { registerAccountPlatformRoutes } from './transport/account-platform-http.js';
import { registerTriggeredPublishRefsRoutes } from './transport/triggered-publish-refs-http.js';
import type { TriggeredPublishRefsReader } from './kernel/delegated-task-types.js';
import type { AccountPlatformReader } from './kernel/platform-types.js';
import type { RoleModelSelectionReader, RoleModelSelectionSource } from './kernel/role-model-selection-port.js';
import type { ProviderSecretReader } from './kernel/provider-secret-port.js';
import type { ImageModelSelectionReader } from './kernel/image-model-selection-port.js';
import type { PublishCardExitPort } from './kernel/publish-card-exit-port.js';
import type { PipelineLogSink } from './kernel/pipeline-log-contract.js';
import type { PublishLogWriter } from './kernel/publish-log-writer-port.js';
import { PublishStatusHttpClient, registerPublishStatusRoutes } from './transport/publish-status-http.js';
import { PublishGenerationHttpClient, registerPublishGenerationRoutes } from './transport/publish-generation-http.js';
// Block② 2e：拆进程后 api ↔ automation 的跨段传输接缝。默认 monolith 全不启用（红线：monolith 不起任何新东西）。
//   - 风控只读投影：api 经 HTTP 客户端读 automation 的内部 API（server 侧 registerRiskReadRoutes）。
//   - 风控写：api 只 emit 命令落 outbox；automation 唯一消费者经真 RiskController 应用（单写不变量物理成立）。
//   - 事件观测：automation 把 EventBus tee 到 outbox；api 回放进本进程 EventBus → panel-ws。
import { RiskReadHttpClient, registerRiskReadRoutes } from './transport/risk-read-http.js';
import {
  PgAccountProjectionStore,
} from './transport/account-projection-store.js';
import type { AccountRosterSourcePort } from './kernel/account-projection-types.js';
import type { RiskReadPort } from './kernel/risk-read-types.js';
import type { PanelAutomationReader } from './kernel/panel-automation-types.js';
import { PgPanelAutomationRead } from './risk/panel-automation-read.js';
import {
  PanelAutomationHttpClient,
  registerPanelAutomationRoutes,
} from './transport/panel-automation-http.js';
import {
  PanelPacingConfigHttpClient,
  PanelQuotaConfigHttpClient,
  PanelResumeConfigHttpClient,
  PanelSessionLimitsHttpClient,
  registerPanelConfigRoutes,
} from './transport/panel-config-http.js';
import type { FacebookGroupOpsPort } from './kernel/facebook-group-ops-types.js';
import {
  FacebookGroupOpsHttpClient,
  registerFacebookGroupOpsRoutes,
} from './transport/facebook-group-ops-http.js';
import {
  GroupRouteHttpClient,
  registerGroupRouteRoutes,
} from './transport/group-route-http.js';
import {
  AlertResolutionHttpClient,
  registerAlertResolutionRoutes,
} from './transport/alert-resolution-http.js';
import {
  RiskCommandConsumer,
  RISK_COMMAND_CONSUMER,
  RISK_COMMAND_RETENTION_MS,
  RISK_COMMAND_TOPIC,
} from './transport/risk-command-outbox.js';
import { createRiskCommandApplyHandler, PgRiskCommandService } from './risk/risk-command-service.js';
import { RiskCommandHttpClient, registerRiskCommandRoutes } from './transport/risk-command-http.js';
import type { RiskCommandPort } from './kernel/risk-command-types.js';
import {
  bridgeEventBusToOutbox,
  PanelEventReplay,
  PANEL_EVENT_OUTBOX_TOPIC,
  PANEL_EVENT_REPLAY_CONSUMER,
  PANEL_EVENT_RETENTION_MS,
  PANEL_EVENT_UNCONSUMED_RETENTION_MS,
} from './transport/eventbus-outbox-bridge.js';
import {
  PanelEventDeliveryHttpClient,
  registerPanelEventDeliveryRoutes,
} from './transport/panel-event-delivery-http.js';
import { PanelEventFanout } from './panel/panel-event-fanout.js';
// event_outbox 保留期剪裁：outbox 是队列不是账本，没有剪裁就在共库的生产 PG 上无界增长。
import {
  EVENT_OUTBOX_NOTIFY_CHANNEL,
  OutboxConsumer,
  OutboxRetentionPruner,
} from './transport/event-outbox.js';
import { startOutboxNotifyListener, type NotifyClientLike } from './transport/outbox-notify-listener.js';
import { startOutboxHealthLog, type OutboxHealthSource } from './transport/outbox-health.js';
// 互动配置面审计的跨属主投递契约（Block③ L3）：automation 入队 → 中继在 api 池上幂等落地。
import {
  INTERACTION_AUDIT_OUTBOX_RETENTION_MS,
  INTERACTION_AUDIT_OUTBOX_TOPIC,
  INTERACTION_AUDIT_RELAY_CONSUMER,
  decodeInteractionAuditEvent,
} from './kernel/interaction-audit-outbox.js';
/** automation 内部 API 的默认监听端口（可由 AIDCP_AUTOMATION_PORT 覆盖）；api 侧 base URL 由 AIDCP_AUTOMATION_URL 指定。 */
const DEFAULT_AUTOMATION_INTERNAL_API_PORT = 8093;
/** api 进程内部 API 的默认监听端口（可由 `AIDCP_API_PORT` 覆盖）。 */
const DEFAULT_API_INTERNAL_API_PORT = 8094;
import { PgAlertStore } from './alerts/index.js';
// 跨进程配置镜像失效通道（change config-mirror-cross-process-invalidation）。
import pg from 'pg';
import { MirrorVersionStore } from './config/mirror-version-store.js';
import { ConfigMirrorRefresher } from './config/mirror-refresher.js';
// 跨域失效信号：本域 outbox 入队 + 进程内中继 + api 侧 inbox 去重落地
// （change block3-l3-config-mirror-bump-decouple）。
import { CONFIG_MIRRORS, CONFIG_MIRROR_KEYS } from './config/mirror-registry.js';
import { ConfigMirrorBumpRelay, OutboxMirrorVersionBumper } from './config/mirror-bump-outbox.js';
import { PgConfigMirrorBumpSink, UnavailableConfigMirrorBumpSink } from './config/mirror-bump-sink.js';
import {
  ConfigMirrorBumpHttpClient,
  registerConfigMirrorBumpRoutes,
} from './transport/config-mirror-bump-http.js';
import type { ConfigMirrorBumpSink, ConfigMirrorGatePort } from './kernel/config-mirror-bump-types.js';
import { allowsTransportWhenGateUnknown, hasStaleGateMirror, platformActionHalt } from './config/mirror-stop-work.js';
import { isMirrorStale, noteMirrorStaleRefusal } from './config-mirror-freshness.js';
import { automationOperationDescriptorFor } from './comm/operation-registry.js';
import { PG_OWNERS, resolveOwnerPgConfig, type PgOwner } from './kernel/pg-owner-connection-resolver.js';
import { ModelConfigStore } from './config/model-config-store.js';
import { RoleConfigStore } from './config/role-config-store.js';
import { createRoleConfigPanel, type ModelProbeResult } from './config/role-config-facade.js';
import { CategoryConfigStore } from './config/category-config-store.js';
import { createCategoryConfigPanel } from './config/category-config-facade.js';
import { ROLE_CATALOG, categoryOf, type ThinkingMode } from './config/role-catalog.js';
// 账号人设（change account-persona-config，stream F）：按账号可配 + 热加载，回落打包 soul.yaml 不 brick。
import { PersonaStore, createPersonaResolver } from './config/persona-store.js';
import { createPersonaPanel } from './config/persona-facade.js';
import { AccountPersonaService } from './config/account-persona-service.js';
import { PersonaAutoFillStore } from './config/persona-auto-fill-store.js';
// 安全限额（change safety-quota-config，stream D）：三档×动作×三窗口限额数字后台可改+热加载，缺值回落写死默认。
import { QuotaConfigStore } from './config/quota-config-store.js';
import { createQuotaConfigPanel } from './config/quota-config-facade.js';
import { PacingConfigStore } from './config/pacing-config-store.js';
import { createPacingConfigPanel } from './config/pacing-config-facade.js';
import { SessionConfigStore } from './config/session-config-store.js';
import { createSessionLimitPanel } from './config/session-config-facade.js';
import { HotLeadConfigStore } from './config/hot-lead-config-store.js';
import { createHotLeadConfigPanel } from './config/hot-lead-config-facade.js';
import { ResumeConfigStore } from './config/resume-config-store.js';
import { createResumeConfigPanel } from './config/resume-config-facade.js';
// 内容排期（change content-schedule-auto-publish，Phase 1 只发帖）：全局内容格 + 每账号排期存储 + 分钟心跳触发扇入。
import {
  ContentScheduleStore,
  actionModeEnabled,
  type ContentScheduleCatalogRow,
} from './config/content-schedule-store.js';
import { projectClientEnvironmentSchedule } from './client-auth/client-environment-schedule.js';
import { FacebookGroupJoinAutomationStore } from './config/facebook-group-join-automation-store.js';
import {
  buildFacebookGroupJoinAutomationCatalogViewFailClosed,
  projectFacebookGroupJoinAutomationCatalog,
} from './config/facebook-group-join-automation-view.js';
import {
  ApprovalPolicyStore,
  type AccountCommentApprovalMode,
} from './config/approval-policy-store.js';
import { FacebookCommentConfigStore } from './config/facebook-comment-config-store.js';
import { FacebookCommentAuditStore } from './comment-agent/facebook-comment-audit-store.js';
import {
  FacebookGroupJoinAuditStore,
  FacebookGroupMembershipStore,
  FacebookGroupTargetStore,
} from './comment-agent/facebook-group-store.js';
import { FacebookGroupJoinScheduler } from './comment-agent/facebook-group-join-scheduler.js';
import { ContentScheduler } from './orchestrator/content-scheduler.js';
import { isWeekActiveAt } from './risk/session-limits.js';
import { createRolePromptProvider } from './config/role-prompt-preview.js';
import { PUBLISH_PREVIEW_BUILDERS, IMAGE_PROMPT_PREVIEW_BUILDERS } from './publish-agent/prompts-preview.js';
import { CredentialStore } from './config/credential-store.js';
import type { ModelConfigView } from './panel/types.js';
// automation 属主 + kernel 契约经 automation 桶导入（本文件是 composition，MAY 导入任何层）。
import {
  InteractionStore,
  ReplyWorkflow,
  InteractionInboxService,
  InteractionSendOrchestrator,
  InteractionOffboardingService,
  InteractionMetrics,
  INTERACTION_OFFBOARDING_CAPABILITY,
  INTERACTION_REPLY_RECOVERY_CAPABILITY,
  INTERACTION_RUNTIME_CONTROLS_CAPABILITY,
  interactionWritesAllowed,
  type InteractionSchemaMode,
  type InteractionRuntimeControlsPayload,
} from './interactions/index.js';
// api 属主的配置/查询面：不再经 automation 桶再导出（桶拆分），由组合根直接从各具体文件导入。
import { ReplyConfigStore } from './interactions/reply-config-store.js';
import { ReplyConfigScopeStore } from './interactions/reply-config-scope-store.js';
import { ReplyConfigResolver } from './interactions/reply-config-resolver.js';
import { InteractionCustomerApi, interactionTestDataResetEnabled } from './interactions/interaction-customer-api.js';
import { InteractionInternalApi, parseInteractionPanelGrants } from './interactions/interaction-internal-api.js';
import { InteractionScopeInternalApi } from './interactions/interaction-scope-internal-api.js';
import { buildInteractionPermissionOverview } from './interactions/interaction-panel-permissions.js';
// 互动域环境授权闸的 api 属主实现（Block③ L3 反方向收口）：持 api 池、自开事务，经 kernel 端口注入 automation。
import { PgInteractionAuthGate } from './interactions/interaction-auth-gate.js';
import type { InteractionAuthGate } from './kernel/interaction-auth-gate-types.js';
// 组合根直接构造 content 的回复生成实现，并作为 ReplyAiPort 注入 ReplyWorkflow（automation 编排层只持接口）。
import { ReplyAiService } from './interactions/reply-ai.js';
import { projectRuntimeControls } from './interactions/runtime-controls-provider.js';
// change offboard-saga → Block③ L3：离场**执行台账**的属主侧操作，由组合根注入（拆进程时换成内部 HTTP）。
import { PgOffboardMaterializationOps } from './interactions/offboard-write-adapter.js';
import { AutomationOffboardAdmissionReconciler } from './interactions/offboard-admission-reconciler.js';
import type { OffboardMaterializationOperations } from './kernel/offboard-materialization-types.js';
// Block③ L3：离场写适配器的**读侧配对**——api 的客户环境生命周期经 kernel 端口向 automation 取只读投影。
import { PgClientEnvAutomationRead } from './interactions/client-env-automation-read.js';
import { PgOffboardCleanupGrantOps } from './interactions/offboard-cleanup-grant-ops.js';
import type { OffboardCleanupGrantOperations } from './kernel/offboard-cleanup-grant-types.js';
import type { ClientEnvAutomationReader } from './kernel/client-env-automation-types.js';
import { PgInteractionApiWrites } from './interactions/interaction-api-writes.js';
import { createAutomationConfigCommands } from './config/content-schedule-store.js';

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

type PublishApprovalPreflightResult =
  | { ok: true; accountId?: string; edgeId?: string }
  | {
      ok: false;
      reason: 'account_offline' | 'publish_target_unavailable';
      accountId?: string;
    };

function matchAccountNickname(
  nickname: string,
  candidates: Array<{
    accountId: string;
    displayName?: string | null;
    names?: string[];
  }>,
):
  | { ok: true; accountId: string }
  | {
      ok: false;
      reason: 'not_found' | 'ambiguous';
      available: string[];
    } {
  const normalized = nickname.trim().toLowerCase();
  const available = candidates.map(
    (candidate) => candidate.displayName?.trim() || '（未获取昵称）',
  );
  const matches = candidates.filter((candidate) =>
    (candidate.names?.length
      ? candidate.names
      : [candidate.displayName ?? '']
    ).some((name) => name.trim().toLowerCase() === normalized),
  );
  if (matches.length === 1) {
    return { ok: true, accountId: matches[0].accountId };
  }
  return {
    ok: false,
    reason: matches.length === 0 ? 'not_found' : 'ambiguous',
    available:
      matches.length === 0
        ? available
        : matches.map(
            (candidate) =>
              candidate.displayName?.trim() || '（未获取昵称）',
          ),
  };
}

async function writeLegacyApprovalShadow(
  requestId: string,
  approved: boolean,
  payload: PublishApprovalPayload,
  timestamp: number,
): Promise<void> {
  const path = `/tmp/aidcp-publish-approve-${requestId}.json`;
  try {
    await writeFile(
      path,
      JSON.stringify({
        requestId,
        approved,
        ts: timestamp,
        payload,
      }),
      { flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function requirePublishApprovalInternalToken(): string {
  const token = readEnvString('AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN');
  if (!token) {
    throw new Error(
      'AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN is required for publish approval internal HTTP',
    );
  }
  return token;
}

function requireDirectInternalToken(
  envName:
    | 'AIDCP_API_INTERNAL_TOKEN'
    | 'AIDCP_AUTOMATION_INTERNAL_TOKEN'
    | 'AIDCP_CONTENT_INTERNAL_TOKEN',
): string {
  const token = readEnvString(envName);
  if (!token || /\s/.test(token)) {
    throw new Error(`${envName} is required and must not contain whitespace`);
  }
  return token;
}

function personaGeneratorFromCommand(
  command: PersonaGeneratorAuthorityPort,
): PersonaGeneratorPort {
  return {
    async generate(input) {
      const idempotencyKey = input.diversitySeed?.trim();
      if (!idempotencyKey) {
        throw new Error('persona_generation_idempotency_key_missing');
      }
      const receipt = await command.generate({ ...input, idempotencyKey });
      if (receipt.outcome === 'collision') {
        throw new Error('persona_generation_idempotency_collision');
      }
      return receipt.result;
    },
  };
}

function readEnvPort(name: string): number | undefined {
  const value = readEnvString(name);
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function readEnvNumber(name: string, fallback: number): number {
  const value = readEnvString(name);
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 「有 env 用 env，没有就交给被注入方的类默认」——给那些**默认值必须只有一处事实源**的参数用。
 *
 * 用 `Number(process.env.X ?? <硬编码>)` 会在注入点复制一份默认值，从此两处必须手工同步；一旦只改了
 * 类默认、忘了注入点，注入点的旧值会**永远覆盖**新默认，修复零生效且 typecheck 毫无反应
 * （change browser-slot-scheduling 的受理超时 45s→200s 就是这么废掉的）。
 */
function readEnvNumberOrUndefined(name: string): number | undefined {
  const value = readEnvString(name);
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function objectKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'unknown';
}

function createCuratedReferenceImageRelocator(store: ObjectStore) {
  return async (ctx: {
    accountId: string;
    sourceId: string;
    images: CuratedReferenceImage[];
  }): Promise<CuratedReferenceImage[]> => {
    const account = objectKeyPart(ctx.accountId);
    const source = objectKeyPart(ctx.sourceId);
    const out: CuratedReferenceImage[] = [];
    for (let i = 0; i < ctx.images.length; i++) {
      const img = ctx.images[i];
      try {
        const relocated = await relocateImageToStore(img.sourceUrl, `curated-reference/${account}/${source}/${String(i + 1).padStart(2, '0')}`, {
          store,
          logger: console,
        });
        if (!relocated) throw new Error('relocation returned empty url');
        out.push({
          ...img,
          ossUrl: relocated,
          captureStatus: 'stored',
          capturedAt: Date.now(),
        });
      } catch (err) {
        console.warn('[aidcp-cloud] curated reference image relocation failed:', (err as Error).message);
        out.push({
          ...img,
          captureStatus: 'fetch_failed',
          capturedAt: img.capturedAt ?? Date.now(),
        });
      }
    }
    return out;
  };
}

/**
 * ⚠️ 全部指标键**无条件物化**（缺失 → 0）。任何平台投影都必须跑在**本函数之后**，绝不在之前——
 * 先摘再 pick 会把摘掉的键补回 `0`，quotaSaturation 随即算出 `totals(0) >= cap(0)` ⇒ 标 saturated ⇒
 * 客户端渲染「0/0 今日计划已完成」，typecheck 全绿。见 omitUnsupportedUsageMetrics 的调用顺序注释。
 *
 * 键名与风控动作名逐字同名（含 join_group）⇒ 本函数可直读风控 totals，无 UI↔风控映射表。
 * 清单来自 protocol.ts 的单一来源，勿在此另写一份。
 */
function quotaSaturation(totals: UiDailyUsageCounts, quotas: UiDailyUsageCounts): UiDailyUsageAction[] {
  return UI_DAILY_USAGE_ACTIONS.filter((action) => {
    const cap = quotas[action];
    return typeof cap === 'number' && (totals[action] ?? 0) >= cap;
  });
}

function makeUsageWindow(
  totals: UiDailyUsageCounts,
  quotas?: UiDailyUsageCounts,
  options?: {
    active?: boolean;
    startedAt?: number;
    windowMs?: number;
    expiresAt?: number;
    refreshAt?: number;
    releaseAt?: number;
    skipSaturation?: boolean;
  },
): UiDailyUsageWindowStatus {
  const window: UiDailyUsageWindowStatus = { totals };
  if (options && Object.prototype.hasOwnProperty.call(options, 'active')) window.active = options.active;
  if (typeof options?.startedAt === 'number' && Number.isFinite(options.startedAt)) window.startedAt = options.startedAt;
  if (typeof options?.windowMs === 'number' && Number.isFinite(options.windowMs) && options.windowMs > 0) {
    window.windowMs = Math.floor(options.windowMs);
  }
  if (typeof options?.expiresAt === 'number' && Number.isFinite(options.expiresAt)) window.expiresAt = options.expiresAt;
  if (typeof options?.refreshAt === 'number' && Number.isFinite(options.refreshAt)) window.refreshAt = options.refreshAt;
  if (typeof options?.releaseAt === 'number' && Number.isFinite(options.releaseAt)) window.releaseAt = options.releaseAt;
  if (quotas && Object.keys(quotas).length > 0) {
    window.quotas = quotas;
    window.saturated = options?.skipSaturation ? [] : quotaSaturation(totals, quotas);
  }
  return window;
}

function usageWindowReleaseAt(
  controller: RiskController,
  window: RiskWindow,
  saturated: UiDailyUsageAction[] | undefined,
  asOf: number,
): number | undefined {
  let releaseAt: number | undefined;
  for (const action of saturated ?? []) {
    const retryAfterMs = controller.quotaReleaseAfterMs(action as RiskAction, window);
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) continue;
    const at = asOf + Math.ceil(retryAfterMs);
    releaseAt = releaseAt === undefined ? at : Math.min(releaseAt, at);
  }
  return releaseAt;
}

function dayWindowStart(at: number): number {
  return shanghaiDayStartMs(at);
}

/**
 * 解析毫秒超时 env：非有限数 / 低于 1s（surely misconfig）视为非法，回落 fallback（绝不 brick）。
 * change raise-model-call-timeouts-for-thinking-models：为单次模型天花板 / 发布总闸等提供统一的下限保护。
 */
function normalizeTimeoutMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1_000 ? n : fallback;
}

function parseForbiddenPorts(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

interface ApiDirectAuthorities {
  accountRoster?: AccountRosterAuthorityPort;
  accountOwnership?: AccountOwnershipAuthorityPort;
  accountRuntime?: AccountRuntimeAuthorityPort;
  publishLog?: AutomationPublishLogPort;
  edgePublish?: EdgePublishCommandPort;
  interactionAuth?: InteractionAuthAuthorityPort;
  interactionApiWrites?: InteractionApiWritesPort;
  replyConfig?: ReplyConfigResolverPort;
  accountPersona?: AccountPersonaAuthorityPort;
  environmentHandshake?: EnvironmentHandshakePort;
  commentApprovalPolicy?: CommentApprovalPolicyPort;
  notificationContacts?: NotificationContactsPort;
  firstPostProgress?: FirstPostProgressPort;
  automationConfigCommands?: AutomationConfigCommandsPort;
  offboardAdmissionLedger?: OffboardAdmissionLedgerPort;
  notificationDelivery?: StructuredNotificationDeliveryPort;
}

interface CompositionContext {
  // late-bound real-ring ports & forward-declared handles (assigned in a later segment than a referencing closure)
  scheduledPublishReconciler?: ScheduledPublishReconciler | null;
  publishScheduler?: PublishScheduler;
  uiSnapshot?: UiSnapshotService;
  interactionSender?: InteractionSendOrchestrator;
  edgeServer?: EdgeCloudServer;
  runtimes?: ConnectionRuntimeRegistry;
  // single-assignment cross-segment handles
  apiDirectAuthorities?: ApiDirectAuthorities;
  apiFeishuOwner?: ApiFeishuOwner;
  automationDispatchCommands?: Pick<
    CommandFaceDeps,
    'dispatch' | 'dispatchActive'
  >;
  automationEdgeResumeAuthority?: EdgeResumeCommandPort;
  automationFacebookScopeAuthority?: FacebookScopeCommandPort;
  automationPublishUiUpdateAuthority?: PublishUiUpdateCommandPort;
  contentPersonaGeneratorAuthority?: PersonaGeneratorAuthorityPort;
  publishUiUpdateCommand?: PublishUiUpdateCommandPort;
  pushApiOwnedPublishPreview?: (recordId: number) => Promise<void>;
  pushApiOwnedPublishState?: (
    accountId: string,
    recordId: number,
    state: 'pending' | 'approved' | 'submitted' | 'rejected' | 'failed',
    factVersion: number,
    title?: string | null,
  ) => Promise<void>;
  accountDisplayName: (accountId: string) => string | undefined;
  accountDisplayNameCandidates: (accountId: string) => string[];
  accountPersonaService?: AccountPersonaService;
  accountProjectionStore?: PgAccountProjectionStore;
  apiSyncReadMirrors?: ApiSyncReadMirrors;
  apiSyncReadSource?: ApiSyncReadSnapshotSource;
  automationSyncReadMirrors?: AutomationSyncReadMirrors;
  automationSyncReadSource?: AutomationSyncReadSnapshotSource;
  accountState: AccountStateManager;
  accountStore: AccountStore | undefined;
  alertStore?: PgAlertStore | undefined;
  anyImageKeyPresent: boolean;
  approvalPolicyStore: ApprovalPolicyStore | undefined;
  approvePublishForClient?: ReturnType<typeof createClientPublishApprovalHandler>;
  botChatsProvider?: Awaited<
    ReturnType<ApiFeishuOwner['startIngress']>
  >['botChatsProvider'];
  buildTodayUsageForAccount?: (accountId: string, edgeId?: string) => Promise<UiDailyUsagePayload>;
  cache: PgAnchorCache;
  captchaAssist?: CaptchaAssistService;
  categoryConfigStore: CategoryConfigStore;
  clientUserStore: ClientUserStore;
  commandFace?: CommandFace;
  commentScheduler?: CommentScheduler | undefined;
  conceptStore: ConceptStore | undefined;
  configMirrorPool: pg.Pool;
  // Block③ L3 step0：event_outbox / event_outbox_cursor / 风控命令 outbox 均属 automation。
  // 拆段传输 helper（风控命令消费者 / 事件→outbox 桥 / 面板回放 / emitRiskCommand）MUST 用 automation 池，
  // 而非 api 的 configMirrorPool（后者只服务 config_mirror_version）。单库下二池同库、字节等价；拆库后才分道。
  automationPool: pg.Pool;
  // api 属主池（accounts / persona_config / publish_log 等）。configMirrorPool 亦指向它（同对象），
  // 但语义为「config_mirror_version 专用」；面板等 api 属主读写按属主取用本字段，避免与 mirror 语义混淆。
  apiPool: pg.Pool;
  configMirrorRefresher?: ConfigMirrorRefresher;
  /** api 侧失效信号落地端（segA 构造；api 模式的内部 HTTP 监听把它暴露成 route）。 */
  configMirrorBumpSink: ConfigMirrorBumpSink;
  contentScheduleStore: ContentScheduleStore;
  credentialStore: CredentialStore;
  curatedContentStore: CuratedContentStore | undefined;
  dashscopeApiKey: string | undefined;
  delegatedTaskService: DelegatedTaskService | undefined;
  delegatedTaskStore: PgDelegatedTaskStore | undefined;
  deploymentTarget: "dev" | "ol" | null;
  draftRefinementStore: DraftRefinementStore | undefined;
  eventBus: EventBus;
  facebookCommentAuditStore: FacebookCommentAuditStore;
  facebookCommentConfigStore: FacebookCommentConfigStore;
  facebookGroupJoinAuditStore: FacebookGroupJoinAuditStore;
  facebookGroupJoinAutomationStore: FacebookGroupJoinAutomationStore;
  facebookGroupMembershipStore: FacebookGroupMembershipStore;
  facebookGroupTargetStore: FacebookGroupTargetStore;
  facebookPublishMediaStore: FacebookPublishMediaStore | undefined;
  firstPostOnboardingStore: FirstPostOnboardingStore | undefined;
  getSoul: (accountId?: string) => Soul;
  groupRouteStore: GroupRouteStore | undefined;
  handlePublishDraftImageRemove?: ReturnType<typeof createPublishDraftImageRemoveHandler>;
  hotLeadConfigStore: HotLeadConfigStore;
  imageProvider?: RoutingImageProvider;
  interactionCustomerApi?: InteractionCustomerApi | undefined;
  // Block② 数据网关：收件箱读侧窄面本地实例（segC 构造），additive 挂 ctx 供 segD 组建 DataGateway 聚合；不改其构造/时机。
  interactionStore?: InteractionStore | undefined;
  interactionInternalApi?: { handle: (req: import("http").IncomingMessage, res: import("http").ServerResponse<import("http").IncomingMessage>, actor: string) => Promise<boolean>; } | undefined;
  interactionOffboarding?: InteractionOffboardingService | undefined;
  interactionPermissionOverview?: ReturnType<typeof buildInteractionPermissionOverview>;
  listAccountAutomationCatalog?: () => Promise<ContentScheduleCatalogRow[]>;
  llm: QwenClient;
  manualCommentAccounts: Set<string>;
  mirrorVersionStore: MirrorVersionStore;
  modelConfigStore: ModelConfigStore;
  notificationContactStore: NotificationContactStore | undefined;
  notifyPublishRejected?: (requestId: string) => void;
  ossUploader: ObjectStore | undefined;
  pacingConfigStore: PacingConfigStore;
  /** api 进程的本地实时事件扇出；内部 ingress 写入、panel-ws 只读订阅。 */
  panelEventFanout?: PanelEventFanout;
  panelUsers?: ReturnType<typeof parsePanelUsers>;
  personaAutoFill?: PersonaAutoFillService | undefined;
  personaAutoFillStore: PersonaAutoFillStore | undefined;
  personaPanel: ReturnType<typeof createPersonaPanel>;
  personaStore: PersonaStore;
  planner: SimplePlanner;
  port: number;
  preflightApprovePublish?: (requestId: string) => Promise<PublishApprovalPreflightResult>;
  providerRuntime: Record<string, { baseUrl: string; apiKey: string; }>;
  publishApprovalAuthority?: PublishApprovalAuthorityPort;
  publishApprovalClient: ReturnType<typeof createPublishApprovalClient> | undefined;
  publishApprovalDecisionWriter?: PublishApprovalDecisionWriterPort;
  publishApprovalStore: PublishApprovalStore | undefined;
  publishDispatchTrigger?: PublishDispatchTriggerPort;
  publishDispatcher?: PublishDispatcher;
  publishLogStore: PublishLogStore;
  /**
   * 发布台账的**窄写入口**（change cloud-batch2-content-main）：内容域只经这四个方法写。
   * 单体里就是上面那个存储本身（结构上满足），拆进程后 content 侧换成 `PublishLogHttpClient`。
   * 上面那个整存储另有二十余个方法（排期 / 下发 / 编辑 / 对账），**都不属于内容域**。
   */
  publishLogWriter: PublishLogWriter;
  /**
   * 发布管线角色执行日志 sink（change cloud-batch2-content-main）。`publish_pipeline_logs` 属 api，
   * 内容段只写。拆进程后 content 侧换成 `PipelineLogHttpClient`（写不成吵闹放过，绝不阻塞发布）。
   */
  pipelineLogSink: PipelineLogSink;
  /**
   * 发布候审的卡片出口（change cloud-batch2-content-main）：发卡 / 发通知 / 传图 / 默认群 /
   * 落点解析 / 免审预授权，六个方法一组。基础段构造（实现全在本域），内容段只调。
   * 拆进程后 content 侧换成 `PublishCardExitHttpClient`，**内容仓因此不需要飞书 SDK**。
   */
  publishCardExit: PublishCardExitPort;
  /**
   * 图片模型选择的**同步**读（change cloud-batch2-content-main）。单体 = 配置存储的进程内缓存；
   * content 拆进程后注入 `PollingImageModelSelectionMirror`（异步取源 + 本地镜像），
   * 调用点签名不变、热路径不加网络跳。
   */
  imageModelSelection: ImageModelSelectionReader;
  /**
   * 角色模型解析的**同步**读（change cloud-batch2-content-main）：单体 = 就地四层回落；
   * content 拆进程后注入 `PollingRoleModelSelectionMirror`（属主侧预解析 + 本地查表）。
   */
  roleModelSelection: RoleModelSelectionReader;
  /** 角色模型解析的异步取源（属主侧实现，供 content 侧镜像刷新器调）。 */
  roleModelSelectionSource: RoleModelSelectionSource;
  /** 厂商密钥窄读（change cloud-batch2-content-main）：启动期几次调用，不需要镜像。 */
  providerSecretReader: ProviderSecretReader;
  /**
   * 账号平台窄读（change cloud-batch2-content-main）：`accounts` 属 api，内容域的素材库守卫经它问。
   * 缺账号 → null 是**答案**不是兜底；读失败必须抛，两者 MUST 可区分。
   */
  accountPlatformReader: AccountPlatformReader | undefined;
  /**
   * 「哪些参照稿已被触发过」（change cloud-batch2-content-main）：委托任务台账属 automation，
   * 内容域的精选库拿它判去重。读不到 MUST 抛 —— 回空集合会让每条用过的参照稿重新变成可用。
   */
  triggeredPublishRefs: TriggeredPublishRefsReader | undefined;
  /**
   * 候审预览读（change cloud-batch2-content-main）。内容段只在**界面推送口在场时**才调它 ——
   * 那个推送口由自动化段赋值，content 进程里恒缺席，故这条读在 content 里恒不可达。
   * content 的 `main()` MUST 注入 `unavailableInMode(...)`：不可达就该是不可达，
   * 万一哪天可达性假设被改坏，要当场响亮失败，而不是悄悄发一次跨进程读。
   */
  pendingPublishPreviewForAccount: (accountId: string) => Promise<PendingPublishPreview | null>;
  publishOrchestrator?: PublishOrchestrator;
  quotaConfigStore: QuotaConfigStore;
  readLiveContentVersion?: (recordId: number) => Promise<number | null>;
  readPublishApproval?: (requestId: string) => Promise<{ approved: boolean; contentVersion: number; revision: number; } | null>;
  refreshPublishPreview?: (recordId: number) => void;
  /**
   * 候审卡投递判定（change cloud-batch2-content-main）：基础段构造（判定要的两张表都是 api 属主），
   * 内容段只调。拆进程后 content 侧换成 `ReviewCardDeliveryHttpClient`，调用点一行不改。
   */
  resolveReviewCardDelivery: ReviewCardDeliveryPort['resolveReviewCardDelivery'];
  resolveController?: (accountId: string) => Promise<RiskController>;
  resolvePersona: ReturnType<typeof createPersonaResolver>;
  resumeConfigStore: ResumeConfigStore;
  riskRegistry?: RiskControllerRegistry;
  /** 风控写命令服务（P5-1）：segC 构造（提交 + 结果账本），segD 注入面板。 */
  riskCommandService?: PgRiskCommandService;
  roleConfigStore: RoleConfigStore;
  rolePromptProvider?: ReturnType<typeof createRolePromptProvider>;
  server?: EdgeCloudServer;
  sessionConfigStore: SessionConfigStore;
  tokenUsageStore: TokenUsageStore;
  triggerPublishDispatchOnApprove?: (
    requestId: string,
    revision: number,
    kind: PublishDispatchTriggerKind,
  ) => Promise<void>;
  installPublishApprovalOutboxWake: (wake: () => void) => void;
  wakePublishApprovalOutbox: () => void;
  writeApprovalDecision: (
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
    context: ApprovalDecisionContext,
  ) => Promise<{ written: boolean; alreadyDecided?: boolean; revision: number; }>;
}

async function main(): Promise<void> {
  // Block② 2d 第一步：按 AIDCP_SERVICE 选运行模式（一套代码、多入口）。
  //   - monolith（默认 / 未设 / 未识别值）：四段全跑、无新监听、网关默认 local —— 与拆分前逐字节等价。
  //   - content：segA+segB，跳 segC/segD，额外起内部 HTTP 读 API 服务 curated-content 读端点。
  //   - core：segA+segC+segD，跳 segB，curated 读侧经数据网关走 HTTP（需 env 指向 content 进程）。
  const mode: ServiceMode = serviceModeFromEnv();
  const segments = segmentsForMode(mode);
  const listeners = listenersForMode(mode);
  if (mode !== 'monolith') {
    console.log(`[aidcp-cloud] AIDCP_SERVICE=${mode} —— 按段计划启动`, segments);
  }

  const ctx = {} as CompositionContext;
  if (segments.segA) await segAApiFoundation(ctx);
  if (segments.segB) await segBContent(ctx);
  if (segments.segC) await segCAutomation(ctx);
  if (segments.segD) await segDApiServing(ctx);
  if (listeners.contentReadApi) await startContentReadApi(ctx);
  // Block② 2e：automation 独立进程起内部 API（供 api/content 进程访问 automation-owned 能力）。
  // 仅 automation 模式起：monolith/core 的 segD 与 registry 同进程、走本地适配（不需 HTTP）；content/api 无 registry。
  if (mode === 'automation') await startAutomationInternalApi(ctx);
  // Block③ L3：api 独立进程起内部写 API（供 automation 进程的失效信号中继把 bump 推过来）。
  // 仅 api 模式起：monolith/core/content 的 api 池就在本进程、中继走本地 sink、零 HTTP。
  if (mode === 'api') await startApiInternalApi(ctx);
}

const API_SYNC_READ_OWNER_STREAMS = [
  'account_persona',
  'client_environment_automation',
  'automation_account_projection',
  'content_schedule',
  'hot_lead_config',
  'facebook_comment_config',
  'facebook_group_join_automation_config',
] as const satisfies readonly SyncReadStream[];

const AUTOMATION_SYNC_READ_OWNER_STREAMS = [
  'session_config_global',
  'edge_presence',
  'publish_in_flight',
  'captcha_availability',
  'automation_config_mirror_health',
] as const satisfies readonly SyncReadStream[];

const AUTOMATION_RUNTIME_SYNC_READ_STREAMS = [
  'edge_presence',
  'publish_in_flight',
  'captcha_availability',
  'automation_config_mirror_health',
] as const satisfies readonly AutomationRuntimeSyncReadStream[];

/**
 * The monolith deliberately exercises the same 4b owner-snapshot contracts as
 * split services. Local authority only removes the HTTP hop; it does not permit
 * direct cross-owner reads or bypass consumer checkpoints.
 */
async function startMonolithSyncReads(ctx: CompositionContext): Promise<void> {
  const executionTarget = ctx.deploymentTarget;
  if (!executionTarget) {
    throw new Error('AIDCP_DEPLOY_ENV is required for monolith sync-read mirrors');
  }
  const projection = requireSegment(
    ctx.accountProjectionStore,
    'accountProjectionStore',
    'automation',
  );

  const apiSource = createApiSyncReadSource(ctx, executionTarget);
  const automationSource = createAutomationSyncReadSource(
    ctx,
    executionTarget,
  );
  const apiMirrors = new ApiSyncReadMirrors(executionTarget);
  const automationMirrors = new AutomationSyncReadMirrors(executionTarget);
  const apiCheckpoints = createApiSyncReadConsumerCheckpointStore(
    ctx.apiPool,
    executionTarget,
  );
  const automationCheckpoints =
    createAutomationSyncReadConsumerCheckpointStore(
      ctx.automationPool,
      executionTarget,
    );

  ctx.apiSyncReadSource = apiSource;
  ctx.automationSyncReadSource = automationSource;
  ctx.apiSyncReadMirrors = apiMirrors;
  ctx.automationSyncReadMirrors = automationMirrors;

  await Promise.all([
    ...AUTOMATION_SYNC_READ_OWNER_STREAMS.map(async (stream) => {
      const loaded = await apiCheckpoints.load(stream);
      if (loaded.outcome === 'unknown') {
        throw new Error(
          `api_sync_read_checkpoint_invalid stream=${stream}: ${loaded.message}`,
        );
      }
      if (loaded.outcome === 'loaded') {
        const restored = restoreApiSyncReadCheckpoint(
          apiMirrors,
          stream,
          loaded.checkpoint,
        );
        if (restored.outcome !== 'loaded') {
          throw new Error(
            `api_sync_read_checkpoint_restore_failed stream=${stream}`,
          );
        }
      }
    }),
    ...API_SYNC_READ_OWNER_STREAMS.map(async (stream) => {
      const loaded = await automationCheckpoints.load(stream);
      if (loaded.outcome === 'unknown') {
        throw new Error(
          `automation_sync_read_checkpoint_invalid stream=${stream}: ${loaded.message}`,
        );
      }
      if (loaded.outcome === 'loaded') {
        const restored = restoreAutomationSyncReadCheckpoint(
          automationMirrors,
          stream,
          loaded.checkpoint,
        );
        if (restored.outcome !== 'loaded') {
          throw new Error(
            `automation_sync_read_checkpoint_restore_failed stream=${stream}`,
          );
        }
      }
    }),
  ]);

  const refreshAutomationOwned = async (): Promise<void> => {
    await Promise.all(
      AUTOMATION_RUNTIME_SYNC_READ_STREAMS.map((stream) =>
        automationSource.publishChanged(stream),
      ),
    );
    await Promise.all(
      AUTOMATION_SYNC_READ_OWNER_STREAMS.map(async (stream) => {
        const envelope = await automationSource.snapshot(stream);
        const applied = apiMirrors.apply(envelope, 'owner_fetch');
        if (applied.outcome === 'rejected') {
          throw new Error(
            `api_sync_read_apply_failed stream=${stream} reason=${applied.reason}`,
          );
        }
        const saved = await apiCheckpoints.save(
          apiSyncReadCheckpoint(apiMirrors, stream),
        );
        if (saved.outcome !== 'stored') {
          throw new Error(
            `api_sync_read_checkpoint_save_failed stream=${stream} reason=${saved.reason}`,
          );
        }
      }),
    );
  };

  const refreshApiOwned = async (): Promise<void> => {
    await Promise.all(
      API_SYNC_READ_OWNER_STREAMS.map(async (stream) => {
        const envelope = await apiSource.snapshot(stream);
        if (stream === 'automation_account_projection') {
          const projected = await projection.applyOwnerSnapshot(envelope);
          if (projected.outcome === 'rejected') {
            throw new Error(
              `automation_account_projection_apply_failed reason=${projected.reason}`,
            );
          }
        }
        const applied = automationMirrors.apply(envelope, 'owner_fetch');
        if (applied.outcome === 'rejected') {
          throw new Error(
            `automation_sync_read_apply_failed stream=${stream} reason=${applied.reason}`,
          );
        }
        if (stream !== 'automation_account_projection') {
          const saved = await automationCheckpoints.save(
            automationSyncReadCheckpoint(automationMirrors, stream),
          );
          if (saved.outcome !== 'stored') {
            throw new Error(
              `automation_sync_read_checkpoint_save_failed stream=${stream} reason=${saved.reason}`,
            );
          }
        }
      }),
    );
  };

  await refreshAutomationOwned();
  await refreshApiOwned();
  const apiReadiness = apiMirrors.readiness();
  const automationReadiness = automationMirrors.readiness();
  if (
    apiReadiness.state !== 'ready' ||
    automationReadiness.state !== 'ready'
  ) {
    throw new Error(
      `monolith_sync_read_not_ready api=${JSON.stringify(apiReadiness)} automation=${JSON.stringify(automationReadiness)}`,
    );
  }

  scheduleSyncReadRefresh(
    'automation-owner',
    10_000,
    refreshAutomationOwned,
  );
  scheduleSyncReadRefresh('api-owner', 30_000, refreshApiOwned);
  console.log(
    `[aidcp-cloud] 4b 单体权威镜像已就绪（target=${executionTarget}，API consumer=5，automation consumer=7）`,
  );
}

function scheduleSyncReadRefresh(
  owner: string,
  delayMs: number,
  refresh: () => Promise<void>,
): void {
  const schedule = (): void => {
    const timer = setTimeout(() => {
      void refresh()
        .catch((error) => {
          console.warn(
            `[sync-read] ${owner} periodic owner snapshot failed; freshness will fail closed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(schedule);
    }, delayMs);
    timer.unref();
  };
  schedule();
}

function createApiSyncReadSource(
  ctx: CompositionContext,
  executionTarget: 'dev' | 'ol',
): ApiSyncReadSnapshotSource {
  return new ApiSyncReadSnapshotSource({
    executionTarget,
    pool: ctx.apiPool,
    parseSoul: (personaText) => {
      try {
        return JSON.parse(
          JSON.stringify(PERSONA_SOUL_CODEC.parseYaml(personaText)),
        );
      } catch {
        return null;
      }
    },
  });
}

function createAutomationSyncReadSource(
  ctx: CompositionContext,
  executionTarget: 'dev' | 'ol',
): AutomationSyncReadSnapshotSource {
  const configMirrorRefresher = requireSegment(
    ctx.configMirrorRefresher,
    'configMirrorRefresher',
    'automation',
  );
  const edgeServer = requireSegment(ctx.server, 'server', 'automation');
  const publishDispatcher = requireSegment(
    ctx.publishDispatcher,
    'publishDispatcher',
    'automation',
  );
  return new AutomationSyncReadSnapshotSource(
    executionTarget,
    {
      sessionConfigGlobal: () => ctx.sessionConfigStore.syncReadObservation(),
      edgePresence: () => edgeServer.edgePresenceSnapshot(),
      publishInFlight: () => ({
        recordIds: publishDispatcher.getInFlightRecordIds(),
      }),
      captchaAvailability: () => ({
        state:
          readEnvString('AIDCP_CAPTCHA_ASSIST_ENABLED') !== 'true'
            ? 'disabled'
            : ctx.captchaAssist?.isAvailable()
              ? 'available'
              : 'unavailable',
      }),
      configMirrorHealth: () => {
        const health = configMirrorRefresher.health();
        return {
          sourceService: 'automation',
          ...health,
          entries: health.entries.filter(
            (entry) =>
              CONFIG_MIRRORS[
                entry.mirrorKey as keyof typeof CONFIG_MIRRORS
              ]?.owner === 'automation',
          ),
        };
      },
    },
    new PgAutomationSyncReadGenerationStore(
      executionTarget,
      ctx.automationPool,
    ),
    new SyncReadChangedOutbox(executionTarget, ctx.automationPool),
  );
}

function restoreApiSyncReadCheckpoint(
  mirrors: ApiSyncReadMirrors,
  stream: (typeof AUTOMATION_SYNC_READ_OWNER_STREAMS)[number],
  checkpoint: SyncReadConsumerCheckpoint,
) {
  switch (stream) {
    case 'session_config_global':
      return mirrors.sessionConfig.restoreCheckpoint(checkpoint);
    case 'edge_presence':
      return mirrors.edgePresence.restoreCheckpoint(checkpoint);
    case 'publish_in_flight':
      return mirrors.publishInFlight.restoreCheckpoint(checkpoint);
    case 'captcha_availability':
      return mirrors.captchaAvailability.restoreCheckpoint(checkpoint);
    case 'automation_config_mirror_health':
      return mirrors.automationHealth.restoreCheckpoint(checkpoint);
  }
}

function apiSyncReadCheckpoint(
  mirrors: ApiSyncReadMirrors,
  stream: (typeof AUTOMATION_SYNC_READ_OWNER_STREAMS)[number],
): SyncReadConsumerCheckpoint {
  switch (stream) {
    case 'session_config_global':
      return mirrors.sessionConfig.checkpoint();
    case 'edge_presence':
      return mirrors.edgePresence.checkpoint();
    case 'publish_in_flight':
      return mirrors.publishInFlight.checkpoint();
    case 'captcha_availability':
      return mirrors.captchaAvailability.checkpoint();
    case 'automation_config_mirror_health':
      return mirrors.automationHealth.checkpoint();
  }
}

function restoreAutomationSyncReadCheckpoint(
  mirrors: AutomationSyncReadMirrors,
  stream: (typeof API_SYNC_READ_OWNER_STREAMS)[number],
  checkpoint: SyncReadConsumerCheckpoint,
) {
  switch (stream) {
    case 'account_persona':
      return mirrors.persona.restoreCheckpoint(checkpoint);
    case 'client_environment_automation':
      return mirrors.environment.restoreCheckpoint(checkpoint);
    case 'automation_account_projection':
      return mirrors.accounts.restoreCheckpoint(checkpoint);
    case 'content_schedule':
      return mirrors.contentSchedule.restoreCheckpoint(checkpoint);
    case 'hot_lead_config':
      return mirrors.hotLead.restoreCheckpoint(checkpoint);
    case 'facebook_comment_config':
      return mirrors.facebookComment.restoreCheckpoint(checkpoint);
    case 'facebook_group_join_automation_config':
      return mirrors.facebookGroupJoin.restoreCheckpoint(checkpoint);
  }
}

function automationSyncReadCheckpoint(
  mirrors: AutomationSyncReadMirrors,
  stream: Exclude<
    (typeof API_SYNC_READ_OWNER_STREAMS)[number],
    'automation_account_projection'
  >,
): SyncReadConsumerCheckpoint {
  switch (stream) {
    case 'account_persona':
      return mirrors.persona.checkpoint();
    case 'client_environment_automation':
      return mirrors.environment.checkpoint();
    case 'content_schedule':
      return mirrors.contentSchedule.checkpoint();
    case 'hot_lead_config':
      return mirrors.hotLead.checkpoint();
    case 'facebook_comment_config':
      return mirrors.facebookComment.checkpoint();
    case 'facebook_group_join_automation_config':
      return mirrors.facebookGroupJoin.checkpoint();
  }
}

/**
 * api 进程独占的内部 API：把本进程的配置镜像失效信号落地端（`config_mirror_version` 的属主）
 * 暴露成一条内部 HTTP route，供 automation 进程的中继投递（change block3-l3-config-mirror-bump-decouple）。
 *
 * 这是本目录里**唯一一条写 route**，且写的只是「某项配置变了，请重读」的失效信号 ——
 * 不搬配置内容、不接受任何配置值，消费方永远从自己的权威重读。幂等由 `dedupKey` 承担。
 * 仅 api 模式调用（monolith/core/content 的 api 池就在本进程，中继走本地 sink、不需 HTTP）。
 */
async function startApiInternalApi(ctx: CompositionContext): Promise<void> {
  const sink = ctx.configMirrorBumpSink;
  const port = readEnvPort('AIDCP_API_PORT') ?? DEFAULT_API_INTERNAL_API_PORT;
  const httpServer = new InternalHttpServer();
  if (!ctx.deploymentTarget) {
    throw new Error('AIDCP_DEPLOY_ENV is required for API direct-authority routes');
  }
  const directToken = requireDirectInternalToken('AIDCP_API_INTERNAL_TOKEN');
  ctx.apiSyncReadSource ??= createApiSyncReadSource(
    ctx,
    ctx.deploymentTarget,
  );
  const direct = ctx.apiDirectAuthorities ?? {};
  const registerDirect = (
    name: keyof ApiDirectAuthorities,
    register: () => void,
  ): void => {
    if (direct[name]) register();
    else console.warn(`[aidcp-cloud] api 内部 API：4a ${name} route 未注册（owner capability 不可用）`);
  };
  registerDirect('accountRoster', () =>
    registerAccountRosterRoutes(httpServer, direct.accountRoster!, directToken, ctx.deploymentTarget!));
  registerDirect('accountOwnership', () =>
    registerAccountOwnershipRoutes(httpServer, direct.accountOwnership!, directToken, ctx.deploymentTarget!));
  registerDirect('accountRuntime', () =>
    registerAccountRuntimeRoutes(httpServer, direct.accountRuntime!, directToken, ctx.deploymentTarget!));
  registerDirect('publishLog', () =>
    registerAutomationPublishLogRoutes(httpServer, direct.publishLog!, directToken, ctx.deploymentTarget!));
  registerDirect('edgePublish', () =>
    registerEdgePublishCommandRoutes(httpServer, direct.edgePublish!, directToken, ctx.deploymentTarget!));
  registerDirect('interactionAuth', () =>
    registerInteractionAuthRoutes(httpServer, direct.interactionAuth!, directToken, ctx.deploymentTarget!));
  registerDirect('interactionApiWrites', () =>
    registerInteractionApiWritesRoutes(httpServer, direct.interactionApiWrites!, directToken, ctx.deploymentTarget!));
  registerDirect('replyConfig', () =>
    registerReplyConfigResolverRoutes(httpServer, direct.replyConfig!, directToken, ctx.deploymentTarget!));
  registerDirect('accountPersona', () =>
    registerAccountPersonaRoutes(httpServer, direct.accountPersona!, directToken, ctx.deploymentTarget!));
  registerDirect('environmentHandshake', () =>
    registerEnvironmentHandshakeRoutes(httpServer, direct.environmentHandshake!, directToken, ctx.deploymentTarget!));
  registerDirect('commentApprovalPolicy', () =>
    registerCommentApprovalPolicyRoutes(httpServer, direct.commentApprovalPolicy!, directToken, ctx.deploymentTarget!));
  registerDirect('notificationContacts', () =>
    registerNotificationContactsRoutes(httpServer, direct.notificationContacts!, directToken, ctx.deploymentTarget!));
  registerDirect('firstPostProgress', () =>
    registerFirstPostProgressRoutes(httpServer, direct.firstPostProgress!, directToken, ctx.deploymentTarget!));
  registerDirect('automationConfigCommands', () =>
    registerAutomationConfigCommandsRoutes(
      httpServer,
      direct.automationConfigCommands!,
      directToken,
      ctx.deploymentTarget!,
    ));
  registerDirect('offboardAdmissionLedger', () =>
    registerOffboardAdmissionLedgerRoutes(
      httpServer,
      direct.offboardAdmissionLedger!,
      directToken,
      ctx.deploymentTarget!,
    ));
  registerDirect('notificationDelivery', () =>
    registerStructuredNotificationRoutes(
      httpServer,
      direct.notificationDelivery!,
      directToken,
      ctx.deploymentTarget!,
    ));
  if (ctx.apiSyncReadSource) {
    registerSyncReadSnapshotRoute(
      httpServer,
      {
        snapshotFor: ({ stream }) => ctx.apiSyncReadSource!.snapshot(stream),
      },
      {
        owner: 'api',
        executionTarget: ctx.deploymentTarget,
        bearerToken: directToken,
        streams: API_SYNC_READ_OWNER_STREAMS,
      },
    );
  } else {
    console.warn(
      '[aidcp-cloud] api 内部 API：4b owner snapshot route 未注册（source 不可用）',
    );
  }
  if (sink) registerConfigMirrorBumpRoutes(httpServer, sink);
  else console.warn('[aidcp-cloud] api 内部 API：配置镜像失效信号路由未注册（segA 未构造）');
  if (ctx.panelEventFanout && ctx.deploymentTarget) {
    registerPanelEventDeliveryRoutes(httpServer, ctx.panelEventFanout, ctx.deploymentTarget);
  } else {
    console.warn('[aidcp-cloud] api 内部 API：panel-event ingress 未注册（fanout 或 AIDCP_DEPLOY_ENV 不可用）');
  }
  if (ctx.publishApprovalAuthority) {
    registerPublishApprovalAuthorityRoutes(
      httpServer,
      ctx.publishApprovalAuthority,
      requirePublishApprovalInternalToken(),
    );
  } else {
    console.warn('[aidcp-cloud] api 内部 API：publish-approval authority 未注册（属主存储或 target 不可用）');
  }
  if (ctx.publishApprovalDecisionWriter) {
    registerPublishApprovalDecisionWriterRoutes(
      httpServer,
      ctx.publishApprovalDecisionWriter,
      requirePublishApprovalInternalToken(),
    );
  } else {
    console.warn('[aidcp-cloud] api 内部 API：publish-approval decision writer 未注册（属主存储或 target 不可用）');
  }
  // 候审卡投递判定（change cloud-batch2-content-main）：判定要的两张表是 api 属主，实现留本进程；
  // content 进程经 ReviewCardDeliveryHttpClient 调这条 route。
  // **无缺席分支是有意的**：基础段在所有模式下都跑、且无条件赋值它（与 resolveCardChatId 同待遇），
  // 加一个恒为真的守卫只会把「这里可能缺」这个错误印象写进代码。
  registerReviewCardDeliveryRoutes(httpServer, {
    resolveReviewCardDelivery: (accountId) => ctx.resolveReviewCardDelivery(accountId),
  });
  // 发布台账窄写入口（change cloud-batch2-content-main）：`publish_log` 是本域属主表，
  // 内容域经这四条 route 写。**只暴露这四个**——那个存储另有二十余个方法不属于内容域，
  // 端口有多宽，拆进程后要守的跨进程契约就有多宽。
  registerPublishLogRoutes(httpServer, ctx.publishLogWriter);
  // 发布管线角色执行日志（change cloud-batch2-content-main）：`publish_pipeline_logs` 是本域属主表。
  registerPipelineLogRoutes(httpServer, ctx.pipelineLogSink);
  // 发布候审卡片出口（change cloud-batch2-content-main）：飞书客户端 / 机器人会话表 / 授权台账都在本域。
  registerPublishCardExitRoutes(
    httpServer,
    ctx.publishCardExit,
    requirePublishApprovalInternalToken(),
  );
  // 图片模型选择的异步取源（change cloud-batch2-content-main）：content 侧镜像刷新器调它。
  registerImageModelSelectionRoutes(httpServer, {
    fetchImageModelSelection: async () => ctx.imageModelSelection.current(),
  });
  // 角色模型解析的异步取源 + 厂商密钥窄读（change cloud-batch2-content-main）：
  // 三张配置表与凭据表都是本域属主表，content 侧经这两条 route 取。
  registerRoleModelSelectionRoutes(httpServer, ctx.roleModelSelectionSource);
  registerProviderSecretRoutes(httpServer, ctx.providerSecretReader);
  // 账号平台窄读（change cloud-batch2-content-main）：`accounts` 是本域属主表。
  // 未装配即如实告警、不注册 —— 绝不注册一条注定 500 的路由。
  if (ctx.accountPlatformReader) registerAccountPlatformRoutes(httpServer, ctx.accountPlatformReader);
  else console.warn('[aidcp-cloud] api 内部 API：账号平台读路由未注册（账号存储不可用）');
  const actual = await httpServer.listen(port);
  console.log(
    `[aidcp-cloud] api 内部 API 已监听 127.0.0.1:${actual}` +
      `（${sink ? 'config-mirror bump + ' : ''}` +
      `${ctx.panelEventFanout && ctx.deploymentTarget ? 'panel-event ingress + ' : ''}` +
      `review-card-delivery + publish-log + pipeline-log + publish-card-exit + image-model-selection + role-model-selection + provider-secret 落地端点）`,
  );
}

/**
 * automation 进程独占的内部 API：按能力注册 automation-owned 读写端口，供 api/content 进程消费。
 * 仅 automation 模式调用（monolith/core 同进程直调；content/api 不拥有这些事实）。
 *
 * 配置、Facebook 群运营、群路由与告警的写端点只转调各自 automation owner；风控命令端点
 * 只提交 outbox 并回读结果账本，不直接碰 `RiskController`。真正改风控状态的三个方法仍只在
 * 本进程 outbox 消费者的那一处回调里被调用，风控单写不变量在进程边界上物理成立。
 * 可选 owner 缺失时不注册对应能力：宁可调用报 404，也不返回伪造成功。
 */
async function startAutomationInternalApi(ctx: CompositionContext): Promise<void> {
  const port = readEnvPort('AIDCP_AUTOMATION_PORT') ?? DEFAULT_AUTOMATION_INTERNAL_API_PORT;
  const httpServer = new InternalHttpServer();
  if (!ctx.deploymentTarget) {
    throw new Error('AIDCP_DEPLOY_ENV is required for automation command routes');
  }
  const directToken = requireDirectInternalToken('AIDCP_AUTOMATION_INTERNAL_TOKEN');
  ctx.automationSyncReadSource ??= createAutomationSyncReadSource(
    ctx,
    ctx.deploymentTarget,
  );
  const observeRuntimeSyncReads = async (): Promise<void> => {
    await Promise.all(
      AUTOMATION_RUNTIME_SYNC_READ_STREAMS.map((stream) =>
        ctx.automationSyncReadSource!.publishChanged(stream),
      ),
    );
  };
  await observeRuntimeSyncReads();
  scheduleSyncReadRefresh(
    'automation-owner-observation',
    10_000,
    observeRuntimeSyncReads,
  );
  if (ctx.automationSyncReadSource) {
    registerSyncReadSnapshotRoute(
      httpServer,
      {
        snapshotFor: ({ stream }) =>
          ctx.automationSyncReadSource!.snapshot(stream),
      },
      {
        owner: 'automation',
        executionTarget: ctx.deploymentTarget,
        bearerToken: directToken,
        streams: AUTOMATION_SYNC_READ_OWNER_STREAMS,
      },
    );
  } else {
    console.warn(
      '[aidcp-cloud] automation 内部 API：4b owner snapshot route 未注册（source 不可用）',
    );
  }
  if (ctx.automationEdgeResumeAuthority) {
    registerEdgeResumeCommandRoutes(
      httpServer,
      ctx.automationEdgeResumeAuthority,
      directToken,
      ctx.deploymentTarget,
    );
  } else {
    console.warn('[aidcp-cloud] automation 内部 API：Edge resume route 未注册（本地 Edge server 不可用）');
  }
  if (ctx.automationFacebookScopeAuthority) {
    registerFacebookScopeCommandRoutes(
      httpServer,
      ctx.automationFacebookScopeAuthority,
      directToken,
      ctx.deploymentTarget,
    );
  } else {
    console.warn('[aidcp-cloud] automation 内部 API：Facebook scope routes 未注册（owner capability 不可用）');
  }
  if (ctx.automationPublishUiUpdateAuthority) {
    registerPublishUiUpdateCommandRoutes(
      httpServer,
      ctx.automationPublishUiUpdateAuthority,
      directToken,
      ctx.deploymentTarget,
    );
  } else {
    console.warn('[aidcp-cloud] automation 内部 API：Publish UI update route 未注册（UI snapshot 不可用）');
  }
  const registry = ctx.riskRegistry;
  if (registry) {
    const local: RiskReadPort = {
      getState: (accountId) => registry.getController(accountId).then((c) => c.getState()),
      effectiveQuotas: (accountId) => registry.getController(accountId).then((c) => c.effectiveQuotas()),
      slowStartView: (accountId) => registry.getController(accountId).then((c) => c.slowStartView()),
    };
    registerRiskReadRoutes(httpServer, local);
  } else {
    console.warn('[aidcp-cloud] automation 内部 API：risk-read 路由未注册（RiskControllerRegistry 不可用）');
  }
  registerPanelAutomationRoutes(httpServer, new PgPanelAutomationRead({ pool: ctx.automationPool }));
  registerPanelConfigRoutes(httpServer, {
    quota: createQuotaConfigPanel({ store: ctx.quotaConfigStore }),
    pacing: createPacingConfigPanel({ store: ctx.pacingConfigStore }),
    session: createSessionLimitPanel({ store: ctx.sessionConfigStore }),
    resume: createResumeConfigPanel({ store: ctx.resumeConfigStore }),
  });
  const facebookGroupOps: FacebookGroupOpsPort = {
    listTargets: (options) => ctx.facebookGroupTargetStore.listTargets(options),
    listFacets: () => ctx.facebookGroupTargetStore.listFacets(),
    setEnabled: (groupUrl, enabled) => ctx.facebookGroupTargetStore.setEnabled(groupUrl, enabled),
    accountProgress: () => ctx.facebookGroupTargetStore.accountProgress(),
    listAssignments: (limit) => ctx.facebookGroupMembershipStore.listAssignments(limit),
    reclaimStaleAssignments: (ttlMs) =>
      ctx.facebookGroupMembershipStore.reclaimStaleAssignments(ttlMs),
    scopedTargetCountForAccount: (accountId) =>
      ctx.facebookGroupTargetStore.scopedTargetCountForAccount(accountId),
    scopedTargetCountsForAccounts: (accountIds) =>
      ctx.facebookGroupTargetStore.scopedTargetCountsForAccounts(accountIds),
    latestScheduledResult: (accountId) =>
      ctx.facebookGroupJoinAuditStore.latestScheduledResult(accountId),
    latestScheduledResults: (accountIds) =>
      ctx.facebookGroupJoinAuditStore.latestScheduledResults(accountIds),
  };
  registerFacebookGroupOpsRoutes(httpServer, facebookGroupOps);
  if (ctx.groupRouteStore) registerGroupRouteRoutes(httpServer, ctx.groupRouteStore);
  else console.warn('[aidcp-cloud] automation 内部 API：群路由未注册（GroupRouteStore 不可用）');
  if (ctx.alertStore) registerAlertResolutionRoutes(httpServer, ctx.alertStore);
  else console.warn('[aidcp-cloud] automation 内部 API：告警勾销未注册（PgAlertStore 不可用）');
  // 参照稿触发去重读（change cloud-batch2-content-main）：委托任务台账是本域属主表，
  // content 侧精选库经这条 route 取。缺则如实告警、不注册。
  if (ctx.triggeredPublishRefs) registerTriggeredPublishRefsRoutes(httpServer, ctx.triggeredPublishRefs);
  else console.warn('[aidcp-cloud] automation 内部 API：参照稿触发去重读路由未注册（委托任务存储不可用）');
  const commandService = ctx.riskCommandService;
  if (commandService && ctx.deploymentTarget) {
    registerRiskCommandRoutes(httpServer, commandService, {
      executionTarget: ctx.deploymentTarget,
    });
  }
  else console.warn('[aidcp-cloud] risk-command 端点未注册：AIDCP_DEPLOY_ENV 缺失/非法，命令无人应用故不受理');
  if (ctx.publishDispatchTrigger) {
    registerPublishDispatchTriggerRoutes(
      httpServer,
      ctx.publishDispatchTrigger,
      requirePublishApprovalInternalToken(),
    );
  } else {
    console.warn('[aidcp-cloud] publish-dispatch trigger 端点未注册：dispatcher 或 approval authority 不可用');
  }
  const actual = await httpServer.listen(port);
  console.log(
    `[aidcp-cloud] automation 内部 API 已监听 127.0.0.1:${actual}` +
      `（panel-automation + panel-config + facebook-group-ops` +
      `${ctx.groupRouteStore ? ' + group-route' : ''}` +
      `${ctx.alertStore ? ' + alert-resolution' : ''}` +
      `${registry ? ' + risk-read' : ''}` +
      `${commandService ? ' + risk-command' : ''} 端点）`,
  );
}

/**
 * content 进程独占的内部 HTTP 读 API：把 segB 构造的本地 CuratedContentStore 的只读方法
 * 暴露为内部 HTTP route，供 core 进程经数据网关（gateway=http）远程取数。
 * 仅 content 模式调用；monolith 永不起（进程内本地实例直连）。
 * 每项 capability 独立注册；CuratedContentStore 缺失时只关闭精选库路由，
 * 不得连带关闭 persona command 或 publish status/generation。
 */
async function startContentReadApi(ctx: CompositionContext): Promise<void> {
  const store = ctx.curatedContentStore;
  const port = readEnvPort('AIDCP_CONTENT_PORT') ?? DEFAULT_CONTENT_READ_API_PORT;
  const httpServer = new InternalHttpServer();
  const capabilities: string[] = [];
  if (ctx.contentPersonaGeneratorAuthority) {
    if (!ctx.deploymentTarget) {
      throw new Error('AIDCP_DEPLOY_ENV is required for content command routes');
    }
    registerPersonaGeneratorCommandRoutes(
      httpServer,
      ctx.contentPersonaGeneratorAuthority,
      requireDirectInternalToken('AIDCP_CONTENT_INTERNAL_TOKEN'),
      ctx.deploymentTarget,
    );
    capabilities.push('persona-generator');
  } else {
    console.warn('[aidcp-cloud] content 内部 API：PersonaGenerator route 未注册（owner capability 不可用）');
  }
  if (store) {
    registerCuratedContentRoutes(httpServer, store);
    capabilities.push('curated-content');
  } else {
    console.warn(
      '[aidcp-cloud] content 内部 API：curated-content 路由未注册（CuratedContentStore 不可用）',
    );
  }
  // Block② 2e：把发布队列状态读 + 发布生成触发 additive 暴露到 content 侧内部读 API。
  // 生成 / 状态两条路由都由 content 自己的 publishOrchestrator 承载；缺则 warn 不注册（绝不静默假成功）。
  const contentPublishOrchestrator = ctx.publishOrchestrator;
  if (contentPublishOrchestrator) {
    registerPublishStatusRoutes(httpServer, {
      getStatus: () => Promise.resolve(contentPublishOrchestrator.getStatus()),
    });
    registerPublishGenerationRoutes(httpServer, contentPublishOrchestrator);
    capabilities.push('publish-status', 'publish-generation');
  } else {
    console.warn(
      '[aidcp-cloud] content 内部读 API：publish-status / publish-generation 路由未注册（PublishOrchestrator 不可用）',
    );
  }
  const actual = await httpServer.listen(port);
  console.log(
    `[aidcp-cloud] content 内部 API 已监听 127.0.0.1:${actual}` +
      `（${capabilities.length > 0 ? capabilities.join(' + ') : 'no capabilities'}）`,
  );
}

/**
 * outbox 通知唤醒接线（change outbox-listen-and-topic-cursor）。
 *
 * `emitOutboxEvent` 一直在发 `pg_notify`，但**接收端从来没接**——`wake()` 生产零调用者，投递延迟恒等于
 * 一个完整轮询周期。这里补上接收端：一条**专用长连接** `LISTEN event_outbox`，收到通知就按载荷里的
 * topic 唤醒相关消费者，投递降到毫秒级。
 *
 * 三条纪律（细节见 src/transport/outbox-notify-listener.ts 文件头）：
 *   ① 专用 `pg.Client`，不占共享池、不会被池回收；
 *   ② 断开有界退避重连（1s 起、30s 封顶、带抖动），永不放弃、连续失败抬成 error；
 *   ③ **绝不因为接了通知就放宽轮询周期**——承重通道仍是 `OutboxConsumer` 的有界轮询，
 *      本函数一行都没碰 `pollIntervalMs`。通道整个挂掉也只是退回轮询，绝不丢事件。
 *
 * 连接配置取 **automation 属主**：`event_outbox` / `event_outbox_cursor` / `event_outbox_topic_cursor`
 * 三张表都归 automation（boundaries/table-ownership.json），唤醒通道随表走。
 */
async function wireOutboxNotifyWakeups(
  label: string,
  consumers: (OutboxHealthSource & { wake(topic?: string): void })[],
): Promise<void> {
  if (consumers.length === 0) return;
  const listener = await startOutboxNotifyListener({
    // 每次重连都要一个全新 Client（pg.Client 断开后不可复用）。
    // connectionTimeoutMillis 是硬需求：没有它，库不可达时 connect() 可能永久挂起，
    // 而本函数是被 await 的 —— 一个连不上的加速器会把整个组合根卡在启动期。
    // keepAlive：这是一条长期空闲的长连接，靠 TCP keepalive 让中间设备别把它悄悄掐掉。
    createClient: () =>
      new pg.Client({
        ...resolveOwnerPgConfig('automation'),
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
      }) as unknown as NotifyClientLike,
    channel: EVENT_OUTBOX_NOTIFY_CHANNEL,
    // topic 由 wake() 侧过滤：与本消费者无关的主题（如 panel.event firehose 之于风控命令消费者）直接丢弃，
    // 免得一条高频主题把所有消费者都吵醒、把空闲期的查询频率抬到总线事件频率。
    onNotify: (topic) => {
      for (const consumer of consumers) consumer.wake(topic);
    },
    logger: console,
  });
  if (!listener.health().connected) {
    // 不静默：加速器没接上就明说，别让日志看起来像「已接线」。
    console.warn(
      `[aidcp-cloud] outbox 通知通道未就绪（${label}）：${listener.health().lastError ?? '未知原因'}` +
        ' —— 已排重连；投递退回有界轮询，不丢事件',
    );
  }
  startOutboxHealthLog({ consumers, listener, logger: console });
}

async function segAApiFoundation(ctx: CompositionContext): Promise<void> {
  const port = Number(process.env.AIDCP_PORT ?? 8787);
  const deploymentTarget = parseDeploymentTarget(readEnvString('AIDCP_DEPLOY_ENV'));
  const serviceMode = serviceModeFromEnv();

  // schema 契约门（change cloud-schema-migration-executor 任务 6.3）：读迁移账本最高版本，与本构建
  // 声明的所需 / 已知版本按复合序比较。库比代码新（回滚场景）时旧代码会静默重建空表并开始写入 ——
  // 这一门把它变成一次显式的启动失败。
  // MUST 跑在任何存储 init() 之前；MUST NOT 包 try/catch（吞掉它等于恢复静默假成功）。
  // 默认 warn 模式：判定照做、结论照打，不拒绝启动；切 enforce 后不通过即在此处抛错退出。
  //
  // Block④ 三仓提取 · 批次 0：判定范围＝**本进程要连哪些属主库**（pgOwnersForProcess），
  // 不是「跑的是哪个服务模式」。今天基础段无条件建三个池 ⇒ 恒为全部三个，与改动前逐字节一致。
  // 判据放在 pgOwnersForProcess 一处，建池与本门共用；下面还有一条启动期断言把两者钉死，
  // 防止将来收窄了池却漏改门（那会让门去校验一个本进程根本没连的库，或反过来漏校验真在用的库）。
  await runSchemaContractGate({ owners: pgOwnersForProcess() });

  // ── 跨进程配置镜像失效通道（change config-mirror-cross-process-invalidation）────────────
  // dev 与 ol 是两个 cloud 进程共用同一个 PostgreSQL 库，其中 8 张是无 execution_target 列的全局配置表。
  // 在 dev 控制台改一个全局安全限额，ol 进程的镜像原本要到重启才可见，中间零日志、零告警、后台还回显
  // 写入成功。这条通道把「写方 +1 版本 / 读方有界轮询比对 → 只重载变化的 key」做成机械保证。
  //
  // **配置层唯一连接池**（task 3.4：刷新器 MUST 复用组合根已有的 Pool、MUST NOT 另开连接池）。
  // 组合根此前没有任何共享池——每个 store 各自 new 一个。这里先建一个，再把它交给全部 15 处镜像所在的
  // 配置 store 与版本表：镜像子系统因此**没有**新增任何连接池，配置层的池数反而从 12 收敛到 1。
  // Block③ L2（物理拆库前置）：按属主的三连接池（content / automation / api）。今天三个 owner 都未配
  // AIDCP_PG_<OWNER>_URL，resolveOwnerPgConfig 逐字回落到共享单库配置（DATABASE_URL 未设 → PGHOST/DEFAULT），
  // 三池与既有 resolveEnvPgConfig() 逐字节一致 = 同一物理库、三个别名；拆库时逐个把 owner URL 指向新库即切换。
  // ⚠️ 字节等价前提：部署 .env 的 DATABASE_URL 未设（dev+ol 均已核实未设）。若设了 DATABASE_URL，今天忽略它的
  //    HOST-param store 会随 owner 池开始认 DATABASE_URL（resolveOwnerPgConfig 的共享回落优先 DATABASE_URL）。
  const apiPool = new pg.Pool({ ...resolveOwnerPgConfig('api'), max: 30 });
  const automationPool = new pg.Pool({ ...resolveOwnerPgConfig('automation'), max: 30 });
  const contentPool = new pg.Pool({ ...resolveOwnerPgConfig('content'), max: 30 });
  // Block④ 批次 0：把「建了哪些属主池」与「schema 契约门校验了哪些属主」钉成同一件事。
  // 上面三行今天无条件建三个池（零模式门控），所以 pgOwnersForProcess() 也必须是全部三个。
  // 批次 0d 按消费方收窄池时，改 pgOwnersForProcess 一处即可，本断言会当场抓出漏改的一侧。
  assertOwnerPoolsMatchProcessOwners({ api: apiPool, automation: automationPool, content: contentPool });
  // config_mirror_version 属 api；configMirrorPool 即 api 池（保持既有变量名，全部现有 `pool: configMirrorPool` 引用零改）。
  // ✅ L3 blocker 已解（change block3-l3-config-mirror-bump-decouple）：quota/pacing/session/resume 四个
  //    automation 配置 store 不再在自己的写事务里同连接 bump 本 api 表，改为「本域 outbox 行同事务入队 →
  //    进程内中继 → api 库内 inbox 去重 + 推版本」，故它们已改钉 automation 池（见下方四处构造）。
  const configMirrorPool = apiPool;
  // TokenUsageStore 属 content，但用专用小池（热路径隔离 max:4），单独构造、不共享 content 主池。
  const tokenUsagePool = new pg.Pool({ ...resolveOwnerPgConfig('content'), max: 4 });
  const mirrorVersionStore = new MirrorVersionStore({ pool: configMirrorPool });

  // ── 跨域配置镜像失效信号（change block3-l3-config-mirror-bump-decouple）────────────────────
  // 落地端（api 库内「inbox 去重 + 推版本」一笔事务）。
  //   - monolith / core / content / api：本进程持有 api 池 ⇒ 本地实现，零 HTTP、逐字节等价。
  //   - automation：本进程**不该**持有 api 库的连接。配了 AIDCP_API_URL 就走内部 HTTP 推给 api 进程；
  //     没配则注入不可用实现——它一律抛错、绝不假装成功，中继因此保留 outbox 行与游标，
  //     信号原地堆着等通道恢复（红线：绝不静默丢投）。
  const configMirrorBumpSink: ConfigMirrorBumpSink =
    serviceModeFromEnv() === 'automation'
      ? (() => {
          const apiUrl = readEnvString('AIDCP_API_URL');
          if (!apiUrl) {
            console.warn(
              '[config-mirror] automation 模式未配 AIDCP_API_URL ⇒ 失效信号无处投递：' +
                'outbox 会持续堆积并每轮告警（绝不静默丢弃），配好该 env 后自动补投',
            );
            return new UnavailableConfigMirrorBumpSink('automation 模式未配 AIDCP_API_URL');
          }
          return new ConfigMirrorBumpHttpClient(new InternalHttpClient(apiUrl));
        })()
      : new PgConfigMirrorBumpSink({ pool: apiPool, versionStore: mirrorVersionStore });
  // 生产方进程内中继 + 事务型入队器。
  // execution_target 缺失/非法 ⇒ **不启动本通道**（CLAUDE.md §2：target 不合法即不起该 worker）：
  // 四个 store 退回「无 bumper」形态 —— 写库照常、不开事务、不入队，与本通道引入之前逐字一致。
  // 这条降级是**吵闹**的（下面 warn），MUST NOT 被理解为「静默继续」：它意味着跨进程失效对这四项失效。
  let configMirrorBumpRelay: ConfigMirrorBumpRelay | undefined;
  let configMirrorOutboxBumper: OutboxMirrorVersionBumper | undefined;
  if (deploymentTarget) {
    configMirrorBumpRelay = new ConfigMirrorBumpRelay({
      pool: automationPool,
      sink: configMirrorBumpSink,
      executionTarget: deploymentTarget,
    });
    // 只允许属 automation 的 mirrorKey 走本通道（闭集合由属主表算出，
    // 把「api 属主的配置绕道 automation 的 outbox」这种反向错接线在第一次写入时就打出来）。
    const automationOwnedMirrorKeys = new Set<string>(
      CONFIG_MIRROR_KEYS.filter((key) => CONFIG_MIRRORS[key].owner === 'automation'),
    );
    const relay = configMirrorBumpRelay;
    configMirrorOutboxBumper = new OutboxMirrorVersionBumper({
      allowedMirrorKeys: automationOwnedMirrorKeys,
      executionTarget: deploymentTarget,
      onCommitted: () => relay.wake(),
    });
  } else {
    console.warn(
      '[config-mirror] AIDCP_DEPLOY_ENV 缺失/非法 ⇒ 四类限频配置的跨进程失效通道不启动：' +
        '改配置只对本进程生效，别的进程要到重启才可见（绝不假装已投递）',
    );
  }

  // 模型配置 + 加密凭据（change console-model-provider-config）。
  // 先于 LLM 客户端构造：模型名经 getCached() 运行时解析（热加载）；DashScope 密钥库内优先、回退 env。
  const modelConfigStore = new ModelConfigStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: configMirrorPool,
    mirrorVersionBumper: mirrorVersionStore,
  });
  const credentialStore = new CredentialStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: apiPool,
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 角色级模型/温度覆盖（change console-role-model-config）。缺/空/无效一律回落全局，绝不 brick。
  const roleConfigStore = new RoleConfigStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: configMirrorPool,
    mirrorVersionBumper: mirrorVersionStore,
  });
  // 分类级模型默认（change role-model-category-config，item 5/6）。缺/空/异常一律返「无覆盖」，绝不 brick。
  const categoryConfigStore = new CategoryConfigStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: configMirrorPool,
    mirrorVersionBumper: mirrorVersionStore,
  });
  // 安全限额（change safety-quota-config，stream D）。缺行/非法值一律回落 deriveWindowQuotas 写死默认，绝不 brick。
  const quotaConfigStore = new QuotaConfigStore({
    pool: automationPool,
    mirrorVersionBumper: configMirrorOutboxBumper,
  });
  // 操作兜底 floor（change pacing-floor-config-min-interval）：四类操作最小间隔兜底区间、全局一套；
  // 缺行/非法值一律回落 BUILTIN_FLOOR 内置默认并在读出口 clamp，绝不 brick、绝不零延迟。
  const pacingConfigStore = new PacingConfigStore({
    pool: automationPool,
    mirrorVersionBumper: configMirrorOutboxBumper,
  });
  // 单场会话上限（全局单例，change restore-auto-resume-and-global-safety-config）：全局单场时长 + 互动预算、对所有账号生效；缺行/非法回落写死默认，绝不 brick。
  const sessionConfigStore = new SessionConfigStore({
    pool: automationPool,
    mirrorVersionBumper: configMirrorOutboxBumper,
  });
  // 引流线索热度过滤阈值（全局单例，change feed-hot-lead-group-comment）：帖龄上限 / 速率阈值 / 最小赞，落安全页卡片、热加载。
  const hotLeadConfigStore = new HotLeadConfigStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: configMirrorPool,
    mirrorVersionBumper: mirrorVersionStore,
  });
  // 自动续场护栏 + 看门狗阈值（全局单例，change restore-auto-resume-and-global-safety-config）：全局 rest_ratio / 活跃时段 /
  // 每日上限 / 看门狗两阈值、对所有账号生效；缺行/非法回落写死默认，绝不 brick。init 失败也不致命（空镜像→全回落默认）。
  const resumeConfigStore = new ResumeConfigStore({
    pool: automationPool,
    mirrorVersionBumper: configMirrorOutboxBumper,
  });
  // 内容排期（change content-schedule-auto-publish）：全局「内容可自动时段」+ 每账号发帖排期。
  // fail-closed：未配 / 非法 = 不自动（与浏览掩码「缺失=全天活跃」刻意相反）；init 失败不致命（空镜像 = 全不自动）。
  const contentScheduleStore = new ContentScheduleStore({ schemaEnsurer: ensureCapabilitySchema,
    scheduledAutomationCatalog: SCHEDULED_AUTOMATION_CATALOG_READER,
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    pool: configMirrorPool,
    mirrorVersionBumper: mirrorVersionStore,
    // 只读组合：账号活跃覆盖优先，未配回落 session_config_global 热镜像；本 store 不写全局表。
    // 归属对齐后这是 api 侧目录投影取生效掩码的**唯一**通道（task 5.3）：MUST NOT 在 api 侧另建副本。
    globalActiveWeekMask: () => sessionConfigStore.weekActiveMask(),
  });
  const facebookGroupJoinAutomationStore = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: configMirrorPool,
    mirrorVersionBumper: mirrorVersionStore,
  });
  // 每账号 Facebook 定时评论配置（change facebook-scheduled-comment 2.1）：关键词列表 + 容器列表。
  // fail-closed：任一为空 = 不生效（诚实 no-op）；init 失败不致命（空镜像 = 全不生效）。
  const facebookCommentConfigStore = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: configMirrorPool,
    mirrorVersionBumper: mirrorVersionStore,
  });
  // Facebook 定时评论每次触发的审计行（facebook-scheduled-comment 2.7）：best-effort、不阻塞主链路。
  const facebookCommentAuditStore = new FacebookCommentAuditStore({
    pool: automationPool,
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // automation 域对 api 属主 accounts 的守卫投影（change automation-accounts-projection）。
  // 真正构造押到下面 accountStore 就绪那一段（花名册来源要靠它），这里先声明——两个 Facebook 群存储
  // 与委托任务存储在下面就要按引用取它。
  let accountProjectionStore: PgAccountProjectionStore | undefined;
  // Facebook group join: operator target catalog, one-group-one-account assignment ledger,
  // and best-effort join audit. Join loop is default-off and shadow-first.
  const facebookGroupTargetStore = new FacebookGroupTargetStore({
    pool: automationPool,
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  const facebookGroupMembershipStore = new FacebookGroupMembershipStore({
    pool: automationPool,
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  const facebookGroupJoinAuditStore = new FacebookGroupJoinAuditStore({
    pool: automationPool,
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 对外客户身份 + 客户↔环境归属（change edge-client-customer-auth）。独立表,与内部运营登录物理隔离。
  // Block③ L3：本 store 自己的读写走 api 属主池；automation 属主表（离场记录 / 微信互动授权绑定 /
  // 风控态）的**顶层只读**改经端口取投影，本 store 不直连 automation 的库、也不知其表结构。
  //   - monolith / core / automation / content：跑在本进程 automation 池上的本地实现，逐字节等价、零 HTTP。
  //   - api：segC 未跑 ⇒ 本进程不该持有 automation 属主表的连接；HTTP 客户端待 Block② 补，暂 fail-closed
  //     （各方法 reject 具名错误），镜像 segD 的 panelAutomationRead / publishStatusLocal 先例；
  //     api 模式当前未部署，此路不改现网行为。
  // Block③ L3 最终一致改造已收尾：环境注销关键路径上那 7 处「事务内跨库读 / 跨库行锁」与 5 处跨库
  // 联合提交全部消除——准入事实收进 api 自己的库（client_env_revocation_holds 升格为清理准入表），
  // 执行台账交给属主自开事务落（下面的 offboardMaterialization 端口）。详见 client-user-store 文件头。
  const clientEnvAutomationRead: ClientEnvAutomationReader =
    serviceModeFromEnv() === 'api'
      ? {
          offboardForUser: () => Promise.reject(new Error('client_env_automation_read_unavailable_in_api_mode')),
          activeWechatOffboards: () => Promise.reject(new Error('client_env_automation_read_unavailable_in_api_mode')),
          wechatBoundEnvKeys: () => Promise.reject(new Error('client_env_automation_read_unavailable_in_api_mode')),
          wechatEnvKeysForAccount: () => Promise.reject(new Error('client_env_automation_read_unavailable_in_api_mode')),
          boundAccountForEnv: () => Promise.reject(new Error('client_env_automation_read_unavailable_in_api_mode')),
          riskStateProjection: () => Promise.reject(new Error('client_env_automation_read_unavailable_in_api_mode')),
        }
      : new PgClientEnvAutomationRead({ pool: automationPool });
  // 离场清理授权的属主侧操作（Block③ L3）：签发 / 烧票两笔事务碰的表全是 automation 属主、
  // 与任何 api 写都不共事务 ⇒ 整体收回属主域，由它**自己开事务、跑 automation 池**，
  // 而不是接 api 侧递来的事务句柄。
  // api 模式同样 fail-closed（HTTP 客户端待 Block② 补），与上面的读端口同一范式。
  const offboardCleanupGrantOps: OffboardCleanupGrantOperations =
    serviceModeFromEnv() === 'api'
      ? {
          issueCleanupGrant: () => Promise.reject(new Error('offboard_cleanup_grant_ops_unavailable_in_api_mode')),
          consumeCleanupGrant: () => Promise.reject(new Error('offboard_cleanup_grant_ops_unavailable_in_api_mode')),
        }
      : new PgOffboardCleanupGrantOps({ pool: automationPool });
  // 离场**执行台账**的属主侧操作（Block③ L3 最终一致改造）：与上面两个端口同一范式——
  // 自开事务、跑 automation 池，绝不接 api 侧递来的事务句柄（那正是拆库后会崩 / 会写错库的形态）。
  const offboardMaterialization: OffboardMaterializationOperations =
    serviceModeFromEnv() === 'api'
      ? {
          materializeEnvironmentOffboard: () =>
            Promise.reject(new Error('offboard_materialization_unavailable_in_api_mode')),
        }
      : new PgOffboardMaterializationOps({ pool: automationPool });
  const clientUserStore = new ClientUserStore({
    pool: apiPool,
    schemaEnsurer: ensureCapabilitySchema,
    mirrorVersionBumper: mirrorVersionStore,
    offboardMaterialization,
    automationReads: clientEnvAutomationRead,
    cleanupGrantOps: offboardCleanupGrantOps,
    ...(deploymentTarget ? { executionTarget: deploymentTarget } : {}),
  });
  try {
    await mirrorVersionStore.init();
    await modelConfigStore.init();
    await credentialStore.init();
    await roleConfigStore.init();
    await categoryConfigStore.init();
    await quotaConfigStore.init();
    await pacingConfigStore.init();
    await sessionConfigStore.init();
    await hotLeadConfigStore.init();
    await resumeConfigStore.init();
    await contentScheduleStore.init();
    await facebookGroupJoinAutomationStore.init();
    await facebookCommentConfigStore.init();
    await facebookCommentAuditStore.init();
    await facebookGroupTargetStore.init();
    await facebookGroupMembershipStore.init();
    await facebookGroupJoinAuditStore.init();
    await clientUserStore.init();
    console.log('[aidcp-cloud] 模型配置 + 凭据 + 角色配置 + 分类默认 + 安全限额 + 单场上限 + 续场配置存储已就绪（model_config / provider_credentials / role_config / category_config / quota_config / session_config / resume_config）');
  } catch (err) {
    // change cloud-schema-migration-executor 任务 5.3：这一处过去用一句通用 warn 覆盖两种完全不同的原因。
    // 「连不上库」是瞬时故障，重试 / 修网络即可；「库里没有这张表 / 这一列」是 schema 落后于代码，
    // 处置是补跑迁移，重试一万次都不会好。合成一句话报出去，等于让运维每次都从零开始猜。
    if (isSchemaCapabilityError(err)) {
      console.error(
        `[aidcp-cloud] 配置层 schema 不满足要求（${err.code}）：能力 ${err.capability} 缺 `
        + `${err.missing.join(', ')}；来源迁移 ${err.sinceVersion}。`
        + '处置是补跑迁移（npm run migrate status / up），MUST NOT 靠重启或自建表绕过；'
        + '本次启动该能力 fail-closed 回退代码默认值。',
      );
    } else {
      console.warn(
        '[aidcp-cloud] 配置层存储初始化失败（数据库不可达或查询失败，非 schema 缺对象；'
        + '回退代码默认模型 + env 密钥；限额/续场回退派生写死默认）:',
        (err as Error).message,
      );
    }
  }
  // 起失效信号中继（change block3-l3-config-mirror-bump-decouple）。
  // 放在配置层 init 之后、且**在 try/catch 之外**：它读的是 outbox 行，与配置 store 是否 init 成功无关；
  // 上一段 init 失败时更需要它跑起来把积压的信号投出去。start() 幂等，消费循环自吞错并 warn、不抛。
  configMirrorBumpRelay?.start();

  // 启动期解密 DashScope 密钥（库内优先、回退 env）；明文仅用于构造图片客户端（万相），绝不日志化、绝不回前端。
  const dashscopeApiKey =
    (await credentialStore.getSecretForRuntime('dashscope', 'dashscope_api_key').catch(() => null)) ??
    readEnvString('DASHSCOPE_API_KEY');

  // OSS 对象存储上传出口（change cloud-oss-storage-integration）：照抄 DASHSCOPE「库内优先、回退 env」范式。
  // AccessKey/Secret 敏感 → 加密库(provider='oss')优先、env 回退；region/bucket 非敏感 → env（默认 oss-cn-beijing / aidcp）。
  // 凭据明文仅用于构造 OSS 客户端，绝不日志化、绝不回前端；凭据齐备才构造 uploader，缺则不注入（触发配图「零回归」路径）。
  const ossAccessKeyId =
    (await credentialStore.getSecretForRuntime('oss', 'access_key_id').catch(() => null)) ??
    readEnvString('OSS_ACCESS_KEY_ID');
  const ossAccessKeySecret =
    (await credentialStore.getSecretForRuntime('oss', 'access_key_secret').catch(() => null)) ??
    readEnvString('OSS_ACCESS_KEY_SECRET');
  const ossRegion = readEnvString('OSS_REGION') ?? 'oss-cn-beijing';
  const ossBucket = readEnvString('OSS_BUCKET') ?? 'aidcp';
  const ossInternal = readEnvString('OSS_INTERNAL') === 'true';
  let ossUploader: ObjectStore | undefined;
  if (ossAccessKeyId && ossAccessKeySecret) {
    try {
      // 动态载入：仅在配了 OSS 凭据时才把 ali-oss 依赖树拉进进程（未配置时零加载、零回归）。
      const { createOssObjectStore } = await import('./storage/oss-client-factory.js');
      ossUploader = createOssObjectStore({
        accessKeyId: ossAccessKeyId,
        accessKeySecret: ossAccessKeySecret,
        bucket: ossBucket,
        region: ossRegion,
        internal: ossInternal,
      });
      console.log(`[aidcp-cloud] OSS 对象存储已就绪（bucket=${ossBucket} region=${ossRegion} internal=${ossInternal}）：配图将转存到稳定公网链接`);
    } catch (err) {
      console.warn('[aidcp-cloud] OSS 客户端构造失败（配图回退 provider 临时 URL、零回归）:', (err as Error).message);
    }
  } else {
    console.log('[aidcp-cloud] 未配置 OSS 凭据（oss/access_key_id[_secret] 或 env OSS_ACCESS_KEY_ID[_SECRET]），配图沿用 provider 临时 URL');
  }

  // provider 运行时映射（change model-config-volcengine-provider）：每文本厂商 key 启动期一次性解密载入
  //（库内优先、回退 env），baseUrl 取注册表默认或 env 覆盖。明文仅用于构造文本出口，绝不日志化、绝不回前端。
  // 与现状一致：模型名热加载、密钥变更重启生效。dashscope 项 == 现有 key+baseUrl 以保零回归。
  const providerRuntime: Record<string, { baseUrl: string; apiKey: string }> = {};
  for (const id of Object.keys(TEXT_PROVIDERS) as TextProviderId[]) {
    const meta = TEXT_PROVIDERS[id];
    const dbKey = await credentialStore.getSecretForRuntime(id, meta.credentialField).catch(() => null);
    providerRuntime[id] = {
      baseUrl: resolveProviderBaseUrl(id),
      apiKey: dbKey ?? resolveProviderEnvKey(id) ?? '',
    };
  }

  // 按角色解析「生效厂商 + 模型」（change model-config-volcengine-provider）：四层回落，provider 跟胜出层的 model 同行。
  //   per-role 覆盖 → 分类默认 → 全局（textProvider/textModel）→ 代码默认（store 缺省）。
  // 某层 model 非空才贡献 provider；provider 缺/未知由 normProvider 归一 dashscope，绝不跨层混搭、绝不 brick。
  // role 缺省（planner/select/探活）→ 直接走全局，零回归。账号维度（item 9）：分类读路径恒 account_id IS NULL，本期不接 accountId。
  const resolveSelection = (role?: string): { provider: TextProviderId; model: string } => {
    if (role) {
      const ro = roleConfigStore.getForRole(role);
      if (ro.model?.trim()) return { provider: normProvider(ro.provider), model: ro.model.trim() }; // 2. per-role
      const catId = categoryOf(role);
      if (catId) {
        const cat = categoryConfigStore.getForCategory(catId);
        if (cat.model?.trim()) return { provider: normProvider(cat.provider), model: cat.model.trim() }; // 3. 分类默认
      }
    }
    const g = modelConfigStore.getCached(); // 4. 全局默认（store 缺省回 5. 代码默认）
    return { provider: normProvider(g.textProvider), model: g.textModel };
  };
  const resolveModelForRole = (role?: string): string => resolveSelection(role).model;
  const resolveProviderForRole = (role?: string): string => resolveSelection(role).provider;
  // 温度本期不引入分类层（温度只对少数生成/改写角色开放，按角色配已足够，YAGNI）。保持两层、与 provider 无关。
  const resolveTempForRole = (role?: string): number | undefined => {
    const t = role ? roleConfigStore.getForRole(role).temperature : null;
    return t ?? undefined;
  };
  // 思考模式解析（change role-thinking-mode-config）：role → 分类 → undefined(=default 不干预)。
  // 与模型/温度相互独立；两层回落、无全局层（全局隐含 default）。取自共享内存镜像、热加载。
  // 返回 undefined 时出口不发任何 thinking 字段（请求体零回归）。可行性守卫（Qwen+on）在出口按当时模型判定。
  const resolveThinkingForRole = (role?: string): ThinkingMode | undefined => {
    if (!role) return undefined;
    const ro = roleConfigStore.getForRole(role).thinkingMode;
    if (ro) return ro;
    const catId = categoryOf(role);
    if (catId) {
      const cat = categoryConfigStore.getForCategory(catId).thinkingMode;
      if (cat) return cat;
    }
    return undefined;
  };
  // ── 角色模型解析 / 厂商密钥的跨属主口（change cloud-batch2-content-main）────────────────
  // 上面那四个 resolve* 读的三张配置表（角色覆盖 / 分类默认 / 全局）全是 **api 属主**，
  // 分类归属还来自 api 侧的角色目录。内容域的文本出口每次调用都要它们，且调用是**同步**的。
  //
  // 所以属主侧**把答案算好再送**，而不是把三张表送过去：送表等于要求调用方也持有那份目录、
  // 复刻四层回落 —— 正是「两侧各写一份、各自编译通过、只有真跑才发现不一致」的形态。
  // 单体下这个 reader 就地解析，与那四个 resolve* 同源逐字等价；拆进程后 content 换成本地镜像查表。
  const roleModelSelection: RoleModelSelectionReader = {
    forRole: (role) => {
      const sel = resolveSelection(role);
      const temperature = resolveTempForRole(role);
      const thinkingMode = resolveThinkingForRole(role);
      return {
        provider: sel.provider,
        model: sel.model,
        ...(temperature === undefined ? {} : { temperature }),
        ...(thinkingMode === undefined ? {} : { thinkingMode }),
      };
    },
  };
  // 取源：把**全部已登记角色**逐个预解析成快照。未登记角色查不到 → 调用方用 fallback（即全局那一层），
  // 与单体下逐字一致（那种角色本来就穿过前两层落到全局）。
  const roleModelSelectionSource: RoleModelSelectionSource = {
    fetchRoleModelSelections: async () => ({
      fallback: roleModelSelection.forRole(),
      byRole: Object.fromEntries(ROLE_CATALOG.map((r) => [r.roleId, roleModelSelection.forRole(r.roleId)])),
    }),
  };
  // 厂商密钥：只在启动期被调几次、不在热路径 ⇒ 普通异步跨进程读即可，不需要镜像。
  const providerSecretReader: ProviderSecretReader = {
    getSecretForRuntime: (provider, field) => credentialStore.getSecretForRuntime(provider, field),
  };

  // token 用量记账（change llm-token-usage-stats）：出口 onCall 钩子只做纯内存累加，
  // 定时 flush 到 llm_token_usage 预聚合表（专用池隔离热路径）。须早于接受 LLM 调用/探活建好。
  const tokenUsageStore = new TokenUsageStore({ pool: tokenUsagePool, schemaEnsurer: ensureCapabilitySchema });
  try {
    await tokenUsageStore.init();
    console.log('[aidcp-cloud] token 用量记账已就绪（llm_token_usage，按账号/角色/模型/10分钟桶预聚合）');
  } catch (err) {
    console.warn('[aidcp-cloud] token 用量记账初始化失败（用量将不落库，绝不影响 LLM 调用）:', (err as Error).message);
  }

  const flushTokenUsageOnExit = (sig: string): void => {
    console.log(`[aidcp-cloud] 收到 ${sig}，flush token 用量后退出`);
    // 批次 0b 有意保留裸 `?.`：这是**停一个本进程没起过的东西**。自动化段没跑 ⇒ 对账器根本不存在 ⇒
    // 「没停」不是被丢弃的动作、也没有任何后果需要别人承接。这里记 error 只会在每次 api / content
    // 进程正常退出时喊一次狼，反而稀释掉真正的 cross_segment_drop。
    ctx.scheduledPublishReconciler?.stop();
    void Promise.race([
      tokenUsageStore.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]).finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => flushTokenUsageOnExit('SIGTERM'));
  process.once('SIGINT', () => flushTokenUsageOnExit('SIGINT'));

  const llm = new QwenClient({
    apiKey: dashscopeApiKey, // 构造默认（仅未注入 providerRuntime 的旧路径用；生产恒走 providerRuntime）
    // 单次模型调用天花板（change raise-model-call-timeouts-for-thinking-models）：默认 180s 容纳 thinking 模型，
    // env AIDCP_LLM_TIMEOUT_MS 可调；非法/缺省回落 180_000（正数下限保护，绝不 brick）。
    timeoutMs: normalizeTimeoutMs(process.env.AIDCP_LLM_TIMEOUT_MS, 180_000),
    getModel: resolveModelForRole,
    getTemperature: resolveTempForRole,
    // change model-config-volcengine-provider：按角色解析出的 provider 从 providerRuntime 取 baseUrl+key。
    getProvider: resolveProviderForRole,
    // change role-thinking-mode-config：按角色解析思考三态（role→分类→default）；default 出口不发 thinking 字段（零回归）。
    getThinking: resolveThinkingForRole,
    providerRuntime,
    // 开始行证明已越过本地同步准备；只含路由/时限元数据，绝不含 prompt、响应正文或密钥。
    onStart: (info) => {
      console.log(
        `[llm.start] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} timeoutMs=${info.timeoutMs}`,
      );
    },
    // 保留原 console.log（加 provider + tokens 维度）；记账 add() 受 try/catch 双保险，绝不抛进/拖垮 LLM 调用路径。
    // 用量上报接线点①（文本 LLM 出口）：经 TokenUsageStore 单一接口写归 aidcp-content 的 llm_token_usage，MUST NOT 直写（方案 §4.6.6）。
    onCall: (info) => {
      console.log(
        `[llm] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} ms=${info.ms} ok=${info.ok} tokens=${info.totalTokens ?? 0} stage=${info.stage} timedOut=${info.timedOut} requestId=${info.requestId ?? '-'}`,
      );
      try {
        tokenUsageStore.add(info);
      } catch {
        /* metrics never breaks llm */
      }
    },
  });
  const planner = new SimplePlanner({ llm });
  const cache = new PgAnchorCache({
    pool: automationPool,
    connectionString: readEnvString('DATABASE_URL'),
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });

  // 探测 schema（不再建表，change cloud-schema-migration-executor 第 5 节）；
  // PG 不可用时打印告警但不阻塞启动协议处理。缺对象与连不上库分别报出，MUST NOT 混成一句通用 warn。
  try {
    await cache.init();
    console.log('[aidcp-cloud] PG 锚点缓存已就绪');
  } catch (err) {
    if (isSchemaCapabilityError(err)) {
      console.error(
        `[aidcp-cloud] 锚点缓存 schema 不满足要求（${err.code}）：缺 ${err.missing.join(', ')}；`
        + `来源迁移 ${err.sinceVersion}。处置是补跑迁移，本次启动锚点缓存 fail-closed。`,
      );
    } else {
      console.warn('[aidcp-cloud] PG 连接/查询失败（非 schema 缺对象；缓存相关消息将报错）:', (err as Error).message);
    }
  }

  // 发布日志存储（publish_log 表）
  const publishLogStore = new PublishLogStore({
    schemaEnsurer: ensureCapabilitySchema,
    schemaProber: probeSchemaShape,
    pool: apiPool,
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // change cloud-batch2-content-main：init 从**内容段**上移到属主段。
  // 它只探测自己的 schema、不建表，而 `publish_log` 是本域（api）的表——
  // 让内容域去初始化别人的表本就没有立场，拆进程后更是连库都够不着。
  // 单体等价：内容段紧跟基础段跑，同一进程同一次调用，只是提前了几行。
  try {
    await publishLogStore.init();
    console.log('[aidcp-cloud] PublishLogStore 已就绪');
  } catch (err) {
    console.warn('[aidcp-cloud] PublishLogStore 初始化失败:', (err as Error).message);
  }

  // 发布角色执行日志（publish_pipeline_logs 表，change publish-pipeline-observability）。
  // change cloud-batch2-content-main：构造从**内容段**上移到属主段。这张表属 api，
  // 而它原先就在内容段里绑 apiPool 建 —— §4.1 登记的「属主反转」之一，正是拆仓要消的形态。
  // 表由 migration 0004 已建、无需 init；写入 best-effort、不阻塞发布，注入给 PublishOrchestrator。
  const publishPipelineLogStore = new PublishPipelineLogStore({
    pool: apiPool,
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });

  // ── 人审授权的持久权威（change publish-approval-signal-to-database）────────────────────────
  // 授权这一位过去躺在本机文件 /tmp/aidcp-publish-approve-<requestId>.json 上：写方（飞书/后台/客户端/
  // 委托/排期免审）与读方（发布下发器/评论审批闸）一分进程，文件系统即不再共享，读方永远读不到
  // approved===true——**fail-closed 的静默停滞**。现在授权只认这张表；文件只剩兼容窗口内的影子写。
  let publishApprovalStore: PublishApprovalStore | undefined;
  const approvalOwnerMode = serviceModeFromEnv();
  if (ownsPublishApprovalAuthorityForMode(approvalOwnerMode) && deploymentTarget) {
    try {
      const store = new PublishApprovalStore({
        executionTarget: deploymentTarget,
        pool: apiPool,
        host: readEnvString('PGHOST'),
        port: readEnvPort('PGPORT'),
        database: readEnvString('PGDATABASE'),
        user: readEnvString('PGUSER'),
        password: readEnvString('PGPASSWORD'),
      });
      await store.init();
      publishApprovalStore = store;
      console.log(`[aidcp-cloud] PublishApprovalStore 已就绪（executionTarget=${deploymentTarget}）`);
    } catch (err) {
      console.error('[aidcp-cloud] PublishApprovalStore 初始化失败，人审授权全链 fail-closed:', (err as Error).message);
    }
  } else if (!ownsPublishApprovalAuthorityForMode(approvalOwnerMode)) {
    console.log(`[aidcp-cloud] AIDCP_SERVICE=${approvalOwnerMode}：PublishApprovalStore 归 api，本进程不构造`);
  } else {
    console.error('[aidcp-cloud] PublishApprovalStore 未启用：AIDCP_DEPLOY_ENV 缺失或非法 → 授权写入一律失败（绝不落 target 未知的授权）');
  }
  // API-owner authority：本地形态与 HTTP server 共用同一 adapter；automation 只持其端口/client。
  const publishApprovalAuthority = publishApprovalStore
    ? createPublishApprovalAuthorityService(publishApprovalStore, deploymentTarget)
    : undefined;
  const publishApprovalClient = publishApprovalAuthority
    ? createPublishApprovalClient(publishApprovalAuthority, deploymentTarget)
    : undefined;
  // 兼容窗口影子写（默认开）：持久写成功之后 best-effort 写同路径同格式文件，失败只记日志。
  // 关闭它是**独立一步**（改 env 即可回滚），前置条件是盘点确认零读者 + dev/ol 各观察满一个发布周期。
  const legacyApprovalSignalEnabled = readEnvString('AIDCP_PUBLISH_APPROVAL_LEGACY_SIGNAL_FILE') !== 'false';
  /**
   * 发帖候选 → 目标环境键。五个审批入口手边都只有候选 / 账号，故 envKey 的解析收口在写出口一处
   * （change publish-approval-signal-to-database；首版全靠各入口自传，结果是 env_key 全表恒 NULL）。
   * 解析不出 MUST 留空，绝不猜一个环境写进审计记录。
   */
  const resolveApprovalEnvKey = async (subject: {
    subjectKind: 'publish' | 'comment';
    candidateRef: string;
  }): Promise<string | null> => {
    // 评论授权的 candidateRef 是 `<noteId>-<ts>`，与环境 / 账号无对应关系——留空即诚实。
    if (subject.subjectKind !== 'publish') return null;
    const recordId = Number(subject.candidateRef);
    if (!Number.isInteger(recordId) || recordId <= 0) return null;
    const draft = await publishLogStore.loadForDispatch(recordId);
    if (!draft?.accountId) return null;
    return clientUserStore.envKeyForAccount(draft.accountId);
  };
  const approvalWriteOutlet: ApprovalWriteOutlet | undefined = publishApprovalStore
    ? createApprovalWriteOutlet({
        store: publishApprovalStore,
        resolveEnvKey: resolveApprovalEnvKey,
        legacySignal: {
          enabled: legacyApprovalSignalEnabled,
          write: async (requestId, approved, payload, ts) => {
            await writeLegacyApprovalShadow(
              requestId,
              approved,
              payload,
              ts,
            );
          },
        },
      })
    : undefined;
  // segA 先于本地 relay（segC/segD）构造；用一位启动期 latch 合并早到 wake。
  // 决定/outbox 已同事务持久化，因此这只影响低延迟，不承担可靠性；独立进程由 API relay 自己初始扫一轮。
  let publishApprovalOutboxWakeImpl: (() => void) | undefined;
  let publishApprovalOutboxWakePending = false;
  ctx.wakePublishApprovalOutbox = () => {
    if (publishApprovalOutboxWakeImpl) publishApprovalOutboxWakeImpl();
    else publishApprovalOutboxWakePending = true;
  };
  ctx.installPublishApprovalOutboxWake = (wake) => {
    publishApprovalOutboxWakeImpl = wake;
    if (!publishApprovalOutboxWakePending) return;
    publishApprovalOutboxWakePending = false;
    wake();
  };
  /**
   * 一批稿件的授权下发进度（投影用，task 4.6）。未接线 / 读失败 → 空表，投影不带下发态字段、
   * 前端回落既有呈现。MUST NOT 因读不到就伪造一个「无阻塞」的下发态。
   */

  /**
   * 授权写出口的对外形状（沿用 `ApprovalWriteResult`）。未接线（PG 不可用 / target 缺失）时**诚实抛错**，
   * MUST NOT 退化成「只写文件」——那正是本 change 要消灭的第二事实源。
   */
  const writeApprovalDecision = async (
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
    context: ApprovalDecisionContext,
  ): Promise<{ written: boolean; alreadyDecided?: boolean; revision: number }> => {
    if (!approvalWriteOutlet) throw new Error('approval_outlet_unavailable');
    const outcome = await approvalWriteOutlet(requestId, approved, payload, context);
    if (approved && outcome.written) ctx.wakePublishApprovalOutbox();
    return outcome;
  };
  const publishApprovalDecisionWriter = approvalWriteOutlet
    ? createPublishApprovalDecisionWriter(writeApprovalDecision, deploymentTarget)
    : undefined;

  let draftRefinementStore: DraftRefinementStore | undefined;
  if (deploymentTarget) {
    try {
      const store = new DraftRefinementStore({
        executionTarget: deploymentTarget,
        pool: contentPool,
        host: readEnvString('PGHOST'),
        port: readEnvPort('PGPORT'),
        database: readEnvString('PGDATABASE'),
        user: readEnvString('PGUSER'),
        password: readEnvString('PGPASSWORD'),
      });
      await store.init();
      const recovered = await store.recoverInterruptedClaims();
      draftRefinementStore = store;
      console.log(`[aidcp-cloud] DraftRefinementStore 已就绪（executionTarget=${deploymentTarget}, recovered=${recovered}）`);
    } catch (err) {
      console.warn('[aidcp-cloud] DraftRefinementStore 初始化失败，稿件调整不可用:', (err as Error).message);
    }
  } else {
    console.warn('[aidcp-cloud] DraftRefinementWorker 未启用：AIDCP_DEPLOY_ENV 缺失或非法');
  }
  // ── Block② 2d step1：以下共享地基 + 内容管线构造由 segBContent 整体上移至此（纯搬运、零改行），
  //    使 core（segA+segC+segD，跳过 segB）在 segC/segD 构造期即可拿到这些对象；monolith 逐字节等价。
  // 晚绑定：精选存储在发布调度器与首作状态存储之前构造，回调运行时两者已完成装配。

  let firstPostCoordinator: FirstPostOnboardingCoordinator | undefined;




  // 通知联系人名册（notification-contact-registry，迁移 0016）：记录给本账号发过通知的人（评论/@/点赞/收藏/关注）。
  // 无条件接线（核心特性）；init 失败留 undefined（记录与面板退化，绝不崩闭环）。
  let notificationContactStore: NotificationContactStore | undefined;
  try {
    const ncs = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema,
      pool: apiPool,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await ncs.init();
    notificationContactStore = ncs;
    console.log('[aidcp-cloud] NotificationContactStore 已就绪（notification_event / notification_contact_meta 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] NotificationContactStore 初始化失败，通知联系人记录退化:', (err as Error).message);
  }

  // 团队 → 群路由（change feishu-per-team-notification-routing，schema 自建于 init）：出站按账号 group_label 路由到对应群。
  // init 失败留 undefined（路由退化 → 一律落默认群，绝不崩、绝不静默丢）。空表 = 今天行为逐字一致。
  let groupRouteStore: GroupRouteStore | undefined;
  if (serviceMode !== 'api' && serviceMode !== 'content') {
    try {
      const grs = new GroupRouteStore({ pool: automationPool });
      await grs.init();
      groupRouteStore = grs;
      console.log('[aidcp-cloud] GroupRouteStore 已就绪（group_route 表；账号→团队群路由）');
    } catch (err) {
      console.warn('[aidcp-cloud] GroupRouteStore 初始化失败，团队路由退化（一律落默认群）:', (err as Error).message);
    }
  }


  // 精选灵感语料（curated_content 表，change curated-inspiration-corpus）。过门槛的高价值笔记落详细行，
  // 作发帖创作正向素材来源。init 失败留 undefined（不捕获、创作回落旧路径，绝不崩闭环）。
  let curatedContentStore: CuratedContentStore | undefined;
  try {
    const ccs = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema,
      pool: contentPool,
      // Block③ 拆库解耦：created/uncreated 判定经 automation 域的委托任务存储（惰性 thunk，它在下方构造），content 不碰 automation 库。
      triggeredRefsReader: () => delegatedTaskStore,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
      ...(ossUploader ? { referenceImageRelocator: createCuratedReferenceImageRelocator(ossUploader) } : {}),
      onSourceAdmitted: (source: CuratedSourceAdmission) => firstPostCoordinator?.onSourceAdmitted(source),
      logger: console,
      ...(deploymentTarget ? { executionTarget: deploymentTarget } : {}),
    });
    await ccs.init();
    curatedContentStore = ccs;
    console.log('[aidcp-cloud] CuratedContentStore 已就绪（curated_content 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] CuratedContentStore 初始化失败，精选灵感语料退化:', (err as Error).message);
  }



  // 概念池存储（concepts 表，跨会话搜索记忆）。init 失败则留 undefined：
  // RoleDispatcher 不注册概念抽取角色、搜索退化为仅 seed_keywords（不崩闭环）。
  let conceptStore: ConceptStore | undefined;
  try {
    const cs = new ConceptStore({ schemaEnsurer: ensureCapabilitySchema,
      pool: contentPool,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await cs.init();
    conceptStore = cs;
    console.log('[aidcp-cloud] ConceptStore 已就绪（concepts 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] ConceptStore 初始化失败，搜索退化为仅 seed_keywords:', (err as Error).message);
  }

  // 图片总开关：任一图片厂商密钥就绪即启用（选中厂商若缺密钥，其客户端会诚实失败 → 该张记 M 少一张、不假成功）。
  // Block② 2e：内容管线对象（PostProcessor / WanxiangClient / SeedreamClient / RoutingImageProvider / PublishOrchestrator）
  //   已下移至 segBContent（content 段独占生成）；此处仅保留跨段共用的图片总开关布尔，其依赖的火山运行时在本段就地重取
  //   （廉价属性读、与 segB 各算各的、无共享状态问题）。
  const arkRuntime = providerRuntime['volcengine'];
  const anyImageKeyPresent = !!(readEnvString('WANXIANG_API_KEY') ?? dashscopeApiKey) || !!arkRuntime?.apiKey;

  // 页面写执行权现由 EdgeTaskLeaseClient + edge EdgeTaskCoordinator 统一管理；发布/评论不再各自 end/resume 浏览。
  // 手动 /comment 接管期间该账号在此集合。**它标的是「这条评论来自运营手动命令」，不是「它不算数」**
  // （change risk-record-actuated-facts）：人工授权豁免的是**配额闸**（不被 canDo('comment') 阻断，
  // 那道豁免在下发侧），**不是那本账**——平台照样看见了这条评论，故它照常 record、照常吃自治评论预算
  // （用户裁决 2026-07-17）。此前 `interaction.occurred` 的订阅者据此**整个跳过 record**，使「豁免」与
  // 「丢数」不可区分；现已摘除，本集合只剩一个用途：**抑制节奏饱和告警**（运营存心为之，「节奏过载」
  // 对他是噪声不是信号）。标记只覆盖获批后的 commit 租约，不覆盖 prepare/LLM/人审，也不触发浏览会话
  // 生命周期；自动排期 priority=automatic 不进入集合。
  // 注：只覆盖 XHS 手动评论（withManualCommitMarker 那条路）；FB 手动 /comment 从不进本集合。
  const manualCommentAccounts = new Set<string>();

  // 事件总线
  const eventBus = new EventBus();

  // 账号主表 + 暂停态持久化（accounts 表，seed 一个 default 行）。
  // PG 不可用则退化为纯内存（重启丢暂停态，告警但不阻塞启动）。
  let accountStore: AccountStore | undefined;
  let approvalPolicyStore: ApprovalPolicyStore | undefined;
  try {
    const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema,
      mirrorVersionBumper: mirrorVersionStore,
      pool: apiPool,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await store.init();
    accountStore = store;
    console.log('[aidcp-cloud] AccountStore 已就绪（accounts 表，seed default）');
    // ── automation 域的账号守卫投影（change automation-accounts-projection）──────────────────
    // accounts 属 api 单写。automation 侧原本有 10 处内联 accounts 的守卫读（三处夹在写路径 / 写事务内），
    // 现已全部改读本域投影表 ⇒ 守卫回到同库、留在单条语句内，跨库读与跨库事务在这批点位上消失。
    // 花名册来源经 kernel 端口取，**绝不**把 api 的连接池递给 automation 侧消费方：
    //   - monolith / core / content：本进程内 api 账号存储直读，逐字节等价、零 HTTP；
    //   - automation：从 API owner 的全量 roster route 拉取，绝不使用本进程误建的 api store；
    //   - api：本进程不该驱动 automation 的守卫，投影也不属它 ⇒ fail-closed（reject 具名错误），
    //     镜像 clientEnvAutomationRead / offboardCleanupGrantOps 的既有范式。
    const rosterMode = serviceModeFromEnv();
    const accountRosterSource: AccountRosterSourcePort =
      rosterMode === 'automation'
        ? (() => {
            const apiUrl = readEnvString('AIDCP_API_URL');
            if (!apiUrl) throw new Error('AIDCP_API_URL is required in automation mode');
            if (!deploymentTarget) {
              throw new Error('AIDCP_DEPLOY_ENV is required in automation mode');
            }
            return new AccountRosterHttpClient(
              new InternalHttpClient(apiUrl),
              requireDirectInternalToken('AIDCP_API_INTERNAL_TOKEN'),
              deploymentTarget,
            );
          })()
        : rosterMode === 'api'
        ? {
            listAccountIdentities: () =>
              Promise.reject(new Error('account_roster_source_unavailable_in_api_mode')),
          }
        : {
            listAccountIdentities: async () => {
              // 诚实失败：账号存储没起来就是「这次没读到」，让刷新算失败、新鲜期不推进、守卫到期即拒绝。
              // MUST NOT 返空数组冒充成功——那会把「读不到」洗成「一个账号都没有」。
              if (!store.listAccountIdentities) throw new Error('account_roster_source_missing_method');
              return store.listAccountIdentities();
            },
          };
    try {
      if (segmentsForMode(rosterMode).segC) {
        if (!deploymentTarget) {
          throw new Error(
            'AIDCP_DEPLOY_ENV is required for target-scoped account projection',
          );
        }
        const projection = new PgAccountProjectionStore({
          pool: automationPool,
          source: accountRosterSource,
          executionTarget: deploymentTarget,
        });
        await projection.init();
        accountProjectionStore = projection;
        console.log(
          `[aidcp-cloud] 账号守卫投影结构已就绪（target=${deploymentTarget}；等待 4b API owner 全量快照，legacy refresher 未启动）`,
        );
      }
    } catch (projectionError) {
      // 投影不可用 = 加群 / 委托任务认领这批守卫全部 fail-closed（响亮停摆），其余功能不受影响。
      // 这正是要的方向：宁可停手，也不要因为守卫读不到就放行。
      console.error(
        '[aidcp-cloud] 账号守卫投影初始化失败：Facebook 加群与委托任务认领的账号守卫将一律拒绝'
        + '（fail-closed，绝不放行）。多半是迁移 0077_automation_account_projection 还没跑，'
        + '处置是 npm run migrate up 后重启：',
        (projectionError as Error).message,
      );
    }
    try {
      const policies = new ApprovalPolicyStore({ pool: apiPool, schemaEnsurer: ensureCapabilitySchema });
      await policies.init();
      approvalPolicyStore = policies;
      console.log('[aidcp-cloud] ApprovalPolicyStore 已就绪（账号评论审批覆盖 / 分组稿件审核入口）');
    } catch (policyError) {
      console.warn('[aidcp-cloud] ApprovalPolicyStore 初始化失败：评论回落来源规则、稿件保留飞书卡:', (policyError as Error).message);
    }
    try {
      const migrated = await clientUserStore.migrateEnvironmentSlowStartFromAccounts();
      console.log(`[aidcp-cloud] 环境级慢启动镜像已就绪（一次性初始化 ${migrated} 个历史环境）`);
    } catch (migrationError) {
      // 加列/回填失败时环境镜像保持关闭态，绝不退回读取账号旧列重新制造“设置跟账号走”。
      console.warn('[aidcp-cloud] 环境级慢启动迁移失败（不回退账号旧列）:', (migrationError as Error).message);
    }
  } catch (err) {
    console.warn(
      '[aidcp-cloud] AccountStore 初始化失败，账号暂停态退化为纯内存（重启丢失）:',
      (err as Error).message,
    );
  }
  // ── 候审卡投递判定（change cloud-batch2-content-main）──────────────────────────────────
  // 原先这段闭包住在**内容段**里，就地读 approvalPolicyStore 与 clientUserStore ——
  // 两者都绑 api 池。content 拆成独立进程后它连不上那个库，整段判定无从执行。
  // 判定要的两张表都是 api 属主，故整段留在这里（属主侧），跨边界只暴露一个方法（kernel 端口）。
  // 内容段因此**同时**摘掉了对这两个存储的依赖 —— 拆仓要消的两条边，一次消完。
  //
  // fail-open 是这条口的语义、不是容错兜底：判不出来一律保留飞书卡（见 kernel 接口文档）。
  // 下面每个 catch 都如实带上走到了哪一支的 reason，MUST NOT 归一成一个笼统值。
  const resolveReviewCardDelivery = async (accountId: string): Promise<ReviewCardDeliveryDecision> => {
    if (!approvalPolicyStore) return { send: true, reason: 'policy_store_unavailable' };
    let policy: Awaited<ReturnType<ApprovalPolicyStore['getGroupPublishPolicyForAccount']>>;
    try {
      policy = await approvalPolicyStore.getGroupPublishPolicyForAccount(accountId);
    } catch (error) {
      console.warn(`[approval-policy] 分组稿件策略读取失败，保留飞书卡 account=${accountId}: ${(error as Error).message}`);
      return { send: true, reason: 'policy_read_failed' };
    }
    if (policy.delivery !== 'client_only') return { send: true, reason: 'client_and_feishu' };
    if (!policy.groupLabel) return { send: true, reason: 'account_group_missing' };
    try {
      const reachability = await clientUserStore.hasEnabledClientApprovalReachability(accountId);
      if (reachability.reachable) return { send: false, reason: 'suppressed_by_client_only_policy' };
      console.warn(
        `[approval-policy] client_only 账号客户审批归属不可证，保留飞书卡 account=${accountId} group=${policy.groupLabel} reason=${reachability.reason}`,
      );
      return { send: true, reason: `client_reachability_${reachability.reason}` };
    } catch (error) {
      console.warn(`[approval-policy] 客户审批归属读取失败，保留飞书卡 account=${accountId}: ${(error as Error).message}`);
      return { send: true, reason: 'client_reachability_read_failed' };
    }
  };

  // 启动加载持久化暂停态进内存缓存：被暂停账号重启后仍为 paused，不静默复活。
  const accountState = new AccountStateManager(accountStore);

  await accountState.init();
  const accountDisplayName = (accountId: string): string | undefined => {
    const display = accountStore?.getDisplayName?.(accountId);
    return display && display.source !== 'account_id' ? display.name : undefined;
  };
  const accountDisplayNameCandidates = (accountId: string): string[] =>
    accountStore?.getDisplayNameCandidates?.(accountId) ?? [];

  // Unified user-delegated task control plane. If PG/account facts are unavailable, all public write entries fail closed.
  let delegatedTaskStore: PgDelegatedTaskStore | undefined;
  let delegatedTaskService: DelegatedTaskService | undefined;
  if (accountStore && deploymentTarget) {
    try {
      const store = new PgDelegatedTaskStore({
        executionTarget: deploymentTarget,
        pool: automationPool,
        host: readEnvString('PGHOST'),
        port: readEnvPort('PGPORT'),
        database: readEnvString('PGDATABASE'),
        user: readEnvString('PGUSER'),
        password: readEnvString('PGPASSWORD'),
      });
      await store.init();
      delegatedTaskStore = store;
      delegatedTaskService = new DelegatedTaskService({
        store,
        listAccounts: async () => Promise.all((await accountStore!.listAll()).map(async (row) => ({
          accountId: row.accountId,
          displayName: accountDisplayName(row.accountId) ?? null,
          names: accountDisplayNameCandidates(row.accountId),
          platform: await accountStore!.getPlatform?.(row.accountId) ?? 'xiaohongshu',
          status: row.status,
        }))),
        prepareTarget: async (intent, account) => {
          if (intent.action === 'approve_candidate' || intent.action === 'reject_candidate' || intent.action === 'modify_candidate') {
            const recordId = Number(intent.targetConstraints?.candidateId);
            if (!Number.isInteger(recordId) || recordId <= 0) {
              return { ok: false, code: 'candidate_target_required', message: '请提供有效候选稿编号。' };
            }
            const draft = await publishLogStore.loadForDispatch(recordId);
            if (!draft || draft.accountId !== account.accountId || draft.platform !== account.platform) {
              return { ok: false, code: 'candidate_not_found_or_mismatch', message: '候选稿不存在或不属于该账号/平台。' };
            }
            if (draft.status !== 'pending_approval') {
              return { ok: false, code: 'candidate_not_pending', message: `候选稿当前状态为 ${draft.status}，不能创建该操作。` };
            }
            return {
              ok: true,
              targetConstraints: {
                ...(intent.targetConstraints ?? {}),
                candidateId: String(recordId),
                candidateVersion: draft.contentVersion,
                candidateTitle: draft.title ?? '',
              },
            };
          }
          if (intent.action === 'comment_curated') {
            const curatedId = Number(intent.targetConstraints?.curatedId);
            let row: Awaited<ReturnType<CuratedContentStore['getOneForAccount']>> = null;
            try {
              row = Number.isInteger(curatedId) && curatedContentStore
                ? await curatedContentStore.getOneForAccount(curatedId, account.accountId)
                : null;
            } catch (err) {
              // 缺表/改名（42P01）：诚实回「服务不可用」，MUST NOT 复用 curated_target_unavailable（那句是「这行不存在」= 谎）。
              if (err instanceof CuratedContentUnavailableError) {
                return { ok: false, code: 'curated_content_unavailable', message: '精选内容存储暂不可用，请稍后重试。' };
              }
              throw err;
            }
            if (!row || (row.contentType !== 'image_text' && row.contentType !== 'video') || !row.title?.trim()) {
              return { ok: false, code: 'curated_target_unavailable', message: '指定精选内容不存在、归属不符或缺少可定位标题。' };
            }
            return {
              ok: true,
              targetConstraints: {
                ...(intent.targetConstraints ?? {}), curatedId, noteId: row.sourceId, title: row.title,
              },
            };
          }
          return { ok: true };
        },
        validateTarget: async (task) => {
          if (task.action === 'approve_candidate' || task.action === 'reject_candidate' || task.action === 'modify_candidate') {
            const recordId = Number(task.targetConstraints.candidateId);
            const expectedVersion = Number(task.targetConstraints.candidateVersion);
            const draft = await publishLogStore.loadForDispatch(recordId);
            if (!draft || draft.accountId !== task.accountId || draft.platform !== task.platform) {
              return { ok: false, code: 'candidate_not_found_or_mismatch', message: '候选稿已不存在或归属/平台已变化。' };
            }
            if (draft.contentVersion !== expectedVersion) {
              return { ok: false, code: 'candidate_version_conflict', message: `候选稿已更新到 v${draft.contentVersion}，请重新确认。` };
            }
          }
          const curatedId = Number(task.targetConstraints.curatedId ?? task.sourceConstraints.curatedId);
          if (Number.isInteger(curatedId) && curatedId > 0) {
            let row: Awaited<ReturnType<CuratedContentStore['getOneForAccount']>> = null;
            try {
              row = curatedContentStore ? await curatedContentStore.getOneForAccount(curatedId, task.accountId) : null;
            } catch (err) {
              // 缺表/改名（42P01）：诚实回「服务不可用」，MUST NOT 复用 curated_target_changed（那句是「已删/已变」= 谎）。
              if (err instanceof CuratedContentUnavailableError) {
                return { ok: false, code: 'curated_content_unavailable', message: '精选内容存储暂不可用，请稍后重试。' };
              }
              throw err;
            }
            if (!row || row.sourceId !== String(task.targetConstraints.noteId ?? task.sourceConstraints.sourceId ?? '')) {
              return { ok: false, code: 'curated_target_changed', message: '精选目标已删除或身份发生变化，不能改选相似内容。' };
            }
          }
          return { ok: true };
        },
      });
      console.log(`[aidcp-cloud] DelegatedTaskStore 已就绪（统一用户委托任务控制面；executionTarget=${deploymentTarget}）`);
    } catch (err) {
      console.warn('[aidcp-cloud] DelegatedTaskStore 初始化失败，公共写入口 fail-closed:', (err as Error).message);
    }
  } else if (accountStore) {
    console.warn(
      `[aidcp-cloud] DelegatedTaskStore 未启用：AIDCP_DEPLOY_ENV=${JSON.stringify(readEnvString('AIDCP_DEPLOY_ENV') ?? null)} ` +
      '不是 dev/ol；任务创建与 worker fail-closed，绝不猜测执行环境',
    );
  }

  // Feishu is API-owned and dynamically loaded only in API-bearing modes.
  // automation/content therefore do not even load the SDK/card stack.
  let apiFeishuOwner: ApiFeishuOwner | undefined;
  if (ownsApiFeishuForMode(serviceMode)) {
    const groupRoutes =
      serviceMode === 'api'
        ? new GroupRouteHttpClient(
            new InternalHttpClient(
              readEnvString('AIDCP_AUTOMATION_URL')
                ?? (() => {
                  throw new Error('AIDCP_AUTOMATION_URL is required in api mode');
                })(),
            ),
          )
        : groupRouteStore;
    const { createApiFeishuOwner } = await import(
      './feishu/api-owner-composition.js'
    );
    apiFeishuOwner = createApiFeishuOwner({
      pool: apiPool,
      accountStore,
      groupRoutes,
      accountDisplayName,
      publishApprovalDecisionWriter,
      deploymentTarget,
      fallbackChatId: process.env.FEISHU_CHAT_ID,
      logger: console,
    });
    ctx.apiFeishuOwner = apiFeishuOwner;
  }

  let facebookPublishMediaStore: FacebookPublishMediaStore | undefined;
  try {
    const store = new FacebookPublishMediaStore({ schemaEnsurer: ensureCapabilitySchema,
      pool: contentPool,
      // Block③ 拆库解耦：账号校验经 api 域的账号存储读接口（缺账号返 null），content 不碰 api 库。
      accountPlatformReader: () =>
        accountStore?.getPlatformOrNull
          ? { getPlatformOrNull: (id: string) => accountStore!.getPlatformOrNull!(id) }
          : undefined,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
      objectStore: ossUploader,
    });
    await store.init();
    facebookPublishMediaStore = store;
    console.log('[aidcp-cloud] FacebookPublishMediaStore 已就绪（account_facebook_publish_image_set / image）');
  } catch (err) {
    console.warn('[aidcp-cloud] FacebookPublishMediaStore 初始化失败，FB 发帖素材池不可用:', (err as Error).message);
  }

  // ── 账号人设（change account-persona-config，stream F，迁移 0011）─────────────
  // 须在 accounts 表建好之后（persona_config FK 到 accounts）。
  // persona-driven-content-pipeline：系统不存在默认/兜底人设——PG 不可用 / init 失败时人设镜像为空，
  // 所有账号按「未绑人设」fail-closed 诚实拒绝（isPersonaBound=false），绝不静默套打包 soul.yaml 开跑。
  const personaStore = new PersonaStore({ schemaEnsurer: ensureCapabilitySchema,
    pool: configMirrorPool,
    mirrorVersionBumper: mirrorVersionStore,
  });
  try {
    await personaStore.init();
    console.log('[aidcp-cloud] 账号人设存储已就绪（persona_config，按账号热加载）');
  } catch (err) {
    console.warn(
      '[aidcp-cloud] 人设存储初始化失败 → 所有账号视为未绑人设、入口闸诚实拒绝运行（fail-closed，绝不回落默认人设）:',
      (err as Error).message,
    );
  }
  let personaAutoFillStore: PersonaAutoFillStore | undefined;
  try {
    const store = new PersonaAutoFillStore({ pool: apiPool, schemaEnsurer: ensureCapabilitySchema });
    await store.init();
    personaAutoFillStore = store;
    console.log('[aidcp-cloud] Facebook 人设自动补齐任务存储已就绪');
  } catch (err) {
    console.warn('[aidcp-cloud] Facebook 人设自动补齐任务存储初始化失败，该能力禁用:', (err as Error).message);
  }
  // 首作新人状态（change persona-first-post-onboarding）：账号首次绑定时只建一次，后续解绑/更新不重置。
  // 存储不可用时不展示带自动生成承诺的引导；普通人设/浏览/发布链继续按既有逻辑工作。
  let firstPostOnboardingStore: FirstPostOnboardingStore | undefined;
  try {
    const store = new FirstPostOnboardingStore({ schemaEnsurer: ensureCapabilitySchema,
      pool: apiPool,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await store.init();
    firstPostOnboardingStore = store;
    firstPostCoordinator = new FirstPostOnboardingCoordinator({
      store,
      countPendingForAccount: (accountId) => publishLogStore.countPendingForAccount(accountId),
      // 批次 0b：本处前向引用**已经是诚实实现**（缺了抛 `publish_unready`，调用方拿到失败而非假成功），
      // 故只做登记、不改代码。三等分后 api / content 进程走到这里会如实炸在参照创作入口上。
      beginRewrite: (accountId, referenceNote, options) => {
        if (!ctx.publishScheduler) throw new Error('publish_unready');
        return ctx.publishScheduler.tryBeginRewrite(accountId, referenceNote, options);
      },
      onStateChanged: (accountId) =>
        crossSegment(
          ctx.uiSnapshot,
          `账号 ${accountId} 的首作进度界面推送`,
          '自动化段',
          '该账号客户端左栏的今日用量会停在旧值，须由自动化进程侧承接推送',
        )?.pushDailyUsage(accountId),
      logger: console,
    });
    console.log('[aidcp-cloud] FirstPostOnboardingStore 已就绪（首次人设 → 首条精选 → 参照创作）');
  } catch (err) {
    console.warn('[aidcp-cloud] 首作新人状态初始化失败，首次作品自动生成链路禁用:', (err as Error).message);
  }
  // 按账号解析人设的取值口（派发 / 发布热路径用；永不抛）。persona-driven-content-pipeline：
  // 无人设/解析失败 → resolvePersona 返回 null（明确「无人设」信号）；浏览/发布/评论入口闸
  // （isPersonaBound）已先行诚实拒绝，getSoul 再遇 null 即抛 no_persona（防御性，如会话中途被解绑），
  // 绝不静默套用任何默认/替代人设（红线：不静默假成功）。
  const resolvePersona = createPersonaResolver({ store: personaStore, logger: console });
  const getSoul = (accountId?: string): Soul => {
    const soul = resolvePersona(accountId);
    if (!soul) {
      throw new Error(`no_persona: 账号 ${accountId ?? '(未指定)'} 未绑定人设，拒绝以默认人设运行`);
    }
    return soul;
  };
  // 人设面板外观（后台按账号编辑 + soul 校验 + 写非乐观回真态）。
  // auto-start-on-persona-bind：后台真绑定人设成功 → 唤醒该账号在线、被人设闸短路的节点就地开跑（无需重连）。
  // runtimes 为后向声明，onBound 闭包仅在请求期（PUT 人设）才调用、装配早已完成（同 onPublishEnd 模式）。
  // 批次 0b：两个回调读的都是**自动化段**赋值的句柄，三等分后 api 进程读不到 —— 经 crossSegment 响亮记账。
  const personaPanel = createPersonaPanel({
    store: personaStore,
    onBound: (accountId) => {
      crossSegment(
        ctx.runtimes,
        `账号 ${accountId} 绑定人设后的会话唤醒`,
        '自动化段',
        '该账号不会就地开跑（表现为「绑了人设却一直不动」），须由自动化进程侧承接唤醒',
      )?.startSessionForAccount(accountId);
    },
    // 绑定 / 解绑都即时把新的绑定态推给在线边缘（uiSnapshot 同为后向声明，闭包只在请求期才调用）。
    onChanged: (accountId) => {
      crossSegment(
        ctx.uiSnapshot,
        `账号 ${accountId} 的人设绑定态界面推送`,
        '自动化段',
        '在线边缘收不到绑定态变更，客户端会继续按旧绑定态显示（人设三态的「未知≠否」不变量在此断链）',
      )?.pushPersonaBound(accountId);
    },
  });

  ctx.cache = cache;
  ctx.categoryConfigStore = categoryConfigStore;
  ctx.clientUserStore = clientUserStore;
  ctx.configMirrorPool = configMirrorPool;
  ctx.automationPool = automationPool;
  ctx.apiPool = apiPool;
  ctx.contentScheduleStore = contentScheduleStore;
  ctx.credentialStore = credentialStore;
  ctx.dashscopeApiKey = dashscopeApiKey;
  ctx.deploymentTarget = deploymentTarget;
  ctx.draftRefinementStore = draftRefinementStore;
  ctx.facebookCommentAuditStore = facebookCommentAuditStore;
  ctx.facebookCommentConfigStore = facebookCommentConfigStore;
  ctx.facebookGroupJoinAuditStore = facebookGroupJoinAuditStore;
  ctx.facebookGroupJoinAutomationStore = facebookGroupJoinAutomationStore;
  ctx.facebookGroupMembershipStore = facebookGroupMembershipStore;
  ctx.facebookGroupTargetStore = facebookGroupTargetStore;
  ctx.hotLeadConfigStore = hotLeadConfigStore;
  ctx.llm = llm;
  ctx.mirrorVersionStore = mirrorVersionStore;
  ctx.configMirrorBumpSink = configMirrorBumpSink;
  ctx.modelConfigStore = modelConfigStore;
  ctx.ossUploader = ossUploader;
  ctx.pacingConfigStore = pacingConfigStore;
  ctx.planner = planner;
  ctx.port = port;
  ctx.providerRuntime = providerRuntime;
  ctx.publishApprovalAuthority = publishApprovalAuthority;
  ctx.publishApprovalClient = publishApprovalClient;
  ctx.publishApprovalDecisionWriter = publishApprovalDecisionWriter;
  ctx.publishApprovalStore = publishApprovalStore;
  ctx.publishLogStore = publishLogStore;
  ctx.publishLogWriter = publishLogStore;
  ctx.pipelineLogSink = publishPipelineLogStore;
  ctx.pendingPublishPreviewForAccount = (accountId) => publishLogStore.pendingPublishPreviewForAccount(accountId);
  ctx.quotaConfigStore = quotaConfigStore;
  ctx.resumeConfigStore = resumeConfigStore;
  ctx.roleConfigStore = roleConfigStore;
  ctx.sessionConfigStore = sessionConfigStore;
  ctx.tokenUsageStore = tokenUsageStore;
  ctx.writeApprovalDecision = writeApprovalDecision;
  // ── 发布候审的卡片出口（change cloud-batch2-content-main）────────────────────────────────
  // 六个方法是一组：发卡 / 发通知 / 传图 / 默认群 / 落点解析 / 免审预授权。实现全长在本域——
  // 飞书客户端与卡片构造、机器人会话表、授权台账。内容段原先分别拿着这四样东西自己拼，
  // 于是**内容仓被迫依赖飞书 SDK**，而依赖集重算时飞书已判给 api：两者只能有一个成立，
  // 正解是后者。卡片长什么样、发到哪个会话由属主侧决定，内容域只交结构化数据。
  //
  // `decidedVia` 在这里固定成排期免审那一档 —— 原本就写死在内容段里，只是挪了位置，逐字等价。
  // 账号展示名由**属主侧就地补**（change cloud-batch2-content-main）：它是 api 的事实，
  // 读它的那个函数是**同步**的、且底下是进程内缓存 —— 跨进程包不成一次调用（会改掉每个调用点的签名，
  // 还给每张卡加一跳网络），做本地镜像又要为一个渲染字段养一张投影表。
  // 而这个字段在卡片契约里本就是**可选**的，卡片构造器缺它时回落账号 id。
  // 于是正解是第三条：调用方不再传，属主侧构卡前自己解析。单体下取到的是同一个值、同一份缓存，
  // 逐字等价；拆进程后它比任何镜像都新鲜，因为解析发生在渲染那一刻。
  // 图片模型选择（change cloud-batch2-content-main）：调用点是**同步**的、在热闭包里，
  // 所以跨进程形态是「异步取源 + 同步读本地镜像」两件事，而不是一个 HTTP 客户端。
  // 单体里镜像就是配置存储自己的进程内缓存 —— 两口指向同一份事实，逐字等价。
  const imageModelSelection: ImageModelSelectionReader = {
    current: () => {
      const cfg = modelConfigStore.getCached();
      return { imageProvider: cfg.imageProvider, imageModel: cfg.imageModel };
    },
  };

  const unavailablePublishCardExit = (): Promise<never> =>
    Promise.reject(new Error('publish_card_exit_unavailable_in_this_service_mode'));
  const publishCardExit: PublishCardExitPort =
    apiFeishuOwner?.publishCardExit ?? {
      sendApprovalCard: unavailablePublishCardExit,
      sendCommandResult: unavailablePublishCardExit,
      uploadImageFromUrl: unavailablePublishCardExit,
      getDefaultChat: unavailablePublishCardExit,
      resolveCardChatId: unavailablePublishCardExit,
      writeApprovalSignal: unavailablePublishCardExit,
    };

  ctx.accountDisplayName = accountDisplayName;
  ctx.accountDisplayNameCandidates = accountDisplayNameCandidates;
  ctx.accountProjectionStore = accountProjectionStore;
  ctx.accountState = accountState;
  ctx.accountStore = accountStore;
  ctx.anyImageKeyPresent = anyImageKeyPresent;
  ctx.approvalPolicyStore = approvalPolicyStore;
  ctx.conceptStore = conceptStore;
  ctx.curatedContentStore = curatedContentStore;
  ctx.delegatedTaskService = delegatedTaskService;
  ctx.delegatedTaskStore = delegatedTaskStore;
  ctx.eventBus = eventBus;
  ctx.facebookPublishMediaStore = facebookPublishMediaStore;
  ctx.firstPostOnboardingStore = firstPostOnboardingStore;
  ctx.getSoul = getSoul;
  ctx.groupRouteStore = groupRouteStore;
  ctx.manualCommentAccounts = manualCommentAccounts;
  ctx.notificationContactStore = notificationContactStore;
  ctx.personaAutoFillStore = personaAutoFillStore;
  ctx.personaPanel = personaPanel;
  ctx.personaStore = personaStore;
  ctx.resolveReviewCardDelivery = resolveReviewCardDelivery;
  ctx.publishCardExit = publishCardExit;
  ctx.imageModelSelection = imageModelSelection;
  ctx.roleModelSelection = roleModelSelection;
  ctx.roleModelSelectionSource = roleModelSelectionSource;
  ctx.providerSecretReader = providerSecretReader;
  ctx.accountPlatformReader = accountStore?.getPlatformOrNull
    ? { getPlatformOrNull: (id: string) => accountStore.getPlatformOrNull!(id) }
    : undefined;
  ctx.triggeredPublishRefs = delegatedTaskStore;
  ctx.resolvePersona = resolvePersona;

  let apiReplyConfigAuthority: ReplyConfigResolverPort | undefined;
  let apiAccountPersonaAuthority: AccountPersonaService | undefined;
  if (serviceModeFromEnv() === 'api') {
    const replyScopes = new ReplyConfigScopeStore({ pool: apiPool });
    await replyScopes.init();
    apiReplyConfigAuthority = new ReplyConfigResolver(replyScopes);

    const contentUrl = readEnvString('AIDCP_CONTENT_URL');
    if (!contentUrl) throw new Error('AIDCP_CONTENT_URL is required in api mode');
    if (!deploymentTarget) throw new Error('AIDCP_DEPLOY_ENV is required in api mode');
    const personaGenerator = personaGeneratorFromCommand(
      new PersonaGeneratorCommandHttpClient(
        new InternalHttpClient(contentUrl),
        requireDirectInternalToken('AIDCP_CONTENT_INTERNAL_TOKEN'),
        deploymentTarget,
      ),
    );
    apiAccountPersonaAuthority = new AccountPersonaService({
      generator: personaGenerator,
      facade: personaPanel,
      personaBinding: (accountId) => personaStore.bindingFor(accountId),
      logger: console,
    });
    ctx.accountPersonaService = apiAccountPersonaAuthority;
  }

  const publishUiUpdateProducer = createPublishUiUpdateProducer({
    loadPreview: (recordId) =>
      publishLogStore.pendingPublishPreviewForRecord(recordId),
    command: {
      applyPublishUiUpdate: (input) => {
        const command = ctx.publishUiUpdateCommand;
        if (!command) {
          throw new Error('publish_ui_update_command_unavailable');
        }
        return command.applyPublishUiUpdate(input);
      },
    },
  });
  const pushApiOwnedPublishPreview = async (
    recordId: number,
  ): Promise<void> => {
    const result = await publishUiUpdateProducer.pushPreview(recordId);
    if (result.outcome === 'no_record') {
      throw new Error(`publish_ui_preview_no_record:${recordId}`);
    }
  };
  const pushApiOwnedPublishState: NonNullable<
    CompositionContext['pushApiOwnedPublishState']
  > = async (accountId, recordId, state, factVersion, title) => {
    await publishUiUpdateProducer.pushState(
      accountId,
      recordId,
      state,
      factVersion,
      title,
    );
  };
  ctx.pushApiOwnedPublishPreview = pushApiOwnedPublishPreview;
  ctx.pushApiOwnedPublishState = pushApiOwnedPublishState;

  const apiPublishLogAuthority: AutomationPublishLogPort = {
    loadForDispatch: (recordId) => publishLogStore.loadForDispatch(recordId),
    updateStatus: (recordId, status) => publishLogStore.updateStatus(recordId, status),
    updatePostId: (recordId, postId, postUrl) =>
      publishLogStore.updatePostId(recordId, postId, postUrl),
    markScheduled: (recordId, scheduledAt, scheduledPlatformId) =>
      publishLogStore.markScheduled(recordId, scheduledAt, scheduledPlatformId),
    markImagesAttached: (recordId, imageCount) =>
      publishLogStore.markImagesAttached(recordId, imageCount),
    listDueScheduled: (limit, now) => publishLogStore.listDueScheduled(limit, now),
    deferScheduledReconcile: (recordId, error, nextAt, maxAttempts) =>
      publishLogStore.deferScheduledReconcile(recordId, error, nextAt, maxAttempts),
    confirmScheduledPublished: (recordId, postId, postUrl) =>
      publishLogStore.confirmScheduledPublished(recordId, postId, postUrl),
    getMostRecentPublishTime: () => publishLogStore.getMostRecentPublishTime(),
    recentPublishedContents: (limit) => publishLogStore.recentPublishedContents(limit),
    editDraft: async (recordId, expectedVersion, patch, editor, expectedAccountId) => {
      const result = await publishLogStore.editDraft(
        recordId,
        expectedVersion,
        patch,
        editor,
        expectedAccountId,
      );
      if (result.ok && serviceModeFromEnv() === 'api') {
        void pushApiOwnedPublishPreview(recordId).catch((error) => {
          console.warn(
            `[aidcp-cloud] publish draft edit 已提交，UI preview 投递失败 record=${recordId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return result;
    },
    rejectPendingApproval: async (recordId) => {
      const draft = await publishLogStore.loadForDispatch(recordId);
      const rejected = await publishLogStore.rejectPendingApproval(recordId);
      if (rejected && draft && serviceModeFromEnv() === 'api') {
        void pushApiOwnedPublishState(
          draft.accountId,
          recordId,
          'rejected',
          draft.contentVersion,
          draft.title,
        ).catch((error) => {
          console.warn(
            `[aidcp-cloud] publish rejection 已提交，UI state 投递失败 record=${recordId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return rejected;
    },
    pendingApprovalForAccount: (accountId) =>
      publishLogStore.pendingApprovalForAccount(accountId),
    pendingPublishPreviewForAccount: (accountId) =>
      publishLogStore.pendingPublishPreviewForAccount(accountId),
    lastPublishedForAccount: (accountId) => publishLogStore.lastPublishedForAccount(accountId),
    countPendingForAccount: (accountId) => publishLogStore.countPendingForAccount(accountId),
    countPendingAutonomousForAccount: (accountId) =>
      publishLogStore.countPendingAutonomousForAccount(accountId),
    countPublishedTodayForAccount: (accountId) =>
      publishLogStore.countPublishedTodayForAccount(accountId),
    countPublishedSinceForAccount: (accountId, since) =>
      publishLogStore.countPublishedSinceForAccount(accountId, since),
  };

  const apiDirectAuthorities: ApiDirectAuthorities = {
    publishLog: apiPublishLogAuthority,
    edgePublish: {
      removeDraftImage: async (input) => {
        const handler = ctx.handlePublishDraftImageRemove;
        if (!handler) throw new Error('edge_publish_image_remove_owner_unavailable');
        return handler(input.payload, input.session);
      },
      decidePublishApproval: async (input) => {
        const handler = ctx.approvePublishForClient;
        if (!handler) throw new Error('edge_publish_approval_owner_unavailable');
        return handler(input.payload, input.accountId);
      },
    },
    interactionAuth: new PgInteractionAuthGate({ pool: apiPool }),
    interactionApiWrites: new PgInteractionApiWrites(apiPool),
    ...(apiReplyConfigAuthority ? { replyConfig: apiReplyConfigAuthority } : {}),
    ...(apiAccountPersonaAuthority ? { accountPersona: apiAccountPersonaAuthority } : {}),
    environmentHandshake: createEnvironmentHandshakeAuthority(
      clientUserStore,
      (envKey) =>
        crossSegment(
          ctx.personaAutoFill,
          `personaAutoFill.notifyEnvironmentBound(${envKey})`,
          'automation 段',
          '环境已登记，但本进程没有发送人设补全提示',
        )?.notifyEnvironmentBound(envKey),
    ),
    automationConfigCommands: createAutomationConfigCommands(
      contentScheduleStore,
      facebookCommentConfigStore,
    ),
    ...(apiFeishuOwner
      ? { notificationDelivery: apiFeishuOwner.notificationDelivery }
      : {}),
    ...(approvalPolicyStore ? { commentApprovalPolicy: approvalPolicyStore } : {}),
    ...(notificationContactStore ? { notificationContacts: notificationContactStore } : {}),
    ...(firstPostOnboardingStore ? { firstPostProgress: firstPostOnboardingStore } : {}),
    ...(deploymentTarget
      ? { offboardAdmissionLedger: new PgOffboardAdmissionLedger(apiPool, deploymentTarget) }
      : {}),
  };
  if (
    accountStore?.listAccountIdentities
    && accountStore.getExecutionTarget
    && accountStore.resolveExecutionTarget
    && accountStore.setExecutionTarget
    && accountStore.ensureAccount
    && accountStore.getPlatformOrNull
    && accountStore.getContactInfo
    && accountStore.recordNickname
  ) {
    apiDirectAuthorities.accountRoster = {
      listAccountIdentities: () => accountStore.listAccountIdentities!(),
    };
    apiDirectAuthorities.accountOwnership = {
      getExecutionTarget: (accountId) => accountStore.getExecutionTarget!(accountId),
      resolveExecutionTarget: (accountId) => accountStore.resolveExecutionTarget!(accountId),
      setExecutionTarget: (accountId, target) => accountStore.setExecutionTarget!(accountId, target),
    };
    apiDirectAuthorities.accountRuntime = {
      ensureAccount: (accountId, platform) => accountStore.ensureAccount!(accountId, platform),
      getPlatformOrNull: (accountId) => accountStore.getPlatformOrNull!(accountId),
      getContactInfo: (accountId) => accountStore.getContactInfo!(accountId),
      recordNickname: (accountId, nickname) => accountStore.recordNickname!(accountId, nickname),
    };
  }
  ctx.apiDirectAuthorities = apiDirectAuthorities;
}

async function segBContent(ctx: CompositionContext): Promise<void> {
  // Block② 2e：content 段独占内容生成管线。共享对象留 segA；本段构造图片/内容管线对象 + 视觉链路 + 注册发布角色，
  //   并回挂 ctx（postProcessor / imageProvider / publishOrchestrator）。automation（segA+segC，无本段）不构造这些对象即可开机；
  //   monolith 下本段在 segC/segD 之前跑、同一实例、逐字节等价。视觉链路用量上报闭包本段自持一份（segC textcard-OCR 另有同源实现）。
  const {
    anyImageKeyPresent,
    curatedContentStore,
    dashscopeApiKey,
    facebookPublishMediaStore,
    llm,
    // change cloud-batch2-content-main：只取图片模型选择那两个值的**同步**读口，不再拿整个配置存储。
    // 它绑 api 池；拆进程后本段换成本地镜像（异步取源 + 同步读），调用点签名一行不改。
    imageModelSelection,
    ossUploader,
    providerRuntime,
    // change cloud-batch2-content-main：只取窄写入口（四个方法）+ 一条候审预览读，不再拿整个存储。
    // 那个存储绑 api 池、另有二十余个不属于本域的方法；拆进程后本段换成 HTTP 客户端，调用点不变。
    publishLogWriter,
    pendingPublishPreviewForAccount,
    pipelineLogSink,
    // change cloud-batch2-content-main：卡片出口收成一个端口（发卡 / 发通知 / 传图 / 默认群 /
    // 落点解析 / 免审预授权）。本段原先分别持有飞书客户端、机器人会话表、落点解析与授权写四样，
    // 于是**内容仓被迫依赖飞书 SDK**；实现全在属主域，这里只调。
    publishCardExit: localPublishCardExit,
    // change cloud-batch2-content-main：候审卡投递判定改由基础段（属主侧）给成品。
    // 本段原先自己读 approvalPolicyStore + clientUserStore 现算——两者都绑 api 池，
    // content 拆成独立进程后连不上那个库。判定整段留属主侧，这里只调。
    resolveReviewCardDelivery,
    tokenUsageStore,
    // change cloud-batch2-content-main：**apiPool 已从本段彻底消失**。
    // 内容段曾直接拿 api 池建两个 api 属主表的存储（发布台账 / 管线日志），两者都已上移到属主段，
    // 跨边界只剩窄端口。这一行的消失就是「内容域不再连另一个域的库」这条铁律在本段成立的机械证据。
  } = ctx;
  const personaGenerator = new PersonaGenerator({
    llm,
    soulCodec: PERSONA_SOUL_CODEC,
  });
  ctx.contentPersonaGeneratorAuthority =
    new PersonaGeneratorCommandReceiver(personaGenerator);
  const publishCardExit: PublishCardExitPort =
    serviceModeFromEnv() === 'content'
      ? new PublishCardExitHttpClient(
          new InternalHttpClient(
            readEnvString('AIDCP_API_URL') ?? `http://127.0.0.1:${DEFAULT_API_INTERNAL_API_PORT}`,
          ),
          requirePublishApprovalInternalToken(),
        )
      : localPublishCardExit;
  // ── Block④ 三仓提取 · 批次 0d：以下句柄只被本段消费，已从 segA 下沉到此 ──────────────
  // 判据三条全中才搬：① segA 赋值 ② 只有本段读 ③ **segA 自己不再引用它**。
  // segA 仍引用的一律留在 segA（含声明前就被惰性回调捕获的**前向引用**，那类最阴）。
  // 发布链 token 账号归属（change parallel-rewrite-drafts 显式归账）：每个发布角色的 LLM 调用从当轮黑板
  // 显式带 accountId（BasePublishRole.accountIdFrom），并发生成各轮各归各账。原「当前发布账号」进程级
  // 单槽已退役——红线：MUST NOT 重新引入共享可变槽推断当前账号（并发轮互踩记账）。
  // 把共享文本客户端按角色绑定成 thin wrapper（发布侧用）：只补 role，账号由调用方显式携带。
  const roleLlm = (roleId: string): ChatLlmClient => ({
    complete: (prompt, opts) => llm.complete(prompt, { ...opts, role: opts?.role ?? roleId }),
    chat: (messages, opts) => llm.chat(messages, { ...opts, role: opts?.role ?? roleId }),
  });
  // 去 AI 味后处理器
  const postProcessor = new PostProcessor({
    rewrite: async (content, flagged, accountId) => {
      // change publish-prompt-preview：prompt 抽到 buildDeAiRewritePrompt（与后台只读预览同一份来源、防漂移）；
      // 带 role='publish:ContentCleaner' 使该重写按其后台模型/温度配置解析（否则配了是静默 no-op）。
      // change raise-model-call-timeouts-for-thinking-models：与 ContentCleaner 角色闸共用 CLEAN_TIMEOUT_MS，
      // 使该 complete() 的超时不短于角色闸（外层秒表绝不短于所包裹的模型预算、且底层 HTTP 同时限被真正中止）。
      // change parallel-rewrite-drafts：显式带 accountId（由 ContentCleanerRole 从当轮黑板穿入）——
      // 该调用不经 roleLlm 包装，是发布链归账覆盖面上唯一的非角色调用点。
      return llm.complete(buildDeAiRewritePrompt(content, flagged), {
        role: 'publish:ContentCleaner',
        timeoutMs: CLEAN_TIMEOUT_MS,
        accountId,
      });
    },
  });

  // 通义万相客户端（图片生成）。万相文生图与 Qwen 同属阿里云百炼、同一 DashScope key——
  // 未单设 WANXIANG_API_KEY 时回退 DASHSCOPE_API_KEY（已实测该 key 可提交万相 wanx-v1 任务并产出 OSS 图）。
  const wanxiangClient = new WanxiangClient({
    apiKey: readEnvString('WANXIANG_API_KEY') ?? dashscopeApiKey,
    getModel: () => imageModelSelection.current().imageModel,
    // 慢图容忍：轮询次数 env 可调（默认 34×5s=170s；须 < ImageGenerator 角色闸 200s）。change publish-image-required-or-fail。
    maxPollAttempts: Number(process.env.AIDCP_WANXIANG_MAX_POLL ?? 34),
  });

  // 即梦-Seedream 客户端（图片生成，火山方舟 Ark 同步）。change image-provider-volcengine-seedream：
  // 复用启动期已载入的火山 key+base（providerRuntime['volcengine']，与文本火山同源）；imageModel 热加载。
  const arkRuntime = providerRuntime['volcengine'];
  const seedreamClient = new SeedreamClient({
    apiKey: arkRuntime?.apiKey || undefined,
    baseUrl: arkRuntime?.baseUrl || undefined,
    getModel: () => imageModelSelection.current().imageModel,
    timeoutMs: Number(process.env.AIDCP_SEEDREAM_TIMEOUT_MS ?? 60_000),
  });

  // 图片出口：按全局 image_provider 路由（dashscope→万相、volcengine→即梦 Seedream），热加载、缺密钥诚实失败不跨厂商兜底。
  const imageProvider = new RoutingImageProvider({
    getProvider: () => imageModelSelection.current().imageProvider,
    providers: { dashscope: wanxiangClient, volcengine: seedreamClient },
  });

  // 发布编排器（PublishOrchestrator）。change decouple-publish-generation-from-dispatch：
  // 编排只跑生成候审段（生成终稿 + 落库待审 + 发审批卡），**不再让位浏览**、**不再内联等审**——
  // 让位/续场与真正下发已下放到 PublishDispatcher（下方构造，由人审授权触发）。
  // change raise-model-call-timeouts-for-thinking-models：总闸默认 180s → 600s，须 ≥ 关键路径各模型角色预算之和
  // （容器不得小于内容物；旧 180s < scout+content 串行和 210s，慢跑会中途掐断并丢弃已付费产出）。env 可调、下限保护。
  const publishOrchestrator = new PublishOrchestrator({
    logger: console,
    pipelineTimeoutMs: normalizeTimeoutMs(process.env.AIDCP_PUBLISH_PIPELINE_TIMEOUT_MS, 600_000),
    // 角色执行日志写入口（死表 publish_pipeline_logs 激活）：每角色每次执行 best-effort 落一行。
    pipelineLogSink,
  });

  ctx.imageProvider = imageProvider;
  ctx.publishOrchestrator = publishOrchestrator;

  // 用量上报接线点②（视觉 LLM 出口）content 段副本：与 segC textcard-OCR 的同名闭包同源（各段自持、都写 TokenUsageStore）。
  const recordVisionCall = (info: VisionCallInfo): void => {
    console.log(
      `[llm] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} ms=${info.ms} ok=${info.ok} tokens=${info.totalTokens ?? 0}`,
    );
    try {
      tokenUsageStore.add(info);
    } catch {
      /* metrics never breaks llm */
    }
  };

  // ── 封面形态链路装配（change textcard-cover-form）：双旗标默认关，全关=与现版逐字一致 ──
  // 感知旗标 AIDCP_COVER_FORM_SENSING 只门控视觉调用；渲染旗标 AIDCP_PUBLISH_TEXTCARD_COVER 只门控决策+渲染。
  // 感知开+渲染关 = 影子模式（注解与审计照落、封面照走生成式），面板核准确率后再放行渲染。
  const coverFormVision = new OpenAiCompatVisionClient({
    // v1 模型解析两层收敛（design D5 评审修正）：env → 代码默认；绝不进按角色文本解析/全局文本模型回落层。
    getModel: resolveCoverFormModel,
    getProvider: resolveCoverFormProvider,
    providerRuntime,
    onCall: recordVisionCall,
  });
  const coverFormSensor = createCoverFormSensor({
    vision: coverFormVision,
    enabled: () => process.env.AIDCP_COVER_FORM_SENSING === 'true',
    // 回写缓存：素材库可用才接（历史空行/无库时感知照跑、只是不缓存）。单条 UPDATE 带锚守卫，绝不 bump updated_at。
    ...(curatedContentStore
      ? { annotate: curatedContentStore.annotateReferenceImageFormGuess.bind(curatedContentStore) }
      : {}),
    getModel: resolveCoverFormModel,
    getProvider: resolveCoverFormProvider,
  });
  // 整组视觉反推使用独立模型解析与旗标；默认关闭。角色恒写键，开后缓存到精选行且不抬 updated_at。
  const referenceVisualVision = new OpenAiCompatVisionClient({
    getModel: resolveReferenceVisualModel,
    getProvider: resolveReferenceVisualProvider,
    providerRuntime,
    onCall: recordVisionCall,
    timeoutMs: Number(process.env.AIDCP_REFERENCE_VISUAL_TIMEOUT_MS ?? 120_000),
  });
  const visualReferenceAnalyzer = createVisualReferenceAnalyzer({
    vision: referenceVisualVision,
    enabled: () => process.env.AIDCP_REFERENCE_VISUAL_ANALYSIS === 'true',
    getModel: resolveReferenceVisualModel,
    getProvider: resolveReferenceVisualProvider,
    ...(curatedContentStore
      ? { annotate: curatedContentStore.annotateReferenceVisualAnalysis.bind(curatedContentStore) }
      : {}),
    logger: console,
  });
  const visualAuditVision = new OpenAiCompatVisionClient({
    getModel: resolveVisualAuditModel,
    getProvider: resolveVisualAuditProvider,
    providerRuntime,
    onCall: recordVisionCall,
    timeoutMs: Number(process.env.AIDCP_VISUAL_AUDIT_TIMEOUT_MS ?? 60_000),
  });
  const visualFidelityAuditor = createVisualFidelityAuditor({ vision: visualAuditVision });
  // 帖级形态档服务（change textcard-carousel-form-parity，阶段0 影子）：AIDCP_POST_FORM_PROFILE 默认关。
  // 开=CoverCardWriter 复用封面感知结果 + 对内页 senseAt 有界并发判形、只把形态档写审计（不改渲染）；关=不计算、byte-identical。
  // 依赖感知旗标 AIDCP_COVER_FORM_SENSING（senseAt 受同一 enabled 门控；感知关时形态档恒 generative）。
  const postFormProfileService = createPostImageFormProfileService({
    senseAt: (ref, arrayIndex) => coverFormSensor.senseAt!(ref, arrayIndex),
    enabled: () => process.env.AIDCP_POST_FORM_PROFILE === 'true',
    logger: console,
  });
  // 渲染出口：lazy 工厂只在渲染旗标开时初始化（关=零加载零成本）；工厂失败→null，text_card 请求诚实降级生成式。
  // change textcard-carousel-form-parity 阶段1：轮播旗标也触发加载（任一渲染旗标开即需渲染出口）。
  let textCardRenderer: TextCardRenderer | null = null;
  if (process.env.AIDCP_PUBLISH_TEXTCARD_COVER === 'true' || process.env.AIDCP_PUBLISH_TEXTCARD_CAROUSEL === 'true') {
    void createTextCardRenderer({ logger: console })
      .then((r) => {
        textCardRenderer = r;
        console.log(r ? '[aidcp-cloud] 文字卡渲染出口已就绪（satori+resvg+字体校验通过）' : '[aidcp-cloud] 文字卡渲染出口不可用（工厂返回 null），封面按生成式降级');
      })
      .catch((err) => {
        console.warn('[aidcp-cloud] 文字卡渲染工厂异常（封面按生成式降级）:', (err as Error).message);
      });
  }

  // 注册发布编排器的生产段角色（A 阶段2 细拆：6→11，下游 Gatekeeper/Executor 不变）。
  // 注册顺序无关正确性（黑板靠键就绪触发），按拓扑排列便于阅读。
  publishOrchestrator.registerRole(new ContentScoutRole({ llmClient: roleLlm('publish:ContentScout') }));
  publishOrchestrator.registerRole(new ContentTypeSelectorRole());
  publishOrchestrator.registerRole(new ContentCreatorRole({ llmClient: roleLlm('publish:ContentCreator') }));
  publishOrchestrator.registerRole(new ReferenceAnalyzerRole({ llmClient: roleLlm('publish:ReferenceAnalyzer') }));
  publishOrchestrator.registerRole(new FaithfulRewritePlannerRole({ llmClient: roleLlm('publish:FaithfulRewritePlanner') }));
  publishOrchestrator.registerRole(new FaithfulDraftWriterRole({ llmClient: roleLlm('publish:FaithfulDraftWriter') }));
  publishOrchestrator.registerRole(new FidelityAuditorRole({ llmClient: roleLlm('publish:FidelityAuditor') }));
  // 配图三角色（change publish-multi-image）：选题（ImageSetPlanner）→ 指令（ImagePromptComposer）→ 执行（ImageGenerator）→ 封面（CoverSelector）
  // 选题读正文定张数+主题（配强模型）；指令把主题翻成万相 prompt（配便宜模型）；执行并行出多图；封面恒取首张。
  // 品类判定（change category-adaptive-images-and-judgment）：读正文判品类，供配图选题风格档 + 质量评审复用；flash 可后台配。
  publishOrchestrator.registerRole(new CategoryClassifierRole({ llmClient: roleLlm('publish:CategoryClassifier') }));
  publishOrchestrator.registerRole(new VisualReferenceAnalyzerRole(visualReferenceAnalyzer, { logger: console }));
  // 封面形态决策（textcard-cover-form）：恒写 coverCardPlan（composer waitAll 三键依赖）；门禁序内感知独立于渲染旗标（影子模式）。
  publishOrchestrator.registerRole(new CoverCardWriterRole({
    llmClient: roleLlm('publish:CoverCardWriter'),
    sensor: coverFormSensor,
    // 帖级形态档影子服务（change textcard-carousel-form-parity，阶段0）：旗标关时不计算、byte-identical。
    profileService: postFormProfileService,
    // 渲染门（gate 3）：封面卡或轮播任一旗标开即放行决策+文案；轮播旗标（阶段1）门控 all_text_card 整帖多卡渲卡。
    renderEnabled: () => process.env.AIDCP_PUBLISH_TEXTCARD_COVER === 'true' || process.env.AIDCP_PUBLISH_TEXTCARD_CAROUSEL === 'true',
    carouselEnabled: () => process.env.AIDCP_PUBLISH_TEXTCARD_CAROUSEL === 'true',
    rendererAvailable: () => textCardRenderer !== null,
    getTextCardRenderer: () => textCardRenderer,
    ossAvailable: () => !!ossUploader,
  }));
  publishOrchestrator.registerRole(new ImageSetPlannerRole({ llmClient: roleLlm('publish:ImageSetPlanner') }));
  publishOrchestrator.registerRole(new ImagePromptComposerRole({ llmClient: roleLlm('publish:ImagePromptComposer') }));
  if (facebookPublishMediaStore) {
    publishOrchestrator.registerRole(new FacebookMediaSelectorRole({
      mediaStore: facebookPublishMediaStore,
      logger: console,
    }));
  }
  publishOrchestrator.registerRole(new ImageGeneratorRole({
    imageProvider,
    getProvider: () => imageModelSelection.current().imageProvider,
    getModel: () => imageModelSelection.current().imageModel,
    // 用量上报接线点③（图片生成出口）：经 TokenUsageStore 单一接口写归 aidcp-content 的 llm_token_usage，MUST NOT 直写（方案 §4.6.6）。
    usageRecorder: (info) => {
      console.log(
        `[image] account=${info.accountId} role=publish:ImageGenerator provider=${info.provider} model=${info.model} ok=${info.ok}`,
      );
      try {
        tokenUsageStore.add({
          accountId: info.accountId,
          role: 'publish:ImageGenerator',
          provider: info.provider,
          model: info.model,
          ok: info.ok,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        });
      } catch {
        /* metrics never breaks image generation */
      }
    },
    // change image-provider-volcengine-seedream：注入路由图片出口（按 image_provider 分发万相/即梦）。
    // 任一图片厂商密钥就绪即启用；选中厂商缺密钥时其客户端诚实失败（M 少一张、不假成功）。
    // 并行多图张数/每图超时/并发经 env 读取（AIDCP_PUBLISH_MAX_IMAGES/PER_IMAGE_TIMEOUT_MS/IMAGE_CONCURRENCY）。
    enableImageGeneration: anyImageKeyPresent,
    // change cloud-oss-storage-integration：注入 OSS 转存出口（配了凭据才有；缺则 undefined = 配图零回归用 provider URL）。
    // 生成成功后逐张转存 OSS 换稳定公网 URL，根治「审批超 provider TTL → 死链」；转存失败诚实落空、不伪造 URL。
    ossUploader,
    // change textcard-cover-form：文字卡渲染出口（工厂异步就绪故取 getter）；执行器只读 plan+依赖可用性，不二次读旗标。
    getTextCardRenderer: () => textCardRenderer,
    visualAuditor: visualFidelityAuditor,
    auditEnabled: () => process.env.AIDCP_VISUAL_FIDELITY_AUDIT === 'true',
    autonomousAuditEnabled: () => process.env.AIDCP_AUTONOMOUS_VISUAL_AUDIT === 'true',
  }));
  publishOrchestrator.registerRole(new CoverSelectorRole());
  // 后处理：清洗（ContentCleaner）→ AI味分（AiFlavorScorer）/ 质量分（QualityScorer）
  publishOrchestrator.registerRole(new ContentCleanerRole({ postProcessor }));
  publishOrchestrator.registerRole(new AiFlavorScorerRole());
  publishOrchestrator.registerRole(new QualityScorerRole({ llmClient: roleLlm('publish:QualityScorer') }));
  // 汇合：瘦身 ContentAssembler（纯组装，waitAll 五键）
  publishOrchestrator.registerRole(new ContentAssemblerRole());
  // 标题链路：定稿后单独生成标题（watch assembledContent → titleSelection）；发布门 waitAll 依赖此键（注册顺序无关）。
  publishOrchestrator.registerRole(new TitleCreatorRole({ llmClient: roleLlm('publish:TitleCreator') }));
  // 阶段3 元数据 + 合规决策（并行于发布链，规则式确定性；产出 publishMetadata，本阶段不应用到边缘）。
  // change split-topic-roles：话题拆生成/评判两角色（生成 watch assembledContent、评判 watch topicCandidates、产出 topicSelection）。
  publishOrchestrator.registerRole(new TopicGeneratorRole({ llmClient: roleLlm('publish:TopicGenerator') }));
  publishOrchestrator.registerRole(new TopicEvaluatorRole({ llmClient: roleLlm('publish:TopicEvaluator') }));
  publishOrchestrator.registerRole(new MentionStrategistRole());
  publishOrchestrator.registerRole(new LocationStrategistRole());
  publishOrchestrator.registerRole(new CollectionStrategistRole());
  publishOrchestrator.registerRole(new VisibilityDeciderRole());
  publishOrchestrator.registerRole(new PermissionDeciderRole());
  publishOrchestrator.registerRole(new PublishModeDeciderRole());
  publishOrchestrator.registerRole(new ComplianceDeciderRole());
  publishOrchestrator.registerRole(new MetadataAggregatorRole());
  publishOrchestrator.registerRole(new ApprovalGatekeeperRole({ llmClient: roleLlm('publish:ApprovalGatekeeper') }));
  publishOrchestrator.registerRole(new PublishExecutorRole({
    store: {
      async insert(record) {
        return publishLogWriter.insert({
          title: record.title,
          content: record.content,
          // 真血缘：用 executor 计算的真概念/真点赞 id（无则空数组），不再用 tags / [] 充数（修 stage-4 适配器漏接）。
          sourceConcepts: record.sourceConcepts ?? [],
          sourceLikedIds: record.sourceLikedIds ?? [],
          // decouple-publish-generation-from-dispatch：生成候审段落 'pending_approval'（待人审、未下发）。
          status: record.status as 'draft' | 'pending_approval' | 'scheduled' | 'submitted' | 'published' | 'failed' | 'needs_review',
          // 审计用 image_url（封面=首张）+ 多图全集 images（下发段读回逐张上传）；真实附着数插入时 0，上传成功后由 markImagesAttached 置真实 K。
          imageUrl: record.imageUrl,
          imageUrls: record.images,
          // 真实发布账号（change publish-history-account-and-detail）：来自触发上下文，缺省 'default'。
          accountId: record.accountId,
          platform: record.platform,
          // 参照洗稿来稿快照；普通发布为空，内容页据此展示来源。
          sourceReference: record.sourceReference ?? null,
        });
      },
      async updateStatus(id, status) {
        await publishLogWriter.updateStatus!(id, status as 'draft' | 'pending_approval' | 'scheduled' | 'submitted' | 'published' | 'failed' | 'needs_review');
      },
      // stage-4 元数据落库 + 防篡改审计（供下发段重建发布输入 + 审计）。
      async recordMetadata(id, metadata, aiEnforced) {
        await publishLogWriter.recordMetadata!(id, metadata, aiEnforced);
      },
      // 配图收口：如实标记真实附着张数 K（生成段无图诚实 failed 时传 0），杜绝纯文字帖留「有图」假信号。
      async markImagesAttached(id, count) {
        await publishLogWriter.markImagesAttached!(id, count);
      },
    },
    // change feishu-contract-seam（§4.6.2）：业务侧只交结构化数据，属主侧构飞书卡 + 发送。
    // change cloud-batch2-content-main：发卡 / 默认群 / 落点解析（来源会话 → 账号团队群 → 默认群）/
    // 免审预授权四样已收进同一个端口，实现全在属主域，本段只调 —— 同一个对象喂给这几个入参。
    messenger: publishCardExit,
    botChatStore: publishCardExit,
    resolveCardChatId: publishCardExit.resolveCardChatId,
    resolveReviewCardDelivery,
    // change cloud-batch2-content-main：**不再由本段传账号展示名**。它是 api 的事实、读它是同步调用，
    // 而卡片契约里这个字段本就可选、缺它回落账号 id ⇒ 由属主侧构卡前自己解析（见 publishCardExit）。
    // 排期免审预授权（content-schedule）：与人工审批**同一个**授权写出口，决策主体 = 触发该免审的排期规则。
    writeApprovalSignal: publishCardExit.writeApprovalSignal,
    // 陪伴界面（edge-companion-ui 8.1）：候审即推 pending（发布卡自动展开到「等你确认」）。
    notifyPublishPending: (accountId, recordId, title) =>
      {
        // 一次通知里的两次推送共用一次取用：缺席只喊一次，别把同一个事实记两条。
        const uiSnapshot = crossSegment(
          ctx.uiSnapshot,
          `账号 ${accountId} 稿件 ${recordId} 的候审界面推送`,
          '自动化段',
          '客户端不会自动展开到「等你确认」，须由自动化进程侧承接推送',
        );
        uiSnapshot?.pushPublishState(accountId, recordId, 'pending', title);
        // change cloud-batch2-content-main：取用不到就到此为止，**不再去读那次预览**。
        // 预览的唯一消费者就是上面这个界面推送口；它缺席时读回来的东西没有任何去处，
        // 而那是一次 api 属主表的查询 —— content 拆成独立进程后会变成一次跨进程读，
        // 为一个恒缺席的消费者开一条跨进程契约是纯亏。单体下 uiSnapshot 恒在，行为逐字不变。
        if (!uiSnapshot) return;
        void pendingPublishPreviewForAccount(accountId).then((preview) => {
          if (!preview) return;
          uiSnapshot?.pushPublishPreview(accountId, {
            recordId: preview.id,
            code: `#${preview.id}`,
            kind: preview.kind,
            title: preview.title ?? '',
            content: preview.content,
            topics: preview.topics,
            images: preview.images,
            contentVersion: preview.contentVersion,
            updatedAt: preview.updatedAt,
            ...(preview.imageReferenceAudit ? { imageReferenceAudit: preview.imageReferenceAudit } : {}),
          });
        }).catch((err) => console.warn(`[ui-snapshot] 预览读取失败 recordId=${recordId}: ${err instanceof Error ? err.message : String(err)}`));
      },
    // decouple-publish-generation-from-dispatch：executor 只落库待审 + 发审批卡，不再内联等审/下发，
    // 故不再注入 sequencer / isApproved / approvalWaitMs / pusher。超时只覆盖落库+发卡（默认 30s）。
    roleTimeoutMs: Number(process.env.AIDCP_PUBLISH_ROLE_TIMEOUT_MS ?? 30_000),
  }));
  console.log(`[aidcp-cloud] PublishOrchestrator 已就绪，角色: ${publishOrchestrator.getRoles().join(', ')}`);
}

async function segCAutomation(ctx: CompositionContext): Promise<void> {
  const { accountDisplayName, accountState, accountStore, apiPool, automationPool, cache, categoryConfigStore, clientUserStore, conceptStore, configMirrorPool, contentScheduleStore, curatedContentStore, delegatedTaskService, delegatedTaskStore, deploymentTarget, draftRefinementStore, eventBus, facebookCommentAuditStore, facebookCommentConfigStore, facebookGroupJoinAuditStore, facebookGroupJoinAutomationStore, facebookGroupMembershipStore, facebookGroupTargetStore, facebookPublishMediaStore, firstPostOnboardingStore, getSoul, hotLeadConfigStore, imageProvider, llm, manualCommentAccounts, mirrorVersionStore, modelConfigStore, ossUploader, pacingConfigStore, personaAutoFillStore, personaPanel, personaStore, planner, port, providerRuntime, publishApprovalAuthority, publishApprovalDecisionWriter, publishApprovalStore, publishLogStore, quotaConfigStore, resolvePersona, resumeConfigStore, roleConfigStore, sessionConfigStore, tokenUsageStore } = ctx;
  const seamMode = serviceModeFromEnv();
  let apiDirectPorts = ctx.apiDirectAuthorities ?? {};
  if (seamMode === 'automation') {
    const apiUrl = readEnvString('AIDCP_API_URL');
    if (!apiUrl) throw new Error('AIDCP_API_URL is required in automation mode');
    if (!deploymentTarget) {
      throw new Error('AIDCP_DEPLOY_ENV is required in automation mode');
    }
    const token = requireDirectInternalToken('AIDCP_API_INTERNAL_TOKEN');
    const http = new InternalHttpClient(apiUrl);
    apiDirectPorts = {
      accountRoster: new AccountRosterHttpClient(http, token, deploymentTarget),
      accountOwnership: new AccountOwnershipHttpClient(http, token, deploymentTarget),
      accountRuntime: new AccountRuntimeHttpClient(http, token, deploymentTarget),
      publishLog: new AutomationPublishLogHttpClient(http, token, deploymentTarget),
      edgePublish: new EdgePublishCommandHttpClient(http, token, deploymentTarget),
      interactionAuth: new InteractionAuthHttpClient(http, token, deploymentTarget),
      interactionApiWrites: new InteractionApiWritesHttpClient(http, token, deploymentTarget),
      replyConfig: new ReplyConfigResolverHttpClient(http, token, deploymentTarget),
      accountPersona: new AccountPersonaHttpClient(http, token, deploymentTarget),
      environmentHandshake: new EnvironmentHandshakeHttpClient(http, token, deploymentTarget),
      commentApprovalPolicy: new CommentApprovalPolicyHttpClient(http, token, deploymentTarget),
      notificationContacts: new NotificationContactsHttpClient(http, token, deploymentTarget),
      firstPostProgress: new FirstPostProgressHttpClient(http, token, deploymentTarget),
      automationConfigCommands: new AutomationConfigCommandsHttpClient(
        http,
        token,
        deploymentTarget,
      ),
      offboardAdmissionLedger: new OffboardAdmissionLedgerHttpClient(
        http,
        token,
        deploymentTarget,
      ),
      notificationDelivery: new StructuredNotificationHttpClient(
        http,
        token,
        deploymentTarget,
      ),
    };
  }
  const automationPublishLog = apiDirectPorts.publishLog;
  if (!automationPublishLog) {
    throw new Error('automation_publish_log_authority_unavailable');
  }
  const deliverStructuredNotification = async (
    notification: Parameters<StructuredNotificationDeliveryPort['deliver']>[0]['notification'],
    commandId: string = randomUUID(),
  ): Promise<void> => {
    const delivery = apiDirectPorts.notificationDelivery;
    if (!delivery) throw new Error('structured_notification_delivery_authority_unavailable');
    const result = await delivery.deliver({ commandId, notification });
    if (result.outcome === 'delivered') return;
    if (result.outcome === 'unknown') {
      throw new Error('structured_notification_delivery_result_unknown');
    }
    throw new Error(`structured_notification_not_delivered:${result.reason}`);
  };
  const approvalAuthorityForAutomation: PublishApprovalAuthorityPort | undefined =
    seamMode === 'automation'
      ? new PublishApprovalAuthorityHttpClient(
          new InternalHttpClient(
            readEnvString('AIDCP_API_URL') ?? `http://127.0.0.1:${DEFAULT_API_INTERNAL_API_PORT}`,
          ),
          requirePublishApprovalInternalToken(),
        )
      : publishApprovalAuthority;
  const publishApprovalClient = approvalAuthorityForAutomation
    ? createPublishApprovalClient(approvalAuthorityForAutomation, deploymentTarget)
    : undefined;
  const approvalDecisionWriterForAutomation: PublishApprovalDecisionWriterPort | undefined =
    seamMode === 'automation'
      ? new PublishApprovalDecisionWriterHttpClient(
          new InternalHttpClient(
            readEnvString('AIDCP_API_URL') ?? `http://127.0.0.1:${DEFAULT_API_INTERNAL_API_PORT}`,
          ),
          requirePublishApprovalInternalToken(),
        )
      : publishApprovalDecisionWriter;
  const writeApprovalDecision = (
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
    context: ApprovalDecisionContext,
  ) => {
    if (!approvalDecisionWriterForAutomation || !deploymentTarget) {
      throw new Error('approval_decision_writer_unavailable');
    }
    return approvalDecisionWriterForAutomation.writeDecision({
      requestId,
      approved,
      payload,
      context,
      executionTarget: deploymentTarget,
    });
  };
  // ── Block④ 三仓提取 · 批次 0d：以下句柄只被本段消费，已从 segA 下沉到此 ──────────────
  // 判据三条全中才搬：① segA 赋值 ② 只有本段读 ③ **segA 自己不再引用它**。
  // segA 仍引用的一律留在 segA（含声明前就被惰性回调捕获的**前向引用**，那类最阴）。
  // 点赞笔记存储（liked_notes 表，发帖来源血缘）。init 失败留 undefined（血缘退化、不阻塞启动）。
  let likedNoteStore: LikedNoteStore | undefined;
  try {
    const ls = new LikedNoteStore({
      pool: automationPool,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await ls.init();
    likedNoteStore = ls;
    console.log('[aidcp-cloud] LikedNoteStore 已就绪（liked_notes 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] LikedNoteStore 初始化失败，来源血缘退化:', (err as Error).message);
  }
  // 优质评论语料库（valuable_comments 表，comment-like-on-detail B）。
  // init 失败留 undefined（语料库退化：不归档、撰写不注入参考，不崩闭环）。
  let valuableCommentStore: ValuableCommentStore | undefined;
  try {
    const vs = new ValuableCommentStore({
      pool: automationPool,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await vs.init();
    valuableCommentStore = vs;
    console.log('[aidcp-cloud] ValuableCommentStore 已就绪（valuable_comments 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] ValuableCommentStore 初始化失败，评论语料库退化:', (err as Error).message);
  }
  // 面板互动流展示账本（change interaction-feed-enrichment）。init 失败留 undefined（面板互动表退化为空、绝不崩闭环）。
  let interactionFeedStore: InteractionFeedStore | undefined;
  try {
    const ifs = new InteractionFeedStore({
      pool: automationPool,
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await ifs.init();
    interactionFeedStore = ifs;
    console.log('[aidcp-cloud] InteractionFeedStore 已就绪（interaction_feed / interaction_target_meta 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] InteractionFeedStore 初始化失败，面板互动流退化:', (err as Error).message);
  }
  // 「本账号最近观测到的笔记内容」缓存（change curated-inspiration-corpus）：collect 通常在 note.detail 之后、
  // 同访问内发生，自有收藏自动纳入精选时据此补建正文。仅留最近一条/账号，内存态、丢失无害（取不到则不补建空正文壳行）。
  const lastObservedNoteByAccount = new Map<
    string,
    {
      noteId: string;
      title: string;
      body: string;
      mediaType: 'image_text' | 'video';
      author?: string;
      sourceUrl?: string;
      topics: string[];
      likeCount: number;
      collectCount: number;
      referenceImages: CuratedReferenceImageInput[];
      publishedAtText?: string;
      publishedObservedAt?: number;
    }
  >();
  const onCommentTakeoverStart = (accountId: string): void => {
    manualCommentAccounts.add(accountId);
  };
  const onCommentTakeoverEnd = (accountId: string): void => {
    manualCommentAccounts.delete(accountId);
  };
  const resolveEffectiveCommentApprovalMode = async (
    accountId: string,
    sourceMode: 'review' | 'auto_approve',
  ): Promise<'review' | 'auto_approve'> => {
    const policy = apiDirectPorts.commentApprovalPolicy;
    if (!policy) {
      console.warn(
        `[approval-policy] 评论策略 authority 未接线，fail-closed 为 review account=${accountId}`,
      );
      return 'review';
    }
    try {
      const accountMode: AccountCommentApprovalMode =
        await policy.getAccountCommentMode(accountId);
      return accountMode === 'auto_approve_all' ? 'auto_approve' : sourceMode;
    } catch (error) {
      console.warn(
        `[approval-policy] 评论策略读取失败，fail-closed 为 review account=${accountId} sourceMode=${sourceMode}: ${(error as Error).message}`,
      );
      return 'review';
    }
  };
  // RiskController 注册表（V1 task 9.1）：每账号一个 controller、单写 PER ACCOUNT、共享 PgRiskStore。
  // 现役路径用其 default controller（单一来源，避免双 controller 写同一 risk_state）；PG 不可用则现役回退内存态。
  // PgRiskStore 单例：既喂 registry（按账号风控单写），又作 InteractionStore 接线孤儿
  // risk_interactions 去重表（V1 task 9.2，按笔记互动历史）。
  // 风控告警出口（change risk-state-cross-process-integrity）：alertStore 在本处之后才构造，
  // 故先声明一个后绑定的 sink——闭包在事件真正发生时才读它。**绝不因为告警链路没就绪就静默**：
  // sink 未就绪时照样 console.warn，可检索性降级但不消失。
  let riskAlertSink: Pick<PgAlertStore, 'raise'> | undefined;
  const raiseRiskAlert = async (input: {
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    type: string;
    accountId?: string;
    title: string;
    detail: string;
  }): Promise<void> => {
    console.warn(`[aidcp-cloud][risk] ${input.title} — ${input.detail}`);
    if (!riskAlertSink) return;
    try {
      await riskAlertSink.raise(input);
    } catch (err) {
      console.warn(`[aidcp-cloud][risk] 告警落库失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // 启动期告警（写者锁抢不到 → 立即退出）：此刻 alertStore 尚未构造，且我们马上就要 exit，
  // 故临时开一条连接把这条 P1 写进去再走。写不进去也照退——诚实失败优于静默双写。
  //
  // Block③ L3：`alerts` 属 automation ⇒ 连接配置改由 owner resolver 给（原为裸 PGHOST/… HOST-param，
  // 那套**无视 `DATABASE_URL`**、也不会跟着 owner URL 走）。
  // ⚠️ 这一处**故意仍自建一个专用小池**、不注入共享 `automationPool`：下面 `finally` 里调 `store.close()`
  //    （= `pool.end()`），注入共享池会把整个 automation 池 end 掉、连带打死其余十几个 store
  //    —— 与 `7f5232a` 修掉的那个 bug 同形。专用池由本函数独占、随 close 释放，才是对的。
  const raiseStandaloneAlert = async (input: {
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    type: string;
    title: string;
    detail: string;
  }): Promise<void> => {
    const store = new PgAlertStore({
      pool: new pg.Pool({ ...resolveOwnerPgConfig('automation'), max: 1 }),
    });
    try {
      await store.init();
      await store.raise(input);
    } catch (err) {
      console.error(`[aidcp-cloud] 启动期告警写入失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await store.close().catch(() => undefined);
    }
  };

  // ── 自动化写者锁（change risk-state-cross-process-integrity，design D2）─────────────────
  //
  // 「承载风控写的进程对每个 executionTarget 单实例」以前只是文档纪律。这里在**建
  // RiskControllerRegistry 之前**先去数据库抢一把会话级 advisory lock：抢不到就拒绝启用风控写路径
  // 并以非零码退出，MUST NOT 降级为无锁照写。滚动 / 蓝绿部署的第二个实例会在启动阶段响亮失败，
  // 而不是安静地开始双写。
  //
  // executionTarget 缺失 / 非法 → 按拆分方案 §8 第 4 条 fail-closed：不抢锁、不启用归属强制、
  // 不启动记账 worker（parseDeploymentTarget 已 fail-closed 返回 null）。
  let writerLock: AutomationWriterLock | undefined;
  /** 写权丢失闸：一旦为真，本进程对**所有**账号拒绝互动准入（见 interactionBlockedProvider）。 */
  let writerAuthorityLost = false;
  if (!deploymentTarget) {
    console.warn(
      '[aidcp-cloud] AIDCP_DEPLOY_ENV 缺失或非法 → 不抢自动化写者锁、不启用风控归属强制、不启动记账 worker（fail-closed）',
    );
  } else {
    writerLock = new AutomationWriterLock({
      executionTarget: deploymentTarget,
      // Block③ L3：锁连接的来源收口在 resolveWriterLockConnection()——设了
      // AIDCP_PG_AUTOMATION_URL 就走连接串连 automation 属主库（与 risk_state 落地库同库），
      // 未设则逐字回落到原来这段 PGHOST/... 读法（今天生产的状态，行为零变更）。
      // ⚠️ 这里 MUST NOT 注入 automationPool：advisory lock 是**会话级**的，池回收连接即释放锁。
      // ⚠️ 也 MUST NOT 改写成把 resolveOwnerPgConfig('automation') 拆成五字段：owner URL 已设时
      //    那份 PoolConfig 只有 connectionString，五字段全 undefined 会一路落到本机默认库，
      //    「在错的库上取到锁而且会成功」——正是这把锁要防的那种失效。
      connection: resolveWriterLockConnection(),
      waitMs: readEnvNumber('AIDCP_RISK_WRITER_LOCK_WAIT_MS', 60_000),
      logger: console,
    });
    const acquired = await writerLock.acquire();
    if (!acquired.ok) {
      const title = `自动化写者锁获取失败（${deploymentTarget}），进程拒绝启动`;
      const detail =
        `${acquired.detail}。本进程 MUST NOT 在无锁状态下启用风控写路径——两个实例同时持有写权，` +
        `合计放行的真实平台动作会是单份上限的两倍，且一方刚写下的 restricted 会被另一方陈旧的 normal 盖回。` +
        `处理办法：确认 ${deploymentTarget} 上是否已有一个 aidcp-cloud 在跑（部署形态 MUST 是 stop→start，` +
        `禁止滚动 / 蓝绿）；老进程被 kill -9 后如仍占锁，按 docs/deployment-environments.md 的强制释放步骤处理。`;
      console.error(`[aidcp-cloud] ${title} — ${detail}`);
      await raiseStandaloneAlert({ severity: 'P1', type: 'risk_writer_lock_unavailable', title, detail });
      process.exit(1);
    }
    console.log(`[aidcp-cloud] 自动化写者锁已持有（target=${deploymentTarget}）`);
    // 锁连接断开 = 写权已经丢失（PostgreSQL 在会话结束时就释放了该会话持有的 advisory lock）。
    // MUST 立刻停止下发新的互动命令并告警，MUST NOT 静默继续写 risk_state。
    // 实现：置一个全局闸，让每账号的准入判定一律拒绝互动动作（浏览仍放行）——与记账 fail-closed
    // 共用同一条现读通道，覆盖是结构性的，不依赖逐处接线。
    // 记账 outbox 的 apply 刻意**不停**：risk_counters 是 append-only 的既成事实账本，
    // 停掉它只会把已经发生的动作丢掉，而丢账正是本 change 要消灭的缺陷。
    writerLock.onLost((reason) => {
      writerAuthorityLost = true;
      void raiseRiskAlert({
        severity: 'P1',
        type: 'risk_writer_lock_lost',
        title: `自动化写者锁已丢失（${deploymentTarget}），已停止下发新的互动命令`,
        detail:
          `${reason}。持锁连接断开即视为写权丢失：数据库已释放该会话的 advisory lock，` +
          `另一个实例随时可能接管。本进程已 fail-closed（互动准入一律拒绝），` +
          `MUST 重启本进程重新抢锁；MUST NOT 无锁继续运行。`,
      });
    });
  }

  // 归属跟随当次连接（change risk-target-follows-active-session）：握手无条件把 accounts.execution_target
  // 更新为当前 target；risk_state 条件写据此在「两连接并发接管同一账号」的瞬间作废先写方。
  // 有合法 target 默认启用（安全）；AIDCP_RISK_OWNERSHIP_ENFORCE=false 为秒级回滚闸——退回历史无谓词 upsert。
  const ownershipDisabled = process.env.AIDCP_RISK_OWNERSHIP_ENFORCE === 'false';
  // 归属事实的窄读写口（change risk-state-cross-process-integrity，tasks 3.1b 决议①）：
  // `accounts` 按拆分方案 §5.1 由 api 单写；automation 侧只经本口调用、绝不自己拼 accounts 的 SQL。
  // 拆进程时把这个对象换成一次内部 HTTP 即可，调用点一行不改。
  // **构造位置在 riskStore 之前**（change risk-ownership-via-port）：风控条件写的属主谓词要经本口取值，
  // 它必须先于 riskStore 存在。MUST NOT 挪回下面去——挪回去 riskStore 拿到 undefined 会静默降级成
  // 无谓词 upsert，跨 target 接管保护无声消失。
  const ownershipPort: AccountOwnershipPort | undefined =
    apiDirectPorts.accountOwnership
      ? {
          getExecutionTarget: (accountId) =>
            apiDirectPorts.accountOwnership!.getExecutionTarget(accountId),
          // 三态归属读（change risk-ownership-via-port）：风控写路径的属主谓词经此取值。
          resolveExecutionTarget: (accountId) =>
            apiDirectPorts.accountOwnership!.resolveExecutionTarget(accountId),
          // 归属跟随当次连接（change risk-target-follows-active-session）：握手用它无条件改写归属。
          setExecutionTarget: (accountId, target) =>
            apiDirectPorts.accountOwnership!.setExecutionTarget(accountId, target),
        }
      : undefined;
  // 缺归属读口 ⇒ 属主谓词无从取值 ⇒ 只能退回无谓词 upsert。这里就判掉并说明白，
  // 免得让 store 内部那道降级（同样响亮）成为唯一的告知点。
  const ownershipMode: OwnershipMode =
    !deploymentTarget || ownershipDisabled || !ownershipPort ? 'off' : 'enforce';
  console.log(
    `[aidcp-cloud] 账号归属跟随当次连接：条件写=${ownershipMode}` +
      (ownershipMode === 'off' && deploymentTarget
        ? ownershipDisabled
          ? '（AIDCP_RISK_OWNERSHIP_ENFORCE=false 已回滚为无谓词 upsert）'
          : '（未装配归属读口 → 无谓词 upsert；跨 target 接管保护不生效）'
        : ''),
  );

  // Block③ L3 翻转前置：risk_state / risk_counters / risk_interactions 都是 automation 属主表，
  // 但此前这里传裸 PG* 五参数、store 自建私池连**共享库**。一旦设 AIDCP_PG_AUTOMATION_URL，
  // 风控权威态会继续写旧共享库，而面板经已迁的 automation 读端口读新库 ⇒ 面板永远看到空/陈旧
  // 风控态且零报错（本仓红线点名的「静默假成功」形态）。故在此显式绑 automationPool。
  // 字节等价：dev/ol 的 .env 只有 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD（无 DATABASE_URL、
  // 无 AIDCP_PG_*_URL），owner resolver 回落到同一份配置 ⇒ 逐字相同（只核变量名，未读取任何值）。
  const riskStore = new PgRiskStore({
    pool: automationPool,
    schemaEnsurer: ensureCapabilitySchema,
    ...(deploymentTarget ? { executionTarget: deploymentTarget } : {}),
    ownershipMode,
    // 属主谓词的取值口（change risk-ownership-via-port）：MUST 注入，否则 enforce 自动降级为 off。
    ...(ownershipPort ? { ownershipReader: ownershipPort } : {}),
  });
  // quotaConfigStore 作 QuotaProvider 注入：每账号 controller 的 effectiveQuotas 热加载读限额数字
  // （change safety-quota-config）；init 失败时其镜像为空 → 退化派生写死默认，绝不 brick。
  // 养号冷启动配额爬坡（change disable-account-age-coldstart-ramp）：默认**关**——配额直接走安全限额
  // 配置（quota_config / quotas.ts 三档），不按账号年龄压低。仅当运维显式设 AIDCP_COLDSTART_RAMP=true 时
  // opt-in 启用逐日爬坡（effectiveQuotas=min(冷启动天花板, 风控缩放)）。provider 缺 → 该账号不叠冷启动。
  const coldStartRampEnabled = process.env.AIDCP_COLDSTART_RAMP === 'true';
  // 慢启动全局停用闸：置真 → 无视所有环境级开关与历史 env 旁路、全体不 clamp。
  // 环境级事实源由 ClientUserStore 的进程内镜像同步现读；
  // raw SQL 改库**不刷镜像**（全仓无 watch / setInterval）→ 没有此闸就没有秒级止血手段。重启即生效。
  const slowStartDisabled = process.env.AIDCP_SLOW_START_DISABLED === 'true';
  // 养号事实 provider：平台/历史 created_at 仍来自 AccountStore；显式慢启动起点只来自当前绑定环境。
  // RiskController 仍按账号单写，但不再读取 accounts.slow_start_since。
  const nurtureProvider =
    accountStore?.platformFor && accountStore.createdAtFor
      ? {
          platformFor: (accountId: string) => accountStore.platformFor!(accountId),
          slowStartSinceFor: (accountId: string) => clientUserStore.slowStartSinceFor(accountId),
          createdAtFor: (accountId: string) => accountStore.createdAtFor!(accountId),
        }
      : undefined;
  // 环境花名册（client_environments）窄回写口（change env-table-write-collection）：
  // §5.1 把该表定为 api 单写、自动化握手回写 MUST 经窄内部接口、MUST NOT 直写表。形态同上面的
  // ownershipPort——automation 侧握手闭包只持这个窄口（EnvironmentRegistryPort），实现转发到 api 侧
  // clientUserStore 的窄方法；拆进程时把这个对象换成一次内部 HTTP 即可，握手调用点一行不改。
  const environmentRegistryPort: EnvironmentRegistryPort =
    apiDirectPorts.environmentHandshake ?? {
      registerHandshakeEnvironment: () =>
        Promise.reject(new Error('environment_handshake_authority_unavailable')),
    };
  // 配置副本停手闸的单一适配器（change cloud-coupling-phase4-runtime-ports）：automation 侧的
  // handler / dispatcher / 风控三处都注入这一个对象。四个实参就是 api 侧那四个模块函数——它们在
  // **调用时**才读 ambient 事实源，故本适配器可以在镜像刷新器 start() 之前构造，无时序问题。
  const configMirrorGate: ConfigMirrorGatePort = {
    isStale: (mirrorKey) => isMirrorStale(mirrorKey),
    hasStaleGateMirror: () => hasStaleGateMirror(),
    platformActionHalt: (context) => platformActionHalt(context),
    noteStaleRefusal: (mirrorKey, context) => noteMirrorStaleRefusal(mirrorKey, context),
  };
  // 记账漏斗先声明后构造：registry 的 fail-closed 现读要读它，而它要读 registry 解析 controller。
  let riskAccounting: RiskAccounting | undefined;
  const riskRegistry = new RiskControllerRegistry(riskStore, undefined, quotaConfigStore, {
    coldStartRampEnabled,
    slowStartDisabled,
    nurtureProvider,
    mirrorStale: (mirrorKey) => configMirrorGate.isStale(mirrorKey),
    // 记账断链 ⇒ 该账号的一切互动准入判定直接拒（浏览仍放行）。闸设在 explain 是因为它是
    // 全部自动路径的公共必经点，新加一道独立闸必然漏接线。
    interactionBlockedProvider: (accountId) => writerAuthorityLost || (riskAccounting?.isBlocked(accountId) ?? false),
    ...(deploymentTarget ? { executionTarget: deploymentTarget } : {}),
    // 条件写因并发接管被拒 → 驱逐本地缓存 + 告警（change risk-target-follows-active-session）。
    onOwnershipAlert: (info) => {
      void raiseRiskAlert({
        severity: 'P1',
        type: 'risk_controller_evicted_not_owned',
        accountId: info.accountId,
        title: `账号 ${info.accountId} 的风控写被拒（账号已被另一连接接管），已驱逐本地缓存控制器`,
        detail: info.detail,
      });
    },
    logger: console,
  });
  console.log(`[aidcp-cloud] 冷启动配额爬坡 ${coldStartRampEnabled ? '已开启(AIDCP_COLDSTART_RAMP=true)' : '已禁用(默认·直接走安全限额配置)'}`);
  if (slowStartDisabled) {
    console.log('[aidcp-cloud] 环境级慢启动 已被全局停用(AIDCP_SLOW_START_DISABLED=true·无视所有环境开关)');
  }
  // retire-default-account：不再建单租户全局 'default' controller；风控一律经 registry 按真实账号懒解析。
  const resolveController = (accountId: string): Promise<RiskController> => riskRegistry.getController(accountId);
  const listAccountAutomationCatalog = async (): Promise<ContentScheduleCatalogRow[]> => {
    const rows = await contentScheduleStore.listCatalog();
    return projectFacebookGroupJoinAutomationCatalog(rows, {
      getConfig: (accountId) => facebookGroupJoinAutomationStore.getForAccount(accountId),
      loadRiskDailyCap: (accountId) => resolveController(accountId)
        .then((controller) => controller.effectiveQuotas().day.join_group),
      loadScopes: (accountIds) => facebookGroupTargetStore.scopedTargetCountsForAccounts(accountIds),
      loadRecentResults: (accountIds) => facebookGroupJoinAuditStore.latestScheduledResults(accountIds),
    });
  };
  // 「唯一真实账号」解析（飞书无参 / 自动发帖用）：恰好一个真实账号 → 它，0 或多个 → null（honest-fail，绝不回落 default）。
  const resolveSingleAccountId = async (): Promise<string | null> => {
    if (!accountStore) return null;
    try {
      const all = await accountStore.listAll();
      return all.length === 1 ? all[0].accountId : null;
    } catch (err) {
      console.warn('[aidcp-cloud] resolveSingleAccountId 失败:', (err as Error).message);
      return null;
    }
  };
  console.log('[aidcp-cloud] RiskControllerRegistry 已就绪（按真实账号懒解析，PgRiskStore 持久化）');

  // ── Block② 2e：拆段传输接线 ────────────────────────────────────────────────
  //   ① 风控命令消费者——把提交侧 emit 的风控写命令，交本进程唯一的 RiskController 应用（单写落地点）。
  //   ② EventBus → outbox 桥——把本进程编排事件 tee 到 panel.event 主题，供 api 进程回放给 panel-ws。
  //      **仅当面板确实在另一个进程时才接**（判定收口在 panelEventTransportForMode）：core 下 panel-ws
  //      与产生端同进程、EventBus 直连，此处再 tee 就是往共库的生产 PG 满速率写无人消费的废行。
  //
  // **① 不再按 seamMode 分叉（change cloud-coupling-phase5 P5-1）**：面板的风控写从今天起一律走这条
  // 异步通道，monolith 也不例外。原先「monolith 不起消费者」的前提是「monolith 下没人 emit」——
  // 那个前提已经不成立。若这里仍按 seamMode 跳过，面板提交完命令**没有任何人会应用它**：
  // 操作员看到 202、状态永远不变、日志里一个字都不会提（红线：静默假成功）。
  // 一条路径、从今天起就在生产上跑，拆进程那天这里不需要任何改动。
  const panelEventTransport = panelEventTransportForMode(seamMode);
  const riskCommandService = deploymentTarget
    ? new PgRiskCommandService({ pool: automationPool, executionTarget: deploymentTarget, logger: console })
    : undefined;
  ctx.riskCommandService = riskCommandService;
  let riskCommandConsumer: RiskCommandConsumer | undefined;
  if (deploymentTarget && riskCommandService) {
    riskCommandConsumer = new RiskCommandConsumer({
      pool: automationPool,
      executionTarget: deploymentTarget,
      // 单写不变量收口在领域应用器：恢复命令只有写后真态为 normal 才解除该账号的 Edge pause。
      // 消费者只在本段末尾 EdgeCloudServer 已安装进 ctx 后启动。未执行 resume 绝不能记成成功 0。
      apply: createRiskCommandApplyHandler({
        service: riskCommandService,
        getController: (accountId) => riskRegistry.getController(accountId),
        resumeEdgesForAccount: (accountId) =>
          requireSegment(ctx.server, 'server', 'automation').resumeEdgesForAccount(accountId),
      }),
      logger: console,
    });
    const installedRiskCommandConsumer = riskCommandConsumer;
    if (seamMode !== 'monolith' && panelEventTransport.tee) {
      bridgeEventBusToOutbox({ eventBus, pool: automationPool, executionTarget: deploymentTarget, logger: console });
    }
    let panelEventReplay: PanelEventReplay | undefined;
    if (panelEventTransport.replay) {
      const apiBaseUrl = readEnvString('AIDCP_API_URL') ?? `http://127.0.0.1:${DEFAULT_API_INTERNAL_API_PORT}`;
      const delivery = new PanelEventDeliveryHttpClient(new InternalHttpClient(apiBaseUrl));
      panelEventReplay = new PanelEventReplay({
        pool: automationPool,
        executionTarget: deploymentTarget,
        sink: (event) => delivery.deliver(event),
        logger: console,
      });
      panelEventReplay.start();
    }
    console.log(
      `[aidcp-cloud] 拆段传输已接线（${seamMode}）：风控命令消费者${
        seamMode !== 'monolith' && panelEventTransport.tee
          ? ` + 事件→outbox 桥${panelEventReplay ? ' + owner cursor→api ingress relay' : ''}`
          : '；面板事件 tee 未启用（面板与产生端同进程，EventBus 直连，无进程外消费者）'
      }`,
    );
    // 通知唤醒（毫秒级）+ 健康巡检。失败不阻断启动：承重通道是消费者自己的有界轮询。
    await wireOutboxNotifyWakeups(seamMode, [
      {
        name: 'risk-command',
        wake: (topic) => installedRiskCommandConsumer.wake(topic),
        stats: () => installedRiskCommandConsumer.stats(),
        backlogByTopic: () => installedRiskCommandConsumer.backlogByTopic(),
      },
      ...(panelEventReplay
        ? [{
            name: 'panel-event-replay',
            wake: (topic: string) => panelEventReplay!.wake(topic),
            stats: () => panelEventReplay!.stats(),
            backlogByTopic: () => panelEventReplay!.backlogByTopic(),
          }]
        : []),
    ]);
  } else {
    console.warn(
      '[aidcp-cloud] AIDCP_DEPLOY_ENV 缺失/非法 ⇒ 风控命令消费者未启动：面板的风控写会以具名错误拒绝（fail-closed），绝不静默受理。',
    );
  }

  // ── event_outbox 保留期（本 change）：outbox 是队列不是账本，没有剪裁就只进不出。─────────────
  // 只在跑了 segC（automation 属主）且 target 合法时起。「等谁追平才敢剪」由模式决定，而不是由
  // 游标行在不在倒推——否则没有消费者的形态会永久拒绝剪裁 + 永久告警。
  const outboxRetention = outboxRetentionForMode(seamMode);
  if (outboxRetention.prune && deploymentTarget) {
    const pruner = new OutboxRetentionPruner({
      pool: automationPool,
      executionTarget: deploymentTarget,
      topics: [
        {
          topic: PANEL_EVENT_OUTBOX_TOPIC,
          retentionMs: PANEL_EVENT_RETENTION_MS,
          consumers: outboxRetention.panelEventConsumed ? [PANEL_EVENT_REPLAY_CONSUMER] : [],
          // 纯观测流：即使回放端从没上线，3 天前的历史帧也不该继续占生产库磁盘（强删会 warn）。
          unconsumedRetentionMs: PANEL_EVENT_UNCONSUMED_RETENTION_MS,
        },
        {
          topic: RISK_COMMAND_TOPIC,
          retentionMs: RISK_COMMAND_RETENTION_MS,
          consumers: outboxRetention.riskCommandConsumed ? [RISK_COMMAND_CONSUMER] : [],
          // 承重命令：MUST NOT 设兜底强删——未被应用就删掉 = 静默吞掉一次风控状态写。
        },
      ],
      logger: console,
    });
    pruner.start();
    console.log(
      `[aidcp-cloud] event_outbox 保留期剪裁已启动（${seamMode}）：panel.event 等待消费者=${
        outboxRetention.panelEventConsumed
      }，risk.command 等待消费者=${outboxRetention.riskCommandConsumed}`,
    );
  }

  // ── 记账 outbox + worker + 对账（change risk-state-cross-process-integrity，design D5/D6）──
  //
  // 只在持有写者锁且 target 合法时启用。启用后，「边缘确认真实动作 → 风控记账」这条链路从
  // 「进程内 fire-and-forget、异常只打日志」变成「先落库、再推进；apply 与计数同事务；
  // 内存计数只在 apply 成功时递增」。
  let riskReconciler: RiskCounterReconciler | undefined;
  if (deploymentTarget && writerLock) {
    try {
      // schema 只探测、不自愈：outbox 表与 risk_counters.outbox_id 都必须已由迁移建立。
      await riskStore.init();
      // Block③ L3：risk_counter_outbox 属 automation，且 MUST 与 riskStore **同一个池**——
      // 记账 exactly-once 全靠 risk_counters.outbox_id 上的唯一索引 + 单事务「写计数 + 标 applied」，
      // 两者分居两库时那条索引管不到对方，exactly-once 直接失效且零报错。
      const outboxStore = new PgRiskCounterOutboxStore({
        executionTarget: deploymentTarget,
        pool: automationPool,
      });
      await outboxStore.init();
      const accounting = new RiskAccounting({
        outbox: outboxStore,
        // 记账刻意**不过归属闸**：risk_counters 是既成事实账本，归属刚变更时飞在半路的回执
        // 仍要记进同一本账（design D4「分裂的是写权限，不分裂的是事实」）。
        resolveController: (accountId) => riskRegistry.getControllerForAccounting(accountId),
        // 后绑定：alertStore 在本处之后才构造，故包一层现读（构造期直接传引用会永远拿到 undefined）。
        alertStore: { raise: async (input) => (riskAlertSink ? riskAlertSink.raise(input) : { alertId: 0 }) },
        logger: console,
        maxAttempts: readEnvNumber('AIDCP_RISK_OUTBOX_MAX_ATTEMPTS', 5),
        pollIntervalMs: readEnvNumber('AIDCP_RISK_OUTBOX_POLL_MS', 5_000),
        workerId: `risk-outbox-${deploymentTarget}`,
      });
      const { recovered } = await accounting.start();
      riskAccounting = accounting;
      console.log(
        `[aidcp-cloud] 风控记账 outbox 已就绪（executionTarget=${deploymentTarget}, 启动回收在途行=${recovered}）`,
      );

      riskReconciler = new RiskCounterReconciler({
        registry: riskRegistry,
        totalsSince: (accountId, since) => riskStore.totalsForAccountSince(accountId, since),
        intervalMs: readEnvNumber('AIDCP_RISK_RECONCILE_INTERVAL_MS', 5 * 60_000),
        logger: console,
        onDrift: (drift) =>
          raiseRiskAlert({
            severity: 'P1',
            type: 'risk_counter_drift',
            accountId: drift.accountId,
            title: `风控计数与库内事实不一致：账号 ${drift.accountId} 的 ${drift.action}`,
            detail:
              `内存=${drift.memory}，库=${drift.database}。判据是偏差是否为零（无容忍阈值）。` +
              `已按库内事实重建该账号计数；偏差来源通常是归属变更、运维手工 SQL 或另一 target 的遗留行。`,
          }),
      });
      riskReconciler.start();
      console.log('[aidcp-cloud] 风控计数对账已启动（偏差非零即告警并以库为准重建）');
    } catch (err) {
      // 记账链路起不来 = 记不上账。这里 MUST NOT 静默降级为「照跑」——但也不该把整个云端拖死
      // （客户数据、内容服务与已在跑的会话都不依赖它）。折中：诚实告警 + 明确日志，
      // 记账漏斗保持未注入 ⇒ 回执路径退回改动前的行为（订阅者记账），且这一点被写进告警里。
      const detail = err instanceof Error ? err.message : String(err);
      await raiseRiskAlert({
        severity: 'P1',
        type: 'risk_accounting_unavailable',
        title: '风控记账 outbox 未能启用，记账退回改动前的进程内路径',
        detail:
          `${detail}。此时「崩在回执与记账之间不丢账」这条保证不成立，MUST 尽快修复。` +
          `常见原因：migrations/0061 未执行、schema 对象不完整或数据库连接失败。`,
      });
    }
  }
  /** 写入前判定 + 记账（全系统唯一入口）。漏斗未启用时回落改动前的 controller.record，行为逐位一致。 */
  const recordRiskFact = async (
    accountId: string,
    action: RiskAction,
    dedupeKey: string,
  ): Promise<boolean> => {
    if (riskAccounting) {
      const verdict = await riskAccounting.record({ accountId, action, dedupeKey });
      return verdict.allowed;
    }
    return (await riskRegistry.getControllerForAccounting(accountId)).record(action);
  };
  /**
   * 互动域（评论回复 / 私信回复）的风控视图：判定直读 controller，**记账走同一个漏斗**。
   * 这两条路径的重投递已由 interaction 域自己的 claimRiskRecord 幂等占位挡住，故去重键用一次性 uuid；
   * 真正的 exactly-once 仍由 risk_counters.outbox_id 唯一索引承担。
   */
  const interactionRiskControllerFor = async (accountId: string) => {
    const controller = await riskRegistry.getControllerForAccounting(accountId);
    return {
      explain: (action: 'comment' | 'dm_reply') => controller.explain(action),
      record: (action: 'comment' | 'dm_reply') =>
        recordRiskFact(accountId, action, `interaction:${accountId}:${action}:${Date.now()}:${randomUUID()}`),
    };
  };

  // Session 02：独立入站互动域。0039 未部署时只禁用本能力，不拖垮原有浏览/发布链。
  const interactionMetrics = new InteractionMetrics();
  let interactionStore: InteractionStore | undefined;
  let interactionSchemaMode: InteractionSchemaMode | undefined;
  let replyConfigStore: ReplyConfigStore | undefined;
  let replyConfigScopeStore: ReplyConfigScopeStore | undefined;
  let localReplyConfigResolver: ReplyConfigResolver | undefined;
  let replyConfigResolver: ReplyConfigResolverPort | undefined;
  let replyWorkflow: ReplyWorkflow | undefined;
  let interactionInbox: InteractionInboxService | undefined;

  let interactionOffboarding: InteractionOffboardingService | undefined;
  const interactionAiTimeoutMs = Math.max(1_000, readEnvNumber('AIDCP_INTERACTION_AI_TIMEOUT_MS', 20_000));
  try {
    // Block③ L3 翻转前置：这三个 store 此前构造时都不传 pool ⇒ 各自 `new Pool(resolveEnvPgConfig())`
    // 回落**共享库**配置，而不是自己表的属主池。**属主各不相同**：InteractionStore 写的是 interaction_*
    // 那批 automation 属主表；两个 reply-config store 写的却全是 api 属主表（见下方注释）。
    // 一旦设 AIDCP_PG_AUTOMATION_URL，属主会继续读写旧共享库、而已解耦的读端口读新 automation 库
    // ⇒ split brain（读端看空库/陈旧副本，写端的授权与离场改动读端永远看不见）。故在此显式绑属主池。
    // **今天逐字节等价且不依赖任何 env 组合**：resolveOwnerPgConfig('automation') 在 owner URL 未设时
    // 回落的 resolveSharedPgConfig 与 resolveEnvPgConfig() 是同一套 env 名 / 同一 DEFAULT 兜底 /
    // 同样 DATABASE_URL 优先 —— 这三个 store 本就跑在那个 resolver 上，故不存在 L2 那批 HOST-param
    // store「接池后开始认 DATABASE_URL」的口径漂移。连接数亦降（三个私有池 → 复用 automationPool）。
    // Block③ L3 反方向收口（本 change）：那几处「automation 事务里直读 / 直锁 api 属主表」的守卫
    // （client_env_revocation_holds / accounts 的 FOR SHARE、经 envLock 锁 client_environments）
    // 已收敛进 api 窄端点 PgInteractionAuthGate —— 判定与环境级行锁跑在 **api 池、api 本地事务**里，
    // 发一张带有效期的条件写回执，automation 拿回执才落登录态。闸问不到 / 被拒 / 回执过期 ⇒ 拒绝写入。
    // api 模式（segC 未跑）同样 fail-closed，与同文件 clientEnvAutomationRead / offboardCleanupGrantOps 同范式。
    const interactionAuthGate: InteractionAuthGate =
      apiDirectPorts.interactionAuth ?? {
        authorizeAuthStateWrite: () =>
          Promise.reject(new Error('interaction_auth_gate_unavailable')),
        checkAccountScope: () =>
          Promise.reject(new Error('interaction_auth_gate_unavailable')),
      };
    const interactionApiWrites = apiDirectPorts.interactionApiWrites;
    // 配置面审计（interaction_audit_events 属 api 单写）改走本域 outbox + 中继：那笔 INSERT 与
    // automation 的业务写同事务，拆库后是跨库事务，端口换不掉「两个库要一起提交」。target 缺失 ⇒
    // 审计写入当场抛错（连带业务事务回滚），绝不把归属未知的审计静默落进队列。
    if (!deploymentTarget) {
      console.error(
        '[aidcp-cloud] AIDCP_DEPLOY_ENV 缺失或非法 → 互动域配置面审计无法投递（dev/ol 隔离无从判定），'
        + '互动写入路径将当场失败。MUST 先修 env，绝不静默丢审计。',
      );
    }
    interactionStore = new InteractionStore({
      pool: automationPool,
      ...(interactionApiWrites ? { apiPurge: interactionApiWrites } : {}),
      authGate: interactionAuthGate,
      ...(deploymentTarget ? { executionTarget: deploymentTarget } : {}),
      // 运行控制行的播种守卫经 api 域读平台（原为内联 `SELECT 1 FROM accounts`，拆库后必炸）。
      // 形态照抄 facebookPublishMediaStore 的 accountPlatformReader。
      ...(apiDirectPorts.accountRuntime
        ? { accountPlatform: { getPlatformOrNull: (id: string) =>
          apiDirectPorts.accountRuntime!.getPlatformOrNull(id) } }
        : {}),
    });
    // ⚠️ 这两个 store 住在 src/interactions/ 但它们的表**全是 api 属主**
    // （interaction_reply_configs / _versions / _scopes / _scope_versions / _scope_audit /
    //  reply_templates / reply_rules / account_reply_profiles / interaction_audit_events / accounts）
    // ⇒ 绑 **apiPool**，不是 automationPool。目录位置不是属主判据，`boundaries/table-ownership.json` 才是。
    interactionSchemaMode = await interactionStore.init();
    if (seamMode === 'automation') {
      replyConfigResolver = apiDirectPorts.replyConfig;
      if (!replyConfigResolver) throw new Error('reply_config_resolver_unavailable');
    } else {
      replyConfigStore = new ReplyConfigStore({ pool: apiPool });
      replyConfigScopeStore = new ReplyConfigScopeStore({ pool: apiPool });
      await replyConfigStore.init();
      await replyConfigScopeStore.init();
      localReplyConfigResolver = new ReplyConfigResolver(replyConfigScopeStore);
      replyConfigResolver = localReplyConfigResolver;
    }
    const resetClassifying = await interactionStore.recoverStalledClassifyingJobs(Date.now() - interactionAiTimeoutMs * 2);
    interactionMetrics.gauge('interaction_recovered_classifying_jobs', resetClassifying);
    const replyAi = new ReplyAiService(
      llm,
      interactionAiTimeoutMs,
    );
    replyWorkflow = new ReplyWorkflow(interactionStore, replyConfigResolver, replyAi, {
      accountNameFor: accountDisplayName,
      ...(apiDirectPorts.accountRuntime ? {
        contactInfoFor: (accountId: string) =>
          apiDirectPorts.accountRuntime!.getContactInfo(accountId),
      } : {}),
      canAutoQueue: async (context, snapshot, preview) =>
        ctx.interactionSender?.canAutoQueueDraft(context, snapshot, preview) ?? false,
    });
    interactionInbox = new InteractionInboxService({
      store: interactionStore,
      configs: replyConfigResolver,
      workflow: replyWorkflow,
      controllerFor: interactionRiskControllerFor,
      metrics: interactionMetrics,
      ...(apiDirectPorts.accountRuntime ? {
        recordNickname: (accountId: string, nickname: string) =>
          apiDirectPorts.accountRuntime!.recordNickname(accountId, nickname),
      } : {}),
      logger: console,
      dispatchAuto: (input) => {
        if (!ctx.interactionSender) throw new Error('interaction_sender_unavailable');
        return ctx.interactionSender.dispatchQueued(input);
      },
    });
    const recovery = await interactionStore.recoverableAttemptIds();
    interactionMetrics.gauge('interaction_recoverable_attempts', recovery.length);
    if (recovery.length) {
      console.warn(`[interaction] 启动发现 ${recovery.length} 个待核验 attempt；保留原 idempotency，等待 Edge result，绝不盲重发`);
    }
    await interactionStore.purgeExpiredContent();
    const interactionRetentionTimer = setInterval(() => {
      void interactionStore?.purgeExpiredContent().catch((error) =>
        console.warn(`[interaction] retention 失败: ${error instanceof Error ? error.message : String(error)}`));
    }, 24 * 60 * 60 * 1_000);
    interactionRetentionTimer.unref?.();
    // ── 配置面审计中继（Block③ L3）：automation 的 event_outbox → api 属主表 interaction_audit_events ──
    // 载荷结构不符 ⇒ 抛错让游标停在该条之前，每一轮如实报一次（可见的堵塞），MUST NOT 静默跳过：
    // 载荷由本仓自己的 emit 侧生成，结构不符即代码缺陷，不该靠丢审计来掩盖。
    if (deploymentTarget) {
      const auditRelay = new OutboxConsumer({
        consumer: INTERACTION_AUDIT_RELAY_CONSUMER,
        executionTarget: deploymentTarget,
        pool: automationPool,
        handlers: new Map([[INTERACTION_AUDIT_OUTBOX_TOPIC, async (event) => {
          const record = decodeInteractionAuditEvent(event.payload);
          if (!record) {
            throw new Error(`interaction_audit_relay_undecodable_payload id=${event.id}`);
          }
          if (!interactionApiWrites) {
            throw new Error('interaction_api_writes_unavailable');
          }
          await interactionApiWrites.insertAuditEvent(record);
        }]]),
        logger: console,
      });
      auditRelay.start();
      // 队列剪裁：审计的**账本**是 interaction_audit_events 本身（api 属主、365 天），outbox 只留 24h。
      // 承重命令类主题 ⇒ MUST NOT 设 unconsumedRetentionMs 兜底强删（未落地就删 = 静默吞审计）。
      const auditOutboxPruner = new OutboxRetentionPruner({
        pool: automationPool,
        executionTarget: deploymentTarget,
        topics: [{
          topic: INTERACTION_AUDIT_OUTBOX_TOPIC,
          retentionMs: INTERACTION_AUDIT_OUTBOX_RETENTION_MS,
          consumers: [INTERACTION_AUDIT_RELAY_CONSUMER],
        }],
        logger: console,
      });
      auditOutboxPruner.start();
      console.log(
        `[aidcp-cloud] 互动配置面审计中继已启动（topic=${INTERACTION_AUDIT_OUTBOX_TOPIC}, target=${deploymentTarget}）`,
      );
    }
    if (
      interactionSchemaMode === 'legacy_read_only' &&
      readEnvString('AIDCP_DEPLOY_ENV') === 'dev'
    ) {
      console.warn(
        '[aidcp-cloud] interaction legacy schema active in dev ' +
        '(migration 0046 unchanged; writes follow the global write switch)',
      );
    } else if (interactionSchemaMode === 'legacy_read_only') {
      console.warn('[aidcp-cloud] 入站 interaction 域以兼容只读模式就绪（migration 0046 未执行；读取已恢复；评论回复/私信发送强制关闭）');
    } else {
      console.log(
        `[aidcp-cloud] 入站 interaction 域已就绪（migration 0048；回复策略解析模式 ${
          localReplyConfigResolver?.mode ?? 'remote'
        }；完整读写能力受写总开关控制）`,
      );
    }
  } catch (error) {
    await Promise.allSettled([
      interactionStore?.close(),
      replyConfigStore?.close(),
      replyConfigScopeStore?.close(),
      localReplyConfigResolver?.close(),
    ]);
    interactionStore = undefined;
    interactionSchemaMode = undefined;
    replyConfigStore = undefined;
    replyConfigScopeStore = undefined;
    localReplyConfigResolver = undefined;
    replyConfigResolver = undefined;
    replyWorkflow = undefined;
    interactionInbox = undefined;
    console.warn(`[aidcp-cloud] 入站 interaction 域未启用: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Block② 数据网关聚合用：把收件箱读实例（可能 undefined）additive 挂到 ctx，供 segD 组建 DataGateway。
  // 不改其构造/时机/顺序，也不改本段既有 interaction 消费者的注入（那些仍直连本地实例，见 docpatch residual）。
  ctx.interactionStore = interactionStore;

  // 数据保留清理（change retention-local-purge）：原先面板层 retention-sweeper 在此跨域调三个别的
  // 属主 store 的 purge——驱动方跨界。已收口为各属主 store 在自己 init() 里自驱本地日频 purge
  // （risk_counters → PgRiskStore、interaction_feed → InteractionFeedStore、llm_token_usage →
  // TokenUsageStore），阈值/周期/删的数据逐位不变，故此处装配整块撤除。

  // 节奏饱和运维告警器（change decouple-quota-hit-from-risk）：撞速率突发窗不再升风控态，
  // 改道成低优先级运维告警。alertStore 就绪后（见下方）赋值；闭包在事件触发时读取，故此处先声明。
  let pacingAlerter: PacingSaturationAlerter | undefined;

  // RiskController 订阅跨模块事件：真实发生的动作按账号计数（record 无条件写入既成事实，其返回值只答「在不在策略内」）。
  eventBus.on('interaction.occurred', (evt) => {
    // retire-default-account：账号归因 honest-fail —— 缺 accountId（握手已保证存在）即丢弃该事件 + 告警，
    // 绝不回落保留键 default（杜绝脏流量记到退役账号名下）。
    if (!evt.accountId) {
      console.warn('[aidcp-cloud] interaction.occurred 缺 accountId — 丢弃（honest-fail），绝不回落 default');
      return;
    }
    const accountId = evt.accountId;
    // 手动命令（/comment 等）**跳过的是配额闸，不是这本账**（用户裁决 2026-07-17，change
    // risk-record-actuated-facts）：平台照样看见了运营手动做的那一下，它照样消耗该账号在平台眼里的
    // 活动预算，故照常 record、照常被后续 canDo 读到（自治动作据此被拦是预期结果）。
    // 「不被 canDo 阻断」的豁免在下发侧、逐字不动；此前这里以「人工授权」为由整个跳过 record，
    // 使「豁免」与「丢数」不可区分——已摘除。
    const manualSource = evt.action === 'comment' && manualCommentAccounts.has(accountId);
    riskRegistry
      .getControllerForAccounting(accountId)
      .then(async (c) => {
        // 节奏告警判据 MUST 取自**写入前**的判定：写完再问 explain 读到的是**含这一笔**的新状态，
        // 已不是那次动作当时面对的状态。此处的「写入前」现在指 **apply 之前**——事实早已在
        // 回执处理里落进 outbox（handler.enqueueRiskFact），但内存计数只在 apply 时递增，
        // 故这一行取到的仍是那次动作当时面对的状态，与改动前逐位一致
        // （change risk-state-cross-process-integrity，design D5 末段）。
        const verdict = pacingAlerter && !manualSource ? c.explain(evt.action) : undefined;
        // 记账已不在这里做：outbox 行在回执处理里已同步提交，这里只触发一次立即 apply，
        // 把「事实落库」与「内存计数递增」的窗口压到不可观测。轮询只作崩溃恢复兜底。
        // 漏斗未启用（target 缺失 / outbox 起不来）时回落改动前的进程内记账，行为逐位一致。
        if (riskAccounting) await riskAccounting.applyNow();
        else await c.record(evt.action);
        // 配额饱和改道（change decouple-quota-hit-from-risk）：撞突发窗（小时/分钟）→ 发低优先级
        // 运维告警（每日窗静默、只背压）。风控状态不因撞配额而改动。
        // 手动来源不发此告警（运营存心为之，「节奏过载」对他是噪声不是信号）——此前它靠「整个跳过
        // record」顺带获得静默，现改为**在告警侧显式排除**，行为不变而账变诚实。
        if (verdict && !verdict.allowed && pacingAlerter) {
          if (verdict.reason === 'quota:hour' || verdict.reason === 'quota:minute') {
            pacingAlerter.maybe(accountId, evt.action, verdict.reason === 'quota:hour' ? 'hour' : 'minute');
          }
        }
      })
      .catch((err) => {
        console.warn('[aidcp-cloud] RiskController record error:', err);
      });
    // A 阶段4 来源血缘：真实点赞落 liked_notes（noteId 才落；详情缺则空字段如实，不编造）。
    if (evt.action === 'like' && evt.noteId && likedNoteStore) {
      likedNoteStore.recordLike(evt.noteId).catch((err) => {
        console.warn('[aidcp-cloud] LikedNoteStore recordLike error:', err);
      });
    }
    // 精选灵感：把自有动作并入精选语料（change curated-inspiration-corpus）。
    // like = 弱信号（只标既有行、不自动建）；collect = 强信号（有同访问非空正文才补建精选，取不到则只补标记既有行）。
    if (curatedContentStore && evt.noteId && (evt.action === 'like' || evt.action === 'collect')) {
      const observed = lastObservedNoteByAccount.get(accountId);
      const content =
        evt.action === 'collect' && observed && observed.noteId === evt.noteId
          ? {
              title: observed.title,
              body: observed.body,
              mediaType: observed.mediaType,
              author: observed.author,
              sourceUrl: observed.sourceUrl,
              topics: observed.topics,
              referenceImages: observed.referenceImages,
              ...(observed.publishedAtText
                ? {
                    publishedAtText: observed.publishedAtText,
                    publishedObservedAt: observed.publishedObservedAt,
                  }
                : {}),
            }
          : undefined;
      curatedContentStore.markBotAction(accountId, evt.noteId, evt.action, content).catch((err) => {
        console.warn('[aidcp-cloud] curated markBotAction error:', err);
      });
    }
    // V1 task 9.2：按笔记互动落去重表（接线孤儿 risk_interactions）。
    // 仅 like/collect（InteractionAction，follow 无 per-note 语义）；ON CONFLICT DO NOTHING 天然去重。
    // 注：change interaction-feed-enrichment 后面板已改读 interaction_feed，此表保留为去重台账、行为不变（零回归）。
    if (evt.noteId && (evt.action === 'like' || evt.action === 'collect')) {
      riskStore
        .recordInteraction(accountId, evt.noteId, evt.action, Date.now())
        .catch((err) => {
          console.warn('[aidcp-cloud] recordInteraction error:', err);
        });
    }
    // 展示账本（change interaction-feed-enrichment）：四类动作落 interaction_feed —— 纯观测账本，不碰 RiskController 终态。
    // targetId 由 handler 据动作填（笔记动作=noteId，关注=authorId）；comment_like 无目标语义、刻意不进。
    if (
      interactionFeedStore &&
      evt.targetId &&
      (evt.action === 'like' || evt.action === 'collect' || evt.action === 'comment' || evt.action === 'follow')
    ) {
      interactionFeedStore
        .recordEvent(accountId, evt.action, evt.targetId, Date.now())
        .catch((err) => {
          console.warn('[aidcp-cloud] interactionFeed recordEvent error:', err);
        });
    }
  });

  // 搜索是账号级平台活动，但不是 note-scoped interaction；独立事实通道避免污染互动 feed/liked_notes。
  eventBus.on('search.occurred', (evt) => {
    if (!evt.accountId) {
      console.warn('[aidcp-cloud] search.occurred 缺 accountId — 丢弃（honest-fail），绝不回落 default');
      return;
    }
    const accountId = evt.accountId;
    riskRegistry
      .getControllerForAccounting(accountId)
      .then(async (controller) => {
        // 与 interaction.occurred 同形：判定取自 apply 之前，事实已在回执处理里落进 outbox。
        const verdict = pacingAlerter && evt.purpose !== 'operator' ? controller.explain('search') : undefined;
        if (riskAccounting) await riskAccounting.applyNow();
        else await controller.record('search');
        if (verdict && !verdict.allowed && pacingAlerter) {
          if (verdict.reason === 'quota:hour' || verdict.reason === 'quota:minute') {
            pacingAlerter.maybe(accountId, 'search', verdict.reason === 'quota:hour' ? 'hour' : 'minute');
          }
        }
      })
      .catch((err) => console.warn('[aidcp-cloud] search RiskController record error:', err));
  });
  console.log('[aidcp-cloud] 事件订阅已建立（RiskController）');

  // 展示账本元数据（change interaction-feed-enrichment）：看到笔记/作者时独立 upsert 标题+链接，面板读时 LEFT JOIN。
  // 与互动事件解耦 → 杀「动作回执先于详情到达→标题为空」竞态；诚实置空（COALESCE 缺则不覆盖、不伪造）。
  const rememberObservedNote = (evt: { detail: NoteDetailData; accountId?: string; ts: number }): void => {
    // retire-default-account：缺 accountId 即 honest-fail 丢弃，绝不回落 default。
    if (!evt.accountId) {
      console.warn('[aidcp-cloud] note.detail.arrived 缺 accountId — 跳过（honest-fail）');
      return;
    }
    const acc = evt.accountId;
    const d = evt.detail;
    if (interactionFeedStore && d.noteId) {
      interactionFeedStore.upsertMeta(acc, d.noteId, { title: d.title, url: d.url }).catch((err) => {
        console.warn('[aidcp-cloud] interactionFeed upsertMeta(note) error:', err);
      });
    }
    // 笔记上报已带作者昵称 → 顺手补作者元数据（关注展示用；主页 url 待 profile.detail 补，COALESCE 互不抹除）。
    if (interactionFeedStore && d.authorId && d.author) {
      interactionFeedStore.upsertMeta(acc, d.authorId, { title: d.author }).catch(() => {});
    }
    // 精选灵感（change curated-inspiration-corpus + curated-admission-eval-roles）：
    // 此处**只记最近观测笔记内容**（供自有收藏 markBotAction('collect') 在正文可用时补建精选，见 interaction.occurred 处理器）。
    // 「笔记是否进精选」的准入判定已移交角色 curated_note_evaluator（Phase 3 两段式：共鸣预筛 → 读全文 LLM 评估），
    // 以拿到账号绑定 LLM 与人设；此处不再直接 upsertObservation。
    if (curatedContentStore && d.noteId) {
      const topics = topicKeysFromTitle(d.title);
      lastObservedNoteByAccount.set(acc, {
        noteId: d.noteId,
        title: d.title,
        body: d.content,
        mediaType: d.mediaType === 'video' ? 'video' : 'image_text',
        author: d.author,
        sourceUrl: d.url,
        topics,
        likeCount: d.likeCount,
        collectCount: d.collectCount,
        referenceImages: d.images ?? [],
        ...(d.publishedAtText ? { publishedAtText: d.publishedAtText, publishedObservedAt: evt.ts } : {}),
      });
    }
  };
  eventBus.on('note.detail.arrived', rememberObservedNote);
  eventBus.on('note.image_snapshot.arrived', rememberObservedNote);
  eventBus.on('profile.detail.arrived', (evt) => {
    if (!interactionFeedStore) return;
    const d = evt.detail;
    if (!d.authorId) return;
    // retire-default-account：缺 accountId 即 honest-fail 丢弃，绝不回落 default。
    if (!evt.accountId) {
      console.warn('[aidcp-cloud] profile.detail.arrived 缺 accountId — 跳过元数据 upsert（honest-fail）');
      return;
    }
    // 隔离守卫③（change account-real-nickname）：本人主页采集绝不写进 interaction_feed 作者元数据
    // （d.authorId === evt.accountId 即本人 → 跳过）。
    if (d.authorId === evt.accountId) return;
    interactionFeedStore.upsertMeta(evt.accountId, d.authorId, { title: d.nickname, url: d.url }).catch((err) => {
      console.warn('[aidcp-cloud] interactionFeed upsertMeta(profile) error:', err);
    });
  });

  // 告警日志存储（alerts 表，V1 task 9.5）。init 失败留 undefined（告警不落库、不阻塞启动；飞书告警仍发）。
  let alertStore: PgAlertStore | undefined;
  try {
    // Block③ L3：`alerts` 属 automation ⇒ 绑 automationPool（原为裸 HOST-param 自建池，翻转时会
    // 继续写旧共享库，而读端 `PgPanelAutomationRead.listAlerts` 已在 automation 池上 ⇒ 后台告警列表
    // 会永久为空且零报错，正是「静默假成功」形态）。本实例的 `close()` **全仓无调用方**，故注入共享池安全。
    const as = new PgAlertStore({ pool: automationPool });
    await as.init();
    alertStore = as;
    // 风控告警后绑定（change risk-state-cross-process-integrity）：写者锁 / 归属 / 记账 / 对账
    // 四条链路的 P1 从此落库可检索（在此之前只进 console.warn）。
    riskAlertSink = as;
    console.log('[aidcp-cloud] AlertStore 已就绪（alerts 表）');
    // schema 契约门的超前放行（change cloud-schema-migration-executor 任务 6.4）要求「启动日志与告警通道各记一条」。
    // 门跑在 alertStore 构造之前，故放行事件先缓存在门里，此处 flush 到告警通道。
    const schemaWaiver = takePendingSchemaGateAlert();
    if (schemaWaiver) {
      void as.raise({ severity: 'P1', type: 'schema_gate_waiver', title: schemaWaiver.title, detail: schemaWaiver.detail });
    }
    // D5 跨客户绑定冲突告警（change curated-envkey-account-binding）：clientUserStore 在 alertStore 之前构造，
    // 故此处事后接线到既有告警存储（非仅 console.warn）。冲突 = 安全事件（另一客户的账号被自报身份争用）→ P1。
    clientUserStore.setBindingConflictAlertSink((alert) => {
      void as.raise({
        severity: 'P1',
        type: 'env_binding_conflict',
        accountId: alert.accountId,
        title: '环境→账号绑定跨客户冲突（已 fail-closed 拒写）',
        detail: `env_key=${alert.envKey} 尝试绑定账号 ${alert.accountId}，但该账号已绑在归属其他客户的环境上；`
          + `本次绑定写被拒、既有绑定不变（owner=${alert.ownerUserId ?? '⊥'}）。`,
      }).catch((err) => console.warn(`[client-env] 绑定冲突告警落库失败: ${err instanceof Error ? err.message : String(err)}`));
    });
  } catch (err) {
    console.warn('[aidcp-cloud] AlertStore 初始化失败，告警不落库（飞书告警仍发）:', (err as Error).message);
  }
  // 节奏饱和告警器接线（change decouple-quota-hit-from-risk）：有 alertStore 才发，缺则降级为不发、不阻塞。
  if (alertStore) {
    pacingAlerter = new PacingSaturationAlerter({ alertStore });
    console.log('[aidcp-cloud] PacingSaturationAlerter 已就绪（撞突发窗 → 低优先级运维告警）');
  }

  // ── 配置镜像刷新器接线（change config-mirror-cross-process-invalidation §3 / §6）────────────
  // 一个进程一个实例；只对**版本变化**的 key 触发对应 store 重载。它同时是「新鲜度事实源」：
  // 闸门取值口（人设 / 暂停态 / 环境出口闸 / 慢启动锚点）经 src/config-mirror-freshness.ts 同步问它。
  // 整体开关 AIDCP_CONFIG_MIRROR_REFRESH=false 可秒级回滚——关掉即不安装事实源，全部闸门按今日现状运行。
  // ⚠️ 拆库残留（不在 change block3-l3-config-mirror-bump-decouple 范围）：刷新器读的是 api 属主的
  //    config_mirror_version。物理拆库后，跑在 automation 进程里的这份刷新器会变成「读别人的库」——
  //    要么把版本读也收成 kernel 端口（api 侧内部只读投影），要么按属主各存一张版本表。
  //    本刀只解「写事务跨库」，读侧解耦另开一刀；今天三池同库，行为零变化。
  const configMirrorRefresher = new ConfigMirrorRefresher({
    pool: configMirrorPool,
    versionStore: mirrorVersionStore,
    executionTarget: deploymentTarget ?? 'unknown',
    reloaders: {
      quota_config: () => quotaConfigStore.refreshFromAuthority(),
      pacing_floor_config: () => pacingConfigStore.refreshFromAuthority(),
      session_config_global: () => sessionConfigStore.refreshFromAuthority(),
      resume_config_global: () => resumeConfigStore.refreshFromAuthority(),
      persona_config: () => personaStore.refreshFromAuthority(),
      content_schedule: () => contentScheduleStore.refreshFromAuthority(),
      model_config: () => modelConfigStore.refreshFromAuthority(),
      role_config: () => roleConfigStore.refreshFromAuthority(),
      category_config: () => categoryConfigStore.refreshFromAuthority(),
      hot_lead_config: () => hotLeadConfigStore.refreshFromAuthority(),
      facebook_comment_config: () => facebookCommentConfigStore.refreshFromAuthority(),
      facebook_group_join_automation_config: () => facebookGroupJoinAutomationStore.refreshFromAuthority(),
      account_status: () => accountState.refreshFromAuthority(),
      client_environment_slow_start: () => clientUserStore.refreshSlowStartFromAuthority(),
      client_environment_automation_gate: () => clientUserStore.refreshAutomationGateFromAuthority(),
    },
    // 具名告警 config_mirror_stale：载荷含 mirrorKey / 陈旧秒数 / 最后已知版本 / executionTarget。
    // 优先级按**是否真的停手**给：闸门镜像进入陈旧 = 已停止下发新平台动作 → P1；闸门预警 → P2；
    // 参数镜像（陈旧继续用最后已知良值、绝不停手）无论预警还是已陈旧一律 P3，且文案 MUST NOT 谎称已停手。
    ...(alertStore
      ? {
          onStaleAlert: (input) => {
            const halting = input.tier === 'gate' && input.severity === 'stale';
            const lag = input.reloadFailing ? '（副本已知落后：重载持续失败）' : '';
            void alertStore!
              .raise({
                severity: input.tier === 'parameter' ? 'P3' : input.severity === 'stale' ? 'P1' : 'P2',
                type: 'config_mirror_stale',
                title: halting
                  ? `配置镜像已陈旧，已停止下发新平台动作（${input.mirrorKey}）`
                  : input.tier === 'parameter'
                    ? `参数镜像陈旧，继续使用最后已知良值（${input.mirrorKey}）`
                    : `配置镜像即将陈旧（${input.mirrorKey}）`,
                detail:
                  `mirror=${input.mirrorKey} tier=${input.tier}${lag} 陈旧=${input.staleSeconds}s ` +
                  `最后已知版本=${input.lastKnownVersion ?? '无'} target=${input.executionTarget}`,
              })
              .catch((err: unknown) => {
                console.warn(
                  `[config-mirror] 告警落库失败 mirror=${input.mirrorKey}: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          },
        }
      : {}),
  });
  try {
    await configMirrorRefresher.start();
  } catch (err) {
    // 轮询周期超硬上界这类配置错误 MUST 诚实报错而非静默截断；但也绝不能因此让整个云端起不来——
    // 不启动刷新器 = 退回今日现状（启动 + 本进程写入刷新），闸门按 fresh 运行、行为逐位与本 change 前一致。
    console.error(
      '[aidcp-cloud] 配置镜像刷新器启动失败 → 退回今日现状（启动 + 本进程写入刷新，跨进程改配置到重启才可见）:',
      (err as Error).message,
    );
  }

  // A 阶段4 发帖触发器已在发布日志之后前向声明；actions.publish / 首作精选回调运行时引用。
  // 按需评论触发器（change comment-search-command；下方实例化，actions.comment 运行时引用，前向安全）。
  let commentScheduler: CommentScheduler | undefined;
  /**
   * 晚绑定的排期调度器引用（change browser-slot-scheduling）：评论管线要在任务跑完、发现「根本没开始」时
   * 把这一小时的名额还回去；但它构造得比 ContentScheduler 早（后者依赖它），只能这样回指。
   */
  let contentSchedulerRef: ContentScheduler | undefined;

  // Feishu is API-owned. segD composes the command face, cards and WS ingress;
  // this automation segment exposes only its domain services through ctx/ports.
  // A 阶段1 发布指令编排器 / 验证码协助均经 edgeServer 推送（server 在下方构造，闭包运行时已就绪）。

  let edgeTaskLeases!: EdgeTaskLeaseClient;
  const captchaAssist = new CaptchaAssistService({
    enabled: readEnvString('AIDCP_CAPTCHA_ASSIST_ENABLED') === 'true',
    publicBaseUrl: readEnvString('AIDCP_CAPTCHA_ASSIST_PUBLIC_BASE_URL') ?? readEnvString('AIDCP_PANEL_PUBLIC_BASE_URL'),
    tokenSecret: readEnvString('AIDCP_CAPTCHA_ASSIST_TOKEN_SECRET') ?? readEnvString('AIDCP_PANEL_JWT_SECRET'),
    tokenTtlSeconds: readEnvPort('AIDCP_CAPTCHA_ASSIST_TOKEN_TTL_SECONDS') ?? 30 * 60,
    incidentTtlMs: (readEnvPort('AIDCP_CAPTCHA_ASSIST_INCIDENT_TTL_SECONDS') ?? 30 * 60) * 1000,
    // 实时抓帧（change captcha-assist-live-snapshot）：默认关（=== 'true' 才开），开则 capture 带 live 字段、
    // edge 进有界去重实时循环。intervalMs/maxDurationMs/maxFrames 只是 hint，edge 一律再钳制。
    liveCapture: {
      enabled: readEnvString('AIDCP_CAPTCHA_ASSIST_LIVE_ENABLED') === 'true',
      intervalMs: readEnvPort('AIDCP_CAPTCHA_ASSIST_LIVE_INTERVAL_MS'),
      maxDurationMs: readEnvPort('AIDCP_CAPTCHA_ASSIST_LIVE_MAX_DURATION_MS'),
      maxFrames: readEnvPort('AIDCP_CAPTCHA_ASSIST_LIVE_MAX_FRAMES'),
    },
    pusher: {
      pushToEdges: (env, edgeId) => (ctx.edgeServer ? ctx.edgeServer.pushToEdges(env as Envelope, edgeId) : 0),
      // 键入能力 fail-closed 闸（change captcha-assist-text-answer，design D8）：live 查当前连接声明的能力位。
      edgeCapabilities: (edgeId) => (ctx.edgeServer ? ctx.edgeServer.edgeCapabilities(edgeId) : undefined),
    },
    taskLeases: {
      acquire: (request) => edgeTaskLeases.acquire(request),
      release: (lease, outcome) => edgeTaskLeases.release(lease, outcome),
    },
    logger: console,
    getAccountName: accountDisplayName,
  });
  if (readEnvString('AIDCP_CAPTCHA_ASSIST_ENABLED') === 'true' && !captchaAssist.isAvailable()) {
    console.warn(
      '[aidcp-cloud] 验证码云端协助未启用：需要 AIDCP_CAPTCHA_ASSIST_PUBLIC_BASE_URL 或 AIDCP_PANEL_PUBLIC_BASE_URL，并配置 token secret',
    );
  }
  // 验证码事件协调器：消费 risk.captcha_detected/cleared（迁状态 + 按 edge 暂停 + 去重发飞书）。
  const captcha = new CaptchaCoordinator({
    resolveController,
    deliverAlert: (alert) =>
      deliverStructuredNotification({
        kind: 'alert',
        input: {
          severity:
            alert.severity === 'P0'
              ? 'critical'
              : alert.severity === 'P1'
                ? 'error'
                : alert.severity === 'P2'
                  ? 'warning'
                  : 'info',
          title: alert.title,
          detail: alert.detail,
          accountId: alert.accountId,
          actionText: alert.actionText,
          actionUrl: alert.actionUrl,
        },
      }),
    // V1 task 9.5：验证码告警落库（飞书卡发送点写入、清除点 resolveByEdge）。
    alertStore,
    assist: captchaAssist,
    resolveChatId: async () => '',
  });
  // A 阶段1 发布指令编排器：逐条下发 publish.command、按 recordId+seq 关联 publish.command.result。
  // FB 正文逐字输入：填写这一步的预算随正文长度伸缩下发；上限按发布租约 TTL 收敛，
  // 免得边缘在打字途中单方面过期租约、恢复浏览循环去滚半写的编辑器。
  const warnBudget = (message: string): void => console.warn(`[aidcp-cloud] ${message}`);
  const publishLeaseMs = readEnvNumber('AIDCP_EDGE_PUBLISH_LEASE_MS', DEFAULT_PUBLISH_LEASE_MS);
  const fillBudget = clampFillBudgetToLease(
    sanitizeFillBudget(
      {
        baseMs: readEnvNumber('AIDCP_PUBLISH_FILL_BASE_MS', DEFAULT_FILL_BUDGET.baseMs),
        perCharMs: readEnvNumber('AIDCP_PUBLISH_FILL_PER_CHAR_MS', DEFAULT_FILL_BUDGET.perCharMs),
        maxMs: readEnvNumber('AIDCP_PUBLISH_FILL_MAX_MS', DEFAULT_FILL_BUDGET.maxMs),
      },
      warnBudget,
    ),
    publishLeaseMs,
    warnBudget,
  );
  warnIfFillBudgetUnusable(fillBudget, warnBudget);
  const commandSequencer = new CommandSequencer({
    pusher: { pushToEdges: (env, edgeId) => (ctx.edgeServer ? ctx.edgeServer.pushToEdges(env as Envelope, edgeId) : 0) },
    fillBudget,
    resultSlackMs: readEnvNumber('AIDCP_PUBLISH_RESULT_SLACK_MS', 8_000),
    logger: console,
  });
  edgeTaskLeases = new EdgeTaskLeaseClient({
    pusher: { pushToEdges: (env, edgeId) => (ctx.edgeServer ? ctx.edgeServer.pushToEdges(env, edgeId) : 0) },
    // 受理超时必须容得下边缘为停泊账号原地重开浏览器（死线 180s）。生效值只认 EdgeTaskLeaseClient 的
    // 类默认（200s），这里**绝不**再写一个硬编码回落值——上一次就是因为抬了类默认却没改这行，45s 把
    // 200s 永远盖住，那次修复一行都没生效。
    acquireTimeoutMs: readEnvNumberOrUndefined('AIDCP_EDGE_TASK_ACQUIRE_TIMEOUT_MS'),
    releaseTimeoutMs: Number(process.env.AIDCP_EDGE_TASK_RELEASE_TIMEOUT_MS ?? 10_000),
    defaultLeaseMs: Number(process.env.AIDCP_EDGE_TASK_LEASE_MS ?? 5 * 60_000),
    // 7.5 活跃租约中断：某活跃租约被边缘以抢占原因释放 → 就地 reject 属于该 taskId 的在飞 publish.command，
    // 交序列器按 preempted / submitted_unconfirmed 归类、**绝不 unwind executePublishSequence**（防提交后被抢重投双发）。
    // 无对应在途发布指令时为 no-op（巡视/评论任务的收敛走各自命令回执 + 8.2/7.7 路径）。
    onActiveLeasePreempted: (taskId, _edgeId, reason) => commandSequencer.preemptTask(taskId, reason),
    logger: console,
  });
  // AC-PUB 第1道 + 版本闸（edit-note-draft-before-publish；载体由 publish-approval-signal-to-database 换成
  // 持久授权记录）：经内部窄接口按 requestId 读**活跃行**，回 { approved, contentVersion }。
  //
  // 三态严格可区分，绝不合并：
  //   活跃行存在 → 决定本身；无活跃行（404）→ null（未授权，正常等待）；
  //   查询不可读（接口未接线 / 503）→ **抛 ApprovalUnreadableError**，由调用方标 approval_unreadable
  //   阻塞原因并 fail-closed，MUST NOT 当作「未授权」静默吞掉、更 MUST NOT 写任何终态。
  const readPublishApproval = async (
    requestId: string,
  ): Promise<{ approved: boolean; contentVersion: number; revision: number } | null> => {
    if (!publishApprovalClient) throw new ApprovalUnreadableError('approval_api_unavailable');
    const row = await publishApprovalClient.readApproval(requestId);
    return row
      ? { approved: row.approved, contentVersion: row.contentVersion, revision: row.revision }
      : null;
  };
  // 作废一份授权（edit-note-draft-before-publish）：**状态迁移而非删除**，历史轮次保留供审计；
  // 作废后活跃槽位让出，同 requestId 可以 revision+1 重新授权（旧「删文件=可重新审批」语义逐条保留）。
  const voidApprovalSignal = async (
    requestId: string,
    expectedRevision: number,
    reason: ApprovalVoidReason,
  ): Promise<void> => {
    if (!publishApprovalClient) throw new ApprovalUnreadableError('approval_api_unavailable');
    await publishApprovalClient.voidApproval(requestId, expectedRevision, reason);
  };
  // 读某草稿当前内容版本号（edit-note-draft-before-publish）：面板/飞书授权前的写时预检用；不存在/出错 → null。
  const readLiveContentVersion = async (recordId: number): Promise<number | null> => {
    try {
      const draft = await automationPublishLog.loadForDispatch(recordId);
      return draft ? draft.contentVersion : null;
    } catch {
      return null;
    }
  };

  // ── 多租户连接运行时（multi-account-node-support）：每连接私有 EventBus + RoleDispatcher ──────────
  // 前向声明：handler / server 经闭包引用 runtimes（runtimes 在下方装配后才被调用，运行时安全）。

  // 调度启停态（面板 /dispatch 全局开关）：false 时新 / 现有连接不启动浏览会话。
  let dispatchActive = true;
  let personaGenerator: PersonaGeneratorPort | undefined;
  if (seamMode === 'monolith') {
    personaGenerator = new PersonaGenerator({
      llm,
      soulCodec: PERSONA_SOUL_CODEC,
    });
  } else if (seamMode === 'core') {
    const contentUrl = readEnvString('AIDCP_CONTENT_URL');
    if (!contentUrl || !deploymentTarget) {
      throw new Error('content_persona_generator_authority_unavailable');
    }
    personaGenerator = personaGeneratorFromCommand(
      new PersonaGeneratorCommandHttpClient(
        new InternalHttpClient(contentUrl),
        requireDirectInternalToken('AIDCP_CONTENT_INTERNAL_TOKEN'),
        deploymentTarget,
      ),
    );
  }
  const personaFirstPostOnboarding = firstPostOnboardingStore
    ? {
        armFirstBind: async (accountId: string) => {
          // 只有精选入口与既有参照创作调度器都就绪，才向客户端承诺这条自动首作链。
          if (!curatedContentStore || !ctx.publishScheduler) return false;
          const created = await firstPostOnboardingStore!.armFirstBind(accountId);
          if (created) void ctx.uiSnapshot?.pushDailyUsage(accountId);
          return created;
        },
      }
    : undefined;
  const accountPersonaService = personaGenerator
    ? new AccountPersonaService({
        generator: personaGenerator,
        facade: personaPanel,
        firstPostOnboarding: personaFirstPostOnboarding,
        personaBinding: (accountId) => personaStore.bindingFor(accountId),
        logger: console,
      })
    : undefined;
  const accountPersonaPort =
    seamMode === 'automation'
      ? apiDirectPorts.accountPersona
      : accountPersonaService;
  if (!accountPersonaPort) {
    throw new Error('account_persona_authority_unavailable');
  }
  if (accountPersonaService) {
    apiDirectPorts.accountPersona = accountPersonaService;
  }
  const personaAutoFill = seamMode !== 'automation' && personaAutoFillStore
    ? new PersonaAutoFillService({
        store: personaAutoFillStore,
        clientUsers: clientUserStore,
        personas: personaStore,
        personaPanel,
        logger: console,
      })
    : undefined;
  void personaAutoFill?.resume().catch((err) => {
    console.warn('[persona-auto-fill] 启动恢复失败，现有 run 保持持久态、待下次启动继续:', (err as Error).message);
  });
  const interactionConfiguredGlobalWriteEnabled = ['1', 'true', 'yes', 'on'].includes(
    (readEnvString('AIDCP_INTERACTION_WRITE_ENABLED') ?? '').toLowerCase(),
  );
  const interactionGlobalWriteEnabled = interactionWritesAllowed(
    interactionSchemaMode,
    interactionConfiguredGlobalWriteEnabled,
    readEnvString('AIDCP_DEPLOY_ENV'),
  );
  console.log(
    '[aidcp-cloud] interaction write capability ' +
    `schema=${interactionSchemaMode ?? 'unavailable'} ` +
    `environment=${readEnvString('AIDCP_DEPLOY_ENV') ?? 'unset'} ` +
    `configured=${interactionConfiguredGlobalWriteEnabled} ` +
    `effective=${interactionGlobalWriteEnabled} ` +
    'reply_quantity_gate=interaction_windows',
  );
  const interactionRuntimeControls = interactionStore && interactionInbox
    ? {
        getSnapshot: async (accountId: string): Promise<InteractionRuntimeControlsPayload> => {
          return projectRuntimeControls({
            getRuntimeControls: (id) => interactionStore!.getRuntimeControls(id),
            hasPendingOffboard: (id) => interactionInbox!.hasPendingOffboard(id),
            hasPendingRevocationHold: (id) => clientUserStore.hasPendingRevocationHold(id),
            globalWriteEnabled: interactionGlobalWriteEnabled,
          }, accountId);
        },
      }
    : undefined;
  const handler = new DefaultMessageHandler({
    configMirrorGate,
    planner,
    llm,
    cache,
    publishApprovalNotifier: (data) =>
      deliverStructuredNotification(
        { kind: 'publish_approval', input: data },
        `publish-approval:${data.requestId}`,
      ),
    eventBus,
    accountState,
    captcha,
    captchaAssist,
    commandSequencer,
    edgeTaskLeases,
    // 单账号人设应用服务由旧 WS 与 customer-auth HTTP 共用，生成幂等与写入语义只有一份。
    personaService: accountPersonaPort,
    // 该函数声明在下方审批装配段；用闭包延迟取值，避免 handler 初始化时触发 TDZ。
    publishApprovalAction: (payload, session) => {
      if (seamMode !== 'automation') {
        return handlePublishApprovalAction(payload, session);
      }
      if (!session.accountId || !apiDirectPorts.edgePublish) {
        return Promise.resolve({
          requestId: payload?.requestId ?? '',
          ok: false,
          reason: 'edge_publish_authority_unavailable',
        });
      }
      return apiDirectPorts.edgePublish.decidePublishApproval({
        payload,
        accountId: session.accountId,
      });
    },
    publishDraftImageRemove: (payload, session) =>
      seamMode === 'automation'
        ? apiDirectPorts.edgePublish?.removeDraftImage({ payload, session })
          ?? Promise.resolve({
            requestId: payload?.requestId ?? '',
            ok: false,
            reason: 'edge_publish_authority_unavailable',
          })
        : handlePublishDraftImageRemove(payload, session),
    // 多租户路由：私有总线（入站事件灌本连接通道）/ 握手建运行时 / 按连接真实账号解析 controller。
    busFor: (session) => ctx.runtimes!.busFor(session),
    onHandshake: (session) => ctx.runtimes!.onHandshake(session),
    resolveController: (session) => ctx.runtimes?.controllerForSession(session),
    // 记账漏斗（change risk-state-cross-process-integrity）：回执处理**先落 outbox 再 emit**。
    // 未启用时字段省略 ⇒ handler 保持改动前行为（直接 emit，记账由订阅者承担）。
    ...(riskAccounting
      ? {
          riskAccounting: {
            enqueue: (input: Parameters<RiskAccounting['enqueue']>[0]) => riskAccounting!.enqueue(input),
            record: (input: Parameters<RiskAccounting['record']>[0]) => riskAccounting!.record(input),
          },
        }
      : {}),
    // 节奏兜底 floor 提供者（change pacing-floor-config-min-interval）：welcome 握手现读组装 pacing 快照下发
    // （PUT 后下次握手即新值 = 热加载）。init 失败也安全：空镜像 → floorFor 逐项回落 BUILTIN_FLOOR 内置默认。
    pacingFloors: pacingConfigStore,
    interactionInbox,
    interactionRuntimeControls,
  });
  // 陪伴界面快照层（edge-companion-ui 8.1）：前向引用（服务实例在 server 起后构造，同 pusher 闭包模式）。
  const server = new EdgeCloudServer({
    port,
    handler,
    // 删除本身不经 WS；这里只同步抑制普通自动化下发。视频号既有 offboard 清理命令与 session.end
    // 必须穿透，避免 tombstone 前被环境删除闸自锁。
    // 三态出口闸（change config-mirror-cross-process-invalidation task 4.7）：
    // - `allowed`：放行（今日现状）。
    // - `blocked`：环境正处于删除生命周期，这是**确定态**，除既有豁免外一律不放行。
    // - `unknown`：出口闸副本陈旧，这是**瞬时基础设施态**、全车队同时命中。此时只拦「新的真实平台
    //   动作」，控制面与收尾类照常放行（租约取得/归还、UI 快照、节奏、ack、验证码协助、离开笔记/返回）。
    //   把 unknown 当 blocked 处理会连租约释放一起扣住 → 浏览器槽位不归还、在跑会话无法自然收敛，
    //   且调用方只看到「投递 0 个」而把在线的边缘误报成离线。判据见 mirror-stop-work.ts。
    canPushToEdge: (env, edgeId) => {
      if (env.type === 'session.end' || env.type.startsWith('interaction.offboard.')) return true;
      const gate = clientUserStore.automationGateForEdgeId(edgeId);
      if (gate === 'allowed') return true;
      if (gate === 'blocked') return false;
      const allowed = allowsTransportWhenGateUnknown(
        env.type,
        automationOperationDescriptorFor(env.type)?.category ?? null,
      );
      // 只有真的拦下来才算一次「因陈旧的拒绝」——放行的那些不记账，否则指标被纯控制面淹没。
      if (!allowed) noteMirrorStaleRefusal('client_environment_automation_gate', `transport:${env.type}`);
      return allowed;
    },
    onClose: (session) => {
      if (session.edgeId) {
        edgeTaskLeases.invalidateEdge(session.edgeId);
        // 在途发布指令一并诚实失败：正文填写的等待窗口随长度伸缩（可达数分钟），
        // 边缘一死若还傻等满预算，该账号后面所有已审稿件都被堵在串行队列里。
        commandSequencer.invalidateEdge(session.edgeId);
      }
      ctx.runtimes?.onDisconnect(session);
    },
    // 握手注册完成（连接已可被推送、welcome 已回）→ 回填该账号的陪伴界面快照（昵称/最近发布/在途候审）。
    onEdgeRegistered: (session) => {
      // welcome 是传输提交点：只有走到这里的新连接才可顶替同 edgeId 旧连接并激活浏览业务。
      // 视频号由注册表保持 transport-only；无人设 XHS/FB 由启动闸保持在线但不启动会话。
      ctx.runtimes?.onWelcomed(session);
      void ctx.uiSnapshot?.pushHelloSnapshot(session.accountId, session.edgeId, session.capabilities).catch((err) => {
        console.warn(
          `[ui-snapshot] hello 快照回填失败（连接保持在线） account=${session.accountId ?? '-'} edge=${session.edgeId ?? '-'}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (session.accountId && session.edgeId) {
        void (async () => {
          const capabilities = new Set(session.capabilities ?? []);
          const pendingOffboards = capabilities.has(INTERACTION_OFFBOARDING_CAPABILITY)
            ? await interactionStore?.pendingOffboards(session.accountId!, 1) ?? []
            : [];
          if (pendingOffboards.length > 0) {
            await interactionOffboarding?.dispatchPending(session.accountId!, session.edgeId!);
          } else if (capabilities.has(INTERACTION_REPLY_RECOVERY_CAPABILITY)) {
            await ctx.interactionSender?.reconcileRecoverable(session.accountId!, session.edgeId!);
          }
        })().catch((error) => console.warn(
          `[interaction] Edge 恢复编排失败 account=${session.accountId}: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
      // 自动登记环境进管理侧注册表（change client-user-env-registry）：AdsPower 环境（edgeId=ads-<分身id>）一连上来
      // 就进后台「待分配」池，供运营把它分给端用户——**只登记、不归属**（绝不误塞给某客户）。仅带 ads- 前缀的真实分身
      // 环境登记；self-/host- 兜底 edge 不是可分配环境、跳过。env_key = 去掉 ads- 前缀（与 edge attach/过滤口径一致）。
      const eid = session.edgeId;
      if (eid && eid.startsWith('ads-')) {
        const envKey = eid.slice('ads-'.length);
        // 经环境花名册窄回写口（EnvironmentRegistryPort，§5.1）登记，绝不直调 clientUserStore 直写 client_environments。
        void environmentRegistryPort
          .registerHandshakeEnvironment(
            // 环境→账号绑定（change curated-envkey-account-binding）：session.accountId 就在同一 session 对象里；
            // 该钩子按构造安全（welcome 已回发后触发、fire-and-forget + .catch），加此字段结构上不可能拒掉一次握手。
            {
              envKey,
              label: session.accountNickname ?? null,
              platform: session.platform ?? null,
              accountId: session.accountId ?? null,
            },
          )
          .catch((err) => console.warn(`[client-env] 自动登记环境失败 edge=${eid}: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  });
  ctx.edgeServer = server;
  ctx.automationEdgeResumeAuthority =
    new EdgeResumeCommandReceiver({ wsServer: server });
  if (ctx.accountProjectionStore) {
    ctx.automationFacebookScopeAuthority =
      new FacebookScopeCommandReceiver({
        owner: facebookGroupTargetStore,
        refreshAccountProjection: () => ctx.accountProjectionStore!.refresh(),
      });
  }
  ctx.interactionSender = interactionStore && replyConfigResolver
    ? new InteractionSendOrchestrator({
      store: interactionStore,
      configs: replyConfigResolver,
      pusher: server,
      isEdgePaused: (edgeId) => server.isEdgePaused(edgeId),
      controllerFor: interactionRiskControllerFor,
      metrics: interactionMetrics,
      globalWriteEnabled: interactionGlobalWriteEnabled,
    })
    : undefined;
  interactionOffboarding = interactionStore
    ? new InteractionOffboardingService({ store: interactionStore, pusher: server, metrics: interactionMetrics })
    : undefined;
  const interactionPanelGrants = parseInteractionPanelGrants(readEnvString('AIDCP_INTERACTION_PANEL_GRANTS'));
  const panelUsers = parsePanelUsers(readEnvString('AIDCP_PANEL_USERS'));
  const interactionPermissionOverview = buildInteractionPermissionOverview(panelUsers, interactionPanelGrants);
  const deliverInteractionRuntimeControls = async (controls: import('./kernel/interaction-types.js').RuntimeControls): Promise<{ delivered: number }> => {
    if (!interactionRuntimeControls) return { delivered: 0 };
    const edgeId = server.resolveEdgeIdForAccount(
      controls.accountId,
      INTERACTION_RUNTIME_CONTROLS_CAPABILITY,
    );
    if (!edgeId) return { delivered: 0 };
    const payload = await interactionRuntimeControls.getSnapshot(controls.accountId);
    return {
      delivered: server.pushToEdges(
        makeEnvelope('interaction.runtime.controls', `runtime-controls-${controls.accountId}-${controls.version}`, Date.now(), payload),
        edgeId,
      ),
    };
  };
  const legacyInteractionInternalApi = interactionStore && replyConfigStore && replyWorkflow
    ? new InteractionInternalApi({
      store: interactionStore,
      configs: replyConfigStore,
      workflow: replyWorkflow,
      grantsFor: (actor) => interactionPanelGrants.get(actor) ?? new Set(),
      cursorSecret: readEnvString('AIDCP_PANEL_JWT_SECRET') ?? '',
      resolutionMode: localReplyConfigResolver?.mode,
      onRuntimeControlsUpdated: deliverInteractionRuntimeControls,
    })
    : undefined;
  const scopeInteractionInternalApi = replyConfigScopeStore && localReplyConfigResolver && replyWorkflow
    ? new InteractionScopeInternalApi({
      scopes: replyConfigScopeStore,
      resolver: localReplyConfigResolver,
      workflow: replyWorkflow,
      grantsFor: (actor) => interactionPanelGrants.get(actor) ?? new Set(),
      cursorSecret: readEnvString('AIDCP_PANEL_JWT_SECRET') ?? '',
    })
    : undefined;
  const interactionInternalApi = legacyInteractionInternalApi || scopeInteractionInternalApi
    ? {
        handle: async (...args: Parameters<InteractionInternalApi['handle']>) =>
          await scopeInteractionInternalApi?.handle(...args) || await legacyInteractionInternalApi?.handle(...args) || false,
      }
    : undefined;
  const clientCursorSecret = readEnvString('AIDCP_CLIENT_JWT_SECRET');
  const testDataResetEnabled = interactionTestDataResetEnabled(process.env);
  const interactionCustomerApi = interactionStore && replyConfigResolver && replyWorkflow && ctx.interactionSender && clientCursorSecret
    ? new InteractionCustomerApi({
      users: clientUserStore,
      store: interactionStore,
      configs: replyConfigResolver,
      workflow: replyWorkflow,
      sender: ctx.interactionSender,
      onRuntimeControlsUpdated: deliverInteractionRuntimeControls,
      testDataResetEnabled,
      cursorSecret: clientCursorSecret,
    })
    : undefined;
  if (interactionStore && replyWorkflow && ctx.interactionSender) {
    let recoveryRunning = false;
    const drainInteractionRecovery = async (): Promise<void> => {
      if (recoveryRunning || !interactionStore || !replyWorkflow || !ctx.interactionSender) return;
      recoveryRunning = true;
      try {
        const resetClassifying = await interactionStore.recoverStalledClassifyingJobs(
          Date.now() - interactionAiTimeoutMs * 2,
        );
        interactionMetrics.gauge('interaction_recovered_classifying_jobs', resetClassifying);
        const drafts = await interactionStore.pendingGenerationJobs();
        for (const ref of drafts) {
          try {
            const job = await replyWorkflow.generate({
              accountId: ref.accountId, envKey: ref.envKey, jobId: ref.jobId,
              expectedVersion: ref.version, actor: 'system',
            });
            if (job.state === 'queued') {
              await ctx.interactionSender.dispatchQueued({ accountId: ref.accountId, envKey: ref.envKey,
                jobId: ref.jobId, expectedVersion: job.version });
            }
          } catch {
            interactionMetrics.increment('interaction_recovery_total', { stage: 'generation', status: 'deferred' });
          }
        }
        const queued = await interactionStore.pendingQueuedJobs();
        for (const ref of queued) {
          try {
            await ctx.interactionSender.dispatchQueued({ accountId: ref.accountId, envKey: ref.envKey,
              jobId: ref.jobId, expectedVersion: ref.version });
          } catch {
            interactionMetrics.increment('interaction_recovery_total', { stage: 'dispatch', status: 'deferred' });
          }
        }
        interactionMetrics.gauge('interaction_recovery_pending_drafts', drafts.length);
        interactionMetrics.gauge('interaction_recovery_pending_queued', queued.length);
      } finally {
        recoveryRunning = false;
      }
    };
    const interactionRecoveryTimer = setInterval(() => void drainInteractionRecovery(), 30_000);
    interactionRecoveryTimer.unref?.();
    void drainInteractionRecovery();
  }
  if (interactionOffboarding) {
    const offboardAdmissionReconciler =
      deploymentTarget && apiDirectPorts.offboardAdmissionLedger
        ? new AutomationOffboardAdmissionReconciler({
            automationRead: new PgClientEnvAutomationRead({ pool: automationPool }),
            materializationOps: new PgOffboardMaterializationOps({ pool: automationPool }),
            admissionLedger: apiDirectPorts.offboardAdmissionLedger,
            workerId: `offboard-reconcile-${deploymentTarget}`,
          })
        : undefined;
    let offboardRetryRunning = false;
    const retryOffboards = (): void => {
      if (offboardRetryRunning) return;
      offboardRetryRunning = true;
      void (async () => {
        try {
          // 承重兜底通道：认领属主台账里 api 侧还没记上的清理 + 释放已清除的准入 + 重放尚未物化的准入。
          if (!offboardAdmissionReconciler) {
            throw new Error('offboard_admission_reconciler_unavailable');
          }
          const reconciliation = await offboardAdmissionReconciler.reconcile({
            commandId: randomUUID(),
            now: Date.now(),
          });
          for (const offboard of reconciliation.materializedOffboards) {
            if (!offboard.accountId) continue;
            const edgeId = server.resolveEdgeIdForAccount(offboard.accountId);
            if (edgeId) await interactionOffboarding?.dispatchPending(offboard.accountId, edgeId);
          }
        } catch (error) {
          console.warn(
            `[interaction] 环境清理准入 reconcile 失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await interactionOffboarding?.retryPending();
      })()
        .catch((error) => console.warn(
          `[interaction] offboard retry 失败: ${error instanceof Error ? error.message : String(error)}`,
        ))
        .finally(() => { offboardRetryRunning = false; });
    };
    retryOffboards();
    const offboardRetryTimer = setInterval(retryOffboards, 60_000);
    offboardRetryTimer.unref?.();
    const purgeOffboards = (): void => {
      void interactionOffboarding?.purgeDue().catch((error) =>
        console.warn(`[interaction] offboard purge 失败: ${error instanceof Error ? error.message : String(error)}`));
    };
    purgeOffboards();
    const offboardPurgeTimer = setInterval(purgeOffboards, 60 * 60 * 1_000);
    offboardPurgeTimer.unref?.();
  }

  // ── 发布下发段（change decouple-publish-generation-from-dispatch）──────────────
  // 由人审授权信号到达触发（通过即切）。唯一碰边缘、唯一让位浏览的阶段：让位 → 从落库草稿重建发布输入 →
  // 驱动指令序列 → 回写 → 解除让位。AC-PUB：下发前复核授权信号 approved===true，未授权绝不下发。
  // 陪伴界面快照层实例化（edge-companion-ui 8.1）：hello 回填 + 发布审批状态实时推送。
  const buildTodayUsageForAccount = async (accountId: string, edgeId?: string): Promise<UiDailyUsagePayload> => {
    const asOf = Date.now();
    const minuteWindowMs = 60_000;
    const hourWindowMs = 60 * 60_000;
    const dayStartedAt = dayWindowStart(asOf);
    const dayWindowMs = 24 * 60 * 60_000;
    const minuteSince = asOf - 60_000;
    const hourSince = asOf - 60 * 60_000;
    const nextUsageRefreshAt = asOf + minuteWindowMs;
    // 平台按**同步镜像**现读（change platform-honest-usage-caps）：init() 全表预热 + 新账号入库回填。
    // undefined = 未知（缺键）⇒ 下游 omitUnsupportedUsageMetrics 保持现状：既有指标一个不摘、
    // 加群指标一个不加（change platform-honest-usage-metrics）。
    // 刻意不用 getPlatform()：那条缺值回落小红书（把「不知道」说成「是小红书」），且是 await PG。
    const accountPlatform = accountStore?.platformFor?.(accountId);
    const sessionUsage = ctx.runtimes?.sessionUsageForAccount(accountId, edgeId) ?? null;
    const sessionStartedAt = sessionUsage?.active === true
      && typeof sessionUsage.startedAt === 'number'
      && Number.isFinite(sessionUsage.startedAt)
      ? sessionUsage.startedAt
      : null;
    const [
      sessionRiskTotals,
      minuteRiskTotals,
      hourRiskTotals,
      dayRiskTotals,
      sessionPublishCount,
      minutePublishCount,
      hourPublishCount,
      dayPublishCount,
    ] = await Promise.all([
      sessionStartedAt === null ? Promise.resolve(null) : riskStore.totalsForAccountSince(accountId, sessionStartedAt),
      riskStore.totalsForAccountSince(accountId, minuteSince),
      riskStore.totalsForAccountSince(accountId, hourSince),
      riskStore.todayTotalsForAccount(accountId),
      sessionStartedAt === null ? Promise.resolve(null) : automationPublishLog.countPublishedSinceForAccount(accountId, sessionStartedAt),
      automationPublishLog.countPublishedSinceForAccount(accountId, minuteSince),
      automationPublishLog.countPublishedSinceForAccount(accountId, hourSince),
      automationPublishLog.countPublishedTodayForAccount(accountId),
    ]);

    // 计数面也按平台投影（change platform-honest-usage-metrics）。三条纪律，缺一条就复活一个谎：
    // ① **投影永远是最后一步**——先 pick 物化、再覆盖 publish，最后才摘。顺序颠倒 ⇒ 摘掉的键被补回 0
    //    ⇒ quotaSaturation 算 `0 >= 0` ⇒「0/0 今日计划已完成」。
    // ② **四个计数面一个都不能漏**（session / minute / hour / day）。漏一个 = 同一个账号在同屏的两处
    //    互相打脸：KPI 格诚实地没有收藏，正下方的窗口条却列着「收藏 0」。session 面尤其容易漏——它的
    //    预算来自另一套零平台维度的全局配置，且是窗口列表的第一条。
    // ③ 投影**只塑形、不算数**：它不改任何一个数字，只决定哪些键出现在载荷里。
    const projectTotals = (totals: UiDailyUsageCounts): UiDailyUsageCounts =>
      omitUnsupportedUsageMetrics(accountPlatform, totals);
    const withPublish = (totals: UiDailyUsageCounts, publishCount: number): UiDailyUsageCounts => {
      totals.publish = publishCount;
      return totals;
    };

    const minuteTotals = projectTotals(withPublish(pickDailyUsageCounts(minuteRiskTotals), minutePublishCount));
    const hourTotals = projectTotals(withPublish(pickDailyUsageCounts(hourRiskTotals), hourPublishCount));
    const dayTotals = projectTotals(withPublish(pickDailyUsageCounts(dayRiskTotals), dayPublishCount));
    const sessionTotals = projectTotals(
      completeSessionUsageCounts(sessionUsage?.totals ?? {}, sessionRiskTotals, sessionPublishCount),
    );
    // 「本轮计划」窗口也是一个客户端上限面（change platform-honest-usage-caps）：session 预算是全局单例
    // （session_config_global，零平台维度）⇒ 不摘的话 FB 会在 KPI 格显示诚实的「收藏 0」、而正下方的
    // 窗口条同屏显示「收藏 0/5」带进度条。两处同源同谎，必须一起摘。
    const sessionQuotas = projectTotals(
      pickSessionUsageCounts(sessionUsage?.quotas ?? sessionConfigStore.sessionBudget()),
    );
    const windows: NonNullable<UiDailyUsagePayload['windows']> = {
      session: makeUsageWindow(sessionTotals, sessionQuotas, {
        active: sessionUsage?.active === true,
        startedAt: sessionUsage?.startedAt,
        windowMs: sessionConfigStore.sessionDurationMs(),
        expiresAt: sessionUsage?.active === true && typeof sessionUsage.startedAt === 'number'
          ? sessionUsage.startedAt + sessionConfigStore.sessionDurationMs()
          : undefined,
        skipSaturation: sessionUsage?.active !== true,
      }),
      minute: makeUsageWindow(minuteTotals, undefined, {
        startedAt: minuteSince,
        windowMs: minuteWindowMs,
        expiresAt: asOf + minuteWindowMs,
        refreshAt: nextUsageRefreshAt,
      }),
      hour: makeUsageWindow(hourTotals, undefined, {
        startedAt: hourSince,
        windowMs: hourWindowMs,
        expiresAt: asOf + hourWindowMs,
        refreshAt: nextUsageRefreshAt,
      }),
      day: makeUsageWindow(dayTotals, undefined, { startedAt: dayStartedAt, windowMs: dayWindowMs, expiresAt: dayStartedAt + dayWindowMs }),
    };

    const payload: UiDailyUsagePayload = { asOf, totals: dayTotals, windows };
    if (apiDirectPorts.firstPostProgress) {
      try {
        const firstPost = await apiDirectPorts.firstPostProgress.getFirstPostProgress(accountId);
        if (firstPost && (firstPost.state === 'searching' || firstPost.state === 'generating')) {
          const sinceTotals = await riskStore.totalsForAccountSince(accountId, firstPost.startedAt);
          const viewed = Number.isFinite(sinceTotals.view) ? Math.max(0, Math.floor(Number(sinceTotals.view))) : 0;
          payload.firstPost = {
            state: firstPost.state,
            viewed,
            target: 20,
            startedAt: firstPost.startedAt,
            ...(firstPost.sourceId ? { sourceId: firstPost.sourceId } : {}),
          };
        }
      } catch (err) {
        console.warn(
          `[aidcp-cloud] first-post usage read failed account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      const controller = await riskRegistry.getController(accountId);
      const effective = controller.effectiveQuotas();
      // 平台过滤**永远是最后一步**（change platform-honest-usage-caps）：先让 effectiveQuotas 算完该发多少
      // （含风控缩放与慢启动 min(曲线, 档位) 压低），最后再把这个平台结构上发不出的摘掉。顺序颠倒则
      // 慢启动曲线会对一个不存在的动作做 clamp 运算。且必须在 pickDailyUsageCounts **之后**——见该函数注释。
      const minuteQuotas = projectTotals(pickDailyUsageCounts(effective.minute));
      const hourQuotas = projectTotals(pickDailyUsageCounts(effective.hour));
      const dayQuotas = projectTotals(pickDailyUsageCounts(effective.day));
      payload.quotaLevel = controller.getState().quotaLevel;
      // 环境级慢启动投影：**必须从同一个 controller 实例取**，
      // 绝不从 store 另读一次——这是唯一能防「徽章说 D7、clamp 已按 D8 放行」的机制。
      // controller 内部 slowStartView() 与 clamp 共用同一个 anchor 解析 + 同一次 clock()。
      payload.slowStart = controller.slowStartView();
      const minuteWindow = makeUsageWindow(minuteTotals, minuteQuotas, {
        startedAt: minuteSince,
        windowMs: minuteWindowMs,
        expiresAt: asOf + minuteWindowMs,
        refreshAt: nextUsageRefreshAt,
      });
      const minuteReleaseAt = usageWindowReleaseAt(controller, 'minute', minuteWindow.saturated, asOf);
      if (typeof minuteReleaseAt === 'number' && Number.isFinite(minuteReleaseAt)) minuteWindow.releaseAt = minuteReleaseAt;
      const hourWindow = makeUsageWindow(hourTotals, hourQuotas, {
        startedAt: hourSince,
        windowMs: hourWindowMs,
        expiresAt: asOf + hourWindowMs,
        refreshAt: nextUsageRefreshAt,
      });
      const hourReleaseAt = usageWindowReleaseAt(controller, 'hour', hourWindow.saturated, asOf);
      if (typeof hourReleaseAt === 'number' && Number.isFinite(hourReleaseAt)) hourWindow.releaseAt = hourReleaseAt;
      const dayWindow = makeUsageWindow(dayTotals, dayQuotas, {
        startedAt: dayStartedAt,
        windowMs: dayWindowMs,
        expiresAt: dayStartedAt + dayWindowMs,
      });
      const dayReleaseAt = usageWindowReleaseAt(controller, 'day', dayWindow.saturated, asOf);
      if (typeof dayReleaseAt === 'number' && Number.isFinite(dayReleaseAt)) dayWindow.releaseAt = dayReleaseAt;
      windows.minute = minuteWindow;
      windows.hour = hourWindow;
      windows.day = dayWindow;
      payload.quotas = dayQuotas;
      payload.saturated = windows.day.saturated ?? [];
    } catch (err) {
      console.warn(
        `[aidcp-cloud] ui daily usage quota read failed account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return payload;
  };

  const browserStandbyConfig = resolveBrowserStandbyConfig(process.env);
  const buildBrowserStandbyForAccount = async (accountId: string, edgeId?: string): Promise<UiBrowserStandbyPayload> => {
    const controller = await riskRegistry.getController(accountId);
    // 续场闸裁决（change standby-covers-idle-waits）：把「排期外 / 周历关闭 / 每日时长满 / 冻结」这几类停工也接进
    // 待机判定——过去它们完全不产出提示，账号安静下来了、浏览器却一直开着占 700MB。
    // 拿不到（边缘离线 / 无 dispatcher）→ null → 退化为只按风控判，即本 change 之前的行为（安全方向：不让位）。
    const resumeGate = ctx.runtimes?.resumeGateForAccount(accountId, edgeId) ?? null;
    // 「解除阻塞需要浏览器」一票否决（change standby-captcha-must-not-yield）：边缘正卡在验证码上时绝不让位。
    // 验证码会把账号打成 restricted，而 restricted 是让位触发器之一——不接这道闸，就会去关掉运维正要解验证码的
    // 那个浏览器。这里用云端权威的暂停集合（检测到验证码即置位、解除才清），不依赖边缘自报的浮层标志（那个会被
    // 「浏览循环结束」清掉）。edgeId 缺省时按账号解析，解析不到 → false（无从判断则不阻断既有行为）。
    const targetEdgeId = edgeId ?? server.resolveEdgeIdForAccount(accountId) ?? undefined;
    const needsBrowserToUnblock = targetEdgeId ? server.isEdgePaused(targetEdgeId) : false;
    return buildBrowserStandbyHint(controller, {
      now: Date.now(),
      config: browserStandbyConfig,
      resumeGate,
      needsBrowserToUnblock,
    });
  };

  ctx.uiSnapshot = new UiSnapshotService({
    pusher: { pushToEdges: (env, edgeId) => server.pushToEdges(env, edgeId) },
    resolveEdgeIdForAccount: (accountId) => server.resolveEdgeIdForAccount(accountId),
    edgeCapabilities: (edgeId) => server.edgeCapabilities(edgeId),
    getNickname: (accountId) => accountStore?.getNickname?.(accountId) ?? null,
    // 已绑人设信号（change persona-wizard-onboarding-fixes → config-mirror task 4.2/4.3）：persona 存储
    // 权威判据，**三态**——副本陈旧时返回 'unknown'，快照层据此不下发 personaBound 字段（未知≠未绑）。
    personaBinding: (accountId) => personaStore.bindingFor(accountId),
    getPersonaWritingLanguage: (accountId) => resolvePersona(accountId)?.writing_language ?? null,
    lastPublishedForAccount: (accountId) => automationPublishLog.lastPublishedForAccount(accountId),
    pendingApprovalForAccount: (accountId) => automationPublishLog.pendingApprovalForAccount(accountId),
    pendingPublishPreviewForAccount: async (accountId) => {
      return toUiPublishPreview(await automationPublishLog.pendingPublishPreviewForAccount(accountId));
    },
    readApproval: readPublishApproval,
    todayUsageForAccount: buildTodayUsageForAccount,
    browserStandbyForAccount: buildBrowserStandbyForAccount,
    logger: console,
  });
  const uiSnapshotService = ctx.uiSnapshot;
  const publishUiUpdateReceiver = new PublishUiUpdateCommandReceiver({
    uiSnapshot: uiSnapshotService,
  });
  ctx.automationPublishUiUpdateAuthority = publishUiUpdateReceiver;
  if (seamMode !== 'automation') {
    ctx.publishUiUpdateCommand = publishUiUpdateReceiver;
  }

  function toUiPublishPreview(preview: Awaited<ReturnType<PublishLogStore['pendingPublishPreviewForAccount']>>) {
    if (!preview) return null;
    return {
      recordId: preview.id,
      code: `#${preview.id}`,
      kind: preview.kind,
      title: preview.title ?? '',
      content: preview.content,
      topics: preview.topics,
      images: preview.images,
      contentVersion: preview.contentVersion,
      updatedAt: preview.updatedAt,
      ...(preview.imageReferenceAudit ? { imageReferenceAudit: preview.imageReferenceAudit } : {}),
    };
  }

  const recordPublish = async (accountId: string): Promise<void> => {
    // 记账经统一漏斗（change risk-state-cross-process-integrity）：发布是云端自证的既成事实，
    // 没有边缘信封 id 可用，故用「账号 + 动作 + 时刻」构造去重键——这条路径不会被重投，
    // 去重只是形式要求，真正的 exactly-once 由 risk_counters.outbox_id 唯一索引承担。
    await recordRiskFact(accountId, 'publish', `publish:${accountId}:${Date.now()}:${randomUUID()}`);
  };
  const dispatchPublishStore =
    seamMode === 'automation'
      ? {
          loadForDispatch: (recordId: number) =>
            automationPublishLog.loadForDispatch(recordId),
          updateStatus: (id: number, status: Parameters<typeof automationPublishLog.updateStatus>[1]) =>
            automationPublishLog.updateStatus(id, status),
          updatePostId: (id: number, postId: string, postUrl?: string | null) =>
            automationPublishLog.updatePostId(id, postId, postUrl),
          markScheduled: (
            id: number,
            scheduledAt: number,
            scheduledPlatformId?: string | null,
          ) => automationPublishLog.markScheduled(id, scheduledAt, scheduledPlatformId),
          markImagesAttached: (id: number, count: number) =>
            automationPublishLog.markImagesAttached(id, count),
          listPendingApprovalIds: () =>
            Promise.reject(
              new Error(
                'publish_pending_scan_uses_authenticated_3b_listPendingDispatch',
              ),
            ),
        }
      : publishLogStore;
  const publishDispatcher = new PublishDispatcher({
    store: dispatchPublishStore,
    sequencer: commandSequencer,
    edgeTaskLeases,
    resolveEdgeIdForAccount: (accountId) => server.resolveEdgeIdForAccount(accountId),
    executionTarget: deploymentTarget,
    // 7.3：该 edge 是否处于验证码硬暂停（发布命令不在下发豁免名单 → 暂停期投递必为 0）。暂停即零副作用回待审、不烧稿。
    isEdgePaused: (edgeId) => (ctx.edgeServer ? ctx.edgeServer.isEdgePaused(edgeId) : false),
    readApproval: readPublishApproval,
    voidApprovalSignal,
    // 授权下发进度（change publish-approval-signal-to-database）：让「已批准·待下发」成为持久可见状态，
    // 进程重启后仍成立（不再依赖进程内在途集合）。未就绪时不写进度、行为与今天一致。
    ...(publishApprovalClient
      ? {
          approvalDispatchState: {
            markDispatching: async (requestId: string, expectedRevision: number) => {
              await publishApprovalClient.markDispatching(requestId, expectedRevision);
            },
            markConsumed: async (requestId: string, expectedRevision: number) => {
              await publishApprovalClient.markConsumed(requestId, expectedRevision);
            },
            releaseToPending: async (requestId: string, expectedRevision: number, blockedReason) => {
              await publishApprovalClient.releaseToPending(requestId, expectedRevision, blockedReason);
            },
            setBlockedReason: async (requestId: string, expectedRevision: number, reason) => {
              await publishApprovalClient.setBlockedReason(requestId, expectedRevision, reason);
            },
          },
        }
      : {}),
    // 兜底扫描按本机 target 批量拉「已批准·待下发」，取代「遍历待审 id 逐个查授权」的放大器。
    ...(publishApprovalClient && deploymentTarget
      ? {
          listPendingDispatchRecordIds: async (): Promise<number[]> => {
            // subjectKind 收窄到 publish：评论授权没有下发段、状态永远停在 pending_dispatch，
            // 混进来会把 LIMIT 窗口占满，真正待下发的稿反而被挤出窗口、永远扫不到。
            const rows = await publishApprovalClient.listPendingDispatch(deploymentTarget, undefined, 'publish');
            return rows
              .filter((row) => row.approved && /^publish-\d+$/.test(row.requestId))
              .map((row) => Number(row.requestId.slice('publish-'.length)));
          },
        }
      : {}),
    // 发布记账（change risk-record-actuated-facts）：真发出去了才记，与 publish_log 权威口径同轴。
    // 此前 record('publish') 全仓零调用点 ⇒ 发布计数器恒 0 ⇒ 发布日配额从未开过火。
    recordPublish,
    // 陪伴界面：授权核实→approved、云端终判失败→failed 推给在线边缘（published 由边缘自知）。
    notifyUiPublishState: (accountId, recordId, state, title) =>
      uiSnapshotService.pushPublishState(accountId, recordId, state, title),
    // 下发段运维通知：离线/浏览器接管超时/CDP 控制不可用回待审 / 熔断开启 / 熔断解除，best-effort。
    // change unify-card-routing-origin-then-team：文案本就账号作用域（渲染了账号名）→ 按账号路由到团队群。
    notifyDispatchEvent: (notice) => {
      void (async () => {
        const name = accountDisplayName(notice.accountId) ?? '（未获取昵称）';
        const ref = notice.recordId !== undefined ? `草稿 #${notice.recordId}${notice.title ? `「${notice.title}」` : ''}` : '';
        const text =
          notice.kind === 'edge_offline_waiting'
            ? `⏳ 发布待执行：账号「${name}」的批准已受理，但客户端核心暂离线。${ref} 保持授权，核心恢复后会自动尝试执行；当前尚未发布。`
            : notice.kind === 'offline_requeued'
            ? `⚠️ 发布未执行：账号「${name}」边缘离线，${ref} 已退回待审（本次授权作废）。边缘恢复后请重新批准。`
            : notice.kind === 'browser_slot_waiting'
              ? `⏳ 发布排队中：账号「${name}」客户端在线，目标浏览器正在等待本机可用槽位。${ref} 已批准且授权保留，槽位可用后会自动重试，无需重新批准。`
            : notice.kind === 'acquire_timeout_requeued'
              ? `⚠️ 发布未执行：账号「${name}」客户端仍在线，但浏览器未在接管时限内完成暂停当前浏览，${ref} 已退回待审（本次授权作废，未下发发布命令）。请检查浏览器/CDP后重新批准。`
              : notice.kind === 'cdp_unhealthy_requeued'
                ? `⚠️ 发布未执行：账号「${name}」客户端仍在线，但浏览器控制暂不可用，${ref} 已退回待审（本次授权作废，未下发发布命令）。请恢复或重启浏览器客户端后重新批准。`
              : notice.kind === 'breaker_open'
              ? `🔴 发布熔断：账号「${name}」连续下发失败（最近 ${ref}），已停止自动下发其已批草稿。排查边缘后重新批准任一草稿即恢复。`
              : notice.kind === 'edge_paused_requeued'
              ? `⏸️ 发布暂缓：账号「${name}」正处于验证码/风控暂停，${ref} 暂不下发、仍待审（授权保留）。验证码解除后会自动重投，无需重新批准。`
              : notice.kind === 'preempted_exhausted'
              ? `⚠️ 发布反复被打断：账号「${name}」${ref} 连续多次被更高优先任务抢占，已暂停自动重投、仍保持待审（未烧稿）。稍后手动重新批准即可再次尝试。`
              : `🟢 发布熔断解除：账号「${name}」人工批准确认，恢复下发已批队列。`;
        await deliverStructuredNotification({
          kind: 'operational_text',
          input: { route: 'account', accountId: notice.accountId, text },
        });
      })().catch((error) => {
        console.warn(
          `[publish-dispatch] 运维通知发送失败 kind=${notice.kind} account=${notice.accountId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    facebookPublishMedia: facebookPublishMediaStore
      ? {
          releaseReservation: (setId, reservationId) => facebookPublishMediaStore!.releaseReservation(setId, reservationId),
          markUsed: (setId, publishLogId) => facebookPublishMediaStore!.markUsed(setId, publishLogId),
          quarantine: (setId, reason) => facebookPublishMediaStore!.quarantine(setId, reason),
        }
      : undefined,
    breakerThreshold: Number(process.env.AIDCP_PUBLISH_BREAKER_THRESHOLD ?? 2),
    logger: console,
  });
  ctx.scheduledPublishReconciler = new ScheduledPublishReconciler({
    store: automationPublishLog,
    sequencer: commandSequencer,
    edgeTaskLeases,
    resolveEdgeIdForAccount: (accountId) => server.resolveEdgeIdForAccount(accountId),
    isEdgePaused: (edgeId) => (ctx.edgeServer ? ctx.edgeServer.isEdgePaused(edgeId) : false),
    recordPublish,
    intervalMs: readEnvNumber('AIDCP_SCHEDULED_RECONCILE_SCAN_MS', 60_000),
    maxAttempts: readEnvNumber('AIDCP_SCHEDULED_RECONCILE_MAX_ATTEMPTS', 8),
    logger: console,
  });
  // automation owner 的短应答 receiver：只受理唤醒，不把 dispatch Promise 或平台结局塞进 HTTP 生命周期。
  const publishDispatchTrigger =
    approvalAuthorityForAutomation && deploymentTarget
      ? createPublishDispatchTriggerReceiver({
          executionTarget: deploymentTarget,
          approvalAuthority: approvalAuthorityForAutomation,
          dispatcher: publishDispatcher,
          logger: console,
        })
      : undefined;
  ctx.publishDispatchTrigger = publishDispatchTrigger;
  const triggerPublishDispatchOnApprove = async (
    requestId: string,
    revision: number,
    kind: PublishDispatchTriggerKind,
  ): Promise<void> => {
    if (!publishDispatchTrigger || !deploymentTarget) {
      throw new Error('publish_dispatch_trigger_unavailable');
    }
    await publishDispatchTrigger.triggerApproved({
      requestId,
      revision,
      executionTarget: deploymentTarget,
      kind,
    });
  };
  // 陪伴界面：拒绝发布（飞书取消/面板拒绝首写成功）→ rejected 推给该账号在线边缘（仅 publish-<n>）。
  const notifyPublishRejected = (requestId: string): void => {
    const m = /^publish-(\d+)$/.exec(requestId);
    if (!m) return;
    const recordId = Number(m[1]);
    void automationPublishLog
      .loadForDispatch(recordId)
      .then(async (draft) => {
        if (!draft || draft.status !== 'pending_approval') return;
        await automationPublishLog.rejectPendingApproval(recordId);
        if (draft.platform === 'facebook' && draft.metadata?.facebookMedia && facebookPublishMediaStore) {
          await facebookPublishMediaStore
            .releaseReservation(draft.metadata.facebookMedia.setId, draft.metadata.facebookMedia.reservationId)
            .catch((err) =>
              console.warn(
                `[aidcp-cloud] Facebook 素材释放失败 recordId=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        }
        uiSnapshotService.pushPublishState(draft.accountId, recordId, 'rejected', draft.title);
      })
      .catch(() => {});
  };

  const preflightApprovePublish = async (requestId: string): Promise<PublishApprovalPreflightResult> => {
    const m = /^publish-(\d+)$/.exec(requestId);
    if (!m) return { ok: true };
    const recordId = Number(m[1]);
    let draft: Awaited<ReturnType<typeof automationPublishLog.loadForDispatch>>;
    try {
      draft = await automationPublishLog.loadForDispatch(recordId);
    } catch (err) {
      console.warn(
        `[aidcp-cloud] 授权发布前置检查失败，无法读取草稿 requestId=${requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: false, reason: 'publish_target_unavailable' };
    }
    if (!draft) return { ok: false, reason: 'publish_target_unavailable' };
    const edgeId = server.resolveEdgeIdForAccount(draft.accountId);
    if (!edgeId) {
      console.log(`[aidcp-cloud] 授权发布已受理：账号 ${draft.accountId} 核心暂离线，等待恢复后执行 requestId=${requestId}`);
      return { ok: true, accountId: draft.accountId };
    }
    return { ok: true, accountId: draft.accountId, edgeId };
  };

  // 客户端稿件预览内的审批动作：复用飞书/控制台同一份 first-writer-wins 信号，
  // 并以连接握手的真实 accountId 校验归属，避免客户端传入任意 recordId 越权操作。
  /**
   * 待审草稿内容变更后重推预览快照（后台就地编辑 / 客户端删配图共用）。
   * best-effort：账号无在线边缘或下发未达即丢弃、不重试——故调用方 MUST NOT 把它当作唯一刷新手段
   * （客户端删配图以应答回带的写后真态为主刷新路径）。
   */
  const refreshPublishPreview = (recordId: number): void => {
    if (seamMode === 'automation') {
      console.warn(
        `[ui-snapshot] automation 端不再跨 owner 读取 record preview；等待 API owner 的 publish UI update command recordId=${recordId}`,
      );
      return;
    }
    void publishLogStore
      .pendingPublishPreviewForRecord(recordId)
      .then((preview) => {
        if (!preview) return;
        const uiPreview = toUiPublishPreview(preview);
        if (uiPreview) uiSnapshotService.pushPublishPreview(preview.accountId, uiPreview);
      })
      .catch((err) =>
        console.warn(
          `[ui-snapshot] 编辑后预览刷新失败 recordId=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  };

  if (seamMode !== 'automation' && draftRefinementStore && imageProvider) {
    const worker = new DraftRefinementWorker({
      store: draftRefinementStore,
      drafts: publishLogStore,
      llm,
      imageProvider,
      ...(ossUploader ? { objectStore: ossUploader } : {}),
      logger: console,
      refreshPreview: async (recordId) => refreshPublishPreview(recordId),
    });
    let pumping = false;
    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        // 每轮最多连续处理 3 条，防止单账号高频调整饿死事件循环；下一 tick 会继续。
        for (let i = 0; i < 3 && await worker.processNext(`draft-refinement-${deploymentTarget}`); i += 1) { /* bounded drain */ }
      } catch (err) {
        console.warn('[draft-refinement] worker pump failed:', err instanceof Error ? err.message : String(err));
      } finally {
        pumping = false;
      }
    };
    const timer = setInterval(() => void pump(), 1_500);
    timer.unref?.();
    void pump();
  }

  // 客户端预览内删配图（change client-preview-image-delete）：闸序与红线在 draft-image-remove.ts（可单测），
  // 这里只做接线——读草稿 / 探审批签名 / 既有单写 editDraft / 读活版本 / 重推预览。
  const handlePublishDraftImageRemove = createPublishDraftImageRemoveHandler({
    loadDraft: (recordId) => automationPublishLog.loadForDispatch(recordId),
    readApproval: (requestId) => readPublishApproval(requestId),
    editDraft: (recordId, expectedVersion, patch, editor) =>
      automationPublishLog.editDraft(recordId, expectedVersion, patch, editor),
    readLiveVersion: (recordId) => readLiveContentVersion(recordId),
    refreshPreview: (recordId) => refreshPublishPreview(recordId),
  });

  const approvePublishForClient = createClientPublishApprovalHandler({
    loadDraft: (recordId) => automationPublishLog.loadForDispatch(recordId),
    readApproval: (requestId) => readPublishApproval(requestId),
    editDraft: (recordId, expectedVersion, patch, editor) =>
      automationPublishLog.editDraft(recordId, expectedVersion, patch, editor),
    preflight: (requestId) => preflightApprovePublish(requestId),
    // 客户端内审批：决策人 = 那台客户端所绑账号（真实主体，MUST NOT 常量占位）。
    writeApproval: (requestId, approved, approvalPayload, decidedBy) =>
      writeApprovalDecision(requestId, approved, approvalPayload, {
        decidedBy: `client:${decidedBy}`,
        decidedVia: 'client',
      }),
    triggerApproved: (trigger) => {
      void triggerPublishDispatchOnApprove(trigger.requestId, trigger.revision, trigger.kind).catch((err) => {
        console.warn('[aidcp-cloud] client human_reconfirm trigger 失败:', err instanceof Error ? err.message : String(err));
      });
    },
    notifyRejected: notifyPublishRejected,
    // 客户端稿件卡上把「已批准·待下发」与「待审批」区分开（task 6.5）。读不到 → 不带字段，旧行为不变。
    ...(publishApprovalClient
      ? {
          readDispatchState: async (requestId: string) => {
            const row = await publishApprovalClient.readApproval(requestId);
            if (!row || !row.approved) return null;
            if (row.dispatchState === 'dispatching') return { dispatchState: 'dispatching' as const };
            if (row.dispatchState !== 'pending_dispatch') return null;
            return row.dispatchBlockedReason
              ? { dispatchState: 'blocked' as const, dispatchBlockedReason: row.dispatchBlockedReason }
              : { dispatchState: 'pending_dispatch' as const };
          },
        }
      : {}),
  });

  const handlePublishApprovalAction = (
    payload: import('./comm/protocol.js').PublishApprovalActionPayload,
    session: import('./comm/ws-server.js').EdgeSession,
  ): Promise<import('./comm/protocol.js').PublishApprovalActionResultPayload> =>
    approvePublishForClient(payload, session.accountId);

  // API owner outbox relay：只有 automation 明确短应答 queued/duplicate 后才 ack；
  // automation 独立模式不碰 API store，由 api 进程承担同一 relay。
  const publishApprovalOutboxRelay =
    seamMode !== 'automation' && publishApprovalStore && deploymentTarget && publishDispatchTrigger
      ? new PublishApprovalOutboxRelay({
          executionTarget: deploymentTarget,
          store: publishApprovalStore,
          trigger: publishDispatchTrigger,
          logger: console,
        })
      : undefined;
  const pumpPublishApprovalOutbox = async (): Promise<void> => {
    if (!publishApprovalOutboxRelay) return;
    try {
      await publishApprovalOutboxRelay.runOnce(20);
    } catch (err) {
      console.warn(
        '[aidcp-cloud] PublishApproved outbox relay 失败（命令保持 pending）:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  ctx.installPublishApprovalOutboxWake(() => void pumpPublishApprovalOutbox());

  // 兜底补偿（at-least-once）：低频扫描已授权但未下发的待审草稿补触发（覆盖事件丢失）；靠 dispatch 幂等去重。
  const dispatchScanMs = Number(process.env.AIDCP_PUBLISH_DISPATCH_SCAN_MS ?? 60_000);
  if (dispatchScanMs > 0) {
    const scanTimer = setInterval(() => {
      void pumpPublishApprovalOutbox();
      publishDispatcher.scanAndDispatchApproved().catch(() => {});
    }, dispatchScanMs);
    scanTimer.unref?.();
  }
  void pumpPublishApprovalOutbox();

  // 待下发看门狗（change publish-approval-signal-to-database，task 4.4）：只对**无阻塞原因**的长时间
  // 待下发告警——有原因的是已解释的等待（离线/槽位/熔断/暂停/授权不可读），对它们告警只是噪声；
  // 「没有原因的长时间待下发」恰恰是执行侧静默失联的形态，本项目红线禁止它无声存在。
  // 按本机 execution_target 过滤（DEV/OL 共库异步隔离）。
  if (seamMode !== 'automation' && publishApprovalStore && deploymentTarget) {
    const pendingDispatchCandidateLimit = 50;
    const pendingDispatchWatchdog = new PendingDispatchWatchdog({
      executionTarget: deploymentTarget,
      // subjectKind 收窄到 publish：评论授权由评论人审闸就地消费、没有下发侧，混进来是纯误报，
      // 还会把 LIMIT 窗口永久占满 —— 那会让这道唯一的「静默停滞探测器」自己瞎掉。
      listStalePendingDispatch: (target, olderThanMs) =>
        publishApprovalStore!.listStalePendingDispatch(target, olderThanMs, pendingDispatchCandidateLimit, 'publish'),
      candidateLimit: pendingDispatchCandidateLimit,
      thresholdMs: readEnvNumber('AIDCP_PUBLISH_PENDING_DISPATCH_ALERT_MS', 15 * 60_000),
      // 落 alerts 表：后台告警页可见、可 resolveById 对账。只发飞书的话消息一刷就没、无从追溯。
      ...(alertStore ? { alertStore } : {}),
      // 告警须指明是哪个号（spec：指明该记录与其账号）。解析失败降级为「未知账号」，绝不因此不告警。
      resolveAccountId: async (row) => {
        const match = /^publish-(\d+)$/.exec(row.requestId);
        if (!match) return null;
        const draft = await automationPublishLog.loadForDispatch(Number(match[1]));
        return draft?.accountId ?? null;
      },
      notify: async ({ requestId, envKey, accountId, waitingMs }) => {
        const name = accountId ? (accountDisplayName(accountId) ?? accountId) : '（未知账号）';
        await deliverStructuredNotification({
          kind: 'operational_text',
          input: {
            route: accountId ? 'account' : 'default',
            ...(accountId ? { accountId } : {}),
            text:
              `🔴 已批准稿件长时间待下发：${requestId}（账号 ${name}${envKey ? ` / 环境 ${envKey}` : ''}）` +
            `已等待 ${Math.round(waitingMs / 60_000)} 分钟，` +
            '且**没有任何已知阻塞原因**（非离线 / 非排队 / 非熔断 / 非验证码暂停）。' +
            '这通常意味着下发侧失联，请排查云端下发段与数据库连通性。稿件仍保持待审、授权仍有效。',
          },
        }, `pending-dispatch-watchdog:${requestId}:${Math.trunc(waitingMs / 60_000)}`);
      },
    });
    pendingDispatchWatchdog.start(Math.max(60_000, dispatchScanMs));
  }

  // ── 评论循环内人审端口（env 闸：默认 dormant，绝不裸发）─────────────────
  // 同形复用 AC-PUB 接收端（parseApprovalActionValue + writeApprovalSignal）+ 读侧 isPublishApproved，
  // 用评论专属 requestId（comment-<noteId>-<ts>），零改 AC-PUB 共享代码。
  // 90s 超时 < idle 看门狗 idleNudgeMs(130s)，故审批等待期不会触发 idle nudge，无需显式暂停态。
  const commentApprovalEnabled = process.env.AIDCP_COMMENT_APPROVAL === 'true';
  const commentApproval: CommentApprovalPort = {
    request: async ({ requestId, noteId, text, title, authorName, accountId, accountName, originChatId }) => {
      await deliverStructuredNotification({
        kind: 'comment_approval',
        input: {
          requestId,
          noteId,
          text,
          title,
          authorName,
          accountId,
          accountName,
          originChatId,
        },
      }, `comment-approval:${requestId}`);
    },
    isApproved: async (requestId: string) => {
      const decision = await readPublishApproval(requestId);
      const approved = decision?.approved === true;
      // 评论授权没有下发段（下发状态机只被发帖下发器驱动）：人审闸读到「已批准」的这一刻，授权就被用掉了。
      // 不迁走状态的话，这条记录会永远停在「已批准·待下发」——一个不会有人来消费的假等待。
      // best-effort：迁移失败绝不影响本次放行（授权判定只看 approved）。
      if (approved && decision && publishApprovalClient) {
        await publishApprovalClient.markConsumed(requestId, decision.revision).catch((err: unknown) => {
          console.warn(
            `[comment] 评论授权状态迁移失败 requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        });
      }
      return approved;
    },
    timeoutMs: 90_000,
    pollMs: 2_000,
  };

  /** comment auto_approve 统一旁路通知出口；调用方不等待，失败只记录且不影响授权。 */
  const notifyAutoApprovedComment = async (
    input: CommentApprovalNoticeInput & { contactIncluded?: boolean; originChatId?: string },
    source: 'mandatory_persona' | 'account_global' | 'comment_scheduler',
  ): Promise<void> => {
    const mandatory = source === 'mandatory_persona';
    await deliverStructuredNotification(
      mandatory
        ? {
            kind: 'mandatory_comment_pre_authorization',
            input,
          }
        : {
            kind: 'command_result',
            input: {
            command: input.contactIncluded ? '联系评论（免审）' : '评论（免审）',
            ok: true,
            level: 'success',
            title: input.contactIncluded ? '联系评论已免审授权' : '评论已免审授权',
            message:
              `账号或来源已开启免审，评论终稿已生成并进入提交步骤；下发前仍会核对页面、去重和边端结果。\n` +
              `**目标**：${input.title?.trim() || input.authorName?.trim() || '目标内容'}\n` +
              `**正文预览**：${input.text.replace(/\s+/g, ' ').trim().slice(0, 160) || '（空）'}`,
            accountId: input.accountId,
            accountName: input.accountName,
            originChatId: input.originChatId,
          },
        },
      `comment-auto-approved:${source}:${input.requestId}`,
    );
    console.log(`[comment] 免审通知已发 source=${source} account=${input.accountId ?? '-'} requestId=${input.requestId} note=${input.noteId}`);
  };

  const notifyMandatoryCommentOutcome = async (input: MandatoryCommentOutcomeNoticeInput): Promise<void> => {
    await deliverStructuredNotification(
      { kind: 'mandatory_comment_outcome', input },
      `mandatory-comment-outcome:${input.requestId}:${input.outcome}`,
    );
    console.log(
      `[comment] mandatory 终态通知已发 outcome=${input.outcome} account=${input.accountId ?? '-'} requestId=${input.requestId} note=${input.noteId}`,
    );
  };

  // ── 按连接多租户编排（multi-account-node-support D1/D2/D3/D4/D6）─────────────────
  // 未绑人设 → 仅记录拒绝日志；不再向飞书群发送 needs_persona_setup 提示。
  // 「needs_persona_setup 态」是派生字段（persona_config 行不存在即未绑），无需额外落库。
  const onNeedsPersonaSetup = (accountId: string, edgeId: string | undefined, reason: string): void => {
    console.warn(`[aidcp-cloud] 账号 ${accountId}（edge=${edgeId ?? '-'}）${reason}：未绑人设，拒绝启动浏览会话`);
  };
  // 缺 / 空 accountId 握手 → 配置错误（拒绝握手在 handler/registry 完成，这里只发飞书把人叫去修启动器）。
  const onConfigError = async (session: { edgeId?: string; machineLabel?: string }, message: string): Promise<void> => {
    console.error(`[aidcp-cloud] 握手配置错误 edge=${session.edgeId ?? '-'}: ${message}`);
    try {
      await deliverStructuredNotification({
        kind: 'operational_text',
        input: {
          route: 'default',
          text: `⚠️ 边缘节点握手被拒（配置错误）：edge=\`${session.edgeId ?? '-'}\`${session.machineLabel ? `（${session.machineLabel}）` : ''} 未声明 accountId。\n请为该节点启动器显式设置 AIDCP_ACCOUNT_ID（默认账号写 default）。`,
        },
      });
    } catch (err) {
      console.error('[aidcp-cloud] 配置错误飞书告警发送失败:', (err as Error).message);
    }
  };

  // 同账号并行（N:1）互动去重 guard 注册表（按账号单例）：同账号 N 连接共用一个 guard，
  // 下发互动前占坑去重，防两节点对同一笔记/作者重复点赞/关注/评论（D7②）。
  const interactionGuardRegistry = new InteractionGuardRegistry();

  // 动作冷却闸（engagement-restraint）：单例共享（内部按 accountId 分桶）——同账号 N 连接共用同一冷却时间线，
  // 不同账号互不影响。**兜底闸、不是数量闸**（数量单归风控配额主闸；语义见 risk/action-cooldown.ts 文件头）：
  // 只防意外爆发——同秒重入、同账号并行会话同刻双发、重启后首发。不写风控终态；判定全在云端、内存态、
  // 不经协议、无迁移。
  // 重启冷启动静默期（change account-nurture-discipline-spine §4.1，默认值于 cooldown-as-backstop-not-quota 改判）：
  // 冷却为内存态、重启即清零 ⇒ 兜底对每账号每动作的首发是瞎的，静默期补上这一发的最小间距。
  // 默认 15s ＝ 与冷却同值、同受「兜底必须比主闸松」不变量约束（旧默认 3min 把病灶从冷却搬到静默期：
  // 严 12×，且严于 follow/comment 的 60s 主闸地板）。AIDCP_RESTART_QUIET_MS 可调（0=关）＝秒级回滚旋钮。
  const RESTART_QUIET_DEFAULT_MS = 15_000;
  const restartQuietMs = Number(process.env.AIDCP_RESTART_QUIET_MS ?? RESTART_QUIET_DEFAULT_MS);
  const actionCooldownGate = new ActionCooldownGate({
    startedAtMs: Date.now(),
    restartQuietMs:
      Number.isFinite(restartQuietMs) && restartQuietMs >= 0 ? restartQuietMs : RESTART_QUIET_DEFAULT_MS,
  });

  // 每个连接握手时由 buildDispatcher 造一束 RoleDispatcher：私有总线 / 该连接真实账号 controller / 定向下发。
  // 人设以取值口注入（account-persona-config）：派发时按当前账号热加载，PUT 后无需重启。
  // opts.getSoul 仅供预览实例注入示例人设（见 previewDispatcher）；运行时连接一律用严格 getSoul。
  // ── 精选准入文字卡识别/转写（change transcribe-textcard-image-text）────────────
  // 独立于发布时封面感知：OCR 旗标开启才调用；形态识别与转写仍是两个隔离的视觉请求。
  // 此处必须在 server.start 之前装配，避免重启后抢先握手的 Edge 得到缺少转写依赖的 dispatcher。
  const textCardOcrEnabled = (): boolean => process.env.AIDCP_TEXTCARD_OCR === 'true';
  const textCardOcrProvider = (): string => resolveTextCardTranscriptionProvider(resolveCoverFormProvider);
  const textCardOcrModel = (): string => resolveTextCardTranscriptionModel(resolveCoverFormModel);
  // 用量上报接线点②（视觉 LLM 出口）：经 TokenUsageStore 单一接口写归 aidcp-content 的 llm_token_usage，MUST NOT 直写（方案 §4.6.6）。
  const recordVisionCall = (info: VisionCallInfo): void => {
    console.log(
      `[llm] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} ms=${info.ms} ok=${info.ok} tokens=${info.totalTokens ?? 0}`,
    );
    try {
      tokenUsageStore.add(info);
    } catch {
      /* metrics never breaks llm */
    }
  };
  const admissionFormVision = new OpenAiCompatVisionClient({
    getModel: resolveCoverFormModel,
    getProvider: resolveCoverFormProvider,
    providerRuntime,
    onCall: recordVisionCall,
  });
  const admissionFormSensor = createCoverFormSensor({
    vision: admissionFormVision,
    enabled: textCardOcrEnabled,
    getModel: resolveCoverFormModel,
    getProvider: resolveCoverFormProvider,
    logger: console,
  });
  const textCardOcrVision = new OpenAiCompatVisionClient({
    getModel: textCardOcrModel,
    getProvider: textCardOcrProvider,
    providerRuntime,
    onCall: recordVisionCall,
    timeoutMs: Number(process.env.AIDCP_TEXTCARD_OCR_TIMEOUT_MS ?? 120_000),
  });
  const textCardTranscriber = createTextCardTranscriber({
    vision: textCardOcrVision,
    formSensor: admissionFormSensor,
    enabled: textCardOcrEnabled,
    getModel: textCardOcrModel,
    getProvider: textCardOcrProvider,
    logger: console,
  });

  const buildDispatcher = (ctx: DispatcherBuildContext, opts?: { getSoul?: (accountId?: string) => Soul }): RoleDispatcher => {
    // 通知联系人名册（notification-contact-registry）：订阅该连接私有总线的 notification.items.arrived
    // （评论/@/点赞/收藏/关注发送者），按该连接真实账号追加进事件流水。每连接握手 buildDispatcher 调一次 →
    // 一连接订阅一次（避免 setup/restart 重复订阅重复记录）。记录失败只吞 + 准确日志：绝不冒充飞书失败、
    // 绝不阻塞巡视；append 幂等，下轮安全重试。预览 dispatcher 无边缘会话 → 永不触发（不在默认账号空记）。
    if (apiDirectPorts.notificationContacts) {
      ctx.bus.on('notification.items.arrived', (p) => {
        const items = p?.items ?? [];
        if (!items.length) return;
        apiDirectPorts.notificationContacts!.appendEvents(ctx.accountId, items).catch((err) =>
          console.warn(
            `[notification-contacts] 记录失败 account=${ctx.accountId}（巡视照常，下轮幂等重试）:`,
            (err as Error).message,
          ),
        );
      });
    }
    const commentCorpusLookupTimeoutMs = readEnvNumberOrUndefined('AIDCP_COMMENT_CORPUS_LOOKUP_TIMEOUT_MS');
    const commentLlmTimeoutMs = readEnvNumberOrUndefined('AIDCP_COMMENT_LLM_TIMEOUT_MS');
    const commentSublineTimeoutMs = readEnvNumberOrUndefined('AIDCP_COMMENT_SUBLINE_TIMEOUT_MS');
    return new RoleDispatcher({
      configMirrorGate,
      getSoul: opts?.getSoul ?? getSoul,
      llm,
      // 私有事件通道（连接间互不串味）；其上事件经 tee 汇入全局观测总线供风控记账 / 看板消费。
      eventBus: ctx.bus,
      // 该连接账号平台（facebook-scheduled-comment 2.8）：喂 session-start 平台闸，拦下无 browse 能力平台起 xhs 浏览循环。
      accountPlatform: ctx.platform,
      // 就地读/赞版本偏斜闸（change facebook-feed-inline-browse）：本连接边缘声明 inline_targeting 才对其开
      // effectiveReadSurface='feed'（就地读命令 + feed 循环闭合 + 评论迁移 + no_target 重扫）。老边端 / 未重打包
      // 回落 detail ⇒ 逐位等今天。快照本连接握手能力（重连按新连接重建、天然刷新）。
      hasInlineTargeting: () => (ctx.capabilities ?? []).includes('inline_targeting'),
      // Reel 关注版本偏斜闸：旧 Edge 没有 note-scoped follow 执行器时不掷骰、不下发。
      hasReelFollow: () => (ctx.capabilities ?? []).includes(FACEBOOK_REEL_FOLLOW_EDGE_CAPABILITY),
      // 搜索事实版本偏斜闸：只有声明能力的新 Edge 才等待终态并延后概念词落态。
      hasSearchActivityReceipt: () => (ctx.capabilities ?? []).includes(SEARCH_ACTIVITY_RECEIPT_CAPABILITY),
      hasIdentityReadCurrent: () => (ctx.capabilities ?? []).includes(IDENTITY_READ_CURRENT_CAPABILITY),
      hasIdentityReadSelfProfile: () =>
        (ctx.capabilities ?? []).includes(IDENTITY_READ_SELF_PROFILE_CAPABILITY),
      // FB 每日在线时长预算（change account-nurture-discipline-spine §4.2）：全局每日时长未设(0)时 FB 账号
      // 回落非零安全日窗（养号「每天在线 0.5-6h」防长挂）。AIDCP_FB_DAILY_ONLINE_MIN 覆盖；缺/非法 → dispatcher 默认 360。
      facebookDailyOnlineMinutes:
        Number.isFinite(Number(process.env.AIDCP_FB_DAILY_ONLINE_MIN)) && Number(process.env.AIDCP_FB_DAILY_ONLINE_MIN) >= 0
          ? Number(process.env.AIDCP_FB_DAILY_ONLINE_MIN)
          : undefined,
      // 指令级节奏：喂当前（该账号）风控状态，驱动 dwellMs/thinkMs 的 tempo。
      getRiskStatus: () => ctx.controller.getState().status,
      getQuotaLevel: () => ctx.controller.getState().quotaLevel,
      pacingFloors: pacingConfigStore,
      // 互动前风控闸：按该连接真实账号的 controller 判定（不再钉死 default）。被拒诚实跳过。
      canInteract: (action) => ctx.controller.canDo(action),
      explainInteract: (action) => ctx.controller.explain(action),
      explainSearch: () => ctx.controller.explain('search'),
      // 浏览前风控闸：view 配额耗尽时不再打开下一篇笔记，按窗口释放时间休眠后重驱。
      explainView: () => ctx.controller.explain('view'),
      // 评论人审端口（env 闸开启时注入；未开启 → 评论一律诚实跳过、不发）。
      ...(commentApprovalEnabled ? { commentApproval } : {}),
      // 人设 mandatory auto_approve 独立于逐条人审 env；通知为旁路可观测性，不参与授权。
      commentAutoApproveNotify: (input) => notifyAutoApprovedComment(
        input,
        input.approvalSource === 'mandatory_persona' ? 'mandatory_persona' : 'account_global',
      ),
      resolveCommentApprovalMode: resolveEffectiveCommentApprovalMode,
      notifyMandatoryCommentOutcome,
      // 评论增强查询、模型调用和整条子链都有界；未配 env 时由唯一默认事实源兜底（3s / 30s / 5min）。
      ...(commentCorpusLookupTimeoutMs !== undefined ? { commentCorpusLookupTimeoutMs } : {}),
      ...(commentLlmTimeoutMs !== undefined ? { commentLlmTimeoutMs } : {}),
      ...(commentSublineTimeoutMs !== undefined ? { commentSublineTimeoutMs } : {}),
      // 评论 / 评论赞当日配额预闸：按该账号 controller 当日剩余。
      getCommentDailyRemaining: () => ctx.controller.dailyRemaining('comment'),
      getCommentLikeDailyRemaining: () => ctx.controller.dailyRemaining('comment_like'),
      // 优质评论语料库（comment-like-on-detail B）：归档闭包 + 按主题召回参考闭包（store 缺失则不接线）。
      ...(valuableCommentStore
        ? {
            archiveValuableComment: async (input) => {
              // 评论写作语料（喂 composer）：行为不变，仍在此同步落。
              // 「评论是否进精选」的准入判定已移交角色 curated_comment_evaluator（change curated-admission-eval-roles，
              // Phase 3：共鸣预筛 → LLM 评估），故此处不再直接 archiveComment（避免绕过模型评估直纳）。
              await valuableCommentStore!.archive(input);
            },
            getCorpusReferences: (topics) => valuableCommentStore!.retrieveByTopics(topics, 3),
          }
        : {}),
      // 概念池：跨会话搜索记忆 + 从浏览学新关键词（undefined 时退化为仅 seed_keywords）。
      conceptStore,
      // 精选语料库（change curated-admission-eval-roles，Phase 3）：注入则注册两段式准入的模型评估角色
      // （正文 curated_note_evaluator + 评论 curated_comment_evaluator）。缺省（PG 不可用）→ 不注册。
      curatedStore: curatedContentStore,
      textCardTranscriber,
      // content 层角色工厂（组合根注入）：dispatcher 据此构造 4 个 content 角色而不静态 import 它们。
      roleFactories: CONTENT_ROLE_FACTORIES,
      // 热度过滤阈值取值口：判定角色每次现读全局配置（后台改完热加载即时生效）。
      hotLeadGateConfig: () => hotLeadConfigStore.getGateConfig(),
      // 账号是否开启自动联系评论（off/review/auto_approve；默认关＝零回归）。
      isAutoContactEnabled: async (accountId) =>
        actionModeEnabled(contentScheduleStore.effectiveScheduleFor(accountId).contactCommentMode),
      // 引流线索「已评过」去重：复用 riskStore 的按账号互动去重（与自治评论/联系评论同一账本）。
      hasCommentedForLead: (accountId, noteId) =>
        riskStore.hasInteraction(accountId, noteId, 'comment').catch(() => false),
      // 引流线索自动触发（change feed-hot-lead-auto-group-comment）：过统一安全闸 → 复用当前 note.detail 的 triggerTargeted(injectContact) → 飞书人审。
      // 仅评论机器可用时注入（否则 detector 不注册）。helper 一处收口 canDo/子上限/尝试审计；record('comment') 只在最终 commented 后消费。
      ...(commentScheduler
        ? {
            fireAutoContactComment: (args: { accountId: string; noteId: string; title: string; currentDetail: NoteDetailData; velocity: number; ageHours: number }) =>
              triggerGatedAutoComment(
                {
                  accountId: args.accountId,
                  source: 'hot_lead',
                  snapshot: { noteId: args.noteId, velocity: args.velocity, ageHours: args.ageHours },
                  triggerFn: async () => {
                    const contactCommentMode = contentScheduleStore.effectiveScheduleFor(args.accountId).contactCommentMode;
                    const receipt = await commentScheduler!.triggerTargeted(
                      args.accountId,
                      { noteId: args.noteId, title: args.title },
                      {
                        injectContact: true,
                        priority: 'automatic',
                        approvalMode: actionModeEnabled(contactCommentMode) ? contactCommentMode : 'review',
                        currentNote: {
                          noteId: args.currentDetail.noteId,
                          title: args.currentDetail.title,
                          content: args.currentDetail.content,
                          author: args.currentDetail.author,
                          likeCount: args.currentDetail.likeCount,
                          collectCount: args.currentDetail.collectCount,
                        },
                        onResult: async (result) => {
                          if (result.outcome === 'commented') {
                            await recordRiskFact(
                              args.accountId,
                              'comment',
                              `contact-comment:${args.accountId}:${args.noteId}:${Date.now()}`,
                            );
                          }
                        },
                      },
                    );
                    return { ...receipt, recordCommentOnTrigger: false };
                  },
                },
                {
                  canComment: async (a) => (await resolveController(a)).canDo('comment'),
                  recordComment: async (a) =>
                    recordRiskFact(a, 'comment', `contact-comment:${a}:${Date.now()}:${randomUUID()}`),
                  countAttemptsToday: (a) =>
                    apiDirectPorts.automationConfigCommands
                      ? apiDirectPorts.automationConfigCommands.countContactAttemptsToday(a)
                      : Promise.reject(
                          new Error('automation_config_commands_authority_unavailable'),
                        ),
                  getDailyCap: async (a) => contentScheduleStore.effectiveScheduleFor(a).contactCommentDailyCap,
                  recordAttempt: (a, source, snap) =>
                    apiDirectPorts.automationConfigCommands
                      ? apiDirectPorts.automationConfigCommands.recordContactCommentAttempt(
                          a,
                          { source, ...(snap ?? {}) },
                        )
                      : Promise.reject(
                          new Error('automation_config_commands_authority_unavailable'),
                        ),
                },
              ),
          }
        : {}),
      // 硬暂停闸（验证码/人工接管）：通知准入据此放弃巡视——硬暂停期连帧都不发。
      isHardPaused: (edgeId) => (edgeId ? server.isEdgePaused(edgeId) : false),
      // 通知巡视发飞书（仅"评论和@"）：按本连接真实账号路由到其团队群（change feishu-per-team-notification-routing）——
      // 账号 → group_label → group_route.chat_id 命中即投；未绑定 / 读失败一律回落默认群、绝不静默丢。
      // 这是本 change 的核心投递点（账号的平台入站消息 = 各团队要收的"消息"）；其余审批卡 / 运维告警仍走默认群（面向运营方）。
      notifyComments: async (items) => {
        await deliverStructuredNotification({
          kind: 'notification_inbox',
          accountId: ctx.accountId,
          items,
        });
      },
      // 下行指令只发回**发起该决策的连接**（按 edgeId 定向，不再广播 → 不串号）。单连接时等价于原广播。
      sendCommand: (command) => {
        const envelope = edgeCommandToEnvelope(command);
        const sent = server.pushToEdges(envelope, ctx.edgeId);
        console.log(
          `[RoleDispatcher] sendCommand account=${ctx.accountId} edgeId=${ctx.edgeId ?? '-'} action=${command.action} sent=${sent}`,
        );
      },
      edgeTaskLeases,
      // 诚实人设启动闸（D3）：以 persona_config 行存在为独立判据（不走会回落的解析器）；default 硬豁免（在
      // RoleDispatcher.canStartSession 内）；存储读不到 → false（fail-closed，诚实拒绝、不偷用默认人设）。
      personaBinding: (accountId: string) => personaStore.bindingFor(accountId),
      onSessionRejected: (accountId, reason) => onNeedsPersonaSetup(accountId, ctx.edgeId, reason),
      // 全局调度开关（面板 /dispatch）。
      isDispatchActive: () => dispatchActive,
      // 同账号并行互动去重（按账号单例 guard；同账号 N 连接共用 → 共享 in-flight/completed，不重复动作）。
      interactionGuard: interactionGuardRegistry.forAccount(ctx.accountId),
      // 动作冷却闸（engagement-restraint）：单例共享，内部按 ctx.accountId 分桶。下发互动前查、真成功后落时间戳。
      cooldownGate: actionCooldownGate,
      // 单场上限提供者（全局单例，change restore-auto-resume-and-global-safety-config）：读全局单场时长 + 互动预算（热加载、后台改即生效）、对所有账号生效；
      // 缺行/非法回落写死默认（零回归）。每连接共享同一 store，现读全局单行，不触风控状态单写。
      sessionLimitProvider: sessionConfigStore,
      // 账号活跃周历覆盖：开场、续场、唤醒、运行中跨界与冷待机裁决统一从同一解析口现读。
      activeWeekMaskFor: (accountId) => contentScheduleStore.effectiveActiveWeekMaskFor(accountId),
      // 续场护栏 + 看门狗阈值提供者（全局单例，change restore-auto-resume-and-global-safety-config）：读全局配置、对所有账号生效，热加载。
      // 注入即开启自动续场（生产）；缺行回落写死默认（rest 10% / 全天窗口 / 不限 / 看门狗轻推~2min·放弃 1h）。
      resumeConfigProvider: resumeConfigStore,
      // 登录账号真实昵称采集（change account-real-nickname）：同步读（进程内缓存，采集收尾做差异判定）+ 单写持久化。
      // xhs 仍经 dispatcher/profile.detail 路径采集；Facebook 可在通过平台校验后由 hello 的 verified nickname 补充。
      getNickname: (accountId) => accountStore?.getNickname?.(accountId) ?? null,
      setNickname: (accountId, nickname) => accountStore?.setNickname?.(accountId, nickname),
    });
  };

  ctx.runtimes = new ConnectionRuntimeRegistry({
    observerBus: eventBus,
    // 握手解析该连接账号的 controller：此时归属闸已在前面放行，故取可写口。
    getController: (accountId) => riskRegistry.getWritableController(accountId),
    // 账号归属跟随当次连接（change risk-target-follows-active-session）：缺任一项即整段不启用。
    ...(deploymentTarget && ownershipPort && ownershipMode !== 'off'
      ? {
          ownership: {
            executionTarget: deploymentTarget,
            port: ownershipPort,
            onEvent: (info) => {
              void raiseRiskAlert({
                // 首次驱动（NULL→target）P3；跨 target 接管（target→target）P2，运营值得看一眼。
                severity: info.previousTarget === null ? 'P3' : 'P2',
                type: 'risk_owner_driver_switched',
                accountId: info.accountId,
                title:
                  info.previousTarget === null
                    ? `账号 ${info.accountId} 首次由 ${info.ownerTarget} 驱动，归属已设为 ${info.ownerTarget}`
                    : `账号 ${info.accountId} 由 ${info.previousTarget} 切换到 ${info.ownerTarget} 驱动`,
                detail: info.detail,
              });
            },
            // 归属切换后 MUST 驱逐本进程缓存的 controller。账号刚从另一个 target 切过来，本进程此前
            // 可能已为它物化过 controller（面板汇总会为每个账号物化），那份内存**既有陈旧计数、也有陈旧
            // 状态**。只 reloadCounters 会漏掉状态：陈旧的 normal 会在下次条件写时盖回接管方刚写的
            // restricted——切换后归属已是本 target、条件写谓词通过，最后一道 handleNotOwned 不再触发，
            // 静默覆盖就此发生（正是本 change 要消除的形状）。驱逐后下次物化经 RiskController.create
            // 从库重读 state + 回放计数，两者一并刷新。
            onClaimed: async (accountId) => {
              riskRegistry.evict(accountId);
            },
          },
        }
      : {}),
    buildDispatcher,
    ensureAccount: async (accountId, platform) => {
      try {
        const accountRuntime = apiDirectPorts.accountRuntime;
        if (!accountRuntime) throw new Error('account_runtime_authority_unavailable');
        await accountRuntime.ensureAccount(accountId, platform);
      } catch (err) {
        console.warn(`[aidcp-cloud] ensureAccount(${accountId}) 失败（不阻塞握手）:`, (err as Error).message);
      }
    },
    getAccountPlatform: async (accountId) => {
      const accountRuntime = apiDirectPorts.accountRuntime;
      if (!accountRuntime) throw new Error('account_runtime_authority_unavailable');
      return (await accountRuntime.getPlatformOrNull(accountId)) ?? 'xiaohongshu';
    },
    recordNickname: (accountId, nickname) => {
      const accountRuntime = apiDirectPorts.accountRuntime;
      if (!accountRuntime) {
        return Promise.reject(new Error('account_runtime_authority_unavailable'));
      }
      return accountRuntime.recordNickname(accountId, nickname).then(() => undefined);
    },
    onConfigError,
    closeEdge: (sessionId) => server.closeEdge(sessionId),
    logger: console,
  });
  console.log('[aidcp-cloud] 连接运行时注册表就绪（按连接多租户编排，握手建运行时、断连拆除）');

  // 4b required mirrors are a startup barrier, not a post-listen health probe.
  // Publish only the handles needed by the local-authority bootstrap, then
  // complete owner fetch + checkpoint persistence before Edge can handshake.
  ctx.captchaAssist = captchaAssist;
  ctx.configMirrorRefresher = configMirrorRefresher;
  ctx.publishDispatcher = publishDispatcher;
  ctx.server = server;
  if (serviceModeFromEnv() === 'monolith') {
    await startMonolithSyncReads(ctx);
  }
  ctx.scheduledPublishReconciler?.start();

  // hello 处理会同步进入 runtimes.onHandshake()/busFor()。必须先完成运行时注册表装配再开放端口，
  // 否则 Cloud 重启窗口内的 Edge 会收到 handler_error，却可能留下只有自陈 identity/capability 的半握手连接。
  await server.start();
  console.log(`[aidcp-cloud] 边-云 WebSocket 服务端已监听 :${port}`);

  // 角色 prompt 只读预览（role-prompt-visibility）：用一个仅供预览的 RoleDispatcher 渲染真实 prompt
  // （独立私有总线、从不启动会话 / 从不下发指令；多租户下不再有单一全局 dispatcher 可借）。
  // persona-driven-content-pipeline：预览专用示例人设（打包 soul.yaml）——仅供后台只读预览渲染占位，
  // 页面对未绑人设账号已诚实标注（personaFallback）；运行时 getSoul 无此回落（无人设即拒），
  // 绝不以示例人设生成/发布任何内容。
  const previewSampleSoul = loadSoul();
  const previewGetSoul = (accountId?: string): Soul => resolvePersona(accountId) ?? previewSampleSoul;
  const previewDispatcher = buildDispatcher(
    {
      bus: new EventBus(),
      // retire-default-account：预览不写任何状态；用一次性内存 controller + 保留预览标识，绝不用 default。
      controller: new RiskController({
        accountId: '__preview__',
        mirrorStale: (mirrorKey) => configMirrorGate.isStale(mirrorKey),
      }),
      accountId: '__preview__',
      edgeId: undefined,
    },
    { getSoul: previewGetSoul },
  );
  previewDispatcher.setup();
  const previewOnlyLlm: RoleLlmLike = {
    complete: async () => {
      throw new Error('preview-only role must not call LLM');
    },
  };
  const previewOnlyRoles = [
    new CommentSearchTermGenerator({
      llm: previewOnlyLlm,
      getSoul: () => previewGetSoul(previewDispatcher.accountId),
    }),
    new CommentTargetPicker({
      llm: previewOnlyLlm,
      getSoul: () => previewGetSoul(previewDispatcher.accountId),
    }),
  ] as unknown as readonly BaseRole[];

  // 按需评论触发器（change comment-search-command）：飞书 /comment 即用。装配角色①搜索词生成 + 角色②强相关甄选
  // + 边端步骤（搜索原生筛选/开笔记翻评论/发布/去重）+ 撰写人审 → 有界换词重试；接管边端跑、finally 恢复浏览，
  // 结果异步补结果卡片（level 按结果、绝不染绿）。纯增量、不依赖概念池；边端离线/任一步失败 honest-fail。
  commentScheduler = new CommentScheduler({
    // 排期任务「根本没开始」→ 归还这一小时的名额（change browser-slot-scheduling）。
    // 晚绑定：ContentScheduler 在下面才建（它依赖 commentScheduler），这里只能持一个引用。
    onScheduledTaskNotStarted: (accountId, action, reason) =>
      contentSchedulerRef?.reportNotStarted(accountId, action, reason),
    resolveConnection: (accountId) => ctx.runtimes?.runtimeForAccount(accountId) ?? null,
    pusher: { pushToEdges: (env, edgeId) => (ctx.edgeServer ? ctx.edgeServer.pushToEdges(env as Envelope, edgeId) : 0) },
    edgeTaskLeases,
    getSoul,
    // persona-driven-content-pipeline：/comment 触发前人设闸——未绑人设不接管边端、不启动评论任务（与浏览/发布同口径）。
    // 三态：副本陈旧返回 'unknown'，回一句「云端暂时读不到人设配置」而非「你还没设人设」。
    personaBinding: (accountId) => personaStore.bindingFor(accountId),
    getPlatform: (accountId) => accountStore?.getPlatform?.(accountId) ?? 'xiaohongshu',
    // account-group-chat-injection → generalize-contact-info：/comment --contact 时读账号联系方式（异步直读账号存储）；缺联系方式由 scheduler fail-closed。
    getContactInfo: accountStore?.getContactInfo
      ? (accountId) => accountStore!.getContactInfo!(accountId)
      : undefined,
    selectCurated: (accountId, type, limit) =>
      curatedContentStore
        ? curatedContentStore
            .selectForCreation(accountId, type, limit)
            .then((rows) => rows.map((r) => ({ title: r.title, topics: r.topics, collectCount: r.collectCount })))
        : Promise.resolve([]),
    llmFor: (accountId) => ({ complete: (prompt, opts) => llm.complete(prompt, { ...opts, accountId }) }),
    dedupFor: (accountId) => ({
      hasInteracted: (noteId, action) => riskStore.hasInteraction(accountId, noteId, action).catch(() => false),
      recordInteraction: (noteId, action) =>
        riskStore.recordInteraction(accountId, noteId, action, Date.now()).catch(() => {}),
    }),
    ...(commentApprovalEnabled ? { approval: commentApproval } : {}),
    autoApproveNotify: (input) => notifyAutoApprovedComment(input, 'comment_scheduler'),
    resolveApprovalMode: resolveEffectiveCommentApprovalMode,
    onTakeoverStart: onCommentTakeoverStart,
    onTakeoverEnd: onCommentTakeoverEnd,
    // ── Facebook 定向评论：账号配置与结构化审批策略授权，风险/限速/验证继续 fail-closed。 ──
    facebookConfigFor: (accountId) => facebookCommentConfigStore.effectiveConfigFor(accountId),
    facebookCompose: async (accountId, { keyword, postText, comments }) => {
      // 读了再写（change facebook-comment-read-before-write）：撰写器吃到帖子正文（图片帖常空）+ 顶部他人评论，
      // 顺着讨论、用**内容语言**写（图片群里内容多是当地语言，而本号 FB 界面可能是中文——绝不跟界面语言）。
      // 无人值守（不走人审），一次 LLM 调用产草稿，交给确定性校验器把关。
      try {
        const s = getSoul(accountId);
        const writingLanguage = s.writing_language;
        if (!writingLanguage) {
          console.warn(`[facebook-comment] account=${accountId} 缺少 writing_language，拒绝生成评论`);
          return null;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const retryPrompt = buildFacebookCommentComposerPrompt({
            soul: s,
            writingLanguage,
            keyword,
            postText,
            comments: comments ?? [],
            retry: attempt > 0,
          });
          const text = await llm.complete(retryPrompt, { accountId, role: 'facebook_comment_composer' } as never);
          const clean = String(text ?? '').trim();
          if (clean && checkWritingLanguage(clean, writingLanguage) === 'match') return clean;
        }
        console.warn(`[facebook-comment] account=${accountId} 连续两次未满足 writing_language=${writingLanguage}，拒绝发布评论`);
        return null;
      } catch {
        return null;
      }
    },
    facebookCanComment: async (accountId) => (await resolveController(accountId)).canDo('comment'),
    facebookCommentedToday: (accountId) => riskStore.countInteractionsTodayForAccount(accountId, 'comment'),
    facebookDailyCap: () => Number(readEnvString('AIDCP_FB_COMMENT_DAILY_CAP') ?? '2') || 2,
    facebookAudit: (row) => {
      void facebookCommentAuditStore.append(row);
    },
    facebookResolveContainerName: (accountId, url, name) =>
      apiDirectPorts.automationConfigCommands
        ? apiDirectPorts.automationConfigCommands.resolveFacebookContainerName(
            accountId,
            url,
            name,
          )
        : Promise.reject(
            new Error('automation_config_commands_authority_unavailable'),
          ),
    facebookCoverageConfigFor: async (accountId) => {
      // FB 配置不再手填群组；正常评论目标统一来自该账号已加入群组账本。仍保留原 warmup/cooldown
      // 与 relaxed 兜底（最久没评优先），但不再要求 AIDCP_FB_GROUP_COVERAGE_ALL / allowlist 选中。
      const base = facebookCommentConfigStore.effectiveConfigFor(accountId);
      const pickWindow = readEnvNumber('AIDCP_FB_GROUP_COVERAGE_PICK_WINDOW', 5);
      let candidates = await facebookGroupMembershipStore.coverageCandidates(accountId, {
        limit: pickWindow,
        cooldownMs: readEnvNumber('AIDCP_FB_GROUP_COVERAGE_COOLDOWN_HOURS', 72) * 60 * 60 * 1000,
        warmupMs: readEnvNumber('AIDCP_FB_GROUP_COVERAGE_WARMUP_HOURS', 24) * 60 * 60 * 1000,
      });
      // 放开时限兜底（change facebook-coverage-relax-and-keyword-space）：正常约束下无可评群 → 默认降级放开预热/冷却，
      // 选「最久没评」的加入群，仍守日上限与人审；relaxed pick 会在飞书审核卡标注「未满足冷却/预热」交人把关。
      // AIDCP_FB_GROUP_COVERAGE_RELAX=false 可退回严格「无群则跳过」。账号无任何加入群 → 两级都空 → 诚实 no-op。
      let relaxed = false;
      const relaxWhenEmpty = readEnvString('AIDCP_FB_GROUP_COVERAGE_RELAX') !== 'false';
      if (candidates.length === 0 && relaxWhenEmpty) {
        candidates = await facebookGroupMembershipStore.coverageCandidates(accountId, { limit: pickWindow, relaxed: true });
        relaxed = candidates.length > 0;
      }
      const chosen = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] ?? null : null;
      return {
        coverageEnabled: true,
        enabled: base.enabled && chosen !== null,
        keywords: base.keywords,
        containers: chosen ? [{ url: chosen.groupUrl }] : [],
        commentMode: base.commentMode,
        commentTemplates: base.commentTemplates,
        relaxed: chosen !== null ? relaxed : false,
      };
    },
    facebookCoverageOnCommented: (accountId, groupUrl) =>
      facebookGroupMembershipStore.markCoverageCommented(accountId, groupUrl, {
        cooldownMs: readEnvNumber('AIDCP_FB_GROUP_COVERAGE_COOLDOWN_HOURS', 72) * 60 * 60 * 1000,
      }),
    facebookCoverageOnFailure: (accountId, groupUrl, reason) => {
      if (reason === 'permission_gated' || reason === 'nav_error' || reason.startsWith('nav_error')) {
        void facebookGroupMembershipStore.recordCoverageLeftSignal(accountId, groupUrl, reason, {
          requiredConfirmations: Math.max(1, Math.trunc(readEnvNumber('AIDCP_FB_GROUP_LEFT_CONFIRMATIONS', 3))),
          // P0-4（change facebook-join-comment-resilience）：nav_error 是网络瞬态，不再即时驱逐——与 permission_gated 一样
          // 要求达 requiredConfirmations 次确认才把已加入群降级为 left（left 不可复 claim，一次抖动即永久丢一个养熟的群）。
          demoteNow: false,
        });
      }
    },
    // 加群评论（change facebook-manual-join-comment）：/comment --join 复用云端加群调度器加入一个新群（含 kill switch /
    // 判定 fail-closed / 风控配额 / 账本）。facebookGroupJoinScheduler 在本 CommentScheduler 之后构造——闭包运行时才取值（TDZ 安全）。
    facebookJoinNewGroup: (accountId, opts) => facebookGroupJoinScheduler.triggerScheduled(accountId, opts),
    // --join=<url>（change facebook-comment-review-and-targeted-join）：加入指定群、只归该账号（同一 TDZ-safe 闭包，scheduler 稍后构造）。
    facebookJoinSpecificGroup: (accountId, groupUrl, opts) => facebookGroupJoinScheduler.joinSpecificGroup(accountId, groupUrl, opts),
    postResultCard: async (accountId, receipt, source, originChatId) => {
      await deliverStructuredNotification({
        kind: 'command_result',
        input: {
          // 触发来源可辨识（change comment-keep-open-through-approval）：自动排期评论 vs 人工 /comment。
          command: source ?? '/comment',
          ok: receipt.ok,
          level: receipt.level,
          title: receipt.title,
          message: receipt.message,
          accountId,
          originChatId,
        },
      });
    },
    logger: console,
  });

  const facebookGroupJoinScheduler = new FacebookGroupJoinScheduler({
    resolveConnection: (accountId) => ctx.runtimes?.runtimeForAccount(accountId) ?? null,
    pusher: { pushToEdges: (env, edgeId) => (ctx.edgeServer ? ctx.edgeServer.pushToEdges(env as Envelope, edgeId) : 0) },
    edgeTaskLeases,
    targets: facebookGroupTargetStore,
    memberships: facebookGroupMembershipStore,
    audit: facebookGroupJoinAuditStore,
    llmFor: (accountId) => ({ complete: (prompt, opts) => llm.complete(prompt, { ...opts, accountId }) }),
    canJoin: async (accountId) => (await resolveController(accountId)).canDo('join_group'),
    canUseSessionJoin: (accountId, edgeId) =>
      (ctx.runtimes?.remainingSessionBudgetForAccount(accountId, 'join_group', edgeId) ?? 0) > 0,
    recordSessionJoin: (accountId, edgeId) =>
      ctx.runtimes?.consumeSessionBudgetForAccount(accountId, 'join_group', edgeId) ?? false,
    isFacebookAccount: async (accountId) => (await accountStore?.getPlatform?.(accountId)) === 'facebook',
    pauseAccount: async (accountId, reason) => {
      await accountState.pause(accountId);
      console.warn(`[fb-group-join] account paused account=${accountId} reason=${reason}`);
    },
    retryBackoffMs: readEnvNumber('AIDCP_FB_GROUP_JOIN_RETRY_BACKOFF_HOURS', 6) * 60 * 60 * 1000,
    maxAttempts: Math.max(1, Math.trunc(readEnvNumber('AIDCP_FB_GROUP_JOIN_MAX_ATTEMPTS', 3))),
    logger: console,
  });
  console.log(
    `[aidcp-cloud] CommentScheduler 已就绪（飞书 /comment 即用${commentApprovalEnabled ? '' : '；⚠️ AIDCP_COMMENT_APPROVAL 未开 → 人审口未接线、评论一律不发'}）`,
  );

  // A 阶段4 发帖触发器：复用已持久化的 ConceptStore/LikedNoteStore/PublishLogStore/RiskController 单例。
  // 缺概念池/点赞库（PG 不可用）则不建——manual /publish 回"未就绪"，不静默假发布。
  if (conceptStore && likedNoteStore) {
    // Block② 2e：内容生成触发端口。默认 local ⇒ publishGenerationPort === publishOrchestrator（同一实例，
    // 逐字节等价、零 HTTP）；仅当 AIDCP_GENERATION_TRANSPORT=http 且有 base URL 时才切「同步 kick + 分段 long-poll」HTTP 客户端。
    const generationTransport = readEnvString('AIDCP_GENERATION_TRANSPORT') === 'http' ? 'http' : 'local';
    const generationBaseUrl = readEnvString('AIDCP_GATEWAY_BASE_URL');
    const publishGenerationPort: SchedulerOrchestrator =
      generationTransport === 'http' && generationBaseUrl
        ? // 单次调用超时**必须 > 分段 long-poll 预算**（PUBLISH_GENERATION_POLL_SEGMENT_CEILING_MS=150s），
          // 否则每一段 poll 都会在服务端回 `{done:false}` 之前先被客户端切断 ⇒ 每次跨服务生成都在默认 15s
          // 确定性失败。取内部 HTTP 的 180s 硬顶（与 model-call 180s 天花板同源的既有常量，不新写魔数）。
          new PublishGenerationHttpClient(
            new InternalHttpClient(generationBaseUrl, { timeoutMs: INTERNAL_HTTP_TIMEOUT_CEILING_MS }),
          )
        : // 批次 0e：local 分支取内容段构造的编排器。automation 模式没跑内容段 ⇒ 它是 undefined，
          // 此前直接落穿成端口本体：每次发帖在调用点炸 TypeError、被上层 catch 归一成「失败」，
          // 而启动日志照打「已就绪」—— 排期发帖 100% 失败且**小时格幂等票在触发前就已认领**，
          // 失败一次就烧掉那一小时。改为响亮抛错并点名该配 http 传输，绝不静默回落。
          requireSegment(
            ctx.publishOrchestrator,
            'publishOrchestrator（跑自动化段但没跑内容段时，须设 AIDCP_GENERATION_TRANSPORT=http + AIDCP_GATEWAY_BASE_URL 指向 content 服务）',
            'content',
          );
    ctx.publishScheduler = new PublishScheduler({
      conceptStore,
      likedStore: likedNoteStore,
      publishLog: automationPublishLog,
      resolveRisk: resolveController,
      resolveSingleAccountId,
      getPlatform: (accountId) => accountStore?.getPlatform?.(accountId) ?? 'xiaohongshu',
      // persona-driven-content-pipeline：发布前人设闸——未绑人设的账号拒绝发布，绝不以打包默认人设生成（与浏览侧 canStartSession 同口径）。
      // 三态：副本陈旧 → persona_unavailable（可重试），绝不压成 needs_persona_setup（那会把委托任务永久判死）。
      personaBinding: (accountId) => personaStore.bindingFor(accountId),
      // 生成段账号归账（change parallel-rewrite-drafts）：账号随 TriggerInput.accountId 上黑板，
      // 每个角色的 LLM 调用显式取之记账——无进程级槽、无括起复位，并发生成各轮各归各账。
      orchestrator: publishGenerationPort,
      // 精选灵感语料（change curated-inspiration-corpus）：发帖创作正向素材来源；缺失则回落旧点赞素材路径。
      curatedStore: curatedContentStore,
      selectTopK: resolveCuratedGateConfig().selectTopK,
      // 人设取值口（change account-persona-config）：构建发布输入时按当前账号热加载。
      getSoul,
      conceptThreshold: Number(process.env.AIDCP_PUBLISH_CONCEPT_THRESHOLD ?? 20),
      minHoursBetween: Number(process.env.AIDCP_PUBLISH_MIN_HOURS ?? 24),
      // 并发准入（change parallel-rewrite-drafts）：账号在途帽（claim + DB 待审之和，覆盖全部触发入口）
      // + 全局并发生成帽（保护 LLM/生图供应商；上线先压 AIDCP_PUBLISH_IMAGE_CONCURRENCY 观察成功率）。
      countPendingForAccount: (accountId) => automationPublishLog.countPendingForAccount(accountId),
      pendingCapPerAccount: Number(process.env.AIDCP_PUBLISH_PENDING_CAP_PER_ACCOUNT ?? 20),
      maxConcurrentRuns: Number(process.env.AIDCP_PUBLISH_MAX_CONCURRENT_RUNS ?? 3),
      logger: console,
    });
    console.log('[aidcp-cloud] PublishScheduler 已就绪（手动 /publish 即用；洗稿并行=参照稿粒度）');

    // ── 内容排期调度器（change content-schedule-auto-publish，Phase 1 只发帖）────────────────
    // 每分钟心跳、按账号扇出、分钟错峰；到点只产草稿→飞书人审→approved 才发（AC-PUB 不动）。
    // 调度器在合法执行目标上常驻；账号周历/动作开关默认关闭并承担产品授权。
    if (deploymentTarget) {
      const contentScheduler: ContentScheduler = new ContentScheduler({
        onlineAccounts: () => ctx.runtimes?.onlineAccountIdentities() ?? [],
        executionTarget: deploymentTarget,
        claimPostHourCell: (identity, hourCell) =>
          contentScheduleStore.claimAutoPostHourCell({
            accountId: identity.accountId,
            envKey: identity.envKey,
            executionTarget: deploymentTarget,
            hourCell,
          }),
        scheduleFor: (accountId) => contentScheduleStore.effectiveScheduleFor(accountId),
        riskStatus: async (accountId) => (await resolveController(accountId)).getState().status,
        postedTodayCount: (accountId) => automationPublishLog.countPublishedTodayForAccount(accountId),
        // 日上限口径（change parallel-rewrite-drafts）：自主在途按真实条数计（防两张自动草稿都获批超发）；
        // 洗稿候选（source_reference 非空）不占排期日上限——由账号在途帽独立兜量，不堵 cap=1 账号的排期。
        pendingAutonomousCount: (accountId) => automationPublishLog.countPendingAutonomousForAccount(accountId),
        getPlatform: (accountId) => accountStore?.getPlatform?.(accountId) ?? 'xiaohongshu',
        availablePublishMediaCount: (accountId) =>
          facebookPublishMediaStore ? facebookPublishMediaStore.availableCount(accountId) : Promise.resolve(0),
        // 忙判定收窄为账号粒度自主单飞：洗稿在途不让排期槽（全局帽在 claim 层另行兜底）。
        isPublishBusy: (accountId) => ctx.publishScheduler?.isBusy(accountId) ?? false,
        delegatedOwnershipBusy: (accountId, family) =>
          delegatedTaskStore?.hasActiveOwnership(accountId, family) ?? false,
        // 自动 ⊆ 活跃（用户拍板：浏览休眠格绝不自动发内容）：读浏览周历掩码，沿其 fail-open（未配=全天活跃=不限）。
        browseActiveAt: (accountId, now) =>
          isWeekActiveAt(contentScheduleStore.effectiveActiveWeekMaskFor(accountId), now),
        // fire-and-forget：调度器只发起；结果（成功/诚实空槽/失败）在此异步补一张飞书卡，绝不静默假成功。
        triggerPost: async (accountId, approvalMode, scheduleExecution) => {
          let ok = false;
          let level: 'success' | 'warning' | 'error' = 'error';
          let title = '排期发帖失败';
          let message = 'unknown';
          try {
            const o = await ctx.publishScheduler!.triggerScheduled(accountId, approvalMode, scheduleExecution);
            if (o.result === 'triggered') {
              const st = o.status;
              if (st === 'pending_approval' || st === 'published' || st === 'draft') {
                ok = true;
                level = 'success';
                title =
                  approvalMode === 'auto_approve'
                    ? '排期发帖：已按免审预授权提交'
                    : '排期发帖：草稿已生成，待飞书人审';
                message =
                  approvalMode === 'auto_approve'
                    ? `status=${st}（后台免审已自动授权；下发仍由发布派发器复核/执行）`
                    : `status=${st}（真发仍须人审通过；未通过/超时一律不发）`;
              } else if (st === 'skipped') {
                level = 'warning';
                title = '排期发帖：本槽无新素材，本次不发';
                message = o.failureReason ?? '内容侦察判定无可用素材（诚实空槽，不硬凑内容）';
              } else {
                level = 'error';
                title = '排期发帖：编排未成';
                message = `status=${st}${o.failureReason ? `：${o.failureReason}` : ''}`;
              }
            } else {
              // blocked（未绑人设 / 风控非 normal / canDo 拒）→ 黄色如实回报。
              level = 'warning';
              title = '排期发帖：本槽被闸拦下，未触发';
              message = o.reason;
            }
          } catch (e) {
            message = (e as Error).message;
          }
          await deliverStructuredNotification({
            kind: 'command_result',
            input: {
                command: '排期发帖（自动）',
                ok,
                level,
                title,
                message,
                accountId,
              },
            })
            .catch((e) => console.warn('[content-scheduler] 排期结果卡发送失败：', (e as Error).message));
        },
        // 评论动作三件套（change content-schedule-comments）：commentScheduler 未建（PG 缺）则不注入 → 调度器整体跳过评论动作。
        ...(commentScheduler
          ? {
              // 触发排期评论：自动路径 MUST 过 canDo('comment') 配额闸（手动 /comment 跳配额、人是刹车；自动无人在场）。
              // 触发回执非 ok（配额拒 / 离线 / 未绑人设 / 在跑）回黄卡如实说明；任务终态结果卡由评论链自补（postResultCard），此处绝不重复发。
              triggerComment: async (accountId: string, approvalMode) => {
                const sendReceiptCard = async (level: 'warning' | 'error', title: string, message: string) => {
                  await deliverStructuredNotification({
                    kind: 'command_result',
                    input: {
                        command: '排期评论（自动）',
                        ok: false,
                        level,
                        title,
                        message,
                        accountId,
                      },
                    })
                    .catch((e) => console.warn('[content-scheduler] 排期评论回执卡发送失败：', (e as Error).message));
                };
                try {
                  const controller = await resolveController(accountId);
                  if (!controller.canDo('comment')) {
                    await sendReceiptCard('warning', '排期评论：配额拒绝，本槽未触发', `风控 canDo('comment')=false（自动路径必过配额；手动 /comment 不受此限）`);
                    return;
                  }
                  const receipt = await commentScheduler!.triggerManual(accountId, { priority: 'automatic', approvalMode });
                  if (!receipt.ok) {
                    // 瞬时未开始（边端离线 / 浏览器唤醒失败 / 租约不可得）：归还小时格、由调度器在本小时内有界重试。
                    // 此处**不发卡**——重试期间每次都发卡就是每分钟刷一张告警；放弃时由 onCellAbandoned 统一发一张。
                    if (receipt.code) return { started: false, reason: receipt.code };
                    // 持久性未触发（未绑人设 / 缺联系方式 / 已在跑）：重试无用，照旧烧掉本格并如实回卡。
                    await sendReceiptCard(receipt.level === 'error' ? 'error' : 'warning', `排期评论：${receipt.title}`, receipt.message);
                  }
                  // ok=任务已开跑：不发卡（评论链任务结束自补终态结果卡，避免双卡）。
                } catch (e) {
                  await sendReceiptCard('error', '排期评论：触发异常', (e as Error).message);
                }
              },
              isCommentBusy: (accountId: string) => commentScheduler!.isRunning(accountId),
              commentedTodayCount: (accountId: string) => riskStore.countInteractionsTodayForAccount(accountId, 'comment'),
              // 联系评论两件套（change content-schedule-group-comments → generalize-contact-info）：同一评论机器 + injectContact，
              // 尝试型持久日上限——触发回执 ok（任务真开跑）即记 attempt（被人审拒/无目标也占额度，保守方向）。
              triggerContactComment: async (accountId: string, approvalMode) => {
                const sendReceiptCard = async (level: 'warning' | 'error', title: string, message: string) => {
                  await deliverStructuredNotification({
                    kind: 'command_result',
                    input: {
                        command: '排期联系评论（自动）',
                        ok: false,
                        level,
                        title,
                        message,
                        accountId,
                      },
                    })
                    .catch((e) => console.warn('[content-scheduler] 排期联系评论回执卡发送失败：', (e as Error).message));
                };
                try {
                  const controller = await resolveController(accountId);
                  if (!controller.canDo('comment')) {
                    await sendReceiptCard('warning', '排期联系评论：配额拒绝，本槽未触发', `风控 canDo('comment')=false（自动路径必过配额；手动 /comment --contact 不受此限）`);
                    return;
                  }
                  const receipt = await commentScheduler!.triggerManual(accountId, {
                    injectContact: true,
                    priority: 'automatic',
                    approvalMode,
                  });
                  if (!receipt.ok) {
                    // 瞬时未开始：归还小时格、本小时内有界重试；不发卡（放弃时统一发一张）。不占尝试额度。
                    if (receipt.code) return { started: false, reason: receipt.code };
                    // 持久性未触发（缺联系方式 fail-closed / 未绑人设 / 在跑）：透传回执如实回卡；不占尝试额度。
                    await sendReceiptCard(receipt.level === 'error' ? 'error' : 'warning', `排期联系评论：${receipt.title}`, receipt.message);
                    return;
                  }
                  // 任务真开跑 → 记一条持久 attempt（尝试型日上限；重启不清零、绝不超发）。终态结果卡评论链自补。
                  const configCommands = apiDirectPorts.automationConfigCommands;
                  if (!configCommands) {
                    throw new Error('automation_config_commands_authority_unavailable');
                  }
                  await configCommands.recordContactCommentAttempt(accountId);
                } catch (e) {
                  await sendReceiptCard('error', '排期联系评论：触发异常', (e as Error).message);
                }
              },
              contactAttemptsTodayCount: (accountId: string) =>
                apiDirectPorts.automationConfigCommands
                  ? apiDirectPorts.automationConfigCommands.countContactAttemptsToday(
                      accountId,
                    )
                  : Promise.reject(
                      new Error('automation_config_commands_authority_unavailable'),
                    ),
            }
          : {}),
        triggerJoin: (accountId: string) => facebookGroupJoinScheduler.triggerScheduled(accountId),
        isJoinBusy: (accountId: string) => facebookGroupJoinScheduler.isRunning(accountId),
        joinedTodayCount: (accountId: string) => facebookGroupMembershipStore.countJoinedToday(accountId),
        joinDailyCap: async (accountId: string) => (await resolveController(accountId)).effectiveQuotas().day.join_group,
        joinAutomationFor: (accountId: string) => facebookGroupJoinAutomationStore.getForAccount(accountId),
        /**
         * 本小时格的有界重试用尽 → 发**一张**放弃卡（change browser-slot-scheduling）。
         * 重试期间刻意不发卡，否则边端离线一小时就是一串每分钟的告警噪声。
         */
        onCellAbandoned: (accountId: string, action: string, reason: string) => {
          void (async () => {
            await deliverStructuredNotification({
              kind: 'command_result',
              input: {
                  command: `排期${action === 'comment' ? '评论' : action === 'contact_comment' ? '联系评论' : action === 'join' ? '加群' : '发帖'}（自动）`,
                  ok: false,
                  level: 'warning',
                  title: '本小时未能开始，已放弃',
                  message: `多次尝试后仍未接管边端（原因：${reason}）。本小时未搜索、未选中、未发布；下一个小时格会重新尝试。`,
                  accountId,
                },
              })
              .catch((e) => console.warn('[content-scheduler] 放弃卡发送失败：', (e as Error).message));
          })();
        },
        logger: console,
      });
      contentSchedulerRef = contentScheduler; // 供评论管线回流「没开始」，见 onScheduledTaskNotStarted
      contentScheduler.start(60_000);
      console.log('[aidcp-cloud] ContentScheduler 已启动（每分钟心跳、按账号错峰；账号配置为唯一产品授权）');
    } else {
      console.warn(
        `[aidcp-cloud] ContentScheduler 未启动：AIDCP_DEPLOY_ENV=${JSON.stringify(readEnvString('AIDCP_DEPLOY_ENV') ?? null)} ` +
          '不是 dev/ol，自动执行环境无法安全盖章',
      );
    }
    // Mock 触发（仅 AIDCP_MOCK_PUBLISH=true；无飞书时驱动一次发帖，诊断/联调用）：
    // 监视信号文件 → 等价飞书 /publish 的 triggerManual(forced)；文件触发后即删避免重复。
    // 红线不旁路：发布前 AC-PUB 人审信号（/tmp/aidcp-publish-approve-<requestId>.json）仍铁定生效，未授权绝不发布。
    if (readEnvString('AIDCP_MOCK_PUBLISH') === 'true') {
      const triggerFile = '/tmp/aidcp-mock-publish-trigger';
      setInterval(async () => {
        let raw: string;
        try {
          raw = await readFile(triggerFile, 'utf8');
        } catch {
          return; // 文件不存在 → 不触发
        }
        await unlink(triggerFile).catch(() => {});
        // 文件内容（trim 后非空）视为目标账号 id——多账号部署下 triggerManual() 无参会因解析不出唯一账号被拒；
        // 空文件保持旧语义（解析唯一账号）。人设闸 + AC-PUB 人审闸照常生效，绝不旁路。
        const mockAccount = raw.trim() || undefined;
        console.log(`[aidcp-cloud] MOCK publish 触发命中 → triggerManual(${mockAccount ?? '(唯一账号)'})`);
        ctx.publishScheduler!.triggerManual(mockAccount).catch((e) => console.warn('[aidcp-cloud] MOCK triggerManual err:', e));
      }, 3000);
      console.log('[aidcp-cloud] MOCK publish 触发已开启（touch /tmp/aidcp-mock-publish-trigger 触发一次；文件内容可写目标账号 id）');
    }
  } else {
    console.warn('[aidcp-cloud] PublishScheduler 未建（ConceptStore/LikedNoteStore 不可用），发帖触发不可用');
  }

  // DelegatedTask execution is late-bound after both schedulers and PublishDispatcher are ready.
  if (delegatedTaskStore && delegatedTaskService && commentScheduler && ctx.publishScheduler) {
    const loadCandidate = async (recordId: number) => {
      const draft = await automationPublishLog.loadForDispatch(recordId);
      if (!draft) return null;
      const platform = draft.platform ?? 'xiaohongshu';
      // Delegated candidates belong to the existing proactive publishing
      // domain. Video Channels is intentionally inbox-only in this session.
      if (platform === 'wechat_channels') return null;
      return {
        recordId: draft.recordId,
        accountId: draft.accountId,
        platform,
        status: draft.status,
        contentVersion: draft.contentVersion,
        title: draft.title,
        content: draft.content,
        images: draft.imageUrls,
        userRejected: hasUserRejectionEvidence(draft.metadata),
      };
    };
    const delegatedExecutors = createDelegatedExecutorRouter({
      comments: commentScheduler,
      publishes: ctx.publishScheduler,
      loadCandidate,
      approveCandidate: async (candidate, decidedBy) => {
        const draft = await automationPublishLog.loadForDispatch(candidate.recordId);
        if (!draft || draft.contentVersion !== candidate.contentVersion) return loadCandidate(candidate.recordId);
        const requestId = `publish-${candidate.recordId}`;
        const preflight = await preflightApprovePublish(requestId);
        if (!preflight.ok) throw new Error(`candidate_deferred:${preflight.reason}`);
        const tags = Array.isArray(draft.metadata?.topics)
          ? draft.metadata.topics.filter((item): item is string => typeof item === 'string')
          : [];
        const result = await writeApprovalDecision(
          requestId,
          true,
          { title: draft.title ?? '', content: draft.content, tags, contentVersion: draft.contentVersion },
          { decidedBy, decidedVia: 'delegated_task' },
        );
        if (!result.written && result.alreadyDecided !== true) throw new Error('candidate_already_rejected');
        if (!result.written && result.alreadyDecided === true) {
          await triggerPublishDispatchOnApprove(requestId, result.revision, 'human_reconfirm');
        }
        return loadCandidate(candidate.recordId);
      },
      rejectCandidate: async (candidate, decidedBy) => {
        const draft = await automationPublishLog.loadForDispatch(candidate.recordId);
        if (!draft || draft.contentVersion !== candidate.contentVersion) return loadCandidate(candidate.recordId);
        const requestId = `publish-${candidate.recordId}`;
        const tags = Array.isArray(draft.metadata?.topics)
          ? draft.metadata.topics.filter((item): item is string => typeof item === 'string')
          : [];
        const result = await writeApprovalDecision(
          requestId,
          false,
          { title: draft.title ?? '', content: draft.content, tags, contentVersion: draft.contentVersion },
          { decidedBy, decidedVia: 'delegated_task' },
        );
        if (!result.written && result.alreadyDecided !== false) throw new Error('candidate_already_approved');
        await automationPublishLog.rejectPendingApproval(candidate.recordId);
        notifyPublishRejected(requestId);
        return loadCandidate(candidate.recordId);
      },
      modifyCandidate: async (candidate, patch) => {
        const result = await automationPublishLog.editDraft(candidate.recordId, candidate.contentVersion, patch, 'delegated-task');
        if (!result.ok) throw new Error(`candidate_edit_${result.reason}`);
        refreshPublishPreview(candidate.recordId);
        return loadCandidate(candidate.recordId);
      },
      terminalWaitMs: readEnvNumber('AIDCP_DELEGATED_TASK_TERMINAL_WAIT_MS', 4 * 60_000),
    });
    const delegatedTaskNotificationGate = new DelegatedTaskNotificationGate();
    const delegatedTaskMaxConcurrent = Math.max(
      1,
      Math.trunc(readEnvNumber('AIDCP_DELEGATED_TASK_MAX_CONCURRENT', 3)),
    );
    const worker = new DelegatedTaskWorker({
      store: delegatedTaskStore,
      executorFor: delegatedExecutors.executorFor,
      externalBusy: delegatedExecutors.externalBusy,
      platformStillMatches: async (task) => (await accountStore?.getPlatform?.(task.accountId)) === task.platform,
      onTaskUpdated: async (task: DelegatedTask) => {
        // 委托层不再主动推送任务进度卡（change feishu-delegated-suppress-progress-cards）：结果由每类任务
        // 自己的正常业务结果卡承担（评论链 postResultCard / 发帖人审卡自证成功）。兜底＝没有独立结果卡的终态失败
        // 补一张避免静默（红线：绝不静默失败）——发帖类终态失败，以及评论类「起跑前触发闸失败」（评论链从未起跑、
        // 未发过结果卡；change delegated-executor-operator-authority-parity）。
        const receipt = delegatedTaskFailureReceipt(task);
        if (!receipt) return;
        if (!delegatedTaskNotificationGate.shouldSend(task)) return;
        // change restore-delegated-command-card-origin-chat：命令触发的终态卡回来源会话（操作员触发、操作员收结果）；
        // 无来源会话（自动 / 排期 / 旧行）补集式回落账号→团队群路由，零回归。
        const originChatId = task.originChatId?.trim();
        const commandLabel = task.actionFamily === 'comment' ? '评论' : '发帖';
        console.log(
          `[delegated-task] ${commandLabel}终态失败卡 task=${task.id} account=${task.accountId} sink=${originChatId ? 'origin' : 'account_team'}`,
        );
        try {
          await deliverStructuredNotification({
            kind: 'command_result',
            input: {
              command: commandLabel,
              ok: false,
              level: receipt.level,
              title: receipt.title,
              message: receipt.message,
              accountId: task.accountId,
              originChatId,
              // change delegated-terminal-failure-reason：平台名 additive 补齐（cards.ts 的 platformLine 是
              // 现成条件片段）——多账号多平台并行时，光有昵称不够定位是哪条线出的事。
              platformName: platformRegistryEntry(task.platform).displayName,
            },
          }, `delegated-task-result:${task.id}:${task.status}`);
          delegatedTaskNotificationGate.markSent(task);
        } catch (err) {
          console.warn(`[delegated-task] ${commandLabel}失败结果卡发送失败 task=${task.id}: ${(err as Error).message}`);
        }
      },
      maxConcurrent: delegatedTaskMaxConcurrent,
      logger: console,
    });
    if (readEnvString('AIDCP_DELEGATED_TASK_WORKER') !== 'false') {
      // recover-stale-delegated-executions：新进程没有任何存活的本地执行；先收敛旧进程遗留的
      // planning/executing claim，再开放 pump，避免旧 ownership 把同源重洗卡到 24h deadline。
      await worker.start(readEnvNumber('AIDCP_DELEGATED_TASK_POLL_MS', 5_000));
      console.log(`[aidcp-cloud] DelegatedTaskWorker 已启动（automatic priority；安全边界 pause/cancel；并发=${delegatedTaskMaxConcurrent}）`);
    } else {
      console.warn('[aidcp-cloud] DelegatedTaskWorker 已禁用（任务可确认但不会执行）');
    }
  } else if (delegatedTaskService) {
    console.warn('[aidcp-cloud] DelegatedTask 执行器未就绪（评论或发布 scheduler 缺失）；任务服务保持 fail-visible');
  }
  // 旧 TODO(temp) /debug/publish 调试口已删除（A 阶段4）：发帖只经 PublishScheduler 三扳机 + 发布前人审。
  // Feishu WS ingress is composed by segD after API owner and remote command
  // clients are available.
  // 角色 prompt 只读预览（change role-prompt-visibility）：借仅供预览的 RoleDispatcher 渲染真实 prompt。
  // 人设选择框（change prompt-preview-persona-selector）：给定 accountId 时把预览 dispatcher 当前账号临时切到
  // 该账号、同步渲染、finally 还原（previewPrompt 全程同步、单线程无交错，故原子安全）；hasPersona 用不回落的
  // getForAccount 判定该账号是否真有人设行（无行则诚实标 personaFallback、绝不冒充）。
  const rolePromptProvider = createRolePromptProvider(() => [...previewDispatcher.getRoles(), ...previewOnlyRoles], {
    withAccount: (accountId, fn) => {
      const prev = previewDispatcher.accountId;
      previewDispatcher.setCurrentAccountId(accountId);
      try {
        return fn();
      } finally {
        previewDispatcher.setCurrentAccountId(prev);
      }
    },
    hasPersona: (accountId) => personaStore.getForAccount(accountId) !== null,
    getPersona: (accountId) => resolvePersona(accountId),
    // P4-7：发布 / 图像预览的渲染闭包表由组合根注入（content 属主实装），api 侧的预览提供方不再直连。
    publishPreviewBuilders: PUBLISH_PREVIEW_BUILDERS,
    imagePromptPreviewBuilders: IMAGE_PROMPT_PREVIEW_BUILDERS,
  });

  ctx.accountPersonaService = accountPersonaService;
  ctx.alertStore = alertStore;
  ctx.approvePublishForClient = approvePublishForClient;
  ctx.buildTodayUsageForAccount = buildTodayUsageForAccount;
  ctx.captchaAssist = captchaAssist;
  ctx.commentScheduler = commentScheduler;
  ctx.configMirrorRefresher = configMirrorRefresher;
  ctx.handlePublishDraftImageRemove = handlePublishDraftImageRemove;
  ctx.interactionCustomerApi = interactionCustomerApi;
  ctx.interactionInternalApi = interactionInternalApi;
  ctx.interactionOffboarding = interactionOffboarding;
  ctx.interactionPermissionOverview = interactionPermissionOverview;
  ctx.listAccountAutomationCatalog = listAccountAutomationCatalog;
  ctx.notifyPublishRejected = notifyPublishRejected;
  ctx.panelUsers = panelUsers;
  ctx.personaAutoFill = personaAutoFill;
  ctx.preflightApprovePublish = preflightApprovePublish;
  ctx.publishDispatcher = publishDispatcher;
  ctx.readLiveContentVersion = readLiveContentVersion;
  ctx.readPublishApproval = readPublishApproval;
  ctx.refreshPublishPreview = refreshPublishPreview;
  ctx.resolveController = resolveController;
  ctx.riskRegistry = riskRegistry;
  ctx.rolePromptProvider = rolePromptProvider;
  ctx.server = server;
  ctx.automationDispatchCommands = {
    dispatch: async (accountId, action) => {
      const want = action === 'start';
      const changed = dispatchActive !== want;
      if (changed) {
        dispatchActive = want;
        if (want) ctx.runtimes?.startAll();
        else ctx.runtimes?.endAll('panel_dispatch_stop');
      }
      return {
        accountId,
        dispatch: want ? 'started' : 'stopped',
        changed,
        edgesOnline: server.onlineEdgeCount(),
      };
    },
    dispatchActive: () => dispatchActive,
  };
  // risk.command backlog 只能在真实 Edge resume 依赖就绪后开始消费；此前 LISTEN wake 会被未启动 consumer 忽略，
  // start() 立即跑首轮并承接全部 backlog，不丢通知。
  riskCommandConsumer?.start();
  ctx.triggerPublishDispatchOnApprove = triggerPublishDispatchOnApprove;
}

/**
 * 本进程要连**哪些属主库** —— 建池与启动期 schema 契约门共用的**唯一事实源**（Block④ 批次 0）。
 *
 * 今天恒为全部三个：基础段 `server.ts` 的三行建池**无条件执行、零模式门控**，任何服务模式都连三个库。
 * 因此 MUST NOT 按 `AIDCP_SERVICE` 收窄本函数 —— 那会让契约门校验得比进程实际使用的少，
 * 正好造出这道门存在的意义（enforce 假绿）的反面：库里少一张表，门却说通过。
 *
 * 批次 0d 把基础段的池按消费方收窄之后，改这里一处即可，契约门自动跟随；
 * 两侧是否一致由 {@link assertOwnerPoolsMatchProcessOwners} 在启动期钉死。
 */
function pgOwnersForProcess(): readonly PgOwner[] {
  return PG_OWNERS;
}

/** 建池集合必须与 {@link pgOwnersForProcess} 逐个吻合；对不上即拒绝启动（不是告警）。 */
function assertOwnerPoolsMatchProcessOwners(pools: Partial<Record<PgOwner, unknown>>): void {
  const declared = [...pgOwnersForProcess()].sort();
  const built = (Object.keys(pools) as PgOwner[]).filter((o) => pools[o] !== undefined).sort();
  if (declared.join(',') !== built.join(',')) {
    throw new Error(
      `owner_pool_scope_mismatch: 声明要连 [${declared.join(',')}]，实际建池 [${built.join(',')}]。` +
        `两者必须一致 —— 否则要么 schema 契约门在校验本进程没连的库，要么真在用的库没被校验。`,
    );
  }
}

/**
 * 跨段依赖的**取用闸**（Block④ 三仓提取 · 批次 0e）。
 *
 * `CompositionContext` 的字段现已按「在哪一段被赋值」如实声明：基础段 74 个保持非可选，
 * 只在内容段（3）/自动化段（38）赋值的一律可选 —— **本进程没跑那一段，字段就是 `undefined`**。
 *
 * 此前它们全声明成非可选、而上下文由 `{} as CompositionContext` 造出，等于**类型系统在替谎言背书**：
 * `npm run typecheck` 对「api 模式下 47 个字段根本没被赋值」完全失明（全仓也没有任何一条测试
 * 跑过 api 模式启动），落到运行时就是裸 TypeError —— 被上层 catch 归一成「失败」，而启动日志照打「已就绪」。
 * 改成可选后编译器一次性列出 33 处未守卫使用点，本闸就是逐处收口用的。
 *
 * 两个形态，按「什么时候才需要它」选：
 *   - {@link requireSegment}：**构造期**就要。缺了带字段名与来源段响亮抛错 —— 宁可这个模式起不来，
 *     也不让 `undefined` 落穿到运行时。错误里点名缺什么，下一批补跨进程端口时照着做。
 *   - {@link unavailableInMode}：**请求期**才调用（惰性闭包里）。缺了返回一个 reject 具名错误的函数，
 *     让那条路由诚实失败、其余路由照常 —— 命名照本段既有的 `*_unavailable_in_api_mode` 范式。
 *
 * MUST NOT 用空对象、`?? null` 或吞掉错误的默认值收口：那正是本仓头号红线「静默假成功」。
 */
function requireSegment<T>(value: T | undefined, field: string, segment: string): T {
  if (value === undefined) {
    throw new Error(
      `composition_dependency_unavailable: ${field}（由 ${segment} 段构造，本进程未运行该段）`,
    );
  }
  return value;
}

/** 请求期才用的跨段依赖：缺了返回 reject 具名错误的函数，绝不返回 undefined 让调用点炸成 TypeError。 */
function unavailableInMode(field: string): (...args: never[]) => Promise<never> {
  return () => Promise.reject(new Error(`${field}_unavailable_in_this_service_mode`));
}

/**
 * 跨段**前向引用**闸（Block④ 三仓提取 · 批次 0b）。
 *
 * 形状：基础段 / 内容段在**装配期**构造一个回调，回调体里读一个由**自动化段**赋值的句柄。
 * 单体里自动化段恒跑、回调又只在请求期触发，于是永远读得到 —— 前向引用毫无代价。
 * 三等分后 api / content 进程根本不跑自动化段，同一行就变成读 `undefined`。
 *
 * 此前这几处一律写成 `ctx.X?.doSomething()`：**缺了就静默短路，调用方照样拿到「成功」**。
 * 后果分别是「人设绑定了却没有任何会话被唤醒」「稿件审批通过了却没有任何东西被下发」
 * 「状态变了却没有任何界面收到推送」—— 全部落在本仓头号红线「静默假成功」上，
 * 且没有任何机械手段看得见：类型系统对 `?.` 短路无话可说，日志里也不会留下一个字。
 *
 * 本闸**不改变有实现时的行为**（单体逐字节等价），只把「没实现」那一支从静默改成响亮：
 * 记一条带 `cross_segment_drop:` 前缀的 error，点名丢了谁的哪个动作、由哪一段承接。
 * 批次 3/4 把 `undefined` 分支换成真正的跨进程调用；在那之前它至少是**可被发现**的。
 *
 * 与 {@link requireSegment} 的分工：那个是**构造期**就必须有、缺了直接拒绝启动；本闸是请求期才知道缺，
 * 且不能因此把调用链整条炸掉（一次界面推送失败不该让发布事务回滚），所以是响亮记账而非抛错。
 *
 * MUST NOT 退回裸 `ctx.X?.…`：`test/server-startup-order.test.ts` 有一条机械回归会当场拦下。
 */
function crossSegment<T>(
  handle: T | null | undefined,
  droppedAction: string,
  ownerSegment: string,
  consequence: string,
): T | undefined {
  if (handle !== undefined && handle !== null) return handle;
  console.error(
    `[aidcp-cloud] cross_segment_drop: ${droppedAction} 未执行` +
      `（该能力由${ownerSegment}构造，本进程未运行该段）—— ${consequence}`,
  );
  return undefined;
}

async function segDApiServing(ctx: CompositionContext): Promise<void> {
  const { accountDisplayName, accountPersonaService, accountStore, alertStore, apiPool, apiFeishuOwner, approvalPolicyStore, approvePublishForClient, automationPool, buildTodayUsageForAccount, captchaAssist, categoryConfigStore, clientUserStore, commentScheduler, configMirrorRefresher, contentScheduleStore, credentialStore, curatedContentStore, delegatedTaskService, draftRefinementStore, eventBus, facebookCommentConfigStore, facebookGroupJoinAuditStore, facebookGroupJoinAutomationStore, facebookGroupMembershipStore, facebookGroupTargetStore, facebookPublishMediaStore, groupRouteStore, handlePublishDraftImageRemove, hotLeadConfigStore, interactionCustomerApi, interactionInternalApi, interactionOffboarding, interactionPermissionOverview, listAccountAutomationCatalog, llm, modelConfigStore, notificationContactStore, notifyPublishRejected, pacingConfigStore, personaAutoFill, personaPanel, personaStore, port, preflightApprovePublish, publishApprovalStore, publishDispatcher, publishLogStore, publishOrchestrator, quotaConfigStore, readLiveContentVersion, readPublishApproval, refreshPublishPreview, resumeConfigStore, riskRegistry, roleConfigStore, rolePromptProvider, server, sessionConfigStore, tokenUsageStore, writeApprovalDecision } = ctx;
  // ── Block④ 三仓提取 · 批次 0c：面板配置外观从 segC 上提到本段 ────────────────────────
  // 判据＝**构造只依赖 segA**（llm / modelConfigStore / 六个配置 store 全在 segA）。它们只被本段消费，
  // 原先建在 segC 再经 ctx 绕一圈回来 —— 那让 api 模式白白依赖 automation 段。就地建，零跨段依赖。
  // MUST NOT 顺手搬 rolePromptProvider / listAccountAutomationCatalog / botChatsProvider：
  // 它们构造时真依赖 segC 的预览调度器 / 风控控制器 / 边缘服务端 —— 那些要走端口，不是搬家。
  // 组装平台配置视图（GET /api/config/model 与 setModel 回真态共用）。永不含明文密钥。
  // change platform-provider-credentials-config：多厂商模型配置 + 平台凭据态（模型 API key / 账单 AccessKey）。
  const buildModelConfigView = async (): Promise<ModelConfigView> => {
    const cfg = modelConfigStore.getCached();
    const ids = Object.keys(TEXT_PROVIDERS) as TextProviderId[];
    const providers = ids.map((id) => ({
      id,
      displayName: TEXT_PROVIDERS[id].displayName,
      baseUrl: resolveProviderBaseUrl(id),
    }));
    const credentials = await Promise.all(
      PLATFORM_CREDENTIALS.map(async (cred) => {
        const stored = await credentialStore.getStored(cred.provider, cred.field).catch(() => null);
        const envPresent = !!resolvePlatformCredentialEnvValue(cred);
        const base = {
          provider: cred.provider,
          field: cred.field,
          label: cred.label,
          providerLabel: cred.providerLabel,
          group: cred.group,
          groupLabel: cred.groupLabel,
          secretKind: cred.secretKind,
          restartRequired: cred.restartRequired,
        };
        return stored
          ? { ...base, configured: true, maskedHint: stored.maskedHint, source: 'db' as const }
          : envPresent
            ? { ...base, configured: true, maskedHint: '（来自环境变量）', source: 'env' as const }
            : { ...base, configured: false, maskedHint: null, source: 'none' as const };
      }),
    );
    // change image-provider-volcengine-seedream：图片厂商也可选（万相/即梦 Seedream），独立于文本厂商。
    const imageProviders = (Object.keys(IMAGE_PROVIDERS) as ImageProviderId[]).map((id) => ({
      id,
      displayName: IMAGE_PROVIDERS[id].displayName,
    }));
    return {
      textProvider: normProvider(cfg.textProvider),
      imageProvider: normImageProvider(cfg.imageProvider),
      textModel: cfg.textModel,
      imageModel: cfg.imageModel,
      providers,
      imageProviders,
      credentials,
      canEditCredential: credentialStore.canEdit(),
    };
  };

  // 显式 provider + model 覆盖 + 短超时；探活按 provider 路由到正确端点+密钥。
  // 失败抛错 → facade 区分 provider_key_missing（密钥缺失）与 model_invalid，绝不落库。
  // role 'system:model_probe'：探活真实消耗 token，如实记、可区分、不静默丢（change llm-token-usage-stats）。
  const probeModel = async (provider: string, model: string): Promise<void> => {
    await llm.chat([{ role: 'user', content: 'ping' }], { provider, model, timeoutMs: 8000, role: 'system:model_probe' });
  };
  // P4-4：探活错误的**分类**挪到组合根（它本来就持有厂商客户端与错误类），外观只收结果型。
  // 两种原因仍逐一可分，对外 reason 串逐字不变。写法与本文件 6300+ 全局模型面板那处 instanceof 同款。
  const probeModelResult = async (provider: string, model: string): Promise<ModelProbeResult> => {
    try {
      await probeModel(provider, model);
      return { ok: true };
    } catch (e) {
      if (e instanceof ProviderKeyMissingError) return { ok: false, reason: 'provider_key_missing' };
      return { ok: false, reason: 'model_unavailable' };
    }
  };
  const thinkingOnAvailable = (provider: string, model: string): boolean =>
    Object.keys(buildThinkingParams(provider, model, 'on').params).length > 0;
  // 角色配置面板外观（change console-role-model-config + model-config-volcengine-provider）：白名单 + 生效值视图（含 provider）+ 写校验 + 按 provider 探活。
  const roleConfigPanel = createRoleConfigPanel({
    store: roleConfigStore,
    getGlobalTextModel: () => modelConfigStore.getCached().textModel,
    getGlobalTextProvider: () => modelConfigStore.getCached().textProvider,
    getGlobalImageModel: () => modelConfigStore.getCached().imageModel,
    getGlobalImageProvider: () => modelConfigStore.getCached().imageProvider,
    getCategoryModel: (categoryId) => categoryConfigStore.getForCategory(categoryId).model,
    getCategoryProvider: (categoryId) => categoryConfigStore.getForCategory(categoryId).provider,
    getCategoryThinking: (categoryId) => categoryConfigStore.getForCategory(categoryId).thinkingMode,
    thinkingOnAvailable,
    getVisionModel: resolveCoverFormModel,
    getVisionProvider: resolveCoverFormProvider,
    probeModel: probeModelResult,
  });
  // 分类默认模型面板外观（change role-model-category-config + model-config-volcengine-provider）：白名单 + 生效值视图（含 provider）+ 写校验 + 按 provider 探活。
  const categoryConfigPanel = createCategoryConfigPanel({
    store: categoryConfigStore,
    getGlobalTextModel: () => modelConfigStore.getCached().textModel,
    getGlobalTextProvider: () => modelConfigStore.getCached().textProvider,
    thinkingOnAvailable,
    probeModel: probeModelResult,
  });
  // ── Block② 2e：运行模式（纯选择器，与 main() 同源）。segD 只在 monolith / api / core 跑。─────
  const mode = serviceModeFromEnv();
  const { deploymentTarget } = ctx; // 'dev'|'ol'|null（segA 设）；outbox emit / 消费的 executionTarget。
  const panelEventFanout = mode === 'api' ? new PanelEventFanout(console) : undefined;
  ctx.panelEventFanout = panelEventFanout;
  const configuredAutomationUrl = readEnvString('AIDCP_AUTOMATION_URL');
  if (mode === 'api' && !configuredAutomationUrl) {
    throw new Error('AIDCP_AUTOMATION_URL is required in api mode');
  }
  if (mode === 'api' && !deploymentTarget) {
    throw new Error('AIDCP_DEPLOY_ENV is required in api mode');
  }
  const automationBaseUrl =
    configuredAutomationUrl ?? `http://127.0.0.1:${DEFAULT_AUTOMATION_INTERNAL_API_PORT}`;
  const automationHttp = new InternalHttpClient(automationBaseUrl);
  const automationDirectToken =
    mode === 'api'
      ? requireDirectInternalToken('AIDCP_AUTOMATION_INTERNAL_TOKEN')
      : undefined;
  const edgeResumeCommand =
    mode === 'api' && deploymentTarget && automationDirectToken
      ? new EdgeResumeCommandHttpClient(
          automationHttp,
          automationDirectToken,
          deploymentTarget,
        )
      : undefined;
  const facebookScopeCommand =
    mode === 'api' && deploymentTarget && automationDirectToken
      ? new FacebookScopeCommandHttpClient(
          automationHttp,
          automationDirectToken,
          deploymentTarget,
        )
      : undefined;
  const publishUiUpdateCommand =
    mode === 'api' && deploymentTarget && automationDirectToken
      ? new PublishUiUpdateCommandHttpClient(
          automationHttp,
          automationDirectToken,
          deploymentTarget,
        )
      : ctx.publishUiUpdateCommand;
  ctx.publishUiUpdateCommand = publishUiUpdateCommand;
  const feishuOwner = requireSegment(
    apiFeishuOwner,
    'apiFeishuOwner',
    'api',
  );
  const requireCommandAccount = async (
    accountId?: string,
  ): Promise<string> => {
    if (accountId) return accountId;
    if (!accountStore) {
      throw new Error('account_store_unavailable');
    }
    const accounts = await accountStore.listAll();
    if (accounts.length === 1) return accounts[0].accountId;
    throw new Error(
      '当前为 0 个或多个账号，请显式指定账号，例如 `/status <accountId>`',
    );
  };
  const resolveAccountByNickname = async (
    nickname?: string,
  ): Promise<string> => {
    if (!accountStore) {
      throw new Error('账号存储未就绪，无法按昵称解析账号');
    }
    const accounts = await accountStore.listAll();
    if (!nickname) {
      if (accounts.length === 1) return accounts[0].accountId;
      throw new Error(
        '当前为 0 个或多个账号，请用昵称指定，例如 `/publish 工程师大白`',
      );
    }
    const result = matchAccountNickname(
      nickname,
      accounts.map((account) => ({
        accountId: account.accountId,
        displayName: accountDisplayName(account.accountId) ?? null,
        names: ctx.accountDisplayNameCandidates(account.accountId),
      })),
    );
    if (result.ok) return result.accountId;
    if (result.reason === 'ambiguous') {
      throw new Error(
        `有多个账号匹配昵称「${nickname}」（${result.available.join('、')}），请去重后再试`,
      );
    }
    throw new Error(
      `找不到昵称「${nickname}」的账号。可用昵称：${result.available.join('、') || '(无)'}`,
    );
  };
  const resumeEdgesForAccount: CommandFaceDeps['account']['resumeEdgesForAccount'] =
    async (accountId) => {
      if (mode !== 'api') {
        if (!server) {
          return {
            state: 'failed',
            reason: 'edge_resume_authority_unavailable',
          };
        }
        return {
          state: 'applied',
          resumedEdges: server.resumeEdgesForAccount(accountId),
        };
      }
      if (!edgeResumeCommand) {
        return {
          state: 'failed',
          reason: 'edge_resume_authority_unavailable',
        };
      }
      try {
        const receipt = await edgeResumeCommand.resumeEdgesForAccount({
          commandId: randomUUID(),
          accountId,
        });
        return receipt.outcome === 'collision'
          ? {
              state: 'failed',
              reason: 'edge_resume_command_collision',
            }
          : {
              state: 'applied',
              resumedEdges: receipt.resumedEdges,
            };
      } catch (error) {
        const code =
          typeof error === 'object'
          && error !== null
          && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'edge_resume_failed';
        return {
          state:
            code === 'edge_resume_result_unknown'
              ? 'unknown'
              : 'failed',
          reason: code,
        };
      }
    };
  const managementChatIds = new Set(
    (readEnvString('FEISHU_MANAGEMENT_CHAT_IDS') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const commandFace: CommandFace = feishuOwner.createCommandFace({
    account: {
      requireCommandAccount,
      getStatus: (accountId) => ctx.accountState.getStatus(accountId),
      pause: (accountId) => ctx.accountState.pause(accountId),
      resume: (accountId) => ctx.accountState.resume(accountId),
      resumeEdgesForAccount,
    },
    bindChat: (record) => feishuOwner.botChatStore.setDefault(record),
    delegate: async (text, context) => {
      if (!delegatedTaskService) {
        throw new Error('automation_operator_command_unavailable:delegate');
      }
      const result = await delegatedTaskService.createFromText(text, {
        sourceRef: context?.messageId ?? context?.chatId,
        originChatId: context?.chatId,
      });
      if (result.kind === 'control') {
        const request = result.request;
        const task =
          request.action === 'pause'
            ? await delegatedTaskService.pause(request.taskId)
            : request.action === 'resume'
              ? await delegatedTaskService.resume(request.taskId)
              : request.action === 'cancel'
                ? await delegatedTaskService.cancel(request.taskId)
                : await delegatedTaskService.get(request.taskId);
        return {
          command: text,
          ok: true,
          title: '委托任务当前状态',
          message:
            `任务 ${task.id} 当前为 ${task.status}，真实完成 ` +
            `${task.progress.successCount}/${task.targetSuccessCount}。`,
          accountId: task.accountId,
          accountName: task.accountName,
          platformName: task.platform,
          card: feishuOwner.buildDelegatedTaskProgressCard(task),
        };
      }
      if (result.autoQueued) {
        return {
          command: text,
          ok: true,
          title: '委托任务已直接排队',
          message: '精确命令已直接入队；结果由任务自身的结果卡回报。',
          accountId: result.task.accountId,
          accountName: result.task.accountName,
          platformName: result.task.platform,
          silent: true,
        };
      }
      return {
        command: text,
        ok: true,
        title: result.created
          ? '委托任务待确认'
          : '已存在相同待确认任务',
        message: '确认前不会执行任何平台写动作。',
        accountId: result.task.accountId,
        accountName: result.task.accountName,
        platformName: result.task.platform,
        card: feishuOwner.buildDelegatedTaskConfirmationCard(
          result.confirmation,
        ),
      };
    },
    publish: async (nickname, options) => {
      if (!ctx.publishScheduler) {
        return {
          ok: false,
          level: 'error',
          title: '发帖未触发',
          message:
            mode === 'api'
              ? 'automation_operator_command_unavailable:publish'
              : '发帖触发器未就绪（PG / 概念池不可用），未发起任何编排。',
        };
      }
      const accountId = await resolveAccountByNickname(nickname);
      const outcome = await ctx.publishScheduler.triggerManual(accountId, {
        manualApprovalChatId: options?.sourceChatId,
      });
      if (outcome.result !== 'triggered') {
        return {
          ok: false,
          level: 'warning',
          title: '发帖未触发',
          message: `账号 \`${accountId}\` 未触发：${outcome.reason}`,
        };
      }
      const head =
        `已触发（${outcome.reason}）→ 账号 \`${accountId}\` → ` +
        `编排状态 ${outcome.status}`;
      const why = outcome.failureReason
        ? `\n原因：${outcome.failureReason}`
        : '';
      if (outcome.status === 'failed' || outcome.status === 'timeout') {
        return {
          ok: false,
          level: 'error',
          title: '发帖编排失败',
          message:
            `${head}${why}\n（编排在生成候审阶段失败，未发审批卡；` +
            '请查云端日志或重试 /publish）',
        };
      }
      if (outcome.status === 'skipped') {
        return {
          ok: false,
          level: 'warning',
          title: '发帖未产出',
          message: `${head}${why}`,
        };
      }
      if (outcome.approvalCard && !outcome.approvalCard.sent) {
        const target = outcome.approvalCard.targetChatId
          ? `目标会话 \`${outcome.approvalCard.targetChatId}\``
          : '未解析到目标会话';
        const error = outcome.approvalCard.error
          ? `\n发卡错误：${outcome.approvalCard.error}`
          : '';
        return {
          ok: false,
          level: 'warning',
          title: '草稿已生成，审批卡未送达',
          message:
            `${head}\n已生成待审草稿，但审批卡没有送达（${target}）。` +
            `${error}\n请在控制台审批，或修复飞书会话权限后重试。`,
        };
      }
      return {
        ok: true,
        level: 'success',
        title: '已触发发帖编排',
        message:
          `${head}\n（账号昵称 \`${nickname ?? '(唯一账号)'}\`；` +
          '人工授权越过风控，但发布前仍需飞书人审 approved=true 才会真发）',
      };
    },
    comment: async (nickname, options) => {
      if (!commentScheduler) {
        return {
          ok: false,
          level: 'error',
          title: '按需评论未就绪',
          message:
            mode === 'api'
              ? 'automation_operator_command_unavailable:comment'
              : '评论触发器未就绪（启动中或依赖不可用），未发起任务。',
        };
      }
      const accountId = await resolveAccountByNickname(nickname);
      return commentScheduler.triggerManual(accountId, {
        injectContact: options?.injectContact,
        joinFirst: options?.joinGroup,
        joinGroupUrl: options?.joinGroupUrl,
        manualOverride: true,
        force: options?.force === true,
        fastReturnToFeed: options?.fastReturnToFeed === true,
      });
    },
    dispatch:
      ctx.automationDispatchCommands?.dispatch
      ?? (() =>
        Promise.reject(
          new Error('automation_operator_command_unavailable:dispatch'),
        )),
    dispatchActive:
      ctx.automationDispatchCommands?.dispatchActive
      ?? (() => {
        throw new Error('automation_operator_command_unavailable:dispatch');
      }),
    managementChatIds,
  });
  ctx.commandFace = commandFace;
  const facebookGroupOpsForPanel: FacebookGroupOpsPort =
    mode === 'api'
      ? new FacebookGroupOpsHttpClient(automationHttp)
      : {
          listTargets: (options) => facebookGroupTargetStore.listTargets(options),
          listFacets: () => facebookGroupTargetStore.listFacets(),
          setEnabled: (groupUrl, enabled) =>
            facebookGroupTargetStore.setEnabled(groupUrl, enabled),
          accountProgress: () => facebookGroupTargetStore.accountProgress(),
          listAssignments: (limit) => facebookGroupMembershipStore.listAssignments(limit),
          reclaimStaleAssignments: (ttlMs) =>
            facebookGroupMembershipStore.reclaimStaleAssignments(ttlMs),
          scopedTargetCountForAccount: (accountId) =>
            facebookGroupTargetStore.scopedTargetCountForAccount(accountId),
          scopedTargetCountsForAccounts: (accountIds) =>
            facebookGroupTargetStore.scopedTargetCountsForAccounts(accountIds),
          latestScheduledResult: (accountId) =>
            facebookGroupJoinAuditStore.latestScheduledResult(accountId),
          latestScheduledResults: (accountIds) =>
            facebookGroupJoinAuditStore.latestScheduledResults(accountIds),
        };
  const publishDispatchTrigger: PublishDispatchTriggerPort | undefined =
    mode === 'api'
      ? new PublishDispatchTriggerHttpClient(
          automationHttp,
          requirePublishApprovalInternalToken(),
        )
      : ctx.publishDispatchTrigger;
  const triggerPublishDispatchOnApprove = async (
    requestId: string,
    revision: number,
    kind: PublishDispatchTriggerKind,
  ): Promise<void> => {
    if (!publishDispatchTrigger || !deploymentTarget) {
      throw new Error('publish_dispatch_trigger_unavailable');
    }
    await publishDispatchTrigger.triggerApproved({
      requestId,
      revision,
      executionTarget: deploymentTarget,
      kind,
    });
  };
  const feishuIngress = await feishuOwner.startIngress({
    commandFace,
    writeApproval: (requestId, approved, payload, context) =>
      writeApprovalDecision(
        requestId,
        approved,
        payload,
        context,
      ),
    onApproved: (trigger) => {
      void triggerPublishDispatchOnApprove(
        trigger.requestId,
        trigger.revision,
        trigger.kind,
      ).catch((error) => {
        console.warn(
          `[aidcp-cloud] Feishu human_reconfirm trigger failed requestId=${trigger.requestId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    onRejected: (requestId) => {
      const match = /^publish-(\d+)$/.exec(requestId);
      if (!match) return;
      const recordId = Number(match[1]);
      const authority = ctx.apiDirectAuthorities?.publishLog;
      if (!authority) {
        console.warn(
          `[aidcp-cloud] Feishu rejection owner unavailable requestId=${requestId}`,
        );
        return;
      }
      void authority.rejectPendingApproval(recordId).catch((error) => {
        console.warn(
          `[aidcp-cloud] Feishu rejection materialization failed requestId=${requestId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    readLiveContentVersion: async (recordId) => {
      const draft = await publishLogStore.loadForDispatch(recordId);
      return draft?.contentVersion ?? null;
    },
    preflightApprovePublish: async (requestId) => {
      const match = /^publish-(\d+)$/.exec(requestId);
      if (!match) return { ok: true };
      const draft = await publishLogStore.loadForDispatch(Number(match[1]));
      return draft
        ? { ok: true, accountId: draft.accountId }
        : {
            ok: false,
            reason: 'publish_target_unavailable',
          };
    },
    ...(delegatedTaskService ? { delegatedTasks: delegatedTaskService } : {}),
  });
  ctx.botChatsProvider = feishuIngress.botChatsProvider;
  if (mode === 'api') {
    const approvalClient = ctx.publishApprovalClient;
    const publishAuthority = ctx.apiDirectAuthorities?.publishLog;
    if (!approvalClient || !publishAuthority) {
      throw new Error('api_publish_owner_authority_unavailable');
    }
    const apiReadLiveContentVersion = async (recordId: number): Promise<number | null> => {
      const draft = await publishLogStore.loadForDispatch(recordId);
      return draft?.contentVersion ?? null;
    };
    const apiRefreshPublishPreview = (recordId: number): void => {
      const pushPreview = ctx.pushApiOwnedPublishPreview;
      if (!pushPreview) {
        console.warn(
          `[publish-ui-update] API draft action preview producer unavailable recordId=${recordId}`,
        );
        return;
      }
      void pushPreview(recordId).catch((err) =>
        console.warn(
          `[publish-ui-update] API draft action preview delivery failed recordId=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    };
    ctx.handlePublishDraftImageRemove = createPublishDraftImageRemoveHandler({
      loadDraft: (recordId) => publishLogStore.loadForDispatch(recordId),
      readApproval: (requestId) => approvalClient.readApproval(requestId),
      editDraft: (recordId, expectedVersion, patch, editor) =>
        publishLogStore.editDraft(recordId, expectedVersion, patch, editor),
      readLiveVersion: apiReadLiveContentVersion,
      refreshPreview: apiRefreshPublishPreview,
    });
    ctx.approvePublishForClient = createClientPublishApprovalHandler({
      loadDraft: (recordId) => publishLogStore.loadForDispatch(recordId),
      readApproval: (requestId) => approvalClient.readApproval(requestId),
      editDraft: (recordId, expectedVersion, patch, editor) =>
        publishLogStore.editDraft(recordId, expectedVersion, patch, editor),
      preflight: async (requestId) => {
        const match = /^publish-(\d+)$/.exec(requestId);
        if (!match) return { ok: true };
        const draft = await publishLogStore.loadForDispatch(Number(match[1]));
        return draft
          ? { ok: true }
          : { ok: false, reason: 'publish_target_unavailable' };
      },
      writeApproval: (requestId, approved, payload, decidedBy) =>
        ctx.writeApprovalDecision(requestId, approved, payload, {
          decidedBy: `client:${decidedBy}`,
          decidedVia: 'client',
        }),
      triggerApproved: (trigger) => {
        void triggerPublishDispatchOnApprove(
          trigger.requestId,
          trigger.revision,
          trigger.kind,
        ).catch((err) =>
          console.warn(
            `[aidcp-cloud] API owner human_reconfirm trigger failed requestId=${trigger.requestId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
      notifyRejected: (requestId) => {
        const match = /^publish-(\d+)$/.exec(requestId);
        if (!match) return;
        void publishAuthority.rejectPendingApproval(Number(match[1])).catch((err) =>
          console.warn(
            `[aidcp-cloud] API owner publish rejection materialization failed requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
      readDispatchState: async (requestId) => {
        const row = await approvalClient.readApproval(requestId);
        if (!row || !row.approved) return null;
        if (row.dispatchState === 'dispatching') {
          return { dispatchState: 'dispatching' as const };
        }
        if (row.dispatchState !== 'pending_dispatch') return null;
        return row.dispatchBlockedReason
          ? {
              dispatchState: 'blocked' as const,
              dispatchBlockedReason: row.dispatchBlockedReason,
            }
          : { dispatchState: 'pending_dispatch' as const };
      },
    });
  }
  if (mode === 'api' && publishApprovalStore && deploymentTarget && publishDispatchTrigger) {
    const relay = new PublishApprovalOutboxRelay({
      executionTarget: deploymentTarget,
      store: publishApprovalStore,
      trigger: publishDispatchTrigger,
      logger: console,
    });
    const pump = () =>
      relay.runOnce(20).catch((err) => {
        console.warn(
          '[aidcp-cloud] PublishApproved outbox relay 失败（命令保持 pending）:',
          err instanceof Error ? err.message : String(err),
        );
      });
    ctx.installPublishApprovalOutboxWake(() => void pump());
    const relayIntervalMs = readEnvNumber('AIDCP_PUBLISH_DISPATCH_SCAN_MS', 60_000);
    if (relayIntervalMs > 0) {
      const relayTimer = setInterval(() => void pump(), relayIntervalMs);
      relayTimer.unref?.();
    }
    void pump();
  }
  const groupRoutes =
    mode === 'api' ? new GroupRouteHttpClient(automationHttp) : groupRouteStore;
  const alertResolution =
    mode === 'api' ? new AlertResolutionHttpClient(automationHttp) : alertStore;
  // 安全限额面板外观（change safety-quota-config）：三档×动作×三窗口生效值 + 写校验（非法整块拒）+ 非乐观回真态。
  const quotaConfigPanel = mode === 'api'
    ? new PanelQuotaConfigHttpClient(automationHttp)
    : createQuotaConfigPanel({ store: quotaConfigStore });
  // 操作兜底 floor 面板外观（change pacing-floor-config-min-interval）：四类操作生效兜底区间 + 写校验（展宽/CAP，非法整块拒）+ 非乐观回真态。
  const pacingConfigPanel = mode === 'api'
    ? new PanelPacingConfigHttpClient(automationHttp)
    : createPacingConfigPanel({ store: pacingConfigStore });
  // 单场上限面板外观（全局单例，change restore-auto-resume-and-global-safety-config）：全局时长 + 七项预算回显 + 写校验（非法整块拒）+ 非乐观回真态。
  const sessionLimitPanel = mode === 'api'
    ? new PanelSessionLimitsHttpClient(automationHttp)
    : createSessionLimitPanel({ store: sessionConfigStore });
  // 引流线索热度过滤阈值面板外观（全局单例，change feed-hot-lead-group-comment）：三阈值回显 + 写校验（非法整块拒）+ 热加载。
  const hotLeadConfigPanel = createHotLeadConfigPanel({ store: hotLeadConfigStore });
  // 续场配置面板外观（全局单例，change restore-auto-resume-and-global-safety-config）：全局续场护栏 + 看门狗阈值回显 + 写校验 + 非乐观回真态。
  const resumeConfigPanel = mode === 'api'
    ? new PanelResumeConfigHttpClient(automationHttp)
    : createResumeConfigPanel({ store: resumeConfigStore });
  // ── Block④ 三仓提取 · 批次 0d：以下句柄只被本段消费，已从 segA 下沉到此 ──────────────
  // 判据三条全中才搬：① segA 赋值 ② 只有本段读 ③ **segA 自己不再引用它**。
  // segA 仍引用的一律留在 segA（含声明前就被惰性回调捕获的**前向引用**，那类最阴）。
  const debugPort = Number(process.env.AIDCP_DEBUG_PORT ?? 8788);
  // 退出前 flush 末窗（有界 3s，防 PG 不可达时 close 挂住退出）。
  const billingPriceRefresh = createBillingPriceRefresh({
    tokenUsage: tokenUsageStore,
    credentials: credentialStore,
    env: process.env,
  });
  const readApprovalDispatchProjection = async (
    rows: Array<{ id: number }>,
  ): Promise<Map<number, ApprovalDispatchProjection>> => {
    const out = new Map<number, ApprovalDispatchProjection>();
    if (!publishApprovalStore) return out;
    const ids = [...new Set(rows.map((row) => row.id))];
    if (ids.length === 0) return out;
    try {
      const active = await publishApprovalStore.readActiveMany(ids.map((id) => `publish-${id}`));
      for (const [requestId, row] of active) {
        const match = /^publish-(\d+)$/.exec(requestId);
        if (!match) continue;
        out.set(Number(match[1]), {
          approved: row.approved,
          dispatchState: row.dispatchState,
          dispatchBlockedReason: row.dispatchBlockedReason,
          decidedAt: row.decidedAt,
        });
      }
    } catch (err) {
      console.warn('[aidcp-cloud] 授权下发进度读取失败（投影回落既有呈现）:', (err as Error).message);
    }
    return out;
  };
  // 面板用户名单在 segB/segC 才解析（parsePanelUsers）；api 模式跳过那两段 ⇒ ctx.panelUsers 恒 undefined。
  // 就地按同一 env 重解析（守卫：缺则面板启动读 config.users.length 会 NPE）；monolith/core 下 ctx.panelUsers 已有 ⇒ 短路、逐字节等价。
  const panelUsers = ctx.panelUsers ?? parsePanelUsers(readEnvString('AIDCP_PANEL_USERS'));
  // 风控只读投影端口（seam①·风控读）。
  //   - monolith / core：本地适配（就是本进程 riskRegistry，逐字节等价、零 HTTP）。
  //   - api：HTTP 客户端（指向 automation 的内部 API）。segC 未跑 ⇒ 本进程无 riskRegistry。
  //     base URL 走 AIDCP_AUTOMATION_URL；缺省回落 127.0.0.1:<默认端口>（仅解析 URL、不发网络，构造不抛）。
  // 批次 0e：本地分支依赖 riskRegistry（自动化段构造）。monolith / core 跑了那一段 ⇒ 必有，逐字节等价；
  // 若某个未来模式既不是 api、又没跑自动化段，这里给 reject 具名错误的端口 —— 绝不让 undefined 落穿。
  const riskRead: RiskReadPort =
    mode === 'api'
      ? new RiskReadHttpClient(automationHttp)
      : riskRegistry
        ? {
            getState: (accountId) => riskRegistry.getController(accountId).then((c) => c.getState()),
            effectiveQuotas: (accountId) => riskRegistry.getController(accountId).then((c) => c.effectiveQuotas()),
            slowStartView: (accountId) => riskRegistry.getController(accountId).then((c) => c.slowStartView()),
          }
        : {
            getState: unavailableInMode('risk_read'),
            effectiveQuotas: unavailableInMode('risk_read'),
            slowStartView: unavailableInMode('risk_read'),
          };
  // 风控**写命令**端口（P5-1，用户 2026-07-25 拍板走异步）。与只读端口同形的三分支：
  //   - api：HTTP 客户端 → automation 的内部 API（那边注册了 registerRiskCommandRoutes）。
  //   - monolith / core：本进程直接落 outbox + 读结果账本（PgRiskCommandService）。
  //   - 既非 api 又没跑自动化段：reject 具名错误。**绝不给一个「假装受理」的空实现**——
  //     那会让操作员提交完看到 202、命令却从未存在（红线：静默假成功）。
  const riskCommands: RiskCommandPort =
    mode === 'api'
      ? new RiskCommandHttpClient(automationHttp, {
          executionTarget: deploymentTarget ?? undefined,
        })
      : (ctx.riskCommandService ?? {
          submitSignal: unavailableInMode('risk_command'),
          submitQuotaLevel: unavailableInMode('risk_command'),
          outcomeOf: unavailableInMode('risk_command'),
          submitRestrictedRecovery: unavailableInMode('risk_command'),
          restrictedRecoveryOutcomeOf: unavailableInMode('risk_command'),
        });
  // 面板对 automation 域的只读投影端口（Block③ L3：面板不直连 automation 的库）。
  //   - monolith / core：跑在本进程 automation 池上的本地实现（PgPanelAutomationRead），逐字节等价、零 HTTP。
  //   - api：segC 未跑 ⇒ 本进程无 automation 属主表，经同一个 automation internal HTTP client 取投影。
  //     owner/transport 失败原样抛，绝不回零或空数组冒充「今天没干活」。
  const panelAutomationRead: PanelAutomationReader =
    mode === 'api'
      ? new PanelAutomationHttpClient(automationHttp)
      : new PgPanelAutomationRead({ pool: automationPool });
  // ── Block② 数据网关（决定①：api/panel 收口取数）─────────────────────────────
  // 聚合三个 kernel 读端口（精选库 / 委托任务 / 收件箱），api 消费者从这里取端口注入。
  // 默认 mode='local'（AIDCP_GATEWAY_MODE!=='http'）⇒ getter 返回的就是上面 ctx 里的本地实例本身、
  // 零 HTTP、不起任何内部 server（内部 HTTP server 的 listen 属 2d 拆进程，本刀不启动它）、运行时零行为变更。
  // remote thunk 仅在 http 模式构造 client（拆进程后 2d）；此处 baseUrl 走 env，缺省不提供 ⇒ 保持 local。
  // api 模式：content 域读端口（精选库 / 发布状态）一律走 HTTP 指向 content 服务；monolith/core 保持 env 决定（默认 local，逐字节等价）。
  const gatewayMode = mode === 'api' ? 'http' : gatewayModeFromEnv();
  const gatewayBaseUrl = readEnvString('AIDCP_GATEWAY_BASE_URL');
  const dataGateway = new DataGateway({
    curatedContentLocal: curatedContentStore,
    delegatedTaskLocal: delegatedTaskService,
    interactionReaderLocal: ctx.interactionStore,
    // Block② 2e：发布队列状态读端口。默认 local ⇒ 直接把同步 getStatus 适配成异步端口，
    // 底层仍是同一个 publishOrchestrator.getStatus()，逐字节等价、零 HTTP。
    // publishOrchestrator 属 segB（content 段）；api 模式本进程无它 ⇒ 本地适配回落诚实报错端口（绝不假成功），
    // 真正取数经上面的 http remote 指向 content 服务。monolith/core 下 publishOrchestrator 存在 ⇒ 就是原适配、逐字节等价。
    publishStatusLocal: publishOrchestrator
      ? { getStatus: () => Promise.resolve(publishOrchestrator.getStatus()) }
      : { getStatus: () => Promise.reject(new Error('publish_status_unavailable_in_api_mode')) },
    mode: gatewayMode,
    // Block② 2d step2 拓扑：core 的 http 网关只把「content 域」读端口（精选库）remote 到 content 进程；
    // delegatedTask / interaction 属 automation 域、由 core 本地拥有（segA 已构造），一律保持 local，
    // 绝不指向 content（content 的内部读 API 只服务 curated 路由，误投 delegated-task 会 404）。
    // 未来若把委托任务 / 收件箱各自拆成独立服务，再按各自 base URL 追加对应 remote thunk。
    ...(gatewayMode === 'http' && gatewayBaseUrl
      ? {
          remote: {
            curatedContentReader: () => new CuratedContentHttpClient(new InternalHttpClient(gatewayBaseUrl)),
            publishStatusReader: () => new PublishStatusHttpClient(new InternalHttpClient(gatewayBaseUrl)),
          },
        }
      : {}),
  });

  // ── 面板 API 层（管理后台后端，进程内、独立端口、JWT）──────────────────────
  // 未设置 AIDCP_PANEL_PORT 则禁用（默认不开新端口）；启动失败非致命，绝不连累边-云闭环。
  const panelPort = readEnvPort('AIDCP_PANEL_PORT');
  // 对外客户鉴权端口（change edge-client-customer-auth）；未设则禁用（镜像面板端口门控）。提前读取以纳入面板自检。
  const clientAuthPort = readEnvPort('AIDCP_CLIENT_AUTH_PORT');
  if (panelPort) {
    try {
      const panel = await startPanelApi(
        {
          interactionInternalApi,
          // 批次 0e：三个跨段依赖（互动权限总览 / 风控注册表 / 边缘 WS 服务端）都由自动化段构造，
          // 面板 deps 侧声明为非可选（src/panel/types.ts）。api 模式没跑那一段 ⇒ 这里响亮抛错、
          // 由下面的 catch 记成「面板启动失败 + 缺哪个依赖」，而不是启动成功后逐条路由炸 TypeError。
          // 把它们改成 deps 侧可选 + 逐路由 503 属批次 3（api main()）的范围，需同改 panel/types.ts。
          interactionPermissions: {
            getView: () => requireSegment(interactionPermissionOverview, 'interactionPermissionOverview', 'automation'),
          },
          revocation: new TokenRevocationStore(),
          // change cloud-coupling-phase5 P5-1：面板的风控写改成异步命令端口（提交 + 回读），
          // 不再注入 RiskController registry。写只发生在 automation 的单写者回调里。
          riskCommands,
          riskRead,
          // change risk-target-follows-active-session：归属跟随当次连接，面板不再有「改归属」端点，
          // 也不按归属禁用风控写（写改回账号级）。currentDriverTarget 只读展示直接来自 panel-store。
          publishLogStore,
          botChatStore: feishuOwner.botChatStore,
          eventBus: panelEventFanout ?? eventBus,
          edgeServer: requireSegment(server, 'server', 'automation'),
          ...(ctx.apiSyncReadMirrors
            ? {
                edgePresenceEvidence: () => {
                  const evidence = ctx.apiSyncReadMirrors!.presence();
                  return {
                    state: evidence.state,
                    asOf: evidence.asOf,
                    onlineEdgeCount: evidence.onlineEdgeCount,
                  };
                },
                publishInFlightEvidence: () =>
                  ctx.apiSyncReadMirrors!.inFlightEvidence(),
              }
            : {}),
          // Block③ L3：面板自己的读走 api 属主池（accounts/persona_config/publish_log）；
          // automation 属主表（风控/告警/互动）经注入的只读端口取，面板不直连别域的库。
          panelStore: new PgPanelStore({ pool: apiPool, automation: panelAutomationRead }),
          // Block② 2e：面板只经 getStatus 读发布队列状态 ⇒ 注入数据网关的读端口（默认 local ⇒
          // publishStatusReader === 上面 publishStatusLocal 适配，底层同一个 publishOrchestrator.getStatus()）。
          publishStatus: dataGateway.publishStatusReader!,
          publishDispatcher,
          // Block② 数据网关收口：默认 local ⇒ dataGateway.delegatedTaskService === delegatedTaskService，零行为变更。
          delegatedTasks: dataGateway.delegatedTaskService,
          preflightApprovePublish: (requestId) => requireSegment(preflightApprovePublish, 'preflightApprovePublish', 'automation')(requestId),
          writeApprovalSignal: async (requestId, approved, payload, decidedBy) => {
            const result = await writeApprovalDecision(requestId, approved, payload, {
              decidedBy,
              decidedVia: 'console',
            });
            // 首写批准由同事务 durable outbox 发 decision_recorded；只有操作员对同一活跃授权明确重批，
            // 才发送 human_reconfirm 取得清熔断权力。
            if (approved && !result.written && result.alreadyDecided === true) {
              await triggerPublishDispatchOnApprove(requestId, result.revision, 'human_reconfirm');
            }
            else if (!approved && result.written) {
              if (mode === 'api') {
                const match = /^publish-(\d+)$/.exec(requestId);
                if (match) {
                  await requireSegment(
                    ctx.apiDirectAuthorities?.publishLog,
                    'apiDirectAuthorities.publishLog',
                    'api',
                  ).rejectPendingApproval(Number(match[1]));
                }
              } else {
                requireSegment(
                  notifyPublishRejected,
                  'notifyPublishRejected',
                  'automation',
                )(requestId);
              }
            }
            return result;
          },
          // 授权下发进度投影（change publish-approval-signal-to-database，task 4.6）：
          // 「已批准·待下发」来自持久记录，进程重启后仍成立。
          ...(publishApprovalStore
            ? {
                readApprovalDispatchStates: async (requestIds: string[]) => {
                  const rows = await publishApprovalStore!.readActiveMany(requestIds);
                  const out = new Map<
                    string,
                    { dispatchState: string; dispatchBlockedReason: string | null; decidedAt: number; approved: boolean }
                  >();
                  for (const [requestId, row] of rows) {
                    out.set(requestId, {
                      dispatchState: row.dispatchState,
                      dispatchBlockedReason: row.dispatchBlockedReason,
                      decidedAt: row.decidedAt,
                      approved: row.approved,
                    });
                  }
                  return out;
                },
              }
            : {}),
          // 待审正文草稿就地编辑 + 活版本读回 + 授权在途探测（edit-note-draft-before-publish）。经拥有者对象单写，绝不 raw UPDATE。
          publishDraft: {
            edit: (recordId, expectedVersion, patch, editor) =>
              publishLogStore.editDraft(recordId, expectedVersion, patch, editor),
            liveVersion: (recordId) =>
              mode === 'api'
                ? publishLogStore
                    .loadForDispatch(recordId)
                    .then((draft) => draft?.contentVersion ?? null)
                : requireSegment(
                    readLiveContentVersion,
                    'readLiveContentVersion',
                    'automation',
                  )(recordId),
            hasDecision: async (recordId) =>
              mode === 'api'
                ? (await requireSegment(
                    ctx.publishApprovalClient,
                    'publishApprovalClient',
                    'api',
                  ).readApproval(`publish-${recordId}`)) !== null
                : (await requireSegment(
                    readPublishApproval,
                    'readPublishApproval',
                    'automation',
                  )(`publish-${recordId}`)) !== null,
          },
          notifyPublishPreviewChanged: (recordId) => {
            if (mode === 'api') {
              const pushPreview = ctx.pushApiOwnedPublishPreview;
              if (!pushPreview) {
                console.warn(
                  `[publish-ui-update] panel preview producer unavailable recordId=${recordId}`,
                );
                return;
              }
              void pushPreview(recordId).catch((err) =>
                console.warn(
                  `[publish-ui-update] panel preview delivery failed recordId=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
              return;
            }
            requireSegment(
              refreshPublishPreview,
              'refreshPublishPreview',
              'automation',
            )(recordId);
          },
          // 面板与 Feishu 共用上方 segD 的同一个 API command face。
          // API mode 的 resume 保留 account-state-first + remote Edge partial truth。
          commandActions: commandFace.panelCommandActions,
          // 账号属性写入（change editable-account-group-label + account-group-chat-injection → generalize-contact-info）：经账号存储单写；
          // 存储未就绪 → 不注入，路由回 503。setContactInfo 可选（存储方法存在时才挂，否则该子路由单独 503）。
          accountAttr: accountStore?.setGroupLabel
            ? {
                setGroupLabel: (accountId, label) => accountStore!.setGroupLabel!(accountId, label),
                ...(accountStore.setContactInfo
                  ? {
                      setContactInfo: (accountId: string, info: string | null) =>
                        accountStore!.setContactInfo!(accountId, info),
                    }
                  : {}),
              }
            : undefined,
          // 内容排期（change content-schedule-auto-publish，Phase 1 只发帖）：经 ContentScheduleStore 单写，
          // 非法整块拒、写前校验账号存在防幽灵行、退役拒、写后回读真态；fail-closed（未配=不自动）。
          contentSchedule: {
            getGlobalView: () => {
              const g = contentScheduleStore.getGlobal();
              return {
                contentActiveMask: g?.contentActiveMask ?? null,
                overridden: g !== null,
                updatedAt: g?.updatedAt ?? null,
                updatedBy: g?.updatedBy ?? null,
              };
            },
            listCatalog: () => requireSegment(listAccountAutomationCatalog, 'listAccountAutomationCatalog', 'automation')(),
            setGlobal: (mask, updatedBy) => contentScheduleStore.setGlobal({ contentActiveMask: mask }, updatedBy),
            setAccount: (accountId, patch, updatedBy) => contentScheduleStore.setAccount(accountId, patch, updatedBy),
            setJoinGroupAutomation: async (accountId, patch, updatedBy) => {
              const result = await facebookGroupJoinAutomationStore.setAccount(accountId, patch, updatedBy);
              if (!result.ok) return result;
              // UPSERT 已提交后，任何目录/派生读失败都只能 fail-closed 降级，不能向 Console 假报“保存失败”。
              const row = (await contentScheduleStore.listCatalog().catch((error) => {
                console.warn(`[content-schedule] join config saved; catalog refresh failed account=${accountId}:`, (error as Error).message);
                return [];
              })).find((item) => item.accountId === accountId && item.platform === 'facebook');
              const joinGroupAutomation = await buildFacebookGroupJoinAutomationCatalogViewFailClosed({
                config: result.row,
                effectiveActiveWeekMask: row?.effectiveActiveWeekMask ?? null,
                effectiveContentActiveMask: row?.effectiveContentActiveMask ?? null,
                loadRiskDailyCap: () => riskRead.effectiveQuotas(accountId).then((q) => q.day.join_group),
                loadScope: () => facebookGroupTargetStore.scopedTargetCountForAccount(accountId),
                loadRecentResult: () => facebookGroupJoinAuditStore.latestScheduledResult(accountId),
              });
              return { ok: true, joinGroupAutomation };
            },
          },
          // Facebook 发帖素材池：手工上传图片，发帖从账号素材池保留，不调用图片模型。
          facebookPublishMedia: facebookPublishMediaStore
            ? {
                list: (accountId) => facebookPublishMediaStore!.listForAccount(accountId),
                upload: (accountId, files) => facebookPublishMediaStore!.uploadFiles(accountId, files),
                reorder: (accountId, orderedSetIds) => facebookPublishMediaStore!.reorder(accountId, orderedSetIds),
                updateSet: (accountId, setId, patch) => facebookPublishMediaStore!.updateSet(accountId, setId, patch),
                deleteSet: (accountId, setId) =>
                  facebookPublishMediaStore!.updateSet(accountId, setId, { status: 'deleted' }),
              }
            : undefined,
          // 每账号 Facebook 定时评论配置：关键词 + 评论模式 / 模板；目标群来自 joined ledger。
          facebookCommentConfig: {
            get: (accountId) => facebookCommentConfigStore.getForAccount(accountId),
            set: (accountId, patch, updatedBy) =>
              facebookCommentConfigStore.setAccount(accountId, patch, updatedBy),
          },
          facebookGroupTargets: {
            importTargets: async (inputs, importBatch, options) => {
              if (mode !== 'api') {
                return facebookGroupTargetStore.importTargets(inputs, importBatch, options);
              }
              if (!facebookScopeCommand) {
                throw new Error('facebook_scope_authority_unavailable');
              }
              const receipt = await facebookScopeCommand.importTargets({
                commandId: randomUUID(),
                inputs,
                importBatch,
                ...(options ? { options } : {}),
              });
              if (receipt.outcome === 'collision') {
                throw new Error('facebook_scope_command_collision');
              }
              return receipt.result;
            },
            listTargets: (options) => facebookGroupOpsForPanel.listTargets(options),
            listFacets: () => facebookGroupOpsForPanel.listFacets(),
            setEnabled: (groupUrl, enabled) =>
              facebookGroupOpsForPanel.setEnabled(groupUrl, enabled),
            replaceTargetScopes: async (groupUrls, accountGroupLabels, updatedBy) => {
              if (mode !== 'api') {
                return facebookGroupTargetStore.replaceTargetScopes(
                  groupUrls,
                  accountGroupLabels,
                  updatedBy,
                );
              }
              if (!facebookScopeCommand) {
                throw new Error('facebook_scope_authority_unavailable');
              }
              const receipt = await facebookScopeCommand.replaceTargetScopes({
                commandId: randomUUID(),
                groupUrls,
                accountGroupLabels,
                updatedBy,
              });
              if (receipt.outcome === 'collision') {
                throw new Error('facebook_scope_command_collision');
              }
              return receipt.result;
            },
            accountProgress: () => facebookGroupOpsForPanel.accountProgress(),
            listAssignments: (limit) => facebookGroupOpsForPanel.listAssignments(limit),
            reclaimStaleAssignments: (ttlMs) =>
              facebookGroupOpsForPanel.reclaimStaleAssignments(ttlMs),
          },
          captchaAssist: captchaAssist?.isAvailable() ? captchaAssist : undefined,
          // 模型与凭据配置（change console-model-provider-config + model-config-volcengine-provider）。明文密钥绝不经此回传。
          modelConfig: {
            getView: (...a) => requireSegment(buildModelConfigView, 'buildModelConfigView', 'automation')(...a),
            setModel: async (patch, updatedBy) => {
              const cfg = modelConfigStore.getCached();
              const wantTextModel = typeof patch.textModel === 'string' && patch.textModel.trim() !== '';
              const wantTextProvider = typeof patch.textProvider === 'string' && patch.textProvider.trim() !== '';
              // 解析本次生效的文本厂商（变更则用新值、否则沿用当前）；未知厂商诚实拒，绝不落库。
              let provider: string;
              if (wantTextProvider) {
                const p = (patch.textProvider as string).trim();
                if (!isKnownProvider(p)) return { ok: false, reason: 'unknown_provider' as const };
                provider = p;
              } else {
                provider = normProvider(cfg.textProvider);
              }
              // 文本模型或厂商任一变更 → 按生效厂商对生效模型探活（某厂商上合法的模型名在另一厂商未必合法）。
              if (wantTextModel || wantTextProvider) {
                const modelToProbe = wantTextModel ? (patch.textModel as string).trim() : cfg.textModel;
                try {
                  await requireSegment(probeModel, 'probeModel', 'automation')(provider, modelToProbe);
                } catch (e) {
                  if (e instanceof ProviderKeyMissingError) return { ok: false, reason: 'provider_key_missing' as const };
                  return { ok: false, reason: 'model_invalid' as const };
                }
              }
              const storePatch: {
                textModel?: string;
                textProvider?: string;
                imageModel?: string;
                imageProvider?: string;
              } = {};
              if (wantTextModel) storePatch.textModel = (patch.textModel as string).trim();
              if (wantTextModel || wantTextProvider) storePatch.textProvider = provider;
              if (typeof patch.imageModel === 'string' && patch.imageModel.trim())
                storePatch.imageModel = patch.imageModel.trim();
              // change image-provider-volcengine-seedream：图片厂商未知则归一（不 brick，与图片路由归一一致），非文本探活范畴。
              if (typeof patch.imageProvider === 'string' && patch.imageProvider.trim())
                storePatch.imageProvider = normImageProvider(patch.imageProvider);
              await modelConfigStore.set(storePatch, updatedBy);
              return { ok: true, view: await requireSegment(buildModelConfigView, 'buildModelConfigView', 'automation')() };
            },
            setCredential: async (provider, field, value, updatedBy) => {
              if (!credentialStore.canEdit()) return { ok: false, reason: 'cred_key_missing' as const };
              const { maskedHint } = await credentialStore.setSecret(provider, field, value, updatedBy);
              return { ok: true, provider, field, maskedHint };
            },
          },
          // 角色级模型/温度配置（change console-role-model-config）。白名单 + 探活 + 写非乐观回真态。
          roleConfig: roleConfigPanel,
          // 分类级模型默认配置（change role-model-category-config，item 5/6）。白名单 + 探活 + 写非乐观回真态。
          categoryConfig: categoryConfigPanel,
          // 安全限额配置（change safety-quota-config，stream D）。三档×动作×三窗口可改 + 热加载 + 非乐观回真态。
          quotaConfig: quotaConfigPanel,
          // 配置镜像健康只读投影（task 6.4）：每次请求现取，asOf 是数据时刻而非响应时刻。
          configMirrorHealth: () => requireSegment(configMirrorRefresher, 'configMirrorRefresher', 'automation').health(),
          ...(ctx.apiSyncReadMirrors
            ? {
                configMirrorServicesHealth: () => {
                  const local = requireSegment(
                    configMirrorRefresher,
                    'configMirrorRefresher',
                    'automation',
                  ).health();
                  const automation =
                    ctx.apiSyncReadMirrors!.automationConfigMirrorHealth();
                  return {
                    services: [
                      {
                        sourceService: 'api' as const,
                        asOf: local.asOf,
                        deliveryState: 'fresh' as const,
                        entries: local.entries.filter(
                          (entry) =>
                            CONFIG_MIRRORS[
                              entry.mirrorKey as keyof typeof CONFIG_MIRRORS
                            ]?.owner === 'api',
                        ),
                      },
                      {
                        ...automation,
                        entries: [...automation.entries],
                      },
                    ],
                  };
                },
              }
            : {}),
          // 操作兜底 floor 配置（change pacing-floor-config-min-interval）。四类操作最小间隔兜底区间可改 + 热加载 + 非乐观回真态。
          pacingConfig: pacingConfigPanel,
          // 单场会话上限配置（change session-limits-to-quota-layer）。按账号时长 + 互动预算可改 + 热加载 + 非乐观回真态。
          sessionLimits: sessionLimitPanel,
          hotLeadConfig: hotLeadConfigPanel,
          // 自动续场护栏 + 看门狗阈值配置（change session-auto-resume-with-excursions）。按账号可改 + 热加载 + 非乐观回真态。
          resumeConfig: resumeConfigPanel,
          // 角色 prompt 只读预览（change role-prompt-visibility）。纯读，无写路径。
          rolePromptPreview: rolePromptProvider,
          // 账号人设配置（change account-persona-config，stream F）。按账号编辑 + soul 校验 + 写非乐观回真态。
          persona: personaPanel,
          // token 用量统计（change llm-token-usage-stats）。同一记账 store 实例（共享专用池），纯只读查询。
          tokenUsage: tokenUsageStore,
          billingPriceRefresh,
          // 通知联系人名册（change notification-contact-registry）。同一记录 store 实例：读=按账号联系人列表、写=人工字段（微信/标签/备注）。
          notificationContact: notificationContactStore,
          // 团队 → 群路由配置面（change feishu-per-team-notification-routing）。同一 group_route store 实例：读=全部映射、写=按团队键 upsert/清除。
          // init 失败留 undefined 时面板自然 503，绝不崩闭环。botChatStore 已注入（GET /api/bot-chats 复用其 listActive）。
          notificationRoutes: groupRoutes,
          approvalPolicies: approvalPolicyStore
            ? {
                list: async () => {
                  const [accounts, groups, coverage] = await Promise.all([
                    approvalPolicyStore!.listAccountPolicies(),
                    approvalPolicyStore!.listGroupPolicies(),
                    clientUserStore.listClientApprovalCoverageByGroup(),
                  ]);
                  const coverageByGroup = new Map(coverage.map((row) => [row.groupLabel, row]));
                  return {
                    accounts,
                    groups: groups.map((row) => ({
                      ...row,
                      activeAccountCount: coverageByGroup.get(row.groupLabel)?.activeAccountCount ?? 0,
                      reachableAccountCount: coverageByGroup.get(row.groupLabel)?.reachableAccountCount ?? 0,
                    })),
                  };
                },
                setAccountCommentMode: (accountId, mode, updatedBy) =>
                  approvalPolicyStore!.setAccountCommentMode(accountId, mode, updatedBy),
                setGroupPublishDelivery: (groupLabel, delivery, updatedBy) =>
                  approvalPolicyStore!.setGroupPublishDelivery(groupLabel, delivery, updatedBy),
              }
            : undefined,
          // 机器人所在群 provider（change feishu-bot-chat-name-display）：GET /api/bot-chats 实时取飞书真实群名 + 默认群标记。
          botChats: ctx.botChatsProvider,
          // 精选内容后台管理（change curated-content-admin-page）。同一精选语料 store 实例：读=按账号列表/筛选面、写=删单条/清空壳行。
          // init 失败留 undefined 时面板自然 503，绝不崩边-云闭环。
          // 注：面板 curatedContent 走更宽的 PanelCuratedContent 端口（含 listForPanel/facets/delete/clear），
          // 非本网关聚合的窄读端口 CuratedContentReader，故不经 dataGateway 收口，保留直连（见 docpatch residual）。
          curatedContent: curatedContentStore,
          // 精选笔记行级定向动作（change curated-note-actions）：参照洗稿创作 + 定向评论（内容/带联系方式）。
          // HTTP 只回**触发态**（生成段可达数分钟，不可同步等）；终态沿既有渠道（发布=待审草稿+人审卡+异步结果卡、
          // 评论=人审卡+定向终态结果卡）。域内拒绝回 triggered=false+机器原因码，绝不染绿。
          curatedActions: {
            createPostFromNote: async (accountId, row, options) => {
              if (!ctx.publishScheduler) return { triggered: false, reason: 'publish_unready' };
              if (personaStore.getForAccount(accountId) === null) return { triggered: false, reason: 'needs_persona' };
              if (!(row.body ?? '').trim()) return { triggered: false, reason: 'empty_body' };
              const useReferenceImages = options?.useReferenceImages ?? row.referenceImages.length > 0;
              // 并发准入（change parallel-rewrite-drafts）：预取 DB 待审数 → 同步键控 claim。全部拒绝
              //（duplicate_source / publish_capacity / publish_busy）都在 HTTP 回执同步可见、绝不落到只有飞书卡才知道；
              // 同账号跨参照稿并行放行。claim 成功即管线已发起，结果卡链挂 outcome。
              const dbPendingCount = await publishLogStore.countPendingForAccount(accountId).catch(() => 0);
              const begin = ctx.publishScheduler.tryBeginRewrite(
                accountId,
                {
                  sourceId: row.sourceId,
                  title: row.title ?? '',
                  body: row.body ?? '',
                  topics: row.topics,
                  curatedContentId: row.id,
                  accountId,
                  sourceUrl: row.sourceUrl,
                  capturedAt: Date.now(),
                  ...(row.author ? { author: row.author } : {}),
                  ...(useReferenceImages && row.referenceImages.length > 0 ? { images: row.referenceImages } : {}),
                  ...(useReferenceImages && row.visualAnalysis ? { visualAnalysis: row.visualAnalysis } : {}),
                  ...(useReferenceImages && row.textCardTranscription
                    ? { textCardTranscription: row.textCardTranscription }
                    : {}),
                },
                { dbPendingCount },
              );
              if (!begin.started) return { triggered: false, reason: begin.reason };
              // fire-and-forget：结果卡链挂 outcome（诚实三态，镜像 /publish 回执语义；成功终态=人审卡本身，不重复报绿）。
              // 并行多轮可区分：卡文案带参照稿标题/sourceId。
              const sourceLabel = (row.title ?? '').trim() || row.sourceId;
              void begin.outcome
                .then(async (o) => {
                  // 只在「没走到人审卡」时补卡（未触发黄 / 失败红 / 跳过黄）；进人审（pending_approval 等）由人审卡自证，不双卡。
                  let receipt: { ok: boolean; level: 'success' | 'warning' | 'error'; title: string; message: string } | null = null;
                  const accountName = accountDisplayName(accountId);
                  const accountLabel = accountName ?? '（未获取昵称）';
                  if (o.result !== 'triggered') {
                    receipt = { ok: false, level: 'warning', title: '参照创作未触发', message: `账号 \`${accountLabel}\`「${sourceLabel}」未触发：${o.reason}` };
                  } else if (o.status === 'failed' || o.status === 'timeout') {
                    receipt = { ok: false, level: 'error', title: '参照创作编排失败', message: `账号 \`${accountLabel}\`「${sourceLabel}」编排状态 ${o.status}${o.failureReason ? `\n原因：${o.failureReason}` : ''}` };
                  } else if (o.status === 'skipped') {
                    receipt = { ok: false, level: 'warning', title: '参照创作未产出', message: `账号 \`${accountLabel}\`「${sourceLabel}」编排状态 skipped${o.failureReason ? `（${o.failureReason}）` : ''}` };
                  }
                  if (!receipt) return;
                  await feishuOwner.sendCommandResult(accountId, {
                    command: '参照创作',
                    ok: receipt.ok,
                    level: receipt.level,
                    title: receipt.title,
                    message: receipt.message,
                    accountId,
                    accountName,
                  });
                })
                .catch((err) => console.warn(`[curated-actions] 参照创作编排异常 account=${accountId}：${(err as Error).message}`));
              return { triggered: true }; // 触发已发起；HTTP 立即回触发态

            },
            commentOnNote: async (accountId, row, withContact) => {
              if (!commentScheduler) return { triggered: false, reason: 'comment_unready' };
              const r = await commentScheduler.triggerTargeted(
                accountId,
                { noteId: row.sourceId, title: row.title ?? '' },
                { injectContact: withContact },
              );
              return r.ok ? { triggered: true } : { triggered: false, reason: r.reason ?? 'rejected' };
            },
          },
          // 告警手动解决（change alert-resolution-by-id）：复用同一告警存储单例（上方 L811 构造，init 失败为 undefined）。
          // 面板按 alert_id 勾销单条告警；未注入时路由自然 503。只闭合日志行，绝不碰风控单写 / edge 恢复。
          alertStore: alertResolution,
          // 对外客户管理（change edge-client-customer-auth）：内部 JWT 保护的 /api/client-users*。同一 store 实例
          // 亦供客户鉴权服务做 auth/scope 读（单实例共享池）。绝不回传 key/hash。
          clientUsers: clientUserStore,
          onClientOffboardCreated: async (offboard) => {
            // 同上：尚未物化的离场没有可派发的账号，等对账循环补。
            if (!offboard.accountId) return;
            const edgeId = requireSegment(server, 'server', 'automation').resolveEdgeIdForAccount(offboard.accountId);
            if (edgeId) await interactionOffboarding?.dispatchPending(offboard.accountId, edgeId);
          },
        },
        {
          port: panelPort,
          jwtSecret: readEnvString('AIDCP_PANEL_JWT_SECRET') ?? '',
          users: panelUsers,
          jwtTtlSeconds: readEnvPort('AIDCP_PANEL_JWT_TTL_SECONDS') ?? 3600,
          // 自检拒绝绑定：边-云 8787 / PG 5432 / 调试 8788 / 客户鉴权端口 / 部署时经 env 补充的 isales 等端口。
          forbiddenPorts: [port, debugPort, 5432, ...(clientAuthPort ? [clientAuthPort] : []), ...parseForbiddenPorts(readEnvString('AIDCP_PANEL_FORBIDDEN_PORTS'))],
          logger: console,
        },
      );
      if (panel.started) {
        console.log(`[aidcp-cloud] 面板 API 已启动（127.0.0.1:${panel.port}，经 Nginx 反代 /api）`);
      } else {
        console.warn(
          `[aidcp-cloud] 面板 API 未启动（${panel.reason}${panel.detail ? ':' + panel.detail : ''}）——边-云闭环与飞书不受影响`,
        );
      }
    } catch (err) {
      console.warn('[aidcp-cloud] 面板 API 启动异常（非致命）:', (err as Error).message);
    }
  } else {
    console.log('[aidcp-cloud] 面板 API 已禁用（未设置 AIDCP_PANEL_PORT）');
  }

  // ── 对外客户鉴权 API（change edge-client-customer-auth，独立端口 + 独立密钥）───────────
  // 未设 AIDCP_CLIENT_AUTH_PORT 则禁用（默认不开）；启动失败非致命，绝不连累边-云闭环与面板。
  // N1 头号风险：AIDCP_CLIENT_JWT_SECRET 与面板密钥相同则边界坍塌 → startClientAuthApi 内硬断言拒启。
  if (clientAuthPort) {
    try {
      // 客户发布队列复用面板已有的 publish_log 生命周期读取，但经过独立最小披露投影后才跨客户边界。
      // 该 reader 只在客户 API 启用时创建；不初始化/修改表，也不复用面板鉴权域或路由。
      // 仅调 publishedHistory（api 属主：publish_log + accounts）⇒ 走 api 池；automation 端口只为满足
      // 必填契约注入，本路径从不触达（Block③ L3）。
      const clientPublishQueueStore = new PgPanelStore({ pool: apiPool, automation: panelAutomationRead });
      // 环境级慢启动读写共用的投影产出：与 ui.snapshot
      // 的慢启动投影**同一个 controller**（同一 anchor 解析、同一次 clock）→ 徽章天数与生效上限同源同规则。
      // dayQuotas 亦过客户端信任边界，与 ui.snapshot 上限投影同规则剥去平台不支持项（change platform-honest-usage-caps）。
      const buildSlowStartView = async (accountId: string) => {
        // seam①·风控读：经只读投影端口（api=HTTP，monolith/core=本地 registry 适配·逐字节等价）。
        const [slowStart, quotas] = await Promise.all([
          riskRead.slowStartView(accountId),
          riskRead.effectiveQuotas(accountId),
        ]);
        return {
          slowStart,
          dayQuotas: omitUnsupportedUsageMetrics(
            accountStore?.platformFor?.(accountId),
            pickDailyUsageCounts(quotas.day),
          ) as Record<string, number>,
        };
      };
      const clientAuth = await startClientAuthApi(
        {
          store: clientUserStore,
          revocation: new TokenRevocationStore(), // 独立撤销黑名单，绝不共用面板的
          rateLimiter: new LoginRateLimiter(),
          ...(accountStore?.setOperatorAlias ? {
            operatorAlias: {
              setForAccount: (accountId: string, alias: string | null) =>
                accountStore!.setOperatorAlias!(accountId, alias),
            },
          } : {}),
          // Block② 数据网关收口：默认 local ⇒ 取到的就是原本地实例（=== delegatedTaskService / curatedContentStore），零行为变更。
          delegatedTasks: dataGateway.delegatedTaskService,
          curatedContent: dataGateway.curatedContentReader,
          referenceDraftCountForAccount: (accountId) => publishLogStore.countReferenceDraftsForAccount(accountId),
          pendingDrafts: publishLogStore,
          publishSchedule: publishLogStore,
          environmentOverview: {
            viewForAccount: async (accountId) => {
              try {
                const [dailyUsage, current, last] = await Promise.all([
                  requireSegment(buildTodayUsageForAccount, 'buildTodayUsageForAccount', 'automation')(accountId),
                  publishLogStore.currentPublishForAccount(accountId),
                  publishLogStore.lastPublishedForAccount(accountId),
                ]);
                let currentPublishState: {
                  state: 'pending' | 'approved' | 'submitted';
                  code: string;
                  title?: string;
                  at: number;
                } | null = null;
                if (current) {
                  let state: 'pending' | 'approved' | 'submitted' | null;
                  if (current.status === 'submitted') state = 'submitted';
                  else if (current.status === 'scheduled') state = 'approved';
                  else {
                    const decision = await requireSegment(readPublishApproval, 'readPublishApproval', 'automation')(`publish-${current.id}`).catch(() => null);
                    state = decision == null ? 'pending' : decision.approved ? 'approved' : null;
                  }
                  if (state) {
                    currentPublishState = {
                      state,
                      code: `#${current.id}`,
                      ...(current.title ? { title: current.title } : {}),
                      at: current.at,
                    };
                  }
                }
                return {
                  dailyUsage,
                  currentPublishState,
                  lastPublished: last?.title ? { title: last.title, at: last.at } : null,
                };
              } catch (err) {
                console.warn(
                  `[aidcp-cloud] client environment overview failed account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return null;
              }
            },
          },
          environmentSchedule: {
            platformForAccount: (accountId) => accountStore?.platformFor?.(accountId),
            viewForAccount: (accountId) =>
              projectClientEnvironmentSchedule(contentScheduleStore.effectiveScheduleFor(accountId)),
          },
          publishQueue: {
            platformForAccount: (accountId) => accountStore?.platformFor?.(accountId),
            viewForAccount: async (accountId) => {
              if (!delegatedTaskService) return null;
              try {
                const queue = await (dataGateway.publishStatusReader
                  ? dataGateway.publishStatusReader.getStatus()
                  : requireSegment(publishOrchestrator, 'publishOrchestrator', 'content').getStatus());
                // 先按账号过滤 runs，并刻意丢弃全局 aggregate snapshot：终态 snapshot 没有稳定账号键，
                // 不能让另一账号的最近一轮穿过客户边界；该账号 recent 只以 publish_log 为权威来源。
                const accountRuns = (queue.runs ?? []).filter((run) => run.accountId === accountId);
                const [pending, recent, tasks] = await Promise.all([
                  clientPublishQueueStore.publishedHistory(50, accountId, 'pending_approval'),
                  clientPublishQueueStore.publishedHistory(10, accountId),
                  delegatedTaskService.list({
                    accountId,
                    actionFamily: 'publish',
                    statuses: ['queued', 'planning', 'deferred'],
                    limit: 50,
                  }),
                ]);
                const lifecycle = buildPublishLifecycle({
                  queue: {
                    status: accountRuns.length > 0 ? 'running' : 'idle',
                    snapshot: null,
                    runs: accountRuns,
                  },
                  pending,
                  recent,
                  ...(ctx.apiSyncReadMirrors
                    ? {
                        inFlightEvidence:
                          ctx.apiSyncReadMirrors.inFlightEvidence(),
                      }
                    : {
                        inFlightRecordIds: requireSegment(
                          publishDispatcher,
                          'publishDispatcher',
                          'automation',
                        ).getInFlightRecordIds(),
                      }),
                  recentLimit: 5,
                  ...(publishApprovalStore
                    ? { approvalDispatch: await readApprovalDispatchProjection([...pending, ...recent]) }
                    : {}),
                });
                return projectClientPublishQueue({ accountId, lifecycle, tasks });
              } catch (err) {
                console.warn(
                  `[aidcp-cloud] client publish queue failed account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return null;
              }
            },
          },
          publishDraftActions: {
            edit: async (recordId, expectedVersion, patch, accountId, actor) => {
              const result = await publishLogStore.editDraft(recordId, expectedVersion, patch, actor, accountId);
              if (result.ok) {
                if (mode === 'api') {
                  const pushPreview = ctx.pushApiOwnedPublishPreview;
                  if (!pushPreview) {
                    console.warn(
                      `[publish-ui-update] panel edit preview producer unavailable recordId=${recordId}`,
                    );
                  } else {
                    await pushPreview(recordId).catch((err) =>
                      console.warn(
                        `[publish-ui-update] panel edit preview delivery failed recordId=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
                      ),
                    );
                  }
                } else {
                  requireSegment(refreshPublishPreview, 'refreshPublishPreview', 'automation')(recordId);
                }
              }
              return result;
            },
            approve: (payload, accountId, actor) =>
              mode === 'api'
                ? requireSegment(
                    ctx.approvePublishForClient,
                    'approvePublishForClient',
                    'api',
                  )(payload, accountId, actor)
                : requireSegment(
                    approvePublishForClient,
                    'approvePublishForClient',
                    'automation',
                  )(payload, accountId, actor),
            removeImage: (payload, accountId, actor) =>
              mode === 'api'
                ? requireSegment(
                    ctx.handlePublishDraftImageRemove,
                    'handlePublishDraftImageRemove',
                    'api',
                  )(payload, { accountId, actor })
                : requireSegment(
                    handlePublishDraftImageRemove,
                    'handlePublishDraftImageRemove',
                    'automation',
                  )(payload, { accountId, actor }),
          },
          draftRefinements: draftRefinementStore,
          // D5 活体佐证（change curated-envkey-account-binding）：不可逆写要求绑定账号此刻活在该环境上。
          // 幸存者 resolveEdgeIdForAccount（account→edge）；反方向的 resolveAccountIdForEdge 已被慢启动 change 删除。
          resolveEdgeIdForAccount: (accountId) => requireSegment(server, 'server', 'automation').resolveEdgeIdForAccount(accountId),
          interactionApi: interactionCustomerApi,
          // 环境配置由 ClientUserStore 直接单写；仅当存在唯一当前账号时，回调读取同一个 controller 的生效投影。
          slowStart: {
            viewForAccount: async (accountId) => {
              try {
                return await buildSlowStartView(accountId);
              } catch {
                return null;
              }
            },
          },
          environmentRisk: {
            platformForAccount: (accountId) => accountStore?.platformFor?.(accountId),
            viewForAccount: async (accountId) => {
              try {
                // seam①·风控读：只读投影端口（api=HTTP，monolith/core=本地 registry 适配·逐字节等价）。
                const state = await riskRead.getState(accountId);
                return { status: state.status, statusSince: state.statusSince, updatedAt: state.updatedAt };
              } catch {
                return null;
              }
            },
            submitRestrictedRecovery: async (envKey, accountId, reason, requestedBy) => {
              try {
                return await riskCommands.submitRestrictedRecovery({ envKey, accountId, reason, requestedBy });
              } catch {
                return null;
              }
            },
            restrictedRecoveryOutcomeOf: async (commandId, envKey, accountId) => {
              try {
                const outcome = await riskCommands.restrictedRecoveryOutcomeOf(commandId, envKey, accountId);
                if (outcome.state !== 'applied' && outcome.state !== 'refused') return outcome;
                const risk = outcome.risk;
                if (
                  risk.status !== 'normal'
                  && risk.status !== 'warned'
                  && risk.status !== 'restricted'
                  && risk.status !== 'frozen'
                ) {
                  console.warn('[aidcp-cloud] restricted recovery returned invalid risk status', {
                    commandId,
                    envKey,
                    rawStatus: String(risk.status),
                  });
                  return { commandId, state: 'failed' as const, reason: 'recovery_outcome_incomplete' };
                }
                return {
                  ...outcome,
                  risk: {
                    status: risk.status,
                    statusSince: risk.statusSince,
                    updatedAt: risk.updatedAt,
                  },
                };
              } catch {
                return null;
              }
            },
          },
          persona: {
            get: (accountId) => requireSegment(accountPersonaService, 'accountPersonaService', 'automation').get(accountId),
            generate: (input) => requireSegment(accountPersonaService, 'accountPersonaService', 'automation').generate(input),
            persist: (accountId, soulYaml, updatedBy) => requireSegment(accountPersonaService, 'accountPersonaService', 'automation').persist(accountId, soulYaml, updatedBy),
            platformForAccount: (accountId) => accountStore?.platformFor?.(accountId),
          },
          onOffboardCreated: async (offboard) => {
            // accountId 为 null = 已受理、尚未物化（属主还没解析出账号）：此刻没有可派发的目标，
            // MUST NOT 猜一个。对账循环物化成功后会带着真 accountId 再走一次派发。
            if (!offboard.accountId) return;
            const edgeId = requireSegment(server, 'server', 'automation').resolveEdgeIdForAccount(offboard.accountId);
            if (edgeId) await interactionOffboarding?.dispatchPending(offboard.accountId, edgeId);
          },
          personaAutoFill,
        },
        {
          port: clientAuthPort,
          jwtSecret: readEnvString('AIDCP_CLIENT_JWT_SECRET') ?? '',
          panelJwtSecret: readEnvString('AIDCP_PANEL_JWT_SECRET') ?? '',
          jwtTtlSeconds: readEnvPort('AIDCP_CLIENT_JWT_TTL_SECONDS') ?? 900,
          // 自检拒绝绑定：边-云 8787 / PG 5432 / 调试 8788 / 面板端口 / env 补充（isales 等）。
          forbiddenPorts: [port, debugPort, 5432, ...(panelPort ? [panelPort] : []), ...parseForbiddenPorts(readEnvString('AIDCP_CLIENT_FORBIDDEN_PORTS'))],
          logger: console,
        },
      );
      if (clientAuth.started) {
        console.log(`[aidcp-cloud] 客户鉴权 API 已启动（127.0.0.1:${clientAuth.port}，经 Nginx 反代）`);
      } else {
        console.warn(
          `[aidcp-cloud] 客户鉴权 API 未启动（${clientAuth.reason}${clientAuth.detail ? ':' + clientAuth.detail : ''}）——边-云闭环与面板不受影响`,
        );
      }
    } catch (err) {
      console.warn('[aidcp-cloud] 客户鉴权 API 启动异常（非致命）:', (err as Error).message);
    }
  } else {
    console.log('[aidcp-cloud] 客户鉴权 API 已禁用（未设置 AIDCP_CLIENT_AUTH_PORT）');
  }

}


main().catch((err) => {
  console.error('[aidcp-cloud] 启动失败:', err);
  process.exitCode = 1;
});
