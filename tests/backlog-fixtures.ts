import type { BacklogGraphOptions } from "../src/backlog.js";
import type { BacklogReader } from "../src/backlog-queries.js";

export const spaceKey = "fixture";
export const spaceUrl = `https://${spaceKey}.backlog.com`;
export const key = (id: number) => `backlog:${spaceKey}:issue:${id}`;

export const options: BacklogGraphOptions = {
  maxDepth: 1,
  maxNodes: 80,
  maxPages: 5,
  hubThreshold: 12,
  concurrency: 4,
  generatedAt: "2026-11-08T00:00:00.000Z",
};

export const statuses = [
  { id: 1, name: "Open", displayOrder: 1000 },
  { id: 2, name: "In progress", displayOrder: 2000 },
  { id: 3, name: "Resolved", displayOrder: 3000 },
  { id: 4, name: "Closed", displayOrder: 4000 },
];

export function project(id = 1, projectKey = "PROJ") {
  return { id, projectKey, name: `${projectKey} project` };
}

export interface FixtureIssue {
  id: number;
  projectId: number;
  issueKey: string;
  summary: string;
  description: string;
  resolution: { id: number; name: string } | null;
  status: { id: number; name: string };
  created: string;
  updated: string;
  parentIssueId: number | null;
  createdUser: { id: number; name: string };
  assignee: { id: number; name: string } | null;
  stars: unknown[];
}

export function issue(id: number, overrides: Partial<FixtureIssue> = {}): FixtureIssue {
  return {
    id,
    projectId: 1,
    issueKey: `PROJ-${id}`,
    summary: `Issue ${id}`,
    description: "",
    resolution: null,
    status: { id: 1, name: "Open" },
    created: "2026-11-01T00:00:00Z",
    updated: "2026-11-02T00:00:00Z",
    parentIssueId: null,
    createdUser: { id: 1, name: "author" },
    assignee: null,
    stars: [],
    ...overrides,
  };
}

export interface FixtureOptions {
  issues?: FixtureIssue[];
  projects?: ReturnType<typeof project>[];
  comments?: Record<
    number,
    Array<{ id: number; content: string; createdUser?: { id: number; name: string } }>
  >;
  related?: Record<number, number[]>;
  children?: Record<number, number[]>;
}

export interface FixtureReader extends BacklogReader {
  calls: string[];
}

export function fixtureReader(fixture: FixtureOptions = {}): FixtureReader {
  const issues = fixture.issues ?? [issue(1)];
  const projects = fixture.projects ?? [project()];
  const comments = fixture.comments ?? {};
  const related = fixture.related ?? {};
  const children = fixture.children ?? {};
  const calls: string[] = [];
  const find = (idOrKey: string | number) => {
    const value = String(idOrKey);
    const found = issues.find(
      (item) => String(item.id) === value || item.issueKey === value.toUpperCase(),
    );
    if (!found) throw new Error(`Fixture issue ${value} unavailable`);
    return structuredClone(found);
  };
  return {
    calls,
    async space() {
      calls.push("space");
      return { spaceKey, name: "Fixture", textFormattingRule: "markdown" };
    },
    async projects() {
      calls.push("projects");
      return structuredClone(projects);
    },
    async project(idOrKey) {
      calls.push(`project:${idOrKey}`);
      const value = String(idOrKey).toUpperCase();
      const found = projects.find(
        (item) => String(item.id) === String(idOrKey) || item.projectKey === value,
      );
      if (!found) throw new Error(`Fixture project ${value} unavailable`);
      return structuredClone(found);
    },
    async projectStatuses() {
      calls.push("statuses");
      return structuredClone(statuses);
    },
    async issue(idOrKey) {
      calls.push(`issue:${idOrKey}`);
      return find(idOrKey);
    },
    async comments(idOrKey, page) {
      calls.push(`comments:${idOrKey}:${page.minId ?? 0}`);
      const all = comments[Number(idOrKey)] ?? [];
      const after = page.minId ?? 0;
      return structuredClone(all.filter((comment) => comment.id >= after).slice(0, page.count));
    },
    async relatedIssues(idOrKey) {
      calls.push(`related:${idOrKey}`);
      return (related[Number(idOrKey)] ?? []).map((id) => find(id));
    },
    async children(idOrKey, page) {
      calls.push(`children:${idOrKey}:${page.offset}`);
      const declared = children[Number(idOrKey)];
      const ids = declared
        ? [...declared]
        : issues.filter((item) => item.parentIssueId === Number(idOrKey)).map((item) => item.id);
      return ids.map((id) => find(id)).slice(page.offset, page.offset + page.count);
    },
    async projectIssues(projectId, statusIds, page) {
      calls.push(`projectIssues:${page.offset}:${statusIds.join(",")}`);
      const matching = issues.filter(
        (item) =>
          String(item.projectId) === String(projectId) &&
          (statusIds.length === 0 || statusIds.includes(item.status.id)),
      );
      return structuredClone(matching.slice(page.offset, page.offset + page.count));
    },
    async countIssues(projectId, statusIds) {
      calls.push(`count:${statusIds.join(",")}`);
      const count = issues.filter(
        (item) =>
          String(item.projectId) === String(projectId) &&
          (statusIds.length === 0 || statusIds.includes(item.status.id)),
      ).length;
      return { count };
    },
  };
}
