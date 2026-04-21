import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { buildUpdate } from '../helpers/sql-builder.js';
import { logActivity, logEntityUpdate } from '../helpers/activity-logger.js';
import { resolveBranch } from '../helpers/git.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'epic_create',
    description:
      'Create an epic within a project. Epics group related tasks into a feature or workstream. Pass branch to scope the epic to a git branch (use "current" to auto-detect).',
    annotations: { title: 'Create Epic', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Parent project ID' },
        name: { type: 'string', description: 'Epic name' },
        description: { type: 'string', description: 'Epic description' },
        status: {
          type: 'string',
          enum: ['planned', 'in_progress', 'completed', 'cancelled'],
          default: 'planned',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          default: 'medium',
        },
        branch: {
          type: 'string',
          description: 'Git branch this epic is scoped to. Pass "current" to auto-detect from the repo. Omit or pass empty string for a branch-agnostic (global) epic.',
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['project_id', 'name'],
    },
  },
  {
    name: 'epic_list',
    description:
      'List epics for a project with task counts and completion stats. Optionally filter by status, priority, or branch. Pass branch="current" to auto-detect the active git branch; pass empty string to list only branch-agnostic epics.',
    annotations: { title: 'List Epics', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Project ID' },
        status: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        branch: {
          type: 'string',
          description: 'Filter by git branch. Pass "current" to auto-detect; pass empty string to list only branch-agnostic epics. Omit to list all.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'epic_update',
    description:
      'Update an epic. Pass only the fields you want to change. Set status to "cancelled" to soft-delete. Pass branch="current" to pin to the active branch, or empty string to clear.',
    annotations: { title: 'Update Epic', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Epic ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        sort_order: { type: 'integer' },
        branch: {
          type: 'string',
          description: 'Git branch this epic is scoped to. Pass "current" to auto-detect; pass empty string to clear (branch-agnostic).',
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
];

function handleEpicCreate(args: Record<string, unknown>) {
  const db = getDb();
  const projectId = args.project_id as number;
  const name = args.name as string;
  const description = (args.description as string) ?? null;
  const status = (args.status as string) ?? 'planned';
  const priority = (args.priority as string) ?? 'medium';
  const tags = JSON.stringify((args.tags as string[]) ?? []);
  const resolvedBranch = resolveBranch(args.branch);
  const branch = resolvedBranch === undefined ? null : resolvedBranch;

  const epic = db
    .prepare(
      'INSERT INTO epics (project_id, name, description, status, priority, branch, tags) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *'
    )
    .get(projectId, name, description, status, priority, branch, tags);

  const row = epic as Record<string, unknown>;
  const branchSuffix = branch ? ` on branch '${branch}'` : '';
  logActivity(db, 'epic', row.id as number, 'created', null, null, null, `Epic '${name}' created in project ${projectId}${branchSuffix}`);

  return epic;
}

function handleEpicList(args: Record<string, unknown>) {
  const db = getDb();
  const projectId = args.project_id as number;
  const status = args.status as string | undefined;
  const priority = args.priority as string | undefined;
  const branchFilter = resolveBranch(args.branch);

  const whereClauses = ['e.project_id = ?'];
  const params: unknown[] = [projectId];

  if (status) {
    whereClauses.push('e.status = ?');
    params.push(status);
  }
  if (priority) {
    whereClauses.push('e.priority = ?');
    params.push(priority);
  }
  if (branchFilter === null) {
    whereClauses.push('e.branch IS NULL');
  } else if (branchFilter !== undefined) {
    whereClauses.push('e.branch = ?');
    params.push(branchFilter);
  }

  const sql = `
    SELECT e.*,
      COUNT(t.id) as task_count,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_count,
      SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) as blocked_count,
      CASE WHEN COUNT(t.id) > 0
        THEN ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id), 1)
        ELSE 0 END as completion_pct
    FROM epics e
    LEFT JOIN tasks t ON t.epic_id = e.id
    WHERE ${whereClauses.join(' AND ')}
    GROUP BY e.id
    ORDER BY e.sort_order, e.created_at
  `;

  return db.prepare(sql).all(...params);
}

function handleEpicUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const oldRow = db.prepare('SELECT * FROM epics WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!oldRow) throw new Error(`Epic ${id} not found`);

  // Branch is handled separately so that explicit null/empty clears it; buildUpdate skips undefined.
  const branchResolution = args.branch !== undefined ? resolveBranch(args.branch) : undefined;
  const fieldsForBuilder: Record<string, unknown> = { ...args };
  if (branchResolution !== undefined) {
    fieldsForBuilder.branch = branchResolution;
  } else {
    delete fieldsForBuilder.branch;
  }

  const update = buildUpdate('epics', id, fieldsForBuilder, ['name', 'description', 'status', 'priority', 'sort_order', 'branch', 'tags']);
  if (!update) throw new Error('No fields to update');

  const newRow = db.prepare(update.sql).get(...update.params) as Record<string, unknown>;
  logEntityUpdate(db, 'epic', id, newRow.name as string, oldRow, newRow, ['name', 'status', 'priority', 'branch']);

  return newRow;
}

export const handlers: Record<string, ToolHandler> = {
  epic_create: handleEpicCreate,
  epic_list: handleEpicList,
  epic_update: handleEpicUpdate,
};
