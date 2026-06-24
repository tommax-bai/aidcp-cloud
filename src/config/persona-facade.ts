/**
 * 账号人设面板外观（change account-persona-config，stream F）。
 *
 * 把「账号目录 + 人设生效值/来源视图」与「按账号写（soul 校验）」收口成可单测的外观，
 * 与 server 装配解耦。复刻 role-config-facade 形态。
 *
 * 红线：写前用 soul 加载器校验，非法人设诚实拒绝（{ok:false, reason:'persona_invalid'}）——
 *       不落库、不刷镜像、绝不假成功。空文本 = 清除覆盖（回落打包默认）。
 */

import { loadSoulFromYaml } from '../soul/index.js';
import type { PersonaStore } from './persona-store.js';
import { getDefaultPersonaText } from './persona-store.js';
import type {
  PanelPersonaConfig,
  PersonaConfigCatalogView,
  PersonaConfigRowView,
  PersonaDetailView,
  PersonaSetResult,
} from '../panel/types.js';

export interface PersonaFacadeDeps {
  store: PersonaStore;
}

export function createPersonaPanel(deps: PersonaFacadeDeps): PanelPersonaConfig {
  /** 解析人设取身份摘要（解析失败 → 空摘要，不抛）。 */
  const identityOf = (text: string): { name: string; role: string } => {
    try {
      const s = loadSoulFromYaml(text);
      return { name: s.identity.name, role: s.identity.role };
    } catch {
      return { name: '', role: '' };
    }
  };

  const buildRow = (accountId: string, label: string | null): PersonaConfigRowView => {
    const row = deps.store.getRow(accountId);
    const overrideText = row?.persona.trim() ? row.persona : null;
    const effectiveText = overrideText ?? getDefaultPersonaText();
    const { name, role } = identityOf(effectiveText);
    return {
      accountId,
      label,
      source: overrideText ? 'override' : 'fallback',
      identityName: name,
      identityRole: role,
      updatedAt: overrideText ? row?.updatedAt ?? null : null,
      updatedBy: overrideText ? row?.updatedBy ?? null : null,
    };
  };

  const buildCatalog = async (): Promise<PersonaConfigCatalogView> => {
    const accounts = await deps.store.listAccounts();
    return { accounts: accounts.map((a) => buildRow(a.accountId, a.label)) };
  };

  return {
    getCatalog: buildCatalog,
    getDetail: async (accountId): Promise<PersonaDetailView | null> => {
      const accounts = await deps.store.listAccounts();
      const acct = accounts.find((a) => a.accountId === accountId);
      if (!acct) return null;
      const row = deps.store.getRow(accountId);
      const overrideText = row?.persona.trim() ? row.persona : null;
      return {
        accountId,
        label: acct.label,
        source: overrideText ? 'override' : 'fallback',
        // 编辑起点：覆盖→该账号文本；回落→打包默认 soul.yaml 原文（便于在默认基础上改）。
        persona: overrideText ?? getDefaultPersonaText(),
        updatedAt: overrideText ? row?.updatedAt ?? null : null,
        updatedBy: overrideText ? row?.updatedBy ?? null : null,
      };
    },
    setPersona: async (accountId, persona, updatedBy): Promise<PersonaSetResult> => {
      // FK 守护：未知账号诚实 404，绝不写孤儿行。
      if (!(await deps.store.accountExists(accountId))) {
        return { ok: false, reason: 'unknown_account' };
      }
      if (!(persona ?? '').trim()) {
        // 空文本 = 清除覆盖 → 回落打包默认（对齐 role-config 空值=回落语义）。
        await deps.store.clear(accountId);
        return { ok: true, view: await buildCatalog() };
      }
      // 写前校验：非法人设诚实拒绝、不落库、不刷镜像、不假成功（红线）。
      try {
        loadSoulFromYaml(persona);
      } catch {
        return { ok: false, reason: 'persona_invalid' };
      }
      await deps.store.set(accountId, persona, updatedBy);
      return { ok: true, view: await buildCatalog() };
    },
  };
}
