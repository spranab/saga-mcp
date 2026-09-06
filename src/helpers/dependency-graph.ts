import type Database from 'better-sqlite3';

/**
 * Cycle detection, shared by task and subtask dependencies.
 *
 * Subtasks refused cycles from the start (#22). Tasks never did — `A depends
 * on B, B depends on A` was accepted, and the auto-blocking then put both in
 * `blocked` permanently, where nothing could ever release them. The two
 * dependency graphs are the same shape, so they should refuse the same things.
 *
 * This matters more now that dependencies are editable from the web UI: it is
 * a click away rather than a deliberate pair of tool calls.
 */
export interface DependencyEdge {
  from: number;
  to: number;
}

/**
 * Throw if pointing `id` at `dependsOn` would close a loop.
 *
 * `edges` is the existing graph; edges starting at `id` are ignored, since the
 * caller is about to replace them.
 */
export function assertAcyclic(
  edges: DependencyEdge[],
  id: number,
  dependsOn: number[],
  label: string
): void {
  const graph = new Map<number, number[]>();
  for (const edge of edges) {
    if (edge.from === id) continue; // replaced by dependsOn below
    graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
  }
  graph.set(id, dependsOn);

  const seen = new Set<number>();
  const stack = new Set<number>();
  const walk = (node: number): number[] | null => {
    if (stack.has(node)) return [node];
    if (seen.has(node)) return null;
    seen.add(node);
    stack.add(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return [node, ...cycle];
    }
    stack.delete(node);
    return null;
  };

  const cycle = walk(id);
  if (cycle) {
    throw new Error(
      `That would make a circular ${label} dependency: ${cycle.map((n) => `#${n}`).join(' → ')}. ` +
        'Nothing in a cycle can ever start.'
    );
  }
}

/** Every task dependency edge, for the check above. */
export function taskEdges(db: Database.Database): DependencyEdge[] {
  return (
    db.prepare('SELECT task_id, depends_on_task_id FROM task_dependencies').all() as Array<{
      task_id: number;
      depends_on_task_id: number;
    }>
  ).map((row) => ({ from: row.task_id, to: row.depends_on_task_id }));
}

/** Every subtask dependency edge. */
export function subtaskEdges(db: Database.Database): DependencyEdge[] {
  return (
    db.prepare('SELECT subtask_id, depends_on_subtask_id FROM subtask_dependencies').all() as Array<{
      subtask_id: number;
      depends_on_subtask_id: number;
    }>
  ).map((row) => ({ from: row.subtask_id, to: row.depends_on_subtask_id }));
}
