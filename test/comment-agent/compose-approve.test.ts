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
    const result = await step(note, comments);
    assert.equal(result?.text, '这套检索链路很实在');
    assert.equal(result?.groupChatCode, null);
    assert.deepEqual(seen, ['学到了', '求教程']);
  });

  it('人审请求携带账号信息，供审批卡显示昵称', async () => {
    let request: { accountId?: string; accountName?: string } | undefined;
    const step = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      accountId: 'acc-01',
      accountName: 'Tmax',
      approval: {
        request: async (r: { accountId?: string; accountName?: string }) => { request = r; },
        isApproved: async () => true,
      },
      logger: { log: () => {}, warn: () => {} },
    });
    const result = await step(note, comments);
    assert.equal(result?.text, '这套检索链路很实在');
    assert.equal(request?.accountId, 'acc-01');
    assert.equal(request?.accountName, 'Tmax');
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

  // ── change account-group-chat-injection：群聊引流码 verbatim 注入 + 审=发 ──

  it('群聊引流码：正文与码分开返回；人审卡展示合并终稿（审=发）', async () => {
    let approvedText: string | undefined;
    const code = '2【长按复制】加群🐶\n第二行 :/#f'; // 含 emoji / 换行 / 特殊符
    const step = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      groupChatCode: code,
      approval: {
        request: async (r: { text: string }) => {
          approvedText = r.text;
        },
        isApproved: async () => true,
      },
      logger: { log: () => {}, warn: () => {} },
    });
    const result = await step(note, comments);
    const merged = `这套检索链路很实在\n${code}`;
    assert.equal(result?.text, '这套检索链路很实在'); // 正文（边缘逐字敲）
    assert.equal(result?.groupChatCode, code); // 码（边缘整段插入，verbatim）
    assert.equal(approvedText, merged); // 人审卡展示合并终稿（AC-PUB 审=发）
  });

  it('无群聊码（groupChatCode 缺省 / null）→ 正文不变、码为 null，零回归', async () => {
    const step1 = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    const r1 = await step1(note, comments);
    assert.equal(r1?.text, '这套检索链路很实在');
    assert.equal(r1?.groupChatCode, null);

    const step2 = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      groupChatCode: null,
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    assert.equal((await step2(note, comments))?.groupChatCode, null);
  });

  it('码不参与反照搬：references 命中码不致弃发（overlap 只比正文）', async () => {
    const code = '加群暗号-xyz';
    const step = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      groupChatCode: code,
      getReferences: async () => [code], // 参考里正好含码字面
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    // 正文不撞参考 → 不弃发；码不进 overlap 比对；正文与码分开返回
    const r = await step(note, comments);
    assert.equal(r?.text, '这套检索链路很实在');
    assert.equal(r?.groupChatCode, code);
  });
});
