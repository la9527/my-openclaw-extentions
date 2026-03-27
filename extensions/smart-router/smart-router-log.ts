import crypto from "node:crypto";
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { EvaluationTrace } from "./complexity.js";

type JsonObject = Record<string, unknown>;

export interface SmartRouterLoggerConfig {
  enabled?: boolean;
  filePath?: string;
  includePayloadBody?: boolean;
  maxTextChars?: number;
  retentionDays?: number;
}

export interface SmartRouterRouteDecision {
  level?: string;
  reason?: string;
  scoreTotal?: number;
  scoreBreakdown?: Record<string, number>;
}

export interface SmartRouterRouteInfo {
  requestedModelId: string;
  routeMode: "auto" | "direct";
  evaluationMode: string;
  threshold?: string;
  routeTier: string;
  routeProvider: string;
  routeModel: string;
  routeApi: string;
  routeLabel: string;
  thinkingLevel?: string;
  workspaceDir?: string;
  agentDir?: string;
  sessionId?: string;
  turnIndex?: number;
  rootTurnId?: string;
  parentRequestId?: string;
  context: unknown;
  extraParams?: Record<string, unknown>;
  streamOptions?: unknown;
  decision?: SmartRouterRouteDecision;
}

export interface SmartRouterResponseLog {
  kind: "response" | "response_error";
  message: AssistantMessage;
  eventCounts: Record<string, number>;
  thrownError?: unknown;
}

type SmartRouterLogEvent = JsonObject & {
  ts: string;
  event: "evaluation" | "route" | "payload" | "response" | "response_error" | "stream_failure";
  requestId: string;
};

const DEFAULT_LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "smart-router.jsonl");
const DEFAULT_MAX_TEXT_CHARS = 600;
const DEFAULT_RETENTION_DAYS = 10;
const SENSITIVE_KEY_RE = /(api[-_]?key|authorization|token|secret|password|cookie|session)/i;
const BASE64_KEY_RE = /(data|blob|base64|image)/i;
const writeChains = new Map<string, Promise<void>>();

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function digest(value: unknown): string | undefined {
  const serialized = safeJsonStringify(value);
  if (!serialized) return undefined;
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function formatError(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  const serialized = safeJsonStringify(error);
  return serialized ?? undefined;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function clampPositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : fallback;
}

function formatLogDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitLogPath(filePath: string): { dirPath: string; baseName: string; extension: string } {
  const parsedPath = path.parse(filePath);
  return {
    dirPath: parsedPath.dir,
    baseName: parsedPath.name,
    extension: parsedPath.ext || ".jsonl",
  };
}

function resolveDatedLogPath(filePath: string, date = new Date()): string {
  const { dirPath, baseName, extension } = splitLogPath(filePath);
  return path.join(dirPath, `${baseName}-${formatLogDate(date)}${extension}`);
}

function getRetentionCutoffDate(retentionDays: number, now = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - Math.max(retentionDays - 1, 0));
  return cutoff;
}

async function pruneOldLogFiles(filePath: string, retentionDays: number, now = new Date()): Promise<void> {
  if (retentionDays <= 0) return;

  const { dirPath, baseName, extension } = splitLogPath(filePath);
  const fileNamePattern = new RegExp(`^${escapeRegExp(baseName)}-(\\d{4}-\\d{2}-\\d{2})${escapeRegExp(extension)}$`);
  const cutoffDate = getRetentionCutoffDate(retentionDays, now);

  let entries: string[] = [];
  try {
    entries = await readdir(dirPath);
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const match = entry.match(fileNamePattern);
      if (!match?.[1]) return;

      const entryDate = new Date(`${match[1]}T00:00:00.000Z`);
      if (Number.isNaN(entryDate.getTime()) || entryDate >= cutoffDate) {
        return;
      }

      await rm(path.join(dirPath, entry), { force: true });
    }),
  );
}

function summarizePrimitive(value: unknown): unknown {
  if (typeof value === "string") return truncateText(value, 120);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "object") {
    return { type: "object", keys: Object.keys(value as JsonObject).sort() };
  }
  return String(value);
}

function redactValue(value: unknown, keyPath: string[] = [], depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    const key = keyPath.at(-1) ?? "";
    if (SENSITIVE_KEY_RE.test(key)) {
      return "<redacted>";
    }
    if (BASE64_KEY_RE.test(key) && value.length > 200) {
      return `<redacted:${value.length} chars sha256:${crypto.createHash("sha256").update(value).digest("hex")}>`;
    }
    return truncateText(value, DEFAULT_MAX_TEXT_CHARS);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (depth >= 8) {
    return "<truncated-depth>";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, keyPath, depth + 1, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) {
      return "<circular>";
    }
    seen.add(value as object);

    const out: JsonObject = {};
    const entries = Object.entries(value as JsonObject);
    for (const [key, nested] of entries.slice(0, 50)) {
      out[key] = redactValue(nested, [...keyPath, key], depth + 1, seen);
    }
    if (entries.length > 50) {
      out.__truncatedKeys = entries.length - 50;
    }
    return out;
  }

  return String(value);
}

function collectTextLengthFromContentItem(item: unknown): number {
  if (!item || typeof item !== "object") return 0;
  const typedItem = item as JsonObject;
  const textValue = typedItem.text;
  if (typeof textValue === "string") return textValue.length;
  const thinkingValue = typedItem.thinking;
  if (typeof thinkingValue === "string") return thinkingValue.length;
  return 0;
}

function summarizeMessageLikeArray(messages: unknown[]): JsonObject {
  const roleCounts: Record<string, number> = {};
  const contentTypes = new Set<string>();
  const toolNames = new Set<string>();
  let textChars = 0;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const typedMessage = message as JsonObject;
    const role = typeof typedMessage.role === "string" ? typedMessage.role : "unknown";
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;

    if (typeof typedMessage.content === "string") {
      contentTypes.add("string");
      textChars += typedMessage.content.length;
      continue;
    }

    if (!Array.isArray(typedMessage.content)) continue;

    for (const item of typedMessage.content) {
      if (!item || typeof item !== "object") continue;
      const typedItem = item as JsonObject;
      if (typeof typedItem.type === "string") {
        contentTypes.add(typedItem.type);
      }
      if (typeof typedItem.name === "string") {
        toolNames.add(typedItem.name);
      }
      textChars += collectTextLengthFromContentItem(item);
    }
  }

  return {
    messageCount: messages.length,
    roleCounts,
    contentTypes: [...contentTypes].sort(),
    textChars,
    toolNames: [...toolNames].sort(),
  };
}

function summarizeContext(context: unknown): JsonObject {
  if (!context || typeof context !== "object") {
    return { kind: typeof context };
  }

  const typedContext = context as JsonObject;
  const messages = typedContext.messages ?? typedContext.input ?? typedContext.prompt;
  const summary: JsonObject = {
    rootKeys: Object.keys(typedContext).sort(),
  };

  if (typeof typedContext.systemPrompt === "string") {
    summary.systemPromptChars = typedContext.systemPrompt.length;
  }

  if (Array.isArray(messages)) {
    summary.messages = summarizeMessageLikeArray(messages);
  } else if (typeof messages === "string") {
    summary.promptChars = messages.length;
  } else {
    summary.messageContainerType = typeof messages;
  }

  return summary;
}

function summarizePayload(payload: unknown): JsonObject {
  if (!payload || typeof payload !== "object") {
    return { kind: typeof payload };
  }

  const typedPayload = payload as JsonObject;
  const summary: JsonObject = {
    rootKeys: Object.keys(typedPayload).sort(),
  };

  if (Array.isArray(typedPayload.messages)) {
    summary.messages = summarizeMessageLikeArray(typedPayload.messages);
  }

  if (Array.isArray(typedPayload.input)) {
    summary.input = summarizeMessageLikeArray(typedPayload.input);
  } else if (typeof typedPayload.input === "string") {
    summary.inputChars = typedPayload.input.length;
  }

  if (Array.isArray(typedPayload.tools)) {
    summary.toolCount = typedPayload.tools.length;
    summary.toolNames = typedPayload.tools
      .map((tool) => {
        if (!tool || typeof tool !== "object") return undefined;
        const typedTool = tool as JsonObject;
        if (typeof typedTool.name === "string") return typedTool.name;
        const fn = typedTool.function;
        if (fn && typeof fn === "object" && typeof (fn as JsonObject).name === "string") {
          return (fn as JsonObject).name as string;
        }
        return undefined;
      })
      .filter((name): name is string => Boolean(name))
      .sort();
  }

  for (const key of [
    "model",
    "max_output_tokens",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "store",
    "stream",
    "service_tier",
    "reasoning",
    "text",
    "previous_response_id",
  ]) {
    if (key in typedPayload) {
      summary[key] = summarizePrimitive(typedPayload[key]);
    }
  }

  return summary;
}

function summarizeExtraParams(extraParams?: Record<string, unknown>): JsonObject | undefined {
  if (!extraParams) return undefined;
  const summary: JsonObject = {};
  for (const [key, value] of Object.entries(extraParams)) {
    summary[key] = summarizePrimitive(value);
  }
  return summary;
}

function summarizeStreamOptions(options: unknown): JsonObject | undefined {
  if (!options || typeof options !== "object") return undefined;
  const typedOptions = options as JsonObject;
  const summary: JsonObject = {};

  for (const key of [
    "temperature",
    "maxTokens",
    "sessionId",
    "transport",
    "cacheRetention",
    "maxRetryDelayMs",
    "reasoning",
  ]) {
    if (key in typedOptions) {
      summary[key] = summarizePrimitive(typedOptions[key]);
    }
  }

  if (typedOptions.headers && typeof typedOptions.headers === "object") {
    summary.headerKeys = Object.keys(typedOptions.headers as JsonObject).sort();
  }
  if (typedOptions.metadata && typeof typedOptions.metadata === "object") {
    summary.metadataKeys = Object.keys(typedOptions.metadata as JsonObject).sort();
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizeAssistantMessage(message: AssistantMessage, maxTextChars: number): JsonObject {
  const contentTypes = new Set<string>();
  const toolCallNames = new Set<string>();
  let textChars = 0;
  let thinkingChars = 0;

  for (const item of message.content) {
    contentTypes.add(item.type);
    if (item.type === "text") {
      textChars += item.text.length;
    }
    if (item.type === "thinking") {
      thinkingChars += item.thinking.length;
    }
    if (item.type === "toolCall") {
      toolCallNames.add(item.name);
    }
  }

  const firstText = message.content.find((item) => item.type === "text");

  return {
    provider: message.provider,
    api: message.api,
    model: message.model,
    responseId: message.responseId,
    stopReason: message.stopReason,
    contentTypes: [...contentTypes].sort(),
    toolCallCount: toolCallNames.size,
    toolCallNames: [...toolCallNames].sort(),
    textChars,
    thinkingChars,
    firstTextPreview:
      firstText && firstText.type === "text"
        ? truncateText(firstText.text, maxTextChars)
        : undefined,
  };
}

function enqueueWrite(filePath: string, line: string): Promise<void> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, line, "utf8");
    })
    .catch((error) => {
      console.error("[smart-router] failed to write log", error);
    });

  writeChains.set(filePath, next);
  return next;
}

export class SmartRouterRequestLogger {
  private readonly startedAt = Date.now();

  constructor(
    private readonly logger: SmartRouterLogger,
    readonly requestId: string,
    private readonly info: SmartRouterRouteInfo,
  ) {}

  logEvaluation(trace: EvaluationTrace): void {
    this.logger.write({
      ...this.baseEvent("evaluation"),
      evaluationId: crypto.randomUUID(),
      evaluation: trace,
      evaluationApiType: trace.apiType,
      evaluationDurationMs: trace.durationMs,
      evaluationTarget: trace.finalTarget,
      evaluationFallbackToRule: trace.fallbackToRule,
      evaluationUsage: trace.usage,
    });
  }

  logRoute(): void {
    this.logger.write({
      ...this.baseEvent("route"),
      decision: this.info.decision,
      contextSummary: summarizeContext(this.info.context),
      extraParams: summarizeExtraParams(this.info.extraParams),
      streamOptions: summarizeStreamOptions(this.info.streamOptions),
    });
  }

  wrapOptions(options: unknown): unknown {
    if (!this.logger.enabled || !options || typeof options !== "object") {
      return options;
    }

    const typedOptions = options as JsonObject;
    const existingOnPayload =
      typeof typedOptions.onPayload === "function"
        ? (typedOptions.onPayload as (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>)
        : undefined;

    return {
      ...typedOptions,
      onPayload: async (payload: unknown, model: Model<Api>) => {
        const nextPayload = await existingOnPayload?.(payload, model);
        const finalPayload = nextPayload !== undefined ? nextPayload : payload;
        this.logger.write({
          ...this.baseEvent("payload"),
          payloadSummary: summarizePayload(finalPayload),
          payloadDigest: digest(redactValue(finalPayload)),
          payloadModel: {
            provider: model.provider,
            api: model.api,
            id: model.id,
          },
          rewritten: nextPayload !== undefined,
          payload: this.logger.includePayloadBody ? redactValue(finalPayload) : undefined,
        });
        return nextPayload;
      },
    };
  }

  logResponse(params: SmartRouterResponseLog): void {
    this.logger.write({
      ...this.baseEvent(params.kind),
      durationMs: Date.now() - this.startedAt,
      eventCounts: params.eventCounts,
      usage: params.message.usage,
      responseSummary: summarizeAssistantMessage(params.message, this.logger.maxTextChars),
      error: formatError(params.thrownError) ?? params.message.errorMessage,
    });
  }

  logStreamFailure(error: unknown, eventCounts: Record<string, number>): void {
    this.logger.write({
      ...this.baseEvent("stream_failure"),
      durationMs: Date.now() - this.startedAt,
      eventCounts,
      error: formatError(error),
    });
  }

  private baseEvent(event: SmartRouterLogEvent["event"]): SmartRouterLogEvent {
    return {
      ts: new Date().toISOString(),
      event,
      requestId: this.requestId,
      requestedModelId: this.info.requestedModelId,
      routeMode: this.info.routeMode,
      evaluationMode: this.info.evaluationMode,
      threshold: this.info.threshold,
      routeTier: this.info.routeTier,
      routeProvider: this.info.routeProvider,
      routeModel: this.info.routeModel,
      routeApi: this.info.routeApi,
      routeLabel: this.info.routeLabel,
      thinkingLevel: this.info.thinkingLevel,
      workspaceDir: this.info.workspaceDir,
      agentDir: this.info.agentDir,
      sessionId: this.info.sessionId,
      turnIndex: this.info.turnIndex,
      rootTurnId: this.info.rootTurnId,
      parentRequestId: this.info.parentRequestId,
    };
  }
}

export class SmartRouterLogger {
  readonly enabled: boolean;
  readonly includePayloadBody: boolean;
  readonly filePath: string;
  readonly maxTextChars: number;
  readonly retentionDays: number;
  private lastPrunedDate?: string;
  private readonly lastRequestIdByTurn = new Map<string, string>();

  constructor(config: SmartRouterLoggerConfig = {}) {
    this.enabled = parseBoolean(process.env.OPENCLAW_SMART_ROUTER_LOG, config.enabled ?? true);
    this.includePayloadBody = parseBoolean(
      process.env.OPENCLAW_SMART_ROUTER_LOG_PAYLOAD,
      config.includePayloadBody ?? false,
    );
    this.filePath = process.env.OPENCLAW_SMART_ROUTER_LOG_FILE?.trim() || config.filePath || DEFAULT_LOG_PATH;
    this.maxTextChars = parseNumber(
      process.env.OPENCLAW_SMART_ROUTER_LOG_TEXT_LIMIT,
      config.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    );
    this.retentionDays = clampPositiveInteger(
      parseNumber(
        process.env.OPENCLAW_SMART_ROUTER_LOG_RETENTION_DAYS,
        config.retentionDays ?? DEFAULT_RETENTION_DAYS,
      ),
      DEFAULT_RETENTION_DAYS,
    );
  }

  createRequest(info: SmartRouterRouteInfo): SmartRouterRequestLogger {
    const requestId = crypto.randomUUID();
    const parentRequestId = info.rootTurnId ? this.lastRequestIdByTurn.get(info.rootTurnId) : undefined;
    if (info.rootTurnId) {
      this.lastRequestIdByTurn.set(info.rootTurnId, requestId);
    }
    return new SmartRouterRequestLogger(this, requestId, {
      ...info,
      parentRequestId,
    });
  }

  async flush(): Promise<void> {
    const datedFilePath = resolveDatedLogPath(this.filePath);
    await (writeChains.get(datedFilePath) ?? Promise.resolve());
  }

  write(event: SmartRouterLogEvent): void {
    if (!this.enabled) return;
    const serialized = safeJsonStringify(event);
    if (!serialized) return;

    const now = new Date();
    const datedFilePath = resolveDatedLogPath(this.filePath, now);
    const currentDate = formatLogDate(now);

    if (this.lastPrunedDate !== currentDate) {
      this.lastPrunedDate = currentDate;
      void pruneOldLogFiles(this.filePath, this.retentionDays, now).catch((error) => {
        console.error("[smart-router] failed to prune old logs", error);
      });
    }

    void enqueueWrite(datedFilePath, `${serialized}\n`);
  }
}

export function createSmartRouterLogger(config: SmartRouterLoggerConfig = {}): SmartRouterLogger {
  return new SmartRouterLogger(config);
}