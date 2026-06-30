/**
 * buildComposeAndApprove 单测（change comment-search-command，撰写→去AI味→人审）。
 * 覆盖：撰写空→null、人审通过→返回文本、人审口未接线→null（不裸发）、人审超时→null、现场评论入撰写。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposeAndApprove } from '../../src/comment-agent/compose-approve.js';
import type { ComposerLike } from '../../src/comment-agent/compose-approve.js';
import type { CommentApprovalPort } from '../../src/agents/comment-approval-gate.js';
import type { NoteForComment, OnPageComment } from '../../src/comment-agent/comment-task-runner.js';

const note: NoteForComment = { noteId: 'n1', title: 'RAG 实战', content: '正文', likeCount: 10, collectCount: 5 };
const comments: OnPageComment[] = [{ text: '学到了' }, { text: '求教程' }];

function composer(draft: string | null, capture?: (opts: { onPageComments?: string[] }) => void): ComposerLike {
  return {
    composeDraft: async (_note, opts) => {
      capture?.(opts);
      return draft;
    },
  };
}

function approvalPort(approved: boolean, opts: { timeoutMs?: number; pollMs?: number } = {}): CommentApprovalPort {
  return {
    request: async () => {},
    isApproved: async () => approved,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
  };
}

describe('buildComposeAndApprove', () => {
  it('撰写为空 → null，不发审批', async () => {
    let requested = false;
    const step = buildComposeAndApprove({
      composer: composer(null),
      approval: { request: async () => { requested = true; }, isApproved: async () => true },
      logger: { log: () => {}, warn: () => {} },
    });
    assert.equal(await step(note, comments), null);
    assert.equal(requested, false);
  });

  it('撰写成功 + 人审通过 → 返回文本；现场评论喂进撰写', async () => {
    let seen: string[] | undefined;
    const step = buildComposeAndApprove({
      composer: composer('这套检索链路很实在', (o) => { seen = o.onPageComments; }),
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    const text = await step(note, comments);
    assert.equal(text, '这套检索链路很实在');
    assert.deepEqual(seen, ['学到了', '求教程']);
  });

  it('人审口未接线 → null（绝不裸发）', async () => {
    const step = buildComposeAndApprove({
      composer: composer('一条评论'),
      approval: undefined,
      logger: { log: () => {}, warn: () => {} },
    });
    assert.equal(await step(note, comments), null);
  });

  it('人审超时 → null', async () => {
    let t = 1000;
    const step = buildComposeAndApprove({
      composer: composer('一条评论'),
      approval: approvalPort(false, { timeoutMs: 5000, pollMs: 1000 }),
      now: () => {
        t += 2000;
        return t;
      },
      sleep: async () => {},
      logger: { log: () => {}, warn: () => {} },
    });
    assert.equal(await step(note, comments), null);
  });

  it('清洗后为空（撰写只剩空白）→ null', async () => {
    const step = buildComposeAndApprove({
      composer: composer('   '),
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    assert.equal(await step(note, comments), null);
  });
});
