/**
 * automation → content 另外两条属主端口的传输三件套（路由常量 + 服务端注册 + 类型化客户端）。
 *
 * 覆盖的两个端口（都在 kernel 定义，本文件一个字都不改它们）：
 *   - {@link file://../kernel/facebook-publish-media-port.ts} FB 发帖素材状态流转 3 个写
 *     —— **已接线**（task 2.4d）：content 监听独立注册、automation 侧客户端按模式取、两个消费点已改指；
 *   - {@link file://../kernel/llm-usage-recording-port.ts} 模型 token 用量记账 1 个批量写
 *     —— **仍未接线**，且它不是纯接线：属主今天没有 `recordUsage`，automation 侧还需要一个合并缓冲，
 *     两者的落点都要先裁定，见文件末尾 {@link CONTENT_MEDIA_USAGE_WIRING_DEBT}。
 * 失败信号统一走 {@link file://../kernel/content-port-error.ts}，线上译码复用
 * {@link file://./content-authority-wire.ts}（**不复制第二份失败映射表**，理由见那份文件的文件头）。
 *
 * **三件套同文件是硬要求**（CLAUDE §8.4）：拆成「属主仓写服务端、消费方仓写客户端」两份，
 * 两侧各自编译通过、各自测试通过，**只有真跑起来才 404**。路由常量在这里只有一份，
 * 且 `as const satisfies Record<keyof Port, string>` 让「端口加了方法而路由表没跟上」在 typecheck
 * 当场失败。注意那条 satisfies 只保证**表**是全的，保证不了**注册函数**把表里每条都挂上去——
 * 后者靠 `test/transport/content-media-usage-http.test.ts` 逐条走一遍回环钉住。
 * 有效性做过双向变异实测，两次的结论不一样，都记下来免得后来人高估 typecheck：
 *   - 变异 A「整条注册删掉」→ typecheck **会**报，但报的是 `noUnusedLocals`（那条路由的入参解析器
 *     成了孤儿），**不是**漏注册本身。入参解析器一旦被两条路由共用，这个信号就没有了。
 *   - 变异 B「注册时不用共享常量、手写一遍路径」→ typecheck **完全绿**（就是个字符串），
 *     用例当场红。这才是这份测试真正在守的那个失败，也正是「路由常量只有一份」的全部理由。
 *
 * 信封 / 鉴权照 4a 已建立的形态：版本 + `executionTarget` 双校验、`registerBearer` 内部令牌。
 * **target 由客户端从本进程部署事实注入**，业务调用方没有任何入口能选它——DEV/OL 长期共库，
 * 让调用方挑 target 等于把「在哪台机器上真跑」交给一个请求体字段。
 *
 * ═══ 两条端口各自的一句要害 ═══
 *
 * **FB 素材**：三个方法的 `boolean` 回执是「那一行真的被改了吗」，`false` 是**真实的领域答案**。
 * 所以这条边上 `false` 与抛出的区别是刚性的：读不到 / 连不上 MUST 抛，MUST NOT 落成 `false`——
 * `false` 会被读成「这组素材早被别人动过了」，而真相是「这次记账压根没发生」，
 * 素材会永久卡在保留态上没人回收。本文件所有出口只有两种结局：裸值，或抛。
 *
 * **用量记账**：属主侧是可交换累加计数器，**同一批提交两次 ＝ 数字翻倍**。所以传输失败
 * MUST NOT 重投；超时是结果未知，按属主自己的「用量可丢」约定丢弃并计数留痕即可。
 * 这一条 MUST NOT 由本文件替调用方决定——本文件只保证失败一定抛得出来、且带具名 reason
 * （`timeout` 与 `remote_error` 在这里是分得开的两件事，正因为处置不同）。
 *
 * ═══ 成本红线 ═══
 *
 * 用量这条边只搬 **token 计数**，没有任何单价 / 金额 / 币种字段，这是刻意的：
 * 成本 MUST 由厂商账单反算（属主侧读时 JOIN 账单派生单价快照算出），
 * MUST NOT 在这一层硬编码价目表，也 MUST NOT 在传输层就地折算。
 *
 * 零属主表 SQL、零业务判定，满足 `aidcp-transport` 准入（三家都可能调用 + 不含任何属主表 SQL）。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import type { FacebookPublishMediaPort } from '../kernel/facebook-publish-media-port.js';
import {
  LLM_USAGE_BUCKET_MS,
  llmUsageBucketStart,
  type LlmUsageIncrement,
  type LlmUsageRecordingPort,
} from '../kernel/llm-usage-recording-port.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  ApiDirectHttpError,
  isNonNegativeInteger,
  parseApiDirectEnvelope,
  requireInteger,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';
import {
  callContentAuthority,
  ownerHasMethod,
  runOwnerCall,
  type ContentAuthorityChannel,
} from './content-authority-wire.js';

/* ───────────────────────────────────────────────────────── 路由表 */

export const FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES = {
  releaseReservation: 'content-authority/facebook-publish-media/v1/release-reservation',
  markUsed: 'content-authority/facebook-publish-media/v1/mark-used',
  quarantine: 'content-authority/facebook-publish-media/v1/quarantine',
} as const satisfies Record<keyof FacebookPublishMediaPort, string>;

export const LLM_USAGE_RECORDING_AUTHORITY_ROUTES = {
  recordUsage: 'content-authority/llm-usage/v1/record-usage',
} as const satisfies Record<keyof LlmUsageRecordingPort, string>;

/* ─────────────────────────────────────────── 入参解析（服务端侧） */

interface ReleaseReservationInput {
  setId: number;
  reservationId?: string;
}

interface MarkUsedInput {
  setId: number;
  publishLogId: number;
}

interface QuarantineInput {
  setId: number;
  reason: string;
}

/**
 * 行号下限取 1，不是 0。属主侧三条全是 `WHERE id = $1` 的条件 UPDATE：
 * `setId = 0` 匹配不到任何行、回 `false`，读起来与「这组素材已经不在那个状态上了」一模一样——
 * 把一次问错了的提问伪装成一个领域答案。同理 `publishLogId`。
 */
function requireRowId(value: unknown, label: string): number {
  return requireInteger(value, label, 1);
}

function releaseReservationInput(value: unknown): ReleaseReservationInput {
  const input = requireRecord(value, 'facebook publish media release');
  // `reservationId` 缺席 ＝ 不校验持有者（属主既有行为）。**空串不等于缺席**：
  // 空串会当成一个真实的持有者去比对、永远匹配不上，于是回 false 而不是释放。
  const reservationId =
    input.reservationId === undefined || input.reservationId === null
      ? undefined
      : requireString(input.reservationId, 'reservationId');
  return {
    setId: requireRowId(input.setId, 'setId'),
    ...(reservationId === undefined ? {} : { reservationId }),
  };
}

function markUsedInput(value: unknown): MarkUsedInput {
  const input = requireRecord(value, 'facebook publish media mark-used');
  return {
    setId: requireRowId(input.setId, 'setId'),
    publishLogId: requireRowId(input.publishLogId, 'publishLogId'),
  };
}

function quarantineInput(value: unknown): QuarantineInput {
  const input = requireRecord(value, 'facebook publish media quarantine');
  return {
    setId: requireRowId(input.setId, 'setId'),
    // 隔离原因是留痕文案，但**必须在场**：空原因会写出一条查不出所以然的隔离记录，
    // 而隔离本身是需要人来判的终态。
    reason: requireString(input.reason, 'reason'),
  };
}

function requireCount(value: unknown, label: string): number {
  return requireInteger(value, label, 0);
}

/**
 * 桶起点必须落在桶宽的整数倍上。
 *
 * 这不是洁癖：属主表的主键含桶起点，未对齐的取值**不会**报错，只会悄悄多出一行——
 * 同一次调用因两侧对齐口径不同被拆成两条账，而面板那条按 10 分钟画的曲线会多出一个错位的点。
 * 这是典型的「编译过、测试过、只有看图的人觉得哪里不对」。
 */
function requireBucketStart(value: unknown): number {
  const bucketStartMs = requireInteger(value, 'bucketStartMs', 0);
  if (bucketStartMs !== llmUsageBucketStart(bucketStartMs)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `bucketStartMs must be aligned to ${LLM_USAGE_BUCKET_MS}ms buckets`,
    );
  }
  return bucketStartMs;
}

function usageIncrementInput(value: unknown, index: number): LlmUsageIncrement {
  const row = requireRecord(value, `increments[${index}]`);
  const calls = requireInteger(row.calls, `increments[${index}].calls`, 1);
  const okCalls = requireCount(row.okCalls, `increments[${index}].okCalls`);
  if (okCalls > calls) {
    // 成功次数多于总次数是纯粹的算错，放过去会让成功率永久大于 100% 且无人能溯源。
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `increments[${index}].okCalls must not exceed calls`,
    );
  }
  return {
    bucketStartMs: requireBucketStart(row.bucketStartMs),
    // 三个维度字段全部要求非空串：跨进程之后空串是个看起来完全合法的取值，
    // 会落成一行谁都归属不了的账，而不是被谁挡下来。
    accountId: requireString(row.accountId, `increments[${index}].accountId`),
    role: requireString(row.role, `increments[${index}].role`),
    provider: requireString(row.provider, `increments[${index}].provider`),
    model: requireString(row.model, `increments[${index}].model`),
    promptTokens: requireCount(row.promptTokens, `increments[${index}].promptTokens`),
    completionTokens: requireCount(row.completionTokens, `increments[${index}].completionTokens`),
    totalTokens: requireCount(row.totalTokens, `increments[${index}].totalTokens`),
    calls,
    okCalls,
  };
}

function recordUsageInput(value: unknown): LlmUsageIncrement[] {
  const input = requireRecord(value, 'llm usage record');
  const increments = input.increments;
  if (!Array.isArray(increments)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'increments must be an array');
  }
  // 空批合法：调用方的合并窗口里什么都没发生。**MUST NOT 因此报错**，
  // 否则一条正常的空闲心跳会被记成一次记账失败。
  return increments.map(usageIncrementInput);
}

/* ─────────────────────────────────────────── 服务端注册（content 侧） */

/**
 * FB 发帖素材三个写口。
 *
 * 照 design §2.6：本组独立注册，**一组初始化失败不得连带关闭其它组**；
 * 调用方 MUST 把实际注册成功的组名打进启动日志（「声称注册了什么」与「实际注册了什么」不分家）。
 */
export function registerFacebookPublishMediaAuthorityRoutes(
  server: InternalHttpServer,
  local: FacebookPublishMediaPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  const route = <TIn, TOut>(
    method: keyof FacebookPublishMediaPort & string,
    parseInput: (value: unknown) => TIn,
    invoke: (input: TIn) => Promise<TOut>,
  ) => async (args: unknown): Promise<TOut> => {
    // 信封先解，且**故意在 try 之外**：版本 / target 不符是传输契约问题，MUST 保住
    // `api_direct_*` 原码，别被属主译码那层染成泛化的 remote_error——否则「打到了另一台机器」
    // 读起来会跟「对面库读不到」一模一样。
    const input = parseApiDirectEnvelope(args, executionTarget, parseInput);
    return runOwnerCall(`facebook-publish-media.${method}`, ownerHasMethod(local, method), () =>
      invoke(input));
  };

  server.registerBearer(
    FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES.releaseReservation,
    callerToken,
    route('releaseReservation', releaseReservationInput, (input) =>
      local.releaseReservation(input.setId, input.reservationId)),
  );
  server.registerBearer(
    FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES.markUsed,
    callerToken,
    route('markUsed', markUsedInput, (input) => local.markUsed(input.setId, input.publishLogId)),
  );
  server.registerBearer(
    FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES.quarantine,
    callerToken,
    route('quarantine', quarantineInput, (input) => local.quarantine(input.setId, input.reason)),
  );
}

/**
 * 模型用量记账写口（单方法一组，同样独立注册）。
 *
 * ⚠️ **属主今天没有 `recordUsage`**：它的批量落库藏在私有定时器里。content 接线时必须二选一——
 * 给属主补上这个方法，或交一个满足本端口的适配对象。两者都没做时，
 * `ownerHasMethod` 会把缺失当场译成具名的 `unsupported_method`，**不会**静默变成「记上了」。
 * 这与精选库那条 `selectSamplesForSearchTerms` 是完全同形的一件事。
 */
export function registerLlmUsageRecordingAuthorityRoutes(
  server: InternalHttpServer,
  local: LlmUsageRecordingPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    LLM_USAGE_RECORDING_AUTHORITY_ROUTES.recordUsage,
    callerToken,
    async (args: unknown): Promise<number> => {
      const increments = parseApiDirectEnvelope(args, executionTarget, recordUsageInput);
      return runOwnerCall(
        'llm-usage.recordUsage',
        ownerHasMethod(local, 'recordUsage'),
        () => local.recordUsage(increments),
      );
    },
  );
}

/* ─────────────────────────────────────────── 回执守卫（客户端侧） */

function isBooleanResult(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/* ─────────────────────────────────────────── 客户端（automation 侧） */

export class FacebookPublishMediaAuthorityHttpClient implements FacebookPublishMediaPort {
  private readonly channel: ContentAuthorityChannel;

  constructor(
    http: InternalHttpClient,
    callerToken: string,
    executionTarget: DeploymentTarget,
  ) {
    this.channel = { http, callerToken, executionTarget };
  }

  releaseReservation(setId: number, reservationId?: string): Promise<boolean> {
    return callContentAuthority(
      this.channel,
      FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES.releaseReservation,
      'facebook-publish-media.releaseReservation',
      { setId, reservationId },
      // 非布尔 MUST 判形状不符而不是取假：取假会把一次契约漂移说成「这组素材已经不是保留态了」，
      // 而那条素材其实还卡在保留态上等着被放回来。
      isBooleanResult,
    );
  }

  markUsed(setId: number, publishLogId: number): Promise<boolean> {
    return callContentAuthority(
      this.channel,
      FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES.markUsed,
      'facebook-publish-media.markUsed',
      { setId, publishLogId },
      isBooleanResult,
    );
  }

  quarantine(setId: number, reason: string): Promise<boolean> {
    return callContentAuthority(
      this.channel,
      FACEBOOK_PUBLISH_MEDIA_AUTHORITY_ROUTES.quarantine,
      'facebook-publish-media.quarantine',
      { setId, reason },
      isBooleanResult,
    );
  }
}

export class LlmUsageRecordingAuthorityHttpClient implements LlmUsageRecordingPort {
  private readonly channel: ContentAuthorityChannel;

  constructor(
    http: InternalHttpClient,
    callerToken: string,
    executionTarget: DeploymentTarget,
  ) {
    this.channel = { http, callerToken, executionTarget };
  }

  /**
   * **客户端刻意不做任何缓冲、合并、重试**：
   *   - 缓冲与合并是调用方的事（它本来就在调用方内存里），塞进客户端会让这个方法重新变回一个
   *     发完就走的 `void`，失败又一次无处可报；
   *   - 重试在可交换累加计数器上等于翻倍，见文件头。
   */
  recordUsage(increments: readonly LlmUsageIncrement[]): Promise<number> {
    return callContentAuthority(
      this.channel,
      LLM_USAGE_RECORDING_AUTHORITY_ROUTES.recordUsage,
      'llm-usage.recordUsage',
      { increments },
      // 落库行数走「非负整数」而不是「是个数」：读不到 MUST 抛，绝不落成 0——
      // 0 会被读成「对面明确说它一行都没写」，而真相是压根没问到对面。
      isNonNegativeInteger,
    );
  }
}

/* ─────────────────────────────────────────────── 接线期欠账（显式登记） */

/**
 * 本轮**只定义契约**。以下几项 MUST 在接线那一轮处理，登记在此以免变成静默遗漏——
 * 它们都不是本文件能自己修的（涉及组装根、调用侧既有代码、属主实现、跨仓同步名单、归属表）。
 */
export const CONTENT_MEDIA_USAGE_WIRING_DEBT = [
  'content 属主 MUST 补 recordUsage（把批量落库那段从私有定时器里提出来）或交适配对象，否则服务端在场探针会一直答 unsupported_method；同形先例是精选库的 selectSamplesForSearchTerms',
  'automation 侧需要一个本进程的用量合并缓冲（打桶 + 按主键合并 + 定时批量提交）。落点由接线方裁定，但无论落在哪，recordUsage 的抛出 MUST 有人接住并计数，MUST NOT 被 fire-and-forget 吞掉；且传输失败 MUST NOT 重投（可交换累加计数器，重投即翻倍）',
  '成本红线：接线时 MUST NOT 在传输层或 automation 侧折算成本、MUST NOT 引入任何硬编码价目表。成本由属主侧读时 JOIN 账单反算出的单价快照算出（已上线规格 llm-token-usage-stats 的 Token Usage Cost Estimates）',
  'automation 侧的 AIDCP_CONTENT_URL / AIDCP_CONTENT_INTERNAL_TOKEN 与 content 侧「每组独立注册、一组失败不连带关闭其它组、注册成功的组名进启动日志」已由 CONTENT_AUTHORITY_WIRING_DEBT 登记，本文件这两组照同一份处置，不重复登记',
] as const;

/**
 * 已结清的欠账（形态照 `operator-command-http.ts` 的同名清单）。
 *
 * **留着条目而不是删掉**，理由与那份一致：删掉之后「做过了」与「从来没记过」长得一模一样，
 * 而这三条里有两条是**别处的文件**（归属表、控制仓同步名单），下一个人无从判断该不该再做一遍。
 */
export const CONTENT_MEDIA_USAGE_WIRING_DEBT_CLOSED = [
  'FB 素材三条路由已在 content 监听上独立注册，automation 侧客户端已按模式取好，两个消费点（下发器窄口 + 组装根审批驳回直调）都已改指端口',
  'publish-dispatcher 的静默 return 已拆成两支：「这条稿没有素材保留」仍是正常返回，「本进程没有这条端口」计入 dropped 并具名报错、说出后果（素材会停在 reserved 无人回收）',
  'publish-dispatcher 写失败那支已补可计数信号（与 dropped 分开数，两者处置不同）。⚠️ **兜底回收扫描仍未做**——欠账原文是「补可计数信号 or 兜底回收扫描」，这里只取了前一半：计数让「漏了多少」问得出来，但漏掉的那些素材今天仍然没有任何东西会把它们放回可用池",
  'content-authority-http.ts 的私有译码副本已删，改指 content-authority-wire.ts 公共那一份（结清前逐条比过两份实现，语义一致、尚未漂移 ⇒ 这次是防患不是修 bug）',
  '两个 kernel 端口文件已同时进 ownership-rules.json 的 fileOverrides 与 kernel-non-members.json 的 kernelRoster.members',
  '本文件与 content-authority-wire.ts 已进控制仓 scripts/sync-split-repos 的 TRANSPORT_MEMBERS',
] as const;
