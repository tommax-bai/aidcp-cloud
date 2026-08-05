/**
 * 保存前模型探活的跨进程窄口（change restore-panel-capability-wiring）。
 *
 * **为什么必须跨这条边**：管理后台的三处模型写入（全局平台配置 / 角色 / 分类）都以
 * 「先按所选厂商探活、不过就拒、绝不落库」为既有保证，而探活是**真发一次模型调用**——
 * 文本厂商客户端归内容进程。面板住在接口进程；不开这条口，接口进程就只有两个选择：
 * 跳过探活直接写（静默假成功：一个打错的模型名会落库，直到某个角色真去调用才炸），
 * 或者干脆不让改模型（后台三处配置页全废）。两个都不能接受。
 *
 * **三态在这条边上的形态**（这是本文件存在的全部理由）：
 *   - 对面答「探活过了」            → `{ ok: true }`
 *   - 对面答「密钥缺失 / 模型不可用」 → `{ ok:false, reason }`，是**真实答案**，照实传
 *   - **没问到对面**（通道不通、超时、对面没注册这条路由）
 *                                  → `{ ok:false, reason:'probe_unavailable' }`
 *
 * 第三态 MUST NOT 被折进前两者。折进 `model_unavailable` 会让运营看到「模型名不合法」，
 * 于是去改一个本来正确的模型名；折进 `ok:true` 则是直接的静默假成功。
 *
 * 跨进程后 `instanceof` 恒 false：密钥缺失的识别在**属主侧**完成（那里错误类还是真的），
 * 线上传的只是判别式结果。调用方 MUST NOT 试图去 parse 文案还原错误类型。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

export const MODEL_PROBE_ROUTES = {
  probe: 'model-probe/probe',
} as const;

/** 与 `src/config/role-config-facade.ts` 的 `ModelProbeResult` 同形（结构对接，不跨属主 import）。 */
export type ModelProbeWireResult =
  | { ok: true }
  | { ok: false; reason: 'provider_key_missing' | 'model_unavailable' | 'probe_unavailable' };

/** 属主侧实现：真发一次探活调用，并把错误类分类成判别式结果。 */
export interface ModelProbePort {
  probeModel(provider: string, model: string): Promise<ModelProbeWireResult>;
}

interface ProbeArgs {
  provider: string;
  model: string;
}

/**
 * 属主侧注册。分类留在属主（它持有厂商客户端与错误类）；本函数不做任何 try/catch ——
 * 属主的分类若漏了一种错误，那应该以「没问到」的形态暴露给调用方，而不是被这里抹平成
 * 某个具体原因。
 */
export function registerModelProbeRoutes(server: InternalHttpServer, local: ModelProbePort): void {
  server.register(MODEL_PROBE_ROUTES.probe, (args) => {
    const a = args as ProbeArgs;
    return local.probeModel(a.provider, a.model);
  });
}

export class ModelProbeHttpClient implements ModelProbePort {
  constructor(private readonly http: InternalHttpClient) {}

  async probeModel(provider: string, model: string): Promise<ModelProbeWireResult> {
    try {
      return await this.http.call<ModelProbeWireResult>(MODEL_PROBE_ROUTES.probe, {
        provider,
        model,
      });
    } catch (err) {
      // **这里的 catch 只吃「没问到」**，不吃业务答案（业务答案是正常返回值，走不到这里）。
      // 记一行：探活拒写在后台上表现为一次保存失败，没有这行日志就查不出是通道问题还是模型问题。
      console.warn(
        `[model-probe] 跨进程探活未完成 provider=${provider} model=${model}: `
          + `${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, reason: 'probe_unavailable' };
    }
  }
}
