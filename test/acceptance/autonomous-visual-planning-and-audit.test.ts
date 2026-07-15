import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import { ImageSetPlannerRole } from '../../src/publish-agent/roles/image-set-planner.js';
import { ImagePromptComposerRole } from '../../src/publish-agent/roles/image-prompt-composer.js';
import { ImageGeneratorRole } from '../../src/publish-agent/roles/image-generator.js';
import type { PipelineFields, TriggerInput } from '../../src/publish-agent/types.js';
import type { VisualAuditInput } from '../../src/publish-agent/visual-fidelity-auditor.js';

const clock = () => 1700000000000;
const logger = { log() {}, warn() {}, error() {} };

test('自主创作从整组视觉计划、八类参数路由到无来源正文审计完整闭环', async () => {
  const llm = {
    chat: async (messages: Array<{ content: string }>) => {
      if (messages[0].content.includes('配图选题师')) {
        return JSON.stringify({
          imageCount: 2,
          visualSetBrief: {
            narrativeArc: '先呈现部署问题，再解释解决闭环',
            continuityRules: ['统一冷蓝和米白', '重复使用终端窗口与环形箭头'],
            typeMixRationale: '场景摄影承载问题，信息图解释因果',
          },
          themes: [
            {
              slotRole: 'cover_hook', subject: '部署失败现场',
              contentVisualBrief: {
                narrativeMoment: '终端刚提示部署失败', emotion: '受挫但克制', emotionIntensity: 0.55,
                action: '开发者停下来检查日志', environment: '夜间工作台', avoid: ['商业摆拍'],
                categoryBrief: {
                  kind: 'scene_photo', timeAndWeather: '夜间室内', location: '工作台', humanPresence: '一名虚构开发者背影',
                  eventTrace: '终端刚出现错误提示', spatialRelationship: '人物、屏幕与笔记本形成三角关系', motionLevel: '低动态',
                },
              },
            },
            {
              slotRole: 'explanation', subject: '依赖、显存与验证闭环',
              contentVisualBrief: {
                narrativeMoment: '解释排查和验证关系', emotion: '理性', emotionIntensity: 0.35,
                action: '沿闭环阅读', environment: '无数值信息图', avoid: ['编造性能数字'],
                categoryBrief: {
                  kind: 'infographic_chart', claim: '排查必须回到验证', relationship: '循环', entities: ['依赖', '显存', '验证'],
                  direction: '顺时针', steps: ['检查依赖', '核对显存', '重新验证'], dataPolicy: '正文无可靠数字，只画无数值关系',
                },
              },
            },
          ],
          styleHint: '克制的工程记录',
        });
      }
      return JSON.stringify({ imagePrompt: messages[1].content.includes('依赖、显存与验证闭环') ? '无数值排查闭环关系图' : '夜间工作台上的部署排查现场' });
    },
    complete: async () => '',
  };
  const providerPrompts: string[] = [];
  const auditInputs: VisualAuditInput[] = [];
  const context = new PipelineContext<PipelineFields>();
  new ImageSetPlannerRole({ llmClient: llm as never, maxImages: 2, clock, logger }).register(context);
  new ImagePromptComposerRole({ llmClient: llm as never, clock, logger }).register(context);
  new ImageGeneratorRole({
    imageProvider: {
      generate: async (prompt) => {
        providerPrompts.push(prompt);
        return { url: `https://out.test/${providerPrompts.length}.jpg`, referenceStatus: 'skipped' };
      },
    },
    visualAuditor: {
      audit: async (input) => {
        auditInputs.push(input);
        return { status: 'passed', reason: '槽位、类型与正文一致', auditedAt: clock() };
      },
    },
    auditEnabled: () => false,
    autonomousAuditEnabled: () => true,
    perImageTimeoutMs: 500,
    maxImages: 2,
    concurrency: 2,
    clock,
    logger,
  }).register(context);

  context.write('trigger', { accountId: 'acceptance-autonomous', generateInput: {} } as unknown as TriggerInput);
  context.write('postCategory', { category: 'tech', classifiedAt: clock() });
  context.write('coverCardPlan', {
    coverForm: 'generative', card: null, sensedForm: 'unknown', sensedSource: 'none', gateReason: 'flag_off', decidedAt: clock(),
  });
  context.write('createdContent', {
    title: '部署失败后我改了排查顺序',
    content: '依赖和显存都可能让部署失败。真正有用的不是记住一个答案，而是每次修改后重新验证，形成排查闭环。',
    tags: ['部署'], tone: 'technical', style: {}, createdAt: clock(),
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  const setPlan = context.get('imageSetPlan')!;
  const imagePlan = context.get('imagePlan')!;
  const directive = context.get('imageDirective')!;

  assert.equal(setPlan.visualSetBrief?.source, 'model');
  assert.deepEqual(setPlan.themes.map((theme) => theme.slotRole), ['cover_hook', 'explanation']);
  assert.deepEqual(imagePlan.visualRoutes, ['generative', 'specialized_generative']);
  assert.deepEqual(imagePlan.slotRoles, ['cover_hook', 'explanation']);
  assert.equal(providerPrompts.length, 2);
  assert.equal(auditInputs.length, 2);
  assert.ok(auditInputs.every((input) => input.referenceUrl === undefined));
  assert.deepEqual(auditInputs.map((input) => input.expectedKind), ['scene_photo', 'infographic_chart']);
  assert.equal(directive.visualReferenceAudit?.bindingMode, 'none');
  assert.deepEqual(directive.visualReferenceAudit?.slots.map((slot) => slot.auditMode), ['content_alignment', 'content_alignment']);
  assert.deepEqual(directive.visualReferenceAudit?.slots.map((slot) => slot.finalStatus), ['passed', 'passed']);
  assert.equal(directive.visualReferenceAudit?.visualSetBrief?.source, 'model');
});
