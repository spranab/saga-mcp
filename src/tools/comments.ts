import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'comment_add',
    description:
      'Add a comment to a task. Comments create a chronological discussion thread — useful for leaving breadcrumbs across sessions.',
    annotations: { title: 'Add Comment', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Task ID to comment on' },
        content: { type: 'string', description: 'Comment text' },
        author: { type: 'string', description: 'Author name (optional)' },
      },
      required: ['task_id', 'content'],
    },
  },
  {
    name: 'comment_list',
    description:
      'List comments on a task in chronological order. Comments removed with comment_delete are hidden by default; pass include_deleted to see them with their removal reason.',
    annotations: { title: 'List Comments', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Task ID' },
        include_deleted: {
          type: 'boolean',
          default: false,
          description: 'Include comments that were removed (soft-deleted). Off by default.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'comment_delete',
    description:
      'Remove a comment (soft delete). The row is kept for the audit trail but hidden from comment_list and task_get. Use this to retract a comment that turned out to be wrong or stale. Reversible with comment_restore.',
    annotations: { title: 'Remove Comment', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Comment ID to remove' },
        reason: { type: 'string', description: 'Why the comment is being removed (recommended — it stays in the audit trail)' },
        deleted_by: { type: 'string', description: 'Who removed it (optional)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'comment_restore',
    description: 'Restore a comment previously removed with comment_delete.',
    annotations: { title: 'Restore Comment', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Comment ID to restore' },
      },
      required: ['id'],
    },
  },
];

function handleCommentAdd(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const content = args.content as string;
  const author = (args.author as string) ?? null;

  // Verify task exists
  const task = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(taskId) as { id: number; title: string } | undefined;
  if (!task) throw new Error(`Task ${taskId} not found`);

  const comment = db
    .prepare('INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?) RETURNING *')
    .get(taskId, author, content);

  const row = comment as Record<string, unknown>;
  logActivity(db, 'comment', row.id as number, 'created', null, null, null,
    `Comment added to task '${task.title}'${author ? ` by ${author}` : ''}`);

  return comment;
}

function handleCommentList(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const includeDeleted = args.include_deleted === true;

  const sql = includeDeleted
    ? 'SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC'
    : 'SELECT * FROM comments WHERE task_id = ? AND is_deleted = 0 ORDER BY created_at ASC';

  return db.prepare(sql).all(taskId);
}

function handleCommentDelete(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;
  const reason = (args.reason as string) ?? null;
  const deletedBy = (args.deleted_by as string) ?? null;

  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!comment) throw new Error(`Comment ${id} not found`);
  if (comment.is_deleted) {
    return { message: `Comment ${id} was already removed.`, comment };
  }

  const updated = db
    .prepare(
      `UPDATE comments
       SET is_deleted = 1, deleted_at = datetime('now'), deleted_by = ?, delete_reason = ?
       WHERE id = ? RETURNING *`
    )
    .get(deletedBy, reason, id) as Record<string, unknown>;

  logActivity(db, 'comment', id, 'deleted', 'is_deleted', '0', '1',
    `Comment ${id} removed${deletedBy ? ` by ${deletedBy}` : ''}${reason ? `: ${reason}` : ''}`);

  return {
    message: `Comment ${id} removed. The row is retained for audit — pass include_deleted to comment_list to see it, or comment_restore to bring it back.`,
    comment: updated,
  };
}

function handleCommentRestore(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!comment) throw new Error(`Comment ${id} not found`);
  if (!comment.is_deleted) {
    return { message: `Comment ${id} is not removed — nothing to restore.`, comment };
  }

  const updated = db
    .prepare(
      `UPDATE comments
       SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE id = ? RETURNING *`
    )
    .get(id) as Record<string, unknown>;

  logActivity(db, 'comment', id, 'restored', 'is_deleted', '1', '0', `Comment ${id} restored`);

  return { message: `Comment ${id} restored.`, comment: updated };
}

export const handlers: Record<string, ToolHandler> = {
  comment_add: handleCommentAdd,
  comment_list: handleCommentList,
  comment_delete: handleCommentDelete,
  comment_restore: handleCommentRestore,
};
