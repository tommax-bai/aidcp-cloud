/**
 * 对外客户鉴权 HTTP 服务（进程内、独立端口、**独立 JWT 密钥**）。change edge-client-customer-auth。
 *
 * 与内部面板（8090）**物理隔离**:独立 http.Server、独立路由表、独立 revocation、独立限流、
 * 身份源为 client_users 表（非 env AIDCP_PANEL_USERS）。三条不变量：
 *  - N1 密钥即边界：secret 独立且启动断言 ≠ 面板 secret（相等则拒启，见 startClientAuthApi）。
 *  - N2 结构性无泄漏：环境读只有 store.listEnvScope(userId) 这一个 scoped 方法。
 *  - N3 每请求回库复核 status：验签通过后再查 isEnabled(sub)，停用即时 401。
 *
 * 复用 panel/jwt.ts（signJwt/verifyJwt，独立 secret 即独立域）、panel/revocation.ts、panel/auth.ts:parseBearer。
 * 启动失败一律 started=false 而非抛出，绝不连累边-云闭环与面板。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { signJwt, verifyJwt } from '../panel/jwt.js';
import { parseBearer } from '../panel/auth.js';
import type { TokenRevocationStore } from '../panel/revocation.js';
import type { ClientUserStore } from './client-user-store.js';
import type { ClientOffboardView } from './client-user-store.js';
import type { LoginRateLimiter } from './rate-limiter.js';
import { DelegatedTaskServiceError, type DelegatedTaskServicePort } from '../kernel/delegated-task-types.js';
import type { DelegatedTaskIntent, JsonValue } from '../kernel/delegated-task-types.js';
import { clampClientApprovalMode } from '../kernel/delegated-task-types.js';
import type { CuratedContentReader, CuratedPanelRow, CuratedReferenceImage } from '../kernel/curated-content-types.js';
import { CuratedContentUnavailableError } from '../kernel/curated-content-types.js';
import type { ResolvedBinding } from './client-user-store.js';
import type {
  PublishApprovalActionPayload,
  PublishApprovalActionResultPayload,
  PublishDraftImageRemovePayload,
  PublishDraftImageRemoveResultPayload,
  UiDailyUsagePayload,
  UiSlowStartPayload,
} from '../comm/protocol.js';
import type { EditDraftResult, PendingPublishPreview, PublishLogStore } from '../publish-agent/publish-log-store.js';
import type {
  DraftRefinementJob,
  DraftRefinementScope,
  DraftRefinementSelection,
  DraftRefinementStore,
} from '../publish-agent/draft-refinement.js';
import type { PersonaAutoFillService } from '../agents/persona-auto-fill.js';
import type { AccountPersonaService } from '../config/account-persona-service.js';
import { isWritingLanguage } from '../soul/writing-language.js';
import { loadSoulFromYaml } from '../soul/index.js';
import type { RiskStatus } from '../risk/types.js';
import type { SetOperatorAliasResult } from '../account-store.js';
import {
  hashOffboardCleanupGrantJti,
  issueOffboardCleanupGrant,
  verifyOffboardCleanupGrant,
} from './offboard-cleanup-grant.js';
import {
  CLIENT_PUBLISH_QUEUE_TASK_STATUSES,
  projectClientPublishQueueCancelReceipt,
  type ClientPublishQueueView,
} from './client-publish-queue.js';
import type { ClientEnvironmentScheduleView } from './client-environment-schedule.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SELECTED_PERSONA_BYTES = 32 * 1024;

export interface ClientAuthDeps {
  store: ClientUserStore;
  revocation: TokenRevocationStore;
  rateLimiter: LoginRateLimiter;
  /** 当前客户自有环境的运营别名写入；账号键只由 Cloud 绑定解析得到。 */
  operatorAlias?: {
    setForAccount(accountId: string, alias: string | null): Promise<SetOperatorAliasResult>;
  };
  /** Customer-scoped delegated tasks. Every route re-checks env ownership from the DB. */
  delegatedTasks?: DelegatedTaskServicePort;
  /** Account-scoped curated reads. HTTP responses are projected through an explicit customer DTO below. */
  curatedContent?: CuratedContentReader;
  /** Account-scoped count of publish_log rows that have a persisted source_reference. */
  referenceDraftCountForAccount?: (accountId: string) => Promise<number>;
  /** Account/status-scoped pending drafts. Customer responses always pass through explicit DTO allowlists below. */
  pendingDrafts?: Pick<
    PublishLogStore,
    'listPendingPublishPreviewsForAccount' | 'pendingPublishPreviewForAccountRecord'
  >;
  /** 客户创建/读取的持久调整任务；store 自身再按 execution_target 隔离。 */
  draftRefinements?: Pick<DraftRefinementStore, 'create' | 'getForAccount' | 'latestForAccountRecord' | 'latestForAccountRecords'>;
  /** Account-scoped Xiaohongshu scheduled truth for approval-page free-slot selection. */
  publishSchedule?: Pick<PublishLogStore, 'listOccupiedScheduledTimesForAccount'>;
  /** 客户首页只读概览；账号键由持久绑定解析，DTO 不得回传 accountId。 */
  environmentOverview?: {
    viewForAccount(accountId: string): Promise<ClientEnvironmentOverview | null>;
  };
  /** 当前环境账号的客户可读生效排期；平台和账号键只在 Cloud 内部流转。 */
  environmentSchedule?: {
    platformForAccount(accountId: string): string | undefined;
    viewForAccount(accountId: string): ClientEnvironmentScheduleView | null;
  };
  /** 小红书客户发布队列；账号键只在 Cloud 内部流转，响应经最小披露 DTO 投影。 */
  publishQueue?: {
    platformForAccount(accountId: string): string | undefined;
    viewForAccount(accountId: string): Promise<ClientPublishQueueView | null>;
  };
  /** 客户待审稿写：传输层只解析客户环境，实际闸序与落库复用既有领域方法。 */
  publishDraftActions?: {
    edit(
      recordId: number,
      expectedVersion: number,
      patch: { title?: string; content?: string; topics?: string[] },
      accountId: string,
      actor: string,
    ): Promise<EditDraftResult>;
    approve(
      payload: PublishApprovalActionPayload,
      accountId: string,
      actor: string,
    ): Promise<PublishApprovalActionResultPayload>;
    removeImage(
      payload: PublishDraftImageRemovePayload,
      accountId: string,
      actor: string,
    ): Promise<PublishDraftImageRemoveResultPayload>;
  };
  /**
   * 环境→edgeId 活会话反查（change curated-envkey-account-binding，D5 活体佐证）。返回 `ads-<envKey>` 或 null。
   * **刻意用 resolveEdgeIdForAccount（幸存者）；反方向的 resolveAccountIdForEdge 已被慢启动 change 删除**——
   * 给后者新增调用方会把那次删除卡死。仅用于通用客户端发布类委托的创建时活体佐证；读路由与纯云端洗稿创建绝不用。
   */
  resolveEdgeIdForAccount?: (accountId: string) => string | null;
  interactionApi?: {
    handle(req: http.IncomingMessage, res: http.ServerResponse, userId: string): Promise<boolean>;
  };
  /** 有当前唯一账号时，从同一个 RiskController 读取实际 clamp 投影。环境配置写入由 store 单写。 */
  slowStart?: {
    viewForAccount(accountId: string): Promise<
      { slowStart: UiSlowStartPayload; dayQuotas: Record<string, number> } | null
    >;
  };
  /** 客户环境风险读/恢复：accountId 只在 Cloud 内部流转，HTTP DTO 永不暴露。 */
  environmentRisk?: {
    platformForAccount(accountId: string): string | undefined;
    viewForAccount(accountId: string): Promise<ClientEnvironmentRiskState | null>;
    recoverRestrictedForAccount(accountId: string, reason: string): Promise<ClientEnvironmentRiskRecovery | null>;
    resumeEdgesForAccount(accountId: string): number;
  };
  onOffboardCreated?: (offboard: ClientOffboardView) => Promise<void>;
  /** 客户只提交已确认人设；环境/账号/人设缺失状态均由 Cloud 自行解析。 */
  personaAutoFill?: Pick<PersonaAutoFillService, 'createRun'>;
  /** 客户按授权环境离线读取/生成/保存单账号人设；账号键与平台均只在 Cloud 内解析。 */
  persona?: Pick<AccountPersonaService, 'get' | 'generate' | 'persist'> & {
    platformForAccount(accountId: string): string | undefined;
  };
}

export interface ClientEnvironmentOverview {
  dailyUsage: UiDailyUsagePayload;
  currentPublishState: {
    state: 'pending' | 'approved' | 'submitted';
    code: string;
    title?: string;
    at: number;
  } | null;
  lastPublished: { title: string; at: number } | null;
}

export interface ClientEnvironmentRiskState {
  status: RiskStatus;
  statusSince: number;
  updatedAt: number;
}

export interface ClientEnvironmentRiskRecovery {
  accepted: boolean;
  refusal?: 'state_not_restricted';
  statusBefore: RiskStatus;
  state: ClientEnvironmentRiskState;
  changed: boolean;
}

export interface ClientAuthConfig {
  port: number;
  /** 客户令牌签名密钥（独立于面板）。 */
  jwtSecret: string;
  /** 面板密钥——仅用于启动断言 ≠（N1）；服务运行不使用它。 */
  panelJwtSecret: string;
  jwtTtlSeconds: number;
  forbiddenPorts: number[];
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type ClientAuthStartReason = 'forbidden_port' | 'missing_secret' | 'secret_collision' | 'listen_error';

export interface ClientAuthHandle {
  started: boolean;
  reason?: ClientAuthStartReason;
  detail?: string;
  port?: number;
  close(): Promise<void>;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function environmentOnlySlowStartView(
  slowStartSince: number | null,
  reason: 'binding_unknown' | 'binding_conflict',
  now = Date.now(),
): UiSlowStartPayload {
  const totalDays = 7;
  if (slowStartSince == null) {
    return { state: 'off', totalDays, eligible: false, ineligibleReason: reason };
  }
  const day = Math.max(0, Math.floor((now - slowStartSince) / 86_400_000)) + 1;
  if (day > totalDays) {
    return {
      state: 'graduated', totalDays, since: slowStartSince, eligible: false, ineligibleReason: reason,
    };
  }
  return {
    state: 'active', day, totalDays, since: slowStartSince, eligible: false, ineligibleReason: reason,
  };
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

/** 规范化单个 IP；拒绝把任意转发头文本反射进响应头。 */
function normalizeIp(value: string | undefined): string | null {
  let candidate = String(value ?? '').trim();
  if (!candidate) return null;
  if (candidate.startsWith('[')) {
    const closing = candidate.indexOf(']');
    if (closing > 0) candidate = candidate.slice(1, closing);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(':'));
  }
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const mapped = candidate.slice(7);
    if (isIP(mapped) === 4) candidate = mapped;
  }
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

/** 取客户端源 IP（受控 Nginx 注入 x-forwarded-for 首段；非法时回落 socket 地址）。 */
function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const forwarded = typeof xff === 'string' ? normalizeIp(xff.split(',')[0]) : null;
  return forwarded ?? normalizeIp(req.socket.remoteAddress) ?? 'unknown';
}

/**
 * 出口证明取受控 nginx 追加的最右段：`$proxy_add_x_forwarded_for` 会把真实连接端追加在任意客户端前缀之后。
 * 取首段会被上游代理自带/客户端伪造的 XFF 欺骗，甚至把已代理请求误报成本机原始 IP。
 */
function egressClientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const values = typeof xff === 'string' ? xff.split(',') : [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const candidate = normalizeIp(values[index]);
    if (candidate) return candidate;
  }
  return normalizeIp(req.socket.remoteAddress) ?? 'unknown';
}

const EGRESS_CORS_HEADERS: http.OutgoingHttpHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'cache-control',
  'access-control-expose-headers': 'x-aidcp-egress-ip, x-aidcp-egress-checked-at, x-aidcp-request-id',
  'cache-control': 'no-store',
};

function parseIntegerQuery(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function toClientReferenceImage(image: CuratedReferenceImage): Record<string, unknown> {
  return {
    index: image.index,
    sourceUrl: image.sourceUrl,
    ...(image.ossUrl ? { ossUrl: image.ossUrl } : {}),
    ...(typeof image.width === 'number' ? { width: image.width } : {}),
    ...(typeof image.height === 'number' ? { height: image.height } : {}),
    ...(image.alt ? { alt: image.alt } : {}),
    captureStatus: image.captureStatus,
    capturedAt: image.capturedAt,
  };
}

function isCreatableCuratedRow(row: CuratedPanelRow): boolean {
  return row.contentType === 'image_text' && Boolean(row.body?.trim());
}

/** Explicit allowlist: never serialize the store row directly into the customer token domain. */
function toClientCuratedListItem(row: CuratedPanelRow): Record<string, unknown> {
  const body = row.body?.trim() ?? '';
  return {
    id: row.id,
    contentType: row.contentType,
    title: row.title,
    bodyPreview: body.length > 180 ? `${body.slice(0, 180)}…` : body,
    author: row.author,
    sourceUrl: row.sourceUrl,
    topics: row.topics,
    likeCount: row.likeCount,
    collectCount: row.collectCount,
    commentCount: row.commentCount,
    sourcePublishedAtText: row.sourcePublishedAtText,
    sourcePublishedAt: row.sourcePublishedAt,
    sourcePublishedAtPrecision: row.sourcePublishedAtPrecision,
    sourcePublishedAtStatus: row.sourcePublishedAtStatus,
    sourcePublishedAtObservedAt: row.sourcePublishedAtObservedAt,
    botLiked: row.botLiked,
    botCollected: row.botCollected,
    referenceImages: row.referenceImages.map(toClientReferenceImage),
    creatable: isCreatableCuratedRow(row),
    updatedAt: row.updatedAt,
  };
}

function toClientCuratedDetail(row: CuratedPanelRow): Record<string, unknown> {
  return {
    ...toClientCuratedListItem(row),
    body: row.body,
    firstSeenAt: row.firstSeenAt,
    countsCapturedAt: row.countsCapturedAt,
  };
}

/** 待审稿客户投影：不回 accountId/sourceReference/provider 诊断/审批凭据。 */
function toClientPendingDraftListItem(row: PendingPublishPreview): Record<string, unknown> {
  const body = row.content.trim();
  return {
    id: row.id,
    platform: row.platform,
    kind: row.kind,
    title: row.title,
    contentPreview: body.length > 180 ? `${body.slice(0, 180)}…` : body,
    topics: row.topics,
    images: row.images,
    contentVersion: row.contentVersion,
    updatedAt: row.updatedAt,
    publishMode: row.publishMode,
    publishTime: row.publishTime,
    ...(Object.prototype.hasOwnProperty.call(row, 'sourceCuratedId') ? { sourceCuratedId: row.sourceCuratedId ?? null } : {}),
  };
}

function toClientPendingDraftDetail(row: PendingPublishPreview): Record<string, unknown> {
  return { ...toClientPendingDraftListItem(row), content: row.content };
}

function toClientRefinementJob(job: DraftRefinementJob): Record<string, unknown> {
  return {
    id: job.id,
    recordId: job.recordId,
    expectedVersion: job.expectedVersion,
    scope: job.scope,
    status: job.status,
    progress: job.progress.map((item) => ({
      seq: item.seq,
      stage: item.stage,
      status: item.status,
      summary: item.summary,
      at: item.at,
    })),
    resultVersion: job.resultVersion,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage ?? '调整没有完成，原稿未变化。' } : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function toClientRefinementSummary(job: DraftRefinementJob): Record<string, unknown> {
  const current = [...job.progress].reverse().find((item) => item.status === 'running') ?? job.progress.at(-1) ?? null;
  return {
    id: job.id,
    scope: job.scope,
    status: job.status,
    ...(current ? { current: { stage: current.stage, status: current.status, summary: current.summary } } : {}),
    resultVersion: job.resultVersion,
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage ?? '调整没有完成，原稿未变化。' } : null,
  };
}

function editFailureStatus(reason: Exclude<EditDraftResult, { ok: true }>['reason']): number {
  if (reason === 'not_found') return 404;
  if (reason === 'not_pending' || reason === 'version_conflict') return 409;
  return 422;
}

/**
 * 参考创作排队回执：同 list/detail 一样是显式白名单。
 * 绝不回 `createDraft` 的整个结果——那里的 `task.sourceConstraints` 与
 * `confirmation.constraints` 携带服务端内部诊断（参考图的 formGuess.model/provider、
 * visualAnalysis 的 provider/model/cacheKey/风格描述），正是 list/detail DTO 特意剥掉的字段。
 * 客户端只需要「排没排上队 + 哪个任务」，据此收口到最小字段。
 */
function toClientTaskReceipt(task: { id: string; status: string; version: number }): Record<string, unknown> {
  return { id: task.id, status: task.status, version: task.version };
}

/**
 * 绑定解析失败 → HTTP（change curated-envkey-account-binding）。**绝不回 200-空**：把失败谎报成「你没有数据」
 * 与谎报成成功同为不诚实。`binding_unknown`（日常态，连一次云端即自愈）与 `binding_conflict`（跨客户争用，
 * 安全事件）**码不同**，绝不合并——合成一个码就是把告警埋进日常噪声。
 */
function sendBindingFailure(res: http.ServerResponse, reason: Exclude<ResolvedBinding, { ok: true }>['reason']): void {
  const status = reason === 'environment_not_owned' ? 403
    : reason === 'binding_unavailable' ? 503
      : 409; // binding_unknown / binding_conflict
  sendJson(res, status, { error: reason });
}

/** 单一客户环境绑定解析边界：所有 env-scoped Cloud 操作复用，绝不采信客户端 accountId。 */
async function resolveOwnedBoundAccount(
  deps: ClientAuthDeps,
  res: http.ServerResponse,
  userId: string,
  envKey: string,
): Promise<{ envKey: string; accountId: string } | null> {
  const normalizedEnvKey = envKey.trim();
  if (!normalizedEnvKey || normalizedEnvKey.length > 256 || /[\u0000-\u001f\u007f]/.test(normalizedEnvKey)) {
    sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
    return null;
  }
  const bound = await deps.store.resolveBoundAccountForEnv(userId, normalizedEnvKey);
  if (!bound.ok) {
    sendBindingFailure(res, bound.reason);
    return null;
  }
  return { envKey: normalizedEnvKey, accountId: bound.accountId };
}

async function resolveOwnedFacebookRiskAccount(
  deps: ClientAuthDeps,
  res: http.ServerResponse,
  userId: string,
  envKey: string,
): Promise<string | null> {
  const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
  if (!bound) return null;
  const platform = deps.environmentRisk?.platformForAccount(bound.accountId)?.trim().toLowerCase();
  if (platform !== 'facebook') {
    sendJson(res, 409, { error: 'unsupported_platform' });
    return null;
  }
  return bound.accountId;
}

/**
 * D5 活体佐证（change curated-envkey-account-binding，ESSENTIAL）：解析出的绑定账号此刻**真的活在该环境上**吗。
 * 绑定是上一次握手的事实、可能陈旧——对**读 / 纯云端候审内容生成**（无平台副作用、可回头）无所谓，
 * 对当前阶段就具备平台写能力的通用委托 MUST 佐证。
 *
 * 判据 = `resolveEdgeIdForAccount(boundAccountId) === 'ads-' + envKey`：语义正是「我解析出的账号此刻是否正跑在这个
 * 环境上」。**用幸存者 resolveEdgeIdForAccount；反方向的 resolveAccountIdForEdge 已被慢启动 change 删除**。多连接时前者取最早登记者
 * ⇒ 可能误拒；误拒可接受（fail-closed + 有日志），误放不可接受。dep 缺失 ⇒ 无法佐证 ⇒ fail-closed。
 * **MUST NOT 用于读路由或精选内容洗稿创建**——二者在当前阶段都不需要浏览器兑现。
 */
function attestLiveBinding(deps: ClientAuthDeps, boundAccountId: string, envKey: string): boolean {
  const edgeId = deps.resolveEdgeIdForAccount?.(boundAccountId) ?? null;
  return edgeId === `ads-${envKey}`;
}

function createRequestHandler(deps: ClientAuthDeps, config: ClientAuthConfig) {
  const logger = config.logger ?? console;

  async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const { name, key } = (body ?? {}) as { name?: unknown; key?: unknown };
    if (typeof name !== 'string' || typeof key !== 'string') {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const ip = clientIp(req);
    const dims = [`name:${name.trim()}`, `ip:${ip}`];
    const wait = deps.rateLimiter.retryAfter(dims);
    if (wait > 0) {
      sendJson(res, 429, { error: 'rate_limited', retryAfter: wait });
      return;
    }
    const result = await deps.store.verifyLogin(name, key);
    if (!result.ok) {
      deps.rateLimiter.recordFailure(dims);
      // 统一不可区分错误（不区分 name 不存在 / 停用 / key 错），防枚举。
      sendJson(res, 401, { error: 'invalid_credentials' });
      return;
    }
    deps.rateLimiter.clear(dims);
    const token = signJwt({ sub: result.userId }, config.jwtSecret, config.jwtTtlSeconds);
    sendJson(res, 200, { token, expiresIn: config.jwtTtlSeconds });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const url = rawUrl.split('?')[0];

    // ── 公开端点 ──────────────────────────────────────────────
    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'OPTIONS' && url === '/egress') {
      res.writeHead(204, EGRESS_CORS_HEADERS);
      res.end();
      return;
    }
    if (method === 'GET' && url === '/egress') {
      const ip = egressClientIp(req);
      const checkedAt = new Date().toISOString();
      const requestId = randomUUID();
      sendJson(res, 200, { ip, checkedAt, requestId }, {
        ...EGRESS_CORS_HEADERS,
        'x-aidcp-egress-ip': ip,
        'x-aidcp-egress-checked-at': checkedAt,
        'x-aidcp-request-id': requestId,
      });
      return;
    }
    if (method === 'POST' && url === '/login') {
      await handleLogin(req, res);
      return;
    }

    // ── 其余受客户令牌保护 ────────────────────────────────────
    const token = parseBearer(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'unauthorized', reason: 'missing_token' });
      return;
    }
    const verified = verifyJwt(token, config.jwtSecret);
    if (!verified.valid) {
      sendJson(res, 401, { error: 'unauthorized', reason: verified.reason });
      return;
    }
    if (deps.revocation.isRevoked(verified.payload.jti)) {
      sendJson(res, 401, { error: 'unauthorized', reason: 'revoked' });
      return;
    }
    // N3：每请求回库复核启用态——停用/删除即时失效（范围/状态绝不内嵌令牌）。
    const userId = verified.payload.sub;
    if (!(await deps.store.isEnabled(userId))) {
      sendJson(res, 401, { error: 'unauthorized', reason: 'disabled' });
      return;
    }

    if (method === 'POST' && url === '/auth/refresh') {
      const fresh = signJwt({ sub: userId }, config.jwtSecret, config.jwtTtlSeconds);
      sendJson(res, 200, { token: fresh, expiresIn: config.jwtTtlSeconds });
      return;
    }
    if (method === 'POST' && url === '/logout') {
      deps.revocation.revoke(verified.payload.jti, verified.payload.exp);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && url === '/me') {
      sendJson(res, 200, { clientId: userId });
      return;
    }
    // 权威过滤点：只返回该客户归属的环境（N2 scoped 读）。
    if (method === 'GET' && url === '/my-environments') {
      const scope = await deps.store.listEnvScope(userId);
      const environments = await Promise.all(scope.map(async (s) => {
        const base = { envKey: s.envKey, label: s.label, platform: s.platform };
        const bound = await deps.store.resolveBoundAccountForEnv(userId, s.envKey);
        if (!bound.ok) return { ...base, bindingState: bound.reason };
        if (!deps.persona) return { ...base, bindingState: 'bound', personaState: 'unavailable' };
        const persona = await deps.persona.get(bound.accountId).catch(() => null);
        if (!persona?.ok) return { ...base, bindingState: 'bound', personaState: 'unavailable' };
        return {
          ...base,
          bindingState: 'bound',
          personaState: persona.view.state,
          personaBound: persona.view.state === 'configured',
        };
      }));
      sendJson(res, 200, { environments });
      return;
    }

    const operatorAliasMatch = /^\/environments\/([^/]+)\/operator-alias$/.exec(url);
    if (operatorAliasMatch) {
      if (method !== 'PUT') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      if (!deps.operatorAlias) {
        sendJson(res, 503, { error: 'operator_alias_unavailable' });
        return;
      }
      let envKey: string;
      try {
        envKey = decodeURIComponent(operatorAliasMatch[1] ?? '').trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = body as Record<string, unknown>;
      if (Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'alias')
          || (typeof raw.alias !== 'string' && raw.alias !== null)) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'alias_string_or_null_required' });
        return;
      }
      const clean = typeof raw.alias === 'string' ? raw.alias.trim() : '';
      if (clean.length > 80) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'alias_too_long' });
        return;
      }
      const bound = await deps.store.resolveOperatorAliasAccountForEnv(userId, envKey);
      if (!bound.ok) {
        const status = bound.reason === 'environment_not_owned' ? 403
          : bound.reason === 'binding_unavailable' ? 503
            : 409;
        sendJson(res, status, { error: bound.reason });
        return;
      }
      try {
        const result = await deps.operatorAlias.setForAccount(bound.accountId, clean || null);
        if (!result.ok) {
          sendJson(res, 409, { error: result.reason });
          return;
        }
        sendJson(res, 200, {
          data: {
            envKey,
            operatorAlias: result.operatorAlias,
            displayName: result.display.name,
            displayNameSource: result.display.source,
          },
          meta: { requestId: randomUUID(), asOf: Date.now() },
        });
      } catch (err) {
        logger.warn('[client-auth] 运营别名写入失败', {
          userId, envKey, reason: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 503, { error: 'operator_alias_write_failed' });
      }
      return;
    }

    const personaMatch = /^\/environments\/([^/]+)\/persona(?:\/(draft))?$/.exec(url);
    if (personaMatch) {
      if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      if (!deps.persona) {
        sendJson(res, 503, { error: 'persona_unavailable' });
        return;
      }
      let envKey: string;
      try {
        envKey = decodeURIComponent(personaMatch[1] ?? '').trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
        return;
      }
      const isDraft = personaMatch[2] === 'draft';
      if ((method === 'POST') !== isDraft || (method === 'GET' && isDraft) || (method === 'PUT' && isDraft)) {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;

      if (method === 'GET') {
        const result = await deps.persona.get(bound.accountId);
        if (!result.ok) {
          const status = result.reason === 'unknown_account' ? 409 : 503;
          sendJson(res, status, { error: result.reason });
          return;
        }
        sendJson(res, 200, {
          data: { envKey, ...result.view },
          meta: { requestId: randomUUID(), asOf: Date.now() },
        });
        return;
      }

      if (method === 'POST') {
        const idempotencyHeader = req.headers['idempotency-key'];
        const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader.trim() : '';
        if (!idempotencyKey || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
          sendJson(res, 400, { error: 'bad_request', reason: 'invalid_idempotency_key' });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        const raw = body as Record<string, unknown>;
        const allowed = new Set(['keywordSelections', 'writingLanguage']);
        if (Object.keys(raw).some((key) => !allowed.has(key)) || !Array.isArray(raw.keywordSelections)) {
          sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_persona_draft_intent' });
          return;
        }
        const result = await deps.persona.generate({
          accountId: bound.accountId,
          platform: deps.persona.platformForAccount(bound.accountId),
          keywordSelections: raw.keywordSelections,
          ...(raw.writingLanguage === undefined ? {} : { writingLanguage: raw.writingLanguage }),
          idempotencyKey,
        });
        if (!result.ok) {
          const status = result.reason === 'unknown_account' ? 409
            : result.reason === 'unavailable' || result.reason === 'generation_failed' ? 503
              : 422;
          sendJson(res, status, { error: 'persona_draft_rejected', reason: result.reason });
          return;
        }
        sendJson(res, 200, {
          data: {
            envKey,
            draft: {
              soulYaml: result.soulYaml,
              identitySummary: result.identitySummary,
              summary: result.summary,
            },
          },
          meta: { requestId: randomUUID(), asOf: Date.now() },
        });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req, MAX_SELECTED_PERSONA_BYTES + 1024);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = body as Record<string, unknown>;
      if (Object.keys(raw).length !== 1 || typeof raw.soulYaml !== 'string'
          || Buffer.byteLength(raw.soulYaml, 'utf8') > MAX_SELECTED_PERSONA_BYTES) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_persona_persist_intent' });
        return;
      }
      const result = await deps.persona.persist(
        bound.accountId,
        raw.soulYaml,
        `client-auth:${userId}:${envKey}`,
      );
      if (!result.ok) {
        const status = result.reason === 'unknown_account' ? 409
          : result.reason === 'persist_failed' ? 503
            : 422;
        sendJson(res, status, { error: 'persona_persist_rejected', reason: result.reason });
        return;
      }
      sendJson(res, 200, {
        data: { envKey, ...result.view, firstPostOnboarding: result.firstPostOnboarding },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    const draftEditMatch = /^\/environments\/([^/]+)\/publish-drafts\/([^/]+)$/.exec(url);
    if (method === 'PATCH' && draftEditMatch) {
      if (!deps.publishDraftActions || !deps.pendingDrafts) {
        sendJson(res, 503, { error: 'publish_draft_actions_unavailable' });
        return;
      }
      let envKey: string;
      let recordId: number;
      try {
        envKey = decodeURIComponent(draftEditMatch[1] ?? '').trim();
        recordId = Number(decodeURIComponent(draftEditMatch[2] ?? ''));
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_draft_target' });
        return;
      }
      if (!envKey || !Number.isInteger(recordId) || recordId <= 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_draft_target' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, 64 * 1024);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = body as Record<string, unknown>;
      const allowed = new Set(['expectedVersion', 'title', 'content', 'topics']);
      const patchKeys = Object.keys(raw).filter((key) => key !== 'expectedVersion');
      if (Object.keys(raw).some((key) => !allowed.has(key)) || patchKeys.length === 0
        || !Number.isInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 0
        || (raw.title !== undefined && (typeof raw.title !== 'string' || !raw.title.trim()))
        || (raw.content !== undefined && (typeof raw.content !== 'string' || !raw.content.trim()))
        || (raw.topics !== undefined && (!Array.isArray(raw.topics) || !raw.topics.every((topic) => typeof topic === 'string')))) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_draft_edit_intent' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;
      const result = await deps.publishDraftActions.edit(
        recordId,
        Number(raw.expectedVersion),
        {
          ...(raw.title !== undefined ? { title: raw.title as string } : {}),
          ...(raw.content !== undefined ? { content: raw.content as string } : {}),
          ...(raw.topics !== undefined ? { topics: raw.topics as string[] } : {}),
        },
        bound.accountId,
        `client-auth:${userId}:${bound.envKey}`,
      );
      if (!result.ok) {
        sendJson(res, editFailureStatus(result.reason), { error: 'publish_draft_edit_rejected', reason: result.reason });
        return;
      }
      sendJson(res, 200, {
        data: {
          envKey: bound.envKey,
          item: {
            id: recordId,
            title: result.title,
            content: result.content,
            topics: Array.isArray(result.metadata?.topics) ? result.metadata.topics : [],
            images: result.images,
            contentVersion: result.contentVersion,
          },
        },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    const refinementCreateMatch = /^\/environments\/([^/]+)\/publish-drafts\/([^/]+)\/refinements$/.exec(url);
    if (method === 'POST' && refinementCreateMatch) {
      if (!deps.pendingDrafts || !deps.draftRefinements) {
        sendJson(res, 503, { error: 'draft_refinement_unavailable' });
        return;
      }
      let envKey: string;
      let recordId: number;
      try {
        envKey = decodeURIComponent(refinementCreateMatch[1] ?? '').trim();
        recordId = Number(decodeURIComponent(refinementCreateMatch[2] ?? ''));
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_draft_target' });
        return;
      }
      if (!envKey || !Number.isInteger(recordId) || recordId <= 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_draft_target' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, 16 * 1024);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = body as Record<string, unknown>;
      const allowed = new Set(['expectedVersion', 'scope', 'instruction', 'selection']);
      const scopes: DraftRefinementScope[] = ['whole', 'body', 'images', 'selected_image', 'selected_text'];
      const scope = raw.scope as DraftRefinementScope;
      const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim() : '';
      if (Object.keys(raw).some((key) => !allowed.has(key))
        || !Number.isInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 0
        || !scopes.includes(scope) || !instruction || instruction.length > 1000) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_refinement_intent' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;
      const draft = await deps.pendingDrafts.pendingPublishPreviewForAccountRecord(bound.accountId, recordId);
      if (!draft) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (draft.contentVersion !== Number(raw.expectedVersion)) {
        sendJson(res, 409, { error: 'draft_refinement_rejected', reason: 'version_conflict', currentVersion: draft.contentVersion });
        return;
      }
      let selection: DraftRefinementSelection = null;
      if (scope === 'selected_text') {
        const selected = raw.selection;
        if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
          sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_selection' });
          return;
        }
        const value = selected as Record<string, unknown>;
        if (Object.keys(value).some((key) => !['start', 'end', 'text'].includes(key))
          || !Number.isInteger(value.start) || !Number.isInteger(value.end) || typeof value.text !== 'string'
          || Number(value.start) < 0 || Number(value.end) <= Number(value.start) || Number(value.end) > draft.content.length
          || draft.content.slice(Number(value.start), Number(value.end)) !== value.text) {
          sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_selection' });
          return;
        }
        selection = { start: Number(value.start), end: Number(value.end), text: value.text };
      } else if (scope === 'selected_image') {
        const selected = raw.selection;
        if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
          sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_selection' });
          return;
        }
        const value = selected as Record<string, unknown>;
        if (Object.keys(value).some((key) => key !== 'imageUrl') || typeof value.imageUrl !== 'string'
          || draft.images.filter((url) => url === value.imageUrl).length !== 1) {
          sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_selection' });
          return;
        }
        selection = { imageUrl: value.imageUrl };
      } else if (raw.selection !== undefined && raw.selection !== null) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'selection_not_allowed' });
        return;
      }
      try {
        const job = await deps.draftRefinements.create({
          accountId: bound.accountId,
          recordId,
          expectedVersion: draft.contentVersion,
          scope,
          instruction,
          selection,
        });
        sendJson(res, 202, {
          data: { envKey: bound.envKey, job: toClientRefinementJob(job) },
          meta: { requestId: randomUUID(), asOf: Date.now() },
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          sendJson(res, 409, { error: 'draft_refinement_rejected', reason: 'refinement_already_active' });
          return;
        }
        throw err;
      }
      return;
    }

    const refinementReadMatch = /^\/environments\/([^/]+)\/publish-drafts\/([^/]+)\/refinements\/([^/]+)$/.exec(url);
    if (method === 'GET' && refinementReadMatch) {
      if (!deps.draftRefinements) {
        sendJson(res, 503, { error: 'draft_refinement_unavailable' });
        return;
      }
      let envKey: string;
      let recordId: number;
      let jobKey: string;
      try {
        envKey = decodeURIComponent(refinementReadMatch[1] ?? '').trim();
        recordId = Number(decodeURIComponent(refinementReadMatch[2] ?? ''));
        jobKey = decodeURIComponent(refinementReadMatch[3] ?? '').trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_refinement_target' });
        return;
      }
      if (!envKey || !Number.isInteger(recordId) || recordId <= 0
        || (jobKey !== 'latest' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobKey))) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_refinement_target' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;
      const job = jobKey === 'latest'
        ? await deps.draftRefinements.latestForAccountRecord(bound.accountId, recordId)
        : await deps.draftRefinements.getForAccount(bound.accountId, recordId, jobKey);
      if (!job) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, {
        data: { envKey: bound.envKey, job: toClientRefinementJob(job) },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    const publishApprovalMatch = /^\/environments\/([^/]+)\/publish\/approval$/.exec(url);
    if (method === 'POST' && publishApprovalMatch) {
      if (!deps.publishDraftActions) {
        sendJson(res, 503, { error: 'publish_draft_actions_unavailable' });
        return;
      }
      let envKey: string;
      try {
        envKey = decodeURIComponent(publishApprovalMatch[1] ?? '').trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = body as Record<string, unknown>;
      const allowed = new Set(['requestId', 'approved', 'contentVersion', 'publishMode', 'publishTime']);
      if (Object.keys(raw).some((key) => !allowed.has(key))) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_publish_approval_intent' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;
      const payload = {
        requestId: raw.requestId,
        approved: raw.approved,
        contentVersion: raw.contentVersion,
        ...(Object.prototype.hasOwnProperty.call(raw, 'publishMode') ? { publishMode: raw.publishMode } : {}),
        ...(Object.prototype.hasOwnProperty.call(raw, 'publishTime') ? { publishTime: raw.publishTime } : {}),
      } as PublishApprovalActionPayload;
      const result = await deps.publishDraftActions.approve(
        payload,
        bound.accountId,
        `client-auth:${userId}:${bound.envKey}`,
      );
      if (!result.ok) {
        const status = result.reason === 'invalid_request' || result.reason === 'invalid_publish_plan' ? 422
          : result.reason === 'store_unavailable' || result.reason === 'publish_target_unavailable' ? 503
            : 409;
        sendJson(res, status, { error: 'publish_approval_rejected', ...result });
        return;
      }
      sendJson(res, 200, {
        data: {
          envKey: bound.envKey,
          ...result,
          receipt: result.state === 'approved' ? 'accepted_pending_execution' : 'rejected',
        },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    const publishImageRemoveMatch = /^\/environments\/([^/]+)\/publish\/draft-image-remove$/.exec(url);
    if (method === 'POST' && publishImageRemoveMatch) {
      if (!deps.publishDraftActions) {
        sendJson(res, 503, { error: 'publish_draft_actions_unavailable' });
        return;
      }
      let envKey: string;
      try {
        envKey = decodeURIComponent(publishImageRemoveMatch[1] ?? '').trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = body as Record<string, unknown>;
      const allowed = new Set(['requestId', 'contentVersion', 'imageUrl']);
      if (Object.keys(raw).some((key) => !allowed.has(key))) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_publish_image_remove_intent' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;
      const result = await deps.publishDraftActions.removeImage(
        {
          requestId: raw.requestId,
          contentVersion: raw.contentVersion,
          imageUrl: raw.imageUrl,
        } as PublishDraftImageRemovePayload,
        bound.accountId,
        `client-auth:${userId}:${bound.envKey}`,
      );
      if (!result.ok) {
        const status = result.reason === 'invalid_request' ? 422
          : result.reason === 'store_unavailable' ? 503
            : result.reason === 'not_found' ? 404
              : 409;
        sendJson(res, status, { error: 'publish_image_remove_rejected', ...result });
        return;
      }
      sendJson(res, 200, {
        data: { envKey: bound.envKey, ...result },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    // 当前客户拥有的 Facebook 环境风险真态读（离线可用）：envKey→accountId 只在 Cloud 内解析，回包绝不泄露账号键。
    if (method === 'GET' && /^\/environments\/[^/]+\/risk-state$/.test(url)) {
      const envKey = decodeURIComponent(url.split('/')[2] ?? '').trim();
      if (!deps.environmentRisk) {
        sendJson(res, 503, { error: 'environment_risk_unavailable' });
        return;
      }
      const accountId = await resolveOwnedFacebookRiskAccount(deps, res, userId, envKey);
      if (!accountId) return;
      const state = await deps.environmentRisk.viewForAccount(accountId);
      if (!state) {
        sendJson(res, 503, { error: 'environment_risk_unavailable' });
        return;
      }
      sendJson(res, 200, {
        data: { envKey, ...state },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    // 客户自助「解除受限」：只接受空对象。kind/status/accountId/reason 全由 Cloud 固定或解析，客户端无选择权。
    if (method === 'POST' && /^\/environments\/[^/]+\/risk-state\/recover$/.test(url)) {
      const envKey = decodeURIComponent(url.split('/')[2] ?? '').trim();
      if (!deps.environmentRisk) {
        sendJson(res, 503, { error: 'environment_risk_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).length !== 0) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'empty_object_required' });
        return;
      }
      const accountId = await resolveOwnedFacebookRiskAccount(deps, res, userId, envKey);
      if (!accountId) return;
      const auditReason = `client_environment_recovery:user=${userId}:env=${envKey}`;
      const recovery = await deps.environmentRisk.recoverRestrictedForAccount(accountId, auditReason);
      if (!recovery) {
        sendJson(res, 503, { error: 'environment_risk_unavailable' });
        return;
      }
      if (!recovery.accepted) {
        sendJson(res, 409, {
          error: 'risk_state_not_restricted',
          data: { envKey, status: recovery.state.status },
        });
        return;
      }
      const resumedEdges = deps.environmentRisk.resumeEdgesForAccount(accountId);
      logger.log('[client-auth] Facebook 环境解除受限', {
        userId,
        envKey,
        statusBefore: recovery.statusBefore,
        statusAfter: recovery.state.status,
        changed: recovery.changed,
        resumedEdges,
      });
      sendJson(res, 200, {
        data: { envKey, ...recovery.state, changed: recovery.changed, resumedEdges },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    if (method === 'POST' && url === '/persona-auto-fill/runs') {
      if (!deps.personaAutoFill) {
        sendJson(res, 503, { error: 'persona_auto_fill_unavailable' });
        return;
      }
      const idempotencyHeader = req.headers['idempotency-key'];
      const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader.trim() : '';
      if (!idempotencyKey || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_idempotency_key' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = body as Record<string, unknown>;
      const allowed = new Set(['platform', 'soulYaml']);
      if (Object.keys(raw).some((key) => !allowed.has(key)) || raw.platform !== 'facebook' ||
          typeof raw.soulYaml !== 'string' || !raw.soulYaml.trim() ||
          Buffer.byteLength(raw.soulYaml, 'utf8') > MAX_SELECTED_PERSONA_BYTES) {
        sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_persona_auto_fill_intent' });
        return;
      }
      try {
        const soul = loadSoulFromYaml(raw.soulYaml);
        if (!isWritingLanguage(soul.writing_language)) throw new Error('writing_language_required');
      } catch {
        sendJson(res, 422, { error: 'validation_failed', reason: 'invalid_selected_persona' });
        return;
      }
      const result = await deps.personaAutoFill.createRun({
        userId,
        idempotencyKey,
        soulYaml: raw.soulYaml,
      });
      sendJson(res, result.idempotent ? 200 : 201, {
        data: { runId: result.run.runId, state: result.run.state, idempotent: result.idempotent },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    // 无浏览器控制面启动引导（change browser-slot-cloud-presence）。这是一个刻意收窄的 env-scoped 读：
    // - 客户 token / ownership / binding conflict 均由既有权威链复核；
    // - 只返回当前环境的 envKey + accountId，不把所有环境账号塞进 /my-environments；
    // - 只用于建立随后仍会被真实浏览器身份复核的控制面，绝不创建/修改/推断绑定。
    const controlBootstrapMatch = /^\/environments\/([^/]+)\/control-bootstrap$/.exec(url);
    if (method === 'GET' && controlBootstrapMatch) {
      let envKey: string;
      try {
        envKey = decodeURIComponent(controlBootstrapMatch[1]).trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
        return;
      }
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      sendJson(res, 200, {
        data: { envKey, accountId: bound.accountId },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    // 客户首页概览：常规业务数据始终经 request-scoped HTTP 拉取，与自动化连接、引擎和浏览器解耦。
    // envKey 只用于客户 ownership + 持久绑定解析；accountId 只在 Cloud 内部流转，响应 DTO 明确不含该字段。
    const overviewMatch = /^\/environments\/([^/]+)\/overview$/.exec(url);
    if (method === 'GET' && overviewMatch) {
      if (!deps.environmentOverview) {
        sendJson(res, 503, { error: 'environment_overview_unavailable' });
        return;
      }
      let envKey: string;
      try {
        envKey = decodeURIComponent(overviewMatch[1]).trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
        return;
      }
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      const view = await deps.environmentOverview.viewForAccount(bound.accountId);
      if (!view) {
        sendJson(res, 503, { error: 'environment_overview_unavailable' });
        return;
      }
      const asOf = Date.now();
      sendJson(res, 200, {
        data: {
          envKey,
          dailyUsage: view.dailyUsage,
          currentPublishState: view.currentPublishState,
          lastPublished: view.lastPublished,
        },
        meta: { requestId: randomUUID(), asOf },
      });
      return;
    }

    // 当前小红书环境的生效排期：纯 Cloud 配置投影，离线可读，不依赖浏览器/core/WS。
    // accountId 与两份 168 位掩码均停留在 Cloud；客户 DTO 只返回可读时间区间。
    const scheduleMatch = /^\/environments\/([^/]+)\/schedule$/.exec(url);
    if (method === 'GET' && scheduleMatch) {
      if (!deps.environmentSchedule) {
        sendJson(res, 503, { error: 'environment_schedule_unavailable' });
        return;
      }
      let envKey: string;
      try {
        envKey = decodeURIComponent(scheduleMatch[1]).trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;
      if (deps.environmentSchedule.platformForAccount(bound.accountId)?.trim().toLowerCase() !== 'xiaohongshu') {
        sendJson(res, 409, { error: 'unsupported_platform' });
        return;
      }
      const view = deps.environmentSchedule.viewForAccount(bound.accountId);
      if (!view) {
        sendJson(res, 503, { error: 'environment_schedule_unavailable' });
        return;
      }
      sendJson(res, 200, {
        data: { envKey: bound.envKey, ...view },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    // 环境级慢启动开关（change environment-level-slow-start）：env-scoped、离线且未绑定账号也可配置。
    //
    // **绝不走 WS 写**（仍成立）：ws-server 全文无鉴权，session.accountId 是边缘 hello 里自报的字符串
    // ——改一个字符串就能替别人关慢启动。**accountId 由云端解析、客户端永不提交**（仍成立）。
    //
    // **原作者「边缘不在线就改不了不是缺陷」的论断已被用户裁定推翻**（change slow-start-offline-toggle）：
    // 那半个论点里为真的只是「用量计数来自 ui.snapshot.dailyUsage、边缘离线时确实陈旧」；但慢启动**真态**
    // （state/day/since/binding 与当日上限）是**纯云端**算出的（controller.slowStartView + effectiveQuotas，
    // 零边缘输入），写入的执行体也在云端配额计算内、经运行时现读生效。真态与用量是共用一张卡的两条独立通路，
    // 「离线不刷新」只打到用量那半条、打不到真态。而运营做「接下来这一程按不按曲线放量」的决定，最自然的时刻
    // 恰恰是浏览器还没起来时。因此 accountId 改由**持久绑定**解析（resolveBoundAccountForEnv，离线可解、
    // env_key 为 PK ⇒ 至多一个账号），不再要求边缘在线；离线时卡上仍诚实呈现「真态新鲜 + 用量标注为可能陈旧」。
    if (method === 'PUT' && /^\/environments\/[^/]+\/slow-start$/.test(url)) {
      const envKey = decodeURIComponent(url.split('/')[2] ?? '').trim();
      if (!deps.slowStart) {
        sendJson(res, 503, { error: 'slow_start_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // 严格 onlyKeys：绝不接受 accountId / since / quotaLevel 之类的跨客户选择器混进来（先于绑定解析，
      // 坏 body 一律 422，不因 ownership 差异漏出状态码侧信道）。
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const keys = Object.keys(body as object);
      const enabled = (body as { enabled?: unknown }).enabled;
      if (keys.length !== 1 || keys[0] !== 'enabled' || typeof enabled !== 'boolean') {
        sendJson(res, 422, { error: 'validation_failed', reason: 'only_enabled_boolean_accepted' });
        return;
      }
      // 单写目标就是环境：ownership 与 UPDATE 同一语句。账号绑定只决定能否追加 controller 生效投影，
      // 不再是保存环境配置的前置；未绑定也不能把已写成误报为失败。
      const stored = await deps.store.setEnvironmentSlowStart(userId, envKey, enabled, Date.now());
      if (!stored.ok) {
        sendBindingFailure(res, stored.reason);
        return;
      }
      let view: { slowStart: UiSlowStartPayload; dayQuotas?: Record<string, number> };
      if (stored.binding === 'bound') {
        const controllerView = await deps.slowStart.viewForAccount(stored.accountId);
        if (!controllerView) {
          sendJson(res, 503, { error: 'slow_start_unavailable' });
          return;
        }
        view = controllerView;
      } else {
        view = { slowStart: environmentOnlySlowStartView(stored.slowStartSince, stored.binding) };
      }
      // 回执带写后真态 + 生效后的当日上限。**不做「已保存 vs 已下发本机」二态**：慢启动的执行体
      // 就在云端 effectiveQuotas 内，provider 现读做对了 → PUT 200 = 本云端已生效。
      // 照抄一个不存在的状态同样是撒谎。（两者绑定：若把 provider 偷懒做成构造期读入，这句立刻变谎言。）
      sendJson(res, 200, {
        data: { envKey, slowStart: view.slowStart, ...(view.dayQuotas ? { dayQuotas: view.dayQuotas } : {}) },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    // 不依赖边缘的慢启动读（change slow-start-offline-toggle，GET /environments/:envKey/slow-start）：
    // 让从未连过云端、因而没有活快照的环境也能把这一行渲染出来（否则客户端整行不渲染 = 用户无从分辨
    // 是没支持 / 坏了 / 在等他做什么）。同一份持久绑定解析、同一 ownership fail-closed、同一个 controller 产出。
    if (method === 'GET' && /^\/environments\/[^/]+\/slow-start$/.test(url)) {
      const envKey = decodeURIComponent(url.split('/')[2] ?? '').trim();
      if (!deps.slowStart) {
        sendJson(res, 503, { error: 'slow_start_unavailable' });
        return;
      }
      const stored = await deps.store.getEnvironmentSlowStart(userId, envKey);
      if (!stored.ok) {
        sendBindingFailure(res, stored.reason);
        return;
      }
      let view: { slowStart: UiSlowStartPayload; dayQuotas?: Record<string, number> };
      if (stored.binding === 'bound') {
        const controllerView = await deps.slowStart.viewForAccount(stored.accountId);
        if (!controllerView) {
          sendJson(res, 503, { error: 'slow_start_unavailable' });
          return;
        }
        view = controllerView;
      } else {
        view = { slowStart: environmentOnlySlowStartView(stored.slowStartSince, stored.binding) };
      }
      // 回包 MUST NOT 含 accountId（读路由不得开侧门泄露账号身份，与「非所有者 fail-closed」同口径）。
      sendJson(res, 200, {
        data: { envKey, slowStart: view.slowStart, ...(view.dayQuotas ? { dayQuotas: view.dayQuotas } : {}) },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    // 客户稿件审核：读可离线，envKey 每次从持久绑定解析账号；SQL 同时收口 account + pending 状态。
    if (method === 'GET' && url === '/publish-drafts') {
      if (!deps.pendingDrafts) {
        sendJson(res, 503, { error: 'pending_drafts_unavailable' });
        return;
      }
      const query = new URL(rawUrl, 'http://localhost').searchParams;
      const envKey = (query.get('envKey') ?? '').trim();
      const limit = parseIntegerQuery(query.get('limit'), 12, 1, 50);
      const offset = parseIntegerQuery(query.get('offset'), 0, 0, 1_000_000);
      if (limit === null || offset === null) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_pagination' });
        return;
      }
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      const result = await deps.pendingDrafts.listPendingPublishPreviewsForAccount(
        bound.accountId,
        { limit, offset },
      );
      const latestRefinements = deps.draftRefinements
        ? await deps.draftRefinements.latestForAccountRecords(bound.accountId, result.items.map((item) => item.id))
        : new Map<number, DraftRefinementJob>();
      sendJson(res, 200, {
        items: result.items.map((item) => {
          const latest = latestRefinements.get(item.id);
          return {
            ...toClientPendingDraftListItem(item),
            ...(latest ? { refinement: toClientRefinementSummary(latest) } : {}),
          };
        }),
        total: result.total,
        limit,
        offset,
      });
      return;
    }

    // 客户端快捷排期占用：账号只由客户环境绑定解析；不接受 renderer 自报账号或时间窗口。
    if (method === 'GET' && url === '/publish-schedule/occupied-hours') {
      if (!deps.publishSchedule) {
        sendJson(res, 503, { error: 'publish_schedule_unavailable' });
        return;
      }
      const envKey = (new URL(rawUrl, 'http://localhost').searchParams.get('envKey') ?? '').trim();
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      const occupiedTimes = await deps.publishSchedule.listOccupiedScheduledTimesForAccount(bound.accountId);
      sendJson(res, 200, { occupiedTimes: occupiedTimes.filter(Number.isFinite) });
      return;
    }

    const pendingDraftDetail = /^\/publish-drafts\/([^/]+)$/.exec(url);
    if (method === 'GET' && pendingDraftDetail) {
      if (!deps.pendingDrafts) {
        sendJson(res, 503, { error: 'pending_drafts_unavailable' });
        return;
      }
      const id = Number(decodeURIComponent(pendingDraftDetail[1]));
      if (!Number.isInteger(id) || id <= 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_id' });
        return;
      }
      const envKey = (new URL(rawUrl, 'http://localhost').searchParams.get('envKey') ?? '').trim();
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      const row = await deps.pendingDrafts.pendingPublishPreviewForAccountRecord(bound.accountId, id);
      if (!row) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, { item: toClientPendingDraftDetail(row) });
      return;
    }

    // 客户灵感库：每个读写都回库复核 envKey 归属；绝不接受 accountId 或复用内部面板路由。
    if (method === 'GET' && url === '/curated-contents') {
      if (!deps.curatedContent) {
        sendJson(res, 503, { error: 'curated_content_unavailable' });
        return;
      }
      const query = new URL(rawUrl, 'http://localhost').searchParams;
      const envKey = (query.get('envKey') ?? '').trim();
      const mode = query.get('mode') ?? 'uncreated';
      if (mode !== 'uncreated' && mode !== 'created' && mode !== 'creatable' && mode !== 'all') {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_mode' });
        return;
      }
      const sort = query.get('sort') ?? 'weighted';
      if (sort !== 'weighted' && sort !== 'collects' && sort !== 'likes' && sort !== 'recent') {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_sort' });
        return;
      }
      const limit = parseIntegerQuery(query.get('limit'), 20, 1, 50);
      const offset = parseIntegerQuery(query.get('offset'), 0, 0, 1_000_000);
      if (limit === null || offset === null) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_pagination' });
        return;
      }
      // 环境→账号绑定解析（唯一入口）：归属闸 + 绑定 + accounts 存在 + 跨客户争用一次现读。
      // 未解析 MUST 响亮回报，**绝不 200-空**（本 change 存在的理由）；store 也永不用 envKey 当 accountId 查。
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      const accountId = bound.accountId;
      const referenceDraftCountPromise: Promise<number | null> = deps.referenceDraftCountForAccount
        ? deps.referenceDraftCountForAccount(accountId)
            .then((count) => (Number.isFinite(count) && count >= 0 ? Math.floor(count) : null))
            .catch((err) => {
              logger.warn(
                `[client-auth] reference draft count unavailable env=${envKey}: ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            })
        : Promise.resolve(null);
      const [result, referenceDraftCount] = await Promise.all([
        deps.curatedContent.listForClient(accountId, {
          creationStatus: mode,
          sort,
          limit,
          offset,
        }),
        referenceDraftCountPromise,
      ]);
      sendJson(res, 200, {
        items: result.items.map(toClientCuratedListItem),
        total: result.total,
        ...(referenceDraftCount !== null ? { referenceDraftCount } : {}),
        limit,
        offset,
      });
      return;
    }
    const curatedCreatePost = /^\/curated-contents\/([^/]+)\/create-post$/.exec(url);
    if (method === 'POST' && curatedCreatePost) {
      if (!deps.curatedContent || !deps.delegatedTasks) {
        sendJson(res, 503, { error: 'curated_actions_unavailable' });
        return;
      }
      const id = Number(decodeURIComponent(curatedCreatePost[1]));
      if (!Number.isInteger(id) || id <= 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_id' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = (body ?? {}) as { envKey?: unknown; useReferenceImages?: unknown };
      const envKey = typeof raw.envKey === 'string' ? raw.envKey.trim() : '';
      if (typeof raw.useReferenceImages !== 'boolean') {
        sendJson(res, 400, { error: 'bad_request', reason: 'reference_mode_required' });
        return;
      }
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      const accountId = bound.accountId;
      // 内容读取与洗稿任务创建都在云端完成；持久绑定已确定账号，不要求浏览器在线。
      const row = await deps.curatedContent.getOneForAccount(id, accountId);
      if (!row) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (row.contentType !== 'image_text') {
        sendJson(res, 200, { triggered: false, reason: 'image_text_only' });
        return;
      }
      if (!row.body?.trim()) {
        sendJson(res, 200, { triggered: false, reason: 'empty_body' });
        return;
      }
      if (raw.useReferenceImages && row.referenceImages.length === 0) {
        sendJson(res, 200, { triggered: false, reason: 'reference_images_unavailable' });
        return;
      }
      // client-rewrite-offline-start：这里只排队生成必审候选稿；真正的平台下发仍由后续活边缘定向闸控制。
      try {
        const result = await deps.delegatedTasks.createDraft({
          accountId,
          action: 'publish_post',
          targetSuccessCount: 1,
          maxAttempts: 2,
          deadlineAt: Date.now() + 24 * 60 * 60 * 1000,
          executionWindow: { mode: 'immediate' },
          // 专用服务端入口产生的人工单篇洗稿；通用客户端建任务路由仍强制 source=edge，不能伪造此权限。
          source: 'operator_action',
          sourceRef: `edge:curated:${envKey}:${id}:create-post`,
          sourceConstraints: {
            curatedId: id,
            sourceId: row.sourceId,
            title: row.title ?? '',
            body: row.body,
            author: row.author ?? '',
            sourceUrl: row.sourceUrl ?? '',
            topics: row.topics,
            useReferenceImages: raw.useReferenceImages,
            ...(raw.useReferenceImages
              ? { referenceImages: JSON.parse(JSON.stringify(row.referenceImages)) as JsonValue }
              : {}),
            ...(raw.useReferenceImages && row.visualAnalysis
              ? { visualAnalysis: JSON.parse(JSON.stringify(row.visualAnalysis)) as JsonValue }
              : {}),
            ...(raw.useReferenceImages && row.textCardTranscription
              ? { textCardTranscription: JSON.parse(JSON.stringify(row.textCardTranscription)) as JsonValue }
              : {}),
          },
          targetConstraints: {},
          approvalMode: 'review',
          priority: 'normal',
        });
        // 最小披露：只回排队回执，绝不把整个 task/confirmation 原样回给客户域。
        sendJson(res, result.created ? 201 : 200, {
          triggered: true,
          created: result.created,
          task: toClientTaskReceipt(result.task),
        });
      } catch (err) {
        if (err instanceof DelegatedTaskServiceError) {
          sendJson(res, err.status, { error: err.code, message: err.message });
        } else {
          throw err;
        }
      }
      return;
    }
    const curatedDetail = /^\/curated-contents\/([^/]+)$/.exec(url);
    if (method === 'GET' && curatedDetail) {
      if (!deps.curatedContent) {
        sendJson(res, 503, { error: 'curated_content_unavailable' });
        return;
      }
      const id = Number(decodeURIComponent(curatedDetail[1]));
      if (!Number.isInteger(id) || id <= 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_id' });
        return;
      }
      const envKey = (new URL(rawUrl, 'http://localhost').searchParams.get('envKey') ?? '').trim();
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      const row = await deps.curatedContent.getOneForAccount(id, bound.accountId);
      if (!row) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, { item: toClientCuratedDetail(row) });
      return;
    }
    // 官方 Electron 主进程的窄创建例外：先取一次性 intent，再用本次 user/create 的真实 envKey 完成。
    // proof 不写日志、不进入 renderer；普通 attach 路由仍在下方固定 403。
    if (method === 'POST' && url === '/environment-provisioning/intents') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).length !== 0) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const result = await deps.store.createProvisioningIntent(userId);
      if (!result.ok) {
        sendJson(res, result.reason === 'disabled' ? 401 : 503, { error: result.reason });
        return;
      }
      sendJson(res, 201, {
        data: { intentId: result.intentId, proof: result.proof, expiresAt: result.expiresAt },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }
    if (method === 'POST' && url === '/environment-provisioning/complete') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = body as Record<string, unknown>;
      const allowed = new Set(['intentId', 'proof', 'envKey', 'label', 'platform', 'slowStartEnabled']);
      if (Object.keys(raw).some((key) => !allowed.has(key)) ||
          typeof raw.intentId !== 'string' || typeof raw.proof !== 'string' ||
          typeof raw.envKey !== 'string' || (raw.label != null && typeof raw.label !== 'string') ||
          typeof raw.platform !== 'string' ||
          (raw.slowStartEnabled !== undefined && typeof raw.slowStartEnabled !== 'boolean')) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const result = await deps.store.completeProvisioningIntent(userId, {
        intentId: raw.intentId,
        proof: raw.proof,
        envKey: raw.envKey,
        label: raw.label as string | null | undefined,
        platform: raw.platform,
        slowStartEnabled: raw.slowStartEnabled as boolean | undefined,
      });
      if (!result.ok) {
        const status = result.reason === 'disabled' ? 401 :
          result.reason === 'invalid_intent' ? 404 :
            result.reason === 'intent_expired' ? 410 :
              result.reason === 'invalid_environment' ? 400 : 409;
        sendJson(res, status, { error: result.reason });
        return;
      }
      sendJson(res, result.idempotent ? 200 : 201, {
        data: { environment: result.environment, idempotent: result.idempotent },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }
    // 环境归属只能来自内部权威注册表 + 管理员分配。保留旧路由用于明确拒绝
    // 老客户端，绝不把客户提交的 envKey 写入归属表。
    if (method === 'POST' && url === '/environments') {
      try {
        await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      sendJson(res, 403, { error: 'forbidden', reason: 'environment_assignment_admin_only' });
      return;
    }
    const environmentOffboard = /^\/environments\/([^/]+)$/.exec(url);
    if (method === 'DELETE' && environmentOffboard) {
      const envKey = decodeURIComponent(environmentOffboard[1]).trim();
      let edgeId = '';
      try {
        const raw = await readJsonBody(req);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
          || Object.keys(raw).some((key) => key !== 'edgeId')
          || ('edgeId' in raw && typeof (raw as { edgeId?: unknown }).edgeId !== 'string')) {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        edgeId = String((raw as { edgeId?: string }).edgeId || '').trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // Backward compatibility: old clients send no body and continue on the durable legacy
      // offboard path. New clients must bind the cleanup grant to this environment's stable edgeId.
      if (edgeId && (edgeId.length > 256 || edgeId !== `ads-${envKey}`)) {
        sendJson(res, 409, { error: 'cleanup_edge_mismatch' });
        return;
      }
      const result = await deps.store.beginEnvironmentOffboard(userId, envKey);
      if (!result.ok) {
        sendJson(res, result.reason === 'disabled' ? 401 : result.reason === 'not_authorized' ? 404 : 409,
          { error: result.reason });
        return;
      }
      let cleanupGrant: { token: string; expiresAt: number; edgeId: string } | null = null;
      // 清理授权把 accountId 绑进票据、并由属主按台账逐项核对。`state==='accepted'`（已受理、
      // 尚未物化）时台账行还不存在、accountId 也还没解析出来 —— 此刻签票必然核不过，
      // 更不能拿一个猜的账号去签。故这一支不发票：客户端仍拿 202 + accepted 态，
      // 轮询 `GET /offboarding/:id` 直到物化，与旧客户端「不带 edgeId」那条路等价。
      const grantable = result.offboard.accountId !== null
        && result.offboard.state !== 'accepted'
        && result.offboard.state !== 'tombstoned'
        && result.offboard.state !== 'purged';
      if (edgeId && grantable) {
        const issued = issueOffboardCleanupGrant({
          offboardId: result.offboard.offboardId,
          envKey: result.offboard.envKey,
          accountId: result.offboard.accountId!,
          edgeId,
          userId,
        }, config.jwtSecret);
        const expiresAt = issued.claims.exp * 1000;
        const registered = await deps.store.registerOffboardCleanupGrant({
          userId,
          offboardId: result.offboard.offboardId,
          edgeId,
          jtiHash: hashOffboardCleanupGrantJti(issued.claims.jti),
          expiresAt,
        });
        if (!registered) {
          sendJson(res, 409, { error: 'cleanup_grant_unavailable' });
          return;
        }
        cleanupGrant = { token: issued.token, expiresAt, edgeId };
      }
      await deps.onOffboardCreated?.(result.offboard);
      sendJson(res, 202, {
        data: {
          ...result.offboard,
          ...(cleanupGrant ? {
            cleanupGrant: cleanupGrant.token,
            cleanupGrantExpiresAt: cleanupGrant.expiresAt,
            cleanupEdgeId: cleanupGrant.edgeId,
          } : {}),
        },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }
    const offboardCleanupBootstrap = /^\/offboarding\/([^/]+)\/cleanup-bootstrap$/.exec(url);
    if (method === 'POST' && offboardCleanupBootstrap) {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).some((key) => key !== 'cleanupGrant' && key !== 'edgeId')) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { cleanupGrant, edgeId } = raw as { cleanupGrant?: unknown; edgeId?: unknown };
      if (typeof cleanupGrant !== 'string' || !cleanupGrant || cleanupGrant.length > 4096
        || typeof edgeId !== 'string' || !edgeId || edgeId.length > 256) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const verifiedGrant = verifyOffboardCleanupGrant(cleanupGrant, config.jwtSecret);
      if (!verifiedGrant.ok) {
        sendJson(res, verifiedGrant.reason === 'expired' ? 410 : 403, { error: `cleanup_grant_${verifiedGrant.reason}` });
        return;
      }
      const claims = verifiedGrant.claims;
      const offboardId = decodeURIComponent(offboardCleanupBootstrap[1]);
      if (claims.offboardId !== offboardId || claims.userId !== userId || claims.edgeId !== edgeId) {
        sendJson(res, 403, { error: 'cleanup_grant_scope_mismatch' });
        return;
      }
      const consumed = await deps.store.consumeOffboardCleanupGrant({
        userId,
        offboardId: claims.offboardId,
        envKey: claims.envKey,
        accountId: claims.accountId,
        edgeId: claims.edgeId,
        jtiHash: hashOffboardCleanupGrantJti(claims.jti),
      });
      if (!consumed.ok) {
        const status = consumed.reason === 'not_found' ? 404
          : consumed.reason === 'expired' ? 410
            : consumed.reason === 'already_used' ? 409 : 403;
        sendJson(res, status, { error: `cleanup_grant_${consumed.reason}` });
        return;
      }
      sendJson(res, 200, {
        data: {
          mode: 'restricted_cleanup',
          offboardId: consumed.offboard.offboardId,
          envKey: consumed.offboard.envKey,
          accountId: consumed.offboard.accountId,
          edgeId: consumed.edgeId,
        },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }
    const offboardStatus = /^\/offboarding\/([^/]+)$/.exec(url);
    if (method === 'GET' && offboardStatus) {
      // 200 + `state:'accepted'` 是「已受理、尚未物化」的诚实答案；只有**这个客户名下确实没有这笔离场**
      // 才 404。对一笔已经被接受、归属也已经撤销的离场答 404，是静默假成功的镜像。
      const offboard = await deps.store.getOffboard(userId, decodeURIComponent(offboardStatus[1]));
      if (!offboard) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, { data: offboard, meta: { requestId: randomUUID(), asOf: Date.now() } });
      return;
    }

    const publishQueueRead = /^\/environments\/([^/]+)\/publish-queue$/.exec(url);
    if (method === 'GET' && publishQueueRead) {
      if (!deps.publishQueue) {
        sendJson(res, 503, { error: 'publish_queue_unavailable' });
        return;
      }
      let envKey: string;
      try {
        envKey = decodeURIComponent(publishQueueRead[1]);
      } catch {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_env_key' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;
      if (deps.publishQueue.platformForAccount(bound.accountId)?.trim().toLowerCase() !== 'xiaohongshu') {
        sendJson(res, 409, { error: 'unsupported_platform' });
        return;
      }
      const view = await deps.publishQueue.viewForAccount(bound.accountId);
      if (!view) {
        sendJson(res, 503, { error: 'publish_queue_unavailable' });
        return;
      }
      sendJson(res, 200, {
        data: { envKey: bound.envKey, ...view },
        meta: { requestId: randomUUID(), asOf: Date.now() },
      });
      return;
    }

    const publishQueueCancel = /^\/environments\/([^/]+)\/publish-queue\/tasks\/([^/]+)\/cancel$/.exec(url);
    if (method === 'POST' && publishQueueCancel) {
      if (!deps.publishQueue || !deps.delegatedTasks) {
        sendJson(res, 503, { error: 'publish_queue_unavailable' });
        return;
      }
      let envKey: string;
      let taskId: string;
      try {
        envKey = decodeURIComponent(publishQueueCancel[1]);
        taskId = decodeURIComponent(publishQueueCancel[2]).trim();
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (!taskId || taskId.length > 256 || /[\u0000-\u001f\u007f]/.test(taskId)) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_task_id' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const version = (body as { version?: unknown } | null)?.version;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'version_required' });
        return;
      }
      const bound = await resolveOwnedBoundAccount(deps, res, userId, envKey);
      if (!bound) return;
      if (deps.publishQueue.platformForAccount(bound.accountId)?.trim().toLowerCase() !== 'xiaohongshu') {
        sendJson(res, 409, { error: 'unsupported_platform' });
        return;
      }
      try {
        const task = await deps.delegatedTasks.get(taskId);
        if (task.accountId !== bound.accountId || task.actionFamily !== 'publish') {
          sendJson(res, 404, { error: 'task_not_found' });
          return;
        }
        if (!(CLIENT_PUBLISH_QUEUE_TASK_STATUSES as readonly string[]).includes(task.status)) {
          sendJson(res, 409, { error: 'task_not_cancellable' });
          return;
        }
        if (task.cancelRequested) {
          sendJson(res, 409, { error: 'task_cancel_pending' });
          return;
        }
        const updated = await deps.delegatedTasks.cancel(taskId, version);
        sendJson(res, 200, {
          data: projectClientPublishQueueCancelReceipt(updated),
          meta: { requestId: randomUUID(), asOf: Date.now() },
        });
      } catch (err) {
        if (err instanceof DelegatedTaskServiceError) {
          sendJson(res, err.status, { error: err.code, message: err.message });
        } else {
          throw err;
        }
      }
      return;
    }

    // Edge task entry is bound to the selected environment. Scope is read from
    // client_env_scope on every request; accountId is never accepted as an
    // unverified cross-customer selector.
    if (url === '/delegated-tasks' && method === 'GET') {
      if (!deps.delegatedTasks) {
        sendJson(res, 503, { error: 'delegated_tasks_unavailable' });
        return;
      }
      const envKey = (new URL(rawUrl, 'http://localhost').searchParams.get('envKey') ?? '').trim();
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      sendJson(res, 200, { tasks: await deps.delegatedTasks.list({ accountId: bound.accountId, limit: 50 }) });
      return;
    }
    if (url === '/delegated-tasks/draft' && method === 'POST') {
      if (!deps.delegatedTasks) {
        sendJson(res, 503, { error: 'delegated_tasks_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = (body ?? {}) as Partial<DelegatedTaskIntent> & { envKey?: unknown };
      const envKey = typeof raw.envKey === 'string' ? raw.envKey.trim() : '';
      const bound = await deps.store.resolveBoundAccountForEnv(userId, envKey);
      if (!bound.ok) {
        sendBindingFailure(res, bound.reason);
        return;
      }
      const accountId = bound.accountId;
      // D5 活体佐证：建委托任务是不可逆写，MUST 由活会话佐证绑定，否则诚实拒绝、绝不创建任务。
      if (!attestLiveBinding(deps, accountId, envKey)) {
        sendJson(res, 409, { error: 'binding_unverified', message: '暂时无法确认该环境当前登录的账号，请让该环境连上云端后重试。' });
        return;
      }
      try {
        const result = await deps.delegatedTasks.createDraft({
          ...raw as DelegatedTaskIntent,
          accountId,
          source: 'edge',
          // change delegated-approvalmode-clamp：客户端体不可信，绝不放行 auto_approve（否则免审绕过审批闸）。
          approvalMode: clampClientApprovalMode(raw.approvalMode),
          sourceRef: typeof raw.sourceRef === 'string' && raw.sourceRef.trim()
            ? raw.sourceRef.trim()
            : `edge:${envKey}:${Date.now()}`,
        });
        sendJson(res, result.created ? 201 : 200, result);
      } catch (err) {
        if (err instanceof DelegatedTaskServiceError) {
          sendJson(res, err.status, { error: err.code, message: err.message });
        } else {
          throw err;
        }
      }
      return;
    }
    const taskAction = /^\/delegated-tasks\/([^/]+)\/(confirm|pause|resume|cancel)$/.exec(url);
    if (taskAction && method === 'POST') {
      if (!deps.delegatedTasks) {
        sendJson(res, 503, { error: 'delegated_tasks_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      try {
        const taskId = decodeURIComponent(taskAction[1]);
        const task = await deps.delegatedTasks.get(taskId);
        // 反向归属判定：该客户是否经其某环境绑定到该任务的账号（由与正向解析同源的绑定+归属+争用逻辑派生）。
        // 旧的 `scope.some(item.envKey === task.accountId)` 恒不匹配（两个键空间）→ 对正当所有者回 403 = 诬告。
        const reachable = await deps.store.isAccountReachableByUser(userId, task.accountId);
        if (!reachable.ok) {
          sendBindingFailure(res, reachable.reason);
          return;
        }
        const raw = (body ?? {}) as { version?: unknown };
        const version = typeof raw.version === 'number' ? raw.version : undefined;
        const action = taskAction[2];
        const updated = action === 'confirm'
          ? await deps.delegatedTasks.confirm(taskId, version ?? -1)
          : action === 'pause'
            ? await deps.delegatedTasks.pause(taskId, version)
            : action === 'resume'
              ? await deps.delegatedTasks.resume(taskId, version)
              : await deps.delegatedTasks.cancel(taskId, version);
        sendJson(res, 200, { task: updated });
      } catch (err) {
        if (err instanceof DelegatedTaskServiceError) {
          sendJson(res, err.status, { error: err.code, message: err.message });
        } else {
          throw err;
        }
      }
      return;
    }

    if (deps.interactionApi && await deps.interactionApi.handle(req, res, userId)) return;

    sendJson(res, 404, { error: 'not_found' });
  }

  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    void handle(req, res).catch((err) => {
      // 缺表/改名（42P01）由只读方法抛 typed error：诚实回 503，绝不回落空结果、绝不 500（change
      // curated-envkey-account-binding，D6）。只有精选只读方法抛此类型，故此处映射精确无副作用。
      if (err instanceof CuratedContentUnavailableError) {
        if (!res.headersSent) sendJson(res, 503, { error: 'curated_content_unavailable' });
        return;
      }
      logger.warn(`[client-auth] 请求处理异常: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  };
}

/**
 * 启动客户鉴权 API。失败（保留端口 / 缺密钥 / 密钥与面板相同 / 端口占用）一律 started=false 而非抛出。
 * N1 头号风险：secret 与面板相同则客户令牌能在内部面板验签通过 → 边界坍塌，故此处硬断言拒启。
 */
export function startClientAuthApi(deps: ClientAuthDeps, config: ClientAuthConfig): Promise<ClientAuthHandle> {
  const logger = config.logger ?? console;
  const noop = async (): Promise<void> => {};

  if (config.forbiddenPorts.includes(config.port)) {
    logger.warn(`[client-auth] 拒绝绑定保留端口 ${config.port}（forbidden_port）——客户鉴权未启动`);
    return Promise.resolve({ started: false, reason: 'forbidden_port', port: config.port, close: noop });
  }
  if (!config.jwtSecret) {
    logger.warn('[client-auth] 未配置 AIDCP_CLIENT_JWT_SECRET（missing_secret）——客户鉴权未启动');
    return Promise.resolve({ started: false, reason: 'missing_secret', close: noop });
  }
  if (config.jwtSecret === config.panelJwtSecret) {
    logger.error(
      '[client-auth] AIDCP_CLIENT_JWT_SECRET 与面板密钥相同（secret_collision）——密钥即边界会坍塌,拒启客户鉴权',
    );
    return Promise.resolve({ started: false, reason: 'secret_collision', close: noop });
  }

  const server = http.createServer(createRequestHandler(deps, config));

  return new Promise<ClientAuthHandle>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      logger.warn(`[client-auth] listen 失败（${err.code ?? err.message}，非致命）——客户鉴权不可用`);
      resolve({ started: false, reason: 'listen_error', detail: err.code ?? err.message, port: config.port, close: noop });
    });
    // 绑 127.0.0.1：与面板同款,由 Nginx 反代（TLS 终止 + 转发,注入 x-forwarded-for）;绝不裸暴露 HTTP 端口。
    server.listen(config.port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : config.port;
      logger.log(`[client-auth] 客户鉴权 API 已监听 :${actualPort}（/login /my-environments，独立密钥）`);
      resolve({
        started: true,
        port: actualPort,
        close: async () => {
          server.closeAllConnections?.();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
