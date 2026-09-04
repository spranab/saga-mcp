import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import { guardSubtaskStatus, FORCE_SCHEMA } from '../helpers/completion-guard.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'subtask_create',
    description:
      'Create one or more subtasks (checklist items) for a task. Accepts one title or an array. New subtasks are appended after any that exist.',
    annotations: { title: 'Create Subtask(s)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Parent task ID' },
        titles: {
          oneOf: [
            { type: 'string', description: 'Single subtask title' },
            { type: 'array', items: { type: 'string' }, description: 'Multiple subtask titles' },
          ],
        },
        depends_on: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Siblings each new subtask waits on',
        },
      },
      required: ['task_id', 'titles'],
    },
  },
  {
    name: 'subtask_update',
    description:
      'Update a subtask title, status or position. depends_on sets what it waits on, blocks the inverse; both replace the set, [] clears. Starting or finishing one with unmet prerequisites needs force.',
    annotations: { title: 'Update Subtask', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Subtask ID' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
        sort_order: { type: 'integer' },
        depends_on: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Siblings this one waits on (replaces the set)',
        },
        blocks: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Siblings that wait on this one — inverse of depends_on',
        },
        force: FORCE_SCHEMA,
      },
      required: ['id'],
    },
  },
  {
    name: 'subtask_reorder',
    description:
      'Reorder a task subtask list. Pass IDs in the order you want; any omitted keep their relative order at the end.',
    annotations: { title: 'Reorder Subtasks', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Parent task ID' },
        ordered_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Subtask IDs, in order',
        },
      },
      required: ['task_id', 'ordered_ids'],
    },
  },
  {
    name: 'subtask_delete',
    description: 'Delete one or more subtasks. Accepts a single ID or array of IDs.',
    annotations: { title: 'Delete Subtask(s)', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          oneOf: [
            { type: 'integer', description: 'Single subtask ID' },
            { type: 'array', items: { type: 'integer' }, description: 'Multiple subtask IDs' },
          ],
        },
      },
      required: ['ids'],
    },
  },
];

// --- Ordering (#21) ---

/** Next free position within a task, so new subtasks land at the end rather than at 0. */
function nextSortOrder(db: Database.Database, taskId: number): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM subtasks WHERE task_id = ?')
    .get(taskId) as { max: number };
  return row.max + 1;
}

// --- Dependencies (#22) ---

/**
 * Subtask dependencies are deliberately confined to siblings. A checklist item
 * waiting on an item under some other task is really a task-level dependency,
 * and task_dependencies already models that.
 */
function assertSameTask(db: Database.Database, taskId: number, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, task_id FROM subtasks WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: number; task_id: number }>;

  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`Subtask(s) not found: ${missing.join(', ')}`);

  const foreign = rows.filter((r) => r.task_id !== taskId);
  if (foreign.length > 0) {
    throw new Error(
      `Subtasks can only depend on siblings under the same task. ` +
        `${foreign.map((r) => `#${r.id}`).join(', ')} belong to another task — ` +
        'use task_update depends_on for cross-task ordering.'
    );
  }
}

/** Walk the dependency graph to keep it acyclic; a cycle would block every member forever. */
function assertNoCycle(db: Database.Database, subtaskId: number, dependsOn: number[]): void {
  const edges = db.prepare('SELECT subtask_id, depends_on_subtask_id FROM subtask_dependencies').all() as Array<{
    subtask_id: number;
    depends_on_subtask_id: number;
  }>;

  const graph = new Map<number, number[]>();
  for (const e of edges) {
    if (e.subtask_id === subtaskId) continue; // replaced below
    graph.set(e.subtask_id, [...(graph.get(e.subtask_id) ?? []), e.depends_on_subtask_id]);
  }
  graph.set(subtaskId, dependsOn);

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

  const cycle = walk(subtaskId);
  if (cycle) {
    throw new Error(
      `That would make a circular dependency: ${cycle.map((id) => `#${id}`).join(' → ')}. ` +
        'Nothing in a cycle can ever start.'
    );
  }
}

function setDependencies(db: Database.Database, subtaskId: number, taskId: number, dependsOn: number[]): void {
  const clean = [...new Set(dependsOn)].filter((id) => id !== subtaskId);
  assertSameTask(db, taskId, clean);
  assertNoCycle(db, subtaskId, clean);

  db.prepare('DELETE FROM subtask_dependencies WHERE subtask_id = ?').run(subtaskId);
  const insert = db.prepare(
    'INSERT INTO subtask_dependencies (subtask_id, depends_on_subtask_id) VALUES (?, ?)'
  );
  for (const depId of clean) insert.run(subtaskId, depId);
}

/**
 * Subtasks have no 'blocked' status — the three they have are enough, and
 * widening the CHECK constraint would mean rebuilding the table. So a blocked
 * subtask is reported, not restyled: reads carry depends_on and blocked.
 */
export function describeDependencies(
  db: Database.Database,
  subtaskId: number
): { depends_on: Array<{ id: number; title: string; status: string }>; blocked: boolean } {
  const dependsOn = db
    .prepare(
      `SELECT s.id, s.title, s.status FROM subtask_dependencies d
       JOIN subtasks s ON s.id = d.depends_on_subtask_id
       WHERE d.subtask_id = ?
       ORDER BY s.sort_order, s.id`
    )
    .all(subtaskId) as Array<{ id: number; title: string; status: string }>;

  return { depends_on: dependsOn, blocked: dependsOn.some((d) => d.status !== 'done') };
}

/** Attach dependency info to a set of sibling rows, in one pass. */
export function withDependencies(
  db: Database.Database,
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (rows.length === 0) return rows;
  return rows.map((row) => {
    const info = describeDependencies(db, row.id as number);
    if (info.depends_on.length === 0) return row; // costs nothing when unused
    return { ...row, depends_on: info.depends_on, blocked: info.blocked };
  });
}

// --- Handlers ---

function handleSubtaskCreate(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const rawTitles = args.titles;
  const titles = Array.isArray(rawTitles) ? (rawTitles as string[]) : [rawTitles as string];
  const dependsOn = (args.depends_on as number[]) ?? [];

  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const stmt = db.prepare(
    'INSERT INTO subtasks (task_id, title, sort_order) VALUES (?, ?, ?) RETURNING *'
  );

  const created = db.transaction(() => {
    let position = nextSortOrder(db, taskId);
    return titles.map((title) => {
      const subtask = stmt.get(taskId, title, position++) as Record<string, unknown>;
      if (dependsOn.length > 0) {
        setDependencies(db, subtask.id as number, taskId, dependsOn);
      }
      logActivity(db, 'subtask', subtask.id as number, 'created', null, null, null, `Subtask '${title}' created`);
      return subtask;
    });
  })();

  return created.length === 1 ? created[0] : created;
}

function handleSubtaskUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const oldRow = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!oldRow) throw new Error(`Subtask ${id} not found`);
  const taskId = oldRow.task_id as number;

  // #26: a dependency that does not stop anything is decoration. Refuse to move
  // a blocked subtask forward unless the caller says so explicitly.
  const overridden = guardSubtaskStatus(db, id, args.status, args.force === true);

  const updates: string[] = [];
  const params: unknown[] = [];

  if (args.title !== undefined) {
    updates.push('title = ?');
    params.push(args.title);
  }
  if (args.status !== undefined) {
    updates.push('status = ?');
    params.push(args.status);
  }
  if (args.sort_order !== undefined) {
    updates.push('sort_order = ?');
    params.push(args.sort_order);
  }

  const touchesDeps = args.depends_on !== undefined || args.blocks !== undefined;
  if (updates.length === 0 && !touchesDeps) throw new Error('No fields to update');

  let newRow = oldRow;

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(id);
    newRow = db
      .prepare(`UPDATE subtasks SET ${updates.join(', ')} WHERE id = ? RETURNING *`)
      .get(...params) as Record<string, unknown>;

    if (oldRow.status !== newRow.status) {
      const override = overridden.length > 0
        ? ` (forced past ${overridden.map((b) => `#${b.id}`).join(', ')})`
        : '';
      logActivity(
        db, 'subtask', id, 'status_changed', 'status',
        oldRow.status as string, newRow.status as string,
        `Subtask '${newRow.title}' status: ${oldRow.status} -> ${newRow.status}${override}`
      );
    }
  }

  if (args.depends_on !== undefined) {
    const dependsOn = (args.depends_on as number[]) ?? [];
    setDependencies(db, id, taskId, dependsOn);
    logActivity(db, 'subtask', id, 'updated', 'depends_on', null,
      dependsOn.length > 0 ? dependsOn.join(',') : '(none)',
      `Subtask '${newRow.title}' now waits on [${dependsOn.join(', ')}]`);
  }

  // The inverse direction: "this bug holds up those three", without editing each.
  if (args.blocks !== undefined) {
    const blocks = [...new Set((args.blocks as number[]) ?? [])].filter((x) => x !== id);
    assertSameTask(db, taskId, blocks);
    const existing = db
      .prepare('SELECT subtask_id FROM subtask_dependencies WHERE depends_on_subtask_id = ?')
      .all(id) as Array<{ subtask_id: number }>;

    db.transaction(() => {
      for (const row of existing) {
        if (!blocks.includes(row.subtask_id)) {
          db.prepare('DELETE FROM subtask_dependencies WHERE subtask_id = ? AND depends_on_subtask_id = ?')
            .run(row.subtask_id, id);
        }
      }
      for (const target of blocks) {
        const current = db
          .prepare('SELECT depends_on_subtask_id FROM subtask_dependencies WHERE subtask_id = ?')
          .all(target) as Array<{ depends_on_subtask_id: number }>;
        const next = [...new Set([...current.map((c) => c.depends_on_subtask_id), id])];
        setDependencies(db, target, taskId, next);
      }
    })();

    logActivity(db, 'subtask', id, 'updated', 'blocks', null,
      blocks.length > 0 ? blocks.join(',') : '(none)',
      `Subtask '${newRow.title}' now blocks [${blocks.join(', ')}]`);
  }

  const info = describeDependencies(db, id);
  return info.depends_on.length > 0 ? { ...newRow, ...info } : newRow;
}

function handleSubtaskReorder(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const orderedIds = (args.ordered_ids as number[]) ?? [];

  const siblings = db
    .prepare('SELECT id FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at')
    .all(taskId) as Array<{ id: number }>;
  if (siblings.length === 0) throw new Error(`Task ${taskId} has no subtasks`);

  const known = new Set(siblings.map((s) => s.id));
  const unknown = orderedIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Subtask(s) ${unknown.join(', ')} do not belong to task ${taskId}`);
  }

  // Anything not mentioned keeps its relative order, after the listed ones.
  const seen = new Set(orderedIds);
  const finalOrder = [...orderedIds, ...siblings.map((s) => s.id).filter((id) => !seen.has(id))];

  const stmt = db.prepare("UPDATE subtasks SET sort_order = ?, updated_at = datetime('now') WHERE id = ?");
  db.transaction(() => {
    finalOrder.forEach((id, index) => stmt.run(index + 1, id));
  })();

  logActivity(db, 'subtask', taskId, 'updated', 'sort_order', null, finalOrder.join(','),
    `Subtasks of task ${taskId} reordered`);

  return db
    .prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at')
    .all(taskId);
}

function handleSubtaskDelete(args: Record<string, unknown>) {
  const db = getDb();
  const rawIds = args.ids;
  const ids = Array.isArray(rawIds) ? (rawIds as number[]) : [rawIds as number];

  const getStmt = db.prepare('SELECT * FROM subtasks WHERE id = ?');
  const delStmt = db.prepare('DELETE FROM subtasks WHERE id = ?');

  const deleted = db.transaction(() => {
    return ids.map((id) => {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Subtask ${id} not found`);
      delStmt.run(id); // dependency rows cascade
      logActivity(db, 'subtask', id, 'deleted', null, null, null, `Subtask '${row.title}' deleted`);
      return { id, title: row.title, deleted: true };
    });
  })();

  return deleted.length === 1 ? deleted[0] : deleted;
}

export const handlers: Record<string, ToolHandler> = {
  subtask_create: handleSubtaskCreate,
  subtask_update: handleSubtaskUpdate,
  subtask_reorder: handleSubtaskReorder,
  subtask_delete: handleSubtaskDelete,
};
