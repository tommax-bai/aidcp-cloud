import type { ChatLlmClient } from '../llm/qwen.js';
import type { ImageProvider } from './image-provider.js';
import type { ObjectStore } from '../storage/object-store.js';
import { relocateImageToStore } from '../storage/object-store.js';
import type {
  DispatchDraft,
  DraftRefinementDrafts,
  DraftRefinementJob,
  DraftRefinementProgress,
  DraftRefinementSelection,
  DraftRefinementStage,
  RefineDraftPatch,
} from '../kernel/publish-draft-contract.js';
import type { DraftRefinementStore } from './draft-refinement.js';

class RefinementFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RefinementFailure';
  }
}

function jsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('response_not_object');
  return parsed as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('response_string_missing');
  return value.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('response_string_array_missing');
  }
  return value.map((item) => item.trim());
}

function textPrompt(job: DraftRefinementJob, draft: DispatchDraft): string {
  const boundary = job.scope === 'body'
    ? '只返回调整后的正文，不改标题、话题或图片。'
    : job.scope === 'selected_text'
      ? '只返回选中文字的替换文本，不补前后正文。'
      : '返回完整标题、正文和话题；配图由另一条受控链生成。';
  const output = job.scope === 'body'
    ? '{"content":"完整新正文"}'
    : job.scope === 'selected_text'
      ? '{"replacement":"仅替换片段"}'
      : '{"title":"标题","content":"完整正文","topics":["话题"]}';
  const selection = job.scope === 'selected_text' && job.selection && 'text' in job.selection
    ? `\n选中文字：${job.selection.text}`
    : '';
  return [
    '你正在调整一份尚未发布的小红书待审稿。严格遵守调整范围和用户指令，不添加事实性承诺，不解释思考过程。',
    boundary,
    `用户指令：${job.instruction}`,
    `当前标题：${draft.title ?? ''}`,
    `当前正文：${draft.content}`,
    `当前话题：${JSON.stringify(draft.metadata?.topics ?? [])}${selection}`,
    `只输出合法 JSON：${output}`,
  ].join('\n');
}

function imagePromptRequest(job: DraftRefinementJob, draft: DispatchDraft, count: number): string {
  const selected = job.scope === 'selected_image' && job.selection && 'imageUrl' in job.selection
    ? `只重做所选图片：${job.selection.imageUrl}`
    : `需要 ${count} 张彼此分工清楚的图片`;
  return [
    '为一份尚未发布的小红书图文稿生成中文文生图指令。不要复制水印、账号、品牌或原图文字，不解释思考过程。',
    `用户要求：${job.instruction}`,
    `标题：${draft.title ?? ''}`,
    `正文：${draft.content}`,
    selected,
    `只输出合法 JSON：{"prompts":[${Array.from({ length: count }, (_, i) => `"第${i + 1}张完整指令"`).join(',')}]}`,
  ].join('\n');
}

function publicRefinementError(reason: string): { code: string; message: string } {
  switch (reason) {
    case 'version_conflict': return { code: 'version_conflict', message: '稿件已经更新，本次调整没有覆盖新版本。请刷新后重新发起。' };
    case 'not_pending': return { code: 'not_pending', message: '这份稿件已不在待确认状态，不能继续调整。' };
    case 'invalid_selection': return { code: 'selection_stale', message: '所选文字或图片已经变化，本次调整没有写入。请重新选择。' };
    case 'not_found': return { code: 'draft_not_found', message: '没有找到当前账号的这份待审稿。' };
    default: return { code: 'refinement_rejected', message: '生成结果没有通过范围或完整性检查，原稿未变化。' };
  }
}

export interface DraftRefinementWorkerDeps {
  store: Pick<DraftRefinementStore, 'claimNext' | 'replaceProgress' | 'complete' | 'fail'>;
  drafts: DraftRefinementDrafts;
  llm: Pick<ChatLlmClient, 'chat'>;
  imageProvider: ImageProvider;
  objectStore?: ObjectStore;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  refreshPreview?: (recordId: number) => Promise<void> | void;
}

export class DraftRefinementWorker {
  private readonly clock: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(private readonly deps: DraftRefinementWorkerDeps) {
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? console;
  }

  async processNext(workerId = 'draft-refinement-worker'): Promise<boolean> {
    const job = await this.deps.store.claimNext(workerId, 15 * 60_000, this.clock());
    if (!job) return false;
    const token = job.claimToken;
    if (!token) return false;
    let progress = [...job.progress];
    const step = async (stage: DraftRefinementStage, summary: string): Promise<void> => {
      progress = progress.map((item) => item.status === 'running' ? { ...item, status: 'completed' as const } : item);
      progress.push({ seq: progress.length + 1, stage, status: 'running', summary, at: this.clock() });
      const stored = await this.deps.store.replaceProgress(job.id, token, progress);
      if (!stored) throw new RefinementFailure('claim_lost', '任务执行权已失效，本次没有写入稿件。');
    };
    const finishProgress = (): DraftRefinementProgress[] => progress.map((item) => (
      item.status === 'running' ? { ...item, status: 'completed' as const } : item
    ));

    try {
      await step('计划', `已锁定“${this.scopeLabel(job)}”范围，先核对必须保持不变的内容。`);
      const draft = await this.deps.drafts.loadForDispatch(job.recordId);
      if (!draft || draft.accountId !== job.accountId) throw new RefinementFailure('draft_not_found', '没有找到当前账号的这份待审稿。');
      if (draft.status !== 'pending_approval') throw new RefinementFailure('not_pending', '这份稿件已不在待确认状态。');
      if (draft.contentVersion !== job.expectedVersion) throw new RefinementFailure('version_conflict', '稿件已经更新，本次调整没有覆盖新版本。');
      this.validateSelection(job.selection, job, draft);

      await step('判断', this.boundarySummary(job, draft));
      const patch: RefineDraftPatch = {};
      if (job.scope === 'whole' || job.scope === 'body' || job.scope === 'selected_text') {
        await step('生成', job.scope === 'selected_text' ? '正在只重写选中的文字，前后正文保持不变。' : '正在按要求生成新的文字版本。');
        let output: Record<string, unknown>;
        try {
          output = jsonObject(await this.deps.llm.chat(
            [{ role: 'user', content: textPrompt(job, draft) }],
            { role: job.scope === 'whole' ? 'publish:ContentCreator' : 'publish:FaithfulDraftWriter', accountId: job.accountId },
          ));
        } catch (err) {
          this.logger.warn(`[draft-refinement] text generation failed job=${job.id}: ${err instanceof Error ? err.message : String(err)}`);
          throw new RefinementFailure('text_generation_failed', '文字调整没有生成可用结果，原稿未变化，请稍后重试。');
        }
        if (job.scope === 'selected_text') {
          const selected = job.selection as Extract<DraftRefinementSelection, { start: number }>;
          const replacement = nonEmptyString(output.replacement);
          patch.content = `${draft.content.slice(0, selected.start)}${replacement}${draft.content.slice(selected.end)}`;
        } else if (job.scope === 'body') {
          patch.content = nonEmptyString(output.content);
        } else {
          patch.title = nonEmptyString(output.title);
          patch.content = nonEmptyString(output.content);
          patch.topics = stringArray(output.topics);
        }
      }

      if (job.scope === 'whole' || job.scope === 'images' || job.scope === 'selected_image') {
        const currentImages = draft.imageUrls;
        const imageCount = job.scope === 'selected_image' ? 1 : Math.max(1, currentImages.length);
        await step('生成', imageCount === 1 ? '正在生成目标配图。' : `正在生成 ${imageCount} 张分工明确的配图。`);
        let prompts: string[];
        try {
          const output = jsonObject(await this.deps.llm.chat(
            [{ role: 'user', content: imagePromptRequest(job, draft, imageCount) }],
            { role: 'publish:ImagePromptComposer', accountId: job.accountId },
          ));
          prompts = stringArray(output.prompts);
        } catch (err) {
          this.logger.warn(`[draft-refinement] image planning failed job=${job.id}: ${err instanceof Error ? err.message : String(err)}`);
          throw new RefinementFailure('image_plan_failed', '配图计划没有生成可用结果，原稿未变化，请稍后重试。');
        }
        if (prompts.length !== imageCount) throw new RefinementFailure('image_plan_incomplete', '配图计划数量不完整，原稿未变化。');
        const generated: string[] = [];
        for (let index = 0; index < prompts.length; index += 1) {
          await step('生成', `正在生成第 ${index + 1}/${prompts.length} 张配图，已完成 ${generated.length} 张。`);
          const reference = job.scope === 'selected_image'
            ? (job.selection && 'imageUrl' in job.selection ? job.selection.imageUrl : undefined)
            : currentImages[index];
          const result = await this.deps.imageProvider.generate(
            prompts[index],
            undefined,
            reference ? { referenceImages: [reference] } : undefined,
          );
          if (!result.url) throw new RefinementFailure('image_generation_failed', `第 ${index + 1} 张图片生成失败，原稿未变化。`);
          const stableUrl = this.deps.objectStore
            ? await relocateImageToStore(result.url, `publish/refinement/${job.accountId}/${job.id}/${index}`, {
                store: this.deps.objectStore,
                ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
                logger: this.logger,
              })
            : result.url;
          if (!stableUrl) throw new RefinementFailure('image_relocation_failed', `第 ${index + 1} 张图片转存失败，原稿未变化。`);
          generated.push(stableUrl);
        }
        if (generated.length !== imageCount) throw new RefinementFailure('image_generation_incomplete', '配图未全部完成，原稿未变化。');
        if (job.scope === 'selected_image') {
          const selectedUrl = (job.selection as { imageUrl: string }).imageUrl;
          const selectedIndex = currentImages.indexOf(selectedUrl);
          patch.images = currentImages.map((url, index) => index === selectedIndex ? generated[0] : url);
        } else {
          patch.images = generated;
        }
      }

      await step('检查', '正在核对调整范围、内容完整性和未改部分是否保持原样。');
      await step('确认', '检查通过，正在把完整结果写入新的待审版本；不会自动发布。');
      const written = await this.deps.drafts.refineDraft(
        job.recordId,
        job.accountId,
        job.expectedVersion,
        job.scope,
        job.selection,
        patch,
        `draft-refinement:${job.id}`,
      );
      if (!written.ok) {
        const failure = publicRefinementError(written.reason);
        throw new RefinementFailure(failure.code, failure.message);
      }
      progress = finishProgress();
      if (!(await this.deps.store.complete(job.id, token, written.contentVersion, progress))) {
        throw new RefinementFailure('claim_lost', '任务完成回执未能保存，请刷新稿件确认版本。');
      }
      await this.deps.refreshPreview?.(job.recordId);
      return true;
    } catch (err) {
      const failure = err instanceof RefinementFailure
        ? err
        : new RefinementFailure('refinement_failed', '调整没有完成，原稿未变化，请稍后重试。');
      this.logger.warn(`[draft-refinement] job=${job.id} code=${failure.code}: ${failure.message}`);
      await this.deps.store.fail(job.id, token, failure.code, failure.message, progress).catch(() => false);
      return true;
    }
  }

  private validateSelection(selection: DraftRefinementSelection, job: DraftRefinementJob, draft: DispatchDraft): void {
    if (job.scope === 'selected_text') {
      if (!selection || !('start' in selection) || !Number.isInteger(selection.start) || !Number.isInteger(selection.end)
        || selection.start < 0 || selection.end <= selection.start || selection.end > draft.content.length
        || draft.content.slice(selection.start, selection.end) !== selection.text) {
        throw new RefinementFailure('selection_stale', '所选文字已经变化，请重新选择。');
      }
    } else if (job.scope === 'selected_image') {
      if (!selection || !('imageUrl' in selection) || draft.imageUrls.filter((url) => url === selection.imageUrl).length !== 1) {
        throw new RefinementFailure('selection_stale', '所选图片已经变化，请重新选择。');
      }
    } else if (selection !== null) {
      throw new RefinementFailure('invalid_selection', '当前调整范围不接受选区。');
    }
  }

  private scopeLabel(job: DraftRefinementJob): string {
    return ({ whole: '整篇内容', body: '仅正文', images: '全部配图', selected_image: '所选图片', selected_text: '所选文字' })[job.scope];
  }

  private boundarySummary(job: DraftRefinementJob, draft: DispatchDraft): string {
    switch (job.scope) {
      case 'body': return `只调整正文；标题、${draft.imageUrls.length} 张配图和发布设置保持不变。`;
      case 'images': return `只重做 ${Math.max(1, draft.imageUrls.length)} 张配图；标题、正文、话题和发布设置保持不变。`;
      case 'selected_image': return '只替换选中的一张图片；其它图片顺序和全部文字保持不变。';
      case 'selected_text': return '只替换选中的文字；前后正文、标题、话题和配图保持不变。';
      case 'whole': return '允许调整标题、正文、话题和配图；发布方式、可见范围和账号保持不变。';
    }
  }
}
