/**
 * 配置镜像失效信号的内部 HTTP 传输（change block3-l3-config-mirror-bump-decouple）。
 * 范式逐字照 {@link file://./risk-read-http.ts}。
 *
 * 两件东西：
 *   1. server 侧 {@link registerConfigMirrorBumpRoutes} —— 跑在**持有 api 库**的进程里，
 *      把本地 sink（`src/config/mirror-bump-sink.ts`）暴露成一条内部 route。
 *   2. client 侧 {@link ConfigMirrorBumpHttpClient} —— 跑在**生产方（automation）**进程里，
 *      满足同一个 kernel 端口 `ConfigMirrorBumpSink`，中继对它一无所知地调用。
 *
 * 这条通道是**写**（推进版本），与本目录其余只读端口不同，故三条纪律写死在这里：
 *   - 幂等由 `dedupKey` 承担：HTTP 重试、超时后对端其实已成功，都不会重复推版本。
 *   - 失败一律抛：超时 / 连不上 / 对端报错都原样抛给中继，让它保留游标下一轮重放。
 *     **MUST NOT** 把失败当成功，那会让一条失效信号永久蒸发。
 *   - 只搬 `{mirrorKey, dedupKey}` 两个字段：失效信号是「去重读」的通知，绝不搬配置内容，
 *     消费方永远从自己的权威重读，不存在「HTTP 里传了个旧值」的可能。
 */
import type {
  ConfigMirrorBumpRequest,
  ConfigMirrorBumpResult,
  ConfigMirrorBumpSink,
} from '../kernel/config-mirror-bump-types.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

/** 路由名。server / client 两侧共用，防漂移。 */
export const CONFIG_MIRROR_BUMP_ROUTES = {
  applyBump: 'config-mirror/apply-bump',
} as const;

/** 把一个本地 sink 注册为内部 HTTP route（跑在持有 api 库的进程里）。 */
export function registerConfigMirrorBumpRoutes(
  server: InternalHttpServer,
  local: ConfigMirrorBumpSink,
): void {
  server.register(CONFIG_MIRROR_BUMP_ROUTES.applyBump, (args) => {
    const a = args as ConfigMirrorBumpRequest;
    return local.applyBump({ mirrorKey: a.mirrorKey, dedupKey: a.dedupKey });
  });
}

/** `ConfigMirrorBumpSink` 的 HTTP 实现：一次调用 = 一次 route 调用。 */
export class ConfigMirrorBumpHttpClient implements ConfigMirrorBumpSink {
  constructor(private readonly http: InternalHttpClient) {}

  applyBump(request: ConfigMirrorBumpRequest): Promise<ConfigMirrorBumpResult> {
    return this.http.call<ConfigMirrorBumpResult>(CONFIG_MIRROR_BUMP_ROUTES.applyBump, {
      mirrorKey: request.mirrorKey,
      dedupKey: request.dedupKey,
    });
  }
}
