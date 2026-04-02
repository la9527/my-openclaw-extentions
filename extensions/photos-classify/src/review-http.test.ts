import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PHOTOS_CLASSIFY_ROUTE_BASE,
  createPhotosReviewHttpHandler,
  resolveReviewProxyTarget,
} from "./review-http.js";

const decoder = new TextDecoder();

type FetchSpy = {
  mock: {
    calls: unknown[][];
  };
  mockResolvedValue(value: unknown): unknown;
  mockResolvedValueOnce(value: unknown): FetchSpy;
  mockRejectedValue(value: unknown): unknown;
  mockRejectedValueOnce(value: unknown): FetchSpy;
};

function createRequest(params: {
  url: string;
  method?: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
}) {
  const req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
    end(): void;
  } = {
    url: params.url,
    method: params.method ?? "GET",
    headers: params.headers ?? {},
    socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
    end() {},
  };
  req.end();
  return req;
}

function createResponse() {
  const headers = new Map<string, string>();
  return {
    statusCode: 200,
    ended: false,
    body: new Uint8Array(),
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(body?: string | Uint8Array) {
      this.ended = true;
      if (typeof body === "string") {
        this.body = new TextEncoder().encode(body);
      } else if (body) {
        this.body = new Uint8Array(body);
      }
    },
  };
}

describe("resolveReviewProxyTarget", () => {
  it("adds base_path when proxying review pages", () => {
    const target = resolveReviewProxyTarget(
      new URL(`${PHOTOS_CLASSIFY_ROUTE_BASE}/review/job-1?foo=bar`, "http://127.0.0.1"),
      "http://127.0.0.1:8765",
    );

    expect(target?.toString()).toBe(
      "http://127.0.0.1:8765/review/job-1?foo=bar&base_path=%2Fplugins%2Fphotos-classify",
    );
  });
});

describe("createPhotosReviewHttpHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false for unrelated routes", async () => {
    const handler = createPhotosReviewHttpHandler({ reviewBaseUrl: "http://127.0.0.1:8765" });
    const handled = await handler(
      createRequest({ url: "/somewhere-else" }) as never,
      createResponse() as never,
    );

    expect(handled).toBe(false);
  });

  it("renders a portal page for the root route", async () => {
    const handler = createPhotosReviewHttpHandler({ reviewBaseUrl: "http://127.0.0.1:8765" });
    const res = createResponse();

    const handled = await handler(
      createRequest({ url: `${PHOTOS_CLASSIFY_ROUTE_BASE}/` }) as never,
      res as never,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(decoder.decode(res.body)).toContain("Photos Classify Portal");
    expect(decoder.decode(res.body)).toContain("/api/jobs?limit=24");
  });

  it("proxies review pages through the local review app", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<html>ok</html>", { status: 200 })) as FetchSpy;
    const handler = createPhotosReviewHttpHandler({ reviewBaseUrl: "http://127.0.0.1:8765" });
    const res = createResponse();

    const handled = await handler(
      createRequest({ url: `${PHOTOS_CLASSIFY_ROUTE_BASE}/review/job-42` }) as never,
      res as never,
    );

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall?.[0])).toBe(
      "http://127.0.0.1:8765/review/job-42?base_path=%2Fplugins%2Fphotos-classify",
    );
    expect((firstCall?.[1] as { method?: string } | undefined)?.method).toBe("GET");
    expect(res.statusCode).toBe(200);
    expect(decoder.decode(res.body)).toContain("ok");
  });

  it("returns a local guidance page when the review app is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));
    const handler = createPhotosReviewHttpHandler({ reviewBaseUrl: "http://127.0.0.1:8765" });
    const res = createResponse();

    const handled = await handler(
      createRequest({ url: `${PHOTOS_CLASSIFY_ROUTE_BASE}/review/job-42` }) as never,
      res as never,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(decoder.decode(res.body)).toContain("uv run python review_app.py");
  });

  it("auto-starts the review app and retries the proxy request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response("<html>ok</html>", { status: 200 })) as FetchSpy;
    const spawn = vi.fn(() => ({ unref() {} }));
    const handler = createPhotosReviewHttpHandler({
      reviewBaseUrl: "http://127.0.0.1:8765",
      reviewAppAutoStart: {
        enabled: true,
        cwd: "/tmp/photo-ranker",
        spawn: spawn as never,
        sleep: async () => {},
        startTimeoutMs: 10,
        pollIntervalMs: 0,
      },
    });
    const res = createResponse();

    const handled = await handler(
      createRequest({ url: `${PHOTOS_CLASSIFY_ROUTE_BASE}/review/job-42` }) as never,
      res as never,
    );

    expect(handled).toBe(true);
    expect(spawn).toHaveBeenCalledWith("uv", ["run", "python", "review_app.py"], {
      cwd: "/tmp/photo-ranker",
      detached: true,
      stdio: "ignore",
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(decoder.decode(res.body)).toContain("ok");
  });

  it("blocks non-loopback requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const handler = createPhotosReviewHttpHandler({ reviewBaseUrl: "http://127.0.0.1:8765" });
    const res = createResponse();

    const handled = await handler(
      createRequest({
        url: `${PHOTOS_CLASSIFY_ROUTE_BASE}/review/job-42`,
        remoteAddress: "10.0.0.8",
      }) as never,
      res as never,
    );

    expect(handled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("allows remote requests with a matching token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<html>ok</html>", { status: 200 })) as FetchSpy;
    const handler = createPhotosReviewHttpHandler({
      reviewBaseUrl: "http://127.0.0.1:8765",
      reviewAccessToken: "secret-token",
    });
    const res = createResponse();

    const handled = await handler(
      createRequest({
        url: `${PHOTOS_CLASSIFY_ROUTE_BASE}/review/job-42?token=secret-token`,
        remoteAddress: "10.0.0.8",
      }) as never,
      res as never,
    );

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall?.[0])).toContain("auth_token=secret-token");
  });

  it("allows Tailscale Serve requests when identity headers are present and access is enabled", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<html>ok</html>", { status: 200 })) as FetchSpy;
    const handler = createPhotosReviewHttpHandler({
      reviewBaseUrl: "http://127.0.0.1:8765",
      reviewTailscaleAccess: {
        enabled: true,
        allowedUserLogins: [],
      },
    });
    const res = createResponse();

    const handled = await handler(
      createRequest({
        url: `${PHOTOS_CLASSIFY_ROUTE_BASE}/review/job-42`,
        remoteAddress: "127.0.0.1",
        headers: {
          "x-forwarded-for": "100.64.0.10",
          "tailscale-user-login": "user@example.com",
          "tailscale-user-name": "Example User",
        },
      }) as never,
      res as never,
    );

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("blocks Tailscale Serve requests when the login is not allowlisted", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const handler = createPhotosReviewHttpHandler({
      reviewBaseUrl: "http://127.0.0.1:8765",
      reviewTailscaleAccess: {
        enabled: true,
        allowedUserLogins: ["allowed@example.com"],
      },
    });
    const res = createResponse();

    const handled = await handler(
      createRequest({
        url: `${PHOTOS_CLASSIFY_ROUTE_BASE}/review/job-42`,
        remoteAddress: "127.0.0.1",
        headers: {
          "x-forwarded-for": "100.64.0.10",
          "tailscale-user-login": "blocked@example.com",
          "tailscale-user-name": "Blocked User",
        },
      }) as never,
      res as never,
    );

    expect(handled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});