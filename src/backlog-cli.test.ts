import { describe, expect, test } from "vitest";
import { fixtureReader, options } from "../tests/backlog-fixtures.js";
import type { BacklogReport } from "./backlog.js";
import { runBacklog } from "./backlog-cli.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (value: string) => out.push(value),
    stderr: (value: string) => err.push(value),
  };
}

describe("Backlog CLI", () => {
  test("prints usage without touching the reader", async () => {
    const sink = io();
    let reads = 0;
    const code = await runBacklog(
      ["--help"],
      () => {
        reads++;
        return fixtureReader();
      },
      sink,
    );
    expect(code).toBe(0);
    expect(reads).toBe(0);
    expect(sink.out.join("")).toContain("issue-graph backlog");
  });
  test.each([
    [[], "Specify a Backlog issue"],
    [["PROJ-1", "--project", "PROJ"], "Choose an issue neighborhood"],
    [["PROJ-1", "--clusters", "c.json"], "--clusters requires --html"],
    [["PROJ-1", "--cluster", "--json"], "--cluster cannot be combined"],
    [["PROJ-1", "--depth", "9"], "--depth must be an integer"],
    [["PROJ-1", "--project", "bad key"], "--project requires"],
    [["PROJ-1", "--nope"], "Unknown Backlog flag"],
    [["https://other.backlog.com/view/PROJ-1", "--space", "fixture"], "disagree"],
  ])("rejects %o with a usage error", async (argv, message) => {
    const sink = io();
    const code = await runBacklog(argv, () => fixtureReader(), sink);
    expect(code).toBe(2);
    expect(sink.err.join("")).toContain(message);
  });
  test("prints the report as JSON", async () => {
    const sink = io();
    const code = await runBacklog(["PROJ-1", "--json"], () => fixtureReader(), sink);
    expect(code).toBe(0);
    const report = JSON.parse(sink.out.join("")) as BacklogReport;
    expect(report.source).toBe("backlog");
    expect(report.nodes).toHaveLength(1);
  });
  test("writes the dashboard with clusters and saves unless --no-save", async () => {
    const sink = io();
    let seen: { path?: string; open: boolean; save: boolean; clusters?: unknown } | undefined;
    const code = await runBacklog(
      ["PROJ-1", "--html", "out.html", "--clusters", "clusters.json"],
      () => fixtureReader(),
      {
        ...sink,
        readClusters: async () => [
          { label: "Uploads", members: [{ key: "backlog:fixture:issue:1" }] },
        ],
        dashboard: async (_report, opts) => {
          seen = opts;
        },
      },
    );
    expect(code).toBe(0);
    expect(seen).toEqual({
      path: "out.html",
      open: false,
      save: true,
      clusters: [{ label: "Uploads", members: [{ key: "backlog:fixture:issue:1" }] }],
    });
  });
  test("passes limits and the all flag to project capture", async () => {
    const sink = io();
    const reader = fixtureReader();
    await runBacklog(
      ["--project", "PROJ", "--all", "--max-nodes", "3", "--space", "fixture", "--json"],
      () => reader,
      sink,
    );
    const report = JSON.parse(sink.out.join("")) as BacklogReport;
    expect(report.limits).toEqual({
      maxDepth: 0,
      maxNodes: 3,
      maxPages: options.maxPages,
      hubThreshold: options.hubThreshold,
      concurrency: options.concurrency,
    });
    expect(report.scope.archived).toBe("issues-included-links-excluded");
  });
  test("prints a clustering task after the report", async () => {
    const sink = io();
    const code = await runBacklog(["PROJ-1", "--cluster"], () => fixtureReader(), sink);
    expect(code).toBe(0);
    expect(sink.out.join("")).toContain("Issue 1");
  });
});
