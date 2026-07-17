/**
 * Surface / 能力静态解析器（change platform-registry-shape C1a）。
 *
 * 全部**纯函数**、**全部 fail-safe 到「今天行为」**：registry 查不到 / 抛异常 ⇒ 回落到今天（读/评在 detail、
 * 动作放行、能力可用），绝不因查表失败静默砍掉一个支持平台。控制流一律读这里的静态表，**不读**运行时
 * observedSurface。
 *
 * 注意「今天行为」不等于「一律放行」：对 change platform-honest-usage-metrics 引入的、今天客户端根本没有的
 * 指标（join_group），「今天行为」是**不发**——查表失败时照样不发。fail-safe 的方向永远由「现状是什么」
 * 决定，不由某个全局默认决定。详见 omitUnsupportedUsageMetrics。
 */
import { platformRegistryEntry } from './registry.js';
import type { NoteScopedAction, NoteSupport, OrchestrationCapability, Surface } from './registry.js';
import { UI_DAILY_USAGE_ACTIONS } from '../comm/protocol.js';
import type { UiDailyUsageAction, UiDailyUsageCounts } from '../comm/protocol.js';

/** read_content 在哪个 surface 完成。fail-open = 'detail'（今天所有平台都先开详情）。 */
export function resolveReadSurface(platform: string | null | undefined): Surface {
  try {
    return platformRegistryEntry(platform).noteSurfaces.read_content;
  } catch {
    return 'detail';
  }
}

/** comment 在哪个 surface 完成。fail-open = 'detail'。 */
export function resolveCommentSurface(platform: string | null | undefined): Surface {
  try {
    return platformRegistryEntry(platform).noteSurfaces.comment;
  } catch {
    return 'detail';
  }
}

/**
 * 循环闭合的纯决策：读完一篇后是「返回列表（back）」还是「继续下滚（scroll）」。
 * - 已迁移进详情页（为评论离开过列表）⇒ 必须 back。
 * - 否则：read 在 feed（就地读、从未离开列表）⇒ scroll；read 在 detail（离开过列表）⇒ back。
 * 小红书 read=detail 且迁移结构不可达 ⇒ 恒 back（与事件到达顺序无关）。
 */
export function loopClosure(readSurface: Surface, migratedToDetail: boolean): 'back' | 'scroll' {
  if (migratedToDetail) return 'back';
  return readSurface === 'feed' ? 'scroll' : 'back';
}

/** 逐帖动作是否支持。fail-open = true（查表失败照常下发 = 今天行为）。 */
export function isNoteActionSupported(platform: string | null | undefined, action: NoteScopedAction): boolean {
  try {
    return platformRegistryEntry(platform).noteActions[action].supported;
  } catch {
    return true;
  }
}

/** 逐帖动作被拒的 reason（供审计）；支持 / 查表失败 ⇒ null。 */
export function noteActionRefusalReason(
  platform: string | null | undefined,
  action: NoteScopedAction,
): string | null {
  try {
    const support = platformRegistryEntry(platform).noteActions[action];
    return support.supported ? null : support.reason;
  } catch {
    return null;
  }
}

/** 编排能力是否支持。fail-open = true。 */
export function isOrchestrationCapabilitySupported(
  platform: string | null | undefined,
  capability: OrchestrationCapability,
): boolean {
  try {
    return platformRegistryEntry(platform).capabilities[capability].supported;
  } catch {
    return true;
  }
}

/**
 * 客户端用量指标的声明来源（change platform-honest-usage-caps → platform-honest-usage-metrics）。
 *
 * 每个客户端指标键映射到 registry 的哪张矩阵。**两张矩阵都要查**：`collect` 的不支持声明在 noteActions、
 * `follow` 的在 capabilities——只查一张会结构性看不见另一半（FB 会带着一个与收藏逐位同构的谎上线）。
 * `publish` 两张矩阵都没有（FB registry 注释自陈：编排词只登记「有云端消费者」的，publish 的接线在
 * FacebookPublishExecutor 专属路径）⇒ 声明为 'none' = **永不动**，而不是靠「查不到」碰巧不动。
 *
 * `statusQuo` 是本表第二个字段，也是最容易被下一个人漏掉的那个：**它记的是「本规则不存在时，客户端有没有
 * 这一格」**。fail-safe 的方向由它决定，而不是由某个全局的 fail-open 常量决定：
 *   - `'supplied'`（既有六键，今天就在屏幕上）⇒ 只有**显式 supported:false** 才摘。
 *   - `'absent'`（如 join_group，今天屏幕上根本没有）⇒ 只有**显式 supported:true** 才加。
 * 这两条看起来相反，其实是同一条：**只有显式声明才能改变现状**。若给 'absent' 的键沿用 'supplied' 的
 * fail-open，平台未知的账号会凭空长出一个「加群」格——用一个新谎去治一个旧谎。
 *
 * 全覆盖 Record：新增指标键时，typecheck 逼调用方**当场表态**它的支持性从哪读、它的现状是哪个——
 * 这是本表存在的主要理由（载荷类型是宽松的 Partial<Record<…>>，漏一个键 typecheck 一声不吭）。
 */
type UsageMetricDeclaration =
  | { matrix: 'note'; action: NoteScopedAction }
  | { matrix: 'capability'; capability: OrchestrationCapability }
  | { matrix: 'none' };

interface UsageMetricSupportSource {
  /** 本规则之前，客户端有没有这一格。决定 fail-safe 的方向，见上方注释。 */
  statusQuo: 'supplied' | 'absent';
  declaration: UsageMetricDeclaration;
}

const USAGE_METRIC_SUPPORT_SOURCE: Record<UiDailyUsageAction, UsageMetricSupportSource> = {
  view: { statusQuo: 'supplied', declaration: { matrix: 'note', action: 'read_content' } },
  like: { statusQuo: 'supplied', declaration: { matrix: 'note', action: 'like' } },
  collect: { statusQuo: 'supplied', declaration: { matrix: 'note', action: 'collect' } },
  comment: { statusQuo: 'supplied', declaration: { matrix: 'note', action: 'comment' } },
  follow: { statusQuo: 'supplied', declaration: { matrix: 'capability', capability: 'follow' } },
  publish: { statusQuo: 'supplied', declaration: { matrix: 'none' } },
  join_group: { statusQuo: 'absent', declaration: { matrix: 'capability', capability: 'group_join' } },
};

/**
 * 「本规则不存在时该发什么」——每一条 fail-safe 路径的落点。
 *
 * ⚠️ 这里**不能**图省事 `return counts`。入参是 pickDailyUsageCounts 的产物、七键全物化，其中
 * join_group 的现状是「客户端根本没有这一格」⇒ 原样返回会把加群指标泄给平台未知的账号（小红书没有群）。
 * 「保持现状」= 留下现状本就在发的键、丢掉现状本就没有的键，而不是「原样透传」。
 *
 * 本函数不查 registry、不抛。
 */
function statusQuoUsageMetrics(counts: UiDailyUsageCounts): UiDailyUsageCounts {
  const out: UiDailyUsageCounts = {};
  for (const action of UI_DAILY_USAGE_ACTIONS) {
    if (USAGE_METRIC_SUPPORT_SOURCE[action].statusQuo !== 'supplied') continue;
    const value = counts[action];
    if (value !== undefined) out[action] = value;
  }
  return out;
}

/**
 * 平台感知的用量指标投影（change platform-honest-usage-metrics，扩自 platform-honest-usage-caps）：
 * 摘掉「该平台结构上做不到的动作」的**整个指标**（上限**与**计数），并放出「该平台真做、且风控真记账」的指标。
 *
 * 前身只摘上限、刻意留计数，理由是「计数是事实、只有承诺会撒谎」。**那个理由在结构不支持的动作上不成立**：
 * FB 的「收藏 0」不是观测，是 pickDailyUsageCounts 对一个不存在的动作**物化**出来的常量。它读作「今天还没
 * 收藏」、暗示明天会有数字，而真相是「这个平台没有收藏」。它与那条永远 0% 的进度条是同一个谎的两半。
 *
 * 反向同理：加群是 FB 真做、真烧日配额（均衡档 3/天）、后台用量表真在显示的动作。客户端看不见它，
 * 等于对同一个账号，两块屏幕说不同的话。
 *
 * **本函数是只读消费者、不是第二道闸**（platform-browse-surface）：它只塑造「告诉客户端账号在做什么」，
 * MUST NOT 下发 / 拒绝 / 取消任何命令。唯一审计拒绝点仍是 dispatch wrapper；加群的闸仍在 join scheduler。
 *
 * **同步、纯、永不抛**：内部自兜 try/catch ⇒ fail-safe 由函数自证，不依赖调用点记得包 try。
 * 平台为空 / 未知 / 查表抛异常 ⇒ 回落 statusQuoUsageMetrics（**不是**原样返回入参，理由见该函数注释）。
 * 摘掉一个既有指标只能由**显式 supported:false** 造成；放出一个新指标只能由**显式 supported:true** 造成。
 * 两者都绝不能由「没查到」造成。
 *
 * **调用顺序**：必须在 pickDailyUsageCounts 之后。那一步把全部键无条件物化（缺失 → 0），若先摘再 pick，
 * 摘掉的键会被补回 `0`，而 quotaSaturation 会算出 `totals(0) >= cap(0)` ⇒ 把该动作标成 saturated ⇒
 * 客户端渲染「0/0 今日计划已完成」——正是本 change 要除掉的那个谎，早一行重新引入。typecheck 全绿。
 */
export function omitUnsupportedUsageMetrics(
  platform: string | null | undefined,
  counts: UiDailyUsageCounts,
): UiDailyUsageCounts {
  try {
    // 平台未知（镜像缺键 / 未登记）⇒ 保持现状。**这道 early return 必须在 platformRegistryEntry 之前**：
    // normalizePlatformId 对缺失值静默回落小红书，直接查表会把「不知道」当成「是小红书」。
    if (platform === null || platform === undefined || platform === '') return statusQuoUsageMetrics(counts);
    const entry = platformRegistryEntry(platform);
    const out: UiDailyUsageCounts = {};
    for (const action of UI_DAILY_USAGE_ACTIONS) {
      const value = counts[action];
      if (value === undefined) continue;
      const { statusQuo, declaration } = USAGE_METRIC_SUPPORT_SOURCE[action];
      let support: NoteSupport | undefined;
      if (declaration.matrix === 'note') support = entry.noteActions[declaration.action];
      else if (declaration.matrix === 'capability') support = entry.capabilities[declaration.capability];
      const keep = statusQuo === 'supplied'
        ? support?.supported !== false // 现状=有：只有显式不支持才摘；缺声明（'none' / 表里没这格）⇒ 照发。
        : support?.supported === true; // 现状=无：只有显式支持才加；缺声明 ⇒ 不加。
      if (keep) out[action] = value;
    }
    return out;
  } catch {
    return statusQuoUsageMetrics(counts);
  }
}

/** 平台 feed 翻页停留地板（ms）；未声明 / 查表失败 ⇒ undefined（无地板，走默认）。 */
export function platformFeedScrollFloorMs(platform: string | null | undefined): number | undefined {
  try {
    return platformRegistryEntry(platform).pacing.feedScrollDwellFloorMs;
  } catch {
    return undefined;
  }
}
