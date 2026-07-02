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
  isValidThinkingModePatch,
} from './role-catalog.js';
import type { CategoryConfigStore } from './category-config-store.js';
import { normProvider, ProviderKeyMissingError, buildThinkingParams } from '../llm/index.js';
import type {
  PanelCategoryConfig,
  CategoryConfigCatalogView,
  CategoryConfigSetResult,
} from '../panel/types.js';

/** 生效模型是否支持"开启(on)"（与出口 buildThinkingParams 同源；DashScope Qwen 需流式 → false）。 */
function thinkingOnAvailableFor(provider: string, model: string): boolean {
  return Object.keys(buildThinkingParams(provider, model, 'on').params).length > 0;
}

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
          const effModel = ovModel || textModel;
          const effProvider = ovModel ? normProvider(row?.provider) : textProvider;
          const ovThinking = row?.thinkingMode ?? null;
          return {
            categoryId: c.categoryId,
            displayName: c.displayName,
            order: c.order,
            // 分类默认模型：覆盖则用覆盖、否则回落全局「默认模型」；effectiveProvider 取同行 / 回落全局文本厂商。
            effectiveModel: effModel,
            effectiveProvider: effProvider,
            modelOverridden: !!ovModel,
            // 思考模式（change role-thinking-mode-config）：分类覆盖则用覆盖、否则 default。
            effectiveThinkingMode: ovThinking ?? 'default',
            thinkingModeOverridden: !!ovThinking,
            thinkingOnAvailable: thinkingOnAvailableFor(effProvider, effModel),
            updatedAt: row?.updatedAt ?? null,
            updatedBy: row?.updatedBy ?? null,
          };
        }),
    };
  };

  return {
    getCatalog: buildCatalog,
    setCategoryConfig: async (categoryId, patch, updatedBy): Promise<CategoryConfigSetResult> => {
      if (!isKnownCategory(categoryId)) return { ok: false, reason: 'unknown_category' };
      if (!isCategoryModelConfigurable(categoryId)) {
        return { ok: false, reason: 'category_not_configurable' };
      }
      // 思考模式校验（change role-thinking-mode-config）：非法值诚实拒绝、绝不落库、绝不当作清除。
      if (!isValidThinkingModePatch(patch.thinkingMode)) {
        return { ok: false, reason: 'thinking_mode_invalid' };
      }
      const wantsModel = patch.model !== undefined && (patch.model ?? '').trim() !== '';
      const prov = normProvider(patch.provider);
      // 非空模型名：按所选 provider 保存前探活；不过则拒，绝不落库（红线：绝不静默假成功）。
      if (wantsModel) {
        try {
          await deps.probeModel(prov, (patch.model as string).trim());
        } catch (e) {
          if (e instanceof ProviderKeyMissingError) return { ok: false, reason: 'provider_key_missing' };
          return { ok: false, reason: 'model_invalid' };
        }
      }
      await deps.store.set(
        categoryId,
        { ...patch, provider: wantsModel ? prov : patch.provider },
        updatedBy,
      );
      return { ok: true, view: buildCatalog() };
    },
  };
}
