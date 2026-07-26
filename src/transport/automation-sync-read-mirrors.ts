import type { DeploymentTarget } from '../deployment-target.js';
import type {
  ConfigMirrorFreshnessSource,
  ConfigMirrorKey,
  MirrorReadState,
} from '../kernel/config-mirror-bump-types.js';
import {
  isSyncReadFactPayload,
  type AccountPersonaSnapshot,
  type AutomationAccountProjectionSnapshot,
  type ClientEnvironmentAutomationSnapshot,
  type ContentScheduleSnapshot,
  type FacebookCommentConfigSnapshot,
  type FacebookGroupJoinAutomationConfigSnapshot,
  type HotLeadConfigSnapshot,
} from '../kernel/sync-read-facts.js';
import {
  AtomicSyncReadMirror,
  PerProcessConfigFreshnessRuntime,
  syncReadProcessReadiness,
  type SyncReadApplyResult,
  type SyncReadDeliveryState,
  type SyncReadObservationSource,
  type SyncReadSnapshotEnvelope,
} from '../kernel/sync-read-snapshot.js';

export type AutomationMirrorLookup<T> =
  | { state: 'fresh'; value: T; asOf: number }
  | {
      state: Exclude<SyncReadDeliveryState, 'fresh'>;
      value: T | null;
      asOf: number | null;
    };

export type AutomationSlowStartLookup =
  | {
      state: 'fresh';
      resolution: 'known';
      slowStartSince: number | null;
      asOf: number;
    }
  | {
      state: 'fresh';
      resolution: 'missing' | 'ambiguous';
      slowStartSince: null;
      asOf: number;
    }
  | {
      state: Exclude<SyncReadDeliveryState, 'fresh'>;
      resolution: 'unknown';
      slowStartSince: null;
      asOf: number | null;
    };

export class AutomationSyncReadMirrors {
  readonly persona: AtomicSyncReadMirror<AccountPersonaSnapshot>;
  readonly environment: AtomicSyncReadMirror<ClientEnvironmentAutomationSnapshot>;
  readonly accounts: AtomicSyncReadMirror<AutomationAccountProjectionSnapshot>;
  readonly contentSchedule: AtomicSyncReadMirror<ContentScheduleSnapshot>;
  readonly hotLead: AtomicSyncReadMirror<HotLeadConfigSnapshot>;
  readonly facebookComment: AtomicSyncReadMirror<FacebookCommentConfigSnapshot>;
  readonly facebookGroupJoin: AtomicSyncReadMirror<FacebookGroupJoinAutomationConfigSnapshot>;

  constructor(
    executionTarget: DeploymentTarget,
    private readonly clock: () => number = Date.now,
  ) {
    this.persona = mirror(executionTarget, 'account_persona', clock);
    this.environment = mirror(
      executionTarget,
      'client_environment_automation',
      clock,
    );
    this.accounts = mirror(
      executionTarget,
      'automation_account_projection',
      clock,
    );
    this.contentSchedule = mirror(executionTarget, 'content_schedule', clock);
    this.hotLead = mirror(executionTarget, 'hot_lead_config', clock);
    this.facebookComment = mirror(
      executionTarget,
      'facebook_comment_config',
      clock,
    );
    this.facebookGroupJoin = mirror(
      executionTarget,
      'facebook_group_join_automation_config',
      clock,
    );
  }

  apply(
    envelope: SyncReadSnapshotEnvelope,
    source: SyncReadObservationSource,
  ): SyncReadApplyResult {
    switch (envelope.stream) {
      case 'account_persona':
        return this.persona.apply(envelope, source);
      case 'client_environment_automation':
        return this.environment.apply(envelope, source);
      case 'automation_account_projection':
        return this.accounts.apply(envelope, source);
      case 'content_schedule':
        return this.contentSchedule.apply(envelope, source);
      case 'hot_lead_config':
        return this.hotLead.apply(envelope, source);
      case 'facebook_comment_config':
        return this.facebookComment.apply(envelope, source);
      case 'facebook_group_join_automation_config':
        return this.facebookGroupJoin.apply(envelope, source);
      default:
        return {
          outcome: 'rejected',
          reason: 'invalid_envelope',
          currentCursor: null,
          message: `sync_read_stream_not_consumed_by_automation:${envelope.stream}`,
        };
    }
  }

  personaFor(
    accountId: string,
    now = this.clock(),
  ): AutomationMirrorLookup<{
    binding: 'bound' | 'unbound';
    personaText: string | null;
    soul: AccountPersonaSnapshot['accounts'][number]['soul'];
  }> {
    const view = this.persona.view(now);
    const state = deliveryState(view.state);
    if (state !== 'fresh' || !view.value) {
      return {
        state: state as Exclude<SyncReadDeliveryState, 'fresh'>,
        value: null,
        asOf: view.metadata?.sourceAsOf ?? null,
      };
    }
    const row = view.value.accounts.find(
      (candidate) => candidate.accountId === accountId,
    );
    return {
      state: 'fresh',
      value: row
        ? {
            binding: 'bound',
            personaText: row.personaText,
            soul: row.soul,
          }
        : { binding: 'unbound', personaText: null, soul: null },
      asOf: view.metadata!.sourceAsOf,
    };
  }

  automationGateForEdgeId(
    edgeId: string,
    now = this.clock(),
  ): 'allowed' | 'blocked' | 'unknown' {
    if (!edgeId.trim().startsWith('ads-')) return 'allowed';
    const view = this.environment.view(now);
    if (view.state !== 'ready' || !view.value) return 'unknown';
    return view.value.blockedEnvironmentKeys.includes(
      edgeId.trim().slice('ads-'.length),
    )
      ? 'blocked'
      : 'allowed';
  }

  slowStartForAccount(
    accountId: string,
    now = this.clock(),
  ): AutomationSlowStartLookup {
    const view = this.environment.view(now);
    const state = deliveryState(view.state);
    if (state !== 'fresh' || !view.value) {
      return {
        state: state as Exclude<SyncReadDeliveryState, 'fresh'>,
        resolution: 'unknown',
        slowStartSince: null,
        asOf: view.metadata?.sourceAsOf ?? null,
      };
    }
    const row = view.value.slowStartAnchors.find(
      (candidate) => candidate.accountId === accountId,
    );
    if (!row) {
      return {
        state: 'fresh',
        resolution: 'missing',
        slowStartSince: null,
        asOf: view.metadata!.sourceAsOf,
      };
    }
    if (row.ambiguous) {
      return {
        state: 'fresh',
        resolution: 'ambiguous',
        slowStartSince: null,
        asOf: view.metadata!.sourceAsOf,
      };
    }
    return {
      state: 'fresh',
      resolution: 'known',
      slowStartSince: row.slowStartSince,
      asOf: view.metadata!.sourceAsOf,
    };
  }

  accountFor(
    accountId: string,
    now = this.clock(),
  ): AutomationMirrorLookup<
    AutomationAccountProjectionSnapshot['accounts'][number] | null
  > {
    const view = this.accounts.view(now);
    const state = deliveryState(view.state);
    if (state !== 'fresh' || !view.value) {
      return {
        state: state as Exclude<SyncReadDeliveryState, 'fresh'>,
        value: null,
        asOf: view.metadata?.sourceAsOf ?? null,
      };
    }
    return {
      state: 'fresh',
      value:
        view.value.accounts.find((row) => row.accountId === accountId) ?? null,
      asOf: view.metadata!.sourceAsOf,
    };
  }

  configFreshnessRuntime(
    noteStaleRefusal: (
      mirrorKey: ConfigMirrorKey,
      context?: string,
    ) => void = () => undefined,
  ): PerProcessConfigFreshnessRuntime {
    const source: ConfigMirrorFreshnessSource = {
      stateOf: (mirrorKey) => this.configMirrorStateOf(mirrorKey),
      noteStaleRefusal,
    };
    return new PerProcessConfigFreshnessRuntime({
      serviceMode: 'automation',
      authorityMode: 'remote-mirror',
      source,
    });
  }

  configMirrorStateOf(
    mirrorKey: ConfigMirrorKey,
    now = this.clock(),
  ): MirrorReadState {
    const mirror =
      mirrorKey === 'persona_config'
        ? this.persona
        : mirrorKey === 'client_environment_slow_start' ||
            mirrorKey === 'client_environment_automation_gate'
          ? this.environment
          : mirrorKey === 'account_status'
            ? this.accounts
            : mirrorKey === 'content_schedule'
              ? this.contentSchedule
              : mirrorKey === 'hot_lead_config'
                ? this.hotLead
                : mirrorKey === 'facebook_comment_config'
                  ? this.facebookComment
                  : mirrorKey ===
                      'facebook_group_join_automation_config'
                    ? this.facebookGroupJoin
                    : null;
    if (!mirror) return 'stale';
    return mirror.view(now).state === 'ready' ? 'fresh' : 'stale';
  }

  businessConfig<S extends
    | 'content_schedule'
    | 'hot_lead_config'
    | 'facebook_comment_config'
    | 'facebook_group_join_automation_config'>(
    stream: S,
    now = this.clock(),
  ): AutomationMirrorLookup<
    S extends 'content_schedule'
      ? ContentScheduleSnapshot
      : S extends 'hot_lead_config'
        ? HotLeadConfigSnapshot
        : S extends 'facebook_comment_config'
          ? FacebookCommentConfigSnapshot
          : FacebookGroupJoinAutomationConfigSnapshot
  > {
    const selected =
      stream === 'content_schedule'
        ? this.contentSchedule
        : stream === 'hot_lead_config'
          ? this.hotLead
          : stream === 'facebook_comment_config'
            ? this.facebookComment
            : this.facebookGroupJoin;
    const view = selected.view(now);
    const state = deliveryState(view.state);
    if (state === 'fresh' && view.value) {
      return {
        state: 'fresh',
        value: view.value as any,
        asOf: view.metadata!.sourceAsOf,
      };
    }
    return {
      state: state as Exclude<SyncReadDeliveryState, 'fresh'>,
      value: (view.value ?? null) as any,
      asOf: view.metadata?.sourceAsOf ?? null,
    };
  }

  readiness(now = this.clock()) {
    return syncReadProcessReadiness(
      [
        this.persona.health(now),
        this.environment.health(now),
        this.accounts.health(now),
        this.contentSchedule.health(now),
        this.hotLead.health(now),
        this.facebookComment.health(now),
        this.facebookGroupJoin.health(now),
      ],
      now,
    );
  }
}

function mirror<S extends
  | 'account_persona'
  | 'client_environment_automation'
  | 'automation_account_projection'
  | 'content_schedule'
  | 'hot_lead_config'
  | 'facebook_comment_config'
  | 'facebook_group_join_automation_config'>(
  executionTarget: DeploymentTarget,
  stream: S,
  clock: () => number,
): AtomicSyncReadMirror<any> {
  return new AtomicSyncReadMirror({
    executionTarget,
    stream,
    required: true,
    clock,
    validateValue: (value): value is any =>
      isSyncReadFactPayload(stream, value),
  });
}

function deliveryState(
  state: 'uninitialized' | 'ready' | 'stale' | 'invalid' | 'recovering',
): SyncReadDeliveryState {
  if (state === 'ready') return 'fresh';
  if (state === 'stale') return 'stale';
  if (state === 'invalid') return 'invalid';
  return 'unknown';
}
