import { afterEach, describe, expect, it, vi } from "vitest";
import smartRouter, { __testing } from "./index.js";
import { createAssistantMessageEventStream, type AssistantMessageEvent } from "@mariozechner/pi-ai";

afterEach(() => {
  vi.restoreAllMocks();
});

type ResolvedConfigForTest = Parameters<typeof __testing.resolveEvaluationRequestConfig>[0];

function buildResolvedConfig(overrides: Partial<ResolvedConfigForTest> = {}): ResolvedConfigForTest {
  return {
    localProvider: "lmstudio",
    localModel: "lmstudio-community/LFM2-24B-A2B-MLX-4bit",
    localBaseUrl: "http://127.0.0.1:1235/v1",
    localApi: "openai-completions",
    remoteProvider: "openai",
    nanoModel: "gpt-5.4-nano-2026-03-17",
    miniModel: "gpt-5.4-mini-2026-03-17",
    fullModel: "gpt-5.4-2026-03-05",
    remoteBaseUrl: "https://api.openai.com/v1",
    remoteApi: "openai-responses",
    threshold: "moderate",
    evaluationMode: "llm",
    evaluationLlmTarget: "local",
    evaluationLlmModel: undefined,
    evaluationTimeoutMs: 3000,
    evaluationTimeoutRetryCount: 1,
    evaluationTimeoutFallbackTarget: "nano",
    streamFirstTokenTimeoutMs: 15000,
    streamRetryOnFailure: true,
    showModelLabel: true,
    logEnabled: true,
    logFilePath: undefined,
    logPayloadBody: false,
    logMaxTextChars: 600,
    logPreviewChars: 240,
    logRetentionDays: 10,
    toolExposureMode: "conservative",
    localForceNoTools: false,
    latencyAwareRouting: true,
    localLatencyP95ThresholdMs: 12000,
    localErrorRateThreshold: 0.25,
    localHealthMinSamples: 3,
    ...overrides,
  };
}

function buildEvaluationTrace(error: string, durationMs: number) {
  return {
    mode: "llm",
    apiType: "openai",
    durationMs,
    messageChars: 12,
    threshold: "moderate",
    finalTarget: "local",
    fallbackToRule: true,
    error,
  } as const;
}

describe("smart-router route metadata", () => {
  it("attaches structured route metadata and aliases the visible model to the route tier", () => {
    const message = __testing.attachRouteMeta(
      {
        role: "assistant",
        model: "gpt-5.4-mini-2026-03-17",
        content: [{ type: "text", text: "응답 본문" }],
        api: "openai-responses",
        provider: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "length",
        timestamp: 0
      },
      {
        source: "smart-router",
        mode: "auto",
        tier: "mini",
        level: "complex",
      },
    );

    expect(message.content).toEqual([{ type: "text", text: "응답 본문" }]);
    expect((message as { model?: string }).model).toBe("mini");
    expect(message).toMatchObject({
      smartRouterRoute: {
        source: "smart-router",
        mode: "auto",
        tier: "mini",
        level: "complex",
        resolvedModel: "gpt-5.4-mini-2026-03-17",
      },
    });
  });

  it("registers with a wrapStreamFn hook", () => {
    let wrapStreamFn: unknown;
    let catalogRun: undefined | (() => Promise<{ provider: { models: Array<{ id: string }> } }>);

    smartRouter.register({
      pluginConfig: {},
      registerProvider(provider: unknown) {
        wrapStreamFn = (provider as { wrapStreamFn?: unknown }).wrapStreamFn;
        catalogRun = (provider as { catalog?: { run?: typeof catalogRun } }).catalog?.run;
      },
    } as Parameters<typeof smartRouter.register>[0]);

    expect(wrapStreamFn).toBeTypeOf("function");
    expect(catalogRun).toBeTypeOf("function");
  });

  it("exposes auto plus four direct model selections", async () => {
    let catalogRun: undefined | (() => Promise<{ provider: { models: Array<{ id: string }> } }>);

    smartRouter.register({
      pluginConfig: {},
      registerProvider(provider: unknown) {
        catalogRun = (provider as { catalog?: { run?: typeof catalogRun } }).catalog?.run;
      },
    } as Parameters<typeof smartRouter.register>[0]);

    const result = await catalogRun?.();
    expect(result?.provider.models.map((model) => model.id)).toEqual(["auto", "local", "nano", "mini", "full"]);
  });

  it("detects explicit tool intent keywords", () => {
    expect(__testing.hasExplicitToolIntent("로그 파일을 read 해서 분석해줘")).toBe(true);
    expect(__testing.hasExplicitToolIntent("안녕, 오늘 기분 어때?")).toBe(false);
  });

  it("prunes tools for local route in conservative mode", () => {
    const result = __testing.applyToolExposurePolicy(
      { tools: [{ name: "read" }, { name: "write" }] },
      "local",
      "안녕, 한 줄로 답해줘",
      { hasToolUse: false },
      "conservative",
    );

    expect(result.applied).toBe(true);
    expect(result.originalToolCount).toBe(2);
    expect(result.retainedToolCount).toBe(0);
    expect((result.context as { tools: unknown[] }).tools).toEqual([]);
  });

  it("keeps tools when explicit tool intent exists", () => {
    const result = __testing.applyToolExposurePolicy(
      { tools: [{ name: "read" }, { name: "write" }] },
      "local",
      "로그 파일을 read 해서 비교해줘",
      { hasToolUse: false },
      "conservative",
    );

    expect(result.applied).toBe(false);
    expect(result.retainedToolCount).toBe(2);
  });

  it("prunes tools for nano route in minimal mode", () => {
    const result = __testing.applyToolExposurePolicy(
      { tools: [{ name: "read" }, { name: "write" }] },
      "nano",
      "요약만 해줘",
      { hasToolUse: false },
      "minimal",
    );

    expect(result.applied).toBe(true);
    expect(result.retainedToolCount).toBe(0);
  });

  it("forceLocalPrune removes tools for local even when hasToolUse is true", () => {
    const result = __testing.applyToolExposurePolicy(
      { tools: [{ name: "read" }, { name: "write" }] },
      "local",
      "안녕, 한 줄로 답해줘",
      { hasToolUse: true },
      "conservative",
      true, // forceLocalPrune
    );

    expect(result.applied).toBe(true);
    expect(result.retainedToolCount).toBe(0);
  });

  it("escalates local routing when p95 latency is too high", () => {
    const reason = __testing.shouldEscalateLocalRoute(
      { sampleCount: 4, errorCount: 0, errorRate: 0, p95Ms: 16000 },
      {
        latencyAwareRouting: true,
        localLatencyP95ThresholdMs: 12000,
        localErrorRateThreshold: 0.25,
        localHealthMinSamples: 3,
      },
    );

    expect(reason).toContain("p95");
  });

  it("does not escalate local routing before minimum samples", () => {
    const reason = __testing.shouldEscalateLocalRoute(
      { sampleCount: 2, errorCount: 1, errorRate: 0.5, p95Ms: 20000 },
      {
        latencyAwareRouting: true,
        localLatencyP95ThresholdMs: 12000,
        localErrorRateThreshold: 0.25,
        localHealthMinSamples: 3,
      },
    );

    expect(reason).toBeUndefined();
  });

  it("maps retry targets in order local->nano->mini->full", () => {
    expect(__testing.resolveRetryTarget("local")).toBe("nano");
    expect(__testing.resolveRetryTarget("nano")).toBe("mini");
    expect(__testing.resolveRetryTarget("mini")).toBe("full");
    expect(__testing.resolveRetryTarget("full")).toBeUndefined();
  });

  it("resolves classifier request to local endpoint when evaluationLlmTarget=local", () => {
    const resolved = __testing.resolveEvaluationRequestConfig(buildResolvedConfig());

    expect(resolved).toMatchObject({
      targetTier: "local",
      model: "lmstudio-community/LFM2-24B-A2B-MLX-4bit",
      baseUrl: "http://127.0.0.1:1235/v1",
      apiType: "openai",
    });
  });

  it("resolves classifier request to remote endpoint when evaluationLlmTarget=nano", () => {
    const resolved = __testing.resolveEvaluationRequestConfig(
      buildResolvedConfig({ evaluationLlmTarget: "nano" }),
    );

    expect(resolved).toMatchObject({
      targetTier: "nano",
      model: "gpt-5.4-nano-2026-03-17",
      baseUrl: "https://api.openai.com/v1",
      apiType: "openai-responses",
    });
  });

  it("routes classifier timeout >=3s to full", () => {
    const fallback = __testing.resolveClassifierFailureFallback(
      buildResolvedConfig(),
      buildEvaluationTrace("The operation was aborted", 3010),
    );

    expect(fallback).toMatchObject({
      target: "full",
    });
  });

  it("routes classifier JSON parse failure to nano", () => {
    const fallback = __testing.resolveClassifierFailureFallback(
      buildResolvedConfig({ evaluationTimeoutFallbackTarget: "full" }),
      buildEvaluationTrace("invalid level: {bad json}", 900),
    );

    expect(fallback).toMatchObject({
      target: "nano",
    });
  });

  it("routes classifier connection failure to nano", () => {
    const fallback = __testing.resolveClassifierFailureFallback(
      buildResolvedConfig({ evaluationTimeoutFallbackTarget: "full" }),
      buildEvaluationTrace("fetch failed", 1200),
    );

    expect(fallback).toMatchObject({
      target: "nano",
    });
  });

  it("routes classifier HTTP failure to nano", () => {
    const fallback = __testing.resolveClassifierFailureFallback(
      buildResolvedConfig({ evaluationTimeoutFallbackTarget: "full" }),
      buildEvaluationTrace("HTTP 502", 800),
    );

    expect(fallback).toMatchObject({
      target: "nano",
    });
  });

  it("retries with fallback stream when primary emits immediate response_error", async () => {
    const primary = createAssistantMessageEventStream();
    const fallback = createAssistantMessageEventStream();

    queueMicrotask(() => {
      primary.push({
        type: "error",
        error: {
          role: "assistant",
          provider: "smart-router",
          api: "ollama",
          model: "gemma3:4b",
          stopReason: "error",
          content: [],
          errorMessage: "primary failed",
        },
      } as unknown as AssistantMessageEvent);

      fallback.push({
        type: "done",
        message: {
          role: "assistant",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.4-nano-2026-03-17",
          stopReason: "stop",
          content: [{ type: "text", text: "retry ok" }],
        },
      } as unknown as AssistantMessageEvent);
    });

    const reasons: string[] = [];
    const wrapped = __testing.wrapStreamWithAutoRetry(
      primary,
      async (reason) => {
        reasons.push(reason);
        return fallback;
      },
      15_000,
    );

    const events: AssistantMessageEvent[] = [];
    for await (const event of wrapped) {
      events.push(event);
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }

    expect(reasons).toEqual(["response_error"]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("retries on first-token timeout before any output", async () => {
    const primary = createAssistantMessageEventStream();
    const fallback = createAssistantMessageEventStream();

    queueMicrotask(() => {
      fallback.push({
        type: "done",
        message: {
          role: "assistant",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.4-mini-2026-03-17",
          stopReason: "stop",
          content: [{ type: "text", text: "timeout retry ok" }],
        },
      } as unknown as AssistantMessageEvent);
    });

    const reasons: string[] = [];
    const wrapped = __testing.wrapStreamWithAutoRetry(
      primary,
      async (reason) => {
        reasons.push(reason);
        return fallback;
      },
      10,
    );

    const events: AssistantMessageEvent[] = [];
    for await (const event of wrapped) {
      events.push(event);
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }

    expect(reasons).toEqual(["first_token_timeout"]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("executes direct local requests through Ollama chat endpoint", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"message":{"content":"로컬 "},"done":false}\n{"message":{"content":"응답"},"done":false}\n{"message":{"content":""},"done":true,"prompt_eval_count":12,"eval_count":4}\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stream = __testing.createNativeOllamaStream(
      {
        tier: "local",
        provider: "smart-router",
        model: "gemma3:4b",
        baseUrl: "http://127.0.0.1:11435/v1",
        api: "openai-completions",
        contextWindow: 32768,
        maxTokens: 8192,
        label: "local:gemma3:4b",
      },
      {
        systemPrompt: "시스템 프롬프트",
        messages: [{ role: "user", content: "현재 시간만 말해줘" }],
      },
      {},
    );

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11435/api/chat",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as { body?: string };
    expect(request.body).toBeTypeOf("string");
    expect(JSON.parse(request.body ?? "{}")).toMatchObject({
      model: "gemma3:4b",
      stream: true,
      messages: [
        { role: "system", content: "시스템 프롬프트" },
        { role: "user", content: "현재 시간만 말해줘" },
      ],
    });

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    const textDelta = events.filter((event) => event.type === "text_delta");
    expect(textDelta).toHaveLength(2);
    expect(textDelta[0]).toMatchObject({ delta: "로컬 " });
    expect(textDelta[1]).toMatchObject({ delta: "응답" });
    const doneEvent = events.at(-1);
    expect(doneEvent?.type).toBe("done");
    if (doneEvent?.type === "done") {
      expect(doneEvent.message.api).toBe("ollama");
      expect(doneEvent.message.model).toBe("gemma3:4b");
      expect(doneEvent.message.content).toEqual([{ type: "text", text: "로컬 응답" }]);
      expect(doneEvent.message.usage).toMatchObject({
        input: 12,
        output: 4,
        totalTokens: 16,
      });
    }
  });

  it("executes direct local requests through OpenAI-compatible SSE stream", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"안녕"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":" 하"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"세요"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stream = __testing.createNativeOpenAICompletionsStream(
      {
        tier: "local",
        provider: "smart-router",
        model: "lmstudio-community/LFM2-24B-A2B-MLX-4bit",
        baseUrl: "http://127.0.0.1:1235/v1",
        api: "openai-completions",
        contextWindow: 32768,
        maxTokens: 8192,
        label: "local:lmstudio-community/LFM2-24B-A2B-MLX-4bit",
      },
      {
        messages: [{ role: "user", content: "인사만 해줘" }],
      },
      {},
      "lm-studio",
    );

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1235/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as { body?: string };
    expect(request.body).toBeTypeOf("string");
    expect(JSON.parse(request.body ?? "{}")).toMatchObject({
      model: "lmstudio-community/LFM2-24B-A2B-MLX-4bit",
      stream: true,
      messages: [{ role: "user", content: "인사만 해줘" }],
    });

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(3);
    expect(deltas[0]).toMatchObject({ delta: "안녕" });
    expect(deltas[1]).toMatchObject({ delta: " 하" });
    expect(deltas[2]).toMatchObject({ delta: "세요" });

    const doneEvent = events.at(-1);
    expect(doneEvent?.type).toBe("done");
    if (doneEvent?.type === "done") {
      expect(doneEvent.message.api).toBe("openai-completions");
      expect(doneEvent.message.content).toEqual([{ type: "text", text: "안녕 하세요" }]);
      expect(doneEvent.message.usage).toMatchObject({
        input: 8,
        output: 3,
        totalTokens: 11,
      });
    }
  });
});