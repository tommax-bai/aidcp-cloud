/**
 * automation → content 两条属主端口的传输三件套（路由常量 + 服务端注册 + 类型化客户端），
 * **本轮只定义、不接线**（不改组装根、不改默认注入、不改 `src/server.ts`）。
 *
 * 覆盖的两个端口（都已在 kernel 定义好，本文件一个字都不改它们）：
 *   - {@link file://../kernel/concept-pool-port.ts} 概念池 6 个方法；
 *   - {@link file://../kernel/curated-selection-port.ts} 精选库召回 2 个方法。
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
import {
  CONTENT_PORT_ERROR_CODE_PREFIX,
  ContentPortError,
  contentPortReasonFromCode,
  isContentPortError,
  isContentPortFailureReason,
} from '../kernel/content-port-error.js';
import { API_DIRECT_CONTRACT_VERSION } from '../kernel/api-direct-port.js';
import type { ConceptPool } from '../kernel/concept-pool.js';
import type { ConceptPoolPort, ConceptWithSource } from '../kernel/concept-pool-port.js';
import type {
  CuratedSelectionPort,
  CuratedSelectionWindow,
  CuratedTermSample,
} from '../kernel/curated-selection-port.js';
import type {
  CuratedContentTypeFilter,
  CuratedSelectItem,
} from '../kernel/curated-content-types.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';
import {
  ApiDirectHttpError,
  apiDirectEnvelope,
  isNonNegativeInteger,
  isRecord,
  isVoidAck,
  parseApiDirectEnvelope,
  requireFiniteNumber,
  requireInteger,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

/**
 * 把属主抛出的任何东西译成**线上还认得出来**的失败。
 *
 * 三条分支各有各的必要性：
 *   ① 已是具名 content 端口错误 → **重建**而不是原样抛。`ContentPortErrorShape` 的 `code` 是可选的，
 *      而线格式只透传带 string `code` 的抛出物；原样抛一个没有 `code` 的实现方错误，
 *      reason 会在这一跳被压成 `handler_error`，回落分支再次死掉。
 *   ② reason 超出本进程枚举（对面版本更新）→ 原样带过去，**不收窄成兜底原因**
 *      （kernel 明写：未知取值由调用方原样记录并按不可用处置）。
 *   ③ 其它任何抛出物 → 具名 `remote_error`，原始 code 与消息进 `detail`。属主侧既有哨兵错误
 *      （精选库缺表那个）没有 `code`，正是靠这一条才没在跨进程后退化成一句 `handler_error`。
 */
function ownerFailureAsWireError(error: unknown, operation: string): unknown {
  if (isContentPortError(error)) {
    if (isContentPortFailureReason(error.reason)) {
      return new ContentPortError(error.reason, error.operation ?? operation, error.detail);
    }
    return new InternalHttpError(
      `${CONTENT_PORT_ERROR_CODE_PREFIX}${error.reason}`,
      errorMessage(error),
    );
  }
  const code = errorCode(error);
  const message = errorMessage(error);
  return new ContentPortError(
    'remote_error',
    operation,
    code === null ? message : `${code}: ${message}`,
  );
}

/**
 * 属主侧的方法在场探针。**这个 `typeof` 探针只有放在这一侧才有意义**：它问的是本进程里那个
 * 真实存储对象有没有这个方法。同一个探针写在 automation 侧就恒为真（客户端类总是定义着方法），
 * 那正是本 change 要消掉的死代码。属主缺方法时答具名 `unsupported_method`，
 * 让概念池的回落分支有一个真会发生的触发条件。
 *
 * 另一条更常见的触发路径不经过这里：对面跑的是旧版本、根本没注册这条路由 → 404
 * `route_not_found` → 客户端译成 `unsupported_method`（见 {@link clientFailureAsContentPortError}）。
 */
function ownerHasMethod(port: object, method: string): boolean {
  return typeof (port as Record<string, unknown>)[method] === 'function';
}

async function runOwnerCall<T>(
  operation: string,
  present: boolean,
  invoke: () => Promise<T>,
): Promise<T> {
  if (!present) {
    throw new ContentPortError(
      'unsupported_method',
      operation,
      'owner implementation does not provide this method',
    );
  }
  try {
    return await invoke();
  } catch (error) {
    throw ownerFailureAsWireError(error, operation);
  }
}

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

/**
 * 把这一跳上的任何失败译回具名 {@link ContentPortError}。
 *
 * 顺序有讲究：先用 `contentPortReasonFromCode` 还原属主给的具名原因（`unsupported_method`
 * 唯一能活着过来的路径），还原不出来的再逐条显式判定。**认不出的一律 `remote_error` +
 * 原始 code 进 `detail`，MUST NOT 套一个默认 reason。**
 */
function clientFailureAsContentPortError(error: unknown, operation: string): ContentPortError {
  const code = errorCode(error);
  const message = errorMessage(error);
  const recovered = contentPortReasonFromCode(code);
  if (recovered !== null) return new ContentPortError(recovered, operation, message);

  switch (code) {
    case 'timeout':
      // 连上了但没在预算内答完。**与「对面回答了空」是两回事**，这正是本端口存在的理由之一。
      return new ContentPortError('timeout', operation, message);
    case 'transport_error':
      return new ContentPortError('unreachable', operation, message);
    case 'bad_response':
      return new ContentPortError('malformed_response', operation, message);
    case 'route_not_found':
      // 对面在、令牌也对，就是没有这条路由：版本落后 / 路由没注册。**这是回落分支最现实的触发点。**
      return new ContentPortError('unsupported_method', operation, message);
    case 'internal_http_auth_config_invalid':
      // 本进程的令牌根本没配好，**一个字节都没发出去**——这是「这条端口没配置」的字面情形。
      return new ContentPortError('not_configured', operation, `${code}: ${message}`);
    case 'internal_http_unauthorized':
      // 401 是对面明确拒绝，不是没配。混进 `not_configured` 会让「令牌轮换没同步」
      // 读起来像「这条端口本来就没开」，运维会去查错的地方。
      return new ContentPortError('remote_error', operation, `${code}: ${message}`);
    case 'api_direct_version_unsupported':
      // **刻意不判 `unsupported_method`**：版本不符是整条通道对不上，回落方法与首选方法同属一个
      // 契约版本、照样会失败。判成回落只会让调用方多打一次注定失败的请求，
      // 并把一次通道级配置错误伪装成一次能力缺口。
      return new ContentPortError('remote_error', operation, `${code}: ${message}`);
    default:
      return new ContentPortError(
        'remote_error',
        operation,
        code === null ? message : `${code}: ${message}`,
      );
  }
}

interface ContentAuthorityChannel {
  readonly http: InternalHttpClient;
  readonly callerToken: string;
  readonly executionTarget: DeploymentTarget;
}

async function callContentAuthority<T>(
  channel: ContentAuthorityChannel,
  route: string,
  operation: string,
  input: unknown,
  validate: (value: unknown) => value is T,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await channel.http.callBearer<unknown>(
      route,
      apiDirectEnvelope(channel.executionTarget, input),
      channel.callerToken,
    );
  } catch (error) {
    throw clientFailureAsContentPortError(error, operation);
  }
  // 形状不符 MUST 抛。**MUST NOT 兜底成空数组 / false / 0**——那就是把一次契约漂移
  // （kernel pin 没跟上：编译过、跑起来才错）伪装成一个真实答案。
  if (!validate(raw)) {
    throw new ContentPortError(
      'malformed_response',
      operation,
      `unexpected response shape from ${route}`,
    );
  }
  return raw;
}

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
  'CuratedContentUnavailableError 没有 code（与 FacebookPublishMediaError 同一处判例缺口）：本文件在属主侧包了一层译成具名 remote_error，但若它自身要跨边界被识别，仍需照同一形状补 code',
  '本文件 MUST 进控制仓 scripts/sync-split-repos 的 TRANSPORT_MEMBERS：服务端在 content、客户端在 automation，不进名单则 content 仓拿不到注册函数',
] as const;
