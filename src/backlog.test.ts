import { describe, expect, test } from "vitest";
import { fixtureReader, issue, key, options } from "../tests/backlog-fixtures.js";
import {
  backlogNodeKey,
  buildBacklogGraph,
  buildBacklogProject,
  parseBacklogLocator,
  renderBacklog,
} from "./backlog.js";

describe("Backlog identity", () => {
  test.each([
    "PROJ-1",
    "proj-1",
    "https://fixture.backlog.com/view/PROJ-1",
    "https://fixture.backlog.com/view/PROJ-1/",
    "https://fixture.backlog.com/view/PROJ-1#comment-1",
  ])("resolves %s into a space-scoped identity", async (seed) => {
    const report = await buildBacklogGraph(fixtureReader(), seed, options);
    expect(report.seeds).toEqual([key(1)]);
    expect(report.space).toEqual({
      spaceKey: "fixture",
      name: "Fixture",
      url: "https://fixture.backlog.com",
      domain: "backlog.com",
    });
    expect(report.nodes[0].key).toBe(backlogNodeKey("fixture", 1));
    expect(report.nodes[0].url).toBe("https://fixture.backlog.com/view/PROJ-1");
    expect(report.coverageComplete).toBe(true);
  });
  test.each([
    "",
    "PROJ",
    "PROJ-0",
    "#1",
    "http://fixture.backlog.com/view/PROJ-1",
    "https://user@fixture.backlog.com/view/PROJ-1",
    "https://fixture.backlog.com:8443/view/PROJ-1",
    "https://sub.fixture.backlog.com/view/PROJ-1",
    "https://fixture.backlog.com.evil.example/view/PROJ-1",
    "https://example.com/fixture/view/PROJ-1",
  ])("rejects invalid locator %s", (seed) => expect(() => parseBacklogLocator(seed)).toThrow());
  test("resolves a legacy backlog.jp space", () => {
    expect(parseBacklogLocator("https://globetails.backlog.jp/view/PROJ-1")).toEqual({
      id: "PROJ-1",
      space: "globetails",
      domain: "backlog.jp",
    });
  });
  test("checks the URL domain against the connected host", async () => {
    await expect(
      buildBacklogGraph(fixtureReader(), "https://globetails.backlog.jp/view/PROJ-1", options),
    ).rejects.toThrow("SPACE_MISMATCH");
  });
  test("checks the URL space before the crawl starts", async () => {
    await expect(
      buildBacklogGraph(fixtureReader(), "https://another.backlog.com/view/PROJ-1", options),
    ).rejects.toThrow("SPACE_MISMATCH");
  });
  test("rejects an issue the reader returns under a different key", async () => {
    const reader = fixtureReader({ issues: [issue(1), issue(2)] });
    reader.issue = async () => issue(2);
    await expect(buildBacklogGraph(reader, "PROJ-1", options)).rejects.toThrow("IDENTITY_MISMATCH");
  });
});

describe("Backlog nodes", () => {
  test("maps status, resolution, project, and discussion heat", async () => {
    const reader = fixtureReader({
      issues: [
        issue(1, {
          summary: "Broken upload",
          assignee: { id: 2, name: "reviewer" },
          stars: [{ id: 1, presenter: { id: 3, name: "starrer" } }],
        }),
      ],
      comments: { 1: [{ id: 10, content: "same here", createdUser: { id: 4, name: "reporter" } }] },
    });
    const report = await buildBacklogGraph(reader, "PROJ-1", options);
    const node = report.nodes[0];
    expect(node).toMatchObject({
      provider: "backlog",
      authority: "fixture",
      nativeId: "1",
      identifier: "PROJ-1",
      kind: "issue",
      url: "https://fixture.backlog.com/view/PROJ-1",
      state: { name: "Open", type: "open" },
      updatedAt: "2026-11-02T00:00:00Z",
      archived: false,
      project: { id: "1", name: "PROJ project", url: "https://fixture.backlog.com/projects/PROJ" },
      heat: {
        createdAt: "2026-11-01T00:00:00Z",
        comments: 1,
        participants: 4,
        reactions: 1,
      },
    });
  });
  test("treats a resolvable issue as completed", async () => {
    const report = await buildBacklogGraph(
      fixtureReader({
        issues: [
          issue(1, { resolution: { id: 0, name: "Done" }, status: { id: 4, name: "Closed" } }),
        ],
      }),
      "PROJ-1",
      options,
    );
    expect(report.nodes[0].state).toEqual({ name: "Closed", type: "completed" });
  });
  test("keeps the default project when the project list is unreadable", async () => {
    const reader = fixtureReader();
    reader.projects = undefined;
    const report = await buildBacklogGraph(reader, "PROJ-1", options);
    expect(report.nodes[0].project).toEqual({
      id: "1",
      name: "PROJ",
      url: "https://fixture.backlog.com/projects/PROJ",
    });
  });
});

describe("Backlog relationships", () => {
  test("records parent, children, and related issues with native direction", async () => {
    const reader = fixtureReader({
      issues: [issue(1), issue(2, { parentIssueId: 1 }), issue(3)],
      related: { 1: [3] },
    });
    const report = await buildBacklogGraph(reader, "PROJ-1", { ...options, maxDepth: 0 });
    expect(report.nodes[0].edges).toEqual([
      {
        to: key(2),
        relation: "parent_of",
        direction: "outgoing",
        nativeRelation: "parent",
        evidence: { kind: "hierarchy", id: "2" },
      },
      {
        to: key(3),
        relation: "related",
        direction: "undirected",
        nativeRelation: "related",
        evidence: { kind: "relation", id: "1-3" },
      },
    ]);
    expect(reader.calls).toContain("children:1:0");
    expect(reader.calls).toContain("related:1");
  });
  test("keeps an incoming parent edge from parentIssueId", async () => {
    const reader = fixtureReader({ issues: [issue(1, { parentIssueId: 7 }), issue(7)] });
    const report = await buildBacklogGraph(reader, "PROJ-1", { ...options, maxDepth: 0 });
    expect(report.nodes[0].edges).toEqual([
      {
        to: key(7),
        relation: "parent_of",
        direction: "incoming",
        nativeRelation: "parent",
        evidence: { kind: "hierarchy", id: "1" },
      },
    ]);
  });
  test("reads issue keys from the description and comments, ignoring lookalikes", async () => {
    const reader = fixtureReader({
      issues: [
        issue(1, {
          description: "Blocked by PROJ-2.\nEncoding is UTF-8, not PROJ-0.",
        }),
        issue(2),
        issue(3),
      ],
      comments: { 1: [{ id: 10, content: "see https://fixture.backlog.com/view/PROJ-3" }] },
    });
    const report = await buildBacklogGraph(reader, "PROJ-1", { ...options, maxDepth: 0 });
    expect(report.nodes[0].edges.map((edge) => [edge.to, edge.nativeRelation])).toEqual([
      [key(2), "text mention"],
      [key(3), "text mention"],
    ]);
    expect(report.nodes[0].edges.map((edge) => edge.evidence.id)).toEqual([
      "description:PROJ-2",
      "comment:10:PROJ-3",
    ]);
  });
  test("reports links from prose without fetching them", async () => {
    const reader = fixtureReader({
      issues: [
        issue(1, { description: "Design https://example.com/spec and https://example.com/spec" }),
      ],
    });
    const report = await buildBacklogGraph(reader, "PROJ-1", options);
    expect(report.nodes[0].externalLinks).toEqual([
      {
        url: "https://example.com/spec",
        title: "example.com",
        evidence: { kind: "attachment", id: "https://example.com/spec" },
      },
    ]);
    expect(report.nodes[0].edges).toEqual([]);
  });
  test("ignores mentions that cannot be resolved", async () => {
    const report = await buildBacklogGraph(
      fixtureReader({ issues: [issue(1, { description: "duplicate of PROJ-99" })] }),
      "PROJ-1",
      options,
    );
    expect(report.nodes[0].edges).toEqual([]);
    expect(report.coverageComplete).toBe(true);
  });
});

describe("Backlog crawl bounds", () => {
  const chain = () =>
    fixtureReader({
      issues: [issue(1), issue(2, { parentIssueId: 1 }), issue(3, { parentIssueId: 2 })],
    });
  test("follows relationships only to the requested depth", async () => {
    const one = await buildBacklogGraph(chain(), "PROJ-1", { ...options, maxDepth: 1 });
    expect(one.nodes.map((node) => node.identifier).sort()).toEqual(["PROJ-1", "PROJ-2"]);
    expect(one.coverage.depthBoundaries).toEqual([key(2)]);
    expect(one.coverageComplete).toBe(true);
    const two = await buildBacklogGraph(chain(), "PROJ-1", { ...options, maxDepth: 2 });
    expect(two.nodes.map((node) => node.identifier).sort()).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
  });
  test("records nodes dropped by the node cap", async () => {
    const report = await buildBacklogGraph(chain(), "PROJ-1", {
      ...options,
      maxDepth: 2,
      maxNodes: 2,
    });
    expect(report.coverage.cappedOut).toEqual([key(3)]);
    expect(report.coverageComplete).toBe(false);
  });
  test("records a failed read without failing the crawl", async () => {
    const reader = chain();
    const find = reader.issue;
    reader.issue = async (id) => {
      if (String(id) === "2") throw new Error("boom");
      return find(id);
    };
    const report = await buildBacklogGraph(reader, "PROJ-1", { ...options, maxDepth: 2 });
    const failed = report.nodes.find((node) => node.key === key(2));
    expect(failed).toMatchObject({ fetched: false, error: "READ_FAILED", title: "Unavailable" });
    expect(report.coverage.failed).toEqual([key(2)]);
  });
  test("stops expanding hubs and reports them", async () => {
    const reader = fixtureReader({
      issues: [issue(1), issue(2, { parentIssueId: 1 }), issue(3, { parentIssueId: 2 })],
    });
    const report = await buildBacklogGraph(reader, "PROJ-1", {
      ...options,
      maxDepth: 3,
      hubThreshold: 1,
    });
    expect(report.coverage.hubs).toEqual([key(2)]);
    expect(report.coverageComplete).toBe(false);
  });
  test("marks capped comment reads as partial", async () => {
    const comments = Array.from({ length: 150 }, (_, index) => ({
      id: index + 1,
      content: `comment ${index + 1}`,
    }));
    const report = await buildBacklogGraph(fixtureReader({ comments: { 1: comments } }), "PROJ-1", {
      ...options,
      maxPages: 1,
    });
    expect(report.nodes[0].heat?.comments).toBe(100);
    expect(report.nodes[0].coverage).toEqual([
      { source: "children", pages: 1, complete: true },
      { source: "relatedIssues", pages: 1, complete: true },
      { source: "comments", pages: 1, complete: false, reason: "page-limit" },
    ]);
    expect(report.coverageComplete).toBe(false);
  });
  test("is deterministic across concurrency settings", async () => {
    const results: string[] = [];
    for (const concurrency of [1, 4]) {
      const report = await buildBacklogGraph(chain(), "PROJ-1", { ...options, concurrency });
      results.push(JSON.stringify(report.nodes));
    }
    expect(results[0]).toBe(results[1]);
  });
});

describe("Backlog project capture", () => {
  const reader = () =>
    fixtureReader({
      issues: [
        issue(1),
        issue(2, { status: { id: 2, name: "In progress" } }),
        issue(3, { status: { id: 4, name: "Closed" }, resolution: { id: 0, name: "Done" } }),
      ],
    });
  test("captures the project's open issues and counts them", async () => {
    const report = await buildBacklogProject(reader(), "PROJ", options);
    expect(report.scope.issues).toBe("project");
    expect(report.project).toMatchObject({ name: "PROJ project" });
    expect(report.seeds).toEqual([]);
    expect(report.nodes.map((node) => node.identifier).sort()).toEqual(["PROJ-1", "PROJ-2"]);
    expect(report.openCount).toMatchObject({ value: 2, issues: 2, complete: true });
    expect(report.inventory).toEqual({ source: "project issues", pages: 1, complete: true });
    expect(report.coverageComplete).toBe(true);
  });
  test("includes closed issues with --all and labels the scope", async () => {
    const report = await buildBacklogProject(reader(), "PROJ", {
      ...options,
      includeClosed: true,
    });
    expect(report.nodes.map((node) => node.identifier).sort()).toEqual([
      "PROJ-1",
      "PROJ-2",
      "PROJ-3",
    ]);
    expect(report.scope.archived).toBe("issues-included-links-excluded");
    expect(report.scope.notes?.[0]).toContain("--all");
  });
  test("caps the inventory at maxNodes and orders capped keys", async () => {
    const report = await buildBacklogProject(
      fixtureReader({ issues: [issue(1), issue(2), issue(3), issue(4)] }),
      "1",
      { ...options, maxNodes: 2 },
    );
    expect(report.nodes).toHaveLength(2);
    expect(report.coverage.cappedOut).toEqual([key(3), key(4)]);
    expect(report.coverageComplete).toBe(false);
  });
});

describe("Backlog rendering", () => {
  test("escapes control characters and markdown syntax", async () => {
    const report = await buildBacklogGraph(
      fixtureReader({ issues: [issue(1, { summary: "Heading\n\u001b[31mred *bold*" })] }),
      "PROJ-1",
      options,
    );
    const rendered = renderBacklog(report);
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("\\*bold\\*");
  });
});
