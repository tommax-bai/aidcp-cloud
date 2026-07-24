/**
 * Block② 数据网关（决定①：api/panel 收口取数）。
 *
 * 把「api 直接持有本地读实例」包装成「可切 HTTP 的读端口聚合」。**默认路径一字不改**：
 * 默认 mode='local' ⇒ 每个 getter 返回的就是构造时传入的那个本地实例（`===`），零 HTTP、
 * 零行为变更。只有显式切到 'http'（拆进程后 2d）才用组合根注入的 remote thunk 构造出的 HTTP
 * 客户端——那时仍满足同一个 kernel 读接口。
 *
 * ## 为什么本文件只 import kernel、不 import transport
 * 网关落在 api 层。api → automation 是需豁免的跨层边（会抬高边界棘轮 frozenTotal）。transport 的
 * `makeReadPort` / `InternalHttpClient` / 各 `*HttpClient` 都在 automation 层，若在此直接 import 就会
 * 新增一条 api → automation 违规。故本文件：
 *   - 只依赖 kernel 读接口（`to === kernel` 恒 allowed）；
 *   - 把 `makeReadPort` 那条 `mode === 'http' ? remote() : local` 的等价选择逻辑**内联**（见
 *     {@link selectPort}），语义逐字一致；
 *   - remote thunk 由**组合根（composition，src/server.ts）**注入——组合根可合法 import transport
 *     并在其中构造 `*HttpClient`。默认 local 下 thunk 永不被调用、不构造任何 client、不碰网络。
 * 由此：网关在 api 层但只连 kernel，边界棘轮不升。
 */
import type { CuratedContentReader } from '../kernel/curated-content-types.js';
import type { DelegatedTaskServicePort } from '../kernel/delegated-task-types.js';
import type { InteractionStoreReaderPort } from '../kernel/interaction-types.js';
import type { PublishStatusReader } from '../kernel/publish-status-types.js';
import type { PublishGenerationPort } from '../kernel/publish-generation-types.js';

/** 读端口传输模式。与 transport 的 `ReadPortMode` 语义一致，此处独立声明以免 api→automation 依赖。 */
export type GatewayMode = 'local' | 'http';

/**
 * 单端口的本地/HTTP 选择（内联版 `makeReadPort`）。
 * **默认 mode='local' → 直接返回本地实例、零 HTTP、零行为变更**；remote 是 thunk：local 模式下**不被调用**。
 * 本地实例可能不存在（对应上游依赖未就绪）→ 透传 undefined。
 */
function selectPort<I>(local: I | undefined, remote: (() => I) | undefined, mode: GatewayMode): I | undefined {
  if (mode === 'http' && remote) return remote();
  return local;
}

/** 从 env 读网关传输模式，**默认 local**：仅当显式等于 `'http'` 才切远端。 */
export function gatewayModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  key = 'AIDCP_GATEWAY_MODE',
): GatewayMode {
  return env[key] === 'http' ? 'http' : 'local';
}

/** 每个读端口的 HTTP 客户端构造 thunk（由组合根提供；仅 http 模式调用）。 */
export interface DataGatewayRemote {
  curatedContentReader?: () => CuratedContentReader;
  delegatedTaskService?: () => DelegatedTaskServicePort;
  interactionReader?: () => InteractionStoreReaderPort;
  publishStatusReader?: () => PublishStatusReader;
  publishGenerationPort?: () => PublishGenerationPort;
}

export interface DataGatewayOptions {
  /** content 域：精选库读侧窄面本地实例（CuratedContentStore 结构兼容）。 */
  curatedContentLocal?: CuratedContentReader;
  /** automation 域：委托任务读写窄面本地实例（DelegatedTaskService 结构兼容）。 */
  delegatedTaskLocal?: DelegatedTaskServicePort;
  /** automation 域：收件箱读侧窄面本地实例（InteractionStore 结构兼容）。 */
  interactionReaderLocal?: InteractionStoreReaderPort;
  /** content 域：发布队列状态读侧窄面本地实例（PublishOrchestrator.getStatus 适配为异步端口）。 */
  publishStatusLocal?: PublishStatusReader;
  /** content 域：内容生成触发端口本地实例（PublishOrchestrator 本体，默认 local 即同步 await 同一管线）。 */
  publishGenerationLocal?: PublishGenerationPort;
  /** 传输模式，缺省 'local'（零 HTTP、同注入实例）。 */
  mode?: GatewayMode;
  /** http 模式下各端口的客户端构造 thunk；local 模式忽略。 */
  remote?: DataGatewayRemote;
}

/**
 * 三读端口聚合。对外只暴露 kernel 读接口类型的 getter；api 消费者从这里取端口注入，
 * 默认（local）取到的就是原本地实例，运行时零变化。
 */
export class DataGateway {
  private readonly curated: CuratedContentReader | undefined;
  private readonly delegated: DelegatedTaskServicePort | undefined;
  private readonly interaction: InteractionStoreReaderPort | undefined;
  private readonly publishStatus: PublishStatusReader | undefined;
  private readonly publishGeneration: PublishGenerationPort | undefined;
  readonly mode: GatewayMode;

  constructor(opts: DataGatewayOptions) {
    this.mode = opts.mode ?? 'local';
    const remote = opts.remote ?? {};
    this.curated = selectPort(opts.curatedContentLocal, remote.curatedContentReader, this.mode);
    this.delegated = selectPort(opts.delegatedTaskLocal, remote.delegatedTaskService, this.mode);
    this.interaction = selectPort(opts.interactionReaderLocal, remote.interactionReader, this.mode);
    this.publishStatus = selectPort(opts.publishStatusLocal, remote.publishStatusReader, this.mode);
    this.publishGeneration = selectPort(opts.publishGenerationLocal, remote.publishGenerationPort, this.mode);
  }

  /** content 域读端口（精选灵感库·按账号）。 */
  get curatedContentReader(): CuratedContentReader | undefined {
    return this.curated;
  }

  /** automation 域读写窄面（委托任务）。 */
  get delegatedTaskService(): DelegatedTaskServicePort | undefined {
    return this.delegated;
  }

  /** automation 域读端口（收件箱投影 / 请求账本）。 */
  get interactionReader(): InteractionStoreReaderPort | undefined {
    return this.interaction;
  }

  /** content 域读端口（发布队列状态·后台/客户端展示）。 */
  get publishStatusReader(): PublishStatusReader | undefined {
    return this.publishStatus;
  }

  /** content 域写触发端口（内容生成·调度器驱动）。默认 local 时为 undefined（调度器于 segC 就地注入，不经本网关）。 */
  get publishGenerationReader(): PublishGenerationPort | undefined {
    return this.publishGeneration;
  }
}
