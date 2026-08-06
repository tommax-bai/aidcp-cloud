/**
 * AC-CONTRACT-DRIFT —— api 段本地重抄的协议载荷 MUST 与 `src/comm/protocol.ts` 逐字同形。
 *
 * 背景（定稿 §10.9）：`protocol.ts` 归 aidcp-automation 独占、MUST NOT 进 kernel；api 与 content
 * MUST NOT 导入它（**包括仅类型导入**）。于是 api 段在 `src/api-contracts/` 重新声明同一形状。
 * 重抄本身是一处**静默漂移入口**：协议加一个字段，两侧各自编译全绿、线上悄悄分家。
 *
 * ⚠️ 判据 MUST 用下面的 `Equals`（函数签名同构法），**MUST NOT 用「双向可赋值 + 双向 keyof 包含」**：
 *   那种写法把 `never` 当中间结果往下传，而 `never extends true` 恒真 —— 一旦某侧判定失败得到 `never`，
 *   外层条件反而回落成 `true`，闸门静默失效。实测：给 protocol 侧加必填字段 / 加可选字段，那种写法
 *   全绿放行（只有联集成员增删因为没套外层条件才被抓到）。这正是本闸要防的「静默假成功」。
 *
 * ⚠️ 这道闸的牙齿在 **`npm run typecheck`**，不在 `npm test`：
 *   `npm test` 用 tsx（esbuild）执行，只剥类型不做检查，本文件的断言在运行期恒真。
 *   tsconfig.json 的 include 覆盖 `test/**\/*.ts`，故 `tsc --noEmit` 会检查本文件。
 *   验收方式：给 protocol.ts 某形状加一个字段 → `npm run typecheck` MUST 变红并点名本文件。
 *
 * test/ 不在 boundaries 的归属清单内（boundary-scan 只扫 src/），故本文件同时导入两侧不产生跨边界 import 边。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Wire from '@automation/comm/protocol.js';
import type * as PublishContract from '@api/api-contracts/publish-approval-wire.js';
import type * as UsageContract from '@api/api-contracts/ui-usage-wire.js';
import type * as NotificationContract from '@api/api-contracts/notification-wire.js';
import type * as CaptchaPort from '@api/panel/captcha-assist-port.js';

/**
 * 精确同形判据：必填/可选、多字段/少字段、联集成员增删、字面量取值变化，全部会把结果翻成 `false`。
 * 不产生 `never` 中间态，故不会被 `never extends …` 恒真吃掉。
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/* ---------------------------------------------------------------- 发布审批 / 删配图 */
export const _publishApprovalAction: Equals<
  Wire.PublishApprovalActionPayload,
  PublishContract.PublishApprovalActionPayload
> = true;
export const _publishApprovalActionResult: Equals<
  Wire.PublishApprovalActionResultPayload,
  PublishContract.PublishApprovalActionResultPayload
> = true;
export const _publishDraftImageRemove: Equals<
  Wire.PublishDraftImageRemovePayload,
  PublishContract.PublishDraftImageRemovePayload
> = true;
export const _publishDraftImageRemoveResult: Equals<
  Wire.PublishDraftImageRemoveResultPayload,
  PublishContract.PublishDraftImageRemoveResultPayload
> = true;

/* ---------------------------------------------------------------- 日用量 / 慢启动 */
export const _uiDailyUsage: Equals<Wire.UiDailyUsagePayload, UsageContract.UiDailyUsagePayload> = true;
export const _uiSlowStart: Equals<Wire.UiSlowStartPayload, UsageContract.UiSlowStartPayload> = true;
export const _uiDailyUsageWindowStatus: Equals<
  Wire.UiDailyUsageWindowStatus,
  UsageContract.UiDailyUsageWindowStatus
> = true;
export const _uiDailyUsageInspiration: Equals<
  Wire.UiDailyUsageInspirationSummary,
  UsageContract.UiDailyUsageInspirationSummary
> = true;
export const _uiDailyUsageAction: Equals<Wire.UiDailyUsageAction, UsageContract.UiDailyUsageAction> = true;
export const _uiDailyUsageWindow: Equals<Wire.UiDailyUsageWindow, UsageContract.UiDailyUsageWindow> = true;
export const _uiDailyUsageCounts: Equals<Wire.UiDailyUsageCounts, UsageContract.UiDailyUsageCounts> = true;

/* ---------------------------------------------------------------- 通知项 */
export const _notificationItem: Equals<Wire.NotificationItem, NotificationContract.NotificationItem> = true;

/* ---------------------------------------------------------------- 验证码协助（api 侧窄端口 src/panel/captcha-assist-port.ts 重抄的 10 个协议形状） */
export const _captchaOverlayDomFeature: Equals<
  Wire.BlockingOverlayDomFeaturePayload,
  CaptchaPort.CaptchaAssistOverlayDomFeature
> = true;
export const _captchaOverlaySnapshot: Equals<
  Wire.BlockingOverlaySnapshotPayload,
  CaptchaPort.CaptchaAssistOverlaySnapshot
> = true;
export const _captchaViewport: Equals<Wire.CaptchaAssistViewportPayload, CaptchaPort.CaptchaAssistViewport> = true;
export const _captchaCrop: Equals<Wire.CaptchaAssistCropPayload, CaptchaPort.CaptchaAssistCrop> = true;
export const _captchaImage: Equals<Wire.CaptchaAssistImagePayload, CaptchaPort.CaptchaAssistImage> = true;
export const _captchaSnapshot: Equals<Wire.CaptchaAssistSnapshotPayload, CaptchaPort.CaptchaAssistSnapshot> = true;
export const _captchaTrajectory: Equals<
  Wire.CaptchaAssistTrajectoryPayload,
  CaptchaPort.CaptchaAssistTrajectory
> = true;
export const _captchaTrajectorySample: Equals<
  Wire.CaptchaAssistTrajectorySamplePayload,
  CaptchaPort.CaptchaAssistTrajectorySample
> = true;
export const _captchaFocusTier: Equals<Wire.CaptchaAssistFocusTier, CaptchaPort.CaptchaAssistFocusTier> = true;
export const _captchaTypeReport: Equals<
  Wire.CaptchaAssistTypeReportPayload,
  CaptchaPort.CaptchaAssistTypeReport
> = true;

describe('AC-CONTRACT-DRIFT api 段重抄的协议载荷与 protocol.ts 同形', () => {
  it('形状断言在类型层，牙齿在 npm run typecheck（本用例只保证文件被加载）', () => {
    // 运行期没有类型可校验；这里只钉住「本文件确实被测试运行器加载」，避免整文件被删后无人察觉。
    assert.equal(_publishApprovalAction, true);
    assert.equal(_uiDailyUsage, true);
    assert.equal(_notificationItem, true);
    assert.equal(_captchaTrajectory, true);
  });
});
