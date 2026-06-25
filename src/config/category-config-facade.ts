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
import { normProvider, ProviderKeyMissingError } from '../llm/index.js';
import type {
  PanelCategoryConfig,
  CategoryConfigCatalogView,
  CategoryConfigSetResult,
} from '../panel/types.js';

export interface CategoryConfigFacadeDeps {
  store: CategoryConfigStore;
  /** 当前全局文本模型名（分类无覆盖时的回落，即「默认模型」）。 */
  getGlobalTextModel: () => string;
  /** 当前全局文本厂商（change model-config-volcengine-provider）：分类无覆盖时回落的生效厂商。 */
  getGlobalTextProvider: () => string;
  /** 保存前探活：按 provider 探；模型不可用抛错；该厂商密钥缺失抛 ProviderKeyMissingError。 */
  probeModel: (provider: string, model: string) => Promise<void>;
}

export function createCategoryConfigPanel(deps: CategoryConfigFacadeDeps): PanelCategoryConfig {
  const buildCatalog = (): CategoryConfigCatalogView => {
    const textModel = deps.getGlobalTextModel();
    const textProvider = normProvider(deps.getGlobalTextProvider());
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
            // 分类默认模型：覆盖则用覆盖、否则回落全局「默认模型」；effectiveProvider 取同行 / 回落全局文本厂商。
            effectiveModel: ovModel || textModel,
            effectiveProvider: ovModel ? normProvider(row?.provider) : textProvider,
            modelOverridden: !!ovModel,
            updatedAt: row?.updatedAt ?? null,
            updatedBy: row?.updatedBy ?? null,
          };
        }),
    };
  };

  return {
    getCatalog: buildCatalog,
    setCategoryConfig: async (categoryId, model, provider, updatedBy): Promise<CategoryConfigSetResult> => {
      if (!isKnownCategory(categoryId)) return { ok: false, reason: 'unknown_category' };
      if (!isCategoryModelConfigurable(categoryId)) {
        return { ok: false, reason: 'category_not_configurable' };
      }
      const wantsModel = model !== null && (model ?? '').trim() !== '';
      const prov = normProvider(provider);
      // 非空模型名：按所选 provider 保存前探活；不过则拒，绝不落库（红线：绝不静默假成功）。
      if (wantsModel) {
        try {
          await deps.probeModel(prov, (model as string).trim());
        } catch (e) {
          if (e instanceof ProviderKeyMissingError) return { ok: false, reason: 'provider_key_missing' };
          return { ok: false, reason: 'model_invalid' };
        }
      }
      await deps.store.set(categoryId, model, wantsModel ? prov : provider, updatedBy);
      return { ok: true, view: buildCatalog() };
    },
  };
}
