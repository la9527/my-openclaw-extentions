import { spawn as spawnProcess } from "child_process";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

export const PHOTOS_CLASSIFY_ROUTE_BASE = "/plugins/photos-classify";

const BLOCKED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

type ReviewRouteKind = "root" | "review" | "api" | "artifacts" | null;

type RequestLike = {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
};

type ResponseLike = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string | Uint8Array) => void;
};

type ReviewAppAutoStart = {
  enabled: boolean;
  cwd: string;
  command?: string;
  args?: string[];
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  spawn?: typeof spawnProcess;
  sleep?: (ms: number) => Promise<void>;
};

type ReviewTailscaleAccess = {
  enabled: boolean;
  allowedUserLogins: string[];
};

export type ReviewJobProgress = {
  total: number;
  completed: number;
  stage: string;
  current_file: string;
  percent: number;
  errors: string[];
};

export type ReviewJobSummary = {
  job_id: string;
  source: string;
  source_path: string;
  request_options?: Record<string, unknown>;
  status: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  progress: ReviewJobProgress;
  result_summary?: Record<string, unknown> | null;
  error_message?: string | null;
  photo_count: number;
  selected_count: number;
  preview_path?: string;
};

const DEFAULT_REVIEW_APP_COMMAND = "uv";
const DEFAULT_REVIEW_APP_ARGS = ["run", "python", "review_app.py"];
const DEFAULT_REVIEW_APP_START_TIMEOUT_MS = 5000;
const DEFAULT_REVIEW_APP_POLL_INTERVAL_MS = 200;
const reviewAppStartPromises = new Map<string, Promise<boolean>>();

export function createPhotosReviewHttpHandler(params: {
  reviewBaseUrl: string;
  reviewAccessToken?: string;
  reviewAppAutoStart?: ReviewAppAutoStart;
  reviewTailscaleAccess?: ReviewTailscaleAccess;
  logger?: PluginLogger;
}) {
  return async (req: RequestLike, res: ResponseLike): Promise<boolean> => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed) {
      return false;
    }

    const routeKind = classifyRoute(parsed.pathname);
    if (!routeKind) {
      return false;
    }

    const access = resolveRouteAccess(req, parsed, params.reviewAccessToken, params.reviewTailscaleAccess);
    if (!access.allowed) {
      respondHtml(
        res,
        access.statusCode,
        buildLocalOnlyHtml({
          title: access.statusCode === 401 ? "Photos Review token required" : "Photos Review is local-only",
          message: access.message,
          reviewBaseUrl: params.reviewBaseUrl,
        }),
      );
      return true;
    }

    if (routeKind === "root") {
      respondHtml(
        res,
        200,
        buildPortalHtml({
          basePath: PHOTOS_CLASSIFY_ROUTE_BASE,
          authToken: access.token,
          accessLabel: access.accessLabel,
        }),
      );
      return true;
    }

    const upstream = resolveReviewProxyTarget(parsed, params.reviewBaseUrl, access.token);
    if (!upstream) {
      respondText(res, 404, "Not found");
      return true;
    }

    try {
      await proxyRequest(req, res, upstream);
      return true;
    } catch (error) {
      params.logger?.warn?.(`photos-classify: review proxy failed for ${upstream.toString()}: ${String(error)}`);
      const started = await ensureReviewAppRunning({
        reviewBaseUrl: params.reviewBaseUrl,
        autoStart: params.reviewAppAutoStart,
        logger: params.logger,
      });
      if (started) {
        try {
          await proxyRequest(req, res, upstream);
          return true;
        } catch (retryError) {
          params.logger?.warn?.(
            `photos-classify: review proxy retry failed for ${upstream.toString()}: ${String(retryError)}`,
          );
        }
      }
      if (routeKind === "review") {
        respondHtml(
          res,
          503,
          buildLocalOnlyHtml({
            title: "Review app is not running",
            message:
              started
                ? "review app 자동 기동을 시도했지만 연결하지 못했습니다. `photoRankerDir` 설정과 uv 환경을 확인하세요."
                : "photo-ranker review app에 연결하지 못했습니다. 먼저 `uv run python review_app.py`를 실행하거나 auto-start 설정을 확인하세요.",
            reviewBaseUrl: params.reviewBaseUrl,
          }),
        );
        return true;
      }
      respondText(res, 503, "Review app is not running");
      return true;
    }
  };
}

export async function fetchReviewJobSummary(params: {
  reviewBaseUrl: string;
  jobId: string;
  autoStart?: ReviewAppAutoStart;
  logger?: PluginLogger;
}): Promise<ReviewJobSummary | null> {
  const result = await fetchReviewJobData({
    reviewBaseUrl: params.reviewBaseUrl,
    path: `/api/jobs/${encodeURIComponent(params.jobId)}`,
    autoStart: params.autoStart,
    logger: params.logger,
  });
  return Array.isArray(result) ? null : result;
}

export async function fetchRecentReviewJobs(params: {
  reviewBaseUrl: string;
  limit?: number;
  status?: string;
  autoStart?: ReviewAppAutoStart;
  logger?: PluginLogger;
}): Promise<ReviewJobSummary[]> {
  const search = new URLSearchParams();
  if (params.limit) {
    search.set("limit", String(params.limit));
  }
  if (params.status) {
    search.set("status", params.status);
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  const result = await fetchReviewJobData({
    reviewBaseUrl: params.reviewBaseUrl,
    path: `/api/jobs${suffix}`,
    autoStart: params.autoStart,
    logger: params.logger,
  });
  return Array.isArray(result) ? result : [];
}

async function fetchReviewJobData(params: {
  reviewBaseUrl: string;
  path: string;
  autoStart?: ReviewAppAutoStart;
  logger?: PluginLogger;
}): Promise<ReviewJobSummary[] | ReviewJobSummary | null> {
  const ready = (await isReviewAppHealthy(params.reviewBaseUrl)) || (await ensureReviewAppRunning({
    reviewBaseUrl: params.reviewBaseUrl,
    autoStart: params.autoStart,
    logger: params.logger,
  }));
  if (!ready) {
    return null;
  }

  try {
    const response = await fetch(new URL(params.path, params.reviewBaseUrl));
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`review app returned ${response.status}`);
    }
    return (await response.json()) as ReviewJobSummary[] | ReviewJobSummary;
  } catch (error) {
    params.logger?.warn?.(
      `photos-classify: failed to fetch review job data from ${params.path}: ${String(error)}`,
    );
    return null;
  }
}

async function ensureReviewAppRunning(params: {
  reviewBaseUrl: string;
  autoStart?: ReviewAppAutoStart;
  logger?: PluginLogger;
}): Promise<boolean> {
  const autoStart = params.autoStart;
  if (!autoStart?.enabled || !autoStart.cwd.trim() || !isLocalReviewBaseUrl(params.reviewBaseUrl)) {
    return false;
  }

  const key = [params.reviewBaseUrl, autoStart.cwd, autoStart.command ?? DEFAULT_REVIEW_APP_COMMAND].join("\n");
  const existing = reviewAppStartPromises.get(key);
  if (existing) {
    return existing;
  }

  const pending = startAndWaitForReviewApp({
    reviewBaseUrl: params.reviewBaseUrl,
    autoStart,
    logger: params.logger,
  }).finally(() => {
    reviewAppStartPromises.delete(key);
  });
  reviewAppStartPromises.set(key, pending);
  return pending;
}

async function startAndWaitForReviewApp(params: {
  reviewBaseUrl: string;
  autoStart: ReviewAppAutoStart;
  logger?: PluginLogger;
}): Promise<boolean> {
  const command = params.autoStart.command ?? DEFAULT_REVIEW_APP_COMMAND;
  const args = params.autoStart.args ?? DEFAULT_REVIEW_APP_ARGS;
  const spawn = params.autoStart.spawn ?? spawnProcess;
  const sleep = params.autoStart.sleep ?? defaultSleep;

  try {
    const child = spawn(command, args, {
      cwd: params.autoStart.cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    params.logger?.info?.(
      `photos-classify: starting review app automatically with ${command} ${args.join(" ")} (cwd=${params.autoStart.cwd})`,
    );
  } catch (error) {
    params.logger?.warn?.(`photos-classify: failed to start review app automatically: ${String(error)}`);
    return false;
  }

  const deadline =
    Date.now() + (params.autoStart.startTimeoutMs ?? DEFAULT_REVIEW_APP_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await isReviewAppHealthy(params.reviewBaseUrl)) {
      return true;
    }
    await sleep(params.autoStart.pollIntervalMs ?? DEFAULT_REVIEW_APP_POLL_INTERVAL_MS);
  }
  return false;
}

async function isReviewAppHealthy(reviewBaseUrl: string): Promise<boolean> {
  try {
    const healthUrl = new URL("/health", reviewBaseUrl);
    const response = await fetch(healthUrl);
    return response.ok;
  } catch {
    return false;
  }
}

function isLocalReviewBaseUrl(reviewBaseUrl: string): boolean {
  try {
    const parsed = new URL(reviewBaseUrl);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveReviewProxyTarget(
  parsedUrl: URL,
  reviewBaseUrl: string,
  accessToken?: string,
): URL | null {
  const routeKind = classifyRoute(parsedUrl.pathname);
  if (!routeKind || routeKind === "root") {
    return null;
  }

  const upstream = new URL(parsedUrl.pathname.slice(PHOTOS_CLASSIFY_ROUTE_BASE.length), reviewBaseUrl);
  upstream.search = parsedUrl.search;
  if (routeKind === "review") {
    upstream.searchParams.set("base_path", PHOTOS_CLASSIFY_ROUTE_BASE);
    if (accessToken) {
      upstream.searchParams.set("auth_token", accessToken);
    }
  }
  return upstream;
}

function resolveRouteAccess(
  req: RequestLike,
  parsedUrl: URL,
  configuredToken?: string,
  tailscaleAccess?: ReviewTailscaleAccess,
):
  | { allowed: true; token: string; accessLabel: "local-only" | "token" | "tailscale" }
  | { allowed: false; statusCode: 401 | 403; message: string } {
  const requestToken = readAccessToken(req, parsedUrl);
  if (isLoopbackRequest(req)) {
    return { allowed: true, token: requestToken, accessLabel: "local-only" };
  }
  if (isTrustedTailscaleRequest(req, tailscaleAccess)) {
    return { allowed: true, token: requestToken, accessLabel: "tailscale" };
  }
  if (configuredToken && requestToken === configuredToken) {
    return { allowed: true, token: requestToken, accessLabel: "token" };
  }
  if (configuredToken) {
    return {
      allowed: false,
      statusCode: 401,
      message:
        "원격 접근은 token 이 필요합니다. `?token=...` query 또는 `x-photos-classify-token` 헤더로 접근하세요. Tailscale Serve를 쓴다면 `reviewAllowTailscale` 설정도 검토하세요.",
    };
  }
  return {
    allowed: false,
    statusCode: 403,
    message:
      "이 route는 현재 로컬 브라우저 전용입니다. 원격 접근이 필요하면 `reviewAccessToken` 또는 `reviewAllowTailscale` 설정을 추가하세요.",
  };
}

function isTrustedTailscaleRequest(
  req: RequestLike,
  tailscaleAccess?: ReviewTailscaleAccess,
): boolean {
  if (!tailscaleAccess?.enabled) {
    return false;
  }
  const remoteAddress = normalizeRemoteAddress(req.socket?.remoteAddress);
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1") {
    return false;
  }
  const login = readHeader(req, "tailscale-user-login");
  const name = readHeader(req, "tailscale-user-name");
  if (!login && !name) {
    return false;
  }
  if (tailscaleAccess.allowedUserLogins.length === 0) {
    return true;
  }
  return login ? tailscaleAccess.allowedUserLogins.includes(login.toLowerCase()) : false;
}

function readAccessToken(req: RequestLike, parsedUrl: URL): string {
  const queryToken = parsedUrl.searchParams.get("token")?.trim();
  if (queryToken) {
    return queryToken;
  }
  const headerToken = req.headers?.["x-photos-classify-token"];
  if (Array.isArray(headerToken)) {
    return headerToken[0]?.trim() ?? "";
  }
  return typeof headerToken === "string" ? headerToken.trim() : "";
}

function readHeader(req: RequestLike, name: string): string {
  const value = req.headers?.[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? "";
  }
  return typeof value === "string" ? value.trim() : "";
}

function classifyRoute(pathname: string): ReviewRouteKind {
  if (pathname === PHOTOS_CLASSIFY_ROUTE_BASE || pathname === `${PHOTOS_CLASSIFY_ROUTE_BASE}/`) {
    return "root";
  }
  if (pathname.startsWith(`${PHOTOS_CLASSIFY_ROUTE_BASE}/review/`)) {
    return "review";
  }
  if (pathname.startsWith(`${PHOTOS_CLASSIFY_ROUTE_BASE}/api/`)) {
    return "api";
  }
  if (pathname.startsWith(`${PHOTOS_CLASSIFY_ROUTE_BASE}/artifacts/`)) {
    return "artifacts";
  }
  return null;
}

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function normalizeRemoteAddress(remoteAddress: string | undefined): string {
  const normalized = remoteAddress?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function hasProxyForwardingHints(req: RequestLike): boolean {
  const headers = req.headers ?? {};
  return Boolean(
    headers["x-forwarded-for"] ||
      headers["x-real-ip"] ||
      headers.forwarded ||
      headers["x-forwarded-host"] ||
      headers["x-forwarded-proto"],
  );
}

function isLoopbackRequest(req: RequestLike): boolean {
  if (hasProxyForwardingHints(req)) {
    return false;
  }
  const remoteAddress = normalizeRemoteAddress(req.socket?.remoteAddress);
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1";
}

async function proxyRequest(req: RequestLike, res: ResponseLike, upstream: URL): Promise<void> {
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(req);
  const response = await fetch(upstream, {
    method,
    headers: buildForwardHeaders(req),
    body,
  });
  const responseBody = new Uint8Array(await response.arrayBuffer());

  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    if (BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    res.setHeader(key, value);
  }
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", response.headers.get("cache-control") ?? "no-store, max-age=0");
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(responseBody);
}

async function readRequestBody(req: RequestLike): Promise<ArrayBuffer | undefined> {
  const iterator = req[Symbol.asyncIterator];
  if (!iterator) {
    return undefined;
  }
  const iterable = {
    [Symbol.asyncIterator]: iterator.bind(req),
  };
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const merged = concatUint8Arrays(chunks);
  return new Uint8Array(merged).buffer;
}

function buildForwardHeaders(req: RequestLike): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (value == null || BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return headers;
}

function respondText(res: ResponseLike, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

function respondHtml(res: ResponseLike, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

function buildLocalOnlyHtml(params: {
  title: string;
  message: string;
  reviewBaseUrl: string;
}): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(params.title)}</title>
  <style>
    body { margin: 0; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; background: #f5efe6; color: #221b16; }
    main { max-width: 760px; margin: 48px auto; padding: 28px; background: rgba(255,250,244,0.96); border: 1px solid #e6d7c5; border-radius: 24px; box-shadow: 0 18px 48px rgba(34,27,22,0.1); }
    h1 { margin-top: 0; font-size: 28px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0e4d6; border-radius: 12px; }
    code { padding: 2px 6px; }
    pre { padding: 14px; overflow: auto; }
    .muted { color: #6b6258; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.title)}</h1>
    <p>${escapeHtml(params.message)}</p>
    <p class="muted">review app base URL: <code>${escapeHtml(params.reviewBaseUrl)}</code></p>
    <pre>cd ${escapeHtml("mcp-servers/photo-ranker")}
uv run review_app.py</pre>
    <p class="muted">그 다음 <code>/plugins/photos-classify/review/&lt;job_id&gt;</code> 경로로 다시 접속하세요.</p>
  </main>
</body>
</html>`;
}

function buildPortalHtml(params: { basePath: string; authToken: string; accessLabel: string }): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Photos Classify Portal</title>
  <style>
    :root { --bg:#f4efe8; --panel:#fffaf2; --ink:#201913; --muted:#6c6258; --line:#e6d8c7; --accent:#c45f3c; --accent-2:#2f6c58; }
    * { box-sizing:border-box; }
    body { margin:0; font:16px/1.5 ui-sans-serif,system-ui,sans-serif; color:var(--ink); background:radial-gradient(circle at top,#fff5e8,var(--bg) 68%); }
    main { max-width:1100px; margin:0 auto; padding:32px 24px 56px; }
    .hero { display:grid; gap:14px; margin-bottom:22px; }
    .hero h1 { margin:0; font-size:32px; }
    .muted { color:var(--muted); }
    .actions, .chips { display:flex; gap:10px; flex-wrap:wrap; }
    .btn { display:inline-flex; align-items:center; justify-content:center; padding:10px 14px; border-radius:999px; border:1px solid var(--line); background:var(--panel); color:var(--ink); text-decoration:none; cursor:pointer; }
    .btn--primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    .btn--secondary { background:#e8f2ed; border-color:#c8ddd4; color:#173d31; }
    .panel { background:rgba(255,250,242,0.95); border:1px solid var(--line); border-radius:24px; padding:18px; box-shadow:0 16px 40px rgba(32,25,19,0.08); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:16px; margin-top:18px; }
    .card { display:grid; gap:10px; }
    .status { display:inline-flex; width:max-content; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; background:#efe3d2; }
    .status[data-status="completed"] { background:#d9efe2; color:#1d5a40; }
    .status[data-status="running"] { background:#f6e5b5; color:#745500; }
    .status[data-status="failed"] { background:#f6d6d2; color:#87342a; }
    .meta { font-size:13px; color:var(--muted); }
    .title-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .empty { padding:24px; border:1px dashed var(--line); border-radius:18px; color:var(--muted); }
    .error { color:#872d24; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:#f0e4d6; border-radius:8px; padding:2px 6px; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>Photos Classify Portal</h1>
      <div class="muted">OpenClaw core UI를 수정하지 않고 review route, 최근 job, review 진입, export 동선을 한 곳에 모은 포털입니다.</div>
      <div class="actions">
        <a class="btn btn--primary" href="${params.basePath}/">Refresh Portal</a>
        <a class="btn btn--secondary" href="${params.basePath}/review/demo">Review Route Example</a>
      </div>
      <div class="chips muted">
        <span>base route: <code>${params.basePath}</code></span>
        <span id="access-chip">access: ${params.authToken ? "token" : params.accessLabel}</span>
      </div>
    </section>

    <section class="panel">
      <div class="title-row">
        <div>
          <strong>Recent Jobs</strong>
          <div class="meta">최근 분류 job을 보고 review 화면과 export 동선으로 바로 이동합니다.</div>
        </div>
        <button class="btn" id="reload-jobs">Reload</button>
      </div>
      <div id="jobs-state" class="meta" style="margin-top:10px">Loading…</div>
      <div id="jobs-grid" class="grid"></div>
    </section>
  </main>
  <script>
    const basePath = ${JSON.stringify(params.basePath)};
    const authToken = ${JSON.stringify(params.authToken)};

    function withAuth(path) {
      if (!authToken) return path;
      const separator = path.includes('?') ? '&' : '?';
      return path + separator + 'token=' + encodeURIComponent(authToken);
    }

    function formatDate(ts) {
      if (!ts) return '-';
      return new Date(ts * 1000).toLocaleString();
    }

    function renderJobs(items) {
      const grid = document.getElementById('jobs-grid');
      const state = document.getElementById('jobs-state');
      if (!items.length) {
        state.textContent = '저장된 recent job이 없습니다. /classify 또는 start_classify_job 이후 다시 확인하세요.';
        grid.innerHTML = '<div class="empty">No jobs yet</div>';
        return;
      }
      state.textContent = String(items.length) + ' job loaded';
      grid.innerHTML = items.map((job) => {
        const progress = job.progress || {};
        const reviewUrl = withAuth(basePath + '/review/' + encodeURIComponent(job.job_id));
        const itemsUrl = withAuth(basePath + '/api/jobs/' + encodeURIComponent(job.job_id) + '/items?top_n=20');
        const errorHtml = job.error_message
          ? '<div class="meta error">' + job.error_message + '</div>'
          : '';
        return [
          '<article class="panel card">',
          '<div class="title-row">',
          '<strong>' + job.job_id + '</strong>',
          '<span class="status" data-status="' + job.status + '">' + job.status + '</span>',
          '</div>',
          '<div class="meta">' + job.source + ' · ' + (job.source_path || '-') + '</div>',
          '<div class="meta">created ' + formatDate(job.created_at) + '</div>',
          '<div class="meta">photos ' + job.photo_count + ' · selected ' + job.selected_count + '</div>',
          '<div class="meta">progress ' + (progress.completed || 0) + '/' + (progress.total || 0) + ' · ' + (progress.stage || '-') + '</div>',
          errorHtml,
          '<div class="actions">',
          '<a class="btn btn--primary" href="' + reviewUrl + '">Open Review</a>',
          '<a class="btn" href="' + itemsUrl + '">Items API</a>',
          '</div>',
          '</article>',
        ].join('');
      }).join('');
    }

    async function loadJobs() {
      const state = document.getElementById('jobs-state');
      const grid = document.getElementById('jobs-grid');
      state.textContent = 'Loading…';
      try {
        const response = await fetch(withAuth(basePath + '/api/jobs?limit=24'));
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        const payload = await response.json();
        renderJobs(payload);
      } catch (error) {
        state.textContent = 'recent job을 불러오지 못했습니다.';
        grid.innerHTML = '<div class="empty error">review app이 실행 중인지 확인하세요. error: ' + String(error) + '</div>';
      }
    }

    document.getElementById('reload-jobs').addEventListener('click', loadJobs);
    loadJobs();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}