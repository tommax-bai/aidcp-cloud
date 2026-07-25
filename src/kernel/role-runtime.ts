/**
 * 事件驱动角色的**无状态运行段**（change cloud-coupling-phase5 · P5-2）。
 *
 * ## 为什么是函数而不是基类
 *
 * 四个 content 侧角色（概念抽取 / 笔记精选评估 / 评论精选评估 / 有价值评论归档）继承的
 * `src/agents/base-role.ts` 归 automation：它引进程内事件总线实现与角色名联合。拆仓后 content 的
 * src 里没有那两样，四个角色编译不过。
 *
 * 但基类本身**进不了 kernel**：它持有事件总线句柄与人设快照，是带状态的行为类，撞
 * 「kernel 里不放行为类」。复制第二份实现更糟——同一段判定逻辑分两处长，漂了没有任何机械手段会说话。
 *
 * 所以按判例拆：**无状态的那段提成函数放这里，类留原处当薄壳**。两侧基类都只是这些函数的外壳，
 * 实现只有一份。
 *
 * ## 事件订阅为什么只给「订阅」这一半
 *
 * 实测那四个角色**从不 emit**（全仓零命中）：它们订阅事件、写自己域的存储，不往总线回灌。
 * 故 {@link RoleEventSource} 只有 `on`。给出 `emit` 会让 content 在拆进程后能往一条它并不拥有的
 * 进程内总线上发事件——那在单体里能跑通、拆完静默失效，正是最难查的一类。
 *
 * 零 SQL、零 HTTP、零 LLM 客户端实现（只收端口）、无进程内活状态，满足 §4.7 kernel 准入。
 */
import type { Soul } from './soul-types.js';
import type { TextCompletionPort } from './llm-contract.js';
import type { NoteDetailData } from './note-detail.js';

/**
 * content 侧角色订阅的事件载荷（automation `RoleEventMap` 对应键的**逐字子集**）。
 *
 * 这里重新声明而不是 import，原因与 `NoteDetailImage` 同：事件映射表归 automation，
 * kernel MUST NOT 反向依赖业务层。漂移不靠自觉——`test/agents/content-role-events.test.ts`
 * 有一条编译期断言，任一键的载荷与 automation 侧不再兼容就当场编译失败。
 */
export interface ContentRoleEventMap {
  'note.detail.arrived': { detail: NoteDetailData; accountId?: string; ts: number };
  'note.image_snapshot.arrived': { detail: NoteDetailData; accountId?: string; ts: number };
  'comment_like.confirmed': {
    noteId: string;
    commentAnchorId: string;
    author?: string;
    text: string;
    reason: string;
    likeCount?: number;
    ts: number;
  };
}

/**
 * 角色需要的事件总线能力：**只订阅，不发布**。返回值是退订函数。
 * automation 的进程内总线结构上满足它（其 `on` 的键集更大、载荷同形）。
 */
export interface RoleEventSource {
  on<K extends keyof ContentRoleEventMap>(
    event: K,
    handler: (payload: ContentRoleEventMap[K]) => void,
  ): () => void;
}

/** 人设注入的两种形态：热加载取值口优先，构造期快照兜底。 */
export interface SoulSource {
  soul?: Soul;
  getSoul?: () => Soul;
}

/**
 * 解析当前人设。getSoul 优先（按当前账号热解析，改人设即时生效），否则回落构造期快照。
 *
 * 两者皆缺时抛，是**构造契约违背**的诚实失败，不是运行期降级：副本陈旧那类降级已在入口闸
 * （会话启动闸与各 scheduler 的人设闸）收敛，角色执行中途走不到这里。保留抛出仅为「会话中途被
 * 真实解绑」这条防御路径——那是权威明确的状态变化。把可预期的降级伪装成崩溃，运营只会在日志里
 * 看到一堆 no_persona、找不到真正原因。
 */
export function resolveSoul(source: SoulSource, roleName: string): Soul {
  if (source.getSoul) return source.getSoul();
  if (source.soul) return source.soul;
  throw new Error(`${roleName} 缺少人设注入（soul / getSoul 至少给一个）`);
}

/** 归一化可选超时：非正数 / 非有限值一律当未配置，绝不把 0 当「立即超时」下发。 */
export function positiveTimeoutMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** 把多行文本压成单行并截断，用于日志预览。 */
export function oneLinePreview(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 角色统一日志前缀，便于在服务日志中观测各角色行为。 */
export function roleLog(roleName: string, msg: string): void {
  console.log(`[${roleName}] ${msg}`);
}

export interface RoleCompletionOptions {
  llm: TextCompletionPort | undefined;
  roleName: string;
  /** per-role 模型硬 deadline；缺省沿用共享客户端的构造默认。 */
  llmTimeoutMs?: number;
}

/**
 * 跑一次角色决策补全，并打印可观测日志（角色 / 原始判定 / 失败原因）。
 * `AIDCP_LLM_DEBUG=true` 时额外打印完整 prompt。
 *
 * 角色键带 `browse:` 前缀下发，客户端据此解析模型 / 温度；缺端口即抛具名错误，
 * MUST NOT 静默返回空串——那会让上游把「没调成模型」读成「模型说没有」。
 *
 * **文案措辞不是随手写的**：kernel 准入检查「LLM 或供应商 HTTP 调用」只剥注释、**不剥字符串字面量**，
 * 各角色构造闸里那句同义文案带的类名 token 一旦出现在 kernel 源码里就会当场命中门禁。
 * 本函数只收注入的补全端口、不认识任何模型客户端，故这里改用不含该 token 的等义措辞。
 * 别「顺手」把它改回去——门禁会红，而原因一点都不显然。
 * 注：角色构造期本就有各自的缺失闸并抛出带类名的文案，本行只是防御路径。
 */
export async function runRoleCompletion(prompt: string, options: RoleCompletionOptions): Promise<string> {
  const { llm, roleName } = options;
  if (!llm) throw new Error(`${roleName} 缺少模型补全端口注入，无法发起决策`);
  if (process.env.AIDCP_LLM_DEBUG === 'true') roleLog(roleName, `prompt ↓\n${prompt}`);
  let raw: string;
  try {
    raw = await llm.complete(prompt, {
      role: `browse:${roleName}`,
      ...(options.llmTimeoutMs !== undefined ? { timeoutMs: options.llmTimeoutMs } : {}),
    });
  } catch (err) {
    roleLog(roleName, `LLM 调用失败：${(err as Error).message}`);
    throw err;
  }
  roleLog(roleName, `LLM 判定 → ${oneLinePreview(raw, 240)}`);
  return raw;
}
