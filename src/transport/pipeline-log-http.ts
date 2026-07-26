/**
 * 发布管线角色执行日志的跨进程三件套。范式逐字照 {@link file://./curated-content-http.ts}。
 * 服务端跑在 **api** 进程（`publish_pipeline_logs` 在它的库里），客户端跑在 **content** 进程。
 *
 * 端口本体是现成的 kernel 契约 `PipelineLogSink`，这里只把它 HTTP 化。
 *
 * **客户端不透传异常，这条与台账写相反、与投递判定同向。**
 * 这是**可观测性**写入：它的既定语义就是 best-effort、不阻塞发布
 * （见 `PipelineLogSink` 文档：未注入时 orchestrator 行为退化为现状、不报错）。
 * 单体里它是一次同库 INSERT，几乎不会失败；拆进程后新增了「对端没起 / 端口没配 / 超时」一整类失败，
 * 让它们抛出去就等于**因为一条日志没写成而中断一次发布** —— 那是拿主链路给观测让路，方向反了。
 *
 * 但降级 MUST 是**吵闹的**：每次失败留一行 warn。静默吞掉会让「日志断了」看起来像「没有日志可写」，
 * 而那两件事在排查发布问题时的含义天差地别。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { PipelineLogEntry, PipelineLogSink } from '../kernel/pipeline-log-contract.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const PIPELINE_LOG_ROUTES = {
  append: 'pipeline-log/append',
} as const;

/** 把一个本地日志 sink 注册为内部 HTTP route。只做参数解包 → 转调 → 回传，零业务逻辑。 */
export function registerPipelineLogRoutes(server: InternalHttpServer, local: PipelineLogSink): void {
  server.register(PIPELINE_LOG_ROUTES.append, async (args) => {
    const a = args as { entry: PipelineLogEntry };
    await local.append(a.entry);
    return null;
  });
}

/** `PipelineLogSink` 的 HTTP 实现：写不成就吵闹地放过，绝不把观测失败升级成发布失败。 */
export class PipelineLogHttpClient implements PipelineLogSink {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  async append(entry: PipelineLogEntry): Promise<void> {
    try {
      await this.http.call(PIPELINE_LOG_ROUTES.append, { entry });
    } catch (error) {
      this.logger.warn(
        `[pipeline-log] 角色执行日志远程写入失败（本条丢弃，不影响发布）` +
          ` run=${entry.runId} role=${entry.roleName}: ${(error as Error).message}`,
      );
    }
  }
}
