export const FACEBOOK_RULE_DEFINITION_ID = 'facebook_browse_10_like_1_join_contact_1';
export const FACEBOOK_RULE_DEFINITION_VERSION = 1;
export const FACEBOOK_RULE_VIEW_THRESHOLD = 10;

export type FacebookBrowseMode =
  | 'facebook_rule'
  | 'persona'
  | 'slow_start'
  | 'blocked'
  | 'unsupported';

export type FacebookRuleActionState =
  | 'pending'
  | 'dispatched'
  | 'confirmed'
  | 'already_satisfied'
  | 'risk_suppressed'
  | 'structural_skip'
  | 'not_started'
  | 'rejected'
  | 'failed'
  | 'ambiguous'
  | 'submitted_unknown';

export interface FacebookRuleModeConfig {
  accountId: string;
  enabled: boolean;
  definitionId: typeof FACEBOOK_RULE_DEFINITION_ID;
  definitionVersion: typeof FACEBOOK_RULE_DEFINITION_VERSION;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FacebookRuleModeBatchView {
  batchId: string;
  sequence: number;
  triggerContentKey: string;
  likeState: FacebookRuleActionState;
  joinState: FacebookRuleActionState;
  commentState: FacebookRuleActionState;
  terminal: boolean;
  blocker: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacebookRuleModeRuntimeView {
  viewCount: number;
  threshold: typeof FACEBOOK_RULE_VIEW_THRESHOLD;
  currentBatch: FacebookRuleModeBatchView | null;
  updatedAt: string | null;
}

export interface FacebookRuleModeView {
  config: FacebookRuleModeConfig;
  runtime: FacebookRuleModeRuntimeView;
}

export type SetFacebookRuleModeResult =
  | { ok: true; row: FacebookRuleModeConfig }
  | {
      ok: false;
      reason:
        | 'account_not_found'
        | 'unsupported_platform'
        | 'invalid_value'
        | 'no_valid_fields';
    };

export type ApplyFacebookRuleViewResult =
  | { kind: 'counted'; viewCount: number }
  | { kind: 'duplicate'; viewCount: number }
  | { kind: 'batch_active'; batchId: string }
  | { kind: 'batch_created'; batch: FacebookRuleModeBatchView };
