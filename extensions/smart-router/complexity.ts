/**
 * Smart Router – 요청 복잡도 판별 엔진
 *
 * 메시지 내용을 분석하여 로컬 LLM과 외부 LLM 중
 * 어느 쪽이 적합한지 결정한다.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplexityLevel = "simple" | "moderate" | "complex" | "advanced";

export type RouteTarget = "local" | "nano" | "mini" | "full";

export interface ComplexityScore {
  total: number;
  breakdown: {
    length: number;
    code: number;
    tools: number;
    depth: number;
    keywords: number;
  };
}

export interface RoutingDecision {
  level: ComplexityLevel;
  score: ComplexityScore;
  target: RouteTarget;
  reason: string;
}

export interface EvaluationUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface EvaluationTrace {
  mode: "rule" | "llm";
  apiType: LocalApiType | "rule";
  model?: string;
  baseUrl?: string;
  endpoint?: string;
  durationMs: number;
  messageChars: number;
  turnCount?: number;
  hasToolUse?: boolean;
  threshold: ComplexityLevel;
  promptChars?: number;
  usage?: EvaluationUsageSummary;
  httpStatus?: number;
  classifierLevel?: ComplexityLevel;
  classifierReason?: string;
  finalTarget: RouteTarget;
  fallbackToRule: boolean;
  error?: string;
}

export interface EvaluationContext {
  /** 현재 대화 턴 수 */
  turnCount?: number;
  /** 도구(함수) 호출 요청 포함 여부 */
  hasToolUse?: boolean;
  /** 이전 메시지에서 이미 라우팅된 적 있는지 */
  previousTarget?: RouteTarget;
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/** 각 카테고리별 최대 점수 */
const MAX_LENGTH_SCORE = 4;
const MAX_CODE_SCORE = 4;
const MAX_TOOL_SCORE = 3;
const MAX_DEPTH_SCORE = 3;
const MAX_KEYWORD_SCORE = 3;

/** 복잡도 레벨 경계값 (total score 기준) */
const THRESHOLD_MODERATE = 4;
const THRESHOLD_COMPLEX = 7;
const THRESHOLD_ADVANCED = 12;

// ---------------------------------------------------------------------------
// Keyword dictionaries
// ---------------------------------------------------------------------------

/** 고복잡도를 시사하는 키워드 (한국어 + 영어) */
const COMPLEX_KEYWORDS = [
  // 코드 관련
  "refactor", "리팩토링", "리팩터링",
  "architecture", "아키텍처", "설계",
  "debug", "디버그", "디버깅",
  "optimize", "최적화",
  "implement", "구현",
  "algorithm", "알고리즘",
  "data structure", "자료구조",
  "design pattern", "디자인 패턴",
  "concurrency", "동시성", "병렬",
  "security", "보안",
  "performance", "성능",
  "migration", "마이그레이션",
  "deploy", "배포",
  // 분석 관련
  "analyze", "분석",
  "compare", "비교",
  "evaluate", "평가",
  "review", "리뷰",
  "explain in detail", "자세히 설명",
  "step by step", "단계별",
  "pros and cons", "장단점",
  // 생성 관련
  "generate", "생성",
  "create a", "만들어",
  "write a", "작성",
  "build", "빌드",
] as const;

/** 단순 요청을 시사하는 키워드 */
const SIMPLE_KEYWORDS = [
  "hello", "hi", "안녕", "ㅎㅇ",
  "thanks", "고마워", "감사",
  "yes", "no", "네", "아니",
  "ok", "ㅇㅋ", "알겠",
  "what time", "몇 시",
  "weather", "날씨",
  "translate", "번역",
] as const;

// ---------------------------------------------------------------------------
// Scoring functions
// ---------------------------------------------------------------------------

function scoreLength(text: string): number {
  const charCount = text.length;
  if (charCount < 50) return 0;
  if (charCount < 200) return 1;
  if (charCount < 500) return 2;
  if (charCount < 1500) return 3;
  return MAX_LENGTH_SCORE;
}

function scoreCode(text: string): number {
  let score = 0;

  // 코드 블록 존재
  const codeBlockCount = (text.match(/```/g) ?? []).length / 2;
  if (codeBlockCount >= 2) score += 3;
  else if (codeBlockCount >= 1) score += 2;

  // 인라인 코드
  const inlineCodeCount = (text.match(/`[^`]+`/g) ?? []).length;
  if (inlineCodeCount >= 5) score += 1;

  // 프로그래밍 언어 키워드 (코드 블록 외부에서도 감지)
  const codeKeywords = /\b(function|class|import|export|const|let|var|def|async|await|return|interface|type|struct|enum)\b/i;
  if (codeKeywords.test(text)) score += 1;

  return Math.min(score, MAX_CODE_SCORE);
}

function scoreToolUse(text: string, context?: EvaluationContext): number {
  let score = 0;

  if (context?.hasToolUse) score += 2;

  // 도구/함수 호출 관련 키워드
  const toolPatterns = /\b(API|endpoint|webhook|curl|fetch|request|HTTP|REST|GraphQL|database|SQL|query)\b/i;
  if (toolPatterns.test(text)) score += 1;

  // 파일 시스템 접근 관련
  const filePatterns = /\b(file|directory|folder|path|read|write|create|delete|move|copy)\b/i;
  if (filePatterns.test(text)) score += 1;

  return Math.min(score, MAX_TOOL_SCORE);
}

function scoreDepth(context?: EvaluationContext): number {
  const turns = context?.turnCount ?? 0;
  if (turns < 3) return 0;
  if (turns < 6) return 1;
  if (turns < 12) return 2;
  return MAX_DEPTH_SCORE;
}

function scoreKeywords(text: string): number {
  const lower = text.toLowerCase();
  let complexCount = 0;
  let simpleCount = 0;

  for (const kw of COMPLEX_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) complexCount++;
  }
  for (const kw of SIMPLE_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) simpleCount++;
  }

  // 복잡 키워드가 많으면 +, 단순 키워드가 많으면 -
  const net = complexCount - simpleCount;
  if (net <= -2) return 0;
  if (net <= 0) return 1;
  if (net <= 2) return 2;
  return MAX_KEYWORD_SCORE;
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

function levelFromScore(total: number): ComplexityLevel {
  if (total < THRESHOLD_MODERATE) return "simple";
  if (total < THRESHOLD_COMPLEX) return "moderate";
  if (total < THRESHOLD_ADVANCED) return "complex";
  return "advanced";
}

export function routeTargetFromLevel(
  level: ComplexityLevel,
  remoteThreshold: ComplexityLevel = "moderate",
): RouteTarget {
  const thresholdOrder: ComplexityLevel[] = ["simple", "moderate", "complex", "advanced"];
  const levelIdx = thresholdOrder.indexOf(level);
  const thresholdIdx = thresholdOrder.indexOf(remoteThreshold);

  if (levelIdx < thresholdIdx) return "local";

  switch (level) {
    case "simple":
      return "local";
    case "moderate":
      return "nano";
    case "complex":
      return "mini";
    case "advanced":
      return "full";
  }
}

/**
 * 메시지와 대화 컨텍스트를 기반으로 복잡도를 평가하고 라우팅 결정을 내린다.
 */
export function evaluateComplexity(
  message: string,
  context?: EvaluationContext,
  /** 이 수준 이상이면 remote tier(nano/mini/full)로 라우팅. 기본값: "moderate" */
  remoteThreshold: ComplexityLevel = "moderate",
): RoutingDecision {
  const trimmedMessage = message.trim();
  const breakdown = {
    length: scoreLength(message),
    code: scoreCode(message),
    tools: scoreToolUse(message, context),
    depth: scoreDepth(context),
    keywords: scoreKeywords(message),
  };

  // 짧은 인사/단답은 긴 세션 맥락 때문에 remote tier로 밀리지 않게 고정한다.
  if (
    trimmedMessage.length <= 20 &&
    breakdown.length === 0 &&
    breakdown.code === 0 &&
    breakdown.tools === 0 &&
    breakdown.keywords <= 1
  ) {
    return {
      level: "simple",
      score: {
        total: Math.min(breakdown.keywords, 1),
        breakdown: {
          ...breakdown,
          depth: 0,
        },
      },
      target: "local",
      reason: "단순 질의",
    };
  }

  const total = breakdown.length + breakdown.code + breakdown.tools + breakdown.depth + breakdown.keywords;
  const level = levelFromScore(total);
  const target = routeTargetFromLevel(level, remoteThreshold);

  const reasons: string[] = [];
  if (breakdown.code >= 2) reasons.push("코드 분석 필요");
  if (breakdown.tools >= 2) reasons.push("도구 사용 감지");
  if (breakdown.depth >= 2) reasons.push("깊은 대화 맥락");
  if (breakdown.length >= 3) reasons.push("장문 입력");
  if (breakdown.keywords >= 2) reasons.push("복잡한 작업 키워드");
  if (reasons.length === 0) reasons.push(target === "local" ? "단순 질의" : "복합 요청");

  return {
    level,
    score: { total, breakdown },
    target,
    reason: reasons.join(", "),
  };
}

/**
 * 복잡도 레벨을 사람이 읽기 좋은 문자열로 변환.
 */
export function formatComplexityLevel(level: ComplexityLevel): string {
  switch (level) {
    case "simple": return "단순 (Simple)";
    case "moderate": return "보통 (Moderate)";
    case "complex": return "복잡 (Complex)";
    case "advanced": return "고급 (Advanced)";
  }
}

// ---------------------------------------------------------------------------
// LLM-based evaluation
// ---------------------------------------------------------------------------

/** LLM 평가에 사용할 시스템 프롬프트 */
const LLM_CLASSIFIER_PROMPT = `You are a request complexity classifier. Analyze the user's message and classify its complexity.

Respond ONLY with a JSON object (no markdown, no explanation) in this exact format:
{"level":"simple|moderate|complex|advanced","reason":"한국어로 이유를 간결하게 설명"}

Classification criteria:
- simple: 인사, 간단한 질문, 번역, 날씨, 단답형 (예: "안녕", "오늘 날씨", "고마워")
- moderate: 일반 지식 질문, 요약, 간단한 설명 요청 (예: "파이썬이 뭐야?", "docker 명령어 알려줘")
- complex: 코드 작성/분석, 설계, 디버깅, 다단계 작업, 비교 분석 (예: "이 코드 리팩토링해줘", "아키텍처 설계해줘")
- advanced: 대규모 코드베이스 분석, 복합 시스템 설계, 연구 수준 분석, 여러 도구 연동 (예: "마이크로서비스 전체 설계", "보안 감사")

Consider: message length, code presence, technical depth, number of sub-tasks, domain expertise required.`;

/** Ollama /api/chat 응답 타입 */
interface OllamaChatResponse {
  message?: { content?: string };
}

/** OpenAI /v1/chat/completions 응답 타입 */
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** OpenAI /v1/responses 응답 타입 */
interface OpenAIResponsesResponse {
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

/** 로컬 LLM API 타입 */
export type LocalApiType = "ollama" | "openai" | "openai-responses";

type UsageContainer = {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
  prompt_eval_count?: number;
  eval_count?: number;
};

function normalizeUsageSummary(input = 0, output = 0, cacheRead = 0, cacheWrite = 0, totalTokens = 0): EvaluationUsageSummary {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
  };
}

function extractEvaluationUsage(payload: OpenAIResponsesResponse & OpenAIChatResponse & OllamaChatResponse & UsageContainer): EvaluationUsageSummary | undefined {
  if (payload.usage) {
    const openAiUsage = payload.usage as OpenAIResponsesResponse["usage"] & UsageContainer["usage"];
    const input = openAiUsage?.input_tokens ?? openAiUsage?.prompt_tokens ?? 0;
    const output = openAiUsage?.output_tokens ?? openAiUsage?.completion_tokens ?? 0;
    const cacheRead = openAiUsage?.input_tokens_details?.cached_tokens ?? openAiUsage?.prompt_tokens_details?.cached_tokens ?? 0;
    const totalTokens = openAiUsage?.total_tokens ?? input + output;
    return normalizeUsageSummary(input, output, cacheRead, 0, totalTokens);
  }

  if (typeof payload.prompt_eval_count === "number" || typeof payload.eval_count === "number") {
    const input = payload.prompt_eval_count ?? 0;
    const output = payload.eval_count ?? 0;
    return normalizeUsageSummary(input, output, 0, 0, input + output);
  }

  return undefined;
}

function extractOpenAIResponseText(payload: OpenAIResponsesResponse | OpenAIChatResponse): string {
  if ("output_text" in payload && typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if ("output" in payload && Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) {
        continue;
      }

      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
          return part.text.trim();
        }
      }
    }
  }

  if ("choices" in payload) {
    return payload.choices?.[0]?.message?.content?.trim() ?? "";
  }

  return "";
}

/**
 * 로컬 LLM에게 직접 복잡도를 판단하도록 요청한다.
 *
 * - Ollama (`/api/chat`), OpenAI Responses (`/responses`), OpenAI 호환 API (`/chat/completions`) 지원
 * - 타임아웃과 에러 처리 포함
 * - 실패 시 규칙 기반 평가로 fallback
 */
export async function evaluateComplexityWithLLM(
  message: string,
  baseUrl: string,
  model: string,
  context?: EvaluationContext,
  remoteThreshold: ComplexityLevel = "moderate",
  timeoutMs = 10_000,
  apiType: LocalApiType = "openai",
  apiKey?: string,
  onTrace?: (trace: EvaluationTrace) => void,
): Promise<RoutingDecision> {
  const startedAt = Date.now();
  const emitTrace = (trace: Omit<EvaluationTrace, "durationMs" | "messageChars" | "turnCount" | "hasToolUse" | "threshold">) => {
    onTrace?.({
      durationMs: Date.now() - startedAt,
      messageChars: message.length,
      turnCount: context?.turnCount,
      hasToolUse: context?.hasToolUse,
      threshold: remoteThreshold,
      ...trace,
    });
  };

  // 빈 메시지는 규칙 기반으로 바로 처리
  if (!message.trim()) {
    const decision = evaluateComplexity(message, context, remoteThreshold);
    emitTrace({
      mode: "rule",
      apiType: "rule",
      finalTarget: decision.target,
      classifierLevel: decision.level,
      classifierReason: decision.reason,
      fallbackToRule: false,
    });
    return decision;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);

    // API 타입에 따라 엔드포인트와 요청 포맷 분기
    const isOllama = apiType === "ollama";
    const isResponsesApi = apiType === "openai-responses";
    const url = isOllama
      ? `${baseUrl}/api/chat`
      : isResponsesApi
        ? `${baseUrl.replace(/\/+$/, "")}/responses`
        : `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const body = isOllama
      ? {
          model,
          messages: [
            { role: "system", content: LLM_CLASSIFIER_PROMPT },
            { role: "user", content: message },
          ],
          stream: false,
          options: { temperature: 0, num_predict: 128 },
        }
      : isResponsesApi
        ? {
            model,
            input: [
              {
                type: "message",
                role: "system",
                content: LLM_CLASSIFIER_PROMPT,
              },
              {
                type: "message",
                role: "user",
                content: message,
              },
            ],
            max_output_tokens: 128,
            temperature: 0,
            text: {
              format: {
                type: "json_schema",
                name: "complexity_classification",
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    level: {
                      type: "string",
                      enum: ["simple", "moderate", "complex", "advanced"],
                    },
                    reason: { type: "string" },
                  },
                  required: ["level", "reason"],
                },
              },
            },
          }
      : {
          model,
          messages: [
            { role: "system", content: LLM_CLASSIFIER_PROMPT },
            { role: "user", content: message },
          ],
          stream: false,
          temperature: 0,
          max_tokens: 128,
        };

      const promptChars = LLM_CLASSIFIER_PROMPT.length + message.length;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...((apiType === "openai" || apiType === "openai-responses") && apiKey
          ? { Authorization: `Bearer ${apiKey}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[smart-router] LLM 평가 실패 (HTTP ${response.status}), 규칙 기반으로 fallback`);
      const fallbackDecision = evaluateComplexity(message, context, remoteThreshold);
      emitTrace({
        mode: "llm",
        apiType,
        model,
        baseUrl,
        endpoint: url,
        promptChars,
        httpStatus: response.status,
        finalTarget: fallbackDecision.target,
        classifierLevel: fallbackDecision.level,
        classifierReason: fallbackDecision.reason,
        fallbackToRule: true,
        error: `HTTP ${response.status}`,
      });
      return fallbackDecision;
    }

    const data = (await response.json()) as OllamaChatResponse & OpenAIChatResponse & OpenAIResponsesResponse;
    const usage = extractEvaluationUsage(data);
    const content = isOllama
      ? (data.message?.content?.trim() ?? "")
      : extractOpenAIResponseText(data);

    // JSON 파싱 — LLM이 markdown 코드 블록으로 감쌀 수 있으므로 정리
    const jsonStr = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(jsonStr) as { level?: string; reason?: string };

    const validLevels: ComplexityLevel[] = ["simple", "moderate", "complex", "advanced"];
    const level = validLevels.includes(parsed.level as ComplexityLevel)
      ? (parsed.level as ComplexityLevel)
      : null;

    if (!level) {
      console.warn(`[smart-router] LLM 응답 파싱 실패 ("${content}"), 규칙 기반으로 fallback`);
      const fallbackDecision = evaluateComplexity(message, context, remoteThreshold);
      emitTrace({
        mode: "llm",
        apiType,
        model,
        baseUrl,
        endpoint: url,
        promptChars,
        usage,
        httpStatus: response.status,
        finalTarget: fallbackDecision.target,
        classifierLevel: fallbackDecision.level,
        classifierReason: fallbackDecision.reason,
        fallbackToRule: true,
        error: `invalid level: ${content}`,
      });
      return fallbackDecision;
    }

    const reason = parsed.reason ?? level;

    // 규칙 기반 점수도 참고용으로 계산 (로그에 사용)
    const ruleDecision = evaluateComplexity(message, context, remoteThreshold);

    const target = routeTargetFromLevel(level, remoteThreshold);

    const decision = {
      level,
      score: ruleDecision.score, // 참고용 규칙 점수 유지
      target,
      reason: `[LLM] ${reason}`,
    };

    emitTrace({
      mode: "llm",
      apiType,
      model,
      baseUrl,
      endpoint: url,
      promptChars,
      usage,
      httpStatus: response.status,
      classifierLevel: level,
      classifierReason: reason,
      finalTarget: target,
      fallbackToRule: false,
    });

    return decision;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const fallbackDecision = evaluateComplexity(message, context, remoteThreshold);
    if (errMsg.includes("abort")) {
      console.warn(`[smart-router] LLM 평가 타임아웃 (${timeoutMs}ms), 규칙 기반으로 fallback`);
    } else {
      console.warn(`[smart-router] LLM 평가 에러: ${errMsg}, 규칙 기반으로 fallback`);
    }
    emitTrace({
      mode: "llm",
      apiType,
      model,
      baseUrl,
      endpoint: apiType === "ollama"
        ? `${baseUrl}/api/chat`
        : apiType === "openai-responses"
          ? `${baseUrl.replace(/\/+$/, "")}/responses`
          : `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      promptChars: LLM_CLASSIFIER_PROMPT.length + message.length,
      finalTarget: fallbackDecision.target,
      classifierLevel: fallbackDecision.level,
      classifierReason: fallbackDecision.reason,
      fallbackToRule: true,
      error: errMsg,
    });
    return fallbackDecision;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 라우팅 결정을 요약 문자열로 변환.
 */
export function formatRoutingDecision(decision: RoutingDecision): string {
  const targetLabel = {
    local: "🏠 로컬 LLM",
    nano: "☁️ OpenAI Nano",
    mini: "☁️ OpenAI Mini",
    full: "☁️ OpenAI Full",
  }[decision.target];
  const { total, breakdown } = decision.score;
  return [
    `복잡도: ${formatComplexityLevel(decision.level)} (점수: ${total}/17)`,
    `라우팅: ${targetLabel}`,
    `근거: ${decision.reason}`,
    `세부: 길이=${breakdown.length} 코드=${breakdown.code} 도구=${breakdown.tools} 깊이=${breakdown.depth} 키워드=${breakdown.keywords}`,
  ].join("\n");
}
