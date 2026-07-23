/**
 * 角色 prompt 只读预览（change role-prompt-visibility，Option A；change prompt-viewer-persona-source 加人设来源标注）。
 *
 * 忠实渲染：调浏览角色**真实的** `previewPrompt()`（其内部用最小示例数据 + 真实 this.soul 调既有 buildPrompt），
 * 把结果原样供后台只读查看——看到的就是线上真用的指令文字与人设口径（实时数据为示例占位）。
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
import type { Soul } from '../kernel/soul-types.js';
import { getCatalogItem } from './role-catalog.js';
import { PUBLISH_PREVIEW_BUILDERS, IMAGE_PROMPT_PREVIEW_BUILDERS } from '../publish-agent/prompts-preview.js';
import { STATIC_ROLE_PROMPT_PREVIEWS } from './static-role-prompt-previews.js';
import type { RolePromptView, RolePromptSegment } from '../panel/types.js';

const SAMPLE_PERSONA_NOTE = '实时数据为示例占位（线上调用时由系统填入真实值）；人设为示例人设。';
const ACCOUNT_PERSONA_NOTE = '实时数据为示例占位（线上调用时由系统填入真实值）；人设来自所选账号。';
// 发布侧忠实渲染的说明：默认用示例输入 + 示例人设；选账号时预览提供方可替换为该账号人设。
const PUBLISH_PLACEHOLDER_NOTE = '实时数据为示例占位（线上调用时由系统填入真实值）；发布侧预览使用示例人设。';
const PUBLISH_ACCOUNT_NOTE = '实时数据为示例占位（线上调用时由系统填入真实值）；发布侧预览已使用所选账号人设。';
// 图像角色的图片指令说明（change publish-prompt-preview 补图片类）。
const IMAGE_PREVIEW_NOTE =
  '发给文生图模型的图片指令（非大模型文本 prompt）：主体由「配图指令」角色按正文产出（此处为示例），系统统一追加下方固定风格基底；配图用全局图片模型生成。';

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

type PersonaSource = NonNullable<RolePromptView['personaSource']>;

function withPersonaSource(view: RolePromptView, source: PersonaSource, label: string, note?: string): RolePromptView {
  if (!view.available) return view;
  return {
    ...view,
    ...(note ? { note } : {}),
    personaSource: source,
    personaSourceLabel: label,
  };
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
    return { roleId, prompt, available: true, note: SAMPLE_PERSONA_NOTE, ...(segments ? { segments } : {}) };
  } catch (e) {
    return { roleId, prompt: null, available: false, note: `预览不可用：${(e as Error).message}` };
  }
}

export interface RolePromptProvider {
  /**
   * 取某角色 prompt 只读预览。未知/非文本/无预览/失败 → available:false + 诚实 note。
   * 可选 accountId（change prompt-preview-persona-selector）：给定则按该账号人设渲染、回显账号 +
   * 无人设行时诚实标注回落示例人设；缺省则按示例人设（行为与扩展前兼容）。
   */
  get(roleId: string, accountId?: string): RolePromptView;
}

/**
 * 预览的账号口径注入（change prompt-preview-persona-selector）。两者皆缺省 → 退化为「恒示例人设」行为。
 */
export interface RolePromptProviderOptions {
  /**
   * 在选定账号口径下同步执行 fn（切预览 dispatcher 当前账号 → 同步渲染 → finally 还原）。
   * 渲染全程同步、Node 单线程，单次调用内无 await/无交错，故「切—还原」对并发预览原子安全。
   */
  withAccount?: <T>(accountId: string, fn: () => T) => T;
  /** 该账号是否真有人设行（不回落判定，用于诚实回落标注）；缺省视为「无从判定」→ 不标 fallback。 */
  hasPersona?: (accountId: string) => boolean;
  /** 取选定账号的真实人设；返回 null 表示无人设，发布侧预览回落示例人设并诚实标注。 */
  getPersona?: (accountId: string) => Soul | null;
}

const FALLBACK_NOTE = '该账号未绑定人设（运行会被诚实拒绝，no_persona）；此预览按示例人设渲染、仅供查看；实时数据为示例占位（线上调用时由系统填入真实值）。';

/**
 * @param getBrowseRoles 取已注册的浏览角色实例（经 RoleDispatcher.getRoles() 借读）。
 * @param opts 账号口径注入（可选）：给定 withAccount/hasPersona 才支持 accountId 维度预览。
 */
export function createRolePromptProvider(
  getBrowseRoles: () => readonly BaseRole[],
  opts: RolePromptProviderOptions = {},
): RolePromptProvider {
  // 单角色渲染（不含账号口径切换）：未知/非文本/无预览/失败 → available:false + 诚实 note。
  const render = (roleId: string, publishSoul?: Soul): RolePromptView => {
    const item = getCatalogItem(roleId);
    if (!item) return { roleId, prompt: null, available: false, note: '未知角色' };
    // 不依赖 RoleDispatcher 的 interaction、独立 browse、发布文本与 vision 角色。
    // 每个闭包都调用运行时共享 prompt builder；预览只注入明示示例数据，绝不触发模型或读取业务图片。
    const staticPreview = STATIC_ROLE_PROMPT_PREVIEWS[roleId];
    if (staticPreview) {
      try {
        const prompt = staticPreview.build(publishSoul);
        if (!prompt.trim()) throw new Error('empty prompt');
        return {
          roleId,
          prompt,
          available: true,
          note: staticPreview.note,
          ...(staticPreview.usesPersona
            ? {}
            : { personaSource: 'none' as const, personaSourceLabel: '不使用人设' }),
        };
      } catch (e) {
        return { roleId, prompt: null, available: false, note: `预览不可用：${(e as Error).message}` };
      }
    }
    if (item.llmKind !== 'text') {
      // 图像角色（change publish-prompt-preview 补图片类）：展示发给文生图模型的「有效图片指令」
      // （示例主体 + 固定风格基底）；无预览闭包时回落旧「无文本 prompt」说明。
      if (item.llmKind === 'image') {
        const buildImg = IMAGE_PROMPT_PREVIEW_BUILDERS[roleId];
        if (!buildImg) {
          return { roleId, prompt: null, available: false, note: '图像角色无文本 prompt（用全局图片模型）' };
        }
        try {
          return {
            roleId,
            prompt: buildImg(),
            available: true,
            note: IMAGE_PREVIEW_NOTE,
            personaSource: 'none',
            personaSourceLabel: '不使用人设',
          };
        } catch (e) {
          return { roleId, prompt: null, available: false, note: `预览不可用：${(e as Error).message}` };
        }
      }
      if (item.llmKind === 'vision') {
        return { roleId, prompt: null, available: false, note: '该视觉模型角色暂不支持预览' };
      }
      return { roleId, prompt: null, available: false, note: '该角色不调用大模型' };
    }
    if (item.group === 'browse') {
      const roleName = roleId.slice('browse:'.length);
      const inst = getBrowseRoles().find((r) => r.roleName === roleName);
      if (!inst || !hasPreview(inst)) {
        return { roleId, prompt: null, available: false, note: '该角色暂不支持预览' };
      }
      return safePreview(roleId, inst);
    }
    // 发布侧文本角色（change publish-prompt-preview）：用示例输入调既有 build*Prompt 忠实渲染；
    // 可由账号口径传入真实人设替换示例人设。渲染抛错优雅降级、绝不连累发布闭环。
    const buildPreview = PUBLISH_PREVIEW_BUILDERS[roleId];
    if (!buildPreview) {
      return { roleId, prompt: null, available: false, note: '该角色暂不支持预览' };
    }
    try {
      return { roleId, prompt: buildPreview(publishSoul), available: true, note: PUBLISH_PLACEHOLDER_NOTE };
    } catch (e) {
      return { roleId, prompt: null, available: false, note: `预览不可用：${(e as Error).message}` };
    }
  };

  return {
    get(roleId: string, accountId?: string): RolePromptView {
      // 无 accountId 或未注入 withAccount → 示例人设预览，不附账号字段。
      if (!accountId || !opts.withAccount) {
        const view = render(roleId);
        const item = getCatalogItem(roleId);
        const staticPreview = STATIC_ROLE_PROMPT_PREVIEWS[roleId];
        if (staticPreview?.usesPersona) return withPersonaSource(view, 'sample', '示例人设');
        if (item?.llmKind !== 'text' || staticPreview) return view;
        return withPersonaSource(view, 'sample', item.group === 'publish' ? '发布侧示例人设' : '示例人设');
      }
      const staticPreview = STATIC_ROLE_PROMPT_PREVIEWS[roleId];
      // 不消费 persona 的静态预览不得因账号选择伪造来源或 fallback。
      if (staticPreview && !staticPreview.usesPersona) return render(roleId);
      // Facebook 定向评论等独立角色虽不进 dispatcher，但运行时确实读取 Soul；按真实/示例 persona 口径渲染。
      if (staticPreview?.usesPersona) {
        const persona = opts.getPersona?.(accountId) ?? null;
        const fallback = !!opts.getPersona && persona == null;
        const view = render(roleId, persona ?? undefined);
        return {
          ...withPersonaSource(
            view,
            fallback ? 'fallback_sample' : 'account',
            fallback ? '示例人设' : '所选账号人设',
            fallback ? FALLBACK_NOTE : ACCOUNT_PERSONA_NOTE,
          ),
          accountId,
          ...(fallback ? { personaFallback: true } : {}),
        };
      }
      const pubItem = getCatalogItem(roleId);
      if (pubItem?.group === 'publish') {
        // 图像角色无人设，保留其自身图片指令说明。
        if (pubItem.llmKind !== 'text') return render(roleId);
        const persona = opts.getPersona?.(accountId) ?? null;
        const fallback = !!opts.getPersona && persona == null;
        const pubView = render(roleId, persona ?? undefined);
        return {
          ...withPersonaSource(
            pubView,
            fallback ? 'fallback_sample' : 'account',
            fallback ? '示例人设' : '所选账号人设',
            fallback ? FALLBACK_NOTE : PUBLISH_ACCOUNT_NOTE,
          ),
          accountId,
          ...(fallback ? { personaFallback: true } : {}),
        };
      }
      if (!opts.withAccount) return render(roleId);
      // 选定账号口径：切预览账号 → 同步渲染 → finally 还原（由 withAccount 保证，含渲染抛错路径）。
      const view = opts.withAccount(accountId, () => render(roleId));
      // 诚实标注（persona-driven-content-pipeline：default 账号已删、不再特判）：无人设行即标 personaFallback
      // ——该账号运行会被诚实拒绝，预览仅按示例人设渲染供查看。
      const fallback = !!opts.hasPersona && !opts.hasPersona(accountId);
      return {
        ...withPersonaSource(
          view,
          fallback ? 'fallback_sample' : 'account',
          fallback ? '示例人设' : '所选账号人设',
          fallback ? FALLBACK_NOTE : ACCOUNT_PERSONA_NOTE,
        ),
        accountId,
        ...(fallback ? { personaFallback: true } : {}),
      };
    },
  };
}
