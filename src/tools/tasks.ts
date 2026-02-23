import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import { buildUpdate, addTagFilter } from '../helpers/sql-builder.js';
import { logActivity, logEntityUpdate } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'task_create',
    description: 'Create a task within an epic. Tasks are the primary unit of work.',
    annotations: { title: 'Create Task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'Parent epic ID' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'review', 'done', 'blocked'],
          default: 'todo',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          default: 'medium',
        },
        assigned_to: { type: 'string', description: 'Assignee name' },
        estimated_hours: { type: 'number', description: 'Estimated hours' },
        due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
        source_ref: {
          type: 'object',
          description: 'Link to source code location',
          properties: {
            file: { type: 'string', description: 'File path' },
            line_start: { type: 'integer', description: 'Start line number' },
            line_end: { type: 'integer', description: 'End line number' },
            repo: { type: 'string', description: 'Repository URL or name' },
            commit: { type: 'string', description: 'Commit hash' },
          },
          required: ['file'],
        },
        depends_on: { type: 'array', items: { type: 'integer' }, description: 'Task IDs this task depends on' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['epic_id', 'title'],
    },
  },
  {
    name: 'task_list',
    description:
      'List tasks with optional filters. If no epic_id given, lists across ALL epics. Includes subtask counts and dependency info.',
    annotations: { title: 'List Tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'Filter by epic (omit for all tasks)' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assigned_to: { type: 'string', description: 'Filter by assignee' },
        tag: { type: 'string', description: 'Filter by tag' },
        sort_by: {
          type: 'string',
          enum: ['priority', 'created', 'due_date', 'status'],
          default: 'priority',
          description: 'Sort order: priority (critical first), created (newest first), due_date (earliest first), status (actionable first)',
        },
        limit: { type: 'integer', default: 50, description: 'Max results' },
      },
    },
  },
  {
    name: 'task_get',
    description: 'Get a single task with full details including all subtasks, related notes, comments, and dependencies.',
    annotations: { title: 'Get Task', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Task ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_update',
    description:
      'Update a task. Pass only fields to change. Status transitions are automatically logged in the activity log.',
    annotations: { title: 'Update Task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Task ID' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assigned_to: { type: 'string' },
        estimated_hours: { type: 'number' },
        actual_hours: { type: 'number' },
        due_date: { type: 'string' },
        source_ref: {
          type: 'object',
          description: 'Link to source code location',
          properties: {
            file: { type: 'string', description: 'File path' },
            line_start: { type: 'integer', description: 'Start line number' },
            line_end: { type: 'integer', description: 'End line number' },
            repo: { type: 'string', description: 'Repository URL or name' },
            commit: { type: 'string', description: 'Commit hash' },
          },
          required: ['file'],
        },
        depends_on: { type: 'array', items: { type: 'integer' }, description: 'Task IDs this task depends on (replaces existing)' },
        sort_order: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
];

// --- Dependency helpers ---

function setDependencies(db: Database.Database, taskId: number, dependsOn: number[]): void {
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
  const insert = db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)');
  for (const depId of dependsOn) {
    if (depId === taskId) continue; // prevent self-dependency
    insert.run(taskId, depId);
  }
}

function getUnmetDependencies(db: Database.Database, taskId: number): Array<{ id: number; title: string; status: string }> {
  return db.prepare(
    `SELECT t.id, t.title, t.status FROM task_dependencies d
     JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = ? AND t.status != 'done'`
  ).all(taskId) as Array<{ id: number; title: string; status: string }>;
}

function evaluateAndUpdateDependencies(db: Database.Database, taskId: number): void {
  const task = db.prepare('SELECT id, status, title FROM tasks WHERE id = ?').get(taskId) as { id: number; status: string; title: string } | undefined;
  if (!task) return;

  const deps = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?').all(taskId) as Array<{ depends_on_task_id: number }>;
  if (deps.length === 0) return;

  const unmet = getUnmetDependencies(db, taskId);

  if (unmet.length > 0 && task.status !== 'blocked' && task.status !== 'done') {
    db.prepare("UPDATE tasks SET status = 'blocked', updated_at = datetime('now') WHERE id = ?").run(taskId);
    logActivity(db, 'task', taskId, 'status_changed', 'status', task.status, 'blocked',
      `Task '${task.title}' auto-blocked: depends on ${unmet.map(u => `#${u.id}`).join(', ')}`);
  } else if (unmet.length === 0 && task.status === 'blocked') {
    db.prepare("UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ?").run(taskId);
    logActivity(db, 'task', taskId, 'status_changed', 'status', 'blocked', 'todo',
      `Task '${task.title}' auto-unblocked: all dependencies met`);
  }
}

export function reevaluateDownstream(db: Database.Database, completedTaskId: number): void {
  const downstream = db.prepare(
    'SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?'
  ).all(completedTaskId) as Array<{ task_id: number }>;

  for (const row of downstream) {
    evaluateAndUpdateDependencies(db, row.task_id);
  }
}

// --- Handlers ---

function handleTaskCreate(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number;
  const title = args.title as string;
  const description = (args.description as string) ?? null;
  const status = (args.status as string) ?? 'todo';
  const priority = (args.priority as string) ?? 'medium';
  const assignedTo = (args.assigned_to as string) ?? null;
  const estimatedHours = (args.estimated_hours as number) ?? null;
  const dueDate = (args.due_date as string) ?? null;
  const sourceRef = args.source_ref ? JSON.stringify(args.source_ref) : null;
  const tags = JSON.stringify((args.tags as string[]) ?? []);
  const dependsOn = (args.depends_on as number[]) ?? [];

  const task = db
    .prepare(
      `INSERT INTO tasks (epic_id, title, description, status, priority, assigned_to, estimated_hours, due_date, source_ref, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(epicId, title, description, status, priority, assignedTo, estimatedHours, dueDate, sourceRef, tags);

  const row = task as Record<string, unknown>;
  const taskId = row.id as number;
  logActivity(db, 'task', taskId, 'created', null, null, null, `Task '${title}' created`);

  if (dependsOn.length > 0) {
    setDependencies(db, taskId, dependsOn);
    evaluateAndUpdateDependencies(db, taskId);
    // Re-fetch to get potentially updated status
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  }

  return task;
}

const PRIORITY_ORDER = "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END";
const STATUS_ORDER = "CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'review' THEN 2 WHEN 'todo' THEN 3 WHEN 'done' THEN 4 END";

function getTaskOrderClause(sortBy: string): string {
  switch (sortBy) {
    case 'priority':
      return `${PRIORITY_ORDER}, ${STATUS_ORDER}, t.sort_order, t.created_at`;
    case 'status':
      return `${STATUS_ORDER}, ${PRIORITY_ORDER}, t.sort_order, t.created_at`;
    case 'due_date':
      return `t.due_date IS NULL, t.due_date ASC, ${PRIORITY_ORDER}, t.created_at`;
    case 'created':
      return `t.created_at DESC`;
    default:
      return `${PRIORITY_ORDER}, ${STATUS_ORDER}, t.sort_order, t.created_at`;
  }
}

function handleTaskList(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number | undefined;
  const status = args.status as string | undefined;
  const priority = args.priority as string | undefined;
  const assignedTo = args.assigned_to as string | undefined;
  const tag = args.tag as string | undefined;
  const sortBy = (args.sort_by as string) ?? 'priority';
  const limit = (args.limit as number) ?? 50;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (epicId !== undefined) {
    whereClauses.push('t.epic_id = ?');
    params.push(epicId);
  }
  if (status) {
    whereClauses.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    whereClauses.push('t.priority = ?');
    params.push(priority);
  }
  if (assignedTo) {
    whereClauses.push('t.assigned_to = ?');
    params.push(assignedTo);
  }
  if (tag) {
    addTagFilter(whereClauses, params, tag, 't');
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = `
    SELECT t.*,
      e.name as epic_name,
      COUNT(DISTINCT s.id) as subtask_count,
      SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) as subtask_done_count,
      (SELECT COUNT(*) FROM task_dependencies d
       JOIN tasks dt ON dt.id = d.depends_on_task_id AND dt.status != 'done'
       WHERE d.task_id = t.id) as blocked_by_count
    FROM tasks t
    JOIN epics e ON e.id = t.epic_id
    LEFT JOIN subtasks s ON s.task_id = t.id
    ${whereStr}
    GROUP BY t.id
    ORDER BY ${getTaskOrderClause(sortBy)}
    LIMIT ?
  `;

  params.push(limit);
  return db.prepare(sql).all(...params);
}

function handleTaskGet(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const task = db
    .prepare(
      `SELECT t.*, e.name as epic_name
       FROM tasks t
       JOIN epics e ON e.id = t.epic_id
       WHERE t.id = ?`
    )
    .get(id);

  if (!task) throw new Error(`Task ${id} not found`);

  const subtasks = db
    .prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at')
    .all(id);

  const notes = db
    .prepare(
      `SELECT * FROM notes
       WHERE related_entity_type = 'task' AND related_entity_id = ?
       ORDER BY created_at DESC`
    )
    .all(id);

  const comments = db
    .prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC')
    .all(id);

  // Dependencies: what this task depends on
  const dependsOn = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`
    )
    .all(id);

  // Dependents: what tasks depend on this task
  const dependents = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_task_id = ?`
    )
    .all(id);

  return { ...(task as object), subtasks, notes, comments, depends_on: dependsOn, dependents };
}

function handleTaskUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const oldRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!oldRow) throw new Error(`Task ${id} not found`);

  const update = buildUpdate('tasks', id, args, [
    'title', 'description', 'status', 'priority', 'assigned_to',
    'estimated_hours', 'actual_hours', 'due_date', 'source_ref', 'sort_order', 'tags',
  ]);

  let newRow: Record<string, unknown>;

  if (update) {
    newRow = db.prepare(update.sql).get(...update.params) as Record<string, unknown>;
    logEntityUpdate(db, 'task', id, newRow.title as string, oldRow, newRow, [
      'status', 'priority', 'assigned_to', 'title',
    ]);
  } else if (args.depends_on !== undefined) {
    // Only depends_on changed, no column updates
    newRow = oldRow;
  } else {
    throw new Error('No fields to update');
  }

  // Handle dependency updates
  if (args.depends_on !== undefined) {
    const dependsOn = args.depends_on as number[];
    setDependencies(db, id, dependsOn);
    logActivity(db, 'task', id, 'updated', 'depends_on', null,
      dependsOn.length > 0 ? dependsOn.join(',') : '(none)',
      `Task '${newRow.title}' dependencies updated: [${dependsOn.join(', ')}]`);
    evaluateAndUpdateDependencies(db, id);
    // Re-fetch in case status changed
    newRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;
  }

  // Auto time tracking: when status changes to done and actual_hours wasn't manually set
  const statusChanged = args.status && oldRow.status !== args.status;
  if (statusChanged && args.status === 'done' && !args.actual_hours && !newRow.actual_hours) {
    const startEntry = db.prepare(
      `SELECT created_at FROM activity_log
       WHERE entity_type = 'task' AND entity_id = ? AND action = 'status_changed'
         AND field_name = 'status' AND new_value = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`
    ).get(id) as { created_at: string } | undefined;

    if (startEntry) {
      const startMs = new Date(startEntry.created_at + 'Z').getTime();
      const nowMs = Date.now();
      const hours = Math.round(((nowMs - startMs) / 3_600_000) * 10) / 10; // 1 decimal
      if (hours > 0) {
        db.prepare('UPDATE tasks SET actual_hours = ? WHERE id = ?').run(hours, id);
        (newRow as Record<string, unknown>).actual_hours = hours;
        logActivity(db, 'task', id, 'updated', 'actual_hours', null, String(hours),
          `Task '${newRow.title}' auto-tracked: ${hours}h`);
      }
    }
  }

  // Re-evaluate downstream tasks when this task is marked done
  if (statusChanged && args.status === 'done') {
    reevaluateDownstream(db, id);
  }

  return newRow;
}

export const handlers: Record<string, ToolHandler> = {
  task_create: handleTaskCreate,
  task_list: handleTaskList,
  task_get: handleTaskGet,
  task_update: handleTaskUpdate,
};
