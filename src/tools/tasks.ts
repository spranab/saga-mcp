import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import { buildUpdate, addTagFilter } from '../helpers/sql-builder.js';
import { logActivity, logEntityUpdate } from '../helpers/activity-logger.js';
import { slimListRow, slimList, LIST_DESCRIPTION_CHARS } from '../helpers/slim.js';
import { resolveProjectId, taskScopeClause, PROJECT_ID_SCHEMA } from '../helpers/project-scope.js';
import { resolveBranch } from '../helpers/git.js';
import { withDependencies } from './subtasks.js';
import { guardTaskDone, FORCE_SCHEMA } from '../helpers/completion-guard.js';
import { asIdList, tagsColumn } from '../helpers/coerce.js';
import { liveTaskClause, wantsHidden, INCLUDE_ARCHIVED_SCHEMA, INCLUDE_DELETED_TASKS_SCHEMA } from '../helpers/visibility.js';
import { assertAcyclic, taskEdges } from '../helpers/dependency-graph.js';
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
            file: { type: 'string' },
            line_start: { type: 'integer' },
            line_end: { type: 'integer' },
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
      'List tasks; without epic_id, across all epics. Includes subtask and dependency counts. ' +
      'Rows are compact: nulls and metadata dropped, descriptions cut to ' + LIST_DESCRIPTION_CHARS + ' chars (task_get for full). ' +
      'branch="current" restricts to the active git branch.',
    annotations: { title: 'List Tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'Filter by epic (omit for all tasks)' },
        project_id: PROJECT_ID_SCHEMA,
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assigned_to: { type: 'string', description: 'Filter by assignee' },
        tag: { type: 'string', description: 'Filter by tag' },
        branch: {
          type: 'string',
          description: 'Git branch filter: "current" = active branch, "" = branch-agnostic only, omit = all.',
        },
        include_archived: INCLUDE_ARCHIVED_SCHEMA,
        include_deleted: INCLUDE_DELETED_TASKS_SCHEMA,
        sort_by: {
          type: 'string',
          enum: ['priority', 'created', 'due_date', 'status', 'manual'],
          description: 'Omit to follow the arrangement set by task_reorder, falling back to priority. priority (critical first), created (newest), due_date (earliest), status (actionable first), manual.',
        },
        limit: { type: 'integer', default: 50, description: 'Max results' },
      },
    },
  },
  {
    name: 'task_reorder',
    description:
      "Set the order of an epic's tasks. Omitted IDs keep their relative order at the end. task_list then follows this arrangement by default.",
    annotations: { title: 'Reorder Tasks', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'Parent epic' },
        ordered_ids: { type: 'array', items: { type: 'integer' }, description: 'Task IDs, in order' },
      },
      required: ['epic_id', 'ordered_ids'],
    },
  },
  {
    name: 'task_delete',
    description:
      "Remove a task (soft delete). Only 'todo' tasks — anything further along has history worth keeping. The row is kept and hidden from listings; task_restore brings it back.",
    annotations: { title: 'Remove Task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        reason: { type: 'string', description: 'Why it is being removed (kept in the audit trail)' },
        deleted_by: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_restore',
    description: 'Restore a task removed with task_delete.',
    annotations: { title: 'Restore Task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'task_lock_description',
    description:
      "Lock or unlock a task's description. While locked, task_update refuses to change it — a guard against rewriting the spec when you meant to add a comment. Every other field still changes freely.",
    annotations: { title: 'Lock Task Description', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Task ID' },
        locked: { type: 'boolean', default: true, description: 'true to lock, false to unlock' },
      },
      required: ['id'],
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
      'Update a task; pass only fields to change. Completing it while subtasks are unfinished is refused unless force is set.',
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
            file: { type: 'string' },
            line_start: { type: 'integer' },
            line_end: { type: 'integer' },
            repo: { type: 'string', description: 'Repository URL or name' },
            commit: { type: 'string', description: 'Commit hash' },
          },
          required: ['file'],
        },
        depends_on: { type: 'array', items: { type: 'integer' }, description: 'Task IDs this task depends on (replaces existing)' },
        sort_order: { type: 'integer', description: 'Manual position within the epic; lower sorts first. Use task_reorder instead of setting this by hand.' },
        tags: { type: 'array', items: { type: 'string' } },
        force: FORCE_SCHEMA,
      },
      required: ['id'],
    },
  },
];

// --- Dependency helpers ---

function setDependencies(db: Database.Database, taskId: number, dependsOn: number[]): void {
  const clean = [...new Set(dependsOn)].filter((depId) => depId !== taskId);
  // A cycle here is worse than a bad edge: auto-blocking would put every task
  // in the loop into `blocked` with nothing able to release them.
  assertAcyclic(taskEdges(db), taskId, clean, 'task');

  db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
  const insert = db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)');
  for (const depId of clean) insert.run(taskId, depId);
}

function getUnmetDependencies(db: Database.Database, taskId: number): Array<{ id: number; title: string; status: string }> {
  return db.prepare(
    `SELECT t.id, t.title, t.status FROM task_dependencies d
     JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = ? AND t.status != 'done'`
  ).all(taskId) as Array<{ id: number; title: string; status: string }>;
}

/**
 * `dependenciesChanged` marks the case where this task's own dependency list
 * was just edited. It matters when the list is now empty: a task holding no
 * dependencies at all is normally left alone, because `blocked` is also a
 * status a person can set by hand and clearing it silently would be wrong.
 * But clearing the last dependency off a task the system had auto-blocked used
 * to strand it in `blocked` with nothing left that could ever release it.
 */
function evaluateAndUpdateDependencies(
  db: Database.Database,
  taskId: number,
  dependenciesChanged = false
): void {
  const task = db.prepare('SELECT id, status, title FROM tasks WHERE id = ?').get(taskId) as { id: number; status: string; title: string } | undefined;
  if (!task) return;

  const deps = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?').all(taskId) as Array<{ depends_on_task_id: number }>;
  if (deps.length === 0 && !dependenciesChanged) return;

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
  const tags = tagsColumn(args.tags);
  const dependsOn = args.depends_on === undefined ? [] : asIdList(args.depends_on, 'depends_on');

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

/**
 * task_reorder writes 1..N, so sort_order = 0 means "never placed". Those sort
 * last rather than first: a task created after an arrangement was made has no
 * position in it, and the head of a plan is the one place it certainly does
 * not belong.
 */
const UNPLACED_LAST = 'CASE WHEN t.sort_order = 0 THEN 1 ELSE 0 END';

/**
 * The arrangement a human actually made, honoured across epics.
 *
 * Epics are grouped first because sort_order only means anything within one
 * epic -- position 1 of epic A and position 1 of epic B are unrelated, so
 * interleaving them by number would invent an order nobody set. Priority still
 * decides between tasks that share a position, i.e. the unplaced ones.
 */
const ARRANGED = `e.sort_order, e.id, ${UNPLACED_LAST}, t.sort_order, ${PRIORITY_ORDER}, ${STATUS_ORDER}, t.created_at`;

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
    case 'manual':
      return `e.sort_order, e.id, ${UNPLACED_LAST}, t.sort_order, t.created_at`;
    case 'arranged':
      return ARRANGED;
    default:
      return `${PRIORITY_ORDER}, ${STATUS_ORDER}, t.sort_order, t.created_at`;
  }
}

/** Has anything in this result set been placed by task_reorder? */
function hasArrangement(
  db: ReturnType<typeof getDb>,
  whereClauses: string[],
  params: unknown[]
): boolean {
  const clauses = [...whereClauses, 't.sort_order != 0'];
  const sql = `SELECT 1 FROM tasks t JOIN epics e ON e.id = t.epic_id
               WHERE ${clauses.join(' AND ')} LIMIT 1`;
  return db.prepare(sql).get(...params) !== undefined;
}

function handleTaskList(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number | undefined;
  const status = args.status as string | undefined;
  const priority = args.priority as string | undefined;
  const assignedTo = args.assigned_to as string | undefined;
  const tag = args.tag as string | undefined;
  const branchFilter = resolveBranch(args.branch);
  const explicitSort = args.sort_by as string | undefined;
  const limit = (args.limit as number) ?? 50;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (epicId !== undefined) {
    whereClauses.push('t.epic_id = ?');
    params.push(epicId);
  }
  const projectId = resolveProjectId(db, args);
  if (projectId !== undefined) {
    whereClauses.push(taskScopeClause('e'));
    params.push(projectId);
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
  // #30: a removed task, and a task inside an archived epic, are both noise the
  // caller is paying for on every listing.
  if (!wantsHidden(args.include_deleted)) whereClauses.push('t.is_deleted = 0');
  if (!wantsHidden(args.include_archived)) whereClauses.push('e.archived = 0');
  if (branchFilter === null) {
    whereClauses.push('e.branch IS NULL');
  } else if (branchFilter !== undefined) {
    whereClauses.push('e.branch = ?');
    params.push(branchFilter);
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  /**
   * Which order to use when the caller did not say (#48).
   *
   * Sorting by priority ignored a deliberate arrangement, so an agent handed a
   * sequenced plan would start in the middle of it -- @rusak47's report had the
   * list opening on "Phase 1.1" while the plan began at "Phase 0". Priority is
   * the right guess only while nobody has expressed a better one.
   *
   * The test is exact rather than clever: if any task in this result was placed
   * by task_reorder, follow the arrangement; otherwise sort exactly as before.
   * An explicit sort_by is always obeyed literally -- asking for priority gets
   * priority, arrangement or not.
   */
  const sortBy = explicitSort ?? (hasArrangement(db, whereClauses, params) ? 'arranged' : 'priority');

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
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => slimListRow(row));
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

  const subtasks = withDependencies(
    db,
    db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at')
      .all(id) as Array<Record<string, unknown>>
  );

  const notes = db
    .prepare(
      `SELECT * FROM notes
       WHERE related_entity_type = 'task' AND related_entity_id = ?
       ORDER BY created_at DESC`
    )
    .all(id);

  const comments = db
    .prepare('SELECT * FROM comments WHERE task_id = ? AND is_deleted = 0 ORDER BY created_at ASC')
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

  // #19: the lock exists because agents rewrite a task's description when they
  // meant to leave a comment. It guards that one field; everything else on the
  // task stays editable, and the lock itself is not settable here — use
  // task_lock_description, which makes unlocking a deliberate, logged act.
  if (oldRow.description_locked && args.description !== undefined) {
    throw new Error(
      `Task ${id}'s description is locked and was not changed. ` +
        'Record progress with comment_add instead, or unlock it in the web UI ' +
        '(or with task_lock_description) if the description itself is genuinely wrong.'
    );
  }

  // #26 follow-up: finishing a task with an unfinished checklist is almost
  // always an oversight. Say what is left rather than silently accepting it.
  const leftOpen = guardTaskDone(db, id, args.status, args.force === true);

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
    if (leftOpen.length > 0) {
      logActivity(db, 'task', id, 'updated', 'status', oldRow.status as string, 'done',
        `Task '${newRow.title}' forced to done with ${leftOpen.length} unfinished subtask(s): ` +
          leftOpen.map((b) => `#${b.id}`).join(', '));
    }
  } else if (args.depends_on !== undefined) {
    // Only depends_on changed, no column updates
    newRow = oldRow;
  } else {
    throw new Error('No fields to update');
  }

  // Handle dependency updates
  if (args.depends_on !== undefined) {
    const dependsOn = asIdList(args.depends_on ?? [], 'depends_on');
    setDependencies(db, id, dependsOn);
    logActivity(db, 'task', id, 'updated', 'depends_on', null,
      dependsOn.length > 0 ? dependsOn.join(',') : '(none)',
      `Task '${newRow.title}' dependencies updated: [${dependsOn.join(', ')}]`);
    evaluateAndUpdateDependencies(db, id, true);
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

  // Re-evaluate dependents whenever this task's *doneness* changes, in either
  // direction. Only running this on the way into done meant reopening a
  // finished blocker left everything waiting on it sitting in todo with an
  // unmet dependency — the same class of hole as a dependency that never
  // blocked at all.
  const wasDone = oldRow.status === 'done';
  const isDone = (newRow.status as string) === 'done';
  if (wasDone !== isDone) {
    reevaluateDownstream(db, id);
  }

  return newRow;
}

function handleTaskLockDescription(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;
  const locked = args.locked === undefined ? true : Boolean(args.locked);

  const task = db.prepare('SELECT id, title, description_locked FROM tasks WHERE id = ?').get(id) as
    | { id: number; title: string; description_locked: number }
    | undefined;
  if (!task) throw new Error(`Task ${id} not found`);

  if (Boolean(task.description_locked) === locked) {
    return { message: `Task ${id}'s description is already ${locked ? 'locked' : 'unlocked'}.`, task };
  }

  const row = db
    .prepare("UPDATE tasks SET description_locked = ?, updated_at = datetime('now') WHERE id = ? RETURNING *")
    .get(locked ? 1 : 0, id) as Record<string, unknown>;

  logActivity(db, 'task', id, 'updated', 'description_locked',
    String(task.description_locked), locked ? '1' : '0',
    `Task '${task.title}' description ${locked ? 'locked' : 'unlocked'}`);

  return {
    message: locked
      ? `Task ${id}'s description is locked. task_update will refuse to change it; use comment_add to record progress.`
      : `Task ${id}'s description is unlocked.`,
    task: row,
  };
}

function handleTaskReorder(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number;
  const orderedIds = asIdList(args.ordered_ids ?? [], 'ordered_ids');

  const siblings = db
    .prepare('SELECT id FROM tasks WHERE epic_id = ? AND is_deleted = 0 ORDER BY sort_order, created_at')
    .all(epicId) as Array<{ id: number }>;
  if (siblings.length === 0) throw new Error(`Epic ${epicId} has no tasks`);

  const known = new Set(siblings.map((row) => row.id));
  const unknown = orderedIds.filter((taskId) => !known.has(taskId));
  if (unknown.length > 0) {
    throw new Error(`Task(s) ${unknown.join(', ')} do not belong to epic ${epicId}`);
  }

  // Anything left out keeps its relative order, after the listed ones.
  const seen = new Set(orderedIds);
  const finalOrder = [...orderedIds, ...siblings.map((row) => row.id).filter((rowId) => !seen.has(rowId))];

  const stmt = db.prepare("UPDATE tasks SET sort_order = ?, updated_at = datetime('now') WHERE id = ?");
  db.transaction(() => {
    finalOrder.forEach((taskId, index) => stmt.run(index + 1, taskId));
  })();

  logActivity(db, 'epic', epicId, 'updated', 'sort_order', null, finalOrder.join(','),
    `Tasks of epic ${epicId} reordered`);

  return slimList(
    db.prepare('SELECT * FROM tasks WHERE epic_id = ? AND is_deleted = 0 ORDER BY sort_order, created_at')
      .all(epicId) as Array<Record<string, unknown>>
  );
}

function handleTaskDelete(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;
  const reason = (args.reason as string) ?? null;
  const deletedBy = (args.deleted_by as string) ?? null;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!task) throw new Error(`Task ${id} not found`);
  if (task.is_deleted) return { message: `Task ${id} was already removed.`, task };

  // Restricted to todo on purpose: anything further along has an activity log,
  // comments and time tracking that removing it would strand.
  if (task.status !== 'todo') {
    throw new Error(
      `Task ${id} is '${task.status}', not 'todo', so it cannot be removed — work that has started has history worth keeping. ` +
        'Close it by setting status to done, or move it back to todo first if it was created by mistake.'
    );
  }

  // Something else waiting on this task would wait forever.
  const dependents = db
    .prepare(
      `SELECT t.id, t.title FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_task_id = ? AND t.is_deleted = 0`
    )
    .all(id) as Array<{ id: number; title: string }>;
  if (dependents.length > 0) {
    throw new Error(
      `Task ${id} cannot be removed — ${dependents.map((d) => `#${d.id} '${d.title}'`).join(', ')} ` +
        `depend${dependents.length === 1 ? 's' : ''} on it and would stay blocked forever. Clear those dependencies first.`
    );
  }

  const row = db
    .prepare(
      `UPDATE tasks SET is_deleted = 1, deleted_at = datetime('now'), deleted_by = ?, delete_reason = ?,
       updated_at = datetime('now') WHERE id = ? RETURNING *`
    )
    .get(deletedBy, reason, id) as Record<string, unknown>;

  logActivity(db, 'task', id, 'deleted', 'is_deleted', '0', '1',
    `Task '${task.title}' removed${deletedBy ? ` by ${deletedBy}` : ''}${reason ? `: ${reason}` : ''}`);

  return {
    message: `Task ${id} removed. The row is kept — pass include_deleted to task_list to see it, or task_restore to bring it back.`,
    task: row,
  };
}

function handleTaskRestore(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!task) throw new Error(`Task ${id} not found`);
  if (!task.is_deleted) return { message: `Task ${id} is not removed — nothing to restore.`, task };

  const row = db
    .prepare(
      `UPDATE tasks SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
       updated_at = datetime('now') WHERE id = ? RETURNING *`
    )
    .get(id) as Record<string, unknown>;

  logActivity(db, 'task', id, 'restored', 'is_deleted', '1', '0', `Task '${task.title}' restored`);
  return { message: `Task ${id} restored.`, task: row };
}

export const handlers: Record<string, ToolHandler> = {
  task_create: handleTaskCreate,
  task_reorder: handleTaskReorder,
  task_delete: handleTaskDelete,
  task_restore: handleTaskRestore,
  task_lock_description: handleTaskLockDescription,
  task_list: handleTaskList,
  task_get: handleTaskGet,
  task_update: handleTaskUpdate,
};
