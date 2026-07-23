import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWritingLanguage, writingLanguageInstruction } from '../src/kernel/writing-language.js';

test('writing-language guard 对中文、英文、越南语给出保守三态结论', () => {
  assert.equal(checkWritingLanguage('这是一段自然的中文内容。', 'zh-CN'), 'match');
  assert.equal(checkWritingLanguage('This is a natural English sentence.', 'en'), 'match');
  assert.equal(checkWritingLanguage('Cảm ơn bạn, bài viết rất hữu ích.', 'vi'), 'match');

  assert.equal(checkWritingLanguage('This should not pass the Chinese guard.', 'zh-CN'), 'mismatch');
  assert.equal(checkWritingLanguage('这不应通过英文检查。', 'en'), 'mismatch');
  assert.equal(checkWritingLanguage('This could be Vietnamese without accents', 'vi'), 'uncertain');
  assert.equal(checkWritingLanguage('ok', 'en'), 'uncertain');
});

test('writing-language prompt 明确从初稿自然创作，不允许末端翻译', () => {
  assert.match(writingLanguageInstruction('vi'), /越南语自然表达/);
  assert.match(writingLanguageInstruction('vi'), /不得先用其它语言成稿后再翻译/);
});
