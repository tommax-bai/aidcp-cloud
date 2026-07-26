/**
 * 厂商密钥窄读的跨进程三件套。范式逐字照 {@link file://./curated-content-http.ts}。
 * 服务端跑在 **api** 进程（凭据表在它的库里），客户端跑在 **content** 进程。
 *
 * **没有镜像、也不需要**：这条口只在启动期被调几次（每个厂商一次），不在任何热路径上。
 *
 * **失败原样抛。** 端口文档已写明「读不到 ≠ 没配」：吞成 `null` 会让调用方把一次读失败
 * 当成「这个厂商没配」，于是静默少构造一个出口 —— 表现为某条链路悄悄不工作、且没有任何报错。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { ProviderSecretReader } from '../kernel/provider-secret-port.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const PROVIDER_SECRET_ROUTES = {
  getSecretForRuntime: 'provider-secret/get-for-runtime',
} as const;

/** 把一个本地凭据读口注册为内部 HTTP route。 */
export function registerProviderSecretRoutes(server: InternalHttpServer, local: ProviderSecretReader): void {
  server.register(PROVIDER_SECRET_ROUTES.getSecretForRuntime, (args) => {
    const a = args as { provider: string; field: string };
    return local.getSecretForRuntime(a.provider, a.field);
  });
}

/** `ProviderSecretReader` 的 HTTP 实现：失败原样抛，绝不吞成「没配」。 */
export class ProviderSecretHttpClient implements ProviderSecretReader {
  constructor(private readonly http: InternalHttpClient) {}

  getSecretForRuntime(provider: string, field: string): Promise<string | null> {
    return this.http.call<string | null>(PROVIDER_SECRET_ROUTES.getSecretForRuntime, { provider, field });
  }
}
