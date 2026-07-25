/**
 * 客户端发布审批 / 删配图的**线上载荷形状**在 api 段的本地声明（定稿 §10.9）。
 *
 * 为什么复制而不是 import：`src/comm/protocol.ts` 是边云协议，MUST 归 aidcp-automation 独占、
 * MUST NOT 进 kernel；api 与 content MUST NOT 导入它，**包括仅类型导入**。故这里逐字重抄同一形状。
 * 逐字一致由 test/acceptance/api-contract-drift.test.ts 的双向精确断言钉住（改一侧即 typecheck 红）。
 */

/** 客户端稿件预览内提交审批动作（edge → cloud）。 */
export interface PublishApprovalActionPayload {
  requestId: string;
  approved: boolean;
  /** 客户端所见的稿件版本；云端写审批信号前再次比对，守住“审=发”。 */
  contentVersion?: number;
  /** 批准时可选发布方式；缺省表示旧客户端沿用稿件当前计划。取消动作不得携带。 */
  publishMode?: 'immediate' | 'scheduled';
  /** scheduled=北京时间目标 epoch ms；immediate 必须为 null。 */
  publishTime?: number | null;
}

/** 客户端审批动作结果（cloud → edge）。 */
export interface PublishApprovalActionResultPayload {
  requestId: string;
  ok: boolean;
  state?: 'approved' | 'rejected';
  alreadyDecided?: boolean;
  reason?: string;
  currentVersion?: number;
  /** 授权的下发进度；与 state 是两个轴。 */
  dispatchState?: 'pending_dispatch' | 'dispatching' | 'blocked';
  /** 可读的下发阻塞原因。 */
  dispatchBlockedReason?: string;
}

/** 客户端稿件预览内删除待审稿件的某张配图（edge → cloud）。 */
export interface PublishDraftImageRemovePayload {
  requestId: string;
  /** 客户端所见的稿件版本；云端落库前比对，守住“审=发”。 */
  contentVersion: number;
  /** 待删的那张配图 URL；MUST 是该稿当前 images 的成员（只删不注入）。 */
  imageUrl: string;
}

/** 客户端删配图结果（cloud → edge）。 */
export interface PublishDraftImageRemoveResultPayload {
  requestId: string;
  ok: boolean;
  /** 成功：写后回读的真态配图（保序）。 */
  images?: string[];
  /** 成功：自增后的稿件版本。 */
  contentVersion?: number;
  /** 失败：可区分拒因。 */
  reason?: string;
  /** version_stale 时回带库内活版本。 */
  currentVersion?: number;
}
