/**
 * 账号主数据的**跨属主投影端口**纯类型契约（kernel 段）。
 *
 * accounts 属 api 单写。automation 域为了让自己的守卫读回到同库（见 migrations/0077 文件头），
 * 在本域冷备一份只含三列的投影；投影的**来源**必须经本端口取，MUST NOT 由 automation 直连
 * api 的库、更 MUST NOT 把 api 的连接池注入 automation 侧的消费方。
 *
 * 端口只有一个方法、只读、无参：整张花名册一次取回。这是刻意的——
 * ① 账号主数据是**小而全量**的（真机 37 行），全量快照比逐账号问答简单得多，也天然自愈：
 *    任何一次成功的全量快照都能把投影拉回正确，不依赖「之前每一条变更事件都收到过」；
 * ② 无参也意味着这个端口可以被内部 HTTP 化成一条最平凡的只读路由，拆进程时不需要重新设计分页 /
 *    过滤 / 游标语义。
 *
 * kernel 门禁（§4.7）：纯类型 + 接口。无 SQL / 无 fetch / 无 LLM 标识符 / 无实现类名 /
 * 无模块级活状态 / 无 setTimeout。
 */
import type { PlatformId } from './platform-types.js';

/**
 * 账号身份投影的**一行**。三列全部是 accounts 对应列的**原样值**。
 *
 * ⚠️ `platform` 与 `groupLabel` MUST NOT 在实现里归一 / trim / 小写化。消费方的守卫谓词
 * （`lower(btrim(platform)) IN ('facebook','fb')`、`platform = 'facebook'`、
 * `btrim(group_label) <> ''`）是逐字照搬过来的，只有原样值才能保证语义等价。
 * 归一会让「同一句谓词在投影上得出不同答案」，那是一种查不出来的静默行为漂移。
 */
export interface AccountIdentityProjectionRow {
  accountId: string;
  /** accounts.platform 原样文本（NOT NULL，库内有默认值）。 */
  platform: string;
  /** accounts.group_label 原样文本；库内 NULL 即 null（不与空串合并）。 */
  groupLabel: string | null;
  /** 账号创建时刻；历史异常 NULL 保持 null，不从当前时间猜。 */
  createdAt: number | null;
  /** automation 暂停闸使用的权威状态。 */
  status: 'active' | 'paused';
}

/**
 * 账号身份花名册的**只读来源端口**：由 accounts 的属主域（api）实现，automation 侧的投影刷新器消费。
 *
 * 实现契约：
 * - 返回**当前全量**账号；空数组是合法返回值，但消费方 MUST 把它当作「这次没读到东西」而不是
 *   「账号被清空了」（见 account-projection-store 的刷新语义）；
 * - 只读、无副作用；
 * - 抛错即视为本次刷新失败，MUST NOT 返回半截结果冒充成功。
 */
export interface AccountRosterSourcePort {
  listAccountIdentities(): Promise<readonly AccountIdentityProjectionRow[]>;
}

/**
 * 账号目录的**一行**：人类可读身份那一面（首选显示名 + 可选号的别名候选）。
 *
 * **与 {@link AccountIdentityProjectionRow} 刻意分开、而不是往它上面加两列**：那一行是守卫投影的
 * 载荷，逐列要求「原样、不归一」，且它背后有一条持久化的投影表；往那条载荷上加字段就得连同投影一起动。
 * 目录这一面既不进投影表、也不参与守卫判定，没有理由绑上去。
 *
 * 字段口径（MUST 逐条照办；任一处放宽都会让「不知道叫什么」冒充成一个真名字）：
 * - `displayName` 取统一解析器的首选名，**解析结果回落到裸账号 ID 时为 `null`**。
 *   裸 ID 不是名字：当成名字交出去，人类界面就会把机器标识显示成昵称；
 * - `names` 是按昵称选号用的候选（运营别名 / 平台昵称 / 运营标签），按显示优先级去重、**永不含账号 ID**。
 *   空数组是合法值，含义是「这个账号今天没有任何可读名」——消费方据此如实回「没有可用昵称」，
 *   MUST NOT 回落成按 ID 匹配；
 * - `platform` 是**归一后**的平台标识（与守卫投影那一行的原样文本刻意不同）：这一面的消费方要的是
 *   「按平台判定这个动作支不支持」，不是复刻库内文本。
 */
export interface AccountDirectoryRow {
  accountId: string;
  displayName: string | null;
  names: readonly string[];
  platform: PlatformId;
  status: 'active' | 'paused';
}
