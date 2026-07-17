/**
 * Surface / 能力静态解析器（change platform-registry-shape C1a）。
 *
 * 全部**纯函数**、**全部 fail-open**：registry 查不到 / 抛异常 ⇒ 回落到「今天行为」（读/评在 detail、动作放行、
 * 能力可用），绝不因查表失败静默砍掉一个支持平台。控制流一律读这里的静态表，**不读**运行时 observedSurface。
 */
import { platformRegistryEntry } from './registry.js';
import type { NoteScopedAction, NoteSupport, OrchestrationCapability, Surface } from './registry.js';
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
 * 客户端用量上限的声明来源（change platform-honest-usage-caps）。
 *
 * 六个客户端指标键各自映射到 registry 的哪张矩阵。**两张矩阵都要查**：`collect` 的不支持声明在 noteActions、
 * `follow` 的在 capabilities——只查一张会结构性看不见另一半（FB 会带着一个与收藏逐位同构的谎上线）。
 * `publish` 两张矩阵都没有（FB registry 注释自陈：编排词只登记「有云端消费者」的，publish 的接线在
 * FacebookPublishExecutor 专属路径）⇒ 声明为 'none' = **永不摘**，而不是靠「查不到」碰巧不摘。
 *
 * 全覆盖 Record：新增第七个客户端指标键时，typecheck 逼调用方**当场表态**它的支持性从哪读——
 * 这是本表存在的主要理由（载荷类型是宽松的 Partial<Record<…>>，漏一个键 typecheck 一声不吭）。
 */
type UsageCapSupportSource =
  | { matrix: 'note'; action: NoteScopedAction }
  | { matrix: 'capability'; capability: OrchestrationCapability }
  | { matrix: 'none' };

const USAGE_CAP_SUPPORT_SOURCE: Record<UiDailyUsageAction, UsageCapSupportSource> = {
  view: { matrix: 'note', action: 'read_content' },
  like: { matrix: 'note', action: 'like' },
  collect: { matrix: 'note', action: 'collect' },
  comment: { matrix: 'note', action: 'comment' },
  follow: { matrix: 'capability', capability: 'follow' },
  publish: { matrix: 'none' },
};

/**
 * 平台感知的用量上限投影（change platform-honest-usage-caps）：摘掉「该平台结构上做不到的动作」的上限。
 *
 * 云端不得供给它自己不可能兑现的上限——FB 收到「收藏 25/天」「关注 15/天」，客户端据此画出 `/25` +
 * 永远 0% 的进度条 = edge-companion-ui 明禁的 fabricated caps。判据 100% 来自 registry 既有声明。
 *
 * **只摘上限、绝不碰计数**：计数照发（客户端继续渲染「收藏 0」，只是不再有分母、进度条与完成态）。
 *
 * **本函数是只读消费者、不是第二道闸**（platform-browse-surface）：它只塑造「告诉客户端可以做什么」，
 * MUST NOT 下发 / 拒绝 / 取消任何命令，唯一审计拒绝点仍是 dispatch wrapper。
 *
 * **同步、纯、永不抛**：内部自兜 try/catch ⇒ fail-open 由函数自证，不依赖调用点记得包 try。
 * 平台为空 / 未知 / 查表抛异常 ⇒ **原样返回入参**（照发全部上限 = 本规则存在之前的行为）。
 * 摘掉一个上限只能由**显式的 supported:false 声明**造成，绝不能由「没查到」造成。
 *
 * **调用顺序**：必须在 pickDailyUsageCounts 之后。那一步把六键无条件物化（缺失 → 0），若先摘再 pick，
 * 摘掉的键会被补回 `0`，而 quotaSaturation 会算出 `totals(0) >= cap(0)` ⇒ 把该动作标成 saturated ⇒
 * 客户端渲染「0/0 今日计划已完成」——正是本 change 要除掉的那个谎，早一行重新引入。
 */
export function omitUnsupportedUsageCaps(
  platform: string | null | undefined,
  quotas: UiDailyUsageCounts,
): UiDailyUsageCounts {
  try {
    // 平台未知（镜像缺键 / 未登记）⇒ 不摘。fail-open 的第一道：绝不因「不知道」而扣掉一个上限。
    if (platform === null || platform === undefined || platform === '') return quotas;
    const entry = platformRegistryEntry(platform);
    const out: UiDailyUsageCounts = {};
    for (const action of Object.keys(USAGE_CAP_SUPPORT_SOURCE) as UiDailyUsageAction[]) {
      const cap = quotas[action];
      if (cap === undefined) continue;
      const source = USAGE_CAP_SUPPORT_SOURCE[action];
      let support: NoteSupport | undefined;
      if (source.matrix === 'note') support = entry.noteActions[source.action];
      else if (source.matrix === 'capability') support = entry.capabilities[source.capability];
      // 只摘**显式声明不支持**的；缺声明（'none' / 表里没这格）⇒ 照发。
      if (support && support.supported === false) continue;
      out[action] = cap;
    }
    return out;
  } catch {
    return quotas;
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
