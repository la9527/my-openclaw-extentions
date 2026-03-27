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
  evaluationLlmTarget: "nano" as Exclude<RouteTarget, "local">,
  evaluationTimeoutMs: 15_000,
  showModelLabel: true,
  logEnabled: true,
  logPayloadBody: false,
  logMaxTextChars: 600,
  logPreviewChars: 240,
  logRetentionDays: 10,
  toolExposureMode: "conservative" as ToolExposureMode,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** localApi ("openai" | "ollama") → OpenClaw provider api 타입으로 변환 */
function toProviderApi(localApi: string): ProviderApiType {
  if (localApi === "ollama") return "ollama";
  return "openai-completions";
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
      (pluginConfig?.evaluationLlmTarget as Exclude<RouteTarget, "local"> | undefined) ??
      DEFAULTS.evaluationLlmTarget,
    evaluationLlmModel: pluginConfig?.evaluationLlmModel
      ? String(pluginConfig.evaluationLlmModel)
      : undefined,
    evaluationTimeoutMs: Number(pluginConfig?.evaluationTimeoutMs ?? DEFAULTS.evaluationTimeoutMs),
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
      api: toProviderApi(config.localApi as string),
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

function buildModelLabel(route: RouteModelConfig, level: ComplexityLevel): string {
  return `<sub>[${route.tier}/${level}]</sub>\n\n`;
}

function buildDirectModelLabel(route: RouteModelConfig): string {
  return `<sub>[${route.tier}]</sub>\n\n`;
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

function stripLeadingModelLabels(text: string): string {
  let normalized = text.replace(/^\s+/u, "");

  while (normalized.length > 0) {
    const next = normalized
      .replace(/^(?:<sub>\s*)?\[smart-router [^\]\n]+\][^\n]*?(?:<\/sub>)?\s*\n+/iu, "")
      .replace(/^(?:<sub>\s*)?\[(?:local|nano|mini|full)(?:\/(?:simple|moderate|complex|advanced|direct))?\](?:<\/sub>)?\s*\n+/iu, "")
      .replace(/^\s+/u, "");

    if (next === normalized) {
      break;
    }

    normalized = next;
  }

  return normalized;
}

function prependModelLabel(text: string, label: string): string {
  const normalized = stripLeadingModelLabels(text);
  if (normalized.startsWith(label)) {
    return normalized;
  }

  return `${label}${normalized}`;
}

function ensureLabeledMessage(message: AssistantMessage, label: string): AssistantMessage {
  const content = [...message.content];
  const firstTextIndex = content.findIndex((item) => item.type === "text");

  if (firstTextIndex === -1) {
    content.unshift({ type: "text", text: label });
    return { ...message, content };
  }

  const firstText = content[firstTextIndex];
  if (firstText.type !== "text" || firstText.text.startsWith(label)) {
    return message;
  }

  content[firstTextIndex] = {
    ...firstText,
    text: prependModelLabel(firstText.text, label),
  };
  return { ...message, content };
}

function wrapStreamWithModelLabel(
  stream: AssistantStream,
  label?: string,
  requestLogger?: SmartRouterRequestLogger,
): AssistantStream {
  let injected = false;
  const wrapped = createAssistantMessageEventStream();
  const eventCounts: Record<string, number> = {};
  let terminalEventSeen = false;

  const patchEvent = (event: AssistantMessageEvent): AssistantMessageEvent => {
    if (!label) {
      return event;
    }

    if (event.type === "text_delta") {
      if (!injected) {
        injected = true;
        return {
          ...event,
          delta: prependModelLabel(event.delta, label),
          partial: ensureLabeledMessage(event.partial, label),
        };
      }

      return {
        ...event,
        partial: ensureLabeledMessage(event.partial, label),
      };
    }

    if (event.type === "text_end") {
      if (!injected) {
        injected = true;
        return {
          ...event,
          content: prependModelLabel(event.content, label),
          partial: ensureLabeledMessage(event.partial, label),
        };
      }

      return {
        ...event,
        partial: ensureLabeledMessage(event.partial, label),
      };
    }

    if (event.type === "done") {
      return {
        ...event,
        message: ensureLabeledMessage(event.message, label),
      };
    }

    if (event.type === "error") {
      return {
        ...event,
        error: ensureLabeledMessage(event.error, label),
      };
    }

    if ("partial" in event && injected) {
      return {
        ...event,
        partial: ensureLabeledMessage(event.partial, label),
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
  const shouldPrune =
    !explicitToolIntent &&
    ((mode === "conservative" && routeTier === "local") ||
      (mode === "minimal" && (routeTier === "local" || routeTier === "nano")));

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
  buildModelLabel,
  buildDirectModelLabel,
  stripLeadingModelLabels,
  prependModelLabel,
  wrapStreamWithModelLabel,
  parseSmartRouterModelId,
  hasExplicitToolIntent,
  applyToolExposurePolicy,
  shouldEscalateLocalRoute,
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
            api: toProviderApi(pluginConfig.localApi as string),
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
          api: toProviderApi(pluginConfig.localApi as string),
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
              context,
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
              stream = (await baseStreamFn(
                directModel as Parameters<typeof baseStreamFn>[0],
                context as Parameters<typeof baseStreamFn>[1],
                requestLogger.wrapOptions(options) as Parameters<typeof baseStreamFn>[2],
              )) as AssistantStream;
            } catch (error) {
              requestLogger.logStreamFailure(error, {});
              throw error;
            }

            return wrapStreamWithModelLabel(stream, undefined, requestLogger);
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
              ? await evaluateComplexityWithLLM(
                  lastMessage,
                  pluginConfig.remoteBaseUrl,
                  pluginConfig.evaluationLlmModel ??
                    resolveRouteModel(
                      pluginConfig,
                      pluginConfig.evaluationLlmTarget,
                    ).model,
                  evalContext,
                  pluginConfig.threshold,
                  pluginConfig.evaluationTimeoutMs,
                  pluginConfig.remoteApi === "openai-responses"
                    ? "openai-responses"
                    : "openai" as LocalApiType,
                  pluginConfig.remoteBaseUrl.includes("api.openai.com")
                    ? process.env.OPENAI_API_KEY?.trim()
                    : undefined,
                  (trace) => {
                    evaluationTrace = trace;
                  },
                )
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
          try {
            stream = (await baseStreamFn(
              routedModel as Parameters<typeof baseStreamFn>[0],
              toolExposure.context as Parameters<typeof baseStreamFn>[1],
              requestLogger.wrapOptions(options) as Parameters<typeof baseStreamFn>[2],
            )) as AssistantStream;
          } catch (error) {
            requestLogger.logStreamFailure(error, {});
            throw error;
          }

          return wrapStreamWithModelLabel(
            stream,
            pluginConfig.showModelLabel ? buildModelLabel(routed, adjustedDecision.level) : undefined,
            requestLogger,
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
