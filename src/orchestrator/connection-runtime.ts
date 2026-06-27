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
import type { RoleDispatcher } from './role-dispatcher.js';
import type { EdgeSession } from '../comm/ws-server.js';
import type { RiskController } from '../risk/index.js';

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
}

export interface RuntimeRegistryDeps {
  /** 全局观测总线：每连接私有总线 tee 到此（看板聚合 + 风控记账）。 */
  observerBus: EventBus;
  /** 按真实账号解析 RiskController（per-account 注册表，同账号单例）。 */
  getController: (accountId: string) => Promise<RiskController>;
  /** 用连接上下文构造该连接的 RoleDispatcher（连接相关闸 / sendCommand 定向 / 私有总线均在此注入）。 */
  buildDispatcher: (ctx: DispatcherBuildContext) => RoleDispatcher;
  /** 握手时对新账号做幂等 upsert（不覆盖已配置行、不默认 active）。 */
  ensureAccount: (accountId: string) => Promise<void>;
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
        '握手缺少 accountId：每个节点（含默认账号）须显式声明 AIDCP_ACCOUNT_ID，无名连接无可路由 / 限频 / 设人设的身份。',
      );
      return { ok: false, code: 'missing_account_id', message: '握手缺少 accountId（配置错误）' };
    }

    // 同 edgeId 重连顶替（同一节点回来，不计为并行第二节点）：收掉该 edgeId 的旧连接。
    // 仅顶替「不同 sessionId 但同 edgeId」的旧运行时；不同 edgeId 则视为真并行第二节点，并存。
    if (session.edgeId) {
      for (const rt of [...this.bySession.values()]) {
        if (rt.edgeId === session.edgeId && rt.sessionId !== session.sessionId) {
          this.deps.logger?.log?.(
            `[runtime] edgeId=${session.edgeId} 重连，顶替旧连接 sessionId=${rt.sessionId}（account=${rt.accountId}）`,
          );
          this.deps.closeEdge(rt.sessionId);
        }
      }
    }

    // 新账号自动登记（幂等 upsert）。
    await this.deps.ensureAccount(accountId);

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

    runtime.dispatcher = this.deps.buildDispatcher({ bus, controller, accountId, edgeId: session.edgeId });
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
