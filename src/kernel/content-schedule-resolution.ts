/**
 * 内容排期「快照 + 账号 → 生效值」的**纯判定段**（kernel）。
 *
 * 从 src/config/content-schedule-store.ts（api 属主）析出：存储残壳继续持库、持缓存、写 SQL，
 * 但「账号覆盖 ?? 全局回落」这段判断在此**只此一份**。理由是拆仓后两个进程都要问同一个问题——
 * api 进程按自己的内存镜像问、automation 进程按同步读快照问；各写一份的现形方式不是报错，
 * 而是某一侧对同一个账号算出不同的生效时段，而两侧各自的测试都会绿。
 *
 * 零 import 副作用、无 SQL、无活状态：只从 kernel 取动作模式与掩码判据。
 * MUST NOT 在别处另写一份等价解析（`test/acceptance/module-boundary.test.ts` 有结构断言钉着）。
 */
import {
  actionModeEnabled,
  type ContentScheduleActionMode,
} from './content-schedule-mode.js';
import { isValidWeekActiveMask } from './week-active-mask.js';

/** 调度器每 tick 现读的生效排期（effectiveMask 已解析：override ?? global）。 */
export interface EffectiveContentSchedule {
  autoEnabled: boolean;
  postEnabled: boolean;
  postMode: ContentScheduleActionMode;
  postDailyCap: number;
  commentEnabled: boolean;
  commentMode: ContentScheduleActionMode;
  commentDailyCap: number;
  contactCommentEnabled: boolean;
  contactCommentMode: ContentScheduleActionMode;
  contactCommentDailyCap: number;
  /** 账号生效活跃掩码；null = 全周全天活跃。 */
  effectiveActiveWeekMask: string | null;
  /** 账号生效内容掩码；旧名保留以避免调度协议面漂移。 */
  effectiveMask: string | null;
}

/**
 * 解析所需的**账号侧事实**。刻意不含 `postEnabled` 一族：它们恒等于 `actionModeEnabled(对应 mode)`
 * （存储的两条构造路径都这么算），带进来等于给同一个事实留两个可能漂开的来源。
 */
export interface ContentScheduleAccountFacts {
  readonly autoEnabled: boolean;
  readonly postMode: ContentScheduleActionMode;
  readonly postDailyCap: number;
  readonly commentMode: ContentScheduleActionMode;
  readonly commentDailyCap: number;
  readonly contactCommentMode: ContentScheduleActionMode;
  readonly contactCommentDailyCap: number;
  readonly activeWeekMask: string | null;
  readonly contentActiveMask: string | null;
}

/**
 * 解析所需的**全局侧事实**。两个掩码来源不同：内容掩码来自排期全局行（api 属主），
 * 活跃掩码来自会话配置（automation 属主）——所以这里只收值、不收取值口，
 * 由各进程按自己拿得到的来源填。
 */
export interface ContentScheduleGlobalFacts {
  readonly activeWeekMask: string | null;
  readonly contentActiveMask: string | null;
}

/**
 * 活跃周历：账号覆盖**合法**才优先；脏覆盖视作缺失并回落全局，
 * 绝不因坏值绕过更严格的全局闸。全局同样只有合法才作数。
 */
export function resolveEffectiveActiveWeekMask(
  accountMask: string | null | undefined,
  globalMask: string | null | undefined,
): string | null {
  if (isValidWeekActiveMask(accountMask)) return accountMask;
  return isValidWeekActiveMask(globalMask) ? globalMask : null;
}

/**
 * 内容周历：按 null 继承全局；**脏非空值原样交调度器 fail-closed 校验**——
 * 这里不校验是有意的，与活跃掩码那条不同口径，别顺手「统一」掉。
 */
export function resolveEffectiveContentActiveMask(
  accountMask: string | null | undefined,
  globalMask: string | null | undefined,
): string | null {
  return accountMask ?? globalMask ?? null;
}

/** 无账号行 → 完全不自动（零回归），但两条掩码照旧按全局解析。 */
export function resolveEffectiveContentSchedule(
  account: ContentScheduleAccountFacts | null | undefined,
  global: ContentScheduleGlobalFacts,
): EffectiveContentSchedule {
  const effectiveActiveWeekMask = resolveEffectiveActiveWeekMask(
    account?.activeWeekMask,
    global.activeWeekMask,
  );
  const effectiveMask = resolveEffectiveContentActiveMask(
    account?.contentActiveMask,
    global.contentActiveMask,
  );
  if (!account) {
    return {
      autoEnabled: false,
      postEnabled: false,
      postMode: 'off',
      postDailyCap: 0,
      commentEnabled: false,
      commentMode: 'off',
      commentDailyCap: 0,
      contactCommentEnabled: false,
      contactCommentMode: 'off',
      contactCommentDailyCap: 0,
      effectiveActiveWeekMask,
      effectiveMask,
    };
  }
  return {
    autoEnabled: account.autoEnabled,
    postEnabled: actionModeEnabled(account.postMode),
    postMode: account.postMode,
    postDailyCap: account.postDailyCap,
    commentEnabled: actionModeEnabled(account.commentMode),
    commentMode: account.commentMode,
    commentDailyCap: account.commentDailyCap,
    contactCommentEnabled: actionModeEnabled(account.contactCommentMode),
    contactCommentMode: account.contactCommentMode,
    contactCommentDailyCap: account.contactCommentDailyCap,
    effectiveActiveWeekMask,
    effectiveMask,
  };
}
