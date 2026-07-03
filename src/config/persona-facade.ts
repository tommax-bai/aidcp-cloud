/**
 * 账号人设面板外观（change account-persona-config，stream F）。
 *
 * 把「账号目录 + 人设生效值/来源视图」与「按账号写（soul 校验）」收口成可单测的外观，
 * 与 server 装配解耦。复刻 role-config-facade 形态。
 *
 * 红线：写前用 soul 加载器校验，非法人设诚实拒绝（{ok:false, reason:'persona_invalid'}）——
 *       不落库、不刷镜像、绝不假成功。
 * persona-driven-content-pipeline：人设必填——空文本诚实拒绝（persona_required），不再有
 *       「清空回落默认」语义（系统不存在默认/兜底人设）；未绑账号在视图中如实标 none（未绑定），
 *       绝不把打包 soul.yaml 冒充为其生效人设。
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
  /**
   * 真绑定（非空、非非法）成功后触发（change auto-start-on-persona-bind）：唤醒该账号在线、因未绑人设
   * 被启动闸短路的节点就地开跑，无需重连。fire-and-forget（调用方不 await、不阻塞 PUT 回真态）；
   * 触发时 store 内存镜像已刷新（isPersonaBound 已为 true）。空文本 / 非法人设均被拒、不触发。
   */
  onBound?: (accountId: string) => void;
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
    const personaText = row?.persona.trim() ? row.persona : null;
    // 未绑人设：source='none' + 空身份摘要（诚实——该账号运行会被拒），绝不用打包默认冒充生效人设。
    const { name, role } = personaText ? identityOf(personaText) : { name: '', role: '' };
    return {
      accountId,
      label,
      source: personaText ? 'override' : 'none',
      identityName: name,
      identityRole: role,
      updatedAt: personaText ? row?.updatedAt ?? null : null,
      updatedBy: personaText ? row?.updatedBy ?? null : null,
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
      const personaText = row?.persona.trim() ? row.persona : null;
      return {
        accountId,
        label: acct.label,
        source: personaText ? 'override' : 'none',
        // 编辑器内容：已绑→该账号文本；未绑→打包 soul.yaml 原文仅作「起点模板」（非运行时兜底——
        // 未绑账号运行会被拒；运营须在模板上改出真实人设后显式保存）。
        persona: personaText ?? getDefaultPersonaText(),
        updatedAt: personaText ? row?.updatedAt ?? null : null,
        updatedBy: personaText ? row?.updatedBy ?? null : null,
      };
    },
    setPersona: async (accountId, persona, updatedBy): Promise<PersonaSetResult> => {
      // FK 守护：未知账号诚实 404，绝不写孤儿行。
      if (!(await deps.store.accountExists(accountId))) {
        return { ok: false, reason: 'unknown_account' };
      }
      // 人设必填（persona-driven-content-pipeline）：空文本诚实拒绝，不清行、不落库——
      // 不再有「清空回落默认」语义；前端被绕过也在此挡住。
      if (!(persona ?? '').trim()) {
        return { ok: false, reason: 'persona_required' };
      }
      // 写前校验：非法人设诚实拒绝、不落库、不刷镜像、不假成功（红线）。
      try {
        loadSoulFromYaml(persona);
      } catch {
        return { ok: false, reason: 'persona_invalid' };
      }
      await deps.store.set(accountId, persona, updatedBy);
      // 真绑定成功 → 唤醒该账号在线被人设闸短路的节点就地开跑（镜像已在 store.set 内同步刷新，
      // isPersonaBound 此刻已为 true）。绑定本身已成功，开跑触发失败绝不让 PUT 报错（fire-and-forget + 吞错）。
      try {
        deps.onBound?.(accountId);
      } catch {
        /* best-effort：不影响绑定回真态 */
      }
      return { ok: true, view: await buildCatalog() };
    },
  };
}
