import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { buildUpdate } from '../helpers/sql-builder.js';
import { logActivity, logEntityUpdate } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'project_create',
    description: 'Create a new project. Projects are the top-level container for all work.',
    annotations: { title: 'Create Project', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Project description' },
        status: {
          type: 'string',
          enum: ['active', 'on_hold', 'completed', 'archived'],
          default: 'active',
          description: 'Project status',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'project_list',
    description:
      'List all projects with epic/task counts and completion percentages. Optionally filter by status.',
    annotations: { title: 'List Projects', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'on_hold', 'completed', 'archived'],
          description: 'Filter by status',
        },
      },
    },
  },
  {
    name: 'project_update',
    description:
      'Update a project. Pass only the fields you want to change. Set status to "archived" to soft-delete.',
    annotations: { title: 'Update Project', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Project ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'on_hold', 'completed', 'archived'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
];

function handleProjectCreate(args: Record<string, unknown>) {
  const db = getDb();
  const name = args.name as string;
  const description = (args.description as string) ?? null;
  const status = (args.status as string) ?? 'active';
  const tags = JSON.stringify((args.tags as string[]) ?? []);

  const project = db
    .prepare(
      'INSERT INTO projects (name, description, status, tags) VALUES (?, ?, ?, ?) RETURNING *'
    )
    .get(name, description, status, tags);

  const row = project as Record<string, unknown>;
  logActivity(db, 'project', row.id as number, 'created', null, null, null, `Project '${name}' created`);

  return project;
}

function handleProjectList(args: Record<string, unknown>) {
  const db = getDb();
  const status = args.status as string | undefined;

  let sql = `
    SELECT p.*,
      COUNT(DISTINCT e.id) as epic_count,
      COUNT(DISTINCT t.id) as task_count,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_count,
      CASE WHEN COUNT(DISTINCT t.id) > 0
        THEN ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(DISTINCT t.id), 1)
        ELSE 0 END as completion_pct
    FROM projects p
    LEFT JOIN epics e ON e.project_id = p.id
    LEFT JOIN tasks t ON t.epic_id = e.id
  `;

  const params: unknown[] = [];
  if (status) {
    sql += ' WHERE p.status = ?';
    params.push(status);
  }

  sql += ' GROUP BY p.id ORDER BY p.created_at DESC';

  return db.prepare(sql).all(...params);
}

function handleProjectUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const oldRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!oldRow) throw new Error(`Project ${id} not found`);

  const update = buildUpdate('projects', id, args, ['name', 'description', 'status', 'tags']);
  if (!update) throw new Error('No fields to update');

  const newRow = db.prepare(update.sql).get(...update.params) as Record<string, unknown>;
  logEntityUpdate(db, 'project', id, newRow.name as string, oldRow, newRow, ['name', 'status']);

  return newRow;
}

export const handlers: Record<string, ToolHandler> = {
  project_create: handleProjectCreate,
  project_list: handleProjectList,
  project_update: handleProjectUpdate,
};
