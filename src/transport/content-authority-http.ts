/**
 * automation → content 两条属主端口的传输三件套（路由常量 + 服务端注册 + 类型化客户端），
 * **本轮只定义、不接线**（不改组装根、不改默认注入、不改 `src/server.ts`）。
 *
 * 覆盖的端口（都已在 kernel 定义好，本文件一个字都不改它们）：
 *   - {@link file://../kernel/concept-pool-port.ts} 概念池 6 个方法；
 *   - {@link file://../kernel/curated-selection-port.ts} 精选库召回 2 个方法；
 *   - {@link file://../kernel/curated-write-port.ts} 精选库写口 5 个方法；
 *   - {@link file://../kernel/text-card-transcriber-port.ts} 图内文字卡转写 1 个方法
 *     （`enabled()` 具名不上线，理由见该组路由表注释）。
 * 失败信号统一走 {@link file://../kernel/content-port-error.ts}。
 *
 * **三件套同文件是硬要求**（CLAUDE §8.4）：拆成「属主仓写服务端、消费方仓写客户端」两份，
 * 两侧各自编译通过、各自测试通过，**只有真跑起来才 404**。路由常量在这里只有一份，
 * 且 `as const satisfies Record<keyof Port, string>` 让「端口加了方法而路由表没跟上」在 typecheck 当场失败。
 * 注意那条 satisfies 只保证**表**是全的，保证不了**注册函数**把表里每条都挂上去——后者靠
 * `test/transport/content-authority-http.test.ts` 逐条走一遍回环钉住。
 *
 * 信封 / 鉴权照 4a 已建立的形态（`api-direct-http-common.ts` + `paired-command-http.ts`）：
 * 版本 + `executionTarget` 双校验、`registerBearer` 内部令牌。**target 由客户端从本进程部署事实注入**，
 * 业务调用方没有任何入口能选它——DEV/OL 长期共库，让调用方挑 target 等于把「在哪台机器上真跑」
 * 交给一个请求体字段。这一点上刻意**不照抄** `curated-content-http.ts`：那组是更早期的裸形态
 * （无 Bearer、无信封），design §2.6 明写新写口一律按 persona 那组来。
 *
 * **失败语义与 4a 的写口不同，别照搬 `callApiDirectWrite`。** 这两条端口的约定是
 * 「返回裸值、失败抛 `ContentPortError`」，调用方按具名 `reason` 判、不用 `instanceof`。
 * 本文件因此自带一层译码，两个方向各一半：
 *   - 服务端：属主抛出物一律译成带 `code` 的 `ContentPortError` 再出网——线格式只透传带 string `code`
 *     的抛出物，属主侧既有哨兵错误（如精选库的缺表错误）**没有 `code`**，不译就会在这一跳被压成
 *     泛化的 `handler_error`，具名原因当场丢失。
 *   - 客户端：`name` / `reason` 跨这一跳会全丢（线上只剩 `code` + `message`），所以 **MUST** 先用
 *     `contentPortReasonFromCode` 还原、再重新抛一个 `ContentPortError`；还原不出来的**逐条显式**
 *     判定，认不出的落 `remote_error` 并把原始 code 写进 `detail`，**MUST NOT 默默套一个默认 reason**。
 *     套错方向的代价是具体的：把「对面不提供这个方法」吞成「对面报错了」，概念池那条回落分支
 *     第二次变成死代码。
 *
 * **读失败在这里绝不会退化成空数组 / 空池 / 零计数**：本文件所有出口只有两种结局——裸值，或抛。
 * 把抛出重新压成空值的那五处降级点在调用侧，见文件末尾 {@link CONTENT_AUTHORITY_WIRING_DEBT}。
 *
 * 零属主表 SQL、零业务判定，满足 `aidcp-transport` 准入（三家都可能调用 + 不含任何属主表 SQL）。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import { API_DIRECT_CONTRACT_VERSION } from '../kernel/api-direct-port.js';
import type { ConceptPool } from '../kernel/concept-pool.js';
import type { ConceptPoolPort, ConceptWithSource } from '../kernel/concept-pool-port.js';
import type {
  CuratedSelectionPort,
  CuratedSelectionWindow,
  CuratedTermSample,
} from '../kernel/curated-selection-port.js';
import type {
  CuratedActionContent,
  CuratedContentTypeFilter,
  CuratedObservation,
  CuratedReferenceImageInput,
  CuratedSelectItem,
  CuratedSourceContentType,
  CuratedTextCardContext,
} from '../kernel/curated-content-types.js';
import type {
  CuratedCommentArchiveInput,
  CuratedWritePort,
} from '../kernel/curated-write-port.js';
import type {
  AiFallback,
  AiStepResult,
  IntentClassifierInput,
  IntentClassifierOutput,
  PolisherInput,
  PolisherOutput,
  ReplyAiPort,
  RiskReviewerInput,
  RiskReviewerOutput,
} from '../kernel/interaction-types.js';
import type {
  TextCardTranscriber,
  TextCardTranscriberInput,
  TextCardTranscriberOutcome,
} from '../kernel/text-card-transcriber-port.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  ApiDirectHttpError,
  isNonNegativeInteger,
  isRecord,
  isVoidAck,
  parseApiDirectEnvelope,
  requireFiniteNumber,
  requireInteger,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';
// 失败映射层取公共那一份（`content-media-usage-http.ts` 的欠账登记第 1 条，本轮结清）。
// 这里原先有一份逐字相同的私有副本：**两份失败映射表各自编译通过、各自测试通过，
// 只有失败真发生的那一刻才看得出对不上**——而失败路径恰恰是最少被真跑到的那条。
// 结清时逐条比过两份实现，语义完全一致、尚未漂移（所以这次是防患，不是修 bug）。
import {
  callContentAuthority,
  ownerHasMethod,
  runOwnerCall,
  type ContentAuthorityChannel,
} from './content-authority-wire.js';

/**
 * 共用 4a 的契约版本号。**刻意不另起一个编号**：两套版本号只会各自漂移，
 * 而这两条端口与 4a 的信封是同一套（同一个 `parseApiDirectEnvelope` 在校验它）。
 */
export const CONTENT_AUTHORITY_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

/* ───────────────────────────────────────────────────────── 路由表 */

export const CONCEPT_POOL_AUTHORITY_ROUTES = {
  addCandidate: 'content-authority/concept-pool/v1/add-candidate',
  loadPool: 'content-authority/concept-pool/v1/load-pool',
  markSearched: 'content-authority/concept-pool/v1/mark-searched',
  countNewSince: 'content-authority/concept-pool/v1/count-new-since',
  getNewConceptsSince: 'content-authority/concept-pool/v1/new-concepts-since',
  getNewConceptsWithSourceSince:
    'content-authority/concept-pool/v1/new-concepts-with-source-since',
} as const satisfies Record<keyof ConceptPoolPort, string>;

export const CURATED_SELECTION_AUTHORITY_ROUTES = {
  selectForCreation: 'content-authority/curated-selection/v1/select-for-creation',
  selectSamplesForSearchTerms:
    'content-authority/curated-selection/v1/select-samples-for-search-terms',
} as const satisfies Record<keyof CuratedSelectionPort, string>;

/* ─────────────────────────────────────────── 入参解析（服务端侧） */

interface AddCandidateInput {
  keyword: string;
  sourceNote?: string;
}

interface MarkSearchedInput {
  keyword: string;
}

interface SinceInput {
  sinceMs: number;
  limit?: number;
}

interface CuratedSelectionInput {
  accountId: string;
  contentType: CuratedContentTypeFilter;
  limit: number;
  window?: CuratedSelectionWindow;
}

const CURATED_CONTENT_TYPE_FILTERS: readonly CuratedContentTypeFilter[] = [
  'image_text',
  'video',
  'comment',
  'note',
  'source_post',
];

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label);
}

/**
 * 召回条数下限取 1，不是 0。`limit=0` 是个退化请求：属主会诚实地回空数组，
 * 而调用方读到的空数组与「库里真没有素材」一模一样——把一次问错了的提问伪装成一个答案。
 */
function requireLimit(value: unknown, label: string): number {
  return requireInteger(value, label, 1);
}

function addCandidateInput(value: unknown): AddCandidateInput {
  const input = requireRecord(value, 'concept add-candidate');
  const sourceNote = optionalString(input.sourceNote, 'sourceNote');
  return {
    keyword: requireString(input.keyword, 'keyword'),
    ...(sourceNote === undefined ? {} : { sourceNote }),
  };
}

function markSearchedInput(value: unknown): MarkSearchedInput {
  const input = requireRecord(value, 'concept mark-searched');
  return { keyword: requireString(input.keyword, 'keyword') };
}

/**
 * 时间窗起点不做范围收窄（由调用方定义「自何时起」），只要求它是个有限数：
 * `NaN` / 字符串跨进这一跳会让属主那条 `to_timestamp()` 静默算出一个谁也没打算要的窗口。
 */
function sinceInput(value: unknown): SinceInput {
  const input = requireRecord(value, 'concept since query');
  const limit = input.limit === undefined || input.limit === null
    ? undefined
    : requireLimit(input.limit, 'limit');
  return {
    sinceMs: requireFiniteNumber(input.sinceMs, 'sinceMs'),
    ...(limit === undefined ? {} : { limit }),
  };
}

function countSinceInput(value: unknown): { sinceMs: number } {
  const input = requireRecord(value, 'concept count query');
  return { sinceMs: requireFiniteNumber(input.sinceMs, 'sinceMs') };
}

/** 空入参仍走信封，故版本与 target 照常校验。 */
function emptyInput(value: unknown): Record<string, never> {
  requireRecord(value, 'concept pool request');
  return {};
}

function curatedContentType(value: unknown): CuratedContentTypeFilter {
  if (
    typeof value !== 'string' ||
    !CURATED_CONTENT_TYPE_FILTERS.includes(value as CuratedContentTypeFilter)
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `contentType must be one of ${CURATED_CONTENT_TYPE_FILTERS.join(' | ')}`,
    );
  }
  return value as CuratedContentTypeFilter;
}

/**
 * 时间窗在属主侧缺席等于**不过滤**（既有行为）。所以一次字段名漂移的后果不是报错，
 * 而是**悄悄放宽召回**、多回一批本该被窗口挡掉的旧行。窗口在场就必须解出 `updatedSinceMs`，
 * 空对象 / 认不出的字段一律当场拒绝。
 */
function curatedWindow(value: unknown): CuratedSelectionWindow | undefined {
  if (value === undefined || value === null) return undefined;
  const window = requireRecord(value, 'window');
  return { updatedSinceMs: requireFiniteNumber(window.updatedSinceMs, 'window.updatedSinceMs') };
}

function curatedSelectionInput(value: unknown): CuratedSelectionInput {
  const input = requireRecord(value, 'curated selection query');
  const window = curatedWindow(input.window);
  return {
    accountId: requireString(input.accountId, 'accountId'),
    contentType: curatedContentType(input.contentType),
    limit: requireLimit(input.limit, 'limit'),
    ...(window === undefined ? {} : { window }),
  };
}

/* ─────────────────────────── 属主侧失败译码（服务端注册用） */

/* ─────────────────────────────────────────── 服务端注册（content 侧） */

export function registerConceptPoolAuthorityRoutes(
  server: InternalHttpServer,
  local: ConceptPoolPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  const route = <TIn, TOut>(
    method: keyof ConceptPoolPort & string,
    parseInput: (value: unknown) => TIn,
    invoke: (input: TIn) => Promise<TOut>,
  ) => async (args: unknown): Promise<TOut> => {
    // 信封先解，且**故意在 try 之外**：版本 / target 不符是传输契约问题，MUST 保住
    // `api_direct_*` 原码，别被属主译码那层染成泛化的 remote_error——否则「打到了另一台机器」
    // 读起来会跟「对面库读不到」一模一样。
    const input = parseApiDirectEnvelope(args, executionTarget, parseInput);
    return runOwnerCall(`concept-pool.${method}`, ownerHasMethod(local, method), () =>
      invoke(input));
  };

  server.registerBearer(
    CONCEPT_POOL_AUTHORITY_ROUTES.addCandidate,
    callerToken,
    route('addCandidate', addCandidateInput, (input) =>
      local.addCandidate(input.keyword, input.sourceNote)),
  );
  server.registerBearer(
    CONCEPT_POOL_AUTHORITY_ROUTES.loadPool,
    callerToken,
    route('loadPool', emptyInput, () => local.loadPool()),
  );
  server.registerBearer(
    CONCEPT_POOL_AUTHORITY_ROUTES.markSearched,
    callerToken,
    // 返回 void 的方法在线上 MUST 回一个显式回执：`undefined` 编码后是个空响应体，
    // 与「路由压根没跑」长得一样，upsert 没做成也会读起来像做成了。
    route('markSearched', markSearchedInput, async (input) => {
      await local.markSearched(input.keyword);
      return { accepted: true } as const;
    }),
  );
  server.registerBearer(
    CONCEPT_POOL_AUTHORITY_ROUTES.countNewSince,
    callerToken,
    route('countNewSince', countSinceInput, (input) => local.countNewSince(input.sinceMs)),
  );
  server.registerBearer(
    CONCEPT_POOL_AUTHORITY_ROUTES.getNewConceptsSince,
    callerToken,
    route('getNewConceptsSince', sinceInput, (input) =>
      local.getNewConceptsSince(input.sinceMs, input.limit)),
  );
  server.registerBearer(
    CONCEPT_POOL_AUTHORITY_ROUTES.getNewConceptsWithSourceSince,
    callerToken,
    route('getNewConceptsWithSourceSince', sinceInput, (input) =>
      local.getNewConceptsWithSourceSince(input.sinceMs, input.limit)),
  );
}

export function registerCuratedSelectionAuthorityRoutes(
  server: InternalHttpServer,
  local: CuratedSelectionPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  const route = <TOut>(
    method: keyof CuratedSelectionPort & string,
    invoke: (input: CuratedSelectionInput) => Promise<TOut>,
  ) => async (args: unknown): Promise<TOut> => {
    const input = parseApiDirectEnvelope(args, executionTarget, curatedSelectionInput);
    return runOwnerCall(`curated-selection.${method}`, ownerHasMethod(local, method), () =>
      invoke(input));
  };

  server.registerBearer(
    CURATED_SELECTION_AUTHORITY_ROUTES.selectForCreation,
    callerToken,
    route('selectForCreation', (input) =>
      local.selectForCreation(input.accountId, input.contentType, input.limit, input.window)),
  );
  server.registerBearer(
    CURATED_SELECTION_AUTHORITY_ROUTES.selectSamplesForSearchTerms,
    callerToken,
    // 三字段窄投影**在属主侧完成**（端口刻意是两个方法）：全字段视图挂着参照图集 / 视觉分析 /
    // 文字卡转写等大块 JSON，搬过边界只为留三个字段。这里不做任何合并或再投影。
    route('selectSamplesForSearchTerms', (input) =>
      local.selectSamplesForSearchTerms(input.accountId, input.contentType, input.limit)),
  );
}

/* ─────────────────────────────────────────── 回执守卫（客户端侧） */

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 计数字段 MUST **在场**且为 `number | null`：缺字段与「真的是 0」在下游是两码事。 */
function isNullableCount(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isBooleanResult(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isConceptPool(value: unknown): value is ConceptPool {
  return isRecord(value) && isStringArray(value.known) && isStringArray(value.candidates);
}

function isConceptWithSourceList(value: unknown): value is ConceptWithSource[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.keyword === 'string' &&
        // `sourceNote` 缺席 MUST 判形状不符：JSON 会把 `undefined` 直接丢掉，
        // 放行等于把「不知道从哪来的」写成一条没有来源的记录。
        'sourceNote' in item &&
        (item.sourceNote === null || typeof item.sourceNote === 'string'),
    )
  );
}

const CURATED_SELECT_ITEM_KEYS = [
  'sourceId',
  'contentType',
  'title',
  'body',
  'topics',
  'likeCount',
  'collectCount',
  'botLiked',
  'botCollected',
  'referenceImages',
] as const;

/**
 * 全字段召回行的形状校验。**有意只校验行身份与计数**：参照图集 / 视觉分析 / 文字卡转写
 * 三块是可选增强，逐字段校验的代价落在每一次召回上，且它们缺失不会被误读成「这一行不存在」。
 * 这里守的是另一件事——行的身份字段与两个计数不会静默变成 `undefined`。
 */
function isCuratedSelectItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!CURATED_SELECT_ITEM_KEYS.every((key) => key in value)) return false;
  return (
    typeof value.sourceId === 'string' &&
    (value.contentType === 'image_text' ||
      value.contentType === 'video' ||
      value.contentType === 'comment') &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    isStringArray(value.topics) &&
    isNullableCount(value.likeCount) &&
    isNullableCount(value.collectCount) &&
    typeof value.botLiked === 'boolean' &&
    typeof value.botCollected === 'boolean' &&
    Array.isArray(value.referenceImages)
  );
}

function isCuratedSelectItemList(value: unknown): value is CuratedSelectItem[] {
  return Array.isArray(value) && value.every(isCuratedSelectItem);
}

function isCuratedTermSampleList(value: unknown): value is CuratedTermSample[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.title === 'string' &&
        isStringArray(item.topics) &&
        'collectCount' in item &&
        isNullableCount(item.collectCount),
    )
  );
}

/* ─────────────────────────── 客户端侧失败译码（automation 侧） */

/* ─────────────────────────────────────────── 客户端（automation 侧） */

export class ConceptPoolAuthorityHttpClient implements ConceptPoolPort {
  private readonly channel: ContentAuthorityChannel;

  constructor(
    http: InternalHttpClient,
    callerToken: string,
    executionTarget: DeploymentTarget,
  ) {
    this.channel = { http, callerToken, executionTarget };
  }

  addCandidate(keyword: string, sourceNote?: string): Promise<boolean> {
    return callContentAuthority(
      this.channel,
      CONCEPT_POOL_AUTHORITY_ROUTES.addCandidate,
      'concept-pool.addCandidate',
      { keyword, sourceNote },
      // 布尔回执是「这个词是不是我新发现的」的唯一依据，非布尔 MUST 判形状不符而不是取假。
      isBooleanResult,
    );
  }

  loadPool(): Promise<ConceptPool> {
    return callContentAuthority(
      this.channel,
      CONCEPT_POOL_AUTHORITY_ROUTES.loadPool,
      'concept-pool.loadPool',
      {},
      isConceptPool,
    );
  }

  async markSearched(keyword: string): Promise<void> {
    await callContentAuthority(
      this.channel,
      CONCEPT_POOL_AUTHORITY_ROUTES.markSearched,
      'concept-pool.markSearched',
      { keyword },
      isVoidAck,
    );
  }

  countNewSince(sinceMs: number): Promise<number> {
    return callContentAuthority(
      this.channel,
      CONCEPT_POOL_AUTHORITY_ROUTES.countNewSince,
      'concept-pool.countNewSince',
      { sinceMs },
      // 计数走「非负整数」而不是「是个数」：读不到 MUST 抛，绝不落成 0——
      // 概念积累扳机按它判阈值，0 会读成「这段时间什么都没发现」。
      isNonNegativeInteger,
    );
  }

  getNewConceptsSince(sinceMs: number, limit?: number): Promise<string[]> {
    return callContentAuthority(
      this.channel,
      CONCEPT_POOL_AUTHORITY_ROUTES.getNewConceptsSince,
      'concept-pool.getNewConceptsSince',
      { sinceMs, limit },
      isStringArray,
    );
  }

  /**
   * 首选取法。**客户端刻意不在这里自己回落到 {@link getNewConceptsSince}**：
   * 回落是调用方看着具名 `unsupported_method` 明写的一个决定，藏进客户端等于把
   * 「对面版本落后」重新变成没人看得见的事。
   */
  getNewConceptsWithSourceSince(sinceMs: number, limit?: number): Promise<ConceptWithSource[]> {
    return callContentAuthority(
      this.channel,
      CONCEPT_POOL_AUTHORITY_ROUTES.getNewConceptsWithSourceSince,
      'concept-pool.getNewConceptsWithSourceSince',
      { sinceMs, limit },
      isConceptWithSourceList,
    );
  }
}

export class CuratedSelectionAuthorityHttpClient implements CuratedSelectionPort {
  private readonly channel: ContentAuthorityChannel;

  constructor(
    http: InternalHttpClient,
    callerToken: string,
    executionTarget: DeploymentTarget,
  ) {
    this.channel = { http, callerToken, executionTarget };
  }

  selectForCreation(
    accountId: string,
    contentType: CuratedContentTypeFilter,
    limit: number,
    window?: CuratedSelectionWindow,
  ): Promise<CuratedSelectItem[]> {
    return callContentAuthority(
      this.channel,
      CURATED_SELECTION_AUTHORITY_ROUTES.selectForCreation,
      'curated-selection.selectForCreation',
      { accountId, contentType, limit, window },
      isCuratedSelectItemList,
    );
  }

  selectSamplesForSearchTerms(
    accountId: string,
    contentType: CuratedContentTypeFilter,
    limit: number,
  ): Promise<CuratedTermSample[]> {
    return callContentAuthority(
      this.channel,
      CURATED_SELECTION_AUTHORITY_ROUTES.selectSamplesForSearchTerms,
      'curated-selection.selectSamplesForSearchTerms',
      { accountId, contentType, limit },
      isCuratedTermSampleList,
    );
  }
}

/* ══════════════════════════════ 精选库写侧（task 2.4b） ══════════════════════════════ */

/*
 * 与上面召回那组**同文件**（三件套同文件是硬要求），且刻意共用这里已有的入参解析与失败译码：
 * 同一个域的两张脸各写一套解析，第二套会在某次字段调整后悄悄与第一套不一致，
 * 而两边都编译得过、都测得过——那正是本文件刚删掉一份重复译码表的同一个理由。
 */

/* ─────────────────────────── 入参解析（服务端侧） */

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isStringArray(value)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', `${label} must be a string array`);
  }
  return value;
}

function optionalNullableCount(value: unknown, label: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isNonNegativeInteger(value)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', `${label} must be a count or null`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireInteger(value, label, 1);
}

/** 源帖内容类型（写侧只认这两个；`comment` 走 archiveComment，`note` / `source_post` 是召回侧的过滤别名）。 */
function curatedSourceContentType(value: unknown): CuratedSourceContentType {
  if (value === 'image_text' || value === 'video') return value;
  throw new ApiDirectHttpError(
    'api_direct_invalid_request',
    'contentType must be image_text or video',
  );
}

/** 观测 / 收藏共用的行定位三元组。 */
interface CuratedRowKeyInput {
  accountId: string;
  sourceId: string;
  contentType: CuratedSourceContentType;
}

function curatedRowKey(record: Record<string, unknown>): CuratedRowKeyInput {
  return {
    accountId: requireString(record.accountId, 'accountId'),
    sourceId: requireString(record.sourceId, 'sourceId'),
    contentType: curatedSourceContentType(record.contentType),
  };
}

/**
 * 观测入参。
 *
 * **身份与必填字段逐条校验，两块增强负载原样透传**（`referenceImages` / `textCardTranscription`）。
 * 那两块的规范化规则住在属主里（非法项丢弃、保住本体），**在这里再写一份校验就是第二份规则**：
 * 两份在写下来那天一致，此后任何一次单边调整都不会报错，只会让某些今天写得进去的观测
 * 明天开始被这一层默默拒掉——而拒掉一条观测没有任何人会发现（精选语料只会少不会多）。
 */
function upsertObservationInput(value: unknown): CuratedObservation {
  const record = requireRecord(value, 'curated observation');
  const contentType = record.contentType;
  if (contentType !== 'image_text' && contentType !== 'video' && contentType !== 'comment') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'contentType must be image_text, video or comment',
    );
  }
  const topics = optionalStringArray(record.topics, 'topics') ?? [];
  const publishedObservedAt = optionalTimestamp(record.publishedObservedAt, 'publishedObservedAt');
  const publishedAtText = optionalString(record.publishedAtText, 'publishedAtText');
  if (publishedAtText !== undefined && publishedObservedAt === undefined) {
    // 属主契约：平台原文在场时，换算锚点必须一起在场。少了锚点那句「3 天前」
    // 会被后来的读者按**读到它的时刻**换算，越晚读误差越大，且看不出是错的。
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'publishedObservedAt is required when publishedAtText is present',
    );
  }
  return {
    accountId: requireString(record.accountId, 'accountId'),
    contentType,
    sourceId: requireString(record.sourceId, 'sourceId'),
    body: requireString(record.body, 'body'),
    topics,
    admitReason: requireString(record.admitReason, 'admitReason'),
    ...(optionalString(record.title, 'title') !== undefined
      ? { title: optionalString(record.title, 'title')! }
      : {}),
    ...(optionalString(record.author, 'author') !== undefined
      ? { author: optionalString(record.author, 'author')! }
      : {}),
    ...(optionalString(record.sourceUrl, 'sourceUrl') !== undefined
      ? { sourceUrl: optionalString(record.sourceUrl, 'sourceUrl')! }
      : {}),
    ...(optionalNullableCount(record.likeCount, 'likeCount') !== undefined
      ? { likeCount: optionalNullableCount(record.likeCount, 'likeCount')! }
      : {}),
    ...(optionalNullableCount(record.collectCount, 'collectCount') !== undefined
      ? { collectCount: optionalNullableCount(record.collectCount, 'collectCount')! }
      : {}),
    ...(optionalNullableCount(record.commentCount, 'commentCount') !== undefined
      ? { commentCount: optionalNullableCount(record.commentCount, 'commentCount')! }
      : {}),
    ...(publishedAtText !== undefined ? { publishedAtText } : {}),
    ...(publishedObservedAt !== undefined ? { publishedObservedAt } : {}),
    // 两块增强负载：属主是它们唯一的规范化处，这里不复制第二份规则。
    ...(Array.isArray(record.referenceImages)
      ? { referenceImages: record.referenceImages as CuratedObservation['referenceImages'] }
      : {}),
    ...(record.textCardTranscription !== undefined && record.textCardTranscription !== null
      ? {
          textCardTranscription:
            record.textCardTranscription as CuratedObservation['textCardTranscription'],
        }
      : {}),
  };
}

interface RefreshReferenceImagesInput extends CuratedRowKeyInput {
  input: CuratedReferenceImageInput[] | undefined;
}

function refreshReferenceImagesInput(value: unknown): RefreshReferenceImagesInput {
  const record = requireRecord(value, 'refresh reference images');
  return {
    ...curatedRowKey(record),
    // 属主对 `undefined` 与空数组的处置相同（都不写），照原样透传即可；
    // 图集本身仍由属主规范化，理由同 upsertObservation。
    input: Array.isArray(record.input)
      ? (record.input as CuratedReferenceImageInput[])
      : undefined,
  };
}

function textCardContextInput(value: unknown): CuratedRowKeyInput {
  return curatedRowKey(requireRecord(value, 'text card context'));
}

interface ArchiveCommentInput {
  accountId: string;
  input: CuratedCommentArchiveInput;
}

function archiveCommentInput(value: unknown): ArchiveCommentInput {
  const record = requireRecord(value, 'archive comment');
  const input = requireRecord(record.input, 'input');
  const likeCount = optionalNullableCount(input.likeCount, 'input.likeCount');
  return {
    accountId: requireString(record.accountId, 'accountId'),
    input: {
      sourceId: requireString(input.sourceId, 'input.sourceId'),
      text: requireString(input.text, 'input.text'),
      topics: optionalStringArray(input.topics, 'input.topics') ?? [],
      ...(optionalString(input.author, 'input.author') !== undefined
        ? { author: optionalString(input.author, 'input.author')! }
        : {}),
      ...(optionalString(input.sourceNoteTitle, 'input.sourceNoteTitle') !== undefined
        ? { sourceNoteTitle: optionalString(input.sourceNoteTitle, 'input.sourceNoteTitle')! }
        : {}),
      ...(optionalString(input.reason, 'input.reason') !== undefined
        ? { reason: optionalString(input.reason, 'input.reason')! }
        : {}),
      // `null` 与「字段缺席」在属主侧同样落 null，但两者 MUST 都能过来：
      // 把 `null` 挡成非法会让「读不到点赞数」这条完全正常的观测整条写不进去。
      ...(likeCount !== undefined ? { likeCount } : {}),
    },
  };
}

interface MarkBotActionInput {
  accountId: string;
  sourceId: string;
  action: 'like' | 'collect';
  content?: CuratedActionContent;
}

function markBotActionInput(value: unknown): MarkBotActionInput {
  const record = requireRecord(value, 'mark bot action');
  const action = record.action;
  if (action !== 'like' && action !== 'collect') {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'action must be like or collect');
  }
  return {
    accountId: requireString(record.accountId, 'accountId'),
    sourceId: requireString(record.sourceId, 'sourceId'),
    action,
    // 强弱信号的差别是属主的领域规则（点赞只标既有行、收藏可自动建行），
    // 这一层不复制它，也不因为 `content` 缺席就改判动作类型。
    ...(record.content !== undefined && record.content !== null
      ? { content: record.content as CuratedActionContent }
      : {}),
  };
}

/* ─────────────────────────── 回执守卫（客户端侧） */

/**
 * 读穿缓存的回执形状。**照本文件既有口径**：只校验行身份必需的那一项（图集是数组），
 * 转写块作可选增强透传——它缺失不会被误读成「这条源帖不存在」，而后者由 `null` 表达。
 */
function isCuratedTextCardContextOrNull(value: unknown): value is CuratedTextCardContext | null {
  if (value === null) return true;
  return isRecord(value) && Array.isArray(value.referenceImages);
}

export const CURATED_WRITE_AUTHORITY_ROUTES = {
  upsertObservation: 'content-authority/curated-write/v1/upsert-observation',
  refreshReferenceImages: 'content-authority/curated-write/v1/refresh-reference-images',
  getTextCardContext: 'content-authority/curated-write/v1/text-card-context',
  archiveComment: 'content-authority/curated-write/v1/archive-comment',
  markBotAction: 'content-authority/curated-write/v1/mark-bot-action',
} as const satisfies Record<keyof CuratedWritePort, string>;

/* ─────────────────────────── 服务端注册（content 侧） */

/**
 * 精选库五条写口。与召回那组**各注册各的**：写口起不来不该连带关掉召回，反之亦然。
 */
export function registerCuratedWriteAuthorityRoutes(
  server: InternalHttpServer,
  local: CuratedWritePort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  const route = <TIn, TOut>(
    method: keyof CuratedWritePort & string,
    parseInput: (value: unknown) => TIn,
    invoke: (input: TIn) => Promise<TOut>,
  ) => async (args: unknown): Promise<TOut> => {
    // 信封先解、且在 try 之外：版本 / target 不符是传输契约问题，MUST 保住原码，
    // 别被属主译码那层染成泛化的 remote_error。
    const input = parseApiDirectEnvelope(args, executionTarget, parseInput);
    return runOwnerCall(`curated-write.${method}`, ownerHasMethod(local, method), () =>
      invoke(input));
  };

  server.registerBearer(
    CURATED_WRITE_AUTHORITY_ROUTES.upsertObservation,
    callerToken,
    // 返回 void 的三个方法**必须回一个显式回执**：`undefined` 编码后是空响应体，
    // 与「这条路由压根没跑」逐字节一样——写没做成会读起来像做成了。
    route('upsertObservation', upsertObservationInput, async (obs) => {
      await local.upsertObservation(obs);
      return { accepted: true } as const;
    }),
  );
  server.registerBearer(
    CURATED_WRITE_AUTHORITY_ROUTES.refreshReferenceImages,
    callerToken,
    route('refreshReferenceImages', refreshReferenceImagesInput, (input) =>
      local.refreshReferenceImages(
        input.accountId,
        input.sourceId,
        input.contentType,
        input.input,
      )),
  );
  server.registerBearer(
    CURATED_WRITE_AUTHORITY_ROUTES.getTextCardContext,
    callerToken,
    route('getTextCardContext', textCardContextInput, (input) =>
      local.getTextCardContext(input.accountId, input.sourceId, input.contentType)),
  );
  server.registerBearer(
    CURATED_WRITE_AUTHORITY_ROUTES.archiveComment,
    callerToken,
    route('archiveComment', archiveCommentInput, async (input) => {
      await local.archiveComment(input.accountId, input.input);
      return { accepted: true } as const;
    }),
  );
  server.registerBearer(
    CURATED_WRITE_AUTHORITY_ROUTES.markBotAction,
    callerToken,
    route('markBotAction', markBotActionInput, async (input) => {
      await local.markBotAction(input.accountId, input.sourceId, input.action, input.content);
      return { accepted: true } as const;
    }),
  );
}

/* ─────────────────────────── 客户端（automation 侧） */

export class CuratedWriteAuthorityHttpClient implements CuratedWritePort {
  private readonly channel: ContentAuthorityChannel;

  constructor(
    http: InternalHttpClient,
    callerToken: string,
    executionTarget: DeploymentTarget,
  ) {
    this.channel = { http, callerToken, executionTarget };
  }

  async upsertObservation(obs: CuratedObservation): Promise<void> {
    await callContentAuthority(
      this.channel,
      CURATED_WRITE_AUTHORITY_ROUTES.upsertObservation,
      'curated-write.upsertObservation',
      obs,
      isVoidAck,
    );
  }

  refreshReferenceImages(
    accountId: string,
    sourceId: string,
    contentType: CuratedSourceContentType,
    input: CuratedReferenceImageInput[] | undefined,
  ): Promise<number> {
    return callContentAuthority(
      this.channel,
      CURATED_WRITE_AUTHORITY_ROUTES.refreshReferenceImages,
      'curated-write.refreshReferenceImages',
      { accountId, sourceId, contentType, input },
      // 受影响行数是调用方的领域答案（0 ＝ 库里没有这条源帖），非整数 MUST 判形状不符，
      // MUST NOT 取 0——那会把一次坏回执读成一句确定的「这条不存在」。
      isNonNegativeInteger,
    );
  }

  getTextCardContext(
    accountId: string,
    sourceId: string,
    contentType: CuratedSourceContentType,
  ): Promise<CuratedTextCardContext | null> {
    return callContentAuthority(
      this.channel,
      CURATED_WRITE_AUTHORITY_ROUTES.getTextCardContext,
      'curated-write.getTextCardContext',
      { accountId, sourceId, contentType },
      isCuratedTextCardContextOrNull,
    );
  }

  async archiveComment(accountId: string, input: CuratedCommentArchiveInput): Promise<void> {
    await callContentAuthority(
      this.channel,
      CURATED_WRITE_AUTHORITY_ROUTES.archiveComment,
      'curated-write.archiveComment',
      { accountId, input },
      isVoidAck,
    );
  }

  async markBotAction(
    accountId: string,
    sourceId: string,
    action: 'like' | 'collect',
    content?: CuratedActionContent,
  ): Promise<void> {
    await callContentAuthority(
      this.channel,
      CURATED_WRITE_AUTHORITY_ROUTES.markBotAction,
      'curated-write.markBotAction',
      { accountId, sourceId, action, content },
      isVoidAck,
    );
  }
}

/* ═══════════════════════════════════ 图内文字卡转写（automation → content） */

/**
 * 转写口的**远端面只有一条**：`transcribe`。
 *
 * `enabled()` 刻意不上线。它答的是「运营把这个旗标开着吗」——旗标是部署配置，两个进程读的是
 * 同一份，本地读得到、且本来就是同步的。为它开一条路由有两处坏：角色每评一篇笔记要为一个布尔
 * 多走一次网络往返；且那一跳失败时这个**同步**方法无处报错，只能编一个答案回去，
 * 而它编出来的那个答案会被角色当成三态里的一态如实打进日志——正是本端口存在的理由要防的形态。
 *
 * 代价是「两台机器的旗标配得不一样」本地看不出来。**所以应答里带回属主那一侧的取值**，
 * 客户端比对不上就告警一次（见 {@link TextCardTranscriptionAuthorityHttpClient}）。
 * 两个方向不对称，而不对称的方向恰好是对的：
 *   - 自动化侧关、属主侧开 ⇒ 压根不发起调用，角色如实报 `flag_off`。**这就是正确行为**：
 *     运营在自动化侧关掉了它，本来就该不转写，属主那边开着与否不改变这个结论；
 *   - 自动化侧开、属主侧关 ⇒ 调用发出去、属主原样退回、一个字也没转写，
 *     而角色会报 `active`。**这一支才是有害的那支，也正是回显能抓住的那支。**
 *
 * `satisfies` 里显式 `Exclude` 掉 `enabled`：端口将来新增任何方法仍会在此 typecheck 当场红，
 * 只有这一条是具名豁免的。写成 `Record<string, string>` 就把这道保护整个丢了。
 */
export const TEXT_CARD_TRANSCRIPTION_AUTHORITY_ROUTES = {
  transcribe: 'content-authority/text-card-transcription/v1/transcribe',
} as const satisfies Record<Exclude<keyof TextCardTranscriber, 'enabled'>, string>;

/** 线格式：属主回执 = 端口结果 + 属主那一侧的旗标取值（后者只用于对账，不进端口类型）。 */
interface TextCardTranscribeWireResult {
  outcome: TextCardTranscriberOutcome;
  ownerFlagEnabled: boolean;
}

function transcribeInput(value: unknown): TextCardTranscriberInput {
  const record = requireRecord(value, 'text card transcribe');
  // 图集不做「不是数组就当空数组」的兜底：那会把一次坏载荷读成「这篇没有图可转写」，
  // 而后者是一个完全正常的成功结局——坏载荷与真·无图长得一模一样，正是红线点名的形态。
  if (!Array.isArray(record.images)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'images must be an array');
  }
  return {
    accountId: requireString(record.accountId, 'accountId'),
    sourceId: requireString(record.sourceId, 'sourceId'),
    // 图集与读穿缓存的**内容**仍由属主规范化（同 upsertObservation / refreshReferenceImages 的口径）：
    // 这一跳只校验行身份与外层形状，不在传输层重做一遍属主的归一（两份归一必然漂）。
    images: record.images as CuratedReferenceImageInput[],
    snapshotAt: requireFiniteNumber(record.snapshotAt, 'snapshotAt'),
    ...(record.cached === undefined
      ? {}
      : { cached: (record.cached ?? null) as CuratedTextCardContext | null }),
  };
}

/**
 * 回执守卫。`images` 是行身份必需的（转写器恒返回规范化后的整组图），
 * `transcription` 作可选增强透传——它缺失表示这一轮没转出东西，不是坏回执。
 * `ownerFlagEnabled` MUST 在场且是布尔：它缺席就等于回显对账这道闸没生效，
 * 而那正好是**静默**失效——一个字都不会说。
 */
function isTextCardTranscribeWireResult(value: unknown): value is TextCardTranscribeWireResult {
  if (!isRecord(value)) return false;
  if (typeof value.ownerFlagEnabled !== 'boolean') return false;
  const outcome = value.outcome;
  return isRecord(outcome) && Array.isArray(outcome.images) && typeof outcome.cacheHit === 'boolean';
}

/* ─────────────────────────── 服务端注册（content 侧） */

/**
 * 转写一条路由。与精选库读写各组**一样各注册各的**：转写起不来不该连带关掉召回或写口。
 */
export function registerTextCardTranscriptionAuthorityRoutes(
  server: InternalHttpServer,
  local: TextCardTranscriber,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    TEXT_CARD_TRANSCRIPTION_AUTHORITY_ROUTES.transcribe,
    callerToken,
    async (args: unknown): Promise<TextCardTranscribeWireResult> => {
      // 信封先解、且在 try 之外：口径同本文件其余各组。
      const input = parseApiDirectEnvelope(args, executionTarget, transcribeInput);
      return runOwnerCall(
        'text-card-transcription.transcribe',
        ownerHasMethod(local, 'transcribe'),
        async () => ({
          outcome: await local.transcribe(input),
          // 属主自己那一侧的旗标取值，原样回显、不做任何解释。
          ownerFlagEnabled: local.enabled(),
        }),
      );
    },
  );
}

/* ─────────────────────────── 客户端（automation 侧） */

/**
 * 转写口的跨进程实现。
 *
 * `enabledLocally` 由组装根注入**同一个**取值闭包（不是这里自己读 env）：读同一份配置这件事
 * 因此在组装根一眼可见，且这个类在测试里不必依赖进程环境。
 */
export class TextCardTranscriptionAuthorityHttpClient implements TextCardTranscriber {
  private readonly channel: ContentAuthorityChannel;
  private flagMismatchWarned = false;

  constructor(
    http: InternalHttpClient,
    callerToken: string,
    executionTarget: DeploymentTarget,
    private readonly enabledLocally: () => boolean,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {
    this.channel = { http, callerToken, executionTarget };
  }

  enabled(): boolean {
    return this.enabledLocally();
  }

  async transcribe(input: TextCardTranscriberInput): Promise<TextCardTranscriberOutcome> {
    const result = await callContentAuthority(
      this.channel,
      TEXT_CARD_TRANSCRIPTION_AUTHORITY_ROUTES.transcribe,
      'text-card-transcription.transcribe',
      input,
      isTextCardTranscribeWireResult,
    );
    this.noteFlagMismatch(result.ownerFlagEnabled);
    return result.outcome;
  }

  /**
   * 旗标对账。只在**有害的那个方向**才会走到这里（另一个方向压根不发起调用，见路由表注释），
   * 所以这条一响就是真事：本进程以为在转写，属主那边一个字也没转。
   * 告警**只响一次**：它是配置态、不是逐条事件，每篇笔记刷一行会把它自己淹掉。
   */
  private noteFlagMismatch(ownerFlagEnabled: boolean): void {
    if (ownerFlagEnabled === this.enabledLocally()) return;
    if (this.flagMismatchWarned) return;
    this.flagMismatchWarned = true;
    this.logger.warn(
      '[text-card-transcription] 旗标两侧不一致：本进程 AIDCP_TEXTCARD_OCR='
        + `${this.enabledLocally()}，content 属主进程=${ownerFlagEnabled}。`
        + '本进程会照常发起转写调用，但属主那侧按自己的旗标原样退回——'
        + '结果是角色报「正在转写」而实际一个字也没转。请让两侧配置一致。',
    );
  }
}

/* ═══════════════════════════════════ 互动回复生成（automation → content） */

/**
 * 回复生成三条方法的传输三件套（task 2.6）。
 *
 * 编排层（automation 的 `ReplyWorkflow`）本来就只持 kernel 的接口，**唯一的跨属主边在组装根**：
 * 它在自动化段里 `new` 了 content 的具体实现。所以这一组不用改编排层一个字。
 *
 * **这条链上最容易在传输层丢掉的东西是 `fallback`**：它带的是「这一步为什么没得到正常答案」
 * （超时 / 上游报错 / JSON 不合法 / 不过 schema / 太长 / 候选被否…）。
 * 丢了它，一次超时的分类会读成一次正常的分类，而 `value` 那半仍然是个合法取值——
 * **失败因此长得和成功一模一样**。所以回执守卫**逐字校验 `fallback` 落在联合类型里**，
 * MUST NOT 只判 `typeof === 'string'`：那样一个乱码回执会被当成一个未知但合法的原因，
 * 更糟的是任何默认值都会把它压成 `'none'`。
 */
const AI_FALLBACK_VALUES: ReadonlySet<string> = new Set<AiFallback>([
  'none',
  'timeout',
  'upstream_error',
  'invalid_json',
  'invalid_schema',
  'too_long',
  'knowledge_answer_missing',
  'candidate_rejected',
]);

export const REPLY_AI_AUTHORITY_ROUTES = {
  classify: 'content-authority/reply-ai/v1/classify',
  polish: 'content-authority/reply-ai/v1/polish',
  review: 'content-authority/reply-ai/v1/review',
} as const satisfies Record<keyof ReplyAiPort, string>;

/**
 * 入参照本文件既有口径**原样透传**：这三个入参是属主自己的提示词装配面，
 * 传输层重做一遍校验就会出现两份口径，而属主那份才是真的（同 `refreshReferenceImages` 的处置）。
 * 这一跳只保证它是个对象——不是对象的话属主会拿到 `undefined` 然后走一条谁也没想过的路。
 */
function replyAiInput<T>(label: string): (value: unknown) => T {
  return (value: unknown): T => requireRecord(value, label) as T;
}

/** `AiStepResult<T>` 的回执守卫。`value` 只判在场（形状归属主），`fallback` **必须**是联合里的一员。 */
function isAiStepResult(value: unknown): value is AiStepResult<unknown> {
  return isRecord(value)
    && 'value' in value
    && typeof value.fallback === 'string'
    && AI_FALLBACK_VALUES.has(value.fallback);
}

/* ─────────────────────────── 服务端注册（content 侧） */

export function registerReplyAiAuthorityRoutes(
  server: InternalHttpServer,
  local: ReplyAiPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  const route = <TIn, TOut>(
    method: keyof ReplyAiPort & string,
    invoke: (input: TIn) => Promise<TOut>,
  ) => async (args: unknown): Promise<TOut> => {
    // 信封先解、且在 try 之外：口径同本文件其余各组。
    const input = parseApiDirectEnvelope(args, executionTarget, replyAiInput<TIn>(`reply-ai.${method}`));
    return runOwnerCall(`reply-ai.${method}`, ownerHasMethod(local, method), () => invoke(input));
  };

  server.registerBearer(
    REPLY_AI_AUTHORITY_ROUTES.classify,
    callerToken,
    route<IntentClassifierInput, AiStepResult<IntentClassifierOutput>>(
      'classify',
      (input) => local.classify(input),
    ),
  );
  server.registerBearer(
    REPLY_AI_AUTHORITY_ROUTES.polish,
    callerToken,
    route<PolisherInput, AiStepResult<PolisherOutput>>('polish', (input) => local.polish(input)),
  );
  server.registerBearer(
    REPLY_AI_AUTHORITY_ROUTES.review,
    callerToken,
    route<RiskReviewerInput, AiStepResult<RiskReviewerOutput>>(
      'review',
      (input) => local.review(input),
    ),
  );
}

/* ─────────────────────────── 客户端（automation 侧） */

export class ReplyAiAuthorityHttpClient implements ReplyAiPort {
  private readonly channel: ContentAuthorityChannel;

  constructor(
    http: InternalHttpClient,
    callerToken: string,
    executionTarget: DeploymentTarget,
  ) {
    this.channel = { http, callerToken, executionTarget };
  }

  classify(input: IntentClassifierInput): Promise<AiStepResult<IntentClassifierOutput>> {
    return callContentAuthority(
      this.channel,
      REPLY_AI_AUTHORITY_ROUTES.classify,
      'reply-ai.classify',
      input,
      isAiStepResult,
    ) as Promise<AiStepResult<IntentClassifierOutput>>;
  }

  polish(input: PolisherInput): Promise<AiStepResult<PolisherOutput>> {
    return callContentAuthority(
      this.channel,
      REPLY_AI_AUTHORITY_ROUTES.polish,
      'reply-ai.polish',
      input,
      isAiStepResult,
    ) as Promise<AiStepResult<PolisherOutput>>;
  }

  review(input: RiskReviewerInput): Promise<AiStepResult<RiskReviewerOutput>> {
    return callContentAuthority(
      this.channel,
      REPLY_AI_AUTHORITY_ROUTES.review,
      'reply-ai.review',
      input,
      isAiStepResult,
    ) as Promise<AiStepResult<RiskReviewerOutput>>;
  }
}

/* ─────────────────────────────────────────────── 接线期欠账（显式登记） */

/**
 * 本轮**只定义契约**。以下几项 MUST 在接线那一轮处理，登记在此以免变成静默遗漏——
 * 它们都不是本文件能自己修的（涉及组装根、调用侧既有代码、跨仓同步名单）。
 */
export const CONTENT_AUTHORITY_WIRING_DEBT = [
  '五处把抛出重新压成空值的降级点 MUST 全改成看着具名 reason 明写的决定：server.ts 的精选库三元、comment-scheduler 的 catch 空数组、role-dispatcher 的装载失败回退空池、publish-scheduler 两处精选库未注入即空',
  'publish-scheduler 的 typeof 能力探针 MUST 换成按 unsupported_method 回落：跨进程后客户端类总是定义着方法，探针恒真、回落分支是死代码',
  '本进程没配置这条端口时 MUST 有响亮取用闸（抛 not_configured），MUST NOT 用 ?. 吞成一个成功的空结果；server.ts 两处「只把 store 当有没有用」要换成显式可用性查询',
  'automation 侧需新增 AIDCP_CONTENT_URL 与 AIDCP_CONTENT_INTERNAL_TOKEN（内部令牌 env 名已在 kernel 的 CONTENT_COMMAND_TOKEN_ENV 定好）——这是 automation 第一次有 content 方向的出边',
  'content 侧注册照 design §2.6：每组独立注册，一组初始化失败不得连带关闭其它组，且实际注册成功的组名要进启动日志',
  '既有 registerCuratedContentRoutes 是更早期的裸形态（无 Bearer、无信封），与本文件两条精选路由同进程并存时 MUST 统一口径，否则同一个域会有两套鉴权与 target 校验',
  '【已消，保留供追溯】CuratedContentUnavailableError 与 FacebookPublishMediaError 的 code 缺口已在同一 change 内补齐（各自的 code 常量 + 编码/还原函数，还原不出返回 null 绝不套默认）。本文件在属主侧包一层译成具名 remote_error 的做法照旧成立，只是不再是唯一出路',
  '本文件 MUST 进控制仓 scripts/sync-split-repos 的 TRANSPORT_MEMBERS：服务端在 content、客户端在 automation，不进名单则 content 仓拿不到注册函数',
] as const;
