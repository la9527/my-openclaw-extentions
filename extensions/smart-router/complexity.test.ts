import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateComplexity,
  evaluateComplexityWithLLM,
  type EvaluationTrace,
  formatComplexityLevel,
  formatRoutingDecision,
  routeTargetFromLevel,
  type EvaluationContext,
  type RoutingDecision,
} from "./complexity.js";

describe("routeTargetFromLevel", () => {
  it("기본 threshold=moderate 에서 local/mini/full 기본 매핑을 적용한다", () => {
    expect(routeTargetFromLevel("simple")).toBe("local");
    expect(routeTargetFromLevel("moderate")).toBe("mini");
    expect(routeTargetFromLevel("complex")).toBe("mini");
    expect(routeTargetFromLevel("advanced")).toBe("full");
  });

  it("threshold=complex 면 moderate 는 local 유지", () => {
    expect(routeTargetFromLevel("moderate", "complex")).toBe("local");
    expect(routeTargetFromLevel("complex", "complex")).toBe("mini");
  });

  it("threshold=advanced 면 advanced 만 full 로 보낸다", () => {
    expect(routeTargetFromLevel("complex", "advanced")).toBe("local");
    expect(routeTargetFromLevel("advanced", "advanced")).toBe("full");
  });
});

describe("evaluateComplexity", () => {
  it("짧은 인사는 simple/local", () => {
    const decision = evaluateComplexity("안녕하세요");
    expect(decision.level).toBe("simple");
    expect(decision.target).toBe("local");
  });

  it("중간 길이 설명 요청은 기본적으로 mini tier 로 간다", () => {
    const decision = evaluateComplexity("파이썬에 대해 단계별로 간단히 설명해줘".padEnd(260, " "));
    expect(decision.level).toBe("moderate");
    expect(decision.target).toBe("mini");
  });

  it("짧고 경량인 비교 요약 요청은 nano tier 로 보낸다", () => {
    const decision = evaluateComplexity(
      "Redis LRU와 LFU 차이를 한 문단으로 간단히 비교해줘. 각각 언제 쓰는지 핵심만 빠르게 정리해주고, 마지막에 한 줄 요약도 붙여줘."
        .padEnd(220, " "),
      { turnCount: 4 },
    );

    expect(decision.level).toBe("moderate");
    expect(decision.target).toBe("nano");
    expect(decision.reason).toContain("경량 remote 질의");
  });

  it("코드 리팩토링 요청은 mini tier 로 간다", () => {
    const message = [
      "이 코드를 리팩토링하고 구조를 개선해줘.",
      "```ts",
      "async function fetchData() {",
      "  const result = await fetch(url);",
      "  return result.json();",
      "}",
      "```",
      "API endpoint 구조와 성능도 같이 봐줘.",
    ].join("\n");

    const decision = evaluateComplexity(message);
    expect(decision.level).toBe("complex");
    expect(decision.target).toBe("mini");
  });

  it("긴 코드와 도구 맥락이 있으면 full tier 로 간다", () => {
    const code = "```typescript\n" + "const value = 1;\n".repeat(120) + "```";
    const context: EvaluationContext = { turnCount: 16, hasToolUse: true };
    const decision = evaluateComplexity(
      `${code}\n이 아키텍처를 분석하고 보안, 성능, 마이그레이션 전략까지 설계해줘.`,
      context,
    );

    expect(decision.level).toBe("advanced");
    expect(decision.target).toBe("full");
  });

  it("운영 정책과 KPI/경보/폴백 설계 요청은 full tier 로 승격한다", () => {
    const message = [
      "smart-router 운영 정책을 다시 설계해줘.",
      "local, nano, mini, full 기준을 표로 정리하고 KPI와 경보 조건을 포함해줘.",
      "fallback policy, rollout 순서, 검증 계획, trade-off까지 함께 설명해줘.",
    ].join(" ");

    const decision = evaluateComplexity(message, { turnCount: 9, hasToolUse: true });

    expect(decision.level).toBe("advanced");
    expect(decision.target).toBe("full");
    expect(decision.reason).toContain("고급 설계/운영 신호");
  });

  it("짧지만 명시적인 advanced 운영 설계 프롬프트도 full tier 로 승격한다", () => {
    const message = "large-scale 운영을 가정하고 smart-router full 승격 기준을 재설계해줘. threat model, capacity planning, KPI, runbook, end-to-end validation을 포함해줘.";

    const decision = evaluateComplexity(message);

    expect(decision.level).toBe("advanced");
    expect(decision.target).toBe("full");
  });

  it("단일 주제의 운영 분석 요청은 advanced 로 과승격되지 않는다", () => {
    const decision = evaluateComplexity(
      "사용자 요청 난이도 분류에서 false positive를 줄이는 기준과 threshold 조정 방법을 단계별로 설명해줘."
        .padEnd(260, " "),
    );

    expect(decision.level).toBe("moderate");
    expect(decision.target).toBe("mini");
  });

  it("score breakdown 을 계산한다", () => {
    const decision = evaluateComplexity("REST API endpoint 를 만들어서 database query 최적화해줘", {
      hasToolUse: true,
      turnCount: 7,
    });

    expect(decision.score.breakdown.tools).toBeGreaterThanOrEqual(2);
    expect(decision.score.breakdown.depth).toBe(2);
    expect(decision.score.total).toBeGreaterThan(0);
  });

  it("threshold=complex 면 moderate 는 local 유지", () => {
    const decision = evaluateComplexity("파이썬에 대해 단계별로 간단히 설명해줘".padEnd(260, " "), undefined, "complex");
    expect(decision.level).toBe("moderate");
    expect(decision.target).toBe("local");
  });

  it("threshold=simple 이어도 짧은 인사는 local 로 고정한다", () => {
    const decision = evaluateComplexity("안녕", { turnCount: 12 }, "simple");
    expect(decision.level).toBe("simple");
    expect(decision.target).toBe("local");
  });
});

describe("evaluateComplexityWithLLM", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("빈 메시지는 fetch 없이 규칙 기반으로 처리한다", async () => {
    const decision = await evaluateComplexityWithLLM("", "http://localhost:1235/v1", "test-model");
    expect(decision.target).toBe("local");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("OpenAI Responses 응답을 파싱해 mini tier 를 반환한다", async () => {
    const traces: EvaluationTrace[] = [];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output_text: '{"level":"complex","reason":"코드 리팩토링 요청"}',
          usage: {
            input_tokens: 31,
            output_tokens: 9,
            total_tokens: 40,
            input_tokens_details: {
              cached_tokens: 7,
            },
          },
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "이 코드를 리팩토링해줘",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "moderate",
      5000,
      "openai-responses",
      undefined,
      (trace) => traces.push(trace),
    );

    expect(decision.level).toBe("complex");
    expect(decision.target).toBe("mini");
    expect(decision.reason).toContain("[LLM]");
    expect(traces[0]).toMatchObject({
      mode: "llm",
      apiType: "openai-responses",
      finalTarget: "mini",
      fallbackToRule: false,
      usage: { input: 31, output: 9, cacheRead: 7, totalTokens: 40 },
    });
  });

  it("threshold=moderate 에서 일반 moderate 분류는 mini tier 로 간다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"level":"moderate","reason":"일반 질문"}' }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "파이썬 설명해줘",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "moderate",
      5000,
      "openai-responses",
    );

    expect(decision.target).toBe("mini");
  });

  it("경량 비교 요약 요청은 moderate 분류여도 nano tier 로 유지한다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"level":"moderate","reason":"짧은 비교 요약 요청"}' }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "Redis LRU와 LFU 차이를 한 문단으로 간단히 비교해줘. 핵심만 빠르게 정리해줘.",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      { turnCount: 4 },
      "moderate",
      5000,
      "openai-responses",
    );

    expect(decision.target).toBe("nano");
  });

  it("threshold=complex 에서 moderate 분류는 local 유지", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"level":"moderate","reason":"일반 질문"}' } }],
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "파이썬 설명해줘",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "complex",
      5000,
      "openai",
    );

    expect(decision.target).toBe("local");
  });

  it("p95 + error rate 판단 기준 요청은 advanced 응답이어도 mini 로 보정한다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"level":"advanced","reason":"운영 지표 판단 기준 설계"}' }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "latency p95와 error rate를 함께 보는 판단 기준을 제안해줘.",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "moderate",
      5000,
      "openai-responses",
    );

    expect(decision.level).toBe("complex");
    expect(decision.target).toBe("mini");
  });

  it("alert-only 운영 요청은 advanced 응답이어도 complex/mini 로 보정한다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"level":"advanced","reason":"경보 정책 설계"}' }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "smart-router 일일 리포트에서 바로 경보로 연결할 조건 3개만 정리해줘.",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "moderate",
      5000,
      "openai-responses",
    );

    expect(decision.level).toBe("complex");
    expect(decision.target).toBe("mini");
  });

  it("짧은 기술 설명 요청은 moderate 응답이어도 local 로 보정한다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"level":"moderate","reason":"기술 용어 설명"}' }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "nano 모델이 어떤 역할인지 짧게 말해줘.",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "moderate",
      5000,
      "openai-responses",
    );

    expect(decision.level).toBe("simple");
    expect(decision.target).toBe("local");
  });

  it("OpenAI chat completions usage 도 trace 에 남긴다", async () => {
    const traces: EvaluationTrace[] = [];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"level":"moderate","reason":"일반 질문"}' } }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 6,
            total_tokens: 26,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        }),
        { status: 200 },
      ),
    );

    await evaluateComplexityWithLLM(
      "일반 질문이야",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "moderate",
      5000,
      "openai",
      undefined,
      (trace) => traces.push(trace),
    );

    expect(traces[0]?.usage).toMatchObject({ input: 20, output: 6, cacheRead: 4, totalTokens: 26 });
  });

  it("Ollama 응답 포맷도 지원한다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { content: '{"level":"advanced","reason":"깊은 시스템 설계"}' },
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "전체 마이크로서비스 아키텍처를 설계해줘",
      "http://localhost:11434",
      "qwen3:8b",
      undefined,
      "moderate",
      5000,
      "ollama",
    );

    expect(decision.target).toBe("full");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("http://localhost:11434/api/chat");
  });

  it("Ollama usage 카운트도 trace 에 남긴다", async () => {
    const traces: EvaluationTrace[] = [];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { content: '{"level":"simple","reason":"짧은 요청"}' },
          prompt_eval_count: 18,
          eval_count: 5,
        }),
        { status: 200 },
      ),
    );

    await evaluateComplexityWithLLM(
      "짧은 요청",
      "http://localhost:11434",
      "qwen3:8b",
      undefined,
      "moderate",
      5000,
      "ollama",
      undefined,
      (trace) => traces.push(trace),
    );

    expect(traces[0]?.usage).toMatchObject({ input: 18, output: 5, totalTokens: 23 });
  });

  it("잘못된 JSON 응답이면 규칙 기반으로 fallback 한다", async () => {
    const traces: EvaluationTrace[] = [];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "invalid-json" } }],
        }),
        { status: 200 },
      ),
    );

    const decision = await evaluateComplexityWithLLM(
      "테스트 메시지",
      "http://localhost:1235/v1",
      "test-model",
      undefined,
      "moderate",
      5000,
      "openai",
      undefined,
      (trace) => traces.push(trace),
    );

    expect(decision).toEqual(evaluateComplexity("테스트 메시지", undefined, "moderate"));
    expect(traces[0]?.fallbackToRule).toBe(true);
    expect(traces[0]?.error).toContain("invalid-json");
  });

  it("HTTP 에러면 규칙 기반으로 fallback 한다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("failure", { status: 500 }));

    const decision = await evaluateComplexityWithLLM(
      "안녕하세요",
      "http://localhost:1235/v1",
      "test-model",
      undefined,
      "moderate",
      5000,
      "openai",
    );

    expect(decision).toEqual(evaluateComplexity("안녕하세요", undefined, "moderate"));
  });

  it("LLM 타임아웃이면 고급 신호를 보존한 fallback 을 사용한다", async () => {
    const traces: EvaluationTrace[] = [];
    vi.mocked(fetch).mockRejectedValueOnce(new Error("abort"));

    const message = "smart-router rollout 순서와 runbook만 짧게 정리해줘.";
    const decision = await evaluateComplexityWithLLM(
      message,
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "moderate",
      1,
      "openai-responses",
      undefined,
      (trace) => traces.push(trace),
    );

    expect(decision.level).toBe("advanced");
    expect(decision.target).toBe("full");
    expect(decision.reason).toContain("타임아웃 fallback 보정");
    expect(traces[0]?.fallbackToRule).toBe(true);
    expect(traces[0]?.finalTarget).toBe("full");
  });

  it("OpenAI 요청 body 는 고정 파라미터를 포함한다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output_text: '{"level":"simple","reason":"인사"}',
        }),
        { status: 200 },
      ),
    );

    await evaluateComplexityWithLLM(
      "안녕",
      "http://localhost:1235/v1",
      "gpt-5.4-nano-2026-03-17",
      undefined,
      "moderate",
      5000,
      "openai-responses",
    );

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("http://localhost:1235/v1/responses");
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("gpt-5.4-nano-2026-03-17");
    expect(body.temperature).toBe(0);
    expect(body.max_output_tokens).toBe(128);
    expect(body.input).toHaveLength(2);
    expect(body.text.format.type).toBe("json_schema");
  });
});

describe("format helpers", () => {
  it.each([
    ["simple", "단순 (Simple)"],
    ["moderate", "보통 (Moderate)"],
    ["complex", "복잡 (Complex)"],
    ["advanced", "고급 (Advanced)"],
  ] as const)("formatComplexityLevel(%s)", (level, expected) => {
    expect(formatComplexityLevel(level)).toBe(expected);
  });

  it("formatRoutingDecision 에 tier 라벨을 포함한다", () => {
    const decision: RoutingDecision = {
      level: "complex",
      score: {
        total: 9,
        breakdown: { length: 1, code: 3, tools: 2, depth: 1, keywords: 2 },
      },
      target: "full",
      reason: "코드 분석 필요, 도구 사용 감지",
    };

    const formatted = formatRoutingDecision(decision);
    expect(formatted).toContain("복잡 (Complex)");
    expect(formatted).toContain("OpenAI Full");
    expect(formatted).toContain("점수: 9/17");
  });
});
