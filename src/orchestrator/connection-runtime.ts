/**
 * 按连接多租户运行时（multi-account-node-support D1/D2/D4/D7）。
 *
 * 握手时为每个 edge 连接建立一束**独立运行时** = 私有 EventBus + RoleDispatcher(+SessionContext/SessionMonitor)
 * + 该连接真实账号的 RiskController（经 per-account 注册表解析；同账号 N 连接天然共用同一 controller →
 * 额度按账号合并不翻倍）。该连接的入站事件只灌进自己的私有通道、出站指令只发回自己的 edgeId；断连即拆除。
 *
 * 私有通道经 onAny **tee 到全局观测总线**（observerBus）：跨连接的风控记账（interaction.occurred）与
 * 后台实时看板（panel-ws onAny）订阅 observerBus 即得到「跨所有连接聚合的单一全局只读流」，不漏不重，
 * 无需逐事件打标过滤（D1）。
 *
 * 编排上下文不再有「单一全局总线做跨连接协调」：连接之间结构上互不可见，新连接不重置他连接会话、不串号。
 */
import { EventBus } from '../event-bus/index.js';
import type { RoleDispatcher, SessionBudgetAction, SessionUsageSnapshot } from './role-dispatcher.js';
import type { EdgeSession } from '../comm/ws-server.js';
import type { RiskController } from '../risk/index.js';
import { normalizePlatformId, type PlatformId } from '../platform/index.js';

/** 单连接运行时束。 */
export interface ConnectionRuntime {
  sessionId: string;
  edgeId?: string;
  accountId: string;
  bus: EventBus;
  controller: RiskController;
  dispatcher: RoleDispatcher;
  /** 拆除：结束会话 + 解除 tee + 清空私有总线监听。 */
  teardown(): void;
}

export type HandshakeOutcome = { ok: true } | { ok: false; code: string; message: string };

/** 构造某连接 RoleDispatcher 的上下文（连接相关注入点：私有总线 / 该账号 controller / edgeId）。 */
export interface DispatcherBuildContext {
  bus: EventBus;
  controller: RiskController;
  accountId: string;
  edgeId?: string;
  /** 该连接账号的运行时平台（facebook-scheduled-comment 2.8）：喂 dispatcher 的 session-start 平台闸。缺省按 xhs（不设闸）。 */
  platform?: PlatformId;
}

export interface RuntimeRegistryDeps {
  /** 全局观测总线：每连接私有总线 tee 到此（看板聚合 + 风控记账）。 */
  observerBus: EventBus;
  /** 按真实账号解析 RiskController（per-account 注册表，同账号单例）。 */
  getController: (accountId: string) => Promise<RiskController>;
  /** 用连接上下文构造该连接的 RoleDispatcher（连接相关闸 / sendCommand 定向 / 私有总线均在此注入）。 */
  buildDispatcher: (ctx: DispatcherBuildContext) => RoleDispatcher;
  /** 握手时对新账号做幂等 upsert（不覆盖已配置行、不默认 active）。platform：仅新行登记时按 edge 声明的平台建行（2.5 死锁修复）。 */
  ensureAccount: (accountId: string, platform?: PlatformId) => Promise<void>;
  /** 从 accounts.platform 读取账号平台；缺省用于测试/旧装配时按 xhs 处理。 */
  getAccountPlatform?: (accountId: string) => Promise<PlatformId>;
  /** 同步读取账号昵称；用于避免 hello 展示名覆盖已有运营昵称。 */
  getNickname?: (accountId: string) => string | null;
  /** 写入账号昵称；必须只在账号已通过平台校验后调用。 */
  setNickname?: (accountId: string, nickname: string) => Promise<void> | void;
  /** 缺/空 accountId → 配置错误告警（拒绝握手，不建会话、不偷映射 default）。 */
  onConfigError: (session: EdgeSession, message: string) => void | Promise<void>;
  /** 同 edgeId 重连顶替：收掉该 sessionId 的旧 ws（→ ws close → onDisconnect 拆除其运行时）。 */
  closeEdge: (sessionId: string) => void;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** 连接运行时注册表：按 sessionId 持有，握手创建、断连拆除。 */
export class ConnectionRuntimeRegistry {
  private readonly bySession = new Map<string, ConnectionRuntime>();

  constructor(private readonly deps: RuntimeRegistryDeps) {}

  /** 该连接的私有事件总线（pre-hello / 无运行时 → 回落全局观测总线，仅作安全兜底）。 */
  busFor(session: EdgeSession): EventBus {
    return this.bySession.get(session.sessionId)?.bus ?? this.deps.observerBus;
  }

  /** 该连接的真实账号 RiskController（供 handler 的 budget / risk 通道按真实账号解析）。 */
  controllerForSession(session: EdgeSession): RiskController | undefined {
    return this.bySession.get(session.sessionId)?.controller;
  }

  /**
   * 握手：校验账号身份 → 顶替同 edgeId 旧连接 → 登记新账号 → 解析账号 controller →
   * 建私有总线(+tee) + RoleDispatcher 并 setup()。**不在此启动会话**——会话由 handler 在握手成功后
   * 向私有通道 emit edge.hello（携 accountId）触发，启动闸（含诚实人设闸）在 dispatcher 内部执行（D3）。
   */
  async onHandshake(session: EdgeSession): Promise<HandshakeOutcome> {
    const accountId = session.accountId?.trim();
    // 决策 4：缺 / 空 accountId 当配置错误拒绝握手，绝不偷映射成 default 开跑。
    if (!accountId) {
      await this.deps.onConfigError(
        session,
        '握手缺少 accountId：每个节点须显式声明 AIDCP_ACCOUNT_ID（登录派生的真实 userid），无名连接无可路由 / 限频 / 设人设的身份。',
      );
      return { ok: false, code: 'missing_account_id', message: '握手缺少 accountId（配置错误）' };
    }
    // retire-default-account：'default' 已退役为保留禁用标识，不再是合法账号身份；与缺账号同等当配置错误拒绝。
    if (accountId === 'default') {
      await this.deps.onConfigError(
        session,
        "握手 accountId='default' 被拒：default 已退役为保留标识，节点须以登录派生的真实小红书 userid 接入。",
      );
      return { ok: false, code: 'retired_account_id', message: "accountId='default' 已退役（保留禁用标识）" };
    }

    // edge-command-target-guard R1：缺 / 空 edgeId 当配置错误拒绝握手，与 accountId 校验对称。
    // 无节点号 = 无可路由的出站身份；放行只会制造「登记在册但一下发即广播」的危险连接
    // （出口 pushToEdges 在目标为空时会退化为向所有 edge 广播 → 可能把本连接的命令误投给他人）。
    const edgeId = session.edgeId?.trim();
    if (!edgeId) {
      await this.deps.onConfigError(
        session,
        '握手缺少 edgeId：每个节点须声明稳定的 edgeId（节点 / 机器身份）。无节点号 = 无可路由的出站身份，命令无法定向下发。',
      );
      return { ok: false, code: 'missing_edge_id', message: '握手缺少 edgeId（配置错误）' };
    }
    // 归一化：写回 trim 后的值，确保后续所有 session.edgeId 读取（重连顶替 / runtime.edgeId / 定向下发）一致。
    session.edgeId = edgeId;

    let edgePlatform: PlatformId;
    try {
      edgePlatform = normalizePlatformId(session.platform);
    } catch (err) {
      await this.deps.onConfigError(session, `握手平台无效：${(err as Error).message}`);
      return { ok: false, code: 'unsupported_platform', message: (err as Error).message };
    }
    session.platform = edgePlatform;
    // 新账号自动登记（幂等 upsert）。按 edge 声明的平台建新行：修复全新 Facebook 账号首连
    // 被 platform_mismatch 死锁（旧路径新行默认 xhs → 与 edge=facebook 不一致被拒）。既有行不覆盖。
    await this.deps.ensureAccount(accountId, edgePlatform);
    const accountPlatform = this.deps.getAccountPlatform
      ? await this.deps.getAccountPlatform(accountId)
      : 'xiaohongshu';
    if (accountPlatform !== edgePlatform) {
      const message = `edge platform=${edgePlatform} 与账号 ${accountId} accounts.platform=${accountPlatform} 不一致，拒绝派活`;
      await this.deps.onConfigError(session, message);
      return { ok: false, code: 'platform_mismatch', message };
    }

    const helloNickname = session.accountNickname?.trim();
    if (helloNickname && this.deps.setNickname) {
      const existingNickname = this.deps.getNickname?.(accountId)?.trim() ?? '';
      if (existingNickname !== helloNickname) {
        try {
          await Promise.resolve(this.deps.setNickname(accountId, helloNickname));
        } catch (err) {
          this.deps.logger?.warn?.(`[runtime] persist hello nickname failed for account=${accountId}: ${(err as Error).message}`);
        }
      }
    }

    // 同 edgeId 重连顶替（同一节点回来，不计为并行第二节点）：收掉该 edgeId 的旧连接。
    // 仅顶替「不同 sessionId 但同 edgeId」的旧运行时；不同 edgeId 则视为真并行第二节点，并存。
    for (const rt of [...this.bySession.values()]) {
      if (rt.edgeId === session.edgeId && rt.sessionId !== session.sessionId) {
        this.deps.logger?.log?.(
          `[runtime] edgeId=${session.edgeId} 重连，顶替旧连接 sessionId=${rt.sessionId}（account=${rt.accountId}）`,
        );
        this.deps.closeEdge(rt.sessionId);
      }
    }

    // 解析该连接账号的 RiskController（同账号 N 连接经注册表天然共用 → 额度合并不翻倍，D7①）。
    const controller = await this.deps.getController(accountId);

    // 每连接私有事件通道 + tee 到全局观测总线（看板聚合 + 风控记账消费）。
    const bus = new EventBus();
    const teeUnsub = bus.onAny((event, data) => this.deps.observerBus.emitRaw(event, data));

    const runtime: ConnectionRuntime = {
      sessionId: session.sessionId,
      edgeId: session.edgeId,
      accountId,
      bus,
      controller,
      dispatcher: undefined as unknown as RoleDispatcher,
      teardown: () => {
        try {
          runtime.dispatcher?.endSession('disconnect');
        } catch (err) {
          this.deps.logger?.warn?.(`[runtime] endSession on teardown error: ${(err as Error).message}`);
        }
        teeUnsub();
        bus.removeAllListeners();
      },
    };

    runtime.dispatcher = this.deps.buildDispatcher({ bus, controller, accountId, edgeId: session.edgeId, platform: accountPlatform });
    runtime.dispatcher.setCurrentAccountId(accountId);
    runtime.dispatcher.setup();
    this.bySession.set(session.sessionId, runtime);
    this.deps.logger?.log?.(
      `[runtime] 连接运行时已建立 sessionId=${session.sessionId} edgeId=${session.edgeId ?? '-'} account=${accountId}（在线连接=${this.bySession.size}）`,
    );
    return { ok: true };
  }

  /** 断连：拆除该连接运行时（结束会话 + 解 tee + 清监听）。 */
  onDisconnect(session: EdgeSession): void {
    const rt = this.bySession.get(session.sessionId);
    if (!rt) return;
    rt.teardown();
    this.bySession.delete(session.sessionId);
    this.deps.logger?.log?.(
      `[runtime] 连接断开，运行时已拆除 sessionId=${session.sessionId} account=${rt.accountId}（在线连接=${this.bySession.size}）`,
    );
  }

  /** 面板 /dispatch 恢复：对所有连接经启动闸尝试启动（未绑人设的仍被诚实拒绝）。 */
  startAll(): void {
    for (const rt of this.bySession.values()) rt.dispatcher.tryStartSession();
  }

  /** 面板 /dispatch 暂停：结束所有连接会话。 */
  endAll(reason?: string): void {
    for (const rt of this.bySession.values()) rt.dispatcher.endSession(reason);
  }

  /**
   * 发布让位（change session-auto-resume-with-excursions）：发布触发时结束该账号当前浏览会话，
   * 使发布独占边缘。结束标记不可续场（不触发休息）；无活跃会话则 no-op。返回匹配的连接数。
   */
  endSessionForAccount(accountId: string, reason?: string): number {
    let n = 0;
    for (const rt of this.bySession.values()) {
      if (rt.accountId === accountId) {
        rt.dispatcher.endSession(reason);
        n++;
      }
    }
    return n;
  }

  /**
   * 发布让位结束 → 该账号起一场全新浏览会话（经续场各闸：调度开关/人设/活跃时段/每日上限/风控）。
   * 闸不过则诚实不起（如发布发生在活跃窗口外）。返回匹配的连接数。
   */
  resumeSessionForAccount(accountId: string): number {
    let n = 0;
    for (const rt of this.bySession.values()) {
      if (rt.accountId === accountId) {
        rt.dispatcher.tryAutoResume();
        n++;
      }
    }
    return n;
  }

  /**
   * 后台为该账号绑定人设后（change auto-start-on-persona-bind）：唤醒该账号所有「已连接但因未绑人设被
   * 启动闸短路、未在跑」的连接就地开会话（含 scroll 重驱唤醒干等的边端）。覆盖同账号 N 连接；
   * 对已在跑的连接是 no-op（不打断）。返回匹配的连接数。
   */
  startSessionForAccount(accountId: string): number {
    let n = 0;
    for (const rt of this.bySession.values()) {
      if (rt.accountId === accountId) {
        rt.dispatcher.startOnPersonaBound();
        n++;
      }
    }
    return n;
  }

  /**
   * 取该账号某在线连接的私有总线 + edgeId（change comment-search-command：按需评论任务接管边端后，
   * 用私有总线等边端上报、用 edgeId 定向下发命令）。同账号多连接取**首个带 edgeId** 的；无匹配 → null。
   */
  runtimeForAccount(accountId: string): { bus: EventBus; edgeId?: string } | null {
    let fallback: { bus: EventBus; edgeId?: string } | null = null;
    for (const rt of this.bySession.values()) {
      if (rt.accountId !== accountId) continue;
      if (rt.edgeId) return { bus: rt.bus, edgeId: rt.edgeId };
      fallback ??= { bus: rt.bus, edgeId: rt.edgeId };
    }
    return fallback;
  }

  /** Read-only current single-session quota usage for an online account/edge. */
  sessionUsageForAccount(accountId: string, edgeId?: string): SessionUsageSnapshot | null {
    let fallback: SessionUsageSnapshot | null = null;
    for (const rt of this.bySession.values()) {
      if (rt.accountId !== accountId) continue;
      const snapshot = rt.dispatcher.sessionUsageSnapshot();
      if (edgeId && rt.edgeId === edgeId) return snapshot;
      if (!fallback || snapshot.active) fallback = snapshot;
    }
    return fallback;
  }

  /** Remaining current single-session budget for an online account/edge. Missing runtime fails closed as 0. */
  remainingSessionBudgetForAccount(accountId: string, action: SessionBudgetAction, edgeId?: string): number {
    let fallback: ConnectionRuntime | null = null;
    for (const rt of this.bySession.values()) {
      if (rt.accountId !== accountId) continue;
      if (edgeId && rt.edgeId === edgeId) return rt.dispatcher.remainingBudget(action);
      if (!fallback || rt.dispatcher.active) fallback = rt;
    }
    return fallback?.dispatcher.remainingBudget(action) ?? 0;
  }

  /** Consume current single-session budget for an online account/edge. Returns false when missing or exhausted. */
  consumeSessionBudgetForAccount(accountId: string, action: SessionBudgetAction, edgeId?: string): boolean {
    let fallback: ConnectionRuntime | null = null;
    for (const rt of this.bySession.values()) {
      if (rt.accountId !== accountId) continue;
      if (edgeId && rt.edgeId === edgeId) return rt.dispatcher.consumeBudget(action);
      if (!fallback || rt.dispatcher.active) fallback = rt;
    }
    return fallback?.dispatcher.consumeBudget(action) ?? false;
  }

  /**
   * 当前在线账号（有 edgeId 的连接，去重；change content-schedule-auto-publish）。
   * 供 ContentScheduler 每分钟 tick 扇出——只对在线账号评估排期，离线账号本槽自然跳过（诚实、不补跑）。
   */
  onlineAccountIds(): string[] {
    const ids = new Set<string>();
    for (const rt of this.bySession.values()) {
      if (rt.edgeId) ids.add(rt.accountId);
    }
    return [...ids];
  }

  /** 当前活跃（已 startSession）的连接数。 */
  activeCount(): number {
    let n = 0;
    for (const rt of this.bySession.values()) if (rt.dispatcher.active) n++;
    return n;
  }

  /** 当前持有的连接运行时总数。 */
  runtimeCount(): number {
    return this.bySession.size;
  }
}
