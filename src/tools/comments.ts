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
    description: 'List all comments on a task in chronological order.',
    annotations: { title: 'List Comments', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Task ID' },
      },
      required: ['task_id'],
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

  return db
    .prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId);
}

export const handlers: Record<string, ToolHandler> = {
  comment_add: handleCommentAdd,
  comment_list: handleCommentList,
};
