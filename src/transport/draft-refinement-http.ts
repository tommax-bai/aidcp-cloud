/**
 * 稿件精修（draft refinement）的跨进程搬运 —— **一个文件、两个方向**。
 *
 * 客户端里的「稿件精修」是一条横跨两个域的链路，拆进程后**两个方向都断了**，不是一条通道：
 *
 *   方向 A（api → content）：作业队列 {@link DraftRefinementReadWritePort} 四个方法。
 *     队列表 `publish_draft_refinement_jobs` 属 content，而唯一的创建 / 查询入口在 api 的
 *     客户端鉴权服务里。→ {@link DRAFT_REFINEMENT_QUEUE_ROUTES}（content 注册、api 调）。
 *
 *   方向 B（content → api）：精修 worker 的落稿写口 `refineDraft`。
 *     worker 跑在 content（模型 / 出图 / 转存都在那边），但 `publish_log` 属 api。
 *     → {@link DRAFT_REFINEMENT_DRAFTS_ROUTES}（api 注册、content 调）。
 *
 * `DraftRefinementDrafts` 的另一半 `loadForDispatch` **刻意不在本文件里再开一条路由**：
 * 那条路由 `api-direct/publish-log/v1/load-for-dispatch` 已经存在、已经在服务，
 * 复用它比再挂一条同语义的路由更安全（两条同义路由只会各自演化）。content 的组装根
 * 把两个客户端拼成一个 `DraftRefinementDrafts` 交给 worker，端口的完整性由**那处对象字面量**
 * 在编译期钉住；本文件的路由表用 `Exclude<…, 'loadForDispatch'>` 显式声明这个分工，
 * 于是端口日后加方法时，这张表照样会当场编译失败。
 *
 * ## 三件套同文件是硬要求（CLAUDE §8.4）
 * 路由常量 + 服务端注册 + 类型化客户端只有一份。拆成「属主仓写服务端、消费方仓写客户端」
 * 两份，两侧各自编译通过、各自测试通过，**只有真跑起来才 404**。
 *
 * ## 两处跨进程保真，都不是锦上添花
 *
 * **① `latestForAccountRecords` 返回 `Map`，而 `Map` 过不了 JSON。**
 * `JSON.stringify(new Map([[1, x]]))` 是 `{}` —— 不报错、不告警，对面拿到一个空对象。
 * 本族因此在线上以 `[key, value][]` 传，两侧各做一次显式转换。它喂的是待审稿列表上
 * 每条稿子的「上次精修状态」，丢了不会有人报障，只会让人以为这功能从没被用过。
 *
 * **② 唯一活跃作业冲突码 `23505` MUST 原样过线。**
 * 队列表上有一条 `WHERE status IN ('queued','running')` 的唯一偏索引，
 * 同一条稿子只允许有一个进行中的精修。api 的客户端鉴权服务**只认 PostgreSQL 的
 * `23505`** 来答 409 `refinement_already_active`。这条码能活下来靠两级具体行为：
 * 传输骨架 `encodeHandlerError` 透传带 string `code` 的抛出物，
 * `translateWriteFailure` 对不认识的 code 原样重抛。两者任一改动都会把
 * 「已经有一个在跑」压成 500，用户读到的是「服务器错误」而不是「已经在调整了」。
 * 这条性质由 `test/transport/draft-refinement-http.test.ts` 钉住。
 *
 * ## 失败语义
 * 照 4a 已建立的形态（`api-direct-http-common.ts`）：版本 + `executionTarget` 双校验、
 * `registerBearer` 内部令牌，**target 由客户端从本进程部署事实注入**，调用方没有入口能选它。
 * 读口失败原样抛（MUST NOT 退化成 null / 空 Map —— 那会把「读不到」读成「没精修过」）；
 * 写口 `refineDraft` 的「结果未知」走具名 `api_authority_result_unknown`，
 * 理由与调用方的处置见该方法上的注释。
 *
 * 零属主表 SQL、零业务判定，满足 `aidcp-transport` 准入。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import { API_DIRECT_CONTRACT_VERSION } from '../kernel/api-direct-port.js';
import type {
  DraftRefinementDrafts,
  DraftRefinementJob,
  DraftRefinementProgress,
  DraftRefinementReadWritePort,
  DraftRefinementScope,
  DraftRefinementSelection,
  DraftRefinementStage,
  DraftRefinementStatus,
  RefineDraftPatch,
  RefineDraftResult,
  RefineDraftSelection,
} from '../kernel/publish-draft-contract.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import { isEditDraftResult } from './api-publish-interaction-http.js';
import {
  ApiDirectHttpError,
  callApiDirectRead,
  callApiDirectWrite,
  isNonNegativeInteger,
  isRecord,
  parseApiDirectEnvelope,
  requireInteger,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';

/** 共用 4a 的契约版本号：同一个 `parseApiDirectEnvelope` 在校验这两族的信封。 */
export const DRAFT_REFINEMENT_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

/* ───────────────────────────────────────────────────────── 路由表 */

/** 方向 A：作业队列。**content 注册、api 调**。 */
export const DRAFT_REFINEMENT_QUEUE_ROUTES = {
  create: 'content-authority/draft-refinement/v1/create',
  getForAccount: 'content-authority/draft-refinement/v1/get-for-account',
  latestForAccountRecord:
    'content-authority/draft-refinement/v1/latest-for-account-record',
  latestForAccountRecords:
    'content-authority/draft-refinement/v1/latest-for-account-records',
} as const satisfies Record<keyof DraftRefinementReadWritePort, string>;

/**
 * 方向 B：worker 的落稿写口。**api 注册、content 调**。
 *
 * `loadForDispatch` 由既有的 `AUTOMATION_PUBLISH_LOG_ROUTES.loadForDispatch` 承担，
 * 故按端口方法名逐条排除（不是「漏了一条」）。端口加第三个方法时这里当场编译失败。
 */
export const DRAFT_REFINEMENT_DRAFTS_ROUTES = {
  refineDraft: 'api-direct/draft-refinement/v1/refine-draft',
} as const satisfies Record<
  Exclude<keyof DraftRefinementDrafts, 'loadForDispatch'>,
  string
>;

/* ───────────────────────────────────────────────────── 入参解析 */

const SCOPES: readonly DraftRefinementScope[] = [
  'whole',
  'body',
  'images',
  'selected_image',
  'selected_text',
];

function requireScope(value: unknown): DraftRefinementScope {
  const scope = requireString(value, 'scope');
  if (!SCOPES.includes(scope as DraftRefinementScope)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `scope must be one of ${SCOPES.join('|')}`,
    );
  }
  return scope as DraftRefinementScope;
}

/**
 * 选区：三态闭集合。**认不出的形状 MUST 抛而不是落 null** ——
 * null 在下游的语义是「整体范围、没有选区」，把一个畸形选区悄悄读成它，
 * 等于把「只改这一段」放大成「整篇随便改」。
 */
function requireSelection(value: unknown, label: string): DraftRefinementSelection {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${label} must be an object or null`,
    );
  }
  if (typeof value.imageUrl === 'string' && value.imageUrl.length > 0) {
    return { imageUrl: value.imageUrl };
  }
  if (
    Number.isInteger(value.start)
    && Number.isInteger(value.end)
    && typeof value.text === 'string'
  ) {
    return {
      start: Number(value.start),
      end: Number(value.end),
      text: value.text,
    };
  }
  throw new ApiDirectHttpError(
    'api_direct_invalid_request',
    `${label} must be {imageUrl} | {start,end,text} | null`,
  );
}

function createInput(value: unknown): Parameters<DraftRefinementReadWritePort['create']>[0] {
  const input = requireRecord(value);
  return {
    accountId: requireString(input.accountId, 'accountId'),
    recordId: requireInteger(input.recordId, 'recordId', 1),
    expectedVersion: requireInteger(input.expectedVersion, 'expectedVersion', 0),
    scope: requireScope(input.scope),
    instruction: requireString(input.instruction, 'instruction'),
    selection: requireSelection(input.selection, 'selection'),
  };
}

function accountRecordJobInput(value: unknown): {
  accountId: string;
  recordId: number;
  jobId: string;
} {
  const input = requireRecord(value);
  return {
    accountId: requireString(input.accountId, 'accountId'),
    recordId: requireInteger(input.recordId, 'recordId', 1),
    jobId: requireString(input.jobId, 'jobId'),
  };
}

function accountRecordInput(value: unknown): { accountId: string; recordId: number } {
  const input = requireRecord(value);
  return {
    accountId: requireString(input.accountId, 'accountId'),
    recordId: requireInteger(input.recordId, 'recordId', 1),
  };
}

function accountRecordsInput(value: unknown): { accountId: string; recordIds: number[] } {
  const input = requireRecord(value);
  if (!Array.isArray(input.recordIds)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'recordIds must be an array');
  }
  return {
    accountId: requireString(input.accountId, 'accountId'),
    recordIds: input.recordIds.map((item, index) =>
      requireInteger(item, `recordIds[${index}]`, 1)),
  };
}

function refineDraftInput(value: unknown): {
  recordId: number;
  accountId: string;
  expectedVersion: number;
  scope: DraftRefinementScope;
  selection: RefineDraftSelection;
  patch: RefineDraftPatch;
  editor: string;
} {
  const input = requireRecord(value);
  const patchRecord = requireRecord(input.patch, 'patch');
  for (const field of ['title', 'content'] as const) {
    if (patchRecord[field] !== undefined && typeof patchRecord[field] !== 'string') {
      throw new ApiDirectHttpError(
        'api_direct_invalid_request',
        `patch.${field} must be a string`,
      );
    }
  }
  for (const field of ['topics', 'images'] as const) {
    const item = patchRecord[field];
    if (
      item !== undefined
      && (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string'))
    ) {
      throw new ApiDirectHttpError(
        'api_direct_invalid_request',
        `patch.${field} must be a string array`,
      );
    }
  }
  // 补丁按「有就带、没有就不带键」重建：`{content: undefined}` 与「没有 content 键」
  // 在属主侧的 scope 校验里是两件事（前者会被 Object.keys 数进去），而 JSON 会把
  // undefined 的键整个吃掉 —— 两侧口径必须一致，故此处显式重建。
  const patch: RefineDraftPatch = {};
  if (typeof patchRecord.title === 'string') patch.title = patchRecord.title;
  if (typeof patchRecord.content === 'string') patch.content = patchRecord.content;
  if (Array.isArray(patchRecord.topics)) patch.topics = patchRecord.topics as string[];
  if (Array.isArray(patchRecord.images)) patch.images = patchRecord.images as string[];
  return {
    recordId: requireInteger(input.recordId, 'recordId', 1),
    accountId: requireString(input.accountId, 'accountId'),
    expectedVersion: requireInteger(input.expectedVersion, 'expectedVersion', 0),
    scope: requireScope(input.scope),
    selection: requireSelection(input.selection, 'selection'),
    patch,
    editor: requireString(input.editor, 'editor'),
  };
}

/* ─────────────────────────────────────────────────── 出参校验 */

const STAGES: readonly DraftRefinementStage[] = ['计划', '判断', '生成', '检查', '确认'];
const STATUSES: readonly DraftRefinementStatus[] = ['queued', 'running', 'completed', 'failed'];

function isProgress(value: unknown): value is DraftRefinementProgress {
  return (
    isRecord(value)
    && isNonNegativeInteger(value.seq)
    && STAGES.includes(value.stage as DraftRefinementStage)
    && (value.status === 'running' || value.status === 'completed')
    && typeof value.summary === 'string'
    && typeof value.at === 'number'
    && Number.isFinite(value.at)
  );
}

function isSelection(value: unknown): value is DraftRefinementSelection {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (typeof value.imageUrl === 'string') return true;
  return (
    Number.isInteger(value.start)
    && Number.isInteger(value.end)
    && typeof value.text === 'string'
  );
}

/**
 * 作业形状的结构校验。**每一格都判**：这份对象是客户端进度条与失败文案的唯一来源，
 * 判宽了的表现不是报错，是进度条卡在某一格 / 失败原因显示成空白。
 */
function isDraftRefinementJob(value: unknown): value is DraftRefinementJob {
  return (
    isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0
    && (value.executionTarget === 'dev' || value.executionTarget === 'ol')
    && typeof value.accountId === 'string' && value.accountId.length > 0
    && isNonNegativeInteger(value.recordId)
    && isNonNegativeInteger(value.expectedVersion)
    && SCOPES.includes(value.scope as DraftRefinementScope)
    && typeof value.instruction === 'string'
    && isSelection(value.selection)
    && STATUSES.includes(value.status as DraftRefinementStatus)
    && Array.isArray(value.progress) && value.progress.every(isProgress)
    && (value.claimToken === null || typeof value.claimToken === 'string')
    && (value.resultVersion === null || isNonNegativeInteger(value.resultVersion))
    && (value.errorCode === null || typeof value.errorCode === 'string')
    && (value.errorMessage === null || typeof value.errorMessage === 'string')
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
    && (value.completedAt === null || typeof value.completedAt === 'number')
  );
}

function isNullableJob(value: unknown): value is DraftRefinementJob | null {
  return value === null || isDraftRefinementJob(value);
}

/** 线格式的 Map：`[recordId, job][]`。见文件头「两处跨进程保真 ①」。 */
type JobEntries = [number, DraftRefinementJob][];

function isJobEntries(value: unknown): value is JobEntries {
  return (
    Array.isArray(value)
    && value.every((entry) =>
      Array.isArray(entry)
      && entry.length === 2
      && isNonNegativeInteger(entry[0])
      && isDraftRefinementJob(entry[1]))
  );
}

/** `RefineDraftResult` 是 `EditDraftResult` 的超集（多两个 reason，成功分支逐字相同）。 */
function isRefineDraftResult(value: unknown): value is RefineDraftResult {
  return isEditDraftResult(value);
}

/* ─────────────────────────────────── 方向 A：队列（content 注册） */

/**
 * 把一个本地精修队列的四个方法注册为内部 HTTP route（跑在 content 进程里）。
 * 只做参数解包 → 转调本地端口 → 原样回传；不含任何业务判定。
 */
export function registerDraftRefinementQueueRoutes(
  server: InternalHttpServer,
  local: DraftRefinementReadWritePort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    DRAFT_REFINEMENT_QUEUE_ROUTES.create,
    callerToken,
    // 唯一偏索引冲突（`23505`）在这里**刻意不接管**：属主抛什么就出网什么，
    // 传输骨架会把带 string `code` 的抛出物原样编码。见文件头「② 唯一活跃作业冲突码」。
    (args) => local.create(parseApiDirectEnvelope(args, executionTarget, createInput)),
  );
  server.registerBearer(
    DRAFT_REFINEMENT_QUEUE_ROUTES.getForAccount,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountRecordJobInput);
      return local.getForAccount(input.accountId, input.recordId, input.jobId);
    },
  );
  server.registerBearer(
    DRAFT_REFINEMENT_QUEUE_ROUTES.latestForAccountRecord,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountRecordInput);
      return local.latestForAccountRecord(input.accountId, input.recordId);
    },
  );
  server.registerBearer(
    DRAFT_REFINEMENT_QUEUE_ROUTES.latestForAccountRecords,
    callerToken,
    async (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountRecordsInput);
      const map = await local.latestForAccountRecords(input.accountId, input.recordIds);
      // Map → entries。**MUST NOT 直接回 map**：JSON 化后是 `{}`，对面拿到的是「一条都没有」。
      return [...map.entries()] satisfies JobEntries;
    },
  );
}

/** 队列端口的 HTTP 实现：满足同一个 kernel 接口，跑在 api 进程里。 */
export class DraftRefinementQueueHttpClient implements DraftRefinementReadWritePort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  /**
   * 建一条精修作业。
   *
   * **失败码原样上抛，调用方按 `23505` 判「已经有一个在跑」**（见文件头 ②）：
   * `callApiDirectWrite` 对不认识的 code 原样重抛，这里 MUST NOT 再包一层。
   */
  create(
    input: Parameters<DraftRefinementReadWritePort['create']>[0],
  ): Promise<DraftRefinementJob> {
    return callApiDirectWrite<DraftRefinementJob>(
      this.http,
      DRAFT_REFINEMENT_QUEUE_ROUTES.create,
      this.callerToken,
      this.executionTarget,
      input,
      isDraftRefinementJob,
    );
  }

  getForAccount(
    accountId: string,
    recordId: number,
    jobId: string,
  ): Promise<DraftRefinementJob | null> {
    return callApiDirectRead<DraftRefinementJob | null>(
      this.http,
      DRAFT_REFINEMENT_QUEUE_ROUTES.getForAccount,
      this.callerToken,
      this.executionTarget,
      { accountId, recordId, jobId },
      isNullableJob,
    );
  }

  latestForAccountRecord(
    accountId: string,
    recordId: number,
  ): Promise<DraftRefinementJob | null> {
    return callApiDirectRead<DraftRefinementJob | null>(
      this.http,
      DRAFT_REFINEMENT_QUEUE_ROUTES.latestForAccountRecord,
      this.callerToken,
      this.executionTarget,
      { accountId, recordId },
      isNullableJob,
    );
  }

  /**
   * 待审稿列表上每条稿子的「上次精修状态」。
   *
   * 读不到 MUST 抛（`callApiDirectRead` 的既有行为），**MUST NOT 回一个空 Map**：
   * 空 Map 与「这些稿子都没被精修过」完全同形，而后者是列表页的正常态 ——
   * 这条降级不会有人报障，只会让人以为这功能从没被用过。
   */
  async latestForAccountRecords(
    accountId: string,
    recordIds: number[],
  ): Promise<Map<number, DraftRefinementJob>> {
    const entries = await callApiDirectRead<JobEntries>(
      this.http,
      DRAFT_REFINEMENT_QUEUE_ROUTES.latestForAccountRecords,
      this.callerToken,
      this.executionTarget,
      { accountId, recordIds },
      isJobEntries,
    );
    return new Map(entries);
  }
}

/* ────────────────────────────── 方向 B：落稿写口（api 注册） */

/** worker 落稿写口在 api 侧的属主面。 */
export type DraftRefinementDraftsWriter = Pick<DraftRefinementDrafts, 'refineDraft'>;

export function registerDraftRefinementDraftsRoutes(
  server: InternalHttpServer,
  local: DraftRefinementDraftsWriter,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    DRAFT_REFINEMENT_DRAFTS_ROUTES.refineDraft,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, refineDraftInput);
      return local.refineDraft(
        input.recordId,
        input.accountId,
        input.expectedVersion,
        input.scope,
        input.selection,
        input.patch,
        input.editor,
      );
    },
  );
}

/** 落稿写口的 HTTP 实现，跑在 content 进程里（worker 那一侧）。 */
export class DraftRefinementDraftsHttpClient implements DraftRefinementDraftsWriter {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  /**
   * 精修的最终落稿。**这是本条链路上唯一一次真正改用户稿件的写**。
   *
   * 拆进程之后这里多出一种单体没有的结局：**写已经提交、而应答在回程丢了**
   * （超时 / 连接断 / 响应畸形）。`callApiDirectWrite` 把这一类归到具名的
   * `api_authority_result_unknown`，**MUST NOT 让它落进「原稿未变化」那句话** ——
   * 调用方（精修 worker）按这个 code 单独出一条「已提交但没能确认」的回执。
   *
   * 重投是安全的、但不该由这一层偷偷做：写口是 `expectedVersion` 的 CAS，
   * 若上一次真的落了，版本号已经变了，重投只会拿到 `version_conflict`。
   * 也就是说这里**不会重复改稿**，要治的只是「回执说了假话」。
   */
  refineDraft(
    recordId: number,
    accountId: string,
    expectedVersion: number,
    scope: DraftRefinementScope,
    selection: RefineDraftSelection,
    patch: RefineDraftPatch,
    editor: string,
  ): Promise<RefineDraftResult> {
    return callApiDirectWrite<RefineDraftResult>(
      this.http,
      DRAFT_REFINEMENT_DRAFTS_ROUTES.refineDraft,
      this.callerToken,
      this.executionTarget,
      { recordId, accountId, expectedVersion, scope, selection, patch, editor },
      isRefineDraftResult,
    );
  }
}
