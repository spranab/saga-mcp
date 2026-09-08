import type Database from 'better-sqlite3';

/**
 * One database can hold many projects — the "global" / centralized setup, where
 * every repo points its MCP server at the same .tracker.db.
 *
 * Without scoping, an agent working in repo B sees repo A's tasks: task_list,
 * note_list, activity_log and tracker_search all read across the whole file.
 * These helpers give every such tool the same scoping rule:
 *
 *   explicit project_id argument  >  SAGA_PROJECT env var  >  unscoped
 *
 * Set SAGA_PROJECT (an id, or a project name) in each repo's MCP config and a
 * shared database behaves exactly like a per-project one.
 */

let cachedEnvProject: { raw: string; id: number } | undefined;

/** Resolve SAGA_PROJECT, which may be a numeric id or a project name. */
function envProjectId(db: Database.Database): number | undefined {
  const raw = process.env.SAGA_PROJECT?.trim();
  if (!raw) return undefined;
  if (cachedEnvProject && cachedEnvProject.raw === raw) return cachedEnvProject.id;

  let row: { id: number } | undefined;
  if (/^\d+$/.test(raw)) {
    row = db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(raw)) as { id: number } | undefined;
  } else {
    row = db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE').get(raw) as { id: number } | undefined;
  }
  if (!row) {
    const known = (db.prepare('SELECT id, name FROM projects ORDER BY id').all() as Array<{ id: number; name: string }>)
      .map((p) => `${p.id}=${p.name}`)
      .join(', ');
    throw new Error(
      `SAGA_PROJECT is set to '${raw}', which is not a project in this database. Known projects: ${known || '(none)'}`
    );
  }
  cachedEnvProject = { raw, id: row.id };
  return row.id;
}

/** The project a call should be scoped to, or undefined for the whole database. */
export function resolveProjectId(
  db: Database.Database,
  args: Record<string, unknown>
): number | undefined {
  const explicit = args.project_id;
  if (typeof explicit === 'number') return explicit;
  if (typeof explicit === 'string' && /^\d+$/.test(explicit)) return Number(explicit);
  return envProjectId(db);
}

export function projectCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n;
}

/** Shared JSON-schema property, so every scoped tool describes it identically. */
export const PROJECT_ID_SCHEMA = {
  type: 'integer' as const,
  description:
    'Scope to one project. Defaults to SAGA_PROJECT if set, else the whole database.',
};

/**
 * `WHERE` fragment selecting tasks in a project, given an alias for the epics
 * table already joined by the caller.
 */
export function taskScopeClause(epicAlias = 'e'): string {
  return `${epicAlias}.project_id = ?`;
}

/** Notes attached to a project, or to any epic/task inside it. Unattached notes count as global. */
export function noteScopeClause(alias = 'notes'): { sql: string; paramCount: number } {
  return {
    sql: `(
      (${alias}.related_entity_type = 'project' AND ${alias}.related_entity_id = ?)
      OR (${alias}.related_entity_type = 'epic' AND ${alias}.related_entity_id IN
            (SELECT id FROM epics WHERE project_id = ?))
      OR (${alias}.related_entity_type = 'task' AND ${alias}.related_entity_id IN
            (SELECT t.id FROM tasks t JOIN epics e ON e.id = t.epic_id WHERE e.project_id = ?))
      OR ${alias}.related_entity_type IS NULL
    )`,
    paramCount: 3,
  };
}

/**
 * Activity rows name an entity by type and id, so scoping means walking each
 * type back up to its project.
 */
export function activityScopeClause(alias = 'activity_log'): { sql: string; paramCount: number } {
  return {
    sql: `(
      (${alias}.entity_type = 'project' AND ${alias}.entity_id = ?)
      OR (${alias}.entity_type = 'epic' AND ${alias}.entity_id IN
            (SELECT id FROM epics WHERE project_id = ?))
      OR (${alias}.entity_type = 'task' AND ${alias}.entity_id IN
            (SELECT t.id FROM tasks t JOIN epics e ON e.id = t.epic_id WHERE e.project_id = ?))
      OR (${alias}.entity_type = 'subtask' AND ${alias}.entity_id IN
            (SELECT s.id FROM subtasks s JOIN tasks t ON t.id = s.task_id
             JOIN epics e ON e.id = t.epic_id WHERE e.project_id = ?))
      OR (${alias}.entity_type = 'comment' AND ${alias}.entity_id IN
            (SELECT c.id FROM comments c JOIN tasks t ON t.id = c.task_id
             JOIN epics e ON e.id = t.epic_id WHERE e.project_id = ?))
      OR (${alias}.entity_type = 'note' AND ${alias}.entity_id IN
            (SELECT n.id FROM notes n WHERE
               (n.related_entity_type = 'project' AND n.related_entity_id = ?)
               OR (n.related_entity_type = 'epic' AND n.related_entity_id IN
                     (SELECT id FROM epics WHERE project_id = ?))
               OR (n.related_entity_type = 'task' AND n.related_entity_id IN
                     (SELECT t.id FROM tasks t JOIN epics e ON e.id = t.epic_id WHERE e.project_id = ?))))
    )`,
    paramCount: 8,
  };
}

/** Repeat a project id n times, for the multi-placeholder clauses above. */
export function repeatId(projectId: number, n: number): number[] {
  return Array.from({ length: n }, () => projectId);
}

/** Only for tests — SAGA_PROJECT is read once and cached. */
export function resetProjectScopeCache(): void {
  cachedEnvProject = undefined;
}
