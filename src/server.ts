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
import * as lark from '@larksuiteoapi/node-sdk';
import {
  QwenClient,
  type ChatLlmClient,
  TEXT_PROVIDERS,
  type TextProviderId,
  normProvider,
  isKnownProvider,
  ProviderKeyMissingError,
  resolveProviderBaseUrl,
  resolveProviderEnvKey,
} from './llm/index.js';
import { PLATFORM_CREDENTIALS, resolvePlatformCredentialEnvValue } from './config/platform-credentials.js';
import { TokenUsageStore } from './metrics/token-usage-store.js';
import { createBillingPriceRefresh } from './metrics/billing-price-refresh.js';
import { startRetentionSweeper } from './panel/retention-sweeper.js';
import { shanghaiDayStartMs } from './time/shanghai-day.js';
import { SimplePlanner } from './planner/index.js';
import { PgAnchorCache, BotChatStore, GroupRouteStore, ConceptStore, LikedNoteStore, ValuableCommentStore, NotificationContactStore, InteractionFeedStore, CuratedContentStore, topicKeysFromTitle } from './cache/index.js';
import type { CuratedReferenceImage, CuratedReferenceImageInput } from './cache/index.js';
import { triggerGatedAutoComment } from './comment-agent/gated-auto-comment.js';
import { resolveCuratedGateConfig } from './publish-agent/curated-gate.js';
import {
  EdgeCloudServer,
  DefaultMessageHandler,
  CaptchaCoordinator,
  CaptchaAssistService,
  edgeCommandToEnvelope,
  type Envelope,
} from './comm/index.js';


import {
  RiskController,
  RiskControllerRegistry,
  PgRiskStore,
  InteractionGuardRegistry,
  ActionCooldownGate,
  PacingSaturationAlerter,
  type RiskAction,
  type RiskWindow,
} from './risk/index.js';
import { EventBus } from './event-bus/index.js';
import type { NoteDetailData } from './event-bus/index.js';
import { RoleDispatcher } from './orchestrator/index.js';
import { ConnectionRuntimeRegistry, type DispatcherBuildContext } from './orchestrator/connection-runtime.js';
import type { CommentApprovalPort } from './agents/comment-approval-gate.js';
import type { BaseRole } from './agents/base-role.js';
import { CommentSearchTermGenerator, type RoleLlmLike } from './agents/comment-search-term-generator.js';
import { PersonaGenerator } from './agents/persona-generator.js';
import { CommentTargetPicker } from './agents/comment-target-picker.js';
import { buildCommentApprovalCard } from './feishu/comment-approval-card.js';
import { buildCommandResultCard } from './feishu/cards.js';
import { CommentScheduler } from './comment-agent/comment-scheduler.js';
import { loadSoul, type Soul } from './soul/index.js';


import {
  CommandRouter,
  FeishuBotChatEventHandler,
  FeishuMessenger,
  FeishuWsReceiver,
  buildFeishuEventDispatcher,
  createBotChatsProvider,
  isFeishuWsEnabled,
  resolveDefaultChatId,
  resolveChatIdForAccount,
  getApprovalSignalPath,
  writeApprovalSignal,
  matchAccountByNickname,
  type CommandActions,
  type PublishApprovalPreflightResult,
} from './feishu/index.js';
import { CommandSequencer } from './publish-agent/command-sequencer.js';
import { EdgeTaskLeaseClient } from './comm/edge-task-lease-client.js';
import { UiSnapshotService } from './comm/ui-snapshot.js';
import type {
  UiDailyUsageAction,
  UiDailyUsageCounts,
  UiDailyUsagePayload,
  UiDailyUsageWindowStatus,
} from './comm/protocol.js';
import { PublishOrchestrator, PublishScheduler, PublishDispatcher } from './publish-agent/index.js';
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
import { OpenAiCompatVisionClient } from './llm/vision.js';
import {
  createCoverFormSensor,
  resolveCoverFormModel,
  resolveCoverFormProvider,
} from './publish-agent/cover-form-sensor.js';
// change textcard-carousel-form-parity（阶段0 影子）：帖级形态档服务（封面先行 + 内页有界并发判形）。
import { createPostImageFormProfileService } from './publish-agent/post-image-form-profile.js';
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
  CoverCardWriterRole,
  ImageSetPlannerRole,
  ImagePromptComposerRole,
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
  ApprovalGatekeeperRole,
  PublishExecutorRole,
} from './publish-agent/roles/index.js';
import { buildDeAiRewritePrompt } from './publish-agent/prompts.js';
import { PostProcessor } from './publish-agent/post-processor.js';
import { PublishLogStore } from './publish-agent/publish-log-store.js';
import { PublishPipelineLogStore } from './publish-agent/publish-pipeline-log-store.js';
import { startPanelApi, parsePanelUsers, PgPanelStore } from './panel/index.js';
import { TokenRevocationStore } from './panel/revocation.js';
import { ClientUserStore, startClientAuthApi, LoginRateLimiter } from './client-auth/index.js';
import { PgAlertStore } from './alerts/index.js';
import { ModelConfigStore } from './config/model-config-store.js';
import { RoleConfigStore } from './config/role-config-store.js';
import { createRoleConfigPanel } from './config/role-config-facade.js';
import { CategoryConfigStore } from './config/category-config-store.js';
import { createCategoryConfigPanel } from './config/category-config-facade.js';
import { categoryOf, type ThinkingMode } from './config/role-catalog.js';
// 账号人设（change account-persona-config，stream F）：按账号可配 + 热加载，回落打包 soul.yaml 不 brick。
import { PersonaStore, createPersonaResolver } from './config/persona-store.js';
import { createPersonaPanel } from './config/persona-facade.js';
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
import { ContentScheduleStore, actionModeEnabled } from './config/content-schedule-store.js';
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
import { CredentialStore } from './config/credential-store.js';
import type { ModelConfigView } from './panel/types.js';

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
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

const UI_DAILY_USAGE_ACTIONS: UiDailyUsageAction[] = ['view', 'like', 'collect', 'comment', 'follow', 'publish'];

function pickDailyUsageCounts(source: Partial<Record<string, number>>): UiDailyUsageCounts {
  const counts: UiDailyUsageCounts = {};
  for (const action of UI_DAILY_USAGE_ACTIONS) {
    const value = source[action];
    counts[action] = Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
  }
  return counts;
}

function pickSessionUsageCounts(source: object | null | undefined): UiDailyUsageCounts {
  const values = (source ?? {}) as Partial<Record<string, number>>;
  const mappings: Array<[UiDailyUsageAction, string]> = [
    ['like', 'likes'],
    ['collect', 'collects'],
    ['comment', 'comments'],
    ['follow', 'follows'],
  ];
  const counts: UiDailyUsageCounts = {};
  for (const [action, key] of mappings) {
    const value = values[key];
    if (Number.isFinite(value)) counts[action] = Math.max(0, Math.floor(Number(value)));
  }
  return counts;
}

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

function completeSessionUsageCounts(
  budgetTotals: object | null | undefined,
  riskTotals: Partial<Record<string, number>> | null,
  publishCount: number | null,
): UiDailyUsageCounts {
  const totals = pickDailyUsageCounts(riskTotals ?? {});
  const interactions = pickSessionUsageCounts(budgetTotals);
  for (const action of ['like', 'collect', 'comment', 'follow'] as const) {
    totals[action] = interactions[action] ?? totals[action] ?? 0;
  }
  totals.publish = typeof publishCount === 'number' && Number.isFinite(publishCount)
    ? Math.max(0, Math.floor(publishCount))
    : (totals.publish ?? 0);
  return totals;
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

async function main(): Promise<void> {
  const port = Number(process.env.AIDCP_PORT ?? 8787);
  const debugPort = Number(process.env.AIDCP_DEBUG_PORT ?? 8788);

  // 模型配置 + 加密凭据（change console-model-provider-config）。
  // 先于 LLM 客户端构造：模型名经 getCached() 运行时解析（热加载）；DashScope 密钥库内优先、回退 env。
  const modelConfigStore = new ModelConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  const credentialStore = new CredentialStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 角色级模型/温度覆盖（change console-role-model-config）。缺/空/无效一律回落全局，绝不 brick。
  const roleConfigStore = new RoleConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 分类级模型默认（change role-model-category-config，item 5/6）。缺/空/异常一律返「无覆盖」，绝不 brick。
  const categoryConfigStore = new CategoryConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 安全限额（change safety-quota-config，stream D）。缺行/非法值一律回落 deriveWindowQuotas 写死默认，绝不 brick。
  const quotaConfigStore = new QuotaConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 操作兜底 floor（change pacing-floor-config-min-interval）：四类操作最小间隔兜底区间、全局一套；
  // 缺行/非法值一律回落 BUILTIN_FLOOR 内置默认并在读出口 clamp，绝不 brick、绝不零延迟。
  const pacingConfigStore = new PacingConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 单场会话上限（全局单例，change restore-auto-resume-and-global-safety-config）：全局单场时长 + 互动预算、对所有账号生效；缺行/非法回落写死默认，绝不 brick。
  const sessionConfigStore = new SessionConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 引流线索热度过滤阈值（全局单例，change feed-hot-lead-group-comment）：帖龄上限 / 速率阈值 / 最小赞，落安全页卡片、热加载。
  const hotLeadConfigStore = new HotLeadConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 自动续场护栏 + 看门狗阈值（全局单例，change restore-auto-resume-and-global-safety-config）：全局 rest_ratio / 活跃时段 /
  // 每日上限 / 看门狗两阈值、对所有账号生效；缺行/非法回落写死默认，绝不 brick。init 失败也不致命（空镜像→全回落默认）。
  const resumeConfigStore = new ResumeConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 内容排期（change content-schedule-auto-publish）：全局「内容可自动时段」+ 每账号发帖排期。
  // fail-closed：未配 / 非法 = 不自动（与浏览掩码「缺失=全天活跃」刻意相反）；init 失败不致命（空镜像 = 全不自动）。
  const contentScheduleStore = new ContentScheduleStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 每账号 Facebook 定时评论配置（change facebook-scheduled-comment 2.1）：关键词列表 + 容器列表。
  // fail-closed：任一为空 = 不生效（诚实 no-op）；init 失败不致命（空镜像 = 全不生效）。
  const facebookCommentConfigStore = new FacebookCommentConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // Facebook 定时评论每次触发的审计行（facebook-scheduled-comment 2.7）：best-effort、不阻塞主链路。
  const facebookCommentAuditStore = new FacebookCommentAuditStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // Facebook group join: operator target catalog, one-group-one-account assignment ledger,
  // and best-effort join audit. Join loop is default-off and shadow-first.
  const facebookGroupTargetStore = new FacebookGroupTargetStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  const facebookGroupMembershipStore = new FacebookGroupMembershipStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  const facebookGroupJoinAuditStore = new FacebookGroupJoinAuditStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 对外客户身份 + 客户↔环境归属（change edge-client-customer-auth）。独立表,与内部运营登录物理隔离。
  const clientUserStore = new ClientUserStore();
  try {
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
    await facebookCommentConfigStore.init();
    await facebookCommentAuditStore.init();
    await facebookGroupTargetStore.init();
    await facebookGroupMembershipStore.init();
    await facebookGroupJoinAuditStore.init();
    await clientUserStore.init();
    console.log('[aidcp-cloud] 模型配置 + 凭据 + 角色配置 + 分类默认 + 安全限额 + 单场上限 + 续场配置存储已就绪（model_config / provider_credentials / role_config / category_config / quota_config / session_config / resume_config）');
  } catch (err) {
    console.warn('[aidcp-cloud] 模型/凭据/角色/分类/限额/续场配置存储初始化失败（回退代码默认模型 + env 密钥；限额/续场回退派生写死默认）:', (err as Error).message);
  }
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
  // token 用量记账（change llm-token-usage-stats）：出口 onCall 钩子只做纯内存累加，
  // 定时 flush 到 llm_token_usage 预聚合表（专用池隔离热路径）。须早于接受 LLM 调用/探活建好。
  const tokenUsageStore = new TokenUsageStore();
  try {
    await tokenUsageStore.init();
    console.log('[aidcp-cloud] token 用量记账已就绪（llm_token_usage，按账号/角色/模型/10分钟桶预聚合）');
  } catch (err) {
    console.warn('[aidcp-cloud] token 用量记账初始化失败（用量将不落库，绝不影响 LLM 调用）:', (err as Error).message);
  }
  // 退出前 flush 末窗（有界 3s，防 PG 不可达时 close 挂住退出）。
  const billingPriceRefresh = createBillingPriceRefresh({
    tokenUsage: tokenUsageStore,
    credentials: credentialStore,
    env: process.env,
  });
  const flushTokenUsageOnExit = (sig: string): void => {
    console.log(`[aidcp-cloud] 收到 ${sig}，flush token 用量后退出`);
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
    // 保留原 console.log（加 provider + tokens 维度）；记账 add() 受 try/catch 双保险，绝不抛进/拖垮 LLM 调用路径。
    onCall: (info) => {
      console.log(
        `[llm] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} ms=${info.ms} ok=${info.ok} tokens=${info.totalTokens ?? 0}`,
      );
      try {
        tokenUsageStore.add(info);
      } catch {
        /* metrics never breaks llm */
      }
    },
  });
  // 发布链 token 账号归属（change parallel-rewrite-drafts 显式归账）：每个发布角色的 LLM 调用从当轮黑板
  // 显式带 accountId（BasePublishRole.accountIdFrom），并发生成各轮各归各账。原「当前发布账号」进程级
  // 单槽已退役——红线：MUST NOT 重新引入共享可变槽推断当前账号（并发轮互踩记账）。
  // 把共享文本客户端按角色绑定成 thin wrapper（发布侧用）：只补 role，账号由调用方显式携带。
  const roleLlm = (roleId: string): ChatLlmClient => ({
    complete: (prompt, opts) => llm.complete(prompt, { ...opts, role: opts?.role ?? roleId }),
    chat: (messages, opts) => llm.chat(messages, { ...opts, role: opts?.role ?? roleId }),
  });
  const planner = new SimplePlanner({ llm });
  const cache = new PgAnchorCache({
    connectionString: readEnvString('DATABASE_URL'),
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });

  const botChatStore = new BotChatStore();
  const botChatEventHandler = new FeishuBotChatEventHandler(botChatStore);

  // 建表（幂等）；PG 不可用时打印告警但不阻塞启动协议处理
  try {
    await cache.init();
    console.log('[aidcp-cloud] PG 锚点缓存已就绪');
  } catch (err) {
    console.warn('[aidcp-cloud] PG 初始化失败（缓存相关消息将报错）:', (err as Error).message);
  }

  // 发布日志存储（publish_log 表）
  const publishLogStore = new PublishLogStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 发布角色执行日志（publish_pipeline_logs 表，change publish-pipeline-observability）：复用同库连接配置。
  // 表由 migration 0004 已建,无需 init;写入 best-effort、不阻塞发布。注入给 PublishOrchestrator 当 pipelineLogSink。
  const publishPipelineLogStore = new PublishPipelineLogStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  try {
    await publishLogStore.init();
    console.log('[aidcp-cloud] PublishLogStore 已就绪');
  } catch (err) {
    console.warn('[aidcp-cloud] PublishLogStore 初始化失败:', (err as Error).message);
  }

  // 点赞笔记存储（liked_notes 表，发帖来源血缘）。init 失败留 undefined（血缘退化、不阻塞启动）。
  let likedNoteStore: LikedNoteStore | undefined;
  try {
    const ls = new LikedNoteStore({
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

  // 优质评论语料库（valuable_comments 表，comment-like-on-detail B）。仅特性开启时建表/接线；
  // init 失败留 undefined（语料库退化：不归档、撰写不注入参考，不崩闭环）。
  let valuableCommentStore: ValuableCommentStore | undefined;
  if (process.env.AIDCP_COMMENT_LIKE === 'true') {
    try {
      const vs = new ValuableCommentStore({
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
  }

  // 通知联系人名册（notification-contact-registry，迁移 0016）：记录给本账号发过通知的人（评论/@/点赞/收藏/关注）。
  // 无条件接线（核心特性）；init 失败留 undefined（记录与面板退化，绝不崩闭环）。
  let notificationContactStore: NotificationContactStore | undefined;
  try {
    const ncs = new NotificationContactStore({
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
  try {
    const grs = new GroupRouteStore();
    await grs.init();
    groupRouteStore = grs;
    console.log('[aidcp-cloud] GroupRouteStore 已就绪（group_route 表；账号→团队群路由）');
  } catch (err) {
    console.warn('[aidcp-cloud] GroupRouteStore 初始化失败，团队路由退化（一律落默认群）:', (err as Error).message);
  }

  // 面板互动流展示账本（change interaction-feed-enrichment）。init 失败留 undefined（面板互动表退化为空、绝不崩闭环）。
  let interactionFeedStore: InteractionFeedStore | undefined;
  try {
    const ifs = new InteractionFeedStore({
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

  // 精选灵感语料（curated_content 表，change curated-inspiration-corpus）。过门槛的高价值笔记落详细行，
  // 作发帖创作正向素材来源。init 失败留 undefined（不捕获、创作回落旧路径，绝不崩闭环）。
  let curatedContentStore: CuratedContentStore | undefined;
  try {
    const ccs = new CuratedContentStore({
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
      ...(ossUploader ? { referenceImageRelocator: createCuratedReferenceImageRelocator(ossUploader) } : {}),
      logger: console,
    });
    await ccs.init();
    curatedContentStore = ccs;
    console.log('[aidcp-cloud] CuratedContentStore 已就绪（curated_content 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] CuratedContentStore 初始化失败，精选灵感语料退化:', (err as Error).message);
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
    }
  >();

  // 概念池存储（concepts 表，跨会话搜索记忆）。init 失败则留 undefined：
  // RoleDispatcher 不注册概念抽取角色、搜索退化为仅 seed_keywords（不崩闭环）。
  let conceptStore: ConceptStore | undefined;
  try {
    const cs = new ConceptStore({
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
    getModel: () => modelConfigStore.getCached().imageModel,
    // 慢图容忍：轮询次数 env 可调（默认 34×5s=170s；须 < ImageGenerator 角色闸 200s）。change publish-image-required-or-fail。
    maxPollAttempts: Number(process.env.AIDCP_WANXIANG_MAX_POLL ?? 34),
  });

  // 即梦-Seedream 客户端（图片生成，火山方舟 Ark 同步）。change image-provider-volcengine-seedream：
  // 复用启动期已载入的火山 key+base（providerRuntime['volcengine']，与文本火山同源）；imageModel 热加载。
  const arkRuntime = providerRuntime['volcengine'];
  const seedreamClient = new SeedreamClient({
    apiKey: arkRuntime?.apiKey || undefined,
    baseUrl: arkRuntime?.baseUrl || undefined,
    getModel: () => modelConfigStore.getCached().imageModel,
    timeoutMs: Number(process.env.AIDCP_SEEDREAM_TIMEOUT_MS ?? 60_000),
  });

  // 图片出口：按全局 image_provider 路由（dashscope→万相、volcengine→即梦 Seedream），热加载、缺密钥诚实失败不跨厂商兜底。
  const imageProvider = new RoutingImageProvider({
    getProvider: () => modelConfigStore.getCached().imageProvider,
    providers: { dashscope: wanxiangClient, volcengine: seedreamClient },
  });
  // 图片总开关：任一图片厂商密钥就绪即启用（选中厂商若缺密钥，其客户端会诚实失败 → 该张记 M 少一张、不假成功）。
  const anyImageKeyPresent = !!(readEnvString('WANXIANG_API_KEY') ?? dashscopeApiKey) || !!arkRuntime?.apiKey;

  // 发布编排器（PublishOrchestrator）。change decouple-publish-generation-from-dispatch：
  // 编排只跑生成候审段（生成终稿 + 落库待审 + 发审批卡），**不再让位浏览**、**不再内联等审**——
  // 让位/续场与真正下发已下放到 PublishDispatcher（下方构造，由人审授权触发）。
  // change raise-model-call-timeouts-for-thinking-models：总闸默认 180s → 600s，须 ≥ 关键路径各模型角色预算之和
  // （容器不得小于内容物；旧 180s < scout+content 串行和 210s，慢跑会中途掐断并丢弃已付费产出）。env 可调、下限保护。
  const publishOrchestrator = new PublishOrchestrator({
    logger: console,
    pipelineTimeoutMs: normalizeTimeoutMs(process.env.AIDCP_PUBLISH_PIPELINE_TIMEOUT_MS, 600_000),
    // 角色执行日志写入口（死表 publish_pipeline_logs 激活）：每角色每次执行 best-effort 落一行。
    pipelineLogSink: publishPipelineLogStore,
  });
  // 页面写执行权现由 EdgeTaskLeaseClient + edge EdgeTaskCoordinator 统一管理；发布/评论不再各自 end/resume 浏览。
  // 手动 /comment 的评论**不计入风控配额**（人工授权，与 /publish 越过风控同理）：评论任务接管期间该账号在此集合，
  // `interaction.occurred` 的 `RiskController.record` 据此对 `comment` 动作跳过。标记只覆盖获批后的 commit 租约，
  // 不覆盖 prepare/LLM/人审，也不触发浏览会话生命周期；自动排期 priority=automatic 不进入集合、照常计配额。
  const manualCommentAccounts = new Set<string>();
  const onCommentTakeoverStart = (accountId: string): void => {
    manualCommentAccounts.add(accountId);
  };
  const onCommentTakeoverEnd = (accountId: string): void => {
    manualCommentAccounts.delete(accountId);
  };

  // 事件总线
  const eventBus = new EventBus();

  // 账号主表 + 暂停态持久化（accounts 表，seed 一个 default 行）。
  // PG 不可用则退化为纯内存（重启丢暂停态，告警但不阻塞启动）。
  let accountStore: AccountStore | undefined;
  try {
    const store = new PgAccountStore({
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await store.init();
    accountStore = store;
    console.log('[aidcp-cloud] AccountStore 已就绪（accounts 表，seed default）');
  } catch (err) {
    console.warn(
      '[aidcp-cloud] AccountStore 初始化失败，账号暂停态退化为纯内存（重启丢失）:',
      (err as Error).message,
    );
  }
  // 启动加载持久化暂停态进内存缓存：被暂停账号重启后仍为 paused，不静默复活。
  const accountState = new AccountStateManager(accountStore);
  await accountState.init();
  const accountDisplayName = (accountId: string): string | undefined => {
    const nickname = accountStore?.getNickname?.(accountId)?.trim();
    return nickname || undefined;
  };

  // ── 账号人设（change account-persona-config，stream F，迁移 0011）─────────────
  // 须在 accounts 表建好之后（persona_config FK 到 accounts）。
  // persona-driven-content-pipeline：系统不存在默认/兜底人设——PG 不可用 / init 失败时人设镜像为空，
  // 所有账号按「未绑人设」fail-closed 诚实拒绝（isPersonaBound=false），绝不静默套打包 soul.yaml 开跑。
  const personaStore = new PersonaStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
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
  const personaPanel = createPersonaPanel({
    store: personaStore,
    onBound: (accountId) => {
      runtimes?.startSessionForAccount(accountId);
    },
  });

  // RiskController 注册表（V1 task 9.1）：每账号一个 controller、单写 PER ACCOUNT、共享 PgRiskStore。
  // 现役路径用其 default controller（单一来源，避免双 controller 写同一 risk_state）；PG 不可用则现役回退内存态。
  // PgRiskStore 单例：既喂 registry（按账号风控单写），又作 InteractionStore 接线孤儿
  // risk_interactions 去重表（V1 task 9.2，按笔记互动历史）。
  const riskStore = new PgRiskStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // quotaConfigStore 作 QuotaProvider 注入：每账号 controller 的 effectiveQuotas 热加载读限额数字
  // （change safety-quota-config）；init 失败时其镜像为空 → 退化派生写死默认，绝不 brick。
  // 养号冷启动配额爬坡（change account-nurture-discipline-spine）：默认开（安全方向），
  // AIDCP_COLDSTART_RAMP=false 可秒回滚。按 accounts.created_at + platform 现算账号年龄→冷启动天花板，
  // effectiveQuotas=min(冷启动天花板, 风控缩放)。resolver 缺 / 失败 → 该账号不叠冷启动（零回归）。
  const coldStartRampEnabled = process.env.AIDCP_COLDSTART_RAMP !== 'false';
  const riskRegistry = new RiskControllerRegistry(riskStore, undefined, quotaConfigStore, {
    coldStartRampEnabled,
    nurtureMetaResolver: accountStore
      ? (accountId) => accountStore!.getNurtureMeta?.(accountId) ?? Promise.resolve(null)
      : undefined,
  });
  console.log(`[aidcp-cloud] 冷启动配额爬坡 ${coldStartRampEnabled ? '已开启' : '已禁用(AIDCP_COLDSTART_RAMP=false)'}`);
  // retire-default-account：不再建单租户全局 'default' controller；风控一律经 registry 按真实账号懒解析。
  const resolveController = (accountId: string): Promise<RiskController> => riskRegistry.getController(accountId);
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

  // 数据保留清理（change console-cloud-panel-hardening #21/#22/#23）：面板只读查询打在追加型表上，
  // 零保留策略会使全表扫描成本随运行时长单调恶化 → 日频清理三表过期行（各表独立 try/catch，
  // 一个失败不拖累其它、绝不逃逸崩进程；只删各自表、不碰风控单写/发布链/edge）。
  startRetentionSweeper({
    targets: { riskStore, interactionFeedStore, tokenUsageStore },
    logger: console,
  });

  // 节奏饱和运维告警器（change decouple-quota-hit-from-risk）：撞速率突发窗不再升风控态，
  // 改道成低优先级运维告警。alertStore 就绪后（见下方）赋值；闭包在事件触发时读取，故此处先声明。
  let pacingAlerter: PacingSaturationAlerter | undefined;

  // RiskController 订阅跨模块事件：真实互动发生时按账号计数（record 内部再过 canDo）。
  eventBus.on('interaction.occurred', (evt) => {
    // retire-default-account：账号归因 honest-fail —— 缺 accountId（握手已保证存在）即丢弃该事件 + 告警，
    // 绝不回落保留键 default（杜绝脏流量记到退役账号名下）。
    if (!evt.accountId) {
      console.warn('[aidcp-cloud] interaction.occurred 缺 accountId — 丢弃（honest-fail），绝不回落 default');
      return;
    }
    const accountId = evt.accountId;
    // 手动 /comment 的评论不计入风控配额（人工授权，change comment-search-command）：评论任务接管期间的 `comment`
    // 跳过 RiskController.record——不消耗自治评论预算、不动风控态。自治评论照常计数；去重(risk_interactions)与
    // 展示账本(interaction_feed)不受影响（各自在下方/其他消费者处理）。
    const skipRiskRecord = evt.action === 'comment' && manualCommentAccounts.has(accountId);
    // 按 accountId 路由到对应账号 controller（record 内部再过 canDo）。
    if (!skipRiskRecord) {
      riskRegistry
        .getController(accountId)
        .then(async (c) => {
          const recorded = await c.record(evt.action);
          // 配额饱和改道（change decouple-quota-hit-from-risk）：record 被拒且原因是突发窗（小时/分钟）
          // 过载 → 发低优先级运维告警（每日窗静默、只背压）。风控状态在 record 内部已不再被撞配额改动。
          if (!recorded && pacingAlerter) {
            const reason = c.explain(evt.action).reason;
            if (reason === 'quota:hour' || reason === 'quota:minute') {
              pacingAlerter.maybe(accountId, evt.action, reason === 'quota:hour' ? 'hour' : 'minute');
            }
          }
        })
        .catch((err) => {
          console.warn('[aidcp-cloud] RiskController record error:', err);
        });
    }
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
    const as = new PgAlertStore({
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await as.init();
    alertStore = as;
    console.log('[aidcp-cloud] AlertStore 已就绪（alerts 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] AlertStore 初始化失败，告警不落库（飞书告警仍发）:', (err as Error).message);
  }
  // 节奏饱和告警器接线（change decouple-quota-hit-from-risk）：有 alertStore 才发，缺则降级为不发、不阻塞。
  if (alertStore) {
    pacingAlerter = new PacingSaturationAlerter({ alertStore });
    console.log('[aidcp-cloud] PacingSaturationAlerter 已就绪（撞突发窗 → 低优先级运维告警）');
  }

  // A 阶段4 发帖触发器（下方实例化；actions.publish 运行时引用，前向安全）。
  let publishScheduler: PublishScheduler | undefined;
  // 按需评论触发器（change comment-search-command；下方实例化，actions.comment 运行时引用，前向安全）。
  let commentScheduler: CommentScheduler | undefined;

  // 飞书事件接收（官方 SDK 长连接，主动连飞书，无需公网 IP / HTTP 端口）
  // MVP：账号启停/查询动作先打桩（后续接云端调度器 → plan.request）
  // retire-default-account：飞书无参命令解析「唯一真实账号」；解析不出（0 或多个）抛错 → 路由层回「请显式指定账号」，绝不回落 default。
  const requireCommandAccount = async (accountId?: string): Promise<string> => {
    if (accountId) return accountId;
    const single = await resolveSingleAccountId();
    if (single) return single;
    throw new Error('当前为 0 个或多个账号，请显式指定账号，例如 `/status <accountId>`');
  };
  // 按昵称解析 /publish 的目标账号（严格只认昵称、不接 id）：缺省 → 唯一真实账号；
  // 找不到 / 重名 → 诚实抛错（带可用昵称清单），由路由层回报给运营。
  const resolveAccountByNickname = async (nickname?: string): Promise<string> => {
    if (!nickname) {
      const single = await resolveSingleAccountId();
      if (single) return single;
      throw new Error('当前为 0 个或多个账号，请用昵称指定，例如 `/publish 工程师大白`');
    }
    if (!accountStore) throw new Error('账号存储未就绪，无法按昵称解析账号');
    const all = await accountStore.listAll();
    const candidates = all.map((a) => ({
      accountId: a.accountId,
      nickname: accountStore!.getNickname?.(a.accountId) ?? null,
    }));
    const r = matchAccountByNickname(nickname, candidates);
    if (r.ok) return r.accountId;
    if (r.reason === 'ambiguous') {
      throw new Error(`有多个账号匹配昵称「${nickname}」（${r.available.join('、')}），请去重后再试`);
    }
    throw new Error(`找不到昵称「${nickname}」的账号。可用昵称：${r.available.join('、') || '(无)'}`);
  };
  const actions: CommandActions = {
    status: async (accountId) => {
      const acct = await requireCommandAccount(accountId);
      const state = accountState.getStatus(acct);
      const emoji = state.status === 'paused' ? '⏸️' : '🟢';
      const statusText = state.status === 'paused' ? 'paused' : 'active';
      const extra = state.pausedAt ? `\n暂停时间：${new Date(state.pausedAt).toLocaleString()}` : '';
      return `账号 \`${acct}\` 当前状态：${statusText} ${emoji}${extra}`;
    },
    pause: async (accountId) => {
      const acct = await requireCommandAccount(accountId);
      await accountState.pause(acct);
      console.log(`[feishu] 已暂停账号：${acct}`);
    },
    resume: async (accountId) => {
      const acct = await requireCommandAccount(accountId);
      await accountState.resume(acct);
      // 验证码人工恢复快路：解除该账号名下被暂停的 edge（server 在下方初始化，命令运行时才触发，引用安全）。
      const resumedEdges = server.resumeEdgesForAccount(acct);
      console.log(`[feishu] 已恢复账号：${acct}（恢复 edge 数=${resumedEdges}）`);
    },
    bindChat: (record) => botChatStore.setDefault(record),
    // 手动 /publish <昵称>：越过风控 canDo（人工授权），发布前飞书人审仍铁定生效（AC-PUB）。
    // 按昵称解析目标账号（严格只认昵称）→ 落 publish_log.account_id + 命令定向到该账号在线节点；缺省 → 唯一真实账号。
    // 回执据**真实编排终态**判 ok/level：成功（已生成进人审）=绿、未触发/未产出=黄、失败/不可用=红，并把失败原因带进正文。
    // 红线：「触发动作成功」≠「发帖成功」——绝不把 failed/skipped 染成绿色 ✅ 误导人以为已发。
    publish: async (nickname?: string, options?: { sourceChatId?: string }) => {
      if (!publishScheduler) {
        return { ok: false, level: 'error', title: '发帖未触发', message: '发帖触发器未就绪（PG / 概念池不可用），未发起任何编排。' };
      }
      const acct = await resolveAccountByNickname(nickname); // 找不到/重名 → 抛错，runPublish 走 fail 分支（红 ❌）
      const note = `（账号昵称 \`${nickname ?? '(唯一账号)'}\`；人工授权越过风控，但发布前仍需飞书人审 approved=true 才会真发）`;
      const o = await publishScheduler.triggerManual(acct, { manualApprovalChatId: options?.sourceChatId });
      // 触发动作本身被拒（解析不出唯一账号等）：没成功但非崩 → 黄色 ⚠️。
      if (o.result !== 'triggered') {
        return { ok: false, level: 'warning', title: '发帖未触发', message: `账号 \`${acct}\` 未触发：${o.reason}` };
      }
      const head = `已触发（${o.reason}）→ 账号 \`${acct}\` → 编排状态 ${o.status}`;
      const why = o.failureReason ? `\n原因：${o.failureReason}` : '';
      // 失败 / 超时：真失败 → 红色 ❌，带上具体原因（中止角色+理由 / 超时 / 异常）。
      if (o.status === 'failed' || o.status === 'timeout') {
        return { ok: false, level: 'error', title: '发帖编排失败', message: `${head}${why}\n（编排在生成候审阶段失败，未发审批卡；请查云端日志或重试 /publish）` };
      }
      // 跳过：触发了但没产出稿件（已有编排在跑 / 选题判定不发）→ 黄色 ⚠️，非失败但也别染绿。
      if (o.status === 'skipped') {
        return { ok: false, level: 'warning', title: '发帖未产出', message: `${head}${why}` };
      }
      if (o.approvalCard && !o.approvalCard.sent) {
        const target = o.approvalCard.targetChatId ? `目标会话 \`${o.approvalCard.targetChatId}\`` : '未解析到目标会话';
        const error = o.approvalCard.error ? `\n发卡错误：${o.approvalCard.error}` : '';
        return {
          ok: false,
          level: 'warning',
          title: '草稿已生成，审批卡未送达',
          message: `${head}\n已生成待审草稿，但审批卡没有送达（${target}）。${error}\n请在控制台审批，或修复飞书会话权限后重试。`,
        };
      }
      // 正常出口（pending_approval / published / draft / needs_review）：已生成并进入人审或已发 → 绿色 ✅。
      return { ok: true, level: 'success', title: '已触发发帖编排', message: `${head}\n${note}` };
    },
    // 手动 /comment <昵称>（change comment-search-command）：按昵称解析账号 → 触发按需评论任务。
    // 回执据**触发结果**判 ok/level（开跑绿 / 未触发黄 / 失败红）；最终评/未评结果由 scheduler 异步补结果卡片。
    comment: async (nickname?: string, options?: { injectContact?: boolean; joinGroup?: boolean; joinGroupUrl?: string; force?: boolean }) => {
      if (!commentScheduler) {
        return { ok: false, level: 'error', title: '按需评论未就绪', message: '评论触发器未就绪（启动中或依赖不可用），未发起任务。' };
      }
      const acct = await resolveAccountByNickname(nickname); // 找不到/重名 → 抛错，runComment 走 fail 分支（红 ❌）
      // injectContact（change generalize-contact-info）：--contact 时注入账号联系方式；缺联系方式 fail-closed 由 scheduler 处置。
      // joinGroup（change facebook-manual-join-comment）：--join 时先加入一个新群、加入成功后在该新群里评论（仅 FB）。
      // joinGroupUrl（change facebook-comment-review-and-targeted-join）：--join=<url> 时加入**指定群**（只归该账号）而非库内下一个。
      // manualOverride（change manual-comment-bypass-quota）：飞书手动 /comment 是操作员命令 → 加群 + 评论整条链跳过节奏 / 风控配额闸
      // （会话加群额度 + 加群速率 + 评论速率 + 评论日上限 + 硬风控状态），与已无配额闸的手动 XHS /comment 对齐；自动排期路径不带此旗标。
      // force（change manual-comment-force-flag）：--force 时放开相关性 + 每笔记去重两道软筛选（仍守人审/安全校验/诚实闸）。
      // 与 manualOverride **分开传**——manualOverride 只绕配额、force 只绕相关性/去重，二者独立语义，绝不合并。
      return commentScheduler.triggerManual(acct, {
        injectContact: options?.injectContact,
        joinFirst: options?.joinGroup,
        joinGroupUrl: options?.joinGroupUrl,
        manualOverride: true,
        force: options?.force === true,
      });
    },
  };
  // 命令作用域（change feishu-per-team-notification-routing）：账号影响类命令只在「管理群」受理，外部 / 非管理群一律诚实拒。
  // 管理群 = 独立显式 env 白名单 FEISHU_MANAGEMENT_CHAT_IDS（逗号分隔）——**不由 /bind 授予、不复用 is_default**（防自助提权）。
  // 未配置（env 空）→ 放行全部（零回归 / 滚动上线 ramp：先零变更部署，待就绪再显式设白名单收紧）。
  const managementChatIds = new Set(
    (readEnvString('FEISHU_MANAGEMENT_CHAT_IDS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const commandScopingEnabled = managementChatIds.size > 0;
  const isCommandChatAuthorized = (chatId?: string): boolean =>
    !commandScopingEnabled || (!!chatId && managementChatIds.has(chatId));
  console.log(
    commandScopingEnabled
      ? `[aidcp-cloud] 飞书命令作用域已启用：仅 ${managementChatIds.size} 个管理群可下达账号命令（外部群纯通知投递）`
      : '[aidcp-cloud] 飞书命令作用域未启用（FEISHU_MANAGEMENT_CHAT_IDS 为空）→ 放行全部命令（零回归）',
  );
  const commandRouter = new CommandRouter(actions, undefined, undefined, isCommandChatAuthorized);
  const messenger = new FeishuMessenger();
  // 机器人所在群 provider（change feishu-bot-chat-name-display）：实时取飞书真实群名 + 标默认群 + 降级来源。
  // 成功结果缓存 60s（避免每次开页打飞书）；失败（缺 im:chat:readonly 权限 / 网络）降级回 bot_chats 表、不缓存（下次自动重试）。
  const botChatsProvider = createBotChatsProvider({
    messenger,
    botChatStore,
    fallbackChatId: process.env.FEISHU_CHAT_ID,
    logger: console,
  });
  // A 阶段1 发布指令编排器 / 验证码协助均经 edgeServer 推送（server 在下方构造，闭包运行时已就绪）。
  let edgeServer: EdgeCloudServer | undefined;
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
    pusher: { pushToEdges: (env, edgeId) => (edgeServer ? edgeServer.pushToEdges(env as Envelope, edgeId) : 0) },
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
    messenger,
    // V1 task 9.5：验证码告警落库（飞书卡发送点写入、清除点 resolveByEdge）。
    alertStore,
    getAccountName: accountDisplayName,
    assist: captchaAssist,
    resolveChatId: () =>
      resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console }),
  });
  // A 阶段1 发布指令编排器：逐条下发 publish.command、按 recordId+seq 关联 publish.command.result。
  const commandSequencer = new CommandSequencer({
    pusher: { pushToEdges: (env, edgeId) => (edgeServer ? edgeServer.pushToEdges(env as Envelope, edgeId) : 0) },
    logger: console,
  });
  edgeTaskLeases = new EdgeTaskLeaseClient({
    pusher: { pushToEdges: (env, edgeId) => (edgeServer ? edgeServer.pushToEdges(env, edgeId) : 0) },
    acquireTimeoutMs: Number(process.env.AIDCP_EDGE_TASK_ACQUIRE_TIMEOUT_MS ?? 45_000),
    releaseTimeoutMs: Number(process.env.AIDCP_EDGE_TASK_RELEASE_TIMEOUT_MS ?? 10_000),
    defaultLeaseMs: Number(process.env.AIDCP_EDGE_TASK_LEASE_MS ?? 5 * 60_000),
    logger: console,
  });
  // AC-PUB 第1道 + 版本闸（edit-note-draft-before-publish）：按 requestId 读审批信号文件，
  // 回 { approved, contentVersion }；signal.payload.contentVersion 缺失（部署前老签名）→ 0（向后兼容）。
  // 缺文件/解析失败 → null（未授权）。
  const readPublishApproval = async (
    requestId: string,
  ): Promise<{ approved: boolean; contentVersion: number } | null> => {
    try {
      const raw = await readFile(getApprovalSignalPath(requestId), 'utf8');
      const parsed = JSON.parse(raw) as { approved?: boolean; payload?: { contentVersion?: number } };
      return { approved: parsed?.approved === true, contentVersion: Number(parsed?.payload?.contentVersion ?? 0) };
    } catch {
      return null;
    }
  };
  // 布尔视图（评论审批口沿用；只关心 approved）。
  const isPublishApproved = async (requestId: string): Promise<boolean> => {
    const d = await readPublishApproval(requestId);
    return d?.approved === true;
  };
  // 作废（删除）一份过期授权签名（edit-note-draft-before-publish）：下发版本闸命中不符时调用，令草稿回可重审。
  const voidApprovalSignal = async (requestId: string): Promise<void> => {
    try {
      await unlink(getApprovalSignalPath(requestId));
    } catch {
      /* 已不存在则忽略（幂等） */
    }
  };
  // 读某草稿当前内容版本号（edit-note-draft-before-publish）：面板/飞书授权前的写时预检用；不存在/出错 → null。
  const readLiveContentVersion = async (recordId: number): Promise<number | null> => {
    try {
      const draft = await publishLogStore.loadForDispatch(recordId);
      return draft ? draft.contentVersion : null;
    } catch {
      return null;
    }
  };

  // ── 多租户连接运行时（multi-account-node-support）：每连接私有 EventBus + RoleDispatcher ──────────
  // 前向声明：handler / server 经闭包引用 runtimes（runtimes 在下方装配后才被调用，运行时安全）。
  let runtimes: ConnectionRuntimeRegistry | undefined;
  // 调度启停态（面板 /dispatch 全局开关）：false 时新 / 现有连接不启动浏览会话。
  let dispatchActive = true;
  // 建号自助人设生成器（change edge-persona-keyword-generation）：复用共享 llm（按角色 browse:persona_generator
  // 解析模型/温度、按 accountId 记账），生成 persona.generate 的草稿。
  const personaGenerator = new PersonaGenerator({ llm });
  const handler = new DefaultMessageHandler({
    planner,
    llm,
    cache,
    messenger,
    botChatStore,
    approvalChatId: process.env.FEISHU_CHAT_ID,
    eventBus,
    accountState,
    captcha,
    captchaAssist,
    commandSequencer,
    edgeTaskLeases,
    // 建号自助人设（change edge-persona-keyword-generation）：persona.generate 生成器 + persona.persist 复用写入外观。
    personaGenerator,
    personaFacade: personaPanel,
    // 多租户路由：私有总线（入站事件灌本连接通道）/ 握手建运行时 / 按连接真实账号解析 controller。
    busFor: (session) => runtimes!.busFor(session),
    onHandshake: (session) => runtimes!.onHandshake(session),
    resolveController: (session) => runtimes?.controllerForSession(session),
    // 节奏兜底 floor 提供者（change pacing-floor-config-min-interval）：welcome 握手现读组装 pacing 快照下发
    // （PUT 后下次握手即新值 = 热加载）。init 失败也安全：空镜像 → floorFor 逐项回落 BUILTIN_FLOOR 内置默认。
    pacingFloors: pacingConfigStore,
  });
  // 陪伴界面快照层（edge-companion-ui 8.1）：前向引用（服务实例在 server 起后构造，同 pusher 闭包模式）。
  let uiSnapshot: UiSnapshotService | undefined;
  const server = new EdgeCloudServer({
    port,
    handler,
    onClose: (session) => {
      if (session.edgeId) edgeTaskLeases.invalidateEdge(session.edgeId);
      runtimes?.onDisconnect(session);
    },
    // 握手注册完成（连接已可被推送、welcome 已回）→ 回填该账号的陪伴界面快照（昵称/最近发布/在途候审）。
    onEdgeRegistered: (session) => {
      void uiSnapshot?.pushHelloSnapshot(session.accountId, session.edgeId);
      // 自动登记环境进管理侧注册表（change client-user-env-registry）：AdsPower 环境（edgeId=ads-<分身id>）一连上来
      // 就进后台「待分配」池，供运营把它分给端用户——**只登记、不归属**（绝不误塞给某客户）。仅带 ads- 前缀的真实分身
      // 环境登记；self-/host- 兜底 edge 不是可分配环境、跳过。env_key = 去掉 ads- 前缀（与 edge attach/过滤口径一致）。
      const eid = session.edgeId;
      if (eid && eid.startsWith('ads-')) {
        void clientUserStore
          .registerEnvironments(
            [{ envKey: eid.slice('ads-'.length), label: session.accountNickname ?? null, platform: session.platform ?? null }],
            'auto',
          )
          .catch((err) => console.warn(`[client-env] 自动登记环境失败 edge=${eid}: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  });
  edgeServer = server;
  await server.start();
  console.log(`[aidcp-cloud] 边-云 WebSocket 服务端已监听 :${port}`);

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
    const sessionUsage = runtimes?.sessionUsageForAccount(accountId, edgeId) ?? null;
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
      sessionStartedAt === null ? Promise.resolve(null) : publishLogStore.countPublishedSinceForAccount(accountId, sessionStartedAt),
      publishLogStore.countPublishedSinceForAccount(accountId, minuteSince),
      publishLogStore.countPublishedSinceForAccount(accountId, hourSince),
      publishLogStore.countPublishedTodayForAccount(accountId),
    ]);

    const minuteTotals = pickDailyUsageCounts(minuteRiskTotals);
    minuteTotals.publish = minutePublishCount;
    const hourTotals = pickDailyUsageCounts(hourRiskTotals);
    hourTotals.publish = hourPublishCount;
    const dayTotals = pickDailyUsageCounts(dayRiskTotals);
    dayTotals.publish = dayPublishCount;

    const sessionTotals = completeSessionUsageCounts(sessionUsage?.totals ?? {}, sessionRiskTotals, sessionPublishCount);
    const sessionQuotas = pickSessionUsageCounts(sessionUsage?.quotas ?? sessionConfigStore.sessionBudget());
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
    try {
      const controller = await riskRegistry.getController(accountId);
      const effective = controller.effectiveQuotas();
      const minuteQuotas = pickDailyUsageCounts(effective.minute);
      const hourQuotas = pickDailyUsageCounts(effective.hour);
      const dayQuotas = pickDailyUsageCounts(effective.day);
      payload.quotaLevel = controller.getState().quotaLevel;
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

  uiSnapshot = new UiSnapshotService({
    pusher: { pushToEdges: (env, edgeId) => server.pushToEdges(env, edgeId) },
    resolveEdgeIdForAccount: (accountId) => server.resolveEdgeIdForAccount(accountId),
    getNickname: (accountId) => accountStore?.getNickname?.(accountId) ?? null,
    // 已绑人设信号（change persona-wizard-onboarding-fixes）：persona 存储权威判据，随 hello 快照下发。
    isPersonaBound: (accountId) => personaStore.getForAccount(accountId) !== null,
    lastPublishedForAccount: (accountId) => publishLogStore.lastPublishedForAccount(accountId),
    pendingApprovalForAccount: (accountId) => publishLogStore.pendingApprovalForAccount(accountId),
    readApproval: readPublishApproval,
    todayUsageForAccount: buildTodayUsageForAccount,
    logger: console,
  });
  const uiSnapshotService = uiSnapshot;

  const publishDispatcher = new PublishDispatcher({
    store: publishLogStore,
    sequencer: commandSequencer,
    edgeTaskLeases,
    resolveEdgeIdForAccount: (accountId) => server.resolveEdgeIdForAccount(accountId),
    readApproval: readPublishApproval,
    voidApprovalSignal,
    // 陪伴界面：授权核实→approved、云端终判失败→failed 推给在线边缘（published 由边缘自知）。
    notifyUiPublishState: (accountId, recordId, state, title) =>
      uiSnapshotService.pushPublishState(accountId, recordId, state, title),
    // 下发段运维通知（change parallel-rewrite-drafts）：离线回待审 / 熔断开启 / 熔断解除 → 默认群文本，best-effort。
    notifyDispatchEvent: (notice) => {
      void (async () => {
        const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
        if (!chatId) return;
        const name = accountDisplayName(notice.accountId) ?? notice.accountId;
        const ref = notice.recordId !== undefined ? `草稿 #${notice.recordId}${notice.title ? `「${notice.title}」` : ''}` : '';
        const text =
          notice.kind === 'offline_requeued'
            ? `⚠️ 发布未执行：账号「${name}」边缘离线，${ref} 已退回待审（本次授权作废）。边缘恢复后请重新批准。`
            : notice.kind === 'breaker_open'
              ? `🔴 发布熔断：账号「${name}」连续下发失败（最近 ${ref}），已停止自动下发其已批草稿。排查边缘后重新批准任一草稿即恢复。`
              : `🟢 发布熔断解除：账号「${name}」人工批准确认，恢复下发已批队列。`;
        await messenger.sendText(chatId, text);
      })().catch(() => {});
    },
    breakerThreshold: Number(process.env.AIDCP_PUBLISH_BREAKER_THRESHOLD ?? 2),
    logger: console,
  });
  // 审批授权 → 触发下发（仅 publish-<n> 走此路；评论审批 comment-<…> 不触发发帖下发）。
  // humanApproval：人工批准入口（含 already-decided 重复批准）——熔断中即视为人工确认清除并恢复 drain。
  const triggerPublishDispatchOnApprove = (requestId: string): void => {
    const m = /^publish-(\d+)$/.exec(requestId);
    if (!m) return;
    publishDispatcher
      .dispatch(Number(m[1]), { humanApproval: true })
      .catch((e) => console.warn('[aidcp-cloud] publish dispatch err:', e instanceof Error ? e.message : String(e)));
  };
  // 陪伴界面：拒绝发布（飞书取消/面板拒绝首写成功）→ rejected 推给该账号在线边缘（仅 publish-<n>）。
  const notifyPublishRejected = (requestId: string): void => {
    const m = /^publish-(\d+)$/.exec(requestId);
    if (!m) return;
    const recordId = Number(m[1]);
    void publishLogStore
      .loadForDispatch(recordId)
      .then(async (draft) => {
        if (!draft || draft.status !== 'pending_approval') return;
        await publishLogStore.rejectPendingApproval(recordId);
        uiSnapshotService.pushPublishState(draft.accountId, recordId, 'rejected', draft.title);
      })
      .catch(() => {});
  };

  const preflightApprovePublish = async (requestId: string): Promise<PublishApprovalPreflightResult> => {
    const m = /^publish-(\d+)$/.exec(requestId);
    if (!m) return { ok: true };
    const recordId = Number(m[1]);
    let draft: Awaited<ReturnType<typeof publishLogStore.loadForDispatch>>;
    try {
      draft = await publishLogStore.loadForDispatch(recordId);
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
      console.warn(`[aidcp-cloud] 授权发布被拦截：账号 ${draft.accountId} 无在线节点，requestId=${requestId}`);
      return { ok: false, reason: 'account_offline', accountId: draft.accountId };
    }
    return { ok: true, accountId: draft.accountId, edgeId };
  };

  // 兜底补偿（at-least-once）：低频扫描已授权但未下发的待审草稿补触发（覆盖事件丢失）；靠 dispatch 幂等去重。
  const dispatchScanMs = Number(process.env.AIDCP_PUBLISH_DISPATCH_SCAN_MS ?? 60_000);
  if (dispatchScanMs > 0) {
    const scanTimer = setInterval(() => {
      publishDispatcher.scanAndDispatchApproved().catch(() => {});
    }, dispatchScanMs);
    scanTimer.unref?.();
  }

  // ── 评论循环内人审端口（env 闸：默认 dormant，绝不裸发）─────────────────
  // 同形复用 AC-PUB 接收端（parseApprovalActionValue + writeApprovalSignal）+ 读侧 isPublishApproved，
  // 用评论专属 requestId（comment-<noteId>-<ts>），零改 AC-PUB 共享代码。
  // 90s 超时 < idle 看门狗 idleNudgeMs(130s)，故审批等待期不会触发 idle nudge，无需显式暂停态。
  const commentApprovalEnabled = process.env.AIDCP_COMMENT_APPROVAL === 'true';
  const commentApproval: CommentApprovalPort = {
    request: async ({ requestId, noteId, text, title, authorName, accountId, accountName }) => {
      const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
      if (!chatId) {
        console.error('[comment] 无可用飞书群，评论审批卡未发出（将超时跳过、不发）');
        return;
      }
      const displayName = accountName?.trim() || (accountId ? accountDisplayName(accountId) : undefined);
      await messenger.sendApprovalCard(chatId, buildCommentApprovalCard({ requestId, noteId, text, title, authorName, accountId, accountName: displayName }));
    },
    isApproved: isPublishApproved,
    timeoutMs: 90_000,
    pollMs: 2_000,
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
      const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
      if (chatId) {
        await messenger.sendText(
          chatId,
          `⚠️ 边缘节点握手被拒（配置错误）：edge=\`${session.edgeId ?? '-'}\`${session.machineLabel ? `（${session.machineLabel}）` : ''} 未声明 accountId。\n请为该节点启动器显式设置 AIDCP_ACCOUNT_ID（默认账号写 default）。`,
        );
      }
    } catch (err) {
      console.error('[aidcp-cloud] 配置错误飞书告警发送失败:', (err as Error).message);
    }
  };

  // 同账号并行（N:1）互动去重 guard 注册表（按账号单例）：同账号 N 连接共用一个 guard，
  // 下发互动前占坑去重，防两节点对同一笔记/作者重复点赞/关注/评论（D7②）。
  const interactionGuardRegistry = new InteractionGuardRegistry();

  // 动作冷却闸（engagement-restraint）：单例共享（内部按 accountId 分桶）——同账号 N 连接共用同一冷却时间线，
  // 不同账号互不影响。附加只读节奏闸，不写风控终态；判定全在云端、内存态、不经协议、无迁移。
  // 重启冷启动静默期（change account-nurture-discipline-spine §4.1）：冷却为内存态、重启即清零，
  // 不设静默期则重启瞬间每账号每类互动可 burst。默认 3min，AIDCP_RESTART_QUIET_MS 可调（0=关）。
  const restartQuietMs = Number(process.env.AIDCP_RESTART_QUIET_MS ?? 180_000);
  const actionCooldownGate = new ActionCooldownGate({
    startedAtMs: Date.now(),
    restartQuietMs: Number.isFinite(restartQuietMs) && restartQuietMs >= 0 ? restartQuietMs : 180_000,
  });

  // 每个连接握手时由 buildDispatcher 造一束 RoleDispatcher：私有总线 / 该连接真实账号 controller / 定向下发。
  // 人设以取值口注入（account-persona-config）：派发时按当前账号热加载，PUT 后无需重启。
  // opts.getSoul 仅供预览实例注入示例人设（见 previewDispatcher）；运行时连接一律用严格 getSoul。
  const buildDispatcher = (ctx: DispatcherBuildContext, opts?: { getSoul?: (accountId?: string) => Soul }): RoleDispatcher => {
    // 通知联系人名册（notification-contact-registry）：订阅该连接私有总线的 notification.items.arrived
    // （评论/@/点赞/收藏/关注发送者），按该连接真实账号追加进事件流水。每连接握手 buildDispatcher 调一次 →
    // 一连接订阅一次（避免 setup/restart 重复订阅重复记录）。记录失败只吞 + 准确日志：绝不冒充飞书失败、
    // 绝不阻塞巡视；append 幂等，下轮安全重试。预览 dispatcher 无边缘会话 → 永不触发（不在默认账号空记）。
    if (notificationContactStore) {
      ctx.bus.on('notification.items.arrived', (p) => {
        const items = p?.items ?? [];
        if (!items.length) return;
        notificationContactStore!.appendEvents(ctx.accountId, items).catch((err) =>
          console.warn(
            `[notification-contacts] 记录失败 account=${ctx.accountId}（巡视照常，下轮幂等重试）:`,
            (err as Error).message,
          ),
        );
      });
    }
    return new RoleDispatcher({
      getSoul: opts?.getSoul ?? getSoul,
      llm,
      // 私有事件通道（连接间互不串味）；其上事件经 tee 汇入全局观测总线供风控记账 / 看板消费。
      eventBus: ctx.bus,
      // 该连接账号平台（facebook-scheduled-comment 2.8）：喂 session-start 平台闸，拦下无 browse 能力平台起 xhs 浏览循环。
      accountPlatform: ctx.platform,
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
      // 浏览前风控闸：view 配额耗尽时不再打开下一篇笔记，按窗口释放时间休眠后重驱。
      explainView: () => ctx.controller.explain('view'),
      // 评论人审端口（env 闸开启时注入；未开启 → 评论一律诚实跳过、不发）。
      ...(commentApprovalEnabled ? { commentApproval } : {}),
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
                          if (result.outcome === 'commented') await (await resolveController(args.accountId)).record('comment');
                        },
                      },
                    );
                    return { ...receipt, recordCommentOnTrigger: false };
                  },
                },
                {
                  canComment: async (a) => (await resolveController(a)).canDo('comment'),
                  recordComment: async (a) => (await resolveController(a)).record('comment'),
                  countAttemptsToday: (a) => contentScheduleStore.countContactAttemptsToday(a),
                  getDailyCap: async (a) => contentScheduleStore.effectiveScheduleFor(a).contactCommentDailyCap,
                  recordAttempt: (a, source, snap) =>
                    contentScheduleStore.recordContactCommentAttempt(a, { source, ...(snap ?? {}) }),
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
        const chatId = await resolveChatIdForAccount(ctx.accountId, {
          accountStore,
          groupRouteStore,
          botChatStore,
          fallbackChatId: process.env.FEISHU_CHAT_ID,
          logger: console,
        });
        if (!chatId) {
          console.error(`[notification] 无可用飞书群，评论/@ 通知未发出 account=${ctx.accountId}`);
          return;
        }
        const lines = items.map(
          (it) =>
            `• ${it.fromUser || '某用户'}（${it.kind === 'mention' ? '@你' : '评论'}）：${it.content}` +
            (it.noteTitle ? ` · 《${it.noteTitle}》` : ''),
        );
        await messenger.sendText(chatId, `📬 小红书新消息（${items.length}）\n${lines.join('\n')}`);
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
      isPersonaBound: (accountId) => personaStore.getForAccount(accountId) !== null,
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
      // 续场护栏 + 看门狗阈值提供者（全局单例，change restore-auto-resume-and-global-safety-config）：读全局配置、对所有账号生效，热加载。
      // 注入即开启自动续场（生产）；缺行回落写死默认（rest 10% / 全天窗口 / 不限 / 看门狗轻推~2min·放弃 1h）。
      resumeConfigProvider: resumeConfigStore,
      // 登录账号真实昵称采集（change account-real-nickname）：同步读（进程内缓存，握手算「需采集」）+ 单写持久化。
      // xhs 仍经 dispatcher/profile.detail 路径采集；Facebook 可在通过平台校验后由 hello 的 verified nickname 补充。
      getNickname: (accountId) => accountStore?.getNickname?.(accountId) ?? null,
      setNickname: (accountId, nickname) => accountStore?.setNickname?.(accountId, nickname),
    });
  };

  runtimes = new ConnectionRuntimeRegistry({
    observerBus: eventBus,
    getController: (accountId) => riskRegistry.getController(accountId),
    buildDispatcher,
    ensureAccount: async (accountId, platform) => {
      try {
        await accountStore?.ensureAccount?.(accountId, platform);
      } catch (err) {
        console.warn(`[aidcp-cloud] ensureAccount(${accountId}) 失败（不阻塞握手）:`, (err as Error).message);
      }
    },
    getAccountPlatform: async (accountId) => accountStore?.getPlatform?.(accountId) ?? 'xiaohongshu',
    getNickname: (accountId) => accountStore?.getNickname?.(accountId) ?? null,
    setNickname: (accountId, nickname) => accountStore?.setNickname?.(accountId, nickname),
    onConfigError,
    closeEdge: (sessionId) => server.closeEdge(sessionId),
    logger: console,
  });
  console.log('[aidcp-cloud] 连接运行时注册表就绪（按连接多租户编排，握手建运行时、断连拆除）');

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
      controller: new RiskController({ accountId: '__preview__' }),
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

  // ── 封面形态链路装配（change textcard-cover-form）：双旗标默认关，全关=与现版逐字一致 ──
  // 感知旗标 AIDCP_COVER_FORM_SENSING 只门控视觉调用；渲染旗标 AIDCP_PUBLISH_TEXTCARD_COVER 只门控决策+渲染。
  // 感知开+渲染关 = 影子模式（注解与审计照落、封面照走生成式），面板核准确率后再放行渲染。
  const coverFormVision = new OpenAiCompatVisionClient({
    // v1 模型解析两层收敛（design D5 评审修正）：env → 代码默认；绝不进按角色文本解析/全局文本模型回落层。
    getModel: resolveCoverFormModel,
    getProvider: resolveCoverFormProvider,
    providerRuntime,
    onCall: (info) => {
      console.log(
        `[llm] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} ms=${info.ms} ok=${info.ok} tokens=${info.totalTokens ?? 0}`,
      );
      try {
        tokenUsageStore.add(info);
      } catch {
        /* metrics never breaks llm */
      }
    },
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
    ossAvailable: () => !!ossUploader,
  }));
  publishOrchestrator.registerRole(new ImageSetPlannerRole({ llmClient: roleLlm('publish:ImageSetPlanner') }));
  publishOrchestrator.registerRole(new ImagePromptComposerRole({ llmClient: roleLlm('publish:ImagePromptComposer') }));
  publishOrchestrator.registerRole(new ImageGeneratorRole({
    imageProvider,
    getProvider: () => modelConfigStore.getCached().imageProvider,
    getModel: () => modelConfigStore.getCached().imageModel,
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
        return publishLogStore.insert({
          title: record.title,
          content: record.content,
          // 真血缘：用 executor 计算的真概念/真点赞 id（无则空数组），不再用 tags / [] 充数（修 stage-4 适配器漏接）。
          sourceConcepts: record.sourceConcepts ?? [],
          sourceLikedIds: record.sourceLikedIds ?? [],
          // decouple-publish-generation-from-dispatch：生成候审段落 'pending_approval'（待人审、未下发）。
          status: record.status as 'draft' | 'pending_approval' | 'published' | 'failed' | 'needs_review',
          // 审计用 image_url（封面=首张）+ 多图全集 images（下发段读回逐张上传）；真实附着数插入时 0，上传成功后由 markImagesAttached 置真实 K。
          imageUrl: record.imageUrl,
          imageUrls: record.images,
          // 真实发布账号（change publish-history-account-and-detail）：来自触发上下文，缺省 'default'。
          accountId: record.accountId,
          // 参照洗稿来稿快照；普通发布为空，内容页据此展示来源。
          sourceReference: record.sourceReference ?? null,
        });
      },
      async updateStatus(id, status) {
        await publishLogStore.updateStatus(id, status as 'draft' | 'pending_approval' | 'published' | 'failed' | 'needs_review');
      },
      // stage-4 元数据落库 + 防篡改审计（供下发段重建发布输入 + 审计）。
      async recordMetadata(id, metadata, aiEnforced) {
        await publishLogStore.recordMetadata(id, metadata, aiEnforced);
      },
      // 配图收口：如实标记真实附着张数 K（生成段无图诚实 failed 时传 0），杜绝纯文字帖留「有图」假信号。
      async markImagesAttached(id, count) {
        await publishLogStore.markImagesAttached(id, count);
      },
    },
    messenger,
    botChatStore,
    getAccountName: accountDisplayName,
    writeApprovalSignal: (requestId, approved, payload) =>
      writeApprovalSignal({ writeFile, readFile }, requestId, approved, payload),
    triggerApprovedDispatch: triggerPublishDispatchOnApprove,
    // 陪伴界面（edge-companion-ui 8.1）：候审即推 pending（发布卡自动展开到「等你确认」）。
    notifyPublishPending: (accountId, recordId, title) =>
      uiSnapshotService.pushPublishState(accountId, recordId, 'pending', title),
    // decouple-publish-generation-from-dispatch：executor 只落库待审 + 发审批卡，不再内联等审/下发，
    // 故不再注入 sequencer / isApproved / approvalWaitMs / pusher。超时只覆盖落库+发卡（默认 30s）。
    roleTimeoutMs: Number(process.env.AIDCP_PUBLISH_ROLE_TIMEOUT_MS ?? 30_000),
  }));
  console.log(`[aidcp-cloud] PublishOrchestrator 已就绪，角色: ${publishOrchestrator.getRoles().join(', ')}`);

  // 按需评论触发器（change comment-search-command）：飞书 /comment 即用。装配角色①搜索词生成 + 角色②强相关甄选
  // + 边端步骤（搜索原生筛选/开笔记翻评论/发布/去重）+ 撰写人审 → 有界换词重试；接管边端跑、finally 恢复浏览，
  // 结果异步补结果卡片（level 按结果、绝不染绿）。纯增量、不依赖概念池；边端离线/任一步失败 honest-fail。
  commentScheduler = new CommentScheduler({
    resolveConnection: (accountId) => runtimes?.runtimeForAccount(accountId) ?? null,
    pusher: { pushToEdges: (env, edgeId) => (edgeServer ? edgeServer.pushToEdges(env as Envelope, edgeId) : 0) },
    edgeTaskLeases,
    getSoul,
    // persona-driven-content-pipeline：/comment 触发前人设闸——未绑人设不接管边端、不启动评论任务（与浏览/发布同口径）。
    isPersonaBound: (accountId) => personaStore.getForAccount(accountId) !== null,
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
    autoApproveNotify: async ({ requestId, noteId, text, title, authorName, accountId, accountName, contactIncluded }) => {
      const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
      if (!chatId) {
        throw new Error('auto_approve_chat_not_configured');
      }
      const displayName = accountName?.trim() || (accountId ? accountDisplayName(accountId) : undefined);
      const target = title?.trim() || authorName?.trim() || '目标内容';
      const preview = text.replace(/\s+/g, ' ').trim().slice(0, 160) || '（空）';
      await messenger.sendCard(
        chatId,
        buildCommandResultCard({
          command: contactIncluded ? '排期联系评论（免审）' : '排期评论（免审）',
          ok: true,
          level: 'success',
          title: contactIncluded ? '排期联系评论已免审提交' : '排期评论已免审提交',
          message:
            `后台排期已开启免审，评论终稿已生成并进入发布步骤；下发前仍会核对页面、去重和边端结果。\n` +
            `**目标**：${target}\n**正文预览**：${preview}`,
          accountId,
          accountName: displayName,
        }),
      );
      console.log(`[comment] 免审通知已发 account=${accountId ?? '-'} requestId=${requestId} note=${noteId}`);
    },
    onTakeoverStart: onCommentTakeoverStart,
    onTakeoverEnd: onCommentTakeoverEnd,
    // ── facebook-scheduled-comment 2.2/2.3：FB 定向评论执行（影子先行；kill switch 默认关；真发边端能力待接入） ──
    facebookConfigFor: (accountId) => facebookCommentConfigStore.effectiveConfigFor(accountId),
    facebookAutoEnabled: () => readEnvString('AIDCP_FB_COMMENT_AUTO') === 'true',
    facebookShadow: () => readEnvString('AIDCP_FB_COMMENT_SHADOW') === 'true',
    // 人审全量闸（change facebook-comment-review-and-targeted-join）：默认开（!== 'false'）→ 不带联系方式的 FB 评论也走飞书人审；
    // 只有显式 AIDCP_FB_COMMENT_REVIEW_ALL=false 才恢复「校验后直发」旧行为。注意与 auto 的 ==='true' 语义相反（这项默认开）。
    facebookCommentReviewAll: () => readEnvString('AIDCP_FB_COMMENT_REVIEW_ALL') !== 'false',
    facebookCompose: async (accountId, { keyword, postText, comments }) => {
      // 读了再写（change facebook-comment-read-before-write）：撰写器吃到帖子正文（图片帖常空）+ 顶部他人评论，
      // 顺着讨论、用**内容语言**写（图片群里内容多是当地语言，而本号 FB 界面可能是中文——绝不跟界面语言）。
      // 无人值守（不走人审），一次 LLM 调用产草稿，交给确定性校验器把关。
      try {
        const s = getSoul(accountId);
        const others = (comments ?? []).slice(0, 6).map((c, i) => `${i + 1}. ${c}`).join('\n');
        const hasBody = Boolean(postText && postText.trim());
        const contextLines = [
          hasBody ? `【帖子正文】\n${postText!.trim()}` : `【帖子正文】（这是一条图片/无文字正文的帖子）`,
          others ? `【其他人的评论】\n${others}` : `【其他人的评论】（暂无可读评论）`,
        ].join('\n\n');
        const prompt =
          `你在 Facebook 上以「${s.identity.name}」（${s.identity.role}）的身份，在下面这条帖子下写一条自然、真诚的评论。\n\n` +
          `${contextLines}\n\n` +
          `要求：\n` +
          `- **用与上面帖子正文/他人评论相同的语言写**（当地语言；除非原文本来就是中文，否则绝不要用中文）；\n` +
          `- 顺着帖子和评论区的话茬自然回应，像真人随手留言，一两句即可；\n` +
          `- 与话题「${keyword}」相关，但不要生硬堆砌关键词；\n` +
          `- 不要外链、不要 @、不要联系方式（微信/电话/邮箱）、不要营销话术、不要话题标签；\n` +
          `- 只输出评论正文。`;
        const text = await llm.complete(prompt, { accountId, role: 'facebook_comment_composer' } as never);
        const clean = String(text ?? '').trim();
        return clean || null;
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
    facebookResolveContainerName: (accountId, url, name) => facebookCommentConfigStore.resolveContainerName(accountId, url, name),
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
    postResultCard: async (accountId, receipt, source) => {
      const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
      if (!chatId) {
        console.warn('[comment] 无可用飞书群，结果卡片未发出');
        return;
      }
      await messenger.sendCard(
        chatId,
        buildCommandResultCard({
          // 触发来源可辨识（change comment-keep-open-through-approval）：自动排期评论 vs 人工 /comment。
          command: source ?? '/comment',
          ok: receipt.ok,
          level: receipt.level,
          title: receipt.title,
          message: receipt.message,
          accountId,
          accountName: accountDisplayName(accountId),
        }),
      );
    },
    logger: console,
  });

  const facebookGroupJoinAutoEnabled = (): boolean => readEnvString('AIDCP_FB_GROUP_JOIN_AUTO') === 'true';
  const facebookGroupJoinShadow = (): boolean => readEnvString('AIDCP_FB_GROUP_JOIN_SHADOW') === 'true';
  const facebookGroupJoinScheduler = new FacebookGroupJoinScheduler({
    resolveConnection: (accountId) => runtimes?.runtimeForAccount(accountId) ?? null,
    pusher: { pushToEdges: (env, edgeId) => (edgeServer ? edgeServer.pushToEdges(env as Envelope, edgeId) : 0) },
    edgeTaskLeases,
    targets: facebookGroupTargetStore,
    memberships: facebookGroupMembershipStore,
    audit: facebookGroupJoinAuditStore,
    llmFor: (accountId) => ({ complete: (prompt, opts) => llm.complete(prompt, { ...opts, accountId }) }),
    canJoin: async (accountId) => (await resolveController(accountId)).canDo('join_group'),
    canUseSessionJoin: (accountId, edgeId) =>
      (runtimes?.remainingSessionBudgetForAccount(accountId, 'join_group', edgeId) ?? 0) > 0,
    recordSessionJoin: (accountId, edgeId) =>
      runtimes?.consumeSessionBudgetForAccount(accountId, 'join_group', edgeId) ?? false,
    isFacebookAccount: async (accountId) => (await accountStore?.getPlatform?.(accountId)) === 'facebook',
    pauseAccount: async (accountId, reason) => {
      await accountState.pause(accountId);
      console.warn(`[fb-group-join] account paused account=${accountId} reason=${reason}`);
    },
    autoEnabled: facebookGroupJoinAutoEnabled,
    shadow: facebookGroupJoinShadow,
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
    publishScheduler = new PublishScheduler({
      conceptStore,
      likedStore: likedNoteStore,
      publishLog: publishLogStore,
      resolveRisk: resolveController,
      resolveSingleAccountId,
      // persona-driven-content-pipeline：发布前人设闸——未绑人设的账号拒绝发布，绝不以打包默认人设生成（与浏览侧 canStartSession 同口径）。
      isPersonaBound: (accountId) => personaStore.getForAccount(accountId) !== null,
      // 生成段账号归账（change parallel-rewrite-drafts）：账号随 TriggerInput.accountId 上黑板，
      // 每个角色的 LLM 调用显式取之记账——无进程级槽、无括起复位，并发生成各轮各归各账。
      orchestrator: publishOrchestrator,
      // 精选灵感语料（change curated-inspiration-corpus）：发帖创作正向素材来源；缺失则回落旧点赞素材路径。
      curatedStore: curatedContentStore,
      selectTopK: resolveCuratedGateConfig().selectTopK,
      // 人设取值口（change account-persona-config）：构建发布输入时按当前账号热加载。
      getSoul,
      conceptThreshold: Number(process.env.AIDCP_PUBLISH_CONCEPT_THRESHOLD ?? 20),
      minHoursBetween: Number(process.env.AIDCP_PUBLISH_MIN_HOURS ?? 24),
      // 并发准入（change parallel-rewrite-drafts）：账号在途帽（claim + DB 待审之和，覆盖全部触发入口）
      // + 全局并发生成帽（保护 LLM/生图供应商；上线先压 AIDCP_PUBLISH_IMAGE_CONCURRENCY 观察成功率）。
      countPendingForAccount: (accountId) => publishLogStore.countPendingForAccount(accountId),
      pendingCapPerAccount: Number(process.env.AIDCP_PUBLISH_PENDING_CAP_PER_ACCOUNT ?? 3),
      maxConcurrentRuns: Number(process.env.AIDCP_PUBLISH_MAX_CONCURRENT_RUNS ?? 2),
      logger: console,
    });
    console.log('[aidcp-cloud] PublishScheduler 已就绪（手动 /publish 即用；洗稿并行=参照稿粒度）');

    // ── 内容排期调度器（change content-schedule-auto-publish，Phase 1 只发帖）────────────────
    // 每分钟心跳、按账号扇出、分钟错峰；到点只产草稿→飞书人审→approved 才发（AC-PUB 不动）。
    // 与旧 AIDCP_PUBLISH_AUTO 单账号扳机**无条件互斥**：内容排期开则旧扳机确定性不启（防错时双触发→同日双草稿超发），不留 fallback。
    const contentScheduleAutoOn = readEnvString('AIDCP_CONTENT_SCHEDULE_AUTO') === 'true';
    if (contentScheduleAutoOn) {
      const contentScheduler = new ContentScheduler({
        onlineAccounts: () => runtimes?.onlineAccountIds() ?? [],
        scheduleFor: (accountId) => contentScheduleStore.effectiveScheduleFor(accountId),
        riskStatus: async (accountId) => (await resolveController(accountId)).getState().status,
        postedTodayCount: (accountId) => publishLogStore.countPublishedTodayForAccount(accountId),
        // 日上限口径（change parallel-rewrite-drafts）：自主在途按真实条数计（防两张自动草稿都获批超发）；
        // 洗稿候选（source_reference 非空）不占排期日上限——由账号在途帽独立兜量，不堵 cap=1 账号的排期。
        pendingAutonomousCount: (accountId) => publishLogStore.countPendingAutonomousForAccount(accountId),
        // 忙判定收窄为账号粒度自主单飞：洗稿在途不让排期槽（全局帽在 claim 层另行兜底）。
        isPublishBusy: (accountId) => publishScheduler?.isBusy(accountId) ?? false,
        // 自动 ⊆ 活跃（用户拍板：浏览休眠格绝不自动发内容）：读浏览周历掩码，沿其 fail-open（未配=全天活跃=不限）。
        browseActiveAt: (now) => isWeekActiveAt(sessionConfigStore.weekActiveMask(), now),
        // fire-and-forget：调度器只发起；结果（成功/诚实空槽/失败）在此异步补一张飞书卡，绝不静默假成功。
        triggerPost: async (accountId, approvalMode) => {
          let ok = false;
          let level: 'success' | 'warning' | 'error' = 'error';
          let title = '排期发帖失败';
          let message = 'unknown';
          try {
            const o = await publishScheduler!.triggerScheduled(accountId, approvalMode);
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
          const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
          if (!chatId) {
            console.warn(`[content-scheduler] 无可用飞书群，排期结果卡未发出 account=${accountId} title=${title}`);
            return;
          }
          await messenger
            .sendCard(
              chatId,
              buildCommandResultCard({
                command: '排期发帖（自动）',
                ok,
                level,
                title,
                message,
                accountId,
                accountName: accountDisplayName(accountId),
              }),
            )
            .catch((e) => console.warn('[content-scheduler] 排期结果卡发送失败：', (e as Error).message));
        },
        // 评论动作三件套（change content-schedule-comments）：commentScheduler 未建（PG 缺）则不注入 → 调度器整体跳过评论动作。
        ...(commentScheduler
          ? {
              // 触发排期评论：自动路径 MUST 过 canDo('comment') 配额闸（手动 /comment 跳配额、人是刹车；自动无人在场）。
              // 触发回执非 ok（配额拒 / 离线 / 未绑人设 / 在跑）回黄卡如实说明；任务终态结果卡由评论链自补（postResultCard），此处绝不重复发。
              triggerComment: async (accountId: string, approvalMode) => {
                const sendReceiptCard = async (level: 'warning' | 'error', title: string, message: string) => {
                  const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
                  if (!chatId) {
                    console.warn(`[content-scheduler] 无可用飞书群，排期评论回执卡未发出 account=${accountId} title=${title}`);
                    return;
                  }
                  await messenger
                    .sendCard(
                      chatId,
                      buildCommandResultCard({
                        command: '排期评论（自动）',
                        ok: false,
                        level,
                        title,
                        message,
                        accountId,
                        accountName: accountDisplayName(accountId),
                      }),
                    )
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
                    // 触发未成（离线 / 未绑人设 / 已在跑等）：如实回执；终态卡不存在（任务没开跑）。
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
                  const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
                  if (!chatId) {
                    console.warn(`[content-scheduler] 无可用飞书群，排期联系评论回执卡未发出 account=${accountId} title=${title}`);
                    return;
                  }
                  await messenger
                    .sendCard(
                      chatId,
                      buildCommandResultCard({
                        command: '排期联系评论（自动）',
                        ok: false,
                        level,
                        title,
                        message,
                        accountId,
                        accountName: accountDisplayName(accountId),
                      }),
                    )
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
                    // 触发未成（缺联系方式 fail-closed / 离线 / 未绑人设 / 在跑）：透传回执如实回卡；不占尝试额度。
                    await sendReceiptCard(receipt.level === 'error' ? 'error' : 'warning', `排期联系评论：${receipt.title}`, receipt.message);
                    return;
                  }
                  // 任务真开跑 → 记一条持久 attempt（尝试型日上限；重启不清零、绝不超发）。终态结果卡评论链自补。
                  await contentScheduleStore.recordContactCommentAttempt(accountId).catch((e) =>
                    console.warn('[content-scheduler] 联系评论 attempt 记录失败（上限将偏松，需关注）：', (e as Error).message),
                  );
                } catch (e) {
                  await sendReceiptCard('error', '排期联系评论：触发异常', (e as Error).message);
                }
              },
              contactAttemptsTodayCount: (accountId: string) => contentScheduleStore.countContactAttemptsToday(accountId),
            }
          : {}),
        triggerJoin: (accountId: string) => facebookGroupJoinScheduler.triggerScheduled(accountId),
        isJoinBusy: (accountId: string) => facebookGroupJoinScheduler.isRunning(accountId),
        joinedTodayCount: (accountId: string) => facebookGroupMembershipStore.countJoinedToday(accountId),
        joinDailyCap: async (accountId: string) => {
          if (!facebookGroupJoinAutoEnabled() && !facebookGroupJoinShadow()) return 0;
          return (await resolveController(accountId)).effectiveQuotas().day.join_group;
        },
        logger: console,
      });
      contentScheduler.start(60_000);
      console.log('[aidcp-cloud] ContentScheduler 已启动（每分钟心跳、按账号错峰；旧 AIDCP_PUBLISH_AUTO 扳机已被互斥关闭）');
      if (readEnvString('AIDCP_PUBLISH_AUTO') === 'true') {
        console.warn('[aidcp-cloud] ⚠️ AIDCP_PUBLISH_AUTO=true 被忽略：内容排期调度器已接管自动发帖（互斥，防错时双触发）');
      }
    } else if (readEnvString('AIDCP_PUBLISH_AUTO') === 'true') {
      // 旧单账号自动扳机（内容排期未开时保持原行为，零回归）。
      const everyMin = Number(process.env.AIDCP_PUBLISH_AUTO_INTERVAL_MIN ?? 30);
      setInterval(() => {
        publishScheduler!.checkAndMaybeTrigger().then(
          (o) => o.result !== 'skipped' && console.log(`[aidcp-cloud] PublishScheduler auto: ${o.result} (${o.reason})`),
          (err) => console.warn('[aidcp-cloud] PublishScheduler auto error:', err),
        );
      }, everyMin * 60_000);
      console.log(`[aidcp-cloud] PublishScheduler 自动扳机已开启（每 ${everyMin} 分钟）`);
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
        publishScheduler!.triggerManual(mockAccount).catch((e) => console.warn('[aidcp-cloud] MOCK triggerManual err:', e));
      }, 3000);
      console.log('[aidcp-cloud] MOCK publish 触发已开启（touch /tmp/aidcp-mock-publish-trigger 触发一次；文件内容可写目标账号 id）');
    }
  } else {
    console.warn('[aidcp-cloud] PublishScheduler 未建（ConceptStore/LikedNoteStore 不可用），发帖触发不可用');
  }
  // 旧 TODO(temp) /debug/publish 调试口已删除（A 阶段4）：发帖只经 PublishScheduler 三扳机 + 发布前人审。
  const feishuReceiver = new FeishuWsReceiver({
    commandRouter,
    messenger,
    // 通过即切：飞书「授权发布」首写成功即触发下发段（仅 publish-<n>）。
    onApproved: triggerPublishDispatchOnApprove,
    // 陪伴界面：取消首写成功 → rejected 推给在线边缘（仅 publish-<n>）。
    onRejected: notifyPublishRejected,
    // 写时版本预检（edit-note-draft-before-publish）：飞书卡片授权前比对活版本与卡片烤入版本；
    // 不一致 → 不写签名、回「请到控制台重新审批」替换卡（云端无法主动刷新已发出的老卡片）。
    readLiveContentVersion,
    preflightApprovePublish: (requestId) => preflightApprovePublish(requestId),
  });
  if (isFeishuWsEnabled()) {
    try {
      const wsClient = new lark.WSClient({
        appId: process.env.FEISHU_APP_ID ?? '',
        appSecret: process.env.FEISHU_APP_SECRET ?? '',
        onReady: () => console.log('[aidcp-cloud] 飞书长连接已建立（WSClient onReady）'),
        onError: (err) => console.error('[aidcp-cloud] 飞书长连接错误:', err.message),
        onReconnecting: () => console.warn('[aidcp-cloud] 飞书长连接重连中…'),
        onReconnected: () => console.log('[aidcp-cloud] 飞书长连接已重连'),
      });
      await wsClient.start({
        eventDispatcher: buildFeishuEventDispatcher(feishuReceiver, botChatEventHandler, console),
      });
      console.log('[aidcp-cloud] 飞书事件接收已启动（WSClient 长连接）');
    } catch (err) {
      console.warn('[aidcp-cloud] 飞书长连接启动失败（事件接收不可用）:', (err as Error).message);
    }
  } else {
    console.warn('[aidcp-cloud] 飞书长连接已禁用（AIDCP_FEISHU_WS_ENABLED=false）；当前进程不接收飞书事件');
  }

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
    probeModel,
  });
  // 分类默认模型面板外观（change role-model-category-config + model-config-volcengine-provider）：白名单 + 生效值视图（含 provider）+ 写校验 + 按 provider 探活。
  const categoryConfigPanel = createCategoryConfigPanel({
    store: categoryConfigStore,
    getGlobalTextModel: () => modelConfigStore.getCached().textModel,
    getGlobalTextProvider: () => modelConfigStore.getCached().textProvider,
    probeModel,
  });
  // 安全限额面板外观（change safety-quota-config）：三档×动作×三窗口生效值 + 写校验（非法整块拒）+ 非乐观回真态。
  const quotaConfigPanel = createQuotaConfigPanel({ store: quotaConfigStore });
  // 操作兜底 floor 面板外观（change pacing-floor-config-min-interval）：四类操作生效兜底区间 + 写校验（展宽/CAP，非法整块拒）+ 非乐观回真态。
  const pacingConfigPanel = createPacingConfigPanel({ store: pacingConfigStore });
  // 单场上限面板外观（全局单例，change restore-auto-resume-and-global-safety-config）：全局时长 + 七项预算回显 + 写校验（非法整块拒）+ 非乐观回真态。
  const sessionLimitPanel = createSessionLimitPanel({ store: sessionConfigStore });
  // 引流线索热度过滤阈值面板外观（全局单例，change feed-hot-lead-group-comment）：三阈值回显 + 写校验（非法整块拒）+ 热加载。
  const hotLeadConfigPanel = createHotLeadConfigPanel({ store: hotLeadConfigStore });
  // 续场配置面板外观（全局单例，change restore-auto-resume-and-global-safety-config）：全局续场护栏 + 看门狗阈值回显 + 写校验 + 非乐观回真态。
  const resumeConfigPanel = createResumeConfigPanel({ store: resumeConfigStore });
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
          revocation: new TokenRevocationStore(),
          riskRegistry,
          publishLogStore,
          conceptStore,
          botChatStore,
          eventBus,
          edgeServer: server,
          panelStore: new PgPanelStore({
            host: readEnvString('PGHOST'),
            port: readEnvPort('PGPORT'),
            database: readEnvString('PGDATABASE'),
            user: readEnvString('PGUSER'),
            password: readEnvString('PGPASSWORD'),
          }),
          publishOrchestrator,
          preflightApprovePublish: (requestId) => preflightApprovePublish(requestId),
          writeApprovalSignal: async (requestId, approved, payload) => {
            const result = await writeApprovalSignal({ writeFile, readFile }, requestId, approved, payload);
            // 通过即切：后台「授权发布」首写成功即触发下发段（仅 publish-<n>）。取消不触发下发，
            // 但要通知陪伴界面 rejected（发布卡收起为「暂不发布」）。
            // already-decided 的重复「授权」也走人工批准入口（change parallel-rewrite-drafts）：
            // 熔断中即确认清除恢复 drain；非熔断时由 dispatch 幂等闸（inFlight/status/信号）自然吸收。
            if (approved && (result.written || result.alreadyDecided === true)) triggerPublishDispatchOnApprove(requestId);
            else if (!approved && result.written) notifyPublishRejected(requestId);
            return result;
          },
          // 待审正文草稿就地编辑 + 活版本读回 + 授权在途探测（edit-note-draft-before-publish）。经拥有者对象单写，绝不 raw UPDATE。
          publishDraft: {
            edit: (recordId, expectedVersion, patch, editor) =>
              publishLogStore.editDraft(recordId, expectedVersion, patch, editor),
            liveVersion: readLiveContentVersion,
            hasDecision: async (recordId) => (await readPublishApproval(`publish-${recordId}`)) !== null,
          },
          commandActions: {
            pause: async (accountId) => {
              await accountState.pause(accountId);
              return { accountId, status: 'paused' as const };
            },
            resume: async (accountId) => {
              await accountState.resume(accountId);
              const resumedEdges = server.resumeEdgesForAccount(accountId);
              return { accountId, status: 'active' as const, resumedEdges };
            },
            // 调度启停全局开关：切所有连接运行时的会话（start 经诚实人设闸 / stop 全停）；回报真实在线 edge 数，绝不乐观。
            // accountId 信息性（当前为全局开关）；no-op（已 active/已 stop）以 changed=false 诚实可辨。
            dispatch: async (accountId, action) => {
              const want = action === 'start';
              const changed = dispatchActive !== want;
              if (changed) {
                dispatchActive = want; // 先置标志，使 startAll 的启动闸看到 active
                if (want) runtimes?.startAll();
                else runtimes?.endAll('panel_dispatch_stop');
              }
              return {
                accountId,
                dispatch: want ? ('started' as const) : ('stopped' as const),
                changed,
                edgesOnline: server.onlineEdgeCount(),
              };
            },
            dispatchActive: () => dispatchActive,
          },
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
            listCatalog: () => contentScheduleStore.listCatalog(),
            setGlobal: (mask, updatedBy) => contentScheduleStore.setGlobal({ contentActiveMask: mask }, updatedBy),
            setAccount: (accountId, patch, updatedBy) => contentScheduleStore.setAccount(accountId, patch, updatedBy),
          },
          // 每账号 Facebook 定时评论配置：关键词 + 评论模式 / 模板；目标群来自 joined ledger。
          facebookCommentConfig: {
            get: (accountId) => facebookCommentConfigStore.getForAccount(accountId),
            set: (accountId, patch, updatedBy) =>
              facebookCommentConfigStore.setAccount(accountId, patch, updatedBy),
          },
          facebookGroupTargets: {
            importTargets: (inputs, importBatch) => facebookGroupTargetStore.importTargets(inputs, importBatch),
            listTargets: (options) => facebookGroupTargetStore.listTargets(options),
            listFacets: () => facebookGroupTargetStore.listFacets(),
            setEnabled: (groupUrl, enabled) => facebookGroupTargetStore.setEnabled(groupUrl, enabled),
            accountProgress: () => facebookGroupTargetStore.accountProgress(),
            listAssignments: (limit) => facebookGroupMembershipStore.listAssignments(limit),
            reclaimStaleAssignments: (ttlMs) => facebookGroupMembershipStore.reclaimStaleAssignments(ttlMs),
          },
          captchaAssist: captchaAssist.isAvailable() ? captchaAssist : undefined,
          // 模型与凭据配置（change console-model-provider-config + model-config-volcengine-provider）。明文密钥绝不经此回传。
          modelConfig: {
            getView: buildModelConfigView,
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
                  await probeModel(provider, modelToProbe);
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
              return { ok: true, view: await buildModelConfigView() };
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
          notificationRoutes: groupRouteStore,
          // 机器人所在群 provider（change feishu-bot-chat-name-display）：GET /api/bot-chats 实时取飞书真实群名 + 默认群标记。
          botChats: botChatsProvider,
          // 精选内容后台管理（change curated-content-admin-page）。同一精选语料 store 实例：读=按账号列表/筛选面、写=删单条/清空壳行。
          // init 失败留 undefined 时面板自然 503，绝不崩边-云闭环。
          curatedContent: curatedContentStore,
          // 精选笔记行级定向动作（change curated-note-actions）：参照洗稿创作 + 定向评论（内容/带联系方式）。
          // HTTP 只回**触发态**（生成段可达数分钟，不可同步等）；终态沿既有渠道（发布=待审草稿+人审卡+异步结果卡、
          // 评论=人审卡+定向终态结果卡）。域内拒绝回 triggered=false+机器原因码，绝不染绿。
          curatedActions: {
            createPostFromNote: async (accountId, row, options) => {
              if (!publishScheduler) return { triggered: false, reason: 'publish_unready' };
              if (personaStore.getForAccount(accountId) === null) return { triggered: false, reason: 'needs_persona' };
              if (!(row.body ?? '').trim()) return { triggered: false, reason: 'empty_body' };
              const useReferenceImages = options?.useReferenceImages ?? row.referenceImages.length > 0;
              // 并发准入（change parallel-rewrite-drafts）：预取 DB 待审数 → 同步键控 claim。全部拒绝
              //（duplicate_source / publish_capacity / publish_busy）都在 HTTP 回执同步可见、绝不落到只有飞书卡才知道；
              // 同账号跨参照稿并行放行。claim 成功即管线已发起，结果卡链挂 outcome。
              const dbPendingCount = await publishLogStore.countPendingForAccount(accountId).catch(() => 0);
              const begin = publishScheduler.tryBeginRewrite(
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
                  const accountLabel = accountName ?? accountId;
                  if (o.result !== 'triggered') {
                    receipt = { ok: false, level: 'warning', title: '参照创作未触发', message: `账号 \`${accountLabel}\`「${sourceLabel}」未触发：${o.reason}` };
                  } else if (o.status === 'failed' || o.status === 'timeout') {
                    receipt = { ok: false, level: 'error', title: '参照创作编排失败', message: `账号 \`${accountLabel}\`「${sourceLabel}」编排状态 ${o.status}${o.failureReason ? `\n原因：${o.failureReason}` : ''}` };
                  } else if (o.status === 'skipped') {
                    receipt = { ok: false, level: 'warning', title: '参照创作未产出', message: `账号 \`${accountLabel}\`「${sourceLabel}」编排状态 skipped${o.failureReason ? `（${o.failureReason}）` : ''}` };
                  }
                  if (!receipt) return;
                  const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
                  if (!chatId) return;
                  await messenger.sendCard(
                    chatId,
                    buildCommandResultCard({
                      command: '参照创作',
                      ok: receipt.ok,
                      level: receipt.level,
                      title: receipt.title,
                      message: receipt.message,
                      accountId,
                      accountName,
                    }),
                  );
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
          alertStore,
          // 对外客户管理（change edge-client-customer-auth）：内部 JWT 保护的 /api/client-users*。同一 store 实例
          // 亦供客户鉴权服务做 auth/scope 读（单实例共享池）。绝不回传 key/hash。
          clientUsers: clientUserStore,
        },
        {
          port: panelPort,
          jwtSecret: readEnvString('AIDCP_PANEL_JWT_SECRET') ?? '',
          users: parsePanelUsers(readEnvString('AIDCP_PANEL_USERS')),
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
      const clientAuth = await startClientAuthApi(
        {
          store: clientUserStore,
          revocation: new TokenRevocationStore(), // 独立撤销黑名单，绝不共用面板的
          rateLimiter: new LoginRateLimiter(),
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
