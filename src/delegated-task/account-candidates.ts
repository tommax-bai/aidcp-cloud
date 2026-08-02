/**
 * 委托任务的账号候选清单：把 api 属主的**账号目录**一行一行翻成服务要的候选。
 *
 * ## 为什么这段要单独成文件、而不是写在组装根里
 *
 * 它有**两个**调用点：单体组装根，以及自动化进程自己的 `main()`。两处各写一遍就是「同一份判断
 * 有两份实现」——那种重复在写下的那一刻行为完全一致，要等某天只改了其中一份、且恰好在
 * 「按昵称选号」真被用到的那一刻才现形。所以这里只有一份，两处都取它。
 *
 * ## 口径
 *
 * - **暂停的账号照样列出**。委托服务自己按 `status` 判断能不能派活；在这里过滤掉，会让运营
 *   给一个暂停号下指令时收到「找不到昵称」——把「这个号停着」说成「没有这个号」，方向是错的。
 * - **一次全量、不逐账号问**。账号主数据是小而全量的（真机几十行），全量快照比逐条问答简单，
 *   也不需要在跨进程那一跳上设计分页与游标。
 * - **本函数不兜任何底**：属主读失败就让它抛。回一个空数组会让「这次没读到」与「一个账号都没有」
 *   同形，而后者会让委托解析如实回「无可用昵称」——一句听着合理、其实是编造的答复。
 */
import type { AccountDirectoryRow } from '../kernel/account-projection-types.js';
import type { DelegatedAccountCandidate } from './service.js';

/** 账号目录的只读取用面。刻意只要这一个方法：多要一个方法就多一处能漂的接线。 */
export interface DelegatedAccountDirectoryReader {
  listAccountDirectory(): Promise<readonly AccountDirectoryRow[]>;
}

/** 目录行 → 候选。字段是一一对应的，这里不做任何回落与推断。 */
export function delegatedAccountCandidateFromDirectoryRow(
  row: AccountDirectoryRow,
): DelegatedAccountCandidate {
  return {
    accountId: row.accountId,
    displayName: row.displayName,
    // 服务侧的候选面是可变数组；这里复制一份，MUST NOT 把属主返回的只读数组强转过去。
    names: [...row.names],
    platform: row.platform,
    status: row.status,
  };
}

/** 委托服务的 `listAccounts` 依赖：整张目录取回后逐行翻译。 */
export async function listDelegatedAccountCandidates(
  directory: DelegatedAccountDirectoryReader,
): Promise<DelegatedAccountCandidate[]> {
  const rows = await directory.listAccountDirectory();
  return rows.map(delegatedAccountCandidateFromDirectoryRow);
}
