/**
 * 极简 YAML 解析器（仅覆盖 soul.yaml 用到的子集）。
 *
 * 设计取舍：项目刻意保持零额外依赖（只用 pg / ws），故不引 js-yaml，
 * 自带一个面向本配置文件的解析器。支持的语法子集：
 * - 缩进表示嵌套 map（2 空格习惯，但按相对缩进判断）；
 * - 块状列表项 `- value` / `- key: value`（对象列表）；
 * - 标量：双引号字符串、整数、true/false；
 * - 行内流式数组 `[a, b, c]`（元素为标量）；
 * - `#` 行注释与行尾注释（引号内的 # 不算注释）。
 *
 * 不支持：锚点/别名、多行字符串块、单引号转义细节等（本配置用不到）。
 * 解析结果为普通 JS 值（对象/数组/字符串/数字/布尔），交给 loader 做强类型校验。
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface Line {
  indent: number;
  content: string;
  raw: string;
  lineNo: number;
}

/** 去掉行尾注释（保留引号内的 #）。返回去注释后的文本。 */
function stripComment(s: string): string {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === '#' && !inQuote) {
      // 注释前需是行首或空白，避免误伤 url 之类（本配置无，但稳妥）
      if (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t') return s.slice(0, i);
    }
  }
  return s;
}

/** 预处理：拆行、计算缩进、剔除空行与纯注释行。 */
function tokenize(text: string): Line[] {
  const out: Line[] = [];
  const rawLines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  rawLines.forEach((raw, idx) => {
    const noComment = stripComment(raw);
    const trimmedEnd = noComment.replace(/\s+$/, '');
    if (trimmedEnd.trim() === '') return; // 空行/纯注释
    const indent = trimmedEnd.length - trimmedEnd.replace(/^\s+/, '').length;
    out.push({
      indent,
      content: trimmedEnd.trim(),
      raw: trimmedEnd,
      lineNo: idx + 1,
    });
  });
  return out;
}

/** 解析标量：双引号字符串 / 数字 / 布尔 / null / 裸字符串。 */
function parseScalar(token: string): YamlValue {
  const t = token.trim();
  if (t === '') return '';
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    return parseFlowArray(t);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return Number.parseFloat(t);
  return t;
}

/** 解析行内流式数组 `[a, b, c]`（元素为标量）。 */
function parseFlowArray(token: string): YamlValue[] {
  const inner = token.slice(1, -1).trim();
  if (inner === '') return [];
  // 简单按逗号切分（标量不含逗号；引号内逗号本配置未用）
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let inQuote = false;
  for (const ch of inner) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === '[' && !inQuote) depth++;
    if (ch === ']' && !inQuote) depth--;
    if (ch === ',' && depth === 0 && !inQuote) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((p) => parseScalar(p.trim()));
}

/**
 * 递归解析一个由 lines[start..] 构成、缩进 >= minIndent 的块。
 * 返回 [解析值, 下一行索引]。
 */
function parseBlock(lines: Line[], start: number, minIndent: number): [YamlValue, number] {
  // 判断块类型：第一项以 "- " 开头 → 列表；否则 map
  const first = lines[start];
  if (first.content.startsWith('- ') || first.content === '-') {
    return parseList(lines, start, minIndent);
  }
  return parseMap(lines, start, minIndent);
}

function parseMap(lines: Line[], start: number, minIndent: number): [Record<string, YamlValue>, number] {
  const map: Record<string, YamlValue> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < minIndent) break;
    if (line.indent > minIndent) {
      throw new Error(`YAML 缩进异常（行 ${line.lineNo}）: ${line.raw}`);
    }
    const colon = findColon(line.content);
    if (colon === -1) {
      throw new Error(`YAML map 行缺少冒号（行 ${line.lineNo}）: ${line.content}`);
    }
    const key = line.content.slice(0, colon).trim();
    const rest = line.content.slice(colon + 1).trim();
    if (rest !== '') {
      map[key] = parseScalar(rest);
      i++;
    } else {
      // 值在后续更深缩进的块里
      const next = lines[i + 1];
      if (!next || next.indent <= minIndent) {
        map[key] = null;
        i++;
      } else {
        const [val, nextI] = parseBlock(lines, i + 1, next.indent);
        map[key] = val;
        i = nextI;
      }
    }
  }
  return [map, i];
}

function parseList(lines: Line[], start: number, minIndent: number): [YamlValue[], number] {
  const arr: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < minIndent) break;
    if (line.indent > minIndent) {
      throw new Error(`YAML 列表缩进异常（行 ${line.lineNo}）: ${line.raw}`);
    }
    if (!line.content.startsWith('-')) break;
    const itemBody = line.content.slice(1).trim();
    if (itemBody === '') {
      // "-" 单独一行，子块在下一行
      const next = lines[i + 1];
      if (next && next.indent > minIndent) {
        const [val, nextI] = parseBlock(lines, i + 1, next.indent);
        arr.push(val);
        i = nextI;
      } else {
        arr.push(null);
        i++;
      }
      continue;
    }
    const colon = findColon(itemBody);
    if (colon !== -1) {
      // 列表项是一个内联起始的对象：`- key: value`
      // 该对象的后续键缩进 = 列表项缩进 + 2（"- " 宽度）
      const childIndent = line.indent + 2;
      const synthetic: Line[] = [];
      // 把当前行的 "key: value" 作为对象第一行
      synthetic.push({
        indent: childIndent,
        content: itemBody,
        raw: itemBody,
        lineNo: line.lineNo,
      });
      // 收集后续属于该对象的行（缩进 >= childIndent）
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= childIndent) {
        synthetic.push(lines[j]);
        j++;
      }
      const [obj] = parseMap(synthetic, 0, childIndent);
      arr.push(obj);
      i = j;
    } else {
      arr.push(parseScalar(itemBody));
      i++;
    }
  }
  return [arr, i];
}

/** 找到 map 行的分隔冒号位置（跳过引号内冒号；要求冒号后为空白或行尾）。 */
function findColon(s: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      const next = s[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

/** 解析 YAML 文本为 JS 值（顶层为 map）。 */
export function parseYaml(text: string): YamlValue {
  const lines = tokenize(text);
  if (lines.length === 0) return {};
  const baseIndent = lines[0].indent;
  const [val] = parseBlock(lines, 0, baseIndent);
  return val;
}

