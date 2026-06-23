/**
 * 角色配置面板外观（change console-role-model-config）。
 *
 * 把「角色目录 + 生效值视图」与「按角色写（校验 + 保存前探活）」收口成一个可单测的外观，
 * 与 server 装配解耦：探活以闭包注入（测试可打桩），不在此直接持有 LLM 客户端。
 *
 * 红线：非空模型名探活不过 → 拒绝写入、报因，绝不落库、绝不假成功。
 * 白名单：只暴露 ROLE_CATALOG 内的现役 LLM 角色；图像/none 不可 per-role 配模型；温度仅可调温度角色。
 */

import { ROLE_CATALOG, getCatalogItem, isModelConfigurable } from './role-catalog.js';
import type { RoleConfigStore } from './role-config-store.js';
import type {
  PanelRoleConfig,
  RoleConfigCatalogView,
  RoleConfigSetResult,
} from '../panel/types.js';

export interface RoleConfigFacadeDeps {
  store: RoleConfigStore;
  /** 当前全局文本模型名（回落用，即「默认模型」）。 */
  getGlobalTextModel: () => string;
  /** 当前全局图片模型名（图像角色生效值展示用）。 */
  getGlobalImageModel: () => string;
  /** 某分类的默认模型覆盖（null=分类无覆盖）；用于计算「继承分类」生效来源。 */
  getCategoryModel: (categoryId: string) => string | null;
  /** 保存前探活：模型不可用时抛错（不抛 = 可用）。 */
  probeModel: (model: string) => Promise<void>;
}

export function createRoleConfigPanel(deps: RoleConfigFacadeDeps): PanelRoleConfig {
  const buildCatalog = (): RoleConfigCatalogView => {
    const textModel = deps.getGlobalTextModel();
    const imageModel = deps.getGlobalImageModel();
    return {
      roles: ROLE_CATALOG.map((item) => {
        const row = deps.store.getAll().get(item.roleId);
        const ovModel = row?.model?.trim() || null;
        // 生效模型 + 来源：四层回落（覆盖 → 分类默认 → 全局默认 → 代码默认）；图像类走全局 imageModel。
        const catModel = item.llmKind === 'text' ? deps.getCategoryModel(item.category) : null;
        let effectiveModel: string;
        let effectiveSource: 'override' | 'category' | 'default' | 'image';
        if (item.llmKind === 'image') {
          effectiveModel = imageModel;
          effectiveSource = 'image';
        } else if (ovModel) {
          effectiveModel = ovModel;
          effectiveSource = 'override';
        } else if (catModel) {
          effectiveModel = catModel;
          effectiveSource = 'category';
        } else {
          effectiveModel = textModel;
          effectiveSource = 'default';
        }
        return {
          roleId: item.roleId,
          displayName: item.displayName,
          group: item.group,
          category: item.category,
          llmKind: item.llmKind,
          tunableTemperature: item.tunableTemperature,
          effectiveModel,
          effectiveSource,
          modelOverridden: item.llmKind === 'text' && !!ovModel,
          temperatureOverride: row?.temperature ?? null,
          updatedAt: row?.updatedAt ?? null,
          updatedBy: row?.updatedBy ?? null,
        };
      }),
    };
  };

  return {
    getCatalog: buildCatalog,
    setRoleConfig: async (roleId, patch, updatedBy): Promise<RoleConfigSetResult> => {
      const item = getCatalogItem(roleId);
      if (!item) return { ok: false, reason: 'unknown_role' };

      const wantsModel = patch.model !== undefined && (patch.model ?? '').trim() !== '';
      if (wantsModel && !isModelConfigurable(roleId)) {
        return { ok: false, reason: 'model_not_configurable' };
      }
      if (patch.temperature !== undefined && patch.temperature !== null) {
        if (!item.tunableTemperature) return { ok: false, reason: 'temperature_not_tunable' };
        if (!(patch.temperature >= 0 && patch.temperature <= 1)) {
          return { ok: false, reason: 'temperature_out_of_range' };
        }
      }

      // 非空模型名：保存前探活；不过则拒，绝不落库（红线：绝不静默假成功）。
      if (wantsModel) {
        try {
          await deps.probeModel((patch.model as string).trim());
        } catch {
          return { ok: false, reason: 'model_invalid' };
        }
      }

      await deps.store.set(roleId, patch, updatedBy);
      return { ok: true, view: buildCatalog() };
    },
  };
}
