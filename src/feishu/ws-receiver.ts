/**
 * 飞书事件接收入口（官方 SDK 长连接 / WSClient）。
 *
 * 取代原 node:http webhook（8788 端口）：由本端主动连接飞书，无需公网 IP，
 * 也无需配置回调地址。职责：
 * - 注册 im.message.receive_v1：解析文本 → 路由到 CommandRouter，结果以指令回执卡片回到群；
 * - fast-ack（change feishu-message-fast-ack）：消息事件**受理即返回**，命令执行 + 回卡甩到后台，
 *   绝不阻塞 SDK 的事件回帧。SDK 按 event_id 对「短时重复帧」有幂等，但**挡不住「处理器久不回帧
 *   导致的超时重推」**——长耗时命令（如 /publish 约 3 分钟）会因此被飞书重推、执行两次；fast-ack
 *   从根上消除这条。残余的长连接重连 replay 重推由发帖并发闸兜底，本层不自建 SeenSet 去重；
 * - URL 验证：长连接模式不需要 challenge 回包，SDK 内部处理握手。
 *
 * 依赖 @larksuiteoapi/node-sdk 的 WSClient + EventDispatcher；
 * 业务通过 CommandRouter / FeishuMessenger 注入，消息发送仍走现有 REST messenger.ts。
 */

import { promises as fs } from 'node:fs';
import { posix } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { CommandRouter } from './commands.js';
import { FeishuMessenger } from './messenger.js';
import {
  buildApprovedPublishApprovalCard,
  buildCancelledPublishApprovalCard,
  buildCommandResultCard,
  buildSupersededPublishApprovalCard,
} from './cards.js';
import type { PublishApprovalPayload } from './types.js';

/** im.message.receive_v1 事件中 message 字段的最小形状（与 SDK 类型对齐的子集） */
export interface FeishuWsMessage {
  message_id: string;
  chat_id: string;
  chat_type?: string;
  message_type: string;
  /** JSON 字符串，文本消息形如 {"text":"..."} */
  content: string;
}

export interface FeishuWsReceiverOptions {
  /** App ID，默认读 env FEISHU_APP_ID */
  appId?: string;
  /** App Secret，默认读 env FEISHU_APP_SECRET */
  appSecret?: string;
  /** 指令路由器（解析 + 执行） */
  commandRouter: CommandRouter;
  /** 消息发送器（回执卡片）；缺省则不回执 */
  messenger?: FeishuMessenger;
  /** 注入日志（测试用），默认 console */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /**
   * @deprecated change publish-approval-signal-to-database：审批不再经本机文件互斥，接收端已不用 fs。
   * 保留字段仅为向后兼容既有构造点，本类内部不再读取它。
   */
  fsImpl?: Pick<typeof fs, 'writeFile' | 'rm'>;
  /**
   * 人审授权后回调（change decouple-publish-generation-from-dispatch）：仅当本次为「授权」且首写成功
   * （written && approved）时调用，带 requestId，由 server 解析 recordId 触发下发段（通过即切）。
   * 取消则不调。缺省（测试/旧装配）不触发，零回归。
   */
  onApproved?: (requestId: string) => void;
  /**
   * 取消（拒绝发布）首写成功时调用（change edge-companion-ui 8.1）：带 requestId，供快照层把
   * rejected 状态推给该账号在线边缘（发布卡收起为「暂不发布」）。缺省不触发，零回归。
   */
  onRejected?: (requestId: string) => void;
  /**
   * 读某草稿当前内容版本号（change edit-note-draft-before-publish）：卡片授权/取消前的写时版本预检。
   * 仅对 `publish-<n>` requestId 生效。缺省（测试/旧装配）不预检、零回归。
   * 返回 null（不存在/读失败）→ fail-safe 拒到控制台，绝不放行未确认版本。
   */
  readLiveContentVersion?: (recordId: number) => Promise<number | null>;
  /**
   * 发帖授权前置检查：仅在「授权发布」写信号前调用，用于拦截账号/节点离线等不可发布状态。
   * 返回 ok=false 时不写审批信号、不替换卡片，保持审批态不变。
   */
  preflightApprovePublish?: (
    requestId: string,
    payload: PublishApprovalPayload,
  ) => Promise<PublishApprovalPreflightResult>;
  /** DelegatedTask card callback. Return null when the value is not a delegated-task action. */
  onDelegatedTaskAction?: (value: unknown) => Promise<{
    toast: { type: 'success' | 'error' | 'info'; content: string };
    card?: unknown;
  } | null>;
  /**
   * 唯一授权写出口（change publish-approval-signal-to-database）：写持久授权记录，
   * first-writer-wins 由数据库活跃行唯一约束承担。
   *
   * 未注入即**fail-closed**：卡片回调返回可见的错误 toast、不写任何授权。绝不退化成「只写本机文件」——
   * 那正是本 change 要消灭的第二事实源，而且拆分后会静默失效。
   */
  writeApproval?: (
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
    context: { decidedBy: string; decidedVia: 'feishu' },
  ) => Promise<ApprovalWriteResult>;
}

interface ApprovalActionValue {
  action?: unknown;
  requestId?: unknown;
  payload?: unknown;
}

interface ApprovalSignal {
  requestId: string;
  approved: boolean;
  ts: number;
  payload: PublishApprovalPayload;
}

const APPROVAL_SIGNAL_DIR = '/tmp';

function isPublishApprovalPayload(value: unknown): value is PublishApprovalPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.title === 'string' &&
    typeof payload.content === 'string' &&
    Array.isArray(payload.tags) &&
    payload.tags.every((tag) => typeof tag === 'string')
  );
}

export function parseApprovalActionValue(value: unknown):
  | { action: 'approve' | 'cancel'; requestId: string; payload: PublishApprovalPayload }
  | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as ApprovalActionValue;
  if ((raw.action !== 'approve' && raw.action !== 'cancel') || typeof raw.requestId !== 'string') {
    return null;
  }
  if (!isPublishApprovalPayload(raw.payload)) return null;
  return { action: raw.action, requestId: raw.requestId, payload: raw.payload };
}

/**
 * @deprecated change publish-approval-signal-to-database：授权的权威载体已是持久记录
 * （`publish_approval_decision`）。本函数只剩**兼容窗口内的影子写路径**用途，MUST NOT 被任何
 * 生产判定路径读取；关闭影子写后应随之删除。
 */
export function getApprovalSignalPath(requestId: string): string {
  return posix.join(APPROVAL_SIGNAL_DIR, `aidcp-publish-approve-${requestId}.json`);
}

export interface ApprovalWriteResult {
  /** 本次是否写入成功（首个写者）。 */
  written: boolean;
  /** 若已被先前决定，返回其 approved 值（first-writer-wins）。 */
  alreadyDecided?: boolean;
}

export type PublishApprovalPreflightReason = 'account_offline' | 'publish_target_unavailable';

export type PublishApprovalPreflightResult =
  | { ok: true; accountId?: string; edgeId?: string }
  | { ok: false; reason: PublishApprovalPreflightReason; accountId?: string };

/** 注入 fs：first-writer-wins 需 writeFile 的 wx flag；readFile 用于读回既有决定（可选）。 */
export interface ApprovalSignalFs {
  writeFile: typeof fs.writeFile;
  readFile?: typeof fs.readFile;
}

/**
 * @deprecated change publish-approval-signal-to-database：唯一授权写出口现在是
 * `createApprovalWriteOutlet`（写 `publish_approval_decision`，first-writer-wins 由活跃行唯一索引承担）。
 * 本函数降级为**兼容窗口内的影子写**实现：由授权出口在持久写成功之后 best-effort 调用，
 * 失败只记日志。它 MUST NOT 再作为任何入口的授权互斥手段——写方与执行侧分进程后该互斥会静默消失。
 */
export async function writeApprovalSignal(
  fsImpl: ApprovalSignalFs,
  requestId: string,
  approved: boolean,
  payload: PublishApprovalPayload,
  now: number = Date.now(),
): Promise<ApprovalWriteResult> {
  const signalPath = getApprovalSignalPath(requestId);
  const signal: ApprovalSignal = { requestId, approved, ts: now, payload };
  try {
    await fsImpl.writeFile(signalPath, JSON.stringify(signal), { flag: 'wx' });
    return { written: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // 已有决定（飞书/Web/重复点击先写）：first-writer-wins，读回既有 approved
    if (fsImpl.readFile) {
      try {
        const raw = await fsImpl.readFile(signalPath, 'utf8');
        const existing = JSON.parse(raw.toString()) as ApprovalSignal;
        return { written: false, alreadyDecided: existing.approved };
      } catch {
        /* 读不回也算已决定 */
      }
    }
    return { written: false, alreadyDecided: approved };
  }
}

/**
 * 从飞书文本消息 content（JSON 字符串）抽出纯文本，并剥离 @ 提及占位。
 * 纯函数，便于单测：飞书 @ 提及在 text 中以 @_user_N 占位。
 */
export function extractText(content: string): string {
  try {
    const obj = JSON.parse(content) as { text?: string };
    const raw = obj.text ?? '';
    return raw.replace(/@_user_\d+/g, '').trim();
  } catch {
    return '';
  }
}

/** 飞书事件接收（长连接） */
export class FeishuWsReceiver {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly commandRouter: CommandRouter;
  private readonly messenger?: FeishuMessenger;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly onApproved?: (requestId: string) => void;
  private readonly onRejected?: (requestId: string) => void;
  private readonly readLiveContentVersion?: (recordId: number) => Promise<number | null>;
  private readonly preflightApprovePublish?: (
    requestId: string,
    payload: PublishApprovalPayload,
  ) => Promise<PublishApprovalPreflightResult>;
  private readonly onDelegatedTaskAction?: FeishuWsReceiverOptions['onDelegatedTaskAction'];
  private readonly writeApproval?: FeishuWsReceiverOptions['writeApproval'];
  private wsClient?: lark.WSClient;

  constructor(options: FeishuWsReceiverOptions) {
    this.appId = options.appId ?? process.env.FEISHU_APP_ID ?? '';
    this.appSecret = options.appSecret ?? process.env.FEISHU_APP_SECRET ?? '';
    this.commandRouter = options.commandRouter;
    this.messenger = options.messenger;
    this.logger = options.logger ?? console;
    this.onApproved = options.onApproved;
    this.onRejected = options.onRejected;
    this.readLiveContentVersion = options.readLiveContentVersion;
    this.preflightApprovePublish = options.preflightApprovePublish;
    this.onDelegatedTaskAction = options.onDelegatedTaskAction;
    this.writeApproval = options.writeApproval;
  }

  /**
   * 处理一条 im.message.receive_v1 事件：解析文本 → CommandRouter → 回执卡片。
   * 抽成纯方法（接收 message 子集）以便单测：无需真实长连接即可验证路由。
   */
  async handleMessage(message: FeishuWsMessage): Promise<void> {
    if (message.message_type !== 'text') return;
    const text = extractText(message.content);
    if (!text) return;

    // 已读即贴「敲键盘」表情回应，告诉用户"我看到了、正在处理"（best-effort，不阻断）。
    if (this.messenger) void this.messenger.addReaction(message.message_id, 'Typing');

    // fast-ack（change feishu-message-fast-ack）：受理即返回，命令执行 + 结果卡发送甩到后台，
    // 绝不阻塞 SDK 的事件回执。否则长耗时命令（如 /publish 发帖生成实测约 3 分钟）会让飞书
    // 判「超时未送达」、约 20s 后重推同一消息 → 命令被执行两次（第二次撞发帖并发闸 → 误导性
    // 「发帖未产出／已有一轮在运行中」卡）。终态结果卡照旧异步补发、honest-status 判级不变；
    // 不插入「任务启动中」中间卡。重复执行由发帖并发闸兜底（本层不自建去重）。
    void this.commandRouter
      .handleBatch(text, { chatId: message.chat_id, messageId: message.message_id })
      .then((results) => {
        for (const result of results) {
          // 静默受理（精确命令直接排队）：不发卡，只留已读表情；结果由任务自身的业务结果卡回报。
          if (result.silent || !this.messenger) continue;
          // 各子命令卡片独立发送；一张卡失败不吞掉其它兄弟结果。
          void this.messenger.sendCard(message.chat_id, result.card ?? buildCommandResultCard(result)).catch((err) => {
            this.logger.error('[feishu] 后台发送子命令结果失败:', (err as Error).message);
          });
        }
      })
      .catch((err) => {
        // 与改动前一致：异常记日志、不发卡。此处兜住后台 promise，杜绝 unhandledRejection。
        this.logger.error('[feishu] 后台处理指令失败:', (err as Error).message);
      });
  }

  /**
   * @param operatorOpenId 点卡片那个人的飞书 open_id（`card.action.trigger` 的 operator）。
   *   它是授权记录的真实决策人，MUST NOT 用常量占位；取不到时退化为可辨识的 `feishu:unknown_operator`
   *   （仍是真实事实：这次决策来自飞书但身份未随事件送达），绝不冒充某个具体人。
   */
  async handleCardAction(value: unknown, operatorOpenId?: string): Promise<{
    toast: { type: 'success' | 'error' | 'info'; content: string };
    card?: unknown;
  }> {
    if (this.onDelegatedTaskAction) {
      const delegated = await this.onDelegatedTaskAction(value);
      if (delegated) return delegated;
    }
    const parsed = parseApprovalActionValue(value);
    if (!parsed) {
      return {
        toast: { type: 'error', content: '审批回调参数无效' },
      };
    }

    const approved = parsed.action === 'approve';

    // 写时版本预检（change edit-note-draft-before-publish）：卡片授权/取消前比对活版本与卡片烤入版本。
    // 云端无法主动刷新已发出的老卡片——草稿一经后台编辑，老卡片显示的是旧字节、点授权会发出未审内容，
    // 点取消会以先到先得锁死签名、令编辑过的好草稿再也无法授权。故版本不符时**拒绝本次决定、绝不写签名**，
    // 就地替换成「请到控制台重新审批」卡（唯一可行的卡片更新方式）。仅 publish-<n> 且注入了读版本函数时生效。
    if (this.readLiveContentVersion) {
      const m = /^publish-(\d+)$/.exec(parsed.requestId);
      if (m) {
        const recordId = Number(m[1]);
        const bakedVersion = parsed.payload.contentVersion ?? 0;
        let liveVersion: number | null;
        try {
          liveVersion = await this.readLiveContentVersion(recordId);
        } catch {
          liveVersion = null;
        }
        if (liveVersion === null) {
          // fail-safe：无法确认版本（不存在/PG 抖动）→ 拒到控制台，绝不放行未确认版本。不写签名。
          return {
            toast: { type: 'error', content: '暂时无法确认草稿版本，请到控制台审批' },
            card: { type: 'raw', data: buildSupersededPublishApprovalCard(parsed.requestId) },
          };
        }
        if (liveVersion !== bakedVersion) {
          // 草稿已在控制台改过（版本不符）→ 拒绝本次决定、不写签名，就地替换成重新审批引导卡。
          return {
            toast: { type: 'info', content: '草稿已在控制台修改，请到控制台审批' },
            card: { type: 'raw', data: buildSupersededPublishApprovalCard(parsed.requestId) },
          };
        }
      }
    }

    if (approved && this.preflightApprovePublish) {
      const preflight = await this.preflightApprovePublish(parsed.requestId, parsed.payload);
      if (!preflight.ok) {
        return {
          toast: {
            type: 'error',
            content: preflight.reason === 'account_offline' ? '账号不在线，无法发布' : '无法确认发布账号，无法发布',
          },
        };
      }
    }

    // 授权写出口（change publish-approval-signal-to-database）：写持久记录，first-writer-wins 由
    // 「活跃行唯一」承担。未接线即 fail-closed 报错——绝不退回本机文件互斥（分进程后会静默消失）。
    if (!this.writeApproval) {
      this.logger.error('[feishu] 授权写出口未接线，拒绝本次审批决定（绝不静默放行、绝不退回文件信号）');
      return { toast: { type: 'error', content: '授权服务不可用，请稍后重试或到控制台审批' } };
    }
    let result: ApprovalWriteResult;
    try {
      result = await this.writeApproval(parsed.requestId, approved, parsed.payload, {
        decidedBy: operatorOpenId?.trim() || 'feishu:unknown_operator',
        decidedVia: 'feishu',
      });
    } catch (err) {
      this.logger.error('[feishu] 授权写入失败:', (err as Error).message);
      return { toast: { type: 'error', content: '授权写入失败，请稍后重试（本次决定未生效）' } };
    }
    if (!result.written) {
      // first-writer-wins：已被先前决定（飞书/Web/重复点击），不覆盖
      const alreadyApproved = result.alreadyDecided === true;
      // already-decided 的重复「授权」也走人工批准入口（change parallel-rewrite-drafts）：
      // 熔断中即确认清除、恢复 drain 该账号已批队列；非熔断时由下发段幂等闸自然吸收，绝不二次发布。
      if (approved && alreadyApproved) {
        try {
          this.onApproved?.(parsed.requestId);
        } catch (err) {
          this.logger.warn('[feishu] onApproved（already-decided 重批确认）触发失败:', (err as Error).message);
        }
      }
      return {
        toast: {
          type: 'info',
          content: `该发布已被处理（${alreadyApproved ? '已授权' : '已取消'}）`,
        },
        card: {
          type: 'raw',
          data: (alreadyApproved ? buildApprovedPublishApprovalCard : buildCancelledPublishApprovalCard)({
            requestId: parsed.requestId,
            ...parsed.payload,
          }),
        },
      };
    }
    if (approved) {
      // 通过即切：首写成功的「授权」即触发下发段（server 解析 recordId）。取消不触发。
      try {
        this.onApproved?.(parsed.requestId);
      } catch (err) {
        this.logger.warn('[feishu] onApproved 触发下发失败:', (err as Error).message);
      }
      return {
        toast: { type: 'success', content: '已授权发布' },
        card: {
          type: 'raw',
          data: buildApprovedPublishApprovalCard({
            requestId: parsed.requestId,
            ...parsed.payload,
          }),
        },
      };
    }
    // 取消首写成功：通知陪伴界面 rejected（发布卡收起为「暂不发布」）。best-effort，绝不影响审批主链路。
    try {
      this.onRejected?.(parsed.requestId);
    } catch (err) {
      this.logger.warn('[feishu] onRejected 通知失败:', (err as Error).message);
    }
    return {
      toast: { type: 'info', content: '已取消发布' },
      card: {
        type: 'raw',
        data: buildCancelledPublishApprovalCard({
          requestId: parsed.requestId,
          ...parsed.payload,
        }),
      },
    };
  }

  /** 构建 EventDispatcher 并注册事件处理器 */
  private buildDispatcher(): lark.EventDispatcher {
    return new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await this.handleMessage(data.message as FeishuWsMessage);
        } catch (err) {
          this.logger.error('[feishu] 处理消息事件失败:', (err as Error).message);
        }
      },
      'card.action.trigger': async (data: {
        action?: { value?: unknown };
        operator?: { open_id?: string };
      }) => {
        try {
          // operator 是点这张卡的人 → 授权记录的真实决策人（decided_by）。
          return await this.handleCardAction(data.action?.value, data.operator?.open_id);
        } catch (err) {
          this.logger.error('[feishu] 处理卡片回调失败:', (err as Error).message);
          return {
            toast: { type: 'error', content: '处理审批回调失败' },
          };
        }
      },
    });
  }

  /** 启动长连接：主动连接飞书，无需公网 IP。建立成功后通过 onReady 回调打印日志。 */
  async start(): Promise<void> {
    if (!this.appId || !this.appSecret) {
      throw new Error('飞书凭证缺失：请配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
    }
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      onReady: () => this.logger.log('[aidcp-cloud] 飞书长连接已建立（WSClient onReady）'),
      onError: (err) => this.logger.error('[aidcp-cloud] 飞书长连接错误:', err.message),
      onReconnecting: () => this.logger.warn('[aidcp-cloud] 飞书长连接重连中…'),
      onReconnected: () => this.logger.log('[aidcp-cloud] 飞书长连接已重连'),
    });
    await this.wsClient.start({ eventDispatcher: this.buildDispatcher() });
  }
}
