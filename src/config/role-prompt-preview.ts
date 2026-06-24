/**
 * 角色 prompt 只读预览（change role-prompt-visibility，Option A；change prompt-viewer-persona-source 加人设来源标注）。
 *
 * 忠实渲染：调浏览角色**真实的** `previewPrompt()`（其内部用最小示例数据 + 真实 this.soul 调既有 buildPrompt），
 * 把结果原样供后台只读查看——看到的就是线上真用的指令文字与**真实人设**（实时数据为示例占位）。
 *
 * 人设来源标注（prompt-viewer-persona-source）：对实现了 `personaSegments()` 的角色，把渲染 prompt 拆成
 * 「角色段 / 人设段」交替返回（`segments`），供前端给人设段加底色。两道诚实闸——① 每个人设片段在
 * 渲染 prompt 里必须恰好出现一次（唯一定位）；② 切出的各段拼回必须逐字等于扁平 prompt。任一不过 →
 * 丢弃 `segments`、回落扁平不标记（**绝不瞎标 = 软性静默假成功**）。
 *
 * 安全不变量（红线）：
 * - 纯只读，无任何写路径。
 * - 单角色渲染 / 分段失败 → 回落（扁平 / available:false），绝不抛、绝不崩、绝不连累浏览/发布闭环。
 * - 不改任何角色 buildPrompt / previewPrompt 的现有逻辑（personaSegments 是并列的新增只读方法）。
 */

import type { BaseRole } from '../agents/base-role.js';
import { getCatalogItem } from './role-catalog.js';
import type { RolePromptView, RolePromptSegment } from '../panel/types.js';

const PLACEHOLDER_NOTE = '实时数据为示例占位（线上调用时由系统填入真实值）；人设为当前账号真实人设。';

interface Previewable {
  previewPrompt(): string;
}
function hasPreview(r: unknown): r is Previewable {
  return typeof (r as { previewPrompt?: unknown }).previewPrompt === 'function';
}

interface PersonaSegmented {
  personaSegments(): string[];
}
function hasPersonaSegments(r: unknown): r is PersonaSegmented {
  return typeof (r as { personaSegments?: unknown }).personaSegments === 'function';
}

/**
 * 把扁平 prompt 按人设片段拆成交替的「角色 / 人设」段。两道诚实闸不过 → 返回 null（回落扁平）。
 * 绝不伪造跨度：定位不唯一（0 或 >1 次）、片段重叠、拼接不等值，一律 null。
 */
export function segmentPromptByPersona(flat: string, personaSegs: readonly string[]): RolePromptSegment[] | null {
  const spans: Array<{ start: number; end: number }> = [];
  for (const seg of personaSegs) {
    if (!seg) return null; // 空片段 → 放弃（防误标）
    const first = flat.indexOf(seg);
    if (first === -1) return null; // 闸①：未找到
    if (flat.indexOf(seg, first + 1) !== -1) return null; // 闸①：出现 >1 次，定位不唯一
    spans.push({ start: first, end: first + seg.length });
  }
  if (spans.length === 0) return null;
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) return null; // 片段重叠 → 放弃
  }
  const out: RolePromptSegment[] = [];
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start > cursor) out.push({ source: 'role', text: flat.slice(cursor, sp.start) });
    out.push({ source: 'persona', text: flat.slice(sp.start, sp.end) });
    cursor = sp.end;
  }
  if (cursor < flat.length) out.push({ source: 'role', text: flat.slice(cursor) });
  // 闸②：拼接等值——切出的各段拼回必须逐字等于扁平 prompt。
  if (out.map((s) => s.text).join('') !== flat) return null;
  return out;
}

/** 单角色预览的安全包裹：渲染失败降级，绝不抛。成功时尽力附人设来源 segments（失败回落扁平）。 */
function safePreview(roleId: string, inst: Previewable): RolePromptView {
  try {
    const prompt = inst.previewPrompt();
    let segments: RolePromptSegment[] | undefined;
    if (hasPersonaSegments(inst)) {
      try {
        const segs = segmentPromptByPersona(prompt, inst.personaSegments());
        // 仅当确有人设段时才附 segments（全 role 段无意义）。
        if (segs && segs.some((s) => s.source === 'persona')) segments = segs;
      } catch {
        // 分段任何异常 → 回落扁平不标记（绝不连累 prompt 本体）。
        segments = undefined;
      }
    }
    return { roleId, prompt, available: true, note: PLACEHOLDER_NOTE, ...(segments ? { segments } : {}) };
  } catch (e) {
    return { roleId, prompt: null, available: false, note: `预览不可用：${(e as Error).message}` };
  }
}

export interface RolePromptProvider {
  /** 取某角色 prompt 只读预览。未知/非文本/无预览/失败 → available:false + 诚实 note。 */
  get(roleId: string): RolePromptView;
}

/**
 * @param getBrowseRoles 取已注册的浏览角色实例（经 RoleDispatcher.getRoles() 借读）。
 */
export function createRolePromptProvider(getBrowseRoles: () => readonly BaseRole[]): RolePromptProvider {
  return {
    get(roleId: string): RolePromptView {
      const item = getCatalogItem(roleId);
      if (!item) return { roleId, prompt: null, available: false, note: '未知角色' };
      if (item.llmKind !== 'text') {
        return {
          roleId,
          prompt: null,
          available: false,
          note: item.llmKind === 'image' ? '图像角色无文本 prompt（用全局图片模型）' : '该角色不调用大模型',
        };
      }
      if (item.group === 'browse') {
        const roleName = roleId.slice('browse:'.length);
        const inst = getBrowseRoles().find((r) => r.roleName === roleName);
        if (!inst || !hasPreview(inst)) {
          return { roleId, prompt: null, available: false, note: '该角色暂不支持预览' };
        }
        return safePreview(roleId, inst);
      }
      // 发布侧：prompt 集中在 publish-agent/prompts.ts，可直接读源码；本期后台暂只渲染浏览侧（诚实，不伪造）。
      return {
        roleId,
        prompt: null,
        available: false,
        note: '发布侧 prompt 集中于 publish-agent/prompts.ts，本期后台暂只渲染浏览侧；发布侧待后续',
      };
    },
  };
}
