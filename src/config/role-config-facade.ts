/**
 * 角色配置面板外观（change console-role-model-config）。
 *
 * 把「角色目录 + 生效值视图」与「按角色写（校验 + 保存前探活）」收口成一个可单测的外观，
 * 与 server 装配解耦：探活以闭包注入（测试可打桩），不在此直接持有 LLM 客户端。
 *
 * 红线：非空模型名探活不过 → 拒绝写入、报因，绝不落库、绝不假成功。
 * 白名单：只暴露 ROLE_CATALOG 内的现役 LLM 角色；图像/none 不可 per-role 配模型；温度仅可调温度角色。
 */

import {
  ROLE_CATALOG,
  getCatalogItem,
  isModelConfigurable,
  isValidThinkingModePatch,
  type ThinkingMode,
} from './role-catalog.js';
import type { RoleConfigStore } from './role-config-store.js';
import {
  normProvider,
  ProviderKeyMissingError,
  buildThinkingParams,
} from '../llm/index.js';
import { normImageProvider } from '../kernel/image-provider-registry.js';
import { resolveCoverFormModel, resolveCoverFormProvider } from '../publish-agent/cover-form-sensor.js';
import type {
  PanelRoleConfig,
  RoleConfigCatalogView,
  RoleConfigSetResult,
} from '../panel/types.js';

/** 生效模型是否支持"开启(on)"：与出口翻译同源——on 能翻出非空参数即支持（否则如 DashScope Qwen 需流式，不支持）。 */
function thinkingOnAvailableFor(provider: string, model: string): boolean {
  return Object.keys(buildThinkingParams(provider, model, 'on').params).length > 0;
}

export interface RoleConfigFacadeDeps {
  store: RoleConfigStore;
  /** 当前全局文本模型名（回落用，即「默认模型」）。 */
  getGlobalTextModel: () => string;
  /** 当前全局文本厂商（change model-config-volcengine-provider）：default 来源的生效厂商。 */
  getGlobalTextProvider: () => string;
  /** 当前全局图片模型名（图像角色生效值展示用）。 */
  getGlobalImageModel: () => string;
  /** 当前全局图片厂商（change console-cloud-panel-hardening #5：图像角色生效厂商展示用，替代恒填文本默认）。 */
  getGlobalImageProvider: () => string;
  /** 某分类的默认模型覆盖（null=分类无覆盖）；用于计算「继承分类」生效来源。 */
  getCategoryModel: (categoryId: string) => string | null;
  /** 某分类默认模型的厂商（change model-config-volcengine-provider）；category 来源的生效厂商。 */
  getCategoryProvider: (categoryId: string) => string | null;
  /** 某分类默认思考模式（change role-thinking-mode-config；null=分类无覆盖）；用于 role 缺省时回落分类。 */
  getCategoryThinking: (categoryId: string) => ThinkingMode | null;
  /** 保存前探活：按 provider 探；模型不可用抛错；该厂商密钥缺失抛 ProviderKeyMissingError。 */
  probeModel: (provider: string, model: string) => Promise<void>;
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
        // effectiveProvider 取自贡献生效模型那一层的同行 provider（normProvider 归一），与运行时解析一致。
        const catModel = item.llmKind === 'text' ? deps.getCategoryModel(item.category) : null;
        let effectiveModel: string;
        let effectiveProvider: string;
        let effectiveSource: 'override' | 'category' | 'default' | 'image' | 'vision';
        if (item.llmKind === 'image') {
          effectiveModel = imageModel;
          effectiveProvider = normImageProvider(deps.getGlobalImageProvider()); // 图像读真实图片厂商（#5，不再恒填文本默认）
          effectiveSource = 'image';
        } else if (item.llmKind === 'vision') {
          // change textcard-cover-form（v1 收敛）：视觉角色模型经 env 两层解析（env → 代码默认）、面板只读展示。
          // 绝不落全局文本模型回落层（文本模型收到 image_url 必错）；写入仍被 isModelConfigurable 拒绝。
          effectiveModel = resolveCoverFormModel();
          effectiveProvider = normProvider(resolveCoverFormProvider());
          effectiveSource = 'vision';
        } else if (ovModel) {
          effectiveModel = ovModel;
          effectiveProvider = normProvider(row?.provider);
          effectiveSource = 'override';
        } else if (catModel) {
          effectiveModel = catModel;
          effectiveProvider = normProvider(deps.getCategoryProvider(item.category));
          effectiveSource = 'category';
        } else {
          effectiveModel = textModel;
          effectiveProvider = normProvider(deps.getGlobalTextProvider());
          effectiveSource = 'default';
        }
        // 思考模式（change role-thinking-mode-config）：仅文本类可配。role 覆盖 → 分类 → default 两层回落。
        const ovThinking = item.llmKind === 'text' ? row?.thinkingMode ?? null : null;
        const catThinking = item.llmKind === 'text' ? deps.getCategoryThinking(item.category) : null;
        let effectiveThinkingMode: 'default' | ThinkingMode = 'default';
        let thinkingModeSource: 'override' | 'category' | 'default' = 'default';
        if (ovThinking) {
          effectiveThinkingMode = ovThinking;
          thinkingModeSource = 'override';
        } else if (catThinking) {
          effectiveThinkingMode = catThinking;
          thinkingModeSource = 'category';
        }
        return {
          roleId: item.roleId,
          displayName: item.displayName,
          group: item.group,
          category: item.category,
          llmKind: item.llmKind,
          tunableTemperature: item.tunableTemperature,
          effectiveModel,
          effectiveProvider,
          effectiveSource,
          modelOverridden: item.llmKind === 'text' && !!ovModel,
          temperatureOverride: row?.temperature ?? null,
          effectiveThinkingMode,
          thinkingModeOverride: ovThinking,
          thinkingModeSource,
          thinkingOnAvailable:
            item.llmKind === 'text' && thinkingOnAvailableFor(effectiveProvider, effectiveModel),
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
      // 思考模式校验（change role-thinking-mode-config）：非法值诚实拒绝、绝不落库、绝不当作清除。
      if (!isValidThinkingModePatch(patch.thinkingMode)) {
        return { ok: false, reason: 'thinking_mode_invalid' };
      }
      // 想设 off/on（而非清除）只对文本类角色开放（图像/none 不调文本 LLM）。
      const wantsThinking =
        patch.thinkingMode != null &&
        ['off', 'on'].includes(patch.thinkingMode.trim().toLowerCase());
      if (wantsThinking && !isModelConfigurable(roleId)) {
        return { ok: false, reason: 'model_not_configurable' };
      }
      if (patch.temperature !== undefined && patch.temperature !== null) {
        if (!item.tunableTemperature) return { ok: false, reason: 'temperature_not_tunable' };
        if (!(patch.temperature >= 0 && patch.temperature <= 1)) {
          return { ok: false, reason: 'temperature_out_of_range' };
        }
      }

      // 非空模型名：按所选 provider 保存前探活；不过则拒，绝不落库（红线：绝不静默假成功）。
      // provider 归一（未知/空 → dashscope），与 model 同行写库。
      const provider = normProvider(patch.provider);
      if (wantsModel) {
        try {
          await deps.probeModel(provider, (patch.model as string).trim());
        } catch (e) {
          // 该厂商密钥缺失 → 可区分原因（让前端提示去配密钥并重启）；否则模型名无效。
          if (e instanceof ProviderKeyMissingError) return { ok: false, reason: 'provider_key_missing' };
          return { ok: false, reason: 'model_invalid' };
        }
      }

      await deps.store.set(roleId, { ...patch, provider: wantsModel ? provider : patch.provider }, updatedBy);
      return { ok: true, view: buildCatalog() };
    },
  };
}
