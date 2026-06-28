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
import type { PanelDeps, PanelConfig, PanelHandle, SessionLimitPatchInput, ResumeConfigPatchInput } from './types.js';
import { startPanelWs, type PanelWsHandle } from './panel-ws.js';
import type { PublishApprovalPayload } from '../feishu/index.js';
import type { RiskSignalKind, RiskQuotaLevel } from '../risk/index.js';
import { isKnownRole } from '../config/role-catalog.js';
import { isAllowedCredential } from '../llm/index.js';

/** 登录/写体很小，限制请求体大小防滥用。 */
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(buf);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createRequestHandler(
  deps: PanelDeps,
  config: PanelConfig,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const logger = config.logger ?? console;

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

    if (method === 'GET' && url === '/api/me') {
      sendJson(res, 200, { sub: verified.payload.sub, panelApiVersion: buildVersionPayload().panelApiVersion });
      return;
    }
    if (method === 'GET' && url === '/api/dashboard/summary') {
      const [totals, totalsByAccount, likeRate, accounts, todayPublishes, alerts] = await Promise.all([
        deps.panelStore.todayTotals(),
        deps.panelStore.todayTotalsByAccount(),
        deps.panelStore.likeRate(),
        deps.panelStore.listAccounts(),
        deps.panelStore.todayPublishCount(),
        deps.panelStore.listAlerts({ limit: 50 }),
      ]);
      sendJson(res, 200, {
        asOf: Date.now(),
        edgesOnline: deps.edgeServer.onlineEdgeCount(), // staleness-aware（死连接不算在线，D9）
        totals: { ...totals, publish: todayPublishes },
        // V1 task 9.6：归因已在事件上流通（interaction.occurred 带 accountId），上真按账号切片。
        totalsByAccount,
        likeRate,
        accounts,
        alerts, // V1 task 9.5：真告警（未解决），来自 alerts 表
        // 归因已落地：按账号切片为真数字（保留键 default 即单账号现实下的真实账号）。
        attributionPending: false,
        // 调度引擎状态（V1 task 9.4：单全局 RoleDispatcher；per-edge 拆分见 design 步骤 8）。
        dispatchActive: deps.commandActions.dispatchActive ? deps.commandActions.dispatchActive() : null,
      });
      return;
    }
    if (method === 'GET' && url === '/api/accounts') {
      sendJson(res, 200, { accounts: await deps.panelStore.listAccounts() });
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
    if (method === 'GET' && url === '/api/content/published') {
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const accountId = query.get('accountId') ?? undefined;
      sendJson(res, 200, { items: await deps.panelStore.publishedHistory(50, accountId) });
      return;
    }
    if (method === 'GET' && url === '/api/content/queue') {
      sendJson(res, 200, deps.publishOrchestrator.getStatus());
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
      const model = query.get('model') ?? undefined;
      sendJson(
        res,
        200,
        await deps.tokenUsage.usage({
          ...(fromMs !== undefined ? { fromMs } : {}),
          ...(toMs !== undefined ? { toMs } : {}),
          ...(accountId ? { accountId } : {}),
          ...(role ? { role } : {}),
          ...(model ? { model } : {}),
        }),
      );
      return;
    }

    // 通知联系人名册（change notification-contact-registry）：按账号联系人列表（accountId 必填，缺则 400；
    // 绝不默认 default、不提供全账号合并视图＝PII 隔离）。未注入 503；缺表由 store 回落空。
    if (method === 'GET' && url === '/api/notification/contacts') {
      if (!deps.notificationContact) {
        sendJson(res, 503, { error: 'notification_contact_unavailable' });
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const accountId = (query.get('accountId') ?? '').trim();
      if (!accountId) {
        sendJson(res, 400, { error: 'bad_request', reason: 'account_required' });
        return;
      }
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

    // ── 写操作（task 4）：经拥有写的对象，绝不乐观假成功 ──────────────────
    if (method === 'POST' && url.startsWith('/api/publish/') && url.endsWith('/approve')) {
      const requestId = decodeURIComponent(url.slice('/api/publish/'.length, -'/approve'.length));
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const { approved, payload } = (body ?? {}) as { approved?: unknown; payload?: PublishApprovalPayload };
      if (typeof approved !== 'boolean') {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      // payload 对 Web 审批为占位（edge 从 publish.request 已知内容）；first-writer-wins 的决定才是关键
      const result = await deps.writeApprovalSignal(
        requestId,
        approved,
        payload ?? { title: '', content: '', tags: [] },
      );
      sendJson(res, 200, result); // {written} 或 {alreadyDecided}，绝不 published
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
      if (command === 'pause') {
        sendJson(res, 200, await deps.commandActions.pause(accountId));
        return;
      }
      if (command === 'resume') {
        sendJson(res, 200, await deps.commandActions.resume(accountId));
        return;
      }
      sendJson(res, 400, { error: 'bad_request', reason: 'unknown_command' });
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
        const { textProvider, textModel, imageModel } = (body ?? {}) as {
          textProvider?: unknown;
          textModel?: unknown;
          imageModel?: unknown;
        };
        // 至少一个非空字符串字段；空 / 非字符串一律不接受（不静默忽略全空请求）
        const patch: { textProvider?: string; textModel?: string; imageModel?: string } = {};
        if (typeof textProvider === 'string' && textProvider.trim()) patch.textProvider = textProvider.trim();
        if (typeof textModel === 'string' && textModel.trim()) patch.textModel = textModel.trim();
        if (typeof imageModel === 'string' && imageModel.trim()) patch.imageModel = imageModel.trim();
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
      // change model-config-volcengine-provider：按厂商写密钥；(provider, field) 须在注册表派生的白名单内。
      const { provider, field, value } = (body ?? {}) as {
        provider?: unknown;
        field?: unknown;
        value?: unknown;
      };
      if (typeof provider !== 'string' || typeof field !== 'string' || !isAllowedCredential(provider, field)) {
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
      const { model, provider, temperature } = (body ?? {}) as {
        model?: unknown;
        provider?: unknown;
        temperature?: unknown;
      };
      const patch: { model?: string | null; provider?: string | null; temperature?: number | null } = {};
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
      if (patch.model === undefined && patch.temperature === undefined) {
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
      const { model, provider } = (body ?? {}) as { model?: unknown; provider?: unknown };
      // model 必须存在，且为 string 或 null（null/'' = 清除覆盖回落）。
      if (model !== null && typeof model !== 'string') {
        sendJson(res, 400, { error: 'bad_request', reason: 'model_type' });
        return;
      }
      let provPatch: string | null = null;
      if (provider !== undefined) {
        if (provider === null || typeof provider === 'string') provPatch = provider;
        else {
          sendJson(res, 400, { error: 'bad_request', reason: 'provider_type' });
          return;
        }
      }
      const result = await deps.categoryConfig.setCategoryConfig(
        categoryId,
        model as string | null,
        provPatch,
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

    // ── 单场会话上限配置（全局单例，change restore-auto-resume-and-global-safety-config）──────
    // append 链（在 D/quotas 之后、F/persona 之前）。全局写非乐观回真态；非法数字整块拒
    // （invalid_value→400），绝不部分落库；只写 session_config_global，不碰风控状态单写路径。
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
      const { maxDurationMin, likes, collects, follows, searches, comments, comment_likes,
              collectSaveLikeDenom, followFansDenom } =
        (body ?? {}) as Record<string, unknown>;
      // 各数字字段须为数字或缺省（缺省=该项不改）；类型不对直接 400（语义校验在 facade）。全局配置、无账号维度。
      const patch: SessionLimitPatchInput = {};
      const numFields = ['maxDurationMin', 'likes', 'collects', 'follows', 'searches', 'comments', 'comment_likes',
        'collectSaveLikeDenom', 'followFansDenom'] as const;
      const rawNums: Record<string, unknown> = {
        maxDurationMin,
        likes,
        collects,
        follows,
        searches,
        comments,
        comment_likes,
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
      const result = await deps.sessionLimits.set(patch, verified.payload.sub);
      if (!result.ok) {
        // invalid_value / no_valid_fields → 400（绝不部分落库、绝不假成功）。
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
      // persona 必须存在且为字符串（''=清除覆盖回落）。
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

    sendJson(res, 404, { error: 'not_found' });
  }

  return (req, res) => {
    void handle(req, res).catch((err) => {
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
