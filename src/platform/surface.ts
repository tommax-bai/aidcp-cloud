/**
 * Surface / 能力静态解析器（change platform-registry-shape C1a）。
 *
 * 全部**纯函数**、**全部 fail-open**：registry 查不到 / 抛异常 ⇒ 回落到「今天行为」（读/评在 detail、动作放行、
 * 能力可用），绝不因查表失败静默砍掉一个支持平台。控制流一律读这里的静态表，**不读**运行时 observedSurface。
 */
import { platformRegistryEntry } from './registry.js';
import type { NoteScopedAction, OrchestrationCapability, Surface } from './registry.js';

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

/** 平台 feed 翻页停留地板（ms）；未声明 / 查表失败 ⇒ undefined（无地板，走默认）。 */
export function platformFeedScrollFloorMs(platform: string | null | undefined): number | undefined {
  try {
    return platformRegistryEntry(platform).pacing.feedScrollDwellFloorMs;
  } catch {
    return undefined;
  }
}
