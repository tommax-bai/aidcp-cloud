import type { PageCardsData } from '../event-bus/types.js';
import type {
  FacebookBrowseMode,
  FacebookRulePolicySnapshot,
} from '../kernel/facebook-rule-mode-types.js';
import type { FacebookConsumptionPolicySnapshot } from './facebook-consumption-mode-types.js';
import { facebookPostKey, hasObviousHighRiskFacebookCaption } from '../platform/facebook-presented-video.js';

export type { FacebookBrowseMode } from '../kernel/facebook-rule-mode-types.js';

export interface FacebookRuleModeDecision {
  mode: FacebookBrowseMode;
  blocker: string | null;
  /** Environment authority pinned by the dispatcher when the browse session starts. */
  primarySurface?: 'feed' | 'reels';
  surfaceRevision?: number;
  /** Present only when the environment operation-policy projection is authoritative. */
  policyRevision?: number;
  rulePolicy?: FacebookRulePolicySnapshot;
  consumptionPolicy?: FacebookConsumptionPolicySnapshot;
  /** Global-only Reel cadence for the already-arbitrated effective mode. */
  reelCadence?: {
    viewsPerLike?: number;
    viewsPerFollow: number;
  };
}

/**
 * Facebook 浏览模式裁决（change facebook-rule-mode-without-persona）。
 *
 * **顺序铁律**（不得调换）：
 *  1. 平台闸——非 Facebook 一律 unsupported。
 *  2. 慢启动的**绝对优先权**及其 fail-closed 判据（身份未知 / 冲突 / 平台未确认）。
 *  3. 规则模式准入——**不再要求账号已绑人设**：规则模式的选卡按上报顺序、点赞是固定意图、
 *     评论正文来自模板，全程不读人设，所以「绑定人设」不是它的前提。
 *  4. 其余一律回到人设浏览闭环，**该路径的人设闸逐字不变**：未绑 → `no_persona`、
 *     读不到 → `persona_unavailable`。例外只解除规则模式这一条路，MUST NOT 让
 *     非规则模式的浏览循环在没有人设的情况下跑起来。
 *
 * 人设例外**必须**排在慢启动之后：慢启动是账号安全的绝对优先项，未绑人设的新账号
 * 若被规则模式抢在慢启动之前接管，等于绕开养号纪律。
 */
export function decideFacebookBrowseMode(input: {
  platform: string | undefined;
  ruleEnabled: boolean;
  operationMode?: 'persona' | 'rule' | 'consumption';
  personaBinding: 'bound' | 'unbound' | 'unknown';
  slowStart: { state: string; ineligibleReason?: string };
}): FacebookRuleModeDecision {
  if (input.platform !== 'facebook') return { mode: 'unsupported', blocker: 'rule_mode_unsupported' };
  if (input.slowStart.state === 'active') return { mode: 'slow_start', blocker: 'slow_start_active' };
  if (
    input.slowStart.ineligibleReason === 'binding_unknown'
    || input.slowStart.ineligibleReason === 'binding_conflict'
    || input.slowStart.ineligibleReason === 'platform_unknown'
    || input.slowStart.ineligibleReason === 'platform_unsupported'
  ) {
    return { mode: 'blocked', blocker: input.slowStart.ineligibleReason };
  }
  const operationMode = input.operationMode ?? (input.ruleEnabled ? 'rule' : 'persona');
  if (operationMode === 'rule') {
    return { mode: 'facebook_rule', blocker: null };
  }
  if (operationMode === 'consumption') {
    return { mode: 'consumption', blocker: null };
  }
  if (input.personaBinding !== 'bound') {
    return {
      mode: 'blocked',
      blocker: input.personaBinding === 'unbound' ? 'no_persona' : 'persona_unavailable',
    };
  }
  return { mode: 'persona', blocker: null };
}

export function selectFacebookRuleCard(
  cards: PageCardsData[],
  alreadyVisited: (contentKey: string) => boolean,
): PageCardsData | null {
  for (const card of [...cards].sort((a, b) => a.index - b.index)) {
    const contentKey = stableFacebookRuleContentKey(card.noteId);
    if (!contentKey || alreadyVisited(contentKey)) continue;
    const caption = card.title.trim();
    if (caption && hasObviousHighRiskFacebookCaption(caption)) continue;
    return card;
  }
  return null;
}

export function stableFacebookRuleContentKey(noteId: string | undefined): string | null {
  if (!noteId?.trim()) return null;
  try {
    const url = new URL(noteId);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'www.facebook.com') return null;
    const pathIdentity = /\/(?:posts|videos|reel|permalink)\/[^/?#]+\/?$/i.test(url.pathname);
    const queryIdentity =
      !!url.searchParams.get('story_fbid')
      || !!url.searchParams.get('multi_permalinks')
      || (/^\/watch\/?$/i.test(url.pathname) && !!url.searchParams.get('v'));
    if (!pathIdentity && !queryIdentity) return null;
  } catch {
    return null;
  }
  const key = facebookPostKey(noteId);
  return key && key !== 'unknown' ? key : null;
}
