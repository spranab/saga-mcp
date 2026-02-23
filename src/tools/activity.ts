import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import { reevaluateDownstream } from './tasks.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'activity_log',
    description:
      'View the activity log showing what changed and when. Useful for understanding recent progress or reviewing what happened since the last session.',
    annotations: { title: 'Activity Log', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          enum: ['project', 'epic', 'task', 'subtask', 'note'],
          description: 'Filter by entity type',
        },
        entity_id: { type: 'integer', description: 'Filter by specific entity' },
        action: {
          type: 'string',
          enum: ['created', 'updated', 'deleted', 'status_changed'],
          description: 'Filter by action type',
        },
        since: { type: 'string', description: 'ISO 8601 datetime - show only activity after this time' },
        limit: { type: 'integer', default: 50 },
      },
    },
  },
  {
    name: 'tracker_session_diff',
    description:
      'Show what changed since a given timestamp. Returns aggregated summary with counts by action and entity type, plus highlights of key changes. Call this at the start of a session to understand what happened since the last one.',
    annotations: { title: 'Session Diff', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO 8601 datetime — show changes after this time (e.g. "2026-02-21T15:00:00")',
        },
      },
      required: ['since'],
    },
  },
  {
    name: 'task_batch_update',
    description:
      'Update multiple tasks at once. Useful for changing status of several tasks (e.g., mark 3 tasks as done) or reassigning tasks.',
    annotations: { title: 'Batch Update Tasks', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Task IDs to update',
        },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assigned_to: { type: 'string' },
      },
      required: ['ids'],
    },
  },
];

function handleActivityLog(args: Record<string, unknown>) {
  const db = getDb();
  const entityType = args.entity_type as string | undefined;
  const entityId = args.entity_id as number | undefined;
  const action = args.action as string | undefined;
  const since = args.since as string | undefined;
  const limit = (args.limit as number) ?? 50;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (entityType) {
    whereClauses.push('entity_type = ?');
    params.push(entityType);
  }
  if (entityId !== undefined) {
    whereClauses.push('entity_id = ?');
    params.push(entityId);
  }
  if (action) {
    whereClauses.push('action = ?');
    params.push(action);
  }
  if (since) {
    whereClauses.push('created_at > ?');
    params.push(since);
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM activity_log ${whereStr} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function handleSessionDiff(args: Record<string, unknown>) {
  const db = getDb();
  const since = args.since as string;

  const rows = db
    .prepare('SELECT * FROM activity_log WHERE created_at >= ? ORDER BY created_at ASC')
    .all(since) as Array<Record<string, unknown>>;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Aggregate by action
  const summary: Record<string, number> = { created: 0, updated: 0, status_changed: 0, deleted: 0 };
  // Aggregate by entity_type -> action
  const byEntity: Record<string, Record<string, number>> = {};

  const highlights: string[] = [];

  for (const row of rows) {
    const action = row.action as string;
    const entityType = row.entity_type as string;

    summary[action] = (summary[action] ?? 0) + 1;

    if (!byEntity[entityType]) {
      byEntity[entityType] = { created: 0, updated: 0, status_changed: 0, deleted: 0 };
    }
    byEntity[entityType][action] = (byEntity[entityType][action] ?? 0) + 1;

    // Pick out highlights: status changes, creates, and deletes
    if (action === 'status_changed' || action === 'created' || action === 'deleted') {
      if (row.summary) highlights.push(row.summary as string);
    }
  }

  return {
    since,
    until: now,
    total_changes: rows.length,
    summary,
    by_entity_type: byEntity,
    highlights,
    activity: rows,
  };
}

function handleTaskBatchUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const ids = args.ids as number[];
  const status = args.status as string | undefined;
  const priority = args.priority as string | undefined;
  const assignedTo = args.assigned_to as string | undefined;

  if (!status && !priority && assignedTo === undefined) {
    throw new Error('Provide at least one field to update: status, priority, or assigned_to');
  }

  const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');

  const results = db.transaction(() => {
    return ids.map((id) => {
      const oldRow = getStmt.get(id) as Record<string, unknown> | undefined;
      if (!oldRow) throw new Error(`Task ${id} not found`);

      const updates: string[] = [];
      const params: unknown[] = [];

      if (status) {
        updates.push('status = ?');
        params.push(status);
      }
      if (priority) {
        updates.push('priority = ?');
        params.push(priority);
      }
      if (assignedTo !== undefined) {
        updates.push('assigned_to = ?');
        params.push(assignedTo);
      }

      updates.push("updated_at = datetime('now')");
      params.push(id);

      const newRow = db
        .prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? RETURNING *`)
        .get(...params) as Record<string, unknown>;

      // Log status changes
      if (status && oldRow.status !== status) {
        logActivity(
          db, 'task', id, 'status_changed', 'status',
          oldRow.status as string, status,
          `Task '${newRow.title}' status: ${oldRow.status} -> ${status}`
        );
      }
      if (priority && oldRow.priority !== priority) {
        logActivity(
          db, 'task', id, 'updated', 'priority',
          oldRow.priority as string, priority,
          `Task '${newRow.title}' priority: ${oldRow.priority} -> ${priority}`
        );
      }

      // Auto time tracking
      if (status === 'done' && oldRow.status !== 'done' && !newRow.actual_hours) {
        const startEntry = db.prepare(
          `SELECT created_at FROM activity_log
           WHERE entity_type = 'task' AND entity_id = ? AND action = 'status_changed'
             AND field_name = 'status' AND new_value = 'in_progress'
           ORDER BY created_at DESC LIMIT 1`
        ).get(id) as { created_at: string } | undefined;

        if (startEntry) {
          const startMs = new Date(startEntry.created_at + 'Z').getTime();
          const nowMs = Date.now();
          const hours = Math.round(((nowMs - startMs) / 3_600_000) * 10) / 10;
          if (hours > 0) {
            db.prepare('UPDATE tasks SET actual_hours = ? WHERE id = ?').run(hours, id);
            newRow.actual_hours = hours;
            logActivity(db, 'task', id, 'updated', 'actual_hours', null, String(hours),
              `Task '${newRow.title}' auto-tracked: ${hours}h`);
          }
        }
      }

      // Re-evaluate downstream dependencies when task marked done
      if (status === 'done' && oldRow.status !== 'done') {
        reevaluateDownstream(db, id);
      }

      return newRow;
    });
  })();

  return { updated: results.length, tasks: results };
}

export const handlers: Record<string, ToolHandler> = {
  activity_log: handleActivityLog,
  tracker_session_diff: handleSessionDiff,
  task_batch_update: handleTaskBatchUpdate,
};
