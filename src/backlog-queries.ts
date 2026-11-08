/**
 * How the crawl talks to Nulab Backlog. Backlog is REST (not GraphQL), so each
 * relationship is its own endpoint: a reader exposes one method per endpoint and
 * the graph logic in `backlog.ts` decides which of them matter.
 *
 * Everything returned here is raw JSON; validation happens in `backlog.ts` so a
 * change in the API shape fails as a recorded gap, not as a crash mid-crawl.
 */

/** Backlog caps every list endpoint at 100 records per request. */
export const BACKLOG_PAGE_SIZE = 100;

/** Backlog spaces live on the current domain or the legacy one. */
export type BacklogDomain = "backlog.com" | "backlog.jp";

export const BACKLOG_DOMAINS: readonly BacklogDomain[] = ["backlog.com", "backlog.jp"];

/**
 * Accepts a bare space key (`globetails`) or a host (`globetails.backlog.jp`).
 * The domain matters because legacy spaces are not served from backlog.com.
 */
export function parseBacklogHost(
  input: string,
): { space: string; domain: BacklogDomain } | undefined {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const [space, domain] = value.split(".");
  if (!space || !/^[a-z0-9][a-z0-9-]*$/.test(space)) return undefined;
  if (domain === undefined) return { space, domain: "backlog.com" };
  const match = BACKLOG_DOMAINS.find((candidate) => candidate === value.slice(space.length + 1));
  return match ? { space, domain: match } : undefined;
}

/** Offset pagination, used by the issue list endpoints. */
export interface BacklogPage {
  offset: number;
  count: number;
}

/** Comment pagination is cursor-based (`minId`), ascending by id. */
export interface BacklogCommentPage {
  minId?: number;
  count: number;
}

export interface BacklogReader {
  /** How the data was read, recorded as the report's source. */
  label?: string;
  /** API origin, so the report can build links for legacy spaces. */
  origin?: string;
  space(): Promise<unknown>;
  /** All projects in the space; used to recognise `PROJ-123` text mentions. */
  projects?(): Promise<unknown>;
  project(projectIdOrKey: string | number): Promise<unknown>;
  /** Statuses of one project, in the space's configured order. */
  projectStatuses?(projectIdOrKey: string | number): Promise<unknown>;
  issue(issueIdOrKey: string | number): Promise<unknown>;
  comments?(issueIdOrKey: string | number, page: BacklogCommentPage): Promise<unknown>;
  relatedIssues?(issueIdOrKey: string | number): Promise<unknown>;
  children?(issueIdOrKey: string | number, page: BacklogPage): Promise<unknown>;
  projectIssues?(
    projectId: string | number,
    statusIds: number[],
    page: BacklogPage,
  ): Promise<unknown>;
  countIssues?(projectId: string | number, statusIds: number[]): Promise<unknown>;
}

export class BacklogReadError extends Error {
  constructor(readonly code: string) {
    super(`Backlog read failed (${code})`);
    this.name = "BacklogReadError";
  }
}
