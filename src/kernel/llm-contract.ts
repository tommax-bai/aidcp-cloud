/**
 * 云端 LLM 调用契约（纯类型 kernel 段）。
 *
 * 这里只放**跨边界共享、且不含供应商语义标识符的纯类型**：Per-call 覆盖选项。
 * 供 automation 侧多个角色 type-only 引用，避免它们直连 content 属主的 `src/llm/qwen.ts`。
 *
 * 客户端接口 `LlmClient` / `ChatLlmClient` **不进 kernel**：门禁 §4.7 kernel 准入把这两个标识符
 * 本身列为「LLM 或供应商 HTTP 调用」特征、禁止出现在 kernel 文件里，故它们留 `src/llm/qwen.ts`（content）。
 * 厂商 HTTP 客户端类与真正发请求的 behavior 同样留 qwen.ts。
 *
 * **错误族已不在此列**（change split-cloud-automation-production-runtime 更正）：
 * `ProviderKeyMissingError` / `LlmErrorMeta` / `buildLlm*Error` 已抬进 `src/kernel/llm-errors.ts`。
 * 理由是结构性的——拆仓后文本出口随 qwen.ts 进共享传输包、视觉出口 `src/llm/vision.ts` 留 content，
 * 两侧各持一份错误类会让跨副本 `instanceof` 恒 false，把「该厂商密钥缺失」静默降级成「模型不可用」。
 * **别照本段的旧版本把它们复制回来**：它们必须只有一份定义。
 *
 * kernel 准入：无 SQL / 无供应商调用标识符 / 无 fetch / 无进程内活状态 / 不反向依赖业务层。
 */

/**
 * 显式思考模式覆盖的取值（change role-thinking-mode-config；测试/探活用）。
 * `'off'|'on'` 覆盖，`'default'` = 不干预（不发 thinking 字段）。
 * 与 `src/config/role-catalog.ts` 的 `ThinkingMode | 'default'` 结构逐字一致；本 kernel 段内联该字面量，
 * 以保住 kernel「不反向依赖业务层」——`ThinkingMode` 定义在 api 属主的 role-catalog，kernel MUST NOT 导入它。
 */
export type LlmThinkingModeOpt = 'off' | 'on' | 'default';

/**
 * **已解析**的思考模式：只有真正要下发的那两个取值，没有「不干预」那一档。
 *
 * 与 api 属主 `src/config/role-catalog.ts` 的 `ThinkingMode` 结构逐字一致，由 {@link LlmThinkingModeOpt}
 * 排除 `'default'` 派生而来 —— 让「解析之后只剩两态」这件事由类型系统承担，而不是靠调用方自觉。
 *
 * ⚠️ **下发路径上的类型绝不能换成三值的 {@link LlmThinkingModeOpt}**：请求体构造处的守卫是
 * `if (!mode) return { params: {} }`（没解析出模式 ⇒ 一个 thinking 字段都不发），而 `'default'` 是**真值**，
 * 会穿过守卫落进厂商分支、把「不干预」发成一个显式的「关闭思考」参数。那正好违反该处自己写死的
 * 「零回归、请求体逐字一致」，且现有思考模式测试抓不到。
 */
export type LlmThinkingMode = Exclude<LlmThinkingModeOpt, 'default'>;

/**
 * Per-call 覆盖选项（change console-role-model-config）。
 * 调用方按需传：`role` 触发按角色解析模型/温度；`model`/`temperature`/`timeoutMs` 为显式覆盖（探活与测试用）。
 * **不传 opts 时行为与改造前逐字一致**（零回归不变量）。
 */
export interface LlmCallOpts {
  /** 角色标识（如 `browse:content_evaluator` / `publish:ContentCreator`）；交给注入的解析器按角色取模型/温度。 */
  role?: string;
  /**
   * 账号标识（token 用量按账号归属用；change llm-token-usage-stats）。
   * 现为单租户：不传即 recorder 端缺省 `'default'`。多账号内核落地后由其在并发安全处穿入真实账号
   * （本流不在 RoleDispatcher 实时读共享 currentAccountId，见 change design D5）。
   */
  accountId?: string;
  /** 显式模型名覆盖（优先于按角色解析；用于保存前探活）。 */
  model?: string;
  /**
   * 显式厂商覆盖（change model-config-volcengine-provider）：优先于按角色解析的 provider。
   * 探活按 provider 探时显式传；不传则交注入的 `getProvider` 按角色解析、再缺则走构造默认路径。
   * MUST NOT 在此传裸 baseUrl/apiKey —— 密钥只从启动期预载的 `providerRuntime` 取，保住"唯一出口"不变量。
   */
  provider?: string;
  /** 显式温度覆盖（优先于按角色解析）。 */
  temperature?: number;
  /** 显式超时覆盖（毫秒；探活用短超时）。 */
  timeoutMs?: number;
  /**
   * 显式思考模式覆盖（change role-thinking-mode-config；测试/探活用）：`'off'|'on'` 覆盖，`'default'` = 不干预（不发 thinking 字段）。
   * 优先于按角色解析；不传则走注入的 `getThinking`，再缺则 default（零回归）。
   */
  thinkingMode?: LlmThinkingModeOpt;
}

/**
 * 纯文本补全端口：**调用方只需要「给一段提示词、拿一段文本」的那一面**。
 *
 * 此前仓里有**三份逐字相同的私有声明**（边云消息处理器与规划器用的客户端接口、搜索词角色的 `RoleLlmLike`、
 * 角色基类里的私有 `RoleLlm`），分属三个属主。于是每个「只想要 complete」的消费方都被迫直连 content 属主的
 * 厂商客户端文件 —— 三条跨边界依赖由此而来，而它们要的其实是同一个一行接口。
 *
 * **命名红线**：本接口名里不得出现 `LlmClient` / `ChatLlmClient` 两个 token —— kernel 准入门把它们本身
 * 当作「厂商调用」特征直接拒绝（正则精确锚这两个词；`LlmCallOpts` / `RoleLlmLike` 这类不命中）。
 * 厂商 HTTP 客户端类、错误类、多轮 chat 接口一律留在 content 属主的实现文件，本端口只承载最窄的那一面。
 */
export interface TextCompletionPort {
  complete(prompt: string, opts?: LlmCallOpts): Promise<string>;
}
