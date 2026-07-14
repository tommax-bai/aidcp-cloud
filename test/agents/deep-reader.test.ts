import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { DeepReader } from '../../src/agents/deep-reader.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';
import type { ReadingBrowseImagesPayload, ReadingImagesDonePayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

const note: NoteData = { noteId: 'note_1', title: 't', content: '正文内容', likeCount: 10, collectCount: 2 };
const getNote = (_id: string): NoteData | null => note;

describe('DeepReader（多图判定）', () => {
  it('决定看图 → emit reading.browse_images；收到 browse_images 回执 → emit reading.images_done', () => {
    const bus = new EventBus();
    // random=0 → 必然 < 概率门 → 看图
    const role = new DeepReader({ eventBus: bus, soul: mockSoul, getNoteData: getNote, random: () => 0 });
    role.subscribe();

    let intent = null as ReadingBrowseImagesPayload | null;
    let done = null as ReadingImagesDonePayload | null;
    let doneCount = 0;
    bus.on('reading.browse_images', (p) => { intent = p; });
    bus.on('reading.images_done', (p) => { done = p; doneCount++; });

    bus.emit('quality.pass', { noteId: 'note_1', sourcePageType: 'feed', reason: 'ok', ts: Date.now() });

    assert.ok(intent, '应 emit reading.browse_images');
    assert.equal(intent!.noteId, 'note_1');
    assert.ok(intent!.count > 0);
    assert.ok(intent!.count > 3, '短图文不应固定只看 3 张');
    assert.equal(doneCount, 0, '回执到达前不应 emit reading.images_done');

    // 模拟边缘 browse_images 完成回执
    bus.emit('action.completed', { action: 'browse_images', ok: true, reason: 'browsed=4', ts: Date.now() });
    assert.ok(done, '回执后应 emit reading.images_done');
    assert.equal(done!.noteId, 'note_1');
    assert.equal(done!.imagesBrowsed, 4, '应按边缘真实 browsed=N 入账');

    role.unsubscribe();
  });

  it('高互动图文 → 给足看完上限，由边缘按真实总数截断', () => {
    const bus = new EventBus();
    const high: NoteData = { noteId: 'note_1', title: 't', content: '短正文', likeCount: 500, collectCount: 120 };
    const role = new DeepReader({ eventBus: bus, soul: mockSoul, getNoteData: () => high, random: () => 0 });
    role.subscribe();

    let intent = null as ReadingBrowseImagesPayload | null;
    bus.on('reading.browse_images', (p) => { intent = p; });

    bus.emit('quality.pass', { noteId: 'note_1', sourcePageType: 'feed', reason: 'ok', ts: Date.now() });

    assert.ok(intent, '应 emit reading.browse_images');
    assert.equal(intent!.count, 18);

    role.unsubscribe();
  });

  it('决定不看图 → 直接 emit reading.images_done(imagesBrowsed=0)', () => {
    const bus = new EventBus();
    // random=0.99 → 不看图
    const role = new DeepReader({ eventBus: bus, soul: mockSoul, getNoteData: getNote, random: () => 0.99 });
    role.subscribe();

    let intentCount = 0;
    let done = null as ReadingImagesDonePayload | null;
    bus.on('reading.browse_images', () => { intentCount++; });
    bus.on('reading.images_done', (p) => { done = p; });

    bus.emit('quality.pass', { noteId: 'note_1', sourcePageType: 'search', reason: 'ok', ts: Date.now() });

    assert.equal(intentCount, 0, '不看图时不应 emit reading.browse_images');
    assert.ok(done, '应直接 emit reading.images_done');
    assert.equal(done!.sourcePageType, 'search');
    assert.equal(done!.imagesBrowsed, 0);

    role.unsubscribe();
  });

  it('browse_images 失败回执 → 仍 emit reading.images_done(imagesBrowsed=0)，不卡死', () => {
    const bus = new EventBus();
    const role = new DeepReader({ eventBus: bus, soul: mockSoul, getNoteData: getNote, random: () => 0 });
    role.subscribe();

    let done = null as ReadingImagesDonePayload | null;
    bus.on('reading.images_done', (p) => { done = p; });

    bus.emit('quality.pass', { noteId: 'note_1', sourcePageType: 'feed', reason: 'ok', ts: Date.now() });
    bus.emit('action.completed', { action: 'browse_images', ok: false, reason: 'no_target', ts: Date.now() });

    assert.ok(done, '失败回执也应推进');
    assert.equal(done!.imagesBrowsed, 0);

    role.unsubscribe();
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const role = new DeepReader({ eventBus: bus, soul: mockSoul, getNoteData: getNote, random: () => 0 });
    role.subscribe();
    role.unsubscribe();

    let emitted = false;
    bus.on('reading.browse_images', () => { emitted = true; });
    bus.on('reading.images_done', () => { emitted = true; });

    bus.emit('quality.pass', { noteId: 'note_1', sourcePageType: 'feed', reason: 'ok', ts: Date.now() });
    assert.equal(emitted, false);
  });

  // change platform-vocabulary-and-thresholds：空正文帖（如 Facebook 图片帖常无正文）按图文主导处理（提高翻图概率），
  // 不再被旧 `textLen > 0` 守卫误判为「长正文」低翻图。random=0.5 下：图文主导概率(0.7)>0.5 ⇒ 翻图；旧逻辑长正文概率(0.4)<0.5 ⇒ 不翻。
  it('空正文帖 + random=0.5 → 按图文主导翻图（旧逻辑会误判长正文而不翻）', () => {
    const bus = new EventBus();
    const emptyBody: NoteData = { noteId: 'note_1', title: 't', content: '', likeCount: 10, collectCount: 0 };
    const role = new DeepReader({ eventBus: bus, soul: mockSoul, getNoteData: () => emptyBody, random: () => 0.5 });
    role.subscribe();

    let intent = null as ReadingBrowseImagesPayload | null;
    bus.on('reading.browse_images', (p) => { intent = p; });
    bus.emit('quality.pass', { noteId: 'note_1', sourcePageType: 'feed', reason: 'ok', ts: Date.now() });

    assert.ok(intent, '空正文按图文主导 ⇒ 翻图概率高于阈值 ⇒ emit reading.browse_images');
    role.unsubscribe();
  });
});
