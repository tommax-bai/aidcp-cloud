/**
 * 账号平台读的跨进程三件套。范式逐字照 {@link file://./curated-content-http.ts}。
 * 服务端跑在 **api** 进程（`accounts` 在它的库里），客户端跑在 **content** 进程。
 *
 * 端口本体是现成的 kernel 契约 `AccountPlatformReader`。它已经是内容域素材库的账号守卫入口
 * （建表时那条跨库外键就是因此降级掉的），现在只是把它真正 HTTP 化。
 *
 * **失败原样抛。** 端口契约里「缺账号 → null」是一个**答案**，不是错误的兜底：
 * 属主侧确实查过、确实没有。把读失败也吞成 `null`，调用方会走 `account_not_found` 那条
 * fail-closed 分支——**看着像守卫正常工作，实际是通道断了**，而且再没有别的地方会说出真相。
 * 两者必须可区分。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { AccountPlatformReader, PlatformId } from '../kernel/platform-types.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const ACCOUNT_PLATFORM_ROUTES = {
  getPlatformOrNull: 'account-platform/get-or-null',
} as const;

/** 把一个本地账号平台读口注册为内部 HTTP route。 */
export function registerAccountPlatformRoutes(
  server: InternalHttpServer,
  local: AccountPlatformReader,
): void {
  server.register(ACCOUNT_PLATFORM_ROUTES.getPlatformOrNull, (args) => {
    const a = args as { accountId: string };
    return local.getPlatformOrNull(a.accountId);
  });
}

/** `AccountPlatformReader` 的 HTTP 实现：失败原样抛，绝不与「查过、没有」混为一谈。 */
export class AccountPlatformHttpClient implements AccountPlatformReader {
  constructor(private readonly http: InternalHttpClient) {}

  getPlatformOrNull(accountId: string): Promise<PlatformId | null> {
    return this.http.call<PlatformId | null>(ACCOUNT_PLATFORM_ROUTES.getPlatformOrNull, { accountId });
  }
}
