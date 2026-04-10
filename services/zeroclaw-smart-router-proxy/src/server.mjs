import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { decideRoute } from "./routing.mjs";

const config = {
  host: process.env.SMART_ROUTER_HOST || "127.0.0.1",
  port: Number(process.env.SMART_ROUTER_PORT || 4310),
  localBaseUrl: process.env.SMART_ROUTER_LOCAL_BASE_URL || "http://127.0.0.1:1242/v1",
  localModel: process.env.SMART_ROUTER_LOCAL_MODEL || "LiquidAI/LFM2-24B-A2B-GGUF:Q4_0",
  localApiKey: process.env.SMART_ROUTER_LOCAL_API_KEY || "",
  remoteBaseUrl: process.env.SMART_ROUTER_REMOTE_BASE_URL || "https://api.openai.com/v1",
  remoteApiKey: process.env.SMART_ROUTER_REMOTE_API_KEY || process.env.OPENAI_API_KEY || "",
  nanoModel: process.env.SMART_ROUTER_NANO_MODEL || "gpt-5.4-nano-2026-03-17",
  miniModel: process.env.SMART_ROUTER_MINI_MODEL || "gpt-5.4-mini-2026-03-17",
  fullModel: process.env.SMART_ROUTER_FULL_MODEL || "gpt-5.4-2026-03-05"
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, service: "zeroclaw-smart-router-proxy" });
    }

    if (req.method === "POST" && req.url === "/route") {
      const body = await readJson(req);
      return json(res, 200, buildRoutePayload(body));
    }

    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
      const body = await readJson(req);
      let route = buildRoutePayload(body);
      const isStreaming = body?.stream === true;

      // local fallback: if local tier but llama.cpp is unreachable, demote to mini
      let upstreamResponse;
      let fallbackApplied = false;
      if (route.tier === "local") {
        try {
          upstreamResponse = await proxyChatCompletion(body, route, req);
          // treat non-2xx from local as connection failure only if it's a network error
          if (!upstreamResponse.ok && upstreamResponse.status >= 500) {
            throw new Error(`local upstream ${upstreamResponse.status}`);
          }
        } catch {
          // local unreachable — fall through to mini
          const miniRoute = {
            tier: "mini",
            level: "moderate",
            reason: "local unavailable - fallback to mini",
            score: route.score,
            resolvedModel: config.miniModel,
            baseUrl: config.remoteBaseUrl
          };
          route = miniRoute;
          fallbackApplied = true;
          upstreamResponse = await proxyChatCompletion(body, route, req);
        }
      } else {
        upstreamResponse = await proxyChatCompletion(body, route, req);
      }

      const routeHeaders = {
        "x-smart-router-tier": route.tier,
        "x-smart-router-level": route.level,
        "x-smart-router-reason": route.reason,
        "cache-control": "no-store",
        ...(fallbackApplied ? { "x-smart-router-fallback": "local->mini" } : {})
      };

      if (isStreaming && upstreamResponse.body) {
        // SSE pass-through: stream upstream chunks directly to the client
        res.writeHead(upstreamResponse.status, {
          "content-type": "text/event-stream; charset=utf-8",
          "transfer-encoding": "chunked",
          connection: "keep-alive",
          ...routeHeaders
        });
        logRoute(route, { fallbackApplied, upstreamStatus: upstreamResponse.status });
        const reader = upstreamResponse.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
          res.end();
        }
        return;
      }

      // Non-streaming: buffer and forward
      const responseBody = await upstreamResponse.arrayBuffer();
      res.writeHead(upstreamResponse.status, {
        "content-type": upstreamResponse.headers.get("content-type") || "application/json",
        ...routeHeaders
      });
      logRoute(route, { fallbackApplied, upstreamStatus: upstreamResponse.status });
      res.end(Buffer.from(responseBody));
      return;
    }

    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: "proxy_error", message: String(error) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`smart-router proxy listening on http://${config.host}:${config.port}`);
});

function buildRoutePayload(body) {
  const decision = decideRoute({ model: body?.model, messages: body?.messages || [] });
  const resolvedModel = resolveModel(decision.tier);
  const baseUrl = decision.tier === "local" ? config.localBaseUrl : config.remoteBaseUrl;
  return {
    ...decision,
    resolvedModel,
    baseUrl
  };
}

function resolveModel(tier) {
  switch (tier) {
    case "local":
      return config.localModel;
    case "nano":
      return config.nanoModel;
    case "mini":
      return config.miniModel;
    case "full":
      return config.fullModel;
    default:
      return config.miniModel;
  }
}

async function proxyChatCompletion(body, route, req) {
  const payload = {
    ...body,
    model: route.resolvedModel
  };

  const headers = {
    "content-type": "application/json"
  };

  const authHeader = resolveAuthorization(route.tier, req.headers.authorization);
  if (authHeader) {
    headers.authorization = authHeader;
  }

  return fetch(buildChatCompletionsUrl(route.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
}

function resolveAuthorization(tier, incomingAuthorization) {
  if (tier === "local") {
    return config.localApiKey ? `Bearer ${config.localApiKey}` : undefined;
  }
  if (config.remoteApiKey) {
    return `Bearer ${config.remoteApiKey}`;
  }
  if (typeof incomingAuthorization === "string" && incomingAuthorization.trim()) {
    return incomingAuthorization;
  }
  return undefined;
}

function buildChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

// ── Route logging ──────────────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), ".zeroclaw", "logs");

function logRoute(route, { fallbackApplied, upstreamStatus }) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const logPath = path.join(LOG_DIR, `smart-router-${localDate}.jsonl`);
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      tier: route.tier,
      level: route.level,
      score: route.score,
      reason: route.reason,
      model: route.resolvedModel,
      fallback: fallbackApplied ? "local->mini" : null,
      status: upstreamStatus
    });
    fs.appendFileSync(logPath, entry + "\n", "utf8");
  } catch {
    // log failures are non-fatal
  }
}