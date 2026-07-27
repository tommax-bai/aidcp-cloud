import type { PageCardsData } from '../event-bus/types.js';
import type { FacebookBrowseMode } from '../kernel/facebook-rule-mode-types.js';
import { facebookPostKey, hasObviousHighRiskFacebookCaption } from '../platform/facebook-presented-video.js';

export type { FacebookBrowseMode } from '../kernel/facebook-rule-mode-types.js';

export interface FacebookRuleModeDecision {
  mode: FacebookBrowseMode;
  blocker: string | null;
}

export function decideFacebookBrowseMode(input: {
  platform: string | undefined;
  ruleEnabled: boolean;
  activeWeek: boolean;
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
  if (input.personaBinding !== 'bound') {
    return {
      mode: 'blocked',
      blocker: input.personaBinding === 'unbound' ? 'no_persona' : 'persona_unavailable',
    };
  }
  if (input.ruleEnabled && input.activeWeek) return { mode: 'facebook_rule', blocker: null };
  return { mode: 'persona', blocker: input.ruleEnabled ? 'outside_active_window' : null };
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
