import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createSmartRouterLogger } from "./smart-router-log.js";

type TempDirState = {
  path: string;
};

const tempDirs: TempDirState[] = [];

async function createTempLogPath(): Promise<string> {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "smart-router-log-"));
  tempDirs.push({ path: dirPath });
  return path.join(dirPath, "smart-router.jsonl");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) break;
    await rm(tempDir.path, { recursive: true, force: true });
  }
});

describe("smart-router execution logger", () => {
  it("records route, payload, and response events as jsonl", async () => {
    const filePath = await createTempLogPath();
    const logger = createSmartRouterLogger({
      enabled: true,
      filePath,
      includePayloadBody: true,
      maxTextChars: 80,
    });

    const requestLogger = logger.createRequest({
      requestedModelId: "auto",
      routeMode: "auto",
      evaluationMode: "llm",
      threshold: "moderate",
      routeTier: "mini",
      routeProvider: "openai",
      routeModel: "gpt-5.4-mini-2026-03-17",
      routeApi: "openai-responses",
      routeLabel: "mini:gpt-5.4-mini-2026-03-17",
      thinkingLevel: "low",
      workspaceDir: "/workspace/demo",
      agentDir: "/agent/demo",
      context: {
        systemPrompt: "test system prompt",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello router" }] },
          { role: "toolResult", toolName: "searchWeb", content: [{ type: "text", text: "ok" }] },
        ],
      },
      extraParams: { temperature: 0.2, strategy: { kind: "auto" } },
      streamOptions: { temperature: 0.1, maxTokens: 2048, sessionId: "sess-1" },
      decision: {
        level: "moderate",
        reason: "일반 설명 요청",
        scoreTotal: 4,
        scoreBreakdown: { length: 1, code: 0, tools: 1, depth: 1, keywords: 1 },
      },
    });

    requestLogger.logRoute();

    const wrappedOptions = requestLogger.wrapOptions({
      onPayload: async () => ({
        model: "gpt-5.4-mini-2026-03-17",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello router" }] }],
        tools: [{ type: "function", name: "searchWeb" }],
        reasoning: { effort: "low" },
        authorization: "secret-token",
      }),
    }) as {
      onPayload?: (payload: unknown, model: { provider: string; api: string; id: string }) => Promise<unknown>;
    };

    await wrappedOptions.onPayload?.(
      { input: [{ role: "user", content: [{ type: "input_text", text: "original" }] }] },
      {
        provider: "openai",
        api: "openai-responses",
        id: "gpt-5.4-mini-2026-03-17",
      },
    );

    requestLogger.logResponse({
      kind: "response",
      eventCounts: { start: 1, text_delta: 2, done: 1 },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello back from router" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4-mini-2026-03-17",
        usage: {
          input: 123,
          output: 45,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 168,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.003,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });

    await logger.flush();

    const today = new Date().toISOString().slice(0, 10);
    const datedLogPath = filePath.replace(/\.jsonl$/u, `-${today}.jsonl`);

    const lines = (await readFile(datedLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.event)).toEqual(["route", "payload", "response"]);
    expect(lines[0]?.routeTier).toBe("mini");
    expect(lines[0]?.decision).toMatchObject({ level: "moderate", scoreTotal: 4 });
    expect(lines[1]?.payloadSummary).toMatchObject({ toolCount: 1 });
    expect(lines[1]?.payload).toMatchObject({ authorization: "<redacted>" });
    expect(lines[2]?.usage).toMatchObject({ totalTokens: 168 });
    expect(lines[2]?.responseSummary).toMatchObject({ textChars: 22, stopReason: "stop" });
  });

  it("prunes dated log files older than the configured retention window", async () => {
    const filePath = await createTempLogPath();
    const logger = createSmartRouterLogger({
      enabled: true,
      filePath,
      retentionDays: 2,
    });

    const baseDir = path.dirname(filePath);
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5);
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 1);

    const oldFilePath = path.join(baseDir, `smart-router-${oldDate.toISOString().slice(0, 10)}.jsonl`);
    const recentFilePath = path.join(baseDir, `smart-router-${recentDate.toISOString().slice(0, 10)}.jsonl`);
    await writeFile(oldFilePath, '{"event":"route"}\n', "utf8");
    await writeFile(recentFilePath, '{"event":"route"}\n', "utf8");

    logger.write({
      ts: new Date().toISOString(),
      event: "route",
      requestId: "req-1",
    });
    await logger.flush();

    await expect(readFile(oldFilePath, "utf8")).rejects.toThrow();
    await expect(readFile(recentFilePath, "utf8")).resolves.toContain('"event":"route"');
  });
});