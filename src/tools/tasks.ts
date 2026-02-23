import type { Tool } from '@modelcontextprotocol/sdk/types.js';
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
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['epic_id', 'title'],
    },
  },
  {
    name: 'task_list',
    description:
      'List tasks with optional filters. If no epic_id given, lists across ALL epics. Includes subtask counts.',
    annotations: { title: 'List Tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'Filter by epic (omit for all tasks)' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assigned_to: { type: 'string', description: 'Filter by assignee' },
        tag: { type: 'string', description: 'Filter by tag' },
        limit: { type: 'integer', default: 50, description: 'Max results' },
      },
    },
  },
  {
    name: 'task_get',
    description: 'Get a single task with full details including all subtasks and related notes.',
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
        sort_order: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
];

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

  const task = db
    .prepare(
      `INSERT INTO tasks (epic_id, title, description, status, priority, assigned_to, estimated_hours, due_date, source_ref, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(epicId, title, description, status, priority, assignedTo, estimatedHours, dueDate, sourceRef, tags);

  const row = task as Record<string, unknown>;
  logActivity(db, 'task', row.id as number, 'created', null, null, null, `Task '${title}' created`);

  return task;
}

function handleTaskList(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number | undefined;
  const status = args.status as string | undefined;
  const priority = args.priority as string | undefined;
  const assignedTo = args.assigned_to as string | undefined;
  const tag = args.tag as string | undefined;
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
      COUNT(s.id) as subtask_count,
      SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) as subtask_done_count
    FROM tasks t
    JOIN epics e ON e.id = t.epic_id
    LEFT JOIN subtasks s ON s.task_id = t.id
    ${whereStr}
    GROUP BY t.id
    ORDER BY t.sort_order, t.created_at
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

  return { ...(task as object), subtasks, notes };
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
  if (!update) throw new Error('No fields to update');

  const newRow = db.prepare(update.sql).get(...update.params) as Record<string, unknown>;
  logEntityUpdate(db, 'task', id, newRow.title as string, oldRow, newRow, [
    'status', 'priority', 'assigned_to', 'title',
  ]);

  return newRow;
}

export const handlers: Record<string, ToolHandler> = {
  task_create: handleTaskCreate,
  task_list: handleTaskList,
  task_get: handleTaskGet,
  task_update: handleTaskUpdate,
};
