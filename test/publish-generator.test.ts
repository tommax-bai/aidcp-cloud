import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContentGenerator,
  buildSystemPrompt,
  buildUserPrompt,
  buildRewritePrompt,
  parseGenerateOutput,
  BANNED_PHRASES,
} from '../src/publish/index.js';
import type { ChatModel } from '../src/publish/index.js';
import type { GenerateInput } from '../src/publish/index.js';
import type { Soul } from '../src/soul/index.js';
import type { QwenChatMessage } from '../src/llm/index.js';

const soul: Soul = {
  identity: { name: '小林', role: 'AI研发', background: '3年', tone: '理性' },
  interests: { primary: ['LLM'], secondary: [], seed_keywords: ['RAG'] },
  engagement_rules: {
    like: [], skip: [], comment_trigger: [],
  },
  browse_patterns: {
    mode: 'state_machine',
    states: { browse: { action: 'x', transitions: [] } },
    session: { max_duration_min: 10, max_likes: 8, max_searches: 3, cooldown_between_actions_sec: [3, 8] },
  },
};

const input: GenerateInput = {
  concepts: [{ keyword: 'RAG 重排', sourceNote: '某篇笔记' }, { keyword: 'vLLM 量化' }],
  likedContents: [{ id: 7, title: 'RAG 实战', summary: '分块很关键', author: '老王' }],
  soul,
  recentPosts: ['上次聊了 prompt 技巧'],
};

test('buildSystemPrompt 含人设/禁用词/范文/反例/输出格式', () => {
  const p = buildSystemPrompt();
  assert.match(p, /小林/);
  assert.match(p, /禁止/);
  for (const w of ['首先', '众所周知', '综上所述']) assert.ok(p.includes(w));
  assert.match(p, /范文/);
  assert.match(p, /反例/);
  assert.match(p, /不要这样写/);
  assert.match(p, /JSON/);
  assert.match(p, /tags/);
});

test('buildUserPrompt 注入概念/点赞内容/最近帖子', () => {
  const p = buildUserPrompt(input);
  assert.match(p, /RAG 重排/);
  assert.match(p, /某篇笔记/);
  assert.match(p, /vLLM 量化/);
  assert.match(p, /RAG 实战/);
  assert.match(p, /分块很关键/);
  assert.match(p, /老王/);
  assert.match(p, /prompt 技巧/);
});

test('buildUserPrompt 空素材有占位', () => {
  const p = buildUserPrompt({ concepts: [], likedContents: [], soul, recentPosts: [] });
  assert.match(p, /暂无新概念/);
  assert.match(p, /暂无点赞内容/);
});

test('buildRewritePrompt 列出命中词并要求替换', () => {
  const p = buildRewritePrompt('首先这样，其次那样', ['首先', '其次']);
  assert.match(p, /首先/);
  assert.match(p, /其次/);
  assert.match(p, /重写/);
});

test('parseGenerateOutput 解析含围栏的 JSON', () => {
  const o = parseGenerateOutput('```json\n{"title":"标题","content":"正文内容","tags":["a","b"]}\n```');
  assert.equal(o.title, '标题');
  assert.equal(o.content, '正文内容');
  assert.deepEqual(o.tags, ['a', 'b']);
});

test('parseGenerateOutput 过滤空标签', () => {
  const o = parseGenerateOutput('{"title":"t","content":"c","tags":["x","",2,"y"]}');
  assert.deepEqual(o.tags, ['x', 'y']);
});

test('parseGenerateOutput 缺 content → 抛错', () => {
  assert.throws(() => parseGenerateOutput('{"title":"t","tags":[]}'));
});

test('parseGenerateOutput 非 JSON → 抛错', () => {
  assert.throws(() => parseGenerateOutput('我不知道怎么写'));
});

test('ContentGenerator.generate 用 mock model，system+user 两条消息，解析输出', async () => {
  let captured: QwenChatMessage[] = [];
  const model: ChatModel = {
    chat: async (msgs) => {
      captured = msgs;
      return '{"title":"调 RAG 踩坑","content":"昨天分块切碎了召回一坨","tags":["RAG","踩坑"]}';
    },
  };
  const gen = new ContentGenerator({ model });
  const out = await gen.generate(input);
  assert.equal(captured.length, 2);
  assert.equal(captured[0].role, 'system');
  assert.equal(captured[1].role, 'user');
  assert.match(captured[1].content, /RAG 重排/);
  assert.equal(out.title, '调 RAG 踩坑');
  assert.deepEqual(out.tags, ['RAG', '踩坑']);
});

test('ContentGenerator.rewrite 用 mock model 重写并解析', async () => {
  const model: ChatModel = {
    chat: async () => '{"title":"t","content":"重写后的口语正文","tags":["a"]}',
  };
  const gen = new ContentGenerator({ model });
  const out = await gen.rewrite('首先...其次...', ['首先', '其次']);
  assert.equal(out.content, '重写后的口语正文');
});

test('BANNED_PHRASES 全部出现在 system prompt', () => {
  const p = buildSystemPrompt();
  for (const w of BANNED_PHRASES) assert.ok(p.includes(w), `system prompt 应含禁用词 ${w}`);
});