import { describe, expect, it } from "vitest";
import smartRouter, { __testing } from "./index.js";

describe("smart-router stream label injection", () => {
  it("prepends the current label and strips stale labels from response text", () => {
    const label = __testing.buildModelLabel(
      {
        tier: "mini",
        provider: "openai",
        model: "gpt-5.4-mini-2026-03-17",
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        contextWindow: 128000,
        maxTokens: 16384,
        label: "mini:gpt-5.4-mini-2026-03-17",
      },
      "complex",
    );

    expect(
      __testing.prependModelLabel(
        "[smart-router nano/moderate] gpt-5.4-nano-2026-03-17\n\n기존 라벨이 섞인 응답",
        label,
      ),
    ).toBe(`${label}기존 라벨이 섞인 응답`);
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
});