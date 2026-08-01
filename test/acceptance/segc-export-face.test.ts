// aidcp:test-owner=cloud
/**
 * AC-SEGC-FACE —— 自动化段导出面的漂移闸（change split-cloud-automation-production-runtime，批 A）。
 *
 * 派生仓 `aidcp-automation` 手抄了一份判据清单，逐条判这些句柄「自动化进程里有没有去处」。
 * 那份清单是批 B…H 的尺子，**而它拿不到本仓的任何机械信号**（同类分叉今天已经咬过多次）。
 * 这条用例就是补上那个信号：导出面一变，本仓当场红，并点名要去同步那份清单。
 *
 * **红了不要改名单了事。** 名单变了意味着自动化段的边界动了，那条句柄的去处要重判一次：
 * 本进程里有没有消费者？只被接口服务段读？还是本进程构造只为答别的进程？
 * 直接把名单改绿，等于把「顺手 new 一个本进程没人读的对象」这类错悄悄放行。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveSegCExportFace } from './helpers/segc-export-face.js';

/**
 * 2026-08-01 实测的自动化段导出面。字典序，41 条。
 *
 * 逐条裁定在 `aidcp-automation/src/automation-segc-export-disposition.ts`；
 * 本仓只钉「有哪些」，不钉「怎么处置」——处置是人读出来的，本仓没有那个上下文。
 */
const SEGC_EXPORT_FACE = [
  'accountPersonaService',
  'alertStore',
  'approvePublishForClient',
  'automationDispatchCommands',
  'automationEdgeResumeAuthority',
  'automationFacebookScopeAuthority',
  'automationPublishUiUpdateAuthority',
  'buildTodayUsageForAccount',
  'captchaAssist',
  'commentScheduler',
  'configMirrorRefresher',
  'dispatchActivityForPanel',
  'edgeServer',
  'handlePublishDraftImageRemove',
  'interactionCustomerApi',
  'interactionInternalApi',
  'interactionOffboarding',
  'interactionPermissionOverview',
  'interactionSender',
  'interactionStore',
  'listAccountAutomationCatalog',
  'notifyPublishRejected',
  'panelUsers',
  'personaAutoFill',
  'preflightApprovePublish',
  'publishDispatchTrigger',
  'publishDispatcher',
  'publishScheduler',
  'publishUiUpdateCommand',
  'readLiveContentVersion',
  'readPublishApproval',
  'refreshPublishPreview',
  'resolveController',
  'riskCommandService',
  'riskRegistry',
  'rolePromptProvider',
  'runtimes',
  'scheduledPublishReconciler',
  'server',
  'triggerPublishDispatchOnApprove',
  'uiSnapshot',
] as const;

test('AC-SEGC-FACE 自动化段导出面与派生仓判据清单同步', () => {
  assert.deepEqual(
    deriveSegCExportFace(),
    [...SEGC_EXPORT_FACE],
    '自动化段的导出面变了。MUST 去 aidcp-automation/src/automation-segc-export-disposition.ts'
      + ' 逐条重判新增/消失的那几个句柄「自动化进程里有没有去处」，再回来同步本名单。'
      + '直接改名单让它变绿 = 把判据这把尺子悄悄折断',
  );
});

test('AC-SEGC-FACE 派生器按符号名定位，段被改名时响亮失败而不是静默返回空集', () => {
  assert.throws(
    () => deriveSegCExportFace('const x = 1;\n'),
    /找不到段签名/,
    '找不到段时 MUST 抛错。返回空数组会让上一条用例把「解析失败」读成「导出面清零」',
  );
});
