import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMandatoryCommentOutcomeCard,
  buildMandatoryCommentPreAuthorizationCard,
  mandatoryCommentOutcomeReason,
} from '../../src/feishu/mandatory-comment-cards.js';

const base = {
  requestId: 'comment-note-1-123',
  noteId: 'note-1',
  text: 'Cho mình hỏi còn tuyển không ạ?',
  accountId: 'acc-fb',
  accountName: 'Tianxing Bai',
  title: 'Tuyển dụng tại Hà Nam',
};

function cardText(card: ReturnType<typeof buildMandatoryCommentOutcomeCard>): string {
  return JSON.stringify(card);
}

describe('mandatory comment Feishu cards', () => {
  it('预授权卡为黄色等待态，不冒充发布成功', () => {
    const card = buildMandatoryCommentPreAuthorizationCard(base);
    assert.equal(card.header?.template, 'yellow');
    assert.match(card.header?.title.content ?? '', /预授权.*等待平台执行/);
    assert.doesNotMatch(card.header?.title.content ?? '', /已发布|成功/);
    assert.match(JSON.stringify(card), /不代表评论已经发布/);
  });

  it('只有 confirmed 终态为绿色平台确认', () => {
    const confirmed = buildMandatoryCommentOutcomeCard({ ...base, outcome: 'confirmed' });
    const pending = buildMandatoryCommentOutcomeCard({ ...base, outcome: 'pending', reason: 'pending_group_approval' });
    const failed = buildMandatoryCommentOutcomeCard({ ...base, outcome: 'failed', reason: 'risk:quota:minute' });
    const unknown = buildMandatoryCommentOutcomeCard({ ...base, outcome: 'unknown', reason: 'receipt_timeout' });
    assert.equal(confirmed.header?.template, 'green');
    assert.equal(pending.header?.template, 'yellow');
    assert.equal(failed.header?.template, 'red');
    assert.equal(unknown.header?.template, 'yellow');
    assert.match(cardText(pending), /尚未公开显示，不能算发布成功/);
    assert.match(cardText(unknown), /不会冒充成功，也不会自动重发/);
  });

  it('内部 reason 转成人话，不直接展示机器 token', () => {
    const card = buildMandatoryCommentOutcomeCard({ ...base, outcome: 'failed', reason: 'risk:quota:minute' });
    const text = cardText(card);
    assert.match(text, /每分钟评论限额/);
    assert.doesNotMatch(text, /risk:quota:minute/);
    assert.match(mandatoryCommentOutcomeReason('verification_ambiguous'), /不会冒充成功或自动重发/);
  });
});
