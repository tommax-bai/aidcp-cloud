import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DispatchDraft, RefineDraftPatch } from '../../src/publish-agent/publish-log-store.js';
import type { DraftRefinementJob, DraftRefinementScope } from '../../src/publish-agent/draft-refinement.js';
import { DraftRefinementWorker } from '../../src/publish-agent/draft-refinement-worker.js';

const draft: DispatchDraft = {
  recordId: 17,
  accountId: 'account-1',
  platform: 'xiaohongshu',
  title: '旧标题',
  content: '开头需要调整的文字结尾',
  imageUrl: 'image-a',
  imageUrls: ['image-a', 'image-b'],
  metadata: {
    topics: ['旧话题'], mentions: [], location: null, collection: null,
    visibility: 'public', permissions: { comment: true, save: true },
    mode: 'immediate', publishTime: null, compliance: { ai: true, aiEnforced: true },
    metadataScore: 1, decidedAt: 1,
  } as never,
  status: 'pending_approval',
  contentVersion: 2,
};

function job(scope: DraftRefinementScope): DraftRefinementJob {
  return {
    id: `00000000-0000-4000-8000-${scope.padEnd(12, '0').slice(0, 12)}`,
    executionTarget: 'dev', accountId: 'account-1', recordId: 17, expectedVersion: 2,
    scope, instruction: '更自然、更生活化',
    selection: scope === 'selected_text'
      ? { start: 2, end: 9, text: '需要调整的文字' }
      : scope === 'selected_image' ? { imageUrl: 'image-b' } : null,
    status: 'running', progress: [], claimToken: 'claim-token', resultVersion: null,
    errorCode: null, errorMessage: null, createdAt: 1, updatedAt: 1, completedAt: null,
  };
}

function fixture(scope: DraftRefinementScope, imageFailure = false, writeFailure?: unknown) {
  const currentJob = job(scope);
  const progressSnapshots: unknown[] = [];
  const completed: unknown[] = [];
  const failed: unknown[] = [];
  const writes: Array<{ scope: DraftRefinementScope; patch: RefineDraftPatch }> = [];
  let claimed = false;
  let imageIndex = 0;
  const worker = new DraftRefinementWorker({
    store: {
      async claimNext() { if (claimed) return null; claimed = true; return currentJob; },
      async replaceProgress(_id, _token, progress) { progressSnapshots.push(structuredClone(progress)); return true; },
      async complete(...args) { completed.push(args); return true; },
      async fail(...args) { failed.push(args); return true; },
    },
    drafts: {
      async loadForDispatch() { return structuredClone(draft); },
      async refineDraft(_recordId, _accountId, _version, actualScope, _selection, patch) {
        if (writeFailure !== undefined) throw writeFailure;
        writes.push({ scope: actualScope, patch: structuredClone(patch) });
        return { ok: true as const, contentVersion: 3, title: patch.title ?? draft.title, content: patch.content ?? draft.content, metadata: draft.metadata, images: patch.images ?? draft.imageUrls };
      },
    },
    llm: {
      async chat(messages) {
        const prompt = messages[0].content;
        if (prompt.includes('文生图指令')) {
          const count = prompt.includes('需要 2 张') ? 2 : 1;
          return JSON.stringify({ prompts: Array.from({ length: count }, (_, i) => `配图指令${i + 1}`) });
        }
        if (prompt.includes('只返回选中文字')) return JSON.stringify({ replacement: '更自然的表达' });
        if (prompt.includes('只返回调整后的正文')) return JSON.stringify({ content: '完整新正文' });
        return JSON.stringify({ title: '新标题', content: '完整新正文', topics: ['新话题'] });
      },
    },
    imageProvider: {
      async generate() {
        imageIndex += 1;
        return imageFailure && imageIndex === 2
          ? { url: null, error: 'provider_failed' }
          : { url: `https://images.example/${imageIndex}.png` };
      },
    },
    clock: (() => { let at = 100; return () => ++at; })(),
    logger: { log() {}, warn() {}, error() {} },
  });
  return { worker, progressSnapshots, completed, failed, writes };
}

describe('DraftRefinementWorker scopes', () => {
  test('body only writes content', async () => {
    const fx = fixture('body');
    assert.equal(await fx.worker.processNext(), true);
    assert.deepEqual(fx.writes[0], { scope: 'body', patch: { content: '完整新正文' } });
    assert.equal(fx.completed.length, 1);
    assert.equal(fx.failed.length, 0);
  });

  test('selected text preserves prefix and suffix', async () => {
    const fx = fixture('selected_text');
    await fx.worker.processNext();
    assert.deepEqual(fx.writes[0], { scope: 'selected_text', patch: { content: '开头更自然的表达结尾' } });
  });

  test('selected image only replaces selected slot', async () => {
    const fx = fixture('selected_image');
    await fx.worker.processNext();
    assert.deepEqual(fx.writes[0], {
      scope: 'selected_image',
      patch: { images: ['image-a', 'https://images.example/1.png'] },
    });
  });

  test('all images produces a complete same-size set without changing text', async () => {
    const fx = fixture('images');
    await fx.worker.processNext();
    assert.deepEqual(fx.writes[0], {
      scope: 'images',
      patch: { images: ['https://images.example/1.png', 'https://images.example/2.png'] },
    });
  });

  test('whole writes text, topics, and complete images together', async () => {
    const fx = fixture('whole');
    await fx.worker.processNext();
    assert.deepEqual(fx.writes[0], {
      scope: 'whole',
      patch: {
        title: '新标题', content: '完整新正文', topics: ['新话题'],
        images: ['https://images.example/1.png', 'https://images.example/2.png'],
      },
    });
    const finalProgress = fx.completed[0] as [string, string, number, Array<{ stage: string; status: string }>];
    assert.deepEqual(finalProgress[3].map((item) => item.stage), ['计划', '判断', '生成', '生成', '生成', '生成', '检查', '确认']);
    assert.equal(finalProgress[3].every((item) => item.status === 'completed'), true);
  });

  test('partial image failure never calls draft writer and fails honestly', async () => {
    const fx = fixture('images', true);
    await fx.worker.processNext();
    assert.equal(fx.writes.length, 0);
    assert.equal(fx.completed.length, 0);
    assert.equal(fx.failed.length, 1);
    assert.equal((fx.failed[0] as unknown[])[2], 'image_generation_failed');
  });
});

describe('DraftRefinementWorker 落稿失败的三态', () => {
  test('「结果未知」MUST NOT 说「原稿未变化」，也 MUST NOT 劝重投', async () => {
    // 拆进程后才有的一态：写可能已经提交、应答在回程丢了。传输层把它归成具名码。
    const fx = fixture('body', false, Object.assign(new Error('call timed out'), {
      code: 'api_authority_result_unknown',
    }));
    await fx.worker.processNext();
    assert.equal(fx.writes.length, 0);
    assert.equal(fx.completed.length, 0);
    assert.equal(fx.failed.length, 1);
    const [, , code, message] = fx.failed[0] as [string, string, string, string];
    assert.equal(code, 'refinement_result_unknown');
    assert.ok(
      !message.includes('原稿未变化'),
      '这一态下「原稿未变化」是假话 —— 稿子可能已经是新版本了',
    );
    assert.ok(message.includes('刷新'), '该让用户去看一眼当前版本，而不是再发一次');
  });

  test('其余抛出物仍走「确认没做成」那条（新分支 MUST NOT 把它一起吞了）', async () => {
    const fx = fixture('body', false, new Error('unexpected'));
    await fx.worker.processNext();
    assert.equal(fx.failed.length, 1);
    const [, , code, message] = fx.failed[0] as [string, string, string, string];
    assert.equal(code, 'refinement_failed');
    assert.ok(message.includes('原稿未变化'));
  });
});
