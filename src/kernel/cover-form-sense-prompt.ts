/**
 * 封面形态感知的**纯视觉指令构建段**（change decouple-behavior-class-ports 析出）。
 *
 * 从 src/publish-agent/cover-form-sensor.ts（content）抬出：`buildCoverFormSensePrompt` 纯函数
 * （零入参、返回固定视觉判定指令，零 import / 零连库 / 零进程内活状态）。感知服务
 * `createCoverFormSensor`、多模态调用、缓存与回写留原文件（content），并从 kernel 等值再导出、行为逐字不变。
 * 供 api 侧静态 prompt 预览跨边界共导，消 1 条 api->content 边。满足 §4.7 kernel 准入。
 */

/** 视觉判定提示词（中文；输出收窄为 form+confidence+reason，刻意不要求颜色/坐标/OCR 全文——防搬运结构隔离）。 */
export function buildCoverFormSensePrompt(): string {
  return `请判断这张小红书笔记封面图的形态，四选一：
- text_card：排版文字知识卡/海报——画面主体是排版好的文字内容（大标题、要点列表、金句等），文字本身是信息主体
- photo：真实拍摄的照片（人物、风景、食物、产品、生活场景等实拍）
- illustration：插画/手绘/漫画/卡通风格的图
- other：以上都不是（如界面截图、纯图表、拼图等）

只输出 JSON（不要其他内容，不要输出图中的具体文字）：
{"form":"text_card|photo|illustration|other","confidence":0.0到1.0之间的数字,"reason":"简短中文理由"}`;
}
