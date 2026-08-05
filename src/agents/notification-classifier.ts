/**
 * notification_classifier — 内容分类 + 评论管线的**入口路由闸**。
 *
 * 收 notification.items.arrived → 校验巡视活跃 → **先按类别定性这批条目是不是「评论和@」栏来的**
 * → 是则挑值得通知的项（v1：评论与@皆值得，仅滤掉空内容；此处是未来接 LLM 精筛的缝）→ classified
 * （worthy 可能为空，由 deduper 收尾）；异常 → classify_failed（交给 resumer 收敛）。
 *
 * **文件头此前自陈「仅评论/@ 路径」，而这恰恰是当时无人守住的那个前提**
 * （change route-notification-items-by-category）：`notification.items` 是一条**共用**上报通道——
 * 「赞和收藏」/「新增关注」两栏在清未读回执之外顺带回传的发送者条目（喂通知联系人名册用）走的是同一条。
 * 本角色此前把到达的每一批都当评论抽取结果处理，实际拦住那批赞/收藏/关注的只有下面那条按正文文案写的
 * 正则；正文一旦不长成那几种固定说法（平台改文案 / 多语言 / 正文位取到笔记标题），它就会被推去飞书，
 * 直接违反已上线规格「点赞、收藏、新增关注 MUST NOT 发飞书」。附带后果是同一类被收尾两次、多发一条返回导航。
 *
 * 定性依据用云端**自己点名**的那一栏（`ctx.excursionSelectedCategory`），不是条目正文、也不新增协议字段。
 * 被拒进评论管线的批次**仍照常到达**——名册那条通路在 `server.ts` 订阅同一事件，一个字节不动。
 *
 * 消费事件：notification.items.arrived
 * 产出事件：notification.classified / notification.classify_failed
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { NotificationCategory, RoleName } from '../event-bus/types.js';
import type { NotificationItem } from '../comm/protocol.js';

/**
 * 条目类型 → 它属于哪条通路。**穷举 Record 是故意的**：新增一种 kind 时 typecheck 当场失败，
 * 逼作者明确它走哪边。用 `Set` / `satisfies` 都查不出遗漏（漏一个只是少一条，编译照过）。
 */
const KIND_LANES: Record<NotificationItem['kind'], 'comment_pipeline' | 'contacts_only'> = {
  comment: 'comment_pipeline',
  mention: 'comment_pipeline',
  like: 'contacts_only',
  collect: 'contacts_only',
  follow: 'contacts_only',
};

/** 这批条目该往哪走。`kindDisagreement` = 云端选中的那一栏与条目自带类型互相打架。 */
export type NotificationBatchRoute =
  | { lane: 'comment_pipeline'; kindDisagreement: boolean }
  | {
      lane: 'contacts_only';
      /** `category_not_comments` = 选中的是赞收藏/新增关注；`category_unselected` = 本趟还没选过任何一栏。 */
      reason: 'category_not_comments' | 'category_unselected';
      kindDisagreement: boolean;
    };

/**
 * 定性一批到达的通知条目：进评论管线，还是只喂联系人名册。
 *
 * **唯一判据是云端自己点名的那一栏**——巡视是云端主动选类、主动下发该类浏览命令的，「现在在看哪一栏」
 * 是它自己的决定，不必经执行端往返。条目自带的 kind 只作**交叉校验纵深**：现网执行端的两条实现路径里，
 * 该字段本就是按云端下发的命令类别推导出来的（只有「赞 vs 收藏」用了行内文案），拿它当唯一判据既不更
 * 可靠、还多一次可能出错的传递。两者打架时按云端选中的那一栏处置，但**必须报出来**——
 * 不一致本身是值得看见的信号，MUST NOT 静默取其一。
 */
export function routeNotificationBatch(input: {
  selectedCategory: NotificationCategory | null;
  items: readonly (NotificationItem | null | undefined)[];
}): NotificationBatchRoute {
  const items = input.items ?? [];
  // 未知 kind（执行端版本漂移 / 脏数据）恒不算评论：查表落空 ⇒ undefined ⇒ 不等于 comment_pipeline。
  const hasCommentKind = items.some((it) => !!it && KIND_LANES[it.kind] === 'comment_pipeline');
  if (input.selectedCategory === 'comments') {
    return {
      lane: 'comment_pipeline',
      // 反向不一致：点名了评论栏，可这批（非空）里一条评论/@ 都没有。
      kindDisagreement: items.length > 0 && !hasCommentKind,
    };
  }
  return {
    lane: 'contacts_only',
    reason: input.selectedCategory === null ? 'category_unselected' : 'category_not_comments',
    // 正向不一致：点名的不是评论栏，却混进了评论/@ 类型的条目。
    kindDisagreement: hasCommentKind,
  };
}

export class NotificationClassifier extends BaseRole {
  readonly roleName: RoleName = 'notification_classifier';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.items.arrived', (p) => this.classify(p.items)),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private classify(items: NotificationItem[]): void {
    if (!this.ctx.excursionActive) return;
    const epoch = this.ctx.excursionEpoch ?? 0;
    const list = items ?? [];
    const selectedCategory = this.ctx.excursionSelectedCategory;
    const routing = routeNotificationBatch({ selectedCategory, items: list });
    const selectedLabel = selectedCategory ?? '未选';
    if (routing.kindDisagreement) {
      // 两个判据打架：按云端选中的那一栏处置，但绝不静默——具名留痕，让不一致本身可被发现。
      this.log(
        `判据不一致：云端选中分类=${selectedLabel}，但本批 ${list.length} 条的类型` +
          `${routing.lane === 'comment_pipeline' ? '无一为评论/@' : '含评论/@'}` +
          `（以云端选中分类为准）epoch=${epoch}`,
      );
    }
    if (routing.lane === 'contacts_only') {
      // 拒的是「进评论管线」，不是「到达」：这批条目仍会被通知联系人名册那条订阅收下。
      // 一条事件都不发 ⇒ 不分类、不去重、不发飞书、不产生 category_handled{comments}。
      // 与「评论栏真的一条都没有」是两态：后者仍走下面的正常路径并由 deduper 收尾本类。
      this.log(
        `本批 ${list.length} 条非「评论和@」栏（${routing.reason}，云端选中分类=${selectedLabel}）→ ` +
          `不进评论管线（仍供通知联系人名册）epoch=${epoch}`,
      );
      return;
    }
    try {
      const worthy = list.filter((it) => {
        if (!it || typeof it.content !== 'string') return false;
        const c = it.content.trim();
        if (c.length === 0) return false; // 无正文（含边缘正文缺失诚实发空串的路径）
        // 防御性过滤（NCQ-1 纵深）：边缘正文子选择器在 reds- 命名下漏掉时，旧码会回退整行 textContent → 飞书 blob。
        // 边缘已改为正文缺失发空串，此处再拦两类残留：正文 == 用户名（错抓到名字）、正文是纯动作标签（无真实评论）。
        if (it.fromUser && c === it.fromUser.trim()) return false;
        if (/^(赞了你的(评论|笔记)|收藏了你的笔记|关注了你|回复了你的?(评论|笔记)?|点赞)$/.test(c)) return false;
        // 已删除评论占位（真机校准 2026-06-24 观察到「该评论已删除」会进抽取结果）：非真实内容，不打扰。
        if (/^(该)?评论已删除$/.test(c)) return false;
        return true;
      });
      this.log(`分类：${worthy.length}/${list.length} 条值得通知 epoch=${epoch}`);
      this.emit('notification.classified', { worthy, epoch, ts: Date.now() });
    } catch (err) {
      this.log(`分类失败（不吞，交 resumer 收敛）：${(err as Error).message}`);
      this.emit('notification.classify_failed', { epoch, reason: (err as Error).message, ts: Date.now() });
    }
  }
}
