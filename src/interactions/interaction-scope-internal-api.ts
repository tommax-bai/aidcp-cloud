import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { isReplyPolicy, isReplyProfile, isReplyRule, isReplyTemplate } from './reply-config.js';
import type { ReplyConfigResolver } from './reply-config-resolver.js';
import type { ReplyConfigScopeStore } from './reply-config-scope-store.js';
import type { ReplyPreviewBuilderPort } from './interaction-automation-ports.js';
import { InteractionError, type ReplyConfigSource } from '../kernel/interaction-types.js';
import type { InteractionGrant } from './interaction-internal-api.js';

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

function onlyKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return Object.keys(value).length === required.length && required.every((key) => key in value);
}

function expectedVersion(body: Record<string, unknown>): number {
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'expectedVersion 不合法。', 422);
  }
  return body.expectedVersion as number;
}

function sourceFromBody(body: Record<string, unknown>): ReplyConfigSource {
  if (!onlyKeys(body, ['type','groupLabel']) || (body.type !== 'group' && body.type !== 'default') ||
      !(body.groupLabel === null || typeof body.groupLabel === 'string')) {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', '配置作用域不合法。', 422);
  }
  if (body.type === 'default' && body.groupLabel !== null) {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', '默认策略不能带分组名称。', 422);
  }
  return { type: body.type, groupLabel: body.type === 'group' ? (body.groupLabel as string) : null };
}

function encodeCursor(value: { createdAt: number; eventId: string }, secret: string): string {
  const data = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

function decodeCursor(value: string, secret: string): { createdAt: number; eventId: string } {
  try {
    const [data, provided, extra] = value.split('.');
    if (!data || !provided || extra) throw new Error('invalid_cursor');
    const expected = createHmac('sha256', secret).update(data).digest();
    const signature = Buffer.from(provided, 'base64url');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error('invalid_signature');
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as { createdAt?: unknown; eventId?: unknown };
    if (!Number.isInteger(parsed.createdAt) || typeof parsed.eventId !== 'string' || !parsed.eventId) throw new Error('invalid_cursor');
    return { createdAt: parsed.createdAt as number, eventId: parsed.eventId };
  } catch {
    throw new InteractionError('INTERACTION_VALIDATION_FAILED', '分页游标不合法。', 422);
  }
}

export class InteractionScopeInternalApi {
  private readonly clock: () => number;

  constructor(private readonly deps: {
    scopes: ReplyConfigScopeStore;
    resolver: ReplyConfigResolver;
    workflow: ReplyPreviewBuilderPort;
    grantsFor: (actor: string) => ReadonlySet<InteractionGrant>;
    cursorSecret: string;
    clock?: () => number;
  }) {
    this.clock = deps.clock ?? Date.now;
  }

  private require(actor: string, grant: InteractionGrant): void {
    if (!this.deps.grantsFor(actor).has(grant)) {
      throw new InteractionError('INTERACTION_PERMISSION_DENIED', '缺少互动配置权限。', 403);
    }
  }

  private ok(res: http.ServerResponse, requestId: string, data: unknown): void {
    sendJson(res, 200, { data, meta: { requestId, asOf: this.clock() } });
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, actor: string): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const root = '/api/interaction-reply-config-scopes';
    const effectivePrefix = '/api/accounts/';
    const effectiveSuffix = '/effective-reply-config';
    const isEffective = url.pathname.startsWith(effectivePrefix) && url.pathname.endsWith(effectiveSuffix);
    if (!isEffective && url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return false;
    const requestId = randomUUID();
    try {
      if (isEffective) {
        this.require(actor, 'interaction.config.view');
        const encoded = url.pathname.slice(effectivePrefix.length, -effectiveSuffix.length);
        const accountId = decodeURIComponent(encoded);
        const effective = await this.deps.resolver.resolve(accountId);
        this.ok(res, requestId, {
          accountId,
          mode: effective.mode,
          status: effective.status,
          reason: effective.reason,
          source: effective.source,
          currentVersion: effective.head?.currentVersion ?? effective.snapshot?.configVersion ?? null,
          draftVersion: effective.head?.draftVersion ?? null,
          publishedVersion: effective.head?.publishedVersion ?? effective.snapshot?.configVersion ?? null,
        });
        return true;
      }
      await this.route(req, res, url, actor, requestId, root);
    } catch (error) {
      const known = error instanceof InteractionError ? error :
        new InteractionError('INTERACTION_INTERNAL_ERROR', '互动配置服务暂时不可用。', 500, true);
      sendJson(res, known.httpStatus, { error: { code: known.code, message: known.message, requestId,
        retryable: known.retryable, ...(known.details ? { details: known.details } : {}) } });
    }
    return true;
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    actor: string,
    requestId: string,
    root: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const rest = url.pathname === root ? '' : url.pathname.slice(root.length + 1);
    if (!rest) {
      if (method === 'GET') {
        this.require(actor, 'interaction.config.view');
        this.ok(res, requestId, { items: await this.deps.scopes.listScopes() });
        return;
      }
      if (method === 'POST') {
        this.require(actor, 'interaction.config.edit');
        const source = sourceFromBody(await readBody(req));
        this.ok(res, requestId, { head: await this.deps.scopes.ensureScope(source, actor) });
        return;
      }
    }
    const slash = rest.indexOf('/');
    const scopeId = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    const suffix = slash < 0 ? '' : rest.slice(slash + 1);
    const head = await this.deps.scopes.getHead(scopeId);
    if (!head) throw new InteractionError('INTERACTION_NOT_FOUND', '回复策略作用域不存在。', 404);

    if (!suffix && method === 'GET') {
      this.require(actor, 'interaction.config.view');
      const selector = head.draftVersion === null ? 'published' : 'draft';
      const snapshot = await this.deps.scopes.getSnapshot(scopeId, selector);
      this.ok(res, requestId, { head, snapshot });
      return;
    }
    if (suffix === 'initialize' && method === 'POST') {
      this.require(actor, 'interaction.config.edit');
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion']) || expectedVersion(body) !== 0) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '初始化请求必须使用 expectedVersion=0。', 422);
      }
      const snapshot = await this.deps.scopes.initialize(scopeId, 0, actor);
      this.ok(res, requestId, { head: await this.deps.scopes.getHead(scopeId), initializedVersion: snapshot.configVersion });
      return;
    }
    if (suffix === 'policy' && method === 'PUT') {
      this.require(actor, 'interaction.config.edit');
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion','policy']) || !isReplyPolicy(body.policy)) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'policy 不合法。', 422);
      }
      const snapshot = await this.deps.scopes.savePolicy(scopeId, expectedVersion(body), actor, body.policy);
      this.ok(res, requestId, { head: await this.deps.scopes.getHead(scopeId), snapshot });
      return;
    }
    if (suffix === 'profiles' && method === 'PUT') {
      this.require(actor, 'interaction.config.edit');
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion','profiles']) || !Array.isArray(body.profiles) || body.profiles.length !== 2 ||
          !body.profiles.every(isReplyProfile) || new Set(body.profiles.map((profile) => profile.channel)).size !== 2) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'profiles 必须同时包含 comment 与 dm。', 422);
      }
      const snapshot = await this.deps.scopes.saveProfiles(scopeId, expectedVersion(body), actor, body.profiles);
      this.ok(res, requestId, { head: await this.deps.scopes.getHead(scopeId), snapshot });
      return;
    }
    if (suffix === 'templates' || suffix.startsWith('templates/')) {
      const templateId = suffix === 'templates' ? null : decodeURIComponent(suffix.slice('templates/'.length));
      if ((method === 'POST' && !templateId) || (method === 'PUT' && templateId)) {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion','template']) || !isReplyTemplate(body.template) ||
            (templateId !== null && body.template.templateId !== templateId)) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'template 不合法。', 422);
        }
        const snapshot = await this.deps.scopes.saveTemplate(scopeId, expectedVersion(body), actor, body.template);
        this.ok(res, requestId, { head: await this.deps.scopes.getHead(scopeId), snapshot });
        return;
      }
      if (method === 'DELETE' && templateId) {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion'])) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求字段不合法。', 422);
        const snapshot = await this.deps.scopes.archiveTemplate(scopeId, expectedVersion(body), actor, templateId);
        this.ok(res, requestId, { head: await this.deps.scopes.getHead(scopeId), snapshot });
        return;
      }
    }
    if (suffix === 'rules' || suffix.startsWith('rules/')) {
      const ruleId = suffix === 'rules' ? null : decodeURIComponent(suffix.slice('rules/'.length));
      if ((method === 'POST' && !ruleId) || (method === 'PUT' && ruleId)) {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion','rule']) || !isReplyRule(body.rule) ||
            (ruleId !== null && body.rule.ruleId !== ruleId)) {
          throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'rule 不合法。', 422);
        }
        const snapshot = await this.deps.scopes.saveRule(scopeId, expectedVersion(body), actor, body.rule);
        this.ok(res, requestId, { head: await this.deps.scopes.getHead(scopeId), snapshot });
        return;
      }
      if (method === 'DELETE' && ruleId) {
        this.require(actor, 'interaction.config.edit');
        const body = await readBody(req);
        if (!onlyKeys(body, ['expectedVersion'])) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '请求字段不合法。', 422);
        const snapshot = await this.deps.scopes.deleteRule(scopeId, expectedVersion(body), actor, ruleId);
        this.ok(res, requestId, { head: await this.deps.scopes.getHead(scopeId), snapshot });
        return;
      }
    }
    if (suffix === 'publish' && method === 'POST') {
      this.require(actor, 'interaction.config.publish');
      const body = await readBody(req);
      if (!onlyKeys(body, ['expectedVersion'])) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '发布请求不合法。', 422);
      const published = await this.deps.scopes.publish(scopeId, expectedVersion(body), actor);
      this.ok(res, requestId, { head: await this.deps.scopes.getHead(scopeId), publishedAt: published.publishedAt,
        publishedBy: published.publishedBy, memberCount: head.memberCount });
      return;
    }
    if (suffix === 'preview' && method === 'POST') {
      this.require(actor, 'interaction.config.preview');
      const body = await readBody(req);
      if (!onlyKeys(body, ['accountId','expectedVersion','use','channel','messageType','userMessage','videoTitle','userName']) ||
          typeof body.accountId !== 'string' || (body.use !== 'draft' && body.use !== 'published') ||
          (body.channel !== 'comment' && body.channel !== 'dm') || !['text','image','unknown'].includes(String(body.messageType)) ||
          !(body.userMessage === null || typeof body.userMessage === 'string') ||
          !(body.videoTitle === null || typeof body.videoTitle === 'string') ||
          !(body.userName === null || typeof body.userName === 'string')) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', 'preview 请求不合法。', 422);
      }
      if (!await this.deps.scopes.accountMatchesScope(body.accountId, scopeId)) {
        throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '预览账号不属于当前策略作用域。', 409);
      }
      if (body.channel === 'dm') this.require(actor, 'interaction.dm.view_full');
      const current = await this.deps.scopes.getHead(scopeId);
      if (!current || current.currentVersion !== expectedVersion(body)) {
        throw new InteractionError('INTERACTION_VERSION_CONFLICT', '配置版本已变化。', 409, false,
          { currentVersion: current?.currentVersion ?? 0 });
      }
      const snapshot = await this.deps.scopes.getSnapshot(scopeId, body.use, body.accountId);
      if (!snapshot) throw new InteractionError('INTERACTION_CONFIG_MISSING', '请求的配置快照不存在。', 404);
      const preview = await this.deps.workflow.buildPreview(snapshot, {
        channel: body.channel, messageType: body.messageType as 'text' | 'image' | 'unknown',
        text: body.userMessage as string | null, videoTitle: body.videoTitle as string | null,
        userName: body.userName as string | null, recentMessages: [],
      }, null);
      await this.deps.scopes.recordPreview(scopeId, actor, snapshot.configVersion, body.accountId);
        const automaticPolicy = snapshot.policy.mode === 'auto_safe' && snapshot.policy.sendReplies &&
          snapshot.policy.channels[body.channel].enabled && snapshot.policy.channels[body.channel].allowAutoSend;
        const action = !preview.matchedRuleId ? 'no_match' : !preview.finalText ? 'blocked'
          : snapshot.policy.mode === 'draft_only' || !snapshot.policy.sendReplies ? 'draft'
            : preview.requiresApproval || !automaticPolicy ? 'review_required' : 'would_auto_send';
      this.ok(res, requestId, {
        scopeId, source: head.source, accountId: body.accountId, configVersion: snapshot.configVersion,
        matchedRule: preview.matchedRuleId ? { ruleId: preview.matchedRuleId, reason: 'matched_by_priority_and_conditions' } : null,
        template: preview.templateId && preview.templateVersion && preview.renderedText
          ? { templateId: preview.templateId, templateVersion: preview.templateVersion, renderedText: preview.renderedText } : null,
        polish: preview.renderedText && preview.polishedText ? { before: preview.renderedText, after: preview.polishedText,
          fallbackUsed: preview.fallbacks.polisher !== 'none', fallbackReason: preview.fallbacks.polisher,
          meaningChanged: preview.meaningChanged,
          introducedClaims: preview.introducedClaims } : null,
        risk: { level: preview.riskLevel, tags: preview.riskReasons, reasons: preview.reviewReasons }, action,
      });
      return;
    }
    if (suffix === 'audit' && method === 'GET') {
      this.require(actor, 'interaction.audit.view');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
          [...url.searchParams.keys()].some((key) => key !== 'limit' && key !== 'cursor')) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '审计分页参数不合法。', 422);
      }
      const rawCursor = url.searchParams.get('cursor');
      const events = await this.deps.scopes.listAudit(scopeId, limit + 1,
        rawCursor ? decodeCursor(rawCursor, this.deps.cursorSecret) : undefined);
      const page = events.slice(0, limit);
      const items = page.map(({ labels: _labels, ...event }) => event);
      const tail = events.length > limit ? page.at(-1) : undefined;
      this.ok(res, requestId, { scopeId, items, nextCursor: tail
        ? encodeCursor({ createdAt: tail.createdAt, eventId: tail.eventId }, this.deps.cursorSecret) : null });
      return;
    }
    throw new InteractionError('INTERACTION_NOT_FOUND', '接口不存在。', 404);
  }
}
