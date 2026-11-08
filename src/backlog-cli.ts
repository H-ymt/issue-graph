import {
  type BacklogGraphOptions,
  type BacklogReport,
  buildBacklogGraph,
  buildBacklogProject,
  parseBacklogLocator,
  renderBacklog,
} from "./backlog.js";
import { backlogDashboardModel } from "./backlog-html.js";
import { type BacklogReader, parseBacklogHost } from "./backlog-queries.js";
import { parseWorkClusters, workClusterPrompt } from "./work-clusters.js";

export const BACKLOG_USAGE = `usage: issue-graph backlog <issue-url|issue-key> [options]
       issue-graph backlog --project <project-key|project-id>

Read explicit Backlog relationships, hierarchy, and issue keys mentioned in text.

  --project REF         capture a whole project instead of an issue neighborhood
  --space SPACE         require this space key or host (also checked against issue URLs)
  --all                 project capture: include issues in the project's last (closed) status
  --depth N             relationship depth, 0..8 (default 1)
  --max-nodes N         node cap, 1..1000 (default 80)
  --max-pages N         pages per collection per issue, 1..100 (default 5)
  --hub-threshold N     stop expanding non-seed hubs, 1..1000 (default 12)
  --concurrency N       issue reads in flight, 1..32 (default 4)
  --json                print JSON to stdout
  --html PATH           write an HTML explorer and save this capture to the dashboard
  --open                open the HTML explorer (creates a temporary file if needed)
  --no-save             do not save this run to the dashboard
  --cluster             print a thematic clustering task for the calling agent
  --clusters PATH       apply proposed themes from JSON to --html or --open
  -h, --help            show help without authentication or network

Set BACKLOG_SPACE (key or host, e.g. globetails.backlog.jp) and exactly one of
BACKLOG_API_KEY or BACKLOG_ACCESS_TOKEN.
Only reads are sent (GET). Local files are written only with --html or --open.
Open issue counts treat the project's last status in display order as closed.
Exit codes: 0 complete within scope, 1 partial or failed, 2 invalid usage.`;

export interface BacklogIO {
  stdout(value: string): void;
  stderr(value: string): void;
  dashboard?(
    report: BacklogReport,
    options: { path?: string; open: boolean; save: boolean; clusters?: unknown },
  ): Promise<void>;
  readClusters?(path: string): Promise<unknown>;
}

export function backlogSetupGuide(): string {
  return `Backlog is not connected.

  export BACKLOG_SPACE=your-space        # globetails, or globetails.backlog.jp
  export BACKLOG_API_KEY=...             # personal API key (read access)

Check with: issue-graph auth status
`;
}

export async function runBacklog(
  argv: string[],
  reader: () => BacklogReader | Promise<BacklogReader>,
  io: BacklogIO,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(`${BACKLOG_USAGE}\n`);
    return 0;
  }
  const options: BacklogGraphOptions = {
    maxDepth: 1,
    maxNodes: 80,
    maxPages: 5,
    hubThreshold: 12,
    concurrency: 4,
    space: undefined,
    includeClosed: false,
  };
  const integers = {
    "--depth": ["maxDepth", 0, 8],
    "--max-nodes": ["maxNodes", 1, 1000],
    "--max-pages": ["maxPages", 1, 100],
    "--hub-threshold": ["hubThreshold", 1, 1000],
    "--concurrency": ["concurrency", 1, 32],
  } as const;
  let seed: string | undefined;
  let project: string | undefined;
  let json = false;
  let htmlPath: string | undefined;
  let open = false;
  let save = true;
  let cluster = false;
  let clustersPath: string | undefined;
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === "--json") json = true;
      else if (arg === "--open") open = true;
      else if (arg === "--all") options.includeClosed = true;
      else if (arg === "--no-save" || arg === "--no-snapshot") {
        if (arg === "--no-snapshot")
          io.stderr("note: --no-snapshot is deprecated; use --no-save\n");
        save = false;
      } else if (arg === "--cluster") cluster = true;
      else if (arg === "--clusters") {
        const value = argv[++index];
        if (!value || value.startsWith("-")) throw new Error("--clusters requires a JSON path");
        clustersPath = value;
      } else if (arg === "--html") {
        const value = argv[++index];
        if (!value || value.startsWith("-")) throw new Error("--html requires an output path");
        htmlPath = value;
      } else if (arg === "--project") {
        const value = argv[++index];
        if (!value || !/^(?:[a-z][a-z0-9_]*|\d+)$/i.test(value))
          throw new Error("--project requires a project key or numeric id");
        project = value;
      } else if (arg === "--space") {
        const value = argv[++index];
        const parsed = value ? parseBacklogHost(value) : undefined;
        if (!parsed) throw new Error("--space requires a Backlog space key or host");
        options.space = parsed.space;
      } else if (Object.hasOwn(integers, arg)) {
        const [name, minimum, maximum] = integers[arg as keyof typeof integers];
        const raw = argv[++index];
        const value = Number(raw);
        if (!raw || !/^\d+$/.test(raw) || value < minimum || value > maximum)
          throw new Error(`${arg} must be an integer from ${minimum} to ${maximum}`);
        options[name] = value;
      } else if (arg.startsWith("-")) throw new Error(`Unknown Backlog flag: ${arg}`);
      else if (seed) throw new Error("Specify exactly one Backlog issue");
      else seed = arg;
    }
    if (!seed && !project) throw new Error("Specify a Backlog issue or --project");
    if (seed && project) throw new Error("Choose an issue neighborhood or --project");
    if (clustersPath && !htmlPath && !open) throw new Error("--clusters requires --html or --open");
    if (cluster && json) throw new Error("--cluster cannot be combined with --json");
    if (seed) {
      const locator = parseBacklogLocator(seed);
      if (locator.space && options.space && locator.space !== options.space)
        throw new Error("Backlog URL and --space disagree");
    }
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Invalid Backlog arguments"}\n`);
    return 2;
  }
  try {
    let clusters: unknown;
    if (clustersPath) {
      if (!io.readClusters) throw new Error("Cluster file input is unavailable in this caller");
      clusters = parseWorkClusters(await io.readClusters(clustersPath));
    }
    const source = await reader();
    const report = project
      ? await buildBacklogProject(source, project, options)
      : await buildBacklogGraph(source, seed as string, options);
    if (source.label) report.readSource = source.label;
    if (htmlPath || open) {
      if (!io.dashboard) throw new Error("HTML output is unavailable in this caller");
      await io.dashboard(report, { path: htmlPath, open, save, clusters });
    }
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderBacklog(report));
    if (cluster) {
      const model = backlogDashboardModel(report);
      io.stdout(
        `\n${workClusterPrompt(
          model.label ?? report.space.name,
          report.nodes.filter((node) => model.nodes[node.key]),
        )}\n`,
      );
    }
    return report.coverageComplete ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Backlog read failed"}\n`);
    return 1;
  }
}
