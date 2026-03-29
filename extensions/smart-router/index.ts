/**
 * Smart Router – OpenClaw 플러그인 엔트리
 *
 * 요청 복잡도를 자동 평가하여 로컬 LLM / 외부 LLM 라우팅을 결정한다.
 *
 * 동작 방식:
 *   1. "smart-router" 프로바이더를 등록하고 "auto" 모델을 제공한다.
 *   2. resolveDynamicModel 훅에서 로컬 Ollama 모델 정의를 반환한다.
 *   3. wrapStreamFn 훅에서 메시지 복잡도를 분석하여:
 *      - 단순 → 로컬 LLM
 *      - 보통 → mini
 *      - 경량 비교/요약 → nano
 *      - 복잡 → mini
 *      - 고급 → full
 *   4. /route, /local, /remote 슬래시 명령을 등록한다.
 */

import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  evaluateComplexity,
  evaluateComplexityWithLLM,
  type ComplexityLevel,
  type EvaluationTrace,
  type EvaluationContext,
  type LocalApiType,
  type RouteTarget,
} from "./complexity.js";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@mariozechner/pi-ai";
import {
  createSmartRouterLogger,
  type SmartRouterLocalHealthSnapshot,
  type SmartRouterRequestLogger,
} from "./smart-router-log.js";

/** 평가 모드 */
export type EvaluationMode = "rule" | "llm";
export type ToolExposureMode = "full" | "conservative" | "minimal";

type SmartRouterModelId = "auto" | "local" | "nano" | "mini" | "full";

/** 프로바이더 API 타입 */
type ProviderApiType = "ollama" | "openai-responses" | "openai-completions" | "openai-codex-responses" | "anthropic-messages" | "google-generative-ai" | "github-copilot" | "bedrock-converse-stream";

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const PROVIDER_ID = "smart-router";
const CLASSIFIER_TIMEOUT_FULL_THRESHOLD_MS = 3_000;

/** 플러그인 설정 기본값 */
const DEFAULTS = {
  localProvider: "lmstudio",
  localModel: "lmstudio-community/LFM2-24B-A2B-MLX-4bit",
  localBaseUrl: "http://127.0.0.1:1235/v1",
  localApi: "openai" as const,
  remoteProvider: "openai",
  nanoModel: "gpt-5.4-nano-2026-03-17",
  miniModel: "gpt-5.4-mini-2026-03-17",
  fullModel: "gpt-5.4-2026-03-05",
  remoteBaseUrl: "https://api.openai.com/v1",
  remoteApi: "openai-responses" as const,
  threshold: "moderate" as ComplexityLevel,
  evaluationMode: "rule" as EvaluationMode,
  evaluationLlmTarget: "nano" as RouteTarget,
  evaluationTimeoutMs: 15_000,
  evaluationTimeoutRetryCount: 1,
  evaluationTimeoutFallbackTarget: "nano" as Exclude<RouteTarget, "local">,
  streamFirstTokenTimeoutMs: 15_000,
  streamRetryOnFailure: true,
  showModelLabel: true,
  logEnabled: true,
  logPayloadBody: false,
  logMaxTextChars: 600,
  logPreviewChars: 240,
  logRetentionDays: 10,
  toolExposureMode: "conservative" as ToolExposureMode,
  localForceNoTools: false,
  latencyAwareRouting: true,
  localLatencyP95ThresholdMs: 12_000,
  localErrorRateThreshold: 0.25,
  localHealthMinSamples: 3,
} as const;

type ResolvedConfig = ReturnType<typeof resolveConfig>;

type AssistantStream = ReturnType<typeof createAssistantMessageEventStream>;

interface RouteModelConfig {
  tier: RouteTarget;
  provider: string;
  model: string;
  baseUrl: string;
  api: ProviderApiType;
  contextWindow: number;
  maxTokens: number;
  label: string;
}

type SmartRouterRouteMeta = {
  source: typeof PROVIDER_ID;
  mode: "auto" | "direct";
  tier: RouteTarget;
  level?: ComplexityLevel;
  resolvedModel?: string;
};

type EvaluationRequestConfig = {
  targetTier: RouteTarget;
  model: string;
  baseUrl: string;
  apiType: LocalApiType;
  apiKey?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** localApi ("openai" | "ollama") → OpenClaw provider api 타입으로 변환 */
function toProviderApi(localApi: string): ProviderApiType {
  if (localApi === "ollama") return "ollama";
  return "openai-completions";
}

function toBootstrapApi(localApi: string): ProviderApiType {
  // Keep the bootstrap model transport-neutral so runtime wrappers can
  // switch per-route at stream time (local vs remote).
  if (localApi === "ollama") return "openai-completions";
  return toProviderApi(localApi);
}

function resolveOllamaChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed.replace(/\/v1$/i, "")}/api/chat`;
}

function resolveOpenAIChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/chat/completions`;
}

function resolveRouterApiKey(): string {
  return (
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.LMSTUDIO_API_KEY?.trim() ||
    process.env.OLLAMA_API_KEY?.trim() ||
    "lm-studio"
  );
}

/** 환경변수 또는 기본값에서 설정 해석 */
function resolveConfig(pluginConfig?: Record<string, unknown>) {
  const remoteProvider = String(pluginConfig?.remoteProvider ?? DEFAULTS.remoteProvider);
  const remoteBaseUrl = String(pluginConfig?.remoteBaseUrl ?? DEFAULTS.remoteBaseUrl);
  const remoteApi = String(pluginConfig?.remoteApi ?? DEFAULTS.remoteApi) as ProviderApiType;
  const legacyRemoteModel = pluginConfig?.remoteModel;

  return {
    localProvider: String(pluginConfig?.localProvider ?? DEFAULTS.localProvider),
    localModel: String(pluginConfig?.localModel ?? DEFAULTS.localModel),
    localBaseUrl: String(pluginConfig?.localBaseUrl ?? DEFAULTS.localBaseUrl),
    localApi: String(pluginConfig?.localApi ?? DEFAULTS.localApi) as ProviderApiType,
    remoteProvider,
    nanoModel: String(pluginConfig?.nanoModel ?? DEFAULTS.nanoModel),
    miniModel: String(pluginConfig?.miniModel ?? DEFAULTS.miniModel),
    fullModel: String(pluginConfig?.fullModel ?? legacyRemoteModel ?? DEFAULTS.fullModel),
    remoteBaseUrl,
    remoteApi,
    threshold: (pluginConfig?.threshold as ComplexityLevel) ?? DEFAULTS.threshold,
    evaluationMode: (pluginConfig?.evaluationMode as EvaluationMode) ?? DEFAULTS.evaluationMode,
    evaluationLlmTarget:
      (pluginConfig?.evaluationLlmTarget as RouteTarget | undefined) ??
      DEFAULTS.evaluationLlmTarget,
    evaluationLlmModel: pluginConfig?.evaluationLlmModel
      ? String(pluginConfig.evaluationLlmModel)
      : undefined,
    evaluationTimeoutMs: Number(pluginConfig?.evaluationTimeoutMs ?? DEFAULTS.evaluationTimeoutMs),
    evaluationTimeoutRetryCount: Math.max(
      0,
      Number(pluginConfig?.evaluationTimeoutRetryCount ?? DEFAULTS.evaluationTimeoutRetryCount),
    ),
    evaluationTimeoutFallbackTarget:
      (pluginConfig?.evaluationTimeoutFallbackTarget as Exclude<RouteTarget, "local"> | undefined) ??
      DEFAULTS.evaluationTimeoutFallbackTarget,
    streamFirstTokenTimeoutMs: Number(
      pluginConfig?.streamFirstTokenTimeoutMs ?? DEFAULTS.streamFirstTokenTimeoutMs,
    ),
    streamRetryOnFailure:
      typeof pluginConfig?.streamRetryOnFailure === "boolean"
        ? pluginConfig.streamRetryOnFailure
        : pluginConfig?.streamRetryOnFailure === undefined
          ? DEFAULTS.streamRetryOnFailure
          : String(pluginConfig.streamRetryOnFailure).toLowerCase() === "true",
    showModelLabel:
      typeof pluginConfig?.showModelLabel === "boolean"
        ? pluginConfig.showModelLabel
        : pluginConfig?.showModelLabel === undefined
          ? DEFAULTS.showModelLabel
          : String(pluginConfig.showModelLabel).toLowerCase() === "true",
    logEnabled:
      typeof pluginConfig?.logEnabled === "boolean"
        ? pluginConfig.logEnabled
        : pluginConfig?.logEnabled === undefined
          ? DEFAULTS.logEnabled
          : String(pluginConfig.logEnabled).toLowerCase() === "true",
    logFilePath: pluginConfig?.logFilePath ? String(pluginConfig.logFilePath) : undefined,
    logPayloadBody:
      typeof pluginConfig?.logPayloadBody === "boolean"
        ? pluginConfig.logPayloadBody
        : pluginConfig?.logPayloadBody === undefined
          ? DEFAULTS.logPayloadBody
          : String(pluginConfig.logPayloadBody).toLowerCase() === "true",
    logMaxTextChars: Number(pluginConfig?.logMaxTextChars ?? DEFAULTS.logMaxTextChars),
    logPreviewChars: Number(pluginConfig?.logPreviewChars ?? DEFAULTS.logPreviewChars),
    logRetentionDays: Number(pluginConfig?.logRetentionDays ?? DEFAULTS.logRetentionDays),
    toolExposureMode: (pluginConfig?.toolExposureMode as ToolExposureMode | undefined) ?? DEFAULTS.toolExposureMode,
    localForceNoTools: Boolean(pluginConfig?.localForceNoTools ?? DEFAULTS.localForceNoTools),
    latencyAwareRouting:
      typeof pluginConfig?.latencyAwareRouting === "boolean"
        ? pluginConfig.latencyAwareRouting
        : pluginConfig?.latencyAwareRouting === undefined
          ? DEFAULTS.latencyAwareRouting
          : String(pluginConfig.latencyAwareRouting).toLowerCase() === "true",
    localLatencyP95ThresholdMs: Number(
      pluginConfig?.localLatencyP95ThresholdMs ?? DEFAULTS.localLatencyP95ThresholdMs,
    ),
    localErrorRateThreshold: Number(pluginConfig?.localErrorRateThreshold ?? DEFAULTS.localErrorRateThreshold),
    localHealthMinSamples: Number(pluginConfig?.localHealthMinSamples ?? DEFAULTS.localHealthMinSamples),
  };
}

function resolveRouteModel(config: ResolvedConfig, target: RouteTarget): RouteModelConfig {
  if (target === "local") {
    return {
      tier: "local",
      provider: PROVIDER_ID,
      model: config.localModel,
      baseUrl: config.localBaseUrl,
      api: toBootstrapApi(config.localApi as string),
      contextWindow: 32768,
      maxTokens: 8192,
      label: `local:${config.localModel}`,
    };
  }

  const modelByTier = {
    nano: config.nanoModel,
    mini: config.miniModel,
    full: config.fullModel,
  };

  return {
    tier: target,
    provider: config.remoteProvider,
    model: modelByTier[target],
    baseUrl: config.remoteBaseUrl,
    api: config.remoteApi,
    contextWindow: 128000,
    maxTokens: target === "full" ? 32768 : 16384,
    label: `${target}:${modelByTier[target]}`,
  };
}

function resolveEvaluationRequestConfig(config: ResolvedConfig): EvaluationRequestConfig {
  const targetTier = config.evaluationLlmTarget;
  const model = config.evaluationLlmModel ?? resolveRouteModel(config, targetTier).model;

  if (targetTier === "local") {
    const apiType: LocalApiType = config.localApi === "ollama" ? "ollama" : "openai";
    const apiKey = config.localBaseUrl.includes("api.openai.com")
      ? process.env.OPENAI_API_KEY?.trim()
      : undefined;
    return {
      targetTier,
      model,
      baseUrl: config.localBaseUrl,
      apiType,
      apiKey,
    };
  }

  return {
    targetTier,
    model,
    baseUrl: config.remoteBaseUrl,
    apiType: config.remoteApi === "openai-responses" ? "openai-responses" : "openai",
    apiKey: config.remoteBaseUrl.includes("api.openai.com")
      ? process.env.OPENAI_API_KEY?.trim()
      : undefined,
  };
}

function isClassifierTimeoutError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes("abort") || lower.includes("timeout") || lower.includes("timed out");
}

function isClassifierJsonError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes("invalid level") || lower.includes("json") || lower.includes("parse");
}

function isClassifierConnectionError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("connection") ||
    lower.includes("socket")
  );
}

type ClassifierFailureFallback = {
  target: Exclude<RouteTarget, "local">;
  reason: string;
};

function resolveClassifierFailureFallback(
  config: ResolvedConfig,
  trace?: EvaluationTrace,
): ClassifierFailureFallback | undefined {
  if (!trace?.fallbackToRule) {
    return undefined;
  }

  const errorMessage = String(trace.error ?? "");
  const durationMs = Number.isFinite(trace.durationMs) ? Number(trace.durationMs) : 0;

  if (isClassifierTimeoutError(errorMessage)) {
    if (durationMs >= CLASSIFIER_TIMEOUT_FULL_THRESHOLD_MS) {
      return {
        target: "full",
        reason: `분류 timeout ${Math.round(durationMs)}ms(>=${CLASSIFIER_TIMEOUT_FULL_THRESHOLD_MS}ms) fallback`,
      };
    }

    return {
      target: config.evaluationTimeoutFallbackTarget,
      reason: "분류 timeout fallback",
    };
  }

  if (isClassifierJsonError(errorMessage)) {
    return {
      target: "nano",
      reason: "분류 JSON 파싱 실패 fallback",
    };
  }

  if (isClassifierConnectionError(errorMessage)) {
    return {
      target: "nano",
      reason: "분류 연결 실패 fallback",
    };
  }

  if (errorMessage.toLowerCase().startsWith("http ")) {
    return {
      target: "nano",
      reason: "분류 HTTP 실패 fallback",
    };
  }

  return {
    target: "nano",
    reason: "분류 실패 fallback",
  };
}

function parseSmartRouterModelId(modelId: unknown): SmartRouterModelId | undefined {
  switch (String(modelId ?? "").trim()) {
    case "auto":
    case "local":
    case "nano":
    case "mini":
    case "full":
      return String(modelId) as SmartRouterModelId;
    default:
      return undefined;
  }
}

function attachRouteMeta(message: AssistantMessage, routeMeta: SmartRouterRouteMeta): AssistantMessage {
  const messageRecord = message as unknown as Record<string, unknown>;
  const resolvedModel = typeof messageRecord.model === "string"
    ? messageRecord.model
    : undefined;

  return {
    ...message,
    model: routeMeta.tier,
    smartRouterRoute: {
      ...routeMeta,
      resolvedModel: routeMeta.resolvedModel ?? resolvedModel,
    },
  } as AssistantMessage;
}

function wrapStreamWithRouteMeta(
  stream: AssistantStream,
  routeMeta?: SmartRouterRouteMeta,
  requestLogger?: SmartRouterRequestLogger,
): AssistantStream {
  const wrapped = createAssistantMessageEventStream();
  const eventCounts: Record<string, number> = {};
  let terminalEventSeen = false;

  const patchEvent = (event: AssistantMessageEvent): AssistantMessageEvent => {
    if (!routeMeta) {
      return event;
    }

    if ("partial" in event) {
      return {
        ...event,
        partial: attachRouteMeta(event.partial, routeMeta),
      };
    }

    if (event.type === "done") {
      return {
        ...event,
        message: attachRouteMeta(event.message, routeMeta),
      };
    }

    if (event.type === "error") {
      return {
        ...event,
        error: attachRouteMeta(event.error, routeMeta),
      };
    }

    return event;
  };

  const recordEvent = (event: AssistantMessageEvent) => {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;

    if (terminalEventSeen || !requestLogger) {
      return;
    }

    if (event.type === "done") {
      terminalEventSeen = true;
      requestLogger.logResponse({
        kind: "response",
        message: event.message,
        eventCounts: { ...eventCounts },
      });
      return;
    }

    if (event.type === "error") {
      terminalEventSeen = true;
      requestLogger.logResponse({
        kind: "response_error",
        message: event.error,
        eventCounts: { ...eventCounts },
      });
    }
  };

  void (async () => {
    try {
      for await (const event of stream) {
        recordEvent(event);
        wrapped.push(patchEvent(event));
      }
    } catch (error) {
      requestLogger?.logStreamFailure(error, { ...eventCounts });
      throw error;
    }
  })();

  return wrapped;
}

/** 스트림 컨텍스트에서 마지막 user 메시지를 추출 */
function extractLastUserMessage(context: unknown): string {
  if (!context || typeof context !== "object") return "";
  const ctx = context as Record<string, unknown>;

  // pi-agent-core context 구조: { messages: Array<{ role, content }> }
  const messages = ctx.messages ?? ctx.input ?? ctx.prompt;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && typeof msg === "object" && "role" in msg && "content" in msg) {
        if (msg.role === "user" && typeof msg.content === "string") {
          return msg.content;
        }
        // content가 배열인 경우 (멀티모달)
        if (msg.role === "user" && Array.isArray(msg.content)) {
          return msg.content
            .filter((p: unknown) => p && typeof p === "object" && "text" in (p as Record<string, unknown>))
            .map((p: unknown) => (p as Record<string, string>).text)
            .join("\n");
        }
      }
    }
  }

  // 단순 문자열 prompt
  if (typeof ctx.prompt === "string") return ctx.prompt;
  return "";
}

function summarizeMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const typedItem = item as Record<string, unknown>;
      if (typedItem.type === "text" && typeof typedItem.text === "string") {
        return typedItem.text;
      }
      if (typedItem.type === "input_text" && typeof typedItem.text === "string") {
        return typedItem.text;
      }
      if (typedItem.type === "output_text" && typeof typedItem.text === "string") {
        return typedItem.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function convertContextToOllamaMessages(context: unknown): Array<Record<string, string>> {
  if (!context || typeof context !== "object") {
    return [];
  }

  const typedContext = context as Record<string, unknown>;
  const messages: Array<Record<string, string>> = [];

  if (typeof typedContext.systemPrompt === "string" && typedContext.systemPrompt.trim()) {
    messages.push({ role: "system", content: typedContext.systemPrompt });
  }

  const rawMessages = typedContext.messages;
  if (!Array.isArray(rawMessages)) {
    return messages;
  }

  for (const rawMessage of rawMessages) {
    if (!rawMessage || typeof rawMessage !== "object") {
      continue;
    }

    const typedMessage = rawMessage as Record<string, unknown>;
    const role = typeof typedMessage.role === "string" ? typedMessage.role : "user";
    const normalizedRole = role === "toolResult" ? "tool" : role;
    const content = summarizeMessageText(typedMessage.content);
    if (!content.trim()) {
      continue;
    }
    messages.push({ role: normalizedRole, content });
  }

  return messages;
}

type NativeOllamaChatResponse = {
  message?: {
    content?: string;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

type OpenAIChatCompletionsChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

async function* parseNativeOllamaNdjson(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<NativeOllamaChatResponse> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      yield JSON.parse(trimmed) as NativeOllamaChatResponse;
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    yield JSON.parse(trailing) as NativeOllamaChatResponse;
  }
}

async function* parseSseDataLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      return undefined;
    }
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    return payload;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let newLineIndex = buffer.indexOf("\n");
    while (newLineIndex >= 0) {
      let line = buffer.slice(0, newLineIndex);
      buffer = buffer.slice(newLineIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (!line.trim()) {
        const payload = flushEvent();
        if (payload) {
          yield payload;
        }
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }

      newLineIndex = buffer.indexOf("\n");
    }
  }

  if (buffer.trim().startsWith("data:")) {
    dataLines.push(buffer.trim().slice(5).trimStart());
  }

  const trailingPayload = flushEvent();
  if (trailingPayload) {
    yield trailingPayload;
  }
}

async function* parseOpenAIChatCompletionsSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OpenAIChatCompletionsChunk> {
  for await (const payload of parseSseDataLines(reader)) {
    if (payload === "[DONE]") {
      return;
    }
    yield JSON.parse(payload) as OpenAIChatCompletionsChunk;
  }
}

function buildNativeOllamaAssistantMessage(
  route: RouteModelConfig,
  text: string,
  stopReason: "stop" | "error",
  usage?: { input?: number; output?: number },
): AssistantMessage {
  return {
    role: "assistant",
    provider: route.provider,
    api: "ollama",
    model: route.model,
    stopReason,
    content: text ? [{ type: "text", text }] : [],
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (usage?.input ?? 0) + (usage?.output ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  } as AssistantMessage;
}

function buildNativeOpenAIAssistantMessage(
  route: RouteModelConfig,
  text: string,
  stopReason: "stop" | "length" | "error",
  usage?: { input?: number; output?: number; total?: number },
): AssistantMessage {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const totalTokens = usage?.total ?? input + output;

  return {
    role: "assistant",
    provider: route.provider,
    api: "openai-completions",
    model: route.model,
    stopReason,
    content: text ? [{ type: "text", text }] : [],
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  } as AssistantMessage;
}

function createNativeOllamaStream(route: RouteModelConfig, context: unknown, options: unknown): AssistantStream {
  const stream = createAssistantMessageEventStream();
  const typedOptions = options && typeof options === "object" ? (options as Record<string, unknown>) : {};

  void (async () => {
    try {
      const response = await fetch(resolveOllamaChatUrl(route.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: route.model,
          messages: convertContextToOllamaMessages(context),
          stream: true,
          options: {
            num_ctx: route.contextWindow,
            ...(typeof typedOptions.temperature === "number"
              ? { temperature: typedOptions.temperature }
              : {}),
            ...(typeof typedOptions.maxTokens === "number"
              ? { num_predict: typedOptions.maxTokens }
              : {}),
          },
        }),
        signal: typedOptions.signal as AbortSignal | undefined,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(`Ollama API error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("Ollama API returned empty response body");
      }

      let accumulatedContent = "";
      let finalResponse: NativeOllamaChatResponse | undefined;
      let streamStarted = false;
      let textBlockClosed = false;

      const closeTextBlock = () => {
        if (!streamStarted || textBlockClosed) {
          return;
        }

        textBlockClosed = true;
        const partial = buildNativeOllamaAssistantMessage(route, accumulatedContent, "stop");
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: accumulatedContent,
          partial,
        });
      };

      for await (const chunk of parseNativeOllamaNdjson(response.body.getReader())) {
        const delta = chunk.message?.content ?? "";
        if (delta) {
          if (!streamStarted) {
            streamStarted = true;
            const emptyPartial = buildNativeOllamaAssistantMessage(route, "", "stop");
            stream.push({ type: "start", partial: emptyPartial });
            stream.push({ type: "text_start", contentIndex: 0, partial: emptyPartial });
          }

          accumulatedContent += delta;
          const partial = buildNativeOllamaAssistantMessage(route, accumulatedContent, "stop");
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta,
            partial,
          });
        }

        if (chunk.done) {
          finalResponse = chunk;
          break;
        }
      }

      if (!finalResponse) {
        throw new Error("Ollama API stream ended without a final response");
      }

      closeTextBlock();

      const finalMessage = buildNativeOllamaAssistantMessage(route, accumulatedContent, "stop", {
        input: finalResponse.prompt_eval_count,
        output: finalResponse.eval_count,
      });

      stream.push({
        type: "done",
        reason: "stop",
        message: finalMessage,
      });
    } catch (error) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          ...buildNativeOllamaAssistantMessage(route, "", "error"),
          errorMessage: error instanceof Error ? error.message : String(error),
        } as AssistantMessage,
      });
    } finally {
      stream.end();
    }
  })();

  return stream;
}

function createNativeOpenAICompletionsStream(
  route: RouteModelConfig,
  context: unknown,
  options: unknown,
  apiKey?: string,
): AssistantStream {
  const stream = createAssistantMessageEventStream();
  const typedOptions = options && typeof options === "object" ? (options as Record<string, unknown>) : {};

  void (async () => {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey?.trim()) {
        headers.Authorization = `Bearer ${apiKey.trim()}`;
      }

      const response = await fetch(resolveOpenAIChatCompletionsUrl(route.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: route.model,
          messages: convertContextToOllamaMessages(context),
          stream: true,
          stream_options: {
            include_usage: true,
          },
          ...(typeof typedOptions.temperature === "number"
            ? { temperature: typedOptions.temperature }
            : {}),
          ...(typeof typedOptions.maxTokens === "number"
            ? { max_tokens: typedOptions.maxTokens }
            : {}),
        }),
        signal: typedOptions.signal as AbortSignal | undefined,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new Error(`OpenAI-compatible API error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("OpenAI-compatible API returned empty response body");
      }

      let accumulatedContent = "";
      let finishReason: string | null | undefined;
      let usage: { input?: number; output?: number; total?: number } | undefined;
      let streamStarted = false;
      let textBlockClosed = false;

      const closeTextBlock = () => {
        if (!streamStarted || textBlockClosed) {
          return;
        }

        textBlockClosed = true;
        const partial = buildNativeOpenAIAssistantMessage(route, accumulatedContent, "stop", usage);
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: accumulatedContent,
          partial,
        });
      };

      for await (const chunk of parseOpenAIChatCompletionsSse(response.body.getReader())) {
        if (chunk.error?.message) {
          throw new Error(chunk.error.message);
        }

        const choice = chunk.choices?.[0];
        const delta =
          choice?.delta?.content ?? choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? "";

        if (delta) {
          if (!streamStarted) {
            streamStarted = true;
            const emptyPartial = buildNativeOpenAIAssistantMessage(route, "", "stop", usage);
            stream.push({ type: "start", partial: emptyPartial });
            stream.push({ type: "text_start", contentIndex: 0, partial: emptyPartial });
          }

          accumulatedContent += delta;
          const partial = buildNativeOpenAIAssistantMessage(route, accumulatedContent, "stop", usage);
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta,
            partial,
          });
        }

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        if (chunk.usage) {
          usage = {
            input: chunk.usage.prompt_tokens,
            output: chunk.usage.completion_tokens,
            total: chunk.usage.total_tokens,
          };
        }
      }

      closeTextBlock();

      const stopReason: "stop" | "length" = finishReason === "length" ? "length" : "stop";
      const finalMessage = buildNativeOpenAIAssistantMessage(route, accumulatedContent, stopReason, usage);
      stream.push({
        type: "done",
        reason: stopReason,
        message: finalMessage,
      });
    } catch (error) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          ...buildNativeOpenAIAssistantMessage(route, "", "error"),
          errorMessage: error instanceof Error ? error.message : String(error),
        } as AssistantMessage,
      });
    } finally {
      stream.end();
    }
  })();

  return stream;
}

/** 대화 턴 수를 추출 */
function extractTurnCount(context: unknown): number {
  if (!context || typeof context !== "object") return 0;
  const ctx = context as Record<string, unknown>;
  const messages = ctx.messages ?? ctx.input;
  if (Array.isArray(messages)) {
    return messages.filter(
      (m: unknown) => m && typeof m === "object" && "role" in m && (m as Record<string, string>).role === "user",
    ).length;
  }
  return 0;
}

/** 도구 사용 여부 감지 */
function detectToolUse(context: unknown): boolean {
  if (!context || typeof context !== "object") return false;
  const ctx = context as Record<string, unknown>;
  const messages = ctx.messages ?? ctx.input;
  if (!Array.isArray(messages)) return false;

  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const typedMessage = message as Record<string, unknown>;

    if (typedMessage.role === "toolResult") {
      return true;
    }

    if (!Array.isArray(typedMessage.content)) {
      return false;
    }

    return typedMessage.content.some(
      (item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "toolCall",
    );
  });
}

function countAvailableTools(context: unknown): number {
  if (!context || typeof context !== "object") return 0;
  const tools = (context as Record<string, unknown>).tools;
  return Array.isArray(tools) ? tools.length : 0;
}

function hasExplicitToolIntent(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "tool",
    "read",
    "write",
    "file",
    "directory",
    "folder",
    "path",
    "search",
    "fetch",
    "browse",
    "web",
    "open",
    "exec",
    "run",
    "command",
    "sql",
    "query",
    "webhook",
    "로그",
    "파일",
    "폴더",
    "검색",
    "실행",
    "명령어",
    "웹",
    "조회",
  ].some((keyword) => lower.includes(keyword));
}

function pruneContextTools(context: unknown): unknown {
  if (!context || typeof context !== "object") {
    return context;
  }

  const typedContext = context as Record<string, unknown>;
  if (!Array.isArray(typedContext.tools) || typedContext.tools.length === 0) {
    return context;
  }

  return {
    ...typedContext,
    tools: [],
  };
}

function applyToolExposurePolicy(
  context: unknown,
  routeTier: RouteTarget,
  message: string,
  evalContext: EvaluationContext,
  mode: ToolExposureMode,
  forceLocalPrune = false,
): {
  context: unknown;
  applied: boolean;
  originalToolCount: number;
  retainedToolCount: number;
} {
  const originalToolCount = countAvailableTools(context);
  if (mode === "full" || originalToolCount === 0) {
    return {
      context,
      applied: false,
      originalToolCount,
      retainedToolCount: originalToolCount,
    };
  }

  const explicitToolIntent = hasExplicitToolIntent(message) || Boolean(evalContext.hasToolUse);
  // forceLocalPrune: localForceNoTools=true 일 때 local 라우트는 hasToolUse 여부에 관계없이 항상 도구를 제거
  const shouldPrune =
    (forceLocalPrune && routeTier === "local") ||
    (!explicitToolIntent &&
      ((mode === "conservative" && routeTier === "local") ||
        (mode === "minimal" && (routeTier === "local" || routeTier === "nano"))));

  if (!shouldPrune) {
    return {
      context,
      applied: false,
      originalToolCount,
      retainedToolCount: originalToolCount,
    };
  }

  return {
    context: pruneContextTools(context),
    applied: true,
    originalToolCount,
    retainedToolCount: 0,
  };
}

function shouldEscalateLocalRoute(
  snapshot: SmartRouterLocalHealthSnapshot,
  config: Pick<
    ResolvedConfig,
    "latencyAwareRouting" | "localLatencyP95ThresholdMs" | "localErrorRateThreshold" | "localHealthMinSamples"
  >,
): string | undefined {
  if (!config.latencyAwareRouting || snapshot.sampleCount < config.localHealthMinSamples) {
    return undefined;
  }

  if (snapshot.errorRate >= config.localErrorRateThreshold) {
    return `local error rate ${snapshot.errorRate} >= ${config.localErrorRateThreshold}`;
  }

  if (snapshot.p95Ms >= config.localLatencyP95ThresholdMs) {
    return `local p95 ${snapshot.p95Ms}ms >= ${config.localLatencyP95ThresholdMs}ms`;
  }

  return undefined;
}

type AutoRetryReason = "response_error" | "first_token_timeout";

function resolveRetryTarget(target: RouteTarget): RouteTarget | undefined {
  if (target === "local") return "nano";
  if (target === "nano") return "mini";
  if (target === "mini") return "full";
  return undefined;
}

function eventHasStreamOutput(event: AssistantMessageEvent): boolean {
  if ("partial" in event) {
    return true;
  }

  if (event.type === "done") {
    return event.message.content.some((item) => {
      if (item.type === "text") return item.text.length > 0;
      if (item.type === "thinking") return item.thinking.length > 0;
      return item.type === "toolCall";
    });
  }

  const eventType = (event as { type?: string }).type ?? "";
  return [
    "text_start",
    "text_delta",
    "thinking_start",
    "thinking_delta",
    "toolcall_start",
    "toolcall_delta",
  ].includes(eventType);
}

function withAbortSignal(options: unknown, signal?: AbortSignal): unknown {
  if (!signal || !options || typeof options !== "object") {
    return options;
  }

  const typedOptions = options as Record<string, unknown>;
  if (typedOptions.signal !== undefined) {
    return options;
  }

  return {
    ...typedOptions,
    signal,
  };
}

function wrapStreamWithAutoRetry(
  primaryStream: AssistantStream,
  createRetryStream: (reason: AutoRetryReason) => Promise<AssistantStream | undefined>,
  firstTokenTimeoutMs: number,
): AssistantStream {
  const wrapped = createAssistantMessageEventStream();
  const timeoutEnabled = Number.isFinite(firstTokenTimeoutMs) && firstTokenTimeoutMs > 0;
  let hasOutput = false;
  let retried = false;

  const consume = async (stream: AssistantStream, allowRetry: boolean) => {
    const iterator = stream[Symbol.asyncIterator]();

    while (true) {
      const nextEventPromise = iterator.next();
      let result: IteratorResult<AssistantMessageEvent>;

      if (allowRetry && !hasOutput && timeoutEnabled) {
        const timeoutResult = await Promise.race<IteratorResult<AssistantMessageEvent> | "timeout">([
          nextEventPromise,
          new Promise<"timeout">((resolve) => {
            setTimeout(() => resolve("timeout"), firstTokenTimeoutMs);
          }),
        ]);

        if (timeoutResult === "timeout") {
          if (!retried) {
            retried = true;
            const retryStream = await createRetryStream("first_token_timeout");
            if (retryStream) {
              await consume(retryStream, false);
              return;
            }
          }
          throw new Error(`smart-router first token timeout (${firstTokenTimeoutMs}ms)`);
        }

        result = timeoutResult;
      } else {
        result = await nextEventPromise;
      }

      if (result.done) {
        return;
      }

      const event = result.value;

      if (eventHasStreamOutput(event)) {
        hasOutput = true;
      }

      if (allowRetry && !hasOutput && event.type === "error" && !retried) {
        retried = true;
        const retryStream = await createRetryStream("response_error");
        if (retryStream) {
          await consume(retryStream, false);
          return;
        }
      }

      wrapped.push(event);
    }
  };

  void (async () => {
    await consume(primaryStream, true);
  })();

  return wrapped;
}

function extractSessionId(options: unknown): string | undefined {
  if (!options || typeof options !== "object") {
    return undefined;
  }

  const sessionId = (options as Record<string, unknown>).sessionId;
  if (typeof sessionId !== "string") {
    return undefined;
  }

  const trimmed = sessionId.trim();
  return trimmed ? trimmed : undefined;
}

function buildRootTurnId(sessionId: string | undefined, turnIndex: number): string | undefined {
  if (!sessionId) {
    return undefined;
  }
  return `${sessionId}:turn:${turnIndex}`;
}

function buildRuleEvaluationTrace(
  decision: ReturnType<typeof evaluateComplexity>,
  context: EvaluationContext,
  threshold: ComplexityLevel,
  startedAt: number,
  message: string,
): EvaluationTrace {
  return {
    mode: "rule",
    apiType: "rule",
    durationMs: Date.now() - startedAt,
    messageChars: message.length,
    turnCount: context.turnCount,
    hasToolUse: context.hasToolUse,
    threshold,
    classifierLevel: decision.level,
    classifierReason: decision.reason,
    finalTarget: decision.target,
    fallbackToRule: false,
  };
}

export const __testing = {
  attachRouteMeta,
  wrapStreamWithRouteMeta,
  wrapStreamWithAutoRetry,
  parseSmartRouterModelId,
  hasExplicitToolIntent,
  applyToolExposurePolicy,
  shouldEscalateLocalRoute,
  resolveRetryTarget,
  resolveEvaluationRequestConfig,
  resolveClassifierFailureFallback,
  convertContextToOllamaMessages,
  createNativeOllamaStream,
  createNativeOpenAICompletionsStream,
};

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "smart-router",
  name: "Smart LLM Router",
  description: "요청 복잡도에 따라 로컬/외부 LLM을 자동 라우팅",

  register(api: OpenClawPluginApi) {
    // api.pluginConfig = plugins.entries["smart-router"].config 의 검증된 값
    const pluginConfig = resolveConfig(api.pluginConfig);
    const executionLogger = createSmartRouterLogger({
      enabled: pluginConfig.logEnabled,
      filePath: pluginConfig.logFilePath,
      includePayloadBody: pluginConfig.logPayloadBody,
      maxTextChars: pluginConfig.logMaxTextChars,
      previewChars: pluginConfig.logPreviewChars,
      retentionDays: pluginConfig.logRetentionDays,
    });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "Smart Router",
      docsPath: "/providers/smart-router",
      envVars: ["OPENAI_API_KEY"],
      aliases: ["router", "hybrid"],

      // ---------------------------------------------------------------
      // Auth: OpenAI API key 하나로 local + remote를 모두 처리
      // ---------------------------------------------------------------
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "openai-api-key",
          label: "OpenAI API key",
          hint: "OpenAI API key 하나로 LM Studio와 OpenAI를 함께 라우팅",
          optionKey: "openaiApiKey",
          flagName: "--openai-api-key",
          envVar: "OPENAI_API_KEY",
          promptMessage: "Enter OpenAI API key for smart-router",
          defaultModel: "auto",
          expectedProviders: [PROVIDER_ID],
          wizard: {
            choiceId: "smart-router-openai-api-key",
            choiceLabel: "Smart Router with OpenAI API key",
            groupId: "smart-router",
            groupLabel: "Smart Router",
            groupHint: "LM Studio local + OpenAI remote",
          },
        }),
      ],

      // ---------------------------------------------------------------
      // Model catalog: auto + direct model selections
      // ---------------------------------------------------------------
      catalog: {
        order: "late",
        run: async () => ({
          provider: {
            baseUrl: pluginConfig.localBaseUrl,
            apiKey: resolveRouterApiKey(),
            api: toBootstrapApi(pluginConfig.localApi as string),
            models: [
              {
                id: "auto",
                name: "Smart Auto (로컬 우선, 자동 라우팅)",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768,
                maxTokens: 8192,
              },
              {
                id: "local",
                name: "Smart Local (LM Studio 직접)",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768,
                maxTokens: 8192,
              },
              {
                id: "nano",
                name: "Smart Nano (직접 선택)",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
              {
                id: "mini",
                name: "Smart Mini (직접 선택)",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
              {
                id: "full",
                name: "Smart Full (직접 선택)",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 32768,
              },
            ],
          },
        }),
      },

      // ---------------------------------------------------------------
      // Dynamic model resolution
      // ---------------------------------------------------------------
      resolveDynamicModel: (
        ctx: ProviderResolveDynamicModelContext,
      ): ProviderRuntimeModel | undefined => {
        const selectedModelId = parseSmartRouterModelId(ctx.modelId);

        return {
          id: selectedModelId ?? ctx.modelId,
          name: selectedModelId ? `Smart ${selectedModelId}` : ctx.modelId,
          api: toBootstrapApi(pluginConfig.localApi as string),
          provider: PROVIDER_ID,
          baseUrl: pluginConfig.localBaseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 8192,
        };
      },

      // ---------------------------------------------------------------
      // Stream wrapper: 복잡도 기반 라우팅의 핵심
      // ---------------------------------------------------------------
      wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
        const baseStreamFn = ctx.streamFn;
        if (!baseStreamFn) return undefined;

        return async (model: unknown, context: unknown, options: unknown) => {
          const requestedModelId = parseSmartRouterModelId((model as Record<string, unknown>)?.id);
          const sessionId = extractSessionId(options);
          const turnIndex = extractTurnCount(context);
          const rootTurnId = buildRootTurnId(sessionId, turnIndex);

          if (requestedModelId && requestedModelId !== "auto") {
            const routed = resolveRouteModel(pluginConfig, requestedModelId);
            console.log(`[smart-router] 🎯 direct selection → ${routed.label}`);
            const directToolExposure = applyToolExposurePolicy(
              context,
              routed.tier,
              extractLastUserMessage(context),
              {
                turnCount: turnIndex,
                hasToolUse: detectToolUse(context),
              },
              pluginConfig.toolExposureMode,
              pluginConfig.localForceNoTools,
            );
            const requestLogger = executionLogger.createRequest({
              requestedModelId,
              routeMode: "direct",
              evaluationMode: "direct",
              threshold: pluginConfig.threshold,
              routeTier: routed.tier,
              routeProvider: routed.provider,
              routeModel: routed.model,
              routeApi: routed.api,
              routeLabel: routed.label,
              thinkingLevel: ctx.thinkingLevel,
              workspaceDir: ctx.workspaceDir,
              agentDir: ctx.agentDir,
              sessionId,
              turnIndex,
              rootTurnId,
              toolExposureMode: pluginConfig.toolExposureMode,
              toolExposureApplied: directToolExposure.applied,
              originalToolCount: directToolExposure.originalToolCount,
              retainedToolCount: directToolExposure.retainedToolCount,
              context: directToolExposure.context,
              extraParams: ctx.extraParams,
              streamOptions: options,
            });
            requestLogger.logRoute();

            const directModel = {
              ...(model as Record<string, unknown>),
              id: routed.model,
              api: routed.api,
              baseUrl: routed.baseUrl,
              provider: routed.provider,
              contextWindow: routed.contextWindow,
              maxTokens: routed.maxTokens,
            };

            let stream: AssistantStream;
            try {
              if (pluginConfig.localApi === "ollama" && routed.tier === "local") {
                stream = createNativeOllamaStream(
                  routed,
                  directToolExposure.context,
                  requestLogger.wrapOptions(options),
                );
              } else if (routed.tier === "local" && routed.api === "openai-completions") {
                stream = createNativeOpenAICompletionsStream(
                  routed,
                  directToolExposure.context,
                  requestLogger.wrapOptions(options),
                  resolveRouterApiKey(),
                );
              } else {
                stream = (await baseStreamFn(
                  directModel as Parameters<typeof baseStreamFn>[0],
                  directToolExposure.context as Parameters<typeof baseStreamFn>[1],
                  requestLogger.wrapOptions(options) as Parameters<typeof baseStreamFn>[2],
                )) as AssistantStream;
              }
            } catch (error) {
              requestLogger.logStreamFailure(error, {});
              throw error;
            }

            return wrapStreamWithRouteMeta(
              stream,
              pluginConfig.showModelLabel
                ? {
                    source: PROVIDER_ID,
                    mode: "direct",
                    tier: routed.tier,
                  }
                : undefined,
              requestLogger,
            );
          }

          // 1. 메시지 추출
          const lastMessage = extractLastUserMessage(context);
          const evalContext: EvaluationContext = {
            turnCount: turnIndex,
            hasToolUse: detectToolUse(context),
          };
          let evaluationTrace: EvaluationTrace | undefined;

          // 2. 평가 모드에 따라 복잡도 판별
          const decision =
            pluginConfig.evaluationMode === "llm"
              ? await (async () => {
                  const evaluationRequest = resolveEvaluationRequestConfig(pluginConfig);

                  const runEvaluation = async () =>
                    evaluateComplexityWithLLM(
                      lastMessage,
                      evaluationRequest.baseUrl,
                      evaluationRequest.model,
                      evalContext,
                      pluginConfig.threshold,
                      pluginConfig.evaluationTimeoutMs,
                      evaluationRequest.apiType,
                      evaluationRequest.apiKey,
                      (trace) => {
                        evaluationTrace = trace;
                      },
                    );

                  let llmDecision = await runEvaluation();

                  for (let retryIndex = 0; retryIndex < pluginConfig.evaluationTimeoutRetryCount; retryIndex += 1) {
                    const timeoutFallbackToRule =
                      evaluationTrace?.fallbackToRule === true &&
                      typeof evaluationTrace.error === "string" &&
                      isClassifierTimeoutError(evaluationTrace.error);
                    if (!timeoutFallbackToRule) {
                      break;
                    }
                    llmDecision = await runEvaluation();
                  }

                  const classifierFallback = resolveClassifierFailureFallback(pluginConfig, evaluationTrace);

                  if (classifierFallback) {
                    const fallbackRoute = resolveRouteModel(
                      pluginConfig,
                      classifierFallback.target,
                    );
                    llmDecision = {
                      ...llmDecision,
                      target: classifierFallback.target,
                      reason: `${llmDecision.reason}, ${classifierFallback.reason}: ${fallbackRoute.label}`,
                    };
                    if (evaluationTrace) {
                      evaluationTrace = {
                        ...evaluationTrace,
                        finalTarget: classifierFallback.target,
                        classifierReason: llmDecision.reason,
                      };
                    }
                  }

                  return llmDecision;
                })()
              : (() => {
                  const evaluationStartedAt = Date.now();
                  const ruleDecision = evaluateComplexity(lastMessage, evalContext, pluginConfig.threshold);
                  evaluationTrace = buildRuleEvaluationTrace(
                    ruleDecision,
                    evalContext,
                    pluginConfig.threshold,
                    evaluationStartedAt,
                    lastMessage,
                  );
                  return ruleDecision;
                })();

          let adjustedDecision = decision;
          const localHealth = executionLogger.getLocalHealthSnapshot();
          const routeAdjustmentReason =
            adjustedDecision.target === "local"
              ? shouldEscalateLocalRoute(localHealth, pluginConfig)
              : undefined;

          if (routeAdjustmentReason) {
            adjustedDecision = {
              ...adjustedDecision,
              target: "nano",
              reason: `${adjustedDecision.reason} | [health] ${routeAdjustmentReason}`,
            };
            if (evaluationTrace) {
              evaluationTrace = {
                ...evaluationTrace,
                finalTarget: "nano",
              };
            }
          }

          const routed = resolveRouteModel(pluginConfig, adjustedDecision.target);
          const toolExposure = applyToolExposurePolicy(
            context,
            routed.tier,
            lastMessage,
            evalContext,
            pluginConfig.toolExposureMode,
            pluginConfig.localForceNoTools,
          );
          const requestLogger = executionLogger.createRequest({
            requestedModelId: requestedModelId ?? String((model as Record<string, unknown>)?.id ?? "unknown"),
            routeMode: "auto",
            evaluationMode: pluginConfig.evaluationMode,
            threshold: pluginConfig.threshold,
            routeTier: routed.tier,
            routeProvider: routed.provider,
            routeModel: routed.model,
            routeApi: routed.api,
            routeLabel: routed.label,
            thinkingLevel: ctx.thinkingLevel,
            workspaceDir: ctx.workspaceDir,
            agentDir: ctx.agentDir,
            sessionId,
            turnIndex,
            rootTurnId,
            toolExposureMode: pluginConfig.toolExposureMode,
            toolExposureApplied: toolExposure.applied,
            originalToolCount: toolExposure.originalToolCount,
            retainedToolCount: toolExposure.retainedToolCount,
            routeAdjustmentReason,
            localHealth,
            context: toolExposure.context,
            extraParams: ctx.extraParams,
            streamOptions: options,
            decision: {
              level: adjustedDecision.level,
              reason: adjustedDecision.reason,
              scoreTotal: adjustedDecision.score.total,
              scoreBreakdown: adjustedDecision.score.breakdown,
            },
          });
          if (evaluationTrace) {
            requestLogger.logEvaluation(evaluationTrace);
          }
          requestLogger.logRoute();

          // 3. 라우팅 결정 로그
          const logPrefix = `[smart-router]`;
          const targetEmoji = adjustedDecision.target === "local" ? "🏠" : "☁️";
          const modeTag = pluginConfig.evaluationMode === "llm" ? "LLM" : "rule";
          console.log(
            `${logPrefix} ${targetEmoji} ${adjustedDecision.level} (score: ${adjustedDecision.score.total}, eval: ${modeTag}) → ${routed.label} | ${adjustedDecision.reason}`,
          );

          const routedModel = {
            ...(model as Record<string, unknown>),
            id: routed.model,
            api: routed.api,
            baseUrl: routed.baseUrl,
            provider: routed.provider,
            contextWindow: routed.contextWindow,
            maxTokens: routed.maxTokens,
          };

          let stream: AssistantStream;
          const firstAttemptAbort = new AbortController();
          try {
            if (pluginConfig.localApi === "ollama" && routed.tier === "local") {
              stream = createNativeOllamaStream(
                routed,
                toolExposure.context,
                withAbortSignal(
                  requestLogger.wrapOptions(options),
                  pluginConfig.streamRetryOnFailure ? firstAttemptAbort.signal : undefined,
                ),
              );
            } else if (routed.tier === "local" && routed.api === "openai-completions") {
              stream = createNativeOpenAICompletionsStream(
                routed,
                toolExposure.context,
                withAbortSignal(
                  requestLogger.wrapOptions(options),
                  pluginConfig.streamRetryOnFailure ? firstAttemptAbort.signal : undefined,
                ),
                resolveRouterApiKey(),
              );
            } else {
              stream = (await baseStreamFn(
                routedModel as Parameters<typeof baseStreamFn>[0],
                toolExposure.context as Parameters<typeof baseStreamFn>[1],
                withAbortSignal(
                  requestLogger.wrapOptions(options),
                  pluginConfig.streamRetryOnFailure ? firstAttemptAbort.signal : undefined,
                ) as Parameters<typeof baseStreamFn>[2],
              )) as AssistantStream;
            }
          } catch (error) {
            requestLogger.logStreamFailure(error, {});
            throw error;
          }

          const primaryWrappedStream = wrapStreamWithRouteMeta(
            stream,
            pluginConfig.showModelLabel
              ? {
                  source: PROVIDER_ID,
                  mode: "auto",
                  tier: routed.tier,
                  level: adjustedDecision.level,
                }
              : undefined,
            requestLogger,
          );

          const createRetryStream = async (reason: AutoRetryReason): Promise<AssistantStream | undefined> => {
            if (!pluginConfig.streamRetryOnFailure) {
              return undefined;
            }

            const retryTarget = resolveRetryTarget(routed.tier);
            if (!retryTarget) {
              return undefined;
            }

            firstAttemptAbort.abort();

            const retryRoute = resolveRouteModel(pluginConfig, retryTarget);
            const retryDecision = {
              ...adjustedDecision,
              target: retryTarget,
              reason: `${adjustedDecision.reason} | [retry:${reason}] ${routed.tier} -> ${retryTarget}`,
            };
            const retryToolExposure = applyToolExposurePolicy(
              context,
              retryRoute.tier,
              lastMessage,
              evalContext,
              pluginConfig.toolExposureMode,
              pluginConfig.localForceNoTools,
            );

            const retryLogger = executionLogger.createRequest({
              requestedModelId: requestedModelId ?? String((model as Record<string, unknown>)?.id ?? "unknown"),
              routeMode: "auto",
              evaluationMode: pluginConfig.evaluationMode,
              threshold: pluginConfig.threshold,
              routeTier: retryRoute.tier,
              routeProvider: retryRoute.provider,
              routeModel: retryRoute.model,
              routeApi: retryRoute.api,
              routeLabel: retryRoute.label,
              thinkingLevel: ctx.thinkingLevel,
              workspaceDir: ctx.workspaceDir,
              agentDir: ctx.agentDir,
              sessionId,
              turnIndex,
              rootTurnId,
              toolExposureMode: pluginConfig.toolExposureMode,
              toolExposureApplied: retryToolExposure.applied,
              originalToolCount: retryToolExposure.originalToolCount,
              retainedToolCount: retryToolExposure.retainedToolCount,
              routeAdjustmentReason: `retry:${reason}:${routed.tier}->${retryRoute.tier}`,
              localHealth,
              context: retryToolExposure.context,
              extraParams: ctx.extraParams,
              streamOptions: options,
              decision: {
                level: retryDecision.level,
                reason: retryDecision.reason,
                scoreTotal: retryDecision.score.total,
                scoreBreakdown: retryDecision.score.breakdown,
              },
            });
            retryLogger.logRoute();

            const retryModel = {
              ...(model as Record<string, unknown>),
              id: retryRoute.model,
              api: retryRoute.api,
              baseUrl: retryRoute.baseUrl,
              provider: retryRoute.provider,
              contextWindow: retryRoute.contextWindow,
              maxTokens: retryRoute.maxTokens,
            };

            let retryStream: AssistantStream;
            try {
              retryStream = (await baseStreamFn(
                retryModel as Parameters<typeof baseStreamFn>[0],
                retryToolExposure.context as Parameters<typeof baseStreamFn>[1],
                retryLogger.wrapOptions(options) as Parameters<typeof baseStreamFn>[2],
              )) as AssistantStream;
            } catch (error) {
              retryLogger.logStreamFailure(error, {});
              return undefined;
            }

            return wrapStreamWithRouteMeta(
              retryStream,
              pluginConfig.showModelLabel
                ? {
                    source: PROVIDER_ID,
                    mode: "auto",
                    tier: retryRoute.tier,
                    level: retryDecision.level,
                  }
                : undefined,
              retryLogger,
            );
          };

          return wrapStreamWithAutoRetry(
            primaryWrappedStream,
            createRetryStream,
            pluginConfig.streamFirstTokenTimeoutMs,
          );
        };
      },

      // ---------------------------------------------------------------
      // Thinking: adaptive 기본값 (프로바이더 수준에서 적응형 사고)
      // ---------------------------------------------------------------
      resolveDefaultThinkingLevel: () => "adaptive",
    });
  },
});
