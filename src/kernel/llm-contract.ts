/**
 * 云端 LLM 调用契约（纯类型 kernel 段）。
 *
 * 这里只放**跨边界共享、且不含供应商语义标识符的纯类型**：Per-call 覆盖选项。
 * 供 automation 侧多个角色 type-only 引用，避免它们直连 content 属主的 `src/llm/qwen.ts`。
 *
 * 客户端接口 `LlmClient` / `ChatLlmClient` **不进 kernel**：门禁 §4.7 kernel 准入把这两个标识符
 * 本身列为「LLM 或供应商 HTTP 调用」特征、禁止出现在 kernel 文件里，故它们留 `src/llm/qwen.ts`（content）。
 * 厂商 HTTP 客户端类、错误类、buildXxx 等 behavior 同样留 qwen.ts。
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
