import {
  BACKLOG_PAGE_SIZE,
  type BacklogDomain,
  BacklogReadError,
  type BacklogReader,
  parseBacklogHost,
} from "./backlog-queries.js";
import { components, crawlGraph } from "./crawl.js";
import type { GraphCrawlOptions } from "./types.js";
import type {
  OpenItemCount,
  ReadCoverage,
  WorkEdge,
  WorkLink,
  WorkNode,
  WorkProject,
} from "./work-types.js";

const ISSUE_KEY = /^[a-z][a-z0-9_]*-[1-9]\d*$/i;
const PROJECT_KEY = /^[a-z][a-z0-9_]*$/i;
const SPACE = /^[a-z0-9][a-z0-9-]*$/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>()"'`\]]+/g;
const KEY_IN_TEXT = /(^|[^A-Za-z0-9_/-])([A-Za-z][A-Za-z0-9_]*)-([1-9]\d*)(?![0-9A-Za-z_])/g;

export interface BacklogLocator {
  /** Issue key (`PROJ-123`), upper-cased. */
  id: string;
  space?: string;
  domain?: BacklogDomain;
}

/** Accepts `PROJ-123` and `https://<space>.backlog.com/view/PROJ-123`. */
export function parseBacklogLocator(input: string): BacklogLocator {
  const value = input.trim();
  if (ISSUE_KEY.test(value)) return { id: value.toUpperCase() };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected a Backlog issue URL or issue key (PROJ-123)");
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password)
    throw new Error("Expected an https://<space>.backlog.com/view/PROJ-123 URL");
  const host = parseBacklogHost(url.hostname);
  const match = url.pathname.match(/^\/view\/([a-z][a-z0-9_]*-[1-9]\d*)\/?$/i);
  if (!host || !match) throw new Error("Expected an https://<space>.backlog.com/view/PROJ-123 URL");
  return { id: match[1].toUpperCase(), space: host.space, domain: host.domain };
}

export interface BacklogSpace {
  spaceKey: string;
  name: string;
  url: string;
  domain: BacklogDomain;
}

export interface BacklogReport {
  schemaVersion: 1;
  source: "backlog";
  generatedAt: string;
  space: BacklogSpace;
  project?: WorkProject | null;
  openCount?: OpenItemCount;
  readSource?: string;
  inventory?: ReadCoverage;
  seeds: string[];
  scope: {
    issues?: "project" | "neighborhood";
    notes?: readonly string[];
    relationships: readonly string[];
    externalLinks: "reported-not-fetched";
    textReferences: "collected" | "not-collected";
    archived: "issues-included-links-excluded" | "excluded";
  };
  limits: {
    maxDepth: number;
    maxNodes: number;
    maxPages: number;
    hubThreshold: number;
    concurrency: number;
  };
  coverageComplete: boolean;
  coverage: {
    failed: string[];
    partial: string[];
    cappedOut: string[];
    hubs: string[];
    depthBoundaries: string[];
  };
  nodes: WorkNode[];
  components: string[][];
}

export interface BacklogGraphOptions extends Omit<GraphCrawlOptions, "depthForEdge"> {
  /** Pages per collection per issue. */
  maxPages: number;
  space?: string;
  /** Project capture: include issues in the project's closed status. */
  includeClosed?: boolean;
  generatedAt?: string;
}

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BacklogReadError("INVALID_PAYLOAD");
  return value as RecordValue;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new BacklogReadError("INVALID_PAYLOAD");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function nativeId(value: unknown): number {
  const id = typeof value === "number" ? value : Number(text(value));
  if (!Number.isSafeInteger(id) || id < 1) throw new BacklogReadError("INVALID_PAYLOAD");
  return id;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new BacklogReadError("INVALID_PAYLOAD");
  return value;
}

export function backlogNodeKey(spaceKey: string, id: number | string): string {
  return `backlog:${spaceKey}:issue:${nativeId(id)}`;
}

function projectKeyOf(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf("-")).toUpperCase();
}

async function readSpace(
  reader: BacklogReader,
  expected?: { space?: string; domain?: BacklogDomain },
): Promise<BacklogSpace> {
  const raw = object(await reader.space());
  const spaceKey = text(raw.spaceKey).toLowerCase();
  if (!SPACE.test(spaceKey)) throw new BacklogReadError("SPACE_MISMATCH");
  const origin = reader.origin ?? `https://${spaceKey}.backlog.com`;
  const host = parseBacklogHost(new URL(origin).hostname);
  if (!host || host.space !== spaceKey) throw new BacklogReadError("SPACE_MISMATCH");
  if (expected?.space && expected.space.toLowerCase() !== spaceKey)
    throw new BacklogReadError("SPACE_MISMATCH");
  if (expected?.domain && expected.domain !== host.domain)
    throw new BacklogReadError("SPACE_MISMATCH");
  return {
    spaceKey,
    name: optionalText(raw.name) ?? spaceKey,
    url: origin,
    domain: host.domain,
  };
}

/**
 * Project keys let `PROJ-123` in prose be treated as a reference without
 * matching unrelated hyphenated tokens such as `UTF-8`.
 */
async function readProjects(
  reader: BacklogReader,
  space: BacklogSpace,
): Promise<Map<string, WorkProject>> {
  const projects = new Map<string, WorkProject>();
  if (!reader.projects) return projects;
  try {
    for (const value of list(await reader.projects())) {
      const item = object(value);
      const key = text(item.projectKey).toUpperCase();
      if (!PROJECT_KEY.test(key)) continue;
      projects.set(key, {
        id: String(nativeId(item.id)),
        name: optionalText(item.name) ?? key,
        url: `${space.url}/projects/${key}`,
      });
    }
  } catch {
    // Text mentions stay unrecognised; the crawl itself still works.
  }
  return projects;
}

interface Status {
  id: number;
  name: string;
  displayOrder: number;
}

async function readStatuses(reader: BacklogReader, projectId: string | number): Promise<Status[]> {
  if (!reader.projectStatuses) return [];
  return list(await reader.projectStatuses(projectId))
    .map((value) => {
      const item = object(value);
      return {
        id: nativeId(item.id),
        name: text(item.name),
        displayOrder: typeof item.displayOrder === "number" ? item.displayOrder : 0,
      };
    })
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * Backlog has no "closed" flag on a status; the project's last status in
 * display order is the one that resolves an issue, so everything else is open.
 */
async function openStatusIds(reader: BacklogReader, projectId: string | number): Promise<number[]> {
  try {
    const statuses = await readStatuses(reader, projectId);
    return statuses.length < 2 ? [] : statuses.slice(0, -1).map((status) => status.id);
  } catch {
    return [];
  }
}

interface ReadContext {
  reader: BacklogReader;
  space: BacklogSpace;
  projects: Map<string, WorkProject>;
  maxPages: number;
  /** issue key → numeric id, so a text mention and the crawl share one read. */
  mentions: Map<string, Promise<number | undefined>>;
}

function readContext(
  reader: BacklogReader,
  space: BacklogSpace,
  projects: Map<string, WorkProject>,
  maxPages: number,
): ReadContext {
  return { reader, space, projects, maxPages, mentions: new Map() };
}

function resolveMention(context: ReadContext, issueKey: string): Promise<number | undefined> {
  let pending = context.mentions.get(issueKey);
  if (!pending) {
    pending = (async () => {
      try {
        const raw = object(await context.reader.issue(issueKey));
        if (text(raw.issueKey).toUpperCase() !== issueKey.toUpperCase()) return undefined;
        return nativeId(raw.id);
      } catch {
        return undefined;
      }
    })();
    context.mentions.set(issueKey, pending);
  }
  return pending;
}

/**
 * Issue keys and URLs in prose. Backlog does not link issues automatically, so
 * text is where most cross-references live.
 */
function scanProse(
  sources: Array<{ content: string | undefined; evidence: string }>,
  context: ReadContext,
  self: string,
): { refs: Array<[string, string]>; links: WorkLink[] } {
  const refs = new Map<string, string>();
  const links = new Map<string, WorkLink>();
  const spaceHost = `${context.space.spaceKey}.backlog.com`;
  for (const { content, evidence } of sources) {
    if (!content) continue;
    for (const match of content.matchAll(URL_IN_TEXT)) {
      let url: URL;
      try {
        url = new URL(match[0]);
      } catch {
        continue;
      }
      const path = url.pathname.match(/^\/view\/([a-z][a-z0-9_]*-[1-9]\d*)\/?$/i);
      if (url.hostname.toLowerCase() === spaceHost && path) {
        const key = path[1].toUpperCase();
        if (key !== self && !refs.has(key)) refs.set(key, evidence);
        continue;
      }
      if (!links.has(url.href))
        links.set(url.href, {
          url: url.href,
          title: url.hostname,
          evidence: { kind: "attachment", id: url.href },
        });
    }
    for (const match of content.matchAll(KEY_IN_TEXT)) {
      const key = `${match[2]}-${match[3]}`.toUpperCase();
      if (key === self || refs.has(key)) continue;
      if (!context.projects.has(projectKeyOf(key))) continue;
      refs.set(key, evidence);
    }
  }
  return {
    refs: [...refs.entries()],
    links: [...links.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
  };
}

async function readComments(
  context: ReadContext,
  id: number,
): Promise<{ comments: RecordValue[]; coverage?: ReadCoverage }> {
  const { reader } = context;
  if (!reader.comments) return { comments: [] };
  const comments: RecordValue[] = [];
  const coverage: ReadCoverage = { source: "comments", pages: 0, complete: false };
  let minId: number | undefined;
  try {
    for (let page = 0; page < context.maxPages; page++) {
      const batch = list(await reader.comments(id, { count: BACKLOG_PAGE_SIZE, minId }));
      coverage.pages++;
      for (const value of batch) comments.push(object(value));
      if (batch.length < BACKLOG_PAGE_SIZE) {
        coverage.complete = true;
        break;
      }
      minId = nativeId(object(batch[batch.length - 1]).id) + 1;
    }
    if (!coverage.complete) coverage.reason = "page-limit";
  } catch {
    coverage.reason = "read-failed";
  }
  return { comments, coverage };
}

async function readRelated(
  context: ReadContext,
  id: number,
): Promise<{ related: RecordValue[]; coverage?: ReadCoverage }> {
  const { reader } = context;
  if (!reader.relatedIssues) return { related: [] };
  const coverage: ReadCoverage = { source: "relatedIssues", pages: 0, complete: false };
  try {
    const related = list(await reader.relatedIssues(id)).map(object);
    coverage.pages = 1;
    coverage.complete = true;
    return { related, coverage };
  } catch {
    coverage.reason = "read-failed";
    return { related: [], coverage };
  }
}

async function readChildren(
  context: ReadContext,
  id: number,
): Promise<{ children: RecordValue[]; coverage?: ReadCoverage }> {
  const { reader } = context;
  if (!reader.children) return { children: [] };
  const children: RecordValue[] = [];
  const coverage: ReadCoverage = { source: "children", pages: 0, complete: false };
  try {
    for (let page = 0; page < context.maxPages; page++) {
      const batch = list(
        await reader.children(id, { offset: page * BACKLOG_PAGE_SIZE, count: BACKLOG_PAGE_SIZE }),
      );
      coverage.pages++;
      for (const value of batch) children.push(object(value));
      if (batch.length < BACKLOG_PAGE_SIZE) {
        coverage.complete = true;
        break;
      }
    }
    if (!coverage.complete) coverage.reason = "page-limit";
  } catch {
    coverage.reason = "read-failed";
  }
  return { children, coverage };
}

async function readNode(
  context: ReadContext,
  ref: string | number,
  depth: number,
): Promise<WorkNode> {
  const raw = object(await context.reader.issue(ref));
  const id = nativeId(raw.id);
  const issueKey = text(raw.issueKey);
  if (!ISSUE_KEY.test(issueKey)) throw new BacklogReadError("INVALID_PAYLOAD");
  const projectKey = projectKeyOf(issueKey);
  const project = context.projects.get(projectKey) ?? {
    id: String(nativeId(raw.projectId)),
    name: projectKey,
    url: `${context.space.url}/projects/${projectKey}`,
  };
  const state = object(raw.status);
  const description = optionalText(raw.description);
  const edges: WorkEdge[] = [];
  const coverage: ReadCoverage[] = [];

  if (raw.parentIssueId !== null && raw.parentIssueId !== undefined) {
    edges.push({
      to: backlogNodeKey(context.space.spaceKey, nativeId(raw.parentIssueId)),
      relation: "parent_of",
      direction: "incoming",
      nativeRelation: "parent",
      evidence: { kind: "hierarchy", id: String(id) },
    });
  }
  const { children, coverage: childrenCoverage } = await readChildren(context, id);
  if (childrenCoverage) coverage.push(childrenCoverage);
  for (const child of children) {
    const childId = nativeId(child.id);
    edges.push({
      to: backlogNodeKey(context.space.spaceKey, childId),
      relation: "parent_of",
      direction: "outgoing",
      nativeRelation: "parent",
      evidence: { kind: "hierarchy", id: String(childId) },
    });
  }
  const { related, coverage: relatedCoverage } = await readRelated(context, id);
  if (relatedCoverage) coverage.push(relatedCoverage);
  for (const value of related) {
    const otherId = nativeId(value.id);
    if (otherId === id) continue;
    edges.push({
      to: backlogNodeKey(context.space.spaceKey, otherId),
      relation: "related",
      direction: "undirected",
      nativeRelation: "related",
      evidence: { kind: "relation", id: `${Math.min(id, otherId)}-${Math.max(id, otherId)}` },
    });
  }
  const { comments, coverage: commentsCoverage } = await readComments(context, id);
  if (commentsCoverage) coverage.push(commentsCoverage);
  const prose = scanProse(
    [
      { content: description, evidence: "description" },
      ...comments.map((comment) => ({
        content: optionalText(comment.content),
        evidence: `comment:${String(comment.id)}`,
      })),
    ],
    context,
    issueKey,
  );
  for (const [mention, evidence] of prose.refs) {
    const target = await resolveMention(context, mention);
    if (target === undefined || target === id) continue;
    edges.push({
      to: backlogNodeKey(context.space.spaceKey, target),
      relation: "related",
      direction: "outgoing",
      nativeRelation: "text mention",
      evidence: { kind: "relation", id: `${evidence}:${mention}` },
    });
  }

  const stars = list(raw.stars ?? []).map(object);
  const participants = new Set<string>();
  const addUser = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const name = optionalText((value as RecordValue).name);
    if (name) participants.add(name);
  };
  addUser(raw.createdUser);
  addUser(raw.assignee);
  for (const comment of comments) addUser(comment.createdUser);
  for (const star of stars) addUser(star.presenter);

  const byIdentity = new Map(
    edges.map((edge) => [
      `${edge.to}\0${edge.relation}\0${edge.direction}\0${edge.evidence.id}`,
      edge,
    ]),
  );
  const orderedEdges = [...byIdentity.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, edge]) => edge);

  return {
    key: backlogNodeKey(context.space.spaceKey, id),
    provider: "backlog",
    authority: context.space.spaceKey,
    nativeId: String(id),
    kind: "issue",
    identifier: issueKey,
    title: text(raw.summary),
    description: description ?? null,
    url: `${context.space.url}/view/${issueKey}`,
    state: { name: text(state.name), type: raw.resolution ? "completed" : "open" },
    updatedAt: text(raw.updated),
    archived: false,
    project,
    fetched: true,
    depth,
    edges: orderedEdges,
    externalLinks: prose.links,
    coverage,
    heat: {
      createdAt: text(raw.created),
      comments: comments.length,
      participants: participants.size,
      reactions: stars.length,
    },
  };
}

function unavailable(spaceKey: string, id: number, depth: number, error: unknown): WorkNode {
  return {
    key: backlogNodeKey(spaceKey, id),
    provider: "backlog",
    authority: spaceKey,
    nativeId: String(id),
    kind: "issue",
    identifier: String(id),
    title: "Unavailable",
    url: "",
    state: { name: "Unknown", type: "unknown" },
    updatedAt: "",
    archived: false,
    fetched: false,
    error: error instanceof BacklogReadError ? error.code : "READ_FAILED",
    depth,
    edges: [],
    externalLinks: [],
    coverage: [],
  };
}

function validateOptions(options: BacklogGraphOptions): void {
  for (const [name, value, minimum, maximum] of [
    ["maxDepth", options.maxDepth, 0, 8],
    ["maxNodes", options.maxNodes, 1, 1000],
    ["hubThreshold", options.hubThreshold, 1, 1000],
    ["concurrency", options.concurrency ?? 4, 1, 32],
    ["maxPages", options.maxPages, 1, 100],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  if (options.space && !SPACE.test(options.space)) throw new Error("Invalid Backlog space key");
}

function limitsOf(options: BacklogGraphOptions) {
  return {
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    hubThreshold: options.hubThreshold,
    concurrency: options.concurrency ?? 4,
    maxPages: options.maxPages,
  };
}

export async function buildBacklogGraph(
  reader: BacklogReader,
  seed: string,
  options: BacklogGraphOptions,
): Promise<BacklogReport> {
  const locator = parseBacklogLocator(seed);
  validateOptions(options);
  if (locator.space && options.space && locator.space !== options.space.toLowerCase())
    throw new Error("Backlog URL and --space disagree");
  const space = await readSpace(reader, {
    space: locator.space ?? options.space,
    domain: locator.domain,
  });
  const projects = await readProjects(reader, space);
  const context = readContext(reader, space, projects, options.maxPages);
  const first = await readNode(context, locator.id, 0);
  if (first.identifier.toUpperCase() !== locator.id)
    throw new BacklogReadError("IDENTITY_MISMATCH");
  const limits = limitsOf(options);
  const { nodes, cappedOut } = await crawlGraph(
    [{ key: first.key }],
    limits,
    async (key, depth) => {
      if (key === first.key) return first;
      const prefix = `backlog:${space.spaceKey}:issue:`;
      if (!key.startsWith(prefix)) throw new BacklogReadError("SPACE_MISMATCH");
      const id = nativeId(key.slice(prefix.length));
      try {
        return await readNode(context, id, depth);
      } catch (error) {
        return unavailable(space.spaceKey, id, depth, error);
      }
    },
  );
  const values = [...nodes.values()];
  const coverage = {
    failed: values.filter((node) => !node.fetched).map((node) => node.key),
    partial: values
      .filter((node) => node.coverage.some((part) => !part.complete))
      .map((node) => node.key),
    cappedOut: [...cappedOut].sort(),
    hubs: values.filter((node) => node.hub).map((node) => node.key),
    depthBoundaries: values
      .filter(
        (node) => node.depth === limits.maxDepth && node.edges.some((edge) => !nodes.has(edge.to)),
      )
      .map((node) => node.key),
  };
  const statusIds = first.project ? await openStatusIds(reader, first.project.id) : [];
  return {
    schemaVersion: 1,
    source: "backlog",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    space,
    project: first.project,
    openCount: first.project
      ? await countBacklogProjectOpen(reader, first.project.id, statusIds)
      : undefined,
    seeds: [first.key],
    scope: {
      issues: "neighborhood",
      relationships: ["parent", "children", "related", "text mentions", "links"],
      externalLinks: "reported-not-fetched",
      textReferences: "collected",
      archived: "issues-included-links-excluded",
    },
    limits,
    coverageComplete:
      !coverage.failed.length &&
      !coverage.partial.length &&
      !coverage.cappedOut.length &&
      !coverage.hubs.length,
    coverage,
    nodes: values,
    components: components(nodes),
  };
}

export async function countBacklogProjectOpen(
  reader: BacklogReader,
  projectId: string | number,
  statusIds: number[],
): Promise<OpenItemCount | undefined> {
  if (!reader.countIssues || !statusIds.length) return undefined;
  try {
    const body = object(await reader.countIssues(projectId, statusIds));
    const count = typeof body.count === "number" ? body.count : Number(text(body.count));
    if (!Number.isSafeInteger(count) || count < 0) throw new BacklogReadError("INVALID_PAYLOAD");
    return {
      value: count,
      issues: count,
      complete: true,
      observedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

export async function buildBacklogProject(
  reader: BacklogReader,
  projectRef: string,
  options: BacklogGraphOptions,
): Promise<BacklogReport> {
  validateOptions(options);
  if (!reader.projectIssues) throw new Error("Project issue listing is unavailable in this reader");
  const space = await readSpace(reader, { space: options.space });
  const rawProject = object(await reader.project(projectRef));
  const projectKey = text(rawProject.projectKey).toUpperCase();
  const project: WorkProject = {
    id: String(nativeId(rawProject.id)),
    name: optionalText(rawProject.name) ?? projectKey,
    url: `${space.url}/projects/${projectKey}`,
  };
  const projects = await readProjects(reader, space);
  projects.set(projectKey, project);
  const context = readContext(reader, space, projects, options.maxPages);
  const statusIds = await openStatusIds(reader, project.id);
  const inventory: ReadCoverage = { source: "project issues", pages: 0, complete: false };
  const listed = new Map<number, string>();
  try {
    for (let page = 0; page < options.maxPages; page++) {
      const batch = list(
        await reader.projectIssues(project.id, options.includeClosed ? [] : statusIds, {
          offset: page * BACKLOG_PAGE_SIZE,
          count: BACKLOG_PAGE_SIZE,
        }),
      );
      inventory.pages++;
      for (const value of batch) {
        const item = object(value);
        listed.set(nativeId(item.id), text(item.issueKey));
      }
      if (batch.length < BACKLOG_PAGE_SIZE) {
        inventory.complete = true;
        break;
      }
      if (listed.size >= options.maxNodes) break;
    }
    if (!inventory.complete)
      inventory.reason = listed.size >= options.maxNodes ? "node-limit" : "page-limit";
  } catch {
    inventory.reason = "read-failed";
  }
  const ids = [...listed.keys()].sort((a, b) => a - b);
  const selected = ids.slice(0, options.maxNodes);
  const values: WorkNode[] = new Array(selected.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 4, selected.length) }, async () => {
      while (next < selected.length) {
        const index = next++;
        const id = selected[index];
        try {
          values[index] = await readNode(context, id, 0);
        } catch (error) {
          values[index] = { ...unavailable(space.spaceKey, id, 0, error), project };
        }
      }
    }),
  );
  const nodes = new Map(values.map((node) => [node.key, node]));
  const coverage = {
    failed: values.filter((node) => !node.fetched).map((node) => node.key),
    partial: values
      .filter((node) => node.coverage.some((part) => !part.complete))
      .map((node) => node.key),
    cappedOut: ids.slice(options.maxNodes).map((id) => backlogNodeKey(space.spaceKey, id)),
    hubs: [],
    depthBoundaries: [],
  };
  const notes = [
    options.includeClosed
      ? "Closed issues are included because --all was set."
      : "Issues in the project's last status are treated as closed and excluded; use --all to include them.",
    "Connections outside this project are retained without fetching those issues.",
  ];
  if (!options.includeClosed && !statusIds.length)
    notes.push("No project statuses were readable, so the listing may include closed issues.");
  return {
    schemaVersion: 1,
    source: "backlog",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    space,
    project,
    openCount: await countBacklogProjectOpen(reader, project.id, statusIds),
    inventory,
    seeds: [],
    scope: {
      issues: "project",
      relationships: ["parent", "children", "related", "text mentions", "links"],
      externalLinks: "reported-not-fetched",
      textReferences: "collected",
      archived: options.includeClosed ? "issues-included-links-excluded" : "excluded",
      notes,
    },
    limits: { ...limitsOf(options), maxDepth: 0 },
    coverageComplete:
      inventory.complete &&
      !coverage.failed.length &&
      !coverage.partial.length &&
      !coverage.cappedOut.length,
    coverage,
    nodes: values,
    components: components(nodes),
  };
}

function markdown(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
}

export function renderBacklog(report: BacklogReport): string {
  const lines = [
    `# Backlog graph · ${markdown(report.space.name)}`,
    "",
    `Coverage: ${report.coverageComplete ? "complete within requested scope" : "partial"} · ${report.nodes.length} nodes · ${report.scope.issues === "project" ? "project capture" : `depth ${report.limits.maxDepth}`}`,
    "",
    "Parent/child, related issues, and issue keys mentioned in descriptions and comments. Links are reported without fetching their targets.",
    "",
  ];
  const labels = new Map(report.nodes.map((node) => [node.key, node.identifier]));
  for (const node of report.nodes) {
    lines.push(
      `## ${markdown(node.identifier)} · ${markdown(node.title)}`,
      "",
      `Status: ${markdown(node.state.name)}${node.hub ? " · hub not expanded" : ""}`,
      "",
    );
    if (node.url) lines.push(node.url, "");
    if (!node.fetched) lines.push(`Read failed: ${node.error}`, "");
    for (const edge of node.edges) {
      const arrow =
        edge.direction === "incoming" ? "←" : edge.direction === "undirected" ? "↔" : "→";
      const native = edge.nativeRelation === "parent" ? "parent" : edge.nativeRelation;
      lines.push(`- ${arrow} ${markdown(native)}: ${markdown(labels.get(edge.to) ?? edge.to)}`);
    }
    for (const link of node.externalLinks)
      lines.push(`- Link: ${markdown(link.title)} · ${markdown(link.url)}`);
    for (const part of node.coverage.filter((item) => !item.complete))
      lines.push(`- Incomplete ${part.source}: ${part.reason}`);
    lines.push("");
  }
  if (report.coverage.cappedOut.length)
    lines.push(`Node cap: ${report.coverage.cappedOut.length} known issues not fetched.`, "");
  if (report.inventory && !report.inventory.complete)
    lines.push(`Project list incomplete: ${report.inventory.reason ?? "read incomplete"}.`, "");
  if (report.coverage.depthBoundaries.length)
    lines.push(`Depth boundary: ${report.coverage.depthBoundaries.length} nodes not expanded.`, "");
  return `${lines.join("\n")}\n`;
}
