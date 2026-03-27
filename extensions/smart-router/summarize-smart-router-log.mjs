#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveLogFilePath(argumentPath) {
  if (argumentPath) {
    return path.resolve(argumentPath);
  }

  const logDir = path.join(os.homedir(), ".openclaw", "logs");
  const latestFile = fs
    .readdirSync(logDir)
    .filter((name) => /^smart-router-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .at(-1);

  if (!latestFile) {
    throw new Error("No smart-router log file found");
  }

  return path.join(logDir, latestFile);
}

function toArray(fileContent) {
  return fileContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function summarize(records) {
  const summary = {
    totalEvents: records.length,
    eventCounts: {},
    routeTiers: {},
    usageByTier: {},
    evaluationUsageTotal: { input: 0, output: 0, cacheRead: 0, totalTokens: 0 },
    responseUsageTotal: { input: 0, output: 0, cacheRead: 0, totalTokens: 0 },
    toolExposure: { applied: 0, skipped: 0, originalTools: 0, retainedTools: 0 },
    fallbackCount: 0,
    rootTurnCount: 0,
    averageRequestsPerTurn: 0,
    toolCallTurnCount: 0,
    usageSourceCounts: {},
    routeAdjustments: {},
    localHealthSeen: 0,
  };

  const rootTurns = new Map();
  const turnsWithToolCalls = new Set();

  for (const record of records) {
    increment(summary.eventCounts, record.event);

    if (record.rootTurnId) {
      rootTurns.set(record.rootTurnId, (rootTurns.get(record.rootTurnId) ?? 0) + 1);
    }

    if (record.routeTier) {
      increment(summary.routeTiers, record.routeTier);
    }

    if (record.toolExposureApplied === true) {
      summary.toolExposure.applied += 1;
    } else if (record.toolExposureApplied === false) {
      summary.toolExposure.skipped += 1;
    }

    summary.toolExposure.originalTools += Number(record.originalToolCount ?? 0);
    summary.toolExposure.retainedTools += Number(record.retainedToolCount ?? 0);

    if (record.routeAdjustmentReason) {
      increment(summary.routeAdjustments, record.routeAdjustmentReason);
    }

    if (record.localHealth) {
      summary.localHealthSeen += 1;
    }

    if (record.event === "evaluation") {
      const usage = record.evaluationUsage ?? record.evaluation?.usage;
      if (usage) {
        summary.evaluationUsageTotal.input += Number(usage.input ?? 0);
        summary.evaluationUsageTotal.output += Number(usage.output ?? 0);
        summary.evaluationUsageTotal.cacheRead += Number(usage.cacheRead ?? 0);
        summary.evaluationUsageTotal.totalTokens += Number(usage.totalTokens ?? 0);
      }
      if (record.evaluationFallbackToRule || record.evaluation?.fallbackToRule) {
        summary.fallbackCount += 1;
      }
    }

    if (record.event === "response" || record.event === "response_error") {
      const tier = record.routeTier ?? "unknown";
      if (!summary.usageByTier[tier]) {
        summary.usageByTier[tier] = {
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          totalTokens: 0,
          durationMs: 0,
        };
      }

      const usage = record.usage ?? {};
      summary.usageByTier[tier].requests += 1;
      summary.usageByTier[tier].input += Number(usage.input ?? 0);
      summary.usageByTier[tier].output += Number(usage.output ?? 0);
      summary.usageByTier[tier].cacheRead += Number(usage.cacheRead ?? 0);
      summary.usageByTier[tier].totalTokens += Number(usage.totalTokens ?? 0);
      summary.usageByTier[tier].durationMs += Number(record.durationMs ?? 0);

      summary.responseUsageTotal.input += Number(usage.input ?? 0);
      summary.responseUsageTotal.output += Number(usage.output ?? 0);
      summary.responseUsageTotal.cacheRead += Number(usage.cacheRead ?? 0);
      summary.responseUsageTotal.totalTokens += Number(usage.totalTokens ?? 0);

      if (record.usageSource) {
        increment(summary.usageSourceCounts, record.usageSource);
      }

      if (Number(record.responseSummary?.toolCallCount ?? 0) > 0 && record.rootTurnId) {
        turnsWithToolCalls.add(record.rootTurnId);
      }
    }
  }

  summary.rootTurnCount = rootTurns.size;
  summary.averageRequestsPerTurn = rootTurns.size === 0
    ? 0
    : Number((records.length / rootTurns.size).toFixed(2));
  summary.toolCallTurnCount = turnsWithToolCalls.size;

  return summary;
}

const filePath = resolveLogFilePath(process.argv[2]);
const records = toArray(fs.readFileSync(filePath, "utf8"));

console.log(JSON.stringify({ filePath, summary: summarize(records) }, null, 2));