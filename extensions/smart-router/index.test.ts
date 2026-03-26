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
});