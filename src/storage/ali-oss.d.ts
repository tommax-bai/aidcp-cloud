/**
 * 最小环境声明：`ali-oss` 无自带类型、未装 `@types/ali-oss`。
 * 只声明本项目用到的构造 + put，避免 tsc 报「找不到声明文件」；精确类型由 OssPutClient 收口。
 */
declare module 'ali-oss' {
  interface OSSOptions {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    region: string;
    endpoint?: string;
    internal?: boolean;
    secure?: boolean;
    authorizationV4?: boolean;
    [key: string]: unknown;
  }
  export default class OSS {
    constructor(options: OSSOptions);
    put(
      name: string,
      file: Buffer,
      options?: { headers?: Record<string, string>; mime?: string },
    ): Promise<{ name: string; url?: string; res?: { status?: number } }>;
  }
}
