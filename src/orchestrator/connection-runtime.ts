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
import type { ResumeGateVerdict } from '../comm/browser-standby.js';
import type { RiskController } from '../risk/index.js';
import type { DeploymentTarget } from '../deployment-target.js';
import type { AccountOwnershipPort, OwnershipMode } from '../risk/ownership.js';
import {
  isOrchestrationCapabilitySupported,
  normalizePlatformId,
  type PlatformId,
} from '../platform/index.js';

/** 单连接运行时束。 */
export interface ConnectionRuntime {
  sessionId: string;
  edgeId?: string;
  accountId: string;
  platform: PlatformId;
  capabilities?: string[];
  bus: EventBus;
  controller: RiskController;
  /** 浏览业务运行时只在 welcome 已写出后激活；interaction-only / degraded 连接保持 undefined。 */
  dispatcher?: RoleDispatcher;
  welcomed: boolean;
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
  /**
   * 边缘握手声明的能力位（change facebook-feed-inline-browse）：喂 dispatcher 的就地读/赞版本偏斜闸
   * （含 inline_targeting 才对该连接开 surface:'feed'）。本连接握手快照，重连按新连接重建。
   */
  capabilities?: string[];
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
  /**
   * 账号归属闸（change risk-state-cross-process-integrity）。三项缺任一即整闸不启用
   * （与今天行为逐位一致），绝不半开——半开的归属闸比没有更危险。
   */
  ownership?: {
    /** 本进程的部署目标（服务端注入，MUST NOT 从握手载荷推导）。 */
    executionTarget: DeploymentTarget;
    mode: OwnershipMode;
    port: AccountOwnershipPort;
    /** 归属占位成功 / 观察模式下本会被拒的握手，都经此留痕。永不抛。 */
    onEvent?: (info: {
      accountId: string;
      kind: 'claimed' | 'mismatch_rejected' | 'mismatch_observed';
      ownerTarget: DeploymentTarget | null;
      detail: string;
    }) => void;
    /** 归属占位成功后强制重放该账号计数（MUST NOT 复用可能陈旧的内存值）。 */
    onClaimed?: (accountId: string) => Promise<void> | void;
  };
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
   * 握手准入：校验账号身份 → 登记新账号 → 解析账号 controller → 建私有总线(+tee)。
   * 不在这里构造 RoleDispatcher、读取人设或顶替旧 edge：这些业务/提交动作只在 welcome 已写出后执行，
   * 防止业务闸或候选连接失败被升级成传输握手失败。
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

    // 归属闸（change risk-state-cross-process-integrity）：与上面的 platform_mismatch 对称——
    // 同一个 onConfigError 通道、同一种「拒绝码 + 人话说明」形态，不新增分支语义、不新增协议消息。
    //
    // 为什么必须在握手拦：dev 与 ol 共用一个库。放行一个非属主账号，等于让两个进程各按自己的
    // 内存计数发真实动作——合计放行量是单份上限的两倍；再叠上 risk_state 盲写，另一个 target
    // 刚写下的 restricted 会被这边陈旧的 normal 盖回去。那两件事都不会报错，只会静默超发。
    const ownershipOutcome = await this.resolveOwnership(session, accountId);
    if (ownershipOutcome) return ownershipOutcome;

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

    // 解析该连接账号的 RiskController（同账号 N 连接经注册表天然共用 → 额度合并不翻倍，D7①）。
    const controller = await this.deps.getController(accountId);

    // 每连接私有事件通道 + tee 到全局观测总线（看板聚合 + 风控记账消费）。
    const bus = new EventBus();
    const teeUnsub = bus.onAny((event, data) => this.deps.observerBus.emitRaw(event, data));

    const runtime: ConnectionRuntime = {
      sessionId: session.sessionId,
      edgeId: session.edgeId,
      accountId,
      platform: accountPlatform,
      capabilities: session.capabilities,
      bus,
      controller,
      dispatcher: undefined,
      welcomed: false,
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

    this.bySession.set(session.sessionId, runtime);
    this.deps.logger?.log?.(
      `[runtime] 传输运行时已建立 sessionId=${session.sessionId} edgeId=${session.edgeId ?? '-'} account=${accountId}（在线连接=${this.bySession.size}）`,
    );
    return { ok: true };
  }

  /**
   * 账号归属解析：未归属 → 原子占位；归属本 target → 放行；归属对方 → 诚实拒绝。
   * 返回非空即「握手到此为止」，返回 null 即放行。
   *
   * 观察模式（`AIDCP_RISK_OWNERSHIP_ENFORCE=false`，默认）：**占位照做、拒绝不做**，
   * 但每一次本会被拒的握手都留一条可检索的告警。观察模式 MUST NOT 静默——它的意义是
   * 「先证明零跨 target 争用再翻开强制」，不是「先假装没事」。
   */
  private async resolveOwnership(session: EdgeSession, accountId: string): Promise<HandshakeOutcome | null> {
    const ownership = this.deps.ownership;
    if (!ownership || ownership.mode === 'off') return null;
    const { executionTarget, mode, port } = ownership;

    let owner: DeploymentTarget | null;
    try {
      owner = await port.getExecutionTarget(accountId);
    } catch (err) {
      // 读不到归属就**不拦**：把数据库抖动升级成「全车队握手失败」，代价远大于它防住的东西。
      // 真正的止血在条件写那一层（非属主的 risk_state 写会被数据库挡住），这里只是提前量。
      this.deps.logger?.warn?.(
        `[runtime] 归属读取失败 account=${accountId}: ${(err as Error).message}（本次不拦，条件写仍是最后一道）`,
      );
      return null;
    }

    if (owner === null) {
      // 首次真实驱动自证占位：条件写「仅当归属为空」，竞争落败方观察到已被占位、绝不覆盖。
      let claim: Awaited<ReturnType<AccountOwnershipPort['claimExecutionTarget']>>;
      try {
        claim = await port.claimExecutionTarget(accountId, executionTarget);
      } catch (err) {
        this.deps.logger?.warn?.(`[runtime] 归属占位失败 account=${accountId}: ${(err as Error).message}`);
        return null;
      }
      if (claim.outcome === 'claimed') {
        this.emitOwnership(ownership, {
          accountId,
          kind: 'claimed',
          ownerTarget: executionTarget,
          detail: `账号 ${accountId} 首次在 ${executionTarget} 上真实握手，归属已占位为 ${executionTarget}`,
        });
        // 占位成功 MUST 强制重放计数：本进程此前可能已为该账号物化过 controller（面板汇总等），
        // 那份内存值不能被当成新属主的起点。
        try {
          await ownership.onClaimed?.(accountId);
        } catch (err) {
          this.deps.logger?.warn?.(
            `[runtime] 占位后重放计数失败 account=${accountId}: ${(err as Error).message}`,
          );
        }
        return null;
      }
      if (claim.outcome === 'account_not_found') return null;
      owner = claim.target;
    }

    if (owner === executionTarget) return null;

    const message =
      `账号 ${accountId} 归属 ${owner} 的自动化，本云端是 ${executionTarget}，拒绝派活。` +
      `同一个账号在平台眼里只有一份活动预算，两个 target 同时驱动会让实际发出的互动是上限的两倍。` +
      `处理办法：把该边缘节点接到 ${owner} 的云端；确需改归属，先在 ${owner} 停止该账号自动化，` +
      `再经后台「改风控归属」变更。`;
    if (mode === 'observe') {
      this.emitOwnership(ownership, {
        accountId,
        kind: 'mismatch_observed',
        ownerTarget: owner,
        detail: `[观察模式] ${message}`,
      });
      return null;
    }
    this.emitOwnership(ownership, { accountId, kind: 'mismatch_rejected', ownerTarget: owner, detail: message });
    await this.deps.onConfigError(session, message);
    return { ok: false, code: 'execution_target_mismatch', message };
  }

  private emitOwnership(
    ownership: NonNullable<RuntimeRegistryDeps['ownership']>,
    info: {
      accountId: string;
      kind: 'claimed' | 'mismatch_rejected' | 'mismatch_observed';
      ownerTarget: DeploymentTarget | null;
      detail: string;
    },
  ): void {
    this.deps.logger?.warn?.(`[runtime] ${info.detail}`);
    try {
      ownership.onEvent?.(info);
    } catch {
      // 告警链路故障绝不反噬握手判定。
    }
  }

  /**
   * welcome 已写出且 socket 已进入在线路由后的提交点：顶替同 edgeId 旧连接，并按平台激活浏览业务运行时。
   * 视频号是 interaction-only，保持 transport-only；业务初始化失败只降级本连接，绝不反向关闭已 welcome 的 socket。
   */
  onWelcomed(session: EdgeSession): void {
    const runtime = this.bySession.get(session.sessionId);
    if (!runtime || runtime.welcomed) return;
    runtime.welcomed = true;

    // 同 edgeId 重连顶替只在新候选已 welcome 后提交；失败候选不能提前驱逐旧健康连接。
    for (const existing of [...this.bySession.values()]) {
      if (existing.welcomed && existing.edgeId === runtime.edgeId && existing.sessionId !== runtime.sessionId) {
        this.deps.logger?.log?.(
          `[runtime] edgeId=${runtime.edgeId} 新连接已 welcome，顶替旧连接 sessionId=${existing.sessionId}（account=${existing.accountId}）`,
        );
        this.deps.closeEdge(existing.sessionId);
      }
    }

    if (!isOrchestrationCapabilitySupported(runtime.platform, 'browse')) {
      this.deps.logger?.log?.(
        `[runtime] sessionId=${runtime.sessionId} platform=${runtime.platform} 无 browse 编排，保持 transport-only`,
      );
      return;
    }

    let dispatcher: RoleDispatcher | undefined;
    try {
      dispatcher = this.deps.buildDispatcher({
        bus: runtime.bus,
        controller: runtime.controller,
        accountId: runtime.accountId,
        edgeId: runtime.edgeId,
        platform: runtime.platform,
        capabilities: runtime.capabilities,
      });
      dispatcher.setCurrentAccountId(runtime.accountId);
      dispatcher.setup();
      runtime.dispatcher = dispatcher;
      runtime.bus.emit('edge.hello', {
        edgeId: runtime.edgeId!,
        accountId: runtime.accountId,
        ts: Date.now(),
      });
      this.deps.logger?.log?.(
        `[runtime] welcome 后业务运行时已激活 sessionId=${runtime.sessionId} edgeId=${runtime.edgeId ?? '-'} account=${runtime.accountId}`,
      );
    } catch (err) {
      try {
        dispatcher?.endSession('activation_failed');
      } catch {
        // 激活失败的清理也只能降级本业务运行时，不能反向破坏已 welcome 的传输。
      }
      runtime.dispatcher = undefined;
      this.deps.logger?.error?.(
        `[runtime] welcome 后业务运行时激活失败，连接保持在线 sessionId=${runtime.sessionId} edgeId=${runtime.edgeId ?? '-'} account=${runtime.accountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    for (const rt of this.bySession.values()) rt.dispatcher?.tryStartSession();
  }

  /** 面板 /dispatch 暂停：结束所有连接会话。 */
  endAll(reason?: string): void {
    for (const rt of this.bySession.values()) rt.dispatcher?.endSession(reason);
  }

  /**
   * 发布让位（change session-auto-resume-with-excursions）：发布触发时结束该账号当前浏览会话，
   * 使发布独占边缘。结束标记不可续场（不触发休息）；无活跃会话则 no-op。返回匹配的连接数。
   */
  endSessionForAccount(accountId: string, reason?: string): number {
    let n = 0;
    for (const rt of this.bySession.values()) {
      if (rt.accountId === accountId && rt.dispatcher) {
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
      if (rt.accountId === accountId && rt.dispatcher) {
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
      if (rt.accountId === accountId && rt.dispatcher) {
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
      if (!rt.welcomed) continue;
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
      if (!rt.dispatcher) continue;
      const snapshot = rt.dispatcher.sessionUsageSnapshot();
      if (edgeId && rt.edgeId === edgeId) return snapshot;
      if (!fallback || snapshot.active) fallback = snapshot;
    }
    return fallback;
  }

  /**
   * 续场闸的只读裁决（change standby-covers-idle-waits）：供云端产出浏览器冷待机提示。
   *
   * 边缘离线 / 无 dispatcher → 返回 null，待机提示退化为「只按风控判」（= 本 change 之前的行为）。这是安全的
   * 方向：拿不到裁决时**不**让位，宁可多占一会儿浏览器，也不凭空关掉一个我们看不清状态的环境。
   */
  resumeGateForAccount(accountId: string, edgeId?: string): ResumeGateVerdict | null {
    let fallback: ResumeGateVerdict | null = null;
    for (const rt of this.bySession.values()) {
      if (rt.accountId !== accountId) continue;
      if (!rt.dispatcher) continue;
      const verdict = rt.dispatcher.resumeGateSnapshot();
      if (edgeId && rt.edgeId === edgeId) return verdict;
      if (!fallback || rt.dispatcher.active) fallback = verdict;
    }
    return fallback;
  }

  /** Remaining current single-session budget for an online account/edge. Missing runtime fails closed as 0. */
  remainingSessionBudgetForAccount(accountId: string, action: SessionBudgetAction, edgeId?: string): number {
    let fallback: ConnectionRuntime | null = null;
    for (const rt of this.bySession.values()) {
      if (rt.accountId !== accountId) continue;
      if (edgeId && rt.edgeId === edgeId) return rt.dispatcher?.remainingBudget(action) ?? 0;
      if (!rt.dispatcher) continue;
      if (!fallback || rt.dispatcher.active) fallback = rt;
    }
    return fallback?.dispatcher?.remainingBudget(action) ?? 0;
  }

  /** Consume current single-session budget for an online account/edge. Returns false when missing or exhausted. */
  consumeSessionBudgetForAccount(accountId: string, action: SessionBudgetAction, edgeId?: string): boolean {
    let fallback: ConnectionRuntime | null = null;
    for (const rt of this.bySession.values()) {
      if (rt.accountId !== accountId) continue;
      if (edgeId && rt.edgeId === edgeId) return rt.dispatcher?.consumeBudget(action) ?? false;
      if (!rt.dispatcher) continue;
      if (!fallback || rt.dispatcher.active) fallback = rt;
    }
    return fallback?.dispatcher?.consumeBudget(action) ?? false;
  }

  /**
   * 当前在线账号（有 edgeId 的连接，去重；change content-schedule-auto-publish）。
   * 供 ContentScheduler 每分钟 tick 扇出——只对在线账号评估排期，离线账号本槽自然跳过（诚实、不补跑）。
   */
  onlineAccountIds(): string[] {
    const ids = new Set<string>();
    for (const rt of this.bySession.values()) {
      if (rt.welcomed && rt.edgeId) ids.add(rt.accountId);
    }
    return [...ids];
  }

  /**
   * 自动排期使用的在线身份。envKey 只从完成 welcome 的既有 `ads-<profileId>` edgeId 派生；
   * 非受管/旧式 edgeId 缺少可证明环境，fail closed，不进入自动发帖扫描。
   */
  onlineAccountIdentities(): Array<{ accountId: string; envKey: string | null }> {
    const identities = new Map<string, { accountId: string; envKey: string | null }>();
    for (const rt of this.bySession.values()) {
      if (!rt.welcomed || !rt.edgeId) continue;
      const parsedEnvKey = rt.edgeId.startsWith('ads-') ? rt.edgeId.slice('ads-'.length).trim() : '';
      const envKey = parsedEnvKey || null;
      const identity = { accountId: rt.accountId, envKey };
      const previous = identities.get(identity.accountId);
      if (!previous || (previous.envKey === null && identity.envKey !== null)) {
        identities.set(identity.accountId, identity);
      }
    }
    return [...identities.values()];
  }

  /** 当前活跃（已 startSession）的连接数。 */
  activeCount(): number {
    let n = 0;
    for (const rt of this.bySession.values()) if (rt.dispatcher?.active) n++;
    return n;
  }

  /** 当前持有的连接运行时总数。 */
  runtimeCount(): number {
    return this.bySession.size;
  }
}
