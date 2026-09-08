import type Database from 'better-sqlite3';
import { activityScopeClause, repeatId } from '../helpers/project-scope.js';
import { withDependencies } from '../tools/subtasks.js';

/**
 * Read-only queries backing the web viewer. Every statement here is a SELECT —
 * the viewer never writes. The MCP tools remain the only write path.
 */

export function listProjects(db: Database.Database) {
  return db
    .prepare(
      `SELECT p.*,
        COUNT(DISTINCT e.id) as epic_count,
        COUNT(DISTINCT t.id) as task_count,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_count,
        CASE WHEN COUNT(DISTINCT t.id) > 0
          THEN ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(DISTINCT t.id), 1)
          ELSE 0 END as completion_pct
      FROM projects p
      LEFT JOIN epics e ON e.project_id = p.id
      LEFT JOIN tasks t ON t.epic_id = e.id
      GROUP BY p.id
      ORDER BY
        CASE p.status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        p.created_at DESC`
    )
    .all();
}

export function getOverview(db: Database.Database, projectId: number, includeArchived = false) {
  const archivedSql = includeArchived ? '' : ' AND e.archived = 0';
  const liveTasks = includeArchived ? '' : ' AND t.is_deleted = 0';
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;

  const stats = db
    .prepare(
      `WITH epic_ids AS (SELECT id FROM epics e WHERE project_id = ?${archivedSql}),
       task_stats AS (
         SELECT
           COUNT(*) as total_tasks,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as tasks_done,
           SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as tasks_in_progress,
           SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as tasks_review,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as tasks_blocked,
           SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as tasks_todo,
           COALESCE(SUM(estimated_hours), 0) as total_estimated_hours,
           COALESCE(SUM(actual_hours), 0) as total_actual_hours
         FROM tasks t WHERE epic_id IN (SELECT id FROM epic_ids)${liveTasks}
       )
       SELECT (SELECT COUNT(*) FROM epic_ids) as total_epics, ts.*,
         CASE WHEN ts.total_tasks > 0
           THEN ROUND(ts.tasks_done * 100.0 / ts.total_tasks, 1)
           ELSE 0 END as completion_pct
       FROM task_stats ts`
    )
    .get(projectId);

  const epics = db
    .prepare(
      `SELECT e.*,
        COUNT(t.id) as task_count,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_count,
        SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) as blocked_count,
        CASE WHEN COUNT(t.id) > 0
          THEN ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id), 1)
          ELSE 0 END as completion_pct
      FROM epics e
      LEFT JOIN tasks t ON t.epic_id = e.id${liveTasks}
      WHERE e.project_id = ?${archivedSql}
      GROUP BY e.id
      ORDER BY e.sort_order, e.created_at`
    )
    .all(projectId);

  const today = new Date().toISOString().slice(0, 10);
  const overdue = db
    .prepare(
      `SELECT t.id, t.title, t.due_date, t.priority, t.status, e.name as epic_name
       FROM tasks t JOIN epics e ON e.id = t.epic_id
       WHERE e.project_id = ? AND t.due_date IS NOT NULL AND t.due_date < ? AND t.status != 'done'${archivedSql}${liveTasks}
       ORDER BY t.due_date ASC`
    )
    .all(projectId, today);

  const blocked = db
    .prepare(
      `SELECT t.id, t.title, t.priority, t.status, e.name as epic_name
       FROM tasks t JOIN epics e ON e.id = t.epic_id
       WHERE e.project_id = ? AND t.status = 'blocked'${archivedSql}${liveTasks}
       ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`
    )
    .all(projectId);

  const branches = db
    .prepare(
      `SELECT branch, COUNT(*) as epic_count FROM epics
       WHERE project_id = ? AND branch IS NOT NULL AND branch != ''
       GROUP BY branch ORDER BY branch`
    )
    .all(projectId);

  const hidden = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM epics WHERE project_id = ? AND archived = 1) as archived_epics,
         (SELECT COUNT(*) FROM tasks t JOIN epics e ON e.id = t.epic_id
          WHERE e.project_id = ? AND t.is_deleted = 1) as removed_tasks`
    )
    .get(projectId, projectId);

  return { project, stats, epics, overdue_tasks: overdue, blocked_tasks: blocked, branches, hidden };
}

export function listTasks(db: Database.Database, projectId: number, includeArchived = false) {
  const hide = includeArchived ? '' : ' AND e.archived = 0 AND t.is_deleted = 0';
  return db
    .prepare(
      `SELECT t.*, e.name as epic_name, e.branch as epic_branch,
        (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id) as subtask_count,
        (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status = 'done') as subtask_done,
        (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id AND c.is_deleted = 0) as comment_count,
        -- Names of the unfinished blockers, so a row in the tree can say what it
        -- is waiting on without a second request per task.
        (SELECT group_concat(b.title, ', ') FROM task_dependencies d
           JOIN tasks b ON b.id = d.depends_on_task_id
          WHERE d.task_id = t.id AND b.status != 'done' AND b.is_deleted = 0) as blocked_by
       FROM tasks t JOIN epics e ON e.id = t.epic_id
       WHERE e.project_id = ?${hide}
       ORDER BY e.sort_order, e.created_at, t.sort_order, t.created_at`
    )
    .all(projectId);
}

export function getTask(db: Database.Database, taskId: number, includeDeleted: boolean) {
  const task = db
    .prepare(
      `SELECT t.*, e.name as epic_name, e.id as epic_id, e.branch as epic_branch, p.name as project_name, p.id as project_id
       FROM tasks t JOIN epics e ON e.id = t.epic_id JOIN projects p ON p.id = e.project_id
       WHERE t.id = ?`
    )
    .get(taskId);
  if (!task) return null;

  const subtasks = withDependencies(
    db,
    db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at')
      .all(taskId) as Array<Record<string, unknown>>
  );

  const comments = db
    .prepare(
      includeDeleted
        ? 'SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC'
        : 'SELECT * FROM comments WHERE task_id = ? AND is_deleted = 0 ORDER BY created_at ASC'
    )
    .all(taskId);

  const deletedCount = db
    .prepare('SELECT COUNT(*) as n FROM comments WHERE task_id = ? AND is_deleted = 1')
    .get(taskId) as { n: number };

  const notes = db
    .prepare(
      `SELECT * FROM notes WHERE related_entity_type = 'task' AND related_entity_id = ?
       ORDER BY created_at DESC`
    )
    .all(taskId);

  const dependsOn = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ?`
    )
    .all(taskId);

  const dependents = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_task_id = ?`
    )
    .all(taskId);

  const activity = db
    .prepare(
      `SELECT * FROM activity_log WHERE entity_type = 'task' AND entity_id = ?
       ORDER BY created_at DESC LIMIT 30`
    )
    .all(taskId);

  return {
    ...(task as object),
    subtasks,
    comments,
    deleted_comment_count: deletedCount.n,
    notes,
    depends_on: dependsOn,
    dependents,
    activity,
  };
}

export function listNotes(db: Database.Database, projectId: number | null, limit: number) {
  if (projectId === null) {
    return db.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  return db
    .prepare(
      `SELECT n.* FROM notes n
       WHERE (n.related_entity_type = 'project' AND n.related_entity_id = ?)
          OR (n.related_entity_type = 'epic' AND n.related_entity_id IN
                (SELECT id FROM epics WHERE project_id = ?))
          OR (n.related_entity_type = 'task' AND n.related_entity_id IN
                (SELECT t.id FROM tasks t JOIN epics e ON e.id = t.epic_id WHERE e.project_id = ?))
          OR n.related_entity_type IS NULL
       ORDER BY n.created_at DESC LIMIT ?`
    )
    .all(projectId, projectId, projectId, limit);
}

export function listActivity(db: Database.Database, projectId: number | null, limit: number) {
  if (projectId === null) {
    return db
      .prepare('SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit);
  }
  const scope = activityScopeClause('activity_log');
  return db
    .prepare(
      `SELECT * FROM activity_log WHERE ${scope.sql} ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...repeatId(projectId, scope.paramCount), limit);
}

export function search(db: Database.Database, query: string, limit: number) {
  const pattern = `%${query}%`;
  return {
    projects: db
      .prepare('SELECT id, name, description, status FROM projects WHERE name LIKE ? OR description LIKE ? LIMIT ?')
      .all(pattern, pattern, limit),
    epics: db
      .prepare(
        `SELECT e.id, e.name, e.description, e.status, e.project_id, p.name as project_name
         FROM epics e JOIN projects p ON p.id = e.project_id
         WHERE (e.name LIKE ? OR e.description LIKE ?) AND e.archived = 0 LIMIT ?`
      )
      .all(pattern, pattern, limit),
    tasks: db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, e.name as epic_name, e.project_id
         FROM tasks t JOIN epics e ON e.id = t.epic_id
         WHERE (t.title LIKE ? OR t.description LIKE ?) AND e.archived = 0 AND t.is_deleted = 0 LIMIT ?`
      )
      .all(pattern, pattern, limit),
    notes: db
      .prepare('SELECT id, title, note_type, related_entity_type, related_entity_id, created_at FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT ?')
      .all(pattern, pattern, limit),
  };
}

/**
 * Templates, with their task definitions parsed.
 *
 * template_data is stored as JSON text; the page needs the tasks themselves to
 * show what a template creates (#44), so parse here rather than making every
 * caller do it. A template whose JSON is somehow unparseable is reported with
 * an empty task list instead of taking the whole page down.
 */
export function listTemplates(db: Database.Database) {
  const rows = db
    .prepare('SELECT * FROM templates ORDER BY name COLLATE NOCASE')
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const { template_data, ...rest } = row;
    let tasks: unknown[] = [];
    let broken = false;
    try {
      const parsed = JSON.parse((template_data as string) || '[]');
      if (Array.isArray(parsed)) tasks = parsed;
      else broken = true;
    } catch {
      broken = true;
    }
    return { ...rest, tasks, task_count: tasks.length, ...(broken ? { unreadable: true } : {}) };
  });
}
