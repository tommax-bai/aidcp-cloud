/**
 * 内部 HTTP 读 API 传输骨架（Block② 数据网关的同步传输承重件）。
 *
 * 目标：为「拆进程后，一个进程按 kernel 读接口向另一个进程取数」提供一层极简、
 * 类型安全、有界超时的 request/response 传输。**只是传输骨架，不接任何业务 endpoint**。
 *
 * 三条硬约束（与本 change 的 behavior-zero 承诺对齐）：
 *   1. 仅内网：默认只监听 127.0.0.1，POST JSON in → JSON out，错误编码为 JSON。
 *   2. 不引新依赖：只用 Node 内置 `node:http`。
 *   3. 默认 local：`makeReadPort` 默认 mode='local' → 直接用本地实例、零 HTTP、零行为变更；
 *      只有显式配置/env 切到 'http' 才会构造 client 走网络。
 *
 * 超时天花板取仓内 model-call-timeout 精神：单次调用有界（默认 15s，硬顶 180s），
 * 绝不无限等；连接/读取/处理任一环卡住都以结构化 timeout 错误收口。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 内部 HTTP 调用的结构化错误。跨进程只搬 `code` + `message`，不搬 stack。 */
export class InternalHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InternalHttpError';
  }
}

/** 单次调用默认超时（毫秒）。内部读取应当很快；给一个保守但明确的默认值。 */
export const INTERNAL_HTTP_DEFAULT_TIMEOUT_MS = 15_000;
/** 单次调用超时硬顶（毫秒）。对齐 model-call 180s 天花板：任何配置都不得越过此上界。 */
export const INTERNAL_HTTP_TIMEOUT_CEILING_MS = 180_000;
/** 请求体大小上限（字节），防不受控内存增长。8 MiB 对读投影绰绰有余。 */
export const INTERNAL_HTTP_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 路由处理器：入参与返回都是可 JSON 化的纯数据。 */
export type RouteHandler = (args: unknown) => Promise<unknown>;

interface RegisteredRoute {
  handler: RouteHandler;
  bearerToken?: string;
}

/** 线格式：成功。 */
interface WireOk {
  ok: true;
  result: unknown;
}
/** 线格式：失败（业务或传输错误的统一编码）。 */
interface WireErr {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}
type WireResponse = WireOk | WireErr;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 把任意抛出物归一为线格式错误。若抛出物带 string `code` 则保留，否则记 `handler_error`。 */
function encodeHandlerError(err: unknown): WireErr {
  if (err instanceof InternalHttpError) {
    return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
  }
  if (isRecord(err) && typeof err.code === 'string') {
    const message = typeof err.message === 'string' ? err.message : String(err.code);
    return { ok: false, error: { code: err.code, message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'handler_error', message } };
}

export interface InternalHttpServerOptions {
  /** 监听主机，默认 `127.0.0.1`（仅内网）。 */
  host?: string;
  /** 请求体上限，默认 {@link INTERNAL_HTTP_MAX_BODY_BYTES}。 */
  maxBodyBytes?: number;
}

/**
 * 极简内部 HTTP+JSON 服务。`register` 挂路由，`listen` 起监听，`close` 收。
 * 仅接受 `POST /<route>`，请求体 `{ args }`，响应体 {@link WireResponse}。
 */
export class InternalHttpServer {
  private readonly routes = new Map<string, RegisteredRoute>();
  private readonly host: string;
  private readonly maxBodyBytes: number;
  private server: Server | null = null;

  constructor(opts: InternalHttpServerOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.maxBodyBytes = opts.maxBodyBytes ?? INTERNAL_HTTP_MAX_BODY_BYTES;
  }

  /** 注册一个路由处理器。路由名重复即抛错（配置期失败，早暴露）。 */
  register(route: string, handler: RouteHandler): this {
    return this.registerRoute(route, { handler });
  }

  /** 注册一条显式 Bearer 鉴权的路由；空白或含空白 token 在配置期直接拒绝。 */
  registerBearer(route: string, bearerToken: string, handler: RouteHandler): this {
    return this.registerRoute(route, {
      handler,
      bearerToken: validateBearerToken(bearerToken),
    });
  }

  private registerRoute(route: string, registered: RegisteredRoute): this {
    const key = normalizeRoute(route);
    if (this.routes.has(key)) {
      throw new InternalHttpError('route_conflict', `route already registered: ${key}`);
    }
    this.routes.set(key, registered);
    return this;
  }

  /** 起监听；`port=0` 取随机空闲端口。resolve 出真实监听端口。 */
  listen(port: number): Promise<number> {
    if (this.server) {
      throw new InternalHttpError('already_listening', 'server already listening');
    }
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        writeJson(res, 500, encodeHandlerError(err));
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.host, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        const actual = addr && typeof addr === 'object' ? addr.port : port;
        resolve(actual);
      });
    });
  }

  /** 真实监听端口；未监听时返回 null。 */
  address(): { host: string; port: number } | null {
    const addr = this.server?.address();
    if (addr && typeof addr === 'object') {
      return { host: this.host, port: addr.port };
    }
    return null;
  }

  /** 关闭监听。幂等。 */
  close(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    this.server = null;
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 405, errBody('method_not_allowed', `only POST is accepted, got ${req.method}`));
      return;
    }
    const route = normalizeRoute((req.url ?? '').split('?')[0] ?? '');
    const registered = this.routes.get(route);
    if (!registered) {
      writeJson(res, 404, errBody('route_not_found', `no route: ${route}`));
      return;
    }
    if (registered.bearerToken && !hasExpectedBearer(req, registered.bearerToken)) {
      writeJson(res, 401, errBody('internal_http_unauthorized', 'internal caller authentication failed'));
      return;
    }
    let body: string;
    try {
      body = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      writeJson(res, 413, encodeHandlerError(err));
      return;
    }
    let args: unknown;
    try {
      const parsed = body.length === 0 ? {} : JSON.parse(body);
      args = isRecord(parsed) && 'args' in parsed ? parsed.args : parsed;
    } catch {
      writeJson(res, 400, errBody('bad_request', 'request body is not valid JSON'));
      return;
    }
    try {
      const result = await registered.handler(args);
      writeJson(res, 200, { ok: true, result } satisfies WireOk);
    } catch (err) {
      writeJson(res, 200, encodeHandlerError(err));
    }
  }
}

export interface InternalHttpClientOptions {
  /** 单次调用超时（毫秒）。缺省 {@link INTERNAL_HTTP_DEFAULT_TIMEOUT_MS}，硬顶 {@link INTERNAL_HTTP_TIMEOUT_CEILING_MS}。 */
  timeoutMs?: number;
}

/**
 * 内部 HTTP 客户端。`call<T>(route, args)` 发一次 POST JSON，类型安全地拿回 `T`。
 * 超时有界；连接/读取/处理错误都归一为 {@link InternalHttpError}。
 */
export class InternalHttpClient {
  private readonly base: URL;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, opts: InternalHttpClientOptions = {}) {
    this.base = new URL(baseUrl);
    this.timeoutMs = clampTimeout(opts.timeoutMs);
  }

  call<T>(route: string, args: unknown): Promise<T> {
    return this.request<T>(route, args);
  }

  /** 以显式 Bearer token 调用鉴权路由；空白或含空白 token 不发网络请求。 */
  callBearer<T>(route: string, args: unknown, bearerToken: string): Promise<T> {
    return this.request<T>(route, args, validateBearerToken(bearerToken));
  }

  private request<T>(route: string, args: unknown, bearerToken?: string): Promise<T> {
    const url = new URL(normalizeRoute(route), this.base);
    const payload = Buffer.from(JSON.stringify({ args }), 'utf8');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(payload.byteLength),
    };
    if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = request(
        url,
        {
          method: 'POST',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let decoded: WireResponse;
            try {
              decoded = JSON.parse(text) as WireResponse;
            } catch {
              finish(() =>
                reject(new InternalHttpError('bad_response', `non-JSON response (HTTP ${res.statusCode})`)),
              );
              return;
            }
            if (isRecord(decoded) && decoded.ok === true) {
              finish(() => resolve((decoded as WireOk).result as T));
              return;
            }
            if (isRecord(decoded) && decoded.ok === false && isRecord(decoded.error)) {
              const e = (decoded as WireErr).error;
              finish(() => reject(new InternalHttpError(e.code, e.message, e.details)));
              return;
            }
            finish(() => reject(new InternalHttpError('bad_response', 'malformed response envelope')));
          });
        },
      );
      const timer = setTimeout(() => {
        finish(() => reject(new InternalHttpError('timeout', `call timed out after ${this.timeoutMs}ms: ${route}`)));
        req.destroy();
      }, this.timeoutMs);
      req.on('error', (err: Error) => {
        finish(() => reject(new InternalHttpError('transport_error', err.message)));
      });
      req.end(payload);
    });
  }
}

/** read-port 传输模式。 */
export type ReadPortMode = 'local' | 'http';

/**
 * read-port 本地/HTTP 开关。**默认 mode='local' → 直接返回本地实例、零 HTTP、零行为变更**。
 * `remote` 是 thunk：local 模式下**不会被调用**，因此不会构造任何 client、不碰网络。
 * mode 只由显式配置/env 决定（见 {@link readPortModeFromEnv}）。
 */
export function makeReadPort<I>(local: I, remote: () => I, mode: ReadPortMode = 'local'): I {
  return mode === 'http' ? remote() : local;
}

/** 从 env 读传输模式，**默认 local**：仅当显式等于 `'http'` 才切远端。 */
export function readPortModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  key = 'AIDCP_READ_PORT_TRANSPORT',
): ReadPortMode {
  return env[key] === 'http' ? 'http' : 'local';
}

/* --------------------------------------------------------------- helpers */

function normalizeRoute(route: string): string {
  return route.replace(/^\/+/, '');
}

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return INTERNAL_HTTP_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(ms), 1), INTERNAL_HTTP_TIMEOUT_CEILING_MS);
}

function validateBearerToken(token: string): string {
  if (typeof token !== 'string' || token.length === 0 || /\s/.test(token)) {
    throw new InternalHttpError(
      'internal_http_auth_config_invalid',
      'internal HTTP bearer token must be a non-empty value without whitespace',
    );
  }
  return token;
}

function hasExpectedBearer(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
  if (!match) return false;
  const expected = createHash('sha256').update(expectedToken, 'utf8').digest();
  const actual = createHash('sha256').update(match[1], 'utf8').digest();
  return timingSafeEqual(expected, actual);
}

function errBody(code: string, message: string): WireErr {
  return { ok: false, error: { code, message } };
}

function writeJson(res: ServerResponse, status: number, body: WireResponse): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.byteLength;
      if (size > maxBytes) {
        reject(new InternalHttpError('payload_too_large', `request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err: Error) => reject(new InternalHttpError('transport_error', err.message)));
  });
}
