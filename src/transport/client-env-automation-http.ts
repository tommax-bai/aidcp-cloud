/**
 * 客户环境生命周期对 automation 域那个**只读投影端口**的跨进程传输。
 *
 * 为什么必须有它：这个端口的六个方法读的全是 automation 属主表，而调用方（客户身份与环境归属）
 * 住在接口进程里。单体时代它是同进程直读；拆开之后接口进程**不该持有 automation 库的连接**，
 * 于是端口在接口进程侧一直是「未注入 ⇒ 当场抛」的形态 —— 后果是**管理后台的环境页整页答 500**
 * （2026-08-04 切流当天实测）。
 *
 * 端口是闭集合，六条路由**一条不少地开**：只开「今天用得到的那几条」等于把剩下的留成
 * 下一次 404，而那种 404 只有真跑两个进程才看得见。
 *
 * 失败语义原样穿过传输层，**MUST NOT 在这一层降级**：端口注释写明
 * 「读失败 MUST 抛、MUST NOT 变成 null / 空集」—— 把跨域读失败降级成一条业务事实
 * （「这个环境确实没绑账号」）正是本仓的红线形态。
 */
import type {
  ClientEnvAutomationReader,
  EnvRiskStateProjection,
  OffboardProjection,
} from '../kernel/client-env-automation-types.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

export const CLIENT_ENV_AUTOMATION_ROUTES = {
  offboardForUser: 'client-env-automation/offboard-for-user',
  activeWechatOffboards: 'client-env-automation/active-wechat-offboards',
  wechatBoundEnvKeys: 'client-env-automation/wechat-bound-env-keys',
  wechatEnvKeysForAccount: 'client-env-automation/wechat-env-keys-for-account',
  boundAccountForEnv: 'client-env-automation/bound-account-for-env',
  riskStateProjection: 'client-env-automation/risk-state-projection',
} as const satisfies Record<keyof ClientEnvAutomationReader, string>;

/** 在属主进程里把六个只读方法挂上。 */
export function registerClientEnvAutomationRoutes(
  server: InternalHttpServer,
  local: ClientEnvAutomationReader,
): void {
  server.register(CLIENT_ENV_AUTOMATION_ROUTES.offboardForUser, (args) => {
    const a = args as { offboardId: string; userId: string };
    return local.offboardForUser(a.offboardId, a.userId);
  });
  server.register(CLIENT_ENV_AUTOMATION_ROUTES.activeWechatOffboards, () =>
    local.activeWechatOffboards(),
  );
  server.register(CLIENT_ENV_AUTOMATION_ROUTES.wechatBoundEnvKeys, (args) => {
    const a = args as { envKeys: string[] };
    return local.wechatBoundEnvKeys(a.envKeys);
  });
  server.register(CLIENT_ENV_AUTOMATION_ROUTES.wechatEnvKeysForAccount, (args) => {
    const a = args as { accountId: string };
    return local.wechatEnvKeysForAccount(a.accountId);
  });
  server.register(CLIENT_ENV_AUTOMATION_ROUTES.boundAccountForEnv, (args) => {
    const a = args as { envKey: string; platform: string };
    return local.boundAccountForEnv(a.envKey, a.platform);
  });
  server.register(CLIENT_ENV_AUTOMATION_ROUTES.riskStateProjection, (args) => {
    const a = args as { accountIds: string[] };
    return local.riskStateProjection(a.accountIds);
  });
}

/**
 * 端口的 HTTP 实现（跑在调用方进程里）。
 *
 * **逐方法显式转调**：绝不用对象展开去「继承」实现 —— 展开拿不到类实例原型上的方法，
 * 那种错编译得过、要真跑起来才现形。
 */
export class ClientEnvAutomationHttpClient implements ClientEnvAutomationReader {
  constructor(private readonly http: InternalHttpClient) {}

  offboardForUser(offboardId: string, userId: string): Promise<OffboardProjection | null> {
    return this.http.call<OffboardProjection | null>(
      CLIENT_ENV_AUTOMATION_ROUTES.offboardForUser,
      { offboardId, userId },
    );
  }

  activeWechatOffboards(): Promise<OffboardProjection[]> {
    return this.http.call<OffboardProjection[]>(
      CLIENT_ENV_AUTOMATION_ROUTES.activeWechatOffboards,
      {},
    );
  }

  wechatBoundEnvKeys(envKeys: string[]): Promise<string[]> {
    return this.http.call<string[]>(CLIENT_ENV_AUTOMATION_ROUTES.wechatBoundEnvKeys, {
      envKeys,
    });
  }

  wechatEnvKeysForAccount(accountId: string): Promise<string[]> {
    return this.http.call<string[]>(CLIENT_ENV_AUTOMATION_ROUTES.wechatEnvKeysForAccount, {
      accountId,
    });
  }

  boundAccountForEnv(envKey: string, platform: string): Promise<string | null> {
    return this.http.call<string | null>(CLIENT_ENV_AUTOMATION_ROUTES.boundAccountForEnv, {
      envKey,
      platform,
    });
  }

  riskStateProjection(accountIds: string[]): Promise<EnvRiskStateProjection[]> {
    return this.http.call<EnvRiskStateProjection[]>(
      CLIENT_ENV_AUTOMATION_ROUTES.riskStateProjection,
      { accountIds },
    );
  }
}
