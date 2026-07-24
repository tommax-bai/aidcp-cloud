import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { ClientUserStore } from '../client-auth/client-user-store.js';
import type { ReplyConfigStore } from './reply-config-store.js';
import type { ReplyConfigResolver } from './reply-config-resolver.js';
// automation 编排层经窄注入端口持有（不再直接 import send-orchestrator / reply-workflow 具体类）。
import type { InteractionSendPort, ReplyWorkflowWritePort } from './interaction-automation-ports.js';
import {
  INTERACTION_PLATFORM,
  InteractionError,
  type InteractionChannel,
  type RuntimeControls,
  type ReplyJobState,
  type ReplyJobView,
  type ScopedJobContext,
  type InteractionStoreReaderPort,
} from '../kernel/interaction-types.js';

const MAX_BODY = 64 * 1024;

export function interactionTestDataResetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIDCP_DEPLOY_ENV?.trim() === 'dev' &&
    env.AIDCP_INTERACTION_TEST_DATA_RESET?.trim().toLowerCase() === 'true';
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function onlyKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return Object.keys(value).length === required.length && required.every((key) => key in value);
}

function onlyQuery(url: URL, allowed: readonly string[]): void {
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', '查询参数不合法。', 422);
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求体过大。', 422);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
    return value as Record<string, unknown>;
  } catch {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求 JSON 不合法。', 422);
  }
}

function publicJob(job: ScopedJobContext['job'] | ReplyJobView): ReplyJobView {
  const raw = job as ScopedJobContext['job'];
  const { meaningChanged: _meaningChanged, introducedClaims: _introducedClaims, lastErrorCode: _lastErrorCode, ...view } = raw;
  return view;
}

function authSummary(
  auth: NonNullable<Awaited<ReturnType<InteractionStoreReaderPort['getAuth']>>>,
  controls: Awaited<ReturnType<InteractionStoreReaderPort['getRuntimeControls']>>,
) {
  const appliedVersion = auth.runtimeControlsVersion;
  const applicationStatus = appliedVersion === controls.version
    ? 'applied'
    : appliedVersion === null || appliedVersion < controls.version ? 'pending' : 'stale';
  return {
    status: auth.status,
    browserState: auth.browserState,
    reasonCode: auth.reasonCode,
    checkedAt: auth.checkedAt,
    capabilities: auth.capabilities,
    identity: auth.identity
      ? { displayName: auth.identity.displayName, identityHash: auth.identity.identityHash }
      : null,
    runtimeControls: {
      storedVersion: controls.version,
      edgeAppliedVersion: appliedVersion,
      applicationStatus,
      stored: {
        commentsReadEnabled: controls.commentsReadEnabled,
        commentsReplyEnabled: controls.commentsReplyEnabled,
        dmReadEnabled: controls.dmReadEnabled,
        dmSendTextEnabled: controls.dmSendTextEnabled,
        dmSendImageEnabled: false as const,
        writePaused: controls.writePaused,
      },
    },
  };
}

type ReplyConfigProjection = {
  status: 'missing' | 'draft_only' | 'published' | 'unknown';
  currentVersion: number | null;
  draftVersion: number | null;
  publishedVersion: number | null;
  mode?: 'scoped';
  source?: { type: 'group' | 'default'; groupLabel: string | null };
};

type CustomerConfigReader = ReplyConfigStore | ReplyConfigResolver;

async function replyConfigSummary(configs: CustomerConfigReader, accountId: string): Promise<ReplyConfigProjection> {
  try {
    if ('resolve' in configs) {
      const effective = await configs.resolve(accountId);
      const version = effective.snapshot?.configVersion ?? null;
      return {
        status: effective.status,
        currentVersion: effective.head?.currentVersion ?? version,
        draftVersion: effective.head?.draftVersion ?? null,
        publishedVersion: effective.head?.publishedVersion ?? version,
        mode: effective.mode,
        source: effective.source,
      };
    }
    const head = await configs.getHead(accountId);
    if (!head) {
      return { status: 'missing', currentVersion: null, draftVersion: null, publishedVersion: null };
    }
    return {
      status: head.publishedVersion === null ? 'draft_only' : 'published',
      currentVersion: head.currentVersion,
      draftVersion: head.draftVersion,
      publishedVersion: head.publishedVersion,
    };
  } catch {
    return { status: 'unknown', currentVersion: null, draftVersion: null, publishedVersion: null };
  }
}

interface CursorPayload {
  kind: 'list' | 'detail';
  envKey: string;
  resourceId?: string;
  asOf: number;
  time: number;
  id: string;
}

class SignedCursor {
  constructor(private readonly secret: string) {}
  encode(payload: CursorPayload): string {
    const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(data).digest('base64url');
    return `${data}.${signature}`;
  }
  decode(token: string, expected: Pick<CursorPayload, 'kind' | 'envKey'> & { resourceId?: string }): CursorPayload {
    const [data, provided, extra] = token.split('.');
    if (!data || !provided || extra) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '分页游标不合法。', 422);
    const expectedSignature = createHmac('sha256', this.secret).update(data).digest();
    let signature: Buffer;
    try { signature = Buffer.from(provided, 'base64url'); } catch { signature = Buffer.alloc(0); }
    if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '分页游标签名无效。', 422);
    }
    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as CursorPayload;
      if (payload.kind !== expected.kind || payload.envKey !== expected.envKey ||
          payload.resourceId !== expected.resourceId || !Number.isInteger(payload.asOf) ||
          !Number.isInteger(payload.time) || typeof payload.id !== 'string') throw new Error('scope');
      return payload;
    } catch {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '分页游标内容无效。', 422);
    }
  }
}

export class InteractionCustomerApi {
  private readonly cursors: SignedCursor;
  private readonly clock: () => number;

  constructor(private readonly deps: {
    users: ClientUserStore;
    store: InteractionStoreReaderPort;
    configs: CustomerConfigReader;
    workflow: ReplyWorkflowWritePort;
    sender: InteractionSendPort;
    onRuntimeControlsUpdated?: (controls: RuntimeControls) => Promise<{ delivered: number }>;
    testDataResetEnabled?: boolean;
    cursorSecret: string;
    clock?: () => number;
  }) {
    this.cursors = new SignedCursor(deps.cursorSecret);
    this.clock = deps.clock ?? Date.now;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, userId: string): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/environments/')) return false;
    const requestId = randomUUID();
    try {
      let parts: string[];
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '路径编码不合法。', 422);
      }
      if (parts.length < 3 || parts[0] !== 'environments' || !['interactions', 'replies'].includes(parts[2])) return false;
      const envKey = parts[1];
      // 完整授权边界在一个数据库事务内完成并持锁到业务操作结束：enabled user、
      // authoritative env ownership、interaction account/platform binding 缺一不可。
      const authorized = await this.deps.users.withAuthorizedInteractionScope(
        userId,
        envKey,
        async ({ accountId }) => this.route(req, res, url, parts, userId, envKey, accountId, requestId),
      );
      if (!authorized.ok) {
        if (authorized.reason === 'disabled') {
          throw new InteractionError('INTERACTION_AUTH_REQUIRED', '客户身份已停用。', 401);
        }
        // 未归属、归属已撤销、环境未登记或账号绑定不匹配统一 404，不泄漏资源存在性。
        throw new InteractionError('INTERACTION_NOT_FOUND', '资源不存在。', 404);
      }
      if (!authorized.value) throw new InteractionError('INTERACTION_NOT_FOUND', '接口不存在。', 404);
      return true;
    } catch (error) {
      this.sendError(res, requestId, error);
      return true;
    }
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    parts: string[],
    userId: string,
    envKey: string,
    accountId: string,
    requestId: string,
  ): Promise<boolean> {
    const method = req.method ?? 'GET';
    if (parts[2] === 'interactions' && parts.length === 3 && method === 'GET') {
      onlyQuery(url, ['limit','channel','state','cursor']);
      const limitParam = url.searchParams.get('limit');
      const limitRaw = Number(limitParam ?? 30);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'limit 不合法。', 422);
      }
      const limit = limitRaw;
      const channelRaw = url.searchParams.get('channel');
      if (channelRaw !== null && channelRaw !== 'comment' && channelRaw !== 'dm') {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'channel 不合法。', 422);
      }
      const channel = channelRaw === 'comment' || channelRaw === 'dm' ? channelRaw : undefined;
      const stateRaw = url.searchParams.get('state');
      const states: ReplyJobState[] = ['new','classifying','draft_ready','approval_required','approved','queued','sending','sent','failed','ambiguous','ignored','escalated'];
      if (stateRaw !== null && stateRaw !== 'pending' && !states.includes(stateRaw as ReplyJobState)) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'state 不合法。', 422);
      }
      const state = stateRaw === 'pending'
        ? 'pending' as const
        : stateRaw && states.includes(stateRaw as ReplyJobState) ? stateRaw as ReplyJobState : undefined;
      const token = url.searchParams.get('cursor');
      const cursor = token ? this.cursors.decode(token, { kind: 'list', envKey }) : null;
      const asOf = cursor?.asOf ?? this.clock();
      const [result, auth, controls, replyConfig, syncFreshness] = await Promise.all([
        this.deps.store.listInteractions({ accountId, envKey, asOf, limit, channel, state,
          before: cursor ? { lastMessageAt: cursor.time, id: cursor.id } : undefined }),
        this.deps.store.getAuth(accountId, envKey),
        this.deps.store.getRuntimeControls(accountId),
        replyConfigSummary(this.deps.configs, accountId),
        this.deps.store.getSyncFreshness(accountId, envKey),
      ]);
      if (!auth) throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '平台登录状态尚不可用。', 503);
      const nextCursor = result.next ? this.cursors.encode({ kind: 'list', envKey, asOf,
        time: result.next.lastMessageAt, id: result.next.id }) : null;
      this.ok(res, requestId, asOf, { envKey, accountId, platform: INTERACTION_PLATFORM,
        auth: authSummary(auth, controls), replyConfig,
        testTools: { dataResetEnabled: this.deps.testDataResetEnabled === true },
        syncFreshness, items: result.items, nextCursor });
      return true;
    }
    if (parts[2] === 'interactions' && parts.length === 4 && method === 'GET') {
      onlyQuery(url, ['cursor']);
      const threadId = parts[3];
      const token = url.searchParams.get('cursor');
      const cursor = token ? this.cursors.decode(token, { kind: 'detail', envKey, resourceId: threadId }) : null;
      const asOf = cursor?.asOf ?? this.clock();
      const [detail, auth, controls, replyConfig, syncFreshness] = await Promise.all([
        this.deps.store.getDetail(accountId, envKey, threadId, 100,
          cursor ? { platformCreatedAt: cursor.time, id: cursor.id } : undefined),
        this.deps.store.getAuth(accountId, envKey),
        this.deps.store.getRuntimeControls(accountId),
        replyConfigSummary(this.deps.configs, accountId),
        this.deps.store.getSyncFreshness(accountId, envKey),
      ]);
      if (!detail) throw new InteractionError('INTERACTION_NOT_FOUND', '资源不存在。', 404);
      if (!auth) throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '平台登录状态尚不可用。', 503);
      const nextCursor = detail.next ? this.cursors.encode({ kind: 'detail', envKey, resourceId: threadId, asOf,
        time: detail.next.platformCreatedAt, id: detail.next.id }) : null;
      this.ok(res, requestId, asOf, { envKey, accountId, platform: INTERACTION_PLATFORM, auth: authSummary(auth, controls), replyConfig, syncFreshness,
        thread: detail.thread, messages: detail.messages, replyJob: detail.replyJob,
        sendAttempt: detail.sendAttempt, nextCursor });
      return true;
    }
    if (parts[2] === 'interactions' && parts.length === 4 && parts[3] === 'read-controls' && method === 'PUT') {
      onlyQuery(url, []);
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion','commentsReadEnabled','dmReadEnabled']) ||
          !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0 ||
          typeof body.commentsReadEnabled !== 'boolean' || typeof body.dmReadEnabled !== 'boolean') {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '互动读取开关请求不合法。', 422);
      }
      const current = await this.deps.store.getRuntimeControls(accountId);
      if (current.envKey !== envKey) {
        throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '环境与账号运行控制不匹配。', 409);
      }
      const controls = await this.deps.store.updateRuntimeControls({
        accountId,
        expectedVersion: body.expectedVersion as number,
        actor: `client:${userId}`,
        commentsReadEnabled: body.commentsReadEnabled,
        commentsReplyEnabled: current.commentsReplyEnabled,
        dmReadEnabled: body.dmReadEnabled,
        dmSendTextEnabled: current.dmSendTextEnabled,
        dmSendImageEnabled: false,
        writePaused: current.writePaused,
      });
      let delivered = 0;
      try {
        delivered = (await this.deps.onRuntimeControlsUpdated?.(controls))?.delivered ?? 0;
      } catch {
        // Stored CAS is authoritative; reconnect converges through the existing runtime-controls snapshot.
      }
      const [auth, replyConfig] = await Promise.all([
        this.deps.store.getAuth(accountId, envKey),
        replyConfigSummary(this.deps.configs, accountId),
      ]);
      if (!auth) throw new InteractionError('INTERACTION_UPSTREAM_UNAVAILABLE', '平台登录状态尚不可用。', 503);
      this.ok(res, requestId, this.clock(), {
        envKey,
        accountId,
        platform: INTERACTION_PLATFORM,
        auth: authSummary(auth, controls),
        replyConfig,
        edgeDelivery: { status: delivered === 1 ? 'enqueued' : 'deferred', delivered },
      });
      return true;
    }
    if (parts[2] === 'replies' && parts.length === 5 && method === 'POST') {
      onlyQuery(url, []);
      const jobId = parts[3];
      const action = parts[4];
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion']) || !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'expectedVersion 不合法。', 422);
      }
      const mutation = { accountId, envKey, jobId, expectedVersion: body.expectedVersion as number, actor: `client:${userId}` };
      if (action === 'approve') {
        const job = await this.deps.workflow.approve(mutation);
        this.ok(res, requestId, this.clock(), { envKey, accountId, job: publicJob(job) });
        return true;
      }
      if (action === 'regenerate') {
        const job = await this.deps.workflow.generate(mutation);
        this.ok(res, requestId, this.clock(), { envKey, accountId, job: publicJob(job) });
        return true;
      }
      if (action === 'send') {
        const key = this.idempotencyKey(req);
        const claim = await this.deps.store.claimApiRequest({ actor: `client:${userId}`, action: 'send',
          idempotencyKey: key, accountId, envKey, resourceId: jobId });
        if (claim.response) { sendJson(res, 200, claim.response); return true; }
        const current = await this.deps.store.getJobContext(accountId, envKey, jobId);
        let job: ScopedJobContext['job'];
        if (!claim.fresh && current && ['queued', 'sending', 'sent', 'failed', 'ambiguous'].includes(current.job.state)) job = current.job;
        else job = await this.deps.sender.queueApproved(mutation);
        const response = this.envelope(requestId, this.clock(), { envKey, accountId, job: publicJob(job) });
        await this.deps.store.completeApiRequest(claim.requestId, response);
        sendJson(res, 200, response);
        if (job.state === 'queued') {
          void this.deps.sender.dispatchQueued({ accountId, envKey, jobId, expectedVersion: job.version }).catch(() => {});
        }
        return true;
      }
      return false;
    }
    if (parts[2] === 'replies' && parts.length === 5 && parts[4] === 'draft' && method === 'PUT') {
      onlyQuery(url, []);
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion','finalText']) || !Number.isInteger(body.expectedVersion) ||
          typeof body.finalText !== 'string' || !body.finalText.trim() || body.finalText.length > 4_000) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '草稿请求不合法。', 422);
      }
      const job = await this.deps.workflow.edit({ accountId, envKey, jobId: parts[3],
        expectedVersion: body.expectedVersion as number, actor: `client:${userId}`, text: body.finalText });
      this.ok(res, requestId, this.clock(), { envKey, accountId, job: publicJob(job) });
      return true;
    }
    if (parts[2] === 'interactions' && parts.length === 5 && method === 'POST' &&
        (parts[4] === 'ignore' || parts[4] === 'escalate')) {
      onlyQuery(url, []);
      const body = await readBody(req);
      const expectedKeys = parts[4] === 'escalate' ? ['expectedVersion','reason'] : ['expectedVersion'];
      if (!onlyKeys(body, expectedKeys) || !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0 ||
          (parts[4] === 'escalate' && (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 512))) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '消息操作请求不合法。', 422);
      }
      const job = await this.deps.store.transitionMessageJob({ accountId, envKey, messageId: parts[3],
        expectedVersion: body.expectedVersion as number, to: parts[4] === 'ignore' ? 'ignored' : 'escalated',
        actor: `client:${userId}`, reason: typeof body.reason === 'string' ? body.reason : undefined });
      this.ok(res, requestId, this.clock(), { envKey, accountId, job: publicJob(job) });
      return true;
    }
    if (parts[2] === 'interactions' && parts.length === 4 && method === 'POST' && parts[3] === 'sync') {
      onlyQuery(url, []);
      const key = this.idempotencyKey(req);
      const body = await readBody(req);
      if (!onlyKeys(body, ['channel','scopeExternalId']) ||
          !(body.channel === null || body.channel === 'comment' || body.channel === 'dm') ||
          !(body.scopeExternalId === null || typeof body.scopeExternalId === 'string')) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '同步请求不合法。', 422);
      }
      const syncResource = `${body.channel ?? 'all'}|${typeof body.scopeExternalId === 'string' ? body.scopeExternalId : ''}`;
      const claim = await this.deps.store.claimApiRequest({ actor: `client:${userId}`, action: 'sync', idempotencyKey: key,
        accountId, envKey, resourceId: syncResource });
      if (claim.response) { sendJson(res, 200, claim.response); return true; }
      const channels: InteractionChannel[] = body.channel ? [body.channel as InteractionChannel] : ['comment', 'dm'];
      const ids = await Promise.all(channels.map((channel) => this.deps.sender.requestSync({ accountId, envKey, channel,
        scopeExternalId: typeof body.scopeExternalId === 'string' ? body.scopeExternalId : null, reason: 'user_requested' })));
      const response = this.envelope(requestId, this.clock(), { envKey, accountId, action: 'sync', actionRequestId: ids[0], status: 'accepted' });
      await this.deps.store.completeApiRequest(claim.requestId, response);
      sendJson(res, 200, response);
      return true;
    }
    if (parts[2] === 'interactions' && parts.length === 4 && method === 'POST' && parts[3] === 'test-reset') {
      onlyQuery(url, []);
      if (this.deps.testDataResetEnabled !== true) {
        throw new InteractionError('INTERACTION_FEATURE_DISABLED', '测试数据重置只在显式启用的开发环境开放。', 404);
      }
      const key = this.idempotencyKey(req);
      const body = await readBody(req);
      if (!onlyKeys(body, ['channel']) || (body.channel !== 'comment' && body.channel !== 'dm')) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '重置请求必须且只能选择评论或私信。', 422);
      }
      const channel = body.channel as InteractionChannel;
      const actor = `client:${userId}`;
      const claim = await this.deps.store.claimApiRequest({ actor, action: 'test_reset', idempotencyKey: key,
        accountId, envKey, resourceId: channel });
      if (claim.response) { sendJson(res, 200, claim.response); return true; }
      if (!claim.fresh) {
        throw new InteractionError('INTERACTION_STATE_CONFLICT',
          '同一幂等键的上次重置结果尚未确认；请刷新状态，确认后使用新的重置操作。', 409);
      }
      // 开发测试工具：清空是纯云端事务，必须与「引擎/浏览器是否在线」解耦——先无条件清空
      //（scope 由 resetTestData 自身的 FOR UPDATE + env 校验兜底），再尽力触发重新拉取。没有在线
      // Edge 或派发失败时不再整体失败，只把 resync 标记为 skipped、actionRequestId 记 null；清空已
      // 落库，Edge 下次上线由既有同步补拉。见 [[wechat-test-reset-unconditional-wipe]] 的离线可重置诉求。
      const reset = await this.deps.store.resetTestData({ accountId, envKey, channel, actor });
      let actionRequestId: string | null = null;
      let resync: 'accepted' | 'skipped' = 'skipped';
      try {
        actionRequestId = await this.deps.sender.requestSync({ accountId, envKey, channel,
          scopeExternalId: null, reason: 'test_reset' });
        resync = 'accepted';
      } catch (error) {
        const reason = error instanceof InteractionError ? error.code : 'INTERACTION_INTERNAL_ERROR';
        await this.deps.store.recordAudit({ accountId, envKey, actor, action: 'test_data_reset_resync_skipped',
          entityType: 'interaction_channel', entityId: channel,
          summary: 'test data reset committed; automatic re-pull not dispatched', labels: { channel, deleted: reset.deleted, reason } });
      }
      const response = this.envelope(requestId, this.clock(), { envKey, accountId, channel,
        action: 'test_reset', actionRequestId, resync, status: 'accepted', deleted: reset.deleted });
      await this.deps.store.completeApiRequest(claim.requestId, response);
      sendJson(res, 200, response);
      return true;
    }
    if (parts[2] === 'interactions' && parts.length === 5 && method === 'POST' && parts[3] === 'auth' && parts[4] === 'reopen') {
      onlyQuery(url, []);
      const key = this.idempotencyKey(req);
      const body = await readBody(req);
      if (Object.keys(body).length) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求体必须为空对象。', 422);
      const claim = await this.deps.store.claimApiRequest({ actor: `client:${userId}`, action: 'auth_reopen',
        idempotencyKey: key, accountId, envKey });
      if (claim.response) { sendJson(res, 200, claim.response); return true; }
      const actionRequestId = this.deps.sender.requestAuthReopen({ accountId, envKey, reason: 'user_requested' });
      const response = this.envelope(requestId, this.clock(), { envKey, accountId, action: 'auth_reopen', actionRequestId, status: 'accepted' });
      await this.deps.store.completeApiRequest(claim.requestId, response);
      sendJson(res, 200, response);
      return true;
    }
    if (parts[2] === 'interactions' && parts.length === 4 && method === 'POST' && parts[3] === 'browser') {
      onlyQuery(url, []);
      const key = this.idempotencyKey(req);
      const body = await readBody(req);
      if (!onlyKeys(body, ['action']) || (body.action !== 'open' && body.action !== 'close')) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '浏览器 action 必须为 open 或 close。', 422);
      }
      const action = body.action;
      const auth = await this.deps.store.getAuth(accountId, envKey);
      if (!auth || auth.status !== 'active') {
        throw new InteractionError('INTERACTION_AUTH_REQUIRED', '仅登录有效的环境可控制浏览器前后台。', 409);
      }
      const claim = await this.deps.store.claimApiRequest({ actor: `client:${userId}`, action: 'browser_control',
        idempotencyKey: key, accountId, envKey, resourceId: action });
      if (claim.response) { sendJson(res, 200, claim.response); return true; }
      const actionRequestId = this.deps.sender.requestBrowserControl({ accountId, envKey, action });
      const response = this.envelope(requestId, this.clock(), {
        envKey, accountId, action: 'browser_control', browserAction: action, actionRequestId, status: 'accepted',
      });
      await this.deps.store.completeApiRequest(claim.requestId, response);
      sendJson(res, 200, response);
      return true;
    }
    return false;
  }

  private idempotencyKey(req: http.IncomingMessage): string {
    const value = req.headers['idempotency-key'];
    if (typeof value !== 'string' || !value.trim() || value.length > 256) {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '缺少有效 Idempotency-Key。', 422);
    }
    return value.trim();
  }

  private envelope(requestId: string, asOf: number, data: unknown): unknown {
    return { data, meta: { requestId, asOf } };
  }

  private ok(res: http.ServerResponse, requestId: string, asOf: number, data: unknown): void {
    sendJson(res, 200, this.envelope(requestId, asOf, data));
  }

  private sendError(res: http.ServerResponse, requestId: string, error: unknown): void {
    const known = error instanceof InteractionError ? error :
      new InteractionError('INTERACTION_INTERNAL_ERROR', '互动服务暂时不可用。', 500, true);
    sendJson(res, known.httpStatus, { error: { code: known.code, message: known.message,
      requestId, retryable: known.retryable, ...(known.details ? { details: known.details } : {}) } });
  }
}
