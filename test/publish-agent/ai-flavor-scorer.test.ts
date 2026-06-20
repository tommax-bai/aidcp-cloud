import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AiFlavorScorerRole } from '../../src/publish-agent/roles/ai-flavor-scorer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

describe('AiFlavorScorerRole', () => {
  test('恒等投影：aiFlavorScore.aiScore === cleanedContent.aiScore（不篡改）', async () => {
    const role = new AiFlavorScorerRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('cleanedContent', { content: 'c', rewritten: false, flaggedPhrases: [], aiScore: 0.37, cleanedAt: clock() });
    await new Promise((r) => setTimeout(r, 30));
    const s = ctx.get('aiFlavorScore');
    assert.ok(s);
    assert.equal(s.aiScore, 0.37);
  });
});
