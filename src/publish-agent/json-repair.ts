/**
 * LLM JSON 输出修复：转义字符串字面量【内部】的裸控制字符。
 *
 * 背景：doubao 等模型生成含多行正文的 JSON 时，常把换行/制表符**不转义**直接放进字符串
 * （`{"content":"第一行\n第二行"}` 写成真实换行），JSON.parse 报
 * "Bad control character in string literal"——正文创作切 doubao 后发帖必炸。
 *
 * 语义红线：只修「JSON 信封」的编码，不改一字内容、不补不猜；引号外的结构性空白原样保留；
 * 修复后仍解析失败 → 由调用方照旧抛错诚实中止（绝不伪造产出）。
 */
export function escapeControlCharsInJsonStrings(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}
