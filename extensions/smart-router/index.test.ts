import { describe, expect, it } from "vitest";
import smartRouter, { __testing } from "./index.js";

describe("smart-router route metadata", () => {
  it("attaches structured route metadata and aliases the visible model to the route tier", () => {
    const message = __testing.attachRouteMeta(
      {
        role: "assistant",
        model: "gpt-5.4-mini-2026-03-17",
        content: [{ type: "text", text: "응답 본문" }],
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