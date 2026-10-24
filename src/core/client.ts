import { SseParser } from './sse';
import type { ApiMessage, StreamHandlers, StreamResult, Usage } from './types';

export type ApiErrorKind =
    | 'auth'
    | 'balance'
    | 'rate-limit'
    | 'timeout'
    | 'aborted'
    | 'network'
    | 'http'
    | 'bad-response';

export class ApiError extends Error {
    readonly kind: ApiErrorKind;
    readonly status?: number;

    constructor(kind: ApiErrorKind, message: string, status?: number) {
        super(message);
        this.name = 'ApiError';
        this.kind = kind;
        this.status = status;
    }
}

export interface ChatRequest {
    model: string;
    messages: ApiMessage[];
    temperature?: number;
    maxTokens?: number;
    /** V4 / Flash 系列支持开关思考模式；旧模型不要传。 */
    thinking?: { type: 'enabled' | 'disabled' };
    reasoningEffort?: 'low' | 'high' | 'max';
}

export interface ClientOptions {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    /** 便于测试注入；默认使用全局 fetch。 */
    fetchImpl?: typeof fetch;
}

/** 避免把 `sk-...` 形式的密钥写进日志或错误提示。 */
export function redactSecrets(text: string): string {
    return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

/**
 * 校验 API 地址。常见误配是把 API Key 粘到「API 地址」里，
 * 这会让请求 URL 变成 `sk-xxx/chat/completions`，网络层只会报「无法解析 URL」，
 * 所以在这里提前给出可操作的提示。
 */
function normalizeBaseUrl(raw: string | undefined): string {
    const value = (raw ?? '').trim().replace(/\/+$/, '');
    if (!value) {
        return 'https://api.deepseek.com';
    }

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        const hint = /^sk-[A-Za-z0-9_-]{8,}$/.test(value)
            ? '「API 地址」里填的看起来是 API Key。请把它改回 https://api.deepseek.com，再用命令「DeepSeek: 设置 DeepSeek API Key」填写 Key。'
            : '「API 地址」不是合法 URL。请改回 https://api.deepseek.com，或形如 https://your-gateway/v1 的地址。';
        throw new ApiError('bad-response', `DeepSeek 配置有误：${hint}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ApiError('bad-response', 'DeepSeek 配置有误：API 地址必须以 http:// 或 https:// 开头。');
    }
    return value;
}

/** 把服务端返回的错误体压成一句可读的中文提示。 */
function describeHttpError(status: number, body: string): ApiError {
    let detail = '';
    try {
        const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
        if (typeof parsed.error === 'string') {
            detail = parsed.error;
        } else if (parsed.error?.message) {
            detail = parsed.error.message;
        } else if (parsed.message) {
            detail = parsed.message;
        }
    } catch {
        detail = body.slice(0, 300);
    }

    const suffix = detail ? `：${redactSecrets(detail)}` : '';
    switch (status) {
        case 400:
            return new ApiError('http', `请求被拒绝（400）${suffix}`, status);
        case 401:
            return new ApiError('auth', 'API Key 无效或已失效，请重新设置 DeepSeek API Key。', status);
        case 402:
            return new ApiError('balance', 'DeepSeek 账户余额不足，请充值后再试。', status);
        case 429:
            return new ApiError('rate-limit', `请求过于频繁，请稍后重试。${suffix}`, status);
        default:
            if (status >= 500) {
                return new ApiError('http', `DeepSeek 服务端错误（${status}），请稍后重试。${suffix}`, status);
            }
            return new ApiError('http', `请求失败（${status}）${suffix}`, status);
    }
}

export class DeepSeekClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(options: ClientOptions) {
        this.apiKey = options.apiKey;
        this.baseUrl = normalizeBaseUrl(options.baseUrl);
        this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    private endpoint(path: string): string {
        if (this.baseUrl.endsWith(path)) {
            return this.baseUrl;
        }
        return `${this.baseUrl}${path}`;
    }

    async listModels(signal?: AbortSignal): Promise<string[]> {
        const controller = new AbortController();
        let timedOut = false;
        const onAbort = (): void => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.timeoutMs);

        try {
            const response = await this.send('GET', this.endpoint('/models'), undefined, controller.signal);
            const text = await response.text();
            try {
                const parsed = JSON.parse(text) as { data?: Array<{ id?: string }> };
                return (parsed.data ?? []).map((item) => item.id ?? '').filter(Boolean);
            } catch {
                throw new ApiError('bad-response', '无法解析模型列表响应。');
            }
        } catch (error) {
            throw this.classify(error, timedOut, signal);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    /**
     * 流式对话：边收边回调，结束后返回完整文本与用量。
     * 超时覆盖「建连 + 整个数据流」，避免首包之后卡死。
     */
    async streamChat(
        request: ChatRequest,
        handlers: StreamHandlers = {},
        signal?: AbortSignal
    ): Promise<StreamResult> {
        const body = this.buildBody(request);
        let relaxed = false;

        for (;;) {
            try {
                return await this.streamOnce(body, handlers, signal);
            } catch (error) {
                // 兼容网关/新模型：400 且报错与可选参数有关时，去掉它们重试一次
                if (!relaxed && this.canRelax(error, body)) {
                    relaxed = true;
                    delete body.temperature;
                    delete body.thinking;
                    delete body.reasoning_effort;
                    continue;
                }
                throw error;
            }
        }
    }

    private buildBody(request: ChatRequest): Record<string, unknown> {
        const body: Record<string, unknown> = {
            model: request.model,
            messages: request.messages,
            stream: true,
            stream_options: { include_usage: true },
        };
        if (request.maxTokens) {
            body.max_tokens = request.maxTokens;
        }
        if (typeof request.temperature === 'number') {
            body.temperature = request.temperature;
        }
        if (request.thinking) {
            body.thinking = request.thinking;
        }
        if (request.reasoningEffort && request.thinking?.type !== 'disabled') {
            body.reasoning_effort = request.reasoningEffort;
        }
        return body;
    }

    private canRelax(error: unknown, body: Record<string, unknown>): boolean {
        if (!(error instanceof ApiError) || error.status !== 400) {
            return false;
        }
        const hasOptional = 'temperature' in body || 'thinking' in body || 'reasoning_effort' in body;
        if (!hasOptional) {
            return false;
        }
        return /temperature|thinking|reasoning|unknown|unsupported|unrecognized|extra/i.test(error.message);
    }

    private async streamOnce(
        body: Record<string, unknown>,
        handlers: StreamHandlers,
        signal: AbortSignal | undefined
    ): Promise<StreamResult> {
        const controller = new AbortController();
        let timedOut = false;
        const onAbort = (): void => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.timeoutMs);

        let text = '';
        let reasoning = '';
        let usage: Usage | undefined;
        let finishReason: string | undefined;

        try {
            const response = await this.send(
                'POST',
                this.endpoint('/chat/completions'),
                JSON.stringify(body),
                controller.signal
            );
            if (!response.body) {
                throw new ApiError('bad-response', '服务端没有返回数据流。');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            const parser = new SseParser();

            const handlePayload = (payload: string): void => {
                if (payload === '[DONE]') {
                    return;
                }
                let chunk: {
                    choices?: Array<{
                        delta?: { content?: string | null; reasoning_content?: string | null };
                        finish_reason?: string | null;
                    }>;
                    usage?: {
                        prompt_tokens?: number;
                        completion_tokens?: number;
                        total_tokens?: number;
                        prompt_cache_hit_tokens?: number;
                        prompt_cache_miss_tokens?: number;
                    } | null;
                };
                try {
                    chunk = JSON.parse(payload);
                } catch {
                    return;
                }

                const delta = chunk.choices?.[0]?.delta;
                const piece = delta?.content;
                if (typeof piece === 'string' && piece.length > 0) {
                    text += piece;
                    handlers.onDelta?.(piece);
                }
                const thought = delta?.reasoning_content;
                if (typeof thought === 'string' && thought.length > 0) {
                    reasoning += thought;
                    handlers.onReasoning?.(thought);
                }
                const reason = chunk.choices?.[0]?.finish_reason;
                if (reason) {
                    finishReason = reason;
                }
                if (chunk.usage) {
                    usage = {
                        promptTokens: chunk.usage.prompt_tokens ?? 0,
                        completionTokens: chunk.usage.completion_tokens ?? 0,
                        totalTokens: chunk.usage.total_tokens ?? 0,
                    };
                    if (typeof chunk.usage.prompt_cache_hit_tokens === 'number') {
                        usage.cacheHitTokens = chunk.usage.prompt_cache_hit_tokens;
                    }
                    if (typeof chunk.usage.prompt_cache_miss_tokens === 'number') {
                        usage.cacheMissTokens = chunk.usage.prompt_cache_miss_tokens;
                    }
                    handlers.onUsage?.(usage);
                }
            };

            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
                        handlePayload(payload);
                    }
                }
                for (const payload of parser.flush()) {
                    handlePayload(payload);
                }
            } finally {
                reader.releaseLock();
            }
        } catch (error) {
            throw this.classify(error, timedOut, signal);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }

        const result: StreamResult = { text, reasoning };
        if (usage) {
            result.usage = usage;
        }
        if (finishReason) {
            result.finishReason = finishReason;
        }
        return result;
    }

    private async send(
        method: 'GET' | 'POST',
        url: string,
        body: string | undefined,
        signal: AbortSignal
    ): Promise<Response> {
        const response = await this.fetchImpl(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                Accept: 'text/event-stream',
            },
            body,
            signal,
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw describeHttpError(response.status, text);
        }
        return response;
    }

    private classify(error: unknown, timedOut: boolean, outerSignal?: AbortSignal): ApiError {
        if (error instanceof ApiError) {
            return error;
        }
        if (timedOut) {
            return new ApiError('timeout', `请求超时（${Math.round(this.timeoutMs / 1000)} 秒），已中断。`);
        }
        if (outerSignal?.aborted) {
            return new ApiError('aborted', '已停止生成。');
        }
        const message = error instanceof Error ? error.message : String(error);
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        const detail = cause?.code ?? cause?.message;
        const suffix = detail ? `（${redactSecrets(detail)}）` : '';
        return new ApiError('network', `网络请求失败：${redactSecrets(message)}${suffix}`);
    }
}
