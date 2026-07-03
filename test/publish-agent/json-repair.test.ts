import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { escapeControlCharsInJsonStrings } from '../../src/publish-agent/json-repair.js';

describe('escapeControlCharsInJsonStrings（doubao 裸换行 JSON 修复）', () => {
  test('字符串内部裸换行/制表符被转义，parse 通过且内容逐字保留', () => {
    const raw = '{"title": "t", "content": "第一行\n第二行\t缩进", "tone": "casual"}';
    assert.throws(() => JSON.parse(raw), '修复前应确实无法 parse');
    const obj = JSON.parse(escapeControlCharsInJsonStrings(raw));
    assert.equal(obj.content, '第一行\n第二行\t缩进', '内容逐字保留（只修信封不改内容）');
  });

  test('引号外的结构性空白原样保留（美化排版 JSON 不被破坏）', () => {
    const raw = '{\n  "a": "x",\n  "b": "y"\n}';
    assert.equal(escapeControlCharsInJsonStrings(raw), raw);
    assert.deepEqual(JSON.parse(escapeControlCharsInJsonStrings(raw)), { a: 'x', b: 'y' });
  });

  test('已合法转义的序列不被二次转义', () => {
    const raw = '{"content": "行一\\n行二，引号\\"内\\""}';
    assert.equal(escapeControlCharsInJsonStrings(raw), raw);
    assert.equal(JSON.parse(raw).content, JSON.parse(escapeControlCharsInJsonStrings(raw)).content);
  });

  test('其他控制字符转成 \\uXXXX', () => {
    const raw = '{"c": "ab"}';
    const fixed = escapeControlCharsInJsonStrings(raw);
    assert.match(fixed, /\\u0001/);
    assert.equal(JSON.parse(fixed).c, 'ab');
  });

  test('转义反斜杠后跟引号不误判字符串边界', () => {
    const raw = '{"path": "C:\\\\dir\n次行"}';
    const obj = JSON.parse(escapeControlCharsInJsonStrings(raw));
    assert.equal(obj.path, 'C:\\dir\n次行');
  });
});
