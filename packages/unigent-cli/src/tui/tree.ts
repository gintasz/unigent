import { type AgentUsage, combineUsage } from "@unigent/core";
import type { TraceNode, TraceTree } from "@unigent/core/trace";
import { formatCost, formatDuration, formatTokens } from "../format.js";

type TreeRowKind = TraceNode["kind"] | "scope";

interface TreeRow {
  readonly spanId: string;
  readonly name: string;
  readonly kind: TreeRowKind;
  readonly prefix: string;
  readonly metrics: string;
  readonly outcome: TraceNode["outcome"];
  readonly toolSummary: string | undefined;
  readonly hasTools: boolean;
  readonly toolsExpanded: boolean;
  readonly selectable: boolean;
  readonly scopePath: readonly string[];
  readonly runCount: number;
  readonly usage: AgentUsage;
  readonly nodes: readonly TraceNode[];
  readonly selectedSpanIds: readonly string[];
}

interface TreeDiagnostic {
  readonly kind: "annotation" | "checkpoint" | "error" | "log" | "repair";
  readonly label: string;
  readonly value: unknown;
}

interface MutableScopeGroup {
  readonly name: string;
  readonly path: readonly string[];
  readonly items: OutlineItem[];
  readonly scopes: Map<string, MutableScopeGroup>;
}

type OutlineItem =
  | { readonly kind: "node"; readonly node: TraceNode }
  | { readonly kind: "scope"; readonly group: MutableScopeGroup };

interface OutlineContainer {
  readonly items: OutlineItem[];
  readonly scopes: Map<string, MutableScopeGroup>;
}

const MAX_SUMMARY_TOOL_NAMES = 3;
const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  calls: 0,
};

function nodeMetrics(node: TraceNode): string {
  const parts: string[] = [];
  if (node.repairs > 0) {
    parts.push(`↻${node.repairs}`);
  }
  if (node.durationMs !== undefined) {
    parts.push(formatDuration(node.durationMs));
  }
  if (node.usage.totalTokens > 0) {
    parts.push(formatTokens(node.usage.totalTokens));
  }
  const cost = formatCost(node.usage.costUsd);
  if (cost.length > 0) {
    parts.push(cost);
  }
  return parts.join("  ");
}

function aggregateUsage(nodes: readonly TraceNode[]): AgentUsage {
  return nodes.reduce((usage, node) => combineUsage(usage, node.usage), EMPTY_USAGE);
}

function scopeMetrics(nodes: readonly TraceNode[]): string {
  const usage = aggregateUsage(nodes);
  const parts = [`${nodes.length} ${nodes.length === 1 ? "run" : "runs"}`];
  if (usage.totalTokens > 0) {
    parts.push(formatTokens(usage.totalTokens));
  }
  const cost = formatCost(usage.costUsd);
  if (cost.length > 0) {
    parts.push(cost);
  }
  return parts.join("  ");
}

function aggregateOutcome(nodes: readonly TraceNode[]): TraceNode["outcome"] {
  if (nodes.some((node) => node.outcome === "running")) {
    return "running";
  }
  if (nodes.some((node) => node.outcome === "failed")) {
    return "failed";
  }
  return nodes.some((node) => node.outcome === "cancelled") ? "cancelled" : "succeeded";
}

function summarizeTools(node: TraceNode): string | undefined {
  const counts = new Map<string, number>();
  for (const child of node.children) {
    if (child.kind === "tool") {
      counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
    }
  }
  const summaries = [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`));
  if (summaries.length === 0) {
    return;
  }
  const visible = summaries.slice(0, MAX_SUMMARY_TOOL_NAMES);
  const hidden = summaries.length - visible.length;
  return `tools  ${visible.join(" · ")}${hidden > 0 ? ` · +${hidden}` : ""}`;
}

function nestedRuns(node: TraceNode): readonly TraceNode[] {
  return node.children.flatMap((child) => (child.kind === "run" ? [child] : nestedRuns(child)));
}

function visibleChildren(
  node: TraceNode,
  expandedRunSpanIds: ReadonlySet<string>,
): readonly TraceNode[] {
  if (node.kind === "tool") {
    return node.children;
  }
  return node.children.flatMap((child) => {
    if (child.kind === "run" || expandedRunSpanIds.has(node.spanId)) {
      return [child];
    }
    return nestedRuns(child);
  });
}

function addRootToOutline(container: OutlineContainer, root: TraceNode): void {
  let current = container;
  const path: string[] = [];
  for (const segment of root.scopePath) {
    path.push(segment);
    let group = current.scopes.get(segment);
    if (group === undefined) {
      group = { name: segment, path: [...path], items: [], scopes: new Map() };
      current.scopes.set(segment, group);
      current.items.push({ kind: "scope", group });
    }
    current = group;
  }
  current.items.push({ kind: "node", node: root });
}

function rootsInGroup(group: MutableScopeGroup): readonly TraceNode[] {
  return group.items.flatMap((item) =>
    item.kind === "node" ? [item.node] : rootsInGroup(item.group),
  );
}

function collectSpanIds(nodes: readonly TraceNode[]): readonly string[] {
  const spanIds: string[] = [];
  const visit = (node: TraceNode): void => {
    spanIds.push(node.spanId);
    for (const child of node.children) {
      visit(child);
    }
  };
  nodes.forEach(visit);
  return spanIds;
}

function scopeRow(group: MutableScopeGroup, prefix: string): TreeRow {
  const nodes = rootsInGroup(group);
  return {
    spanId: `scope:${JSON.stringify(group.path)}`,
    name: group.name,
    kind: "scope",
    prefix,
    metrics: scopeMetrics(nodes),
    outcome: aggregateOutcome(nodes),
    toolSummary: undefined,
    hasTools: false,
    toolsExpanded: false,
    selectable: true,
    scopePath: group.path,
    runCount: nodes.length,
    usage: aggregateUsage(nodes),
    nodes,
    selectedSpanIds: collectSpanIds(nodes),
  };
}

function displayNodeName(node: TraceNode): string {
  return node.kind === "run" && node.name === node.scopePath.at(-1)
    ? (node.agent ?? node.name)
    : node.name;
}

function nodeRow(
  node: TraceNode,
  prefix: string,
  expandedRunSpanIds: ReadonlySet<string>,
): TreeRow {
  return {
    spanId: node.spanId,
    name: displayNodeName(node),
    kind: node.kind,
    prefix,
    metrics: nodeMetrics(node),
    outcome: node.outcome,
    toolSummary: node.kind === "run" ? summarizeTools(node) : undefined,
    hasTools: node.kind === "run" && node.children.some((child) => child.kind === "tool"),
    toolsExpanded: node.kind === "run" && expandedRunSpanIds.has(node.spanId),
    selectable: node.kind === "run",
    scopePath: node.scopePath,
    runCount: node.kind === "run" ? 1 : 0,
    usage: node.usage,
    nodes: [node],
    selectedSpanIds: collectSpanIds([node]),
  };
}

function rowPrefix(ancestorPrefix: string, isLast: boolean, isRoot: boolean): string {
  if (isRoot) {
    return "";
  }
  return `${ancestorPrefix}${isLast ? "└─ " : "├─ "}`;
}

function descendantPrefix(ancestorPrefix: string, isLast: boolean, isRoot: boolean): string {
  if (isRoot) {
    return "";
  }
  return `${ancestorPrefix}${isLast ? "   " : "│  "}`;
}

function flattenTraceTree(
  tree: TraceTree,
  expandedRunSpanIds: ReadonlySet<string> = new Set(),
): readonly TreeRow[] {
  const rows: TreeRow[] = [];
  const outline: OutlineContainer = { items: [], scopes: new Map() };
  tree.roots.forEach((root) => {
    addRootToOutline(outline, root);
  });

  const visitNode = (
    node: TraceNode,
    ancestorPrefix: string,
    isLast: boolean,
    isRoot: boolean,
  ): void => {
    const prefix = rowPrefix(ancestorPrefix, isLast, isRoot);
    rows.push(nodeRow(node, prefix, expandedRunSpanIds));
    const childPrefix = descendantPrefix(ancestorPrefix, isLast, isRoot);
    const children = visibleChildren(node, expandedRunSpanIds);
    children.forEach((child, index) => {
      visitNode(child, childPrefix, index === children.length - 1, false);
    });
  };

  function visitItem(
    item: OutlineItem,
    index: number,
    itemCount: number,
    ancestorPrefix: string,
    parentIsRoot: boolean,
  ): void {
    const isLast = index === itemCount - 1;
    if (item.kind === "node") {
      visitNode(item.node, ancestorPrefix, isLast, parentIsRoot);
      return;
    }
    rows.push(scopeRow(item.group, rowPrefix(ancestorPrefix, isLast, parentIsRoot)));
    visitItems(item.group.items, descendantPrefix(ancestorPrefix, isLast, parentIsRoot), false);
  }

  function visitItems(
    items: readonly OutlineItem[],
    ancestorPrefix: string,
    parentIsRoot: boolean,
  ): void {
    for (const [index, item] of items.entries()) {
      visitItem(item, index, items.length, ancestorPrefix, parentIsRoot);
    }
  }

  visitItems(outline.items, "", true);
  return rows;
}

function nestedNodes(nodes: readonly TraceNode[]): readonly TraceNode[] {
  return nodes.flatMap((node) => [node, ...nestedNodes(node.children)]);
}

function diagnosticNodeName(node: TraceNode): string {
  return node.scopePath.length > 0 ? node.scopePath.join("/") : displayNodeName(node);
}

function diagnosticsForRow(row: TreeRow): readonly TreeDiagnostic[] {
  const diagnostics: TreeDiagnostic[] = [];
  for (const node of nestedNodes(row.nodes)) {
    if (node.repairs > 0) {
      diagnostics.push({
        kind: "repair",
        label: `${diagnosticNodeName(node)} · repairs`,
        value: `${node.repairs} repair ${node.repairs === 1 ? "attempt" : "attempts"}`,
      });
    }
    for (const log of node.logs) {
      diagnostics.push({
        kind: "log",
        label: `${diagnosticNodeName(node)} · ${log.level}`,
        value: log.message,
      });
    }
    for (const annotation of node.annotations) {
      diagnostics.push({
        kind: "annotation",
        label: `${diagnosticNodeName(node)} · annotation`,
        value: annotation,
      });
    }
    for (const checkpoint of node.checkpoints) {
      diagnostics.push({
        kind: "checkpoint",
        label: `${diagnosticNodeName(node)} · checkpoint ${checkpoint.action}`,
        value: checkpoint.key,
      });
    }
    if (node.error !== undefined) {
      diagnostics.push({
        kind: "error",
        label: `${diagnosticNodeName(node)} · error`,
        value: node.error,
      });
    }
  }
  return diagnostics;
}

function environmentLabel(tree: TraceTree, selectedRow?: TreeRow): string {
  const nodes = nestedNodes(selectedRow?.nodes ?? tree.roots).filter((node) => node.kind === "run");
  const backends = new Set(
    nodes.flatMap((node) => (node.backend === undefined ? [] : [node.backend])),
  );
  const models = new Set(nodes.flatMap((node) => (node.model === undefined ? [] : [node.model])));
  if (backends.size === 0 && models.size === 0) {
    return "waiting for agent";
  }
  if (backends.size === 1 && models.size === 1) {
    return `${[...backends][0]}/${[...models][0]}`;
  }
  const parts = [
    backends.size === 1 ? [...backends][0] : `${backends.size} backends`,
    models.size === 1 ? [...models][0] : `${models.size} models`,
  ];
  return parts.filter((part): part is string => part !== undefined).join(" · ");
}

function focusLabel(row: TreeRow | undefined): string | undefined {
  if (row === undefined) {
    return;
  }
  return row.kind === "scope" ? row.scopePath.join("/") : row.name;
}

export type { TreeDiagnostic, TreeRow };
export { diagnosticsForRow, environmentLabel, flattenTraceTree, focusLabel };
