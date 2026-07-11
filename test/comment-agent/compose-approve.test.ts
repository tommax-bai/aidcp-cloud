/**
 * buildComposeAndApprove 单测（change comment-search-command，撰写→去AI味→人审）。
 * change comment-keep-open-through-approval 收尾：返回改判别式 {approved:true,...} | {approved:false, reason}，
 * 断言诚实区分「撰写为空」与「送审未获批」等跳过原因。
 * 覆盖：撰写空→empty_compose、人审通过→返回文本、人审口未接线→approval_not_wired、
 *       人审超时→approval_unapproved、撞参考→overlaps_reference、现场评论入撰写。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposeAndApprove } from '../../src/comment-agent/compose-approve.js';
import type { ComposerLike } from '../../src/comment-agent/compose-approve.js';
import type { CommentApprovalPort } from '../../src/agents/comment-approval-gate.js';
import type { NoteForComment, OnPageComment } from '../../src/comment-agent/comment-task-runner.js';

const note: NoteForComment = { noteId: 'n1', title: 'RAG 实战', content: '正文', author: '开源老周', likeCount: 10, collectCount: 5 };
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
  it('撰写为空 → approved:false/empty_compose，不发审批', async () => {
    let requested = false;
    const step = buildComposeAndApprove({
      composer: composer(null),
      approval: { request: async () => { requested = true; }, isApproved: async () => true },
      logger: { log: () => {}, warn: () => {} },
    });
    assert.deepEqual(await step(note, comments), { approved: false, reason: 'empty_compose' });
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
    assert.ok(result.approved);
    assert.equal(result.text, '这套检索链路很实在');
    assert.equal(result.contactInfo, null);
    assert.deepEqual(seen, ['学到了', '求教程']);
  });

  it('人审请求携带账号信息与用户昵称，供审批卡显示昵称', async () => {
    let request: { accountId?: string; accountName?: string; authorName?: string } | undefined;
    const step = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      accountId: 'acc-01',
      accountName: 'Tmax',
      approval: {
        request: async (r: { accountId?: string; accountName?: string; authorName?: string }) => { request = r; },
        isApproved: async () => true,
      },
      logger: { log: () => {}, warn: () => {} },
    });
    const result = await step(note, comments);
    assert.ok(result.approved);
    assert.equal(result.text, '这套检索链路很实在');
    assert.equal(request?.accountId, 'acc-01');
    assert.equal(request?.accountName, 'Tmax');
    assert.equal(request?.authorName, '开源老周');
  });

  it('人审口未接线 → approved:false/approval_not_wired（绝不裸发）', async () => {
    const step = buildComposeAndApprove({
      composer: composer('一条评论'),
      approval: undefined,
      logger: { log: () => {}, warn: () => {} },
    });
    assert.deepEqual(await step(note, comments), { approved: false, reason: 'approval_not_wired' });
  });

  it('人审超时 → approved:false/approval_unapproved', async () => {
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
    assert.deepEqual(await step(note, comments), { approved: false, reason: 'approval_unapproved' });
  });

  it('审批卡发送失败 → approved:false/approval_send_failed（绝不裸发）', async () => {
    const step = buildComposeAndApprove({
      composer: composer('一条评论'),
      approval: {
        request: async () => { throw new Error('feishu down'); },
        isApproved: async () => true,
      },
      logger: { log: () => {}, warn: () => {} },
    });
    assert.deepEqual(await step(note, comments), { approved: false, reason: 'approval_send_failed' });
  });

  it('清洗后为空（撰写只剩空白）→ approved:false/empty_compose', async () => {
    const step = buildComposeAndApprove({
      composer: composer('   '),
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    assert.deepEqual(await step(note, comments), { approved: false, reason: 'empty_compose' });
  });

  it('与精选参考近似照搬 → approved:false/overlaps_reference（绝不照搬）', async () => {
    const ref = '这套检索链路很实在';
    const step = buildComposeAndApprove({
      composer: composer(ref),
      getReferences: async () => [ref], // 正文与参考逐字相同 → overlap
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    assert.deepEqual(await step(note, comments), { approved: false, reason: 'overlaps_reference' });
  });

  // ── change account-group-chat-injection → generalize-contact-info：联系方式 verbatim 注入 + 审=发 ──

  it('联系方式：正文与联系方式分开返回；人审卡展示合并终稿（审=发）', async () => {
    let approvedText: string | undefined;
    const code = '2【长按复制】加群🐶\n第二行 :/#f'; // 含 emoji / 换行 / 特殊符
    const step = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      contactInfo: code,
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
    assert.ok(result.approved);
    assert.equal(result.text, '这套检索链路很实在'); // 正文（边缘逐字敲）
    assert.equal(result.contactInfo, code); // 码（边缘整段插入，verbatim）
    assert.equal(approvedText, merged); // 人审卡展示合并终稿（AC-PUB 审=发）
  });

  it('无联系方式（contactInfo 缺省 / null）→ 正文不变、联系方式为 null，零回归', async () => {
    const step1 = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    const r1 = await step1(note, comments);
    assert.ok(r1.approved);
    assert.equal(r1.text, '这套检索链路很实在');
    assert.equal(r1.contactInfo, null);

    const step2 = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      contactInfo: null,
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    const r2 = await step2(note, comments);
    assert.ok(r2.approved);
    assert.equal(r2.contactInfo, null);
  });

  it('码不参与反照搬：references 命中码不致弃发（overlap 只比正文）', async () => {
    const code = '加群暗号-xyz';
    const step = buildComposeAndApprove({
      composer: composer('这套检索链路很实在'),
      contactInfo: code,
      getReferences: async () => [code], // 参考里正好含码字面
      approval: approvalPort(true),
      logger: { log: () => {}, warn: () => {} },
    });
    // 正文不撞参考 → 不弃发；码不进 overlap 比对；正文与码分开返回
    const r = await step(note, comments);
    assert.ok(r.approved);
    assert.equal(r.text, '这套检索链路很实在');
    assert.equal(r.contactInfo, code);
  });
});
