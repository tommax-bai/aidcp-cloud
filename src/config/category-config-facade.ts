/**
 * 分类默认模型面板外观（change role-model-category-config，item 5/6）。
 *
 * 复刻 role-config-facade 形态：把「分类目录 + 生效值视图」与「按分类写（白名单 + 保存前探活）」
 * 收口成一个可单测的外观，探活以闭包注入（测试可打桩）。
 *
 * 红线：非空模型名探活不过 → 拒绝写入、报因 model_invalid，绝不落库、绝不假成功。
 * 白名单：只暴露含 ≥1 文本角色的分类（纯图像分类不开放文本默认）。
 */

import {
  CATEGORY_CATALOG,
  isKnownCategory,
  isCategoryModelConfigurable,
} from './role-catalog.js';
import type { CategoryConfigStore } from './category-config-store.js';
import type {
  PanelCategoryConfig,
  CategoryConfigCatalogView,
  CategoryConfigSetResult,
} from '../panel/types.js';

export interface CategoryConfigFacadeDeps {
  store: CategoryConfigStore;
  /** 当前全局文本模型名（分类无覆盖时的回落，即「默认模型」）。 */
  getGlobalTextModel: () => string;
  /** 保存前探活：模型不可用时抛错（不抛 = 可用）。 */
  probeModel: (model: string) => Promise<void>;
}

export function createCategoryConfigPanel(deps: CategoryConfigFacadeDeps): PanelCategoryConfig {
  const buildCatalog = (): CategoryConfigCatalogView => {
    const textModel = deps.getGlobalTextModel();
    return {
      categories: CATEGORY_CATALOG.filter((c) => isCategoryModelConfigurable(c.categoryId))
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((c) => {
          const row = deps.store.getAll().get(c.categoryId);
          const ovModel = row?.model?.trim() || null;
          return {
            categoryId: c.categoryId,
            displayName: c.displayName,
            order: c.order,
            // 分类默认模型：覆盖则用覆盖、否则回落全局「默认模型」。
            effectiveModel: ovModel || textModel,
            modelOverridden: !!ovModel,
            updatedAt: row?.updatedAt ?? null,
            updatedBy: row?.updatedBy ?? null,
          };
        }),
    };
  };

  return {
    getCatalog: buildCatalog,
    setCategoryConfig: async (categoryId, model, updatedBy): Promise<CategoryConfigSetResult> => {
      if (!isKnownCategory(categoryId)) return { ok: false, reason: 'unknown_category' };
      if (!isCategoryModelConfigurable(categoryId)) {
        return { ok: false, reason: 'category_not_configurable' };
      }
      const wantsModel = model !== null && (model ?? '').trim() !== '';
      // 非空模型名：保存前探活；不过则拒，绝不落库（红线：绝不静默假成功）。
      if (wantsModel) {
        try {
          await deps.probeModel((model as string).trim());
        } catch {
          return { ok: false, reason: 'model_invalid' };
        }
      }
      await deps.store.set(categoryId, model, updatedBy);
      return { ok: true, view: buildCatalog() };
    },
  };
}
