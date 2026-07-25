/**
 * Soul 编解码的窄端口（change cloud-coupling-phase4-runtime-ports）。
 *
 * 为什么是端口而不是把加载器搬进 kernel：加载器（`src/soul/loader.ts`）持模块级可变容器单例、
 * 且引同目录的写作语言判定（api 层），进 kernel 会当场违反准入。序列化那半虽然四条准入全过，
 * 单搬它也省不掉这个端口——解析那半仍在 api、仍要注入。
 *
 * 三个方法逐一对应生成侧的三处调用：JSON 对象结构校验 / 确定性序列化 / round-trip 自校验。
 */
import type { Soul } from './soul-types.js';
import type { YamlValue } from './yaml.js';

export interface SoulCodec {
  /** 在已解析的值上做结构校验，非法即抛。 */
  parseValue(value: YamlValue): Soul;
  /** 确定性序列化成 soul YAML。 */
  serialize(soul: Soul): string;
  /** 从 YAML 文本解析，非法即抛（用于序列化后的 round-trip 自校验）。 */
  parseYaml(text: string): Soul;
}
