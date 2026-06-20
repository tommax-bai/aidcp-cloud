import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataAggregatorRole } from '../../src/publish-agent/roles/metadata-aggregator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type {
  PipelineFields,
  TopicSelection,
  MentionSelection,
  LocationSelection,
  CollectionSelection,
  VisibilityDecision,
  PermissionDecision,
  PublishModeDecision,
  ComplianceDecision,
  Compliance,
} from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

/** 收集 error 审计，用于断言 aiEnforced 回正记 error。 */
function recordingLogger() {
  const errors: unknown[][] = [];
  return {
    log() {},
    warn() {},
    error(...args: unknown[]) {
      errors.push(args);
    },
    errors,
  };
}

function topic(selectedTopics: string[]): TopicSelection {
  return { selectedTopics, selectedAt: clock() };
}
function mention(selectedMentions: string[]): MentionSelection {
  return { selectedMentions, selectedAt: clock() };
}
function location(selectedLocation: string | null): LocationSelection {
  return { selectedLocation, selectedAt: clock() };
}
function collection(selectedCollection: string | null): CollectionSelection {
  return { selectedCollection, selectedAt: clock() };
}
function visibility(v: VisibilityDecision['visibility']): VisibilityDecision {
  return { visibility: v, reason: 'r', decidedAt: clock() };
}
function permission(
  comment: PermissionDecision['comment'],
  save: PermissionDecision['save']
): PermissionDecision {
  return { comment, save, decidedAt: clock() };
}
function mode(
  m: PublishModeDecision['mode'],
  publishTime: number | null = null
): PublishModeDecision {
  return { mode: m, publishTime, decidedAt: clock() };
}
function compliance(c: Compliance): ComplianceDecision {
  return { compliance: c, decidedAt: clock() };
}

/** 写入八键（默认全实际分享决策态）。可用 overrides 替换个别键。 */
function writeAll(
  ctx: PipelineContext<PipelineFields>,
  overrides: Partial<{
    topicSelection: TopicSelection;
    mentionSelection: MentionSelection;
    locationSelection: LocationSelection;
    collectionSelection: CollectionSelection;
    visibilityDecision: VisibilityDecision;
    permissionDecision: PermissionDecision;
    publishModeDecision: PublishModeDecision;
    complianceDecision: ComplianceDecision;
  }> = {}
) {
  ctx.write('topicSelection', overrides.topicSelection ?? topic(['a', 'b', 'c']));
  ctx.write('mentionSelection', overrides.mentionSelection ?? mention(['@u1']));
  ctx.write('locationSelection', overrides.locationSelection ?? location('Shanghai'));
  ctx.write('collectionSelection', overrides.collectionSelection ?? collection('TechNotes'));
  ctx.write('visibilityDecision', overrides.visibilityDecision ?? visibility('public'));
  ctx.write('permissionDecision', overrides.permissionDecision ?? permission('allow', 'allow'));
  ctx.write('publishModeDecision', overrides.publishModeDecision ?? mode('immediate', null));
  ctx.write('complianceDecision', overrides.complianceDecision ?? compliance({ ai: true, ad: false, origin: true }));
}

describe('MetadataAggregatorRole', () => {
  test('八键集齐触发一次产出 publishMetadata，字段正确汇合', async () => {
    const role = new MetadataAggregatorRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    writeAll(ctx);
    await new Promise((r) => setTimeout(r, 30));

    const out = ctx.get('publishMetadata');
    assert.ok(out, 'publishMetadata 应已产出');
    assert.deepEqual(out!.topics, ['a', 'b', 'c']);
    assert.deepEqual(out!.mentions, ['@u1']);
    assert.equal(out!.location, 'Shanghai');
    assert.equal(out!.collection, 'TechNotes');
    assert.equal(out!.visibility, 'public');
    assert.deepEqual(out!.permissions, { comment: 'allow', save: 'allow' });
    assert.equal(out!.mode, 'immediate');
    assert.equal(out!.publishTime, null);
    assert.deepEqual(out!.compliance, { ai: true, ad: false, origin: true });
    assert.equal(out!.decidedAt, clock());
  });

  test('七键集齐不触发（waitAll 八键 AND）', async () => {
    const role = new MetadataAggregatorRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('topicSelection', topic(['a', 'b', 'c']));
    ctx.write('mentionSelection', mention(['@u1']));
    ctx.write('locationSelection', location('Shanghai'));
    ctx.write('collectionSelection', collection('TechNotes'));
    ctx.write('visibilityDecision', visibility('public'));
    ctx.write('permissionDecision', permission('allow', 'allow'));
    ctx.write('publishModeDecision', mode('immediate', null));
    // complianceDecision 缺失
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctx.get('publishMetadata'), undefined);
  });

  test('全有效 → metadataScore ≈ 1.0', async () => {
    const role = new MetadataAggregatorRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    writeAll(ctx);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctx.get('publishMetadata')?.metadataScore, 1.0);
  });

  test('全默认（空/null/self_only/disable）→ metadataScore ≈ 0', async () => {
    const role = new MetadataAggregatorRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    writeAll(ctx, {
      topicSelection: topic([]),
      mentionSelection: mention([]),
      locationSelection: location(null),
      collectionSelection: collection(null),
      visibilityDecision: visibility('self_only'),
      permissionDecision: permission('disable', 'disable'),
      publishModeDecision: mode('draft', null),
      complianceDecision: compliance({}),
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctx.get('publishMetadata')?.metadataScore, 0);
  });

  test('aiEnforced && !ai 篡改态被回正 ai=true 并记 error 审计', async () => {
    const logger = recordingLogger();
    const role = new MetadataAggregatorRole({ clock, logger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    writeAll(ctx, {
      // 篡改态：aiEnforced 置位但 ai=false（绝不静默放行）。
      complianceDecision: compliance({ ai: false, aiEnforced: true }),
    });
    await new Promise((r) => setTimeout(r, 30));

    const out = ctx.get('publishMetadata');
    assert.equal(out?.compliance.ai, true, 'ai 应被强制回正为 true');
    assert.equal(out?.compliance.aiEnforced, true);
    assert.ok(logger.errors.length >= 1, '回正应记 error 审计');
  });

  test('aiEnforced && ai=true 正常态不触发回正、不记 error', async () => {
    const logger = recordingLogger();
    const role = new MetadataAggregatorRole({ clock, logger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    writeAll(ctx, {
      complianceDecision: compliance({ ai: true, aiEnforced: true }),
    });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(ctx.get('publishMetadata')?.compliance.ai, true);
    assert.equal(logger.errors.length, 0, '正常态不应记 error');
  });

  test('只读不写边界：绝不写 assembledContent', async () => {
    const role = new MetadataAggregatorRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    writeAll(ctx);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctx.get('assembledContent'), undefined, 'MetadataAggregator 绝不写 assembledContent');
  });
});
