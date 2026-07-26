/**
 * 发布台账的**窄写入口**（kernel）。
 *
 * `publish_log` 是 **api 属主**表，而写它的是内容域的发布出口。单体里两者同进程、
 * 直接拿着 api 池的存储对象写；content 拆成独立进程后连不上那个库，故跨边界只留这四个方法。
 *
 * **四个就是内容域用到的全部面**——那个存储类另有二十余个方法（排期、下发、编辑、对账…），
 * 全都不属于内容域。窄到这个程度不是洁癖：端口有多宽，拆进程后要守的跨进程契约就有多宽。
 *
 * `init()` **有意不在这条口上**：那是属主探测自己 schema 的动作，内容域没有立场初始化别人的表。
 * 它已上移到属主侧的启动序列里。
 *
 * 形状**照抄属主存储的真实签名**（`PublishRecord` / `PublishStatus` 都已是 kernel 类型），
 * 不另造一套更宽松的入参类型 —— 那会让「端口编译过、真调用时字段对不上」变成可能。
 */
import type { PublishRecord, PublishStatus } from './publish-pipeline-types.js';

export interface PublishLogWriter {
  /** 落一条候审草稿，返回台账自增 id —— 后面三个方法都按它定位。 */
  insert(record: PublishRecord): Promise<number>;
  updateStatus(id: number, status: PublishStatus): Promise<void>;
  /** 发帖元数据落库 + 防篡改审计（供下发段重建发布输入 + 审计）。 */
  recordMetadata(id: number, metadata: unknown, aiEnforced: boolean): Promise<void>;
  /** 配图收口：标记该帖真实附着张数 K（生成段尚未上传时为 0）。 */
  markImagesAttached(id: number, count: number): Promise<void>;
}
