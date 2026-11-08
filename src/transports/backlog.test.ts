import { afterEach, describe, expect, test, vi } from "vitest";
import { BacklogReadError } from "../backlog-queries.js";
import { BacklogRateLimitError, backlogReader } from "./backlog.js";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

function mockFetch(response: () => Response): RequestInfo[] {
  const calls: RequestInfo[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input as RequestInfo);
    return response();
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("Backlog transport", () => {
  test("builds space-scoped URLs with the API key and repeated array parameters", async () => {
    const calls = mockFetch(() => json([]));
    const reader = backlogReader({ space: "fixture", apiKey: "secret" });
    await reader.projectIssues?.(1, [1, 2], { offset: 100, count: 100 });
    const url = new URL(String(calls[0]));
    expect(url.origin).toBe("https://fixture.backlog.com");
    expect(url.pathname).toBe("/api/v2/issues");
    expect(url.searchParams.get("apiKey")).toBe("secret");
    expect(url.searchParams.getAll("projectId[]")).toEqual(["1"]);
    expect(url.searchParams.getAll("statusId[]")).toEqual(["1", "2"]);
    expect(url.searchParams.get("offset")).toBe("100");
    expect(url.searchParams.get("count")).toBe("100");
  });
  test("serves legacy backlog.jp spaces from their own host", async () => {
    const calls = mockFetch(() => json({ spaceKey: "legacy" }));
    const reader = backlogReader({ space: "legacy", domain: "backlog.jp", apiKey: "secret" });
    expect(reader.origin).toBe("https://legacy.backlog.jp");
    await reader.space();
    expect(String(calls[0])).toContain("https://legacy.backlog.jp/api/v2/space");
  });
  test("reads a comment page ascending from minId", async () => {
    const calls = mockFetch(() => json([]));
    const reader = backlogReader({ space: "fixture", accessToken: "token" });
    await reader.comments?.(7, { count: 100, minId: 40 });
    const url = new URL(String(calls[0]));
    expect(url.pathname).toBe("/api/v2/issues/7/comments");
    expect(url.searchParams.get("order")).toBe("asc");
    expect(url.searchParams.get("minId")).toBe("40");
    expect(url.searchParams.has("apiKey")).toBe(false);
  });
  test("memoizes issue reads used by both mention resolution and the crawl", async () => {
    const calls = mockFetch(() => json({ id: 1, issueKey: "PROJ-1" }));
    const reader = backlogReader({ space: "fixture", apiKey: "secret" });
    await reader.issue("PROJ-1");
    await reader.issue(1);
    expect(calls).toHaveLength(1);
  });
  test("does not retry authentication failures", async () => {
    const calls = mockFetch(() => json({}, { status: 401 }));
    const reader = backlogReader({ space: "fixture", apiKey: "secret" });
    await expect(reader.space()).rejects.toThrow(BacklogReadError);
    expect(calls).toHaveLength(1);
  });
  test("surfaces rate limits with the reset time", async () => {
    const calls = mockFetch(
      () =>
        new Response("{}", {
          status: 429,
          headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) },
        }),
    );
    const reader = backlogReader({ space: "fixture", apiKey: "secret", maxRetries: 1 });
    await expect(reader.space()).rejects.toThrow(BacklogRateLimitError);
    expect(calls).toHaveLength(1);
  });
  test("retries upstream failures", async () => {
    let attempt = 0;
    const calls = mockFetch(() => {
      attempt++;
      return attempt === 1 ? json({}, { status: 503 }) : json({ spaceKey: "fixture" });
    });
    const reader = backlogReader({ space: "fixture", apiKey: "secret", maxRetries: 1 });
    await expect(reader.space()).resolves.toEqual({ spaceKey: "fixture" });
    expect(calls).toHaveLength(2);
  });
  test.each([
    [{ space: "fixture" }, "exactly one"],
    [{ space: "fixture", apiKey: "a", accessToken: "b" }, "exactly one"],
    [{ space: "evil.example.com", apiKey: "a" }, "BACKLOG_SPACE"],
    [{ space: "", apiKey: "a" }, "BACKLOG_SPACE"],
  ])("rejects invalid options %o", (options, message) =>
    expect(() => backlogReader(options as never)).toThrow(message));
});
