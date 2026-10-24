const { test } = require("node:test");
const assert = require("node:assert/strict");

const { SseParser } = require("../dist/core/sse.js");
const {
  DeepSeekClient,
  ApiError,
  redactSecrets,
} = require("../dist/core/client.js");

function sseBody(payload) {
  const bytes = new TextEncoder().encode(payload);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test("SseParser 处理跨分片的事件与多行 data", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed('data: {"a":'), []);
  assert.deepEqual(parser.feed("1}\n\ndata: [DONE]\n\n"), [
    '{"a":1}',
    "[DONE]",
  ]);
  assert.deepEqual(parser.feed("data: 第一行\ndata: 第二行\n\n"), [
    "第一行\n第二行",
  ]);
  assert.deepEqual(parser.feed(": keep-alive\n\n"), []);
});

test("SseParser flush 处理缺少结尾空行的最后一帧", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed('data: {"x":2}'), []);
  assert.deepEqual(parser.flush(), ['{"x":2}']);
});

test("流式请求：解析增量、reasoning 与 usage", async () => {
  const payload = [
    'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const deltas = [];
  const thoughts = [];
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: sseBody(payload),
      text: async () => "",
    }),
  });

  const result = await client.streamChat(
    {
      model: "deepseek-flash",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.3,
    },
    {
      onDelta: (piece) => deltas.push(piece),
      onReasoning: (piece) => thoughts.push(piece),
    },
  );

  assert.equal(result.text, "你好，世界");
  assert.equal(result.reasoning, "想一想");
  assert.equal(result.usage.totalTokens, 7);
  assert.deepEqual(deltas, ["你好", "，世界"]);
  assert.deepEqual(thoughts, ["想一想"]);
});

test("usage 里的缓存命中/未命中会被带回，用于花费计算", async () => {
  const payload = [
    'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,',
    '"prompt_cache_hit_tokens":200,"prompt_cache_miss_tokens":1000}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: sseBody(payload),
      text: async () => "",
    }),
  });
  const result = await client.streamChat({
    model: "deepseek-flash",
    messages: [],
  });
  assert.equal(result.usage.promptTokens, 1200);
  assert.equal(result.usage.cacheHitTokens, 200);
  assert.equal(result.usage.cacheMissTokens, 1000);
});

test("流式请求：V4 系列正常携带 temperature", async () => {
  let body;
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        body: sseBody("data: [DONE]\n\n"),
        text: async () => "",
      };
    },
  });
  await client.streamChat({
    model: "deepseek-v4-pro",
    messages: [],
    temperature: 0.9,
  });
  assert.equal(body.temperature, 0.9);
  assert.equal(body.stream, true);
});

test("HTTP 错误映射为可读的中文提示", async () => {
  const cases = [
    [401, "API Key 无效"],
    [402, "余额不足"],
    [429, "请求过于频繁"],
    [500, "服务端错误"],
  ];
  for (const [status, expected] of cases) {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetchImpl: async () => ({
        ok: false,
        status,
        text: async () => '{"error":{"message":"boom"}}',
      }),
    });
    await assert.rejects(
      client.streamChat({ model: "deepseek-flash", messages: [] }),
      (error) => error instanceof ApiError && error.message.includes(expected),
      `状态码 ${status} 应提示 ${expected}`,
    );
  }
});

test("请求超时会被映射为 timeout", async () => {
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    timeoutMs: 40,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  await assert.rejects(
    client.streamChat({ model: "deepseek-flash", messages: [] }),
    (error) => error instanceof ApiError && error.kind === "timeout",
  );
});

test("外部取消被映射为 aborted", async () => {
  const controller = new AbortController();
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    timeoutMs: 5000,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
  });
  const promise = client.streamChat(
    { model: "deepseek-flash", messages: [] },
    {},
    controller.signal,
  );
  controller.abort();
  await assert.rejects(
    promise,
    (error) => error instanceof ApiError && error.kind === "aborted",
  );
});

test("流读取中途断开会映射为 network 而不是挂起", async () => {
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () => {
              throw new Error("socket hang up");
            },
            releaseLock() {},
          };
        },
      },
      text: async () => "",
    }),
  });
  await assert.rejects(
    client.streamChat({ model: "deepseek-flash", messages: [] }),
    (error) => error instanceof ApiError && error.kind === "network",
  );
});

test("API 地址被误填成 Key 时给出可操作提示", async () => {
  assert.throws(
    () =>
      new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "sk-0000000000000000000",
      }),
    (error) =>
      error instanceof ApiError &&
      error.kind === "bad-response" &&
      error.message.includes("API Key") &&
      error.message.includes("api.deepseek.com"),
  );
});

test("非法 API 地址会被拒绝，且提示里不泄露密钥", async () => {
  assert.throws(
    () => new DeepSeekClient({ apiKey: "sk-test", baseUrl: "not a url" }),
    (error) =>
      error instanceof ApiError && error.message.includes("不是合法 URL"),
  );

  assert.equal(
    redactSecrets("请求 https://x/sk-abcdefgh12345678/chat/completions 失败"),
    "请求 https://x/sk-***/chat/completions 失败",
  );
  assert.equal(redactSecrets("普通文本没有密钥"), "普通文本没有密钥");
});

test("带路径的 API 地址只拼接一次，且去掉尾部斜杠", async () => {
  const urls = [];
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    baseUrl: "https://gateway.example.com/v1/",
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        body: sseBody("data: [DONE]\n\n"),
        text: async () => "",
      };
    },
  });
  await client.streamChat({ model: "deepseek-flash", messages: [] });
  assert.equal(urls[0], "https://gateway.example.com/v1/chat/completions");

  const direct = new DeepSeekClient({
    apiKey: "sk-test",
    baseUrl: "https://gateway.example.com/v1/chat/completions",
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        body: sseBody("data: [DONE]\n\n"),
        text: async () => "",
      };
    },
  });
  await direct.streamChat({ model: "deepseek-flash", messages: [] });
  assert.equal(urls[1], "https://gateway.example.com/v1/chat/completions");
});

test("网络错误的底层原因会附带在提示里（DNS 解析失败等）", async () => {
  const error = new Error("fetch failed");
  error.cause = {
    code: "ENOTFOUND",
    message: "getaddrinfo ENOTFOUND api.deepseek.com",
  };
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async () => {
      throw error;
    },
  });
  await assert.rejects(
    client.streamChat({ model: "deepseek-flash", messages: [] }),
    (thrown) =>
      thrown instanceof ApiError && thrown.message.includes("ENOTFOUND"),
  );
});

test("V4 请求带上 thinking 与 reasoning_effort", async () => {
  let body;
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        body: sseBody("data: [DONE]\n\n"),
        text: async () => "",
      };
    },
  });
  await client.streamChat({
    model: "deepseek-flash",
    messages: [],
    temperature: 0.2,
    thinking: { type: "enabled" },
    reasoningEffort: "max",
  });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
  assert.equal(body.temperature, 0.2);
});

test("关闭思考时不下发 reasoning_effort", async () => {
  let body;
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        body: sseBody("data: [DONE]\n\n"),
        text: async () => "",
      };
    },
  });
  await client.streamChat({
    model: "deepseek-flash",
    messages: [],
    thinking: { type: "disabled" },
    reasoningEffort: "high",
  });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
});

test("400 且报错指向可选参数时，去掉它们自动重试一次", async () => {
  const calls = [];
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            '{"error":{"message":"Unknown parameter: thinking"}}',
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseBody("data: [DONE]\n\n"),
        text: async () => "",
      };
    },
  });
  await client.streamChat({
    model: "deepseek-flash",
    messages: [],
    thinking: { type: "enabled" },
    reasoningEffort: "high",
    temperature: 0.5,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].thinking, undefined);
  assert.equal(calls[1].reasoning_effort, undefined);
  assert.equal(calls[1].temperature, undefined);
});

test("无关的 400 不会重试", async () => {
  let count = 0;
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async () => {
      count += 1;
      return {
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"messages must not be empty"}}',
      };
    },
  });
  await assert.rejects(
    client.streamChat({ model: "deepseek-flash", messages: [] }),
  );
  assert.equal(count, 1);
});
