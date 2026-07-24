/**
 * 面板 API 层：独立 http.Server（独立端口、内网 127.0.0.1，Nginx 反代）+ 极小 switch 路由 + JWT。
 *
 * 红线：
 * - 独立端口、不碰边-云 8787 ws，不触 protocol.ts / command-bridge；
 * - 启动自检拒绝绑定保留端口（8787/5432/8788/isales 等）；
 * - listen 失败（端口占用/初始化错误）非致命——记日志并返回 started=false，绝不抛出让 main() 崩溃，
 *   边-云闭环与飞书核心继续运行。
 *
 * task 1（本文件）：骨架 + JWT 鉴权 + /api/version 漂移哨兵 + summary 骨架（证明注入链路）。
 * 只读接口全集见 task 5；写接口见 task 4。
 */

import http from 'node:http';
import { signJwt, verifyJwt } from './jwt.js';
import { parseBearer, verifyCredentials } from './auth.js';
import { buildVersionPayload } from './version.js';
import type {
  PanelDeps,
  PanelConfig,
  PanelHandle,
  SessionLimitPatchInput,
  HotLeadConfigPatchInput,
  ResumeConfigPatchInput,
  DashboardSummary,
} from './types.js';
import { startPanelWs, type PanelWsHandle } from './panel-ws.js';
import type { PublishApprovalPayload } from '../feishu/index.js';
import type { CaptchaAssistDispatchResult } from '../comm/captcha-assist.js';
import type { EditDraftPatch } from '../publish-agent/publish-log-store.js';
import {
  FacebookPublishMediaError,
  type FacebookPublishImageInput,
  type FacebookPublishSetPatch,
} from '../publish-agent/facebook-publish-media-store.js';
import {
  isContentScheduleActionMode,
  type AccountContentSchedulePatch,
} from '../config/content-schedule-store.js';
import type { RiskSignalKind, RiskQuotaLevel } from '../risk/index.js';
import { RISK_ACTIONS } from '../risk/index.js';
import { isKnownRole } from '../config/role-catalog.js';
import { isAllowedPlatformCredential } from '../config/platform-credentials.js';
import {
  FacebookGroupScopeError,
  type FacebookGroupMembershipStatus,
  type FacebookGroupTargetInput,
} from '../kernel/facebook-group-types.js';
import { readDownloadsManifest } from './downloads-manifest.js';
import { DelegatedTaskServiceError } from '../kernel/delegated-task-types.js';
import type {
  DelegatedActionFamily,
  DelegatedTaskIntent,
  DelegatedTaskStatus,
  JsonValue,
} from '../kernel/delegated-task-types.js';
import { clampClientApprovalMode, DELEGATED_TASK_STATUSES } from '../kernel/delegated-task-types.js';
import { buildPublishLifecycle, type ApprovalDispatchProjection } from './publish-stage-lifecycle.js';
import { CuratedContentUnavailableError } from '../kernel/curated-content-types.js';

/** 登录/写体很小，限制请求体大小防滥用。 */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_GROUP_IMPORT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FB_PUBLISH_UPLOAD_BODY_BYTES = 64 * 1024 * 1024;

function isCuratedSourcePostType(contentType: string): boolean {
  return contentType === 'image_text' || contentType === 'video';
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(buf);
}

function sendDelegatedTaskError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof DelegatedTaskServiceError) {
    sendJson(res, err.status, { error: err.code, message: err.message });
    return;
  }
  sendJson(res, 500, { error: 'delegated_task_error', message: (err as Error).message ?? String(err) });
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error('body_too_large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseGroupImportInputs(body: unknown): FacebookGroupTargetInput[] | null {
  const raw = (body ?? {}) as Record<string, unknown>;
  const inputs: FacebookGroupTargetInput[] = [];
  const optionalString = (value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return typeof value === 'string' ? value : undefined;
  };
  if (typeof raw.text === 'string') {
    for (const item of raw.text.split(/\s+/)) {
      const url = item.trim();
      if (url) inputs.push({ url });
    }
  }
  if (Array.isArray(raw.urls)) {
    for (const item of raw.urls) {
      if (typeof item !== 'string') return null;
      inputs.push({ url: item });
    }
  }
  if (Array.isArray(raw.items)) {
    for (const item of raw.items) {
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      if (typeof o.url !== 'string') return null;
      if (o.name !== undefined && o.name !== null && typeof o.name !== 'string') return null;
      const region = optionalString(o.region);
      const park = optionalString(o.park);
      const direction = optionalString(o.direction);
      if (region === undefined && o.region !== undefined) return null;
      if (park === undefined && o.park !== undefined) return null;
      if (direction === undefined && o.direction !== undefined) return null;
      inputs.push({
        url: o.url,
        name: (o.name as string | null | undefined) ?? null,
        ...(region !== undefined ? { region } : {}),
        ...(park !== undefined ? { park } : {}),
        ...(direction !== undefined ? { direction } : {}),
      });
    }
  }
  return inputs;
}

function parseFacebookPublishUploadFiles(body: unknown): FacebookPublishImageInput[] | null {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(raw.files)) return null;
  const files: FacebookPublishImageInput[] = [];
  for (const item of raw.files) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    if (typeof o.filename !== 'string') return null;
    const rawBase64 = typeof o.dataBase64 === 'string' ? o.dataBase64 : typeof o.base64 === 'string' ? o.base64 : null;
    if (!rawBase64) return null;
    const cleanBase64 = rawBase64.includes(',') ? rawBase64.slice(rawBase64.indexOf(',') + 1) : rawBase64;
    if (!/^[A-Za-z0-9+/=\s_-]+$/.test(cleanBase64)) return null;
    files.push({
      filename: o.filename,
      contentType: typeof o.contentType === 'string' ? o.contentType : null,
      bytes: Buffer.from(cleanBase64.replace(/\s+/g, ''), 'base64'),
      captionHint: typeof o.captionHint === 'string' ? o.captionHint : null,
    });
  }
  return files;
}

function facebookPublishMediaErrorStatus(reason: string): number {
  if (reason === 'account_not_found' || reason === 'not_found') return 404;
  if (reason === 'object_store_unavailable') return 503;
  if (reason === 'body_too_large') return 413;
  if (reason === 'status_locked') return 409;
  if (reason === 'retired_account' || reason === 'non_facebook_account') return 409;
  return 400;
}

function sendFacebookPublishMediaError(res: http.ServerResponse, err: unknown): void {
  const reason = err instanceof FacebookPublishMediaError ? err.reason : 'unavailable';
  sendJson(res, facebookPublishMediaErrorStatus(reason), {
    error: reason,
    reason,
    ...(err instanceof Error && err.message !== reason ? { message: err.message } : {}),
  });
}

function createRequestHandler(
  deps: PanelDeps,
  config: PanelConfig,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const logger = config.logger ?? console;

  // 账号存在性校验（change console-cloud-panel-hardening #28）：pause/resume/风控写端点的底层是
  // ON CONFLICT INSERT，对不存在账号会凭空造幽灵行并「假成功」（违背「绝不静默假成功」红线）。
  // 端点层先校验账号存在——不存在即 404；账号列表查询失败诚实 503（不放行、绝不造幽灵）。
  // 数据源为只读账号列表（accounts 表小、已为 dashboard 拉取，非全表扫描）。
  const assertAccountExists = async (accountId: string, res: http.ServerResponse): Promise<boolean> => {
    let known: Awaited<ReturnType<typeof deps.panelStore.listAccounts>>;
    try {
      known = await deps.panelStore.listAccounts();
    } catch {
      sendJson(res, 503, { error: 'unavailable', reason: 'account_lookup_failed' });
      return false;
    }
    if (!known.some((a) => a.accountId === accountId)) {
      sendJson(res, 404, { error: 'account_not_found' });
      return false;
    }
    return true;
  };

  // 归属跟随当次连接（change risk-target-follows-active-session）：面板的风控写（配额档 / 信号）改回
  // 账号级、**不按归属禁用**。同一账号分时接入不同目标是正常的；真正的止血在 risk_state 条件写那一层
  // （并发接管即作废先写方），无需在面板层做「非属主只读」的前置 409。

  type CaptchaAssistAuth =
    | { ok: true; actor: string }
    | { ok: false; status: number; body: { error: string; reason?: string } };

  function authenticateCaptchaAssist(req: http.IncomingMessage, incidentId: string): CaptchaAssistAuth {
    const bearer = parseBearer(req.headers.authorization);
    if (bearer) {
      const verified = verifyJwt(bearer, config.jwtSecret);
      if (verified.valid) {
        if (deps.revocation?.isRevoked(verified.payload.jti)) {
          return { ok: false, status: 401, body: { error: 'unauthorized', reason: 'revoked' } };
        }
        return { ok: true, actor: `panel:${verified.payload.sub}` };
      }
    }

    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const scopedToken = requestUrl.searchParams.get('token') ?? undefined;
    if (!scopedToken) {
      return { ok: false, status: 401, body: { error: 'unauthorized', reason: 'missing_token' } };
    }
    const verified = deps.captchaAssist?.verifyToken(scopedToken);
    if (!verified?.ok) {
      return { ok: false, status: 401, body: { error: 'unauthorized', reason: verified?.reason ?? 'unavailable' } };
    }
    if (verified.incidentId !== incidentId) {
      return { ok: false, status: 403, body: { error: 'forbidden', reason: 'token_scope_mismatch' } };
    }
    return { ok: true, actor: 'captcha-assist-token' };
  }

  // 穷举表（change captcha-assist-text-answer，7.2）：把原 if 链 + default 换成 Record<reason, number>，
  // reason union 一加成员 typecheck 立刻红——防新增拒绝码悄悄回落到 409 default 让运营看不懂。
  type CaptchaAssistDispatchReason = Extract<CaptchaAssistDispatchResult, { ok: false }>['reason'];
  const CAPTCHA_ASSIST_HTTP_STATUS: Record<CaptchaAssistDispatchReason, number> = {
    not_found: 404,
    expired: 409,
    edge_offline: 409,
    snapshot_required: 409,
    snapshot_mismatch: 409,
    invalid_points: 400,
    task_busy: 409,
    task_lease_failed: 409,
    invalid_text: 400,
    text_requires_single_focus_point: 400,
    edge_lacks_text_capability: 409,
    edge_capability_unknown: 409,
  };
  function captchaAssistStatus(reason: string | undefined): number {
    if (reason && reason in CAPTCHA_ASSIST_HTTP_STATUS) {
      return CAPTCHA_ASSIST_HTTP_STATUS[reason as CaptchaAssistDispatchReason];
    }
    return 409;
  }

  async function handleCaptchaAssist(req: http.IncomingMessage, res: http.ServerResponse, method: string, url: string): Promise<void> {
    if (!deps.captchaAssist) {
      sendJson(res, 503, { error: 'captcha_assist_unavailable' });
      return;
    }
    const suffix = url.slice('/api/captcha-assist/'.length);
    const parts = suffix.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const incidentId = parts[0];
    if (!incidentId || parts.length > 2) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const auth = authenticateCaptchaAssist(req, incidentId);
    if (!auth.ok) {
      sendJson(res, auth.status, auth.body);
      return;
    }

    if (method === 'GET' && parts.length === 1) {
      // 轮询即"运营在场"（change captcha-assist-live-snapshot）：窗口到期则重新武装实时循环。
      // 先记在场再取快照，使本次回包即反映 re-arm 后的 liveUntil。
      deps.captchaAssist.noteViewerPresence(incidentId);
      const incident = deps.captchaAssist.getIncident(incidentId);
      if (!incident) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, { incident });
      return;
    }

    if (method === 'POST' && parts.length === 2 && parts[1] === 'capture') {
      const result = await deps.captchaAssist.requestCapture(incidentId, auth.actor, 'refresh');
      if (!result.ok) {
        sendJson(res, captchaAssistStatus(result.reason), { error: result.reason, ...(result.incident ? { incident: result.incident } : {}) });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (method === 'POST' && parts.length === 2 && parts[1] === 'click') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { snapshotId, points, settleMs, trajectory, text, submit } = (body ?? {}) as {
        snapshotId?: unknown;
        points?: unknown;
        settleMs?: unknown;
        trajectory?: unknown;
        text?: unknown;
        submit?: unknown;
      };
      if (typeof snapshotId !== 'string' || !Array.isArray(points)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // 键入答案（change captcha-assist-text-answer，7.1）：不新增 verb、不新增身份闸——键入与点击共用同一
      // scoped-token 授权面（design D9）。深校验（charset/长度/单点/能力）全在 submitClick 内，畸形整单拒绝。
      // text 非法类型（非 string）当缺省丢弃，交 submitClick 判纯点击；submit 只认字面量 'enter'。
      const answerText = typeof text === 'string' ? text : undefined;
      const submitGesture = submit === 'enter' ? ('enter' as const) : undefined;
      // 轨迹（change captcha-assist-trajectory-replay）：只做粗形状把关，非对象即当无轨迹（可救透传，
      // 深校验交 submitClick 的 sanitize，畸形则丢弃保留 points、绝不静默）。
      const rawTrajectory =
        trajectory && typeof trajectory === 'object' && !Array.isArray(trajectory)
          ? (trajectory as import('../comm/protocol.js').CaptchaAssistTrajectoryPayload)
          : undefined;
      const normalizedPoints = points.map((point) => point as { x?: unknown; y?: unknown; label?: unknown });
      if (
        normalizedPoints.some(
          (point) =>
            typeof point.x !== 'number' ||
            typeof point.y !== 'number' ||
            (point.label !== undefined && typeof point.label !== 'string'),
        )
      ) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_points' });
        return;
      }
      const result = await deps.captchaAssist.submitClick({
        incidentId,
        snapshotId,
        points: normalizedPoints.map((point) => ({
          x: point.x as number,
          y: point.y as number,
          ...(typeof point.label === 'string' ? { label: point.label } : {}),
        })),
        actor: auth.actor,
        ...(typeof settleMs === 'number' && Number.isFinite(settleMs) ? { settleMs } : {}),
        ...(rawTrajectory ? { trajectory: rawTrajectory } : {}),
        ...(answerText !== undefined ? { text: answerText } : {}),
        ...(submitGesture ? { submit: submitGesture } : {}),
      });
      if (!result.ok) {
        sendJson(res, captchaAssistStatus(result.reason), { error: result.reason, ...(result.incident ? { incident: result.incident } : {}) });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string') {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    if (!verifyCredentials(config.users, username, password)) {
      sendJson(res, 401, { error: 'invalid_credentials' });
      return;
    }
    const token = signJwt({ sub: username }, config.jwtSecret, config.jwtTtlSeconds);
    sendJson(res, 200, { token, expiresIn: config.jwtTtlSeconds });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = (req.url ?? '/').split('?')[0];

    if (!url.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    // ── 公开端点（无需 JWT）──────────────────────────────────────────────
    if (method === 'GET' && url === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && url === '/api/version') {
      // 公开：登录页需在登录前读 version（build/health + 枚举）。
      sendJson(res, 200, buildVersionPayload());
      return;
    }
    if (method === 'POST' && url === '/api/auth/login') {
      await handleLogin(req, res);
      return;
    }
    if (url.startsWith('/api/captcha-assist/')) {
      await handleCaptchaAssist(req, res, method, url);
      return;
    }

    // ── 其余 /api/* 受 JWT 保护 ──────────────────────────────────────────
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
    // 撤销黑名单（change console-cloud-panel-hardening #26）：验签通过但 jti 已被登出/管理撤销 → 拒。
    if (deps.revocation?.isRevoked(verified.payload.jti)) {
      sendJson(res, 401, { error: 'unauthorized', reason: 'revoked' });
      return;
    }

    // 滑动续签（#24）：持未过期令牌换发一枚 exp 推进的新令牌，活跃使用不因定长 TTL 被踢。
    // 使 TTL 可保持短以缩短泄露窗口而不牺牲活跃体验（解除 #3 拉长 TTL 与 #26 无撤销的张力）。
    if (method === 'POST' && url === '/api/auth/refresh') {
      const fresh = signJwt({ sub: verified.payload.sub }, config.jwtSecret, config.jwtTtlSeconds);
      sendJson(res, 200, { token: fresh, expiresIn: config.jwtTtlSeconds });
      return;
    }
    // 登出（#26）：拉黑当前 jti，使令牌对服务端立即失效（不再等自然过期）。
    if (method === 'POST' && url === '/api/auth/logout') {
      deps.revocation?.revoke(verified.payload.jti, verified.payload.exp);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url === '/api/me') {
      sendJson(res, 200, { sub: verified.payload.sub, panelApiVersion: buildVersionPayload().panelApiVersion });
      return;
    }

    // ── 用户委托任务：所有公共写操作先 draft，再以 task id + version 显式确认 ─────────────
    if (url === '/api/delegated-tasks' || url.startsWith('/api/delegated-tasks/')) {
      const service = deps.delegatedTasks;
      if (!service) {
        sendJson(res, 503, { error: 'delegated_tasks_unavailable' });
        return;
      }
      try {
        if (method === 'GET' && url === '/api/delegated-tasks') {
          const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
          const accountId = query.get('accountId')?.trim() || undefined;
          const limitRaw = Number(query.get('limit') ?? 50);
          const limit = Number.isInteger(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
          const actionFamilyRaw = query.get('actionFamily')?.trim() || undefined;
          const actionFamilies: DelegatedActionFamily[] = ['comment', 'publish', 'candidate_control'];
          if (actionFamilyRaw && !actionFamilies.includes(actionFamilyRaw as DelegatedActionFamily)) {
            sendJson(res, 400, { error: 'bad_request', reason: 'invalid_action_family' });
            return;
          }
          const statusesRaw = query.get('statuses')?.trim();
          const statuses = statusesRaw
            ? statusesRaw.split(',').map((status) => status.trim()).filter(Boolean)
            : undefined;
          if (statuses && (statuses.length === 0 || statuses.some((status) => !DELEGATED_TASK_STATUSES.includes(status as DelegatedTaskStatus)))) {
            sendJson(res, 400, { error: 'bad_request', reason: 'invalid_task_status' });
            return;
          }
          sendJson(res, 200, {
            tasks: await service.list({
              accountId,
              actionFamily: actionFamilyRaw as DelegatedActionFamily | undefined,
              statuses: statuses as DelegatedTaskStatus[] | undefined,
              limit,
            }),
          });
          return;
        }
        if (method === 'POST' && url === '/api/delegated-tasks/draft') {
          const body = (await readJsonBody(req)) as Partial<DelegatedTaskIntent> | undefined;
          if (!body || typeof body !== 'object' || typeof body.action !== 'string') {
            sendJson(res, 400, { error: 'bad_request', reason: 'task_intent_required' });
            return;
          }
          const result = await service.createDraft({
            ...body,
            source: body.source === 'edge' || body.source === 'api' ? body.source : 'console',
            // change delegated-approvalmode-clamp：客户端体不可信，绝不放行 auto_approve（否则免审绕过审批闸）。
            approvalMode: clampClientApprovalMode(body.approvalMode),
          } as DelegatedTaskIntent);
          sendJson(res, result.created ? 201 : 200, result);
          return;
        }
        const rest = url.slice('/api/delegated-tasks/'.length);
        const [rawId, operation] = rest.split('/');
        const taskId = decodeURIComponent(rawId ?? '');
        if (!/^[0-9a-f-]{36}$/i.test(taskId)) {
          sendJson(res, 400, { error: 'bad_request', reason: 'invalid_task_id' });
          return;
        }
        if (method === 'GET' && !operation) {
          sendJson(res, 200, { task: await service.get(taskId) });
          return;
        }
        if (method === 'POST' && operation && ['confirm', 'pause', 'resume', 'cancel'].includes(operation)) {
          const body = (await readJsonBody(req)) as { version?: unknown } | undefined;
          const version = body?.version;
          if (!Number.isInteger(version)) {
            sendJson(res, 400, { error: 'bad_request', reason: 'version_required' });
            return;
          }
          const task = operation === 'confirm'
            ? await service.confirm(taskId, Number(version))
            : operation === 'pause'
              ? await service.pause(taskId, Number(version))
              : operation === 'resume'
                ? await service.resume(taskId, Number(version))
                : await service.cancel(taskId, Number(version));
          sendJson(res, 200, { task });
          return;
        }
        sendJson(res, 404, { error: 'not_found' });
      } catch (err) {
        sendDelegatedTaskError(res, err);
      }
      return;
    }

    if (deps.interactionInternalApi && await deps.interactionInternalApi.handle(req, res, verified.payload.sub)) return;

    // 边缘客户端安装包清单（change downloads-manifest-from-host）：**现扫本机 downloads 目录**得出，
    // 绝不由 console 源码写死版本号——那个数字描述的是「哪台机器上放了哪个包」，写进源码就对另一台机器撒谎。
    // 目录不可读 / 空 → 诚实返回空清单（前端显示「暂无可用安装包」），绝不编造版本、绝不给未经证实的链接。
    if (method === 'GET' && url === '/api/downloads') {
      sendJson(res, 200, await readDownloadsManifest());
      return;
    }

    // 管理侧全局环境注册表（change client-user-env-picker）：受**内部** JWT。跨用户聚合读，
    // **只在此处消费、绝不接客户鉴权服务**（守 N2：客户可达读仍只有吃 userId 的 scoped 方法）。
    if (method === 'GET' && url === '/api/client-environments') {
      if (!deps.clientUsers) {
        sendJson(res, 503, { error: 'client_users_unavailable' });
        return;
      }
      sendJson(res, 200, { environments: await deps.clientUsers.listAllEnvironments() });
      return;
    }

    // 环境资产只读管理：历史 lifecycle 如实返回，但 Cloud 不提供环境删除写面。
    if (method === 'GET' && url === '/api/environments') {
      if (!deps.clientUsers) {
        sendJson(res, 503, { error: 'client_users_unavailable' });
        return;
      }
      sendJson(res, 200, { environments: await deps.clientUsers.listAllEnvironments(), asOf: Date.now() });
      return;
    }

    // ── 对外客户管理（change edge-client-customer-auth）：受**内部** JWT 保护 ──────────
    // 客户令牌用另一密钥,到不了这里（上方验签即 bad_signature）。列表/读取绝不含 key/hash；
    // 明文 key 仅 create/rotate 一次性回显。未注入 clientUsers 则 503。
    if (url === '/api/client-users' || url.startsWith('/api/client-users/')) {
      if (!deps.clientUsers) {
        sendJson(res, 503, { error: 'client_users_unavailable' });
        return;
      }
      const store = deps.clientUsers;
      const actor = verified.payload.sub;

      if (method === 'GET' && url === '/api/client-users') {
        sendJson(res, 200, { users: await store.listUsers() });
        return;
      }
      if (method === 'POST' && url === '/api/client-users') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        const { name } = (body ?? {}) as { name?: unknown };
        if (typeof name !== 'string') {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        const r = await store.createUser(name, actor);
        if (!r.ok) {
          sendJson(res, r.reason === 'name_taken' ? 409 : 400, { error: r.reason });
          return;
        }
        // 一次性回显明文 key（此后无接口读回）。
        sendJson(res, 200, { user: r.user, key: r.plainKey });
        return;
      }
      // /api/client-users/:id ...
      const rest = url.slice('/api/client-users/'.length);
      const [rawId, sub] = rest.split('/');
      const userId = decodeURIComponent(rawId);
      if (!userId) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (method === 'PATCH' && !sub) {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        const { name, status } = (body ?? {}) as { name?: unknown; status?: unknown };
        const patch: { name?: string; status?: 'enabled' | 'disabled' } = {};
        if (name !== undefined) {
          if (typeof name !== 'string') {
            sendJson(res, 400, { error: 'bad_request' });
            return;
          }
          patch.name = name;
        }
        if (status !== undefined) {
          if (status !== 'enabled' && status !== 'disabled') {
            sendJson(res, 400, { error: 'bad_request' });
            return;
          }
          patch.status = status;
        }
        const r = await store.updateUser(userId, patch, actor);
        if (!r.ok) {
          sendJson(res, r.reason === 'not_found' ? 404 : r.reason === 'name_taken' ? 409 : 400, { error: r.reason });
          return;
        }
        for (const offboard of r.offboards) await deps.onClientOffboardCreated?.(offboard);
        sendJson(res, 200, { user: r.user, cleanup: r.cleanup });
        return;
      }
      if (method === 'POST' && sub === 'rotate-key') {
        const r = await store.rotateKey(userId);
        if (!r.ok) {
          sendJson(res, 404, { error: r.reason });
          return;
        }
        sendJson(res, 200, { key: r.plainKey });
        return;
      }
      if (method === 'GET' && sub === 'scope') {
        sendJson(res, 200, { scope: await store.getScope(userId) });
        return;
      }
      if (method === 'PUT' && sub === 'scope') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        const { environments } = (body ?? {}) as { environments?: unknown };
        if (!Array.isArray(environments)) {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        const items = environments
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
          .map((e) => ({
            envKey: typeof e.envKey === 'string' ? e.envKey : '',
            label: typeof e.label === 'string' ? e.label : null,
            platform: typeof e.platform === 'string' ? e.platform : null,
          }));
        const r = await store.setScope(userId, items, actor);
        if (!r.ok) {
          const status = r.reason === 'not_found' ? 404 :
            r.reason === 'env_already_assigned' || r.reason === 'cleanup_in_progress' ||
              r.reason === 'offboard_in_progress' ? 409 : 422;
          sendJson(res, status, { error: r.reason, ...(r.envKey ? { envKey: r.envKey } : {}) });
          return;
        }
        for (const offboard of r.offboards) await deps.onClientOffboardCreated?.(offboard);
        sendJson(res, 200, { scope: r.scope, cleanup: r.cleanup });
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (method === 'GET' && url === '/api/dashboard/summary') {
      const [totals, totalsByAccount, likeRate, accounts, todayPublishes, alerts] = await Promise.all([
        deps.panelStore.todayTotals(),
        deps.panelStore.todayTotalsByAccount(),
        deps.panelStore.likeRate(),
        deps.panelStore.listAccounts(),
        deps.panelStore.todayPublishCount(),
        // merge-monitor-into-dashboard：console 监控页并入首页后，summary 成为告警唯一读口，
        // 上限对齐被退役的独立告警流（GET /api/alerts 的 100），避免可见告警静默减半。
        deps.panelStore.listAlerts({ limit: 100 }),
      ]);
      // 每账号补当前 day 窗口生效上限 + 已撞顶动作（change decouple-quota-hit-from-risk）：经 registry
      // （缓存 controller）现读 effectiveQuotas().day，随风控态/档位变化；只读、绝不写风控态；拿不到诚实缺省。
      const totalsByAccountWithQuotas = await Promise.all(
        totalsByAccount.map(async (entry) => {
          try {
            // change risk-target-follows-active-session：不再按归属跳过——归属跟随当次连接，
            // 物化 controller 只为**读**当日生效上限做展示；若该账号其实由另一目标驱动，其风控写会被
            // 条件写作废（并驱逐这份缓存），不会盖回对方状态。拿不到上限就不带上限（诚实缺省）。
            const dayQuotas = (await deps.riskRegistry.getController(entry.accountId)).effectiveQuotas().day;
            const saturated = RISK_ACTIONS.filter((a) => entry.totals[a] >= dayQuotas[a]);
            return { ...entry, quotas: dayQuotas, saturated };
          } catch {
            return entry; // 诚实回落：拿不到 controller 就不带上限（前端只显数字）
          }
        }),
      );
      // change dashboard-refresh-clarity：响应收口到 DashboardSummary DTO（asOf=服务端此刻，
      // console 渲染「数据截至 …」区分「无新活动」与「界面冻结」）。今日聚合（todayTotals /
      // todayTotalsByAccount / likeRate）走 risk_counters 的 occurred_at 打头索引
      // （change console-cloud-panel-hardening #21 新补），不带账号前缀也不再退化为全表扫描。
      const environmentSummaries = deps.clientUsers
        ? await deps.clientUsers.environmentSummariesByAccount()
        : {};
      const accountsWithEnvironments = accounts.map((account) => ({
        ...account,
        environmentSummary: environmentSummaries[account.accountId]
          ?? { activeCount: 0, deletingCount: 0, onlineCount: 0 },
      }));
      const summary: DashboardSummary = {
        asOf: Date.now(),
        edgesOnline: deps.edgeServer.onlineEdgeCount(), // staleness-aware（死连接不算在线，D9）
        totals: { ...totals, publish: todayPublishes },
        // V1 task 9.6：归因已在事件上流通（interaction.occurred 带 accountId），上真按账号切片。
        // decouple-quota-hit-from-risk：每账号带 day 上限 + 饱和标记（用量可见）。
        totalsByAccount: totalsByAccountWithQuotas,
        likeRate,
        accounts: accountsWithEnvironments,
        alerts, // V1 task 9.5：真告警（未解决），来自 alerts 表
        // 归因已落地：按账号切片为真数字（保留键 default 即单账号现实下的真实账号）。
        attributionPending: false,
        // 调度引擎状态（V1 task 9.4：单全局 RoleDispatcher；per-edge 拆分见 design 步骤 8）。
        dispatchActive: deps.commandActions.dispatchActive ? deps.commandActions.dispatchActive() : null,
      };
      sendJson(res, 200, summary);
      return;
    }
    if (method === 'GET' && url === '/api/accounts') {
      const accounts = await deps.panelStore.listAccounts();
      const summaries = deps.clientUsers ? await deps.clientUsers.environmentSummariesByAccount() : {};
      sendJson(res, 200, { accounts: accounts.map((account) => ({
        ...account,
        environmentSummary: summaries[account.accountId]
          ?? { activeCount: 0, deletingCount: 0, onlineCount: 0 },
      })) });
      return;
    }
    if (method === 'GET' && url === '/api/facebook/groups') {
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const rawStatus = query.get('status') ?? undefined;
      const allowedStatuses = new Set<string>([
        'unassigned',
        'assigned',
        'joining',
        'joined',
        'pending',
        'gated',
        'no_button',
        'checkpoint',
        'failed',
        'left',
      ]);
      if (rawStatus && !allowedStatuses.has(rawStatus)) {
        sendJson(res, 400, { error: 'bad_request', reason: 'bad_status' });
        return;
      }
      const enabledRaw = query.get('enabled');
      const enabled = enabledRaw === null ? undefined : enabledRaw === 'true' ? true : enabledRaw === 'false' ? false : null;
      if (enabled === null) {
        sendJson(res, 400, { error: 'bad_request', reason: 'bad_enabled' });
        return;
      }
      sendJson(
        res,
        200,
        await deps.facebookGroupTargets.listTargets({
          limit: Number(query.get('limit') ?? 100),
          offset: Number(query.get('offset') ?? 0),
          ...(rawStatus ? { status: rawStatus as FacebookGroupMembershipStatus | 'unassigned' } : {}),
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
          ...(query.get('region') ? { region: query.get('region') } : {}),
          ...(query.get('park') ? { park: query.get('park') } : {}),
          ...(query.get('direction') ? { direction: query.get('direction') } : {}),
          ...(query.get('accountGroupLabel') ? { accountGroupLabel: query.get('accountGroupLabel') } : {}),
        }),
      );
      return;
    }
    if (method === 'GET' && url === '/api/facebook/groups/facets') {
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      sendJson(res, 200, await deps.facebookGroupTargets.listFacets());
      return;
    }
    if (method === 'POST' && url === '/api/facebook/groups/import') {
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, MAX_GROUP_IMPORT_BODY_BYTES);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = (body ?? {}) as Record<string, unknown>;
      const inputs = parseGroupImportInputs(body);
      if (!inputs || inputs.length === 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'no_targets' });
        return;
      }
      if (raw.importBatch !== undefined && raw.importBatch !== null && typeof raw.importBatch !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'bad_import_batch' });
        return;
      }
      if (raw.accountGroupLabels !== undefined && (
        !Array.isArray(raw.accountGroupLabels) || raw.accountGroupLabels.some((label) => typeof label !== 'string')
      )) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_account_group' });
        return;
      }
      try {
        sendJson(res, 200, await deps.facebookGroupTargets.importTargets(
          inputs,
          raw.importBatch as string | null | undefined ?? null,
          {
            ...(raw.accountGroupLabels !== undefined
              ? { accountGroupLabels: raw.accountGroupLabels as string[] }
              : {}),
            updatedBy: verified.payload.sub,
          },
        ));
      } catch (error) {
        if (error instanceof FacebookGroupScopeError) {
          sendJson(res, 400, { error: 'bad_request', reason: error.reason });
          return;
        }
        throw error;
      }
      return;
    }
    if (method === 'PUT' && url === '/api/facebook/groups/scopes') {
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = (body ?? {}) as Record<string, unknown>;
      if (!Array.isArray(raw.groupUrls) || raw.groupUrls.length === 0 || raw.groupUrls.some((url) => typeof url !== 'string')) {
        sendJson(res, 400, { error: 'bad_request', reason: 'no_targets' });
        return;
      }
      if (!Array.isArray(raw.accountGroupLabels) || raw.accountGroupLabels.some((label) => typeof label !== 'string')) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_account_group' });
        return;
      }
      const result = await deps.facebookGroupTargets.replaceTargetScopes(
        raw.groupUrls as string[],
        raw.accountGroupLabels as string[],
        verified.payload.sub,
      );
      if (!result.ok) {
        sendJson(res, 400, { error: 'bad_request', reason: result.reason });
        return;
      }
      sendJson(res, 200, { items: result.items });
      return;
    }
    if (method === 'PATCH' && url === '/api/facebook/groups/enabled') {
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { groupUrl, enabled } = (body ?? {}) as Record<string, unknown>;
      if (typeof groupUrl !== 'string' || typeof enabled !== 'boolean') {
        sendJson(res, 400, { error: 'bad_request', reason: 'bad_value' });
        return;
      }
      const row = await deps.facebookGroupTargets.setEnabled(groupUrl, enabled);
      if (!row) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, row);
      return;
    }
    if (method === 'GET' && url === '/api/facebook/groups/progress') {
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      sendJson(res, 200, { accounts: await deps.facebookGroupTargets.accountProgress() });
      return;
    }
    if (method === 'GET' && url === '/api/facebook/groups/assignments') {
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      sendJson(res, 200, { assignments: await deps.facebookGroupTargets.listAssignments(Number(query.get('limit') ?? 200)) });
      return;
    }
    if (method === 'POST' && url === '/api/facebook/groups/reclaim-stale') {
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const ttlMs = (body as Record<string, unknown> | undefined)?.ttlMs ?? 30 * 60_000;
      if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 60_000) {
        sendJson(res, 400, { error: 'bad_request', reason: 'bad_ttl' });
        return;
      }
      sendJson(res, 200, { reclaimed: await deps.facebookGroupTargets.reclaimStaleAssignments(ttlMs) });
      return;
    }
    // Facebook 定时评论配置读（change facebook-scheduled-comment 2.1）：必须在下面通配 GET /api/accounts/:id
    // 之前注册，否则会被当成 id=":id/facebook-comment-config" 吞掉。缺行返回空默认（供面板回显）。
    if (method === 'GET' && url.startsWith('/api/accounts/') && url.endsWith('/facebook-comment-config')) {
      const accountId = decodeURIComponent(
        url.slice('/api/accounts/'.length, -'/facebook-comment-config'.length),
      );
      if (!deps.facebookCommentConfig) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      sendJson(res, 200, deps.facebookCommentConfig.get(accountId));
      return;
    }
    // Facebook 发帖素材池：必须在通配 GET /api/accounts/:id 之前注册。
    if (url.startsWith('/api/accounts/') && url.includes('/facebook-publish-media')) {
      if (!deps.facebookPublishMedia) {
        sendJson(res, 503, { error: 'facebook_publish_media_unavailable' });
        return;
      }
      const rest = url.slice('/api/accounts/'.length);
      const marker = '/facebook-publish-media';
      const idx = rest.indexOf(marker);
      if (idx < 0) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const accountId = decodeURIComponent(rest.slice(0, idx));
      const tail = rest.slice(idx + marker.length);
      try {
        if (method === 'GET' && tail === '') {
          sendJson(res, 200, await deps.facebookPublishMedia.list(accountId));
          return;
        }
        if (method === 'POST' && tail === '/upload') {
          let body: unknown;
          try {
            body = await readJsonBody(req, MAX_FB_PUBLISH_UPLOAD_BODY_BYTES);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, message === 'body_too_large' ? 413 : 400, { error: message === 'body_too_large' ? 'body_too_large' : 'bad_request' });
            return;
          }
          const files = parseFacebookPublishUploadFiles(body);
          if (!files || files.length === 0) {
            sendJson(res, 400, { error: 'bad_request', reason: 'no_files' });
            return;
          }
          sendJson(res, 200, await deps.facebookPublishMedia.upload(accountId, files));
          return;
        }
        if (method === 'PUT' && tail === '/reorder') {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { error: 'bad_request' });
            return;
          }
          const ids = (body as Record<string, unknown> | undefined)?.orderedSetIds;
          if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'number')) {
            sendJson(res, 400, { error: 'bad_request', reason: 'bad_order' });
            return;
          }
          sendJson(res, 200, await deps.facebookPublishMedia.reorder(accountId, ids));
          return;
        }
        const setMatch = tail.match(/^\/sets\/(\d+)$/);
        if (setMatch && method === 'PATCH') {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { error: 'bad_request' });
            return;
          }
          const raw = (body ?? {}) as Record<string, unknown>;
          const patch: FacebookPublishSetPatch = {};
          if ('captionHint' in raw) {
            if (raw.captionHint !== null && typeof raw.captionHint !== 'string') {
              sendJson(res, 400, { error: 'bad_request', reason: 'bad_caption_hint' });
              return;
            }
            patch.captionHint = raw.captionHint as string | null;
          }
          if ('status' in raw) {
            if (raw.status !== 'available' && raw.status !== 'disabled' && raw.status !== 'deleted') {
              sendJson(res, 400, { error: 'bad_request', reason: 'bad_status' });
              return;
            }
            patch.status = raw.status;
          }
          const row = await deps.facebookPublishMedia.updateSet(accountId, Number(setMatch[1]), patch);
          if (!row) {
            sendJson(res, 404, { error: 'not_found' });
            return;
          }
          sendJson(res, 200, row);
          return;
        }
        if (setMatch && method === 'DELETE') {
          const row = await deps.facebookPublishMedia.deleteSet(accountId, Number(setMatch[1]));
          if (!row) {
            sendJson(res, 404, { error: 'not_found' });
            return;
          }
          sendJson(res, 200, row);
          return;
        }
      } catch (err) {
        sendFacebookPublishMediaError(res, err);
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (method === 'GET' && url.startsWith('/api/accounts/') && url.endsWith('/facebook-group-progress')) {
      const accountId = decodeURIComponent(
        url.slice('/api/accounts/'.length, -'/facebook-group-progress'.length),
      );
      if (!deps.facebookGroupTargets) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      if (!(await assertAccountExists(accountId, res))) return;
      const progress = (await deps.facebookGroupTargets.accountProgress()).find((row) => row.accountId === accountId) ?? null;
      sendJson(res, 200, { accountId, progress });
      return;
    }
    if (method === 'GET' && url.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(url.slice('/api/accounts/'.length));
      const account = await deps.panelStore.getAccount(id);
      if (!account) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, account);
      return;
    }
    // 已发布历史（change publish-history-account-and-detail）：带账号/正文/详情链接，可选 ?accountId 过滤。
    // ?status 服务端过滤（change parallel-rewrite-drafts）：待审集合完整可见，不受全局 LIMIT 50 窗口挤出。
    if (method === 'GET' && url === '/api/content/published') {
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const accountId = query.get('accountId') ?? undefined;
      const status = query.get('status') ?? undefined;
      const items = await deps.panelStore.publishedHistory(50, accountId, status);
      // 待审详情投影同样带上下发进度（change publish-approval-signal-to-database，task 4.6）：
      // 「已批准·待下发」在稿件列表 / 抽屉里也必须与「待审批」可区分。
      // 读不到 → 不带这些字段，前端回落既有呈现（MUST NOT 白屏）。
      const dispatch = await readApprovalDispatchFor(deps, items);
      sendJson(res, 200, {
        items: dispatch
          ? items.map((row) => {
              const view = dispatch.get(row.id);
              return view
                ? {
                    ...row,
                    dispatchState: view.dispatchState,
                    dispatchBlockedReason: view.dispatchBlockedReason,
                    decidedAt: view.decidedAt,
                    waitingMs: Math.max(0, Date.now() - view.decidedAt),
                  }
                : row;
            })
          : items,
      });
      return;
    }
    if (method === 'GET' && url === '/api/content/queue') {
      const queue = await deps.publishStatus.getStatus();
      const [pending, recent] = await Promise.all([
        // 待审集合必须按状态独立查询，不能被最近 50 条全局历史挤出。
        deps.panelStore.publishedHistory(50, undefined, 'pending_approval'),
        deps.panelStore.publishedHistory(10),
      ]);
      // 「已批准·待下发」的判据来自持久授权记录，不是进程内在途集合——重启后该区分必须依然成立。
      // 读失败 / 未注入 → 不带下发态字段，前端回落既有呈现（MUST NOT 白屏）。
      const approvalDispatch = await readApprovalDispatchFor(deps, [...pending, ...recent]);
      const lifecycle = buildPublishLifecycle({
        queue,
        pending,
        recent,
        inFlightRecordIds: deps.publishDispatcher?.getInFlightRecordIds() ?? [],
        ...(approvalDispatch ? { approvalDispatch } : {}),
      });
      sendJson(res, 200, { ...queue, lifecycle });
      return;
    }
    if (method === 'GET' && url === '/api/analytics/like-rate') {
      sendJson(res, 200, await deps.panelStore.likeRate());
      return;
    }
    // 告警只读流（V1 task 9.5）：默认仅未解决；?includeResolved=1 含已解决。
    if (method === 'GET' && url === '/api/alerts') {
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const includeResolved = query.get('includeResolved') === '1';
      sendJson(res, 200, { alerts: await deps.panelStore.listAlerts({ limit: 100, includeResolved }) });
      return;
    }
    // 按笔记互动历史（V1 task 9.2）：可选 ?accountId 过滤。
    if (method === 'GET' && url === '/api/monitor/interactions') {
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const accountId = query.get('accountId') ?? undefined;
      sendJson(res, 200, {
        interactions: await deps.panelStore.listInteractions({ limit: 100, ...(accountId ? { accountId } : {}) }),
      });
      return;
    }
    // token 用量统计（change llm-token-usage-stats）：一端点返「表格行(按北京日×四维)」+「10 分钟曲线桶」。
    // 纯只读；可选 from/to(epoch ms) + accountId/role/model 过滤；服务端默认窗(近24h)+硬上限(31天)。未注入则 503。
    if (method === 'GET' && url === '/api/llm-usage') {
      if (!deps.tokenUsage) {
        sendJson(res, 503, { error: 'token_usage_unavailable' });
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const numOf = (k: string): number | undefined => {
        const v = query.get(k);
        if (v == null || v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const fromMs = numOf('from');
      const toMs = numOf('to');
      const accountId = query.get('accountId') ?? undefined;
      const role = query.get('role') ?? undefined;
      const provider = query.get('provider') ?? undefined;
      const model = query.get('model') ?? undefined;
      sendJson(
        res,
        200,
        await deps.tokenUsage.usage({
          ...(fromMs !== undefined ? { fromMs } : {}),
          ...(toMs !== undefined ? { toMs } : {}),
          ...(accountId ? { accountId } : {}),
          ...(role ? { role } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        }),
      );
      return;
    }

    // 通知联系人名册（change notification-contact-registry）：联系人列表。
    // accountId 给定＝按账号过滤；缺省＝全账号合并视图（运营便利，每行带 accountId、写入按行账号路由隔离）。
    // 未注入 503；缺表由 store 回落空。
    if (method === 'POST' && url === '/api/llm-usage/prices/refresh') {
      if (!deps.billingPriceRefresh) {
        sendJson(res, 503, { error: 'billing_price_refresh_unavailable' });
        return;
      }
      sendJson(res, 200, await deps.billingPriceRefresh.refresh());
      return;
    }

    if (method === 'GET' && url === '/api/notification/contacts') {
      if (!deps.notificationContact) {
        sendJson(res, 503, { error: 'notification_contact_unavailable' });
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const accountId = (query.get('accountId') ?? '').trim() || undefined;
      const numOf = (k: string, dflt: number): number => {
        const v = query.get(k);
        if (v == null || v === '') return dflt;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : dflt;
      };
      const contacts = await deps.notificationContact.listContacts(accountId, numOf('limit', 200), numOf('offset', 0));
      sendJson(res, 200, { contacts });
      return;
    }

    // 团队 → 群路由列表（change feishu-per-team-notification-routing）：读全部 group_label→chat 映射。
    if (method === 'GET' && url === '/api/notification/routes') {
      if (!deps.notificationRoutes) {
        sendJson(res, 503, { error: 'notification_routes_unavailable' });
        return;
      }
      const routes = await deps.notificationRoutes.listRoutes();
      sendJson(res, 200, { routes });
      return;
    }

    if (method === 'GET' && url === '/api/approval-policies') {
      if (!deps.approvalPolicies) {
        sendJson(res, 503, { error: 'approval_policies_unavailable' });
        return;
      }
      sendJson(res, 200, await deps.approvalPolicies.list());
      return;
    }

    // 机器人当前所在群（change feishu-per-team-notification-routing / feishu-bot-chat-name-display）：
    // 供路由配置从真实所在群下拉选目标（杜绝手贴 raw chat_id 贴错群 → 跨客户 PII 泄漏）。目标为 opaque chat_id（非枚举）。
    // provider 注入时实时取飞书真实群名 + 标默认群 + 降级来源；未注入则回落 bot_chats 表（老形状、群名可能空）。
    if (method === 'GET' && url === '/api/bot-chats') {
      if (deps.botChats) {
        sendJson(res, 200, await deps.botChats.list());
        return;
      }
      const active = await deps.botChatStore.listActive();
      sendJson(res, 200, {
        chats: active.map((c) => ({ chatId: c.chatId, name: c.chatName, isDefault: c.isDefault })),
        defaultChatId: active.find((c) => c.isDefault)?.chatId ?? null,
        source: 'store' as const,
      });
      return;
    }

    // ── 写操作（task 4）：经拥有写的对象，绝不乐观假成功 ──────────────────
    if (method === 'POST' && url.startsWith('/api/publish/') && url.endsWith('/approve')) {
      const requestId = decodeURIComponent(url.slice('/api/publish/'.length, -'/approve'.length));
      // requestId 白名单（change console-cloud-panel-hardening #29；理由由 publish-approval-signal-to-database 重述）：
      // requestId 是**持久授权记录的主键**与本接口的 URL 路径段（不再参与任何文件落盘路径拼接）。
      // 仅放行受控字符集 [A-Za-z0-9_-]，使标识符与路径段的注入面为零（真实审批 requestId 恒为
      // publish-<数字>，此集为其超集，向后兼容既有调用）。非法即 400、**不触发任何授权写入**。
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_request_id' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { approved, payload, contentVersion } = (body ?? {}) as {
        approved?: unknown;
        payload?: PublishApprovalPayload;
        contentVersion?: unknown;
      };
      if (typeof approved !== 'boolean') {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // 人授权的内容版本快照（edit-note-draft-before-publish）：控制台抽屉渲染时快照、随授权带回。缺省→0（部署兼容）。
      const authorizedVersion =
        typeof contentVersion === 'number' && Number.isFinite(contentVersion) ? contentVersion : undefined;
      // 写时版本预检：仅授权(approved) + publish-<n> + 带版本 + 有读版本能力时。活版本 ≠ 授权版本 → 拒、不写签名。
      if (approved && authorizedVersion !== undefined && deps.publishDraft) {
        const m = /^publish-(\d+)$/.exec(requestId);
        if (m) {
          const live = await deps.publishDraft.liveVersion(Number(m[1]));
          if (live !== null && live !== authorizedVersion) {
            sendJson(res, 409, { error: 'version_stale', currentVersion: live });
            return;
          }
        }
      }
      // payload 对 Web 审批为占位（edge 从落库草稿读内容）；first-writer-wins 的决定才是关键。
      // contentVersion 随 payload 落盘：下发闸据此守「审=发」（缺省→0，未编辑草稿 0===0 照发）。
      const approvalPayload: PublishApprovalPayload = {
        ...(payload ?? { title: '', content: '', tags: [] }),
        contentVersion: authorizedVersion ?? 0,
      };
      if (approved && deps.preflightApprovePublish) {
        const preflight = await deps.preflightApprovePublish(requestId, approvalPayload);
        if (!preflight.ok) {
          sendJson(res, 409, {
            error: preflight.reason,
            reason: preflight.reason,
            ...(preflight.accountId ? { accountId: preflight.accountId } : {}),
          });
          return;
        }
      }
      // 真实决策人 = 本次请求的面板 JWT 主体（MUST NOT 常量占位）。
      const result = await deps.writeApprovalSignal(
        requestId,
        approved,
        approvalPayload,
        `panel:${verified.payload.sub}`,
      );
      if (!approved && (result.written || result.alreadyDecided === false)) {
        const m = /^publish-(\d+)$/.exec(requestId);
        if (m) await deps.publishLogStore.rejectPendingApproval(Number(m[1]));
      }
      sendJson(res, 200, result); // {written} 或 {alreadyDecided}，绝不 published
      return;
    }
    // 待审正文草稿就地编辑（change edit-note-draft-before-publish）：经拥有者对象单写、乐观 CAS、诚实非乐观。
    // 面板绝不 raw UPDATE；仅 pending_approval 可编、版本必须匹配、拒因→可区分 HTTP；成功回读真态（含自增后版本）。
    if (method === 'PUT' && url.startsWith('/api/publish/') && url.endsWith('/draft')) {
      if (!deps.publishDraft) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      const recordId = Number(decodeURIComponent(url.slice('/api/publish/'.length, -'/draft'.length)));
      if (!Number.isInteger(recordId) || recordId <= 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_record_id' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { expectedVersion, title, content, visibility, topics, images } = (body ?? {}) as {
        expectedVersion?: unknown;
        title?: unknown;
        content?: unknown;
        visibility?: unknown;
        topics?: unknown;
        images?: unknown;
      };
      if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_version' });
        return;
      }
      // 仅出现的字段进补丁；字段类型/红线细校验（clampTitle、可见范围枚举、topics 数组）由 store 单写一处统一做。
      const patch: EditDraftPatch = {};
      if (title !== undefined) patch.title = title as string;
      if (content !== undefined) patch.content = content as string;
      if (visibility !== undefined) patch.visibility = visibility as string;
      if (topics !== undefined) patch.topics = topics as string[];
      // images 补丁（pending-draft-image-delete）：删配图的保留子集；类型/子集红线校验由 store 单写一处统一做。
      if (images !== undefined) patch.images = images as string[];
      if (Object.keys(patch).length === 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'empty_patch' });
        return;
      }
      // 授权在途 fast-fail（签名已存在）→ already_decided（暂态；下发兜底作废过期签名后草稿回可编辑）。
      if (await deps.publishDraft.hasDecision(recordId)) {
        sendJson(res, 409, { error: 'already_decided' });
        return;
      }
      const result = await deps.publishDraft.edit(recordId, expectedVersion, patch, verified.payload.sub);
      if (!result.ok) {
        const status =
          result.reason === 'not_found'
            ? 404
            : result.reason === 'version_conflict' || result.reason === 'not_pending'
              ? 409
              : result.reason === 'missing_visibility'
                ? 422
                : 400; // invalid_title / invalid_field
        sendJson(res, status, { error: result.reason });
        return;
      }
      deps.notifyPublishPreviewChanged?.(recordId);
      sendJson(res, 200, {
        recordId,
        contentVersion: result.contentVersion,
        title: result.title,
        content: result.content,
        metadata: result.metadata,
        images: result.images,
      });
      return;
    }
    if (method === 'POST' && url.startsWith('/api/accounts/') && url.endsWith('/command')) {
      const accountId = decodeURIComponent(url.slice('/api/accounts/'.length, -'/command'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { command } = (body ?? {}) as { command?: unknown };
      if (command === 'pause' || command === 'resume') {
        // 存在性校验先行（#28）：不存在账号 → 404，绝不经 ON CONFLICT 造幽灵账号行 + 假成功。
        if (!(await assertAccountExists(accountId, res))) return;
        sendJson(
          res,
          200,
          command === 'pause'
            ? await deps.commandActions.pause(accountId)
            : await deps.commandActions.resume(accountId),
        );
        return;
      }
      sendJson(res, 400, { error: 'bad_request', reason: 'unknown_command' });
      return;
    }
    // 账号分组标签写（change editable-account-group-label）：经账号存储单写（accounts 表拥有者），
    // 绝不 raw UPDATE、绝不乐观假成功；空归 NULL（清空）、无行 404、退役账号拒、写后回读真态。
    if (method === 'PUT' && url.startsWith('/api/accounts/') && url.endsWith('/group-label')) {
      const accountId = decodeURIComponent(url.slice('/api/accounts/'.length, -'/group-label'.length));
      if (!deps.accountAttr) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { groupLabel } = (body ?? {}) as { groupLabel?: unknown };
      // groupLabel 只接受 string | null | 缺省（缺省/ null / 空串 = 清空）；其它类型诚实拒。
      if (groupLabel !== undefined && groupLabel !== null && typeof groupLabel !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_group_label' });
        return;
      }
      const label = typeof groupLabel === 'string' ? groupLabel : null;
      const result = await deps.accountAttr.setGroupLabel(accountId, label);
      if (!result.ok) {
        if (result.reason === 'account_not_found') sendJson(res, 404, { error: 'account_not_found' });
        else sendJson(res, 400, { error: 'bad_request', reason: result.reason }); // retired_account
        return;
      }
      sendJson(res, 200, { accountId, groupLabel: result.groupLabel });
      return;
    }
    // 团队 → 群路由写（change feishu-per-team-notification-routing）：按团队键 upsert / 清除（chat_id 空 = 清除该路由）。
    // 经 group_route 存储单写：非法键（空 groupLabel）拒、写后回读真态、绝不乐观假成功。目标为 opaque chat_id（非枚举）。
    if (method === 'PUT' && url === '/api/notification/routes') {
      if (!deps.notificationRoutes) {
        sendJson(res, 503, { error: 'notification_routes_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { groupLabel, chatId } = (body ?? {}) as { groupLabel?: unknown; chatId?: unknown };
      if (typeof groupLabel !== 'string' || groupLabel.trim() === '') {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_group_label' });
        return;
      }
      // chatId 只接受 string | null | 缺省（缺省 / null / 空串 = 清除该团队路由）；其它类型诚实拒。
      if (chatId !== undefined && chatId !== null && typeof chatId !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_chat_id' });
        return;
      }
      const target = typeof chatId === 'string' ? chatId : null;
      const result = await deps.notificationRoutes.setRoute(groupLabel, target, verified.payload.sub);
      if (!result.ok) {
        sendJson(res, 400, { error: 'bad_request', reason: result.reason }); // invalid_key
        return;
      }
      sendJson(res, 200, { route: result.route }); // 写后回读真态（route=null 表已清除）
      return;
    }
    if (method === 'PUT' && url === '/api/approval-policies/account-comment') {
      if (!deps.approvalPolicies) {
        sendJson(res, 503, { error: 'approval_policies_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { accountId, mode } = (body ?? {}) as { accountId?: unknown; mode?: unknown };
      if (typeof accountId !== 'string' || !accountId.trim() || (mode !== 'source_rules' && mode !== 'auto_approve_all')) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_account_comment_policy' });
        return;
      }
      const result = await deps.approvalPolicies.setAccountCommentMode(accountId, mode, verified.payload.sub);
      if (!result.ok) {
        sendJson(res, result.reason === 'account_not_found' ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, { policy: result.row });
      return;
    }
    if (method === 'PUT' && url === '/api/approval-policies/group-publish') {
      if (!deps.approvalPolicies) {
        sendJson(res, 503, { error: 'approval_policies_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { groupLabel, delivery } = (body ?? {}) as { groupLabel?: unknown; delivery?: unknown };
      if (
        typeof groupLabel !== 'string' || !groupLabel.trim()
        || (delivery !== 'client_and_feishu' && delivery !== 'client_only')
      ) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_group_publish_policy' });
        return;
      }
      const result = await deps.approvalPolicies.setGroupPublishDelivery(groupLabel, delivery, verified.payload.sub);
      if (!result.ok) {
        sendJson(res, result.reason === 'group_not_found' ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, { policy: result.row });
      return;
    }
    // 账号「联系方式」写（change account-group-chat-injection → generalize-contact-info）：经账号存储单写（accounts 表拥有者），
    // **verbatim——不 trim / 不截断**；绝不 raw UPDATE、绝不乐观假成功；空归 NULL（清空）、无行 404、退役账号拒、写后回读真态。
    // 过渡期同时受理新路径 /contact-info 与旧路径 /group-chat-info（滚动升级期旧 console 仍可能命中旧路径 + 旧 DTO 字段）。
    if (
      method === 'PUT' &&
      url.startsWith('/api/accounts/') &&
      (url.endsWith('/contact-info') || url.endsWith('/group-chat-info'))
    ) {
      const suffix = url.endsWith('/contact-info') ? '/contact-info' : '/group-chat-info';
      const accountId = decodeURIComponent(url.slice('/api/accounts/'.length, -suffix.length));
      if (!deps.accountAttr?.setContactInfo) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // DTO 字段 contactInfo（新契约）；过渡期同时受理旧字段 groupChatInfo。string | null | 缺省（缺省 / null / 空串 = 清空）；其它类型诚实拒。
      const raw = (body ?? {}) as { contactInfo?: unknown; groupChatInfo?: unknown };
      const contactInfo = raw.contactInfo !== undefined ? raw.contactInfo : raw.groupChatInfo;
      if (contactInfo !== undefined && contactInfo !== null && typeof contactInfo !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_contact_info' });
        return;
      }
      // verbatim：不 trim——原样透传给存储（存储只用 trim 判空决定清空 vs 设值）。
      const info = typeof contactInfo === 'string' ? contactInfo : null;
      const result = await deps.accountAttr.setContactInfo(accountId, info);
      if (!result.ok) {
        if (result.reason === 'account_not_found') sendJson(res, 404, { error: 'account_not_found' });
        else sendJson(res, 400, { error: 'bad_request', reason: result.reason }); // retired_account
        return;
      }
      sendJson(res, 200, { accountId, contactInfo: result.contactInfo });
      return;
    }
      // Facebook 定时评论配置写：关键词 + 评论模式 / 模板；legacy containers 仍接受以兼容旧面板/回滚。
    // 经独立 store 单写：非法整块拒、退役 / 无账号可区分、写后回读真态；绝不乐观假成功。
    if (method === 'PUT' && url.startsWith('/api/accounts/') && url.endsWith('/facebook-comment-config')) {
      const accountId = decodeURIComponent(
        url.slice('/api/accounts/'.length, -'/facebook-comment-config'.length),
      );
      if (!deps.facebookCommentConfig) {
        sendJson(res, 503, { error: 'unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { keywords, containers, commentMode, commentTemplates } = (body ?? {}) as {
        keywords?: unknown;
        containers?: unknown;
        commentMode?: unknown;
        commentTemplates?: unknown;
      };
      const result = await deps.facebookCommentConfig.set(
        accountId,
        {
          keywords: keywords as string[] | undefined,
          // 容器可传裸 url 字符串（向后兼容）或 {url,name}；store 侧 sanitize/coerce 统一处理。
          containers: containers as Array<string | { url: string; name?: string }> | undefined,
          commentMode: commentMode as 'generated' | 'template' | undefined,
          commentTemplates: commentTemplates as string[] | undefined,
        },
        `panel:${verified.payload.sub}`,
      );
      if (!result.ok) {
        if (result.reason === 'account_not_found') sendJson(res, 404, { error: 'account_not_found' });
        else sendJson(res, 400, { error: 'bad_request', reason: result.reason }); // invalid_value / no_valid_fields / retired_account
        return;
      }
      sendJson(res, 200, result.row);
      return;
    }
    // 风控写（V1 task 8.4）：经 registry 取账号 controller 单写；status 经枚举信号种类、quota 经 setQuotaLevel
    if (method === 'POST' && url.startsWith('/api/accounts/') && url.endsWith('/risk/status')) {
      const accountId = decodeURIComponent(url.slice('/api/accounts/'.length, -'/risk/status'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { kind, reason } = (body ?? {}) as { kind?: unknown; reason?: unknown };
      const ALLOWED: RiskSignalKind[] = ['manual_restrict', 'manual_freeze', 'operator_override_recover'];
      if (typeof kind !== 'string' || !(ALLOWED as string[]).includes(kind)) {
        sendJson(res, 400, { error: 'bad_request', reason: 'unknown_kind' });
        return;
      }
      // operator_override_recover 绕过恢复窗口，必须带审计理由
      if (kind === 'operator_override_recover' && (typeof reason !== 'string' || !reason.trim())) {
        sendJson(res, 400, { error: 'bad_request', reason: 'override_requires_audit_reason' });
        return;
      }
      // 存在性校验先行（#28）：不存在账号 → 404，绝不经 saveState 的 ON CONFLICT 造幽灵 risk_state 行。
      if (!(await assertAccountExists(accountId, res))) return;
      // change risk-target-follows-active-session：风控写改回账号级，不再前置「非属主 409」。
      const controller = await deps.riskRegistry.getController(accountId);
      const before = controller.getState().status;
      const after = await controller.applySignal({
        kind: kind as RiskSignalKind,
        ...(typeof reason === 'string' ? { reason } : {}),
      });
      // 诚实：返回写后真态 + 是否真变化（refused 由前端按 changed=false 渲染，区别于成功）
      sendJson(res, 200, { state: after, statusBefore: before, changed: before !== after.status });
      return;
    }
    if (method === 'POST' && url.startsWith('/api/accounts/') && url.endsWith('/risk/quota')) {
      const accountId = decodeURIComponent(url.slice('/api/accounts/'.length, -'/risk/quota'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { level } = (body ?? {}) as { level?: unknown };
      const LEVELS: RiskQuotaLevel[] = ['conservative', 'normal', 'aggressive'];
      if (typeof level !== 'string' || !(LEVELS as string[]).includes(level)) {
        sendJson(res, 400, { error: 'bad_request', reason: 'unknown_level' });
        return;
      }
      // 存在性校验先行（#28）：同上，杜绝对不存在账号造幽灵风控行 + 假成功。
      if (!(await assertAccountExists(accountId, res))) return;
      // change risk-target-follows-active-session：配额档写改回账号级，不再前置「非属主 409」。
      const controller = await deps.riskRegistry.getController(accountId);
      sendJson(res, 200, { state: await controller.setQuotaLevel(level as RiskQuotaLevel) });
      return;
    }
    // 调度启停（V1 task 9.4）：复用共享 CommandActions；回报真实在线 edge 数，绝不乐观。
    // 偏离：当前单全局 RoleDispatcher（非 per-edge），accountId 为信息性；per-edge 拆分见 design 步骤 8。
    if (method === 'POST' && url.startsWith('/api/accounts/') && url.endsWith('/dispatch')) {
      const accountId = decodeURIComponent(url.slice('/api/accounts/'.length, -'/dispatch'.length));
      if (!deps.commandActions.dispatch) {
        sendJson(res, 503, { error: 'dispatch_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { action } = (body ?? {}) as { action?: unknown };
      if (action !== 'start' && action !== 'stop') {
        sendJson(res, 400, { error: 'bad_request', reason: 'unknown_action' });
        return;
      }
      sendJson(res, 200, await deps.commandActions.dispatch(accountId, action));
      return;
    }

    // ── 视频号互动权限只读概览（change wechat-panel-permission-visibility）──
    if (method === 'GET' && url === '/api/config/interaction-permissions') {
      if (!deps.interactionPermissions) {
        sendJson(res, 503, { error: 'interaction_permissions_unavailable' });
        return;
      }
      sendJson(res, 200, deps.interactionPermissions.getView());
      return;
    }

    // ── 模型与凭据配置（change console-model-provider-config）──────────────
    // 明文密钥绝不回传；写非乐观；主密钥缺失诚实 503，绝不假成功。
    if (url === '/api/config/model') {
      if (!deps.modelConfig) {
        sendJson(res, 503, { error: 'model_config_unavailable' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, await deps.modelConfig.getView());
        return;
      }
      if (method === 'PUT') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        // change model-config-volcengine-provider：可改 textProvider（全局文本厂商）。
        // change image-provider-volcengine-seedream：可改 imageProvider（全局图片厂商）。
        const { textProvider, textModel, imageModel, imageProvider } = (body ?? {}) as {
          textProvider?: unknown;
          textModel?: unknown;
          imageModel?: unknown;
          imageProvider?: unknown;
        };
        // 至少一个非空字符串字段；空 / 非字符串一律不接受（不静默忽略全空请求）
        const patch: { textProvider?: string; textModel?: string; imageModel?: string; imageProvider?: string } = {};
        if (typeof textProvider === 'string' && textProvider.trim()) patch.textProvider = textProvider.trim();
        if (typeof textModel === 'string' && textModel.trim()) patch.textModel = textModel.trim();
        if (typeof imageModel === 'string' && imageModel.trim()) patch.imageModel = imageModel.trim();
        if (typeof imageProvider === 'string' && imageProvider.trim()) patch.imageProvider = imageProvider.trim();
        if (Object.keys(patch).length === 0) {
          sendJson(res, 400, { error: 'bad_request', reason: 'no_valid_fields' });
          return;
        }
        const result = await deps.modelConfig.setModel(patch, verified.payload.sub);
        if (!result.ok) {
          // 厂商未知 / 模型探活失败 / 该厂商密钥缺失：诚实 400，绝不落库、绝不假成功
          sendJson(res, 400, { error: result.reason });
          return;
        }
        sendJson(res, 200, result.view);
        return;
      }
    }
    if (method === 'PUT' && url === '/api/config/credential') {
      if (!deps.modelConfig) {
        sendJson(res, 503, { error: 'model_config_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // change platform-provider-credentials-config：按平台凭据写密钥；(provider, field) 须在注册表派生的白名单内。
      const { provider, field, value } = (body ?? {}) as {
        provider?: unknown;
        field?: unknown;
        value?: unknown;
      };
      if (typeof provider !== 'string' || typeof field !== 'string' || !isAllowedPlatformCredential(provider, field)) {
        sendJson(res, 400, { error: 'bad_request', reason: 'unknown_field' });
        return;
      }
      if (typeof value !== 'string' || !value.trim()) {
        sendJson(res, 400, { error: 'bad_request', reason: 'empty_value' });
        return;
      }
      const result = await deps.modelConfig.setCredential(provider, field, value.trim(), verified.payload.sub);
      if (!result.ok) {
        // 主密钥缺失：诚实报因，绝不明文落库、绝不假成功
        sendJson(res, 503, { error: result.reason });
        return;
      }
      sendJson(res, 200, {
        provider: result.provider,
        field: result.field,
        configured: true,
        maskedHint: result.maskedHint,
      });
      return;
    }

    // ── 角色级模型/温度配置（change console-role-model-config）──────────────
    // 白名单制；写非乐观回真态；非空模型名探活不过诚实 400 model_invalid，绝不落库。
    if (method === 'GET' && url === '/api/roles') {
      if (!deps.roleConfig) {
        sendJson(res, 503, { error: 'role_config_unavailable' });
        return;
      }
      sendJson(res, 200, deps.roleConfig.getCatalog());
      return;
    }
    if (method === 'PUT' && url.startsWith('/api/roles/') && url.endsWith('/config')) {
      if (!deps.roleConfig) {
        sendJson(res, 503, { error: 'role_config_unavailable' });
        return;
      }
      const roleId = decodeURIComponent(url.slice('/api/roles/'.length, -'/config'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // change model-config-volcengine-provider：provider 跟 model 同发（写 model 时按此 provider 探活并落库）。
      // change role-thinking-mode-config：thinkingMode 独立可发（'default'|'off'|'on' 或 null）。
      const { model, provider, temperature, thinkingMode } = (body ?? {}) as {
        model?: unknown;
        provider?: unknown;
        temperature?: unknown;
        thinkingMode?: unknown;
      };
      const patch: {
        model?: string | null;
        provider?: string | null;
        temperature?: number | null;
        thinkingMode?: string | null;
      } = {};
      if (model !== undefined) {
        if (model === null || typeof model === 'string') patch.model = model;
        else {
          sendJson(res, 400, { error: 'bad_request', reason: 'model_type' });
          return;
        }
      }
      if (provider !== undefined) {
        if (provider === null || typeof provider === 'string') patch.provider = provider;
        else {
          sendJson(res, 400, { error: 'bad_request', reason: 'provider_type' });
          return;
        }
      }
      if (temperature !== undefined) {
        if (temperature === null || typeof temperature === 'number') patch.temperature = temperature;
        else {
          sendJson(res, 400, { error: 'bad_request', reason: 'temperature_type' });
          return;
        }
      }
      if (thinkingMode !== undefined) {
        if (thinkingMode === null || typeof thinkingMode === 'string') patch.thinkingMode = thinkingMode;
        else {
          sendJson(res, 400, { error: 'bad_request', reason: 'thinking_mode_type' });
          return;
        }
      }
      if (patch.model === undefined && patch.temperature === undefined && patch.thinkingMode === undefined) {
        sendJson(res, 400, { error: 'bad_request', reason: 'no_valid_fields' });
        return;
      }
      const result = await deps.roleConfig.setRoleConfig(roleId, patch, verified.payload.sub);
      if (!result.ok) {
        // unknown_role→404；其余校验/探活失败→400（绝不落库、绝不假成功）
        sendJson(res, result.reason === 'unknown_role' ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, result.view);
      return;
    }

    // ── 分类级模型默认配置（change role-model-category-config，item 5/6）──────────
    // reserved-order append 链首 C；白名单制；写非乐观回真态；非空模型名探活不过诚实 400 model_invalid，绝不落库。
    if (method === 'GET' && url === '/api/categories') {
      if (!deps.categoryConfig) {
        sendJson(res, 503, { error: 'category_config_unavailable' });
        return;
      }
      sendJson(res, 200, deps.categoryConfig.getCatalog());
      return;
    }
    if (method === 'PUT' && url.startsWith('/api/categories/') && url.endsWith('/config')) {
      if (!deps.categoryConfig) {
        sendJson(res, 503, { error: 'category_config_unavailable' });
        return;
      }
      const categoryId = decodeURIComponent(url.slice('/api/categories/'.length, -'/config'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // change model-config-volcengine-provider：provider 跟 model 同发。
      // change role-thinking-mode-config：thinkingMode 独立可发；model 不再必填（可只改思考模式）。
      const { model, provider, thinkingMode } = (body ?? {}) as {
        model?: unknown;
        provider?: unknown;
        thinkingMode?: unknown;
      };
      const patch: { model?: string | null; provider?: string | null; thinkingMode?: string | null } = {};
      if (model !== undefined) {
        if (model === null || typeof model === 'string') patch.model = model;
        else {
          sendJson(res, 400, { error: 'bad_request', reason: 'model_type' });
          return;
        }
      }
      if (provider !== undefined) {
        if (provider === null || typeof provider === 'string') patch.provider = provider;
        else {
          sendJson(res, 400, { error: 'bad_request', reason: 'provider_type' });
          return;
        }
      }
      if (thinkingMode !== undefined) {
        if (thinkingMode === null || typeof thinkingMode === 'string') patch.thinkingMode = thinkingMode;
        else {
          sendJson(res, 400, { error: 'bad_request', reason: 'thinking_mode_type' });
          return;
        }
      }
      if (patch.model === undefined && patch.thinkingMode === undefined) {
        sendJson(res, 400, { error: 'bad_request', reason: 'no_valid_fields' });
        return;
      }
      const result = await deps.categoryConfig.setCategoryConfig(
        categoryId,
        patch,
        verified.payload.sub,
      );
      if (!result.ok) {
        // unknown_category→404；其余（不可配 / 探活失败）→400（绝不落库、绝不假成功）
        sendJson(res, result.reason === 'unknown_category' ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, result.view);
      return;
    }

    // ── 角色 prompt 只读预览（change role-prompt-visibility）──────────────────
    // 纯只读，无写路径；未知角色 404；非文本/无预览/渲染失败 → 200 + available:false 诚实标注。
    if (method === 'GET' && url.startsWith('/api/roles/') && url.endsWith('/prompt')) {
      if (!deps.rolePromptPreview) {
        sendJson(res, 503, { error: 'role_prompt_preview_unavailable' });
        return;
      }
      const roleId = decodeURIComponent(url.slice('/api/roles/'.length, -'/prompt'.length));
      if (!isKnownRole(roleId)) {
        sendJson(res, 404, { error: 'unknown_role' });
        return;
      }
      // 人设选择框（change prompt-preview-persona-selector）：可选 ?accountId= 按选定账号人设渲染。
      // 缺省/未知账号不报错——透传 provider 按诚实回落标注处理（预览是只读探查，不该 4xx 挡路）。
      const promptQuery = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const promptAccountId = promptQuery.get('accountId') ?? undefined;
      sendJson(res, 200, deps.rolePromptPreview.get(roleId, promptAccountId));
      return;
    }

    // ── 安全限额配置（change safety-quota-config，stream D）──────────────────────
    // reserved-order append 链 D（在 C/categories 之后、F/persona 之前）。写非乐观回真态；
    // 非法数字整块拒（invalid_value→400），绝不部分落库；不碰风控状态单写路径。
    if (method === 'GET' && url === '/api/quotas') {
      if (!deps.quotaConfig) {
        sendJson(res, 503, { error: 'quota_config_unavailable' });
        return;
      }
      sendJson(res, 200, deps.quotaConfig.getCatalog());
      return;
    }
    // ── 配置镜像健康只读投影（change config-mirror-cross-process-invalidation task 6.4）──────
    // 每个 mirrorKey 的 lastComparedAt / 当前版本 / fresh|stale。回包带 asOf = **数据时刻**，
    // 与响应时刻分开表达。刷新器未接线 → 503 诚实不可用，绝不回一个「全都新鲜」的空投影。
    if (method === 'GET' && url === '/api/config-mirrors') {
      if (!deps.configMirrorHealth) {
        sendJson(res, 503, { error: 'config_mirror_health_unavailable' });
        return;
      }
      sendJson(res, 200, deps.configMirrorHealth());
      return;
    }
    if (method === 'PUT' && url === '/api/quotas') {
      if (!deps.quotaConfig) {
        sendJson(res, 503, { error: 'quota_config_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { tier, action, daily, perMinute, perHour } = (body ?? {}) as {
        tier?: unknown;
        action?: unknown;
        daily?: unknown;
        perMinute?: unknown;
        perHour?: unknown;
      };
      if (typeof tier !== 'string' || typeof action !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'tier_action_type' });
        return;
      }
      // 窗口值须为数字或缺省（缺省=该窗口不改）；类型不对直接 400。
      const win: { daily?: number; perMinute?: number; perHour?: number } = {};
      for (const [k, v] of [['daily', daily], ['perMinute', perMinute], ['perHour', perHour]] as const) {
        if (v === undefined) continue;
        if (typeof v !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        win[k] = v;
      }
      const result = await deps.quotaConfig.setQuota(
        { tier: tier as never, action: action as never, ...win },
        verified.payload.sub,
      );
      if (!result.ok) {
        // unknown_tier/unknown_action→404；invalid_value/no_valid_fields→400（绝不部分落库、绝不假成功）。
        const notFound = result.reason === 'unknown_tier' || result.reason === 'unknown_action';
        sendJson(res, notFound ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, result.view);
      return;
    }

    // ── 操作兜底 floor 配置（change pacing-floor-config-min-interval）──────────────
    // 四类操作最小间隔兜底区间 {minMs,maxMs}，全局一套。写非乐观回真态；非法整块拒
    // （unknown_operation→404 / invalid_value/no_valid_fields→400），绝不部分落库；生效值经读出口 clamp
    // （含非零防呆下限护栏），配置只能抬高延迟、抬不穿非零下限；不碰风控状态单写路径。
    if (method === 'GET' && url === '/api/pacing') {
      if (!deps.pacingConfig) {
        sendJson(res, 503, { error: 'pacing_unavailable' });
        return;
      }
      sendJson(res, 200, deps.pacingConfig.getCatalog());
      return;
    }
    if (method === 'PUT' && url === '/api/pacing') {
      if (!deps.pacingConfig) {
        sendJson(res, 503, { error: 'pacing_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { operation, minMs, maxMs } = (body ?? {}) as {
        operation?: unknown;
        minMs?: unknown;
        maxMs?: unknown;
      };
      if (typeof operation !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'operation_type' });
        return;
      }
      // 区间两端须为数字（缺省=该值不改，交 facade 判 no_valid_fields / invalid_value）；类型不对直接 400。
      const patch: { minMs?: number; maxMs?: number } = {};
      for (const [k, v] of [['minMs', minMs], ['maxMs', maxMs]] as const) {
        if (v === undefined) continue;
        if (typeof v !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch[k] = v;
      }
      const result = await deps.pacingConfig.setPacing(
        { operation: operation as never, minMs: patch.minMs as never, maxMs: patch.maxMs as never },
        verified.payload.sub,
      );
      if (!result.ok) {
        // unknown_operation→404；invalid_value/no_valid_fields→400（绝不部分落库、绝不假成功）。
        const notFound = result.reason === 'unknown_operation';
        sendJson(res, notFound ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, result.view);
      return;
    }

    // ── 单场会话上限配置（全局单例，change restore-auto-resume-and-global-safety-config）──────
    // append 链（在 D/quotas 之后、F/persona 之前）。全局写非乐观回真态；非法数字整块拒
    // （invalid_value→400），绝不部分落库；只写 session_config_global，不碰风控状态单写路径。
    // ── 内容排期（change content-schedule-auto-publish，Phase 1 只发帖）──────
    // 全局内容格 + 每账号排期。写非乐观回真态、非法整块拒、写前校验账号存在防幽灵行；未注入 503。
    // 顺序：/global 精确匹配须在 /:accountId 前缀前（否则 'global' 被当账号 id）。
    if (method === 'GET' && url === '/api/content-schedule/global') {
      if (!deps.contentSchedule) {
        sendJson(res, 503, { error: 'content_schedule_unavailable' });
        return;
      }
      sendJson(res, 200, deps.contentSchedule.getGlobalView());
      return;
    }
    if (method === 'PUT' && url === '/api/content-schedule/global') {
      if (!deps.contentSchedule) {
        sendJson(res, 503, { error: 'content_schedule_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { contentActiveMask } = (body ?? {}) as { contentActiveMask?: unknown };
      // string | null | 缺省；168 长 / 字符校验在 store（非法整块拒）。
      if (contentActiveMask !== undefined && contentActiveMask !== null && typeof contentActiveMask !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
        return;
      }
      const mask = typeof contentActiveMask === 'string' ? contentActiveMask : null;
      const result = await deps.contentSchedule.setGlobal(mask, verified.payload.sub);
      if (!result.ok) {
        sendJson(res, 400, { error: result.reason }); // invalid_value / no_valid_fields
        return;
      }
      sendJson(res, 200, deps.contentSchedule.getGlobalView());
      return;
    }
    if (method === 'GET' && url === '/api/content-schedule') {
      if (!deps.contentSchedule) {
        sendJson(res, 503, { error: 'content_schedule_unavailable' });
        return;
      }
      sendJson(res, 200, { rows: await deps.contentSchedule.listCatalog() });
      return;
    }
    const joinGroupConfigMatch = url.match(/^\/api\/content-schedule\/(.+)\/join-group$/);
    if (method === 'PUT' && joinGroupConfigMatch) {
      if (!deps.contentSchedule?.setJoinGroupAutomation) {
        sendJson(res, 503, { error: 'content_schedule_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = (body ?? {}) as Record<string, unknown>;
      const patch: { enabled?: boolean; dailyCap?: number; weekMask?: string | null } = {};
      if (raw.enabled !== undefined) {
        if (typeof raw.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'bad_request', reason: 'invalid_value' });
          return;
        }
        patch.enabled = raw.enabled;
      }
      if (raw.dailyCap !== undefined) {
        if (typeof raw.dailyCap !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'invalid_value' });
          return;
        }
        patch.dailyCap = raw.dailyCap;
      }
      if ('weekMask' in raw) {
        if (raw.weekMask !== null && typeof raw.weekMask !== 'string') {
          sendJson(res, 400, { error: 'bad_request', reason: 'invalid_value' });
          return;
        }
        patch.weekMask = raw.weekMask as string | null;
      }
      const accountId = decodeURIComponent(joinGroupConfigMatch[1]);
      const result = await deps.contentSchedule.setJoinGroupAutomation(accountId, patch, verified.payload.sub);
      if (!result.ok) {
        if (result.reason === 'account_not_found') sendJson(res, 404, { error: 'account_not_found' });
        else sendJson(res, 400, { error: 'bad_request', reason: result.reason });
        return;
      }
      sendJson(res, 200, { joinGroupAutomation: result.joinGroupAutomation });
      return;
    }
    if (method === 'PUT' && url.startsWith('/api/content-schedule/')) {
      if (!deps.contentSchedule) {
        sendJson(res, 503, { error: 'content_schedule_unavailable' });
        return;
      }
      const accountId = decodeURIComponent(url.slice('/api/content-schedule/'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = (body ?? {}) as Record<string, unknown>;
      const patch: AccountContentSchedulePatch = {};
      for (const k of ['autoEnabled', 'postEnabled', 'commentEnabled', 'contactCommentEnabled'] as const) {
        const v = raw[k];
        if (v === undefined) continue;
        if (typeof v !== 'boolean') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch[k] = v;
      }
      for (const k of ['postMode', 'commentMode', 'contactCommentMode'] as const) {
        const v = raw[k];
        if (v === undefined) continue;
        if (!isContentScheduleActionMode(v)) {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch[k] = v;
      }
      if (raw.postDailyCap !== undefined) {
        if (typeof raw.postDailyCap !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch.postDailyCap = raw.postDailyCap;
      }
      if (raw.commentDailyCap !== undefined) {
        if (typeof raw.commentDailyCap !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch.commentDailyCap = raw.commentDailyCap;
      }
      if (raw.contactCommentDailyCap !== undefined) {
        if (typeof raw.contactCommentDailyCap !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch.contactCommentDailyCap = raw.contactCommentDailyCap;
      }
      for (const k of ['activeWeekMask', 'contentActiveMask'] as const) {
        if (!(k in raw)) continue;
        const m = raw[k];
        if (m !== null && typeof m !== 'string') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch[k] = m as string | null;
      }
      const result = await deps.contentSchedule.setAccount(accountId, patch, verified.payload.sub);
      if (!result.ok) {
        if (result.reason === 'account_not_found') sendJson(res, 404, { error: 'account_not_found' });
        else sendJson(res, 400, { error: 'bad_request', reason: result.reason }); // retired_account / invalid_value / no_valid_fields / no_contact_info
        return;
      }
      // 一码一号放松（loosen-group-comment-shared-code）：共用联系方式放行但带 sharedContactInfoWarning，前端如实提示防关联风险、绝不静默。
      sendJson(res, 200, result.sharedContactInfoWarning ? { ...result.row, sharedContactInfoWarning: true } : result.row);
      return;
    }

    if (method === 'GET' && url === '/api/session-limits') {
      if (!deps.sessionLimits) {
        sendJson(res, 503, { error: 'session_limits_unavailable' });
        return;
      }
      sendJson(res, 200, deps.sessionLimits.getView());
      return;
    }
    if (method === 'PUT' && url === '/api/session-limits') {
      if (!deps.sessionLimits) {
        sendJson(res, 503, { error: 'session_limits_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { maxDurationMin, likes, collects, follows, searches, comments, comment_likes, join_groups,
              collectSaveLikeDenom, followFansDenom, activeWeekMask } =
        (body ?? {}) as Record<string, unknown>;
      // 各数字字段须为数字或缺省（缺省=该项不改）；类型不对直接 400（语义校验在 facade）。全局配置、无账号维度。
      const patch: SessionLimitPatchInput = {};
      const numFields = ['maxDurationMin', 'likes', 'collects', 'follows', 'searches', 'comments', 'comment_likes', 'join_groups',
        'collectSaveLikeDenom', 'followFansDenom'] as const;
      const rawNums: Record<string, unknown> = {
        maxDurationMin,
        likes,
        collects,
        follows,
        searches,
        comments,
        comment_likes,
        join_groups,
        collectSaveLikeDenom,
        followFansDenom,
      };
      for (const k of numFields) {
        const v = rawNums[k];
        if (v === undefined) continue;
        if (typeof v !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch[k] = v;
      }
      // 「可活跃时间」周历掩码为字符串（非数字）：传了就必须是 string；168 长 / 字符校验在 facade。
      if (activeWeekMask !== undefined) {
        if (typeof activeWeekMask !== 'string') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch.activeWeekMask = activeWeekMask;
      }
      const result = await deps.sessionLimits.set(patch, verified.payload.sub);
      if (!result.ok) {
        // invalid_value / no_valid_fields → 400（绝不部分落库、绝不假成功）。
        sendJson(res, 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, result.view);
      return;
    }

    // ── 引流线索热度过滤阈值（全局单例，change feed-hot-lead-group-comment）──────
    if (method === 'GET' && url === '/api/hot-lead-config') {
      if (!deps.hotLeadConfig) {
        sendJson(res, 503, { error: 'hot_lead_config_unavailable' });
        return;
      }
      sendJson(res, 200, deps.hotLeadConfig.getView());
      return;
    }
    if (method === 'PUT' && url === '/api/hot-lead-config') {
      if (!deps.hotLeadConfig) {
        sendJson(res, 503, { error: 'hot_lead_config_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { postAgeMaxHours, velocityMin, minLikeFloor } = (body ?? {}) as Record<string, unknown>;
      const patch: HotLeadConfigPatchInput = {};
      const rawNums: Record<string, unknown> = { postAgeMaxHours, velocityMin, minLikeFloor };
      for (const k of ['postAgeMaxHours', 'velocityMin', 'minLikeFloor'] as const) {
        const v = rawNums[k];
        if (v === undefined) continue;
        if (typeof v !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch[k] = v;
      }
      const result = await deps.hotLeadConfig.set(patch, verified.payload.sub);
      if (!result.ok) {
        sendJson(res, 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, result.view);
      return;
    }

    // ── 自动续场护栏 + 看门狗阈值配置（全局单例，change restore-auto-resume-and-global-safety-config）──────
    // append 链。全局写非乐观回真态；非法数字整块拒（invalid_value→400），绝不部分落库；
    // 只写 resume_config_global，不碰风控状态单写路径。
    if (method === 'GET' && url === '/api/resume-config') {
      if (!deps.resumeConfig) {
        sendJson(res, 503, { error: 'resume_config_unavailable' });
        return;
      }
      sendJson(res, 200, deps.resumeConfig.getView());
      return;
    }
    if (method === 'PUT' && url === '/api/resume-config') {
      if (!deps.resumeConfig) {
        sendJson(res, 503, { error: 'resume_config_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const raw = (body ?? {}) as Record<string, unknown>;
      // 全局配置、无账号维度；各数字字段须为数字或缺省（缺省=该项不改）。
      const patch: ResumeConfigPatchInput = {};
      const numFields = [
        'restRatioPct',
        'activeWindowStartMin',
        'activeWindowEndMin',
        'dailyMaxSessions',
        'dailyMaxMinutes',
        'idleNudgeMs',
        'idleEndMs',
      ] as const;
      for (const k of numFields) {
        const v = raw[k];
        if (v === undefined) continue;
        if (typeof v !== 'number') {
          sendJson(res, 400, { error: 'bad_request', reason: 'value_type' });
          return;
        }
        patch[k] = v;
      }
      const result = await deps.resumeConfig.set(patch, verified.payload.sub);
      if (!result.ok) {
        sendJson(res, 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, result.view);
      return;
    }

    // ── 账号人设配置（change account-persona-config，stream F）──────────────────
    // reserved-order append 链 F（在 C/categories、D/quotas 之后）。写非乐观回真态；
    // 非法人设（soul 校验不过）诚实 400 persona_invalid 绝不落库；未知账号 404。
    if (method === 'GET' && url === '/api/persona') {
      if (!deps.persona) {
        sendJson(res, 503, { error: 'persona_unavailable' });
        return;
      }
      sendJson(res, 200, await deps.persona.getCatalog());
      return;
    }
    if (method === 'GET' && url.startsWith('/api/persona/')) {
      if (!deps.persona) {
        sendJson(res, 503, { error: 'persona_unavailable' });
        return;
      }
      const accountId = decodeURIComponent(url.slice('/api/persona/'.length));
      const detail = await deps.persona.getDetail(accountId);
      if (!detail) {
        sendJson(res, 404, { error: 'unknown_account' });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }
    if (method === 'PUT' && url.startsWith('/api/persona/')) {
      if (!deps.persona) {
        sendJson(res, 503, { error: 'persona_unavailable' });
        return;
      }
      const accountId = decodeURIComponent(url.slice('/api/persona/'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { persona } = (body ?? {}) as { persona?: unknown };
      // persona 必须存在且为字符串；空文本由 facade 解释为显式解绑（删 persona_config 行 → source=none）。
      if (typeof persona !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'persona_type' });
        return;
      }
      const result = await deps.persona.setPersona(accountId, persona, verified.payload.sub);
      if (!result.ok) {
        // unknown_account→404；persona_invalid→400（绝不落库、绝不假成功）。
        sendJson(res, result.reason === 'unknown_account' ? 404 : 400, { error: result.reason });
        return;
      }
      sendJson(res, 200, result.view);
      return;
    }

    // 通知联系人人工字段编辑（change notification-contact-registry）：只改 微信/备注/标签，只动侧表、绝不碰事件流水。
    // accountId/senderKey 取自 URL path（非 JWT，防越权指定账号）；updatedBy=JWT sub；严格校验、非法整块拒绝不部分落库。
    if (method === 'PUT' && url.startsWith('/api/notification/contacts/')) {
      if (!deps.notificationContact) {
        sendJson(res, 503, { error: 'notification_contact_unavailable' });
        return;
      }
      const rest = url.slice('/api/notification/contacts/'.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'sender_key_required' });
        return;
      }
      const accountId = decodeURIComponent(rest.slice(0, slash));
      const senderKey = decodeURIComponent(rest.slice(slash + 1));
      if (!accountId || !senderKey) {
        sendJson(res, 400, { error: 'bad_request', reason: 'account_or_sender_required' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { wechat, note, tags } = (body ?? {}) as { wechat?: unknown; note?: unknown; tags?: unknown };
      if (wechat != null && typeof wechat !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'wechat_type' });
        return;
      }
      if (note != null && typeof note !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'note_type' });
        return;
      }
      let tagList: string[] = [];
      if (tags != null) {
        if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
          sendJson(res, 400, { error: 'bad_request', reason: 'tags_type' });
          return;
        }
        tagList = Array.from(new Set((tags as string[]).map((t) => t.trim()).filter((t) => t.length > 0)));
        if (tagList.length > 20 || tagList.some((t) => t.length > 40)) {
          sendJson(res, 400, { error: 'invalid_value', reason: 'tags_bounds' });
          return;
        }
      }
      await deps.notificationContact.setManual(
        accountId,
        senderKey,
        { wechat: wechat ?? null, note: note ?? null, tags: tagList },
        verified.payload.sub,
      );
      sendJson(res, 200, { ok: true }); // 写后诚实回真态（upsert 成功）；console 刷新列表重取聚合行
      return;
    }

    // ── 精选内容后台管理（change curated-content-admin-page）──────────────────────
    // 只读检索（accountId 给定＝按账号；缺省＝全账号合并视图，每行带 account_id）+ 治理写。
    // 未注入 503；缺表 store 回落空。删/清把 account_id 强制进 WHERE 防越权（id 全局 SERIAL，故治理写仍账号必填）。
    // 静态后缀路由（/facets、/contents/clear-empty）排在 :id 动态匹配之前。
    if (method === 'GET' && url === '/api/curated/facets') {
      if (!deps.curatedContent) {
        sendJson(res, 503, { error: 'curated_unavailable' });
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const accountId = (query.get('accountId') ?? '').trim() || undefined;
      sendJson(res, 200, await deps.curatedContent.facetsForPanel(accountId));
      return;
    }
    if (method === 'POST' && url === '/api/curated/contents/clear-empty') {
      if (!deps.curatedContent) {
        sendJson(res, 503, { error: 'curated_unavailable' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const rawAccount = ((body ?? {}) as { accountId?: unknown }).accountId;
      const accountId = typeof rawAccount === 'string' ? rawAccount.trim() : '';
      if (!accountId) {
        sendJson(res, 400, { error: 'bad_request', reason: 'account_required' });
        return;
      }
      const deleted = await deps.curatedContent.clearEmptyBody(accountId);
      sendJson(res, 200, { deleted }); // 诚实回真实清理条数（可能因机器人并发写与预览不同）
      return;
    }
    // ── 精选笔记行级定向动作（change curated-note-actions）────────────────────────
    // POST /api/curated/contents/:id/create-post（参照洗稿创作）与 POST /api/curated/contents/:id/comment（定向评论）。
    // 行加载走 getOneForAccount（account_id 进 WHERE 防越权）；仅 note 行开放（comment 行未存源 noteId 无法定位）。
    // 响应为 awaiting_confirmation task；确认前不接管边端、不生成、不发布。
    if (method === 'POST' && url.startsWith('/api/curated/contents/') && (url.endsWith('/create-post') || url.endsWith('/comment'))) {
      if (!deps.curatedContent || !deps.delegatedTasks) {
        sendJson(res, 503, { error: 'curated_actions_unavailable' });
        return;
      }
      const action = url.endsWith('/create-post') ? 'create-post' : 'comment';
      const idRaw = decodeURIComponent(url.slice('/api/curated/contents/'.length, url.lastIndexOf('/')));
      const id = Number(idRaw);
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
      const parsed = (body ?? {}) as { accountId?: unknown; withContact?: unknown; useReferenceImages?: unknown };
      const accountId = typeof parsed.accountId === 'string' ? parsed.accountId.trim() : '';
      if (!accountId) {
        sendJson(res, 400, { error: 'bad_request', reason: 'account_required' });
        return;
      }
      const row = await deps.curatedContent.getOneForAccount(id, accountId);
      if (!row) {
        sendJson(res, 404, { error: 'not_found' }); // 不存在或跨账号不匹配——同一形状，绝不泄露他账号行存在性
        return;
      }
      if (action === 'create-post') {
        if (row.contentType !== 'image_text') {
          sendJson(res, 200, { triggered: false, reason: 'image_text_only' });
          return;
        }
        // 历史/异常壳行红线：空正文不得作洗稿参照，触发前诚实拒绝。
        if (!(row.body ?? '').trim()) {
          sendJson(res, 200, { triggered: false, reason: 'empty_body' });
          return;
        }
        const useReferenceImages = parsed.useReferenceImages === true;
        try {
          const result = await deps.delegatedTasks.createDraft({
            accountId,
            action: 'publish_post',
            targetSuccessCount: 1,
            maxAttempts: 2,
            deadlineAt: Date.now() + 24 * 60 * 60 * 1000,
            executionWindow: { mode: 'immediate' },
            // 专用服务端入口产生的人工单篇洗稿；通用建任务路由会把客户端自报来源收口回 console。
            source: 'operator_action',
            sourceRef: `curated:${id}:create-post`,
            sourceConstraints: {
              curatedId: id,
              sourceId: row.sourceId,
              title: row.title ?? '',
              body: row.body ?? '',
              author: row.author ?? '',
              sourceUrl: row.sourceUrl ?? '',
              topics: row.topics,
              useReferenceImages,
              ...(useReferenceImages && row.referenceImages.length > 0
                ? { referenceImages: JSON.parse(JSON.stringify(row.referenceImages)) as JsonValue }
                : {}),
              ...(useReferenceImages && row.visualAnalysis
                ? { visualAnalysis: JSON.parse(JSON.stringify(row.visualAnalysis)) as JsonValue }
                : {}),
              ...(useReferenceImages && row.textCardTranscription
                ? { textCardTranscription: JSON.parse(JSON.stringify(row.textCardTranscription)) as JsonValue }
                : {}),
            },
            targetConstraints: {},
            approvalMode: 'review',
            priority: 'normal',
          });
          sendJson(res, result.created ? 201 : 200, result);
        } catch (err) {
          sendDelegatedTaskError(res, err);
        }
        return;
      }
      if (!isCuratedSourcePostType(row.contentType)) {
        sendJson(res, 200, { triggered: false, reason: 'source_post_only' });
        return;
      }
      if (!(row.title ?? '').trim()) {
        // 定向评论靠标题搜索定位：无标题无从搜起。
        sendJson(res, 200, { triggered: false, reason: 'empty_title' });
        return;
      }
      const withContact = parsed.withContact === true;
      try {
        const result = await deps.delegatedTasks.createDraft({
          accountId,
          action: 'comment_curated',
          targetSuccessCount: 1,
          maxAttempts: 2,
          deadlineAt: Date.now() + 24 * 60 * 60 * 1000,
          executionWindow: { mode: 'immediate' },
          source: 'console',
          sourceRef: `curated:${id}:comment`,
          sourceConstraints: {},
          targetConstraints: { curatedId: id, noteId: row.sourceId, title: row.title ?? '', withContact },
          approvalMode: 'review',
          priority: 'normal',
        });
        sendJson(res, result.created ? 201 : 200, result);
      } catch (err) {
        sendDelegatedTaskError(res, err);
      }
      return;
    }
    if (method === 'GET' && url === '/api/curated/contents') {
      if (!deps.curatedContent) {
        sendJson(res, 503, { error: 'curated_unavailable' });
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const accountId = (query.get('accountId') ?? '').trim() || undefined;
      const numOf = (k: string, dflt: number): number => {
        const v = query.get(k);
        if (v == null || v === '') return dflt;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : dflt;
      };
      const ctRaw = (query.get('contentType') ?? '').trim();
      const contentType =
        ctRaw === 'image_text' || ctRaw === 'video' || ctRaw === 'comment' || ctRaw === 'note'
          ? ctRaw
          : undefined;
      const admitReason = (query.get('admitReason') ?? '').trim() || undefined;
      const result = await deps.curatedContent.listForPanel(accountId, {
        ...(contentType ? { contentType } : {}),
        ...(admitReason ? { admitReason } : {}),
        limit: numOf('limit', 50),
        offset: numOf('offset', 0),
      });
      sendJson(res, 200, result);
      return;
    }
    if (method === 'DELETE' && url.startsWith('/api/curated/contents/')) {
      if (!deps.curatedContent) {
        sendJson(res, 503, { error: 'curated_unavailable' });
        return;
      }
      const idRaw = decodeURIComponent(url.slice('/api/curated/contents/'.length));
      const id = Number(idRaw);
      if (!Number.isInteger(id) || id <= 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_id' });
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const accountId = (query.get('accountId') ?? '').trim();
      if (!accountId) {
        sendJson(res, 400, { error: 'bad_request', reason: 'account_required' });
        return;
      }
      const deleted = await deps.curatedContent.deleteOne(accountId, id);
      sendJson(res, 200, { deleted }); // 诚实回真实删除行数（0=已不存在/越权，1=已删），绝不假成功
      return;
    }

    // 告警手动解决（change alert-resolution-by-id）：运营按 alert_id 勾销单条未解决告警。
    // by-id 不依赖 edge_id——一次解开「block 需边缘同进程送配对 cleared 才解」与「pacing edge_id=NULL
    // 永不被按 edge 清除匹配」两根因。红线：只闭合日志行（resolveById 只 UPDATE resolved_at），
    // 绝不碰风控单写、绝不 resumeEdge；诚实回真实解决行数（0=没这条/已解决，1=本次解决）。
    // 先校验 id（请求形状，400），再判存储可用性（未注入 503），末尾 404 前。
    if (method === 'POST' && url.startsWith('/api/alerts/') && url.endsWith('/resolve')) {
      const idRaw = decodeURIComponent(url.slice('/api/alerts/'.length, -'/resolve'.length));
      const id = Number(idRaw);
      if (!Number.isInteger(id) || id <= 0) {
        sendJson(res, 400, { error: 'bad_request', reason: 'invalid_id' });
        return;
      }
      if (!deps.alertStore) {
        sendJson(res, 503, { error: 'alerts_unavailable' });
        return;
      }
      const resolved = await deps.alertStore.resolveById(id);
      sendJson(res, 200, { resolved }); // 诚实透传真实解决行数，前端据 0/1 区分文案，绝不假成功
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  return (req, res) => {
    void handle(req, res).catch((err) => {
      // 缺表/改名（42P01）由精选只读方法抛 typed error：诚实回 503（服务不可用），落进面板「加载中/暂无数据/
      // 服务不可用」三态的第三态，绝不回落空池、绝不 500（change curated-envkey-account-binding，D6；覆盖
      // 列表 / 筛选面 / 单行读取三处只读调用点）。只有精选只读方法抛此类型，故此处映射精确无副作用。
      if (err instanceof CuratedContentUnavailableError) {
        if (!res.headersSent) sendJson(res, 503, { error: 'curated_unavailable' });
        return;
      }
      logger.warn(`[panel] 请求处理异常: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  };
}

/**
 * 启动面板 API。失败（保留端口/缺密钥/无用户/端口占用）一律返回 started=false 而非抛出，
 * 保证边-云闭环与飞书不受面板影响。
 */
export function startPanelApi(deps: PanelDeps, config: PanelConfig): Promise<PanelHandle> {
  const logger = config.logger ?? console;
  const noop = async (): Promise<void> => {};

  if (config.forbiddenPorts.includes(config.port)) {
    logger.warn(`[panel] 拒绝绑定保留端口 ${config.port}（forbidden_port）——面板未启动，边-云闭环不受影响`);
    return Promise.resolve({ started: false, reason: 'forbidden_port', port: config.port, close: noop });
  }
  if (!config.jwtSecret) {
    logger.warn('[panel] 未配置 JWT 密钥（missing_secret）——面板未启动');
    return Promise.resolve({ started: false, reason: 'missing_secret', close: noop });
  }
  if (config.users.length === 0) {
    logger.warn('[panel] 未配置任何面板用户（no_users）——面板未启动');
    return Promise.resolve({ started: false, reason: 'no_users', close: noop });
  }

  const server = http.createServer(createRequestHandler(deps, config));

  return new Promise<PanelHandle>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      logger.warn(
        `[panel] listen 失败（${err.code ?? err.message}，非致命）——面板不可用，边-云闭环与飞书继续运行`,
      );
      resolve({ started: false, reason: 'listen_error', detail: err.code ?? err.message, port: config.port, close: noop });
    });
    server.listen(config.port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : config.port;
      // attach 面板 WS（同端口 /ws，纯只读 EventBus 扇出，绝不碰 edge）。失败非致命，/api 仍可用。
      let panelWs: PanelWsHandle | undefined;
      try {
        panelWs = startPanelWs({
          httpServer: server,
          eventBus: deps.eventBus,
          jwtSecret: config.jwtSecret,
          revocation: deps.revocation,
          logger,
        });
      } catch (err) {
        logger.warn(`[panel] 面板 WS attach 失败（非致命，/api 仍可用）: ${(err as Error).message}`);
      }
      logger.log(`[panel] 面板 API 已监听 127.0.0.1:${actualPort}（/api${panelWs ? ' + /ws 面板事件流' : ''}）`);
      resolve({
        started: true,
        port: actualPort,
        close: async () => {
          if (panelWs) await panelWs.close();
          // 强制断开 keep-alive 连接，使 server.close 能及时完成（优雅关闭）
          server.closeAllConnections?.();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}


/**
 * 读一批稿件的授权下发进度（change publish-approval-signal-to-database，task 4.6）。
 *
 * 未注入或读失败 → 返回 null，投影不带下发态字段、前端回落既有呈现。
 * MUST NOT 因为读不到就伪造一个「无阻塞」的下发态——那会把不可读粉饰成正常。
 */
async function readApprovalDispatchFor(
  deps: Pick<PanelDeps, 'readApprovalDispatchStates'>,
  rows: Array<{ id: number }>,
): Promise<Map<number, ApprovalDispatchProjection> | null> {
  if (!deps.readApprovalDispatchStates) return null;
  const ids = [...new Set(rows.map((row) => row.id))];
  if (ids.length === 0) return new Map();
  try {
    const raw = await deps.readApprovalDispatchStates(ids.map((id) => `publish-${id}`));
    const out = new Map<number, ApprovalDispatchProjection>();
    for (const [requestId, view] of raw) {
      const match = /^publish-(\d+)$/.exec(requestId);
      if (!match) continue;
      out.set(Number(match[1]), {
        approved: view.approved,
        dispatchState: view.dispatchState as ApprovalDispatchProjection['dispatchState'],
        dispatchBlockedReason: view.dispatchBlockedReason,
        decidedAt: view.decidedAt,
      });
    }
    return out;
  } catch (err) {
    // 读失败与「未接线」都回落成 null（前端一律回落旧呈现），但两者绝不能同样无声：
    // 不留痕的话，「已批准·待下发」这个本 change 的核心可见性会在 PG 抖动时凭空消失、排障无从下手。
    // 口径与 server.ts 的同类投影读取（readApprovalDispatchProjection）保持一致。
    console.warn('[panel] 授权下发进度读取失败（投影回落既有呈现）:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
