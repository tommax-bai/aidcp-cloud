/**
 * 边-云 WebSocket 服务端。
 *
 * 职责：
 * - 在指定端口监听边缘节点连接；
 * - 解析协议信封（protocol.ts），按 type 路由到注入的 MessageHandler；
 * - 把 handler 的返回信封回发给对应边缘连接；
 * - 维护每条连接的会话状态（sessionId / edgeId），并登记"已上线的边缘连接"，
 *   以便云端在收到控制端（如 trigger-like）的指令时，主动把命令推送给边缘。
 *
 * 仅依赖 `ws`，不绑定具体业务逻辑——planner / cache / llm 通过 handler 注入，
 * 便于单测（可不起真实网络，直接调 routeMessage）。
 */

import { WebSocketServer, WebSocket } from 'ws';
import {
  CLIENT_DATA_PLANE_AUTOMATION_ENGINE_CAPABILITY,
  SEARCH_ACTIVITY_RECEIPT_CAPABILITY,
  makeEnvelope,
  parseEnvelope,
  type Envelope,
  type MessageType,
  type PageCardsPayload,
  type BrowserState,
} from './protocol.js';
import { automationOperationDescriptorFor } from './operation-registry.js';

/** 单条边缘连接的会话上下文 */
export interface EdgeSession {
  sessionId: string;
  edgeId?: string;
  /** edge hello 上报的运行时平台；缺省按 xhs 兼容。 */
  platform?: string;
  app?: string;
  /** 该边缘当前驱动的账号（hello 上报，用于风控归属与验证码定位） */
  accountId?: string;
  /** 账号可读昵称（hello 上报，仅作展示补充） */
  accountNickname?: string;
  /** 人类可读机器标签（hello 上报，验证码卡片告诉运维去哪台机器） */
  machineLabel?: string;
  /** 浏览器执行层真态；缺省表示旧 Edge，Cloud 沿用兼容开场行为。 */
  browserState?: BrowserState;
  /**
   * 当前会话正在浏览的笔记 id（随 note.detail / note.content 戳；V1 task 9.2）。
   * 用于在 action.completed 发射 interaction.occurred 时补 noteId（编排已知当前笔记），
   * 喂按笔记互动历史（risk_interactions）。
   */
  currentNoteId?: string;
  /**
   * 当前会话正在访问的作者 id（随 profile.detail 戳；change interaction-feed-enrichment）。
   * 用于在 action.completed 发射 follow 的 interaction.occurred 时补 targetId（关注按作者归属，无当前笔记）。
   */
  currentAuthorId?: string;
  /**
   * 边缘握手声明的能力位（hello.capabilities，change platform-browse-protocol）。含 `inline_targeting` 时
   * 表示该边缘会在信息流就地互动回执里派生 noteId；用于 feed-surface 归账的版本偏斜闸（缺派生 id 则拒记账，
   * 不回落 currentNoteId）。缺省=不声明（老边端），feed-surface 拒记账闸对其不启用。
   */
  capabilities?: string[];
  /** Search activities actually sent on this connection and awaiting one terminal receipt. */
  pendingSearchActivities?: Map<string, {
    purpose: 'discovery' | 'task_targeting' | 'operator';
    scope: 'global' | 'container';
  }>;
  /** Search terminal IDs consumed on this connection; bounded by the handler. */
  completedSearchActivityIds?: Set<string>;
  /**
   * 最近一批 page.cards 快照（change platform-browse-protocol）：note-scoped 互动回执带独立见证 observation 时，
   * 云端据此逐字段比对选中卡是否即实际被点 article（信息流就地点赞防点错卡）。详情页/无 observation 时不消费。
   */
  lastCards?: PageCardsPayload['cards'];
  /**
   * 当前已经按 `page.cards{listKind:'reels'}` 记过 view 的活动 Reel。
   * 若随后同一条 Reel 为互动评估上报 note.detail，handler 仍转发详情，但不再重复记 view。
   * 下一批 page.cards 会覆盖/清除此值；普通 feed 详情继续走既有 detail 记账。
   */
  countedReelViewNoteId?: string;
  /** Ordinary Feed videos already counted as presented views in this connection session. */
  countedFacebookFeedVideoViewKeys?: Set<string>;
  /**
   * 本连接内、身份为「内容派生会话内引用」的 noteId（change generalize-facebook-content-derived-post-identity）。
   *
   * 由 `page.cards` 上**边缘显式声明**的分档字段填。它存在的唯一理由是：随后的浏览事实与互动回执
   * （`note.detail` / `action.completed`）只带 noteId、不带分档，下游若要判「这条能不能落库、能不能
   * 交给人」，就只剩「按字符串形态猜」这一条路——那正是协议明令禁止的做法。把声明记在会话上、
   * 再显式打到派生事件上，判据始终来自边缘的声明，不来自猜测。
   *
   * 有界（FIFO 淘汰最早的）：引用本就只在签发它的列表面与文档代内有效，早批次的引用不可能还有
   * 在途动作，淘汰它们不丢事实；不设界则长会话会无上限增长。
   */
  contentRefNoteIds?: Set<string>;
}

/**
 * 边缘推送器：把一个信封下发给已上线的边缘连接。
 * 控制端（trigger）触发的命令通过它主动推给边缘（而非请求/响应）。
 */
export interface EdgePusher {
  /**
   * 推送给指定 edgeId 的连接（定向下发），返回送达连接数。
   * edge-command-target-guard：缺目标 edgeId 时**绝不广播**——命中 0、返回 0、记警告（诚实失败）。
   * 全网广播须走独立的显式方法，不得靠省略 edgeId 触发。
   */
  pushToEdges(env: Envelope, edgeId?: string): number;
  /**
   * 解析「绑定某账号的在线边缘节点」的 edgeId（change publish-history-account-and-detail）。
   * 供发布命令定向下发：返回该账号当前在线（OPEN + 非 stale）连接的 edgeId；无在线节点则 null
   * （调用方据此诚实失败、绝不广播）。同账号多连接取确定性单目标（最早登记者）并记日志。
   * 可选成员：EdgeCloudServer 概念实现；旧测试桩不实现亦满足接口（发布定向退回广播旧行为）。
   */
  resolveEdgeIdForAccount?(accountId: string, requiredCapability?: string): string | null;
  /**
   * 该 edgeId 当前在线连接声明的能力位（change captcha-assist-text-answer，验证码键入 fail-closed 闸）。
   * 只认 OPEN + 非 stale 连接，返回其 hello.capabilities；无在线连接则 undefined（「连接状态未知」，与「在线但
   * 没声明」区分——后者返回不含目标能力的数组）。绝不用 onDetected 快照——incident 可能比连接活得久。
   * 可选成员：旧测试桩不实现亦满足接口（键入闸对无此方法的 pusher 走 undefined 分支 fail-closed）。
   */
  edgeCapabilities?(edgeId: string): string[] | undefined;
  /** 当前已登记（完成 hello）的边缘连接总数 */
  edgeCount(): number;
  /** 真实在线的边缘数：已登记 AND 近期有心跳（staleness 校验，绝不把死连接当在线）。 */
  onlineEdgeCount(): number;
  /** 暂停向某 edge 下发指令（验证码期间）。`session.end` 不受暂停影响，仍可送达。 */
  pauseEdge(edgeId: string): void;
  /** 解除某 edge 的暂停（验证码清除/人工恢复）。 */
  resumeEdge(edgeId: string): void;
}

/** 消息处理器：收到一个请求信封，产出 0/1 个响应信封 */
export interface MessageHandler {
  handle(
    env: Envelope,
    session: EdgeSession,
    pusher?: EdgePusher,
  ): Promise<Envelope | null> | Envelope | null;
}

/**
 * 握手期观测到的一条环境登记（AdsPower 分身一连上来就带的花名册字段）。
 * 与 api 侧 store 的入参**结构成对**（拆库后各仓在 contracts/ 内各自重声明形状，
 * 见拆分方案 §10.9）：故此处与 `ClientUserStore.registerHandshakeEnvironment` 的参数
 * 逐字段等价、但**不跨层 import**，避免制造 automation→api 的类型依赖边。
 */
export interface HandshakeEnvironmentObservation {
  /** 去掉 `ads-` 前缀后的分身 id（与 edge attach / 过滤口径一致）。 */
  envKey: string;
  /** 展示用标签（hello 昵称），无则 null；null 在 COALESCE 下不擦既有好值。 */
  label: string | null;
  /** 平台标识（hello 声明），无则 null。 */
  platform: string | null;
  /** 握手声明的平台账号 id（环境→账号绑定）；退役保留 id / 无则由 api 侧归一为 null。 */
  accountId: string | null;
}

/**
 * 环境花名册（`client_environments`）写入的**窄内部接口**（change env-table-write-collection）。
 *
 * 拆分方案 §5.1 把 `client_environments`（环境花名册与绑定事实）定为 **aidcp-api 单写**，并明确：
 * **自动化握手回写 MUST 改为经 api 的窄内部接口，MUST NOT 直写该表**。形态与账号归属的
 * `AccountOwnershipPort`（`src/risk/ownership.ts`）同构：**automation 侧（边缘网关握手路径）只持有本接口、
 * 只调方法、绝不自己拼 `client_environments` 的 SQL**；实现方是 `ClientUserStore`（api 侧）。
 * 今天三者仍在一个进程里，故该「窄内部接口」的实现就是一次对 api 侧 store 方法的直调（在组合根装配）；
 * 拆进程时把它换成一次内部 HTTP 即可，**调用点一行不用改**。
 */
export interface EnvironmentRegistryPort {
  /**
   * 握手时把一条观测到的 AdsPower 环境登记进花名册（幂等 upsert + 「来了新值才覆盖」的账号绑定合并）。
   * **只登记、不归属**——绝不误把环境塞给某客户（归属边界由 api 侧 store fail-closed 守住）。
   */
  registerHandshakeEnvironment(observation: HandshakeEnvironmentObservation): Promise<void>;
}

export interface WsServerOptions {
  port?: number;
  host?: string;
  handler: MessageHandler;
  /** 注入时钟（测试用），默认 Date.now */
  clock?: () => number;
  /** 注入会话 id 生成器（测试用） */
  sessionIdGen?: () => string;
  /** 主动心跳 ping 间隔（ms）；0 关闭定时器（测试）。默认 30000。 */
  heartbeatMs?: number;
  /** 超过此时长无帧/pong 即视为 stale（不在线）。默认 75000（2.5×心跳）。 */
  staleAfterMs?: number;
  /** 连接关闭回调（multi-account-node-support）：拆除该连接的多租户运行时。 */
  onClose?: (session: EdgeSession) => void;
  /**
   * 边缘握手注册完成回调（change edge-companion-ui 8.1）：连接已进推送表（edges.set）且 welcome
   * 已回发之后触发——此刻起 pushToEdges 可命中该连接（绕开「hello 处理中推送 sent=0」的前科）。
   * 仅握手成功（回 welcome）才触发；被拒握手（回 error）不触发。回调异常自吞，不影响主链路。
   */
  onEdgeRegistered?: (session: EdgeSession) => void;
  /** Cloud 内部同步出站闸；返回 false 时命中 0，绝不把删除环境的自动化命令推到 Edge。 */
  canPushToEdge?: (env: Envelope, edgeId: string) => boolean;
  /**
   * 关停时等边缘完成关闭握手的上限（ms），到点强制掐断。默认 {@link EDGE_CLOSE_GRACE_MS}。
   * 生产上别调它——这个口子是给测试用的，好让「装死的对端」那条用例不必真等满默认时限。
   */
  closeGraceMs?: number;
}

let sessionSeq = 0;

/**
 * 关停时等边缘完成关闭握手的上限，到点强制掐断。
 *
 * 取 5 秒的理由是两头夹的：下界要显著大于一个正常关闭来回（同城 ECS 上是毫秒级，5 秒已经远超
 * 「网络慢」的量级）；上界必须显著小于进程管理器的停止超时（systemd 默认 90 秒），否则兜底还
 * 没到点，整组就先被强杀了 —— 那样这道兜底等于不存在。
 */
const EDGE_CLOSE_GRACE_MS = 5_000;

/** 已登记的边缘连接 */
interface EdgeConn {
  ws: WebSocket;
  session: EdgeSession;
  /** 最近一次从该连接收到帧/pong 的时刻（staleness 判定用）。 */
  lastSeen: number;
}

/** 边-云 WebSocket 服务端 */
export class EdgeCloudServer implements EdgePusher {
  private wss?: WebSocketServer;
  private readonly port: number;
  private readonly host: string;
  private readonly handler: MessageHandler;
  private readonly clock: () => number;
  private readonly sessionIdGen: () => string;
  /** 已上线（完成 hello）的边缘连接，按 sessionId 索引 */
  private readonly edges = new Map<string, EdgeConn>();
  /**
   * 被暂停下发的 edgeId 集合（验证码期间）。持于传输层而非会话态，
   * 故 RoleDispatcher.restartSession（每次 edge.hello 重建）后仍生效。
   */
  private readonly pausedEdges = new Set<string>();
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly onCloseCb?: (session: EdgeSession) => void;
  private readonly onEdgeRegisteredCb?: (session: EdgeSession) => void;
  private readonly canPushToEdge?: (env: Envelope, edgeId: string) => boolean;
  private readonly closeGraceMs: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(options: WsServerOptions) {
    this.port = options.port ?? 8787;
    this.host = options.host ?? '0.0.0.0';
    this.handler = options.handler;
    this.clock = options.clock ?? Date.now;
    this.sessionIdGen = options.sessionIdGen ?? (() => `sess-${++sessionSeq}`);
    this.heartbeatMs = options.heartbeatMs ?? 30000;
    this.staleAfterMs = options.staleAfterMs ?? 75000;
    this.onCloseCb = options.onClose;
    this.onEdgeRegisteredCb = options.onEdgeRegistered;
    this.canPushToEdge = options.canPushToEdge;
    this.closeGraceMs = options.closeGraceMs ?? EDGE_CLOSE_GRACE_MS;
  }

  /** 启动监听 */
  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wss = new WebSocketServer({ port: this.port, host: this.host });
      this.wss.on('connection', (ws) => this.onConnection(ws));
      this.wss.on('listening', () => resolve());
    }).then(() => this.startHeartbeat());
  }

  /** 主动心跳：定时 ping 每条在线连接；pong/入站帧回到时刷新 lastSeen（见 onConnection）。 */
  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.edges.values()) {
        if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  /**
   * 关闭服务端。
   *
   * ## MUST 主动断开在线连接 —— 只调 `wss.close()` 会无界挂起
   *
   * `ws` 的 `close()` 只做「不再接受新连接」，**已经建立的连接它一条都不碰**，然后去等内部
   * HTTP 服务端把所有连接收干净才回调。而边缘客户端只会持续心跳、不会主动下线 ——
   * 于是那个回调**永远不触发**。
   *
   * 现象很难倒推回这里：关停日志停在「开始」上，既没有完成也没有失败，进程管理器吃满停止
   * 超时上限后整组强杀。dev 2026-08-05 一小时内四次、次次 90 秒 SIGKILL，而被打断的关停
   * 后面还挂着「用量缓冲最后一次提交」「委托任务泵收敛」「写者锁归还」——它们一次都没跑。
   *
   * 遍历 `wss.clients` 而**不是** `this.edges`：后者只收录完成 hello 之后的连接，而一条刚连上
   * 还没 hello 的 socket 同样会把 `close()` 拖住 —— 它不在 `edges` 里，只在 `wss.clients` 里。
   */
  close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const wss = this.wss;
    if (!wss) return Promise.resolve();
    // 幂等：先摘引用。重复调用走上面那条 resolve，不会再断一次连、也不会再起一个兜底表。
    this.wss = undefined;
    return new Promise<void>((resolve, reject) => {
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (err?: Error | null): void => {
        if (forceTimer) {
          clearTimeout(forceTimer);
          forceTimer = undefined;
        }
        if (err) reject(err);
        else resolve();
      };
      wss.close(settle);
      for (const client of wss.clients) {
        // 1001 = going away。给的是「服务端下线」而不是异常码：边缘据此走正常重连，
        // 不会把一次计划内重启记成异常掉线、更不该因此进受限恢复路径。
        if (client.readyState === WebSocket.OPEN) client.close(1001, 'server_shutting_down');
      }
      // 有界兜底：关闭握手是一个来回，正常情况是毫秒级。到点还没关掉的那条基本是装死，
      // 强制掐断，绝不让单条连接把整个关停重新变回无界等待。
      //
      // **这张表故意不 unref()**：它只活最多 EDGE_CLOSE_GRACE_MS、且一旦 close 回调到达就被清掉。
      // unref 掉的话，当它是事件循环里最后一个句柄时进程会直接退出 —— 兜底没跑、close 没 resolve、
      // 「关停完成」那行日志与显式退出码都不会出现，等于把刚修好的可观测性又还回去了。
      forceTimer = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, this.closeGraceMs);
    });
  }

  /** EdgePusher：把命令推给已上线边缘 */
  pushToEdges(env: Envelope, edgeId?: string): number {
    const operation = automationOperationDescriptorFor(env.type);
    if (!operation) {
      console.warn(`[ws-server] operation_unclassified（type=${env.type}）：拒绝下发到自动化通道`);
      return 0;
    }
    // edge-command-target-guard R2/R3：缺目标 edgeId 时绝不广播——诚实失败（命中 0、返回 0、记警告）。
    // 沿用 resolveEdgeIdForAccount 的「0 = 诚实失败信号」语义；调用方据投递数做诚实失败处理。
    // 如将来确需「全网广播」，须新增语义明确的独立方法（如 broadcastToAllEdges），
    // 禁止靠省略 edgeId 隐式退化为广播（否则某连接漏带 edgeId 会把命令误投给所有 edge）。
    if (!edgeId || !edgeId.trim()) {
      console.warn(`[ws-server] pushToEdges 缺目标 edgeId（type=${env.type}）：拒绝广播、诚实失败（命中 0）`);
      return 0;
    }
    if (this.canPushToEdge && !this.canPushToEdge(env, edgeId)) {
      console.warn(`[ws-server] edgeId=${edgeId} 环境处于删除生命周期，抑制 type=${env.type}（命中 0）`);
      return 0;
    }
    let outbound = env;
    if (env.type === 'ui.snapshot' && this.edgeCapabilities(edgeId)?.includes(CLIENT_DATA_PLANE_AUTOMATION_ENGINE_CAPABILITY)) {
      const payload = env.payload as Record<string, unknown>;
      const automationPayload: Record<string, unknown> = {};
      if (payload.browserStandby !== undefined) automationPayload.browserStandby = payload.browserStandby;
      if (Object.keys(automationPayload).length === 0) {
        console.warn(`[ws-server] ui.snapshot 仅含 cloud_data（edge=${edgeId}）：新客户端应经 HTTP 拉取，拒绝下发`);
        return 0;
      }
      outbound = { ...env, payload: automationPayload } as Envelope;
    }
    const frame = JSON.stringify(outbound);
    // session.end 必达：绝不被验证码暂停闸吞掉，否则持久弹窗会导致会话无法终止（死锁）。
    // ui.snapshot 的自动化投影同样豁免；新客户端的数据面字段已在上方过滤，
    // 人物、草稿、审批、发布等状态由 customer-auth HTTP 拉取，不经该暂停闸。
    // captcha.assist.* 下行恢复命令可穿透暂停闸；普通浏览/互动/发布页面动作仍被拦截。
    const bypassPause =
      env.type === 'session.end' ||
      env.type === 'ui.snapshot' ||
      env.type === 'edge.task.acquire' ||
      env.type === 'edge.task.release' ||
      env.type === 'interaction.runtime.controls' ||
      env.type === 'interaction.browser.control' ||
      env.type === 'captcha.assist.capture' ||
      env.type === 'captcha.assist.click';
    let sent = 0;
    for (const conn of this.edges.values()) {
      if (conn.session.edgeId !== edgeId) continue;
      if (!bypassPause && conn.session.edgeId && this.pausedEdges.has(conn.session.edgeId)) continue;
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(frame);
        if (outbound.type === 'search.execute' && (conn.session.capabilities ?? []).includes(SEARCH_ACTIVITY_RECEIPT_CAPABILITY)) {
          const payload = outbound.payload as Record<string, unknown>;
          const activityId = typeof payload.activityId === 'string' && payload.activityId.trim()
            ? payload.activityId.trim()
            : outbound.id;
          const hasContainer = typeof payload.container === 'string' && payload.container.trim().length > 0;
          const purpose = payload.purpose === 'operator' || payload.purpose === 'task_targeting'
            ? payload.purpose
            : hasContainer ? 'task_targeting' : 'discovery';
          const scope = payload.scope === 'container' || (payload.scope !== 'global' && hasContainer)
            ? 'container'
            : 'global';
          const pending = conn.session.pendingSearchActivities ??= new Map();
          if (pending.size >= 256 && !pending.has(activityId)) {
            const oldest = pending.keys().next().value as string | undefined;
            if (oldest) pending.delete(oldest);
            console.warn(`[ws-server] pending search 已达 256，淘汰最旧关联 activityId=${oldest ?? '-'}`);
          }
          pending.set(activityId, { purpose, scope });
        }
        sent++;
      }
    }
    return sent;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  /** 真实在线数：已登记 AND 连接 OPEN AND 近期有帧/pong（staleness 校验，死连接不算在线，D9）。 */
  onlineEdgeCount(): number {
    const now = this.clock();
    let n = 0;
    for (const conn of this.edges.values()) {
      if (conn.ws.readyState === WebSocket.OPEN && now - conn.lastSeen < this.staleAfterMs) n++;
    }
    return n;
  }

  /**
   * A3 owner observation. Counts and account routing are captured against one
   * clock reading so the sync-read snapshot cannot combine different presence
   * moments. Multiple live connections for one account keep the same
   * deterministic earliest-registration rule as resolveEdgeIdForAccount().
   */
  edgePresenceSnapshot(): {
    edgeCount: number;
    onlineEdgeCount: number;
    accountEdges: Array<{ accountId: string; edgeId: string }>;
  } {
    const now = this.clock();
    let onlineEdgeCount = 0;
    const accountEdges = new Map<string, string>();
    for (const conn of this.edges.values()) {
      if (
        conn.ws.readyState !== WebSocket.OPEN ||
        now - conn.lastSeen >= this.staleAfterMs
      ) {
        continue;
      }
      onlineEdgeCount += 1;
      const accountId = conn.session.accountId?.trim();
      const edgeId = conn.session.edgeId?.trim();
      if (!accountId || !edgeId || accountEdges.has(accountId)) continue;
      accountEdges.set(accountId, edgeId);
    }
    return {
      edgeCount: this.edges.size,
      onlineEdgeCount,
      accountEdges: [...accountEdges]
        .map(([accountId, edgeId]) => ({ accountId, edgeId }))
        .sort((left, right) => left.accountId.localeCompare(right.accountId)),
    };
  }

  /** 已绑定端口（构造时 port:0 由系统分配，测试用）；未启动返回 null。 */
  address(): number | null {
    const a = this.wss?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  /** 暂停向某 edge 下发指令（验证码期间）。幂等。 */
  pauseEdge(edgeId: string): void {
    this.pausedEdges.add(edgeId);
  }

  /** 解除某 edge 的暂停（验证码清除/人工恢复）。幂等。 */
  resumeEdge(edgeId: string): void {
    this.pausedEdges.delete(edgeId);
  }

  /** 该 edge 是否处于暂停态（观测/测试用）。 */
  isEdgePaused(edgeId: string): boolean {
    return this.pausedEdges.has(edgeId);
  }

  /** 解除某账号名下所有 edge 的暂停（飞书人工恢复快路）。返回恢复的 edge 数。 */
  resumeEdgesForAccount(accountId: string): number {
    let resumed = 0;
    for (const conn of this.edges.values()) {
      const eid = conn.session.edgeId;
      if (eid && conn.session.accountId === accountId && this.pausedEdges.delete(eid)) resumed++;
    }
    return resumed;
  }

  /**
   * 解析绑定某账号的在线边缘节点 edgeId（发布命令定向下发用）。
   * 只认 OPEN + 非 stale 的连接（死连接不算在线，与 onlineEdgeCount 同口径）。
   * 严格匹配 `session.accountId === accountId`（retire-default-account：握手已保证每个连接带真实账号，
   * 去掉「目标为 default 时把未声明账号也算上」的 legacy 兼容）。同账号多条在线连接 → 取最早登记者（Map 插入序）并记日志。
   * 无在线节点返回 null（调用方据此诚实失败、绝不广播）。
   */
  resolveEdgeIdForAccount(accountId: string, requiredCapability?: string): string | null {
    const now = this.clock();
    const matches: string[] = [];
    for (const conn of this.edges.values()) {
      const eid = conn.session.edgeId;
      if (!eid) continue;
      if (conn.ws.readyState !== WebSocket.OPEN || now - conn.lastSeen >= this.staleAfterMs) continue;
      if (conn.session.accountId !== accountId) continue;
      if (requiredCapability && !(conn.session.capabilities ?? []).includes(requiredCapability)) continue;
      matches.push(eid);
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      console.warn(`[ws-server] 账号 ${accountId} 有 ${matches.length} 条在线连接，定向发布取最早登记者 edgeId=${matches[0]}（其余=${matches.slice(1).join(',')}）`);
    }
    return matches[0];
  }

  edgeCapabilities(edgeId: string): string[] | undefined {
    const now = this.clock();
    for (const conn of this.edges.values()) {
      if (conn.session.edgeId !== edgeId) continue;
      if (conn.ws.readyState !== WebSocket.OPEN || now - conn.lastSeen >= this.staleAfterMs) continue;
      // 在线连接：返回其声明的能力位（可能不含目标能力 = 在线但没声明）。缺省视为空数组，不返回 undefined。
      return conn.session.capabilities ?? [];
    }
    // 无 OPEN + 非 stale 连接 = 连接状态未知 → undefined（调用方 fail-closed）。
    return undefined;
  }


  private onConnection(ws: WebSocket): void {
    const session: EdgeSession = { sessionId: this.sessionIdGen() };
    ws.on('message', async (data) => {
      const text = typeof data === 'string' ? data : data.toString();
      // 在握手成功时登记边缘连接，使其可被主动推送
      const env = parseEnvelope(text);
      const reply = await this.routeMessage(text, session);
      if (env?.type === 'hello' && reply?.type === 'welcome') {
        this.edges.set(session.sessionId, { ws, session, lastSeen: this.clock() });
      } else if (env?.type !== 'hello') {
        // 任意入站帧刷新 lastSeen（连接活着的证据）
        const conn = this.edges.get(session.sessionId);
        if (conn) conn.lastSeen = this.clock();
      }
      if (reply) ws.send(JSON.stringify(reply));
      // 握手注册完成（连接已可被主动推送、welcome 已先行回发）→ 通知快照层回填陪伴界面数据。
      // 仅握手成功才触发（被拒时 reply 是 error 信封）；回调异常自吞，绝不影响连接主循环。
      if (env?.type === 'hello' && reply?.type === 'welcome') {
        try {
          this.onEdgeRegisteredCb?.(session);
        } catch (err) {
          console.warn(`[ws-server] onEdgeRegistered 回调异常（已吞）: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (env?.type === 'hello') {
        // error/bad hello 不能留下可被 account/capability resolver 命中的幽灵连接。
        // 先写 error frame，再关闭；Edge 必须把它当握手失败并走既有重连。
        ws.close(1008, 'handshake rejected');
      }
    });
    // ws 协议层 pong（响应主动 ping）也刷新 lastSeen
    ws.on('pong', () => {
      const conn = this.edges.get(session.sessionId);
      if (conn) conn.lastSeen = this.clock();
    });
    ws.on('close', () => {
      this.edges.delete(session.sessionId);
      // 拆除该连接的多租户运行时（结束会话 + 解 tee + 清私有总线监听）。
      this.onCloseCb?.(session);
    });
  }

  /**
   * 主动关闭某 session 的连接（同 edgeId 重连顶替旧连接用）。
   * 关闭后 ws 'close' 会触发 edges.delete + onClose（拆除旧运行时）。
   */
  closeEdge(sessionId: string): void {
    const conn = this.edges.get(sessionId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) conn.ws.close();
  }

  /**
   * 路由一帧文本消息，返回应回发的信封（或 null）。
   * 抽成纯方法以便单测：无需真实 socket 即可验证协议处理。
   */
  async routeMessage(text: string, session: EdgeSession): Promise<Envelope | null> {
    const env = parseEnvelope(text);
    if (!env) {
      return this.errorEnvelope('bad_envelope', '无法解析的协议帧');
    }
    try {
      return await this.handler.handle(env, session, this);
    } catch (err) {
      return this.errorEnvelope('handler_error', (err as Error).message, env.id);
    }
  }

  private errorEnvelope(code: string, message: string, id = 'server'): Envelope {
    return makeEnvelope('error' as MessageType, id, this.clock(), { code, message });
  }
}
