/**
 * 角色 prompt 只读预览（change role-prompt-visibility，Option A）。
 *
 * 忠实渲染：调浏览角色**真实的** `previewPrompt()`（其内部用最小示例数据 + 真实 this.soul 调既有 buildPrompt），
 * 把结果原样供后台只读查看——看到的就是线上真用的指令文字与人设（占位数据明示）。
 *
 * 安全不变量（红线）：
 * - 纯只读，无任何写路径。
 * - 单角色渲染失败 → `available:false` + 原因，绝不抛、绝不崩、绝不连累浏览/发布闭环（safePreview 兜底）。
 * - 不改任何角色 buildPrompt 的现有逻辑（只借 previewPrompt 读）。
 *
 * 本期范围：渲染**浏览侧**角色（scattered buildPrompt，运营最看不到的一批）；
 * 发布侧 prompt 集中于 `publish-agent/prompts.ts`（可直接读源码），本期诚实标注「待后续」，不伪造。
 */

import type { BaseRole } from '../agents/base-role.js';
import { getCatalogItem } from './role-catalog.js';
import type { RolePromptView } from '../panel/types.js';

const PLACEHOLDER_NOTE = '实时数据 / 人设为示例占位；线上调用时由系统填入真实值。';

interface Previewable {
  previewPrompt(): string;
}
function hasPreview(r: unknown): r is Previewable {
  return typeof (r as { previewPrompt?: unknown }).previewPrompt === 'function';
}

/** 单角色预览的安全包裹：渲染失败降级，绝不抛。 */
function safePreview(roleId: string, fn: () => string): RolePromptView {
  try {
    return { roleId, prompt: fn(), available: true, note: PLACEHOLDER_NOTE };
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
        return safePreview(roleId, () => inst.previewPrompt());
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
