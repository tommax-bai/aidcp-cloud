/**
 * 面板能力名册与装配对账（change restore-panel-capability-wiring）。
 *
 * 为什么需要这个文件：`PanelDeps` 的能力字段全是**可选**的——少装一项照样编译通过、进程照常
 * 启动、健康口照常绿，只有对应那几条路由逐个回 503。2026-08-04 dev 切三服务后，手写的接口
 * 进程组装根就这样少装了 21 项，直到运营打开设置页才发现。**没有任何机械手段会提醒少装了。**
 *
 * 这道闸把「本进程不提供某项能力」从一次静默的遗漏，变成一个**必须写下来的决定**：
 *   - 装上了 → 什么都不用做；
 *   - 不装 → MUST 在本进程的具名缺席表里写明理由与用户可见后果；
 *   - 两者皆无 → 进程**启动失败**。
 *
 * 刻意做成启动期硬失败而非测试期告警：面板是运营唯一的操作面，少一项就是一页打不开。
 */

import type { PanelDeps } from './types.js';

/**
 * 面板能力名册：`PanelDeps` 里**全部可选字段**。必填字段不进名册——漏填它们编译就红，
 * 本来就不会静默消失；名册只管那些「不写也能过」的。
 */
export const PANEL_CAPABILITY_KEYS = [
  'interactionInternalApi',
  'interactionPermissions',
  'revocation',
  'edgePresenceEvidence',
  'publishDispatcher',
  'publishInFlightEvidence',
  'delegatedTasks',
  'readApprovalDispatchStates',
  'preflightApprovePublish',
  'publishDraft',
  'notifyPublishPreviewChanged',
  'accountAttr',
  'facebookCommentConfig',
  'facebookRuleMode',
  'facebookOperationPolicy',
  'facebookGroupCommentPolicy',
  'facebookPublishMedia',
  'facebookGroupTargets',
  'contentSchedule',
  'captchaAssist',
  'modelConfig',
  'roleConfig',
  'categoryConfig',
  'rolePromptPreview',
  'persona',
  'quotaConfig',
  'configMirrorHealth',
  'configMirrorServicesHealth',
  'pacingConfig',
  'sessionLimits',
  'hotLeadConfig',
  'resumeConfig',
  'tokenUsage',
  'billingPriceRefresh',
  'notificationContact',
  'notificationRoutes',
  'approvalPolicies',
  'botChats',
  'curatedContent',
  'curatedActions',
  'alertStore',
  'clientUsers',
  'slowStartDisabled',
  'onClientOffboardCreated',
] as const;

export type PanelCapabilityKey = (typeof PANEL_CAPABILITY_KEYS)[number];

/** `PanelDeps` 里的可选字段名（`{}` 可赋给 `Pick` ⇔ 该字段可缺省）。 */
type OptionalPanelDepKey = {
  [K in keyof PanelDeps]-?: Record<string, never> extends Pick<PanelDeps, K> ? K : never;
}[keyof PanelDeps];

/**
 * 名册与契约在**两个方向**上互相钉死。手抄名单的老问题（`satisfies` 只查子集、不查写全）
 * 由这两条 `Exclude` 堵住：契约新增一项而名册漏抄 ⇒ 编译红；名册留着已删除的项 ⇒ 也红。
 */
type _RosterMissing = Exclude<OptionalPanelDepKey, PanelCapabilityKey>;
type _RosterExtra = Exclude<PanelCapabilityKey, OptionalPanelDepKey>;
const _rosterCoversContract: _RosterMissing extends never ? true : never = true;
const _rosterHasNoStaleEntries: _RosterExtra extends never ? true : never = true;
void _rosterCoversContract;
void _rosterHasNoStaleEntries;

/**
 * 本进程的具名缺席表：能力名 → **为什么不装 + 管理后台上的具体表现**。
 * 只准缩短。新增一条 MUST 写清用户可见后果，别只写「属别的进程」——那不是后果。
 */
export type PanelCapabilityAbsences = Partial<Record<PanelCapabilityKey, string>>;

export interface PanelCapabilityCoverageProblem {
  key: PanelCapabilityKey;
  /** unwired = 既没装也没具名；stale_absence = 已装上却还留在缺席表里；empty_reason = 缺席理由为空。 */
  kind: 'unwired' | 'stale_absence' | 'empty_reason';
}

/**
 * 纯判定：回问题清单（空 = 全覆盖）。析出成纯函数是为了能被喂违规输入直接断言——
 * 一道只在「全对」路径上跑过的闸，没人能证明它还在。
 */
export function findPanelCapabilityCoverageProblems(
  wired: ReadonlySet<string>,
  absences: PanelCapabilityAbsences,
): PanelCapabilityCoverageProblem[] {
  const problems: PanelCapabilityCoverageProblem[] = [];
  for (const key of PANEL_CAPABILITY_KEYS) {
    const isWired = wired.has(key);
    const declared = Object.prototype.hasOwnProperty.call(absences, key);
    const reason = absences[key];
    if (isWired && declared) {
      // 装上了却还记着缺席：缺席表是棘轮，MUST 在装上的同一次改动里删掉那条，
      // 否则它会变成一个骗人的账本——下一个人读到「本进程不提供」而事实相反。
      problems.push({ key, kind: 'stale_absence' });
      continue;
    }
    if (isWired) continue;
    if (!declared) {
      problems.push({ key, kind: 'unwired' });
      continue;
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      problems.push({ key, kind: 'empty_reason' });
    }
  }
  return problems;
}

/**
 * 从实际装配好的 deps 对象取「装上了哪些」：值为 `undefined` 的字段**不算装上**
 * （`{ x: undefined }` 写法在条件展开里很常见，它与没写是同一件事）。
 * 逐名册取值、不做整对象强转——强转会让「名册里有但契约里没有」这类错误绕过编译期。
 */
export function wiredPanelCapabilities(deps: PanelDeps): ReadonlySet<string> {
  const wired = new Set<string>();
  for (const key of PANEL_CAPABILITY_KEYS) {
    if (deps[key] !== undefined) wired.add(key);
  }
  return wired;
}

/**
 * 启动期断言。`serviceName` 只进错误文案，方便三个进程各自的失败一眼可分。
 * 抛错即让进程起不来——这是有意的，见文件头。
 */
export function assertPanelCapabilityCoverage(
  deps: PanelDeps,
  absences: PanelCapabilityAbsences,
  serviceName: string,
): void {
  const problems = findPanelCapabilityCoverageProblems(wiredPanelCapabilities(deps), absences);
  if (problems.length === 0) return;
  const describe = (p: PanelCapabilityCoverageProblem): string => {
    if (p.kind === 'unwired') return `${p.key}（既没装上、也没写进具名缺席表）`;
    if (p.kind === 'stale_absence') return `${p.key}（已装上，但具名缺席表里还留着，须删除该条）`;
    return `${p.key}（缺席理由为空，须写明不装的理由与管理后台上的表现）`;
  };
  throw new Error(
    `panel_capability_coverage_failed[${serviceName}]: ${problems.length} 项未对账 —— ` +
      `${problems.map(describe).join('；')}。见 src/panel/capability-coverage.ts 文件头。`,
  );
}
