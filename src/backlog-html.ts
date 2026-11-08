import type { BacklogReport } from "./backlog.js";
import type { ClientNode, Model } from "./html.js";
import { workClusterGroups } from "./work-clusters.js";
import type { WorkEdge, WorkNode } from "./work-types.js";

const BACKLOG_SVG =
  '<svg class="backlog-mark" width="14" height="14" role="img" aria-label="Backlog" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h9.5a5.5 5.5 0 0 1 3.4 9.8A5.5 5.5 0 0 1 13 21H3V3Zm4 4v3.5h5a1.75 1.75 0 1 0 0-3.5H7Zm0 7v3.5h5.5a1.75 1.75 0 1 0 0-3.5H7Z"/></svg>';

function state(node: WorkNode): string {
  if (!node.fetched) return "UNKNOWN";
  return ["completed", "canceled", "duplicate"].includes(node.state.type) ? "CLOSED" : "OPEN";
}

function labels(edge: WorkEdge): [string, string] {
  if (edge.relation === "parent_of") return ["parent of", "child of"];
  if (edge.relation === "blocks") return ["blocks", "blocked by"];
  if (edge.relation === "duplicate_of") return ["duplicate of", "has duplicate"];
  return [edge.nativeRelation, `${edge.nativeRelation} (incoming)`];
}

export function backlogDashboardModel(
  report: BacklogReport,
  clusters?: unknown,
): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const nodes: Record<string, ClientNode> = {};
  for (const node of report.nodes) {
    if (
      report.project !== undefined &&
      node.fetched &&
      report.project !== null &&
      node.project?.id !== report.project.id
    )
      continue;
    nodes[node.key] = {
      key: node.key,
      num: 0,
      identifier: node.identifier,
      repo: report.space.spaceKey,
      kind: "Issue",
      state: state(node),
      stateLabel: node.state.name,
      stateType: node.state.type,
      archived: node.archived,
      read: { fetched: node.fetched, error: node.error, coverage: node.coverage },
      title: node.title,
      url: node.url,
      depth: node.depth,
      seed: seeds.has(node.key),
      flags: [
        ...(node.hub ? ["Hub not expanded"] : []),
        ...(!node.fetched ? ["Issue unavailable"] : []),
        ...(node.coverage.some((part) => !part.complete) ? ["Incomplete connections"] : []),
      ],
      mentionedBy: [],
      external: node.externalLinks.map((link) => link.url),
      attachments: node.externalLinks,
      out: [],
      in: [],
      overlaps: [],
    };
  }
  const seen = new Set<string>();
  for (const node of report.nodes) {
    for (const edge of node.edges) {
      let from = edge.direction === "incoming" ? edge.to : node.key;
      let to = edge.direction === "incoming" ? node.key : edge.to;
      const undirected = edge.direction === "undirected";
      if (undirected && from > to) [from, to] = [to, from];
      const key = JSON.stringify([from, to, edge.nativeRelation, edge.evidence]);
      if (seen.has(key)) continue;
      seen.add(key);
      const [outLabel, inLabel] = labels(edge);
      nodes[from]?.out.push({ to, via: outLabel, undirected, evidence: edge.evidence });
      if (undirected)
        nodes[to]?.out.push({
          to: from,
          via: outLabel,
          undirected: true,
          evidence: edge.evidence,
        });
      else nodes[to]?.in.push({ from, via: inLabel, evidence: edge.evidence });
    }
  }
  const warnings: string[] = [];
  for (const [keys, label] of [
    [report.coverage.failed, "issues unavailable"],
    [report.coverage.partial, "issues with incomplete connections"],
    [report.coverage.cappedOut, "known issues omitted by the node limit"],
    [report.coverage.hubs, "hubs not expanded"],
  ] as const)
    if (keys.length) warnings.push(`${keys.length} ${label}`);
  if (report.inventory && !report.inventory.complete)
    warnings.push(`Project issue list incomplete: ${report.inventory.reason ?? "read incomplete"}`);
  const messages = [
    `Source: ${report.readSource ?? "Backlog API"}.`,
    report.scope.issues === "project"
      ? "Project issues and their explicit connections."
      : `Issue neighborhood, up to ${report.limits.maxDepth} relationship steps.`,
    ...(report.scope.notes ?? []),
  ];
  if (report.coverage.depthBoundaries.length)
    messages.push(`${report.coverage.depthBoundaries.length} issues at the depth boundary`);
  messages.push(
    "Issue keys in descriptions and comments are collected as text mentions.",
    "Links are listed without being fetched.",
  );
  if (report.scope.archived === "excluded")
    messages.push("Issues in the project's closed status are outside this capture.");
  const omitted = report.nodes.length - Object.keys(nodes).length;
  if (omitted) messages.push(`${omitted} issues outside this project are omitted from this view.`);
  if (clusters !== undefined)
    messages.push(
      "Themes are proposed groupings, not verified common root causes. Native relationships are unchanged.",
    );
  const all = Object.values(nodes);
  const scopeId = report.project ? `project:${report.project.id}` : "unscoped";
  const scopeName = report.project?.name ?? "Unscoped capture";
  return {
    id: `backlog:${report.space.spaceKey}:${scopeId}`,
    label: `${report.space.name} / ${scopeName}`,
    url: report.project?.url ?? report.space.url,
    openCount: report.openCount,
    grouping: clusters === undefined ? "components" : "themes",
    provider: {
      id: "backlog",
      name: "Backlog",
      logo: BACKLOG_SVG,
      repoUrl: `https://{repo}.${report.space.domain}`,
      signals: [],
      views: ["explore", "swarm"],
      metrics: ["links", "depth"],
    },
    repo: report.space.spaceKey,
    seeds: report.seeds.filter((key) => nodes[key]),
    groups:
      clusters !== undefined
        ? workClusterGroups(Object.keys(nodes), clusters)
        : report.components
            .map((members, index) => ({
              label: `Component ${index + 1}`,
              subtitle:
                members.length === 1
                  ? "No explicit relationships"
                  : (report.nodes.find((node) => seeds.has(node.key) && members.includes(node.key))
                      ?.title ?? "Connected by explicit relationships"),
              members: members.filter((key) => nodes[key]),
            }))
            .filter((group) => group.members.length),
    cleanup: [],
    stats: {
      nodes: all.length,
      openIssues: all.filter((node) => node.state === "OPEN" && !node.archived).length,
      archived: all.filter((node) => node.archived).length,
    },
    nodes,
    coverage: {
      complete: report.coverageComplete && !warnings.length,
      generatedAt: report.generatedAt,
      maxDepth: report.limits.maxDepth,
      messages,
      warnings,
    },
  };
}
