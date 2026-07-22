/**
 * 授权的**唯一写出口**（change publish-approval-signal-to-database）。
 *
 * 五个入口（飞书卡片回调 / 管理后台审批路由 / 客户端内审批 / 委托任务批准拒绝 / 排期免审预授权）
 * 全部收敛到这里，写同一张持久授权记录、用卡铸造时的同一个 `requestId`。
 *
 * 与旧 `writeApprovalSignal` 逐条对应的语义：
 * - 返回形状不变（`{written}` / `{alreadyDecided}`），**MUST NOT 返回 `published`**；
 * - first-writer-wins 不变，但原子性来源从文件系统 `O_EXCL` 换成数据库「活跃行唯一」的部分索引；
 * - 过渡窗口内可 best-effort **影子写**同路径同格式文件（`AIDCP_PUBLISH_APPROVAL_LEGACY_SIGNAL_FILE`，
 *   默认开）。影子写在持久写**之后**、失败只记日志，MUST NOT 影响返回值或抛出，
 *   MUST NOT 成为第二事实源——读侧一律只信持久记录，**绝不存在「读文件回填记录」的逻辑**。
 */

import type { PublishApprovalPayload } from '../feishu/types.js';
import type {
  ApprovalDecidedVia,
  ApprovalWriteOutcome,
  PublishApprovalStore,
} from './publish-approval-store.js';

/** 决策上下文：真实决策人与渠道，MUST NOT 用常量占位。 */
export interface ApprovalDecisionContext {
  decidedBy: string;
  decidedVia: ApprovalDecidedVia;
  /** 目标环境（无环境归属的手动稿可为空）。 */
  envKey?: string | null;
}

export type ApprovalWriteOutlet = (
  requestId: string,
  approved: boolean,
  payload: PublishApprovalPayload,
  context: ApprovalDecisionContext,
) => Promise<ApprovalWriteOutcome>;

/**
 * requestId → 授权主体。`publish-<n>` 是发帖候选（candidateRef = recordId）；
 * 其余（`comment-<noteId>-<ts>`）是评论（candidateRef = 去掉前缀后的整段，仍是不透明关联令牌）。
 */
export function classifyApprovalRequestId(requestId: string): {
  subjectKind: 'publish' | 'comment';
  candidateRef: string;
} {
  const publish = /^publish-(\d+)$/.exec(requestId);
  if (publish) return { subjectKind: 'publish', candidateRef: publish[1] };
  return { subjectKind: 'comment', candidateRef: requestId.replace(/^comment-/, '') };
}

export interface LegacySignalShadowWriter {
  /** 是否启用（env `AIDCP_PUBLISH_APPROVAL_LEGACY_SIGNAL_FILE`，默认 true）。 */
  enabled: boolean;
  write(requestId: string, approved: boolean, payload: PublishApprovalPayload, ts: number): Promise<void>;
}

export interface ApprovalWriteOutletDeps {
  store: Pick<PublishApprovalStore, 'record'>;
  /** 兼容窗口的影子写；缺省 = 不影子写。 */
  legacySignal?: LegacySignalShadowWriter;
  /**
   * `envKey` 补齐（spec 的 MUST 字段）。五个入口手边都只有候选 / 账号、没有环境键，若指望各入口自己传，
   * 结果就是全表恒 NULL（本 change 首版即如此，告警连是哪个号都说不出）。故收口到这一处解析：
   * 调用方显式给了就用调用方的，没给才解析。解析不出 MUST 留 null 并记日志，绝不猜一个环境写进审计记录。
   */
  resolveEnvKey?: (subject: {
    requestId: string;
    subjectKind: 'publish' | 'comment';
    candidateRef: string;
  }) => Promise<string | null>;
  logger?: Pick<Console, 'warn'>;
  clock?: () => number;
}

export function createApprovalWriteOutlet(deps: ApprovalWriteOutletDeps): ApprovalWriteOutlet {
  const clock = deps.clock ?? Date.now;
  const logger = deps.logger ?? console;
  return async (requestId, approved, payload, context) => {
    const { subjectKind, candidateRef } = classifyApprovalRequestId(requestId);
    const decidedAt = clock();
    let envKey = context.envKey ?? null;
    if (envKey === null && deps.resolveEnvKey) {
      try {
        envKey = (await deps.resolveEnvKey({ requestId, subjectKind, candidateRef })) ?? null;
      } catch (err) {
        // 解析失败绝不阻断授权（授权本身与环境键无关），但必须留痕——恒 NULL 的 env_key 是审计盲区。
        logger.warn(
          `[approval-outlet] envKey 解析失败（本条授权 env_key 留空）requestId=${requestId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // 持久记录先写、且是唯一权威。它失败即授权失败（诚实抛出），绝不退化成「只写了文件」。
    const outcome = await deps.store.record({
      requestId,
      subjectKind,
      candidateRef,
      contentVersion: Number.isFinite(payload.contentVersion) ? Number(payload.contentVersion) : 0,
      approved,
      decidedBy: context.decidedBy,
      decidedVia: context.decidedVia,
      envKey,
      frozenPayload: {
        title: payload.title,
        content: payload.content,
        tags: payload.tags,
        contentVersion: payload.contentVersion ?? 0,
      },
      decidedAt,
    });
    // 影子写只在**本次首写成功**时做（后到者不覆盖，与旧 O_EXCL 行为一致）。
    if (outcome.written && deps.legacySignal?.enabled) {
      try {
        await deps.legacySignal.write(requestId, approved, payload, decidedAt);
      } catch (err) {
        logger.warn(
          `[approval-outlet] 影子信号文件写入失败（授权已成立、不受影响）requestId=${requestId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return outcome;
  };
}
