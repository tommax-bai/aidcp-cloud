import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { ReplyConfigStore } from './reply-config-store.js';
import type { ReplyPreviewBuilderPort } from './interaction-automation-ports.js';
import { isReplyPolicy, isReplyProfile, isReplyRule, isReplyTemplate } from './reply-config.js';
import {
  InteractionError,
  type RuntimeControls,
  type InteractionStoreReaderPort,
} from '../kernel/interaction-types.js';

export type InteractionGrant =
  | 'interaction.config.view'
  | 'interaction.config.edit'
  | 'interaction.config.publish'
  | 'interaction.config.preview'
  | 'interaction.dm.view_full'
  | 'interaction.audit.view';

const ALL_GRANTS: readonly InteractionGrant[] = [
  'interaction.config.view', 'interaction.config.edit', 'interaction.config.publish',
  'interaction.config.preview', 'interaction.dm.view_full', 'interaction.audit.view',
];

/** JSON object: {"admin":["interaction.config.view", ...]}; malformed/unknown values fail closed. */
export function parseInteractionPanelGrants(raw: string | undefined): Map<string, ReadonlySet<InteractionGrant>> {
  const result = new Map<string, ReadonlySet<InteractionGrant>>();
  if (!raw?.trim()) return result;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value)) return result;
    for (const [actor, grants] of Object.entries(value)) {
      if (!actor.trim() || !Array.isArray(grants) || grants.some((grant) => typeof grant !== 'string' || !ALL_GRANTS.includes(grant as InteractionGrant))) continue;
      result.set(actor, new Set(grants as InteractionGrant[]));
    }
  } catch {
    return result;
  }
  return result;
}

const KNOWN_SUFFIXES = new Set([
  'interaction-runtime-controls', 'interaction-reply-policy', 'reply-templates', 'reply-rules',
  'reply-profile', 'reply-preview', 'reply-preview-contexts', 'reply-config/initialize',
  'reply-config/publish', 'reply-config/audit',
]);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 256 * 1024) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求体过大。', 422);
    chunks.push(buffer);
  }
  try {
    const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
    return value as Record<string, unknown>;
  } catch {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求 JSON 不合法。', 422);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return Object.keys(value).length === required.length && required.every((key) => key in value);
}

function onlyQuery(url: URL, allowed: readonly string[]): void {
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', '查询参数不合法。', 422);
  }
}

function encodeAuditCursor(value: { createdAt: number; eventId: string }, secret: string): string {
  const data = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function decodeAuditCursor(value: string, secret: string): { createdAt: number; eventId: string } {
  try {
    const [data, provided, extra] = value.split('.');
    if (!data || !provided || extra) throw new Error('invalid_cursor');
    const expected = createHmac('sha256', secret).update(data).digest();
    const signature = Buffer.from(provided, 'base64url');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error('invalid_signature');
    const parsed: unknown = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!isObject(parsed) || !Number.isInteger(parsed.createdAt) || typeof parsed.eventId !== 'string' || !parsed.eventId) {
      throw new Error('invalid_cursor');
    }
    return { createdAt: parsed.createdAt as number, eventId: parsed.eventId };
  } catch {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', '分页游标不合法。', 422);
  }
}

function expectedVersion(body: Record<string, unknown>): number {
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'expectedVersion 不合法。', 422);
  }
  return body.expectedVersion as number;
}

function publicControls(value: RuntimeControls) {
  return {
    accountId: value.accountId,
    platform: value.platform,
    version: value.version,
    commentsReadEnabled: value.commentsReadEnabled,
    commentsReplyEnabled: value.commentsReplyEnabled,
    dmReadEnabled: value.dmReadEnabled,
    dmSendTextEnabled: value.dmSendTextEnabled,
    dmSendImageEnabled: false as const,
    writePaused: value.writePaused,
    circuitOpen: value.circuitOpenedAt !== null,
    circuitOpenedAt: value.circuitOpenedAt,
    consecutiveFailures: value.consecutiveFailures,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
  };
}

function routeGrant(suffix: string, method: string): InteractionGrant {
  if (suffix === 'reply-preview' || suffix === 'reply-preview-contexts') return 'interaction.config.preview';
  if (suffix === 'reply-config/publish') return 'interaction.config.publish';
  if (suffix === 'reply-config/audit') return 'interaction.audit.view';
  if (method === 'GET') return 'interaction.config.view';
  return 'interaction.config.edit';
}

export class InteractionInternalApi {
  private readonly clock: () => number;
  constructor(private readonly deps: {
    store: InteractionStoreReaderPort;
    configs: ReplyConfigStore;
    workflow: ReplyPreviewBuilderPort;
    grantsFor: (actor: string) => ReadonlySet<InteractionGrant>;
    cursorSecret: string;
    resolutionMode?: 'scoped';
    onRuntimeControlsUpdated?: (controls: RuntimeControls) => Promise<{ delivered: number }>;
    clock?: () => number;
  }) {
    this.clock = deps.clock ?? Date.now;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, actor: string): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const prefix = '/api/accounts/';
    if (!url.pathname.startsWith(prefix)) return false;
    const rest = url.pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return false;
    const suffix = rest.slice(slash + 1);
    const rootSuffix = suffix.startsWith('reply-templates/') ? 'reply-templates'
      : suffix.startsWith('reply-rules/') ? 'reply-rules' : suffix;
    if (!KNOWN_SUFFIXES.has(rootSuffix)) return false;
    const requestId = randomUUID();
    try {
      let accountId: string;
      try { accountId = decodeURIComponent(rest.slice(0, slash)); } catch {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '路径编码不合法。', 422);
      }
      await this.route(req, res, url, actor, accountId, suffix, requestId);
    } catch (error) {
      const known = error instanceof InteractionError ? error :
        new InteractionError('INTERACTION_INTERNAL_ERROR', '互动配置服务暂时不可用。', 500, true);
      sendJson(res, known.httpStatus, { error: { code: known.code, message: known.message, requestId,
        retryable: known.retryable, ...(known.details ? { details: known.details } : {}) } });
    }
    return true;
  }

  private require(actor: string, grant: InteractionGrant): void {
    if (!this.deps.grantsFor(actor).has(grant)) {
      throw new InteractionError('INTERACTION_PERMISSION_DENIED', '缺少互动配置权限。', 403);
    }
  }

  private async draft(accountId: string) {
    const head = await this.deps.configs.getHead(accountId);
    if (!head) throw new InteractionError('INTERACTION_CONFIG_MISSING', '回复配置不存在。', 404);
    const snapshot = await this.deps.configs.getSnapshot(accountId, head.draftVersion === null ? 'published' : 'draft');
    if (!snapshot) throw new InteractionError('INTERACTION_CONFIG_MISSING', '回复配置快照不存在。', 404);
    return { head, snapshot };
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    actor: string,
    accountId: string,
    suffix: string,
    requestId: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    if (this.deps.resolutionMode === 'scoped' &&
        suffix !== 'interaction-runtime-controls' && suffix !== 'reply-preview-contexts') {
      throw new InteractionError(
        'INTERACTION_STATE_CONFLICT',
        '账号级回复策略已退役，请在视频号分组/默认策略中管理。',
        410,
        false,
        { reason: 'account_reply_config_retired' },
      );
    }
    this.require(actor, routeGrant(suffix, method));
    const allowedQuery = suffix === 'reply-config/audit' && method === 'GET'
      ? ['limit','cursor']
      : suffix === 'reply-preview-contexts' && method === 'GET' ? ['channel','limit'] : [];
    onlyQuery(url, allowedQuery);
    if (suffix === 'interaction-runtime-controls') {
      if (method === 'GET') {
        this.require(actor, 'interaction.config.view');
        this.ok(res, requestId, publicControls(await this.deps.store.getRuntimeControls(accountId)));
        return;
      }
      if (method === 'PUT') {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        const keys = ['commentsReadEnabled','commentsReplyEnabled','dmReadEnabled','dmSendTextEnabled','writePaused'] as const;
        if (!onlyKeys(body, ['expectedVersion',...keys,'dmSendImageEnabled']) ||
            body.dmSendImageEnabled !== false || keys.some((key) => typeof body[key] !== 'boolean')) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', '运行控制请求不合法。', 422);
        }
        const controls = await this.deps.store.updateRuntimeControls({ accountId, expectedVersion: expectedVersion(body), actor,
          commentsReadEnabled: body.commentsReadEnabled as boolean,
          commentsReplyEnabled: body.commentsReplyEnabled as boolean,
          dmReadEnabled: body.dmReadEnabled as boolean,
          dmSendTextEnabled: body.dmSendTextEnabled as boolean,
          dmSendImageEnabled: false,
          writePaused: body.writePaused as boolean });
        let delivered = 0;
        try {
          delivered = (await this.deps.onRuntimeControlsUpdated?.(controls))?.delivered ?? 0;
        } catch {
          // The CAS/audit commit is authoritative; socket delivery failure converges on the next hello.
        }
        this.ok(res, requestId, {
          ...publicControls(controls),
          edgeDelivery: { status: delivered === 1 ? 'enqueued' : 'deferred', delivered },
        });
        return;
      }
    }
    if (suffix === 'reply-config/initialize' && method === 'POST') {
      this.require(actor, 'interaction.config.edit');
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion']) || expectedVersion(body) !== 0) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '初始化请求必须使用 expectedVersion=0。', 422);
      }
      const snapshot = await this.deps.configs.initialize(accountId, 0, actor);
      const head = await this.deps.configs.getHead(accountId);
      this.ok(res, requestId, { head, initializedVersion: snapshot.configVersion });
      return;
    }
    if (suffix === 'interaction-reply-policy') {
      if (method === 'GET') {
        this.require(actor, 'interaction.config.view');
        const { head, snapshot } = await this.draft(accountId);
        this.ok(res, requestId, { head, policy: snapshot.policy });
        return;
      }
      if (method === 'PUT') {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion','policy']) || !isReplyPolicy(body.policy)) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'policy 不合法。', 422);
        }
        const snapshot = await this.deps.configs.savePolicy(accountId, expectedVersion(body), actor, body.policy);
        const head = await this.deps.configs.getHead(accountId);
        this.ok(res, requestId, { head, policy: snapshot.policy });
        return;
      }
    }
    if (suffix === 'reply-templates' || suffix.startsWith('reply-templates/')) {
      const templateId = suffix === 'reply-templates' ? null : decodeURIComponent(suffix.slice('reply-templates/'.length));
      if (method === 'GET' && !templateId) {
        this.require(actor, 'interaction.config.view');
        const { head, snapshot } = await this.draft(accountId);
        this.ok(res, requestId, { accountId, currentVersion: head.currentVersion, items: snapshot.templates, nextCursor: null });
        return;
      }
      if ((method === 'POST' && !templateId) || (method === 'PUT' && templateId)) {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion','template']) || !isReplyTemplate(body.template)) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'template 不合法。', 422);
        }
        const template = body.template;
        if (templateId && template.templateId !== templateId) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'template 字段不合法。', 422);
        }
        const snapshot = await this.deps.configs.saveTemplate(accountId, expectedVersion(body), actor, template);
        const head = await this.deps.configs.getHead(accountId);
        this.ok(res, requestId, { accountId, currentVersion: head!.currentVersion, items: snapshot.templates, nextCursor: null });
        return;
      }
      if (method === 'DELETE' && templateId) {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion'])) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求字段不合法。', 422);
        const snapshot = await this.deps.configs.archiveTemplate(accountId, expectedVersion(body), actor, templateId);
        const head = await this.deps.configs.getHead(accountId);
        this.ok(res, requestId, { accountId, currentVersion: head!.currentVersion, items: snapshot.templates, nextCursor: null });
        return;
      }
    }
    if (suffix === 'reply-rules' || suffix.startsWith('reply-rules/')) {
      const ruleId = suffix === 'reply-rules' ? null : decodeURIComponent(suffix.slice('reply-rules/'.length));
      if (method === 'GET' && !ruleId) {
        this.require(actor, 'interaction.config.view');
        const { head, snapshot } = await this.draft(accountId);
        this.ok(res, requestId, { accountId, currentVersion: head.currentVersion, items: snapshot.rules, nextCursor: null });
        return;
      }
      if ((method === 'POST' && !ruleId) || (method === 'PUT' && ruleId)) {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion','rule']) || !isReplyRule(body.rule)) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'rule 不合法。', 422);
        }
        const rule = body.rule;
        if (ruleId && rule.ruleId !== ruleId) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'rule 字段不合法。', 422);
        }
        const snapshot = await this.deps.configs.saveRule(accountId, expectedVersion(body), actor, rule);
        const head = await this.deps.configs.getHead(accountId);
        this.ok(res, requestId, { accountId, currentVersion: head!.currentVersion, items: snapshot.rules, nextCursor: null });
        return;
      }
      if (method === 'DELETE' && ruleId) {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion'])) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求字段不合法。', 422);
        const snapshot = await this.deps.configs.deleteRule(accountId, expectedVersion(body), actor, ruleId);
        const head = await this.deps.configs.getHead(accountId);
        this.ok(res, requestId, { accountId, currentVersion: head!.currentVersion, items: snapshot.rules, nextCursor: null });
        return;
      }
    }
    if (suffix === 'reply-profile') {
      if (method === 'GET') {
        this.require(actor, 'interaction.config.view');
        const { head, snapshot } = await this.draft(accountId);
        this.ok(res, requestId, { accountId, currentVersion: head.currentVersion, profiles: snapshot.profiles });
        return;
      }
      if (method === 'PUT') {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion','profiles']) || !Array.isArray(body.profiles) || body.profiles.length !== 2 ||
            !body.profiles.every(isReplyProfile) || new Set(body.profiles.map((profile) => profile.channel)).size !== 2) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'profiles 必须同时包含 comment 与 dm。', 422);
        }
        const snapshot = await this.deps.configs.saveProfiles(accountId, expectedVersion(body), actor,
          body.profiles);
        const head = await this.deps.configs.getHead(accountId);
        this.ok(res, requestId, { accountId, currentVersion: head!.currentVersion, profiles: snapshot.profiles });
        return;
      }
    }
    if (suffix === 'reply-preview-contexts' && method === 'GET') {
      const channel = url.searchParams.get('channel');
      const limit = Number(url.searchParams.get('limit') ?? 20);
      if ((channel !== 'comment' && channel !== 'dm') || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'preview context 查询不合法。', 422);
      }
      if (channel === 'dm') this.require(actor, 'interaction.dm.view_full');
      const items = await this.deps.store.listReplyPreviewContexts(accountId, channel, limit);
      this.ok(res, requestId, { accountId, items });
      return;
    }
    if (suffix === 'reply-preview' && method === 'POST') {
      this.require(actor, 'interaction.config.preview');
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion','use','channel','messageType','userMessage','videoTitle','userName']) ||
          (body.use !== 'draft' && body.use !== 'published') ||
          (body.channel !== 'comment' && body.channel !== 'dm') ||
          !['text','image','unknown'].includes(String(body.messageType)) ||
          !(body.userMessage === null || typeof body.userMessage === 'string') ||
          !(body.videoTitle === null || typeof body.videoTitle === 'string') ||
          !(body.userName === null || typeof body.userName === 'string')) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'preview 请求不合法。', 422);
      }
      if (body.channel === 'dm') this.require(actor, 'interaction.dm.view_full');
      const head = await this.deps.configs.getHead(accountId);
      if (!head || head.currentVersion !== expectedVersion(body)) {
        throw new InteractionError('INTERACTION_VERSION_CONFLICT', '配置版本已变化。', 409, false,
          { currentVersion: head?.currentVersion ?? 0 });
      }
      const snapshot = await this.deps.configs.getSnapshot(accountId, body.use);
      if (!snapshot) throw new InteractionError('INTERACTION_CONFIG_MISSING', '请求的配置快照不存在。', 404);
      const preview = await this.deps.workflow.buildPreview(snapshot, {
        channel: body.channel, messageType: body.messageType as 'text' | 'image' | 'unknown',
        text: body.userMessage as string | null, videoTitle: body.videoTitle as string | null,
        userName: body.userName as string | null,
        recentMessages: [],
      }, null);
      await this.deps.configs.recordPreview(accountId, actor, snapshot.configVersion);
      const automaticPolicy = snapshot.policy.mode === 'auto_safe' && snapshot.policy.sendReplies &&
        snapshot.policy.channels[body.channel].enabled && snapshot.policy.channels[body.channel].allowAutoSend;
      const action = !preview.matchedRuleId ? 'no_match' : !preview.finalText ? 'blocked'
        : snapshot.policy.mode === 'draft_only' || !snapshot.policy.sendReplies ? 'draft'
          : preview.requiresApproval || !automaticPolicy ? 'review_required' : 'would_auto_send';
      this.ok(res, requestId, {
        accountId, configVersion: snapshot.configVersion,
        matchedRule: preview.matchedRuleId ? { ruleId: preview.matchedRuleId, reason: 'matched_by_priority_and_conditions' } : null,
        template: preview.templateId && preview.templateVersion && preview.renderedText
          ? { templateId: preview.templateId, templateVersion: preview.templateVersion, renderedText: preview.renderedText } : null,
        polish: preview.renderedText && preview.polishedText ? { before: preview.renderedText, after: preview.polishedText,
          fallbackUsed: preview.fallbacks.polisher !== 'none', fallbackReason: preview.fallbacks.polisher,
          meaningChanged: preview.meaningChanged,
          introducedClaims: preview.introducedClaims } : null,
        risk: { level: preview.riskLevel, tags: preview.riskReasons, reasons: preview.reviewReasons },
        action,
      });
      return;
    }
    if (suffix === 'reply-config/publish' && method === 'POST') {
      this.require(actor, 'interaction.config.publish');
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion'])) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '发布请求不合法。', 422);
      const published = await this.deps.configs.publish(accountId, expectedVersion(body), actor);
      const head = await this.deps.configs.getHead(accountId);
      this.ok(res, requestId, { head, publishedAt: published.publishedAt!, publishedBy: published.publishedBy! });
      return;
    }
    if (suffix === 'reply-config/audit' && method === 'GET') {
      this.require(actor, 'interaction.audit.view');
      const rawLimit = Number(url.searchParams.get('limit') ?? 50);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'limit 不合法。', 422);
      }
      const cursorToken = url.searchParams.get('cursor');
      const events = await this.deps.configs.listAudit(accountId, rawLimit + 1,
        cursorToken ? decodeAuditCursor(cursorToken, this.deps.cursorSecret) : undefined);
      const page = events.slice(0, rawLimit);
      const items = page.map(({ labels: _labels, ...event }) => event);
      const tail = events.length > rawLimit ? page.at(-1) : undefined;
      const nextCursor = tail ? encodeAuditCursor({ createdAt: tail.createdAt, eventId: tail.eventId }, this.deps.cursorSecret) : null;
      this.ok(res, requestId, { accountId, items, nextCursor });
      return;
    }
    throw new InteractionError('INTERACTION_NOT_FOUND', '接口不存在。', 404);
  }

  private ok(res: http.ServerResponse, requestId: string, data: unknown): void {
    sendJson(res, 200, { data, meta: { requestId, asOf: this.clock() } });
  }
}
