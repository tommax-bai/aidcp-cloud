/**
 * 测试用 content 层角色工厂注册表。
 *
 * 生产由组合根 `src/server.ts` 的 `CONTENT_ROLE_FACTORIES` 注入；测试不经 server，故此处提供等价装配，
 * 让 RoleDispatcher 在测试里也能构造 4 个 content 角色（concept_extractor / curated_note_evaluator /
 * curated_comment_evaluator / valuable_comment_archivist）。测试目录不被边界扫描器纳管，可自由 import content 类。
 */
import type {
  RoleFactoryRegistry,
  ConceptExtractorFactoryOptions,
  ValuableCommentArchivistFactoryOptions,
  CuratedNoteEvaluatorFactoryOptions,
  CuratedCommentEvaluatorFactoryOptions,
} from '../../src/orchestrator/role-dispatcher.js';
import { ConceptExtractorRole } from '../../src/agents/concept-extractor-role.js';
import { CuratedNoteEvaluator, type CuratedNoteSink } from '../../src/agents/curated-note-evaluator.js';
import { CuratedCommentEvaluator, type CuratedCommentSink } from '../../src/agents/curated-comment-evaluator.js';
import { ValuableCommentArchivist } from '../../src/agents/valuable-comment-archivist.js';
import type { TextCardTranscriber } from '../../src/kernel/text-card-transcriber-port.js';

/**
 * 与生产 `CONTENT_ROLE_FACTORIES` 逐条对齐的测试装配（含入参标注为构造契约、opaque 句柄就地 narrow 的同款做法，
 * 以便本装配也承载「契约 → 角色构造签名」的类型检查）。
 */
export function contentRoleFactories(): RoleFactoryRegistry {
  return {
    concept_extractor: (o: ConceptExtractorFactoryOptions) => new ConceptExtractorRole(o),
    valuable_comment_archivist: (o: ValuableCommentArchivistFactoryOptions) => new ValuableCommentArchivist(o),
    curated_note_evaluator: (o: CuratedNoteEvaluatorFactoryOptions) => {
      const { curatedStore, textCardTranscriber, ...rest } = o;
      return new CuratedNoteEvaluator({
        ...rest,
        curatedStore: curatedStore as CuratedNoteSink,
        // 与生产同形：句柄缺时**明说「依赖没接上」**，绝不省略字段。
        // 省略在角色内会退化成与「旗标关掉了」一模一样的假，而本文件的存在意义正是
        // 「与生产逐条对齐」——一旦这里省略而生产不省略，那句自述就变成假的，
        // 且偏差方向是**测试比生产宽松**：拆仓引入的漏传在测试里照样绿。
        textCardTranscriber: textCardTranscriber
          ? { state: 'wired', transcriber: textCardTranscriber as TextCardTranscriber }
          : { state: 'unavailable', reason: 'not_wired_by_composition_root' },
      });
    },
    curated_comment_evaluator: (o: CuratedCommentEvaluatorFactoryOptions) => {
      const { curatedStore, ...rest } = o;
      return new CuratedCommentEvaluator({ ...rest, curatedStore: curatedStore as CuratedCommentSink });
    },
  };
}
