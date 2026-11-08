import {
  type BacklogCommentPage,
  type BacklogDomain,
  type BacklogPage,
  BacklogReadError,
  type BacklogReader,
} from "../backlog-queries.js";

export interface BacklogReaderOptions {
  /** Space key from `https://<space>.backlog.com`; no dots, so the host is fixed. */
  space: string;
  /** Legacy spaces live on `backlog.jp`. */
  domain?: BacklogDomain;
  apiKey?: string;
  /** OAuth 2.0 access token; mutually exclusive with `apiKey`. */
  accessToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
}

interface Failure {
  code: string;
  retry: boolean;
  delay?: number;
  resetAt?: number;
}

/** Backlog reports the rate-limit window as epoch seconds. */
function resetAt(headers: Headers): number | undefined {
  const value = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}

function classify(status: number, headers: Headers): Failure {
  if (status === 429) {
    const reset = resetAt(headers);
    const retryAfter = Number(headers.get("retry-after"));
    return {
      code: "RATE_LIMITED",
      retry: true,
      resetAt: reset,
      delay:
        reset !== undefined
          ? Math.max(0, reset - Date.now())
          : headers.has("retry-after") && Number.isFinite(retryAfter)
            ? retryAfter * 1000
            : undefined,
    };
  }
  if (status === 401) return { code: "AUTHENTICATION", retry: false };
  if (status === 403) return { code: "FORBIDDEN", retry: false };
  if (status === 404) return { code: "NOT_FOUND", retry: false };
  if (status === 400) return { code: "INVALID_REQUEST", retry: false };
  if (status >= 500) return { code: "UPSTREAM", retry: true };
  return { code: `HTTP_${status}`, retry: false };
}

/** Rate-limit failure that names when the window reopens. */
export class BacklogRateLimitError extends BacklogReadError {
  constructor(readonly resetAt?: number) {
    super("RATE_LIMITED");
    if (resetAt)
      this.message = `Backlog read failed (RATE_LIMITED); the limit resets at ${new Date(resetAt).toISOString()}`;
  }
}

class AttemptError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code);
  }
}

const SPACE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Read-only REST reader over fetch. The API key travels as a query parameter
 * (Backlog's documented scheme); OAuth tokens use the Bearer header instead.
 */
export function backlogReader(options: BacklogReaderOptions): BacklogReader {
  if (Boolean(options.apiKey) === Boolean(options.accessToken))
    throw new Error("Set exactly one of BACKLOG_API_KEY or BACKLOG_ACCESS_TOKEN");
  if (!SPACE.test(options.space))
    throw new Error("BACKLOG_SPACE must be the space key of https://<space>.backlog.com");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRetries = options.maxRetries ?? 2;
  const maxBackoffMs = options.maxBackoffMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new RangeError("Backlog timeoutMs must be from 1 to 120000");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3)
    throw new RangeError("Backlog maxRetries must be from 0 to 3");
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < 0 || maxBackoffMs > 30_000)
    throw new RangeError("Backlog maxBackoffMs must be from 0 to 30000");

  const origin = `https://${options.space}.${options.domain ?? "backlog.com"}`;
  const base = `${origin}/api/v2/`;
  // `||`, not `??`: an empty BACKLOG_API_KEY must not shadow a set access token.
  const authorization = options.apiKey ? undefined : `Bearer ${options.accessToken}`;

  function url(path: string, params: Record<string, string | number | number[] | undefined>) {
    const target = new URL(path.replace(/^\//, ""), base);
    if (options.apiKey) target.searchParams.set("apiKey", options.apiKey);
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const single of Array.isArray(value) ? value : [value])
        target.searchParams.append(name, String(single));
    }
    return target;
  }

  async function attempt(
    path: string,
    params: Record<string, string | number | number[] | undefined>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url(path, params), {
        method: "GET",
        headers: authorization ? { authorization } : {},
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new AttemptError({
        code: name === "AbortError" || name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
        retry: false,
      });
    }
    if (!response.ok) throw new AttemptError(classify(response.status, response.headers));
    try {
      return await response.json();
    } catch {
      throw new AttemptError({ code: "INVALID_PAYLOAD", retry: false });
    }
  }

  async function read(
    path: string,
    params: Record<string, string | number | number[] | undefined> = {},
  ): Promise<unknown> {
    for (let tries = 0; ; tries++) {
      try {
        return await attempt(path, params);
      } catch (error) {
        const state =
          error instanceof AttemptError ? error.failure : { code: "NETWORK", retry: false };
        const delay = state.delay ?? 1_000 * 2 ** tries;
        if (!state.retry || tries >= maxRetries || delay > maxBackoffMs)
          throw state.code === "RATE_LIMITED"
            ? new BacklogRateLimitError(state.resetAt)
            : new BacklogReadError(state.code);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const segment = (value: string | number) => encodeURIComponent(String(value));

  // Reads are memoized so resolving a text mention and then crawling the target
  // does not fetch the same issue twice.
  const issues = new Map<string, Promise<unknown>>();

  return {
    origin,
    space: () => read("space"),
    projects: () => read("projects"),
    project: (idOrKey) => read(`projects/${segment(idOrKey)}`),
    projectStatuses: (idOrKey) => read(`projects/${segment(idOrKey)}/statuses`),
    issue(idOrKey) {
      const id = String(idOrKey);
      let pending = issues.get(id);
      if (!pending) {
        // Index the answer under both its numeric id and its issue key, so a
        // mention resolved by key is not fetched again when the crawl reaches it.
        const request = read(`issues/${segment(id)}`).then((body) => {
          if (body && typeof body === "object" && !Array.isArray(body)) {
            const item = body as Record<string, unknown>;
            if (typeof item.id === "number" || typeof item.id === "string")
              issues.set(String(item.id), Promise.resolve(body));
            if (typeof item.issueKey === "string")
              issues.set(item.issueKey.toUpperCase(), Promise.resolve(body));
          }
          return body;
        });
        pending = request;
        issues.set(id, request);
        request.catch(() => issues.delete(id));
      }
      return pending;
    },
    comments: (idOrKey, page: BacklogCommentPage) =>
      read(`issues/${segment(idOrKey)}/comments`, {
        count: page.count,
        order: "asc",
        minId: page.minId,
      }),
    relatedIssues: (idOrKey) => read(`issues/${segment(idOrKey)}/relatedIssues`),
    children: (idOrKey, page: BacklogPage) =>
      read("issues", {
        "parentIssueId[]": Number(idOrKey),
        count: page.count,
        offset: page.offset,
      }),
    projectIssues: (projectId, statusIds: number[], page: BacklogPage) =>
      read("issues", {
        "projectId[]": Number(projectId),
        "statusId[]": statusIds,
        count: page.count,
        offset: page.offset,
      }),
    async countIssues(projectId, statusIds: number[]) {
      const body = await read("issues/count", {
        "projectId[]": Number(projectId),
        "statusId[]": statusIds,
      });
      return body;
    },
  };
}
